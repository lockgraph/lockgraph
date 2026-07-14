import type {
  Diagnostic,
  EdgeKind,
  Graph,
  Manifest,
  OverrideConstraint,
  PackageMetadataField,
  TarballKey,
} from '../graph.ts'
import type { FormatId } from '../api/format-contract.ts'
import type { ConvertInput, ConvertOptions } from '../convert/types.ts'
import type { PackumentVersion } from '../registry/types.ts'

export type Knowledge = 'none' | 'partial' | 'complete'

/** Authority over the override and redirect surface. */
export type PolicyKnowledge = 'none' | 'outcome-only' | 'normalized' | 'authored'

export type PeerKnowledge = 'none' | 'declared' | 'resolved' | 'virtualized'

export type LayoutKnowledge =
  | 'none'
  | 'hints'
  | 'source-native-encoded'
  | 'synthesized-by-consumer'

export type ArtifactKnowledge = 'none' | 'identified' | 'metadata' | 'bytes' | 'verified'

export type Verification =
  | 'unverified'
  | 'graph-validated'
  | 'target-parse-accepted'
  | 'mutable-stable'
  | 'frozen-verified'

export interface CompletenessProfile {
  projectTopology:  Knowledge
  resolvedGraph:    Knowledge
  edgeKinds:        Knowledge
  peerModel:        PeerKnowledge
  resolutionPolicy: PolicyKnowledge
  packageMetadata:  Knowledge
  artifacts:        ArtifactKnowledge
  layout:           LayoutKnowledge
  verification:     Verification
}

export type CompletenessDimension = keyof CompletenessProfile

export interface StructuralCoverage extends CompletenessProfile {}

export interface SourceCapabilityResult {
  readonly floor: Readonly<CompletenessProfile>
  readonly ambiguousDimensions: ReadonlySet<CompletenessDimension>
}

export type EvidenceKind =
  | 'lockfile'
  | 'repository-manifest'
  | 'pm-config'
  | 'abbreviated-packument'
  | 'full-packument'
  | 'version-manifest'
  | 'tarball-manifest'
  | 'artifact-bytes'
  | 'patch-file'
  | 'local-directory'
  | 'installed-state'
  | 'inference'
  | 'target-oracle'

export interface EvidenceRef {
  readonly kind: EvidenceKind
  readonly subject?: string
  readonly source?: string
  readonly digest?: string
  readonly coverage?: ManifestCoverage
  readonly presence?: 'present' | 'absent'
  readonly manager?: Readonly<{
    name: string
    version: string
  }>
  readonly target?: PinnedTargetRequest
  readonly platform?: string
  readonly configDigest?: string
  readonly inputDigest?: string
  readonly projectionDigest?: string
  readonly verification?: OracleVerification
}

export type TargetManager = 'npm' | 'yarn' | 'pnpm' | 'bun' | 'lockgraph'

export interface EvidenceLedger {
  readonly source?: Readonly<{
    format: FormatId
    manager: TargetManager
    version?: string
  }>
  readonly refs: readonly EvidenceRef[]
  readonly diagnostics: readonly Diagnostic[]
}

declare const evidenceContextBrand: unique symbol

/** Immutable evidence handle. Payloads are retained outside the public ledger. */
export interface EvidenceContext {
  readonly ledger: EvidenceLedger
  readonly [evidenceContextBrand]: true
}

export type ManifestCoverage = 'partial' | 'complete'

export interface RepositoryManifestEvidence {
  readonly kind: 'repository-manifests'
  readonly manifests: Readonly<Record<string, Manifest>>
  readonly coverage: ManifestCoverage
}

export interface PmConfigEvidence {
  readonly kind: 'pm-config'
  readonly manager: Exclude<TargetManager, 'lockgraph'>
  readonly version: string
  readonly source: string
  readonly surface: 'overrides'
  readonly coverage: 'complete'
  readonly overrides: readonly OverrideConstraint[]
}

export interface PackageManifestEvidence {
  readonly kind: 'package-manifests'
  readonly authority: 'full-packument' | 'version-manifest' | 'tarball-manifest'
  readonly manifests: Readonly<Record<TarballKey, PackumentVersion>>
}

