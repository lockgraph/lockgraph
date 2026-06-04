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
    // ADR-0031 — integrity is origin-scoped payload (a tarball SRI and a
    // yarn-berry zip digest are different artefacts), compared separately via
    // graphSubset's origin-aware `integrity` feature. It is NOT structural
    // identity, so exclude it here — a cross-origin-class conversion (e.g.
    // classic→berry) legitimately drops it while preserving graph identity.
    tarballs: Array.from(graph.tarballs(), ([key, payload]) => {
      const { integrity: _integrity, ...rest } = payload
      return [key, rest] as const
    }),
    // RECIPE_* diagnostics are emission-side observability events (ADR-0014 §5),
    // not graph identity — exclude them from cross-format snapshot equality
    // so source/destination graphs compare on structural state only.
    diagnostics: graph.diagnostics()
      .filter(diagnostic => !diagnostic.code.startsWith('RECIPE_'))
      .map(diagnostic => ({ ...diagnostic })),
  }
}
