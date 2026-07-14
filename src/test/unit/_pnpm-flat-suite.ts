// _pnpm-flat-suite.ts — shared describe-block registration for pnpm-family adapters.
//
// Resolves pnpm-v9 RESIDUE F3 per ADR-0022 §5 — extracts the
// family-agnostic test harness mirror of `_npm-flat-suite.ts`. Per-version
// delta tests stay in the individual `pnpm-v{6,9}.test.ts` files (v9
// snapshots-block stability, v6 dependencies-collapsed shape, etc.).

import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { type Graph } from '../../main/ts/graph.ts'
import { LockfileError } from '../../main/ts/api/errors.ts'
import { parse as parseClassic } from '../../main/ts/formats/yarn-classic.ts'
import { parse as parseYarnBerry } from '../../main/ts/formats/yarn-berry-v9.ts'
import { parse as parseNpm3 } from '../../main/ts/formats/npm-3.ts'

const sriOf = (s: string): string => 'sha512-' + createHash('sha512').update(s).digest('base64')
const MODIFIED_SRI = sriOf('modified-ms-integrity')
const BUMPED_SRI = sriOf('bumped-ms-integrity')
import {
  FIXTURES,
  expectEmptyGraphDiff,
  fixture,
  graphSnapshot,
  parseFixtureGraph,
  stringifyWithDiagnostics,
  templateRootOf,
  type PnpmFamilySpec,
} from './_pnpm-flat-test-utils.ts'
import { mkIntegrity, sri } from '../_integrity-fixtures.ts'
import { canonicalDigest } from '../../main/ts/recipe/integrity.ts'

// === Discriminant + cross-format isolation =================================

export function describeDiscriminantAndIsolation(spec: PnpmFamilySpec): void {
  const { label, adapter } = spec

  describe(`${label} — discriminant and isolation (§A cross-version)`, () => {
    it(`accepts ${label} fixture and rejects sibling pnpm versions + yarn/npm inputs`, () => {
      const own = fixture(`simple/${spec.fixtureSuffix}`)
      const yarnClassic = fixture('simple/yarn-classic.lock')
      const yarnBerry = fixture('simple/yarn-berry-v9.lock')
      const npm3 = fixture('simple/npm-3.lock')

      expect(adapter.check(own)).toBe(true)
      for (const sibling of spec.crossVersionRejects) {
        const text = fixture(`simple/${sibling}`)
        expect(adapter.check(text)).toBe(false)
      }
      expect(adapter.check(yarnClassic)).toBe(false)
      expect(adapter.check(yarnBerry)).toBe(false)
      expect(adapter.check(npm3)).toBe(false)
    })

    for (const sibling of spec.crossVersionRejects) {
      it(`parse rejects ${sibling} with FORMAT_MISMATCH`, () => {
        const text = fixture(`simple/${sibling}`)
        expect(() => adapter.parse(text)).toThrow(LockfileError)
        try { adapter.parse(text) } catch (error) {
          expect((error as LockfileError).code).toBe('FORMAT_MISMATCH')
        }
      })
    }

    it('parse rejects yarn-classic input with FORMAT_MISMATCH', () => {
      const yarnClassic = fixture('simple/yarn-classic.lock')
      expect(() => adapter.parse(yarnClassic)).toThrow(LockfileError)
      try { adapter.parse(yarnClassic) } catch (error) {
        expect((error as LockfileError).code).toBe('FORMAT_MISMATCH')
      }
    })

    it('parse rejects yarn-berry-v9 input with FORMAT_MISMATCH', () => {
      const yarnBerry = fixture('simple/yarn-berry-v9.lock')
      expect(() => adapter.parse(yarnBerry)).toThrow(LockfileError)
      try { adapter.parse(yarnBerry) } catch (error) {
        expect((error as LockfileError).code).toBe('FORMAT_MISMATCH')
      }
    })

    it('parse rejects npm-3 input with FORMAT_MISMATCH', () => {
      const npm3 = fixture('simple/npm-3.lock')
      expect(() => adapter.parse(npm3)).toThrow(LockfileError)
      try { adapter.parse(npm3) } catch (error) {
        expect((error as LockfileError).code).toBe('FORMAT_MISMATCH')
      }
    })

    it(`cross-adapter probe: yarn-classic / yarn-berry-v9 / npm-3 reject ${label} input`, () => {
      const own = fixture(`simple/${spec.fixtureSuffix}`)
      expect(() => parseClassic(own)).toThrow()
      expect(() => parseYarnBerry(own)).toThrow()
      expect(() => parseNpm3(own)).toThrow()
    })
  })
}

