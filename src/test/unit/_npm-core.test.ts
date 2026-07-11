import { describe, expect, it } from 'vitest'

import {
  newBuilder,
  serializeNodeId,
  type Diagnostic,
  type Graph,
  type Node,
} from '../../main/ts/graph.ts'
import { LockfileError } from '../../main/ts/errors.ts'

import {
  parse as parseV3,
  stringify as stringifyV3,
  enrich as enrichV3,
  optimize as optimizeV3,
} from '../../main/ts/formats/npm-3.ts'
import {
  buildSyntheticRootEntry,
  collectManifestBlocks,
  fallbackInstallPathForNode,
  nameFromInstallPath,
  pruneSidecar,
  type NpmFamilyConfig,
  type NpmSidecar,
} from '../../main/ts/formats/_npm-core.ts'

// A valid 88-char sha512 SRI (ms@2.1.3) that survives parseSri without being
// dropped as empty.
const MS_SRI =
  'sha512-6FlzubTLZG3J2a/NVCAleEhjzq5oxgHyaCU9yYXvcLsvoVaHJq/s5xXI6/XXP6tz7R9xAOtHnSO/tXtF3WRTlA=='

const V3_CONFIG: NpmFamilyConfig = {
  lockfileVersion: 3,
  topLevelShape: 'packages-only',
  diagnosticPrefix: 'NPM_V3',
}

const collectDiagnostics = (
  fn: (emit: (d: Diagnostic) => void) => void,
): Diagnostic[] => {
  const diagnostics: Diagnostic[] = []
  fn(d => diagnostics.push(d))
  return diagnostics
}

