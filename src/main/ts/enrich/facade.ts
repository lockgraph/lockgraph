import {
  stripPeerContextFromNodeId,
  toTarballKey,
  type Diagnostic,
  type Graph,
  type Manifest,
  type OverrideConstraint,
  type TarballKey,
} from '../graph.ts'
import type { FormatId } from '../api/format-contract.ts'
import { completeTransitives } from '../complete/tree-complete.ts'
import {
  deriveEnrichedEvidence,
  evidenceOf,
  internalEvidenceOf,
  packageResolutionFactsEqual,
  withEvidence,
  type EnrichmentDerivationPhase,
  type InternalEvidenceState,
} from '../completeness/evidence.ts'
import {
  completionPolicyAuthorityOf,
} from '../completeness/profile.ts'
import { targetProfileOf } from '../completeness/targets.ts'
import type {
  ConversionContract,
  EvidenceContext,
  EvidenceRef,
  PackageManifestEvidence,
  PmConfigEvidence,
  TargetRequest,
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
import * as bunText from '../formats/bun-text.ts'
import * as npm1 from '../formats/npm-1.ts'
import * as npm2 from '../formats/npm-2.ts'
import * as npm3 from '../formats/npm-3.ts'
import { rebindAdapterState as rebindNpmFlatState } from '../formats/_npm-core.ts'
import { rebindNpm2MirrorState } from '../formats/_npm-2-mirror.ts'
import * as pnpmV5 from '../formats/pnpm-v5.ts'
import * as pnpmV6 from '../formats/pnpm-v6.ts'
import * as pnpmV9 from '../formats/pnpm-v9.ts'
import { rebindAdapterState as rebindPnpmFlatState } from '../formats/_pnpm-flat-core.ts'
import * as yarnBerryV4 from '../formats/yarn-berry-v4.ts'
import * as yarnBerryV5 from '../formats/yarn-berry-v5.ts'
import * as yarnBerryV6 from '../formats/yarn-berry-v6.ts'
import * as yarnBerryV7 from '../formats/yarn-berry-v7.ts'
import * as yarnBerryV8 from '../formats/yarn-berry-v8.ts'
import * as yarnBerryV9 from '../formats/yarn-berry-v9.ts'
import * as yarnBerryV10 from '../formats/yarn-berry-v10.ts'
import { rebindAdapterState as rebindYarnBerryState } from '../formats/_yarn-berry-core.ts'
import * as yarnClassic from '../formats/yarn-classic.ts'
import {
  enrichAdapterStateInvalidated,
  enrichOverrideAuthority,
} from './diagnostics.ts'
import { hydrateMetadata } from './hydrate-metadata.ts'
import { berryCacheKeyFor, refurbish, type TarballSource } from './refurbish.ts'

export interface EnrichSources {
  readonly manifests?: Readonly<Record<string, Manifest>>
  readonly registry?: RegistryAdapter
  readonly artifacts?: TarballSource
  readonly config?: PmConfigEvidence
}

export interface EnrichOptions {
  readonly target: TargetRequest
  readonly contract: ConversionContract
  readonly cacheKey?: string
}

export interface EnrichResult {
  readonly graph: Graph
  readonly diagnostics: readonly Diagnostic[]
}

interface MemoizedRegistry {
  readonly adapter: RegistryAdapter
  readonly packuments: ReadonlyMap<string, Promise<Packument | undefined>>
  readonly resolutionNames: ReadonlySet<string>
  manifest(name: string, version: string): Promise<PackumentVersion | undefined>
  hasManifest(): boolean
}

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

function mutableValue<T>(value: T): T {
  if (Array.isArray(value)) return value.map(item => mutableValue(item)) as T
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .map(([key, item]) => [key, mutableValue(item)])) as T
  }
  return value
}

function mutableManifests(
  manifests: Readonly<Record<string, Manifest>> | undefined,
): Record<string, Manifest> | undefined {
  return manifests === undefined ? undefined : mutableValue(manifests)
}

