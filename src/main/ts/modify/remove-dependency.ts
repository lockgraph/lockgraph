// ADR-0023 §3.2 — `removeDependency`.
//
// 1. `removeEdge(consumer, target, kind)`.
// 2. GC: if `target` now has zero incoming edges, recursively
//    `removeNode(target)` + repeat for its previous out-edges.
//    Workspace nodes are NEVER removed by GC.
//
// Note: per ADR-0023 §4 / B5, modifiers MAY leave orphans for the optimize
// phase to collect. removeDependency is the exception that performs its
// own GC — this is the §3.2 step 2 semantics, and the recursive sweep
// is bounded by the subgraph reachable from the removed edge's tail.

import type {
  Diagnostic,
  EdgeKind,
  Graph,
  NodeId,
} from '../graph.ts'
import { LockfileError } from '../errors.ts'
import { modifyNodeRemoved } from './diagnostics.ts'

export interface RemoveDependencyResult {
  graph:            Graph
  removed:          NodeId[]
  recentlyAdded:    Set<NodeId>
  recentlyOrphaned: Set<NodeId>
  unresolved:       Diagnostic[]
}

export interface RemoveDependencyOptions {
  /** Restrict removal to a specific edge kind. Defaults to all kinds matching `name`. */
  kind?:         EdgeKind
  onDiagnostic?: (d: Diagnostic) => void
}

export async function removeDependency(
  graph: Graph,
  parentId: NodeId,
  name: string,
  options: RemoveDependencyOptions = {},
): Promise<RemoveDependencyResult> {
  const onDiagnostic = options.onDiagnostic
  const unresolved: Diagnostic[] = []
  const emit = (d: Diagnostic): void => {
    unresolved.push(d)
    if (onDiagnostic !== undefined) onDiagnostic(d)
  }

  const parent = graph.getNode(parentId)
  if (parent === undefined) {
    throw new LockfileError({
      code:    'INVALID_INPUT',
      message: `removeDependency: parent ${parentId} not in graph`,
    })
  }

  // Enumerate matching edges: out-edges from parent whose dst.name === name
  // (and whose kind matches if kind option is given).
  const matchingEdges = graph.out(parentId).filter(e => {
    if (options.kind !== undefined && e.kind !== options.kind) return false
    const dst = graph.getNode(e.dst)
    return dst !== undefined && dst.name === name
  })

  if (matchingEdges.length === 0) {
    return {
      graph,
      removed: [],
      recentlyAdded: new Set(),
      recentlyOrphaned: new Set(),
      unresolved,
    }
  }

  const removed: NodeId[] = []
  const recentlyOrphaned: Set<NodeId> = new Set()

  for (const edge of matchingEdges) {
    // Remove the edge first; GC recursively after.
    const targetId = edge.dst
    graph = graph.mutate(m => {
      m.removeEdge(parentId, targetId, edge.kind)
    }).graph

    // Recursive GC starting from targetId.
    graph = gcOrphans(graph, targetId, removed, recentlyOrphaned, emit)
  }

  return {
    graph,
    removed,
    recentlyAdded: new Set(),
    recentlyOrphaned,
    unresolved,
  }
}

/**
 * If `nodeId` is orphaned (no incoming edges) AND not a workspace, remove it
 * along with its outgoing edges, then recurse into each previous out-edge
 * target. Per ADR-0023 §3.2 / removeDependency step 2.
 *
 * ADR-0023 §8.6: MODIFY_NODE_REMOVED diagnostics land on Graph.diagnostics()
 * via Mutator.diagnostic so stringify-side adapters consulting graph-level
 * state see the same record the per-call streaming hook does.
 */
function gcOrphans(
  graph: Graph,
  nodeId: NodeId,
  removed: NodeId[],
  recentlyOrphaned: Set<NodeId>,
  emit: (d: Diagnostic) => void,
): Graph {
  const node = graph.getNode(nodeId)
  if (node === undefined) return graph
  if (node.workspacePath !== undefined) return graph
  if (graph.in(nodeId).length > 0) return graph

  // Collect previous out-edge targets BEFORE removeNode — they may become
  // orphans next.
  const outTargets = graph.out(nodeId).map(e => ({ dst: e.dst, kind: e.kind }))

  // Remove all out-edges first (removeNode requires zero incoming on the
  // target side; we only check out-edges from this node to the descendants).
  // Actually graph.removeNode allows the node to have out-edges — it cleans
  // them up. Let's check graph.ts:692-698 — removeNode iterates outgoing,
  // clears each peer's incoming entry, then deletes. So we can remove the
  // node directly. But for the peer-edge invariant, we need to ensure no
  // peer edges sourced from this node remain — graph.ts handles that via
  // the cleanup in removeNode.
  //
  // However, replacePeerContext invariant: if this node is in another node's
  // peerContext, removing it would break that. Per ADR-0017 / peer-coherence,
  // a peer'd node's incoming peer edges count as "incoming edges", so
  // graph.in(nodeId).length > 0 would catch that case. Good — we already
  // guard above.

  const removedDiag = modifyNodeRemoved(nodeId)
  graph = graph.mutate(m => {
    m.removeNode(nodeId)
    m.diagnostic(removedDiag)
  }).graph
  removed.push(nodeId)
  recentlyOrphaned.add(nodeId)
  emit(removedDiag)

  // Recurse: each previous out-edge target may now be orphaned.
  for (const { dst } of outTargets) {
    graph = gcOrphans(graph, dst, removed, recentlyOrphaned, emit)
  }

  return graph
}
