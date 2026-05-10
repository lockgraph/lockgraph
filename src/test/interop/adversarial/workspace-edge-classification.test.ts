import { describe, expect, it } from 'vitest'
import { enrichClassicGraph, normalizeGraphForBerry, parseFormat, stringifyFormat, workspaceFixtureGraph } from '../_runtime.ts'

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

  it('classic -> berry-v9 currently preserves the root workspace node and the dep/optional edges that survive conversion', () => {
    const enriched = enrichClassicGraph(workspaceFixtureGraph(), 'enrich-aware')
    const emitted = stringifyFormat('yarn-berry-v9', normalizeGraphForBerry(enriched.graph))
    const destinationGraph = parseFormat('yarn-berry-v9', emitted.lockfile)

    expect(destinationGraph.out('case-workspaces-basic@0.0.0').map(edge => ({
      dst: edge.dst,
      kind: edge.kind,
      range: edge.attrs?.range,
      workspace: edge.attrs?.workspace,
    })).sort((a, b) => a.dst.localeCompare(b.dst))).toEqual([
      { dst: '@case-ws/a@0.0.0-use.local', kind: 'dep', range: 'workspace:*', workspace: undefined },
      { dst: 'ms@2.1.3', kind: 'optional', range: 'npm:2.1.3', workspace: undefined },
    ])
  })

  it.todo(
    'classic -> berry-v9 should preserve the dev edge to @case-ws/b and attrs.workspace markers when manifests are supplied',
  )
})
