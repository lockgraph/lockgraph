import type { Diagnostic, EdgeKind, Graph, Manifest } from '../graph.ts'
import { sourceCapabilitiesOf } from './capabilities.ts'
import { internalEvidenceOf, type InternalEvidenceState } from './evidence.ts'
import {
  detectGraphFeatures,
  type GraphFeature,
  type GraphFeatureDetection,
  type SidecarFeatureFact,
} from './features.ts'
import { completenessOf } from './profile.ts'
import { targetProfileOf } from './targets.ts'
import type {
  ArtifactKnowledge,
  AssessmentOptions,
  CompletenessDimension,
  CompletenessProfile,
  ConversionAssessment,
  ConversionContract,
  Knowledge,
  PeerKnowledge,
  PolicyKnowledge,
  RequirementAssessment,
  RequirementStatus,
  SourceCapabilityResult,
  TargetCapability,
  TargetProfile,
  Verification,
} from './types.ts'

export interface OutputProbeResult {
  readonly accepted: boolean
  readonly diagnostics: readonly Diagnostic[]
}

export interface AssessmentRuntime {
  readonly outputProbe?: OutputProbeResult
  readonly targetRequirements?: readonly RequirementAssessment[]
}

type FeatureEvaluator = (
  graph: Graph,
  target: TargetProfile,
  contract: ConversionContract,
  detection: GraphFeatureDetection,
) => RequirementAssessment

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
const verificationRank: Record<Verification, number> = {
  unverified: 0,
  'graph-validated': 1,
  'target-parse-accepted': 2,
  'mutable-stable': 3,
  'frozen-verified': 4,
}

const nonRegistryTargets = new Set<TargetProfile['format']>([
  'npm-1',
  'npm-2',
  'npm-3',
  'yarn-classic',
  'yarn-berry-v4',
  'yarn-berry-v5',
  'yarn-berry-v6',
  'yarn-berry-v7',
  'yarn-berry-v8',
  'yarn-berry-v9',
  'yarn-berry-v10',
  'pnpm-v5',
  'pnpm-v6',
  'pnpm-v9',
  'lockgraph',
])

function diagnostic(
  code: string,
  message: string,
  data?: Record<string, unknown>,
): Diagnostic {
  return Object.freeze({
    code,
    severity: 'warning',
    message,
    ...(data === undefined ? {} : { data: Object.freeze(data) }),
  })
}

function requirement(
  key: string,
  status: RequirementStatus,
  dimension?: CompletenessDimension,
  diagnostics: readonly Diagnostic[] = [],
): RequirementAssessment {
  return Object.freeze({
    key,
    ...(dimension === undefined ? {} : { dimension }),
    status,
    diagnostics: Object.freeze([...diagnostics]),
  })
}

function thresholdRequirement<T extends string>(
  key: string,
  dimension: CompletenessDimension,
  actual: T,
  minimum: T,
  ranks: Record<T, number>,
): RequirementAssessment {
  if (ranks[actual] >= ranks[minimum]) return requirement(key, 'satisfied', dimension)
  return requirement(key, 'unassessed', dimension, [diagnostic(
    'COMPLETENESS_REQUIREMENT_UNASSESSED',
    `${dimension} lacks sufficient evidence for the required completeness`,
    { dimension, actual, required: minimum },
  )])
}

function capabilityRequirement(
  feature: GraphFeature,
  dimension: CompletenessDimension,
  target: TargetProfile,
  capabilities: readonly TargetCapability[],
  supported: boolean,
): RequirementAssessment {
  const ambiguous = capabilities.filter(capability => target.ambiguousCapabilities.has(capability))
  if (ambiguous.length > 0) {
    return requirement(`target-feature:${feature}`, 'unassessed', dimension, [diagnostic(
      'COMPLETENESS_TARGET_CAPABILITY_AMBIGUOUS',
      'target manager version is required to assess this feature',
      { feature, capabilities: ambiguous },
    )])
  }
  if (supported) return requirement(`target-feature:${feature}`, 'satisfied', dimension)
  return requirement(`target-feature:${feature}`, 'unsatisfied', dimension, [diagnostic(
    'COMPLETENESS_TARGET_FEATURE_UNSUPPORTED',
    'target cannot represent a graph feature',
    { feature, target: target.format },
  )])
}

