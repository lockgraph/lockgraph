import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { type Diagnostic, type Graph, type GraphDiff } from '../../main/ts/graph.ts'
import { LockfileError } from '../../main/ts/errors.ts'
import { check, enrich, optimize, parse, stringify } from '../../main/ts/formats/npm-3.ts'
import { parse as parseClassic } from '../../main/ts/formats/yarn-classic.ts'
import { parse as parseV9 } from '../../main/ts/formats/yarn-berry-v9.ts'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = (rel: string): string =>
  readFileSync(resolve(here, '../resources/fixtures/lockfiles', rel), 'utf8')

// Phase §A working fixture set per ADR-0021 §"Acceptance gate — per-version".
const FIXTURES = [
  'bundled-deps',
  'deps-with-scopes',
  'git-github-tarball',
  'peers-basic',
  'peers-multi',
  'simple',
  'workspaces-basic',
  'yarn-crlf',
] as const

function graphSnapshot(graph: Graph) {
  return {
    nodes: Array.from(graph.nodes(), node => ({ ...node })),
    edges: Array.from(graph.nodes(), node =>
      graph.out(node.id).map(edge => ({
        src: edge.src,
        dst: edge.dst,
        kind: edge.kind,
        attrs: edge.attrs === undefined ? undefined : { ...edge.attrs },
      })),
    ).flat(),
    tarballs: Array.from(graph.tarballs(), ([key, payload]) => [key, payload] as const),
  }
}

function expectEmptyGraphDiff(diff: GraphDiff) {
  expect(diff).toEqual({
    addedNodes: [],
    removedNodes: [],
    changedNodes: [],
    addedEdges: [],
    removedEdges: [],
  })
}

function parseFixtureGraph(name: typeof FIXTURES[number]): Graph {
  return parse(fixture(`${name}/npm-3.lock`))
}

describe('npm-3 — discriminant and isolation (§A cross-version)', () => {
  it('accepts an npm-3 header and rejects npm-1 / npm-2 / yarn-* / pnpm-* / bun-text', () => {
    const v3 = fixture('simple/npm-3.lock')
    const v1 = fixture('simple/npm-1.lock')
    const v2 = fixture('simple/npm-2.lock')
    const yarnClassic = fixture('simple/yarn-classic.lock')
    const yarnBerry = fixture('simple/yarn-berry-v9.lock')

    expect(check(v3)).toBe(true)
    expect(check(v1)).toBe(false)
    expect(check(v2)).toBe(false)
    expect(check(yarnClassic)).toBe(false)
    expect(check(yarnBerry)).toBe(false)
  })

  it('parse rejects lockfileVersion 1 with FORMAT_MISMATCH', () => {
    const v1 = fixture('simple/npm-1.lock')
    expect(() => parse(v1)).toThrow(LockfileError)
    try { parse(v1) } catch (error) {
      expect((error as LockfileError).code).toBe('FORMAT_MISMATCH')
      expect((error as LockfileError).message).toContain('lockfileVersion 3')
    }
  })

  it('parse rejects lockfileVersion 2 with FORMAT_MISMATCH', () => {
    const v2 = fixture('simple/npm-2.lock')
    expect(() => parse(v2)).toThrow(LockfileError)
    try { parse(v2) } catch (error) {
      expect((error as LockfileError).code).toBe('FORMAT_MISMATCH')
      expect((error as LockfileError).message).toContain('lockfileVersion 3')
    }
  })

  it('parse rejects yarn-classic input with FORMAT_MISMATCH (non-JSON)', () => {
    const yarnClassic = fixture('simple/yarn-classic.lock')
    expect(() => parse(yarnClassic)).toThrow(LockfileError)
    try { parse(yarnClassic) } catch (error) {
      expect((error as LockfileError).code).toBe('FORMAT_MISMATCH')
    }
  })

  it('parse rejects yarn-berry-v9 input with FORMAT_MISMATCH (non-JSON)', () => {
    const yarnBerry = fixture('simple/yarn-berry-v9.lock')
    expect(() => parse(yarnBerry)).toThrow(LockfileError)
    try { parse(yarnBerry) } catch (error) {
      expect((error as LockfileError).code).toBe('FORMAT_MISMATCH')
    }
  })

  it('cross-adapter probe: yarn-classic / yarn-berry-v9 parsers reject npm-3 input', () => {
    const v3 = fixture('simple/npm-3.lock')
    expect(() => parseClassic(v3)).toThrow()
    expect(() => parseV9(v3)).toThrow()
  })
})

