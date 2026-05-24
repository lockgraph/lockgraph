import { newBuilder, type Graph } from '../../main/ts/graph.ts'

export function emptyGraph(): Graph {
  return newBuilder().seal()
}

export function graphSnapshot(graph: Graph) {
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
    // RECIPE_* diagnostics are emission-side observability events (ADR-0014 §5),
    // not graph identity — exclude them from cross-format snapshot equality
    // so source/destination graphs compare on structural state only.
    diagnostics: graph.diagnostics()
      .filter(diagnostic => !diagnostic.code.startsWith('RECIPE_'))
      .map(diagnostic => ({ ...diagnostic })),
  }
}
