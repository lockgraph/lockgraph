// _npm-flat-suite.ts — shared describe-block registration for npm-2 + npm-3.
//
// Both adapters share the npm-flat-family contract (per ADR-0021 §A).
// The standard suite below covers every contract that is identical
// across the two versions; per-version delta tests stay in the
// individual `npm-{2,3}.test.ts` files (dual-mirror + drift for npm-2,
// unexpected-mirror + resolution-undefined for npm-3).
//
// Genuine utilities (fixture IO, FlatFamilySpec, graphSnapshot, etc.)
// live in `_npm-flat-test-utils.ts` so they can be imported without
// pulling in the describe/it registrations defined here.

import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { type Graph } from '../../main/ts/graph.ts'
import { LockfileError } from '../../main/ts/errors.ts'
import { parse as parseClassic } from '../../main/ts/formats/yarn-classic.ts'
import { parse as parseV9 } from '../../main/ts/formats/yarn-berry-v9.ts'

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
  type FlatFamilySpec,
} from './_npm-flat-test-utils.ts'

// === Shared test suites ====================================================

export function describeDiscriminantAndIsolation(spec: FlatFamilySpec): void {
  const { label, lockfileVersion, adapter } = spec
  const otherVersion = lockfileVersion === 2 ? 1 : 2

  describe(`${label} — discriminant and isolation (§A cross-version)`, () => {
    it(`accepts an ${label} header and rejects npm-1 / yarn-* inputs`, () => {
      const own = fixture(`simple/${spec.fixtureSuffix}`)
      const v1 = fixture('simple/npm-1.lock')
      const yarnClassic = fixture('simple/yarn-classic.lock')
      const yarnBerry = fixture('simple/yarn-berry-v9.lock')

      expect(adapter.check(own)).toBe(true)
      expect(adapter.check(v1)).toBe(false)
      expect(adapter.check(yarnClassic)).toBe(false)
      expect(adapter.check(yarnBerry)).toBe(false)
    })

    it('parse rejects lockfileVersion 1 with FORMAT_MISMATCH', () => {
      const v1 = fixture('simple/npm-1.lock')
      expect(() => adapter.parse(v1)).toThrow(LockfileError)
      try { adapter.parse(v1) } catch (error) {
        expect((error as LockfileError).code).toBe('FORMAT_MISMATCH')
        expect((error as LockfileError).message).toContain(`lockfileVersion ${lockfileVersion}`)
      }
    })

    it(`parse rejects lockfileVersion ${otherVersion === 1 ? 3 : otherVersion} with FORMAT_MISMATCH`, () => {
      // Each flat-family version rejects the other one's fixture. npm-2 rejects npm-3 (no top-level dependencies → layout fail before version check),
      // npm-3 rejects npm-2 (version mismatch surfaces first).
      const other = lockfileVersion === 2 ? fixture('simple/npm-3.lock') : fixture('simple/npm-2.lock')
      expect(() => adapter.parse(other)).toThrow(LockfileError)
      try { adapter.parse(other) } catch (error) {
        expect((error as LockfileError).code).toBe('FORMAT_MISMATCH')
      }
    })

    it('parse rejects yarn-classic input with FORMAT_MISMATCH (non-JSON)', () => {
      const yarnClassic = fixture('simple/yarn-classic.lock')
      expect(() => adapter.parse(yarnClassic)).toThrow(LockfileError)
      try { adapter.parse(yarnClassic) } catch (error) {
        expect((error as LockfileError).code).toBe('FORMAT_MISMATCH')
      }
    })

    it('parse rejects yarn-berry-v9 input with FORMAT_MISMATCH (non-JSON)', () => {
      const yarnBerry = fixture('simple/yarn-berry-v9.lock')
      expect(() => adapter.parse(yarnBerry)).toThrow(LockfileError)
      try { adapter.parse(yarnBerry) } catch (error) {
        expect((error as LockfileError).code).toBe('FORMAT_MISMATCH')
      }
    })

    it(`cross-adapter probe: yarn-classic / yarn-berry-v9${spec.crossAdapterRejectExtra ? ' / cross-version' : ''} parsers reject ${label} input`, () => {
      const own = fixture(`simple/${spec.fixtureSuffix}`)
      expect(() => parseClassic(own)).toThrow()
      expect(() => parseV9(own)).toThrow()
      for (const rejector of spec.crossAdapterRejectExtra ?? []) {
        expect(() => rejector(own)).toThrow()
      }
    })
  })
}

