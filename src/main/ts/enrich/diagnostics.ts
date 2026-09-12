// ENRICH_* diagnostic codes —.
//
// Per-node `ENRICH_FIELD_FILLED` (info) when the phase fills an empty
// install-required field; per-node `ENRICH_CHECKSUM_DEFERRED` (warning) when a
// yarn-berry `checksum` could be neither round-tripped nor recomputed (a
// DEFLATE cacheKey, or the tarball bytes were unavailable); per-call
// `ENRICH_NOOP` (info) when nothing needed filling. Subjects honour
// §7.3: NodeId for per-node events, the `'graph'` literal for the per-call one.

import type { Diagnostic, NodeId } from '../graph.ts'
import type {
  ArtifactLimitOrigin,
  ArtifactRepresentation,
} from '../recipe/artifact-envelope.ts'

export type EnrichDiagnosticCode =
  | 'STORE_PATH_RESOLVED'
  | 'ENRICH_FIELD_FILLED'
  | 'ENRICH_CHECKSUM_DEFERRED'
  | 'ENRICH_NOOP'
  | 'ENRICH_OVERRIDE_AUTHORITY_UNKNOWN'
  | 'ENRICH_OVERRIDE_AUTHORITY_CONFLICT'
  | 'ENRICH_ADAPTER_STATE_INVALIDATED'
  | 'ENRICH_ARTIFACT_ROUTE_MISSING'
  | 'ENRICH_ARTIFACT_ROUTE_AMBIGUOUS'
  | 'ENRICH_ARTIFACT_URL_UNAUTHORIZED'
  | 'ENRICH_ARTIFACT_REGISTRY_METADATA_FAILED'
  | 'ENRICH_ARTIFACT_REDIRECT_REJECTED'
  | 'ENRICH_ARTIFACT_FETCH_FAILED'
  | 'ENRICH_ARTIFACT_HTTP_FAILED'
  | 'ENRICH_ARTIFACT_CONTENT_LENGTH_MISMATCH'
  | 'ENRICH_ARTIFACT_INTEGRITY_MISSING'
  | 'ENRICH_ARTIFACT_INTEGRITY_UNSUPPORTED'
  | 'ENRICH_ARTIFACT_INTEGRITY_MISMATCH'
  | 'ENRICH_ARTIFACT_COMPRESSED_LIMIT'
  | 'ENRICH_ARTIFACT_INFLATED_LIMIT'
  | 'ENRICH_ARTIFACT_TAR_CONTENT_LIMIT'
  | 'ENRICH_ARTIFACT_REPACKED_LIMIT'
  | 'ENRICH_ARTIFACT_LIVE_LIMIT'
  | 'ENRICH_ARTIFACT_TRAFFIC_LIMIT'
  | 'ENRICH_ARTIFACT_STORE_CORRUPT'
  | 'ENRICH_ARTIFACT_STORE_READ_FAILED'
  | 'ENRICH_ARTIFACT_STORE_WRITE_FAILED'
  | 'ENRICH_ARTIFACT_STORE_CAPACITY_EXCEEDED'
  | 'ENRICH_ARTIFACT_STORE_EVICTION_FAILED'

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
    // 'graph' literal per — per-call event; NodeId is `string`.
    subject:  'graph',
    message:  'enrich: nothing to fill',
  }
}

export function enrichOverrideAuthority(
  status: 'unknown' | 'conflict',
): EnrichDiagnostic {
  return {
    code: status === 'unknown'
      ? 'ENRICH_OVERRIDE_AUTHORITY_UNKNOWN'
      : 'ENRICH_OVERRIDE_AUTHORITY_CONFLICT',
    severity: 'warning',
    message: status === 'unknown'
      ? 'transitive completion requires authoritative override evidence'
      : 'transitive completion skipped because override authorities conflict',
    data: { dimension: 'resolutionPolicy' },
  }
}

export function enrichAdapterStateInvalidated(
  format: string,
  subjects: readonly string[],
): EnrichDiagnostic {
  return {
    code: 'ENRICH_ADAPTER_STATE_INVALIDATED',
    severity: 'warning',
    message: `source adapter state was invalidated for ${subjects.length} subject(s)`,
    data: { format, subjects: [...subjects] },
  }
}

export type EnrichArtifactDiagnosticCode = Extract<
  EnrichDiagnosticCode,
  `ENRICH_ARTIFACT_${string}`
>

export function enrichArtifactDiagnostic(
  code: EnrichArtifactDiagnosticCode,
  subject: string,
  message: string,
  data?: Record<string, unknown>,
): EnrichDiagnostic {
  return {
    code,
    severity: 'warning',
    subject,
    message: `enrich: artifact bytes for ${subject} ${message}`,
    ...(data === undefined ? {} : { data }),
  }
}

const limitCode: Record<ArtifactRepresentation, EnrichArtifactDiagnosticCode> = {
  compressed: 'ENRICH_ARTIFACT_COMPRESSED_LIMIT',
  inflated: 'ENRICH_ARTIFACT_INFLATED_LIMIT',
  'tar-content': 'ENRICH_ARTIFACT_TAR_CONTENT_LIMIT',
  repacked: 'ENRICH_ARTIFACT_REPACKED_LIMIT',
  live: 'ENRICH_ARTIFACT_LIVE_LIMIT',
}

export function enrichArtifactLimit(
  subject: string,
  representation: ArtifactRepresentation,
  limitBytes: number,
  origin: ArtifactLimitOrigin,
): EnrichDiagnostic {
  const callerProvided = origin !== 'default'
  return enrichArtifactDiagnostic(
    limitCode[representation],
    subject,
    callerProvided
      ? `reached the caller-provided ${representation} ceiling of ${limitBytes} bytes`
      : `exceeded the default ${representation} safety ceiling of ${limitBytes} bytes; override the resource policy for this accepted package-manager artifact`,
    { representation, limitBytes, origin },
  )
}

export function enrichArtifactTrafficLimit(
  subject: string,
  limitBytes: number,
  origin: ArtifactLimitOrigin,
): EnrichDiagnostic {
  return enrichArtifactDiagnostic(
    'ENRICH_ARTIFACT_TRAFFIC_LIMIT',
    subject,
    origin === 'default'
      ? `exceeded the default cumulative network-traffic ceiling of ${limitBytes} bytes`
      : `reached the caller-provided cumulative network-traffic ceiling of ${limitBytes} bytes`,
    { representation: 'network-traffic', limitBytes, origin },
  )
}
