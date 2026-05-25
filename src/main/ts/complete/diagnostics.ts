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

export interface CompletionDiagnostic extends Diagnostic {
  code: CompletionDiagnosticCode
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
