import {
  stripPeerContextFromNodeId,
  toTarballKey,
  type Diagnostic,
  type DependencyManifest,
  type Graph,
  type GraphResult,
  type Manifest,
  type OverrideConstraint,
  type TarballKey,
} from '../graph.ts'
import type { FormatId } from '../api/format-contract.ts'
import { LockfileError } from '../api/errors.ts'
import {
  normalizeGuardProfiles,
  type FileSource,
  type OperationSources,
  type ProjectionOptions,
} from '../api/operation.ts'
import { rebindFormatAdapterState } from '../api/format-registry.ts'
import { completeTransitives } from '../complete/tree-complete.ts'
import {
  descriptorBindingsForTarget,
  packageVariantBindingsForTarget,
} from '../complete/descriptor-bindings.ts'
import {
  deriveEnrichedEvidence,
  evidenceOf,
  internalEvidenceOf,
  packageDependencyFactsEqual,
  withEvidence,
  type EnrichmentDerivationPhase,
  type InternalEvidenceState,
} from '../completeness/evidence.ts'
import {
  manifestExtensionDependencyMismatchDiagnostic,
} from '../completeness/diagnostics.ts'
import {
  completionPolicyAuthorityOf,
  type CompletionPolicyAuthority,
} from '../completeness/profile.ts'
import { targetProfileOf, targetRequestOf } from '../completeness/targets.ts'
import type {
  ConversionContract,
  EvidenceContext,
  EvidenceRef,
  PackageManifestEvidence,
  PmConfigEvidence,
} from '../completeness/types.ts'
import type { Packument, PackumentVersion, RegistryAdapter } from '../registry/types.ts'
import {
  PACKAGE_METADATA_FIELDS,
  packageMetadataEqual,
  packageMetadataOfPayload,
  payloadOfPackumentVersion,
  type PackageMetadataPayload,
} from '../registry/payload.ts'
import { integrityEquivalent } from '../recipe/integrity.ts'
import type { ArtifactResourcePolicy } from '../recipe/artifact-envelope.ts'
import * as bunText from '../formats/bun-text.ts'
import * as npm1 from '../formats/npm-1.ts'
import * as npm2 from '../formats/npm-2.ts'
import * as npm3 from '../formats/npm-3.ts'
import * as npm4 from '../formats/npm-4.ts'
import * as pnpmV5 from '../formats/pnpm-v5.ts'
import * as pnpmV6 from '../formats/pnpm-v6.ts'
import * as pnpmV9 from '../formats/pnpm-v9.ts'
import * as yarnBerryV4 from '../formats/yarn-berry-v4.ts'
import * as yarnBerryV5 from '../formats/yarn-berry-v5.ts'
import * as yarnBerryV6 from '../formats/yarn-berry-v6.ts'
import * as yarnBerryV7 from '../formats/yarn-berry-v7.ts'
import * as yarnBerryV8 from '../formats/yarn-berry-v8.ts'
import * as yarnBerryV9 from '../formats/yarn-berry-v9.ts'
import * as yarnBerryV10 from '../formats/yarn-berry-v10.ts'
import * as yarnClassic from '../formats/yarn-classic.ts'
import {
  enrichAdapterStateInvalidated,
  enrichOverrideAuthority,
} from './diagnostics.ts'
import { hydrateMetadata } from './hydrate-metadata.ts'
import {
  berryCacheKeyFor,
  refurbish,
} from './refurbish.ts'
import {
  normalizeArtifactSources,
  type ArtifactSourcesInput,
} from './artifact-sources.ts'
import { artifactTarballSource } from './artifact-bytes.ts'
import {
  operationArtifactStore,
} from './artifact-store.ts'
import {
  materializeYarnBerryPluginCompat,
  yarnBerryPluginCompatRegistry,
} from './yarn-berry-plugin-compat.ts'
import { projectYarnBerryDerivedDependencies } from './yarn-berry-derived-dependencies.ts'
import {
  prepareManifestSource,
  type PreparedManifestSource,
} from '../convert/input.ts'

// === ENRICHMENT CONTRACT ====================================================

export interface EnrichSources extends Omit<OperationSources, 'artifacts' | 'manifests'> {
  readonly manifests?: FileSource | Readonly<Record<string, Manifest>>
  /** @deprecated Use packuments. */
  readonly registry?: RegistryAdapter
  readonly artifacts?: ArtifactSourcesInput
  /** @deprecated Use policy. */
  readonly config?: PmConfigEvidence
}

export type EnrichOptions = Omit<ProjectionOptions, 'sources'> & Readonly<{
  readonly sources?: EnrichSources
  readonly contract?: ConversionContract
  readonly cacheKey?: string
  readonly workspaceRoot?: string
  /** Mandatory-on artifact safety envelope. Callers may tune the implementation
   * ceilings globally or for an exact TarballKey; verification/accounting cannot
   * be disabled. */
  readonly artifactResources?: ArtifactResourcePolicy
}>

