import {
  stripPeerContextFromNodeId,
  type Diagnostic,
  type Graph,
  type Manifest,
  type Node,
  type OverrideConstraint,
} from '../graph.ts'
import { getBunOverridesCanonical } from '../formats/bun-text.ts'
import { getPnpmOverridesCanonical } from '../formats/_pnpm-flat-core.ts'
import { getPnpmV5OverridesCanonical } from '../formats/pnpm-v5.ts'
import { captureOverrides } from '../recipe/overrides.ts'
import { isHashedPeerSetToken } from '../recipe/patch.ts'
import {
  packageMetadataEqual,
  packageMetadataOfPayload,
  payloadOfPackumentVersion,
} from '../registry/payload.ts'
import { sourceCapabilitiesOf } from './capabilities.ts'
import { packageMetadataDiagnostic } from './diagnostics.ts'
import {
  evidenceOf,
  internalEvidenceOf,
  type InternalEvidenceState,
} from './evidence.ts'
import type {
  ArtifactKnowledge,
  CompletenessContext,
  CompletenessDimension,
  CompletenessProfile,
  CompletenessResult,
  EvidenceContext,
  Knowledge,
  LayoutKnowledge,
  PeerKnowledge,
  PolicyKnowledge,
  StructuralCoverage,
  Verification,
} from './types.ts'

const emptyProfile = (): CompletenessProfile => ({
  projectTopology: 'none',
  resolvedGraph: 'none',
  edgeKinds: 'none',
  peerModel: 'none',
  resolutionPolicy: 'none',
  packageMetadata: 'none',
  artifacts: 'none',
  layout: 'none',
  verification: 'unverified',
})

const knowledgeRank: Record<Knowledge, number> = { none: 0, partial: 1, complete: 2 }
const policyRank: Record<PolicyKnowledge, number> = {
  none: 0,
  'outcome-only': 1,
  normalized: 2,
  authored: 3,
}
const peerRank: Record<PeerKnowledge, number> = {
  none: 0,
  declared: 1,
  resolved: 2,
  virtualized: 3,
}
const artifactRank: Record<ArtifactKnowledge, number> = {
  none: 0,
  identified: 1,
  metadata: 2,
  bytes: 3,
  verified: 4,
}
const layoutRank: Record<LayoutKnowledge, number> = {
  none: 0,
  hints: 1,
  'source-native-encoded': 2,
  'synthesized-by-consumer': 3,
}
const verificationRank: Record<Verification, number> = {
  unverified: 0,
  'graph-validated': 1,
  'target-parse-accepted': 2,
  'mutable-stable': 3,
  'frozen-verified': 4,
}

function higher<T extends string>(left: T, right: T, ranks: Record<T, number>): T {
  return ranks[right] > ranks[left] ? right : left
}

function lower<T extends string>(left: T, right: T, ranks: Record<T, number>): T {
  return ranks[right] < ranks[left] ? right : left
}

function structuralCoverageOf(graph: Graph): StructuralCoverage {
  const nodes = [...graph.nodes()]
  const payloads = [...graph.tarballs()].map(([, payload]) => payload)
  const edges = nodes.flatMap(node => [...graph.out(node.id)])
  const hasPeerContext = nodes.some(node => node.peerContext.length > 0)
  const hasPeerEdges = edges.some(edge => edge.kind === 'peer')
  const hasPeerDeclarations = payloads.some(payload => payload.peerDependencies !== undefined)
  const hasUnknownArtifact = nodes.some(node => !artifactIdentified(graph, node.id))
  const hasSomeMetadata = payloads.some(payload => Object.keys(payload).some(key => ![
    'resolution',
    'nativeResolution',
  ].includes(key)))
  const hasPolicyCarrier = getPnpmOverridesCanonical(graph) !== undefined
    || getPnpmV5OverridesCanonical(graph) !== undefined
    || getBunOverridesCanonical(graph) !== undefined

  return Object.freeze({
    projectTopology: nodes.length === 0 ? 'none' : 'partial',
    resolvedGraph: nodes.length === 0 ? 'none' : 'partial',
    edgeKinds: nodes.length === 0 ? 'none' : 'partial',
    peerModel: hasPeerContext
      ? 'virtualized'
      : hasPeerEdges
        ? 'resolved'
        : hasPeerDeclarations
          ? 'declared'
          : 'none',
    resolutionPolicy: nodes.length === 0 ? 'none' : hasPolicyCarrier ? 'normalized' : 'outcome-only',
    packageMetadata: hasSomeMetadata ? 'partial' : 'none',
    artifacts: nodes.length === 0 ? 'none' : hasUnknownArtifact ? 'none' : 'identified',
    layout: graph.layoutHints() === undefined ? 'none' : 'hints',
    verification: 'graph-validated',
  })
}

