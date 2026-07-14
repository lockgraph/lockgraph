import { createHash } from 'node:crypto'

import { newBuilder, type Diagnostic, type Graph, type Manifest, type OverrideConstraint } from '../graph.ts'
import {
  LockfileError,
  type ProjectionLoss,
  type ProjectionRemedy,
} from '../api/errors.ts'
import type { FormatId } from '../api/format-contract.ts'
import {
  assessedDiagnostic,
  canonicalGraphSnapshot,
  check,
  detect,
  diagnosticKey,
  packageManagerFamilyOf,
  parse,
  stableValue,
  stringifyProjected,
} from '../api/format-api.ts'
import { captureOverrides } from '../recipe/overrides.ts'
import { isSentinelPatch } from '../recipe/patch.ts'
import {
  attachParsedEvidence,
  evidenceOf,
  internalEvidenceOf,
  withEvidence,
  withSourceVersion,
} from '../completeness/evidence.ts'
import { assessConversion, type OutputProbeResult } from '../completeness/assessment.ts'
import { detectGraphFeatures } from '../completeness/features.ts'
import {
  classifiedProjectionLoss,
  dedupeProjectionLosses,
  projectionDiagnosticLosses,
  projectionError,
  projectionWarning,
  type ProjectionResult,
} from '../completeness/projection.ts'
import { authoritativePolicyOverridesOf } from '../completeness/profile.ts'
import { companionProjectionRuntime } from '../completeness/companions.ts'
import type {
  AssessedOutput,
  CompanionSetOperation,
  ConvertAssessedOptions,
  ConvertProjectOptions,
  EvidenceContext,
  FrozenCandidate,
  FrozenConversionResult,
  FrozenPreparationOptions,
  FrozenPreparationResult,
  FrozenVerificationReceipt,
  ProjectConversionResult,
  ProjectEvidenceInput,
  RequirementAssessment,
  StringifyAssessedOptions,
} from '../completeness/types.ts'
import {
  resolvePnpmWorkspacePeerProjection,
  type PnpmWorkspacePeerProjection,
  type PnpmWorkspacePeerProjectionEvidence,
} from '../formats/_pnpm-flat-core.ts'
import { enrich as enrichGraph, type EnrichSources } from '../enrich/facade.ts'
import {
  materializeOverrides,
  prepareConvertInput,
  structuralEqual,
  type PreparedConvertInput,
} from './input.ts'
import type {
  ConvertDependencies,
  ConvertInput,
  ConvertOptions,
} from './types.ts'

function mergeManifestSources(
  sourceFormat: FormatId,
  prepared: PreparedConvertInput['manifests'],
  legacy: ConvertOptions['manifests'],
  supplied: EnrichSources['manifests'],
): Readonly<Record<string, Manifest>> | undefined {
  const output: Record<string, Manifest> = {}
  for (const source of [prepared, legacy, supplied]) {
    if (source === undefined) continue
    for (const [key, manifest] of Object.entries(source).sort(([left], [right]) => left.localeCompare(right))) {
      const current = output[key]
      if (current !== undefined && !structuralEqual(
        canonicalManifestForMerge(sourceFormat, current),
        canonicalManifestForMerge(sourceFormat, manifest),
      )) {
        throw new LockfileError({
          code: 'INVALID_INPUT',
          message: `convert: conflicting manifest sources for ${key === '' ? 'package.json' : `${key}/package.json`}`,
        })
      }
      if (current === undefined) output[key] = manifest
    }
  }
  return Object.keys(output).length === 0 ? undefined : output
}

function canonicalManifestForMerge(format: FormatId, manifest: Manifest): Manifest {
  const { native, overrides, ...fields } = manifest
  if (overrides !== undefined) return { ...fields, overrides: materializeOverrides(overrides) }
  const pm = packageManagerFamilyOf(format)
  const block = pm === 'npm'
    ? native?.npmOverrides
    : pm === 'yarn'
      ? native?.yarnResolutions
      : native?.pnpmOverrides
  return block === undefined
    ? fields
    : { ...fields, overrides: materializeOverrides(captureOverrides(block, pm).canonical) }
}

function mergedEnrichSources(
  prepared: PreparedConvertInput,
  options: ConvertOptions,
): EnrichSources {
  const manifests = mergeManifestSources(
    prepared.source,
    prepared.manifests,
    options.manifests,
    options.sources?.manifests,
  )
  return {
    ...(manifests === undefined ? {} : { manifests }),
    ...(options.sources?.registry === undefined ? {} : { registry: options.sources.registry }),
    ...(options.sources?.artifacts === undefined ? {} : { artifacts: options.sources.artifacts }),
    ...(options.sources?.config === undefined ? {} : { config: options.sources.config }),
  }
}

function patchPathOfResolution(resolution: string | undefined): string | undefined {
  if (resolution === undefined || !resolution.includes('@patch:')) return undefined
  const hash = resolution.indexOf('#')
  if (hash < 0) return resolution
  const fragment = resolution.slice(hash + 1).split('::', 1)[0]!
  const fileParts = fragment.split('&')
    .map(part => part.replace(/^optional!/, ''))
    .filter(part => part !== ''
      && !part.startsWith('builtin<')
      && !part.startsWith('~builtin<'))
  if (fileParts.length === 0) return undefined
  return fileParts.map(part => {
    try {
      return decodeURIComponent(part)
    } catch {
      return part
    }
  }).join('&')
}

function patchByteDiagnostics(
  prepared: PreparedConvertInput,
  graph: Graph,
): readonly Diagnostic[] {
  if (!prepared.source.startsWith('yarn-berry-')) return []
  const diagnostics: Diagnostic[] = []
  for (const node of [...graph.nodes()].sort((left, right) => left.id.localeCompare(right.id))) {
    if (node.patch === undefined || !isSentinelPatch(node.patch)) continue
    const patchPath = patchPathOfResolution(graph.tarballOf(node.id)?.nativeResolution)
    if (patchPath === undefined) continue
    diagnostics.push({
      code: 'CONVERT_PATCH_BYTES_UNAVAILABLE',
      severity: 'warning',
      subject: node.id,
      message: `${prepared.mode}-mode conversion did not resolve patch bytes for ${patchPath}`,
      data: {
        patchPath,
        reason: prepared.mode === 'path'
          ? 'path-fs-seam-not-threaded'
          : prepared.mode === 'project'
            ? 'project-input-has-no-patch-byte-channel'
            : 'lock-content-has-no-patch-bytes',
        remedy: 'pass-workspaceRoot',
      },
    })
  }
  return diagnostics
}