export interface EnrichResult extends GraphResult {}

function isFileSource(
  source: FileSource | Readonly<Record<string, Manifest>>,
): source is FileSource {
  return Array.isArray(source) || Object.values(source).every(value =>
    typeof value === 'string' || value instanceof Uint8Array)
}

async function operationManifests(
  source: EnrichSources['manifests'],
  format: FormatId,
  cwd: string,
): Promise<PreparedManifestSource | undefined> {
  if (source === undefined) return undefined
  if (isFileSource(source)) return prepareManifestSource(source, format, cwd)
  return {
    manifests: source,
    coverage: 'partial',
    diagnostics: [],
  }
}

interface SourceAdapterContext {
  readonly manifests: Record<string, DependencyManifest> | undefined
  readonly overrides: readonly OverrideConstraint[]
}

interface SourceAdapterContract {
  readonly enrich: (
    graph: Graph,
    context: SourceAdapterContext,
  ) => GraphResult
}

interface MemoizedRegistry {
  readonly adapter: RegistryAdapter
  readonly packuments: ReadonlyMap<string, Promise<Packument | undefined>>
  readonly resolutionNames: ReadonlySet<string>
  manifest(name: string, version: string): Promise<PackumentVersion | undefined>
  hasManifest(): boolean
}

function orderedRegistry(
  sources: EnrichSources,
): RegistryAdapter | undefined {
  if (sources.packuments !== undefined && sources.registry !== undefined) {
    throw new LockfileError({
      code: 'INVALID_INPUT',
      message: 'sources.packuments cannot be combined with legacy sources.registry',
    })
  }
  const registries = sources.packuments
    ?? (sources.registry === undefined ? [] : [sources.registry])
  if (registries.length === 0) return undefined
  if (registries.length === 1) return registries[0]

  const first = async <Value>(
    read: (registry: RegistryAdapter) => Promise<Value | undefined>,
  ): Promise<Value | undefined> => {
    for (const registry of registries) {
      const value = await read(registry)
      if (value !== undefined) return value
    }
    return undefined
  }
  const ordered: RegistryAdapter = {
    packument: (name: string) => first(registry => registry.packument(name)),
    resolve: (name: string, range: string) => first(registry => registry.resolve(name, range)),
    manifest: (name: string, version: string) => first(registry =>
      registry.manifest?.(name, version) ?? Promise.resolve(undefined)),
  }
  return Object.freeze(ordered)
}

// === REGISTRY MEMOIZATION ===================================================

const packageConflictDimensions = new Set([
  'resolvedGraph',
  'edgeKinds',
  'peerModel',
  'packageMetadata',
  'artifacts',
])

function memoizeRegistry(registry: RegistryAdapter): MemoizedRegistry {
  const packuments = new Map<string, Promise<Packument | undefined>>()
  const resolutions = new Map<string, Promise<PackumentVersion | undefined>>()
  const manifests = new Map<string, Promise<PackumentVersion | undefined>>()
  const resolutionNames = new Set<string>()
  const packument = (name: string): Promise<Packument | undefined> => {
    let result = packuments.get(name)
    if (result === undefined) {
      result = registry.packument(name)
      packuments.set(name, result)
    }
    return result
  }
  const resolve = (name: string, range: string): Promise<PackumentVersion | undefined> => {
    resolutionNames.add(name)
    const key = `${name}\0${range}`
    let result = resolutions.get(key)
    if (result === undefined) {
      result = registry.resolve(name, range)
      resolutions.set(key, result)
    }
    return result
  }
  const manifest = (name: string, version: string): Promise<PackumentVersion | undefined> => {
    if (registry.manifest === undefined) return Promise.resolve(undefined)
    const key = `${name}\0${version}`
    let result = manifests.get(key)
    if (result === undefined) {
      result = registry.manifest(name, version)
      manifests.set(key, result)
    }
    return result
  }
  const adapter: RegistryAdapter = {
    packument,
    resolve,
    ...(registry.manifest === undefined ? {} : { manifest }),
    ...(registry.limit === undefined ? {} : { limit: registry.limit }),
  }
  return {
    adapter,
    packuments,
    resolutionNames,
    manifest,
    hasManifest: () => registry.manifest !== undefined,
  }
}

// === SOURCE ADAPTERS ========================================================

function mutableValue<T>(value: T): T {
  if (Array.isArray(value)) return value.map(item => mutableValue(item)) as T
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .map(([key, item]) => [key, mutableValue(item)])) as T
  }
  return value
}

function mutableManifests(
  manifests: Readonly<Record<string, DependencyManifest>> | undefined,
): Record<string, DependencyManifest> | undefined {
  return manifests === undefined ? undefined : mutableValue(manifests)
}

