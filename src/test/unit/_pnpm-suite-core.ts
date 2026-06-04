// _pnpm-suite-core.ts — shape-agnostic lifecycle suite shared across
// pnpm-v5 / pnpm-v6 / pnpm-v9 adapters.
//
// Resolves r1 collab F4 on top of the existing flat-suite extraction
// (which covers v6/v9 only — those share the quoted-handshake + parens-
// peer-context shape). v5 уже had a near-duplicate 829-LoC mirror of
// the flat-suite lifecycle coverage с v5 literals substituted. This
// module factors lifecycle assertions that are identical in semantics
// across all three versions (mutator surface, enrich peer-virt-first-
// class + manifests, optimize prune, ADR-0006 canonical NodeId
// roundtrip) and parameterises them через a richer spec type.
//
// Shape-specific assertions (importers vs. collapsed-dependencies-only
// vs. specifiers+dependencies, packages key form, peer-context location,
// snapshots block presence, dev flag etc.) stay in the calling
// per-version test files OR in `_pnpm-flat-suite.ts` (v6+v9 shared shape).
//
// NO describe()/it() registrations in v5's `_pnpm-flat-suite.ts` mirror
// — v5 wires this core suite directly because its shape would otherwise
// require widening the `PnpmFamilySpec` discriminant unions everywhere.

import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { type Diagnostic, type Graph } from '../../main/ts/graph.ts'
import {
  expectEmptyGraphDiff,
  fixture,
  graphSnapshot,
  stringifyWithDiagnostics as sharedStringifyWithDiagnostics,
} from '../helpers/lockfile-test-utils.ts'

import { mkIntegrity, sri } from '../_integrity-fixtures.ts'
import { canonicalDigest } from '../../main/ts/recipe/integrity.ts'

const sriOf = (s: string): string => 'sha512-' + createHash('sha512').update(s).digest('base64')
const MODIFIED_SRI = sriOf('modified-ms-integrity')
const BUMPED_SRI = sriOf('bumped-ms-integrity')

export interface PnpmCoreAdapter {
  check(input: string): boolean
  parse(input: string, options?: { onDiagnostic?: (d: Diagnostic) => void }): Graph
  stringify(graph: Graph, options?: { lineEnding?: 'lf' | 'crlf'; onDiagnostic?: (d: Diagnostic) => void }): string
  enrich(graph: Graph, options?: { manifests?: Record<string, any> }): { graph: Graph; diagnostics: Diagnostic[] }
  optimize(graph: Graph, options?: {}): { graph: Graph; diagnostics: Diagnostic[] }
}

/**
 * Spec бы the lifecycle suite. Carries enough metadata to compose
 * fixture paths, diagnostic codes, and assertions without referring к
 * any version-specific schema detail.
 */
export interface PnpmCoreSuiteSpec {
  /** Display label, e.g. 'pnpm-v5', 'pnpm-v6', 'pnpm-v9'. */
  label: string
  /** Diagnostic prefix per ADR-0022 (e.g. `PNPM_V5`, `PNPM_V6`, `PNPM_V9`). */
  diagPrefix: string
  /**
   * `<scenario>/<adapter>.lock` filename suffix (e.g. `pnpm-v5.lock`).
   * The fixture catalogue is implicit — each named fixture is resolved
   * as `<fixtureName>/<fixtureSuffix>` под the standard fixtures root.
   */
  fixtureSuffix: string
  /** Fixture names exercised by lifecycle assertions. */
  fixtures: ReadonlyArray<string>
  /** Adapter under test. */
  adapter: PnpmCoreAdapter
}

function parseFixtureGraph(spec: PnpmCoreSuiteSpec, name: string): Graph {
  return spec.adapter.parse(fixture(`${name}/${spec.fixtureSuffix}`))
}

function stringifyWithDiagnostics(
  spec: PnpmCoreSuiteSpec,
  graph: Graph,
): { lockfile: string; diagnostics: Diagnostic[] } {
  return sharedStringifyWithDiagnostics(spec.adapter, graph)
}