function edgeEvaluator(kind: EdgeKind): FeatureEvaluator {
  return (_graph, target) => capabilityRequirement(
    `edge:${kind}` as GraphFeature,
    'edgeKinds',
    target,
    ['edgeKinds'],
    target.capabilities.edgeKinds.has(kind),
  )
}

function metadataEvaluator(feature: GraphFeature): FeatureEvaluator {
  return (_graph, _target, contract) => contract === 'snapshot' || contract === 'policy'
    ? requirement(`target-feature:${feature}`, 'satisfied', 'packageMetadata')
    : requirement(`target-feature:${feature}`, 'unassessed', 'packageMetadata', [diagnostic(
      'COMPLETENESS_EVALUATOR_DEFERRED',
      'deep package metadata projection is not assessed',
      { feature },
    )])
}

function workspaceProtocolPresent(graph: Graph): boolean {
  for (const node of graph.nodes()) {
    for (const edge of graph.out(node.id)) {
      if (edge.attrs?.workspaceRange !== undefined || edge.attrs?.range?.startsWith('workspace:')) {
        return true
      }
    }
  }
  return false
}

const featureEvaluators: Record<GraphFeature, FeatureEvaluator> = {
  'edge:dep': edgeEvaluator('dep'),
  'edge:dev': edgeEvaluator('dev'),
  'edge:optional': edgeEvaluator('optional'),
  'edge:peer': edgeEvaluator('peer'),
  'edge:bundled': (_graph, target) => capabilityRequirement(
    'edge:bundled',
    'edgeKinds',
    target,
    ['edgeKinds', 'bundledDependencies'],
    target.capabilities.edgeKinds.has('bundled') && target.capabilities.bundledDependencies,
  ),
  'peer-context': (_graph, target) => capabilityRequirement(
    'peer-context',
    'peerModel',
    target,
    ['peerRepresentation'],
    target.capabilities.peerRepresentation === 'virtualized',
  ),
  workspace: (graph, target) => {
    const protocol = workspaceProtocolPresent(graph)
    return capabilityRequirement(
      'workspace',
      'projectTopology',
      target,
      protocol ? ['workspaces', 'workspaceProtocol'] : ['workspaces'],
      target.capabilities.workspaces && (!protocol || target.capabilities.workspaceProtocol),
    )
  },
  'edge-alias': (_graph, target) => capabilityRequirement(
    'edge-alias',
    'resolvedGraph',
    target,
    [],
    true,
  ),
  patch: (_graph, target) => capabilityRequirement(
    'patch',
    'artifacts',
    target,
    ['patches'],
    target.capabilities.patches,
  ),
  'source-discriminator': (_graph, target) => capabilityRequirement(
    'source-discriminator',
    'artifacts',
    target,
    [],
    nonRegistryTargets.has(target.format),
  ),
  'resolution:tarball': (_graph, target) => capabilityRequirement(
    'resolution:tarball',
    'artifacts',
    target,
    [],
    true,
  ),
  'resolution:git': (_graph, target) => capabilityRequirement(
    'resolution:git',
    'artifacts',
    target,
    [],
    nonRegistryTargets.has(target.format),
  ),
  'resolution:directory': (_graph, target) => capabilityRequirement(
    'resolution:directory',
    'artifacts',
    target,
    [],
    nonRegistryTargets.has(target.format),
  ),
  'resolution:unknown': (_graph, target) => target.format === 'lockgraph'
    ? requirement('target-feature:resolution:unknown', 'satisfied', 'artifacts')
    : requirement('target-feature:resolution:unknown', 'unassessed', 'artifacts', [diagnostic(
      'COMPLETENESS_EVALUATOR_DEFERRED',
      'target-specific native resolution attribution is unavailable',
      { target: target.format },
    )]),
  'integrity:tarball': (_graph, target) => capabilityRequirement(
    'integrity:tarball',
    'artifacts',
    target,
    ['integrity'],
    target.capabilities.integrity === 'tarball-sri'
      || target.capabilities.integrity === 'canonical',
  ),
  'integrity:berry-zip': (_graph, target) => capabilityRequirement(
    'integrity:berry-zip',
    'artifacts',
    target,
    ['integrity'],
    target.capabilities.integrity === 'berry-zip'
      || target.capabilities.integrity === 'canonical',
  ),
  conditions: (_graph, target) => capabilityRequirement(
    'conditions',
    'resolvedGraph',
    target,
    ['conditions'],
    target.capabilities.conditions,
  ),
  catalog: (_graph, target, _contract, detection) => {
    const attribution = detection.attribution
    if (attribution.catalogRanges === 'unknown') {
      return requirement('target-feature:catalog', 'unassessed', 'resolutionPolicy', [diagnostic(
        'COMPLETENESS_EVALUATOR_DEFERRED',
        'catalog descriptor attribution is unavailable',
      )])
    }
    const pnpmOwned = attribution.catalogRanges === 'pnpm' || attribution.pnpmCatalogs.present
    const familySupported = pnpmOwned ? target.manager === 'pnpm' : target.manager === 'yarn'
    return capabilityRequirement(
      'catalog',
      'resolutionPolicy',
      target,
      ['catalogs'],
      familySupported && target.capabilities.catalogs,
    )
  },
  'metadata:engines': metadataEvaluator('metadata:engines'),
  'metadata:funding': metadataEvaluator('metadata:funding'),
  'metadata:license': metadataEvaluator('metadata:license'),
  'metadata:bin': metadataEvaluator('metadata:bin'),
  'metadata:deprecated': metadataEvaluator('metadata:deprecated'),
  'metadata:platform': metadataEvaluator('metadata:platform'),
  'metadata:install-script': metadataEvaluator('metadata:install-script'),
  'metadata:bundled-dependencies': metadataEvaluator('metadata:bundled-dependencies'),
  'metadata:peer-declarations': metadataEvaluator('metadata:peer-declarations'),
}