const SOURCE_ADAPTER_REGISTRY: Readonly<Record<FormatId, SourceAdapterContract>> = {
  'bun-text': {
    enrich(graph, { manifests }) {
      const manifestOptions = manifests === undefined ? {} : { manifests }
      return bunText.enrich(graph, manifestOptions)
    },
  },
  'bun-text-v2': {
    enrich(graph, { manifests }) {
      const manifestOptions = manifests === undefined ? {} : { manifests }
      return bunText.enrich(graph, manifestOptions)
    },
  },
  'deno-v2': { enrich: graph => ({ graph, diagnostics: [] }) },
  'deno-v3': { enrich: graph => ({ graph, diagnostics: [] }) },
  'deno-v4': { enrich: graph => ({ graph, diagnostics: [] }) },
  'deno-v5': { enrich: graph => ({ graph, diagnostics: [] }) },
  'npm-1': {
    enrich(graph, { manifests }) {
      const manifestOptions = manifests === undefined ? {} : { manifests }
      return npm1.enrich(graph, manifestOptions)
    },
  },
  'npm-2': { enrich: graph => npm2.enrich(graph) },
  'npm-3': { enrich: graph => npm3.enrich(graph) },
  'npm-4': { enrich: graph => npm4.enrich(graph) },
  'pnpm-v5': {
    enrich(graph, { manifests }) {
      const manifestOptions = manifests === undefined ? {} : { manifests }
      return pnpmV5.enrich(graph, manifestOptions)
    },
  },
  'pnpm-v6': {
    enrich(graph, { manifests }) {
      const manifestOptions = manifests === undefined ? {} : { manifests }
      return pnpmV6.enrich(graph, manifestOptions)
    },
  },
  'pnpm-v9': {
    enrich(graph, { manifests }) {
      const manifestOptions = manifests === undefined ? {} : { manifests }
      return pnpmV9.enrich(graph, manifestOptions)
    },
  },
  'yarn-berry-v4': { enrich: graph => yarnBerryV4.enrich(graph) },
  'yarn-berry-v5': { enrich: graph => yarnBerryV5.enrich(graph) },
  'yarn-berry-v6': { enrich: graph => yarnBerryV6.enrich(graph) },
  'yarn-berry-v7': { enrich: graph => yarnBerryV7.enrich(graph) },
  'yarn-berry-v8': { enrich: graph => yarnBerryV8.enrich(graph) },
  'yarn-berry-v9': { enrich: graph => yarnBerryV9.enrich(graph) },
  'yarn-berry-v10': { enrich: graph => yarnBerryV10.enrich(graph) },
  'yarn-classic': {
    enrich(graph, { manifests, overrides }) {
      const manifestOptions = manifests === undefined ? {} : { manifests }
      return yarnClassic.enrich(graph, undefined, {
        ...manifestOptions,
        overrides,
      })
    },
  },
  lockgraph: { enrich: graph => ({ graph, diagnostics: [] }) },
}

function sourceAdapterEnrich(
  format: FormatId,
  graph: Graph,
  manifests: Record<string, DependencyManifest> | undefined,
  overrides: readonly OverrideConstraint[],
): GraphResult {
  return SOURCE_ADAPTER_REGISTRY[format].enrich(graph, { manifests, overrides })
}

// === EVIDENCE COLLECTION ====================================================

function appendEvidenceDiagnostics(
  diagnostics: Diagnostic[],
  before: EvidenceContext,
  after: EvidenceContext,
): void {
  diagnostics.push(...after.ledger.diagnostics.slice(before.ledger.diagnostics.length))
}

function landDiagnostics(graph: Graph, diagnostics: readonly Diagnostic[]): Graph {
  if (diagnostics.length === 0) return graph
  return graph.mutate(mutator => {
    for (const diagnostic of diagnostics) mutator.diagnostic(diagnostic)
  }).graph
}

function packageConflictDiagnostic(
  subject: string,
  sources: readonly string[] = ['abbreviated-packument', 'package-manifest'],
): Diagnostic {
  return {
    code: 'COMPLETENESS_EVIDENCE_CONFLICT',
    severity: 'warning',
    subject,
    message: 'registry package facts conflict with authoritative package evidence',
    data: { dimension: 'resolvedGraph', sources: [...sources] },
  }
}

type RegistryPackageConflictKind = 'dependency-set' | 'authoritative'

function registryPackageConflictKind(
  abbreviated: PackumentVersion,
  exact: PackumentVersion,
): RegistryPackageConflictKind | undefined {
  if (abbreviated.name !== exact.name || abbreviated.version !== exact.version) {
    return 'authoritative'
  }
  if (abbreviated.tarball !== undefined && exact.tarball !== undefined
    && abbreviated.tarball !== exact.tarball) return 'authoritative'
  if (abbreviated.integrity !== undefined && exact.integrity !== undefined
    && !integrityEquivalent(abbreviated.integrity, exact.integrity)) return 'authoritative'

  const left = packageMetadataOfPayload(payloadOfPackumentVersion(abbreviated))
  const right = packageMetadataOfPayload(payloadOfPackumentVersion(exact))
  const leftShared: Partial<PackageMetadataPayload> = {}
  const rightShared: Partial<PackageMetadataPayload> = {}
  for (const field of PACKAGE_METADATA_FIELDS) {
    if (field === 'peerDependencies' || field === 'peerDependenciesMeta') continue
    if (left[field] === undefined || right[field] === undefined) continue
    Object.assign(leftShared, { [field]: left[field] })
    Object.assign(rightShared, { [field]: right[field] })
  }
  if (!packageMetadataEqual(
    leftShared as PackageMetadataPayload,
    rightShared as PackageMetadataPayload,
  )) return 'authoritative'
  return packageDependencyFactsEqual(abbreviated, exact)
    ? undefined
    : 'dependency-set'
}