// === §A.4 lifecycle roundtrip — every fixture stable through emit + reparse =

export function describeRoundtripLifecycle(spec: PnpmCoreSuiteSpec): void {
  const { label, fixtures } = spec
  // yarn-crlf is exercised by а dedicated CRLF case in per-version files;
  // exclude here as the lifecycle assertion stringifies LF.
  const lfFixtures = fixtures.filter(n => n !== 'yarn-crlf')

  describe(`${label} — roundtrip lifecycle (shared)`, () => {
    it.each(lfFixtures)('roundtrips %s at Graph level', (fixtureName) => {
      const original = parseFixtureGraph(spec, fixtureName)
      const emitted = spec.adapter.stringify(original)
      const reparsed = spec.adapter.parse(emitted)

      expect(graphSnapshot(reparsed)).toEqual(graphSnapshot(original))
      expectEmptyGraphDiff(original.diff(reparsed))
      expect(Array.from(reparsed.tarballs())).toEqual(Array.from(original.tarballs()))
    })
  })
}

// === §B Mutator surface =====================================================

export function describeModifyCommon(spec: PnpmCoreSuiteSpec): void {
  const { label, diagPrefix } = spec
  describe(`${label} — modify (§B Mutator surface)`, () => {
    it('roundtrips addNode + setTarball + addEdge', () => {
      const original = parseFixtureGraph(spec, 'simple')
      const result = original.mutate(m => {
        m.addNode({
          id: 'debug@4.4.1',
          name: 'debug',
          version: '4.4.1',
          peerContext: [],
        })
        m.setTarball({ name: 'debug', version: '4.4.1' }, {
          integrity: mkIntegrity('sha512-fakedebugintegrity'),
        })
        m.addEdge('.@0.0.0', 'debug@4.4.1', 'dep', { range: '4.4.1' })
      })
      const reparsed = spec.adapter.parse(spec.adapter.stringify(result.graph))
      expectEmptyGraphDiff(result.graph.diff(reparsed))
      expect(reparsed.getNode('debug@4.4.1')).toBeDefined()
    })

    it('roundtrips addEdge dep + removeEdge', () => {
      const original = parseFixtureGraph(spec, 'simple')
      const added = original.mutate(m => {
        m.addEdge('lodash@4.17.21', 'ms@2.1.3', 'dep', { range: '2.1.3' })
      })
      const reparsed = spec.adapter.parse(spec.adapter.stringify(added.graph))
      expectEmptyGraphDiff(added.graph.diff(reparsed))

      const removed = added.graph.mutate(m => {
        m.removeEdge('lodash@4.17.21', 'ms@2.1.3', 'dep')
      })
      const reparsedRemoved = spec.adapter.parse(spec.adapter.stringify(removed.graph))
      expectEmptyGraphDiff(removed.graph.diff(reparsedRemoved))
    })

    it('roundtrips removeNode + removeTarball', () => {
      const original = parseFixtureGraph(spec, 'simple')
      const result = original.mutate(m => {
        m.removeEdge('.@0.0.0', 'ms@2.1.3', 'dep')
        m.removeNode('ms@2.1.3')
        m.removeTarball({ name: 'ms', version: '2.1.3' })
      })
      const reparsed = spec.adapter.parse(spec.adapter.stringify(result.graph))
      expectEmptyGraphDiff(result.graph.diff(reparsed))
      expect(reparsed.getNode('ms@2.1.3')).toBeUndefined()
    })

    it('roundtrips setTarball (integrity update)', () => {
      const original = parseFixtureGraph(spec, 'simple')
      const result = original.mutate(m => {
        m.setTarball({ name: 'ms', version: '2.1.3' }, { integrity: sri(MODIFIED_SRI) })
      })
      const reparsed = spec.adapter.parse(spec.adapter.stringify(result.graph))
      expectEmptyGraphDiff(result.graph.diff(reparsed))
      // ADR-0014 §4.F3 — round-trip parse re-derives canonical resolution
      // from the on-disk `resolution:` block (or by convention from
      // name@version when only `integrity:` is emitted).
      expect(canonicalDigest(reparsed.tarballOf('ms@2.1.3')!.integrity!)).toBe(MODIFIED_SRI)
    })

    it('roundtrips replaceNode (version bump)', () => {
      const original = parseFixtureGraph(spec, 'simple')
      const current = original.getNode('ms@2.1.3')!
      const result = original.mutate(m => {
        m.removeEdge('.@0.0.0', 'ms@2.1.3', 'dep')
        m.replaceNode('ms@2.1.3', { ...current, id: 'ms@2.1.4', version: '2.1.4' })
        m.setTarball({ name: 'ms', version: '2.1.4' }, { integrity: sri(BUMPED_SRI) })
        m.removeTarball({ name: 'ms', version: '2.1.3' })
        m.addEdge('.@0.0.0', 'ms@2.1.4', 'dep', { range: '2.1.4' })
      })
      const reparsed = spec.adapter.parse(spec.adapter.stringify(result.graph))
      expect(reparsed.getNode('ms@2.1.3')).toBeUndefined()
      expect(reparsed.getNode('ms@2.1.4')).toBeDefined()
      expectEmptyGraphDiff(result.graph.diff(reparsed))
    })

    it('replacePeerContext is NON-lossy (pnpm-family carries peer-virt natively)', () => {
      const original = parseFixtureGraph(spec, 'peers-basic')
      expect(original.getNode('react-dom@18.2.0(react@18.2.0)')).toBeDefined()

      const { lockfile, diagnostics } = stringifyWithDiagnostics(spec, original)
      const reparsed = spec.adapter.parse(lockfile)

      expect(diagnostics.filter(d => d.code.endsWith('PEER_VIRT_FLATTENED'))).toHaveLength(0)
      expect(reparsed.getNode('react-dom@18.2.0(react@18.2.0)')).toBeDefined()
      expectEmptyGraphDiff(original.diff(reparsed))
    })

    it(`setNode patch drops on emit with RECIPE_FEATURE_DROPPED`, () => {
      const original = parseFixtureGraph(spec, 'simple')
      const patch = 'a'.repeat(128)
      const current = original.getNode('ms@2.1.3')!
      const result = original.mutate(m => {
        m.replaceNode('ms@2.1.3', { ...current, patch })
        m.setTarball({ name: 'ms', version: '2.1.3', patch }, { integrity: mkIntegrity('sha512-patched-ms-integrity') })
        m.removeTarball({ name: 'ms', version: '2.1.3' })
      })
      const { diagnostics } = stringifyWithDiagnostics(spec, result.graph)
      expect(diagnostics.filter(d => d.code === 'RECIPE_FEATURE_DROPPED' && d.subject === 'ms@2.1.3')).toHaveLength(1)
    })

    it('emits each lossy diagnostic at most once per affected node', () => {
      const original = parseFixtureGraph(spec, 'peers-basic')
      const patch = 'b'.repeat(128)
      const reactDom = original.getNode('react-dom@18.2.0(react@18.2.0)')!
      const result = original.mutate(m => {
        m.replaceNode('react-dom@18.2.0(react@18.2.0)', { ...reactDom, patch })
        m.setTarball({ name: 'react-dom', version: '18.2.0', patch }, { integrity: mkIntegrity('sha512-y') })
        m.removeTarball({ name: 'react-dom', version: '18.2.0' })
      })
      const { diagnostics } = stringifyWithDiagnostics(spec, result.graph)
      expect(diagnostics.filter(d => d.code === 'RECIPE_FEATURE_DROPPED' && d.subject === 'react-dom@18.2.0(react@18.2.0)')).toHaveLength(1)
    })
  })
}

