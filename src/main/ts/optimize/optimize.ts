// ADR-0024 — optimize phase: mark-and-sweep orphan GC (monotone-reductive).
//
// Post-completion, pre-stringify sweep that removes unreachable nodes from
// the roots/workspaces/preserve mark-set. Never adds nodes, edges, tarball
// entries, or peer-context entries — diagnostic emission is the only
// growth direction, per §2 / §7 invariants.
//
// Per ADR §3.1 the phase is SYNCHRONOUS: it consults Graph alone, no
// RegistryAdapter / CacheAdapter / filesystem. Per §4.5 the sweep iterates
// over the INPUT snapshot in content-sort order; `next` is the cumulative
// write target and is never re-examined for reachability mid-sweep.

import { serializeNodeId, type Diagnostic, type Graph, type NodeId } from '../graph.ts'
import { optimizeNodeRemoved, optimizeNoop, optimizeNoRoots } from './diagnostics.ts'

export interface OptimizeOptions {
  /** ADR-0023 §7.5 — stream diagnostics as they fire. */
  onDiagnostic?: (d: Diagnostic) => void
  /**
   * Additional NodeIds the caller marks as roots (orchestrator-level
   * preservation; rare — workspaces are implicit roots and do not need
   * this hook). Empty by default. Per ADR-0024 §3 / §4.1.
   */
  preserve?:     ReadonlySet<NodeId>
}

export interface OptimizeResult {
  graph:      Graph
  /**
   * Content-sorted (ADR-0007) NodeIds removed by this call. Empty iff the
   * input was already optimal — in which case `unresolved` carries one
   * OPTIMIZE_NOOP record.
   */
  removed:    NodeId[]
  /** All diagnostics this call emitted, in emission order. */
  unresolved: Diagnostic[]
}

/**
 * Optimize phase entry point. See ADR-0024 §4 for the normative algorithm
 * (mark-and-sweep BFS) and §6 for the OPTIMIZE_* diagnostic taxonomy.
 *
 * Synchronous by §3.1. Idempotent by §7 item 4. Deterministic by §7 item 3
 * (removed[] follows content-sort iteration of `graph.nodes()`).
 */
