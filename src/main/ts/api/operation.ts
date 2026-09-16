import { LockfileError, type LockfileErrorCode } from './errors.ts'
import type { FormatId } from './format-contract.ts'
import type {
  Diagnostic,
  Graph,
  GraphResult,
  HostingProvider,
  TarballKey,
} from '../graph.ts'
import type {
  PmConfigEvidence,
  TargetInput,
} from '../completeness/types.ts'
import type {
  ArtifactSourceList,
} from '../enrich/artifact-sources.ts'
import type { Store } from '../enrich/artifact-store.ts'
import type { RegistryAdapter } from '../registry/types.ts'
import {
  DEFAULT_ARTIFACT_MAX_NETWORK_TRAFFIC_BYTES,
  type ArtifactResourceLimits,
  type ArtifactResourcePolicy,
} from '../recipe/artifact-envelope.ts'

export type DiagnosticSeverity = Diagnostic['severity']

export type DiagnosticCode =
  | LockfileErrorCode
  | 'STORE_PATH_RESOLVED'
  | 'STORE_CANDIDATE_CORRUPT'
  | 'STORE_READ_FAILED'
  | 'STORE_WRITE_FAILED'
  | 'STORE_CAPACITY_EXCEEDED'
  | 'STORE_EVICTION_FAILED'
  | 'CONVERT_FROZEN_ORACLE_MISMATCH'
  | `BUN_${string}`
  | `COMPLETENESS_${string}`
  | `COMPLETION_${string}`
  | `CONVERT_${string}`
  | `DENO_${string}`
  | `ENRICH_${string}`
  | `INTEROP_${string}`
  | `LAYOUT_${string}`
  | `MODIFY_${string}`
  | `NPM_${string}`
  | `OVERRIDE_${string}`
  | `PNPM_${string}`
  | `PROJECTION_${string}`
  | `PRUNE_${string}`
  | `RECIPE_${string}`
  | `YARN_${string}`

export type DiagnosticObserver = (diagnostic: Diagnostic) => void

export interface ObserveOptions {
  readonly onDiagnostic?: DiagnosticObserver
}

export interface OperationResult {
  readonly diagnostics: readonly Diagnostic[]
}

export interface GraphOperationResult extends OperationResult {
  readonly graph: Graph
}

export type PackageManager =
  | 'npm'
  | 'pnpm'
  | 'yarn'
  | 'bun'
  | 'deno'
  | 'lockgraph'
export type Resolution =
  | Readonly<{ kind: 'registry'; bind?: string }>
  | Readonly<{
      kind: 'tarball'
      url: string
      hostingProvider?: HostingProvider
      bind?: string
    }>
  | Readonly<{
      kind: 'git'
      url: string
      sha: string
      hostingProvider?: HostingProvider
    }>
  | Readonly<{ kind: 'directory'; path: string }>
  | Readonly<{ kind: 'unknown'; raw: string }>

export type ByteSize =
  `${number} ${'B' | 'kB' | 'MB' | 'GB' | 'KiB' | 'MiB' | 'GiB'}`

export interface GuardProfile {
  readonly patterns?: readonly TarballKey[]
  readonly artifactCompressed?: ByteSize
  readonly artifactInflated?: ByteSize
  readonly artifactTarContent?: ByteSize
  readonly artifactRepacked?: ByteSize
  readonly artifactLive?: ByteSize
  readonly networkTraffic?: ByteSize
}

export type ArtifactSource = ArtifactSourceList[number]

export type FileSource =
  | readonly string[]
  | Readonly<Record<string, string | Uint8Array>>

export interface OperationSources {
  readonly manifests?: FileSource
  readonly policy?: PmConfigEvidence
  readonly packuments?: readonly RegistryAdapter[]
  readonly artifacts?: ArtifactSourceList
}

export interface OperationOptions extends ObserveOptions {
  readonly target: TargetInput
  /** Explicit registry authority for npm-class lock entries whose native
   * format omits the registry host. */
  readonly registry?: string
  readonly sources?: OperationSources
  readonly cwd?: string
  readonly guards?: readonly GuardProfile[]
  readonly store?: Store | false
}

export interface ProjectionOptions extends OperationOptions {
  readonly strict?: boolean
}

const BYTE_UNITS: Readonly<Record<string, number>> = Object.freeze({
  B: 1,
  kB: 1_000,
  MB: 1_000_000,
  GB: 1_000_000_000,
  KiB: 1024,
  MiB: 1024 * 1024,
  GiB: 1024 * 1024 * 1024,
})

export function parseByteSize(value: ByteSize, field = 'byte size'): number {
  const match = /^(?:0|[1-9]\d*)(?:\.\d+)? (B|kB|MB|GB|KiB|MiB|GiB)$/.exec(value)
  if (match === null) throw new TypeError(`${field}: expected a positive human byte size`)
  const amount = Number(value.slice(0, value.indexOf(' ')))
  const bytes = amount * BYTE_UNITS[match[1]!]!
  if (!Number.isFinite(bytes) || bytes <= 0 || !Number.isSafeInteger(bytes)) {
    throw new TypeError(`${field}: byte size must resolve to a positive safe integer`)
  }
  return bytes
}

