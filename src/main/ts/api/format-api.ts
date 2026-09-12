import type {
  Diagnostic,
  EdgeKind,
  Graph,
  Manifest,
  OverrideConstraint,
  PackageMetadataField,
  TarballPayload,
} from '../graph.ts'
import { toTarballKey } from '../graph.ts'
import { isBunTextFormat } from './format-contract.ts'
import { LockfileError } from './errors.ts'
import type {
  FormatId,
  ParseOptions,
  StringifyOptions,
} from './format-contract.ts'
import {
  FORMAT_REGISTRY,
  checkFormat,
  detectFormat,
  formatAdapterStateCompatible,
  formatAdapterStateSubjects,
  hasFormatAdapterState,
  parseFormat,
  stringifyFormat,
  type StringifyDispatchContext,
} from './format-registry.ts'
import {
  adapterMutationLineageOf,
  attachParsedMutationLineage,
} from './mutation-lineage.ts'
import { getFlatSidecar } from '../formats/_npm-core.ts'
import { npm4ManifestExtensionFeatureOf } from '../formats/npm-4.ts'
import {
  getPnpmOverridesCanonical,
  pnpmManifestExtensionFeatureOf,
} from '../formats/_pnpm-flat-core.ts'
import { composeConditionsFromPayload } from '../formats/_yarn-berry-core.ts'
import { denoDeclarationRangeProjections } from '../formats/_deno-core.ts'
import * as bunText from '../formats/bun-text.ts'
import * as pnpmV5 from '../formats/pnpm-v5.ts'
import * as yarnClassic from '../formats/yarn-classic.ts'
import {
  attachParsedEvidence,
  type InternalEvidenceState,
} from '../completeness/evidence.ts'
import { detectGraphFeatures } from '../completeness/features.ts'
import { targetProfileOf } from '../completeness/targets.ts'
import type { ConversionContract } from '../completeness/types.ts'
import {
  dedupeProjectionLosses,
  blockingProjectionLosses,
  genericProjectionLoss,
  projectedStructuralMetadataDrops,
  projectionDiagnosticLosses,
  projectionError,
  projectionPreflightLosses,
  projectionWarning,
  type ProjectionResult,
} from '../completeness/projection.ts'
import { captureOverrides, reportYarnOverridesNotProjected, type OverridePM } from '../recipe/overrides.ts'
import { governingOverrideFor } from '../recipe/descriptor-resolve.ts'
import {
  emitBerryChecksum,
  emitSri,
  parseBerryChecksum,
  parseSri,
  type Integrity,
} from '../recipe/integrity.ts'
import {
  parse as parseResolution,
  stringifyForYarnBerry,
  type ResolutionCanonical,
} from '../recipe/resolution.ts'
import {
  UNRESOLVED_DEPENDENCY_FEATURE,
  unresolvedDependencyDeclarationsOf,
  unresolvedDependencyProjectionKey,
} from '../recipe/unresolved-dependency.ts'
import {
  yarnBerryPluginCompatGapDiagnostics,
} from '../enrich/yarn-berry-plugin-compat.ts'
import {
  getManifestOverrides,
  mergeOverrides,
  rememberManifestOverrides,
} from '../recipe/override-carrier.ts'

// === PROJECTION-AWARE STRINGIFY =============================================

export type StringifyDispatchOptions = StringifyDispatchContext

function observedPolicyCarrier(
  format: FormatId,
  graph: Graph,
): readonly OverrideConstraint[] | null | undefined {
  const carrier = format === 'pnpm-v5'
    ? pnpmV5.getPnpmV5OverridesCanonical(graph)
    : format === 'pnpm-v6' || format === 'pnpm-v9'
      ? getPnpmOverridesCanonical(graph)
      : isBunTextFormat(format)
        ? bunText.getBunOverridesCanonical(graph)
        : undefined
  return format.startsWith('pnpm-') || isBunTextFormat(format)
    ? carrier ?? null
    : undefined
}

function observedManifestKnowledge(
  format: FormatId,
  graph: Graph,
): InternalEvidenceState['observedManifestKnowledge'] {
  if (format !== 'pnpm-v6' && format !== 'pnpm-v9' && format !== 'npm-4') return undefined
  const observed = format === 'npm-4'
    ? npm4ManifestExtensionFeatureOf(graph)
    : pnpmManifestExtensionFeatureOf(graph)
  if (!observed.available || observed.fingerprints.length === 0) return undefined
  return Object.freeze({
    knowledge: 'extended-fingerprinted',
    fingerprints: observed.fingerprints,
  })
}

export function diagnosticKey(diagnostic: Diagnostic): string {
  return JSON.stringify([
    diagnostic.code,
    diagnostic.severity,
    diagnostic.subject ?? null,
    diagnostic.message,
  ])
}

function uniqueDiagnostics(diagnostics: readonly Diagnostic[]): readonly Diagnostic[] {
  const output = new Map<string, Diagnostic>()
  for (const diagnostic of diagnostics) {
    const key = diagnosticKey(diagnostic)
    if (!output.has(key)) output.set(key, Object.freeze({ ...diagnostic }))
  }
  return Object.freeze([...output.values()])
}