export function optimize(graph: Graph, options: OptimizeOptions = {}): OptimizeResult {
  const preserve     = options.preserve ?? EMPTY_PRESERVE
  const onDiagnostic = options.onDiagnostic

  // === Phase 1 — mark (§4.1, §4.2) ===
  //
  // Live seeds: (graph.roots() ∩ workspaces) ∪ workspaces ∪ preserve.
  //
  // Interpretation note (per ADR §4.1 first bullet wording — "On non-
  // workspace projects this is the consumer's top-level package. On
  // workspace projects this is the workspace(s) with no incoming
  // workspace→workspace edges"): the ADR describes graph.roots() as
  // returning legitimate purposeful roots in canonical inputs. In real
  // post-parse graphs of this codebase every top-level package carries
  // `workspacePath` (single-package projects use `workspacePath: ''`), so
  // graph.roots() returns workspaces; the union with the explicit-
  // workspace mark is redundant.
  //
  // In post-modify graphs, however, the modifier may have stranded a
  // non-workspace node with zero incoming edges — exactly the §1.3
  // symptom this phase exists to sweep. If we literally seed every
  // graph.roots() member into the live set, the orphan self-seeds and
  // becomes unreachable to GC, violating §9.2's "replaceVersion merge
  // branch" acceptance gate ("the post-modify graph carries
  // lodash@4.17.20 as orphan; optimize removes it"). We therefore filter
  // graph.roots() to workspace-only members. This preserves the ADR's
  // §4.1 intent (workspaces are always roots) AND honours the §9.2
  // contract (non-workspace orphans get swept). The implementation is
  // operationally equivalent to "iterate workspaces directly" — kept as
  // an explicit union for readability against the ADR pseudocode.
  const live: Set<NodeId> = new Set()
  for (const id of graph.roots()) {
    const n = graph.getNode(id)
    if (n?.workspacePath !== undefined) live.add(id)
  }
  let hasNodes = false
  for (const node of graph.nodes()) {
    hasNodes = true
    if (node.workspacePath !== undefined) live.add(node.id)
  }
  for (const id of preserve) live.add(id)

  // === Rootless guard (§4.1 edge case, §6 r3 amendment) ===
  //
  // The mark phase anchors liveness on workspace nodes and `preserve`. A
  // non-workspace graph — classic lockfiles carry no `workspacePath` — with
  // no `preserve` therefore seeds an EMPTY live set, and the §4.3 sweep
  // would then remove every node, wiping the whole graph. That is never the
  // intent: with no anchor we cannot distinguish a wanted top-level
  // dependency from an orphan (both are zero-incoming roots), so we keep all
  // nodes and surface OPTIMIZE_NO_ROOTS. A caller wanting orphan GC on a
  // rootless graph supplies the real roots via `preserve`. (An empty graph
  // has nothing to protect and falls through to the §4 NOOP epilogue.)
  if (live.size === 0 && hasNodes) {
    const diag = optimizeNoRoots()
    const guarded = graph.mutate(m => { m.diagnostic(diag) }).graph
    if (onDiagnostic !== undefined) onDiagnostic(diag)
    return { graph: guarded, removed: [], unresolved: [diag] }
  }

  // BFS from the live seed via all edge kinds (§4.2 — peer edges count
  // too; removing a peer-only-referenced node violates peer-context
  // coherence per ADR-0006). Plus a defensive peerContext walk — the
  // graph.ts:418-425 seal keeps peer-edges ↔ peerContext in lockstep so
  // out('peer') already covers it, but the explicit walk is defence-in-
  // depth per §4.2 should a future Mutator extension decouple them.
  const frontier: NodeId[] = Array.from(live)
  while (frontier.length > 0) {
    const cur = frontier.shift()!
    for (const edge of graph.out(cur)) {
      if (!live.has(edge.dst)) {
        live.add(edge.dst)
        frontier.push(edge.dst)
      }
    }
    const node = graph.getNode(cur)
    if (node !== undefined) {
      for (const peerId of node.peerContext) {
        if (!live.has(peerId)) {
          live.add(peerId)
          frontier.push(peerId)
        }
      }
    }
  }

  // Patch-base preservation. A `@patch:…!builtin` / source-tagged node is a
  // SEPARATE lock entry installed on top of its bare base (consumers' edges
  // route to the patched variant, so the base sits at in-degree 0 yet yarn keeps
  // both entries). Mark the bare base of every live patched/sourced node live so
  // the sweep does not strip it (e.g. `fsevents@npm:2.3.3` under the optional-
  // builtin patch). The base carries no install-tree deps of its own, so adding
  // it to the live set without re-walking is sufficient.
  for (const node of graph.nodes()) {
    if (!live.has(node.id)) continue
    if (node.patch === undefined && node.source === undefined) continue
    const baseId = serializeNodeId(node.name, node.version, node.peerContext, undefined, undefined)
    if (baseId !== node.id && graph.getNode(baseId) !== undefined) live.add(baseId)
  }

  // === Phase 2 — sweep (§4.3, §4.4, §4.5) ===
  //
  // Iterate the INPUT snapshot in content-sort order (§4.5 normative —
  // graph.nodes() yields content-sorted NodeIds per graph.ts:453-459). The
  // live set is the sole oracle of liveness — we never re-examine `next`'s
  // evolving state for reachability mid-sweep. Coherence: removing a node
  // can only shrink reachability, so anything live against `graph` remains
  // live against any intermediate `next`.
  const removed:    NodeId[]     = []
  const unresolved: Diagnostic[] = []
  let   next:       Graph        = graph

  const emit = (d: Diagnostic): void => {
    unresolved.push(d)
    if (onDiagnostic !== undefined) onDiagnostic(d)
  }

  for (const node of graph.nodes()) {
    if (live.has(node.id)) continue
    // Workspaces are unreachable here only if §4.1 missed them — which it
    // cannot, since the mark phase unconditionally adds every workspace.
    // Defensive guard kept per §4 normative clarity: workspace preservation
    // is invariant. v1 never reaches this branch (OPTIMIZE_WORKSPACE_
    // UNREACHABLE is reserved — diagnostics.ts factory exists, but no
    // emit site under the v1 mark policy).
    if (node.workspacePath !== undefined) continue

    // §4.4 atomicity — one mutate() per removed node carries the full
    // removal transaction: drop remaining incoming edges (defensive —
    // orphans have zero in-edges by construction, but a `preserve` set may
    // keep an intermediate alive whose edges into a downstream unreachable
    // still need clearing before removeNode), then removeNode, then
    // removeTarball (if present), then emit the diagnostic on the same
    // transaction so it lands on Graph.diagnostics() per §6.3 / ADR-0023
    // §8.6.
    const nodeId       = node.id
    const tarballInputs = { name: node.name, version: node.version, patch: node.patch }
    const nodeRemovedDiag = optimizeNodeRemoved(nodeId)

    next = next.mutate(m => {
      for (const inc of next.in(nodeId)) {
        m.removeEdge(inc.src, nodeId, inc.kind)
      }
      m.removeNode(nodeId)
      if (next.tarball(tarballInputs) !== undefined) {
        m.removeTarball(tarballInputs)
      }
      m.diagnostic(nodeRemovedDiag)
    }).graph

    removed.push(nodeId)
    emit(nodeRemovedDiag)
  }

  // §4 noop epilogue. Land via mutate so the diagnostic appears on
  // Graph.diagnostics() — dual-channel symmetry with other phases per
  // §6.3 / ADR-0023 §8.6.
  if (removed.length === 0) {
    const noopDiag = optimizeNoop()
    next = next.mutate(m => { m.diagnostic(noopDiag) }).graph
    emit(noopDiag)
  }

  return { graph: next, removed, unresolved }
}

const EMPTY_PRESERVE: ReadonlySet<NodeId> = new Set()
