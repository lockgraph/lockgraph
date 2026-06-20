// ENRICH_* diagnostic codes — ADR-0034 §7.
//
// Per-node `ENRICH_FIELD_FILLED` (info) when the phase fills an empty
// install-required field; per-node `ENRICH_CHECKSUM_DEFERRED` (warning) when a
// yarn-berry `checksum` could be neither round-tripped nor recomputed (a
// DEFLATE cacheKey, or the tarball bytes were unavailable); per-call
// `ENRICH_NOOP` (info) when nothing needed filling. Subjects honour ADR-0023
// §7.3: NodeId for per-node events, the `'graph'` literal for the per-call one.

import type { Diagnostic, NodeId } from '../graph.ts'

export type EnrichDiagnosticCode =
  | 'ENRICH_FIELD_FILLED'
  | 'ENRICH_CHECKSUM_DEFERRED'
  | 'ENRICH_NOOP'

export interface EnrichDiagnostic extends Diagnostic {
  code: EnrichDiagnosticCode
}

export function enrichFieldFilled(nodeId: NodeId, field: string, rung: string): EnrichDiagnostic {
  return {
    code:     'ENRICH_FIELD_FILLED',
    severity: 'info',
    subject:  nodeId,
    message:  `enrich: filled ${field} on ${nodeId} (rung: ${rung})`,
  }
}

export function enrichChecksumDeferred(nodeId: NodeId): EnrichDiagnostic {
  return {
    code:     'ENRICH_CHECKSUM_DEFERRED',
    severity: 'warning',
    subject:  nodeId,
    message:  `enrich: berry checksum for ${nodeId} not recomputable (DEFLATE cacheKey or tarball bytes unavailable) — line omitted; plain \`yarn install\` recovers it, \`yarn install --immutable\` will reject this node`,
  }
}

export function enrichNoop(): EnrichDiagnostic {
  return {
    code:     'ENRICH_NOOP',
    severity: 'info',
    // 'graph' literal per ADR-0023 §7.3 — per-call event; NodeId is `string`.
    subject:  'graph',
    message:  'enrich: nothing to fill',
  }
}
