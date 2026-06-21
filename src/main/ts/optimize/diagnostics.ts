// OPTIMIZE_* diagnostic codes — ADR-0024 §6.
//
// Four codes total: NODE_REMOVED (per-removal info), NOOP (per-call info
// when removed.length === 0), WORKSPACE_UNREACHABLE (reserved warning code
// that v1 never emits — §6 r2 amendment keeps the factory for future
// opt-in mark-policy tightenings), NO_ROOTS (per-call warning when the mark
// phase finds no live anchor on a non-empty graph — see §6 r3 amendment).
//
// Subjects honour ADR-0023 §7.3: NodeId for per-node events, the 'graph'
// literal for the per-call event. Severities follow §6's table verbatim.

import { nameOf, type Diagnostic, type NodeId } from '../graph.ts'

export type OptimizeDiagnosticCode =
  | 'OPTIMIZE_NODE_REMOVED'
  | 'OPTIMIZE_WORKSPACE_UNREACHABLE'
  | 'OPTIMIZE_NOOP'
  | 'OPTIMIZE_NO_ROOTS'

export interface OptimizeDiagnostic extends Diagnostic {
  code: OptimizeDiagnosticCode
}

/**
 * Fires once per removed node. `subject` is the NodeId being swept.
 * Message includes `name@version` for grep-ability per ADR-0006 readability
 * rationale — the NodeId alone may carry a long peerContext suffix.
 */
export function optimizeNodeRemoved(nodeId: NodeId): OptimizeDiagnostic {
  return {
    code:     'OPTIMIZE_NODE_REMOVED',
    severity: 'info',
    subject:  nodeId,
    message:  `removed orphan ${nodeLabel(nodeId)} (${nodeId})`,
  }
}

/**
 * Best-effort `${name}@${version}` label from a NodeId for human-readable
 * diagnostic messages. Falls back to the bare NodeId on shapes we cannot split
 * (sentinel / patched / peer-keyed NodeIds where the grep-target is the full
 * string). Shared by the OPTIMIZE_* and PRUNE_* node-removal factories.
 */
function nodeLabel(nodeId: NodeId): string {
  const name = nameOf(nodeId)
  const tail = nodeId.slice(name.length + 1)  // skip the separator '@'
  // Strip peerContext segment if present — first depth-0 '(' marks its start.
  let depth = 0
  let cut = tail.length
  for (let i = 0; i < tail.length; i++) {
    const c = tail[i]
    if (c === '(' && depth === 0) { cut = i; break }
    if (c === '(') depth++
    else if (c === ')') depth--
  }
  const version = tail.slice(0, cut)
  return name.length > 0 && version.length > 0 ? `${name}@${version}` : nodeId
}

// PRUNE_* — diagnostics for `pruneOrphans` (reference-count GC, the sibling of
// optimize's reachability GC). Same subject/severity conventions.
export type PruneDiagnosticCode =
  | 'PRUNE_NODE_REMOVED'
  | 'PRUNE_NOOP'

export interface PruneDiagnostic extends Diagnostic {
  code: PruneDiagnosticCode
}

/** Fires once per node retired because it lost its last incoming edge. */
export function pruneNodeRemoved(nodeId: NodeId): PruneDiagnostic {
  return {
    code:     'PRUNE_NODE_REMOVED',
    severity: 'info',
    subject:  nodeId,
    message:  `pruned unreferenced ${nodeLabel(nodeId)} (${nodeId})`,
  }
}

/** Fires once per `pruneOrphans(graph)` call when nothing was removed. */
export function pruneNoop(): PruneDiagnostic {
  return {
    code:     'PRUNE_NOOP',
    severity: 'info',
    subject:  'graph',
    message:  'pruneOrphans: no unreferenced nodes to collect',
  }
}

// reserved — v1 never emits per ADR-0024 §6 r2 amendment.
// The §4.1 explicit workspace mark unconditionally adds every workspace to
// the live set, so the §4 sweep branch that would fire this diagnostic is
// dead under the v1 mark policy. Factory kept for future opt-in mark-policy
// tightenings (e.g. a hypothetical `policy: 'strict-workspaces'` option that
// drops the implicit workspace mark from §4.1 and forces explicit
// reachability).
export function optimizeWorkspaceUnreachable(nodeId: NodeId): OptimizeDiagnostic {
  return {
    code:     'OPTIMIZE_WORKSPACE_UNREACHABLE',
    severity: 'warning',
    subject:  nodeId,
    message:  `workspace ${nodeId} is unreachable from any other workspace`,
  }
}

/**
 * Fires once per `optimize(graph)` call when `removed.length === 0`. The
 * subject is the `'graph'` literal per ADR-0023 §7.3 / ADR-0024 §6.2 —
 * the event is per-call, not per-node. Useful for fixpoint convergence
 * detection: an iteration with OPTIMIZE_NOOP confirms the reductive phase
 * is stable.
 */
export function optimizeNoop(): OptimizeDiagnostic {
  return {
    code:     'OPTIMIZE_NOOP',
    severity: 'info',
    // 'graph' literal per ADR-0023 §7.3 — the modify-layer convention for
    // per-call events. graph.ts types `subject` as `NodeId | EdgeTriple |
    // undefined`; NodeId is `string` so the 'graph' literal is assignable.
    subject:  'graph',
    message:  'optimize: no orphans to collect',
  }
}

/**
 * Fires once per `optimize(graph)` call when the mark phase finds no live
 * anchor — no workspace nodes AND an empty `preserve` set — on a non-empty
 * graph (ADR-0024 §6 r3). Without an anchor, reachability cannot tell a
 * wanted top-level dependency from an orphan (both are zero-incoming roots),
 * so optimize preserves every node and returns the graph unchanged rather
 * than wiping it. The caller supplies the real roots via `preserve` to
 * enable sweeping on non-workspace (classic) graphs.
 *
 * Subject is the `'graph'` literal per ADR-0023 §7.3 — a per-call event.
 */
export function optimizeNoRoots(): OptimizeDiagnostic {
  return {
    code:     'OPTIMIZE_NO_ROOTS',
    severity: 'warning',
    subject:  'graph',
    message:  'optimize: no workspace roots or preserve set on a non-empty graph — kept all nodes to avoid pruning the whole graph',
  }
}
