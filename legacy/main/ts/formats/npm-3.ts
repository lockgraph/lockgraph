import {
  ICheck,
  IFormat,
  IFormatResolution,
  IParseResolution,
  IPreformat,
  TEntry,
  TManifest,
  TSnapshot,
  TSnapshotIndex,
} from '../interface'
import {formatTarballUrl, parseIntegrity, formatIntegrity, parseTarballUrl} from '../common'
import {sortObject, debug} from '../util'
import {analyze, getDeps, getId} from '../analyze'
import semver from 'semver'

export type TNpm3LockfileEntry = {
  name?: string
  version?: string
  resolved?: string
  integrity?: string
  dev?: boolean
  link?: boolean
  dependencies?: Record<string, string>,
  engines?: Record<string, string>
  funding?: Record<string, string>
  peerDependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  bin?: any
  license?: string
}

export type TNpm3LockfileDeps = Record<string, TNpm3LockfileEntry>

export type TNpm3Lockfile = {
  lockfileVersion: 3
  name: string
  version: string
  requires?: true
  packages: TNpm3LockfileDeps
}

export const version = 'npm-3'

export const check: ICheck = (lockfile: string) => lockfile.includes('  "lockfileVersion": 3')

export const parse = (lockfile: string): TSnapshot => {
  const lf: TNpm3Lockfile = JSON.parse(lockfile)
  const snapshot = parsePackages(lf.packages)

  snapshot[""].manifest = lf.packages[""]

  debug.json('npm3-snapshot.json', snapshot)

  return snapshot
}

const formatNmKey = (chunks: string[]) => `node_modules/` + chunks.join('/node_modules/')

const parsePackages = (packages: TNpm3LockfileDeps): any => {
  const entries: Record<string, TEntry> = {}
  const getClosestPkg = (name: string, chain: string[], entries: Record<string, TNpm3LockfileEntry>, _range: string): [string, TNpm3LockfileEntry] => {
    const variants: string[] = []
    const range = _range?.startsWith('npm:') ? _range.slice(_range.lastIndexOf('@') + 1) : _range

    let s = 0
    while(s < chain.length) {
      let l = chain.length + 1
      while (l--) {
        const variant = formatNmKey([...chain.slice(s, l), name].filter(Boolean))
        const entry = entries[variant]

        if (entry && (!entry.version || entry.version === range || semver.satisfies(entry.version as string, range))) {
          return [variant, entry]
        }
        variants.push(variant)
      }
      s++
    }
    throw new Error(`Malformed lockfile: ${name} ${range}\n${variants.join('\n')}`)
  }

  const processPackage = (path: string, pkg: TNpm3LockfileEntry): TEntry => {
    if ((pkg.link || path === "") && !pkg.name){
      // populates workspace entry refs
      return processPackage(path, {
        ...pkg,
        ...packages[pkg.resolved as string]
      })
    }
    // const source: TSource = {
    //   id: (pkg.resolved || '.') as string,
    //   type: sourceType
    // }
    const source = parseResolution(pkg.resolved as string)
    const isNpmAlias = path.startsWith('node_modules/') && pkg.name
    const chain: string[] = path ? ('/' + path).split('/node_modules/').filter(Boolean) : [""]
    // name is present for workspace and npm aliased pkgs and for the root pkg
    const name = !isNpmAlias && pkg.name || chain[chain.length - 1]
    const version = pkg.version as string
    const id = path === "" ? path : getId(name, version)

    if (entries[id]) {
      return entries[id]
    }

    entries[id] = {
      name,
      version,
      ranges: [],
      hashes: parseIntegrity(pkg.integrity),
      source,
      dependencies: pkg.dependencies,
      engines: pkg.engines,
      funding: pkg.funding,
      bin: pkg.bin,
      devDependencies: pkg.devDependencies,
      peerDependencies: pkg.peerDependencies,
      optionalDependencies: pkg.optionalDependencies,
      license: pkg.license
    }

    Object.entries<string>(getDeps(entries[id])).forEach(([_name, range]) => {
      const [_path, _entry] = getClosestPkg(_name, chain, packages, range)
      const {ranges} = processPackage(_path, _entry)

      if (!ranges.includes(range)) {
        ranges.push(range)
        ranges.sort()
      }
    })
    return entries[id]
  }

  Object.entries(packages).forEach(([path, entry]) =>
    (path.startsWith('node_modules/') || path === '') && processPackage(path, entry))

  return sortObject(entries)
}

