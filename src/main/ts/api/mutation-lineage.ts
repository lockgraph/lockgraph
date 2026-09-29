import type { Graph } from '../graph.ts'
import type { FormatId } from './format-contract.ts'

/**
 * Parse-time adapter state is graph-identity keyed (WeakMaps in the format
 * adapters). A bare Graph.mutate() returns a new graph identity, so remember
 * the parsed source across that boundary and let strict stringify verify that
 * the adapter state was explicitly rebound before it certifies an output.
 *
 * This is containment, not propagation: it deliberately records only enough
 * lineage to fail closed when a public mutation detached load-bearing native
 * state. Adapter enrich/optimize paths remain free to rebind their state.
 */
export interface AdapterMutationLineage {
  readonly sourceFormat: FormatId
  /** Effective project root used by parse-time out-of-lockfile reads. */
  readonly workspaceRoot?: string
  readonly adapterStateRequired: boolean
  readonly adapterStateSubjects: readonly string[]
  readonly mutated: boolean
}

const lineageByGraph = new WeakMap<Graph, AdapterMutationLineage>()

export function attachParsedMutationLineage(
  graph: Graph,
  sourceFormat: FormatId,
  workspaceRoot: string | undefined,
  adapterStateRequired: boolean,
  adapterStateSubjects: readonly string[] = [],
): void {
  lineageByGraph.set(graph, Object.freeze({
    sourceFormat,
    ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
    adapterStateRequired,
    adapterStateSubjects: Object.freeze([...adapterStateSubjects]),
    mutated: false,
  }))
}

/** Carry parsed-source lineage onto a newly-created graph and mark the public mutation. */
export function inheritMutationLineage(source: Graph, target: Graph): void {
  const lineage = lineageByGraph.get(source)
  if (lineage === undefined) return
  lineageByGraph.set(target, Object.freeze({ ...lineage, mutated: true }))
}

export function adapterMutationLineageOf(graph: Graph): AdapterMutationLineage | undefined {
  return lineageByGraph.get(graph)
}
