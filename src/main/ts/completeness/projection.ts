import type { Diagnostic, EdgeKind, Graph, PackageMetadataField } from '../graph.ts'
import { isBunTextFormat } from '../api/format-contract.ts'
import type {
  ProjectionLoss,
  ProjectionLossClass,
  ProjectionRemedy,
} from '../api/errors.ts'
import type { FormatId } from '../api/format-contract.ts'
import { emitBerryChecksum, emitSri } from '../recipe/integrity.ts'
import { evidenceOf, internalEvidenceOf } from './evidence.ts'
import { detectGraphFeatures, type GraphFeature } from './features.ts'
import { targetProfileOf } from './targets.ts'
import type { TargetRequest } from './types.ts'
import { stripRegistrySha1Fragment } from '../recipe/resolution.ts'
import { denoDeclarationRangeProjections } from '../formats/_deno-core.ts'
import {
  linkTypeOfResolution,
  yarnBerryChecksumFreeNodes,
} from '../formats/_yarn-berry-core.ts'

// === PROJECTION MODEL =======================================================

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

const yarnMetadataDropTargets = Object.freeze(new Set<FormatId>([
  'yarn-classic',
  'yarn-berry-v4',
  'yarn-berry-v5',
  'yarn-berry-v6',
  'yarn-berry-v7',
  'yarn-berry-v8',
  'yarn-berry-v9',
  'yarn-berry-v10',
]))

/** Frozen-clean metadata drops verified per (field, target) pair. This is an
 * explicit allowlist, not the complement of the target capability table. */
const structuralExpectedMetadataDrops: ReadonlyMap<PackageMetadataField, ReadonlySet<FormatId>> =
  new Map([
    ['engines', yarnMetadataDropTargets],
    ['funding', yarnMetadataDropTargets],
    ['license', yarnMetadataDropTargets],
    ['deprecated', yarnMetadataDropTargets],
    ['bin', Object.freeze(new Set<FormatId>(['yarn-classic']))],
  ])

export function isStructuralExpectedDrop(
  field: PackageMetadataField,
  target: FormatId,
): boolean {
  return structuralExpectedMetadataDrops.get(field)?.has(target) === true
}

export function projectedStructuralMetadataDrops(
  graph: Graph,
  target: FormatId,
): ReadonlyMap<string, ReadonlySet<PackageMetadataField>> | undefined {
  const projected = new Map<string, ReadonlySet<PackageMetadataField>>()
  for (const [key, payload] of graph.tarballs()) {
    const fields = [...structuralExpectedMetadataDrops.keys()]
      .filter(field => payload[field] !== undefined && isStructuralExpectedDrop(field, target))
    if (fields.length > 0) projected.set(key, Object.freeze(new Set(fields)))
  }
  return projected.size === 0 ? undefined : projected
}

// === LOSS CLASSIFICATION ====================================================

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

function structuralExpectedFeature(
  field: PackageMetadataField,
  target: FormatId,
): ProjectionLoss {
  const feature = `metadata:${field}`
  const remedy = allowLoss()
  return loss(
    'structural-expected',
    feature,
    target,
    projectionDiagnostic(
      'structural-expected',
      feature,
      target,
      `target ${target} structurally omits frozen-clean package metadata field ${field}`,
      undefined,
      remedy,
    ),
    remedy,
  )
}

function structuralExpectedIntegrityFeature(
  feature: 'integrity:tarball-sri' | 'integrity:berry-zip' | 'integrity:url-fragment',
  target: FormatId,
  subject: string,
): ProjectionLoss {
  const remedy = allowLoss()
  return loss(
    'structural-expected',
    feature,
    target,
    projectionDiagnostic(
      'structural-expected',
      feature,
      target,
      `target ${target} structurally omits retained ${feature} authority for ${subject}`,
      subject,
      remedy,
    ),
    remedy,
  )
}

// === GRAPH PREFLIGHT ========================================================