// === §C Enrich (peer-virt + workspace concretisation) =======================

export function describeEnrichCommon(spec: PnpmCoreSuiteSpec): void {
  const { label, diagPrefix } = spec
  describe(`${label} — enrich (§C, ADR-0006 reference impl)`, () => {
    it('peer-virt FIRST-CLASS: parse reads peer-context from disk (dominant path)', () => {
      const graph = parseFixtureGraph(spec, 'peers-basic')
      const result = spec.adapter.enrich(graph)
      expect(result.graph.getNode('react-dom@18.2.0(react@18.2.0)')).toBeDefined()
      expect(result.graph.getNode('react-dom@18.2.0(react@18.2.0)')?.peerContext).toEqual(['react@18.2.0'])
    })

    it(`workspace concretisation without manifests emits ${diagPrefix}_NO_MANIFESTS`, () => {
      const graph = parseFixtureGraph(spec, 'peers-multi')
      const result = spec.adapter.enrich(graph)
      expect(result.diagnostics.some(d => d.code === `${diagPrefix}_NO_MANIFESTS`)).toBe(true)
    })

    it('workspace concretisation with manifests succeeds (no diagnostic)', () => {
      const graph = parseFixtureGraph(spec, 'peers-multi')
      const result = spec.adapter.enrich(graph, {
        manifests: {
          '': { name: 'root', version: '0.0.0' },
          'packages/a': { name: 'pkg-a', version: '1.0.0', dependencies: { react: '17.0.2' } },
          'packages/b': { name: 'pkg-b', version: '1.0.0', dependencies: { react: '18.2.0' } },
        },
      })
      expect(result.diagnostics.some(d => d.code === `${diagPrefix}_NO_MANIFESTS`)).toBe(false)
    })

    it('enrich is monotone-additive (idempotent on already-enriched graph)', () => {
      const graph = parseFixtureGraph(spec, 'simple')
      const first = spec.adapter.enrich(graph)
      const second = spec.adapter.enrich(first.graph)
      expect(graphSnapshot(second.graph)).toEqual(graphSnapshot(first.graph))
    })
  })
}