function emptySourceCapabilities(): SourceCapabilityResult {
  const floor: CompletenessProfile = {
    projectTopology: 'none',
    resolvedGraph: 'none',
    edgeKinds: 'none',
    peerModel: 'none',
    resolutionPolicy: 'none',
    packageMetadata: 'none',
    artifacts: 'none',
    layout: 'none',
    verification: 'unverified',
  }
  return Object.freeze({
    floor: Object.freeze(floor),
    ambiguousDimensions: new Set<CompletenessDimension>(Object.keys(floor) as CompletenessDimension[]),
  })
}

function sourceGeneration(state: InternalEvidenceState): string | undefined {
  if (state.source?.version !== undefined) return state.source.version
  if (state.source?.manager === undefined || state.source.manager === 'lockgraph') return undefined
  const versions = new Set(state.pmConfigs
    .filter(config => config.manager === state.source?.manager)
    .map(config => config.version))
  return versions.size === 1 ? [...versions][0] : undefined
}

function sourceCapabilities(state: InternalEvidenceState): SourceCapabilityResult {
  return state.source === undefined
    ? emptySourceCapabilities()
    : sourceCapabilitiesOf(state.source.format, sourceGeneration(state))
}

function canonicalRequirements(
  profile: Readonly<CompletenessProfile>,
  features: ReadonlySet<GraphFeature>,
  contract: ConversionContract,
): RequirementAssessment[] {
  const requirements = [
    thresholdRequirement(
      'canonical:resolved-graph',
      'resolvedGraph',
      profile.resolvedGraph,
      'complete',
      knowledgeRank,
    ),
    thresholdRequirement(
      'canonical:artifacts',
      'artifacts',
      profile.artifacts,
      'identified',
      artifactRank,
    ),
    thresholdRequirement(
      'canonical:verification',
      'verification',
      profile.verification,
      'graph-validated',
      verificationRank,
    ),
  ]

  const requiredPeer: PeerKnowledge | undefined = features.has('peer-context')
    ? 'virtualized'
    : features.has('edge:peer')
      ? 'resolved'
      : features.has('metadata:peer-declarations')
        ? 'declared'
        : undefined
  if (requiredPeer !== undefined) {
    requirements.push(thresholdRequirement(
      'canonical:peer-model',
      'peerModel',
      profile.peerModel,
      requiredPeer,
      peerRank,
    ))
  }

  if (contract !== 'snapshot') {
    requirements.push(thresholdRequirement(
      'canonical:resolution-policy',
      'resolutionPolicy',
      profile.resolutionPolicy,
      'authored',
      policyRank,
    ))
  }
  if (contract === 'project' || contract === 'frozen') {
    requirements.push(
      thresholdRequirement(
        'canonical:project-topology',
        'projectTopology',
        profile.projectTopology,
        'complete',
        knowledgeRank,
      ),
      thresholdRequirement(
        'canonical:edge-kinds',
        'edgeKinds',
        profile.edgeKinds,
        'complete',
        knowledgeRank,
      ),
      requirement('canonical:package-metadata', 'unassessed', 'packageMetadata', [diagnostic(
        'COMPLETENESS_EVALUATOR_DEFERRED',
        'deep package metadata assessment is not implemented',
      )]),
      requirement('target:companion-projection', 'unassessed', undefined, [diagnostic(
        'COMPLETENESS_EVALUATOR_DEFERRED',
        'companion file projection is not implemented',
      )]),
    )
  }
  if (contract === 'frozen') {
    requirements.push(requirement('target:frozen-verification', 'unassessed', 'verification', [diagnostic(
      'COMPLETENESS_EVALUATOR_DEFERRED',
      'frozen conversion verification is not implemented',
    )]))
  }
  return requirements
}