export function stringifyProjected(
  format: FormatId,
  graph: Graph,
  options: StringifyDispatchOptions = {},
): ProjectionResult {
  const emittedDiagnostics: Diagnostic[] = []
  const lineage = adapterMutationLineageOf(graph)
  if (lineage !== undefined
    && !formatAdapterStateCompatible(lineage.sourceFormat, format)) {
    for (const subject of lineage.adapterStateSubjects) {
      emittedDiagnostics.push(assessedDiagnostic(
        'COMPLETENESS_ADAPTER_STATE_LOST',
        `${lineage.sourceFormat} native carrier ${JSON.stringify(subject)} is same-format only and is dropped by ${format}`,
        {
          feature: subject,
          sourceFormat: lineage.sourceFormat,
          target: format,
        },
      ))
    }
  }
  if (lineage?.mutated === true
    && lineage.adapterStateRequired
    && !hasFormatAdapterState(lineage.sourceFormat, graph)) {
    const subjects = lineage.adapterStateSubjects.length > 0
      ? lineage.adapterStateSubjects
      : ['adapter-state']
    for (const subject of subjects) {
      emittedDiagnostics.push(assessedDiagnostic(
        'COMPLETENESS_ADAPTER_STATE_LOST',
        `public mutation detached load-bearing ${lineage.sourceFormat} adapter state carrier ${JSON.stringify(subject)}; strict output cannot prove frozen fidelity`,
        {
          feature: subject,
          sourceFormat: lineage.sourceFormat,
          target: format,
        },
      ))
    }
  }
  if (options.overrides !== undefined
    && options.overrides.length > 0
    && format.startsWith('yarn')) {
    reportYarnOverridesNotProjected(options.overrides.length, diagnostic => {
      emittedDiagnostics.push(diagnostic)
    })
  }
  const output = stringifyFormat(format, graph, {
    ...options,
    onDiagnostic: diagnostic => emittedDiagnostics.push(diagnostic),
  })
  const preflight = projectionPreflightLosses(graph, {
    format,
    ...(options.targetVersion === undefined ? {} : { managerVersion: options.targetVersion }),
  })
  const emittedLosses = projectionDiagnosticLosses(emittedDiagnostics, format)
  let losses = dedupeProjectionLosses([...preflight, ...emittedLosses])
  const probeDiagnostics = projectionOutputDiagnostics(
    graph,
    output,
    format,
    options.overrides,
    options.pnpmWorkspaceNames,
    options.targetVersion,
  )
  if (blockingProjectionLosses(losses).length === 0 && probeDiagnostics.length > 0) {
    const classified = projectionDiagnosticLosses(probeDiagnostics, format)
    losses = dedupeProjectionLosses([
      ...losses,
      ...(classified.length > 0
        ? classified
        : [genericProjectionLoss(format, probeDiagnostics[0]!)]),
    ])
  }
  const diagnostics = uniqueDiagnostics([
    ...emittedDiagnostics,
    ...preflight.map(item => item.diagnostic),
    ...probeDiagnostics,
    ...losses.map(projectionWarning),
  ])
  for (const diagnostic of diagnostics) options.onDiagnostic?.(diagnostic)
  return Object.freeze({ output, diagnostics, losses })
}

// === FORMAT DETECTION AND PARSING ===========================================

/**
 * Runtime membership test over the shipped format ids. Argument-order dispatch
 * below relies on it: a lockfile body is never a bare format id, and a `Graph`
 * is never a string, so the two orders are always distinguishable.
 */
export function isFormatId(value: unknown): value is FormatId {
  return typeof value === 'string'
    && Object.prototype.hasOwnProperty.call(FORMAT_REGISTRY, value)
}

/** Options bag carrying the format inline, mirroring `convert(input, { to })`. */
export type ParseOptionsWithFormat = ParseOptions & { format?: FormatId }
export type StringifyOptionsWithFormat = StringifyOptions & { format?: FormatId }

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasKeyDeep(value: unknown, key: string): boolean {
  const pending: unknown[] = [value]
  while (pending.length > 0) {
    const candidate = pending.pop()
    if (Array.isArray(candidate)) {
      for (const item of candidate) pending.push(item)
      continue
    }
    if (!isUnknownRecord(candidate)) continue
    if (Object.prototype.hasOwnProperty.call(candidate, key)) return true
    for (const item of Object.values(candidate)) pending.push(item)
  }
  return false
}

function undetectedNpmDiagnostic(input: string): Diagnostic | undefined {
  let value: unknown
  try { value = JSON.parse(input) } catch { return undefined }
  if (!isUnknownRecord(value)) return undefined

  const hasLockfileVersion = Object.prototype.hasOwnProperty.call(value, 'lockfileVersion')
  const dependencies = value.dependencies
  if (!hasLockfileVersion
    && isUnknownRecord(dependencies)
    && Object.keys(dependencies).length > 0
    && !hasKeyDeep(value, 'integrity')) {
    return Object.freeze({
      code: 'NPM_SHRINKWRAP_PRE_LOCKFILE_VERSION',
      severity: 'error',
      message: 'parse: pre-npm-5 shrinkwrap has no lockfileVersion or integrity digests; conversion is refused',
    })
  }

  const version = value.lockfileVersion
  const packages = value.packages
  const hasPackagesRoot = isUnknownRecord(packages)
    && Object.prototype.hasOwnProperty.call(packages, '')
  if ((version === 2 || version === 3) && !hasPackagesRoot) {
    return Object.freeze({
      code: 'NPM_LOCKFILE_STRUCTURE_MISSING',
      severity: 'error',
      message: `parse: npm lockfileVersion ${version} is missing the required packages root entry packages[""]; npm writes it even for dependency-free projects`,
    })
  }
  return undefined
}