function artifactIdentified(graph: Graph, nodeId: string): boolean {
  const node = graph.getNode(nodeId)
  if (node?.workspacePath !== undefined) return true
  const payload = graph.tarballOf(nodeId)
  return payload !== undefined
    && payload.resolution?.type !== 'unknown'
    && (payload.resolution !== undefined || payload.nativeResolution !== undefined)
}

function declaredKind(manifest: Manifest, name: string): 'dep' | 'dev' | 'optional' | 'peer' | undefined {
  if (Object.hasOwn(manifest.optionalDependencies ?? {}, name)) return 'optional'
  if (Object.hasOwn(manifest.peerDependencies ?? {}, name)) return 'peer'
  if (Object.hasOwn(manifest.devDependencies ?? {}, name)) return 'dev'
  if (Object.hasOwn(manifest.dependencies ?? {}, name)) return 'dep'
  return undefined
}

function declaredRange(manifest: Manifest, name: string, kind: 'dep' | 'dev' | 'optional' | 'peer'): string | undefined {
  if (kind === 'optional') return manifest.optionalDependencies?.[name]
  if (kind === 'peer') return manifest.peerDependencies?.[name]
  if (kind === 'dev') return manifest.devDependencies?.[name]
  return manifest.dependencies?.[name]
}

function manifestEdgeMatches(graph: Graph, manifest: Manifest, edge: ReturnType<Graph['out']>[number]): boolean {
  const target = graph.getNode(edge.dst)
  if (target === undefined) return false
  const declaredName = edge.attrs?.alias ?? target.name
  const kind = declaredKind(manifest, declaredName)
  if (kind !== edge.kind) return false
  const range = declaredRange(manifest, declaredName, kind)
  if (range === undefined) return false
  if (edge.attrs?.range !== range && edge.attrs?.workspaceRange?.specifier !== range) return false
  if (range.startsWith('workspace:') && edge.attrs?.workspace !== true) return false
  return edge.attrs?.workspaceRange === undefined || edge.attrs.workspaceRange.specifier === range
}

function installDeclarations(
  manifest: Manifest,
  includeDev: boolean,
): Array<readonly [string, 'dep' | 'dev' | 'optional' | 'peer']> {
  const names = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...(includeDev ? Object.keys(manifest.devDependencies ?? {}) : []),
    ...Object.keys(manifest.optionalDependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
  ])
  return [...names].map(name => [name, declaredKind(manifest, name)!])
}

function declaredProjectEdgesPreserved(graph: Graph, nodeId: string, manifest: Manifest): boolean {
  const edges = graph.out(nodeId)
  if (!edges.every(edge => manifestEdgeMatches(graph, manifest, edge))) return false
  return installDeclarations(manifest, true).every(([name, kind]) =>
    edges.some(edge => {
      const target = graph.getNode(edge.dst)
      return target !== undefined
        && (edge.attrs?.alias ?? target.name) === name
        && edge.kind === kind
        && manifestEdgeMatches(graph, manifest, edge)
    }))
}

function workspacePatternMatches(pattern: string, path: string): boolean {
  if (/[{}!]/.test(pattern)) return false
  let source = '^'
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index]!
    if (char === '*' && pattern[index + 1] === '*') {
      source += '.*'
      index++
    } else if (char === '*') {
      source += '[^/]*'
    } else if (char === '?') {
      source += '[^/]'
    } else {
      source += char.replace(/[\\^$.[\]|()+]/g, '\\$&')
    }
  }
  return new RegExp(`${source}$`).test(path)
}

