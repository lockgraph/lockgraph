import type { Diagnostic, EdgeKind, Graph, PackageMetadataField } from '../graph.ts'
import type {
  ProjectionLoss,
  ProjectionLossClass,
  ProjectionRemedy,
} from '../api/errors.ts'
import type { FormatId } from '../api/format-contract.ts'
import { emitBerryChecksum, emitSri } from '../recipe/integrity.ts'
import { detectGraphFeatures, type GraphFeature } from './features.ts'
import { targetProfileOf } from './targets.ts'
import type { TargetRequest } from './types.ts'

export interface ProjectionResult {
  readonly output: string
  readonly diagnostics: readonly Diagnostic[]
  readonly losses: readonly ProjectionLoss[]
}

const metadataFeatureFields: Readonly<Record<Extract<GraphFeature, `metadata:${string}`>, readonly PackageMetadataField[]>> = Object.freeze({
  'metadata:engines': ['engines'],
  'metadata:funding': ['funding'],
  'metadata:license': ['license'],
  'metadata:bin': ['bin'],
  'metadata:deprecated': ['deprecated'],
  'metadata:platform': ['cpu', 'os', 'libc'],
  'metadata:install-script': ['hasInstallScript'],
  'metadata:bundled-dependencies': ['bundledDependencies'],
  'metadata:peer-declarations': ['peerDependencies', 'peerDependenciesMeta'],
})

const metadataFeatures = new Set<GraphFeature>(Object.keys(metadataFeatureFields) as GraphFeature[])

function allowLoss(): ProjectionRemedy {
  return Object.freeze({ kind: 'allow-loss', option: 'strict', value: false })
}

function supply(
  source: Extract<ProjectionRemedy, { kind: 'supply' }>['source'],
  subject?: string,
): ProjectionRemedy {
  return Object.freeze({ kind: 'supply', source, ...(subject === undefined ? {} : { subject }) })
}

function projectionDiagnostic(
  lossClass: ProjectionLossClass,
  feature: string,
  target: FormatId,
  message: string,
  subject?: Diagnostic['subject'],
  remedy?: ProjectionRemedy,
): Diagnostic {
  return Object.freeze({
    code: 'PROJECTION_LOSS',
    severity: 'warning',
    ...(subject === undefined ? {} : { subject }),
    message,
    data: Object.freeze({
      class: lossClass,
      feature,
      target,
      remedy: remedy ?? allowLoss(),
    }),
  })
}

function loss(
  lossClass: ProjectionLossClass,
  feature: string,
  target: FormatId,
  diagnostic: Diagnostic,
  remedy: ProjectionRemedy,
): ProjectionLoss {
  return Object.freeze({
    class: lossClass,
    feature,
    target,
    ...(diagnostic.subject === undefined ? {} : { subject: diagnostic.subject }),
    remedy,
    diagnostic,
  })
}

export function classifiedProjectionLoss(
  lossClass: ProjectionLossClass,
  feature: string,
  target: FormatId,
  diagnostic: Diagnostic,
  remedy: ProjectionRemedy,
): ProjectionLoss {
  return loss(lossClass, feature, target, diagnostic, remedy)
}

