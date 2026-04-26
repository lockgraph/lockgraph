import {TEntry, TSnapshot, TSnapshotIndex} from './interface'
import {debug, sortObject} from './util'

export const getDeps = (entry: TEntry): Record<string, string> => {
  if (!getDeps.cache.has(entry)) {
    getDeps.cache.set(entry, {
      ...sortObject(entry.dependencies || {}),
      ...sortObject({...entry.devDependencies, ...entry.optionalDependencies})
    })
  }

  return getDeps.cache.get(entry) as Record<string, string>
}

getDeps.cache = new WeakMap<TEntry, Record<string, string>>()

type TWalkCtx = {
  root: TEntry,
  entry?: TEntry
  idx: TSnapshotIndex
  id?: string
  prefix?: string
  depth?: number
  parentId?: string
  parents?: TEntry[]
}

const walk = (ctx: TWalkCtx) => {
  const {root, entry = root, prefix, depth = 0, parentId, idx, id = idx.getEntryId(entry), parents = []} = ctx
  const key = (prefix ? prefix + ',' : '') + entry.name

  if (id === undefined) {
    throw new TypeError(`Invalid snapshot: ${key}`)
  }

  if (!idx.tree[key]) {
    const chunks = key.split(',')
    idx.tree[key] = {
      key,
      chunks,
      id,
      name: entry.name,
      version: entry.version,
      entry,
      parents,
      depth,
    }
    if (root.dependencies?.[chunks[1]]) {
      idx.prod.add(entry)
    }
    if (parentId !== undefined) {
      idx.edges.push([parentId, id])
      return
    }
    if (depth) {
      return
    }
  }

  const stack: any[] = []
  const dependencies = getDeps(entry)

  Object.entries(dependencies).forEach(([name, range]) => {
    const _entry = idx.getEntryByRange(name, range)
    if (!_entry) {
      throw new Error(`inconsistent snapshot: ${name} ${range}`)
    }
    idx.bound(entry, _entry)
    if (parents.includes(entry)) {
      return
    }
    const _ctx: TWalkCtx = {root, entry: _entry, prefix: key, depth: depth + 1, parentId: id, idx, parents: [...parents, entry]}
    stack.push(_ctx)
    walk(_ctx)
  })

  stack.forEach(walk)
}

export const getId = (name?: string, version: string = ''): string => name
  ? `${name}@${version}`
  : ''

export const analyze = (snapshot: TSnapshot): TSnapshotIndex => {
  const entries: TEntry[] = Object.values(snapshot)
  const roots = entries.filter(e => e.source.type === 'workspace')
  const prod = new Set(roots)
  const deps = new Map()
  const edges: [string, string][] = []
  const tree: TSnapshotIndex['tree'] = {}
  const rangeMap = new Map()
  const idx: TSnapshotIndex = {
    snapshot,
    roots,
    edges,
    tree,
    prod,
    entries,
    bound(from: TEntry, to: TEntry) {
      const deps = this.getEntryDeps(from)
      if (deps.includes(to)) {
        return
      }

      deps.push(to)
    },
    getEntryId ({name, version}: TEntry): string {
      return getId(name, version)
    },
    getEntry (name: string, version?: string) {
      return snapshot[name] || snapshot[getId(name, version)]
    },
    getEntryByRange (name: string, range: string) {
      const key = getId(name, range)
      if (rangeMap.has(key)) {
        return rangeMap.get(key)
      }

      const _ranges = [range, range.replace('semver:', 'npm:'), range.replace('npm:', 'semver:')]
      const found = entries.find(e => name === e.name && _ranges.some(r => e.ranges.includes(r) || e.patch?.refs.includes(`${name}@${r}`)))
      rangeMap.set(key, found)
      return found
    },
    getEntryDeps (entry: TEntry): TEntry[] {
      if (!deps.has(entry)) {
        deps.set(entry, [])
      }
      return deps.get(entry)
    }
  }

  const now = Date.now()
  roots.forEach((root) => {
    const isRoot = root.source.id === '.'
    // exclude pseudo root
    if (isRoot && !root.manifest) return
    walk({root, idx, id: isRoot ? '' : undefined})
  })
  // walk({root: roots[0], idx, id: ''})
  // walk({root: roots[2], idx})
  debug('analyze duration=', Date.now() - now, 'deptree size=', Object.keys(tree).length)
  debug.json('deptree.json', Object.values(tree).map(({parents, name}) => [...parents.map(p=> p.name).slice(1), name].join(',')))

  return idx
}