function contractDimensions(
  contract: ConversionContract,
  features: ReadonlySet<GraphFeature>,
): ReadonlySet<CompletenessDimension> {
  const dimensions = new Set<CompletenessDimension>([
    'resolvedGraph',
    'artifacts',
    'verification',
  ])
  if (features.has('peer-context') || features.has('edge:peer')
    || features.has('metadata:peer-declarations')) dimensions.add('peerModel')
  if (contract !== 'snapshot') dimensions.add('resolutionPolicy')
  if (contract === 'project' || contract === 'frozen') {
    dimensions.add('projectTopology')
    dimensions.add('edgeKinds')
    dimensions.add('packageMetadata')
  }
  return dimensions
}

function manifestHasOverrides(manifest: Manifest): boolean {
  if ((manifest.overrides?.length ?? 0) > 0) return true
  if (Object.keys(manifest.native?.pnpmOverrides ?? {}).length > 0) return true
  if (Object.keys(manifest.native?.yarnResolutions ?? {}).length > 0) return true
  return Object.keys(manifest.native?.npmOverrides ?? {}).length > 0
}

function policyPresent(state: InternalEvidenceState): boolean {
  if ((state.observedPolicyCarrier?.overrides.length ?? 0) > 0) return true
  if (state.pmConfigs.some(config => config.overrides.length > 0)) return true
  return Object.values(state.repositoryManifests?.manifests ?? {}).some(manifestHasOverrides)
}

function targetPolicyAbsenceProven(
  state: InternalEvidenceState,
  target: TargetProfile,
): boolean {
  const location = target.capabilities.overridesConfigLocation
  if (location === 'none') return true
  if (location === 'manifest') {
    return state.repositoryManifests?.coverage === 'complete'
      && state.repositoryManifests.manifests[''] !== undefined
  }
  return target.managerVersion !== undefined && state.pmConfigs.some(config =>
    config.manager === target.manager
      && config.version === target.managerVersion
      && config.surface === 'overrides'
      && config.coverage === 'complete'
      && config.overrides.length === 0)
}

