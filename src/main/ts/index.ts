// Public surface — ADR-0014 §3.
//
// Exposes both the `convert()` sugar and the underlying primitives
// (`parse / stringify / check / detect`). Recipe-layer normalisation
// (ADR-0014 §4) lands per-feature in subsequent implementer rounds —
// this skeleton dispatches to existing adapter parse / stringify
// hooks without plumbing recipe primitives yet.

import { newBuilder, type Diagnostic, type Graph, type Manifest, type OverrideConstraint } from './graph.ts'
import { captureOverrides, noteYarnOverridesNotProjected, type OverridePM } from './recipe/overrides.ts'
import { getManifestOverrides, mergeOverrides, rememberManifestOverrides } from './recipe/override-carrier.ts'
import { getFlatSidecar } from './formats/_npm-core.ts'
import { getPnpmOverridesCanonical } from './formats/_pnpm-flat-core.ts'
import {
  attachParsedEvidence,
  evidenceOf,
  internalEvidenceOf,
  withEvidence,
  withSourceVersion,
} from './completeness/evidence.ts'
import { assessConversion, type OutputProbeResult } from './completeness/assessment.ts'
import { detectGraphFeatures } from './completeness/features.ts'
import { authoritativePolicyOverridesOf } from './completeness/profile.ts'
import type {
  AssessedOutput,
  ConvertAssessedOptions,
  StringifyAssessedOptions,
} from './completeness/types.ts'

import * as bunText      from './formats/bun-text.ts'
import * as npm1         from './formats/npm-1.ts'
import * as npm2         from './formats/npm-2.ts'
import * as npm3         from './formats/npm-3.ts'
import * as pnpmV5       from './formats/pnpm-v5.ts'
import * as pnpmV6       from './formats/pnpm-v6.ts'
import * as pnpmV9       from './formats/pnpm-v9.ts'
import * as yarnBerryV4  from './formats/yarn-berry-v4.ts'
import * as yarnBerryV5  from './formats/yarn-berry-v5.ts'
import * as yarnBerryV6  from './formats/yarn-berry-v6.ts'
import * as yarnBerryV7  from './formats/yarn-berry-v7.ts'
import * as yarnBerryV8  from './formats/yarn-berry-v8.ts'
import * as yarnBerryV9  from './formats/yarn-berry-v9.ts'
import * as yarnBerryV10 from './formats/yarn-berry-v10.ts'
import * as yarnClassic  from './formats/yarn-classic.ts'
import * as lockgraph    from './formats/lockgraph.ts'

export const version = '0.0.0'

export { LockfileError, type LockfileErrorCode } from './errors.ts'
export type { Diagnostic, Graph } from './graph.ts'

export { sourceCapabilitiesOf } from './completeness/capabilities.ts'
export { evidenceOf, withEvidence }
export { completenessOf } from './completeness/profile.ts'
export type {
  ArtifactKnowledge,
  AssessedOutput,
  AssessmentOptions,
  CompletenessContext,
  CompletenessDimension,
  CompletenessProfile,
  CompletenessResult,
  ConversionAssessment,
  ConversionContract,
  ConvertAssessedOptions,
  EvidenceContext,
  EvidenceInput,
  EvidenceKind,
  EvidenceLedger,
  EvidenceRef,
  Knowledge,
  LayoutKnowledge,
  ManifestCoverage,
  PackageManifestEvidence,
  PeerKnowledge,
  PinnedTargetRequest,
  PmConfigEvidence,
  PolicyKnowledge,
  RepositoryManifestEvidence,
  RequirementAssessment,
  RequirementStatus,
  ResolvedTargetCapabilities,
  SourceCapabilityResult,
  StructuralCoverage,
  TargetManager,
  TargetOracleEvidence,
  TargetProfile,
  TargetRequest,
  StringifyAssessedOptions,
  Verification,
} from './completeness/types.ts'

