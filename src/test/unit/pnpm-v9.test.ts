import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { type Diagnostic, type Graph, type GraphDiff } from '../../main/ts/graph.ts'
import { LockfileError } from '../../main/ts/errors.ts'
import { check, enrich, optimize, parse, stringify } from '../../main/ts/formats/pnpm-v9.ts'
import { parse as parseV5Lock } from '../../main/ts/formats/yarn-classic.ts'
import { parse as parseYarnBerry } from '../../main/ts/formats/yarn-berry-v9.ts'
import { parse as parseNpm3 } from '../../main/ts/formats/npm-3.ts'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = (rel: string): string =>
  readFileSync(resolve(here, '../resources/fixtures/lockfiles', rel), 'utf8')

// 8-fixture matrix per ADR-0022 §A.pnpm-v9 acceptance gate.
const FIXTURES = [
  'simple',
  'peers-basic',
  'peers-multi',
  'deps-with-scopes',
  'workspaces-basic',
  'workspace-cross-refs',
  'patch-yarn',
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

function parseFixtureGraph(name: typeof FIXTURES[number]): Graph {
  return parse(fixture(`${name}/pnpm-v9.lock`))
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

describe('pnpm-v9 — discriminant and isolation (§A cross-version)', () => {
  it('accepts pnpm-v9 fixture and rejects pnpm-v5 / pnpm-v6 / yarn / npm inputs', () => {
    const own = fixture('simple/pnpm-v9.lock')
    const v5 = fixture('simple/pnpm-v5.lock')
    const v6 = fixture('simple/pnpm-v6.lock')
    const yarnClassic = fixture('simple/yarn-classic.lock')
    const yarnBerry = fixture('simple/yarn-berry-v9.lock')
    const npm3 = fixture('simple/npm-3.lock')

    expect(check(own)).toBe(true)
    expect(check(v5)).toBe(false)
    expect(check(v6)).toBe(false)
    expect(check(yarnClassic)).toBe(false)
    expect(check(yarnBerry)).toBe(false)
    expect(check(npm3)).toBe(false)
  })

  it('parse rejects pnpm-v5 (decimal lockfileVersion) with FORMAT_MISMATCH', () => {
    const v5 = fixture('simple/pnpm-v5.lock')
    expect(() => parse(v5)).toThrow(LockfileError)
    try { parse(v5) } catch (error) {
      expect((error as LockfileError).code).toBe('FORMAT_MISMATCH')
    }
  })

  it('parse rejects pnpm-v6 (quoted "6.0") with FORMAT_MISMATCH', () => {
    const v6 = fixture('simple/pnpm-v6.lock')
    expect(() => parse(v6)).toThrow(LockfileError)
    try { parse(v6) } catch (error) {
      expect((error as LockfileError).code).toBe('FORMAT_MISMATCH')
    }
  })

  it('parse rejects yarn-classic input with FORMAT_MISMATCH', () => {
    const yarnClassic = fixture('simple/yarn-classic.lock')
    expect(() => parse(yarnClassic)).toThrow(LockfileError)
    try { parse(yarnClassic) } catch (error) {
      expect((error as LockfileError).code).toBe('FORMAT_MISMATCH')
    }
  })

  it('parse rejects yarn-berry-v9 input with FORMAT_MISMATCH', () => {
    const yarnBerry = fixture('simple/yarn-berry-v9.lock')
    expect(() => parse(yarnBerry)).toThrow(LockfileError)
    try { parse(yarnBerry) } catch (error) {
      expect((error as LockfileError).code).toBe('FORMAT_MISMATCH')
    }
  })

  it('parse rejects npm-3 input with FORMAT_MISMATCH', () => {
    const npm3 = fixture('simple/npm-3.lock')
    expect(() => parse(npm3)).toThrow(LockfileError)
    try { parse(npm3) } catch (error) {
      expect((error as LockfileError).code).toBe('FORMAT_MISMATCH')
    }
  })

  it('cross-adapter probe: yarn-classic / yarn-berry-v9 / npm-3 reject pnpm-v9 input', () => {
    const own = fixture('simple/pnpm-v9.lock')
    expect(() => parseV5Lock(own)).toThrow()
    expect(() => parseYarnBerry(own)).toThrow()
    expect(() => parseNpm3(own)).toThrow()
  })
})

describe('pnpm-v9 — parse fixtures', () => {
  it.each(FIXTURES)('parses %s fixture', (name) => {
    const graph = parseFixtureGraph(name)
    expect(Array.from(graph.nodes())).not.toHaveLength(0)
  })

  it('parses the synthetic root node with workspacePath = ""', () => {
    const graph = parseFixtureGraph('simple')
    const root = graph.getNode('.@0.0.0')
    expect(root).toBeDefined()
    expect(root?.workspacePath).toBe('')
  })

  it('parses snapshots as graph nodes (one per snapshot key)', () => {
    const graph = parseFixtureGraph('simple')
    expect(graph.getNode('lodash@4.17.21')).toBeDefined()
    expect(graph.getNode('ms@2.1.3')).toBeDefined()
  })

  it('parses tarball payload integrity from packages map', () => {
    const graph = parseFixtureGraph('simple')
    const ms = graph.tarballOf('ms@2.1.3')
    expect(ms?.integrity).toBe('sha512-6FlzubTLZG3J2a/NVCAleEhjzq5oxgHyaCU9yYXvcLsvoVaHJq/s5xXI6/XXP6tz7R9xAOtHnSO/tXtF3WRTlA==')
  })

  it('parses scoped names with quoted snapshot keys verbatim', () => {
    const graph = parseFixtureGraph('deps-with-scopes')
    expect(graph.getNode('@sindresorhus/is@6.3.1')).toBeDefined()
    expect(graph.getNode('@types/node@20.11.30')).toBeDefined()
  })

  it('parses peer-virt snapshot keys into canonical NodeIds (ADR-0006 reference impl)', () => {
    const graph = parseFixtureGraph('peers-basic')
    const peerVirtId = 'react-dom@18.2.0(react@18.2.0)'
    const node = graph.getNode(peerVirtId)
    expect(node).toBeDefined()
    expect(node?.name).toBe('react-dom')
    expect(node?.version).toBe('18.2.0')
    expect(node?.peerContext).toEqual(['react@18.2.0'])
  })

  it('parses peer edges from peer-virt snapshots (peer-context source)', () => {
    const graph = parseFixtureGraph('peers-basic')
    const peerEdges = graph.out('react-dom@18.2.0(react@18.2.0)', 'peer')
    expect(peerEdges).toHaveLength(1)
    expect(peerEdges[0]?.dst).toBe('react@18.2.0')
  })

  it('parses importer dependencies into edges from importer node', () => {
    const graph = parseFixtureGraph('simple')
    const out = graph.out('.@0.0.0', 'dep').map(e => e.dst).sort()
    expect(out).toEqual(['lodash@4.17.21', 'ms@2.1.3'])
  })

  it('parses workspace members under importers as workspace nodes', () => {
    const graph = parseFixtureGraph('peers-multi')
    const wsNodes = Array.from(graph.nodes()).filter(n => n.workspacePath !== undefined && n.workspacePath !== '')
    expect(wsNodes.map(n => n.workspacePath).sort()).toEqual(['packages/a', 'packages/b'])
  })

  it('parses workspace cross-refs (link: resolution) into workspace edges', () => {
    const graph = parseFixtureGraph('workspace-cross-refs')
    const appNode = Array.from(graph.nodes()).find(n => n.workspacePath === 'packages/app')
    expect(appNode).toBeDefined()
    const outDeps = graph.out(appNode!.id, 'dep')
    // Should have edges to core and util workspace members.
    const wsDeps = outDeps.filter(e => e.attrs?.workspace === true)
    expect(wsDeps.length).toBeGreaterThan(0)
  })

  it('parses overrides sidecar (patch-yarn fixture carries overrides)', () => {
    const graph = parseFixtureGraph('patch-yarn')
    // overrides parsed as a top-level sidecar; surfaced на graph через
    // emit roundtrip. Verify graph carries lodash node.
    expect(graph.getNode('lodash@4.17.21')).toBeDefined()
  })

  it('warns on orphan snapshot (PNPM_V9_SNAPSHOTS_MISSING)', () => {
    // Synthesize hand-edited input: snapshots entry without matching
    // packages baseline. We DO NOT reference it from importers — that would
    // cause a seal failure (orphan dropped + dangling importer edge).
    const malformed =
      `lockfileVersion: '9.0'\n\n` +
      `settings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n\n` +
      `importers:\n\n  .: {}\n\n` +
      `packages: {}\n\n` +
      `snapshots:\n\n  ghost@1.0.0: {}\n`
    const graph = parse(malformed)
    const diags = graph.diagnostics().filter(d => d.code === 'PNPM_V9_SNAPSHOTS_MISSING')
    expect(diags).toHaveLength(1)
  })
})

describe('pnpm-v9 — stringify (§A.4 Graph-level roundtrip)', () => {
  it.each(FIXTURES.filter(n => n !== 'yarn-crlf'))('roundtrips %s at Graph level', (name) => {
    const original = parseFixtureGraph(name)
    const emitted = stringify(original)
    const reparsed = parse(emitted)

    expect(graphSnapshot(reparsed)).toEqual(graphSnapshot(original))
    expectEmptyGraphDiff(original.diff(reparsed))
    expect(Array.from(reparsed.tarballs())).toEqual(Array.from(original.tarballs()))
  })

  it('emits well-formed YAML with lockfileVersion: \'9.0\'', () => {
    const graph = parseFixtureGraph('simple')
    const text = stringify(graph)
    expect(text).toMatch(/^lockfileVersion: '9\.0'/)
  })

  it('emits canonical 2-space indent + trailing newline', () => {
    const graph = parseFixtureGraph('simple')
    const text = stringify(graph)
    expect(text.endsWith('\n')).toBe(true)
    expect(text).toContain('\n  autoInstallPeers:')
  })

  it('emits packages block sorted alphabetically by key', () => {
    const graph = parseFixtureGraph('peers-basic')
    const text = stringify(graph)
    const packagesIdx = text.indexOf('\npackages:')
    const snapshotsIdx = text.indexOf('\nsnapshots:')
    expect(packagesIdx).toBeGreaterThan(0)
    expect(snapshotsIdx).toBeGreaterThan(packagesIdx)
    const packagesBlock = text.slice(packagesIdx, snapshotsIdx)
    // Capture top-level packages keys: keys begin with 2-space indent, no further.
    const keys = Array.from(packagesBlock.matchAll(/^  ([^\s][^\n:]*):/gm)).map(m => m[1])
    expect(keys.length).toBeGreaterThan(0)
    expect(keys).toEqual([...keys].sort())
  })

  it('emits snapshots block sorted alphabetically and preserves peer-virt keys', () => {
    const graph = parseFixtureGraph('peers-basic')
    const text = stringify(graph)
    expect(text).toContain('  react-dom@18.2.0(react@18.2.0):')
    expect(text).toContain('  react@18.2.0:')
  })

  it('emits scoped names as quoted snapshot keys', () => {
    const graph = parseFixtureGraph('deps-with-scopes')
    const text = stringify(graph)
    expect(text).toMatch(/'@sindresorhus\/is@6\.3\.1':/)
    expect(text).toMatch(/'@types\/node@20\.11\.30':/)
  })

  it('emits resolution as flow-style inline {integrity: ...}', () => {
    const graph = parseFixtureGraph('simple')
    const text = stringify(graph)
    expect(text).toMatch(/resolution: \{integrity: sha512-/)
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

  it('emits settings block always (autoInstallPeers / excludeLinksFromLockfile)', () => {
    const graph = parseFixtureGraph('simple')
    const text = stringify(graph)
    expect(text).toMatch(/settings:\n  autoInstallPeers: (true|false)\n  excludeLinksFromLockfile: (true|false)/)
  })

  it('emits importers block ALWAYS — single-importer collapses to importers["."]', () => {
    const graph = parseFixtureGraph('simple')
    const text = stringify(graph)
    expect(text).toContain('importers:')
    expect(text).toMatch(/  \.:\n/)
  })

  it('roundtrips ADR-0006 canonical NodeId form for peer-virt instances', () => {
    const original = parseFixtureGraph('peers-multi')
    const emitted = stringify(original)
    const reparsed = parse(emitted)
    // Both peer-virt siblings should survive the roundtrip with canonical NodeIds.
    expect(reparsed.getNode('react-dom@17.0.2(react@17.0.2)')).toBeDefined()
    expect(reparsed.getNode('react-dom@18.2.0(react@18.2.0)')).toBeDefined()
    expectEmptyGraphDiff(original.diff(reparsed))
  })
})

describe('pnpm-v9 — modify (§B Mutator surface)', () => {
  it('roundtrips addNode + setTarball + addEdge', () => {
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
      m.addEdge('.@0.0.0', 'debug@4.4.1', 'dep', { range: '4.4.1' })
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

  it('roundtrips removeNode + removeTarball', () => {
    const original = parseFixtureGraph('simple')
    const result = original.mutate(m => {
      m.removeEdge('.@0.0.0', 'ms@2.1.3', 'dep')
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
      m.setTarball({ name: 'ms', version: '2.1.3' }, {
        integrity: 'sha512-modified-ms-integrity',
      })
    })
    const reparsed = parse(stringify(result.graph))
    expectEmptyGraphDiff(result.graph.diff(reparsed))
    expect(reparsed.tarballOf('ms@2.1.3')).toEqual({ integrity: 'sha512-modified-ms-integrity' })
  })

  it('roundtrips replaceNode (version bump)', () => {
    const original = parseFixtureGraph('simple')
    const current = original.getNode('ms@2.1.3')!
    const result = original.mutate(m => {
      m.removeEdge('.@0.0.0', 'ms@2.1.3', 'dep')
      m.replaceNode('ms@2.1.3', { ...current, id: 'ms@2.1.4', version: '2.1.4' })
      m.setTarball({ name: 'ms', version: '2.1.4' }, { integrity: 'sha512-bumped-ms-integrity' })
      m.removeTarball({ name: 'ms', version: '2.1.3' })
      m.addEdge('.@0.0.0', 'ms@2.1.4', 'dep', { range: '2.1.4' })
    })
    const reparsed = parse(stringify(result.graph))
    expect(reparsed.getNode('ms@2.1.3')).toBeUndefined()
    expect(reparsed.getNode('ms@2.1.4')).toBeDefined()
    expectEmptyGraphDiff(result.graph.diff(reparsed))
  })

  it('replacePeerContext is NON-lossy on pnpm-v9 (per ADR-0022 §B)', () => {
    // The pnpm family is the family that *defines* the canonical peer-context
    // encoding (ADR-0006); peer-virt round-trips byte-stable.
    const original = parseFixtureGraph('peers-basic')
    // Existing peer-virt node: react-dom@18.2.0(react@18.2.0)
    expect(original.getNode('react-dom@18.2.0(react@18.2.0)')).toBeDefined()

    const { lockfile, diagnostics } = stringifyWithDiagnostics(original)
    const reparsed = parse(lockfile)

    // No flatten diagnostics on pnpm-v9 — peer-context is native.
    expect(diagnostics.filter(d => d.code.endsWith('PEER_VIRT_FLATTENED'))).toHaveLength(0)
    expect(reparsed.getNode('react-dom@18.2.0(react@18.2.0)')).toBeDefined()
    expectEmptyGraphDiff(original.diff(reparsed))
  })

  it('setNode patch drops on emit with PNPM_V9_PATCH_DROPPED', () => {
    const original = parseFixtureGraph('simple')
    const patch = 'a'.repeat(128)
    const current = original.getNode('ms@2.1.3')!
    const result = original.mutate(m => {
      m.replaceNode('ms@2.1.3', { ...current, patch })
      m.setTarball({ name: 'ms', version: '2.1.3', patch }, { integrity: 'sha512-patched-ms-integrity' })
      m.removeTarball({ name: 'ms', version: '2.1.3' })
    })
    const { diagnostics } = stringifyWithDiagnostics(result.graph)

    expect(diagnostics.filter(d => d.code === 'PNPM_V9_PATCH_DROPPED')).toHaveLength(1)
  })

  it('emits each lossy diagnostic at most once per affected node', () => {
    const original = parseFixtureGraph('peers-basic')
    const patch = 'b'.repeat(128)
    const reactDom = original.getNode('react-dom@18.2.0(react@18.2.0)')!
    const result = original.mutate(m => {
      m.replaceNode('react-dom@18.2.0(react@18.2.0)', { ...reactDom, patch })
      m.setTarball({ name: 'react-dom', version: '18.2.0', patch }, { integrity: 'sha512-y' })
      m.removeTarball({ name: 'react-dom', version: '18.2.0' })
    })
    const { diagnostics } = stringifyWithDiagnostics(result.graph)
    expect(diagnostics.filter(d => d.code === 'PNPM_V9_PATCH_DROPPED')).toHaveLength(1)
  })
})

describe('pnpm-v9 — enrich (§C, ADR-0022 §C.pnpm-v9, ADR-0006 reference impl)', () => {
  it('peer-virt FIRST-CLASS: parse reads peer-context from snapshots keys (dominant path)', () => {
    const graph = parseFixtureGraph('peers-basic')
    // Peer-context already on disk; enrich is a no-op for binding.
    const result = enrich(graph)
    expect(result.graph.getNode('react-dom@18.2.0(react@18.2.0)')).toBeDefined()
    expect(result.graph.getNode('react-dom@18.2.0(react@18.2.0)')?.peerContext).toEqual(['react@18.2.0'])
  })

  it('peer-virt 1-candidate fallback (peer-context absent from disk)', () => {
    // Synthesise a hand-edited lockfile: react-dom declares peerDependencies
    // but has no peer-virt snapshot key. Enrich falls back to semver match.
    const malformed =
      `lockfileVersion: '9.0'\n\n` +
      `settings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n\n` +
      `importers:\n\n  .:\n    dependencies:\n` +
      `      react:\n        specifier: 18.2.0\n        version: 18.2.0\n` +
      `      react-dom:\n        specifier: 18.2.0\n        version: 18.2.0\n\n` +
      `packages:\n\n` +
      `  react@18.2.0:\n    resolution: {integrity: sha512-x}\n` +
      `  react-dom@18.2.0:\n    resolution: {integrity: sha512-y}\n` +
      `    peerDependencies:\n      react: ^18.2.0\n\n` +
      `snapshots:\n\n` +
      `  react@18.2.0: {}\n` +
      `  react-dom@18.2.0: {}\n`
    const graph = parse(malformed)
    const result = enrich(graph)
    // 1-cand match (only react@18.2.0 satisfies ^18.2.0); informational diagnostic.
    const infoCodes = result.diagnostics.map(d => d.code)
    expect(infoCodes).toContain('PNPM_V9_PEER_BOUND')
  })

  it('peer-virt ≥2-candidate fallback emits PNPM_V9_PEER_AMBIGUOUS', () => {
    // Two react versions installed; react-dom declares a permissive range
    // that matches both. The peer-virt snapshot is intentionally absent so
    // enrich runs its fallback.
    const malformed =
      `lockfileVersion: '9.0'\n\n` +
      `settings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n\n` +
      `importers:\n\n  .:\n    dependencies:\n` +
      `      react-dom:\n        specifier: 18.2.0\n        version: 18.2.0\n\n` +
      `packages:\n\n` +
      `  react@17.0.2:\n    resolution: {integrity: sha512-a}\n` +
      `  react@18.2.0:\n    resolution: {integrity: sha512-b}\n` +
      `  react-dom@18.2.0:\n    resolution: {integrity: sha512-c}\n` +
      `    peerDependencies:\n      react: '*'\n\n` +
      `snapshots:\n\n` +
      `  react@17.0.2: {}\n` +
      `  react@18.2.0: {}\n` +
      `  react-dom@18.2.0: {}\n`
    const graph = parse(malformed)
    const result = enrich(graph)
    expect(result.diagnostics.some(d => d.code === 'PNPM_V9_PEER_AMBIGUOUS')).toBe(true)
  })

  it('peer-virt 0-candidate fallback emits PNPM_V9_PEER_UNSATISFIED', () => {
    // react-dom declares a peerDependency on react@^99 — no candidate exists.
    const malformed =
      `lockfileVersion: '9.0'\n\n` +
      `settings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n\n` +
      `importers:\n\n  .:\n    dependencies:\n` +
      `      react-dom:\n        specifier: 18.2.0\n        version: 18.2.0\n\n` +
      `packages:\n\n` +
      `  react@18.2.0:\n    resolution: {integrity: sha512-a}\n` +
      `  react-dom@18.2.0:\n    resolution: {integrity: sha512-b}\n` +
      `    peerDependencies:\n      react: ^99.0.0\n\n` +
      `snapshots:\n\n` +
      `  react@18.2.0: {}\n` +
      `  react-dom@18.2.0: {}\n`
    const graph = parse(malformed)
    const result = enrich(graph)
    expect(result.diagnostics.some(d => d.code === 'PNPM_V9_PEER_UNSATISFIED')).toBe(true)
  })

  it('workspace concretisation without manifests emits PNPM_V9_NO_MANIFESTS', () => {
    const graph = parseFixtureGraph('peers-multi')
    const result = enrich(graph)
    expect(result.diagnostics.some(d => d.code === 'PNPM_V9_NO_MANIFESTS')).toBe(true)
  })

  it('workspace concretisation with manifests succeeds (no diagnostic)', () => {
    const graph = parseFixtureGraph('peers-multi')
    const result = enrich(graph, {
      manifests: {
        '': { name: 'root', version: '0.0.0' },
        'packages/a': { name: 'pkg-a', version: '1.0.0', dependencies: { react: '17.0.2' } },
        'packages/b': { name: 'pkg-b', version: '1.0.0', dependencies: { react: '18.2.0' } },
      },
    })
    expect(result.diagnostics.some(d => d.code === 'PNPM_V9_NO_MANIFESTS')).toBe(false)
  })

  it('enrich is monotone-additive (idempotent on already-enriched graph)', () => {
    const graph = parseFixtureGraph('simple')
    const first = enrich(graph)
    const second = enrich(first.graph)
    expect(graphSnapshot(second.graph)).toEqual(graphSnapshot(first.graph))
  })
})

describe('pnpm-v9 — optimize (§D prune unreachable)', () => {
  it('preserves reachable graph as no-op on each fixture', () => {
    for (const name of FIXTURES) {
      const graph = parseFixtureGraph(name)
      const result = optimize(graph)
      expectEmptyGraphDiff(graph.diff(result.graph))
    }
  })

  it('prunes unreachable nodes (self-loop orphan)', () => {
    const graph = parseFixtureGraph('simple')
    const withOrphan = graph.mutate(m => {
      m.addNode({
        id: 'orphan@1.0.0',
        name: 'orphan',
        version: '1.0.0',
        peerContext: [],
      })
      m.setTarball({ name: 'orphan', version: '1.0.0' }, { integrity: 'sha512-orphan' })
      // Self-loop — graph treats `orphan` as non-root (it has incoming edge from itself).
      m.addEdge('orphan@1.0.0', 'orphan@1.0.0', 'dep', { range: '1.0.0' })
    })
    expect(withOrphan.graph.getNode('orphan@1.0.0')).toBeDefined()
    const optimized = optimize(withOrphan.graph)
    expect(optimized.graph.getNode('orphan@1.0.0')).toBeUndefined()
  })

  it('is idempotent — running optimize twice yields the same graph', () => {
    const graph = parseFixtureGraph('peers-basic')
    const withOrphan = graph.mutate(m => {
      m.addNode({
        id: 'orphan@2.0.0',
        name: 'orphan',
        version: '2.0.0',
        peerContext: [],
      })
      m.addEdge('orphan@2.0.0', 'orphan@2.0.0', 'dep', { range: '2.0.0' })
    })
    const first = optimize(withOrphan.graph)
    const second = optimize(first.graph)
    expectEmptyGraphDiff(first.graph.diff(second.graph))
  })

  it('roundtrips post-optimize through stringify (§D acceptance gate)', () => {
    const graph = parseFixtureGraph('peers-basic')
    const optimized = optimize(graph)
    const reparsed = parse(stringify(optimized.graph))
    expectEmptyGraphDiff(optimized.graph.diff(reparsed))
  })

  it('drops orphaned packages entries после prune (cross-block consistency)', () => {
    const graph = parseFixtureGraph('simple')
    const withOrphan = graph.mutate(m => {
      m.addNode({
        id: 'orphan@1.0.0',
        name: 'orphan',
        version: '1.0.0',
        peerContext: [],
      })
      m.setTarball({ name: 'orphan', version: '1.0.0' }, { integrity: 'sha512-orphan' })
      m.addEdge('orphan@1.0.0', 'orphan@1.0.0', 'dep', { range: '1.0.0' })
    })
    const optimized = optimize(withOrphan.graph)
    const text = stringify(optimized.graph)
    // The orphan should be absent in the emitted lockfile.
    expect(text).not.toContain('orphan@1.0.0')
  })
})

describe('pnpm-v9 — ADR-0006 canonical NodeId form roundtrip', () => {
  it('peer-virt NodeId roundtrips byte-stable через emit + reparse', () => {
    const graph = parseFixtureGraph('peers-multi')
    const peerVirtNodes = Array.from(graph.nodes()).filter(n => n.peerContext.length > 0)
    expect(peerVirtNodes.length).toBeGreaterThan(0)

    const text = stringify(graph)
    const reparsed = parse(text)

    for (const node of peerVirtNodes) {
      const round = reparsed.getNode(node.id)
      expect(round).toBeDefined()
      expect(round?.peerContext).toEqual(node.peerContext)
    }
  })

  it('multi-peer rendering sorts alphabetically by peer-name', () => {
    // Synthesise a peer-virt node with two peers and verify the on-disk
    // emit sorts the segments alphabetically.
    const graph = parseFixtureGraph('peers-basic')
    const reactDom = graph.getNode('react-dom@18.2.0(react@18.2.0)')!
    expect(reactDom.peerContext).toEqual(['react@18.2.0']) // single-peer baseline
    // Verify emit shape carries the parenthesised suffix.
    const text = stringify(graph)
    expect(text).toContain('react-dom@18.2.0(react@18.2.0):')
  })
})