function hasManifestExtensions(state: InternalEvidenceState): boolean {
  return state.observedManifestKnowledge?.knowledge !== undefined
}

async function resolutionConflicts(
  graph: Graph,
  registry: MemoizedRegistry,
  state: InternalEvidenceState,
): Promise<Readonly<{
  conflicts: readonly Diagnostic[]
  diagnostics: readonly Diagnostic[]
}>> {
  const conflicts: Diagnostic[] = []
  const diagnostics: Diagnostic[] = []
  const seen = new Set<TarballKey>()
  for (const node of graph.nodes()) {
    if (node.workspacePath !== undefined || node.source !== undefined || node.patch !== undefined) continue
    const key = stripPeerContextFromNodeId(node.id)
    if (seen.has(key)) continue
    seen.add(key)
    const evidence = state.packageManifests.get(key)
    const pack = await registry.packuments.get(node.name)
    const candidate = pack?.versions[node.version]
    if (evidence === undefined || candidate === undefined) continue
    const kind = registryPackageConflictKind(candidate, evidence.manifest)
    if (kind === 'dependency-set' && hasManifestExtensions(state)) {
      diagnostics.push(manifestExtensionDependencyMismatchDiagnostic(
        key,
        ['abbreviated-packument', evidence.authority],
      ))
    } else if (kind !== undefined) {
      conflicts.push(packageConflictDiagnostic(key))
    }
  }
  return { conflicts, diagnostics }
}

async function registryManifestEvidence(
  graph: Graph,
  registry: MemoizedRegistry,
  state: InternalEvidenceState,
): Promise<Readonly<{
  evidence?: PackageManifestEvidence
  conflicts: readonly Diagnostic[]
  diagnostics: readonly Diagnostic[]
}>> {
  if (!registry.hasManifest()) return { conflicts: [], diagnostics: [] }
  const manifests: Record<TarballKey, PackumentVersion> = Object.create(null) as Record<TarballKey, PackumentVersion>
  const conflicts: Diagnostic[] = []
  const diagnostics: Diagnostic[] = []
  const subjects = new Map<TarballKey, Readonly<{ name: string; version: string }>>()
  for (const node of graph.nodes()) {
    if (node.workspacePath !== undefined || node.source !== undefined || node.patch !== undefined) continue
    subjects.set(toTarballKey(node), { name: node.name, version: node.version })
  }
  for (const key of [...subjects.keys()].sort()) {
    const subject = subjects.get(key)!
    const manifest = await registry.manifest(subject.name, subject.version)
    if (manifest === undefined) continue
    if (manifest.name !== subject.name || manifest.version !== subject.version) {
      conflicts.push(packageConflictDiagnostic(key, ['graph-subject', 'version-manifest']))
      continue
    }
    const packument = await registry.packuments.get(subject.name)
    const abbreviated = packument?.versions[subject.version]
    if (abbreviated !== undefined) {
      const kind = registryPackageConflictKind(abbreviated, manifest)
      if (kind === 'dependency-set' && hasManifestExtensions(state)) {
        diagnostics.push(manifestExtensionDependencyMismatchDiagnostic(
          key,
          ['abbreviated-packument', 'version-manifest'],
        ))
      } else if (kind !== undefined) {
        conflicts.push(packageConflictDiagnostic(key, ['abbreviated-packument', 'version-manifest']))
        continue
      }
    }
    manifests[key] = manifest
  }
  return {
    ...(Object.keys(manifests).length === 0 ? {} : {
      evidence: { kind: 'package-manifests' as const, authority: 'version-manifest' as const, manifests },
    }),
    conflicts,
    diagnostics,
  }
}

function packageEvidenceBatches(state: InternalEvidenceState): PackageManifestEvidence[] {
  const grouped = new Map<PackageManifestEvidence['authority'], Record<TarballKey, PackumentVersion>>()
  for (const [key, evidence] of state.packageManifests) {
    let manifests = grouped.get(evidence.authority)
    if (manifests === undefined) {
      manifests = Object.create(null) as Record<TarballKey, PackumentVersion>
      grouped.set(evidence.authority, manifests)
    }
    manifests[key] = evidence.manifest
  }
  const order: PackageManifestEvidence['authority'][] = [
    'full-packument',
    'version-manifest',
    'tarball-manifest',
  ]
  return order.flatMap(authority => {
    const manifests = grouped.get(authority)
    return manifests === undefined ? [] : [{ kind: 'package-manifests' as const, authority, manifests }]
  })
}