// Registry adapter contract (Phase C) — re-exported for caller-side
// frozen-registry construction and live-adapter authoring. Phase D-A
// adds `liveRegistry` (HTTPS-backed) alongside the offline frozen
// reference impl; Phase D-B adds the filesystem CacheAdapter family —
// `yarnBerryCache` over yarn-berry `.yarn/cache/`, `npmCache` over the
// cacache CAS under `~/.npm/_cacache/`, and `pnpmCache` over the
// pnpm content-addressable store under `~/.pnpm-store/v3/`. All
// honour the same registry/cache adapter shapes.
export { frozenRegistry } from './registry/frozen.ts'
export { liveRegistry, type LiveRegistryOptions } from './registry/live.ts'
export { yarnBerryCache, withYarnCacheChecksums, type YarnBerryCacheOptions } from './registry/cache-yarn-berry.ts'
export { npmCache, type NpmCacheOptions } from './registry/cache-npm.ts'
export { pnpmCache, type PnpmCacheOptions } from './registry/cache-pnpm.ts'
export type {
  CacheAdapter,
  Packument,
  PackumentVersion,
  RegistryAdapter,
} from './registry/types.ts'

// ADR-0023 §8.2 — `modify()` orchestrator + its `Primitive` discriminated
// union and unified `ModifyResult` shape. The orchestrator is the single
// dispatch entry point for the modifier vocabulary; per-primitive functions
// remain individually importable via `lockgraph/modify`.
export { modify } from './modify/modify.ts'
export type {
  ModifyResult,
  ModifyResultBase,
  Primitive,
} from './modify/modify.ts'
export type {
  ModifyContext,
  ModifyOptions,
} from './modify/context.ts'

// ADR-0024 — `optimize()` post-completion, pre-stringify orphan GC.
// Monotone-reductive: removes unreachable nodes from the
// roots/workspaces/preserve mark-set, never adds. Per-primitive importable
// via `lockgraph/optimize`.
export { optimize } from './optimize/optimize.ts'
export type { OptimizeOptions, OptimizeResult } from './optimize/optimize.ts'

export type FormatId =
  | 'yarn-berry-v4'
  | 'yarn-berry-v5'
  | 'yarn-berry-v6'
  | 'yarn-berry-v7'
  | 'yarn-berry-v8'
  | 'yarn-berry-v9'
  | 'yarn-berry-v10'
  | 'yarn-classic'
  | 'npm-1'
  | 'npm-2'
  | 'npm-3'
  | 'pnpm-v5'
  | 'pnpm-v6'
  | 'pnpm-v9'
  | 'bun-text'
  // Native graph-serialization format (#101). Not a PM lockfile — a portable,
  // versioned, graph-IDENTITY serialization of the L2 model itself. Sits at the
  // top of detect order (its `@lockgraph` magic is unambiguous).
  | 'lockgraph'

// L1 Manifest + canonical override types (ADR-0025). The `manifests` /
// `overrides` options below are the surface ADR-0014 §3 / ADR-0025 specify;
// they are now backed by real types in graph.ts. Capture + per-PM projection
// land in the ADR-0025 impl rounds; the option shape is stable.
export type { Manifest, OverrideConstraint } from './graph.ts'

export type ParseOptions = {
  /**
   * Filesystem root for adapter parse hooks that read out-of-lockfile
   * sources (yarn-berry / pnpm v6 / pnpm v9 patch byte hashing per
   * ADR-0014 §4.F2). Adapters without out-of-lockfile reads ignore it.
   */
  workspaceRoot?: string
  /**
   * Declared manifests keyed by workspace path (ADR-0025). Supplies override
   * declarations + workspace context the lockfile alone cannot carry.
   */
  manifests?:    Record<string, Manifest>
  onDiagnostic?:  (d: Diagnostic) => void
}

export type StringifyOptions = {
  lineEnding?:   'lf' | 'crlf'
  cacheKey?:     string
  /**
   * Caller-supplied canonical override constraints (ADR-0025). Each adapter
   * projects them to its native form (pnpm `overrides:` / npm
   * `packages[""].overrides`); yarn-berry emits a loss diagnostic.
   */
  overrides?:    OverrideConstraint[]
  onDiagnostic?: (d: Diagnostic) => void
}