function workspaceProtocolPresent(graph: Graph): boolean {
  for (const node of graph.nodes()) {
    for (const edge of graph.out(node.id)) {
      if (edge.attrs?.workspaceRange?.specifier.startsWith('workspace:')
        || edge.attrs?.range?.startsWith('workspace:')) {
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
    const structuralExpected = unsupported.filter(field =>
      isStructuralExpectedDrop(field, target.format))
    const inherent = unsupported.filter(field =>
      !isStructuralExpectedDrop(field, target.format))
    for (const field of structuralExpected) {
      losses.push(structuralExpectedFeature(field, target.format))
    }
    if (inherent.length > 0) {
      losses.push(inherentFeature(
        feature,
        target.format,
        `target ${target.format} cannot preserve package metadata fields: ${inherent.join(', ')}`,
      ))
    }
  }
  return losses
}

/** NodeIds whose source entry DID carry an integrity field the parser could not
 * decode. The digest is gone from the payload, so absence there is a dropped
 * authority — never a source-authoritative omission. */
function droppedSourceIntegrityNodes(graph: Graph): ReadonlySet<string> {
  const dropped = new Set<string>()
  for (const diagnostic of graph.diagnostics()) {
    if (!diagnostic.code.endsWith('_INVALID_INTEGRITY')) continue
    if (typeof diagnostic.subject === 'string') dropped.add(diagnostic.subject)
  }
  return dropped
}

function integrityPreflight(
  graph: Graph,
  target: ReturnType<typeof targetProfileOf>,
): ProjectionLoss[] {
  if (target.capabilities.integrity === 'canonical') return []
  const losses: ProjectionLoss[] = []
  // Both sets cost a graph traversal, so they are built only once a node
  // actually reaches the Berry checksum demand.
  let checksumFree: ReadonlySet<string> | undefined
  let droppedIntegrity: ReadonlySet<string> | undefined
  const authoredWithoutChecksum = (nodeId: string): boolean => {
    checksumFree ??= yarnBerryChecksumFreeNodes(graph, target.format)
    if (!checksumFree.has(nodeId)) return false
    droppedIntegrity ??= droppedSourceIntegrityNodes(graph)
    return !droppedIntegrity.has(nodeId)
  }
  for (const node of [...graph.nodes()].sort((left, right) => left.id.localeCompare(right.id))) {
    const payload = graph.tarballOf(node.id)
    if (target.capabilities.integrity === 'berry-zip') {
      if (payload?.integrity?.hashes.some(hash => hash.origin !== 'berry-zip') === true) {
        losses.push(structuralExpectedIntegrityFeature(
          'integrity:tarball-sri',
          target.format,
          node.id,
        ))
      }
      if (payload?.resolution?.type === 'tarball'
        && stripRegistrySha1Fragment(payload.resolution.url) !== payload.resolution.url) {
        losses.push(structuralExpectedIntegrityFeature(
          'integrity:url-fragment',
          target.format,
          node.id,
        ))
      }
      const archiveBacked = node.workspacePath === undefined
        && payload?.resolution?.type !== 'directory'
        && linkTypeOfResolution(payload?.nativeResolution) === 'hard'
      if (!archiveBacked) continue
      if (payload?.integrity !== undefined && emitBerryChecksum(payload.integrity) !== undefined) continue
      // Yarn's own writer omits `checksum` for an entry it never materialised,
      // so for those entries the field's absence is what the producer authored
      // and there is no authority to lose. Gated on holding NO digest at all:
      // a held-but-unemittable digest, or one the parser had to drop, is a real
      // loss and still blocks (`yarnBerryChecksumFreeNodes` needs a verbatim
      // parsed `conditions:`, so a converted graph is never excused).
      if (payload?.integrity === undefined && authoredWithoutChecksum(node.id)) continue
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
    if (target.capabilities.integrity !== 'tarball-sri') continue
    if (payload?.integrity?.hashes.some(hash => hash.origin === 'berry-zip') === true
      || payload?.berryChecksumCacheKey !== undefined) {
      losses.push(structuralExpectedIntegrityFeature(
        'integrity:berry-zip',
        target.format,
        node.id,
      ))
    }
    if (payload?.integrity === undefined || emitSri(payload.integrity) !== undefined) continue
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

function denoDeclarationRangePreflight(
  graph: Graph,
  target: ReturnType<typeof targetProfileOf>,
): ProjectionLoss[] {
  const remedy = allowLoss()
  return denoDeclarationRangeProjections(graph, target.format).map(projection => {
    const feature = projection.carrier === 'peerDependencies'
      ? 'metadata:peer-declaration-range'
      : projection.carrier === 'optionalDependencies'
        ? 'metadata:optional-dependency-declaration-range'
        : 'metadata:dependency-declaration-range'
    return (
      loss(
        'structural-expected',
        feature,
        target.format,
        projectionDiagnostic(
          'structural-expected',
          feature,
          target.format,
          `target ${target.format} carries resolved ${projection.carrier} member ${projection.name} as exact ${projection.to} rather than declared range ${projection.from}`,
          projection.subject,
          remedy,
        ),
        remedy,
      )
    )
  })
}

function manifestExtensionProvenancePreflight(
  graph: Graph,
  target: ReturnType<typeof targetProfileOf>,
): ProjectionLoss[] {
  const state = internalEvidenceOf(evidenceOf(graph))
  const observed = state.observedManifestKnowledge
  if (state.source?.format !== 'npm-4'
    || target.format === 'npm-4'
    || observed === undefined
    || observed.fingerprints.length === 0) return []

  return [inherentFeature(
    'manifest-extension-provenance',
    target.format,
    `target ${target.format} cannot preserve npm-4 manifest-extension fingerprints and applied provenance`,
  )]
}

function npm4PatchCarrierPreflight(
  graph: Graph,
  target: ReturnType<typeof targetProfileOf>,
): ProjectionLoss[] {
  const state = internalEvidenceOf(evidenceOf(graph))
  if (state.source?.format !== 'npm-4'
    || target.format === 'npm-4'
    || ![...graph.nodes()].some(node => node.patch !== undefined)) return []

  return [inherentFeature(
    'patch',
    target.format,
    `target ${target.format} cannot replay npm-4's native raw-SRI / path patch carrier`,
  )]
}

function npm4BunGraphShapePreflight(
  graph: Graph,
  target: ReturnType<typeof targetProfileOf>,
): ProjectionLoss[] {
  const state = internalEvidenceOf(evidenceOf(graph))
  if (state.source?.format !== 'npm-4' || !isBunTextFormat(target.format)) return []

  const losses: ProjectionLoss[] = []
  const nodes = [...graph.nodes()]
  const root = nodes.find(node => node.workspacePath === '')
  if (root !== undefined && root.version !== '0.0.0') {
    losses.push(inherentFeature(
      'workspace-root-version',
      target.format,
      `target bun-text does not encode the npm-4 root workspace version ${root.version}`,
    ))
  }

  const idsByName = new Map<string, Set<string>>()
  for (const node of nodes) {
    if (node.workspacePath !== undefined) continue
    const ids = idsByName.get(node.name) ?? new Set<string>()
    ids.add(node.id)
    idsByName.set(node.name, ids)
  }
  for (const [name, ids] of idsByName) {
    if (ids.size < 2) continue
    const edgeTargets = new Set<string>()
    for (const node of nodes) {
      for (const edge of graph.out(node.id)) {
        if (ids.has(edge.dst)) edgeTargets.add(edge.dst)
      }
    }
    if (edgeTargets.size < 2) continue
    losses.push(inherentFeature(
      'bun-package-key-resolution',
      target.format,
      `target bun-text cannot preserve edges to multiple ${name} versions without source-native de-hoist keys`,
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
  if (isBunTextFormat(target.format)) {
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
  losses.push(...denoDeclarationRangePreflight(graph, target))
  losses.push(...npm4PatchCarrierPreflight(graph, target))
  losses.push(...manifestExtensionProvenancePreflight(graph, target))
  losses.push(...npm4BunGraphShapePreflight(graph, target))
  return dedupeProjectionLosses(losses)
}

// === DIAGNOSTIC CLASSIFICATION ==============================================

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
  if (code === 'COMPLETENESS_OUTPUT_UNRESOLVED_DECLARATION_DROPPED') {
    return allowLoss()
  }
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
    || code === 'COMPLETENESS_TARGET_COMPATIBILITY_OVERLAY_REQUIRED'
    || code.endsWith('_NO_MANIFESTS')
    || code.endsWith('_UNRESOLVED_DEP')
    || code === 'PNPM_WORKSPACE_PEER_ATTR_MISSING'
    // A pnpm `snapshots`/inline `link:` slot the seal admits no dependency edge
    // for (: a published package may not depend on a workspace member).
    // The slot survives same-format emit as an unresolved-dependency
    // declaration; cross-format it drops, exactly as it did while these were
    // reported as `PNPM_UNRESOLVED_DEP` — same class, so strictness is
    // unchanged by the rename.
    || code === 'PNPM_WORKSPACE_LINK_PEER_BOUND'
    || code === 'PNPM_WORKSPACE_LINK_EDGE_DROPPED'
    // A supplied override that a yarn/npm/bun lock structurally cannot carry (no
    // overrides block) stays declared in the project manifest (resolutions /
    // overrides) — where it was read from — so an immutable install still honours
    // it. Recoverable via the project API (remedy: use-project-api convertProject),
    // not an irreducible loss; keep raw strict at ENRICH_REQUIRED, not IRREDUCIBLE.
    || code === 'INTEROP_OVERRIDE_NOT_PROJECTED') {
    return 'enrichable'
  }
  if (code === 'RECIPE_FEATURE_DROPPED'
    || code === 'DENO_JSR_PACKAGES_DROPPED'
    || code === 'DENO_ORPHANED_SECTION_DROPPED'
    || code === 'DENO_REMOTE_PACKAGES_DROPPED'
    || code === 'COMPLETENESS_ADAPTER_STATE_LOST'
    || code === 'RECIPE_WORKSPACE_RESOLVED'
    || code === 'RECIPE_WORKSPACE_COLLAPSED'
    || code === 'OVERRIDE_PARENT_REF_DROPPED'
    || code === 'BUN_OVERRIDE_NESTED_UNSUPPORTED'
    || code === 'PNPM_WORKSPACE_PEER_ATTR_COLLISION'
    || code === 'COMPLETENESS_TARGET_FEATURE_UNSUPPORTED'
    || code === 'COMPLETENESS_OUTPUT_GRAPH_MISMATCH'
    || code === 'COMPLETENESS_OUTPUT_FEATURE_MISMATCH'
    || code === 'COMPLETENESS_OUTPUT_UNRESOLVED_DECLARATION_DROPPED'
    || code.endsWith('_UNKNOWN_METADATA_DROPPED')
    || code.endsWith('_PEER_DROPPED')
    || code.endsWith('_PEER_VIRT_FLATTENED')
    || code.endsWith('_WORKSPACES_UNSAFE')
    || code.endsWith('_SETTINGS_DROPPED')
    || code.endsWith('_NATIVE_SECTION_DROPPED')
    || code.endsWith('_V5_ENTRY_FIELDS_DROPPED')) {
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

// === PROJECTION REPORTING ===================================================

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
    'structural-expected': 3,
  }
  return Object.freeze([...output.values()].sort((left, right) =>
    classOrder[left.class] - classOrder[right.class]
      || left.feature.localeCompare(right.feature)
      || subjectKey(left.subject).localeCompare(subjectKey(right.subject))))
}

export function blockingProjectionLosses(
  losses: readonly ProjectionLoss[],
): readonly ProjectionLoss[] {
  return dedupeProjectionLosses(losses.filter(item => item.class !== 'structural-expected'))
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