describe('npm-3 — parse fixtures', () => {
  it.each(FIXTURES)('parses %s fixture', (fixtureName) => {
    const graph = parseFixtureGraph(fixtureName)
    expect(Array.from(graph.nodes())).not.toHaveLength(0)
  })

  it('parses the root node with workspacePath = ""', () => {
    const graph = parseFixtureGraph('simple')
    const root = graph.getNode('case-simple@0.0.0')
    expect(root).toBeDefined()
    expect(root?.workspacePath).toBe('')
  })

  it('parses node_modules entries into (name, version) graph nodes with tarball payload', () => {
    const graph = parseFixtureGraph('simple')
    const ms = graph.getNode('ms@2.1.3')
    expect(ms).toBeDefined()
    expect(ms?.peerContext).toEqual([])
    const tarball = graph.tarballOf('ms@2.1.3')
    expect(tarball?.integrity).toBe('sha512-6FlzubTLZG3J2a/NVCAleEhjzq5oxgHyaCU9yYXvcLsvoVaHJq/s5xXI6/XXP6tz7R9xAOtHnSO/tXtF3WRTlA==')
  })

  it('parses root dependencies into dep edges from the root node', () => {
    const graph = parseFixtureGraph('simple')
    const out = graph.out('case-simple@0.0.0')
    const depEdges = out.filter(edge => edge.kind === 'dep').map(edge => edge.dst).sort()
    expect(depEdges).toEqual(['lodash@4.17.21', 'ms@2.1.3'])
  })

  it('does not derive peer edges in phase A (ADR-0021 §A.npm-3 inherits ADR-0016 §A.4 known degradation)', () => {
    // peerDependencies blocks are stashed in the parse-time sidecar so
    // stringify can round-trip them on-disk, but they are NOT converted
    // into graph peer edges until §C lands (parser-side peer derivation).
    const graph = parseFixtureGraph('peers-basic')
    expect(graph.out('react-dom@18.2.0', 'peer')).toEqual([])
    // Roundtrip preserves the peer block on disk despite zero graph edges.
    const emitted = stringify(graph)
    const parsed = JSON.parse(emitted)
    expect(parsed.packages['node_modules/react-dom']?.peerDependencies).toEqual({
      react: '^18.2.0',
    })
  })

  it('parses workspace entries with workspacePath set + symlink resolution', () => {
    const graph = parseFixtureGraph('workspaces-basic')
    const memberA = graph.getNode('@case-ws/a@0.0.0')
    const memberB = graph.getNode('@case-ws/b@0.0.0')
    expect(memberA?.workspacePath).toBe('packages/a')
    expect(memberB?.workspacePath).toBe('packages/b')
    // Each member depends on ms.
    const memberAOut = graph.out('@case-ws/a@0.0.0', 'dep')
    expect(memberAOut.map(e => e.dst)).toEqual(['ms@2.1.3'])
  })

  it('parses de-hoisted nested entries by collapsing onto the canonical NodeId', () => {
    const graph = parseFixtureGraph('peers-multi')
    // peers-multi has root @ 17 + packages/b @ 18 nested. The 18 nodes are
    // canonical regardless of install path.
    expect(graph.getNode('react@17.0.2')).toBeDefined()
    expect(graph.getNode('react@18.2.0')).toBeDefined()
    expect(graph.getNode('react-dom@17.0.2')).toBeDefined()
    expect(graph.getNode('react-dom@18.2.0')).toBeDefined()
  })

  it('records integrity SRI for tarball entries', () => {
    const graph = parseFixtureGraph('deps-with-scopes')
    const t = graph.tarballOf('@sindresorhus/is@6.3.1')
    expect(t?.integrity).toMatch(/^sha512-/)
  })

  it('records resolution URL on node for tarball entries', () => {
    const graph = parseFixtureGraph('simple')
    const ms = graph.getNode('ms@2.1.3')
    expect(ms?.resolution).toBeUndefined() // resolution is not synced from `resolved` to Node; lives in sidecar / tarball flow.
  })

  it('emits NPM_V3_UNEXPECTED_LEGACY_MIRROR when input carries top-level dependencies', () => {
    const malformed = JSON.stringify({
      name: 'x',
      version: '0.0.0',
      lockfileVersion: 3,
      requires: true,
      dependencies: { ms: { version: '2.1.3' } },
      packages: {
        '': { name: 'x', version: '0.0.0', dependencies: { ms: '2.1.3' } },
        'node_modules/ms': { version: '2.1.3', resolved: 'https://registry.npmjs.org/ms/-/ms-2.1.3.tgz', integrity: 'sha512-abc' },
      },
    }, null, 2)
    const graph = parse(malformed)
    const codes = graph.diagnostics().map(d => d.code)
    expect(codes).toContain('NPM_V3_UNEXPECTED_LEGACY_MIRROR')
  })
})

