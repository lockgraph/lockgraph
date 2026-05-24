import { describe, expect, it } from 'vitest'
import { enrich as enrichBerryV9 } from '../../../main/ts/formats/yarn-berry-v9.ts'
import { parseFormat, stringifyFormat } from '../_dispatch.ts'
import { enrichClassicGraph, normalizeGraphForBerry } from '../_normalize.ts'
import { workspaceFixtureGraph } from '../_synth.ts'

describe('interop adversarial §8.3 — workspace-edge classification', () => {
  it('classic -> berry-v9 stays flat without manifests', () => {
    const enriched = enrichClassicGraph(workspaceFixtureGraph(), 'naive')
    const emitted = stringifyFormat('yarn-berry-v9', normalizeGraphForBerry(enriched.graph))
    const destinationGraph = parseFormat('yarn-berry-v9', emitted.lockfile)
    const root = destinationGraph.getNode('case-workspaces-basic@0.0.0')

    expect(enriched.diagnostics.map(diagnostic => diagnostic.code)).toContain('YARN_CLASSIC_NO_MANIFESTS')
    expect(root).toBeUndefined()
    expect(Array.from(destinationGraph.nodes()).some(node => node.workspacePath !== undefined)).toBe(false)
  })

  // Per ADR-0019 §C: yarn-classic enrich (with manifests) synthesises the root
  // workspace node, classifies dep/dev/optional from the manifest fields, and
  // marks workspace-protocol edges. Across the classic -> berry-v9 emit/parse
  // boundary, the dev classification collapses into `dep` (yarn-berry's on-disk
  // format has no separate devDependencies block per §C's source-of-truth
  // table), but the edge itself MUST survive — without merging dev into the
  // dependencies block on emit, the @case-ws/b workspace member becomes
  // unreachable from the root.
  it('classic -> berry-v9 preserves the root workspace node, all classified edges, and workspace markers when manifests are supplied', () => {
    const enriched = enrichClassicGraph(workspaceFixtureGraph(), 'enrich-aware')
    const emitted = stringifyFormat('yarn-berry-v9', normalizeGraphForBerry(enriched.graph))
    const destinationGraph = parseFormat('yarn-berry-v9', emitted.lockfile)

    expect(destinationGraph.getNode('case-workspaces-basic@0.0.0')?.workspacePath).toBe('')
    expect(destinationGraph.getNode('@case-ws/a@0.0.0-use.local')?.workspacePath).toBe('packages/a')
    expect(destinationGraph.getNode('@case-ws/b@0.0.0-use.local')?.workspacePath).toBe('packages/b')

    // After emit, the dev edge collapses to `dep` per §C (no devDependencies
    // block on yarn-berry); workspace markers survive parse via the F4
    // parse-side marking pass (ADR-0014 §4.F4 — populate `attrs.workspace`
    // + canonical `workspaceRange` whenever the range carries the
    // `workspace:` protocol AND the target carries `workspacePath`).
    expect(destinationGraph.out('case-workspaces-basic@0.0.0').map(edge => ({
      dst: edge.dst,
      kind: edge.kind,
      range: edge.attrs?.range,
      workspace: edge.attrs?.workspace,
    })).sort((a, b) => a.dst.localeCompare(b.dst))).toEqual([
      { dst: '@case-ws/a@0.0.0-use.local', kind: 'dep', range: 'workspace:*', workspace: true },
      { dst: '@case-ws/b@0.0.0-use.local', kind: 'dep', range: 'workspace:^', workspace: true },
      { dst: 'ms@2.1.3', kind: 'optional', range: 'npm:2.1.3', workspace: undefined },
    ])

    // Re-enrich is a no-op for workspace markers now (parse already set
    // them); the assertion preserves the post-enrich invariant.
    const reEnriched = enrichBerryV9(destinationGraph).graph
    expect(reEnriched.out('case-workspaces-basic@0.0.0').map(edge => ({
      dst: edge.dst,
      kind: edge.kind,
      range: edge.attrs?.range,
      workspace: edge.attrs?.workspace,
    })).sort((a, b) => a.dst.localeCompare(b.dst))).toEqual([
      { dst: '@case-ws/a@0.0.0-use.local', kind: 'dep', range: 'workspace:*', workspace: true },
      { dst: '@case-ws/b@0.0.0-use.local', kind: 'dep', range: 'workspace:^', workspace: true },
      { dst: 'ms@2.1.3', kind: 'optional', range: 'npm:2.1.3', workspace: undefined },
    ])
  })
})