function snapshotRequirementRemedy(
  requirement: RequirementAssessment,
): ProjectionRemedy {
  const subject = requirement.diagnostics.find(item => typeof item.subject === 'string')?.subject
  const subjectValue = typeof subject === 'string' ? subject : undefined
  if (requirement.dimension === 'artifacts') {
    return Object.freeze({ kind: 'supply', source: 'artifacts', ...(subjectValue === undefined ? {} : { subject: subjectValue }) })
  }
  if (requirement.dimension === 'packageMetadata'
    || requirement.dimension === 'resolvedGraph'
    || requirement.dimension === 'peerModel') {
    return Object.freeze({ kind: 'supply', source: 'registry', ...(subjectValue === undefined ? {} : { subject: subjectValue }) })
  }
  if (requirement.dimension === 'projectTopology' || requirement.dimension === 'edgeKinds') {
    return Object.freeze({ kind: 'supply', source: 'manifests', ...(subjectValue === undefined ? {} : { subject: subjectValue }) })
  }
  return Object.freeze({ kind: 'supply', source: 'config', ...(subjectValue === undefined ? {} : { subject: subjectValue }) })
}

function snapshotProjectionLosses(
  graph: Graph,
  target: FormatId,
  targetVersion?: string,
): readonly ProjectionLoss[] {
  const assessment = assessConversion(graph, {
    contract: 'snapshot',
    target: {
      format: target,
      ...(targetVersion === undefined ? {} : { managerVersion: targetVersion }),
    },
  }, {
    outputProbe: { accepted: true, diagnostics: Object.freeze([]) },
  })
  const relevant = assessment.requirements.filter(requirement =>
    requirement.status !== 'satisfied'
      && (requirement.key.startsWith('canonical:')
        || requirement.key.startsWith('source:')
        || requirement.key.startsWith('source-sidecar:')
        || requirement.key.startsWith('graph-feature:')))
  return dedupeProjectionLosses(relevant.map(requirement => {
    const diagnostic = requirement.diagnostics[0] ?? assessedDiagnostic(
      'COMPLETENESS_REQUIREMENT_UNASSESSED',
      `conversion snapshot requirement ${requirement.key} is not satisfied`,
      { requirement: requirement.key },
    )
    const inherent = requirement.status === 'unsatisfied'
      || requirement.key.startsWith('graph-feature:')
    const remedy = inherent
      ? Object.freeze({ kind: 'allow-loss', option: 'strict', value: false } as const)
      : snapshotRequirementRemedy(requirement)
    return classifiedProjectionLoss(
      inherent ? 'inherent-meaningful' : 'enrichable',
      requirement.key,
      target,
      diagnostic,
      remedy,
    )
  }))
}

async function defaultFileSystem(): Promise<NonNullable<ConvertDependencies['fs']>> {
  return (await import('./node-fs.ts')).nodeFileSystem
}

interface PreparedConversionRuntime {
  readonly graph: Graph
  readonly prepared: PreparedConvertInput
  readonly diagnostics: readonly Diagnostic[]
}

async function prepareConversionRuntime(
  input: ConvertInput,
  options: ConvertOptions,
  dependencies: ConvertDependencies,
  contract: StringifyAssessedOptions['contract'],
): Promise<PreparedConversionRuntime> {
  const diagnostics: Diagnostic[] = []
  const report = (diagnostic: Diagnostic): void => {
    diagnostics.push(diagnostic)
    options.onDiagnostic?.(diagnostic)
  }
  const prepared = await prepareConvertInput(input, options, { detect }, dependencies)
  for (const diagnostic of prepared.diagnostics) report(diagnostic)
  const sources = mergedEnrichSources(prepared, options)
  let graph = parse(prepared.source, prepared.lockfile, {
    workspaceRoot: options.workspaceRoot,
    manifests: sources.manifests === undefined ? undefined : { ...sources.manifests },
    onDiagnostic: report,
  })
  for (const diagnostic of patchByteDiagnostics(prepared, graph)) report(diagnostic)
  const enriched = await enrichGraph(graph, sources, {
    target: {
      format: options.to,
      ...(options.targetVersion === undefined ? {} : { managerVersion: options.targetVersion }),
    },
    contract,
    ...(options.cacheKey === undefined ? {} : { cacheKey: options.cacheKey }),
  })
  graph = enriched.graph
  for (const diagnostic of enriched.diagnostics) report(diagnostic)
  return { graph, prepared, diagnostics: Object.freeze(diagnostics) }
}

async function _convert(
  input: ConvertInput,
  options: ConvertOptions,
  dependencies: ConvertDependencies,
): Promise<string> {
  const { graph, diagnostics } = await prepareConversionRuntime(
    input,
    options,
    dependencies,
    'snapshot',
  )
  const projected = stringifyProjected(options.to, graph, {
    lineEnding: options.lineEnding,
    cacheKey: options.cacheKey,
    targetVersion: options.targetVersion,
    onDiagnostic: options.onDiagnostic,
  })
  if (options.strict ?? true) {
    const losses = dedupeProjectionLosses([
      ...projectionDiagnosticLosses(diagnostics, options.to),
      ...snapshotProjectionLosses(graph, options.to, options.targetVersion),
      ...projected.losses,
    ])
    if (losses.length > 0) throw new LockfileError(projectionError(losses))
  }
  return projected.output
}

export function convert(input: ConvertInput, options: ConvertOptions): Promise<string> {
  return _convert(input, options, {
    ...(options.fs === undefined ? {} : { fs: options.fs }),
    defaultFileSystem,
  })
}

const assessedBlockingDiagnostic = (diagnostic: Diagnostic): boolean =>
  diagnostic.severity !== 'info'