describe('npm-3 — stringify (§A.4 Graph-level roundtrip)', () => {
  // §A.4 predicate per ADR-0016 §A.4: parse(stringify(parse(x))).diff(parse(x))
  // is structurally empty + tarballs() iteration-equal.
  it.each(FIXTURES.filter(name => name !== 'yarn-crlf'))('roundtrips %s at Graph level', (fixtureName) => {
    const original = parseFixtureGraph(fixtureName)
    const emitted = stringify(original)
    const reparsed = parse(emitted)

    expect(graphSnapshot(reparsed)).toEqual(graphSnapshot(original))
    expectEmptyGraphDiff(original.diff(reparsed))
    expect(Array.from(reparsed.tarballs())).toEqual(Array.from(original.tarballs()))
  })

  it('emits well-formed JSON (re-parsing through JSON.parse succeeds)', () => {
    const graph = parseFixtureGraph('simple')
    const text = stringify(graph)
    expect(() => JSON.parse(text)).not.toThrow()
    const parsed = JSON.parse(text)
    expect(parsed.lockfileVersion).toBe(3)
    expect(parsed.packages).toBeDefined()
    expect(typeof parsed.packages).toBe('object')
  })

  it('emits canonical 2-space indent + trailing newline', () => {
    const graph = parseFixtureGraph('simple')
    const text = stringify(graph)
    expect(text.endsWith('\n')).toBe(true)
    expect(text).toContain('\n  "name":')
    expect(text).toContain('\n    "":')
  })

  it('emits packages map sorted alphabetically', () => {
    const graph = parseFixtureGraph('simple')
    const text = stringify(graph)
    const obj = JSON.parse(text)
    const keys = Object.keys(obj.packages)
    expect(keys).toEqual([...keys].sort())
  })

  it('roundtrips yarn-crlf at Graph level when CRLF is requested', () => {
    const original = parseFixtureGraph('yarn-crlf')
    const emitted = stringify(original, { lineEnding: 'crlf' })
    const reparsed = parse(emitted)

    expect(emitted).toContain('\r\n')
    expect(emitted.replace(/\r\n/g, '\n')).toBe(stringify(original))
    expect(graphSnapshot(reparsed)).toEqual(graphSnapshot(original))
    expectEmptyGraphDiff(original.diff(reparsed))
  })

  it('preserves bundleDependencies on the root entry across roundtrip', () => {
    const original = parseFixtureGraph('bundled-deps')
    const emitted = stringify(original)
    const parsed = JSON.parse(emitted)
    expect(parsed.packages[''].bundleDependencies).toEqual(['ms'])
  })

  it('preserves workspaces array on the root entry across roundtrip', () => {
    const original = parseFixtureGraph('workspaces-basic')
    const emitted = stringify(original)
    const parsed = JSON.parse(emitted)
    expect(parsed.packages[''].workspaces).toEqual(['packages/*'])
  })

  it('preserves the workspace symlink shape (link: true + resolved: <wsPath>) on roundtrip', () => {
    const original = parseFixtureGraph('workspaces-basic')
    const emitted = stringify(original)
    const parsed = JSON.parse(emitted)
    expect(parsed.packages['node_modules/@case-ws/a']).toEqual({
      resolved: 'packages/a',
      link: true,
    })
    expect(parsed.packages['packages/a']).toMatchObject({
      name: '@case-ws/a',
      version: '0.0.0',
    })
  })
})

function stringifyWithDiagnostics(graph: Graph): { lockfile: string; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = []
  const lockfile = stringify(graph, {
    onDiagnostic(diagnostic) {
      diagnostics.push(diagnostic)
    },
  })
  return { lockfile, diagnostics }
}