// === §D Optimize ============================================================

export function describeOptimizeCommon(spec: PnpmCoreSuiteSpec): void {
  const { label, fixtures } = spec
  describe(`${label} — optimize (§D prune unreachable)`, () => {
    it('preserves reachable graph as no-op on each fixture', () => {
      for (const name of fixtures) {
        const graph = parseFixtureGraph(spec, name)
        const result = spec.adapter.optimize(graph)
        expectEmptyGraphDiff(graph.diff(result.graph))
      }
    })

    it('prunes unreachable nodes (self-loop orphan)', () => {
      const graph = parseFixtureGraph(spec, 'simple')
      const withOrphan = graph.mutate(m => {
        m.addNode({
          id: 'orphan@1.0.0',
          name: 'orphan',
          version: '1.0.0',
          peerContext: [],
        })
        m.setTarball({ name: 'orphan', version: '1.0.0' }, { integrity: mkIntegrity('sha512-orphan') })
        m.addEdge('orphan@1.0.0', 'orphan@1.0.0', 'dep', { range: '1.0.0' })
      })
      expect(withOrphan.graph.getNode('orphan@1.0.0')).toBeDefined()
      const optimized = spec.adapter.optimize(withOrphan.graph)
      expect(optimized.graph.getNode('orphan@1.0.0')).toBeUndefined()
    })

    it('is idempotent — running optimize twice yields the same graph', () => {
      const graph = parseFixtureGraph(spec, 'peers-basic')
      const withOrphan = graph.mutate(m => {
        m.addNode({
          id: 'orphan@2.0.0',
          name: 'orphan',
          version: '2.0.0',
          peerContext: [],
        })
        m.addEdge('orphan@2.0.0', 'orphan@2.0.0', 'dep', { range: '2.0.0' })
      })
      const first = spec.adapter.optimize(withOrphan.graph)
      const second = spec.adapter.optimize(first.graph)
      expectEmptyGraphDiff(first.graph.diff(second.graph))
    })

    it('roundtrips post-optimize through stringify (§D acceptance gate)', () => {
      const graph = parseFixtureGraph(spec, 'peers-basic')
      const optimized = spec.adapter.optimize(graph)
      const reparsed = spec.adapter.parse(spec.adapter.stringify(optimized.graph))
      expectEmptyGraphDiff(optimized.graph.diff(reparsed))
    })

    it('drops orphaned packages entries после prune (cross-block consistency)', () => {
      const graph = parseFixtureGraph(spec, 'simple')
      const withOrphan = graph.mutate(m => {
        m.addNode({
          id: 'orphan@1.0.0',
          name: 'orphan',
          version: '1.0.0',
          peerContext: [],
        })
        m.setTarball({ name: 'orphan', version: '1.0.0' }, { integrity: mkIntegrity('sha512-orphan') })
        m.addEdge('orphan@1.0.0', 'orphan@1.0.0', 'dep', { range: '1.0.0' })
      })
      const optimized = spec.adapter.optimize(withOrphan.graph)
      const text = spec.adapter.stringify(optimized.graph)
      expect(text).not.toContain('orphan@1.0.0')
    })
  })
}

