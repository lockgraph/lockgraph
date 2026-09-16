// The public surface. Everything the package exports is named here, once.
// The root index re-exports this barrel and does nothing else but wire graph accessors.

export {
  LockfileError,
  type LockfileErrorCode,
  type ProjectionLoss,
  type ProjectionLossClass,
  type ProjectionRemedy,
} from './errors.ts'
export type {
  Edge,
  EdgeAttributes,
  EdgeKind,
  EdgeTriple,
  GraphChange,
  GraphDiff,
  GraphWalkOptions,
  GraphMutation,
  GraphMutationResult,
  Graph,
  HashOrigin,
  HostingProvider,
  Integrity,
  IntegrityHash,
  LayoutHints,
  Manifest,
  Node,
  NodeId,
  OverrideConstraint,
  OverrideManager,
  Patch,
  SourceDiscriminator,
  TarballKey,
  TarballKeyInput,
  TarballPayload,
  WorkspaceRange,
} from './graph.ts'
export type {
  FormatId,
  YarnBerryFormatId,
} from '../../api/format-contract.ts'
export {
  check,
  detect,
  parse,
  stringify,
  type ParseOptions,
  type StringifyOptions,
} from './codecs.ts'

export type {
  ArtifactSource,
  ByteSize,
  DiagnosticCode,
  Diagnostic,
  DiagnosticObserver,
  DiagnosticSeverity,
  FileSource,
  GraphOperationResult,
  GuardProfile,
  ObserveOptions,
  OperationOptions,
  OperationResult,
  OperationSources,
  PackageManager,
  ProjectionOptions,
  Resolution,
} from './operation.ts'

export {
  complete,
  engines,
  license,
  selectConstrained,
} from './complete.ts'
export type {
  Awaitable,
  CompleteOptions,
  CompleteResult,
  Condition,
  ConditionContext,
  ConditionVerdict,
  CompletionBudget,
  OnUnevaluable,
  RejectedCandidate,
  SelectConstrainedOptions,
  SelectConstrainedResult,
} from './complete.ts'

export {
  convert,
  type CompanionFile,
  type ConvertFileSystem,
  type ConvertGlobOptions,
  type ConvertOptions,
  type ProjectConvertOptions,
  type ProjectOutput,
} from './convert.ts'

export {
  certifyFrozen,
  prepareFrozen,
  type FrozenCandidate,
  type FrozenCertificationOptions,
  type FrozenConversionResult,
  type FrozenOptions,
  type FrozenPreparationResult,
  type FrozenVerificationReceipt,
  type FrozenVerificationSubject,
  type ProjectFrozenOptions,
} from './frozen.ts'

export type {
  ConversionAssessment,
  ConversionContract,
  EvidenceInput,
  EvidenceInputMap,
  ManifestCoverage,
  PackageManifestEvidence,
  PinnedTargetRequest,
  PmConfigEvidence,
  ProjectEvidenceInput,
  RequirementAssessment,
  RequirementStatus,
  TargetInput,
  TargetOracleEvidence,
  TargetRequest,
  Verification,
} from './assessment.ts'

export {
  defaultFetch,
  frozenRegistry,
  liveRegistry,
  resolveRegistry,
  type ArtifactRoute,
  type AuditOptions,
  type Fetch,
  type Limiter,
  type LiveRegistryAdapter,
  type LiveRegistryConfigOptions,
  type LiveRegistryDirectOptions,
  type LiveRegistryDiscoveryOptions,
  type Ecosystem,
  type LiveRegistryOptions,
  type Packument,
  type PackumentVersion,
  type RawAdvisory,
  type RegistryAdapter,
  type RegistryConfig,
  type RegistryConfigDialect,
  type RemoteArtifactRegistry,
  type ResolveRegistryOptions,
} from './registry.ts'

export { modify } from './modify.ts'
export type {
  ApplyPatchSpec,
  GraphFrontier,
  Modification,
  ModifyOptions,
  ModifyResult,
  ReplaceVersionSelector,
} from './modify.ts'

export {
  removeUnreachable,
  type RemoveUnreachableOptions,
  type RemoveUnreachableResult,
} from './optimize.ts'
export {
  enrich,
  type EnrichOptions,
  type EnrichResult,
} from './enrich.ts'
export {
  refurbish,
  type ArtifactResourceLimits,
  type ArtifactResourcePolicy,
  type NpmTarballSource,
  type RefurbishOptions,
  type RefurbishResult,
  type RefurbishSources,
  type TarballSource,
  type YarnBerryChecksumSource,
} from './refurbish.ts'
export type {
  ArtifactCacheSpecifier,
  ArtifactSourceList,
} from './operation.ts'
export {
  lockgraphStore,
} from '../../enrich/artifact-store.ts'
export type {
  Store,
} from '../../enrich/artifact-store.ts'

export {
  assertSource,
  overrideSource,
  parseSourceRule,
  type AssertSourceResult,
  type OverrideSourceResult,
  type SourceCounts,
  type SourceLocalReason,
  type SourceOperationOptions,
  type SourceResultItem,
  type SourceRule,
  type SourceRuleKind,
  type SourceRuleSelectorType,
  type SourceStatus,
} from './source.ts'