function requireFormat(
  format: FormatId | undefined,
  subject: 'parse' | 'stringify',
  input?: string,
): FormatId {
  if (format !== undefined) return format
  const diagnostic = subject === 'parse' && input !== undefined
    ? undetectedNpmDiagnostic(input)
    : undefined
  throw new LockfileError({
    code: subject === 'parse' ? 'FORMAT_DETECT_FAILED' : 'INVALID_INPUT',
    message: subject === 'parse'
      ? 'parse: format could not be detected from the input; pass it explicitly'
      : 'stringify: target format is required; pass it as an argument or as options.format',
    ...(diagnostic === undefined ? {} : { diagnostics: [diagnostic] }),
  })
}

export function check(input: string, format: FormatId): boolean
export function check(format: FormatId, input: string): boolean
export function check(a: string, b: string): boolean {
  const legacy = isFormatId(a) && !isFormatId(b)
  return checkFormat((legacy ? a : b) as FormatId, legacy ? b : a)
}

export function detect(input: string): FormatId | undefined {
  return detectFormat(input)
}

export function parse(input: string, format?: FormatId, options?: ParseOptions): Graph
export function parse(input: string, options: ParseOptionsWithFormat): Graph
export function parse(format: FormatId, input: string, options?: ParseOptions): Graph
export function parse(
  a: string,
  b?: FormatId | string | ParseOptionsWithFormat,
  c?: ParseOptions,
): Graph {
  // Legacy format-first order stays callable; everything else reads input-first.
  if (isFormatId(a) && typeof b === 'string' && !isFormatId(b))
    return parseResolved(a, b, c ?? {})

  if (typeof b === 'string')
    return parseResolved(b as FormatId, a, c ?? {})

  const { format, ...rest } = (b ?? {}) as ParseOptionsWithFormat
  return parseResolved(format ?? detectFormat(a), a, rest)
}

function parseResolved(
  requested: FormatId | undefined,
  input: string,
  options: ParseOptions = {},
): Graph {
  const format = requireFormat(requested, 'parse', input)
  if (options.sources?.policy !== undefined && options.overrides !== undefined) {
    throw new LockfileError({
      code: 'INVALID_INPUT',
      message: 'parse: sources.policy cannot be combined with legacy overrides',
    })
  }
  const declaredOverrides = options.sources?.policy === undefined
    ? options.overrides
    : [...options.sources.policy.overrides]
  // Capture manifest override authority before parse because yarn edge binding
  // needs the canonical override map while resolving descriptors.
  const manifestOverrides = options.manifests !== undefined
    ? captureManifestOverrides(format, options.manifests, options.onDiagnostic)
    : undefined
  const overrides = manifestOverrides === undefined
    ? declaredOverrides
    : mergeOverrides(declaredOverrides ?? [], manifestOverrides)
  let graph = parseFormat(format, input, {
    workspaceRoot: options.cwd ?? options.workspaceRoot,
    overrides,
    manifests: options.manifests,
  })
  if (format === 'yarn-classic' && options.manifests !== undefined) {
    const enriched = yarnClassic.enrich(graph, undefined, {
      manifests: options.manifests,
      overrides,
    })
    graph = enriched.graph
    if (options.onDiagnostic !== undefined) {
      for (const diagnostic of enriched.diagnostics) options.onDiagnostic(diagnostic)
    }
  }
  if (overrides !== undefined && overrides.length > 0) {
    rememberManifestOverrides(graph, overrides)
  }
  if (options.onDiagnostic !== undefined) {
    for (const diagnostic of graph.diagnostics()) options.onDiagnostic(diagnostic)
  }
  attachParsedEvidence(
    graph,
    format,
    options.manifests,
    observedPolicyCarrier(format, graph),
    observedManifestKnowledge(format, graph),
  )
  attachParsedMutationLineage(
    graph,
    format,
    hasFormatAdapterState(format, graph),
    formatAdapterStateSubjects(format, graph),
  )
  return graph
}

// === OVERRIDES AND STRINGIFY DISPATCH =======================================

/** Map a FormatId to its override grammar family (capture). */
export function packageManagerFamilyOf(format: FormatId): OverridePM {
  if (format.startsWith('yarn')) return 'yarn'
  if (format.startsWith('pnpm')) return 'pnpm'
  return 'npm'
}