function hasPackageConflict(state: InternalEvidenceState): boolean {
  return state.conflicts.some(conflict => packageConflictDimensions.has(conflict.dimension))
}

function hasBerryChecksumGap(
  graph: Graph,
  targetCacheKey: string | undefined,
): boolean {
  for (const node of graph.nodes()) {
    if (node.workspacePath !== undefined) continue
    const payload = graph.tarballOf(node.id)
    const hashes = payload?.integrity?.hashes ?? []
    if (!hashes.some(hash => hash.origin === 'berry-zip')) return true
    if (targetCacheKey !== undefined
      && payload?.berryChecksumCacheKey !== undefined
      && payload.berryChecksumCacheKey !== targetCacheKey) return true
  }
  return false
}

function registryRefs(registry: MemoizedRegistry): EvidenceRef[] {
  return [...new Set([...registry.packuments.keys(), ...registry.resolutionNames])]
    .sort()
    .map(subject => ({ kind: 'abbreviated-packument' as const, subject }))
}

function artifactRefs(graph: Graph, enriched: readonly string[]): EvidenceRef[] {
  const refs: EvidenceRef[] = []
  for (const id of enriched) {
    const node = graph.getNode(id)
    if (node === undefined) continue
    const digest = graph.tarballOf(id)?.integrity?.hashes
      .find(hash => hash.origin === 'berry-zip')?.digest
    refs.push({
      kind: 'artifact-bytes',
      subject: toTarballKey(node),
      ...(digest === undefined ? {} : { digest }),
    })
  }
  return refs
}

// === ENRICHMENT ORCHESTRATION ===============================================

interface CollectedOperationEvidence {
  readonly context: EvidenceContext
  readonly manifestSource: PreparedManifestSource | undefined
  readonly diagnostics: readonly Diagnostic[]
}

async function collectOperationEvidence(
  baseEvidence: EvidenceContext,
  sources: EnrichSources,
  sourceFormat: FormatId | undefined,
  targetFormat: FormatId,
  workspaceRoot: string,
): Promise<CollectedOperationEvidence> {
  const diagnostics: Diagnostic[] = []
  const manifestSource = await operationManifests(
    sources.manifests,
    sourceFormat ?? targetFormat,
    workspaceRoot,
  )
  if (manifestSource !== undefined) diagnostics.push(...manifestSource.diagnostics)
  let context = baseEvidence
  if (manifestSource !== undefined) {
    const before = context
    context = withEvidence(context, {
      kind: 'repository-manifests',
      manifests: manifestSource.manifests,
      coverage: manifestSource.coverage,
    })
    appendEvidenceDiagnostics(diagnostics, before, context)
  }
  if (sources.policy !== undefined && sources.config !== undefined) {
    throw new LockfileError({
      code: 'INVALID_INPUT',
      message: 'sources.policy cannot be combined with legacy sources.config',
    })
  }
  const policyEvidence = sources.policy ?? sources.config
  if (policyEvidence !== undefined) {
    const before = context
    context = withEvidence(context, policyEvidence)
    appendEvidenceDiagnostics(diagnostics, before, context)
  }
  return { context, manifestSource, diagnostics }
}

interface SourceGraphProjection {
  readonly graph: Graph
  readonly stateSource: Graph
  readonly diagnostics: readonly Diagnostic[]
  readonly phases: readonly EnrichmentDerivationPhase[]
}

function projectSourceGraph(
  graph: Graph,
  sourceFormat: FormatId | undefined,
  targetRequest: ReturnType<typeof targetRequestOf>,
  manifests: Record<string, DependencyManifest> | undefined,
  policy: CompletionPolicyAuthority,
  policyDiagnostic: Diagnostic | undefined,
): SourceGraphProjection {
  const diagnostics: Diagnostic[] = []
  const phases: EnrichmentDerivationPhase[] = []
  let working = graph
  let stateSource = graph
  if (sourceFormat !== undefined) {
    const adapted = sourceAdapterEnrich(
      sourceFormat,
      graph,
      sourceFormat === 'yarn-classic' && policy.status !== 'known' ? undefined : manifests,
      policy.status === 'known' ? policy.overrides : [],
    )
    diagnostics.push(...adapted.diagnostics)
    phases.push({ kind: 'source-adapter', before: graph, after: adapted.graph })
    working = adapted.graph
    stateSource = adapted.graph
  }
  const sourceProjection = projectYarnBerryDerivedDependencies(
    working,
    sourceFormat,
    targetRequest,
  )
  if (sourceProjection.graph !== working) {
    phases.push({
      kind: 'target-compatibility',
      before: working,
      after: sourceProjection.graph,
      added: [],
      wired: [],
      unwired: sourceProjection.unwired,
      rooted: [...sourceProjection.graph.roots()]
        .filter(id => !working.roots().has(id)),
      unrooted: [...working.roots()]
        .filter(id => !sourceProjection.graph.roots().has(id)),
    })
    working = sourceProjection.graph
    stateSource = sourceProjection.graph
  }
  if (policyDiagnostic !== undefined) working = landDiagnostics(working, [policyDiagnostic])
  return { graph: working, stateSource, diagnostics, phases }
}

