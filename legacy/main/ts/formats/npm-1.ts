import {
    ICheck,
    IFormat,
    IParse, IPreformat,
    TDependencies,
    THashes,
    TEntry,
    TManifest,
    TSnapshot,
    IParseResolution,
    IFormatResolution,
    TResolution,
} from '../interface'
import {debug, sortObject} from '../util'
import {parseIntegrity, formatTarballUrl, parseTarballUrl} from '../common'
import {analyze} from '../analyze'

export const version = 'npm-1'

export type TNpm1LockfileEntry = {
    version: string
    resolved: string
    integrity: string
    dev?: boolean
    requires?: Record<string, string>
    dependencies?: TNpm1LockfileDeps
}

export type TNpm1LockfileDeps = Record<string, TNpm1LockfileEntry>

export type TNpm1Lockfile = {
    lockfileVersion: 1
    name: string
    version: string
    requires?: true
    dependencies: TNpm1LockfileDeps
}

interface TDepTree {
    dependencies?: Record<string, TDepTree>
    version: string
    requires?: any
}

export const check: ICheck = (lockfile: string) => lockfile.includes('  "lockfileVersion": 1')

export const parse: IParse = (lockfile: string, pkg: string): TSnapshot => {
    const lf: TNpm1Lockfile = JSON.parse(lockfile)
    const manifest: TManifest = JSON.parse(pkg)
    const snapshot: Record<string, TEntry> = {
        "": {
            name: manifest.name,
            version: manifest.version,
            dependencies: manifest.dependencies,
            devDependencies: manifest.devDependencies,
            hashes: {},
            source: {
                type: 'workspace',
                id: '.'
            },
            ranges: [],
            manifest,
        }
    }
    const getClosestVersion = (name: string, ...deps: TNpm1LockfileDeps[]): string =>
        deps.find((dep) => dep[name])?.[name]?.version as string

    const upsertEntry = (name: string, version: string, data: Partial<TEntry> = {}): TEntry => {
        const key = `${name}@${version}`
        if (!snapshot[key]) {
            // @ts-ignore
            snapshot[key] = {name, version, ranges: []}
        }
        return Object.assign(snapshot[key], data)
    }
    const pushRange = (name: string, version: string, range: string): void => {
        const entry = upsertEntry(name, version)

        if (!entry.ranges.includes(range)) {
            entry.ranges.push(range)
            entry.ranges.sort()
        }
    }
    const extractRanges = (deps?: TDependencies, ...parents: TNpm1LockfileDeps[]) => deps && Object.entries(deps).forEach(([_name, range]) => {
        const _version = getClosestVersion(_name, ...parents)
        pushRange(_name, _version, range)
    })
    const extractEntries = (deps?: TNpm1LockfileDeps, ...parents: TNpm1LockfileDeps[]) => deps && Object.entries(deps).forEach(([name, entry]) => {
        const requires = entry.requires || entry.dependencies && Object.entries(entry.dependencies).reduce((m, [name, {version}]) => {
            m[name] = version
            return m
        }, {} as Record<string, string>)

        upsertEntry(name, entry.version, {
            hashes: parseIntegrity(entry.integrity),
            dependencies: requires,
            source: parseResolution(entry.resolved)
        })

        extractEntries(entry.dependencies, deps, ...parents)
        extractRanges(requires, entry.dependencies || {}, deps, ...parents)
    })

    extractEntries(lf.dependencies)
    extractRanges({
        ...snapshot[""].dependencies,
        ...snapshot[""].devDependencies
    }, lf.dependencies || {})

    debug.json('npm1-snapshot.json', snapshot)

    return sortObject(snapshot)
}

const formatIntegrity = (hashes: THashes): string => Object.entries(hashes).map(([key, value]) => `${key}-${value}`).join(' ')

export const preformat: IPreformat<TNpm1Lockfile> = (idx): TNpm1Lockfile => {
    const root = idx.snapshot[""].manifest as TManifest
    const deptree = Object.values(idx.tree).slice(1).map(({parents, entry}) => [...parents.slice(1), entry])

    debug.json('deptree-npm-1.json', deptree.map((entries: TEntry[]) => entries.map(e => e.name).join(',')))

    const formatNpm1LockfileEntry = (entry: TEntry): TNpm1LockfileEntry => {
        const {name, version, hashes, source} = entry
        const _entry: TNpm1LockfileDeps[string] = {
            version,
            resolved: formatResolution(source),
            integrity: formatIntegrity(hashes)
        }

        if (!idx.prod.has(entry)) {
            _entry.dev = true
        }

        if (entry.dependencies) {
            _entry.requires = entry.dependencies
        }

        return _entry
    }

    const lf: TNpm1Lockfile = {
        name: root.name,
        version: root.version,
        lockfileVersion: 1,
        requires: true,
        dependencies: {}
    }
    const nmtree = lf
    const nodes: TDepTree[] = [nmtree]
    const processEntry = (name: string, version: string, parents: TNpm1LockfileEntry[]) => {
        const entry = idx.getEntry(name, version)!
        const deps = idx.getEntryDeps(entry)
        const queue: [string, string, TNpm1LockfileEntry[]][] = []

        deps.forEach((e) => {
            const closestIndex = parents.findIndex((p) => p.dependencies?.[e.name])
            const closest = parents[closestIndex]
            if (closest?.dependencies?.[e.name].version === e.version) {
                return
            }

            const _entry = formatNpm1LockfileEntry(e)
            const _parents = [_entry, ...parents]
            const parent = closest
              ? _parents[closestIndex]
              : _parents[_parents.length - 1]

            if (!parent.dependencies) {
                parent.dependencies = {}
            }
            parent.dependencies[e.name] = _entry

            nodes.push(parent)
            queue.push([e.name, e.version, _parents])
        })

        queue.forEach(([name, version, parents]) => processEntry(name, version, parents))
    }

    deptree.forEach((chain) => {
        const entry = chain[chain.length - 1]
        const {name} = entry

        if (!nmtree.dependencies[name]) {
            nmtree.dependencies[name] = formatNpm1LockfileEntry(entry)
        }
    })
    Object.entries(nmtree.dependencies).forEach(([name, entry]) => processEntry(name, entry.version, [entry, nmtree] as TNpm1LockfileEntry[]))

    nodes.forEach((node) => {
        sortObject(node.dependencies || {})

        if (node.requires) {
            const snap1 = Object.entries(node.requires).map(([name, range]) => `${name}@${range}`).join('')
            const snap2 = Object.entries(node.dependencies || {}).map(([name, {version}]) => `${name}@${version}`).join('')

            if (snap1 === snap2) {
                delete node.requires
            }
        }
    })

    return lf
}

export const format: IFormat = (snap): string =>
    JSON.stringify(preformat(analyze(snap)), null, 2)

export const parseResolution: IParseResolution = (input: string) => {
    if (input.startsWith('github:')) {
        // github:mixmaxhq/throng#8a015a378c2c0db0c760b2147b2468a1c1e86edf
        // 7      x              40
        return {
            type: 'github',
            name: input.slice(7, -41),
            id: input.slice(-40)
        }
    }

    const npmResolution = parseTarballUrl(input)
    if (!npmResolution) throw new TypeError(`Unsupported resolution format: ${input}`)

    return npmResolution
}

export const formatResolution: IFormatResolution = (source: TResolution) => {
    const {type, name, id, registry = 'https://registry.npmjs.org'} = source
    if (type === 'github') {
        return `github:${name}#${id}`
    }

    return formatTarballUrl(name as string, id, registry)
}