export type ConvertOptions = {
  to:             FormatId
  from?:          FormatId
  workspaceRoot?: string
  /**
   * Declared manifests keyed by workspace path (ADR-0025) — same shape as
   * {@link ParseOptions.manifests}. Threaded into the underlying `parse()` so a
   * yarn-family source honours its `resolutions`/`overrides` pins on convert
   * (the override map bridges a pinned, possibly-NON-satisfying descriptor back
   * to its node — Bug #99). `convert` stays a pure parse→stringify: the captured
   * overrides are NOT auto-threaded into the stringify `overrides` slot.
   */
  manifests?:     Record<string, Manifest>
  lineEnding?:    'lf' | 'crlf'
  cacheKey?:      string
  onDiagnostic?:  (d: Diagnostic) => void
}

// Ordered so first-match wins on ambiguous head. Disjoint in practice —
// adapter `check()` probes are version-pinned (yarn-berry `version: N`,
// npm `lockfileVersion: N`, pnpm `lockfileVersion: '<v>'`) — but guard
// against future loosening with newest-first / family-distinctive-first.
const DETECT_ORDER: readonly FormatId[] = [
  'lockgraph',
  'bun-text',
  'yarn-berry-v10',
  'yarn-berry-v9',
  'yarn-berry-v8',
  'yarn-berry-v7',
  'yarn-berry-v6',
  'yarn-berry-v5',
  'yarn-berry-v4',
  'pnpm-v9',
  'pnpm-v6',
  'pnpm-v5',
  'yarn-classic',
  'npm-3',
  'npm-2',
  'npm-1',
]

function checkOne(format: FormatId, input: string): boolean {
  switch (format) {
    case 'bun-text':      return bunText.check(input)
    case 'npm-1':         return npm1.check(input)
    case 'npm-2':         return npm2.check(input)
    case 'npm-3':         return npm3.check(input)
    case 'pnpm-v5':       return pnpmV5.check(input)
    case 'pnpm-v6':       return pnpmV6.check(input)
    case 'pnpm-v9':       return pnpmV9.check(input)
    case 'yarn-berry-v4': return yarnBerryV4.check(input)
    case 'yarn-berry-v5': return yarnBerryV5.check(input)
    case 'yarn-berry-v6': return yarnBerryV6.check(input)
    case 'yarn-berry-v7': return yarnBerryV7.check(input)
    case 'yarn-berry-v8':  return yarnBerryV8.check(input)
    case 'yarn-berry-v9':  return yarnBerryV9.check(input)
    case 'yarn-berry-v10': return yarnBerryV10.check(input)
    case 'yarn-classic':   return yarnClassic.check(input)
    case 'lockgraph':      return lockgraph.check(input)
  }
}

function parseOne(
  format: FormatId,
  input: string,
  options: ParseOptions,
  overrides?: OverrideConstraint[],
): Graph {
  const workspaceRoot = options.workspaceRoot
  // Bug #99 — the yarn family (classic + berry) is the only one whose edge
  // resolution joins consumer RANGES to entries by exact key; under a
  // `resolutions` pin that key is rewritten, so the override map is threaded in
  // to bridge the miss. pnpm/npm/bun pre-resolve in the lock body (entries carry
  // resolved versions, not ranges) — they ignore `overrides` at parse.
  switch (format) {
    case 'bun-text':      return bunText.parse(input)
    case 'npm-1':         return npm1.parse(input)
    case 'npm-2':         return npm2.parse(input)
    case 'npm-3':         return npm3.parse(input)
    case 'pnpm-v5':       return pnpmV5.parse(input)
    case 'pnpm-v6':       return pnpmV6.parse(input, { workspaceRoot })
    case 'pnpm-v9':       return pnpmV9.parse(input, { workspaceRoot })
    case 'yarn-berry-v4': return yarnBerryV4.parse(input, { workspaceRoot, overrides })
    case 'yarn-berry-v5': return yarnBerryV5.parse(input, { workspaceRoot, overrides })
    case 'yarn-berry-v6': return yarnBerryV6.parse(input, { workspaceRoot, overrides })
    case 'yarn-berry-v7': return yarnBerryV7.parse(input, { workspaceRoot, overrides })
    case 'yarn-berry-v8':  return yarnBerryV8.parse(input, { workspaceRoot, overrides })
    case 'yarn-berry-v9':  return yarnBerryV9.parse(input, { workspaceRoot, overrides })
    case 'yarn-berry-v10': return yarnBerryV10.parse(input, { workspaceRoot, overrides })
    case 'yarn-classic':   return yarnClassic.parse(input, { overrides })
    case 'lockgraph':      return lockgraph.parse(input)
  }
}

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