interface RegistryCompletionTransaction {
  readonly graph: Graph
  readonly context: EvidenceContext
  readonly diagnostics: readonly Diagnostic[]
  readonly evidenceDiagnostics: readonly Diagnostic[]
  readonly phases: readonly EnrichmentDerivationPhase[]
}

async function settleRegistryCompletion(
  graph: Graph,
  stateSource: Graph,
  context: EvidenceContext,
  registry: MemoizedRegistry | undefined,
  policy: CompletionPolicyAuthority,
  contract: ConversionContract,
  targetRequest: ReturnType<typeof targetRequestOf>,
): Promise<RegistryCompletionTransaction> {
  const diagnostics: Diagnostic[] = []
  const evidenceDiagnostics: Diagnostic[] = []
  const phases: EnrichmentDerivationPhase[] = []
  let working = graph
  let completionAccepted = false
  let completionDiagnostics: readonly Diagnostic[] = []
  let completionPhase: Extract<EnrichmentDerivationPhase, { kind: 'completion' }> | undefined
  const rollbackCompletion = (rollbackDiagnostics: readonly Diagnostic[]): void => {
    const index = completionPhase === undefined ? -1 : phases.indexOf(completionPhase)
    if (index >= 0) phases.splice(index, 1)
    working = landDiagnostics(stateSource, rollbackDiagnostics)
    completionAccepted = false
    completionDiagnostics = []
    completionPhase = undefined
  }

  if (registry !== undefined && policy.status === 'known') {
    const completed = await completeTransitives(working, registry.adapter, {
      overrides: policy.overrides,
      descriptorBindings: descriptorBindingsForTarget(working, targetRequest.format),
      packageVariants: packageVariantBindingsForTarget(working, targetRequest.format),
    })
    const conflictAssessment = await resolutionConflicts(
      completed.graph,
      registry,
      internalEvidenceOf(context),
    )
    diagnostics.push(...conflictAssessment.diagnostics)
    evidenceDiagnostics.push(...conflictAssessment.diagnostics)
    if (conflictAssessment.conflicts.length === 0) {
      completionPhase = {
        kind: 'completion',
        before: working,
        after: completed.graph,
        added: completed.added,
        wired: completed.wired,
      }
      phases.push(completionPhase)
      working = completed.graph
      completionAccepted = true
      completionDiagnostics = completed.unresolved
    } else {
      diagnostics.push(...conflictAssessment.conflicts)
      evidenceDiagnostics.push(...conflictAssessment.conflicts)
      working = landDiagnostics(working, conflictAssessment.conflicts)
    }
  }

  if (registry !== undefined && (contract === 'project' || contract === 'frozen')) {
    const observed = await registryManifestEvidence(
      working,
      registry,
      internalEvidenceOf(context),
    )
    diagnostics.push(...observed.diagnostics)
    evidenceDiagnostics.push(...observed.diagnostics)
    if (observed.conflicts.length > 0) {
      diagnostics.push(...observed.conflicts)
      evidenceDiagnostics.push(...observed.conflicts)
      if (completionAccepted) rollbackCompletion(observed.conflicts)
      else working = landDiagnostics(working, observed.conflicts)
    } else if (observed.evidence !== undefined) {
      const before = context
      const beforeConflicts = internalEvidenceOf(context).conflicts.length
      context = withEvidence(context, observed.evidence)
      appendEvidenceDiagnostics(diagnostics, before, context)
      if (internalEvidenceOf(context).conflicts.length > beforeConflicts
        && completionAccepted) {
        rollbackCompletion(context.ledger.diagnostics.slice(before.ledger.diagnostics.length))
      }
    }
  }

  if (completionAccepted) diagnostics.push(...completionDiagnostics)
  if (completionAccepted) {
    const before = working
    const materialized = materializeYarnBerryPluginCompat(before, targetRequest)
    if (materialized.graph !== before) {
      phases.push({
        kind: 'target-compatibility',
        before,
        after: materialized.graph,
        added: materialized.added,
        wired: materialized.wired,
        unwired: materialized.unwired,
        rooted: materialized.rooted,
        unrooted: materialized.unrooted,
      })
      working = materialized.graph
    }
  }
  return { graph: working, context, diagnostics, evidenceDiagnostics, phases }
}

interface MetadataHydration {
  readonly graph: Graph
  readonly diagnostics: readonly Diagnostic[]
  readonly phases: readonly EnrichmentDerivationPhase[]
}