describe('npm-3 — modify (§B Mutator surface, inherits ADR-0016 §B verbatim)', () => {
  it('roundtrips addNode', () => {
    const original = parseFixtureGraph('simple')
    const result = original.mutate(m => {
      m.addNode({
        id: 'debug@4.4.1',
        name: 'debug',
        version: '4.4.1',
        peerContext: [],
      })
      m.setTarball({ name: 'debug', version: '4.4.1' }, {
        integrity: 'sha512-fakedebugintegrity',
      })
    })
    const reparsed = parse(stringify(result.graph))

    expectEmptyGraphDiff(result.graph.diff(reparsed))
    expect(reparsed.getNode('debug@4.4.1')).toBeDefined()
    expect(result.applied).toEqual([
      { kind: 'node-added', subject: 'debug@4.4.1' },
      { kind: 'tarball-set', subject: 'debug@4.4.1' },
    ])
  })

  it('roundtrips addEdge dep', () => {
    const original = parseFixtureGraph('simple')
    const result = original.mutate(m => {
      m.addEdge('lodash@4.17.21', 'ms@2.1.3', 'dep', { range: '2.1.3' })
    })
    const reparsed = parse(stringify(result.graph))

    expectEmptyGraphDiff(result.graph.diff(reparsed))
    expect(result.applied).toEqual([
      { kind: 'edge-added', subject: { src: 'lodash@4.17.21', dst: 'ms@2.1.3', kind: 'dep' } },
    ])
  })

  it('addEdge peer with range survives on disk (npm-3 records peerDependencies block, unlike npm-1)', () => {
    // npm-3 records peerDependencies on disk per ADR-0021 §B.npm-3 — peer
    // edges persist via the entry's peerDependencies block on stringify. To
    // add a peer edge respecting the Graph invariant (peer edges must match
    // peerContext per graph.ts:380), the caller seeds the consumer node with
    // a virtualised NodeId (peerContext aligned with the peer edge dst). The
    // npm-3 stringify flattens the virtual NodeId on emit (per the family
    // peer-virt-flattened lossy rule) and writes the peerDependencies block
    // under the underlying entry.
    const original = parseFixtureGraph('simple')
    const result = original.mutate(m => {
      m.addNode({
        id: 'peer-consumer@1.0.0(ms@2.1.3)',
        name: 'peer-consumer',
        version: '1.0.0',
        peerContext: ['ms@2.1.3'],
      })
      m.addEdge('peer-consumer@1.0.0(ms@2.1.3)', 'ms@2.1.3', 'peer', { range: '^2.1.0' })
    })
    const { lockfile, diagnostics } = stringifyWithDiagnostics(result.graph)

    // The peer-virt flattening fires (npm has no virtual:<hash># on-disk
    // encoding), but the peer edge itself is NOT dropped (unlike npm-1) —
    // the peerDependencies block surfaces on the flattened entry.
    expect(diagnostics.filter(d => d.code === 'NPM_V3_PEER_VIRT_FLATTENED')).toHaveLength(1)
    expect(diagnostics.filter(d => d.code.includes('PEER_DROPPED'))).toEqual([])

    const obj = JSON.parse(lockfile)
    expect(obj.packages['node_modules/peer-consumer']?.peerDependencies).toEqual({
      ms: '^2.1.0',
    })
  })

  it('roundtrips removeEdge', () => {
    const original = parseFixtureGraph('simple')
    const result = original.mutate(m => {
      m.removeEdge('case-simple@0.0.0', 'ms@2.1.3', 'dep')
    })
    const reparsed = parse(stringify(result.graph))

    expectEmptyGraphDiff(result.graph.diff(reparsed))
    expect(result.applied).toEqual([
      { kind: 'edge-removed', subject: { src: 'case-simple@0.0.0', dst: 'ms@2.1.3', kind: 'dep' } },
    ])
  })

  it('roundtrips removeNode', () => {
    const original = parseFixtureGraph('simple')
    // Remove a leaf node (ms) and its incoming edge from the root.
    const result = original.mutate(m => {
      m.removeEdge('case-simple@0.0.0', 'ms@2.1.3', 'dep')
      m.removeNode('ms@2.1.3')
      m.removeTarball({ name: 'ms', version: '2.1.3' })
    })
    const reparsed = parse(stringify(result.graph))

    expectEmptyGraphDiff(result.graph.diff(reparsed))
    expect(reparsed.getNode('ms@2.1.3')).toBeUndefined()
  })

  it('roundtrips setTarball', () => {
    const original = parseFixtureGraph('simple')
    const result = original.mutate(m => {
      m.setTarball({ name: 'ms', version: '2.1.3' }, {
        integrity: 'sha512-modified-ms-integrity',
      })
    })
    const reparsed = parse(stringify(result.graph))

    expectEmptyGraphDiff(result.graph.diff(reparsed))
    expect(reparsed.tarballOf('ms@2.1.3')).toEqual({ integrity: 'sha512-modified-ms-integrity' })
    expect(result.applied).toEqual([
      { kind: 'tarball-set', subject: 'ms@2.1.3' },
    ])
  })

  it('roundtrips replaceNode (version bump, same name)', () => {
    const original = parseFixtureGraph('simple')
    const current = original.getNode('ms@2.1.3')!
    const result = original.mutate(m => {
      m.removeEdge('case-simple@0.0.0', 'ms@2.1.3', 'dep')
      m.replaceNode('ms@2.1.3', {
        ...current,
        id: 'ms@2.1.4',
        version: '2.1.4',
      })
      m.setTarball({ name: 'ms', version: '2.1.4' }, { integrity: 'sha512-bumped-ms-integrity' })
      m.removeTarball({ name: 'ms', version: '2.1.3' })
      m.addEdge('case-simple@0.0.0', 'ms@2.1.4', 'dep', { range: '2.1.4' })
    })
    const reparsed = parse(stringify(result.graph))

    expect(reparsed.getNode('ms@2.1.3')).toBeUndefined()
    expect(reparsed.getNode('ms@2.1.4')).toBeDefined()
    expectEmptyGraphDiff(result.graph.diff(reparsed))
  })

  it('replacePeerContext (non-empty) flattens on emit with NPM_V3_PEER_VIRT_FLATTENED', () => {
    const original = parseFixtureGraph('peers-basic')
    const result = original.mutate(m => {
      m.replacePeerContext('react-dom@18.2.0', ['react@18.2.0'])
    })
    const { lockfile, diagnostics } = stringifyWithDiagnostics(result.graph)
    const reparsed = parse(lockfile)

    // Reparse flattens the virtualised NodeId back to the bare form.
    expect(reparsed.getNode('react-dom@18.2.0(react@18.2.0)')).toBeUndefined()
    expect(reparsed.getNode('react-dom@18.2.0')).toBeDefined()
    expect(diagnostics.map(d => d.code)).toEqual(['NPM_V3_PEER_VIRT_FLATTENED'])
    expect(diagnostics[0]).toEqual(
      expect.objectContaining({
        code: 'NPM_V3_PEER_VIRT_FLATTENED',
        severity: 'warning',
        subject: 'react-dom@18.2.0(react@18.2.0)',
      }),
    )
    expect(diagnostics[0]?.message).toContain('["react@18.2.0"]')
    expect(result.applied).toEqual([
      { kind: 'peer-context-replaced', subject: 'react-dom@18.2.0(react@18.2.0)' },
    ])
  })

  it('setNode patch drops on emit with NPM_V3_PATCH_DROPPED', () => {
    const original = parseFixtureGraph('simple')
    const patch = 'a'.repeat(128)
    const current = original.getNode('ms@2.1.3')!

    const result = original.mutate(m => {
      m.replaceNode('ms@2.1.3', { ...current, patch })
      m.setTarball({ name: 'ms', version: '2.1.3', patch }, { integrity: 'sha512-patched-ms-integrity' })
      m.removeTarball({ name: 'ms', version: '2.1.3' })
    })
    const { lockfile, diagnostics } = stringifyWithDiagnostics(result.graph)
    const reparsed = parse(lockfile)

    expect(reparsed.getNode('ms@2.1.3')?.patch).toBeUndefined()
    expect(diagnostics.filter(d => d.code === 'NPM_V3_PATCH_DROPPED')).toEqual([
      expect.objectContaining({
        code: 'NPM_V3_PATCH_DROPPED',
        severity: 'warning',
        subject: 'ms@2.1.3',
      }),
    ])
    expect(diagnostics.find(d => d.code === 'NPM_V3_PATCH_DROPPED')?.message).toContain(patch)
  })

  it('emits each lossy diagnostic at most once per affected node', () => {
    const original = parseFixtureGraph('peers-basic')
    const patch = 'b'.repeat(128)
    const reactDom = original.getNode('react-dom@18.2.0')!
    const result = original.mutate(m => {
      m.replaceNode('react-dom@18.2.0', { ...reactDom, patch })
      m.setTarball({ name: 'react-dom', version: '18.2.0', patch }, { integrity: 'sha512-x' })
      m.removeTarball({ name: 'react-dom', version: '18.2.0' })
      m.replacePeerContext('react-dom@18.2.0', ['react@18.2.0'])
    })
    const { diagnostics } = stringifyWithDiagnostics(result.graph)

    const peerVirt = diagnostics.filter(d => d.code === 'NPM_V3_PEER_VIRT_FLATTENED')
    const patchDrop = diagnostics.filter(d => d.code === 'NPM_V3_PATCH_DROPPED')
    expect(peerVirt).toHaveLength(1)
    expect(patchDrop).toHaveLength(1)
  })
})

