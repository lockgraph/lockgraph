// Graph-mutation pipelines that polish or upgrade an *existing* graph. Keep
// constructors / synthesis from minimal seed in `_synth.ts` so the two
// concerns stay separable: normalize = transform existing, synth = build new.

import type { Diagnostic, Graph } from '../../main/ts/graph.ts'
import { enrich as enrichClassic } from '../../main/ts/formats/yarn-classic.ts'
import { WORKSPACE_MANIFESTS } from './_fixtures.ts'

export function normalizeGraphForBerry(graph: Graph): Graph {
  return graph.mutate(m => {
    for (const node of graph.nodes()) {
      for (const edge of graph.out(node.id)) {
        const range = edge.attrs?.range
        if (range === undefined || range.includes(':') || range.startsWith('workspace:')) continue
        m.removeEdge(edge.src, edge.dst, edge.kind)
        m.addEdge(edge.src, edge.dst, edge.kind, { ...edge.attrs, range: `npm:${range}` })
      }
    }
  }).graph
}

export function enrichClassicGraph(
  graph: Graph,
  mode: 'naive' | 'enrich-aware',
): { graph: Graph; diagnostics: Diagnostic[] } {
  if (mode === 'naive') {
    return enrichClassic(graph)
  }
  return enrichClassic(graph, undefined, { manifests: WORKSPACE_MANIFESTS })
}