interface NormalizedGuards {
  readonly artifactResources?: ArtifactResourcePolicy
  readonly maxNetworkTrafficBytes: number
  readonly networkTrafficOrigin: 'default' | 'global'
}

const resourceFields: ReadonlyArray<readonly [
  keyof Pick<GuardProfile,
    | 'artifactCompressed'
    | 'artifactInflated'
    | 'artifactTarContent'
    | 'artifactRepacked'>,
  keyof ArtifactResourceLimits,
]> = [
  ['artifactCompressed', 'maxCompressedBytes'],
  ['artifactInflated', 'maxInflatedBytes'],
  ['artifactTarContent', 'maxTarContentBytes'],
  ['artifactRepacked', 'maxRepackedBytes'],
]

type MutableArtifactResourceLimits = {
  -readonly [Key in keyof ArtifactResourceLimits]: ArtifactResourceLimits[Key]
}

function resourceLimits(profile: GuardProfile): Partial<ArtifactResourceLimits> {
  const limits: Partial<MutableArtifactResourceLimits> = {}
  for (const [source, target] of resourceFields) {
    const value = profile[source]
    if (value !== undefined) limits[target] = guardByteSize(value, source)
  }
  return limits
}

function invalidGuards(message: string, cause?: unknown): LockfileError {
  return new LockfileError({
    code: 'INVALID_INPUT',
    message: `guards: ${message}`,
    ...(cause === undefined ? {} : { cause }),
  })
}

function guardByteSize(value: ByteSize, field: string): number {
  try {
    return parseByteSize(value, `guards.${field}`)
  } catch (error) {
    throw invalidGuards(`${field} must be a positive human byte size`, error)
  }
}

/** Validates ordered profiles once and lowers them to the existing envelope. */
export function normalizeGuardProfiles(
  profiles: readonly GuardProfile[] | undefined,
): NormalizedGuards {
  if (profiles === undefined || profiles.length === 0) {
    return {
      maxNetworkTrafficBytes: DEFAULT_ARTIFACT_MAX_NETWORK_TRAFFIC_BYTES,
      networkTrafficOrigin: 'default',
    }
  }

  const overrides: Record<TarballKey, Partial<ArtifactResourceLimits>> = {}
  let defaults: Partial<ArtifactResourceLimits> | undefined
  let maxLiveBytes: number | undefined
  let maxNetworkTrafficBytes = DEFAULT_ARTIFACT_MAX_NETWORK_TRAFFIC_BYTES
  let networkTrafficOrigin: 'default' | 'global' = 'default'
  let fallbackSeen = false

  for (const [index, profile] of profiles.entries()) {
    const patterns = profile.patterns
    const fallback = patterns === undefined
    if (fallback) {
      if (fallbackSeen || index !== profiles.length - 1) {
        throw invalidGuards('the single unpatterned fallback profile must be last')
      }
      fallbackSeen = true
      defaults = resourceLimits(profile)
      if (profile.artifactLive !== undefined) {
        maxLiveBytes = guardByteSize(profile.artifactLive, 'artifactLive')
      }
      if (profile.networkTraffic !== undefined) {
        maxNetworkTrafficBytes = guardByteSize(profile.networkTraffic, 'networkTraffic')
        networkTrafficOrigin = 'global'
      }
      continue
    }

    if (patterns.length === 0) {
      throw invalidGuards('patterns must contain at least one exact TarballKey')
    }
    if (profile.artifactLive !== undefined || profile.networkTraffic !== undefined) {
      throw invalidGuards('operation-wide meters are legal only on the fallback profile')
    }
    const limits = resourceLimits(profile)
    for (const pattern of patterns) {
      if (pattern.length === 0) throw invalidGuards('pattern must not be empty')
      if (overrides[pattern] === undefined) overrides[pattern] = limits
    }
  }

  const artifactResources = defaults === undefined
    && Object.keys(overrides).length === 0
    && maxLiveBytes === undefined
    ? undefined
    : {
        ...(defaults === undefined ? {} : { defaults }),
        ...(Object.keys(overrides).length === 0 ? {} : { overrides }),
        ...(maxLiveBytes === undefined ? {} : { maxLiveBytes }),
      }
  return { artifactResources, maxNetworkTrafficBytes, networkTrafficOrigin }
}

/** Compile-time assertion that the existing graph result implements the common result. */
const graphResultCompatibility: GraphOperationResult | undefined =
  undefined as GraphResult | undefined
void graphResultCompatibility

/** Keeps FormatId visible to declaration emitters that collapse TargetInput aliases. */
const formatCompatibility: FormatId | undefined = undefined
void formatCompatibility