function captureManifestOverrides(
  format: FormatId,
  manifests: Record<string, Manifest>,
  onDiagnostic?: (diagnostic: Diagnostic) => void,
): OverrideConstraint[] {
  const pm = packageManagerFamilyOf(format)
  let captured: OverrideConstraint[] = []
  for (const key of Object.keys(manifests).sort()) {
    const manifest = manifests[key]!
    if (manifest.overrides !== undefined && manifest.overrides.length > 0) {
      captured = mergeOverrides(captured, manifest.overrides)
      continue
    }
    const block =
      pm === 'npm' ? manifest.native?.npmOverrides
        : pm === 'yarn' ? manifest.native?.yarnResolutions
          : manifest.native?.pnpmOverrides
    if (block === undefined) continue
    captured = mergeOverrides(
      captured,
      captureOverrides(block, pm, onDiagnostic).canonical,
    )
  }
  return captured
}

export function overridesOf(graph: Graph): OverrideConstraint[] {
  const manifest = getManifestOverrides(graph) ?? []
  const lockBorne =
    getFlatSidecar(graph)?.rootMeta?.overrides
      ?? getPnpmOverridesCanonical(graph)
      ?? pnpmV5.getPnpmV5OverridesCanonical(graph)
      ?? bunText.getBunOverridesCanonical(graph)
      ?? []
  return mergeOverrides(mergeOverrides(lockBorne, manifest), pinnedOverrides(graph))
}

/** Recreate the declared policy context needed to reparse an emitted yarn lock.
 *
 * A yarn lock does not encode whether an otherwise-identical descriptor binding
 * was selected normally, by `--force`, or by a project resolution. The source
 * graph does: every governed edge carries `overrideRange`. Turn those stamps
 * into exact, parent-scoped constraints and merge them over any caller/carrier
 * authority so the output probe resolves and re-attributes exactly those edges
 * without inventing governance for an ordinary out-of-range binding.
 */
export function reparseOverrideContext(
  graph: Graph,
  declared: readonly OverrideConstraint[] = [],
): OverrideConstraint[] {
  const governed: OverrideConstraint[] = []
  for (const source of graph.nodes()) {
    for (const edge of graph.out(source.id)) {
      const range = edge.attrs?.range
      const to = edge.attrs?.overrideRange
      const target = graph.getNode(edge.dst)
      if (range === undefined || to === undefined || target === undefined) continue
      governed.push({
        package: edge.attrs?.alias ?? target.name,
        parentPath: [source.name],
        versionCondition: range,
        to,
        origin: 'yarn',
      })
    }
  }
  return mergeOverrides(
    mergeOverrides(getManifestOverrides(graph) ?? [], declared),
    governed,
  )
}

function pinnedOverrides(graph: Graph): OverrideConstraint[] {
  const output: OverrideConstraint[] = []
  for (const diagnostic of graph.diagnostics()) {
    if (diagnostic.code !== 'MODIFY_OVERRIDE_PINNED') continue
    const packageName = diagnostic.data?.package
    const to = diagnostic.data?.to
    if (typeof packageName === 'string' && typeof to === 'string') {
      output.push({ package: packageName, to })
    }
  }
  return output
}

export function stringify(graph: Graph, format?: FormatId, options?: StringifyOptions): string
export function stringify(graph: Graph, options: StringifyOptionsWithFormat): string
export function stringify(format: FormatId, graph: Graph, options?: StringifyOptions): string
export function stringify(
  a: FormatId | Graph,
  b?: FormatId | Graph | StringifyOptionsWithFormat,
  c?: StringifyOptions,
): string {
  if (isFormatId(a)) return stringifyResolved(a, b as Graph, c ?? {})
  const graph = a as Graph
  if (typeof b === 'string') return stringifyResolved(b as FormatId, graph, c ?? {})
  const { format, ...rest } = (b ?? {}) as StringifyOptionsWithFormat
  return stringifyResolved(format, graph, rest)
}

function stringifyResolved(
  requested: FormatId | undefined,
  graph: Graph,
  options: StringifyOptions = {},
): string {
  const format = requireFormat(requested, 'stringify')
  if (options.sources?.policy !== undefined && options.overrides !== undefined) {
    throw new LockfileError({
      code: 'INVALID_INPUT',
      message: 'stringify: sources.policy cannot be combined with legacy overrides',
    })
  }
  const projected = stringifyProjected(format, graph, {
    ...options,
    overrides: options.sources?.policy === undefined
      ? options.overrides
      : [...options.sources.policy.overrides],
  })
  const blocking = blockingProjectionLosses(projected.losses)
  if ((options.strict ?? true) && blocking.length > 0) {
    throw new LockfileError(projectionError(blocking))
  }
  return projected.output
}

// === CANONICAL GRAPH SNAPSHOTS ==============================================

export function assessedDiagnostic(
  code: string,
  message: string,
  data?: Record<string, unknown>,
): Diagnostic {
  return {
    code,
    severity: 'error',
    message,
    ...(data === undefined ? {} : { data }),
  }
}

export function stableValue(
  value: unknown,
  stack: WeakSet<object> = new WeakSet(),
): unknown {
  if (value === null || typeof value !== 'object') return value
  if (stack.has(value)) throw new TypeError('cyclic value in canonical graph projection')
  stack.add(value)
  try {
    if (Array.isArray(value)) return value.map(item => stableValue(item, stack))
    return Object.fromEntries(Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stableValue(item, stack)]))
  } finally {
    stack.delete(value)
  }
}