// A minimal npm-3 lock object with an overridable `packages` map.
const v3Lock = (packages: Record<string, unknown>, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({
    name: 'root',
    version: '1.0.0',
    lockfileVersion: 3,
    requires: true,
    packages,
    ...extra,
  })

describe('parse', () => {
  it('throws PARSE_FAILED when the "packages" map has no "" root entry', () => {
    const lock = v3Lock({ 'node_modules/ms': { version: '2.1.3' } })
    expect(() => parseV3(lock)).toThrow(LockfileError)
    try {
      parseV3(lock)
    } catch (error) {
      expect((error as LockfileError).code).toBe('PARSE_FAILED')
      expect((error as LockfileError).message).toContain('missing root entry')
    }
  })

  it('throws FORMAT_MISMATCH when the top-level JSON value is an array, not an object', () => {
    // Valid JSON, but a top-level array — parseJson rejects it. The
    // lockfileVersion regex must still match so checkFamily is not the gate.
    const lock = '[{"lockfileVersion":3,"packages":{}}]'
    expect(() => parseV3(lock)).toThrow(LockfileError)
    try {
      parseV3(lock)
    } catch (error) {
      expect((error as LockfileError).code).toBe('FORMAT_MISMATCH')
      expect((error as LockfileError).message).toContain('must be a JSON object')
    }
  })

  it('throws IRREDUCIBLE_LOSS when two workspace members collapse onto one NodeId', () => {
    // Both members share the SAME explicit name+version, so they collide on the
    // NodeId.
    const lock = v3Lock({
      '': { name: 'root', version: '1.0.0' },
      'packages/a': { version: '0.0.0' },
      'packages/b': { version: '0.0.0' },
      'node_modules/dup': { resolved: 'packages/a', link: true },
      'node_modules/dup2': { resolved: 'packages/b', link: true },
    })
    const collidingLock = v3Lock({
      '': { name: 'root', version: '1.0.0' },
      'packages/a': { name: 'same', version: '1.2.3' },
      'packages/b': { name: 'same', version: '1.2.3' },
    })
    expect(() => parseV3(collidingLock)).toThrow(LockfileError)
    try {
      parseV3(collidingLock)
    } catch (error) {
      expect((error as LockfileError).code).toBe('IRREDUCIBLE_LOSS')
      expect((error as LockfileError).message).toContain('collapse onto NodeId')
    }
    // The non-colliding variant (distinct link names) parses fine.
    expect(() => parseV3(lock)).not.toThrow()
  })

  it('throws PARSE_FAILED when a link entry omits "resolved"', () => {
    const lock = v3Lock({
      '': { name: 'root', version: '1.0.0' },
      'node_modules/x': { link: true },
    })
    try {
      parseV3(lock)
      throw new Error('expected parse to throw')
    } catch (error) {
      expect(error).toBeInstanceOf(LockfileError)
      expect((error as LockfileError).code).toBe('PARSE_FAILED')
      expect((error as LockfileError).message).toContain('missing resolved')
    }
  })

  it('throws PARSE_FAILED when a link entry resolves to an unknown workspace', () => {
    const lock = v3Lock({
      '': { name: 'root', version: '1.0.0' },
      'node_modules/x': { link: true, resolved: 'packages/nonexistent' },
    })
    try {
      parseV3(lock)
      throw new Error('expected parse to throw')
    } catch (error) {
      expect(error).toBeInstanceOf(LockfileError)
      expect((error as LockfileError).code).toBe('PARSE_FAILED')
      expect((error as LockfileError).message).toContain('unknown workspace')
    }
  })

  it('throws PARSE_FAILED when a node_modules entry omits "version"', () => {
    const lock = v3Lock({
      '': { name: 'root', version: '1.0.0' },
      // No version, no resolved, NOT optional → hits the version-required throw.
      'node_modules/ms': { integrity: MS_SRI },
    })
    try {
      parseV3(lock)
      throw new Error('expected parse to throw')
    } catch (error) {
      expect(error).toBeInstanceOf(LockfileError)
      expect((error as LockfileError).code).toBe('PARSE_FAILED')
      expect((error as LockfileError).message).toContain('missing version')
    }
  })

  it('stashes a nested dep\'s devDependencies in the sidecar and re-emits them', () => {
    // A node_modules entry (NOT root, NOT a workspace member) that carries
    // devDependencies: the parser keeps them in the node sidecar rather than
    // turning them into dev edges, and stringify replays them verbatim.
    const lock = v3Lock({
      '': { name: 'root', version: '1.0.0', dependencies: { pkg: '1.0.0' } },
      'node_modules/pkg': {
        version: '1.0.0',
        resolved: 'https://registry.npmjs.org/pkg/-/pkg-1.0.0.tgz',
        integrity: MS_SRI,
        devDependencies: { 'dev-only': '^2.0.0' },
      },
    })
    const graph = parseV3(lock)
    const out = JSON.parse(stringifyV3(graph)) as {
      packages: Record<string, { devDependencies?: Record<string, string> }>
    }
    expect(out.packages['node_modules/pkg']!.devDependencies).toEqual({
      'dev-only': '^2.0.0',
    })
  })

  it('preserves a boolean root bundleDependencies across parse→stringify', () => {
    const lock = v3Lock({
      '': { name: 'root', version: '1.0.0', bundleDependencies: true },
    })
    const graph = parseV3(lock)
    const out = JSON.parse(stringifyV3(graph)) as {
      packages: Record<string, { bundleDependencies?: unknown }>
    }
    expect(out.packages['']!.bundleDependencies).toBe(true)
  })
})

describe('stringify', () => {
  it('does NOT synthesize packages[""].overrides for caller overrides — diagnoses instead', () => {
    // npm reads overrides from package.json, not the lock; the field is non-native,
    // so caller overrides surface INTEROP_OVERRIDE_NOT_PROJECTED (owed to a
    // companion manifest patch) rather than a forged lock block.
    const graph = parseV3(v3Lock({ '': { name: 'root', version: '1.0.0' } }))
    const diags: Diagnostic[] = []
    const out = JSON.parse(
      stringifyV3(graph, { overrides: [{ package: 'lodash', to: '4.17.21' }], onDiagnostic: d => diags.push(d) }),
    ) as { packages: Record<string, { overrides?: unknown }> }
    expect(out.packages['']!.overrides).toBeUndefined()
    expect(diags.map(d => d.code)).toContain('INTEROP_OVERRIDE_NOT_PROJECTED')
  })

  it('emits NOTHING for an explicit empty overrides array (suppresses captured fallback)', () => {
    // An explicit [] means "the caller asked for none" → no overrides slot even
    // if the lock carried a captured block.
    const lock = v3Lock({
      '': { name: 'root', version: '1.0.0', overrides: { lodash: '4.17.20' } },
    })
    const graph = parseV3(lock)
    const text = stringifyV3(graph, { overrides: [] })
    const out = JSON.parse(text) as {
      packages: Record<string, { overrides?: unknown }>
    }
    expect(out.packages['']!.overrides).toBeUndefined()
  })

  it('does NOT re-emit a captured non-native overrides block — drops it + diagnoses', () => {
    // A non-native lock that carries `packages[""].overrides` is captured into the
    // graph but never re-emitted: npm ignores a lock overrides field.
    const lock = v3Lock({
      '': { name: 'root', version: '1.0.0', overrides: { lodash: '4.17.20', ms: '2.1.3' } },
    })
    const graph = parseV3(lock)
    const diags: Diagnostic[] = []
    const out = JSON.parse(stringifyV3(graph, { onDiagnostic: d => diags.push(d) })) as {
      packages: Record<string, { overrides?: unknown }>
    }
    expect(out.packages['']!.overrides).toBeUndefined()
    expect(diags.map(d => d.code)).toContain('INTEROP_OVERRIDE_NOT_PROJECTED')
  })
})

describe('nameFromInstallPath', () => {
  it('returns entry.name verbatim when present and not a link', () => {
    expect(nameFromInstallPath(V3_CONFIG, 'node_modules/whatever', { name: 'real', version: '1.0.0' }))
      .toBe('real')
  })

  it('derives the tail package name from the install path when name is absent', () => {
    expect(nameFromInstallPath(V3_CONFIG, 'node_modules/a/node_modules/@scope/b', { version: '1.0.0' }))
      .toBe('@scope/b')
  })

  it('throws PARSE_FAILED when the install path yields no derivable tail', () => {
    // A bare "node_modules/" path (empty tail) with no entry.name.
    try {
      nameFromInstallPath(V3_CONFIG, 'node_modules/', { version: '1.0.0' })
      throw new Error('expected throw')
    } catch (error) {
      expect(error).toBeInstanceOf(LockfileError)
      expect((error as LockfileError).code).toBe('PARSE_FAILED')
      expect((error as LockfileError).message).toContain('cannot derive name')
    }
  })
})

describe('fallbackInstallPathForNode', () => {
  const node: Node = { id: 'ms@2.1.3', name: 'ms', version: '2.1.3', peerContext: [] }

  it('returns the primary node_modules/<name> path when it is free', () => {
    expect(fallbackInstallPathForNode(node, new Map())).toBe('node_modules/ms')
  })

  it('returns the primary path when it is already occupied by THIS node', () => {
    const occupied = new Map<string, string>([['node_modules/ms', 'ms@2.1.3']])
    expect(fallbackInstallPathForNode(node, occupied)).toBe('node_modules/ms')
  })

  it('mints a synthetic deep path when node_modules/<name> is taken by a different node', () => {
    const occupied = new Map<string, string>([['node_modules/ms', 'ms@9.9.9']])
    expect(fallbackInstallPathForNode(node, occupied)).toBe(
      'node_modules/.lockfile-ms-2.1.3-1/node_modules/ms',
    )
  })

  it('advances the ordinal when the first synthetic path is also taken', () => {
    const occupied = new Map<string, string>([
      ['node_modules/ms', 'ms@9.9.9'],
      ['node_modules/.lockfile-ms-2.1.3-1/node_modules/ms', 'ms@8.8.8'],
    ])
    expect(fallbackInstallPathForNode(node, occupied)).toBe(
      'node_modules/.lockfile-ms-2.1.3-2/node_modules/ms',
    )
  })
})

describe('buildSyntheticRootEntry', () => {
  it('emits only the defined root-meta fields (name/version/workspaces/bundleDependencies)', () => {
    expect(
      buildSyntheticRootEntry({
        name: 'root',
        version: '1.0.0',
        workspaces: ['packages/*'],
        bundleDependencies: ['ms'],
      }),
    ).toEqual({
      name: 'root',
      version: '1.0.0',
      workspaces: ['packages/*'],
      bundleDependencies: ['ms'],
    })
  })

  it('omits every absent field (an empty root-meta yields an empty entry)', () => {
    expect(buildSyntheticRootEntry({})).toEqual({})
  })
})

describe('collectManifestBlocks', () => {
  const build = (assemble: (b: ReturnType<typeof newBuilder>) => void): Graph => {
    const b = newBuilder()
    assemble(b)
    return b.seal()
  }

  it('buckets dep/dev/peer/optional ranges and SKIPS a bundled edge', () => {
    // peer edges require peerContext coherence, so give the src a peerContext.
    const graph = build(b => {
      b.addNode({ id: 'root@1.0.0', name: 'root', version: '1.0.0', peerContext: [], workspacePath: '' })
      b.addNode({ id: 'd@1.0.0', name: 'd', version: '1.0.0', peerContext: [] })
      b.addNode({ id: 'v@1.0.0', name: 'v', version: '1.0.0', peerContext: [] })
      b.addNode({ id: 'o@1.0.0', name: 'o', version: '1.0.0', peerContext: [] })
      b.addNode({ id: 'bun@1.0.0', name: 'bun', version: '1.0.0', peerContext: [] })
      b.addEdge('root@1.0.0', 'd@1.0.0', 'dep', { range: '^1.0.0' })
      b.addEdge('root@1.0.0', 'v@1.0.0', 'dev', { range: '^1.0.0' })
      b.addEdge('root@1.0.0', 'o@1.0.0', 'optional', { range: '^1.0.0' })
      // A `bundled` edge — a real EdgeKind, but collectManifestBlocks has no
      // bucket for it, so it is skipped.
      b.addEdge('root@1.0.0', 'bun@1.0.0', 'bundled', { range: '^1.0.0' })
    })
    const blocks = collectManifestBlocks(graph, 'root@1.0.0', undefined)
    expect(blocks.dep).toEqual({ d: '^1.0.0' })
    expect(blocks.dev).toEqual({ v: '^1.0.0' })
    expect(blocks.optional).toEqual({ o: '^1.0.0' })
    expect(blocks.peer).toEqual({})
    // The bundled edge produced NO entry in any bucket.
    const all = { ...blocks.dep, ...blocks.dev, ...blocks.peer, ...blocks.optional }
    expect(all.bun).toBeUndefined()
  })

  it('resolves a workspace edge to its resolvedVersion + fires RECIPE_WORKSPACE_RESOLVED', () => {
    // Edge marked workspace:true with a NON-empty specifier and a
    // resolvedVersion → emits RECIPE_WORKSPACE_RESOLVED and writes the version.
    const graph = build(b => {
      b.addNode({ id: 'root@1.0.0', name: 'root', version: '1.0.0', peerContext: [], workspacePath: '' })
      b.addNode({ id: 'm@2.0.0', name: 'm', version: '2.0.0', peerContext: [], workspacePath: 'packages/m' })
      b.addEdge('root@1.0.0', 'm@2.0.0', 'dep', {
        range: 'workspace:^',
        workspace: true,
        workspaceRange: { specifier: 'workspace:^', resolvedVersion: '2.0.0' },
      })
    })
    const diagnostics = collectDiagnostics(emit => {
      const blocks = collectManifestBlocks(graph, 'root@1.0.0', undefined, emit)
      expect(blocks.dep).toEqual({ m: '2.0.0' })
    })
    expect(diagnostics.map(d => d.code)).toContain('RECIPE_WORKSPACE_RESOLVED')
  })

  it('drops a workspace edge with no resolvedVersion + fires RECIPE_WORKSPACE_UNRESOLVED', () => {
    // workspace:true, non-empty specifier, but resolvedVersion undefined →
    // stringifyForVersionOnly returns undefined → UNRESOLVED + entry dropped.
    const graph = build(b => {
      b.addNode({ id: 'root@1.0.0', name: 'root', version: '1.0.0', peerContext: [], workspacePath: '' })
      b.addNode({ id: 'm@2.0.0', name: 'm', version: '2.0.0', peerContext: [], workspacePath: 'packages/m' })
      b.addEdge('root@1.0.0', 'm@2.0.0', 'dep', {
        range: 'workspace:^',
        workspace: true,
        workspaceRange: { specifier: 'workspace:^' },
      })
    })
    const diagnostics = collectDiagnostics(emit => {
      const blocks = collectManifestBlocks(graph, 'root@1.0.0', undefined, emit)
      // Entry dropped — no `m` key in any block.
      expect(blocks.dep).toEqual({})
    })
    expect(diagnostics.map(d => d.code)).toContain('RECIPE_WORKSPACE_UNRESOLVED')
  })
})

describe('enrichFamily', () => {
  const build = (assemble: (b: ReturnType<typeof newBuilder>) => void): Graph => {
    const b = newBuilder()
    assemble(b)
    return b.seal()
  }

  it('marks a workspace edge with workspaceRange carrying resolvedVersion when the member has a version', () => {
    const graph = build(b => {
      b.addNode({ id: 'root@1.0.0', name: 'root', version: '1.0.0', peerContext: [], workspacePath: '' })
      b.addNode({ id: 'm@2.0.0', name: 'm', version: '2.0.0', peerContext: [], workspacePath: 'packages/m' })
      b.addEdge('root@1.0.0', 'm@2.0.0', 'dep', { range: '2.0.0' })
    })
    const { graph: enriched } = enrichV3(graph)
    const edge = enriched.out('root@1.0.0', 'dep').find(e => e.dst === 'm@2.0.0')
    expect(edge?.attrs?.workspace).toBe(true)
    expect(edge?.attrs?.workspaceRange).toEqual({ specifier: '', resolvedVersion: '2.0.0' })
  })

  it('omits resolvedVersion in the workspaceRange when the member version is empty', () => {
    // A workspace member whose version is the empty string → the F4 carrier
    // gets `{ specifier: '' }` with NO resolvedVersion.
    const graph = build(b => {
      b.addNode({ id: 'root@1.0.0', name: 'root', version: '1.0.0', peerContext: [], workspacePath: '' })
      b.addNode({ id: serializeNodeId('m', '', []), name: 'm', version: '', peerContext: [], workspacePath: 'packages/m' })
      b.addEdge('root@1.0.0', serializeNodeId('m', '', []), 'dep', { range: '*' })
    })
    const { graph: enriched } = enrichV3(graph)
    const edge = enriched.out('root@1.0.0', 'dep').find(e => e.dst === 'm@')
    expect(edge?.attrs?.workspace).toBe(true)
    expect(edge?.attrs?.workspaceRange).toEqual({ specifier: '' })
    expect(edge?.attrs?.workspaceRange?.resolvedVersion).toBeUndefined()
  })
})

describe('addDepEdges', () => {
  it('creates distinct dep + optional edges when the root lists the same package under both', () => {
    // Root lists `ms` under BOTH dependencies and optionalDependencies. They are
    // separate EdgeKinds, so both edges land toward the single ms node.
    const lock = v3Lock({
      '': {
        name: 'root',
        version: '1.0.0',
        dependencies: { ms: '^2.1.0' },
        optionalDependencies: { ms: '^2.1.0' },
      },
      'node_modules/ms': {
        version: '2.1.3',
        resolved: 'https://registry.npmjs.org/ms/-/ms-2.1.3.tgz',
        integrity: MS_SRI,
      },
    })
    const graph = parseV3(lock)
    const out = graph.out('root@1.0.0')
    expect(out.some(e => e.dst === 'ms@2.1.3' && e.kind === 'dep')).toBe(true)
    expect(out.some(e => e.dst === 'ms@2.1.3' && e.kind === 'optional')).toBe(true)
  })

  it('stamps edge.attrs.alias when the manifest key differs from the target package name', () => {
    // An npm-alias dep: the root declares `ms-alias: npm:ms@^2` via a
    // node_modules/ms-alias entry whose `name` is the REAL package (`ms`). The
    // manifest key (`ms-alias`) differs from the resolved node name (`ms`) →
    // the edge carries `alias: 'ms-alias'`.
    const lock = v3Lock({
      '': { name: 'root', version: '1.0.0', dependencies: { 'ms-alias': 'npm:ms@^2.1.0' } },
      'node_modules/ms-alias': {
        name: 'ms',
        version: '2.1.3',
        resolved: 'https://registry.npmjs.org/ms/-/ms-2.1.3.tgz',
        integrity: MS_SRI,
      },
    })
    const graph = parseV3(lock)
    const edge = graph.out('root@1.0.0', 'dep').find(e => e.dst === 'ms@2.1.3')
    expect(edge).toBeDefined()
    expect(edge?.attrs?.alias).toBe('ms-alias')
  })
})

describe('optimize', () => {
  // Two node_modules entries that require ONLY each other (oa ⇄ ob) and are
  // referenced by nobody at root → neither is a root, both unreachable.
  const v3CycleLock = v3Lock({
    '': { name: 'root', version: '1.0.0', dependencies: { ms: '2.1.3' } },
    'node_modules/ms': { version: '2.1.3', resolved: 'https://registry.npmjs.org/ms/-/ms-2.1.3.tgz', integrity: MS_SRI },
    'node_modules/oa': { version: '1.0.0', resolved: 'https://registry.npmjs.org/oa/-/oa-1.0.0.tgz', integrity: MS_SRI, dependencies: { ob: '1.0.0' } },
    'node_modules/ob': { version: '1.0.0', resolved: 'https://registry.npmjs.org/ob/-/ob-1.0.0.tgz', integrity: MS_SRI, dependencies: { oa: '1.0.0' } },
  })

  it('prunes the unreachable pair and keeps the reachable ms node on a parsed graph', () => {
    const graph = parseV3(v3CycleLock)
    expect(graph.getNode('oa@1.0.0')).toBeDefined()
    expect(graph.getNode('ob@1.0.0')).toBeDefined()
    const result = optimizeV3(graph)
    expect(result.graph.getNode('oa@1.0.0')).toBeUndefined()
    expect(result.graph.getNode('ob@1.0.0')).toBeUndefined()
    expect(result.graph.getNode('ms@2.1.3')).toBeDefined()
    // The pruned graph still stringifies to a valid npm-3 lock with only ms.
    const out = JSON.parse(stringifyV3(result.graph)) as {
      packages: Record<string, unknown>
    }
    expect(out.packages['node_modules/ms']).toBeDefined()
    expect(out.packages['node_modules/oa']).toBeUndefined()
    expect(out.packages['node_modules/ob']).toBeUndefined()
  })
})

describe('pruneSidecar', () => {
  it('keeps only entries whose node ids survive; rewrites edge maps + workspaces', () => {
    // Build a graph that KEEPS root + keep@1.0.0 and DROPS drop@2.0.0.
    const b = newBuilder()
    b.addNode({ id: 'root@1.0.0', name: 'root', version: '1.0.0', peerContext: [], workspacePath: '' })
    b.addNode({ id: 'keep@1.0.0', name: 'keep', version: '1.0.0', peerContext: [] })
    b.addEdge('root@1.0.0', 'keep@1.0.0', 'dep', { range: '^1.0.0' })
    const survivor = b.seal()

    // A sidecar that references BOTH surviving and dropped ids.
    const sidecar: NpmSidecar = {
      rootId: 'root@1.0.0',
      rootMeta: { name: 'root', version: '1.0.0' },
      nodes: new Map([
        ['keep@1.0.0', { installPaths: ['node_modules/keep'], dev: true }],
        ['drop@2.0.0', { installPaths: ['node_modules/drop'] }],
      ]),
      edgeRanges: new Map([
        ['root@1.0.0|dep|keep@1.0.0', '^1.0.0'],
        ['root@1.0.0|dep|drop@2.0.0', '^2.0.0'],
      ]),
      edgeDeclaredNames: new Map([
        ['root@1.0.0|dep|keep@1.0.0', 'keep'],
        ['root@1.0.0|dep|drop@2.0.0', 'drop'],
      ]),
      workspaceByPath: new Map([
        ['', 'root@1.0.0'],
        ['packages/gone', 'drop@2.0.0'],
      ]),
    }

    const pruned = pruneSidecar(sidecar, survivor)
    // Node sidecars: only the surviving id remains.
    expect([...pruned.nodes.keys()]).toEqual(['keep@1.0.0'])
    expect(pruned.nodes.get('keep@1.0.0')?.dev).toBe(true)
    // Edge maps: only the edge whose src AND dst both survive is retained.
    expect([...pruned.edgeRanges.keys()]).toEqual(['root@1.0.0|dep|keep@1.0.0'])
    expect([...pruned.edgeDeclaredNames.keys()]).toEqual(['root@1.0.0|dep|keep@1.0.0'])
    // Workspace map: the entry pointing at the dropped node is removed.
    expect([...pruned.workspaceByPath.entries()]).toEqual([['', 'root@1.0.0']])
    // rootId survives because root@1.0.0 is still in the graph; rootMeta passes through.
    expect(pruned.rootId).toBe('root@1.0.0')
    expect(pruned.rootMeta).toEqual({ name: 'root', version: '1.0.0' })
  })

  it('nulls rootId when the root node itself did not survive', () => {
    // A graph WITHOUT root@1.0.0 → pruneSidecar clears the stale rootId.
    const b = newBuilder()
    b.addNode({ id: 'lone@1.0.0', name: 'lone', version: '1.0.0', peerContext: [], workspacePath: '' })
    const graph = b.seal()
    const sidecar: NpmSidecar = {
      rootId: 'root@1.0.0',
      rootMeta: { name: 'root', version: '1.0.0' },
      nodes: new Map(),
      edgeRanges: new Map(),
      edgeDeclaredNames: new Map(),
      workspaceByPath: new Map(),
    }
    expect(pruneSidecar(sidecar, graph).rootId).toBeUndefined()
  })
})
