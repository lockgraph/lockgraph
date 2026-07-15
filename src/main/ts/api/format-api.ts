import type {
  Diagnostic,
  Graph,
  Manifest,
  OverrideConstraint,
} from '../graph.ts'
import { LockfileError } from './errors.ts'
import type {
  FormatId,
  ParseOptions,
  StringifyOptions,
} from './format-contract.ts'
import {
  checkFormat,
  detectFormat,
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
import { getPnpmOverridesCanonical } from '../formats/_pnpm-flat-core.ts'
import * as bunText from '../formats/bun-text.ts'
import * as pnpmV5 from '../formats/pnpm-v5.ts'
import * as yarnClassic from '../formats/yarn-classic.ts'
import {
  attachParsedEvidence,
} from '../completeness/evidence.ts'
import { detectGraphFeatures } from '../completeness/features.ts'
import type { ConversionContract } from '../completeness/types.ts'
import {
  dedupeProjectionLosses,
  genericProjectionLoss,
  projectionDiagnosticLosses,
  projectionError,
  projectionPreflightLosses,
  projectionWarning,
  type ProjectionResult,
} from '../completeness/projection.ts'
import { captureOverrides, noteYarnOverridesNotProjected, type OverridePM } from '../recipe/overrides.ts'
import { governingOverrideFor } from '../recipe/descriptor-resolve.ts'
import {
  getManifestOverrides,
  mergeOverrides,
  rememberManifestOverrides,
} from '../recipe/override-carrier.ts'

export type StringifyDispatchOptions = StringifyDispatchContext

function observedPolicyCarrier(
  format: FormatId,
  graph: Graph,
): readonly OverrideConstraint[] | null | undefined {
  const carrier = format === 'pnpm-v5'
    ? pnpmV5.getPnpmV5OverridesCanonical(graph)
    : format === 'pnpm-v6' || format === 'pnpm-v9'
      ? getPnpmOverridesCanonical(graph)
      : format === 'bun-text'
        ? bunText.getBunOverridesCanonical(graph)
        : undefined
  return format.startsWith('pnpm-') || format === 'bun-text'
    ? carrier ?? null
    : undefined
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
  if (lineage?.mutated === true
    && lineage.adapterStateRequired
    && !hasFormatAdapterState(lineage.sourceFormat, graph)) {
    emittedDiagnostics.push(assessedDiagnostic(
      'COMPLETENESS_ADAPTER_STATE_LOST',
      `public mutation detached load-bearing ${lineage.sourceFormat} adapter state; strict output cannot prove frozen fidelity`,
      {
        feature: 'adapter-state',
        sourceFormat: lineage.sourceFormat,
        target: format,
      },
    ))
  }
  if (options.overrides !== undefined
    && options.overrides.length > 0
    && format.startsWith('yarn')) {
    noteYarnOverridesNotProjected(options.overrides.length, diagnostic => {
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
  )
  if (losses.length === 0 && probeDiagnostics.length > 0) {
    const classified = projectionDiagnosticLosses(probeDiagnostics, format)
    losses = dedupeProjectionLosses(classified.length > 0
      ? classified
      : [genericProjectionLoss(format, probeDiagnostics[0]!)])
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

export function check(format: FormatId, input: string): boolean {
  return checkFormat(format, input)
}

export function detect(input: string): FormatId | undefined {
  return detectFormat(input)
}

export function parse(format: FormatId, input: string, options: ParseOptions = {}): Graph {
  // Capture manifest override authority before parse because yarn edge binding
  // needs the canonical override map while resolving descriptors.
  const overrides = options.manifests !== undefined
    ? captureManifestOverrides(format, options.manifests, options.onDiagnostic)
    : undefined
  let graph = parseFormat(format, input, {
    workspaceRoot: options.workspaceRoot,
    overrides,
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
  )
  attachParsedMutationLineage(graph, format, hasFormatAdapterState(format, graph))
  return graph
}

/** Map a FormatId to its override grammar family (ADR-0025 §6 capture). */
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

export function stringify(
  format: FormatId,
  graph: Graph,
  options: StringifyOptions = {},
): string {
  const projected = stringifyProjected(format, graph, options)
  if ((options.strict ?? true) && projected.losses.length > 0) {
    throw new LockfileError(projectionError(projected.losses))
  }
  return projected.output
}

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

export function canonicalGraphSnapshot(
  graph: Graph,
  contract: ConversionContract,
  overrides?: readonly OverrideConstraint[],
  workspaceNames?: ReadonlyMap<string, string>,
): string {
  const nodes = sortByStableJson([...graph.nodes()].map(node => stableValue({
    id: node.id,
    name: node.name,
    version: node.version,
    peerContext: node.peerContext,
    ...(node.patch === undefined ? {} : { patch: node.patch }),
    ...(node.source === undefined ? {} : { source: node.source }),
    ...(node.workspacePath === undefined ? {} : { workspacePath: node.workspacePath }),
  })))
  const edges = sortByStableJson([...graph.nodes()].flatMap(node => [...graph.out(node.id)])
    .map(edge => {
      const source = graph.getNode(edge.src)
      const target = graph.getNode(edge.dst)
      const declaredRange = edge.attrs?.range
      const descriptor = edge.attrs?.alias ?? target?.name
      const projectedRange = source?.workspacePath !== undefined
        && descriptor !== undefined
        && declaredRange !== undefined
        && overrides !== undefined
        ? governingOverrideFor(
            descriptor,
            [workspaceNames?.get(source.id) ?? source.name],
            overrides,
            declaredRange,
          )?.to
        : undefined
      return stableValue({
        src: edge.src,
        dst: edge.dst,
        kind: edge.kind,
        ...(edge.attrs === undefined ? {} : {
          attrs: {
            ...(declaredRange === undefined ? {} : { range: projectedRange ?? declaredRange }),
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
  const tarballs = [...graph.tarballs()].map(([key, payload]) => [key, stableValue({
    ...(payload.integrity === undefined ? {} : { integrity: payload.integrity }),
    ...(payload.berryChecksumCacheKey === undefined ? {} : {
      berryChecksumCacheKey: payload.berryChecksumCacheKey,
    }),
    ...(payload.engines === undefined ? {} : { engines: payload.engines }),
    ...(payload.funding === undefined ? {} : { funding: payload.funding }),
    ...(payload.license === undefined ? {} : { license: payload.license }),
    ...(payload.bin === undefined ? {} : { bin: payload.bin }),
    ...(payload.deprecated === undefined ? {} : { deprecated: payload.deprecated }),
    ...(payload.cpu === undefined ? {} : { cpu: payload.cpu }),
    ...(payload.os === undefined ? {} : { os: payload.os }),
    ...(payload.libc === undefined ? {} : { libc: payload.libc }),
    ...(payload.hasInstallScript === undefined ? {} : {
      hasInstallScript: payload.hasInstallScript,
    }),
    ...(payload.bundledDependencies === undefined ? {} : {
      bundledDependencies: payload.bundledDependencies,
    }),
    ...(payload.resolution === undefined ? {} : { resolution: payload.resolution }),
    ...(payload.peerDependencies === undefined ? {} : {
      peerDependencies: payload.peerDependencies,
    }),
    ...(payload.peerDependenciesMeta === undefined ? {} : {
      peerDependenciesMeta: payload.peerDependenciesMeta,
    }),
  })] as const)
    .sort(([left], [right]) => left.localeCompare(right))
  return JSON.stringify({
    nodes,
    edges,
    roots: [...graph.roots()].sort(),
    tarballs,
  })
}

function projectionOutputDiagnostics(
  graph: Graph,
  output: string,
  target: FormatId,
  overrides?: readonly OverrideConstraint[],
  workspaceNames?: ReadonlyMap<string, string>,
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
    reparsed = parse(target, output)
  } catch (error) {
    return Object.freeze([assessedDiagnostic(
      'COMPLETENESS_OUTPUT_PARSE_FAILED',
      error instanceof Error ? error.message : 'target output parse failed',
      { target },
    )])
  }

  const comparisonOverrides = target.startsWith('pnpm-') ? overrides : undefined
  if (canonicalGraphSnapshot(graph, 'project', comparisonOverrides, workspaceNames)
    !== canonicalGraphSnapshot(reparsed, 'project', comparisonOverrides, workspaceNames)) {
    diagnostics.push(assessedDiagnostic(
      'COMPLETENESS_OUTPUT_GRAPH_MISMATCH',
      'target output does not preserve the canonical graph',
      { target },
    ))
  }
  const sourceFeatures = detectGraphFeatures(graph)
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
  return Object.freeze(diagnostics)
}