export function describeParseFixturesCommon(spec: FlatFamilySpec): void {
  const { label } = spec
  describe(`${label} — parse fixtures (shared)`, () => {
    it.each(FIXTURES)('parses %s fixture', (fixtureName) => {
      const graph = parseFixtureGraph(spec, fixtureName)
      expect(Array.from(graph.nodes())).not.toHaveLength(0)
    })

    it('parses the root node with workspacePath = ""', () => {
      const graph = parseFixtureGraph(spec, 'simple')
      const root = graph.getNode('case-simple@0.0.0')
      expect(root).toBeDefined()
      expect(root?.workspacePath).toBe('')
    })

    it('parses node_modules entries into (name, version) graph nodes with tarball payload', () => {
      const graph = parseFixtureGraph(spec, 'simple')
      const ms = graph.getNode('ms@2.1.3')
      expect(ms).toBeDefined()
      expect(ms?.peerContext).toEqual([])
      const tarball = graph.tarballOf('ms@2.1.3')
      expect(tarball?.integrity).toBe('sha512-6FlzubTLZG3J2a/NVCAleEhjzq5oxgHyaCU9yYXvcLsvoVaHJq/s5xXI6/XXP6tz7R9xAOtHnSO/tXtF3WRTlA==')
    })

    it('parses root dependencies into dep edges from the root node', () => {
      const graph = parseFixtureGraph(spec, 'simple')
      const out = graph.out('case-simple@0.0.0')
      const depEdges = out.filter(edge => edge.kind === 'dep').map(edge => edge.dst).sort()
      expect(depEdges).toEqual(['lodash@4.17.21', 'ms@2.1.3'])
    })

    it('does not derive peer edges in phase A (peerDependencies stay in sidecar)', () => {
      const graph = parseFixtureGraph(spec, 'peers-basic')
      expect(graph.out('react-dom@18.2.0', 'peer')).toEqual([])
      const emitted = spec.adapter.stringify(graph)
      const parsed = JSON.parse(emitted)
      expect(parsed.packages['node_modules/react-dom']?.peerDependencies).toEqual({
        react: '^18.2.0',
      })
    })

    it('parses workspace entries with workspacePath set + symlink resolution', () => {
      const graph = parseFixtureGraph(spec, 'workspaces-basic')
      const memberA = graph.getNode('@case-ws/a@0.0.0')
      const memberB = graph.getNode('@case-ws/b@0.0.0')
      expect(memberA?.workspacePath).toBe('packages/a')
      expect(memberB?.workspacePath).toBe('packages/b')
      const memberAOut = graph.out('@case-ws/a@0.0.0', 'dep')
      expect(memberAOut.map(e => e.dst)).toEqual(['ms@2.1.3'])
    })

    it('parses de-hoisted nested entries by collapsing onto the canonical NodeId', () => {
      const graph = parseFixtureGraph(spec, 'peers-multi')
      expect(graph.getNode('react@17.0.2')).toBeDefined()
      expect(graph.getNode('react@18.2.0')).toBeDefined()
      expect(graph.getNode('react-dom@17.0.2')).toBeDefined()
      expect(graph.getNode('react-dom@18.2.0')).toBeDefined()
    })

    it('records integrity SRI for tarball entries', () => {
      const graph = parseFixtureGraph(spec, 'deps-with-scopes')
      const t = graph.tarballOf('@sindresorhus/is@6.3.1')
      expect(t?.integrity).toMatch(/^sha512-/)
    })
  })
}