const FROZEN_PROJECTION_PROTOCOL = 'lockgraph-frozen-projection/v1' as const
const FROZEN_ORACLE_PROTOCOL = 'lockgraph-native-frozen/v1' as const
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/
const EXACT_MANAGER_VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/

function targetLockPath(format: FormatId): string {
  if (format.startsWith('npm-')) return 'package-lock.json'
  if (format.startsWith('yarn-')) return 'yarn.lock'
  if (format.startsWith('pnpm-')) return 'pnpm-lock.yaml'
  if (format === 'bun-text') return 'bun.lock'
  return 'lockgraph.lockgraph'
}

function sha256(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`
}

function frozenProjectionDigest(
  target: Readonly<{ format: FormatId; managerVersion: string }>,
  lockfile: string,
  companions: readonly CompanionSetOperation[],
): string {
  const envelope = stableValue({
    protocol: FROZEN_PROJECTION_PROTOCOL,
    target,
    lockfile: {
      path: targetLockPath(target.format),
      digest: sha256(lockfile),
    },
    companions,
  })
  return sha256(JSON.stringify(envelope))
}

function overrideSetKey(overrides: readonly OverrideConstraint[], target: FormatId): string {
  const manager = target === 'bun-text' ? 'bun' : target.startsWith('pnpm-') ? 'pnpm' : 'npm'
  const origin = manager === 'bun' ? 'npm' : manager
  const entries = overrides.map((override, index) => ({
    key: JSON.stringify([
      override.package,
      override.parentPath ?? [],
      override.versionCondition ?? '',
      override.to,
      override.selfRef ?? false,
      override.origin ?? origin,
    ]),
    order: override.captureIndex ?? index,
  }))
  return manager === 'bun'
    ? entries.sort((left, right) => left.order - right.order).map(entry => entry.key).join('\n')
    : entries.map(entry => entry.key).sort().join('\n')
}

function probeEligible(
  assessment: AssessedOutput['assessment'],
  allowFrozenCandidate = false,
): boolean {
  return assessment.requirements.every(item =>
    item.key === 'target-output-probe'
      || item.key === 'target:frozen-verification'
      || (allowFrozenCandidate
        && assessment.target.capabilities.integrity === 'berry-zip'
        && item.key === 'target-feature:integrity:tarball')
      || item.status === 'satisfied')
}

function outputProbe(
  graph: Graph,
  output: string,
  target: FormatId,
  contract: StringifyAssessedOptions['contract'],
  sourceEvidence: StringifyAssessedOptions['evidence'],
  diagnostics: Diagnostic[],
  workspaceNames?: ReadonlyMap<string, string>,
): OutputProbeResult {
  if (!check(target, output)) {
    diagnostics.push(assessedDiagnostic(
      'COMPLETENESS_OUTPUT_FORMAT_REJECTED',
      'target adapter rejected emitted output',
      { target },
    ))
    return { accepted: false, diagnostics }
  }

  let reparsed: Graph
  try {
    reparsed = parse(target, output, { onDiagnostic: diagnostic => diagnostics.push(diagnostic) })
  } catch (error) {
    diagnostics.push(assessedDiagnostic(
      'COMPLETENESS_OUTPUT_PARSE_FAILED',
      error instanceof Error ? error.message : 'target output parse failed',
      { target },
    ))
    return { accepted: false, diagnostics }
  }

  const sourceState = internalEvidenceOf(sourceEvidence ?? evidenceOf(graph))
  const authority = contract === 'snapshot' ? undefined : authoritativePolicyOverridesOf(sourceState)
  const comparisonOverrides = target.startsWith('pnpm-') ? authority : undefined
  const sourceSnapshot = canonicalGraphSnapshot(graph, contract, comparisonOverrides, workspaceNames)
  const targetSnapshot = canonicalGraphSnapshot(reparsed, contract, comparisonOverrides, workspaceNames)
  if (sourceSnapshot !== targetSnapshot) {
    diagnostics.push(assessedDiagnostic(
      'COMPLETENESS_OUTPUT_GRAPH_MISMATCH',
      'target output does not preserve the canonical graph',
      { target },
    ))
  }

  const sourceFeatureGraph = sourceState.anchor ?? graph
  const sourceFeatures = detectGraphFeatures(sourceFeatureGraph)
  const targetFeatures = detectGraphFeatures(reparsed)
  const sidecarFacts = [
    ['conditions', sourceFeatures.attribution.berryConditions, targetFeatures.attribution.berryConditions],
    ['catalogs', sourceFeatures.attribution.pnpmCatalogs, targetFeatures.attribution.pnpmCatalogs],
  ] as const
  for (const [feature, sourceFact, targetFact] of sidecarFacts) {
    if (sourceFact.present !== targetFact.present
      || (sourceFact.present && targetFact.fingerprint !== sourceFact.fingerprint)) {
      diagnostics.push(assessedDiagnostic(
        'COMPLETENESS_OUTPUT_FEATURE_MISMATCH',
        'target output changes or drops a sidecar-owned graph feature',
        { target, feature },
      ))
    }
  }
  if (sourceFeatures.unmodeled.length > 0 || targetFeatures.unmodeled.length > 0) {
    diagnostics.push(assessedDiagnostic(
      'COMPLETENESS_FEATURE_UNMODELED',
      'output comparison encountered an unmodeled graph fact',
      { target },
    ))
  }

  if (contract !== 'snapshot') {
    if (authority === undefined) {
      diagnostics.push(assessedDiagnostic(
        'COMPLETENESS_POLICY_AUTHORITY_MISSING',
        'authored override authority is unavailable for output comparison',
      ))
    } else {
      const targetState = internalEvidenceOf(evidenceOf(reparsed))
      const targetCarrier = targetState.observedPolicyCarrier
      const expectsCarrierAttribution = target.startsWith('pnpm-') || target === 'bun-text'
      if (expectsCarrierAttribution && targetCarrier === undefined) {
        diagnostics.push(assessedDiagnostic(
          'COMPLETENESS_OUTPUT_POLICY_ATTRIBUTION_MISSING',
          'target policy carrier attribution is unavailable',
          { target },
        ))
      } else if (targetCarrier !== undefined) {
        const carrierMatches = targetCarrier.present
          ? overrideSetKey(targetCarrier.overrides, target) === overrideSetKey(authority, target)
          : authority.length === 0
        if (!carrierMatches) {
          diagnostics.push(assessedDiagnostic(
            'COMPLETENESS_OUTPUT_POLICY_MISMATCH',
            'target lock policy carrier differs from authored authority',
            { target },
          ))
        }
      }
    }
  }

  return {
    accepted: !diagnostics.some(assessedBlockingDiagnostic),
    diagnostics,
  }
}

function pnpmWorkspacePeerEvidenceOf(
  graph: Graph,
  evidence: StringifyAssessedOptions['evidence'],
): PnpmWorkspacePeerProjectionEvidence {
  const state = internalEvidenceOf(evidence ?? evidenceOf(graph))
  return {
    ...(state.repositoryManifests === undefined
      ? {}
      : { repositoryManifests: state.repositoryManifests }),
    packageManifests: state.packageManifests,
    conflictedSubjects: new Set(state.conflicts
      .flatMap(conflict => conflict.subject === undefined ? [] : [conflict.subject])),
  }
}

function pnpmWorkspacePeerRequirement(
  projection: PnpmWorkspacePeerProjection,
): RequirementAssessment {
  const diagnostics: Diagnostic[] = [
    ...projection.gaps.map(gap => ({
      code: 'PNPM_WORKSPACE_PEER_ATTR_MISSING',
      severity: 'warning' as const,
      subject: gap.owner,
      message: `workspace-peer ${gap.owner} → ${gap.workspace} lacks proven native attribution`,
      data: { reason: gap.reason },
    })),
    ...projection.conflicts.map(conflict => ({
      code: 'PNPM_WORKSPACE_PEER_ATTR_COLLISION',
      severity: 'warning' as const,
      subject: conflict.owner,
      message: `workspace-peer ${conflict.owner} → ${conflict.workspace} has conflicting native attribution`,
      data: { reason: conflict.reason },
    })),
  ]
  return Object.freeze({
    key: 'target:pnpm-workspace-peer-projection',
    dimension: 'peerModel',
    status: projection.conflicts.length > 0
      ? 'unsatisfied'
      : projection.gaps.length > 0
        ? 'unassessed'
        : 'satisfied',
    diagnostics: Object.freeze(diagnostics),
  })
}

function pnpmWorkspacePeerRuntime(
  graph: Graph,
  options: StringifyAssessedOptions,
): {
  projection?: PnpmWorkspacePeerProjection
  targetRequirements: readonly RequirementAssessment[]
} {
  if (options.target.format !== 'pnpm-v6' && options.target.format !== 'pnpm-v9') {
    return { targetRequirements: Object.freeze([]) }
  }
  const projection = resolvePnpmWorkspacePeerProjection(
    graph,
    pnpmWorkspacePeerEvidenceOf(graph, options.evidence),
  )
  return {
    projection,
    targetRequirements: Object.freeze([pnpmWorkspacePeerRequirement(projection)]),
  }
}

type CompanionProjectionRuntime = ReturnType<typeof companionProjectionRuntime>

interface AssessedRuntimeBundle {
  readonly output?: string
  readonly assessment: AssessedOutput['assessment']
  readonly companions?: CompanionProjectionRuntime
  readonly outputProbe?: OutputProbeResult
  readonly projected?: ProjectionResult
  readonly targetRequirements?: readonly RequirementAssessment[]
}

interface AssessedRuntimeOptions {
  readonly allowFrozenCandidate?: boolean
}

const BERRY_FROZEN_PROBE_CODES = new Set([
  'RECIPE_INTEGRITY_INCOMPLETE',
  'COMPLETENESS_OUTPUT_GRAPH_MISMATCH',
])

function frozenCandidateOutputProbe(
  target: FormatId,
  pendingBerry: RequirementAssessment | undefined,
  probe: OutputProbeResult,
): OutputProbeResult {
  if (pendingBerry === undefined || !target.startsWith('yarn-berry-') || probe.accepted) return probe
  const codes = probe.diagnostics.map(diagnostic => diagnostic.code)
  if (codes.length === 0
    || !codes.includes('RECIPE_INTEGRITY_INCOMPLETE')
    || !codes.includes('COMPLETENESS_OUTPUT_GRAPH_MISMATCH')
    || codes.some(code => !BERRY_FROZEN_PROBE_CODES.has(code))) return probe
  return Object.freeze({ accepted: true, diagnostics: Object.freeze([]) })
}

function projectionLossDischarged(
  loss: ProjectionLoss,
  graph: Graph,
  options: StringifyAssessedOptions,
  companions: CompanionProjectionRuntime | undefined,
  projectionDigest: string | undefined,
): boolean {
  if (loss.diagnostic.code === 'INTEROP_OVERRIDE_NOT_PROJECTED') {
    return companions?.result.requirement.status === 'satisfied'
  }
  if (loss.class !== 'berry-checksum'
    || options.target.managerVersion === undefined
    || projectionDigest === undefined) return false
  const state = internalEvidenceOf(options.evidence ?? evidenceOf(graph))
  return state.targetOracles.some(oracle =>
    oracle.graph === graph
      && oracle.verification === 'frozen-verified'
      && oracle.target.format === options.target.format
      && oracle.target.managerVersion === options.target.managerVersion
      && oracle.projectionDigest === projectionDigest)
}

function activeProjectionDiagnostics(
  projected: ProjectionResult,
  graph: Graph,
  options: StringifyAssessedOptions,
  companions: CompanionProjectionRuntime | undefined,
  projectionDigest?: string,
  allowFrozenCandidate = false,
): readonly Diagnostic[] {
  const discharged = projected.losses.filter(loss =>
    projectionLossDischarged(loss, graph, options, companions, projectionDigest)
      || (allowFrozenCandidate && loss.class === 'berry-checksum'))
  if (discharged.length === 0) return projected.diagnostics
  const ignored = new Set(discharged.flatMap(loss => [
    diagnosticKey(loss.diagnostic),
    diagnosticKey(projectionWarning(loss)),
  ]))
  return Object.freeze(projected.diagnostics.filter(diagnostic =>
    !ignored.has(diagnosticKey(diagnostic))))
}

function frozenBerryRequirement(losses: readonly ProjectionLoss[]): RequirementAssessment | undefined {
  const pending = losses.filter(loss => loss.class === 'berry-checksum')
  if (pending.length === 0) return undefined
  return Object.freeze({
    key: 'target:projection:berry-checksum',
    dimension: 'artifacts',
    status: 'unassessed',
    diagnostics: Object.freeze(pending.map(loss => Object.freeze({
      code: 'COMPLETENESS_FROZEN_BERRY_CHECKSUM_PENDING',
      severity: 'warning' as const,
      subject: loss.subject,
      message: `${loss.diagnostic.message}; exact pinned Yarn frozen verification is required`,
      data: {
        feature: loss.feature,
        remedy: { kind: 'verify-target', requirement: 'pinned-frozen-oracle' },
      },
    }))),
  })
}

function frozenVerificationRequirement(
  graph: Graph,
  options: StringifyAssessedOptions,
  projectionDigest: string | undefined,
): RequirementAssessment | undefined {
  if (options.contract !== 'frozen'
    || options.target.managerVersion === undefined
    || projectionDigest === undefined) return undefined
  const state = internalEvidenceOf(options.evidence ?? evidenceOf(graph))
  const receipt = state.targetOracles.find(oracle =>
    oracle.graph === graph
      && oracle.verification === 'frozen-verified'
      && oracle.target.format === options.target.format
      && oracle.target.managerVersion === options.target.managerVersion
      && oracle.projectionDigest === projectionDigest)
  if (receipt === undefined) return undefined
  return Object.freeze({
    key: 'target:frozen-verification',
    dimension: 'verification',
    status: 'satisfied',
    diagnostics: Object.freeze([Object.freeze({
      code: 'COMPLETENESS_FROZEN_VERIFIED',
      severity: 'info' as const,
      message: 'exact pinned target accepted the emitted project in frozen mode',
      data: {
        target: receipt.target,
        platform: receipt.platform,
        projectionDigest,
        configDigest: receipt.configDigest,
        inputDigest: receipt.inputDigest,
      },
    })]),
  })
}

function frozenCandidateReady(assessment: AssessedOutput['assessment']): boolean {
  return assessment.contract === 'frozen' && assessment.requirements.every(requirement =>
    requirement.status === 'satisfied'
      || (requirement.status === 'unassessed'
        && (requirement.key === 'target:frozen-verification'
          || requirement.key === 'target:projection:berry-checksum'
          || (assessment.target.capabilities.integrity === 'berry-zip'
            && requirement.key === 'target-feature:integrity:tarball'))))
}

function assessedOutputOf(runtime: AssessedRuntimeBundle): AssessedOutput {
  return runtime.output === undefined
    ? { assessment: runtime.assessment }
    : { output: runtime.output, assessment: runtime.assessment }
}

function stringifyAssessedRuntime(
  graph: Graph,
  options: StringifyAssessedOptions,
  onDiagnostic?: (diagnostic: Diagnostic) => void,
  runtimeOptions: AssessedRuntimeOptions = {},
): AssessedRuntimeBundle {
  const workspacePeer = pnpmWorkspacePeerRuntime(graph, options)
  const companions = options.contract === 'snapshot'
    ? undefined
    : companionProjectionRuntime(graph, {
        target: options.target,
        evidence: options.evidence,
      })
  const targetRequirements: RequirementAssessment[] = [
    ...workspacePeer.targetRequirements,
    ...(companions === undefined ? [] : [
      companions.policyRequirement,
      companions.result.requirement,
    ]),
  ]
  const preflight = assessConversion(graph, options, {
    targetRequirements,
  })
  if (!probeEligible(preflight, runtimeOptions.allowFrozenCandidate)) {
    return { assessment: preflight, companions, targetRequirements }
  }

  const state = internalEvidenceOf(options.evidence ?? evidenceOf(graph))
  const authority = options.contract === 'snapshot'
    ? undefined
    : authoritativePolicyOverridesOf(state)
  const diagnostics: Diagnostic[] = []
  let output: string
  let projected: ProjectionResult
  let pendingBerry: RequirementAssessment | undefined
  try {
    projected = stringifyProjected(options.target.format, graph, {
      lineEnding: options.lineEnding,
      cacheKey: options.cacheKey,
      targetVersion: options.target.managerVersion,
      overrides: authority === undefined ? undefined : [...authority],
      pnpmWorkspacePeerProjection: workspacePeer.projection,
      pnpmWorkspaceNames: companions?.pnpmWorkspaceNames,
    })
    output = projected.output
    const projectionDigest = options.target.managerVersion === undefined || companions?.result.patches === undefined
      ? undefined
      : frozenProjectionDigest({
          format: options.target.format,
          managerVersion: options.target.managerVersion,
        }, output, companions.result.patches)
    pendingBerry = runtimeOptions.allowFrozenCandidate && options.contract === 'frozen'
      ? frozenBerryRequirement(projected.losses)
      : undefined
    if (pendingBerry !== undefined) {
      targetRequirements.push(pendingBerry, Object.freeze({
        ...pendingBerry,
        key: 'target-feature:integrity:tarball',
      }))
    }
    const frozenVerification = frozenVerificationRequirement(graph, options, projectionDigest)
    if (frozenVerification !== undefined) {
      targetRequirements.push(frozenVerification)
      const pendingIndex = targetRequirements.findIndex(item =>
        item.key === 'target:projection:berry-checksum')
      if (pendingIndex >= 0) targetRequirements[pendingIndex] = Object.freeze({
        ...targetRequirements[pendingIndex]!,
        status: 'satisfied',
        diagnostics: frozenVerification.diagnostics,
      })
    }
    for (const diagnostic of activeProjectionDiagnostics(
      projected,
      graph,
      options,
      companions,
      projectionDigest,
      runtimeOptions.allowFrozenCandidate && options.contract === 'frozen',
    )) {
      diagnostics.push(diagnostic)
      onDiagnostic?.(diagnostic)
    }
  } catch (error) {
    diagnostics.push(assessedDiagnostic(
      'COMPLETENESS_OUTPUT_EMIT_FAILED',
      error instanceof Error ? error.message : 'target output emit failed',
      { target: options.target.format },
    ))
    const assessment = assessConversion(graph, options, {
      outputProbe: { accepted: false, diagnostics },
      targetRequirements,
    })
    return { assessment, companions, targetRequirements }
  }

  let probe: OutputProbeResult
  try {
    probe = outputProbe(
      graph,
      output,
      options.target.format,
      options.contract,
      options.evidence,
      diagnostics,
      companions?.pnpmWorkspaceNames,
    )
  } catch (error) {
    diagnostics.push(assessedDiagnostic(
      'COMPLETENESS_OUTPUT_PROBE_FAILED',
      error instanceof Error ? error.message : 'target output comparison failed',
      { target: options.target.format },
    ))
    probe = { accepted: false, diagnostics }
  }
  const effectiveProbe = runtimeOptions.allowFrozenCandidate
    ? frozenCandidateOutputProbe(options.target.format, pendingBerry, probe)
    : probe
  const assessment = assessConversion(graph, options, {
    outputProbe: effectiveProbe,
    targetRequirements,
  })
  const runtime = {
    assessment,
    companions,
    outputProbe: effectiveProbe,
    projected,
    targetRequirements,
  }
  return assessment.status === 'satisfied'
    || (runtimeOptions.allowFrozenCandidate && frozenCandidateReady(assessment))
    ? { ...runtime, output }
    : runtime
}

/** Emits only when canonical and target conversion requirements are satisfied. */
export function stringifyAssessed(
  graph: Graph,
  options: StringifyAssessedOptions,
): AssessedOutput {
  return assessedOutputOf(stringifyAssessedRuntime(graph, options))
}

function failedAssessedConversion(
  options: ConvertAssessedOptions,
  diagnostic: Diagnostic,
): AssessedOutput {
  options.onDiagnostic?.(diagnostic)
  const builder = newBuilder()
  builder.diagnostic({ ...diagnostic, severity: 'warning' })
  const graph = builder.seal()
  const assessment = assessConversion(graph, {
    contract: options.contract,
    target: { format: options.to, managerVersion: options.targetVersion },
  }, {
    outputProbe: { accepted: false, diagnostics: [diagnostic] },
  })
  return { assessment }
}

interface PreparedAssessedConversion {
  readonly graph: Graph
  readonly evidence: EvidenceContext
}

function prepareAssessedConversion(
  input: string,
  options: ConvertAssessedOptions,
  evidenceInputs: readonly ProjectEvidenceInput[] = [],
): PreparedAssessedConversion | AssessedOutput {
  const from = options.from ?? detect(input)
  if (from === undefined) {
    return failedAssessedConversion(options, assessedDiagnostic(
      'COMPLETENESS_SOURCE_FORMAT_UNKNOWN',
      'source lockfile format was not detected',
    ))
  }
  if (options.manifestCoverage === 'complete' && options.manifests === undefined) {
    return failedAssessedConversion(options, assessedDiagnostic(
      'COMPLETENESS_MANIFESTS_MISSING',
      'complete manifest coverage requires supplied manifests',
    ))
  }

  let graph: Graph
  try {
    graph = parse(from, input, {
      workspaceRoot: options.workspaceRoot,
      manifests: options.manifests === undefined ? undefined : { ...options.manifests },
      onDiagnostic: options.onDiagnostic,
    })
  } catch (error) {
    return failedAssessedConversion(options, assessedDiagnostic(
      'COMPLETENESS_SOURCE_PARSE_FAILED',
      error instanceof Error ? error.message : 'source lockfile parse failed',
      { source: from },
    ))
  }

  let evidence = evidenceOf(graph)
  try {
    if (options.sourceVersion !== undefined) evidence = withSourceVersion(evidence, options.sourceVersion)
    if (options.manifestCoverage === 'complete' && options.manifests !== undefined) {
      evidence = withEvidence(evidence, {
        kind: 'repository-manifests',
        manifests: options.manifests,
        coverage: 'complete',
      })
    }
    for (const inputEvidence of evidenceInputs) evidence = withEvidence(evidence, inputEvidence)
  } catch (error) {
    return failedAssessedConversion(options, assessedDiagnostic(
      'COMPLETENESS_EVIDENCE_INVALID',
      error instanceof Error ? error.message : 'conversion evidence is invalid',
    ))
  }

  return { graph, evidence }
}

/** Parses and emits only when the requested conversion contract is satisfied. */
export function convertAssessed(
  input: string,
  options: ConvertAssessedOptions,
): AssessedOutput {
  const prepared = prepareAssessedConversion(input, options)
  if ('assessment' in prepared) return prepared
  return assessedOutputOf(stringifyAssessedRuntime(prepared.graph, {
    contract: options.contract,
    target: { format: options.to, managerVersion: options.targetVersion },
    evidence: prepared.evidence,
    lineEnding: options.lineEnding,
    cacheKey: options.cacheKey,
  }, options.onDiagnostic))
}

/** Produces a project lockfile and companion operations only as one satisfied bundle. */
export function convertProject(
  input: string,
  options: ConvertProjectOptions,
): ProjectConversionResult {
  const assessedOptions: ConvertAssessedOptions = { ...options, contract: 'project' }
  const prepared = prepareAssessedConversion(input, assessedOptions, options.evidenceInputs)
  if ('assessment' in prepared) {
    return Object.freeze({ assessment: prepared.assessment })
  }

  const runtime = stringifyAssessedRuntime(prepared.graph, {
    contract: 'project',
    target: { format: options.to, managerVersion: options.targetVersion },
    evidence: prepared.evidence,
    lineEnding: options.lineEnding,
    cacheKey: options.cacheKey,
  }, options.onDiagnostic)
  if (runtime.assessment.status !== 'satisfied') {
    return Object.freeze({ assessment: runtime.assessment })
  }
  return Object.freeze({
    lockfile: runtime.output!,
    companions: runtime.companions!.result.patches!,
    assessment: runtime.assessment,
  })
}

interface FrozenCandidateState {
  readonly graph: Graph
  readonly evidence: EvidenceContext
  readonly target: Readonly<{ format: FormatId; managerVersion: string }>
  readonly lockfile: string
  readonly companions: readonly CompanionSetOperation[]
  readonly projectionDigest: string
  readonly outputProbe: OutputProbeResult
  readonly targetRequirements: readonly RequirementAssessment[]
}

const frozenCandidateState = new WeakMap<object, FrozenCandidateState>()

function frozenRequirement(
  status: RequirementAssessment['status'],
  diagnostic: Diagnostic,
): RequirementAssessment {
  return Object.freeze({
    key: 'target:frozen-verification',
    dimension: 'verification',
    status,
    diagnostics: Object.freeze([Object.freeze(diagnostic)]),
  })
}

function replaceTargetRequirement(
  requirements: readonly RequirementAssessment[],
  replacement: RequirementAssessment,
): readonly RequirementAssessment[] {
  const output = requirements.filter(requirement => requirement.key !== replacement.key)
  output.push(replacement)
  return Object.freeze(output)
}

function frozenFailure(
  state: FrozenCandidateState,
  diagnostic: Diagnostic,
): FrozenConversionResult {
  const requirement = frozenRequirement('unsatisfied', diagnostic)
  const assessment = assessConversion(state.graph, {
    contract: 'frozen',
    target: state.target,
    evidence: state.evidence,
  }, {
    outputProbe: state.outputProbe,
    targetRequirements: replaceTargetRequirement(state.targetRequirements, requirement),
  })
  return Object.freeze({ assessment })
}

function invalidFrozenCandidate(diagnostic: Diagnostic): FrozenConversionResult {
  const graph = newBuilder().seal()
  const target = { format: 'npm-3' as const, managerVersion: '9.9.4' }
  const requirement = frozenRequirement('unsatisfied', diagnostic)
  const assessment = assessConversion(graph, {
    contract: 'frozen',
    target,
  }, {
    outputProbe: { accepted: false, diagnostics: [diagnostic] },
    targetRequirements: [requirement],
  })
  return Object.freeze({ assessment })
}

function frozenPreparationFailure(
  options: FrozenPreparationOptions,
  diagnostic: Diagnostic,
): FrozenPreparationResult {
  options.onDiagnostic?.(diagnostic)
  const graph = newBuilder().seal()
  const requirement = frozenRequirement('unsatisfied', diagnostic)
  const assessment = assessConversion(graph, {
    contract: 'frozen',
    target: { format: options.to, managerVersion: options.targetVersion },
  }, {
    outputProbe: { accepted: false, diagnostics: [diagnostic] },
    targetRequirements: [requirement],
  })
  return Object.freeze({ assessment })
}

function preparationEvidence(
  graph: Graph,
  prepared: PreparedConvertInput,
  options: FrozenPreparationOptions,
): EvidenceContext {
  let evidence = evidenceOf(graph)
  if (options.sourceVersion !== undefined) evidence = withSourceVersion(evidence, options.sourceVersion)
  const manifests = mergeManifestSources(
    prepared.source,
    prepared.manifests,
    options.manifests,
    options.sources?.manifests,
  )
  if (options.manifestCoverage === 'complete') {
    if (manifests === undefined) throw new TypeError('complete manifest coverage requires supplied manifests')
    evidence = withEvidence(evidence, {
      kind: 'repository-manifests',
      coverage: 'complete',
      manifests,
    })
  }
  for (const input of options.evidenceInputs ?? []) evidence = withEvidence(evidence, input)
  return evidence
}

/**
 * Emits an opaque native-verification challenge. A candidate is deliberately
 * not a frozen-certified result and must never be applied as one.
 */
export async function prepareFrozen(
  input: ConvertInput,
  options: FrozenPreparationOptions,
): Promise<FrozenPreparationResult> {
  if (!EXACT_MANAGER_VERSION.test(options.targetVersion)) {
    return frozenPreparationFailure(options, assessedDiagnostic(
      'COMPLETENESS_FROZEN_TARGET_UNPINNED',
      'frozen verification requires an exact full target manager version',
      { target: options.to, managerVersion: options.targetVersion },
    ))
  }
  if (options.to === 'lockgraph') {
    return frozenPreparationFailure(options, assessedDiagnostic(
      'COMPLETENESS_FROZEN_ORACLE_UNAVAILABLE',
      'lockgraph has no native package-manager frozen oracle',
      { target: options.to },
    ))
  }

  let preparedRuntime: PreparedConversionRuntime
  try {
    preparedRuntime = await prepareConversionRuntime(input, options, {
      ...(options.fs === undefined ? {} : { fs: options.fs }),
      defaultFileSystem,
    }, 'frozen')
  } catch (error) {
    return frozenPreparationFailure(options, assessedDiagnostic(
      'COMPLETENESS_FROZEN_PREPARATION_FAILED',
      error instanceof Error ? error.message : 'frozen candidate preparation failed',
      { target: options.to },
    ))
  }

  let evidence: EvidenceContext
  try {
    evidence = preparationEvidence(preparedRuntime.graph, preparedRuntime.prepared, options)
  } catch (error) {
    return frozenPreparationFailure(options, assessedDiagnostic(
      'COMPLETENESS_EVIDENCE_INVALID',
      error instanceof Error ? error.message : 'frozen conversion evidence is invalid',
    ))
  }

  const preparationLosses = projectionDiagnosticLosses(preparedRuntime.diagnostics, options.to)
  if (preparationLosses.some(loss => loss.class !== 'berry-checksum')) {
    const first = preparationLosses.find(loss => loss.class !== 'berry-checksum')!
    return frozenPreparationFailure(options, assessedDiagnostic(
      'COMPLETENESS_FROZEN_PROJECTION_BLOCKED',
      first.diagnostic.message,
      { feature: first.feature, target: first.target },
    ))
  }

  const runtime = stringifyAssessedRuntime(preparedRuntime.graph, {
    contract: 'frozen',
    target: { format: options.to, managerVersion: options.targetVersion },
    evidence,
    lineEnding: options.lineEnding,
    cacheKey: options.cacheKey,
  }, options.onDiagnostic, { allowFrozenCandidate: true })
  const companions = runtime.companions?.result.patches
  if (runtime.output === undefined
    || companions === undefined
    || runtime.outputProbe === undefined
    || runtime.targetRequirements === undefined
    || !frozenCandidateReady(runtime.assessment)) {
    return Object.freeze({ assessment: runtime.assessment })
  }

  const target = Object.freeze({ format: options.to, managerVersion: options.targetVersion })
  const projectionDigest = frozenProjectionDigest(target, runtime.output, companions)
  const candidate: FrozenCandidate = Object.freeze({
    protocol: FROZEN_PROJECTION_PROTOCOL,
    target,
    projectionDigest,
    lockfile: runtime.output,
    companions,
    assessment: runtime.assessment,
  })
  frozenCandidateState.set(candidate, Object.freeze({
    graph: preparedRuntime.graph,
    evidence,
    target,
    lockfile: runtime.output,
    companions,
    projectionDigest,
    outputProbe: runtime.outputProbe,
    targetRequirements: runtime.targetRequirements,
  }))
  return Object.freeze({ candidate, assessment: runtime.assessment })
}

function receiptDiagnostic(
  candidate: FrozenCandidate,
  receipt: FrozenVerificationReceipt,
): Diagnostic | undefined {
  const nonEmpty = (value: unknown): value is string =>
    typeof value === 'string' && value.length > 0
  if (receipt === null
    || typeof receipt !== 'object'
    || receipt.protocol !== FROZEN_PROJECTION_PROTOCOL
    || receipt.oracle === null
    || typeof receipt.oracle !== 'object'
    || receipt.oracle.protocol !== FROZEN_ORACLE_PROTOCOL
    || receipt.verification !== 'frozen-verified') {
    return assessedDiagnostic(
      'COMPLETENESS_FROZEN_RECEIPT_INVALID',
      'frozen receipt uses an unknown or non-frozen verification protocol',
    )
  }
  if (receipt.target === null
    || typeof receipt.target !== 'object'
    || receipt.target.format !== candidate.target.format
    || receipt.target.managerVersion !== candidate.target.managerVersion
    || receipt.projectionDigest !== candidate.projectionDigest) {
    return assessedDiagnostic(
      'COMPLETENESS_FROZEN_SUBJECT_MISMATCH',
      'frozen receipt does not match the exact candidate target and projection',
      { candidate: candidate.projectionDigest, receipt: receipt.projectionDigest },
    )
  }
  if (!nonEmpty(receipt.platform)
    || typeof receipt.configDigest !== 'string'
    || !SHA256_DIGEST.test(receipt.configDigest)
    || typeof receipt.inputDigest !== 'string'
    || !SHA256_DIGEST.test(receipt.inputDigest)
    || !nonEmpty(receipt.oracle.runner)
    || !nonEmpty(receipt.oracle.version)) {
    return assessedDiagnostic(
      'COMPLETENESS_FROZEN_RECEIPT_INVALID',
      'frozen receipt contains malformed input, config, platform, or oracle identity',
    )
  }
  return undefined
}

/**
 * Refines an opaque candidate with an external native-PM receipt. This checks
 * receipt integrity and exact projection binding; receipt authenticity belongs
 * to the caller/CI authority that ran the PM.
 */
export function certifyFrozen(
  candidate: FrozenCandidate,
  receipt: FrozenVerificationReceipt,
): FrozenConversionResult {
  const state = frozenCandidateState.get(candidate)
  if (state === undefined) {
    return invalidFrozenCandidate(assessedDiagnostic(
      'COMPLETENESS_FROZEN_CANDIDATE_INVALID',
      'frozen candidate was not created by this runtime or is no longer valid',
    ))
  }
  const recomputed = frozenProjectionDigest(state.target, state.lockfile, state.companions)
  if (recomputed !== state.projectionDigest || candidate.projectionDigest !== recomputed) {
    return frozenFailure(state, assessedDiagnostic(
      'COMPLETENESS_FROZEN_CANDIDATE_INVALID',
      'frozen candidate projection state changed after preparation',
    ))
  }
  const invalidReceipt = receiptDiagnostic(candidate, receipt)
  if (invalidReceipt !== undefined) return frozenFailure(state, invalidReceipt)

  let evidence: EvidenceContext
  try {
    evidence = withEvidence(state.evidence, {
      kind: 'target-oracle',
      graph: state.graph,
      target: state.target,
      verification: 'frozen-verified',
      platform: receipt.platform,
      configDigest: receipt.configDigest,
      inputDigest: receipt.inputDigest,
      projectionDigest: receipt.projectionDigest,
    })
  } catch (error) {
    return frozenFailure(state, assessedDiagnostic(
      'COMPLETENESS_FROZEN_RECEIPT_INVALID',
      error instanceof Error ? error.message : 'frozen receipt evidence is invalid',
    ))
  }

  const verified = frozenRequirement('satisfied', {
    code: 'COMPLETENESS_FROZEN_VERIFIED',
    severity: 'info',
    message: 'exact pinned target accepted the emitted project in frozen mode',
    data: {
      target: state.target,
      platform: receipt.platform,
      projectionDigest: receipt.projectionDigest,
      configDigest: receipt.configDigest,
      inputDigest: receipt.inputDigest,
    },
  })
  const targetRequirements = replaceTargetRequirement(
    state.targetRequirements.map(requirement =>
      requirement.key === 'target:projection:berry-checksum'
        || requirement.key === 'target-feature:integrity:tarball'
        ? Object.freeze({ ...requirement, status: 'satisfied' as const, diagnostics: verified.diagnostics })
        : requirement),
    verified,
  )
  const assessment = assessConversion(state.graph, {
    contract: 'frozen',
    target: state.target,
    evidence,
  }, {
    outputProbe: state.outputProbe,
    targetRequirements,
  })
  if (assessment.status !== 'satisfied') return Object.freeze({ assessment })
  return Object.freeze({
    lockfile: state.lockfile,
    companions: state.companions,
    verification: Object.freeze({
      ...receipt,
      target: Object.freeze({ ...receipt.target }),
      oracle: Object.freeze({ ...receipt.oracle }),
    }),
    assessment,
  })
}