function policyProjectionRequirement(
  state: InternalEvidenceState,
  target: TargetProfile,
  runtimeRequirements: readonly RequirementAssessment[],
): RequirementAssessment {
  const supplied = runtimeRequirements.find(candidate => candidate.key === 'target:resolution-policy')
  if (supplied !== undefined) return supplied
  if (!policyPresent(state)) {
    return targetPolicyAbsenceProven(state, target)
      ? requirement('target:resolution-policy', 'satisfied', 'resolutionPolicy')
      : requirement('target:resolution-policy', 'unassessed', 'resolutionPolicy', [diagnostic(
          'COMPLETENESS_EVALUATOR_DEFERRED',
          'target override authority absence is not proven',
          { location: target.capabilities.overridesConfigLocation },
        )])
  }
  if (state.source?.manager !== target.manager) {
    return requirement('target:resolution-policy', 'unassessed', 'resolutionPolicy', [diagnostic(
      'COMPLETENESS_EVALUATOR_DEFERRED',
      'cross-manager override grammar projection is not assessed',
      { source: state.source?.manager ?? 'unknown', target: target.manager },
    )])
  }
  const relevant: TargetCapability[] = [
    'lockOverridesCarrier',
    'overridesConfigLocation',
    'overridesGrammar',
  ]
  const ambiguous = relevant.filter(capability => target.ambiguousCapabilities.has(capability))
  if (ambiguous.length > 0) {
    return requirement('target:resolution-policy', 'unassessed', 'resolutionPolicy', [diagnostic(
      'COMPLETENESS_TARGET_CAPABILITY_AMBIGUOUS',
      'target manager version is required to assess override projection',
      { capabilities: ambiguous },
    )])
  }
  if (target.capabilities.lockOverridesCarrier) {
    return requirement('target:resolution-policy', 'satisfied', 'resolutionPolicy')
  }
  if (target.capabilities.overridesConfigLocation !== 'none'
    && target.capabilities.overridesGrammar !== 'none') {
    return requirement('target:resolution-policy', 'unassessed', 'resolutionPolicy', [diagnostic(
      'COMPLETENESS_EVALUATOR_DEFERRED',
      'override projection requires a companion manifest or config file',
      { location: target.capabilities.overridesConfigLocation },
    )])
  }
  return requirement('target:resolution-policy', 'unsatisfied', 'resolutionPolicy', [diagnostic(
    'COMPLETENESS_TARGET_FEATURE_UNSUPPORTED',
    'target has no modeled override carrier',
    { target: target.format },
  )])
}

function hasWorkspacePeer(graph: Graph): boolean {
  for (const node of graph.nodes()) {
    if (node.peerContext.some(peer => graph.getNode(peer)?.workspacePath !== undefined)) return true
  }
  return false
}

function workspacePeerProjectionRequirement(
  graph: Graph,
  target: TargetProfile,
  runtimeRequirements: readonly RequirementAssessment[],
): RequirementAssessment | undefined {
  if (target.manager !== 'pnpm' || !hasWorkspacePeer(graph)) return undefined
  const key = 'target:pnpm-workspace-peer-projection'
  if (target.format !== 'pnpm-v5') {
    const supplied = runtimeRequirements.find(candidate => candidate.key === key)
    if (supplied !== undefined) return supplied
  }
  return requirement(key, 'unassessed', 'peerModel', [diagnostic(
    'COMPLETENESS_EVALUATOR_DEFERRED',
    target.format === 'pnpm-v5'
      ? 'pnpm-v5 workspace peer projection is not assessed'
      : 'pnpm workspace peer projection was not resolved',
  )])
}

