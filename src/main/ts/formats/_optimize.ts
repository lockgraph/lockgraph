// Shared optimization helpers for format adapters.

import {
  toTarballKey,
  type Diagnostic,
  type Graph,
  type Node,
  type NodeId,
  type TarballKeyInputs,
} from '../graph.ts'

export interface UnreachableOptimizationOptions {
  readonly seeds: readonly NodeId[]
  readonly compare: (left: string, right: string) => number
  readonly edgeSeparator: string
  readonly tarballInputs: (node: Node) => TarballKeyInputs
  readonly skipMissingTarballs: boolean
}

/**
 * Shared adapter optimization invariant: prune nodes unreachable from the
 * adapter's roots, remove their internal edges in deterministic order, and
 * retire tarballs no surviving node references. Adapter-owned sidecars remain
 * outside this helper and are rebound by each caller after the graph mutation.
 */
export function optimizeUnreachable(
  graph: Graph,
  options: UnreachableOptimizationOptions,
): { graph: Graph; diagnostics: Diagnostic[] } {
  const reachable = new Set(graph.walk(Array.from(options.seeds)))
  const unreachableNodes = Array.from(graph.nodes(), node => node.id)
    .filter(nodeId => !reachable.has(nodeId))
    .sort(options.compare)

  if (unreachableNodes.length === 0) {
    return {
      graph,
      diagnostics: graph.diagnostics().filter(diagnostic => diagnostic.severity === 'warning'),
    }
  }

  const unreachable = new Set(unreachableNodes)
  const referencedTarballs = new Set<string>()
  const tarballsToRemove = new Map<string, TarballKeyInputs>()
  const internalEdges = unreachableNodes
    .flatMap(src =>
      graph.out(src)
        .filter(edge => unreachable.has(edge.dst))
        .map(edge => ({ src: edge.src, dst: edge.dst, kind: edge.kind })),
    )
    .sort((left, right) => options.compare(
      `${left.src}${options.edgeSeparator}${left.kind}${options.edgeSeparator}${left.dst}`,
      `${right.src}${options.edgeSeparator}${right.kind}${options.edgeSeparator}${right.dst}`,
    ))

  for (const node of graph.nodes()) {
    const inputs = options.tarballInputs(node)
    const key = toTarballKey(inputs)
    if (unreachable.has(node.id)) {
      tarballsToRemove.set(key, inputs)
      continue
    }
    referencedTarballs.add(key)
  }

  const result = graph.mutate(mutator => {
    for (const edge of internalEdges) {
      mutator.removeEdge(edge.src, edge.dst, edge.kind)
    }
    for (const nodeId of unreachableNodes) {
      mutator.removeNode(nodeId)
    }
    for (const [key, inputs] of Array.from(tarballsToRemove.entries()).sort((left, right) =>
      options.compare(left[0], right[0]))) {
      if (referencedTarballs.has(key)) continue
      if (options.skipMissingTarballs && graph.tarball(inputs) === undefined) continue
      mutator.removeTarball(inputs)
    }
  })

  return { graph: result.graph, diagnostics: result.unresolved }
}
