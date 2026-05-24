import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const sriOf = (s: string): string => 'sha512-' + createHash('sha512').update(s).digest('base64')
const MODIFIED_SRI = sriOf('modified-ms-integrity')
const BUMPED_SRI = sriOf('bumped-ms-integrity')
import { type Diagnostic, type Graph, type GraphDiff } from '../../main/ts/graph.ts'
import { LockfileError } from '../../main/ts/errors.ts'
import { check, enrich, optimize, parse, stringify } from '../../main/ts/formats/npm-1.ts'
import { parse as parseV2 } from '../../main/ts/formats/npm-2.ts'
import { parse as parseV3 } from '../../main/ts/formats/npm-3.ts'
import { parse as parseClassic } from '../../main/ts/formats/yarn-classic.ts'
import { parse as parseV9 } from '../../main/ts/formats/yarn-berry-v9.ts'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = (rel: string): string =>
  readFileSync(resolve(here, '../resources/fixtures/lockfiles', rel), 'utf8')

// Eight-fixture matrix per ADR-0021 §A.4 acceptance gate.
const FIXTURES = [
  'deps-with-scopes',
  'git-github-tarball',
  'peers-basic',
  'peers-multi',
  'simple',
  'workspaces-basic',
  'yarn-crlf',
] as const

// Note: bundled-deps has no npm-1 fixture in the working set (per ADR-0021
// §C/§D acceptance). The other 7 + patch-yarn cover the matrix.
const PATCH_FIXTURES = ['patch-yarn'] as const

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
    tarballs: Array.from(graph.tarballs(), ([key, payload]) => [key, { ...payload }] as const),
  }
}

function expectEmptyGraphDiff(diff: GraphDiff): void {
  expect(diff).toEqual({
    addedNodes: [],
    removedNodes: [],
    changedNodes: [],
    addedEdges: [],
    removedEdges: [],
  })
}

function parseFixtureGraph(name: typeof FIXTURES[number] | typeof PATCH_FIXTURES[number]): Graph {
  return parse(fixture(`${name}/npm-1.lock`))
}

function stringifyWithDiagnostics(graph: Graph): { lockfile: string; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = []
  const lockfile = stringify(graph, {
    onDiagnostic(diagnostic) {
      diagnostics.push(diagnostic)
    },
  })
  return { lockfile, diagnostics }
}