function outputProbeRequirement(probe: OutputProbeResult | undefined): RequirementAssessment {
  if (probe === undefined) {
    return requirement('target-output-probe', 'unassessed', 'verification', [diagnostic(
      'COMPLETENESS_OUTPUT_PROBE_MISSING',
      'target output has not been emitted, reparsed, and compared',
    )])
  }
  if (probe.accepted) {
    return requirement('target-output-probe', 'satisfied', 'verification', probe.diagnostics)
  }
  const diagnostics = probe.diagnostics.length > 0 ? probe.diagnostics : [diagnostic(
    'COMPLETENESS_OUTPUT_PROBE_REJECTED',
    'target output probe rejected the conversion',
  )]
  return requirement('target-output-probe', 'unsatisfied', 'verification', diagnostics)
}

function overallStatus(requirements: readonly RequirementAssessment[]): RequirementStatus {
  if (requirements.some(item => item.status === 'unsatisfied')) return 'unsatisfied'
  if (requirements.some(item => item.status === 'unassessed')) return 'unassessed'
  return 'satisfied'
}

function targetAndRequirement(options: AssessmentOptions): {
  readonly target: TargetProfile
  readonly requirement?: RequirementAssessment
} {
  try {
    return { target: targetProfileOf(options.target) }
  } catch (error) {
    return {
      target: targetProfileOf({ format: options.target.format }),
      requirement: requirement('target:request', 'unsatisfied', undefined, [diagnostic(
        'COMPLETENESS_TARGET_REQUEST_INVALID',
        error instanceof Error ? error.message : 'invalid target request',
        { format: options.target.format, managerVersion: options.target.managerVersion ?? '' },
      )]),
    }
  }
}

function mergedFeatureDetection(
  graph: Graph,
  state: InternalEvidenceState,
): { detection: GraphFeatureDetection; current: GraphFeatureDetection; source: GraphFeatureDetection } {
  const current = detectGraphFeatures(graph)
  if (state.anchor === undefined || state.anchor === graph) {
    return { detection: current, current, source: current }
  }
  const source = detectGraphFeatures(state.anchor)
  const features = new Set(current.features)
  if (source.features.has('conditions')) features.add('conditions')
  if (source.features.has('catalog')) features.add('catalog')
  const mergedFact = (
    expected: Readonly<SidecarFeatureFact>,
    actual: Readonly<SidecarFeatureFact>,
  ): Readonly<SidecarFeatureFact> => expected.present ? expected : actual.present ? actual : expected
  const sourceRanges = source.attribution.catalogRanges
  const currentRanges = current.attribution.catalogRanges
  const catalogRanges = sourceRanges === 'none'
    ? currentRanges
    : currentRanges === 'none' || currentRanges === sourceRanges
      ? sourceRanges
      : 'unknown'
  return {
    current,
    source,
    detection: Object.freeze({
      features,
      unmodeled: Object.freeze([...source.unmodeled, ...current.unmodeled]),
      attribution: Object.freeze({
        berryConditions: mergedFact(
          source.attribution.berryConditions,
          current.attribution.berryConditions,
        ),
        pnpmCatalogs: mergedFact(source.attribution.pnpmCatalogs, current.attribution.pnpmCatalogs),
        catalogRanges,
      }),
    }),
  }
}

function sidecarAttributionRequirements(
  source: GraphFeatureDetection,
  current: GraphFeatureDetection,
): RequirementAssessment[] {
  const out: RequirementAssessment[] = []
  const facts = [
    ['conditions', source.attribution.berryConditions, current.attribution.berryConditions],
    ['catalogs', source.attribution.pnpmCatalogs, current.attribution.pnpmCatalogs],
  ] as const
  for (const [name, expected, actual] of facts) {
    const changed = expected.present !== actual.present
      || (expected.present && actual.present && expected.fingerprint !== actual.fingerprint)
    if (changed || (expected.present && !actual.available)) {
      out.push(requirement(`source-sidecar:${name}`, 'unassessed', undefined, [diagnostic(
        'COMPLETENESS_EVALUATOR_DEFERRED',
        'source sidecar feature attribution was lost or changed',
        { feature: name },
      )]))
    }
  }
  return out
}