function sortByStableJson<T>(values: T[]): T[] {
  // The index is deliberately per call: each value is serialized once without
  // letting same-identity graph mutations stale a shared summary.
  return values
    .map(value => ({ key: JSON.stringify(value), value }))
    .sort((left, right) => left.key.localeCompare(right.key))
    .map(entry => entry.value)
}

/**
 * What a conversion TARGET contributes to a comparison beyond the graph itself.
 *
 * Every field here answers the same question — how does this target see a value
 * the graph stores generically? A Berry target renames the workspace root and
 * may or may not prefix its checksums; a Deno target rewrites declaration
 * ranges; a lossy target drops metadata fields the graph still holds. None of
 * it is a property of the graph, and none of it is meaningful without a target.
 *
 * These arrived one at a time as positional parameters and reached eleven. They
 * are one concept, so they travel as one value.
 */
export interface TargetProjection {
  readonly overrides?: readonly OverrideConstraint[]
  readonly workspaceNames?: ReadonlyMap<string, string>
  readonly resolutions?: ReadonlyMap<string, ResolutionCanonical>
  readonly integrities?: ReadonlyMap<string, Integrity | undefined>
  readonly metadataDrops?: ReadonlyMap<string, ReadonlySet<PackageMetadataField>>
  readonly peerDependencies?: ReadonlyMap<string, Readonly<Record<string, string>>>
  readonly edgeRanges?: ReadonlyMap<string, string>
  /** Berry renames the workspace root to `<name>@0.0.0-use.local`. */
  readonly nativeBerryWorkspaceRoot?: boolean
  /** Berry-zip and canonical targets carry a `<cacheKey>/` checksum prefix. */
  readonly berryChecksumCacheKey?: boolean
}

/**
 * Berry renames a workspace root to `<name>@0.0.0-use.local`. Nodes, edges and
 * the root list all have to agree about that rename, so it is computed once and
 * consulted rather than recomputed per section.
 */
type RootIdProjection = ReadonlyMap<string, string>

function berryRootIds(graph: Graph, enabled: boolean): RootIdProjection {
  const ids = new Map<string, string>()
  if (!enabled) return ids
  for (const node of graph.nodes()) {
    if (node.workspacePath === '') ids.set(node.id, `${node.name}@0.0.0-use.local`)
  }
  return ids
}

const rootIdOf = (ids: RootIdProjection, id: string): string => ids.get(id) ?? id

function snapshotNodes(graph: Graph, rootIds: RootIdProjection): readonly unknown[] {
  return sortByStableJson([...graph.nodes()].map(node => stableValue({
    id: rootIdOf(rootIds, node.id),
    name: node.name,
    version: rootIds.has(node.id) ? '0.0.0-use.local' : node.version,
    peerContext: node.peerContext,
    ...(node.patch === undefined ? {} : { patch: node.patch }),
    ...(node.source === undefined ? {} : { source: node.source }),
    ...(node.workspacePath === undefined ? {} : { workspacePath: node.workspacePath }),
  })))
}

function snapshotEdges(
  graph: Graph,
  rootIds: RootIdProjection,
  projection: TargetProjection,
  contract: ConversionContract,
): readonly unknown[] {
  return sortByStableJson([...graph.nodes()].flatMap(node => [...graph.out(node.id)])
    .map(edge => {
      const source = graph.getNode(edge.src)
      const target = graph.getNode(edge.dst)
      const declaredRange = edge.attrs?.range
      const targetProjectedRange = projection.edgeRanges?.get(projectionEdgeKey(
        edge.src,
        edge.kind,
        edge.dst,
        edge.attrs?.alias,
      ))
      const descriptor = edge.attrs?.alias ?? target?.name
      const projectedRange = source?.workspacePath !== undefined
        && descriptor !== undefined
        && declaredRange !== undefined
        && projection.overrides !== undefined
        ? governingOverrideFor(
            descriptor,
            [projection.workspaceNames?.get(source.id) ?? source.name],
            projection.overrides,
            declaredRange,
          )?.to
        : undefined
      return stableValue({
        src: rootIdOf(rootIds, edge.src),
        dst: rootIdOf(rootIds, edge.dst),
        kind: edge.kind,
        ...(edge.attrs === undefined ? {} : {
          attrs: {
            ...(declaredRange === undefined
              ? {}
              : { range: projectedRange ?? targetProjectedRange ?? declaredRange }),
            ...(contract === 'snapshot' || edge.attrs.overrideRange === undefined
              ? {}
              : { overrideRange: edge.attrs.overrideRange }),
            ...(edge.attrs.optional === undefined ? {} : { optional: edge.attrs.optional }),
            ...(edge.attrs.workspace === undefined ? {} : { workspace: edge.attrs.workspace }),
            ...(edge.attrs.alias === undefined ? {} : { alias: edge.attrs.alias }),
            ...(edge.attrs.workspaceRange === undefined ? {} : {
              workspaceRange: edge.attrs.workspaceRange,
            }),
          },
        }),
      })
    }))
}