describe('npm-1 — discriminant and isolation (§A cross-version)', () => {
  it('accepts npm-1 fixture and rejects npm-2 / npm-3 / yarn-* inputs', () => {
    const own = fixture('simple/npm-1.lock')
    const v2 = fixture('simple/npm-2.lock')
    const v3 = fixture('simple/npm-3.lock')
    const yarnClassic = fixture('simple/yarn-classic.lock')
    const yarnBerry = fixture('simple/yarn-berry-v9.lock')

    expect(check(own)).toBe(true)
    expect(check(v2)).toBe(false)
    expect(check(v3)).toBe(false)
    expect(check(yarnClassic)).toBe(false)
    expect(check(yarnBerry)).toBe(false)
  })

  it('parse rejects lockfileVersion 2 with FORMAT_MISMATCH', () => {
    const v2 = fixture('simple/npm-2.lock')
    expect(() => parse(v2)).toThrow(LockfileError)
    try { parse(v2) } catch (error) {
      expect((error as LockfileError).code).toBe('FORMAT_MISMATCH')
    }
  })

  it('parse rejects lockfileVersion 3 with FORMAT_MISMATCH', () => {
    const v3 = fixture('simple/npm-3.lock')
    expect(() => parse(v3)).toThrow(LockfileError)
    try { parse(v3) } catch (error) {
      expect((error as LockfileError).code).toBe('FORMAT_MISMATCH')
    }
  })

  it('parse rejects flat `packages` map with FORMAT_MISMATCH (cross-version isolation)', () => {
    const malformed = JSON.stringify({
      name: 'x',
      version: '0.0.0',
      lockfileVersion: 1,
      packages: { '': { name: 'x', version: '0.0.0' } },
    }, null, 2)
    expect(() => parse(malformed)).toThrow(LockfileError)
    try { parse(malformed) } catch (error) {
      expect((error as LockfileError).code).toBe('FORMAT_MISMATCH')
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

  it('cross-adapter probe: npm-2 / npm-3 / yarn-classic / yarn-berry-v9 parsers reject npm-1 input', () => {
    const own = fixture('simple/npm-1.lock')
    expect(() => parseV2(own)).toThrow()
    expect(() => parseV3(own)).toThrow()
    expect(() => parseClassic(own)).toThrow()
    expect(() => parseV9(own)).toThrow()
  })
})

describe('npm-1 — parse fixtures', () => {
  it.each(FIXTURES)('parses %s fixture', (name) => {
    const graph = parseFixtureGraph(name)
    expect(Array.from(graph.nodes())).not.toHaveLength(0)
  })

  it('parses the root node with workspacePath = ""', () => {
    const graph = parseFixtureGraph('simple')
    const root = graph.getNode('case-simple@0.0.0')
    expect(root).toBeDefined()
    expect(root?.workspacePath).toBe('')
  })

  it('parses top-level dependencies into dep edges from root', () => {
    const graph = parseFixtureGraph('simple')
    const out = graph.out('case-simple@0.0.0')
    const depDsts = out.filter(edge => edge.kind === 'dep').map(edge => edge.dst).sort()
    expect(depDsts).toEqual(['lodash@4.17.21', 'ms@2.1.3'])
  })

  it('parses leaf entries into (name, version) graph nodes with tarball payload', () => {
    const graph = parseFixtureGraph('simple')
    const ms = graph.getNode('ms@2.1.3')
    expect(ms).toBeDefined()
    expect(ms?.peerContext).toEqual([])
    const tarball = graph.tarballOf('ms@2.1.3')
    expect(tarball?.integrity).toBe('sha512-6FlzubTLZG3J2a/NVCAleEhjzq5oxgHyaCU9yYXvcLsvoVaHJq/s5xXI6/XXP6tz7R9xAOtHnSO/tXtF3WRTlA==')
  })

  it('parses `requires` blocks into dep edges between leaves', () => {
    const graph = parseFixtureGraph('peers-basic')
    // react carries `requires: { "loose-envify": "^1.1.0" }` per the fixture.
    const reactOut = graph.out('react@18.2.0').filter(edge => edge.kind === 'dep').map(edge => edge.dst)
    expect(reactOut).toContain('loose-envify@1.4.0')
  })

  it('parses scoped names verbatim (no transformation)', () => {
    const graph = parseFixtureGraph('deps-with-scopes')
    expect(graph.getNode('@sindresorhus/is@6.3.1')).toBeDefined()
    expect(graph.getNode('@types/node@20.11.30')).toBeDefined()
  })

  it('parses git/github resolutions where version itself carries the URL', () => {
    const graph = parseFixtureGraph('git-github-tarball')
    const gitNode = graph.getNode('is-git@git+https://github.com/sindresorhus/is.git#47f49741eacf0a3678684738159a87c2011bb026')
    expect(gitNode).toBeDefined()
    const ghNode = graph.getNode('is-github@github:sindresorhus/is#47f49741eacf0a3678684738159a87c2011bb026')
    expect(ghNode).toBeDefined()
  })

  it('parses workspaces-basic to a minimal root-only graph', () => {
    // npm-1 workspaces-basic fixture is the degraded shape — root manifest
    // declares no on-disk dep tree. The graph carries just the root.
    const graph = parseFixtureGraph('workspaces-basic')
    expect(graph.getNode('case-workspaces-basic@0.0.0')).toBeDefined()
    const nonRoot = Array.from(graph.nodes()).filter(n => n.workspacePath !== '')
    expect(nonRoot).toHaveLength(0)
  })
})

describe('npm-1 — stringify (§A.4 Graph-level roundtrip)', () => {
  // §A.4 predicate: parse(stringify(parse(x))).diff(parse(x)) is empty +
  // tarballs() iteration-equal. yarn-crlf excluded (CRLF handled below).
  it.each(FIXTURES.filter(n => n !== 'yarn-crlf'))('roundtrips %s at Graph level', (name) => {
    const original = parseFixtureGraph(name)
    const emitted = stringify(original)
    const reparsed = parse(emitted)

    expect(graphSnapshot(reparsed)).toEqual(graphSnapshot(original))
    expectEmptyGraphDiff(original.diff(reparsed))
    expect(Array.from(reparsed.tarballs())).toEqual(Array.from(original.tarballs()))
  })

  it('emits well-formed JSON with lockfileVersion: 1', () => {
    const graph = parseFixtureGraph('simple')
    const text = stringify(graph)
    expect(() => JSON.parse(text)).not.toThrow()
    const parsed = JSON.parse(text)
    expect(parsed.lockfileVersion).toBe(1)
    expect(parsed.dependencies).toBeDefined()
    expect(parsed.packages).toBeUndefined()
  })

  it('emits canonical 2-space indent + trailing newline', () => {
    const graph = parseFixtureGraph('simple')
    const text = stringify(graph)
    expect(text.endsWith('\n')).toBe(true)
    expect(text).toContain('\n  "name":')
    expect(text).toContain('\n    "lodash":')
  })

  it('emits dependencies map sorted alphabetically', () => {
    const graph = parseFixtureGraph('simple')
    const text = stringify(graph)
    const obj = JSON.parse(text)
    const keys = Object.keys(obj.dependencies)
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

  it('emits `requires` block (npm-1 dialect) for entries с declared deps', () => {
    const graph = parseFixtureGraph('peers-basic')
    const text = stringify(graph)
    const obj = JSON.parse(text)
    expect(obj.dependencies.react?.requires).toEqual({
      'loose-envify': '^1.1.0',
    })
  })

  it('emits empty-graph workspaces fixture as minimal shape (no `dependencies`)', () => {
    const graph = parseFixtureGraph('workspaces-basic')
    const text = stringify(graph)
    const obj = JSON.parse(text)
    expect(obj.lockfileVersion).toBe(1)
    expect(obj.dependencies).toBeUndefined()
  })

  it('emits scoped names verbatim under `dependencies` keys', () => {
    const graph = parseFixtureGraph('deps-with-scopes')
    const text = stringify(graph)
    const obj = JSON.parse(text)
    expect(obj.dependencies['@sindresorhus/is']).toMatchObject({ version: '6.3.1' })
    expect(obj.dependencies['@types/node']).toMatchObject({ version: '20.11.30' })
  })
})

describe('npm-1 — modify (§B Mutator surface)', () => {
  it('roundtrips addNode + setTarball', () => {
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
      m.addEdge('case-simple@0.0.0', 'debug@4.4.1', 'dep', { range: '4.4.1' })
    })
    const reparsed = parse(stringify(result.graph))
    expectEmptyGraphDiff(result.graph.diff(reparsed))
    expect(reparsed.getNode('debug@4.4.1')).toBeDefined()
  })

  it('roundtrips addEdge dep + removeEdge', () => {
    const original = parseFixtureGraph('simple')
    const added = original.mutate(m => {
      m.addEdge('lodash@4.17.21', 'ms@2.1.3', 'dep', { range: '2.1.3' })
    })
    const reparsed = parse(stringify(added.graph))
    expectEmptyGraphDiff(added.graph.diff(reparsed))

    const removed = added.graph.mutate(m => {
      m.removeEdge('lodash@4.17.21', 'ms@2.1.3', 'dep')
    })
    const reparsedRemoved = parse(stringify(removed.graph))
    expectEmptyGraphDiff(removed.graph.diff(reparsedRemoved))
  })

  it('addEdge peer drops with NPM_V1_PEER_DROPPED warning', () => {
    const original = parseFixtureGraph('simple')
    // The graph invariant requires peer edges на a peerContext-bearing node
    // (see graph.ts). We mirror the npm-flat pattern: synthesise a virt-id
    // sibling whose peerContext lists the dst, attach the peer edge, then
    // verify both PEER_DROPPED (edge loss) and PEER_VIRT_FLATTENED (id loss).
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

    expect(diagnostics.filter(d => d.code === 'NPM_V1_PEER_DROPPED')).toHaveLength(1)
    expect(diagnostics.find(d => d.code === 'NPM_V1_PEER_DROPPED')).toEqual(
      expect.objectContaining({
        code: 'NPM_V1_PEER_DROPPED',
        severity: 'warning',
        subject: 'peer-consumer@1.0.0(ms@2.1.3)',
      }),
    )
    expect(diagnostics.filter(d => d.code === 'NPM_V1_PEER_VIRT_FLATTENED')).toHaveLength(1)

    const obj = JSON.parse(lockfile)
    // No peer block on disk in npm-1 — and the virt-id flattens to the
    // bare `peer-consumer` name in the tree.
    expect(obj.dependencies['peer-consumer']?.peerDependencies).toBeUndefined()
  })

  it('roundtrips removeNode + removeTarball', () => {
    const original = parseFixtureGraph('simple')
    const result = original.mutate(m => {
      m.removeEdge('case-simple@0.0.0', 'ms@2.1.3', 'dep')
      m.removeNode('ms@2.1.3')
      m.removeTarball({ name: 'ms', version: '2.1.3' })
    })
    const reparsed = parse(stringify(result.graph))
    expectEmptyGraphDiff(result.graph.diff(reparsed))
    expect(reparsed.getNode('ms@2.1.3')).toBeUndefined()
  })

  it('roundtrips setTarball (integrity update)', () => {
    const original = parseFixtureGraph('simple')
    const result = original.mutate(m => {
      m.setTarball({ name: 'ms', version: '2.1.3' }, { integrity: MODIFIED_SRI })
    })
    const reparsed = parse(stringify(result.graph))
    expectEmptyGraphDiff(result.graph.diff(reparsed))
    expect(reparsed.tarballOf('ms@2.1.3')?.integrity).toBe(MODIFIED_SRI)
  })

  it('roundtrips replaceNode (version bump)', () => {
    const original = parseFixtureGraph('simple')
    const current = original.getNode('ms@2.1.3')!
    const result = original.mutate(m => {
      m.removeEdge('case-simple@0.0.0', 'ms@2.1.3', 'dep')
      m.replaceNode('ms@2.1.3', { ...current, id: 'ms@2.1.4', version: '2.1.4' })
      m.setTarball({ name: 'ms', version: '2.1.4' }, { integrity: BUMPED_SRI })
      m.removeTarball({ name: 'ms', version: '2.1.3' })
      m.addEdge('case-simple@0.0.0', 'ms@2.1.4', 'dep', { range: '2.1.4' })
    })
    const reparsed = parse(stringify(result.graph))
    expect(reparsed.getNode('ms@2.1.3')).toBeUndefined()
    expect(reparsed.getNode('ms@2.1.4')).toBeDefined()
    expectEmptyGraphDiff(result.graph.diff(reparsed))
  })

  it('replacePeerContext (non-empty) flattens on emit with NPM_V1_PEER_VIRT_FLATTENED', () => {
    const original = parseFixtureGraph('peers-basic')
    const result = original.mutate(m => {
      m.replacePeerContext('react-dom@18.2.0', ['react@18.2.0'])
    })
    const { lockfile, diagnostics } = stringifyWithDiagnostics(result.graph)
    const reparsed = parse(lockfile)

    expect(reparsed.getNode('react-dom@18.2.0(react@18.2.0)')).toBeUndefined()
    expect(reparsed.getNode('react-dom@18.2.0')).toBeDefined()
    expect(diagnostics.filter(d => d.code === 'NPM_V1_PEER_VIRT_FLATTENED')).toHaveLength(1)
    expect(diagnostics[0]).toEqual(
      expect.objectContaining({
        code: 'NPM_V1_PEER_VIRT_FLATTENED',
        severity: 'warning',
        subject: 'react-dom@18.2.0(react@18.2.0)',
      }),
    )
  })

  it('setNode patch drops on emit with RECIPE_FEATURE_DROPPED', () => {
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
    expect(diagnostics.filter(d => d.code === 'RECIPE_FEATURE_DROPPED' && d.subject === 'ms@2.1.3')).toHaveLength(1)
  })

  it('workspace member nodes drop on emit with NPM_V1_WORKSPACES_UNSAFE', () => {
    const original = parseFixtureGraph('workspaces-basic')
    const result = original.mutate(m => {
      m.addNode({
        id: '@case-ws/a@0.0.0',
        name: '@case-ws/a',
        version: '0.0.0',
        peerContext: [],
        workspacePath: 'packages/a',
      })
    })
    const { lockfile, diagnostics } = stringifyWithDiagnostics(result.graph)
    expect(diagnostics.filter(d => d.code === 'NPM_V1_WORKSPACES_UNSAFE')).toHaveLength(1)
    expect(diagnostics[0]).toEqual(
      expect.objectContaining({
        code: 'NPM_V1_WORKSPACES_UNSAFE',
        severity: 'warning',
        subject: '@case-ws/a@0.0.0',
      }),
    )
    const obj = JSON.parse(lockfile)
    // Workspace member is omitted from the emitted tree.
    expect(obj.dependencies?.['@case-ws/a']).toBeUndefined()
  })

  it('emits each lossy diagnostic at most once per affected node', () => {
    const original = parseFixtureGraph('peers-basic')
    const patch = 'b'.repeat(128)
    const reactDom = original.getNode('react-dom@18.2.0')!
    const result = original.mutate(m => {
      m.replaceNode('react-dom@18.2.0', { ...reactDom, patch })
      m.setTarball({ name: 'react-dom', version: '18.2.0', patch }, { integrity: 'sha512-x' })
      m.removeTarball({ name: 'react-dom', version: '18.2.0' })
      // replacePeerContext rebinds incoming edges to the virt-id form, so
      // adding a peer edge AFTER is a no-op (the edge already exists from
      // parse — although for npm-1 fixtures the peer edges are absent on
      // disk, the parse-time `peerDependencies` lives in sidecar only).
      // Use a fresh synthetic virt-id node to exercise both PEER_VIRT and
      // PEER_DROPPED in one pass without duplicating an existing edge.
      m.addNode({
        id: 'peer-virt@1.0.0(react@18.2.0)',
        name: 'peer-virt',
        version: '1.0.0',
        peerContext: ['react@18.2.0'],
      })
      m.addEdge('peer-virt@1.0.0(react@18.2.0)', 'react@18.2.0', 'peer', { range: '^18.2.0' })
    })
    const { diagnostics } = stringifyWithDiagnostics(result.graph)

    const peerVirt = diagnostics.filter(d => d.code === 'NPM_V1_PEER_VIRT_FLATTENED')
    const patchDrop = diagnostics.filter(d => d.code === 'RECIPE_FEATURE_DROPPED' && d.subject === 'react-dom@18.2.0')
    const peerDrop = diagnostics.filter(d => d.code === 'NPM_V1_PEER_DROPPED')
    expect(peerVirt).toHaveLength(1)
    expect(patchDrop).toHaveLength(1)
    expect(peerDrop).toHaveLength(1)
  })
})

describe('npm-1 — enrich (§C, ADR-0021 §C.npm-1)', () => {
  it('peer-virt structurally absent: no peer edges на graph, no peer-virt NodeIds', () => {
    const graph = parseFixtureGraph('peers-basic')
    expect(graph.out('react-dom@18.2.0', 'peer')).toEqual([])
    const result = enrich(graph)
    expect(result.graph.out('react-dom@18.2.0', 'peer')).toEqual([])
    for (const node of result.graph.nodes()) {
      expect(node.peerContext).toEqual([])
      expect(node.id).not.toMatch(/\(.+\)$/)
    }
  })

  it('without manifests + non-workspace graph: enrich is no-op', () => {
    const graph = parseFixtureGraph('simple')
    const result = enrich(graph)
    expect(graphSnapshot(result.graph)).toEqual(graphSnapshot(graph))
    expect(result.diagnostics).toEqual([])
  })

  it('manifests-driven enrich: workspace members synthesised + edges marked', () => {
    const graph = parseFixtureGraph('workspaces-basic')
    const result = enrich(graph, {
      manifests: {
        '': {
          name: 'case-workspaces-basic',
          version: '0.0.0',
          dependencies: { '@case-ws/a': 'workspace:*' },
          devDependencies: { '@case-ws/b': 'workspace:^' },
        },
        'packages/a': { name: '@case-ws/a', version: '0.0.0' },
        'packages/b': { name: '@case-ws/b', version: '0.0.0' },
      },
    })
    const memberA = result.graph.getNode('@case-ws/a@0.0.0')
    const memberB = result.graph.getNode('@case-ws/b@0.0.0')
    expect(memberA?.workspacePath).toBe('packages/a')
    expect(memberB?.workspacePath).toBe('packages/b')
    // Edges from root carry the workspace marker.
    const wsEdge = result.graph
      .out('case-workspaces-basic@0.0.0', 'dep')
      .find(e => e.dst === '@case-ws/a@0.0.0')
    expect(wsEdge?.attrs?.workspace).toBe(true)
  })

  it('idempotent — enrich(enrich(graph)) ≡ enrich(graph)', () => {
    const graph = parseFixtureGraph('peers-basic')
    const once = enrich(graph)
    const twice = enrich(once.graph)
    expect(graphSnapshot(twice.graph)).toEqual(graphSnapshot(once.graph))
    expect(twice.diagnostics).toEqual([])
  })

  it('idempotent on a manifest-enriched workspace graph', () => {
    const graph = parseFixtureGraph('workspaces-basic')
    const manifests = {
      '': {
        name: 'case-workspaces-basic',
        version: '0.0.0',
        dependencies: { '@case-ws/a': 'workspace:*' },
      },
      'packages/a': { name: '@case-ws/a', version: '0.0.0' },
    }
    const once = enrich(graph, { manifests })
    const twice = enrich(once.graph, { manifests })
    expect(graphSnapshot(twice.graph)).toEqual(graphSnapshot(once.graph))
  })
})

describe('npm-1 — optimize (§D, ADR-0021 §D.npm-1 — prune unreachable)', () => {
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
      m.addNode({ id: 'cycle-a@1.0.0', name: 'cycle-a', version: '1.0.0', peerContext: [] })
      m.addNode({ id: 'cycle-b@1.0.0', name: 'cycle-b', version: '1.0.0', peerContext: [] })
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
  })

  it('idempotent — optimize(optimize(graph)) ≡ optimize(graph)', () => {
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

  it('survives stringify/parse roundtrip composition c re-enrich (§A.4 + §C/§D composition)', () => {
    const base = parseFixtureGraph('peers-basic')
    const enriched = enrich(base)
    const optimized = optimize(enriched.graph)
    const reparsed = enrich(parse(stringify(optimized.graph)))

    expect(graphSnapshot(reparsed.graph)).toEqual(graphSnapshot(optimized.graph))
    expectEmptyGraphDiff(optimized.graph.diff(reparsed.graph))
  })
})

describe('npm-1 — patch-yarn fixture (legacy fixture coverage)', () => {
  it('parses + roundtrips patch-yarn fixture (no `requires: true` at top-level)', () => {
    const graph = parseFixtureGraph('patch-yarn')
    expect(graph.getNode('lodash@4.17.21')).toBeDefined()
    const text = stringify(graph)
    const reparsed = parse(text)
    expectEmptyGraphDiff(graph.diff(reparsed))
  })
})