// === Parse-fixtures common ==================================================

export function describeParseFixturesCommon(spec: PnpmFamilySpec): void {
  const { label } = spec
  describe(`${label} — parse fixtures (shared)`, () => {
    it.each(FIXTURES)('parses %s fixture', (fixtureName) => {
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

    it('parses overrides sidecar + canonical patch hash (ADR-0014 §4.F2)', () => {
      const graph = parseFixtureGraph(spec, 'patch-yarn')
      const lodash = graph.getNode('lodash@4.17.21')
      expect(lodash).toBeDefined()
      // workspaceRoot is threaded by parseFixtureGraph → canonical
      // byte-hashing path exercised here (not sentinel fallback).
      expect(lodash?.patch).toMatch(/^[0-9a-f]{128}$/)
    })
  })
}

// === Stringify common =======================================================

export function describeStringifyCommon(spec: PnpmFamilySpec): void {
  const { label, lockfileVersion } = spec
  describe(`${label} — stringify (§A.4 Graph-level roundtrip, shared)`, () => {
    it.each(FIXTURES.filter(n => n !== 'yarn-crlf'))('roundtrips %s at Graph level', (fixtureName) => {
      const original = parseFixtureGraph(spec, fixtureName)
      const emitted = spec.adapter.stringify(original)
      // Re-parse with the same workspaceRoot so patch-yarn lands on the
      // canonical byte-hashing path (matches the original parse) instead
      // of the sentinel fallback.
      const reparsed = spec.adapter.parse(emitted, { workspaceRoot: templateRootOf(fixtureName) })

      expect(graphSnapshot(reparsed)).toEqual(graphSnapshot(original))
      expectEmptyGraphDiff(original.diff(reparsed))
      expect(Array.from(reparsed.tarballs())).toEqual(Array.from(original.tarballs()))
    })

    it(`emits well-formed YAML with lockfileVersion: '${lockfileVersion}'`, () => {
      const graph = parseFixtureGraph(spec, 'simple')
      const text = spec.adapter.stringify(graph)
      expect(text).toMatch(new RegExp(`^lockfileVersion: '${lockfileVersion.replace(/\./g, '\\.')}'`))
    })

    it('emits canonical 2-space indent + trailing newline', () => {
      const graph = parseFixtureGraph(spec, 'simple')
      const text = spec.adapter.stringify(graph)
      expect(text.endsWith('\n')).toBe(true)
      expect(text).toContain('\n  autoInstallPeers:')
    })

    it('emits scoped names as quoted packages keys', () => {
      const graph = parseFixtureGraph(spec, 'deps-with-scopes')
      const text = spec.adapter.stringify(graph)
      expect(text).toMatch(/'@sindresorhus\/is/)
      expect(text).toMatch(/'@types\/node/)
    })

    it('emits resolution as flow-style inline {integrity: ...}', () => {
      const graph = parseFixtureGraph(spec, 'simple')
      const text = spec.adapter.stringify(graph)
      expect(text).toMatch(/resolution: \{integrity: sha512-/)
    })

    it('roundtrips yarn-crlf at Graph level when CRLF is requested', () => {
      const original = parseFixtureGraph(spec, 'yarn-crlf')
      const emitted = spec.adapter.stringify(original, { lineEnding: 'crlf' })
      const reparsed = spec.adapter.parse(emitted)

      expect(emitted).toContain('\r\n')
      expect(emitted.replace(/\r\n/g, '\n')).toBe(spec.adapter.stringify(original))
      expect(graphSnapshot(reparsed)).toEqual(graphSnapshot(original))
      expectEmptyGraphDiff(original.diff(reparsed))
    })

    it('emits settings block always (autoInstallPeers / excludeLinksFromLockfile)', () => {
      const graph = parseFixtureGraph(spec, 'simple')
      const text = spec.adapter.stringify(graph)
      expect(text).toMatch(/settings:\n  autoInstallPeers: (true|false)\n  excludeLinksFromLockfile: (true|false)/)
    })

    it('roundtrips ADR-0006 canonical NodeId form for peer-virt instances', () => {
      const original = parseFixtureGraph(spec, 'peers-multi')
      const emitted = spec.adapter.stringify(original)
      const reparsed = spec.adapter.parse(emitted)
      expect(reparsed.getNode('react-dom@17.0.2(react@17.0.2)')).toBeDefined()
      expect(reparsed.getNode('react-dom@18.2.0(react@18.2.0)')).toBeDefined()
      expectEmptyGraphDiff(original.diff(reparsed))
    })
  })
}

// === Modify common =========================================================

export function describeModifyCommon(spec: PnpmFamilySpec): void {
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

    it(`setNode patch SURVIVES on emit via overrides block (ADR-0014 §4.F2)`, () => {
      const original = parseFixtureGraph(spec, 'simple')
      const patch = 'a'.repeat(128)
      const current = original.getNode('ms@2.1.3')!
      const result = original.mutate(m => {
        m.replaceNode('ms@2.1.3', { ...current, patch })
        m.setTarball({ name: 'ms', version: '2.1.3', patch }, { integrity: mkIntegrity('sha512-patched-ms-integrity') })
        m.removeTarball({ name: 'ms', version: '2.1.3' })
      })
      const { lockfile, diagnostics } = stringifyWithDiagnostics(spec, result.graph)

      // pnpm v6/v9 SUPPORT patches via overrides; no drop diagnostic should fire.
      expect(diagnostics.filter(d => d.code === `${diagPrefix}_PATCH_DROPPED`)).toHaveLength(0)
      expect(diagnostics.filter(d => d.code === 'RECIPE_FEATURE_DROPPED' && d.subject === 'ms@2.1.3')).toHaveLength(0)
      expect(lockfile).toContain('overrides:')
      expect(lockfile).toContain('patch:')
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
      // pnpm v6/v9 SUPPORT patches: zero drops; the patch lands in overrides.
      expect(diagnostics.filter(d => d.code === `${diagPrefix}_PATCH_DROPPED`)).toHaveLength(0)
      expect(diagnostics.filter(d => d.code === 'RECIPE_FEATURE_DROPPED')).toHaveLength(0)
    })
  })
}

// === Enrich common ==========================================================

export function describeEnrichCommon(spec: PnpmFamilySpec): void {
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

// === Optimize common ========================================================

export function describeOptimizeCommon(spec: PnpmFamilySpec): void {
  const { label } = spec
  describe(`${label} — optimize (§D prune unreachable)`, () => {
    it('preserves reachable graph as no-op on each fixture', () => {
      for (const name of FIXTURES) {
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

// === Canonical NodeId form roundtrip ========================================

export function describeCanonicalNodeIdRoundtrip(spec: PnpmFamilySpec): void {
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
  })
}

// Registers every shared describe block for a pnpm-family adapter.
// Per-version delta tests stay in the calling test file.
export function registerPnpmFlatSuite(spec: PnpmFamilySpec): void {
  describeDiscriminantAndIsolation(spec)
  describeParseFixturesCommon(spec)
  describeStringifyCommon(spec)
  describeModifyCommon(spec)
  describeEnrichCommon(spec)
  describeOptimizeCommon(spec)
  describeCanonicalNodeIdRoundtrip(spec)
}