export function describeStringifyCommon(spec: FlatFamilySpec): void {
  const { label, lockfileVersion } = spec
  describe(`${label} — stringify (§A.4 Graph-level roundtrip, shared)`, () => {
    // §A.4 predicate per ADR-0016 §A.4: parse(stringify(parse(x))).diff(parse(x))
    // is structurally empty + tarballs() iteration-equal.
    it.each(FIXTURES.filter(name => name !== 'yarn-crlf'))('roundtrips %s at Graph level', (fixtureName) => {
      const original = parseFixtureGraph(spec, fixtureName)
      const emitted = spec.adapter.stringify(original)
      const reparsed = spec.adapter.parse(emitted)

      expect(graphSnapshot(reparsed)).toEqual(graphSnapshot(original))
      expectEmptyGraphDiff(original.diff(reparsed))
      expect(Array.from(reparsed.tarballs())).toEqual(Array.from(original.tarballs()))
    })

    it(`emits well-formed JSON with lockfileVersion: ${lockfileVersion}`, () => {
      const graph = parseFixtureGraph(spec, 'simple')
      const text = spec.adapter.stringify(graph)
      expect(() => JSON.parse(text)).not.toThrow()
      const parsed = JSON.parse(text)
      expect(parsed.lockfileVersion).toBe(lockfileVersion)
      expect(parsed.packages).toBeDefined()
      expect(typeof parsed.packages).toBe('object')
    })

    it('emits canonical 2-space indent + trailing newline', () => {
      const graph = parseFixtureGraph(spec, 'simple')
      const text = spec.adapter.stringify(graph)
      expect(text.endsWith('\n')).toBe(true)
      expect(text).toContain('\n  "name":')
      expect(text).toContain('\n    "":')
    })

    it('emits packages map sorted alphabetically', () => {
      const graph = parseFixtureGraph(spec, 'simple')
      const text = spec.adapter.stringify(graph)
      const obj = JSON.parse(text)
      const keys = Object.keys(obj.packages)
      expect(keys).toEqual([...keys].sort())
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

    it('preserves bundleDependencies on the root entry across roundtrip', () => {
      const original = parseFixtureGraph(spec, 'bundled-deps')
      const emitted = spec.adapter.stringify(original)
      const parsed = JSON.parse(emitted)
      expect(parsed.packages[''].bundleDependencies).toEqual(['ms'])
    })

    it('preserves workspaces array on the root entry across roundtrip', () => {
      const original = parseFixtureGraph(spec, 'workspaces-basic')
      const emitted = spec.adapter.stringify(original)
      const parsed = JSON.parse(emitted)
      expect(parsed.packages[''].workspaces).toEqual(['packages/*'])
    })

    it('preserves the workspace symlink shape (link: true + resolved: <wsPath>) on roundtrip', () => {
      const original = parseFixtureGraph(spec, 'workspaces-basic')
      const emitted = spec.adapter.stringify(original)
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
}

export function describeModifyCommon(spec: FlatFamilySpec): void {
  const { label, diagPrefix, adapter } = spec
  describe(`${label} — modify (§B Mutator surface, inherits ADR-0016 §B verbatim)`, () => {
    it('roundtrips addNode', () => {
      const original = parseFixtureGraph(spec, 'simple')
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
      const reparsed = adapter.parse(adapter.stringify(result.graph))

      expectEmptyGraphDiff(result.graph.diff(reparsed))
      expect(reparsed.getNode('debug@4.4.1')).toBeDefined()
      expect(result.applied).toEqual([
        { kind: 'node-added', subject: 'debug@4.4.1' },
        { kind: 'tarball-set', subject: 'debug@4.4.1' },
      ])
    })

    it('roundtrips addEdge dep', () => {
      const original = parseFixtureGraph(spec, 'simple')
      const result = original.mutate(m => {
        m.addEdge('lodash@4.17.21', 'ms@2.1.3', 'dep', { range: '2.1.3' })
      })
      const reparsed = adapter.parse(adapter.stringify(result.graph))

      expectEmptyGraphDiff(result.graph.diff(reparsed))
      expect(result.applied).toEqual([
        { kind: 'edge-added', subject: { src: 'lodash@4.17.21', dst: 'ms@2.1.3', kind: 'dep' } },
      ])
    })

    it('addEdge peer with range survives on disk under packages block', () => {
      const original = parseFixtureGraph(spec, 'simple')
      const result = original.mutate(m => {
        m.addNode({
          id: 'peer-consumer@1.0.0(ms@2.1.3)',
          name: 'peer-consumer',
          version: '1.0.0',
          peerContext: ['ms@2.1.3'],
        })
        m.addEdge('peer-consumer@1.0.0(ms@2.1.3)', 'ms@2.1.3', 'peer', { range: '^2.1.0' })
      })
      const { lockfile, diagnostics } = stringifyWithDiagnostics(spec, result.graph)

      expect(diagnostics.filter(d => d.code === `${diagPrefix}_PEER_VIRT_FLATTENED`)).toHaveLength(1)
      expect(diagnostics.filter(d => d.code.includes('PEER_DROPPED'))).toEqual([])

      const obj = JSON.parse(lockfile)
      expect(obj.packages['node_modules/peer-consumer']?.peerDependencies).toEqual({
        ms: '^2.1.0',
      })
    })

    it('roundtrips removeEdge', () => {
      const original = parseFixtureGraph(spec, 'simple')
      const result = original.mutate(m => {
        m.removeEdge('case-simple@0.0.0', 'ms@2.1.3', 'dep')
      })
      const reparsed = adapter.parse(adapter.stringify(result.graph))

      expectEmptyGraphDiff(result.graph.diff(reparsed))
      expect(result.applied).toEqual([
        { kind: 'edge-removed', subject: { src: 'case-simple@0.0.0', dst: 'ms@2.1.3', kind: 'dep' } },
      ])
    })

    it('roundtrips removeNode', () => {
      const original = parseFixtureGraph(spec, 'simple')
      const result = original.mutate(m => {
        m.removeEdge('case-simple@0.0.0', 'ms@2.1.3', 'dep')
        m.removeNode('ms@2.1.3')
        m.removeTarball({ name: 'ms', version: '2.1.3' })
      })
      const reparsed = adapter.parse(adapter.stringify(result.graph))

      expectEmptyGraphDiff(result.graph.diff(reparsed))
      expect(reparsed.getNode('ms@2.1.3')).toBeUndefined()
    })

    it('roundtrips setTarball', () => {
      const original = parseFixtureGraph(spec, 'simple')
      const result = original.mutate(m => {
        m.setTarball({ name: 'ms', version: '2.1.3' }, { integrity: MODIFIED_SRI })
      })
      const reparsed = adapter.parse(adapter.stringify(result.graph))

      expectEmptyGraphDiff(result.graph.diff(reparsed))
      expect(reparsed.tarballOf('ms@2.1.3')).toEqual({ integrity: MODIFIED_SRI })
      expect(result.applied).toEqual([
        { kind: 'tarball-set', subject: 'ms@2.1.3' },
      ])
    })

    it('roundtrips replaceNode (version bump, same name)', () => {
      const original = parseFixtureGraph(spec, 'simple')
      const current = original.getNode('ms@2.1.3')!
      const result = original.mutate(m => {
        m.removeEdge('case-simple@0.0.0', 'ms@2.1.3', 'dep')
        m.replaceNode('ms@2.1.3', {
          ...current,
          id: 'ms@2.1.4',
          version: '2.1.4',
        })
        m.setTarball({ name: 'ms', version: '2.1.4' }, { integrity: BUMPED_SRI })
        m.removeTarball({ name: 'ms', version: '2.1.3' })
        m.addEdge('case-simple@0.0.0', 'ms@2.1.4', 'dep', { range: '2.1.4' })
      })
      const reparsed = adapter.parse(adapter.stringify(result.graph))

      expect(reparsed.getNode('ms@2.1.3')).toBeUndefined()
      expect(reparsed.getNode('ms@2.1.4')).toBeDefined()
      expectEmptyGraphDiff(result.graph.diff(reparsed))
    })

    it(`replacePeerContext (non-empty) flattens on emit with ${diagPrefix}_PEER_VIRT_FLATTENED`, () => {
      const original = parseFixtureGraph(spec, 'peers-basic')
      const result = original.mutate(m => {
        m.replacePeerContext('react-dom@18.2.0', ['react@18.2.0'])
      })
      const { lockfile, diagnostics } = stringifyWithDiagnostics(spec, result.graph)
      const reparsed = adapter.parse(lockfile)

      expect(reparsed.getNode('react-dom@18.2.0(react@18.2.0)')).toBeUndefined()
      expect(reparsed.getNode('react-dom@18.2.0')).toBeDefined()
      // mutate() drops the parse-captured install-path sidecar, so this emit
      // re-synthesises the npm layout → LAYOUT_PLACEMENT_RESYNTHESISED (info,
      // ADR-0026) fires alongside the peer-flatten warning. Target the peer
      // diagnostic by code rather than assuming list shape/position.
      const peerFlattened = diagnostics.filter(
        d => d.code === `${diagPrefix}_PEER_VIRT_FLATTENED`,
      )
      expect(peerFlattened).toHaveLength(1)
      expect(peerFlattened[0]).toEqual(
        expect.objectContaining({
          code: `${diagPrefix}_PEER_VIRT_FLATTENED`,
          severity: 'warning',
          subject: 'react-dom@18.2.0(react@18.2.0)',
        }),
      )
      expect(peerFlattened[0]?.message).toContain('["react@18.2.0"]')
      expect(diagnostics.map(d => d.code)).toContain('LAYOUT_PLACEMENT_RESYNTHESISED')
    })

    it(`setNode patch drops on emit with RECIPE_FEATURE_DROPPED`, () => {
      const original = parseFixtureGraph(spec, 'simple')
      const patch = 'a'.repeat(128)
      const current = original.getNode('ms@2.1.3')!

      const result = original.mutate(m => {
        m.replaceNode('ms@2.1.3', { ...current, patch })
        m.setTarball({ name: 'ms', version: '2.1.3', patch }, { integrity: 'sha512-patched-ms-integrity' })
        m.removeTarball({ name: 'ms', version: '2.1.3' })
      })
      const { lockfile, diagnostics } = stringifyWithDiagnostics(spec, result.graph)
      const reparsed = adapter.parse(lockfile)

      expect(reparsed.getNode('ms@2.1.3')?.patch).toBeUndefined()
      expect(diagnostics.filter(d => d.code === 'RECIPE_FEATURE_DROPPED' && d.subject === 'ms@2.1.3')).toEqual([
        expect.objectContaining({
          code: 'RECIPE_FEATURE_DROPPED',
          severity: 'warning',
          subject: 'ms@2.1.3',
        }),
      ])
    })

    it('emits each lossy diagnostic at most once per affected node', () => {
      const original = parseFixtureGraph(spec, 'peers-basic')
      const patch = 'b'.repeat(128)
      const reactDom = original.getNode('react-dom@18.2.0')!
      const result = original.mutate(m => {
        m.replaceNode('react-dom@18.2.0', { ...reactDom, patch })
        m.setTarball({ name: 'react-dom', version: '18.2.0', patch }, { integrity: 'sha512-x' })
        m.removeTarball({ name: 'react-dom', version: '18.2.0' })
        m.replacePeerContext('react-dom@18.2.0', ['react@18.2.0'])
      })
      const { diagnostics } = stringifyWithDiagnostics(spec, result.graph)

      const peerVirt = diagnostics.filter(d => d.code === `${diagPrefix}_PEER_VIRT_FLATTENED`)
      const patchDrop = diagnostics.filter(d => d.code === 'RECIPE_FEATURE_DROPPED' && d.subject === 'react-dom@18.2.0(react@18.2.0)')
      expect(peerVirt).toHaveLength(1)
      expect(patchDrop).toHaveLength(1)
    })
  })
}

export function describeEnrichCommon(spec: FlatFamilySpec): void {
  const { label, lockfileVersion, diagPrefix, adapter } = spec
  describe(`${label} — enrich (§C, ADR-0021 §C.npm-${lockfileVersion})`, () => {
    it('peer-virt structurally absent: peerDependencies stay in sidecar; no graph peer edges', () => {
      const graph = parseFixtureGraph(spec, 'peers-basic')
      expect(graph.out('react-dom@18.2.0', 'peer')).toEqual([])
      const result = adapter.enrich(graph)

      expect(result.diagnostics).toEqual([])
      expect(result.graph.out('react-dom@18.2.0', 'peer')).toEqual([])
      expect(result.graph.getNode('react-dom@18.2.0')?.peerContext).toEqual([])
      expect(result.graph.getNode('react-dom@18.2.0(react@18.2.0)')).toBeUndefined()
      const emitted = adapter.stringify(result.graph)
      const reparsed = JSON.parse(emitted)
      expect(reparsed.packages['node_modules/react-dom']?.peerDependencies).toEqual({
        react: '^18.2.0',
      })
    })

    it(`emits ${diagPrefix}_PEER_UNSATISFIED when no candidate matches the range`, () => {
      const synthetic = buildSyntheticForPeerCheck(spec, {
        peerRange: '^99.99.0',
        installedReactVersion: '18.2.0',
      })
      const graph = adapter.parse(JSON.stringify(synthetic, null, 2))
      const result = adapter.enrich(graph)

      expect(result.diagnostics.map(d => d.code)).toEqual([`${diagPrefix}_PEER_UNSATISFIED`])
      expect(result.diagnostics[0]).toEqual(
        expect.objectContaining({
          code: `${diagPrefix}_PEER_UNSATISFIED`,
          severity: 'warning',
          subject: 'pkg-a@1.0.0',
        }),
      )
      expect(result.graph.out('pkg-a@1.0.0', 'peer')).toEqual([])
    })

    it(`emits ${diagPrefix}_PEER_AMBIGUOUS when multiple candidates satisfy the range`, () => {
      const synthetic = buildSyntheticForPeerCheck(spec, {
        peerRange: '*',
        installedReactVersion: '17.0.2',
        nestedReactVersion: '18.2.0',
      })
      const graph = adapter.parse(JSON.stringify(synthetic, null, 2))
      const result = adapter.enrich(graph)

      expect(result.diagnostics.map(d => d.code)).toEqual([`${diagPrefix}_PEER_AMBIGUOUS`])
      expect(result.diagnostics[0]).toEqual(
        expect.objectContaining({
          code: `${diagPrefix}_PEER_AMBIGUOUS`,
          severity: 'warning',
          subject: 'pkg-a@1.0.0',
        }),
      )
    })

    it('peer-virt structurally absent: never produces virtualised NodeIds on the npm side', () => {
      const graph = parseFixtureGraph(spec, 'peers-multi')
      const result = adapter.enrich(graph)

      for (const node of result.graph.nodes()) {
        expect(node.peerContext).toEqual([])
        expect(node.id).not.toMatch(/\(.+\)$/)
      }
      expect(result.diagnostics.filter(d => d.code.includes('PEER_VIRT'))).toEqual([])
    })

    it('marks edges to workspace members with attrs.workspace = true', () => {
      const base = parseFixtureGraph(spec, 'workspaces-basic')
      const graph = base.mutate(m => {
        m.addEdge('case-workspaces-basic@0.0.0', '@case-ws/a@0.0.0', 'dep', { range: '*' })
      }).graph
      const result = adapter.enrich(graph)

      const wsEdge = result.graph.out('case-workspaces-basic@0.0.0', 'dep')
        .find(e => e.dst === '@case-ws/a@0.0.0')
      expect(wsEdge?.attrs?.workspace).toBe(true)

      const memberToMs = result.graph.out('@case-ws/a@0.0.0', 'dep')
        .find(e => e.dst === 'ms@2.1.3')
      expect(memberToMs?.attrs?.workspace).toBeUndefined()
    })

    it('preserves workspace member tagging from parse (parser sets workspacePath, enrich no-ops)', () => {
      const graph = parseFixtureGraph(spec, 'workspaces-basic')
      const result = adapter.enrich(graph)

      expect(result.graph.getNode('case-workspaces-basic@0.0.0')?.workspacePath).toBe('')
      expect(result.graph.getNode('@case-ws/a@0.0.0')?.workspacePath).toBe('packages/a')
      expect(result.graph.getNode('@case-ws/b@0.0.0')?.workspacePath).toBe('packages/b')
      expect(result.graph.getNode('ms@2.1.3')?.workspacePath).toBeUndefined()
    })

    it(`does NOT emit ${diagPrefix}_NO_MANIFESTS (lockfile embeds manifests natively per ADR-0021 §C.npm-${lockfileVersion})`, () => {
      const graph = parseFixtureGraph(spec, 'workspaces-basic')
      const result = adapter.enrich(graph)
      expect(result.diagnostics.map(d => d.code)).not.toContain(`${diagPrefix}_NO_MANIFESTS`)
    })

    it('is idempotent — enrich(enrich(graph)) ≡ enrich(graph)', () => {
      const graph = parseFixtureGraph(spec, 'peers-basic')
      const once = adapter.enrich(graph)
      const twice = adapter.enrich(once.graph)

      expect(graphSnapshot(twice.graph)).toEqual(graphSnapshot(once.graph))
      expect(twice.diagnostics).toEqual([])
    })

    it('idempotent on a graph with both peer edges and workspace marks', () => {
      const base = parseFixtureGraph(spec, 'workspaces-basic')
      const graph = base.mutate(m => {
        m.addEdge('case-workspaces-basic@0.0.0', '@case-ws/a@0.0.0', 'dep', { range: '*' })
      }).graph
      const once = adapter.enrich(graph)
      const twice = adapter.enrich(once.graph)
      expect(graphSnapshot(twice.graph)).toEqual(graphSnapshot(once.graph))
      expect(twice.diagnostics).toEqual(once.diagnostics)
    })
  })
}

interface SyntheticPeerOptions {
  peerRange: string
  installedReactVersion: string
  nestedReactVersion?: string
}

function buildSyntheticForPeerCheck(spec: FlatFamilySpec, opts: SyntheticPeerOptions): unknown {
  const { lockfileVersion } = spec
  const packages: Record<string, unknown> = {
    '': { name: 'case-x', version: '0.0.0', dependencies: { 'pkg-a': '1.0.0' } },
    'node_modules/pkg-a': {
      version: '1.0.0',
      resolved: 'https://registry.npmjs.org/pkg-a/-/pkg-a-1.0.0.tgz',
      integrity: 'sha512-aaa',
      peerDependencies: { 'react': opts.peerRange },
    },
    'node_modules/react': {
      version: opts.installedReactVersion,
      resolved: `https://registry.npmjs.org/react/-/react-${opts.installedReactVersion}.tgz`,
      integrity: 'sha512-react',
    },
  }
  if (opts.nestedReactVersion !== undefined) {
    packages['node_modules/pkg-a/node_modules/react'] = {
      version: opts.nestedReactVersion,
      resolved: `https://registry.npmjs.org/react/-/react-${opts.nestedReactVersion}.tgz`,
      integrity: 'sha512-r18',
    }
  }
  const out: Record<string, unknown> = {
    name: 'case-x',
    version: '0.0.0',
    lockfileVersion,
    requires: true,
    packages,
  }
  if (spec.diagPrefix === 'NPM_V2') {
    // npm-2 dual-mode: synthesise a matching legacy mirror.
    out.dependencies = {
      'pkg-a': {
        version: '1.0.0',
        resolved: 'https://registry.npmjs.org/pkg-a/-/pkg-a-1.0.0.tgz',
        integrity: 'sha512-aaa',
      },
      'react': {
        version: opts.installedReactVersion,
        resolved: `https://registry.npmjs.org/react/-/react-${opts.installedReactVersion}.tgz`,
        integrity: 'sha512-react',
      },
    }
  }
  return out
}

export function describeOptimizeCommon(spec: FlatFamilySpec): void {
  const { label, lockfileVersion, adapter } = spec

  function graphWithOrphan(): Graph {
    const base = parseFixtureGraph(spec, 'simple')
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
    const base = parseFixtureGraph(spec, 'simple')
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

  describe(`${label} — optimize (§D, ADR-0021 §D.npm-${lockfileVersion} — prune unreachable)`, () => {
    it('prunes an unreachable self-loop orphan and its tarball', () => {
      const graph = graphWithOrphan()
      const result = adapter.optimize(graph)

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
      const result = adapter.optimize(graph)

      expect(result.graph.getNode('cycle-a@1.0.0')).toBeUndefined()
      expect(result.graph.getNode('cycle-b@1.0.0')).toBeUndefined()
      expect(result.graph.tarball({ name: 'cycle-a', version: '1.0.0' })).toBeUndefined()
      expect(result.graph.tarball({ name: 'cycle-b', version: '1.0.0' })).toBeUndefined()
    })

    it('is idempotent — optimize(optimize(graph)) ≡ optimize(graph)', () => {
      const once = adapter.optimize(graphWithOrphan())
      const twice = adapter.optimize(once.graph)
      expect(graphSnapshot(twice.graph)).toEqual(graphSnapshot(once.graph))
      expect(twice.diagnostics).toEqual(once.diagnostics)
    })

    it('preserves every reachable node and tarball on fixture graphs', () => {
      const graph = parseFixtureGraph(spec, 'peers-basic')
      const result = adapter.optimize(graph)
      expect(graphSnapshot(result.graph)).toEqual(graphSnapshot(graph))
      expect(Array.from(result.graph.tarballs(), ([k]) => k)).toEqual(
        Array.from(graph.tarballs(), ([k]) => k),
      )
    })

    it('survives stringify/parse roundtrip composition with re-enrich (§A.4 + §C/§D composition)', () => {
      const base = parseFixtureGraph(spec, 'peers-basic')
      const enriched = adapter.enrich(base)
      const optimized = adapter.optimize(enriched.graph)
      const reparsed = adapter.enrich(adapter.parse(adapter.stringify(optimized.graph)))

      expect(graphSnapshot(reparsed.graph)).toEqual(graphSnapshot(optimized.graph))
      expectEmptyGraphDiff(optimized.graph.diff(reparsed.graph))
    })
  })
}

// Registers every shared describe block for an npm-flat-family adapter.
// Per-version delta tests stay in the calling test file.
export function registerFlatFamilySuite(spec: FlatFamilySpec): void {
  describeDiscriminantAndIsolation(spec)
  describeParseFixturesCommon(spec)
  describeStringifyCommon(spec)
  describeModifyCommon(spec)
  describeEnrichCommon(spec)
  describeOptimizeCommon(spec)
}
