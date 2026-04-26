import semver from 'semver'
import fs from 'node:fs/promises'
import {topo, traverseDeps} from '@semrel-extra/topo'
import {URL} from 'node:url'
import {IFormatReference, TDependencies, THashes, TSnapshot, TSource} from './interface'

export const getSources = (snapshot: TSnapshot): string[] =>
  Object.values(snapshot)
    .map(entry => entry.source.id)
    .filter(Boolean)

export const parseIntegrity = (integrity?: string): THashes =>
  integrity
    ? integrity.split(' ').reduce<THashes>((m, item) => {
      const [k, v] = item.split('-')
      if (k === 'sha512' || k === 'sha256' || k === 'sha1' || k === 'checksum') {
        m[k] = v
      } else if (!v){
        m['checksum'] = k
      }

      return m
    }, {})
    : {}

export const formatIntegrity = (hashes: THashes): string => {
  const checksum = hashes['checksum']
  if (checksum) {
    return checksum
  }

  return Object.entries(hashes).map(([k, v]) => `${k}-${v}`).join(' ')
}

export interface IReference {
  protocol: string
  id: string
  name?: string
  host?: string
  [extra: string]: any
}

const parseVersion = (version: string): string | null => semver.valid(version) || semver.coerce(version)?.version || null

const parseCaret = (value: string): string => (value.startsWith('^') || value.startsWith('~')) ? value[0] : ''

const parseName = (value: string): string => (value).slice(0, (value + '.').indexOf('.'))

export const parseTarballUrl = (resolution: string): TSource | null => {
  // https://registry.yarnpkg.com/@babel/code-frame/-/code-frame-7.5.5.tgz#bc0782f6d69f7b7d49531219699b988f669a8f9d
  // https://registry.npmjs.org/@ampproject/remapping/-/remapping-2.2.0.tgz
  // Use regexp or URL to parse? A benchmark is needed.
  const [tgz, br, _name, org, ...rest] = resolution.split('/').reverse()
  if (br !== '-') {
    return null
  }

  const hasScope = org[0] === '@'
  const name = hasScope ? `${org}/${_name}` : _name
  const id = tgz.slice(_name.length + 1, tgz.lastIndexOf('.tgz'))

  return {
    type: 'npm',
    name,
    id,
    registry: rest.reverse().join('/') + (hasScope ? '' : '/' + org),
    hash: tgz.slice((tgz + '#').indexOf('#'))
  }
}

export const formatTarballUrl = (name: string, version: string, registry = 'https://registry.npmjs.org', hash = '') =>
  `${registry}/${name}/-/${name.slice(name.indexOf('/') + 1)}-${version}.tgz${hash}`


// https://docs.npmjs.com/cli/v10/configuring-npm/package-json#dependencies
// https://v3.yarnpkg.com/features/protocols
const gitProtocols = ['git', 'git+ssh', 'git+http', 'git+https', 'git+file']
const refProtocols = ['npm', 'github', 'workspace', 'semver', 'tag', 'patch', 'link', 'portal', 'file', ...gitProtocols]

export const normalizeDeps = (deps?: TDependencies): TDependencies | undefined => processDeps(deps, normalizeReference)

export const processDeps = (deps?: TDependencies, formatter: IFormatReference = v => v, opts: any = {}): TDependencies | undefined => deps && Object.entries(deps).reduce<TDependencies>((m, [k, v]) => {
  m[k] = formatter(v + '', opts) as string
  return m
}, {})

export const normalizeReference = (ref: string): string => {
  if (refProtocols.some(p => ref.startsWith(p + ':'))) {
    return ref
  }

  if (semver.validRange(ref)) {
    return 'semver:' + ref
  }

  if (ref.includes('.git')) {
    return 'git:' + ref
  }

  if (ref.includes('/')) {
    return 'github:' + ref
  }

  return 'tag:' + ref
  // throw new TypeError(`unsupported ref type: ${ref}`)
}

export const parseReference = (raw?: any): IReference => {
  if (raw.startsWith('workspace:')) {
    return {
      protocol: 'workspace',
      id: raw.slice(10)
    }
  }

  if (raw.startsWith('npm:')) {
    return {
      protocol: 'npm',
      id: raw.slice(4)
    }
  }

  if (URL.canParse(raw)) {
    const url = new URL(raw)
    return {
      protocol: url.protocol.slice(0, -1),
      name: parseName(url.pathname.startsWith('/') ? url.pathname.slice(1) : url.pathname),
      id: url.hash.slice(1),
      host: url.host
    }
  }

  if (raw.includes('/') && !raw.includes(':')) { // use regexp?
    const name = raw.slice(0, (raw + '#').indexOf('#'))
    return {
      protocol: 'github',
      name,
      id: raw.slice(name.length + 1)
    }
  }

  return {
    protocol: 'semver',
    id: raw,
  }
}

export const referenceKeysSorter = (a: string, b: string) => {
  const _a = a.includes('npm:')
  const _b = b.includes('npm:')
  return _a === _b
    ? 0
    : +_b - +_a
}

export const mapReference = (current: string, targetProtocol: string, strategy = 'inherit'): string => {
  const {id, protocol} = parseReference(current)
  const version = parseVersion(id)
  const caret = parseCaret(id)
  const prefix = targetProtocol === 'semver' ? '' : `${targetProtocol}:`

  if (protocol === targetProtocol) {
    return current
  }

  if (version === null) {
    return prefix + '*'
  }

  const _version = strategy === 'pin'
    ? version
    : strategy === 'inherit'
      ? (caret + version)
      : strategy

  return prefix + _version
}

/**
 * Replaces local monorepo cross-refs with the target protocol: workspace or semver
 */
export const switchMonorefs = async ({cwd, strategy, protocol = 'semver', dryrun = false}: {
  cwd?: string
  strategy?: string // 'inherit' | 'pin' | 'coerce'
  protocol?: string
  dryrun?: boolean
}) => {
  const {packages} = await topo({cwd})

  await Promise.all(Object.values(packages).map(async pkg => {
    await traverseDeps({pkg, packages, cb({name, version, deps}) {
      deps[name] = mapReference(version, protocol, strategy)
    }})

    if (dryrun) {
      return
    }

    await fs.writeFile(pkg.manifestAbsPath, JSON.stringify(pkg.manifest), 'utf8')
  }))

  return packages
}
