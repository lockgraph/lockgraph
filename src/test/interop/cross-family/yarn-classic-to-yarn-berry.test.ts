import { describe, expect, it } from 'vitest'
import { assertConversionContract } from '../_assert.ts'
import { convert, parseFormat, stringifyFormat } from '../_dispatch.ts'
import { CLASSIC_SHARED_FIXTURES, fixtureLockfile } from '../_fixtures.ts'
import { CONTRACTS, type ConversionContract } from '../_matrix.ts'
import { enrichClassicGraph, normalizeGraphForBerry } from '../_normalize.ts'
import { activeContract } from '../_observe.ts'
import { workspaceFixtureGraph } from '../_synth.ts'
import type { FormatId } from '../_types.ts'

const BERRY_TARGETS: Array<Extract<FormatId, `yarn-berry-${string}`>> = [
  'yarn-berry-v4',
  'yarn-berry-v5',
  'yarn-berry-v6',
  'yarn-berry-v8',
  'yarn-berry-v9',
]

const CONTRACTS_FROM_CLASSIC = CONTRACTS.filter(contract =>
  contract.from === 'yarn-classic' && contract.to.startsWith('yarn-berry-')
) as ConversionContract[]

describe('interop: yarn-classic -> yarn-berry (naive)', () => {
  for (const contract of CONTRACTS_FROM_CLASSIC) {
    describe(`${contract.from} -> ${contract.to}`, () => {
      it.each(CLASSIC_SHARED_FIXTURES)('%s fixture satisfies the naive contract', fixtureName => {
        const sourceLockfile = fixtureLockfile(fixtureName, 'yarn-classic')
        const result = convert({
          from: 'yarn-classic',
          to: contract.to,
          source: sourceLockfile,
          mode: 'naive',
        })
        const observedContract = activeContract(contract, {
          sourceGraph: result.sourceGraph,
          destinationGraph: result.destinationGraph,
          sourceLockfile,
          destinationLockfile: result.lockfile,
          mode: 'naive',
          manifestsProvided: false,
        })

        assertConversionContract(observedContract, {
          graphSource: result.sourceGraph,
          graphDestination: result.destinationGraph,
          diagnostics: result.diagnostics,
          mode: 'naive',
          fixture: fixtureName,
        })
      })
    })
  }
})

// Per ADR-0019 §C: when manifests are supplied, yarn-classic enrich synthesises
// the root workspace node, classifies dep/dev/optional edges out of the root,
// and tags workspace-protocol edges. The cross-family loop verifies that this
// classification survives across the classic -> berry-v{4,5,6,8,9} stringify
// boundary in all five destination versions.
//
// This is NOT routed through `assertConversionContract` because the §C contract
// declares a documented one-way collapse — `dev` edges fold into `dep` on emit
// (yarn-berry has no devDependencies block on disk per §C's source-of-truth
// table) — that the matrix's `edge-kinds` preservation predicate does not
// model. The §C invariants asserted here are the §C contract directly: edge
// presence + workspace-member resolution survives, edge kind is allowed to
// collapse from `dev` to `dep`.
describe('interop: yarn-classic -> yarn-berry (enrich-aware)', () => {
  for (const target of BERRY_TARGETS) {
    describe(`yarn-classic -> ${target}`, () => {
      it('workspaces-basic synthetic graph preserves manifest-derived dev/workspace edge classification', () => {
        // The on-disk yarn-classic fixture omits workspace-member entries
        // (yarn 1.x does not write them); _synth.ts:workspaceFixtureGraph
        // re-injects them so the §C enrich path has something to mark. Order:
        // enrich first (adds manifest-derived edges with bare ranges), then
        // normalize-for-berry (npm-prefixes the bare ranges).
        const enriched = enrichClassicGraph(workspaceFixtureGraph(), 'enrich-aware')
        const sourceGraph = normalizeGraphForBerry(enriched.graph)
        const emitted = stringifyFormat(target, sourceGraph)
        const destinationGraph = parseFormat(target, emitted.lockfile)

        // §C item (1): root workspace node survives.
        expect(destinationGraph.getNode('case-workspaces-basic@0.0.0')?.workspacePath).toBe('')

        // §C item (b): workspace member nodes carry workspacePath in the
        // destination graph, so downstream callers can apply attrs.workspace
        // markers via berry enrich.
        expect(destinationGraph.getNode('@case-ws/a@0.0.0-use.local')?.workspacePath).toBe('packages/a')
        expect(destinationGraph.getNode('@case-ws/b@0.0.0-use.local')?.workspacePath).toBe('packages/b')

        // §C item (2): all three classified edges (dep/dev/optional) reach the
        // destination graph; the dev edge collapses to `dep` per §C's
        // source-of-truth table (yarn-berry has no devDependencies block).
        const rootEdges = destinationGraph.out('case-workspaces-basic@0.0.0').map(edge => ({
          dst: edge.dst,
          kind: edge.kind,
          range: edge.attrs?.range,
        })).sort((a, b) => a.dst.localeCompare(b.dst))
        expect(rootEdges).toContainEqual({
          dst: '@case-ws/a@0.0.0-use.local',
          kind: 'dep',
          range: 'workspace:*',
        })
        expect(rootEdges).toContainEqual({
          dst: '@case-ws/b@0.0.0-use.local',
          kind: 'dep',
          range: 'workspace:^',
        })
        expect(rootEdges).toContainEqual({
          dst: 'ms@2.1.3',
          kind: 'optional',
          range: 'npm:2.1.3',
        })
      })
    })
  }
})