// === ADR-0006 canonical NodeId form roundtrip ===============================

export function describeCanonicalNodeIdRoundtrip(spec: PnpmCoreSuiteSpec): void {
  const { label } = spec
  describe(`${label} — ADR-0006 canonical NodeId form roundtrip`, () => {
    it('peer-virt NodeId roundtrips byte-stable через emit + reparse', () => {
      const graph = parseFixtureGraph(spec, 'peers-multi')
      const peerVirtNodes = Array.from(graph.nodes()).filter(n => n.peerContext.length > 0)
      expect(peerVirtNodes.length).toBeGreaterThan(0)

      const text = spec.adapter.stringify(graph)
      const reparsed = spec.adapter.parse(text)

      for (const node of peerVirtNodes) {
        const round = reparsed.getNode(node.id)
        expect(round).toBeDefined()
        expect(round?.peerContext).toEqual(node.peerContext)
      }
    })

    it('peer-virt multi-version siblings roundtrip independently', () => {
      const original = parseFixtureGraph(spec, 'peers-multi')
      const emitted = spec.adapter.stringify(original)
      const reparsed = spec.adapter.parse(emitted)
      expect(reparsed.getNode('react-dom@17.0.2(react@17.0.2)')).toBeDefined()
      expect(reparsed.getNode('react-dom@18.2.0(react@18.2.0)')).toBeDefined()
      expectEmptyGraphDiff(original.diff(reparsed))
    })
  })
}

// === Cross-format isolation =================================================

export function describeCrossFormatIsolation(spec: PnpmCoreSuiteSpec): void {
  const { label, adapter } = spec
  // Other formats that this adapter must reject. All members are real
  // fixtures present in the test corpus.
  const FOREIGN_FORMATS = [
    'yarn-classic.lock',
    'yarn-berry-v9.lock',
    'npm-3.lock',
  ] as const

  describe(`${label} — cross-format isolation`, () => {
    it(`accepts ${label} fixture and rejects yarn/npm inputs`, () => {
      const own = fixture(`simple/${spec.fixtureSuffix}`)
      expect(adapter.check(own)).toBe(true)
      for (const sibling of FOREIGN_FORMATS) {
        const text = fixture(`simple/${sibling}`)
        expect(adapter.check(text)).toBe(false)
      }
    })
  })
}

// === Common parse-fixture assertions ========================================

