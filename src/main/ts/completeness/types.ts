import type {
  Diagnostic,
  EdgeKind,
  Graph,
  Manifest,
  OverrideConstraint,
  TarballKey,
} from '../graph.ts'
import type { FormatId } from '../index.ts'

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
  readonly manifests: Readonly<Record<TarballKey, Manifest>>
}

export interface TargetRequest {
  readonly format: FormatId
  readonly managerVersion?: string
}

export interface PinnedTargetRequest extends TargetRequest {
  readonly managerVersion: string
}

export type OracleVerification = Exclude<Verification, 'unverified' | 'graph-validated'>

export interface TargetOracleEvidence {
  readonly kind: 'target-oracle'
  readonly graph: Graph
  readonly target: PinnedTargetRequest
  readonly verification: OracleVerification
  readonly platform: string
  readonly configDigest: string
  readonly inputDigest: string
}

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

export interface AssessedOutput {
  readonly output?: string
  readonly assessment: ConversionAssessment
}