function inherentFeature(
  feature: string,
  target: FormatId,
  message = `target ${target} cannot faithfully represent ${feature}`,
): ProjectionLoss {
  const remedy = allowLoss()
  return loss(
    'inherent-meaningful',
    feature,
    target,
    projectionDiagnostic('inherent-meaningful', feature, target, message, undefined, remedy),
    remedy,
  )
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

function workspaceFeaturePresent(graph: Graph): boolean {
  for (const node of graph.nodes()) {
    if (node.workspacePath !== undefined && node.workspacePath !== '') return true
    for (const edge of graph.out(node.id)) {
      if (edge.attrs?.workspace === true
        || edge.attrs?.workspaceRange !== undefined
        || edge.attrs?.range?.startsWith('workspace:')) return true
    }
  }
  return false
}

function unsupportedEdgeKinds(graph: Graph, supported: ReadonlySet<EdgeKind>): EdgeKind[] {
  const unsupported = new Set<EdgeKind>()
  for (const node of graph.nodes()) {
    for (const edge of graph.out(node.id)) {
      if (!supported.has(edge.kind)) unsupported.add(edge.kind)
    }
  }
  return [...unsupported].sort()
}

function metadataPreflight(
  graph: Graph,
  target: ReturnType<typeof targetProfileOf>,
  features: ReadonlySet<GraphFeature>,
): ProjectionLoss[] {
  if (target.ambiguousCapabilities.has('metadataFields')) return []
  const losses: ProjectionLoss[] = []
  for (const feature of [...features].filter(item => metadataFeatures.has(item)).sort()) {
    const fields = metadataFeatureFields[feature as keyof typeof metadataFeatureFields]
    const present = fields.filter(field => [...graph.tarballs()].some(([, payload]) =>
      payload[field] !== undefined))
    const unsupported = present.filter(field => !target.capabilities.metadataFields.has(field))
    if (unsupported.length === 0) continue
    losses.push(inherentFeature(
      feature,
      target.format,
      `target ${target.format} cannot preserve package metadata fields: ${unsupported.join(', ')}`,
    ))
  }
  return losses
}

function integrityPreflight(
  graph: Graph,
  target: ReturnType<typeof targetProfileOf>,
): ProjectionLoss[] {
  if (target.capabilities.integrity === 'canonical') return []
  const losses: ProjectionLoss[] = []
  for (const node of [...graph.nodes()].sort((left, right) => left.id.localeCompare(right.id))) {
    const payload = graph.tarballOf(node.id)
    if (target.capabilities.integrity === 'berry-zip') {
      const archiveBacked = node.workspacePath === undefined
        && payload?.resolution?.type !== 'directory'
      if (!archiveBacked) continue
      if (payload?.integrity !== undefined && emitBerryChecksum(payload.integrity) !== undefined) continue
      const remedy = supply('artifacts', node.id)
      const diagnostic = projectionDiagnostic(
        'berry-checksum',
        'integrity:berry-checksum',
        target.format,
        `archive-backed entry ${node.id} would emit without a Berry zip-cache checksum`,
        node.id,
        remedy,
      )
      losses.push(loss(
        'berry-checksum',
        'integrity:berry-checksum',
        target.format,
        diagnostic,
        remedy,
      ))
      continue
    }
    if (target.capabilities.integrity !== 'tarball-sri'
      || payload?.integrity === undefined
      || emitSri(payload.integrity) !== undefined) continue
    const remedy = supply('artifacts', node.id)
    const diagnostic = projectionDiagnostic(
      'enrichable',
      'integrity:tarball-sri',
      target.format,
      `entry ${node.id} carries no target-emittable tarball integrity`,
      node.id,
      remedy,
    )
    losses.push(loss(
      'enrichable',
      'integrity:tarball-sri',
      target.format,
      diagnostic,
      remedy,
    ))
  }
  return losses
}

export function projectionPreflightLosses(
  graph: Graph,
  request: TargetRequest,
): readonly ProjectionLoss[] {
  const target = targetProfileOf(request)
  const detection = detectGraphFeatures(graph)
  const features = detection.features
  const losses: ProjectionLoss[] = []

  if (!target.ambiguousCapabilities.has('edgeKinds')) {
    for (const kind of unsupportedEdgeKinds(graph, target.capabilities.edgeKinds)) {
      losses.push(inherentFeature(`edge:${kind}`, target.format))
    }
  }
  if (features.has('edge:bundled')
    && !target.ambiguousCapabilities.has('bundledDependencies')
    && !target.capabilities.bundledDependencies) {
    losses.push(inherentFeature('edge:bundled', target.format))
  }
  if (features.has('peer-context')
    && !target.ambiguousCapabilities.has('peerRepresentation')
    && target.capabilities.peerRepresentation !== 'virtualized') {
    losses.push(inherentFeature('peer-context', target.format))
  }
  if (features.has('workspace') && workspaceFeaturePresent(graph)) {
    const protocol = workspaceProtocolPresent(graph)
    const ambiguous = target.ambiguousCapabilities.has('workspaces')
      || (protocol && target.ambiguousCapabilities.has('workspaceProtocol'))
    if (!ambiguous && (!target.capabilities.workspaces
      || (protocol && !target.capabilities.workspaceProtocol))) {
      losses.push(inherentFeature('workspace', target.format))
    }
  }
  if (features.has('patch')
    && !target.ambiguousCapabilities.has('patches')
    && !target.capabilities.patches) {
    losses.push(inherentFeature('patch', target.format))
  }
  if (features.has('conditions')
    && !target.ambiguousCapabilities.has('conditions')
    && !target.capabilities.conditions) {
    losses.push(inherentFeature('conditions', target.format))
  }
  if (features.has('catalog')
    && !target.ambiguousCapabilities.has('catalogs')
    && !target.capabilities.catalogs) {
    losses.push(inherentFeature('catalog', target.format))
  }
  if (target.format === 'bun-text') {
    for (const feature of ['resolution:git', 'resolution:directory'] as const) {
      if (features.has(feature)) losses.push(inherentFeature(feature, target.format))
    }
  }
  for (const fact of detection.unmodeled) {
    losses.push(inherentFeature(
      `unmodeled:${fact.path}`,
      target.format,
      `graph fact ${fact.subject}:${fact.path} is outside the projection model`,
    ))
  }
  losses.push(...metadataPreflight(graph, target, features))
  losses.push(...integrityPreflight(graph, target))
  return dedupeProjectionLosses(losses)
}

function featureOfDiagnostic(diagnostic: Diagnostic, target: FormatId): string {
  const feature = diagnostic.data?.feature
  // String.prototype.replaceAll is Node 15+; the package floor is Node 14.18 and
  // esbuild does not polyfill runtime methods for target:node14, so use a regex.
  return typeof feature === 'string' ? feature : diagnostic.code.toLowerCase().replace(/_/g, '-')
    .replace(
      'recipe-integrity-incomplete',
      target.startsWith('yarn-berry-') ? 'integrity:berry-checksum' : 'integrity:tarball-sri',
    )
    .replace(/^recipe-workspace-(?:unresolved|resolved|collapsed)$/, 'workspace')
}

function diagnosticRemedy(diagnostic: Diagnostic): ProjectionRemedy {
  const code = diagnostic.code
  if (code === 'INTEROP_OVERRIDE_NOT_PROJECTED') {
    return Object.freeze({ kind: 'use-project-api', api: 'convertProject' })
  }
  if (code.includes('INTEGRITY') || code.includes('PATCH_BYTES')) {
    return supply('artifacts', typeof diagnostic.subject === 'string' ? diagnostic.subject : undefined)
  }
  if (code.includes('MANIFEST') || code.includes('WORKSPACE') || code.includes('ATTR_MISSING')) {
    return supply('manifests', typeof diagnostic.subject === 'string' ? diagnostic.subject : undefined)
  }
  if (code.includes('UNRESOLVED') || code.includes('PEER_META')) {
    return supply('registry', typeof diagnostic.subject === 'string' ? diagnostic.subject : undefined)
  }
  return allowLoss()
}

function diagnosticLossClass(
  diagnostic: Diagnostic,
  target: FormatId,
): ProjectionLossClass | undefined {
  const code = diagnostic.code
  if (code === 'RECIPE_INTEGRITY_INCOMPLETE') {
    return target.startsWith('yarn-berry-') ? 'berry-checksum' : 'enrichable'
  }
  if (code === 'RECIPE_WORKSPACE_UNRESOLVED'
    || code === 'RECIPE_PEER_META_INCOMPLETE'
    || code === 'CONVERT_WORKSPACE_MANIFEST_MISSING'
    || code === 'CONVERT_PATCH_BYTES_UNAVAILABLE'
    || code.endsWith('_NO_MANIFESTS')
    || code.endsWith('_UNRESOLVED_DEP')
    || code === 'PNPM_WORKSPACE_PEER_ATTR_MISSING') {
    return 'enrichable'
  }
  if (code === 'RECIPE_FEATURE_DROPPED'
    || code === 'RECIPE_WORKSPACE_RESOLVED'
    || code === 'RECIPE_WORKSPACE_COLLAPSED'
    || code === 'OVERRIDE_PARENT_REF_DROPPED'
    || code === 'BUN_OVERRIDE_NESTED_UNSUPPORTED'
    || code === 'INTEROP_OVERRIDE_NOT_PROJECTED'
    || code === 'PNPM_WORKSPACE_PEER_ATTR_COLLISION'
    || code === 'COMPLETENESS_TARGET_FEATURE_UNSUPPORTED'
    || code === 'COMPLETENESS_OUTPUT_GRAPH_MISMATCH'
    || code === 'COMPLETENESS_OUTPUT_FEATURE_MISMATCH'
    || code.endsWith('_PEER_DROPPED')
    || code.endsWith('_PEER_VIRT_FLATTENED')
    || code.endsWith('_WORKSPACES_UNSAFE')
    || code.endsWith('_SETTINGS_DROPPED')) {
    return 'inherent-meaningful'
  }
  return undefined
}

export function projectionDiagnosticLosses(
  diagnostics: readonly Diagnostic[],
  target: FormatId,
): readonly ProjectionLoss[] {
  const losses = diagnostics.flatMap(diagnostic => {
    const lossClass = diagnosticLossClass(diagnostic, target)
    if (lossClass === undefined) return []
    const remedy = diagnosticRemedy(diagnostic)
    return [loss(lossClass, featureOfDiagnostic(diagnostic, target), target, diagnostic, remedy)]
  })
  return dedupeProjectionLosses(losses)
}

function subjectKey(subject: Diagnostic['subject']): string {
  return subject === undefined ? '' : typeof subject === 'string' ? subject : JSON.stringify(subject)
}

function lossKey(item: ProjectionLoss): string {
  return JSON.stringify([item.class, item.feature, item.target, subjectKey(item.subject)])
}

export function dedupeProjectionLosses(
  losses: readonly ProjectionLoss[],
): readonly ProjectionLoss[] {
  const output = new Map<string, ProjectionLoss>()
  for (const item of losses) {
    const key = lossKey(item)
    if (!output.has(key)) output.set(key, item)
  }
  const classOrder: Record<ProjectionLossClass, number> = {
    'inherent-meaningful': 0,
    enrichable: 1,
    'berry-checksum': 2,
  }
  return Object.freeze([...output.values()].sort((left, right) =>
    classOrder[left.class] - classOrder[right.class]
      || left.feature.localeCompare(right.feature)
      || subjectKey(left.subject).localeCompare(subjectKey(right.subject))))
}

export function projectionWarning(loss: ProjectionLoss): Diagnostic {
  return projectionDiagnostic(
    loss.class,
    loss.feature,
    loss.target,
    `accepted ${loss.class} projection loss for ${loss.feature}: ${loss.diagnostic.message}`,
    loss.subject,
    loss.remedy,
  )
}

export function projectionError(losses: readonly ProjectionLoss[]): LockfileErrorInitShape {
  const ordered = dedupeProjectionLosses(losses)
  const inherent = ordered.some(item => item.class === 'inherent-meaningful')
  const first = ordered[0]!
  return {
    code: inherent ? 'IRREDUCIBLE_LOSS' : 'ENRICH_REQUIRED',
    message: `${first.class} projection loss for ${first.feature}: ${first.diagnostic.message}${ordered.length === 1 ? '' : ` (+${ordered.length - 1} more)`}`,
    losses: ordered,
  }
}

type LockfileErrorInitShape = Readonly<{
  code: 'IRREDUCIBLE_LOSS' | 'ENRICH_REQUIRED'
  message: string
  losses: readonly ProjectionLoss[]
}>

export function genericProjectionLoss(
  target: FormatId,
  diagnostic: Diagnostic,
): ProjectionLoss {
  return loss('inherent-meaningful', 'canonical-roundtrip', target, diagnostic, allowLoss())
}