export const buildNmtree = (idx: TSnapshotIndex) => {
  const snap = idx.snapshot
  const nmtree = Object.values(idx.tree).reduce<Record<string, {entry: TEntry, parent: string}>>((result, {key, id, chunks}) => {
    const entry = snap[id]
    if (!entry) {
      throw new Error(`Malformed snapshot: ${id}`)
    }

    const grandparent = chunks[1]
    const cl = chunks.length

    let l = 0
    while (l <= cl) {
      const [name, ...parents] = [...chunks].reverse()

      let i = 0
      while (i < parents.length) {
        const __key = parents.slice(i, i + l).reverse()
        const _key = [...__key, name]//
        const variant = formatNmKey(_key)
        const found = result[variant]
        if (found) {

          if (found.entry === entry) {
            return result
          }

        } else {
          const pEntry = result[formatNmKey(__key)]?.entry
          const ppEntry = idx.getEntry(idx.tree[chunks.slice(0, cl - i - l).join(',')]?.id)
          if (__key.length && pEntry !== ppEntry) {
            i++
            continue
          }

          result[variant] = {entry, parent: grandparent}
          return result
        }
        i++
      }
      l++
    }

    if (entry.source.type === 'workspace') {
      result[formatNmKey([entry.name])] = {entry, parent: ''}
    }

    return result
  }, {})

  debug.json('npm3-nmtree.json', nmtree)

  return nmtree
}

export const preformat: IPreformat<TNpm3Lockfile> = (idx): TNpm3Lockfile => {
  const snap = idx.snapshot
  const nmtree = buildNmtree(idx)
  const manifest = snap[""].manifest as TManifest
  const packages = sortObject(Object.entries(nmtree).reduce((m, [k, {entry, parent}]) => {
      if (entry.source.type === 'workspace') {
        if (entry.source.id === '.') {
          m[""] = manifest as TNpm3LockfileEntry
          return m
        }

        m[`node_modules/${entry.name}`] = {
          resolved: entry.source.id as string,
          link: true
        }

        m[entry.source.id as string] = {
          name: entry.name,
          version: entry.version,
          license: entry.license,
          dependencies: entry.dependencies,
          bin: entry.bin,
          devDependencies: entry.devDependencies,
        }
        return m
      }

      m[k] = {
        version: entry.version,
        resolved: formatResolution(entry.source),
        integrity: formatIntegrity(entry.hashes)
      }
      if (!idx.prod.has(entry)) {
        m[k].dev = true
      }
      m[k].dependencies = entry.dependencies
      m[k].bin = entry.bin
      m[k].engines = entry.engines
      m[k].funding = entry.funding
      m[k].peerDependencies = entry.peerDependencies
      m[k].optionalDependencies = entry.optionalDependencies

      return m
    }, {} as TNpm3LockfileDeps)
  )

  return {
    name: manifest.name,
    version: manifest.version,
    lockfileVersion: 3,
    requires: true,
    packages,
  }
}

export const format: IFormat = (snapshot: TSnapshot): string => JSON.stringify(preformat(analyze(snapshot)), null, 2)

export const parseResolution: IParseResolution = (input) => {
  if (!input?.includes('://')) {
    return {
      type: 'workspace',
      id: input || '.'
    }
  }

  // git+ssh://git@github.com/mixmaxhq/throng.git#8a015a378c2c0db0c760b2147b2468a1c1e86edf
  // 25                      x               5    40
  if (input.startsWith('git+ssh://git@github.com/')) {
     return {
       name: input.slice(25, -45),
       id: input.slice(-40),
       type: 'github'
     }
  }

  const npmResolution = parseTarballUrl(input)
  if (!npmResolution) throw new TypeError(`Unsupported resolution format: ${input}`)

  return npmResolution
}

export const formatResolution: IFormatResolution = ({type, id, name, registry, hash}) => {
  if (type === 'github') {
    return `git+ssh://git@github.com/${name}.git#${id}`
  }

  return formatTarballUrl(name as string, id, registry, hash)
}