function snapshotTarballs(graph: Graph, projection: TargetProjection): readonly unknown[] {
  return [...graph.tarballs()].flatMap(([key, payload]) => {
    const resolution = projection.resolutions?.get(key) ?? payload.resolution
    const integrity = projection.integrities?.has(key)
      ? projection.integrities.get(key)
      : payload.integrity
    const metadataDrops = projection.metadataDrops?.get(key)
    const projected = {
      ...(integrity === undefined ? {} : { integrity }),
      ...(payload.berryChecksumCacheKey === undefined || (projection.berryChecksumCacheKey ?? true) === false ? {} : {
        berryChecksumCacheKey: payload.berryChecksumCacheKey,
      }),
      ...(payload.engines === undefined || metadataDrops?.has('engines') ? {} : { engines: payload.engines }),
      ...(payload.funding === undefined || metadataDrops?.has('funding') ? {} : { funding: payload.funding }),
      ...(payload.license === undefined || metadataDrops?.has('license') ? {} : { license: payload.license }),
      ...(payload.bin === undefined || metadataDrops?.has('bin') ? {} : { bin: payload.bin }),
      ...(payload.deprecated === undefined || metadataDrops?.has('deprecated') ? {} : { deprecated: payload.deprecated }),
      ...(payload.cpu === undefined || metadataDrops?.has('cpu') ? {} : { cpu: payload.cpu }),
      ...(payload.os === undefined || metadataDrops?.has('os') ? {} : { os: payload.os }),
      ...(payload.libc === undefined || metadataDrops?.has('libc') ? {} : { libc: payload.libc }),
      ...(payload.hasInstallScript === undefined || metadataDrops?.has('hasInstallScript') ? {} : {
        hasInstallScript: payload.hasInstallScript,
      }),
      ...(payload.bundledDependencies === undefined || metadataDrops?.has('bundledDependencies') ? {} : {
        bundledDependencies: payload.bundledDependencies,
      }),
      ...(resolution === undefined ? {} : { resolution }),
      ...(payload.peerDependencies === undefined || metadataDrops?.has('peerDependencies') ? {} : {
        peerDependencies: projection.peerDependencies?.get(key) ?? payload.peerDependencies,
      }),
      ...(payload.peerDependenciesMeta === undefined || metadataDrops?.has('peerDependenciesMeta') ? {} : {
        peerDependenciesMeta: payload.peerDependenciesMeta,
      }),
    }
    // A payload whose only content was a target-dropped structural-expected metadata
    // field (a completed node carrying only `engines`) projects to `{}`; the target
    // reparse emits no tarball entry for such a node, so omit it for a symmetric
    // snapshot — an empty payload carries no canonical fact (CASE-A).
    return Object.keys(projected).length === 0 ? [] : [[key, stableValue(projected)] as const]
  })
    .sort(([left], [right]) => left.localeCompare(right))
}

/**
 * A canonical snapshot is four independently projected sections over one graph.
 * The sections were inline and the projection arrived as eleven positional
 * parameters; both are now named, so a reader can check one section against one
 * format contract without holding the other three.
 */
export function canonicalGraphSnapshot(
  graph: Graph,
  contract: ConversionContract,
  projection: TargetProjection = {},
): string {
  const rootIds = berryRootIds(graph, projection.nativeBerryWorkspaceRoot ?? false)
  return JSON.stringify({
    nodes: snapshotNodes(graph, rootIds),
    edges: snapshotEdges(graph, rootIds, projection, contract),
    roots: [...graph.roots()].map(id => rootIdOf(rootIds, id)).sort(),
    tarballs: snapshotTarballs(graph, projection),
  })
}

// === PROJECTION SNAPSHOTS ===================================================

/** Integrity after serialization through the target's actual carrier. The
 * canonical graph retains every origin; this projection exists only for the
 * output/reparse comparator. */
function projectedTargetIntegrities(
  graph: Graph,
  target: FormatId,
): ReadonlyMap<string, Integrity | undefined> | undefined {
  if (target === 'yarn-classic') return yarnClassic.projectedCanonicalIntegrities(graph)
  const family = targetProfileOf({ format: target }).capabilities.integrity
  if (family !== 'berry-zip' && family !== 'tarball-sri') return undefined

  const projected = new Map<string, Integrity | undefined>()
  for (const [key, payload] of graph.tarballs()) {
    if (payload.integrity === undefined) continue
    if (family === 'berry-zip') {
      const checksum = emitBerryChecksum(payload.integrity)
      projected.set(key, checksum === undefined
        ? undefined
        : parseBerryChecksum(checksum).integrity)
      continue
    }
    const sri = emitSri(payload.integrity)
    projected.set(key, sri === undefined ? undefined : parseSri(sri))
  }
  return projected.size === 0 ? undefined : projected
}

/** Resolution after serialization through the target's actual carrier. Berry
 * registry locators do not carry the source tarball URL (including a classic
 * `#shasum` fragment), so compare against the URL Berry reconstructs on parse
 * while leaving the canonical Graph untouched. */
