// MODIFY_* diagnostic codes — ADR-0023 §7.1.
//
// Every modifier primitive emits diagnostics through this taxonomy.
// Severities follow the §7.1 table verbatim; MODIFY_LICENSE_BLOCKED is
// `warning` (not error) — caller policy decides whether to gate on it.

import type { Diagnostic, EdgeTriple, NodeId } from '../graph.ts'

export type ModifyDiagnosticCode =
  | 'MODIFY_NODE_REPLACED'
  | 'MODIFY_NODE_ADDED'
  | 'MODIFY_NODE_REMOVED'
  | 'MODIFY_EDGE_REWIRED'
  | 'MODIFY_PATCH_APPLIED'
  | 'MODIFY_LICENSE_FLAGGED'
  | 'MODIFY_LICENSE_BLOCKED'
  | 'MODIFY_RESOLVE_FAILED'
  | 'MODIFY_SENTINEL_REFUSED'
  | 'MODIFY_OVERRIDE_PINNED'

export interface ModifyDiagnostic extends Diagnostic {
  code: ModifyDiagnosticCode
}

export function modifyNodeReplaced(fromId: NodeId, toId: NodeId): ModifyDiagnostic {
  return {
    code:     'MODIFY_NODE_REPLACED',
    severity: 'info',
    subject:  toId,
    message:  `replaced ${fromId} → ${toId}`,
  }
}

export function modifyNodeAdded(consumer: NodeId, newId: NodeId): ModifyDiagnostic {
  return {
    code:     'MODIFY_NODE_ADDED',
    severity: 'info',
    subject:  newId,
    message:  `added ${newId} (consumer: ${consumer})`,
  }
}

export function modifyNodeRemoved(id: NodeId): ModifyDiagnostic {
  return {
    code:     'MODIFY_NODE_REMOVED',
    severity: 'info',
    subject:  id,
    message:  `removed ${id}`,
  }
}

export function modifyEdgeRewired(triple: EdgeTriple): ModifyDiagnostic {
  return {
    code:     'MODIFY_EDGE_REWIRED',
    severity: 'info',
    subject:  triple,
    message:  `rewired ${triple.src} →${triple.kind} ${triple.dst}`,
  }
}

export function modifyPatchApplied(nodeId: NodeId): ModifyDiagnostic {
  return {
    code:     'MODIFY_PATCH_APPLIED',
    severity: 'info',
    subject:  nodeId,
    message:  `applied patch to ${nodeId}`,
  }
}

export function modifyLicenseFlagged(nodeId: NodeId, license: string | undefined): ModifyDiagnostic {
  return {
    code:     'MODIFY_LICENSE_FLAGGED',
    severity: 'warning',
    subject:  nodeId,
    message:  `license ${license ?? '<unknown>'} flagged on ${nodeId}`,
  }
}

export function modifyLicenseBlocked(nodeId: NodeId, license: string | undefined): ModifyDiagnostic {
  return {
    code:     'MODIFY_LICENSE_BLOCKED',
    severity: 'warning',
    subject:  nodeId,
    message:  `license ${license ?? '<unknown>'} blocked on ${nodeId} but cannot be removed (workspace-rooted)`,
  }
}

export function modifyResolveFailed(name: string, range: string): ModifyDiagnostic {
  return {
    code:     'MODIFY_RESOLVE_FAILED',
    severity: 'warning',
    subject:  'graph',
    message:  `registry.resolve(${name}, ${range}) returned undefined`,
  }
}

export function modifySentinelRefused(nodeId: NodeId, op: string): ModifyDiagnostic {
  return {
    code:     'MODIFY_SENTINEL_REFUSED',
    severity: 'warning',
    subject:  nodeId,
    message:  `${op}: sentinel-keyed source refuses byte-modifying mutation on ${nodeId}`,
  }
}

export function modifyOverridePinned(name: string, resolved: string): ModifyDiagnostic {
  return {
    code:     'MODIFY_OVERRIDE_PINNED',
    severity: 'info',
    subject:  'graph',
    message:  `pinned override ${name} → ${resolved}`,
  }
}

// `subject` is a `Diagnostic` type compatible value or the literal 'graph'. The
// graph.ts `Diagnostic.subject` is typed `NodeId | EdgeTriple | undefined`; the
// 'graph' literal lives at the modify-layer level per ADR-0023 §7.3 — we coerce
// via the carrier `subject?:` being string-typed (NodeId IS string).