function stringifyOne(format: FormatId, graph: Graph, options: StringifyOptions): string {
  const lineEnding   = options.lineEnding
  const onDiagnostic = options.onDiagnostic
  const cacheKey     = options.cacheKey
  const overrides    = options.overrides
  // ADR-0025 §4 — yarn lockfiles (classic + berry) carry no overrides block;
  // forced resolutions live in package.json only. Surface the loss once before
  // dispatch. npm-2/3, pnpm, and bun-text project the constraints into their
  // lock below; npm-1 does not yet thread overrides (tracked follow-up).
  if (overrides !== undefined && overrides.length > 0 && format.startsWith('yarn')) {
    noteYarnOverridesNotProjected(overrides.length, onDiagnostic)
  }
  switch (format) {
    case 'bun-text':      return bunText.stringify(graph,     { lineEnding, onDiagnostic, overrides })
    case 'npm-1':         return npm1.stringify(graph,        { lineEnding, onDiagnostic })
    case 'npm-2':         return npm2.stringify(graph,        { lineEnding, onDiagnostic, overrides })
    case 'npm-3':         return npm3.stringify(graph,        { lineEnding, onDiagnostic, overrides })
    case 'pnpm-v5':       return pnpmV5.stringify(graph,      { lineEnding, onDiagnostic, overrides })
    case 'pnpm-v6':       return pnpmV6.stringify(graph,      { lineEnding, onDiagnostic, overrides })
    case 'pnpm-v9':       return pnpmV9.stringify(graph,      { lineEnding, onDiagnostic, overrides })
    case 'yarn-berry-v4': return yarnBerryV4.stringify(graph, { lineEnding, cacheKey, onDiagnostic })
    case 'yarn-berry-v5': return yarnBerryV5.stringify(graph, { lineEnding, cacheKey, onDiagnostic })
    case 'yarn-berry-v6': return yarnBerryV6.stringify(graph, { lineEnding, cacheKey, onDiagnostic })
    case 'yarn-berry-v7': return yarnBerryV7.stringify(graph, { lineEnding, cacheKey, onDiagnostic })
    case 'yarn-berry-v8':  return yarnBerryV8.stringify(graph,  { lineEnding, cacheKey, onDiagnostic })
    case 'yarn-berry-v9':  return yarnBerryV9.stringify(graph,  { lineEnding, cacheKey, onDiagnostic })
    case 'yarn-berry-v10': return yarnBerryV10.stringify(graph, { lineEnding, cacheKey, onDiagnostic })
    case 'yarn-classic':   return yarnClassic.stringify(graph,  { lineEnding, onDiagnostic })
    case 'lockgraph':      return lockgraph.stringify(graph,    { lineEnding, onDiagnostic })
  }
}

export function check(format: FormatId, input: string): boolean {
  return checkOne(format, input)
}

export function detect(input: string): FormatId | undefined {
  for (const format of DETECT_ORDER) {
    if (checkOne(format, input)) return format
  }
  return undefined
}