function repositoryPreservedInGraph(graph: Graph, state: InternalEvidenceState): boolean {
  const repository = state.repositoryManifests
  if (repository?.coverage !== 'complete') return false
  const manifests = repository.manifests
  const manifestByPath = new Map(Object.entries(manifests).map(([path, manifest]) => [
    path === '.' ? '' : path,
    manifest,
  ]))
  if (!manifestByPath.has('')) return false
  const nodesByPath = new Map([...graph.nodes()]
    .filter(node => node.workspacePath !== undefined)
    .map(node => [node.workspacePath!, node]))
  if (manifestByPath.size !== nodesByPath.size) return false
  const rootManifest = manifestByPath.get('')!
  const memberPaths = [...manifestByPath.keys()].filter(path => path !== '')
  if (memberPaths.length > 0 && (rootManifest.workspaces === undefined
    || !memberPaths.every(path => rootManifest.workspaces!.some(pattern =>
      workspacePatternMatches(pattern.replace(/^\.\//, ''), path))))) return false
  for (const [path, manifest] of manifestByPath) {
    const node = nodesByPath.get(path)
    if (node === undefined) return false
    if (manifest.name !== undefined && manifest.name !== node.name
      && !workspaceNameIsPlaceholder(node)) return false
    if (manifest.version !== undefined && manifest.version !== node.version) return false
    if (!declaredProjectEdgesPreserved(graph, node.id, manifest)) return false
  }
  return true
}

function workspaceNameIsPlaceholder(node: Node): boolean {
  if (node.workspacePath === undefined) return false
  return node.name === node.workspacePath
    || (node.workspacePath === '' && node.name === '.')
}

function packageEdgesClassified(graph: Graph, state: InternalEvidenceState): boolean {
  for (const node of graph.nodes()) {
    if (node.workspacePath !== undefined) continue
    const key = stripPeerContextFromNodeId(node.id)
    const evidence = state.packageManifests.get(key)
    if (evidence === undefined) return false
    const manifest = evidence.manifest
    if (manifest.name !== undefined && manifest.name !== node.name) return false
    if (manifest.version !== undefined && manifest.version !== node.version) return false
    if (!graph.out(node.id).every(edge => manifestEdgeMatches(graph, manifest, edge))) return false
    if (!installDeclarations(manifest, false).every(([name, kind]) => graph.out(node.id).some(edge => {
      const target = graph.getNode(edge.dst)
      return target !== undefined
        && (edge.attrs?.alias ?? target.name) === name
        && edge.kind === kind
        && manifestEdgeMatches(graph, manifest, edge)
    }))) return false
  }
  return true
}

function assessPackageMetadata(
  graph: Graph,
  state: InternalEvidenceState,
): { complete: boolean, diagnostics: readonly Diagnostic[] } {
  const diagnostics: Diagnostic[] = []
  const representatives = new Map<string, Node[]>()
  let hasNode = false
  for (const node of graph.nodes()) {
    hasNode = true
    if (node.workspacePath !== undefined) continue
    const key = stripPeerContextFromNodeId(node.id)
    const nodes = representatives.get(key) ?? []
    nodes.push(node)
    representatives.set(key, nodes)
  }

  for (const [key, nodes] of representatives) {
    const representative = nodes[0]!
    const payload = graph.tarballOf(representative.id)
    const resolutionType = payload?.resolution?.type
    if (representative.source !== undefined
      || (resolutionType !== undefined && resolutionType !== 'tarball')) {
      diagnostics.push(packageMetadataDiagnostic(
        'COMPLETENESS_PACKAGE_METADATA_SOURCE_UNSUPPORTED',
        key,
        'non-registry package metadata requires explicit source-specific manifest evidence',
      ))
      continue
    }

    const evidence = state.packageManifests.get(key)
    if (evidence === undefined) {
      diagnostics.push(packageMetadataDiagnostic(
        'COMPLETENESS_PACKAGE_METADATA_INCOMPLETE',
        key,
        'authoritative package manifest evidence is missing',
      ))
      continue
    }
    if (nodes.some(node => node.name !== evidence.manifest.name
      || node.version !== evidence.manifest.version)) {
      diagnostics.push(packageMetadataDiagnostic(
        'COMPLETENESS_PACKAGE_METADATA_MISMATCH',
        key,
        'package manifest identity does not match the graph subject',
      ))
      continue
    }

    const actual = packageMetadataOfPayload(payload)
    const expected = packageMetadataOfPayload(payloadOfPackumentVersion(evidence.manifest))
    if (!packageMetadataEqual(actual, expected)) {
      diagnostics.push(packageMetadataDiagnostic(
        'COMPLETENESS_PACKAGE_METADATA_MISMATCH',
        key,
        'canonical package metadata does not match authoritative manifest evidence',
      ))
    }
  }

  return Object.freeze({
    complete: hasNode && diagnostics.length === 0 && !hasConflict(state, 'packageMetadata'),
    diagnostics: Object.freeze(diagnostics),
  })
}

function rootManifest(state: InternalEvidenceState): Manifest | undefined {
  return state.repositoryManifests?.manifests['']
    ?? state.repositoryManifests?.manifests['.']
}

function repositoryRootComplete(graph: Graph, state: InternalEvidenceState): boolean {
  const manifest = rootManifest(state)
  if (state.repositoryManifests?.coverage !== 'complete' || manifest === undefined) return false
  const root = [...graph.nodes()].find(node => node.workspacePath === '')
  if (root === undefined) return false
  return (manifest.name === undefined || manifest.name === root.name || workspaceNameIsPlaceholder(root))
    && (manifest.version === undefined || manifest.version === root.version)
}

function canonicalManifestOverrides(
  manifest: Manifest | undefined,
  manager: 'npm' | 'yarn' | 'pnpm' | 'bun',
): readonly OverrideConstraint[] {
  if (manifest?.overrides !== undefined) return manifest.overrides
  if (manager === 'pnpm' && manifest?.native?.pnpmOverrides !== undefined) {
    return captureOverrides(manifest.native.pnpmOverrides, 'pnpm').canonical
  }
  if (manager === 'yarn' && manifest?.native?.yarnResolutions !== undefined) {
    return captureOverrides(manifest.native.yarnResolutions, 'yarn').canonical
  }
  if ((manager === 'npm' || manager === 'bun') && manifest?.native?.npmOverrides !== undefined) {
    return captureOverrides(manifest.native.npmOverrides, 'npm').canonical
  }
  return []
}

function overrideKey(override: OverrideConstraint, origin: string): string {
  return JSON.stringify([
    override.package,
    override.parentPath ?? [],
    override.versionCondition ?? '',
    override.to,
    override.selfRef ?? false,
    override.origin ?? origin,
  ])
}

function equalOverrides(
  left: readonly OverrideConstraint[],
  right: readonly OverrideConstraint[],
  manager: 'npm' | 'yarn' | 'pnpm' | 'bun',
): boolean {
  const origin = manager === 'bun' ? 'npm' : manager
  const semantic = (overrides: readonly OverrideConstraint[]): string => {
    const entries = overrides.map((override, index) => ({
      key: overrideKey(override, origin),
      order: override.captureIndex ?? index,
    }))
    if (manager === 'npm' || manager === 'bun') {
      return entries.sort((leftEntry, rightEntry) => leftEntry.order - rightEntry.order)
        .map(entry => entry.key).join('\n')
    }
    return entries.map(entry => entry.key).sort().join('\n')
  }
  return semantic(left) === semantic(right)
}

function policyConflictDiagnostic(manager: string, version?: string): Diagnostic {
  return Object.freeze({
    code: 'COMPLETENESS_EVIDENCE_CONFLICT',
    severity: 'warning',
    message: 'authoritative override sources conflict',
    data: Object.freeze({
      dimension: 'resolutionPolicy',
      manager,
      ...(version === undefined ? {} : { version }),
    }),
  })
}

function policyCarrierConflicts(
  state: InternalEvidenceState,
  authority: readonly OverrideConstraint[],
  required: boolean,
): boolean {
  const observed = state.observedPolicyCarrier
  if (observed === undefined) return required && authority.length > 0
  if (!observed.present) return required && authority.length > 0
  const manager = state.source?.manager
  if (manager === undefined || manager === 'lockgraph') return true
  return !equalOverrides(observed.overrides, authority, manager)
}

function hasConflict(state: InternalEvidenceState, dimension: CompletenessDimension): boolean {
  return state.conflicts.some(conflict => conflict.dimension === dimension)
}

function managerMajor(version: string | undefined): number | undefined {
  if (version === undefined) return undefined
  const match = version.match(/^(\d+)\./)
  return match === null ? undefined : Number(match[1])
}

function pnpmGenerationCompatible(format: string, version: string): boolean {
  const major = managerMajor(version)
  if (major === undefined) return false
  if (format === 'pnpm-v5') return major >= 3 && major <= 7
  if (format === 'pnpm-v6') return major === 8
  if (format === 'pnpm-v9') return major >= 9
  return false
}

function sourceGeneration(state: InternalEvidenceState): string | undefined {
  if (state.source?.version !== undefined) {
    if (state.source.manager === 'pnpm'
      && !pnpmGenerationCompatible(state.source.format, state.source.version)) return undefined
    return state.source.version
  }
  if (state.source?.manager === undefined) return undefined
  const versions = new Set(state.pmConfigs
    .filter(config => config.manager === state.source?.manager)
    .map(config => config.version))
  if (versions.size !== 1) return undefined
  const version = [...versions][0]!
  if (state.source.manager === 'pnpm'
    && !pnpmGenerationCompatible(state.source.format, version)) return undefined
  return version
}

function applyPolicyEvidence(
  profile: CompletenessProfile,
  state: InternalEvidenceState,
  repositoryComplete: boolean,
  diagnostics: Diagnostic[],
): void {
  const manager = state.source?.manager
  if (manager === undefined || manager === 'lockgraph' || !repositoryComplete
    || hasConflict(state, 'resolutionPolicy')) return

  const manifestOverrides = canonicalManifestOverrides(rootManifest(state), manager)

  if (manager !== 'pnpm') {
    if (manager === 'bun' && policyCarrierConflicts(state, manifestOverrides, true)) {
      diagnostics.push(policyConflictDiagnostic(manager))
      return
    }
    profile.resolutionPolicy = 'authored'
    return
  }

  const generation = sourceGeneration(state)
  if (generation === undefined) return
  const major = managerMajor(generation)
  const config = state.pmConfigs.find(candidate => candidate.manager === 'pnpm'
    && candidate.version === generation && candidate.surface === 'overrides'
    && candidate.coverage === 'complete')
  if (config !== undefined && config.overrides.length > 0 && manifestOverrides.length > 0
    && !equalOverrides(manifestOverrides, config.overrides, 'pnpm')) {
    diagnostics.push(policyConflictDiagnostic('pnpm', generation))
    return
  }
  if (major !== undefined && major <= 10) {
    const authority = config !== undefined && config.overrides.length > 0
      ? config.overrides
      : manifestOverrides
    if (policyCarrierConflicts(state, authority, major >= 6)) {
      diagnostics.push(policyConflictDiagnostic('pnpm', generation))
      return
    }
    profile.resolutionPolicy = 'authored'
    return
  }
  if (config === undefined) return
  if (policyCarrierConflicts(state, config.overrides, true)) {
    diagnostics.push(policyConflictDiagnostic('pnpm', generation))
    return
  }
  profile.resolutionPolicy = 'authored'
}

export function authoritativePolicyOverridesOf(
  state: InternalEvidenceState,
): readonly OverrideConstraint[] | undefined {
  const manager = state.source?.manager
  if (manager === undefined || manager === 'lockgraph' || hasConflict(state, 'resolutionPolicy')) {
    return undefined
  }
  const manifestOverrides = canonicalManifestOverrides(rootManifest(state), manager)
  if (manager !== 'pnpm') return manifestOverrides
  const generation = sourceGeneration(state)
  const major = managerMajor(generation)
  if (generation === undefined || major === undefined) return undefined
  const config = state.pmConfigs.find(candidate => candidate.manager === 'pnpm'
    && candidate.version === generation && candidate.surface === 'overrides'
    && candidate.coverage === 'complete')
  if (major <= 10) {
    return config !== undefined && config.overrides.length > 0
      ? config.overrides
      : manifestOverrides
  }
  return config?.overrides
}

export type CompletionPolicyAuthority =
  | Readonly<{ status: 'known'; overrides: readonly OverrideConstraint[] }>
  | Readonly<{ status: 'unknown' | 'conflict' }>

export function completionPolicyAuthorityOf(
  state: InternalEvidenceState,
): CompletionPolicyAuthority {
  const manager = state.source?.manager
  if (hasConflict(state, 'resolutionPolicy')) return { status: 'conflict' }
  if (manager === undefined || manager === 'lockgraph') {
    const manifest = rootManifest(state)
    const configs = state.pmConfigs
    if (configs.length > 1) return { status: 'conflict' }
    if (configs.length === 1) return { status: 'known', overrides: configs[0]!.overrides }
    return manifest?.overrides === undefined
      ? { status: 'unknown' }
      : { status: 'known', overrides: manifest.overrides }
  }

  const manifest = rootManifest(state)
  const manifestOverrides = manifest === undefined
    ? undefined
    : canonicalManifestOverrides(manifest, manager)
  if (state.pmConfigs.some(config => config.manager !== manager)) {
    return { status: 'conflict' }
  }
  const matchingConfigs = state.pmConfigs.filter(config => config.manager === manager)
  if (state.source?.version !== undefined
    && matchingConfigs.some(config => config.version !== state.source?.version)) {
    return { status: 'conflict' }
  }
  const configOverrides = matchingConfigs.length === 1
    ? matchingConfigs[0]!.overrides
    : undefined
  if (matchingConfigs.length > 1) return { status: 'conflict' }
  const carrierOverrides = state.observedPolicyCarrier === undefined
    ? undefined
    : state.observedPolicyCarrier.overrides

  if (manifestOverrides === undefined && configOverrides === undefined
    && carrierOverrides === undefined) return { status: 'unknown' }

  if (manager !== 'pnpm') {
    const candidates = [manifestOverrides, configOverrides, carrierOverrides]
      .filter((candidate): candidate is readonly OverrideConstraint[] => candidate !== undefined)
    const authority = candidates[0]!
    if (candidates.slice(1).some(candidate => !equalOverrides(authority, candidate, manager))) {
      return { status: 'conflict' }
    }
    return { status: 'known', overrides: authority }
  }

  if (manifestOverrides === undefined && configOverrides === undefined
    && carrierOverrides !== undefined) {
    return { status: 'known', overrides: carrierOverrides }
  }
  const authority = authoritativePolicyOverridesOf(state)
  if (authority === undefined) return { status: 'unknown' }
  if (carrierOverrides !== undefined && !equalOverrides(authority, carrierOverrides, 'pnpm')) {
    return { status: 'conflict' }
  }
  return { status: 'known', overrides: authority }
}

function applyConflicts(profile: CompletenessProfile, state: InternalEvidenceState): void {
  for (const conflict of state.conflicts) {
    switch (conflict.dimension) {
      case 'projectTopology':
      case 'resolvedGraph':
      case 'edgeKinds':
      case 'packageMetadata':
        profile[conflict.dimension] = lower(
          profile[conflict.dimension],
          'partial',
          knowledgeRank,
        )
        break
      case 'resolutionPolicy':
        profile.resolutionPolicy = lower(profile.resolutionPolicy, 'normalized', policyRank)
        break
      case 'peerModel':
        profile.peerModel = lower(profile.peerModel, 'declared', peerRank)
        break
      case 'artifacts':
        profile.artifacts = lower(profile.artifacts, 'identified', artifactRank)
        break
      case 'layout':
        profile.layout = lower(profile.layout, 'hints', layoutRank)
        break
      case 'verification':
        profile.verification = lower(profile.verification, 'graph-validated', verificationRank)
        break
    }
  }
}

interface EvidenceScopeDelta {
  readonly nodes: boolean
  readonly edges: boolean
  readonly tarballs: boolean
  readonly layout: boolean
}

function evidenceScopeDelta(graph: Graph, anchor: Graph | undefined): EvidenceScopeDelta | undefined {
  if (anchor === undefined) return undefined
  const diff = anchor.diff(graph)
  const edgeSnapshot = (value: Graph): string => JSON.stringify([...value.nodes()]
    .flatMap(node => [...value.out(node.id)])
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))))
  const anchorTarballs = JSON.stringify([...anchor.tarballs()])
  const graphTarballs = JSON.stringify([...graph.tarballs()])
  const delta = {
    nodes: diff.addedNodes.length > 0 || diff.removedNodes.length > 0 || diff.changedNodes.length > 0,
    edges: diff.addedEdges.length > 0 || diff.removedEdges.length > 0
      || edgeSnapshot(anchor) !== edgeSnapshot(graph),
    tarballs: anchorTarballs !== graphTarballs,
    layout: JSON.stringify(anchor.layoutHints()) !== JSON.stringify(graph.layoutHints()),
  }
  return delta.nodes || delta.edges || delta.tarballs || delta.layout ? delta : undefined
}

function scopeMismatchDiagnostic(delta: EvidenceScopeDelta): Diagnostic {
  return Object.freeze({
    code: 'COMPLETENESS_EVIDENCE_SCOPE_MISMATCH',
    severity: 'warning',
    message: 'evidence source graph differs from the assessed graph',
    data: Object.freeze({ ...delta }),
  })
}

function applyScopeDelta(
  graph: Graph,
  profile: CompletenessProfile,
  delta: EvidenceScopeDelta,
): void {
  if (delta.nodes) {
    profile.projectTopology = lower(profile.projectTopology, 'partial', knowledgeRank)
    profile.resolvedGraph = lower(profile.resolvedGraph, 'partial', knowledgeRank)
    profile.edgeKinds = lower(profile.edgeKinds, 'partial', knowledgeRank)
    profile.peerModel = lower(profile.peerModel, 'declared', peerRank)
    profile.packageMetadata = lower(profile.packageMetadata, 'partial', knowledgeRank)
  }
  if (delta.edges) {
    profile.projectTopology = lower(profile.projectTopology, 'partial', knowledgeRank)
    profile.resolvedGraph = lower(profile.resolvedGraph, 'partial', knowledgeRank)
    profile.edgeKinds = lower(profile.edgeKinds, 'partial', knowledgeRank)
    profile.peerModel = lower(profile.peerModel, 'declared', peerRank)
  }
  if (delta.tarballs) {
    profile.resolvedGraph = lower(profile.resolvedGraph, 'partial', knowledgeRank)
    profile.edgeKinds = lower(profile.edgeKinds, 'partial', knowledgeRank)
    profile.peerModel = lower(profile.peerModel, 'declared', peerRank)
    profile.packageMetadata = lower(profile.packageMetadata, 'partial', knowledgeRank)
  }
  if (delta.layout) {
    profile.layout = graph.layoutHints() === undefined ? 'none' : 'hints'
  }
  if (delta.nodes || delta.tarballs) {
    const allIdentified = [...graph.nodes()].every(node => artifactIdentified(graph, node.id))
    profile.artifacts = allIdentified ? 'identified' : 'none'
  }
}

const graphGapPattern = /(BAD_ENTRY|UNRESOLVED|RESOLVE_VIOLATION|MISSING_(?:ENTRY|NODE|SNAPSHOT|TARGET)|UNKNOWN_(?:ENTRY|SNAPSHOT)|AMBIGUOUS_(?:RESOLUTION|TARGET)|COLLISION|IRREDUCIBLE_LOSS)/
const topologyGapPattern = /(WORKSPACE|IMPORTER|ROOT).*(?:MISSING|UNKNOWN|UNRESOLVED|COLLISION)/
const artifactGapPattern = /(INTEGRITY_INCOMPLETE|RESOLUTION_UNKNOWN|MISSING_(?:RESOLUTION|INTEGRITY))/
const peerGapPattern = /(PEER.*(?:UNSATISFIED|AMBIGUOUS|UNRESOLVED|COLLISION|ATTRIBUTION|MISSING)|WORKSPACE_PEER.*(?:GAP|COLLISION|MISSING))/

function applyRetainedDiagnostics(profile: CompletenessProfile, diagnostics: readonly Diagnostic[]): void {
  for (const diagnostic of diagnostics) {
    if (diagnostic.severity === 'error' || graphGapPattern.test(diagnostic.code)) {
      profile.resolvedGraph = lower(profile.resolvedGraph, 'partial', knowledgeRank)
      profile.edgeKinds = lower(profile.edgeKinds, 'partial', knowledgeRank)
    }
    if (topologyGapPattern.test(diagnostic.code)) {
      profile.projectTopology = lower(profile.projectTopology, 'partial', knowledgeRank)
    }
    if (artifactGapPattern.test(diagnostic.code)) profile.artifacts = 'none'
    if (peerGapPattern.test(diagnostic.code)) {
      profile.peerModel = lower(profile.peerModel, 'declared', peerRank)
    }
  }
}

function containsOpaquePeerToken(value: string): boolean {
  if (isHashedPeerSetToken(value)) return true
  for (let index = 0; index < value.length; index++) {
    if (value[index] !== '(') continue
    let depth = 1
    let end = index + 1
    while (end < value.length && depth > 0) {
      if (value[end] === '(') depth++
      else if (value[end] === ')') depth--
      end++
    }
    if (depth !== 0) return true
    if (containsOpaquePeerToken(value.slice(index + 1, end - 1))) return true
    index = end - 1
  }
  return false
}

/**
 * Computes canonical completeness from the supplied evidence. This is not a
 * conversion-readiness decision. Use `stringifyAssessed` or `convertAssessed`
 * before writing a target lockfile.
 */
export function completenessOf(graph: Graph, context: CompletenessContext = {}): CompletenessResult {
  const evidence: EvidenceContext = context.evidence ?? evidenceOf(graph)
  const state = internalEvidenceOf(evidence)
  const structural = structuralCoverageOf(graph)
  const generation = sourceGeneration(state)
  const capabilities = state.source === undefined
    ? undefined
    : sourceCapabilitiesOf(state.source.format, generation)
  const profile: CompletenessProfile = capabilities === undefined
    ? emptyProfile()
    : { ...capabilities.floor }
  const diagnostics = [...graph.diagnostics(), ...evidence.ledger.diagnostics]

  profile.verification = 'graph-validated'
  if (graph.layoutHints() !== undefined) {
    profile.layout = higher(profile.layout, 'hints', layoutRank)
  }
  const hasUnknownArtifact = [...graph.nodes()].some(node => !artifactIdentified(graph, node.id))
  if (hasUnknownArtifact) profile.artifacts = 'none'
  const scopeDelta = evidenceScopeDelta(graph, state.anchorSnapshot ?? state.anchor)
  if (scopeDelta !== undefined) {
    diagnostics.push(scopeMismatchDiagnostic(scopeDelta))
    applyScopeDelta(graph, profile, scopeDelta)
  }

  if (state.source?.format === 'pnpm-v5' && state.observedPolicyCarrier?.present === true) {
    profile.resolutionPolicy = higher(profile.resolutionPolicy, 'normalized', policyRank)
  }
  if (state.source?.format === 'pnpm-v9' && scopeDelta === undefined
    && ![...graph.nodes()].some(node => node.peerContext.some(containsOpaquePeerToken))
    && !graph.diagnostics().some(diagnostic => diagnostic.severity === 'error'
      || graphGapPattern.test(diagnostic.code))) {
    profile.resolvedGraph = 'complete'
    profile.edgeKinds = 'complete'
  }

  const repositoryPreserved = repositoryPreservedInGraph(graph, state)
  if (repositoryPreserved && !hasConflict(state, 'projectTopology')) {
    profile.projectTopology = 'complete'
  }
  if (repositoryPreserved && packageEdgesClassified(graph, state)
    && !hasConflict(state, 'edgeKinds')) {
    profile.edgeKinds = 'complete'
  }
  const packageMetadata = assessPackageMetadata(graph, state)
  diagnostics.push(...packageMetadata.diagnostics)
  if (packageMetadata.complete && scopeDelta?.nodes !== true && scopeDelta?.tarballs !== true) {
    profile.packageMetadata = 'complete'
  }
  applyPolicyEvidence(profile, state, repositoryRootComplete(graph, state), diagnostics)

  applyConflicts(profile, state)
  applyRetainedDiagnostics(profile, graph.diagnostics())

  return Object.freeze({
    profile: Object.freeze(profile),
    structural,
    evidence,
    diagnostics: Object.freeze(diagnostics),
  })
}
