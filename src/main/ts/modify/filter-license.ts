// ADR-0023 §3.2 — `filterLicense`.
//
// Walk every reachable node; read `tarballOf(node.id)?.license`.
// Apply allow / deny predicates.
//
// - `mode: 'diagnostic-only'` (default) — emit MODIFY_LICENSE_FLAGGED
//   (warning) per affected node.
// - `mode: 'strict'` — additionally removeDependency every incoming edge
//   to the offending node (and GC); if the node is reachable only via
//   workspace deps the user has not explicitly excluded, emit
//   MODIFY_LICENSE_BLOCKED (warning).
//
// F2: License blocking is warning, not error. Caller policy decides.

import type {
  Diagnostic,
  Graph,
  NodeId,
} from '../graph.ts'
import {
  modifyLicenseBlocked,
  modifyLicenseFlagged,
  modifyNodeRemoved,
} from './diagnostics.ts'

export interface FilterLicenseOptions {
  /** Whitelist of license identifiers; missing or none-of permitted licenses → flagged. */
  allow?:        readonly string[]
  /** Blacklist of license identifiers; any deny match → flagged. */
  deny?:         readonly string[]
  mode?:         'diagnostic-only' | 'strict'
  onDiagnostic?: (d: Diagnostic) => void
}

export interface FilterLicenseResult {
  graph:            Graph
  flagged:          NodeId[]
  removed:          NodeId[]
  recentlyAdded:    Set<NodeId>
  recentlyOrphaned: Set<NodeId>
  unresolved:       Diagnostic[]
}

export async function filterLicense(
  graph: Graph,
  options: FilterLicenseOptions = {},
): Promise<FilterLicenseResult> {
  const onDiagnostic = options.onDiagnostic
  const unresolved: Diagnostic[] = []
  const emit = (d: Diagnostic): void => {
    unresolved.push(d)
    if (onDiagnostic !== undefined) onDiagnostic(d)
  }

  const mode  = options.mode ?? 'diagnostic-only'
  const allow = options.allow
  const deny  = options.deny

  if (allow === undefined && deny === undefined) {
    // No predicates → no work.
    return emptyResult(graph)
  }

  // Enumerate offending nodes. Walk every non-workspace node; lookup license
  // via tarballOf. Workspace nodes are skipped — they are not packages whose
  // license a filter would gate on (they're the project itself).
  const offending: Array<{ id: NodeId; license: string | undefined }> = []
  for (const node of graph.nodes()) {
    if (node.workspacePath !== undefined) continue
    const license = graph.tarballOf(node.id)?.license
    if (!isFlagged(license, allow, deny)) continue
    offending.push({ id: node.id, license })
  }

  if (offending.length === 0) {
    return emptyResult(graph)
  }

  // Diagnostic-only mode: flag, return.
  if (mode === 'diagnostic-only') {
    const flagged: NodeId[] = []
    let currentGraph = graph
    for (const { id, license } of offending) {
      const d = modifyLicenseFlagged(id, license)
      emit(d)
      currentGraph = currentGraph.mutate(m => { m.diagnostic(d) }).graph
      flagged.push(id)
    }
    return {
      graph:            currentGraph,
      flagged,
      removed:          [],
      recentlyAdded:    new Set(),
      recentlyOrphaned: new Set(),
      unresolved,
    }
  }

  // Strict mode: remove each offending node's incoming edges, then GC.
  // We don't go through removeDependency for the recursive collapse — we
  // need to operate per offending node uniformly. Workspace-rooted nodes
  // that can't be removed surface MODIFY_LICENSE_BLOCKED.
  const flagged: NodeId[] = []
  const removed: NodeId[] = []
  const recentlyOrphaned: Set<NodeId> = new Set()
  let currentGraph = graph

  for (const { id, license } of offending) {
    const node = currentGraph.getNode(id)
    if (node === undefined) continue
    flagged.push(id)
    const flaggedDiag = modifyLicenseFlagged(id, license)
    emit(flaggedDiag)
    currentGraph = currentGraph.mutate(m => { m.diagnostic(flaggedDiag) }).graph

    // Check if the node has workspace-rooted incoming edges that we can't
    // structurally drop (workspace declares need for this dep).
    const inEdges = currentGraph.in(id).slice()

    // Best-effort: remove all incoming edges. If any incoming source is a
    // workspace node, removing the edge here is legal per the Mutator
    // (only sentinel sources are refused), but the resulting graph may be
    // semantically wrong from the workspace's perspective. We emit
    // MODIFY_LICENSE_BLOCKED to surface that ambiguity to the caller.
    let hasWorkspaceIncoming = false
    for (const inc of inEdges) {
      const src = currentGraph.getNode(inc.src)
      if (src?.workspacePath !== undefined) {
        hasWorkspaceIncoming = true
        break
      }
    }

    if (hasWorkspaceIncoming) {
      const blockedDiag = modifyLicenseBlocked(id, license)
      emit(blockedDiag)
      currentGraph = currentGraph.mutate(m => { m.diagnostic(blockedDiag) }).graph
      continue
    }

    for (const inc of inEdges) {
      currentGraph = currentGraph.mutate(m => {
        m.removeEdge(inc.src, id, inc.kind)
      }).graph
    }

    // GC if orphaned now.
    currentGraph = gcOrphans(currentGraph, id, removed, recentlyOrphaned, emit)
  }

  return {
    graph:            currentGraph,
    flagged,
    removed,
    recentlyAdded:    new Set(),
    recentlyOrphaned,
    unresolved,
  }
}

function isFlagged(
  license: string | undefined,
  allow: readonly string[] | undefined,
  deny:  readonly string[] | undefined,
): boolean {
  if (deny !== undefined && license !== undefined && deny.includes(license)) return true
  if (allow !== undefined) {
    if (license === undefined) return true
    if (!allow.includes(license)) return true
  }
  return false
}

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

  const outTargets = graph.out(nodeId).map(e => ({ dst: e.dst, kind: e.kind }))

  const removedDiag = modifyNodeRemoved(nodeId)
  graph = graph.mutate(m => {
    m.removeNode(nodeId)
    m.diagnostic(removedDiag)
  }).graph
  removed.push(nodeId)
  recentlyOrphaned.add(nodeId)
  emit(removedDiag)

  for (const { dst } of outTargets) {
    graph = gcOrphans(graph, dst, removed, recentlyOrphaned, emit)
  }
  return graph
}

function emptyResult(graph: Graph): FilterLicenseResult {
  return {
    graph,
    flagged:          [],
    removed:          [],
    recentlyAdded:    new Set(),
    recentlyOrphaned: new Set(),
    unresolved:       [],
  }
}