export function parse(format: FormatId, input: string, options: ParseOptions = {}): Graph {
  // ADR-0025 §3/§6 (A2) — F6-capture overrides from supplied manifests BEFORE the
  // parse (Bug #99 Option A): the yarn-family edge resolvers need the override map
  // at parse time to bind a `resolutions`-pinned descriptor (whose entry key was
  // rewritten to a possibly-NON-satisfying pin) back to its node. The constraints
  // are also remembered on the returned graph for later `overridesOf(graph)`.
  const overrides = options.manifests !== undefined
    ? captureManifestOverrides(format, options.manifests, options.onDiagnostic)
    : undefined
  let graph = parseOne(format, input, options, overrides)
  // yarn-classic is the ONLY rootless source: a classic yarn.lock encodes no
  // project root, so the declared root can come only from `manifests`. Without
  // this, parse promotes a top-of-DAG dependency to the `""` root and drops that
  // dependency's own installable node — a lock that fails `npm ci`. The
  // manifest-gated `enrich` synthesizes the declared root and its edges; wiring it
  // into the public parse lets `convert(yarnLock, { manifests })` inherit it. Every
  // other format encodes its own root, so this stays scoped to `yarn-classic`.
  //
  // Workspace members. yarn 1 records a CROSS-DEPENDED member as a `file:` local
  // entry (a `directory` resolution) that `enrich` recognises and marks; an
  // INDEPENDENT member (nothing depends on it) has no lock entry and is
  // SYNTHESIZED from its manifest — node + declared dep edges. Either way the npm
  // emit re-emits it as a proper workspace member (`packages/<path>` +
  // `node_modules/<name>` link) with its deps nested beneath it, frozen-clean.
  if (format === 'yarn-classic' && options.manifests !== undefined) {
    const enriched = yarnClassic.enrich(graph, undefined, { manifests: options.manifests, overrides })
    graph = enriched.graph
    if (options.onDiagnostic !== undefined) {
      for (const d of enriched.diagnostics) options.onDiagnostic(d)
    }
  }
  if (overrides !== undefined && overrides.length > 0) {
    rememberManifestOverrides(graph, overrides)
  }
  if (options.onDiagnostic !== undefined) {
    for (const d of graph.diagnostics()) options.onDiagnostic(d)
  }
  attachParsedEvidence(graph, format, options.manifests, observedPolicyCarrier(format, graph))
  return graph
}

/** Map a FormatId to its override grammar family (ADR-0025 §6 capture). */
function pmFamilyOf(format: FormatId): OverridePM {
  if (format.startsWith('yarn')) return 'yarn'
  if (format.startsWith('pnpm')) return 'pnpm'
  return 'npm' // npm-1/2/3 + bun-text (npm-shaped overrides)
}

/**
 * F6-capture overrides from `ParseOptions.manifests` (ADR-0025 §6, A2). Prefers
 * a manifest's already-canonical `overrides`; else captures the PM-native block
 * matching the source format's grammar. Iterates workspace-path keys
 * deterministically; later keys win on tuple collision via `mergeOverrides`.
 * Pure — returns the canonical union; the caller both threads it into the
 * parse-time edge resolvers (Bug #99) and remembers it on the parsed graph.
 */
function captureManifestOverrides(
  format: FormatId,
  manifests: Record<string, Manifest>,
  onDiagnostic?: (d: Diagnostic) => void,
): OverrideConstraint[] {
  const pm = pmFamilyOf(format)
  let captured: OverrideConstraint[] = []
  for (const key of Object.keys(manifests).sort()) {
    const m = manifests[key]!
    if (m.overrides !== undefined && m.overrides.length > 0) {
      captured = mergeOverrides(captured, m.overrides)
      continue
    }
    const block =
      pm === 'npm'  ? m.native?.npmOverrides :
      pm === 'yarn' ? m.native?.yarnResolutions :
                      m.native?.pnpmOverrides
    if (block === undefined) continue
    captured = mergeOverrides(captured, captureOverrides(block, pm, onDiagnostic).canonical)
  }
  return captured
}

/**
 * Canonical union of a graph's captured overrides (ADR-0025 §6, A2): lock-borne
 * (npm `rootMeta.overrides` / pnpm `sidecar.overrides` canonicalised) folded
 * under manifest-F6 (which wins on `(package, parentPath, versionCondition)`
 * collision). Always an array (`[]` = none from any source).
 *
 * READ-BEFORE-MODIFY: reflects parse-time sources read off the parsed-graph
 * handle; NOT guaranteed to survive `graph.mutate()` / modify / optimize.
 * Capture it right after `parse`, then thread into
 * `stringify(to, g, { overrides: overridesOf(g) })`. A `pinOverride`
 * (MODIFY_OVERRIDE_PINNED) DOES survive `mutate` — diagnostic-borne, not a
 * parse-carrier — and folds in as a winner, so a post-pin `overridesOf` reflects
 * it (pnpm/npm frozen-acceptance). The parse-time sources do NOT survive: after a
 * bare `mutate` they return `[]` — BOTH manifest-F6 and the lock-borne sources
 * drop with the rebuilt graph; re-attachment fires only inside an adapter's own
 * enrich/optimize/stringify, never from `mutate()`. Cross-PM is the intended use:
 * for a SAME-PM round-trip prefer plain `parse → stringify` (the verbatim carrier
 * is byte-stable); threading `overridesOf` back routes through canonical and
 * degrades the documented lossy tail-forms (ADR-0025 §2).
 */