describe('npm-3 — enrich (§C, ADR-0021 §C.npm-3)', () => {
  it('peer-virt structurally absent: on-disk peerDependencies stay in sidecar; no graph peer edges (mirrors yarn-classic)', () => {
    const graph = parseFixtureGraph('peers-basic')
    // Parse leaves the peer block in sidecar (per §A's *Known degradation*
    // clause); enrich does NOT materialise peer edges on the graph — the
    // npm-flat outcome (per ADR-0021 §C.npm-3 + the graph invariant tying
    // peer edges to peerContext) means peer edges only appear when the
    // adapter virtualizes the source NodeId, which the npm side declines.
    expect(graph.out('react-dom@18.2.0', 'peer')).toEqual([])
    const result = enrich(graph)

    expect(result.diagnostics).toEqual([])
    expect(result.graph.out('react-dom@18.2.0', 'peer')).toEqual([])
    expect(result.graph.getNode('react-dom@18.2.0')?.peerContext).toEqual([])
    expect(result.graph.getNode('react-dom@18.2.0(react@18.2.0)')).toBeUndefined()
    // The on-disk peer block round-trips via the sidecar fallback in
    // buildNodeModulesEntry (not via graph peer edges).
    const emitted = stringify(result.graph)
    const reparsed = JSON.parse(emitted)
    expect(reparsed.packages['node_modules/react-dom']?.peerDependencies).toEqual({
      react: '^18.2.0',
    })
  })

  it('emits NPM_V3_PEER_UNSATISFIED when no candidate matches the range', () => {
    // Construct a graph where react-dom declares a peer range that no
    // installed react version satisfies. Use peers-multi as the base and
    // mutate the parse-side state: the cleanest path is a synthetic build
    // via the existing parse + manual graph mutation.
    const synthetic = {
      name: 'case-x',
      version: '0.0.0',
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': { name: 'case-x', version: '0.0.0', dependencies: { 'pkg-a': '1.0.0' } },
        'node_modules/pkg-a': {
          version: '1.0.0',
          resolved: 'https://registry.npmjs.org/pkg-a/-/pkg-a-1.0.0.tgz',
          integrity: 'sha512-aaa',
          peerDependencies: { 'react': '^99.99.0' },
        },
        'node_modules/react': {
          version: '18.2.0',
          resolved: 'https://registry.npmjs.org/react/-/react-18.2.0.tgz',
          integrity: 'sha512-react',
        },
      },
    }
    const graph = parse(JSON.stringify(synthetic, null, 2))
    const result = enrich(graph)

    expect(result.diagnostics.map(d => d.code)).toEqual(['NPM_V3_PEER_UNSATISFIED'])
    expect(result.diagnostics[0]).toEqual(
      expect.objectContaining({
        code: 'NPM_V3_PEER_UNSATISFIED',
        severity: 'warning',
        subject: 'pkg-a@1.0.0',
      }),
    )
    expect(result.graph.out('pkg-a@1.0.0', 'peer')).toEqual([])
  })

  it('emits NPM_V3_PEER_AMBIGUOUS when multiple candidates satisfy the range', () => {
    const synthetic = {
      name: 'case-x',
      version: '0.0.0',
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': { name: 'case-x', version: '0.0.0' },
        'node_modules/pkg-a': {
          version: '1.0.0',
          resolved: 'https://registry.npmjs.org/pkg-a/-/pkg-a-1.0.0.tgz',
          integrity: 'sha512-aaa',
          peerDependencies: { 'react': '*' },
        },
        'node_modules/react': {
          version: '17.0.2',
          resolved: 'https://registry.npmjs.org/react/-/react-17.0.2.tgz',
          integrity: 'sha512-r17',
        },
        'node_modules/pkg-a/node_modules/react': {
          version: '18.2.0',
          resolved: 'https://registry.npmjs.org/react/-/react-18.2.0.tgz',
          integrity: 'sha512-r18',
        },
      },
    }
    const graph = parse(JSON.stringify(synthetic, null, 2))
    const result = enrich(graph)

    expect(result.diagnostics.map(d => d.code)).toEqual(['NPM_V3_PEER_AMBIGUOUS'])
    expect(result.diagnostics[0]).toEqual(
      expect.objectContaining({
        code: 'NPM_V3_PEER_AMBIGUOUS',
        severity: 'warning',
        subject: 'pkg-a@1.0.0',
      }),
    )
  })

  it('peer-virt structurally absent: never produces virtualised NodeIds on the npm side', () => {
    const graph = parseFixtureGraph('peers-multi')
    const result = enrich(graph)

    // Every node keeps peerContext=[] post-enrich (npm-flat outcome).
    for (const node of result.graph.nodes()) {
      expect(node.peerContext).toEqual([])
      // No virtualised NodeId forms (`name@version(react@…)`) on the graph.
      expect(node.id).not.toMatch(/\(.+\)$/)
    }
    // No interop-style peer-virt diagnostics from the npm enrich path.
    expect(result.diagnostics.filter(d => d.code.includes('PEER_VIRT'))).toEqual([])
  })

  it('marks edges to workspace members with attrs.workspace = true', () => {
    // workspaces-basic root has no edges to members; synthesise an edge to
    // exercise the workspace-edge attribution branch of §C.npm-3.
    const base = parseFixtureGraph('workspaces-basic')
    const graph = base.mutate(m => {
      m.addEdge('case-workspaces-basic@0.0.0', '@case-ws/a@0.0.0', 'dep', { range: '*' })
    }).graph
    const result = enrich(graph)

    const wsEdge = result.graph.out('case-workspaces-basic@0.0.0', 'dep')
      .find(e => e.dst === '@case-ws/a@0.0.0')
    expect(wsEdge?.attrs?.workspace).toBe(true)

    // Edge to non-member ms (no workspacePath) stays unmarked.
    const memberToMs = result.graph.out('@case-ws/a@0.0.0', 'dep')
      .find(e => e.dst === 'ms@2.1.3')
    expect(memberToMs?.attrs?.workspace).toBeUndefined()
  })

  it('preserves workspace member tagging from parse (parser sets workspacePath, enrich no-ops)', () => {
    const graph = parseFixtureGraph('workspaces-basic')
    const result = enrich(graph)

    // Parser already materialised workspace members from `packages` block.
    expect(result.graph.getNode('case-workspaces-basic@0.0.0')?.workspacePath).toBe('')
    expect(result.graph.getNode('@case-ws/a@0.0.0')?.workspacePath).toBe('packages/a')
    expect(result.graph.getNode('@case-ws/b@0.0.0')?.workspacePath).toBe('packages/b')
    expect(result.graph.getNode('ms@2.1.3')?.workspacePath).toBeUndefined()
  })

  it('does NOT emit NPM_V3_NO_MANIFESTS (lockfile embeds manifests natively per ADR-0021 §C.npm-3)', () => {
    const graph = parseFixtureGraph('workspaces-basic')
    const result = enrich(graph)
    expect(result.diagnostics.map(d => d.code)).not.toContain('NPM_V3_NO_MANIFESTS')
  })

  it('is idempotent — enrich(enrich(graph)) ≡ enrich(graph)', () => {
    const graph = parseFixtureGraph('peers-basic')
    const once = enrich(graph)
    const twice = enrich(once.graph)

    expect(graphSnapshot(twice.graph)).toEqual(graphSnapshot(once.graph))
    expect(twice.diagnostics).toEqual([])
  })

  it('idempotent on a graph with both peer edges and workspace marks', () => {
    const base = parseFixtureGraph('workspaces-basic')
    const graph = base.mutate(m => {
      m.addEdge('case-workspaces-basic@0.0.0', '@case-ws/a@0.0.0', 'dep', { range: '*' })
    }).graph
    const once = enrich(graph)
    const twice = enrich(once.graph)
    expect(graphSnapshot(twice.graph)).toEqual(graphSnapshot(once.graph))
    expect(twice.diagnostics).toEqual(once.diagnostics)
  })
})

