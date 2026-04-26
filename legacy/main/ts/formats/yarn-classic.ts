import {
    TDependencies,
    TSnapshot,
    TSnapshotIndex,
    ICheck,
    IFormat,
    IParse,
    IPreformat,
    TSource,
    TResolution,
    IParseResolution,
    IFormatResolution
} from '../interface'
import {parseIntegrity, formatTarballUrl, parseTarballUrl, referenceKeysSorter, normalizeDeps} from '../common'
import {debug, mergeDeps, sortObject, unique} from '../util'
import {yamlDump, yamlLoad} from '../vendor'

const kvEntryPattern = /^(\s+)"?([^"]+)"?\s"?([^"]+)"?$/

export type TYarn1Lockfile = Record<string, {
    version: string
    resolved: string
    integrity: string
    dependencies?: TDependencies
    optionalDependencies?: TDependencies
}>

export const version = 'yarn-classic'

export const check: ICheck = (value: string): boolean => value.includes('# yarn lockfile v1')

export const preparse = (value: string): TYarn1Lockfile  => {
    const lines = value.split('\n')
    const _value = lines.map((line) => {
        if (line.startsWith('#')) {
            return ''
        }

        // "@babel/code-frame@^7.0.0", "@babel/code-frame@^7.12.13"
        if (line.length !==0 && line.charAt(0) !== ' ') {
            return `"${line.replaceAll('"', '').slice(0, -1)}":`
        }

        const [,p,k,v]: string[] = line.match(kvEntryPattern) || []
        if (line.match(kvEntryPattern)) {
            return `${p}"${k}": "${v}"`
        }

        return line
    }, '').join('\n')

    return yamlLoad(_value) as TYarn1Lockfile
}

export const parse: IParse = (value: string, ...pkgs: string[]): TSnapshot => {
    const manifest = JSON.parse(pkgs[0])
    const manifests = Object.fromEntries(pkgs.map(p => {
        const manifest = JSON.parse(p)
        return [manifest.name, manifest]
    }))
    const raw = preparse(value)
    const snapshot: TSnapshot = {}

    Object.entries(raw).forEach((value) => {
        const [_key, _entry] = value
        const { version, integrity, dependencies, optionalDependencies, resolved } = _entry
        const hashes = parseIntegrity(integrity)
        const source: TSource = parseResolution(resolved)
        const chunks = _key.split(', ')
        const names = unique(chunks.map(c => c.slice(0, c.indexOf('@', 1))))
        const isLocal = version === '0.0.0-use.local'

        for (const name of names) {
            const ranges = chunks.filter(c => c.startsWith(`${name}@`)).map(r => r.slice(r.indexOf('@', 1) + 1)).sort()
            const key = `${name}@${version}`
            const _dependencies = isLocal && manifests[name]?.dependencies || dependencies
            const _devDependencies = isLocal && manifests[name]?.devDependencies

            snapshot[key] = {
                name,
                version,
                ranges,
                hashes,
                dependencies: _dependencies,
                devDependencies: _devDependencies,
                optionalDependencies,
                source,
            }
        }
    })

    snapshot[""] = {
        name: manifest.name,
        version: manifest.version,
        ranges: [],
        hashes: {},
        source: {
            type: 'workspace',
            id: '.'
        },
        manifest,
        dependencies: manifest.dependencies,
        devDependencies: manifest.devDependencies,
        optionalDependencies: manifest.optionalDependencies,
    }

    debug.json('yarn-classic-snapshot.json', snapshot)

    return snapshot
}



export const preformat: IPreformat<TYarn1Lockfile> = (idx): TYarn1Lockfile => {
    const {snapshot} = idx
    const lf: TYarn1Lockfile = {}
    const rangemap: Record<string, {keys: string[], key: string, name: string}> = {}

    Object.values(snapshot).forEach((entry) => {
        const { name, version, ranges, hashes, devDependencies, dependencies, optionalDependencies, source } = entry
        const resolved = formatResolution(source)
        const alias = rangemap[resolved]
        const integrity = Object.entries(hashes).map(([k, v]) => `${k}-${v}`).join(' ')
        const keys = ranges.map(r => `${name}@${r}`)

        if (alias) {
            keys.push(...alias.keys)
            keys.sort(referenceKeysSorter)
            delete lf[alias.key]
        }

        const key = keys.join(', ')
        const _dependencies = mergeDeps(dependencies, devDependencies)
        if (_dependencies) sortObject(_dependencies)

        rangemap[resolved] = {keys, key, name}
        lf[key] = {
            version,
            resolved,
            integrity,
            dependencies: _dependencies,
            optionalDependencies,
        }
    })

    delete lf[""]

    return lf
}

export const format: IFormat = (snapshot: TSnapshot): string => {
    const lf = preformat({snapshot} as TSnapshotIndex)
    const lines: string[] = yamlDump(lf, {
        quotingType: '"',
        flowLevel: -1,
        lineWidth: -1,
        forceQuotes: true,
        noRefs: true,
    }).split('\n')
    const _value = lines.map((line) => {
        // "@babel/code-frame@^7.0.0", "@babel/code-frame@^7.12.13"
        if (line.length !==0 && line.charAt(0) !== ' ') {
            const chunks = line.slice(0, -1).replaceAll('"', '').split(', ').map(chunk => chunk.startsWith('@') || chunk.includes(' ') || chunk.includes('npm:')? `"${chunk}"` : chunk)
            return `\n${chunks.join(', ')}:`
        }

        if (line.startsWith('  integrity')) {
            const _line = line.replace(':', '')

            return line.includes('= ') // multiple hashes
                ? _line.replaceAll('"integrity"', 'integrity')
                : _line.replaceAll('"', '')
        }

        if (line.endsWith('ependencies:')) {
            return line
        }

        return line.replace(':', '')
    }, '').join('\n')

    return `# THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.
# yarn lockfile v1

${_value}`
}

export const parseResolution: IParseResolution = (input: string): TResolution => {
    // https://github.com/yarnpkg/yarn/blob/master/src/resolvers/exotics/github-resolver.js
    // https://github.com/yarnpkg/yarn/blob/master/src/resolvers/exotics/git-resolver.js
    if (input.startsWith('https://codeload.github.com/')) {
        // https://codeload.github.com/mixmaxhq/throng/tar.gz/8a015a378c2c0db0c760b2147b2468a1c1e86edf
        // 28                          x              8       40
        return {
            type: 'github',
            name: input.slice(28, -48),
            id: input.slice(-40)
        }
    }

    const npmResolution = parseTarballUrl(input)
    if (!npmResolution) throw new TypeError(`Unsupported resolution format: ${input}`)

    return npmResolution
}

export const formatResolution: IFormatResolution = ({type, id, name = '', registry = 'https://registry.yarnpkg.com', hash = ''}: TResolution): string => {
    if (type === 'github') {
        return `https://codeload.github.com/${name}/tar.gz/${id}`
    }

    return formatTarballUrl(name, id, registry, hash)
}

const formatReference = (input: string): string => {
    const colonPos = input.indexOf(':')
    const protocol = input.slice(0, colonPos)
    const ref = input.slice(colonPos + 1)

    if (protocol === 'git' || protocol === 'tag' || protocol === 'semver' || protocol === 'npm') {
        return ref
    }

    return input
}