function projectedTargetResolutions(
  graph: Graph,
  target: FormatId,
): ReadonlyMap<string, ResolutionCanonical> | undefined {
  if (target === 'yarn-classic') return yarnClassic.projectedCanonicalResolutions(graph)
  if (!target.startsWith('yarn-berry-')) return undefined

  const projected = new Map<string, ResolutionCanonical>()
  for (const node of graph.nodes()) {
    if (node.workspacePath !== undefined) continue
    const resolution = graph.tarballOf(node.id)?.resolution
    if (resolution === undefined) continue
    const locator = stringifyForYarnBerry(resolution, {
      name: node.name,
      version: node.version,
    })
    projected.set(toTarballKey(node), parseResolution(locator, {
      sourceKind: 'yarn-berry-locator',
      name: node.name,
    }))
  }
  return projected.size === 0 ? undefined : projected
}


/**
 * Print WHICH graph facts a strict emit failed to preserve, to stderr, when
 * `LOCKGRAPH_DEBUG_SNAPSHOT=1` is set.
 *
 * `COMPLETENESS_OUTPUT_GRAPH_MISMATCH` says only "target output does not preserve the
 * canonical graph" — no node, no field, no side. It is the one diagnostic in this library
 * a consumer cannot act on, and the cost is measurable: a downstream project spent a day
 * mis-attributing a stale registry fixture to a converter bug, because the only way to see
 * the delta was to patch a debug build. Reading a raw payload off `graph.tarballs()` is
 * NOT a substitute — the comparator projects both sides first (registry rehosting, integrity
 * slotting, workspace-root renaming), so raw payloads show differences the check never sees
 * and hide the one it does.
 *
 * Off by default and free when off: nothing is parsed unless the snapshots already differ
 * AND the flag is set. Diagnostic only — it never changes what is emitted or diagnosed.
 */
export function debugSnapshotDelta(source: string, target: string): void {
  if (process.env.LOCKGRAPH_DEBUG_SNAPSHOT !== '1') return
  let left: Record<string, unknown[]>
  let right: Record<string, unknown[]>
  try {
    left = JSON.parse(source) as Record<string, unknown[]>
    right = JSON.parse(target) as Record<string, unknown[]>
  } catch { return }
  for (const section of ['nodes', 'edges', 'roots', 'tarballs']) {
    const canon = (left[section] ?? []).map(value => JSON.stringify(value))
    const round = (right[section] ?? []).map(value => JSON.stringify(value))
    const canonOnly = canon.filter(value => !round.includes(value))
    const roundOnly = round.filter(value => !canon.includes(value))
    if (canonOnly.length === 0 && roundOnly.length === 0) continue
    process.stderr.write(
      `lockgraph: ${section} differ — ${canonOnly.length} only in the canonical graph, `
      + `${roundOnly.length} only in the reparsed output\n`,
    )
    for (const value of canonOnly.slice(0, 5)) process.stderr.write(`  canonical ${value}\n`)
    for (const value of roundOnly.slice(0, 5)) process.stderr.write(`  reparsed  ${value}\n`)
  }
}

/** Snapshot the graph as the target adapter will project it. Target-neutral
 * authorities stay on Graph while the comparator sees only representable
 * resolution, integrity, metadata, and workspace-root spellings. */
export function canonicalProjectionGraphSnapshot(
  graph: Graph,
  target: FormatId,
  contract: ConversionContract,
  overrides?: readonly OverrideConstraint[],
  workspaceNames?: ReadonlyMap<string, string>,
): string {
  // `registryFor` intentionally isn't threaded through this strict comparator:
  // generic StringifyOptions cannot carry it, while the direct classic
  // stringify API that can has no projection comparator. This is therefore
  // safely over-strict today; exposing `registryFor` generically must also plumb
  // it through this projection boundary.
  const projectedResolutions = projectedTargetResolutions(graph, target)
  const targetProfile = targetProfileOf({ format: target })
  const projectedIntegrities = projectedTargetIntegrities(graph, target)
  const denoDeclarationRanges = denoDeclarationRangeProjections(graph, target)
  const projectedPeerDependencies = projectedDenoPeerDependencies(graph, denoDeclarationRanges)
  const projectedEdgeRanges = projectedDenoEdgeRanges(denoDeclarationRanges)
  const projectedMetadataDrops = projectedConditionsMetadataDrops(
    graph,
    target,
    projectedStructuralMetadataDrops(graph, target),
  )
  return canonicalGraphSnapshot(graph, contract, {
    overrides,
    workspaceNames,
    resolutions: projectedResolutions,
    integrities: projectedIntegrities,
    metadataDrops: projectedMetadataDrops,
    peerDependencies: projectedPeerDependencies,
    edgeRanges: projectedEdgeRanges,
    nativeBerryWorkspaceRoot: target.startsWith('yarn-berry-'),
    berryChecksumCacheKey: targetProfile.capabilities.integrity === 'berry-zip'
      || targetProfile.capabilities.integrity === 'canonical',
  })
}

function projectedDenoPeerDependencies(
  graph: Graph,
  projections: ReturnType<typeof denoDeclarationRangeProjections>,
): ReadonlyMap<string, Readonly<Record<string, string>>> | undefined {
  const output = new Map<string, Readonly<Record<string, string>>>()
  const payloads = new Map(graph.tarballs())
  for (const projection of projections) {
    if (projection.carrier !== 'peerDependencies') continue
    const current = output.get(projection.key)
      ?? payloads.get(projection.key)?.peerDependencies
    if (current === undefined) continue
    output.set(projection.key, Object.freeze({
      ...current,
      [projection.name]: projection.to,
    }))
  }
  return output.size === 0 ? undefined : output
}