export function overridesOf(graph: Graph): OverrideConstraint[] {
  const manifest = getManifestOverrides(graph) ?? []
  const lockBorne =
    getFlatSidecar(graph)?.rootMeta?.overrides ??
    getPnpmOverridesCanonical(graph) ??
    pnpmV5.getPnpmV5OverridesCanonical(graph) ??
    bunText.getBunOverridesCanonical(graph) ??
    []
  return mergeOverrides(mergeOverrides(lockBorne, manifest), pinnedOverrides(graph))
}

// `pinOverride` survives `mutate` as a MODIFY_OVERRIDE_PINNED diagnostic carrying
// `{ package, to }` — fold those as global override winners so a post-modify
// `overridesOf` reflects the pin (pnpm/npm frozen-acceptance: the re-emitted
// `overrides:` block then matches the forced resolution).
function pinnedOverrides(graph: Graph): OverrideConstraint[] {
  const out: OverrideConstraint[] = []
  for (const d of graph.diagnostics()) {
    if (d.code !== 'MODIFY_OVERRIDE_PINNED') continue
    const pkg = d.data?.package
    const to = d.data?.to
    if (typeof pkg === 'string' && typeof to === 'string') out.push({ package: pkg, to })
  }
  return out
}

// `governingOverrideFor(dep, consumerPath, overrides, declaredRange?)` — the
// override governing a dep (or undefined), for a consumer policy layer to ask
// "does an override already govern X, and to what?". PM-faithful tie-break;
// full doc on the definition in recipe/descriptor-resolve.
export { governingOverrideFor } from './recipe/descriptor-resolve.ts'

export function stringify(format: FormatId, graph: Graph, options: StringifyOptions = {}): string {
  return stringifyOne(format, graph, options)
}

export function convert(input: string, options: ConvertOptions): string {
  const from = options.from ?? detect(input)
  if (from === undefined) throw new Error('convert: source format not detected')
  const graph = parse(from, input, {
    workspaceRoot: options.workspaceRoot,
    manifests:     options.manifests,
    onDiagnostic:  options.onDiagnostic,
  })
  return stringify(options.to, graph, {
    lineEnding:   options.lineEnding,
    cacheKey:     options.cacheKey,
    onDiagnostic: options.onDiagnostic,
  })
}

const assessedBlockingDiagnostic = (diagnostic: Diagnostic): boolean =>
  diagnostic.severity !== 'info'

