// COMPLETION_* diagnostic codes — ADR-0023 §7.2.
//
// Tree-completion BFS emits these to communicate which nodes were
// added, which edges were wired via find-up reuse, and which gaps the
// caller's registry could not close.

import type { Diagnostic, EdgeTriple, NodeId } from '../graph.ts'

export type CompletionDiagnosticCode =
  | 'COMPLETION_NODE_ADDED'
  | 'COMPLETION_EDGE_RESOLVED'
  | 'COMPLETION_UNRESOLVED'
  | 'COMPLETION_NODE_UNKNOWN'
  | 'COMPLETION_VERSION_UNKNOWN'
  | 'COMPLETION_PEER_CONTEXT_INCOMPLETE'
  | 'COMPLETION_NO_CANDIDATE'
  | 'COMPLETION_OVERRIDE_CONSTRAINT_CONFLICT'

export interface CompletionDiagnostic extends Diagnostic {
  code: CompletionDiagnosticCode
}

/** One rejected candidate on a `COMPLETION_NO_CANDIDATE` diagnostic's `data`.
 *  A LOAD-BEARING consumer-attribution contract (ADR-0037): `by` names the
 *  constraint kind that rejected the version, `reason` is its human message —
 *  together they let a remediation report say WHY a fix was skipped
 *  (e.g. "no version in range satisfies engines.node >=18"). */
export interface RejectedCandidate {
  version: string
  by:      string
  reason?: string
}

export function completionNodeAdded(nodeId: NodeId): CompletionDiagnostic {
  return {
    code:     'COMPLETION_NODE_ADDED',
    severity: 'info',
    subject:  nodeId,
    message:  `completion added ${nodeId}`,
  }
}

export function completionEdgeResolved(triple: EdgeTriple): CompletionDiagnostic {
  return {
    code:     'COMPLETION_EDGE_RESOLVED',
    severity: 'info',
    subject:  triple,
    message:  `wired ${triple.src} →${triple.kind} ${triple.dst} via find-up reuse`,
  }
}

export function completionUnresolved(consumer: NodeId, depName: string, depRange: string): CompletionDiagnostic {
  return {
    code:     'COMPLETION_UNRESOLVED',
    severity: 'warning',
    subject:  consumer,
    message:  `cannot resolve ${depName}@${depRange} for consumer ${consumer}`,
  }
}

export function completionNodeUnknown(nodeId: NodeId): CompletionDiagnostic {
  return {
    code:     'COMPLETION_NODE_UNKNOWN',
    severity: 'warning',
    subject:  nodeId,
    message:  `registry has no packument for ${nodeId}`,
  }
}

export function completionVersionUnknown(nodeId: NodeId): CompletionDiagnostic {
  return {
    code:     'COMPLETION_VERSION_UNKNOWN',
    severity: 'warning',
    subject:  nodeId,
    message:  `packument lacks version for ${nodeId}`,
  }
}

export function completionPeerContextIncomplete(
  nodeId: NodeId,
  peerName: string,
  peerRange: string,
): CompletionDiagnostic {
  return {
    code:     'COMPLETION_PEER_CONTEXT_INCOMPLETE',
    severity: 'warning',
    subject:  nodeId,
    message:  `peer ${peerName}@${peerRange} unresolved at completion for ${nodeId}`,
  }
}

/** No version satisfying the range passed every constraint. Recoverable
 *  (`warning`, like `COMPLETION_UNRESOLVED`) — the edge is left unwired and
 *  completion continues; the caller maps it to policy (skip / stop). The
 *  `rejected` payload is the load-bearing attribution contract. */
export function completionNoCandidate(
  consumer: NodeId,
  depName: string,
  range: string,
  rejected: readonly RejectedCandidate[],
  extra?: {
    /** A lower version of the CONSUMER whose closure IS constraint-clean, found
     *  by the bounded backtracking probe (ADR-0037 v2). The durable fix. */
    suggestion?: { consumer: string; version: string; range: string }
    /** The probe hit the combinatorial budget before finding a fix. */
    budgetExhausted?: boolean
  },
): CompletionDiagnostic {
  const suggestion = extra?.suggestion
  const hint = suggestion !== undefined
    ? ` — a lower ${suggestion.consumer} (${suggestion.version}) resolves it; pin overrides: { "${suggestion.consumer}": "${suggestion.version}" }`
    : extra?.budgetExhausted === true
      ? ' — search budget exhausted before a lower-consumer fix was found'
      : ''
  return {
    code:     'COMPLETION_NO_CANDIDATE',
    severity: 'warning',
    subject:  consumer,
    message:  `no version of ${depName} in ${range} passes all constraints (for consumer ${consumer})${hint}`,
    data:     {
      depName,
      range,
      rejected: rejected.map(r => ({ ...r })),
      ...(suggestion !== undefined ? { suggestion } : {}),
      ...(extra?.budgetExhausted === true ? { budgetExhausted: true } : {}),
    },
  }
}

/** An override forces a version a constraint vetoes — a genuine config
 *  contradiction, surfaced (never silently resolved either way). Recoverable
 *  (`warning`); the edge is left unwired and the caller decides fatality. */
export function completionOverrideConstraintConflict(
  consumer: NodeId,
  depName: string,
  forced: string,
  by: string,
  reason?: string,
): CompletionDiagnostic {
  return {
    code:     'COMPLETION_OVERRIDE_CONSTRAINT_CONFLICT',
    severity: 'warning',
    subject:  consumer,
    message:  `override forces ${depName}@${forced} but constraint '${by}' rejects it${reason !== undefined ? ` (${reason})` : ''}`,
    data:     { depName, forced, by, ...(reason !== undefined ? { reason } : {}) },
  }
}