function projectionEdgeKey(
  source: string,
  kind: EdgeKind,
  destination: string,
  alias?: string,
): string {
  return `${source}\0${kind}\0${destination}\0${alias ?? ''}`
}

function projectedDenoEdgeRanges(
  projections: ReturnType<typeof denoDeclarationRangeProjections>,
): ReadonlyMap<string, string> | undefined {
  const output = new Map<string, string>()
  for (const projection of projections) {
    if (projection.kind === 'peer') continue
    output.set(projectionEdgeKey(
      projection.subject,
      projection.kind,
      projection.destination,
      projection.alias,
    ), projection.to)
  }
  return output.size === 0 ? undefined : output
}

const CONDITION_METADATA_FIELDS = ['os', 'cpu', 'libc'] as const

/** Berry serializes platform metadata through `conditions:` and reparses it as
 * a scalar sidecar fact. Avoid comparing the same fact again as structured
 * tarball metadata, but only for fields the current composer actually carries. */
function projectedConditionsMetadataDrops(
  graph: Graph,
  target: FormatId,
  structural: ReadonlyMap<string, ReadonlySet<PackageMetadataField>> | undefined,
): ReadonlyMap<string, ReadonlySet<PackageMetadataField>> | undefined {
  if (!target.startsWith('yarn-berry-')
    || !targetProfileOf({ format: target }).capabilities.conditions) return structural

  const projected = new Map<string, ReadonlySet<PackageMetadataField>>(structural)
  for (const [key, payload] of graph.tarballs()) {
    const represented = CONDITION_METADATA_FIELDS.filter(field => {
      const values = payload[field]
      if (values === undefined) return false
      return composeConditionsFromPayload({ [field]: values } as TarballPayload) !== undefined
    })
    if (represented.length === 0) continue
    projected.set(key, Object.freeze(new Set([
      ...(projected.get(key) ?? []),
      ...represented,
    ])))
  }
  return projected.size === 0 ? undefined : projected
}

function projectionOutputDiagnostics(
  graph: Graph,
  output: string,
  target: FormatId,
  overrides?: readonly OverrideConstraint[],
  workspaceNames?: ReadonlyMap<string, string>,
  targetVersion?: string,
): readonly Diagnostic[] {
  const diagnostics: Diagnostic[] = []
  if (!checkFormat(target, output)) {
    return Object.freeze([assessedDiagnostic(
      'COMPLETENESS_OUTPUT_FORMAT_REJECTED',
      'target adapter rejected emitted output',
      { target },
    )])
  }

  let reparsed: Graph
  try {
    const reparseOverrides = reparseOverrideContext(graph, overrides)
    reparsed = parse(target, output, {
      ...(reparseOverrides.length === 0 ? {} : { overrides: reparseOverrides }),
    })
  } catch (error) {
    return Object.freeze([assessedDiagnostic(
      'COMPLETENESS_OUTPUT_PARSE_FAILED',
      error instanceof Error ? error.message : 'target output parse failed',
      { target },
    )])
  }

  const comparisonOverrides = target.startsWith('pnpm-') ? overrides : undefined
  const overlayGaps = yarnBerryPluginCompatGapDiagnostics(graph, {
    format: target,
    ...(targetVersion === undefined ? {} : { managerVersion: targetVersion }),
  })
  diagnostics.push(...overlayGaps)
  const sourceSnapshot = canonicalProjectionGraphSnapshot(
    graph, target, 'project', comparisonOverrides, workspaceNames)
  const targetSnapshot = canonicalProjectionGraphSnapshot(
    reparsed, target, 'project', comparisonOverrides, workspaceNames)
  if (sourceSnapshot !== targetSnapshot) {
    debugSnapshotDelta(sourceSnapshot, targetSnapshot)
    if (overlayGaps.length === 0) diagnostics.push(assessedDiagnostic(
      'COMPLETENESS_OUTPUT_GRAPH_MISMATCH',
      'target output does not preserve the canonical graph',
      { target },
    ))
  }
  const sourceFeatures = detectGraphFeatures(graph)
  const targetFeatures = detectGraphFeatures(reparsed)
  const targetUnresolved = new Set(
    unresolvedDependencyDeclarationsOf(reparsed)
      .map(declaration => unresolvedDependencyProjectionKey(reparsed, declaration)),
  )
  for (const declaration of unresolvedDependencyDeclarationsOf(graph)) {
    if (targetUnresolved.has(unresolvedDependencyProjectionKey(graph, declaration))) continue
    diagnostics.push(assessedDiagnostic(
      'COMPLETENESS_OUTPUT_UNRESOLVED_DECLARATION_DROPPED',
      `target output drops unresolved ${declaration.kind} declaration ${declaration.name}@${declaration.descriptor} from ${declaration.src}`,
      {
        feature: UNRESOLVED_DEPENDENCY_FEATURE,
        target,
        unresolvedDependency: declaration,
      },
    ))
  }
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
  return Object.freeze(diagnostics)
}