function assessedDiagnostic(
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

function stableValue(value: unknown, stack: WeakSet<object> = new WeakSet()): unknown {
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

function canonicalGraphSnapshot(
  graph: Graph,
  contract: StringifyAssessedOptions['contract'],
): string {
  const nodes = [...graph.nodes()].map(node => stableValue({
    id: node.id,
    name: node.name,
    version: node.version,
    peerContext: node.peerContext,
    ...(node.patch === undefined ? {} : { patch: node.patch }),
    ...(node.source === undefined ? {} : { source: node.source }),
    ...(node.workspacePath === undefined ? {} : { workspacePath: node.workspacePath }),
  }))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
  const edges = [...graph.nodes()].flatMap(node => [...graph.out(node.id)])
    .map(edge => stableValue({
      src: edge.src,
      dst: edge.dst,
      kind: edge.kind,
      ...(edge.attrs === undefined ? {} : { attrs: {
        ...(edge.attrs.range === undefined ? {} : { range: edge.attrs.range }),
        ...(contract === 'snapshot' || edge.attrs.overrideRange === undefined
          ? {}
          : { overrideRange: edge.attrs.overrideRange }),
        ...(edge.attrs.optional === undefined ? {} : { optional: edge.attrs.optional }),
        ...(edge.attrs.workspace === undefined ? {} : { workspace: edge.attrs.workspace }),
        ...(edge.attrs.alias === undefined ? {} : { alias: edge.attrs.alias }),
        ...(edge.attrs.workspaceRange === undefined ? {} : {
          workspaceRange: edge.attrs.workspaceRange,
        }),
      } }),
    }))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
  const tarballs = [...graph.tarballs()].map(([key, payload]) => [key, stableValue({
    ...(payload.integrity === undefined ? {} : { integrity: payload.integrity }),
    ...(payload.berryChecksumCacheKey === undefined ? {} : {
      berryChecksumCacheKey: payload.berryChecksumCacheKey,
    }),
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

function probeEligible(assessment: AssessedOutput['assessment']): boolean {
  return assessment.requirements.every(item =>
    item.key === 'target-output-probe' || item.status === 'satisfied')
}

function outputProbe(
  graph: Graph,
  output: string,
  target: FormatId,
  contract: StringifyAssessedOptions['contract'],
  sourceEvidence: StringifyAssessedOptions['evidence'],
  diagnostics: Diagnostic[],
): OutputProbeResult {
  if (!checkOne(target, output)) {
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

  if (canonicalGraphSnapshot(graph, contract) !== canonicalGraphSnapshot(reparsed, contract)) {
    diagnostics.push(assessedDiagnostic(
      'COMPLETENESS_OUTPUT_GRAPH_MISMATCH',
      'target output does not preserve the canonical graph',
      { target },
    ))
  }

  const sourceState = internalEvidenceOf(sourceEvidence ?? evidenceOf(graph))
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
    const authority = authoritativePolicyOverridesOf(sourceState)
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

function stringifyAssessedInternal(
  graph: Graph,
  options: StringifyAssessedOptions,
  onDiagnostic?: (diagnostic: Diagnostic) => void,
): AssessedOutput {
  const preflight = assessConversion(graph, options)
  if (!probeEligible(preflight)) return { assessment: preflight }

  const state = internalEvidenceOf(options.evidence ?? evidenceOf(graph))
  const authority = options.contract === 'snapshot'
    ? undefined
    : authoritativePolicyOverridesOf(state)
  const diagnostics: Diagnostic[] = []
  let output: string
  try {
    output = stringifyOne(options.target.format, graph, {
      lineEnding: options.lineEnding,
      cacheKey: options.cacheKey,
      overrides: authority === undefined ? undefined : [...authority],
      onDiagnostic: diagnostic => {
        diagnostics.push(diagnostic)
        onDiagnostic?.(diagnostic)
      },
    })
  } catch (error) {
    diagnostics.push(assessedDiagnostic(
      'COMPLETENESS_OUTPUT_EMIT_FAILED',
      error instanceof Error ? error.message : 'target output emit failed',
      { target: options.target.format },
    ))
    const assessment = assessConversion(graph, options, {
      outputProbe: { accepted: false, diagnostics },
    })
    return { assessment }
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
    )
  } catch (error) {
    diagnostics.push(assessedDiagnostic(
      'COMPLETENESS_OUTPUT_PROBE_FAILED',
      error instanceof Error ? error.message : 'target output comparison failed',
      { target: options.target.format },
    ))
    probe = { accepted: false, diagnostics }
  }
  const assessment = assessConversion(graph, options, { outputProbe: probe })
  return assessment.status === 'satisfied' ? { output, assessment } : { assessment }
}

/** Emits only when canonical and target conversion requirements are satisfied. */
export function stringifyAssessed(
  graph: Graph,
  options: StringifyAssessedOptions,
): AssessedOutput {
  return stringifyAssessedInternal(graph, options)
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

/** Parses and emits only when the requested conversion contract is satisfied. */
export function convertAssessed(
  input: string,
  options: ConvertAssessedOptions,
): AssessedOutput {
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
  } catch (error) {
    return failedAssessedConversion(options, assessedDiagnostic(
      'COMPLETENESS_EVIDENCE_INVALID',
      error instanceof Error ? error.message : 'conversion evidence is invalid',
    ))
  }

  return stringifyAssessedInternal(graph, {
    contract: options.contract,
    target: { format: options.to, managerVersion: options.targetVersion },
    evidence,
    lineEnding: options.lineEnding,
    cacheKey: options.cacheKey,
  }, options.onDiagnostic)
}