export interface TargetRequest {
  readonly format: FormatId
  readonly managerVersion?: string
}

export interface PinnedTargetRequest extends TargetRequest {
  readonly managerVersion: string
}

export type OracleVerification = Exclude<Verification, 'unverified' | 'graph-validated'>

interface TargetOracleEvidenceBase {
  readonly kind: 'target-oracle'
  readonly graph: Graph
  readonly target: PinnedTargetRequest
  readonly platform: string
  readonly configDigest: string
  readonly inputDigest: string
}

export type TargetOracleEvidence = TargetOracleEvidenceBase & (
  | Readonly<{
      readonly verification: 'frozen-verified'
      /** Exact emitted lock + companion projection verified by the frozen oracle. */
      readonly projectionDigest: string
    }>
  | Readonly<{
      readonly verification: Exclude<OracleVerification, 'frozen-verified'>
      readonly projectionDigest?: never
    }>
)

export type EvidenceInput =
  | RepositoryManifestEvidence
  | PmConfigEvidence
  | PackageManifestEvidence
  | TargetOracleEvidence

export interface CompletenessContext {
  readonly evidence?: EvidenceContext
}

/**
 * Result of `completenessOf`. It describes canonical graph completeness, not
 * conversion readiness. Use `stringifyAssessed` or `convertAssessed` before
 * writing a target lockfile.
 */
export interface CompletenessResult {
  readonly profile: Readonly<CompletenessProfile>
  readonly structural: Readonly<StructuralCoverage>
  readonly evidence: EvidenceContext
  readonly diagnostics: readonly Diagnostic[]
}

export type CompletenessDiagnosticCode =
  | 'COMPLETENESS_EVIDENCE_CONFLICT'
  | 'COMPLETENESS_EVIDENCE_SCOPE_MISMATCH'
  | 'COMPLETENESS_FEATURE_UNMODELED'
  | 'COMPLETENESS_MANAGER_GENERATION_AMBIGUOUS'
  | 'COMPLETENESS_PACKAGE_METADATA_INCOMPLETE'
  | 'COMPLETENESS_PACKAGE_METADATA_MISMATCH'
  | 'COMPLETENESS_PACKAGE_METADATA_SOURCE_UNSUPPORTED'

export interface CompletenessDiagnostic extends Diagnostic {
  code: CompletenessDiagnosticCode
}

export type TargetPeerRepresentation = 'none' | 'declared' | 'resolved' | 'virtualized'
export type TargetIntegrityFamily = 'none' | 'tarball-sri' | 'berry-zip' | 'canonical'
export type TargetLayoutCapability = 'none' | 'encoded' | 'generated'
export type OverrideConfigLocation = 'none' | 'manifest' | 'workspace-yaml'
export type OverrideGrammar = 'none' | 'npm-nested' | 'yarn-selective' | 'pnpm-flat' | 'bun-flat'

export interface ResolvedTargetCapabilities {
  readonly edgeKinds: ReadonlySet<EdgeKind>
  readonly workspaces: boolean
  readonly workspaceProtocol: boolean
  readonly peerRepresentation: TargetPeerRepresentation
  readonly patches: boolean
  readonly bundledDependencies: boolean
  readonly conditions: boolean
  readonly catalogs: boolean
  readonly integrity: TargetIntegrityFamily
  readonly layout: TargetLayoutCapability
  readonly lockOverridesCarrier: boolean
  readonly overridesConfigLocation: OverrideConfigLocation
  readonly comparesOverridesInFrozen: boolean
  readonly overridesGrammar: OverrideGrammar
  readonly metadataFields: ReadonlySet<PackageMetadataField>
}

export type TargetCapability = keyof ResolvedTargetCapabilities

export interface TargetProfile {
  readonly manager: TargetManager
  readonly format: FormatId
  readonly managerVersion?: string
  readonly capabilities: Readonly<ResolvedTargetCapabilities>
  readonly ambiguousCapabilities: ReadonlySet<TargetCapability>
  readonly provenance: 'builtin'
}

export type ConversionContract = 'snapshot' | 'policy' | 'project' | 'frozen'
export type RequirementStatus = 'satisfied' | 'unsatisfied' | 'unassessed'