describe('npm-3 — optimize (§D, ADR-0021 §D.npm-3 — prune unreachable)', () => {
  function graphWithOrphan(): Graph {
    const base = parseFixtureGraph('simple')
    return base.mutate(m => {
      m.addNode({
        id: 'orphan@9.9.9',
        name: 'orphan',
        version: '9.9.9',
        peerContext: [],
      })
      m.addEdge('orphan@9.9.9', 'orphan@9.9.9', 'dep', { range: '9.9.9' })
      m.setTarball({ name: 'orphan', version: '9.9.9' }, { integrity: 'sha512-orphan' })
    }).graph
  }

  function graphWithCyclePair(): Graph {
    const base = parseFixtureGraph('simple')
    return base.mutate(m => {
      m.addNode({
        id: 'cycle-a@1.0.0',
        name: 'cycle-a',
        version: '1.0.0',
        peerContext: [],
      })
      m.addNode({
        id: 'cycle-b@1.0.0',
        name: 'cycle-b',
        version: '1.0.0',
        peerContext: [],
      })
      m.addEdge('cycle-a@1.0.0', 'cycle-b@1.0.0', 'dep', { range: '1.0.0' })
      m.addEdge('cycle-b@1.0.0', 'cycle-a@1.0.0', 'dep', { range: '1.0.0' })
      m.setTarball({ name: 'cycle-a', version: '1.0.0' }, { integrity: 'sha512-cycle-a' })
      m.setTarball({ name: 'cycle-b', version: '1.0.0' }, { integrity: 'sha512-cycle-b' })
    }).graph
  }

  it('prunes an unreachable self-loop orphan and its tarball', () => {
    const graph = graphWithOrphan()
    const result = optimize(graph)

    expect(result.graph.getNode('orphan@9.9.9')).toBeUndefined()
    expect(result.graph.tarball({ name: 'orphan', version: '9.9.9' })).toBeUndefined()
    expect(graph.diff(result.graph)).toEqual({
      addedNodes: [],
      removedNodes: ['orphan@9.9.9'],
      changedNodes: [],
      addedEdges: [],
      removedEdges: [{ src: 'orphan@9.9.9', dst: 'orphan@9.9.9', kind: 'dep' }],
    })
  })

  it('prunes an unreachable mutual cycle and its tarballs', () => {
    const graph = graphWithCyclePair()
    const result = optimize(graph)

    expect(result.graph.getNode('cycle-a@1.0.0')).toBeUndefined()
    expect(result.graph.getNode('cycle-b@1.0.0')).toBeUndefined()
    expect(result.graph.tarball({ name: 'cycle-a', version: '1.0.0' })).toBeUndefined()
    expect(result.graph.tarball({ name: 'cycle-b', version: '1.0.0' })).toBeUndefined()
  })

  it('is idempotent — optimize(optimize(graph)) ≡ optimize(graph)', () => {
    const once = optimize(graphWithOrphan())
    const twice = optimize(once.graph)
    expect(graphSnapshot(twice.graph)).toEqual(graphSnapshot(once.graph))
    expect(twice.diagnostics).toEqual(once.diagnostics)
  })

  it('preserves every reachable node and tarball on fixture graphs', () => {
    const graph = parseFixtureGraph('peers-basic')
    const result = optimize(graph)
    expect(graphSnapshot(result.graph)).toEqual(graphSnapshot(graph))
    expect(Array.from(result.graph.tarballs(), ([k]) => k)).toEqual(
      Array.from(graph.tarballs(), ([k]) => k),
    )
  })

  it('survives stringify/parse roundtrip composition with re-enrich (§A.4 + §C/§D composition)', () => {
    // For peer-edge state and workspace markers, re-enrich is required after
    // stringify->parse: graph peer edges demote to sidecar.peerDependencies on
    // parse, and workspace `attrs.workspace = true` markers are not emitted
    // to disk per ADR-0021 §A.npm-3. The composition predicate per ADR-0021
    // §D.npm-3 (mirroring ADR-0019 §D's pattern):
    //   enrich(parse(stringify(optimize(enrich(parse(x)))))) ≡
    //     optimize(enrich(parse(x)))
    const base = parseFixtureGraph('peers-basic')
    const enriched = enrich(base)
    const optimized = optimize(enriched.graph)
    const reparsed = enrich(parse(stringify(optimized.graph)))

    expect(graphSnapshot(reparsed.graph)).toEqual(graphSnapshot(optimized.graph))
    expectEmptyGraphDiff(optimized.graph.diff(reparsed.graph))
  })
})