export function assessConversion(
  graph: Graph,
  options: AssessmentOptions,
  runtime: AssessmentRuntime = {},
): ConversionAssessment {
  const completeness = completenessOf(graph, { evidence: options.evidence })
  const state = internalEvidenceOf(completeness.evidence)
  const source = sourceCapabilities(state)
  const resolvedTarget = targetAndRequirement(options)
  const detected = mergedFeatureDetection(graph, state)
  const detection = detected.detection
  const requirements = canonicalRequirements(
    completeness.profile,
    detection.features,
    options.contract,
  )

  if (state.source === undefined) {
    requirements.push(requirement('source:format', 'unassessed', undefined, [diagnostic(
      'COMPLETENESS_EVALUATOR_DEFERRED',
      'source format evidence is unavailable',
    )]))
  }
  const requiredDimensions = contractDimensions(options.contract, detection.features)
  for (const dimension of source.ambiguousDimensions) {
    if (!requiredDimensions.has(dimension)) continue
    requirements.push(requirement(
      `source:manager-generation:${dimension}`,
      'unassessed',
      dimension,
      [diagnostic(
        'COMPLETENESS_MANAGER_GENERATION_AMBIGUOUS',
        'source manager generation is required for this contract dimension',
        { dimension, contract: options.contract },
      )],
    ))
  }
  if (resolvedTarget.requirement !== undefined) requirements.push(resolvedTarget.requirement)
  requirements.push(...sidecarAttributionRequirements(detected.source, detected.current))

  for (const feature of detection.features) {
    const evaluator = featureEvaluators[feature]
    requirements.push(evaluator === undefined
      ? requirement(`target-feature:${feature}`, 'unassessed', undefined, [diagnostic(
          'COMPLETENESS_EVALUATOR_DEFERRED',
          'graph feature has no target evaluator',
          { feature },
        )])
      : evaluator(graph, resolvedTarget.target, options.contract, detection))
  }

  for (const fact of detection.unmodeled) {
    requirements.push(requirement(
      `graph-feature:unmodeled:${fact.subject}:${fact.path}`,
      'unassessed',
      undefined,
      [diagnostic(
        'COMPLETENESS_FEATURE_UNMODELED',
        'graph contains a fact outside the assessed feature model',
        { subject: fact.subject, path: fact.path, reason: fact.reason },
      )],
    ))
  }

  const runtimeRequirements = runtime.targetRequirements ?? []
  const companion = runtimeRequirements.find(item => item.key === 'target:companion-projection')
  if (companion !== undefined && (options.contract === 'project' || options.contract === 'frozen')) {
    const index = requirements.findIndex(item => item.key === companion.key)
    if (index >= 0) requirements[index] = companion
  }
  if (options.contract !== 'snapshot') {
    requirements.push(policyProjectionRequirement(state, resolvedTarget.target, runtimeRequirements))
  }
  const workspacePeer = workspacePeerProjectionRequirement(
    graph,
    resolvedTarget.target,
    runtimeRequirements,
  )
  if (workspacePeer !== undefined) requirements.push(workspacePeer)
  const consumedRuntimeKeys = new Set([
    workspacePeer?.key,
    options.contract === 'snapshot' ? undefined : 'target:resolution-policy',
    options.contract === 'project' || options.contract === 'frozen'
      ? 'target:companion-projection'
      : undefined,
  ])
  requirements.push(...runtimeRequirements.filter(item => !consumedRuntimeKeys.has(item.key)))
  requirements.push(outputProbeRequirement(runtime.outputProbe))

  const frozenRequirements = Object.freeze(requirements.map(item => Object.freeze({
    ...item,
    diagnostics: Object.freeze([...item.diagnostics]),
  })))
  const diagnostics = Object.freeze([
    ...completeness.diagnostics,
    ...frozenRequirements.flatMap(item => item.diagnostics),
  ])
  return Object.freeze({
    status: overallStatus(frozenRequirements),
    contract: options.contract,
    source,
    target: resolvedTarget.target,
    completeness,
    requirements: frozenRequirements,
    diagnostics,
  })
}