export interface RequirementAssessment {
  readonly key: string
  readonly dimension?: CompletenessDimension
  readonly status: RequirementStatus
  readonly diagnostics: readonly Diagnostic[]
}

export interface ConversionAssessment {
  readonly status: RequirementStatus
  readonly contract: ConversionContract
  readonly source: SourceCapabilityResult
  readonly target: TargetProfile
  readonly completeness: CompletenessResult
  readonly requirements: readonly RequirementAssessment[]
  readonly diagnostics: readonly Diagnostic[]
}

export interface AssessmentOptions {
  readonly contract: ConversionContract
  readonly target: TargetRequest
  readonly evidence?: EvidenceContext
}

export interface StringifyAssessedOptions extends AssessmentOptions {
  readonly lineEnding?: 'lf' | 'crlf'
  readonly cacheKey?: string
}

export interface ConvertAssessedOptions {
  readonly to: FormatId
  readonly from?: FormatId
  readonly workspaceRoot?: string
  readonly manifests?: Readonly<Record<string, Manifest>>
  readonly lineEnding?: 'lf' | 'crlf'
  readonly cacheKey?: string
  readonly onDiagnostic?: (diagnostic: Diagnostic) => void
  readonly contract: ConversionContract
  readonly sourceVersion?: string
  readonly targetVersion?: string
  readonly manifestCoverage?: ManifestCoverage
}

export type ProjectEvidenceInput =
  | RepositoryManifestEvidence
  | PmConfigEvidence
  | PackageManifestEvidence

export interface ConvertProjectOptions extends Omit<ConvertAssessedOptions, 'contract'> {
  readonly evidenceInputs?: readonly ProjectEvidenceInput[]
}

export interface AssessedOutput {
  readonly output?: string
  readonly assessment: ConversionAssessment
}

export interface ProjectConversionResult {
  readonly lockfile?: string
  readonly companions?: readonly CompanionSetOperation[]
  readonly assessment: ConversionAssessment
}

export interface FrozenVerificationSubject {
  readonly protocol: 'lockgraph-frozen-projection/v1'
  readonly target: PinnedTargetRequest
  readonly projectionDigest: string
}

/**
 * An emitted challenge for a native PM. This is not a certified conversion.
 * Values are created by `prepareFrozen`; callers cannot construct a candidate
 * that `certifyFrozen` will accept.
 */
export interface FrozenCandidate extends FrozenVerificationSubject {
  readonly lockfile: string
  readonly companions: readonly CompanionSetOperation[]
  readonly assessment: ConversionAssessment
}

export interface FrozenPreparationResult {
  readonly candidate?: FrozenCandidate
  readonly assessment: ConversionAssessment
}

export interface FrozenVerificationReceipt extends FrozenVerificationSubject {
  readonly verification: 'frozen-verified'
  readonly platform: string
  readonly configDigest: string
  readonly inputDigest: string
  readonly oracle: Readonly<{
    readonly protocol: 'lockgraph-native-frozen/v1'
    readonly runner: string
    readonly version: string
  }>
}

export interface FrozenConversionResult {
  readonly lockfile?: string
  readonly companions?: readonly CompanionSetOperation[]
  readonly verification?: FrozenVerificationReceipt
  readonly assessment: ConversionAssessment
}

export interface FrozenPreparationOptions extends Omit<ConvertOptions, 'strict' | 'targetVersion'> {
  readonly targetVersion: string
  readonly sourceVersion?: string
  readonly manifestCoverage?: ManifestCoverage
  readonly evidenceInputs?: readonly ProjectEvidenceInput[]
}

export type FrozenInput = ConvertInput

export interface ProjectCompanionOptions {
  readonly target: TargetRequest
  readonly evidence?: EvidenceContext
}

export interface CompanionSetOperation {
  readonly path: 'package.json' | 'pnpm-workspace.yaml'
  readonly op: 'set'
  readonly pointer: string
  readonly value: Readonly<Record<string, unknown>>
}

export interface ProjectCompanionResult {
  readonly patches?: readonly CompanionSetOperation[]
  readonly requirement: RequirementAssessment
  readonly target: TargetProfile
  readonly diagnostics: readonly Diagnostic[]
}