function sourceAdapterEnrich(
  format: FormatId,
  graph: Graph,
  manifests: Record<string, Manifest> | undefined,
  overrides: readonly OverrideConstraint[],
): Readonly<{ graph: Graph; diagnostics: readonly Diagnostic[] }> {
  const manifestOptions = manifests === undefined ? {} : { manifests }
  switch (format) {
    case 'bun-text': return bunText.enrich(graph, manifestOptions)
    case 'npm-1': return npm1.enrich(graph, manifestOptions)
    case 'npm-2': return npm2.enrich(graph)
    case 'npm-3': return npm3.enrich(graph)
    case 'pnpm-v5': return pnpmV5.enrich(graph, manifestOptions)
    case 'pnpm-v6': return pnpmV6.enrich(graph, manifestOptions)
    case 'pnpm-v9': return pnpmV9.enrich(graph, manifestOptions)
    case 'yarn-berry-v4': return yarnBerryV4.enrich(graph)
    case 'yarn-berry-v5': return yarnBerryV5.enrich(graph)
    case 'yarn-berry-v6': return yarnBerryV6.enrich(graph)
    case 'yarn-berry-v7': return yarnBerryV7.enrich(graph)
    case 'yarn-berry-v8': return yarnBerryV8.enrich(graph)
    case 'yarn-berry-v9': return yarnBerryV9.enrich(graph)
    case 'yarn-berry-v10': return yarnBerryV10.enrich(graph)
    case 'yarn-classic': return yarnClassic.enrich(graph, undefined, {
      ...manifestOptions,
      overrides,
    })
    case 'lockgraph': return { graph, diagnostics: [] }
  }
}

function rebindSourceState(
  format: FormatId | undefined,
  source: Graph,
  target: Graph,
): Readonly<{ graph: Graph; invalidated: readonly string[] }> {
  if (format === undefined || format === 'lockgraph') return { graph: target, invalidated: [] }
  if (format === 'npm-1') return npm1.rebindAdapterState(source, target)
  if (format === 'npm-2') {
    const flat = rebindNpmFlatState(source, target)
    return {
      graph: flat.graph,
      invalidated: [...new Set([...flat.invalidated, ...rebindNpm2MirrorState(source, flat.graph)])].sort(),
    }
  }
  if (format === 'npm-3') return rebindNpmFlatState(source, target)
  if (format === 'pnpm-v5') return pnpmV5.rebindAdapterState(source, target)
  if (format === 'pnpm-v6' || format === 'pnpm-v9') return rebindPnpmFlatState(source, target)
  if (format === 'yarn-classic') return yarnClassic.rebindAdapterState(source, target)
  if (format.startsWith('yarn-berry-')) return rebindYarnBerryState(source, target)
  return bunText.rebindAdapterState(source, target)
}

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

function registryPackageFactsCompatible(
  abbreviated: PackumentVersion,
  exact: PackumentVersion,
): boolean {
  if (!packageResolutionFactsEqual(abbreviated, exact)) return false
  if (abbreviated.tarball !== undefined && exact.tarball !== undefined
    && abbreviated.tarball !== exact.tarball) return false
  if (abbreviated.integrity !== undefined && exact.integrity !== undefined
    && !integrityEquivalent(abbreviated.integrity, exact.integrity)) return false

  const left = packageMetadataOfPayload(payloadOfPackumentVersion(abbreviated))
  const right = packageMetadataOfPayload(payloadOfPackumentVersion(exact))
  const leftShared: Partial<PackageMetadataPayload> = {}
  const rightShared: Partial<PackageMetadataPayload> = {}
  for (const field of PACKAGE_METADATA_FIELDS) {
    if (left[field] === undefined || right[field] === undefined) continue
    Object.assign(leftShared, { [field]: left[field] })
    Object.assign(rightShared, { [field]: right[field] })
  }
  return packageMetadataEqual(
    leftShared as PackageMetadataPayload,
    rightShared as PackageMetadataPayload,
  )
}

