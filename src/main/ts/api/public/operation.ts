import type { TargetInput, PmConfigEvidence, PackageManager } from './assessment.ts'
import type {
  Diagnostic,
  DiagnosticCode,
  DiagnosticObserver,
  DiagnosticSeverity,
  ObserveOptions,
} from './diagnostics.ts'
import type {
  Graph,
  HostingProvider,
  TarballKey,
} from './graph.ts'
import type {
  RegistryAdapter,
  RemoteArtifactRegistry,
} from './registry.ts'
import type { Store } from '../../enrich/artifact-store.ts'

export type {
  Diagnostic,
  DiagnosticCode,
  DiagnosticObserver,
  DiagnosticSeverity,
  ObserveOptions,
  PackageManager,
}

export interface OperationResult {
  readonly diagnostics: readonly Diagnostic[]
}

export interface GraphOperationResult extends OperationResult {
  readonly graph: Graph
}

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

export type ArtifactCacheSpecifier =
  | 'npm'
  | `npm:${string}`
  | 'yarn-berry'
  | `yarn-berry:${string}`

/**
 * Ingestion accepts a plain `string` so the natural spelling compiles:
 * `const artifacts = ['yarn-berry:.yarn/cache', 'npm']` infers `string[]`, and no
 * signature can accept that variable while still rejecting a misspelling at type
 * level — the literals are gone by then. `ArtifactCacheSpecifier` stays exported as
 * the precise opt-in grammar; normalization is the authority and rejects unknown
 * families, empty paths and inert stores before any filesystem or network access.
 */
export type ArtifactSource = string | RemoteArtifactRegistry
export type ArtifactSourceList = readonly ArtifactSource[]

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