function hydrateAuthoritativeMetadata(
  graph: Graph,
  context: EvidenceContext,
  contract: ConversionContract,
): MetadataHydration {
  if (hasPackageConflict(internalEvidenceOf(context))
    || (contract !== 'project' && contract !== 'frozen'
      && internalEvidenceOf(context).packageManifests.size === 0)) {
    return { graph, diagnostics: [], phases: [] }
  }
  const diagnostics: Diagnostic[] = []
  const phases: EnrichmentDerivationPhase[] = []
  let working = graph
  for (const authority of packageEvidenceBatches(internalEvidenceOf(context))) {
    const before = working
    const hydrated = hydrateMetadata(before, authority)
    diagnostics.push(...hydrated.diagnostics)
    phases.push({
      kind: 'metadata',
      before,
      after: hydrated.graph,
      hydrated: hydrated.hydrated,
    })
    working = hydrated.graph
  }
  return { graph: working, diagnostics, phases }
}

interface ArtifactEnrichment {
  readonly graph: Graph
  readonly diagnostics: readonly Diagnostic[]
  readonly phases: readonly EnrichmentDerivationPhase[]
  readonly enriched: readonly string[]
  readonly inferredCacheKey: string | undefined
}

async function enrichArtifacts(
  graph: Graph,
  target: ReturnType<typeof targetProfileOf>,
  targetRequest: ReturnType<typeof targetRequestOf>,
  requestedCacheKey: string | undefined,
  fallbackCacheKey: string | undefined,
  artifacts: ReturnType<typeof normalizeArtifactSources> | undefined,
  artifactResources: ArtifactResourcePolicy | undefined,
  maxNetworkTrafficBytes: number,
  networkTrafficOrigin: 'default' | 'global',
): Promise<ArtifactEnrichment> {
  if (target.capabilities.integrity !== 'berry-zip' || artifacts === undefined) {
    return {
      graph,
      diagnostics: [],
      phases: [],
      enriched: [],
      inferredCacheKey: undefined,
    }
  }
  const diagnostics: Diagnostic[] = []
  const artifactCacheKey = requestedCacheKey ?? fallbackCacheKey ?? berryCacheKeyFor(
    graph,
    targetRequest.format,
    'observed-only',
  )
  if (!hasBerryChecksumGap(graph, artifactCacheKey)) {
    return {
      graph,
      diagnostics,
      phases: [],
      enriched: [],
      inferredCacheKey: undefined,
    }
  }
  const npmTarballs = artifactTarballSource(
    artifacts,
    artifactResources,
    diagnostic => diagnostics.push(diagnostic),
    { maxBytes: maxNetworkTrafficBytes, origin: networkTrafficOrigin },
  )
  const refurbished = await refurbish(graph, targetRequest.format, {
    ...artifacts.refurbish,
    npmTarballs,
  }, {
    ...(artifactCacheKey === undefined ? {} : { cacheKey: artifactCacheKey }),
    cacheKeyInference: 'observed-only',
    artifactResources,
  })
  diagnostics.push(...refurbished.unresolved)
  const inferredCacheKey = requestedCacheKey === undefined
    && fallbackCacheKey === undefined
    && artifactCacheKey !== undefined
    && refurbished.enriched.length > 0
    ? artifactCacheKey
    : undefined
  return {
    graph: refurbished.graph,
    diagnostics,
    phases: [{
      kind: 'artifact',
      before: graph,
      after: refurbished.graph,
      enriched: refurbished.enriched,
    }],
    enriched: refurbished.enriched,
    inferredCacheKey,
  }
}

function commitEnrichment(
  original: Graph,
  graph: Graph,
  stateSource: Graph,
  sourceFormat: FormatId | undefined,
  baseEvidence: EvidenceContext,
  context: EvidenceContext,
  phases: readonly EnrichmentDerivationPhase[],
  refs: readonly EvidenceRef[],
  diagnostics: Diagnostic[],
  evidenceDiagnostics: readonly Diagnostic[],
  onDiagnostic: EnrichOptions['onDiagnostic'],
): EnrichResult {
  const evidenceChanged = context !== baseEvidence || refs.length > 0
  let working = graph
  if (working === original && (evidenceChanged || diagnostics.length > 0)) {
    working = working.mutate(() => {}).graph
  }

  let transferred = rebindFormatAdapterState(sourceFormat, stateSource, working)
  if (transferred.invalidated.length > 0) {
    const diagnostic = enrichAdapterStateInvalidated(
      sourceFormat ?? 'unknown',
      transferred.invalidated,
    )
    diagnostics.push(diagnostic)
    const withDiagnostic = landDiagnostics(transferred.graph, [diagnostic])
    transferred = rebindFormatAdapterState(sourceFormat, transferred.graph, withDiagnostic)
  }
  working = transferred.graph

  const changed = working !== original || evidenceChanged || diagnostics.length > 0
  if (changed) {
    deriveEnrichedEvidence(
      original,
      working,
      context,
      phases,
      refs,
      evidenceDiagnostics,
    )
  }
  const result = Object.freeze({
    graph: working,
    diagnostics: Object.freeze([...diagnostics]),
  })
  for (const diagnostic of result.diagnostics) onDiagnostic?.(diagnostic)
  return result
}