export function describeParseFixturesCommon(spec: PnpmCoreSuiteSpec): void {
  const { label, fixtures } = spec
  describe(`${label} — parse fixtures (shared)`, () => {
    it.each(fixtures)('parses %s fixture', (fixtureName) => {
      const graph = parseFixtureGraph(spec, fixtureName)
      expect(Array.from(graph.nodes())).not.toHaveLength(0)
    })

    it('parses the synthetic root node with workspacePath = ""', () => {
      const graph = parseFixtureGraph(spec, 'simple')
      const root = graph.getNode('.@0.0.0')
      expect(root).toBeDefined()
      expect(root?.workspacePath).toBe('')
    })

    it('parses packages entries as graph nodes (one per resolved instance)', () => {
      const graph = parseFixtureGraph(spec, 'simple')
      expect(graph.getNode('lodash@4.17.21')).toBeDefined()
      expect(graph.getNode('ms@2.1.3')).toBeDefined()
    })

    it('parses tarball payload integrity from packages map', () => {
      const graph = parseFixtureGraph(spec, 'simple')
      const ms = graph.tarballOf('ms@2.1.3')
      expect(canonicalDigest(ms!.integrity!)).toBe('sha512-6FlzubTLZG3J2a/NVCAleEhjzq5oxgHyaCU9yYXvcLsvoVaHJq/s5xXI6/XXP6tz7R9xAOtHnSO/tXtF3WRTlA==')
    })

    it('parses scoped names with quoted keys verbatim', () => {
      const graph = parseFixtureGraph(spec, 'deps-with-scopes')
      expect(graph.getNode('@sindresorhus/is@6.3.1')).toBeDefined()
      expect(graph.getNode('@types/node@20.11.30')).toBeDefined()
    })

    it('parses peer-virt keys into canonical NodeIds (ADR-0006)', () => {
      const graph = parseFixtureGraph(spec, 'peers-basic')
      const peerVirtId = 'react-dom@18.2.0(react@18.2.0)'
      const node = graph.getNode(peerVirtId)
      expect(node).toBeDefined()
      expect(node?.name).toBe('react-dom')
      expect(node?.version).toBe('18.2.0')
      expect(node?.peerContext).toEqual(['react@18.2.0'])
    })

    it('parses peer edges from peer-virt nodes', () => {
      const graph = parseFixtureGraph(spec, 'peers-basic')
      const peerEdges = graph.out('react-dom@18.2.0(react@18.2.0)', 'peer')
      expect(peerEdges).toHaveLength(1)
      expect(peerEdges[0]?.dst).toBe('react@18.2.0')
    })

    it('parses importer dependencies into edges from importer node', () => {
      const graph = parseFixtureGraph(spec, 'simple')
      const out = graph.out('.@0.0.0', 'dep').map(e => e.dst).sort()
      expect(out).toEqual(['lodash@4.17.21', 'ms@2.1.3'])
    })

    it('parses workspace members under importers as workspace nodes', () => {
      const graph = parseFixtureGraph(spec, 'peers-multi')
      const wsNodes = Array.from(graph.nodes()).filter(n => n.workspacePath !== undefined && n.workspacePath !== '')
      expect(wsNodes.map(n => n.workspacePath).sort()).toEqual(['packages/a', 'packages/b'])
    })

    it('parses workspace cross-refs (link: resolution) into workspace edges', () => {
      const graph = parseFixtureGraph(spec, 'workspace-cross-refs')
      const appNode = Array.from(graph.nodes()).find(n => n.workspacePath === 'packages/app')
      expect(appNode).toBeDefined()
      const outDeps = graph.out(appNode!.id, 'dep')
      const wsDeps = outDeps.filter(e => e.attrs?.workspace === true)
      expect(wsDeps.length).toBeGreaterThan(0)
    })
  })
}

/** Register every shape-agnostic describe block for a pnpm-family adapter. */
export function registerPnpmCoreSuite(spec: PnpmCoreSuiteSpec): void {
  describeCrossFormatIsolation(spec)
  describeParseFixturesCommon(spec)
  describeRoundtripLifecycle(spec)
  describeModifyCommon(spec)
  describeEnrichCommon(spec)
  describeOptimizeCommon(spec)
  describeCanonicalNodeIdRoundtrip(spec)
}