async function resolutionConflicts(
  graph: Graph,
  registry: MemoizedRegistry,
  state: InternalEvidenceState,
): Promise<Diagnostic[]> {
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
    if (evidence !== undefined && candidate !== undefined
      && !registryPackageFactsCompatible(candidate, evidence.manifest)) {
      diagnostics.push(packageConflictDiagnostic(key))
    }
  }
  return diagnostics
}

async function registryManifestEvidence(
  graph: Graph,
  registry: MemoizedRegistry,
): Promise<Readonly<{
  evidence?: PackageManifestEvidence
  conflicts: readonly Diagnostic[]
}>> {
  if (!registry.hasManifest()) return { conflicts: [] }
  const manifests: Record<TarballKey, PackumentVersion> = Object.create(null) as Record<TarballKey, PackumentVersion>
  const conflicts: Diagnostic[] = []
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
    if (abbreviated !== undefined && !registryPackageFactsCompatible(abbreviated, manifest)) {
      conflicts.push(packageConflictDiagnostic(key, ['abbreviated-packument', 'version-manifest']))
      continue
    }
    manifests[key] = manifest
  }
  return {
    ...(Object.keys(manifests).length === 0 ? {} : {
      evidence: { kind: 'package-manifests' as const, authority: 'version-manifest' as const, manifests },
    }),
    conflicts,
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

function hasBerryChecksumGap(graph: Graph): boolean {
  for (const node of graph.nodes()) {
    if (node.workspacePath !== undefined) continue
    const hashes = graph.tarballOf(node.id)?.integrity?.hashes ?? []
    if (!hashes.some(hash => hash.origin === 'berry-zip')) return true
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

export async function enrich(
  graph: Graph,
  sources: EnrichSources,
  options: EnrichOptions,
): Promise<EnrichResult> {
  const target = targetProfileOf(options.target)
  const diagnostics: Diagnostic[] = []
  const evidenceDiagnostics: Diagnostic[] = []
  const phases: EnrichmentDerivationPhase[] = []
  const refs: EvidenceRef[] = []
  const baseEvidence = evidenceOf(graph)
  let context = baseEvidence

  if (sources.manifests !== undefined) {
    const before = context
    context = withEvidence(context, {
      kind: 'repository-manifests',
      manifests: sources.manifests,
      coverage: 'partial',
    })
    appendEvidenceDiagnostics(diagnostics, before, context)
  }
  if (sources.config !== undefined) {
    const before = context
    context = withEvidence(context, sources.config)
    appendEvidenceDiagnostics(diagnostics, before, context)
  }

  const sourceFormat = internalEvidenceOf(context).source?.format
  const policy = completionPolicyAuthorityOf(internalEvidenceOf(context))
  const manifests = mutableManifests(sources.manifests)
  const needsPolicy = sources.registry !== undefined
    || (sourceFormat === 'yarn-classic' && manifests !== undefined)
  const policyDiagnostic = policy.status === 'known' || !needsPolicy
    ? undefined
    : enrichOverrideAuthority(policy.status)
  if (policyDiagnostic !== undefined) diagnostics.push(policyDiagnostic)
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
  if (policyDiagnostic !== undefined) working = landDiagnostics(working, [policyDiagnostic])

  const memoized = sources.registry === undefined ? undefined : memoizeRegistry(sources.registry)
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
  if (memoized !== undefined) {
    if (policy.status === 'known') {
      const completed = await completeTransitives(working, memoized.adapter, {
        overrides: policy.overrides,
      })
      const conflicts = await resolutionConflicts(
        completed.graph,
        memoized,
        internalEvidenceOf(context),
      )
      if (conflicts.length === 0) {
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
        diagnostics.push(...conflicts)
        evidenceDiagnostics.push(...conflicts)
        working = landDiagnostics(working, conflicts)
      }
    }
  }

  if (memoized !== undefined && (options.contract === 'project' || options.contract === 'frozen')) {
    const observed = await registryManifestEvidence(working, memoized)
    if (observed.conflicts.length > 0) {
      diagnostics.push(...observed.conflicts)
      evidenceDiagnostics.push(...observed.conflicts)
      if (completionAccepted) {
        rollbackCompletion(observed.conflicts)
      } else {
        working = landDiagnostics(working, observed.conflicts)
      }
    } else if (observed.evidence !== undefined) {
      const before = context
      const beforeConflicts = internalEvidenceOf(context).conflicts.length
      context = withEvidence(context, observed.evidence)
      appendEvidenceDiagnostics(diagnostics, before, context)
      if (internalEvidenceOf(context).conflicts.length > beforeConflicts && completionAccepted) {
        rollbackCompletion(context.ledger.diagnostics.slice(before.ledger.diagnostics.length))
      }
    }
  }

  if (completionAccepted) diagnostics.push(...completionDiagnostics)

  if (!hasPackageConflict(internalEvidenceOf(context))
    && (options.contract === 'project' || options.contract === 'frozen'
      || internalEvidenceOf(context).packageManifests.size > 0)) {
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
  }

  let artifactEnriched: readonly string[] = []
  let inferredArtifactCacheKey: string | undefined
  if (target.capabilities.integrity === 'berry-zip'
    && sources.artifacts !== undefined && hasBerryChecksumGap(working)) {
    const before = working
    const artifactCacheKey = options.cacheKey ?? berryCacheKeyFor(
      before,
      options.target.format,
      'observed-only',
    )
    const refurbished = await refurbish(before, options.target.format, sources.artifacts, {
      ...(artifactCacheKey === undefined ? {} : { cacheKey: artifactCacheKey }),
      ...(target.managerVersion === undefined ? {} : { managerVersion: target.managerVersion }),
      cacheKeyInference: 'observed-only',
    })
    diagnostics.push(...refurbished.unresolved)
    phases.push({
      kind: 'artifact',
      before,
      after: refurbished.graph,
      enriched: refurbished.enriched,
    })
    working = refurbished.graph
    artifactEnriched = refurbished.enriched
    if (options.cacheKey === undefined && artifactCacheKey !== undefined
      && artifactEnriched.length > 0) inferredArtifactCacheKey = artifactCacheKey
  }

  if (memoized !== undefined) refs.push(...registryRefs(memoized))
  if (inferredArtifactCacheKey !== undefined) {
    refs.push({
      kind: 'inference',
      subject: `berry-cache-key:${inferredArtifactCacheKey}`,
      source: 'graph-observation',
    })
  }
  refs.push(...artifactRefs(working, artifactEnriched))
  const evidenceChanged = context !== baseEvidence || refs.length > 0
  if (working === graph && (evidenceChanged || diagnostics.length > 0)) {
    working = working.mutate(() => {}).graph
  }

  let transferred = rebindSourceState(sourceFormat, stateSource, working)
  if (transferred.invalidated.length > 0) {
    const diagnostic = enrichAdapterStateInvalidated(sourceFormat ?? 'unknown', transferred.invalidated)
    diagnostics.push(diagnostic)
    const withDiagnostic = landDiagnostics(transferred.graph, [diagnostic])
    transferred = rebindSourceState(sourceFormat, transferred.graph, withDiagnostic)
  }
  working = transferred.graph

  const changed = working !== graph || evidenceChanged || diagnostics.length > 0
  if (changed) {
    deriveEnrichedEvidence(graph, working, context, phases, refs, evidenceDiagnostics)
  }
  return Object.freeze({
    graph: working,
    diagnostics: Object.freeze([...diagnostics]),
  })
}