export function enrich(
  graph: Graph,
  options: EnrichOptions,
): Promise<EnrichResult>
/** @deprecated Move sources into options.sources. */
export function enrich(
  graph: Graph,
  sources: EnrichSources,
  options: Omit<EnrichOptions, 'sources'>,
): Promise<EnrichResult>
export async function enrich(
  graph: Graph,
  sourcesOrOptions: EnrichSources | EnrichOptions,
  legacyOptions?: Omit<EnrichOptions, 'sources'>,
): Promise<EnrichResult> {
  const legacy = arguments.length === 3
  const options = legacy
    ? legacyOptions!
    : sourcesOrOptions as EnrichOptions
  const sources = legacy
    ? sourcesOrOptions as EnrichSources
    : (sourcesOrOptions as EnrichOptions).sources ?? {}
  const contract = options.contract ?? 'snapshot'
  const normalizedGuards = normalizeGuardProfiles(options.guards)
  const artifactResources = options.guards === undefined
    ? options.artifactResources
    : normalizedGuards.artifactResources
  const workspaceRoot = options.cwd ?? options.workspaceRoot ?? process.cwd()
  const store = operationArtifactStore(options.store)
  const artifacts = sources.artifacts === undefined && store === undefined
    ? undefined
    : normalizeArtifactSources(sources.artifacts ?? [], {
        workspaceRoot,
        ...(store === undefined ? {} : { store }),
      })
  const targetRequest = targetRequestOf(options.target)
  const requestedCacheKey = 'cacheKey' in targetRequest
    ? targetRequest.cacheKey
    : undefined
  const target = targetProfileOf(targetRequest)
  const diagnostics: Diagnostic[] = []
  const evidenceDiagnostics: Diagnostic[] = []
  const phases: EnrichmentDerivationPhase[] = []
  const refs: EvidenceRef[] = []
  const baseEvidence = evidenceOf(graph)
  const sourceFormat = internalEvidenceOf(baseEvidence).source?.format
  const collected = await collectOperationEvidence(
    baseEvidence,
    sources,
    sourceFormat,
    targetRequest.format,
    workspaceRoot,
  )
  diagnostics.push(...collected.diagnostics)
  let context = collected.context
  const policy = completionPolicyAuthorityOf(internalEvidenceOf(context))
  const manifests = mutableManifests(collected.manifestSource?.manifests)
  const registryAuthority = orderedRegistry(sources)
  const needsPolicy = registryAuthority !== undefined
    || (sourceFormat === 'yarn-classic' && manifests !== undefined)
  const policyDiagnostic = policy.status === 'known' || !needsPolicy
    ? undefined
    : enrichOverrideAuthority(policy.status)
  if (policyDiagnostic !== undefined) diagnostics.push(policyDiagnostic)
  const sourceProjection = projectSourceGraph(
    graph,
    sourceFormat,
    targetRequest,
    manifests,
    policy,
    policyDiagnostic,
  )
  diagnostics.push(...sourceProjection.diagnostics)
  phases.push(...sourceProjection.phases)
  let working = sourceProjection.graph
  const stateSource = sourceProjection.stateSource

  const registry = registryAuthority === undefined
    ? undefined
    : yarnBerryPluginCompatRegistry(registryAuthority, targetRequest)
  const memoized = registry === undefined ? undefined : memoizeRegistry(registry)
  const completion = await settleRegistryCompletion(
    working,
    stateSource,
    context,
    memoized,
    policy,
    contract,
    targetRequest,
  )
  working = completion.graph
  context = completion.context
  diagnostics.push(...completion.diagnostics)
  evidenceDiagnostics.push(...completion.evidenceDiagnostics)
  phases.push(...completion.phases)

  const metadata = hydrateAuthoritativeMetadata(working, context, contract)
  working = metadata.graph
  diagnostics.push(...metadata.diagnostics)
  phases.push(...metadata.phases)

  const artifact = await enrichArtifacts(
    working,
    target,
    targetRequest,
    requestedCacheKey,
    options.cacheKey,
    artifacts,
    artifactResources,
    normalizedGuards.maxNetworkTrafficBytes,
    normalizedGuards.networkTrafficOrigin,
  )
  working = artifact.graph
  diagnostics.push(...artifact.diagnostics)
  phases.push(...artifact.phases)

  if (memoized !== undefined) refs.push(...registryRefs(memoized))
  if (artifact.inferredCacheKey !== undefined) {
    refs.push({
      kind: 'inference',
      subject: `berry-cache-key:${artifact.inferredCacheKey}`,
      source: 'graph-observation',
    })
  }
  refs.push(...artifactRefs(working, artifact.enriched))
  return commitEnrichment(
    graph,
    working,
    stateSource,
    sourceFormat,
    baseEvidence,
    context,
    phases,
    refs,
    diagnostics,
    evidenceDiagnostics,
    options.onDiagnostic,
  )
}
