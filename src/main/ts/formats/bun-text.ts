// bun-text adapter — bun `bun.lock` text lockfile (lockfileVersion 1).
//
// Standalone-fit per yarn-classic / npm-1 / pnpm-v5 precedent. bun-text's
// schema (JSON-with-trailing-commas; positional `[id, "", inner, integrity]`
// tuples under `packages`; declarative `workspaces` map) is unique and does not
// share a flat-shape core with npm-flat or pnpm-flat. Reuses only
// shape-compatible micro-utilities (cmpStr / sortRecord) from `_npm-flat-types`.
//
// §A pinning (see spec/formats/bun-text.md):
//   - top-level numeric `lockfileVersion: 1`; `workspaces` + `packages` blocks.
//   - JSONC subset: trailing commas + comments. Stripped pre-`JSON.parse`,
//     replayed to emit.
//   - `packages` values: `[<id>, "", <inner?>, "<integrity>"]` (len 4) for
//     regular packages, `[<name>@workspace:<path>]` (len 1) for workspace refs.
//
// §B Lossy-but-acceptable:
//   - `RECIPE_FEATURE_DROPPED` (feature='patch') — bun cannot encode
// patches; drop on emit per canonical loss code.
//   - `BUN_TEXT_PEER_VIRT_FLATTENED` — bun's peer-deps are declarative;
//     peer-virt NodeIds (`<id>(<peer>@<v>)`) flatten on emit.
//
// §C enrich: workspace concretisation from manifests. peer-virt structurally
// absent (declarative peer-deps live in the inner-block).
// §D optimize: prune unreachable from `graph.roots()` BFS.

import {
  GraphError,
  nameOf,
  newBuilder,
  type DependencyManifest,
  type Diagnostic,
  type Edge,
  type EdgeKind,
  type Graph,
  type Node,
} from '../graph.ts'
import { LockfileError } from '../api/errors.ts'
import { parseSri, emitSriForRegistry, isEmptyIntegrity } from '../recipe/integrity.ts'
import {
  emitDropped as patchEmitDropped,
  emitDropped as recipeEmitDropped,
  emitWorkspaceCollapsed,
  invalidIntegrityDiagnostic,
} from '../recipe/diagnostics.ts'
import {
  bunTextWouldCollapse,
  isWorkspaceEdge,
  workspaceRangeOfEdge,
} from '../recipe/workspace.ts'
import { cmpStr, sortRecord } from './_npm-flat-types.ts'
import { optimizeUnreachable } from './_optimize.ts'
import { locateAuthoritativeRootNode } from './_root-authority.ts'
import {
  captureUnknownTopLevel,
  mergeUnknownTopLevel,
  unknownKeySubjects,
  unknownTopLevelSubjects,
  type UnknownTopLevelState,
} from './_unknown-top-level.ts'
import { nodeVersionOf } from './_node-id.ts'
import { captureOverrides, projectOverrides } from '../recipe/overrides.ts'
import {
  mergeUnresolvedDependencyDeclarations,
  unresolvedDependencyData,
} from '../recipe/unresolved-dependency.ts'
import type { OverrideConstraint } from '../graph.ts'

// === CONSTANTS ==============================================================

const INDENT = '  '

// === TYPES ==================================================================

/**
 * Which bun lockfile generation an adapter entry speaks.
 *
 * bun 1.4 writes `2` where 1.2-1.3 wrote `1`, and the schema is otherwise identical —
 * a project exercising workspaces, an alias, `overrides`, optional and peer deps and
 * `trustedDependencies` emits byte-identical locks under both apart from this integer.
 * They are nonetheless separate FORMAT IDENTITIES rather than one id with a remembered
 * integer, because a caller has to be able to ASK for a generation: converting into bun
 * from another family has no bun source to inherit from, and a bun-1.4 user is entitled
 * to the lock their own bun would write. That is the same reason npm-1..4, pnpm-v5/v6/v9
 * and deno-v2..v5 are each their own id.
 */
export interface BunTextGeneration {
  readonly lockfileVersion: 1 | 2
}

export const BUN_TEXT_V1: BunTextGeneration = { lockfileVersion: 1 }
export const BUN_TEXT_V2: BunTextGeneration = { lockfileVersion: 2 }

export interface BunTextParseOptions {}

export interface BunTextStringifyOptions {
  lineEnding?: 'lf' | 'crlf'
  /**
   * Caller-supplied canonical override constraints. bun's `overrides`
   * block is FLAT top-level only, so these project through the bun-flat grammar
   * (`projectOverrides(_, 'bun')`); an ancestry-scoped constraint is dropped with
   * BUN_OVERRIDE_NESTED_UNSUPPORTED. An explicit `[]` suppresses the verbatim
   * carrier captured at parse; `undefined` falls back to it. This is the
   * audit-fix write path — `pinOverride` results land here as a forced
   * resolution into bun's top-level `overrides`.
   */
  overrides?: OverrideConstraint[]
  onDiagnostic?: (diagnostic: Diagnostic) => void
}

export interface BunTextManifest extends DependencyManifest {}

export interface BunTextEnrichOptions {
  manifests?: Record<string, BunTextManifest>
}

export interface BunTextOptimizeOptions {}

// === On-disk schema =========================================================

interface BunTextInner {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  bin?: string | Record<string, string>
  [key: string]: unknown
}

interface BunTextWorkspaceManifest {
  name?: string
  version?: string
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}

interface BunTextLockfile {
  lockfileVersion?: number
  configVersion?: number
  workspaces?: Record<string, BunTextWorkspaceManifest>
  packages?: Record<string, unknown[]>
  trustedDependencies?: string[]
  patchedDependencies?: Record<string, string>
  overrides?: Record<string, string>
  [key: string]: unknown
}

interface BunTextNodeSidecar {
  inner?: BunTextInner
  packagesKey?: string
}

interface BunTextWorkspaceSidecar {
  path: string
  manifest: BunTextWorkspaceManifest
  /** Producer-tolerated, adapter-unknown keys of THIS entry. Same-format only. */
  unknownKeys?: UnknownTopLevelState
}

// Keys of a `workspaces` entry this adapter models. Anything else (`bin`,
// `optionalPeers`, whatever bun ships next) rides the verbatim carrier rather
// than gaining a field: a modelled field would claim we can project the concept
// to another lockfile, and for `bin` there is nothing to project — it means
// nothing in a `deno.lock`.
const KNOWN_WORKSPACE_MANIFEST_KEYS = [
  'name',
  'version',
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
] as const

interface BunTextPackageEntry {
  id: string
  inner?: BunTextInner
  integrity?: string
}

interface BunTextParseContext {
  readonly builder: ReturnType<typeof newBuilder>
  readonly diagnostics: Diagnostic[]
  readonly workspaces: Record<string, BunTextWorkspaceManifest>
  readonly packages: Record<string, unknown[]>
  readonly nodeSidecar: Map<string, BunTextNodeSidecar>
  readonly workspaceSidecar: Map<string, BunTextWorkspaceSidecar>
  readonly workspaceByPath: Map<string, string>
  readonly peerDeclarations: Map<string, string>
  readonly rootManifest: BunTextWorkspaceManifest
  readonly rootId: string
  readonly seenNodeIds: Set<string>
  readonly entriesByKey: Map<string, BunTextPackageEntry>
}

interface BunTextFidelity {
  readonly configVersion: number | undefined
  readonly nativeOverrides: Record<string, unknown> | undefined
  readonly canonicalOverrides: OverrideConstraint[] | undefined
  readonly trustedDependencies: string[] | undefined
  readonly patchedDependencies: Record<string, string> | undefined
  readonly unknownTopLevel: UnknownTopLevelState | undefined
}

interface BunTextSidecar {
  /** Native resolver generation. It affects Bun's interpretation of dehoisted
   *  package tuples and therefore survives same-PM emit. */
  configVersion?: number
  /** Verbatim parsed `packages` structure. Bun may carry multiple scoped keys
   *  that collapse onto one Graph NodeId while resolving dependencies
   *  differently for each consumer. */
  nativePackages?: Record<string, unknown[]>
  /** True only while the graph is exactly the graph produced by parse. */
  exactPackageReplay?: boolean
  rootId?: string
  rootManifest?: BunTextWorkspaceManifest
  workspaces: Map<string, BunTextWorkspaceSidecar>
  /** workspacePath -> NodeId (members + root). */
  workspaceByPath: Map<string, string>
  /** NodeId -> { inner, packagesKey } from parse-time `packages` block. */
  nodes: Map<string, BunTextNodeSidecar>
  /** declared peer ranges keyed by `<srcId>|<peerName>`. */
  peerDeclarations: Map<string, string>
  /** Verbatim top-level `overrides` block (lossless same-PM carrier,
   *  symmetric to npm's `rootMeta.nativeOverrides` / pnpm's `sidecar.overrides`).
   *  bun's block is npm-shaped (flat `{name: target}` or nested). */
  nativeOverrides?: Record<string, unknown>
  /** Canonical projection of `overrides` — for cross-PM reads. */
  canonicalOverrides?: OverrideConstraint[]
  /** Verbatim top-level `trustedDependencies` — postinstall-execution allowlist;
   *  load-bearing for reproducibility (spec/formats/bun-text.md Quirks). */
  trustedDependencies?: string[]
  /** Verbatim top-level `patchedDependencies` — bun's patch-protocol map
   *  (`<name>@<version>` -> patch-file path). */
  patchedDependencies?: Record<string, string>
  /** Producer-tolerated, adapter-unknown project-level keys. Same-format only. */
  unknownTopLevel?: UnknownTopLevelState
}

// === SIDECAR ================================================================

const sidecarByGraph = new WeakMap<Graph, BunTextSidecar>()

export function hasAdapterState(graph: Graph): boolean {
  return sidecarByGraph.has(graph)
}

export function adapterStateSubjects(graph: Graph): readonly string[] {
  const sidecar = sidecarByGraph.get(graph)
  const subjects = [...unknownTopLevelSubjects(sidecar?.unknownTopLevel)]
  // Per-workspace carriers are declared alongside the project-level ones: an
  // unmodelled key survives a same-format replay but is a real loss the moment
  // the graph is projected elsewhere, so it must be nameable there too.
  for (const [path, entry] of sidecar?.workspaces ?? []) {
    subjects.push(...unknownKeySubjects(entry.unknownKeys, `workspace[${path}]`))
  }
  return subjects
}

function rememberSidecar(graph: Graph, sidecar: BunTextSidecar): void {
  sidecarByGraph.set(graph, sidecar)
}

export function rebindAdapterState(
  source: Graph,
  target: Graph,
): Readonly<{ graph: Graph; invalidated: readonly string[] }> {
  const sidecar = sidecarByGraph.get(source)
  if (sidecar === undefined) return { graph: target, invalidated: [] }
  const pruned = pruneSidecar(sidecar, target)
  rememberSidecar(target, pruned)
  const invalidated = [
    ...[...sidecar.nodes.keys()].filter(id => !pruned.nodes.has(id)),
    ...[...sidecar.workspaceByPath.entries()]
      .filter(([path, id]) => pruned.workspaceByPath.get(path) !== id)
      .map(([path]) => `workspace:${path}`),
    ...[...sidecar.peerDeclarations.keys()].filter(key => !pruned.peerDeclarations.has(key)),
  ].sort()
  return { graph: target, invalidated }
}

/**
 * Canonical override constraints captured from a bun-text graph's top-level
 * `overrides` block (A2). Mirrors `getPnpmOverridesCanonical` /
 * npm's `rootMeta.overrides` so `index.ts` `overridesOf` can fold a bun source's
 * overrides into a cross-PM conversion. Returns undefined when the graph carries
 * no overrides block (or the sidecar was lost to a bare `mutate`).
 */
export function getBunOverridesCanonical(graph: Graph): OverrideConstraint[] | undefined {
  return sidecarByGraph.get(graph)?.canonicalOverrides
}

// === API ====================================================================

export function check(input: string, generation: BunTextGeneration = BUN_TEXT_V1): boolean {
  // bun-text discriminant. The two regexes are a cheap pre-filter; the structural
  // test below is what actually decides.
  const versionRe = new RegExp(`"lockfileVersion"\\s*:\\s*${generation.lockfileVersion}\\b`)
  if (!versionRe.test(input)) return false
  if (!/"workspaces"\s*:\s*\{/.test(input)) return false
  if (!/"packages"\s*:\s*\{/.test(input)) return false
  // bun 1.4 emits `lockfileVersion: 2`, the integer npm-2 has always used, so
  // the number no longer separates the families and `workspaces` has to. It
  // cannot be tested by scanning the text: npm carries the SAME key nested in
  // `packages[""]` as an object (`{"packages": ["apps/*"]}`, the yarn-style
  // declaration), which six real npm locks in the corpus do — a whole-file
  // regex reads those as bun. Only the TOP-LEVEL position distinguishes them,
  // so parse and look there. npm-2's own `check` already falls back to a parse
  // for the same reason.
  let parsed: { workspaces?: unknown }
  try {
    parsed = parseJsonc(normalizeLineEndings(input)) as { workspaces?: unknown }
  } catch {
    // Unparseable but carrying all three bun markers: keep the claim. `parse`
    // then reports a bun error naming the real problem, which beats `detect`
    // returning undefined and the caller guessing.
    return true
  }
  const workspaces = parsed?.workspaces
  return workspaces !== null && typeof workspaces === 'object' && !Array.isArray(workspaces)
}

export function parse(
  input: string,
  _options: BunTextParseOptions = {},
  generation: BunTextGeneration = BUN_TEXT_V1,
): Graph {
  const lf = parseBunLockfile(input, generation)
  const context = createBunParseContext(lf)

  // --- Pass 1: register all packages entries as graph nodes ----------------
  //
  // bun-text `packages` map keys can carry slash segments for hoisting
  // conflicts (`<consumer-path>/<dep-name>` form). Split on the last
  // `/` for name extraction where the leaf segment is the actual package name.
  // The id pulled from tuple slot [0] is the canonical `<name>@<version>` (or
  // workspace-form `<name>@workspace:<path>`).
  registerPackageEntries(context)

  // Pre-register workspace members declared in the `workspaces` map even
  // when they don't appear in `packages` (rare; bun emits both, but if a
  // member has no installed deps the packages-side entry is still emitted).
  registerDeclaredWorkspaces(context)

  // Pass 2: emit workspace-manifest edges. workspace-protocol ranges resolve
  // via `workspaceByPath` (member name lookup); plain ranges resolve via
  // the flat package index.
  const packageByName = buildPackageByName(context.packages)
  addWorkspaceManifestEdges(context, packageByName)

  // Pass 3: emit packages inner-block edges. Resolution uses a per-consumer
  // scoped index, since bun de-hoists conflicting entries under `<consumer>/<dep>`
  // packages keys and those shadow the flat lookup for that consumer.
  //
  // A single NodeId can appear under multiple `packages` keys — via npm-alias
  // siblings (`string-width` + `string-width-cjs`, both `string-width@4.2.3`)
  // and via de-hoist keys (`<consumer>/<dep>`). Node registration already
  // dedups on NodeId (`seenNodeIds`), but `entriesByKey` keeps one entry per
  // key, so without a guard `addBlockEdges` re-emits the identical
  // `(src, dep, kind)` edge 2-3× → seal `duplicate edge`. Emit each source
  // node's inner-block exactly once; the first key wins (its de-hoist scope
  // applies). The package's own dependency set is invariant across its keys,
  // so collapsing is lossless — stringify re-expands one tuple per
  // name@version regardless.
  addPackageEntryEdges(context, packageByName)

  // -- Top-level fidelity blocks (spec/formats/bun-text.md) ----
  // Capture `overrides` / `trustedDependencies` / `patchedDependencies`
  // verbatim so a same-PM round-trip is lossless. `overrides` is bun's
  // forced-resolution mechanism — the npm/bun analog of yarn `resolutions`,
  // load-bearing for audit-fix transitive pins. The canonical projection
  // (npm grammar — bun's block is npm-shaped) backs cross-PM reads.
  const fidelity = captureBunFidelity(lf)
  return sealBunGraph(context, fidelity)
}

function parseBunLockfile(input: string, generation: BunTextGeneration): BunTextLockfile {
  const lf = parseJsonc(normalizeLineEndings(input))
  // Each generation is its own format id, so each parses only its own integer —
  // the id IS the answer to "which bun wrote this". bun 1.4 emits 2 for a NEW lock
  // and leaves an existing 1 at 1 (measured: `--frozen-lockfile` accepts a v1 and a
  // write-enabled install does not rewrite it), so both remain live inputs.
  if (lf.lockfileVersion !== generation.lockfileVersion) {
    throw new LockfileError({
      code: 'FORMAT_MISMATCH',
      message: `bun-text adapter: expected lockfileVersion ${generation.lockfileVersion}, `
        + `got ${JSON.stringify(lf.lockfileVersion)}`,
    })
  }
  if (lf.workspaces === undefined || lf.workspaces === null || typeof lf.workspaces !== 'object') {
    throw new LockfileError({
      code: 'FORMAT_MISMATCH',
      message: 'bun-text adapter: missing required `workspaces` block',
    })
  }
  if (lf.packages === undefined || lf.packages === null || typeof lf.packages !== 'object') {
    throw new LockfileError({
      code: 'FORMAT_MISMATCH',
      message: 'bun-text adapter: missing required `packages` block',
    })
  }
  // Reject npm-flat shapes which also live under `packages` but as objects (not arrays).
  const packagesValues = Object.values(lf.packages)
  if (packagesValues.length > 0 && !packagesValues.every(v => Array.isArray(v))) {
    throw new LockfileError({
      code: 'FORMAT_MISMATCH',
      message: 'bun-text adapter: `packages` entries must be positional tuples (arrays)',
    })
  }
  return lf
}

function createBunParseContext(lf: BunTextLockfile): BunTextParseContext {
  const builder = newBuilder()
  const diagnostics: Diagnostic[] = []
  const nodeSidecar = new Map<string, BunTextNodeSidecar>()
  const workspaceSidecar = new Map<string, BunTextWorkspaceSidecar>()
  const workspaceByPath = new Map<string, string>()
  const peerDeclarations = new Map<string, string>()

  const workspaces = lf.workspaces as Record<string, BunTextWorkspaceManifest>
  const rootManifest = workspaces[''] ?? { name: '' }
  const rootName = rootManifest.name ?? ''
  const rootVersion = rootManifest.version ?? '0.0.0'
  const rootId = `${rootName}@${rootVersion}`
  builder.addNode({
    id: rootId,
    name: rootName,
    version: rootVersion,
    peerContext: [],
    workspacePath: '',
  })
  workspaceByPath.set('', rootId)
  workspaceSidecar.set('', { path: '', manifest: rootManifest })
  const packages = lf.packages as Record<string, unknown[]>
  const seenNodeIds = new Set<string>([rootId])
  const entriesByKey = new Map<string, BunTextPackageEntry>()
  return {
    builder,
    diagnostics,
    workspaces,
    packages,
    nodeSidecar,
    workspaceSidecar,
    workspaceByPath,
    peerDeclarations,
    rootManifest,
    rootId,
    seenNodeIds,
    entriesByKey,
  }
}

// Snapshot each `workspaces` entry's unmodelled keys once, after every
// registration path has contributed its manifest — a single capture site
// cannot miss one of the three places an entry can be registered from.
function captureWorkspaceUnknownKeys(
  workspaces: Map<string, BunTextWorkspaceSidecar>,
): Map<string, BunTextWorkspaceSidecar> {
  const captured = new Map<string, BunTextWorkspaceSidecar>()
  for (const [path, entry] of workspaces) {
    const unknownKeys = captureUnknownTopLevel(
      (entry.manifest ?? {}) as Readonly<Record<string, unknown>>,
      KNOWN_WORKSPACE_MANIFEST_KEYS,
    )
    captured.set(path, unknownKeys === undefined ? entry : { ...entry, unknownKeys })
  }
  return captured
}

function sealBunGraph(context: BunTextParseContext, fidelity: BunTextFidelity): Graph {
  for (const diagnostic of context.diagnostics) {
    context.builder.diagnostic(diagnostic)
  }

  try {
    const graph = context.builder.seal()
    const sidecar: BunTextSidecar = {
      nativePackages: context.packages,
      exactPackageReplay: true,
      rootId: context.rootId,
      rootManifest: context.rootManifest,
      workspaces: captureWorkspaceUnknownKeys(context.workspaceSidecar),
      workspaceByPath: context.workspaceByPath,
      nodes: context.nodeSidecar,
      peerDeclarations: context.peerDeclarations,
      ...fidelity,
    }
    rememberSidecar(graph, sidecar)
    return graph
  } catch (error) {
    if (error instanceof GraphError) {
      throw new LockfileError({
        code: 'PARSE_FAILED',
        message: `bun-text seal failed: ${error.message}`,
      })
    }
    throw error
  }
}

function captureBunFidelity(lf: BunTextLockfile): BunTextFidelity {
  let nativeOverrides: Record<string, unknown> | undefined
  let canonicalOverrides: OverrideConstraint[] | undefined
  if (lf.overrides !== undefined && lf.overrides !== null && typeof lf.overrides === 'object') {
    nativeOverrides = lf.overrides as Record<string, unknown>
    // Capture canonical form for cross-PM reads. No `onDiagnostic` is threaded:
    // the only event `captureOverrides` emits is the `RECIPE_OVERRIDE_NORMALISED`
    // *info* observability ping, and landing it on `graph.diagnostics()` would be
    // pure noise on the same-PM bun round-trip (the verbatim block is the
    // load-bearing carrier). The canonical projection is still computed.
    const captured = captureOverrides(lf.overrides, 'npm')
    if (captured.canonical.length > 0) canonicalOverrides = captured.canonical
  }
  const trustedDependencies = Array.isArray(lf.trustedDependencies)
    ? (lf.trustedDependencies as unknown[]).filter((value): value is string => typeof value === 'string')
    : undefined
  const patchedDependencies = lf.patchedDependencies !== undefined
    && lf.patchedDependencies !== null
    && typeof lf.patchedDependencies === 'object'
    ? Object.fromEntries(
        Object.entries(lf.patchedDependencies as Record<string, unknown>)
          .filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
      )
    : undefined
  return {
    configVersion: typeof lf.configVersion === 'number' ? lf.configVersion : undefined,
    nativeOverrides,
    canonicalOverrides,
    trustedDependencies,
    patchedDependencies,
    unknownTopLevel: captureUnknownTopLevel(lf, [
      'lockfileVersion',
      'configVersion',
      'workspaces',
      'packages',
      'trustedDependencies',
      'patchedDependencies',
      'overrides',
    ]),
  }
}

function registerDeclaredWorkspaces(context: BunTextParseContext): void {
  for (const [path, manifest] of Object.entries(context.workspaces)) {
    if (path === '') continue
    if (context.workspaceByPath.has(path)) continue
    if (manifest === null || typeof manifest !== 'object') continue
    const memberName = manifest.name
    if (typeof memberName !== 'string' || memberName.length === 0) continue
    const memberVersion = manifest.version ?? '0.0.0'
    const memberId = `${memberName}@${memberVersion}`
    if (!context.seenNodeIds.has(memberId)) {
      context.seenNodeIds.add(memberId)
      context.builder.addNode({
        id: memberId,
        name: memberName,
        version: memberVersion,
        peerContext: [],
        workspacePath: path,
      })
    }
    context.workspaceByPath.set(path, memberId)
    context.workspaceSidecar.set(path, { path, manifest })
  }
}

function addWorkspaceManifestEdges(
  context: BunTextParseContext,
  packageByName: Map<string, string>,
): void {
  for (const [path, workspace] of context.workspaceSidecar) {
    const srcId = context.workspaceByPath.get(path)
    if (srcId === undefined) continue
    addBlockEdges(
      context.builder,
      context.diagnostics,
      srcId,
      workspace.manifest,
      packageByName,
      context.workspaceByPath,
      context.peerDeclarations,
      'workspace',
    )
  }
}

function addPackageEntryEdges(
  context: BunTextParseContext,
  packageByName: Map<string, string>,
): void {
  const emittedSrc = new Set<string>()
  for (const [packagesKey, entry] of context.entriesByKey) {
    if (entry.inner === undefined) continue
    if (emittedSrc.has(entry.id)) continue
    emittedSrc.add(entry.id)
    const consumerScope = buildConsumerScope(packagesKey, context.packages, packageByName)
    addBlockEdges(
      context.builder,
      context.diagnostics,
      entry.id,
      entry.inner,
      consumerScope,
      undefined,
      context.peerDeclarations,
      'package',
    )
  }
}

function registerPackageEntries(context: BunTextParseContext): void {
  for (const [packagesKey, raw] of Object.entries(context.packages)) {
    registerPackageEntry(context, packagesKey, raw)
  }
}

function registerPackageEntry(
  context: BunTextParseContext,
  packagesKey: string,
  raw: unknown[],
): void {
  if (!Array.isArray(raw) || raw.length === 0) {
    context.diagnostics.push({
      code: 'BUN_TEXT_BAD_ENTRY',
      severity: 'warning',
      message: `bun-text entry ${JSON.stringify(packagesKey)} is not a positional tuple; skipping`,
    })
    return
  }
  const idToken = raw[0]
  if (typeof idToken !== 'string') {
    context.diagnostics.push({
      code: 'BUN_TEXT_BAD_ENTRY',
      severity: 'warning',
      message: `bun-text entry ${JSON.stringify(packagesKey)} missing id token`,
    })
    return
  }
  if (raw.length === 1) {
    registerWorkspacePackageEntry(context, packagesKey, idToken)
    return
  }
  registerRegularPackageEntry(context, packagesKey, idToken, raw)
}

function registerWorkspacePackageEntry(
  context: BunTextParseContext,
  packagesKey: string,
  idToken: string,
): void {
  // Workspace member reference: `[<name>@workspace:<path>]`.
  const parsed = parseWorkspaceRef(idToken)
  if (parsed === undefined) {
    context.diagnostics.push({
      code: 'BUN_TEXT_BAD_ENTRY',
      severity: 'warning',
      message: `bun-text workspace-ref ${JSON.stringify(idToken)} unparseable; skipping`,
    })
    return
  }
  const wsManifest = context.workspaces[parsed.path]
  const wsVersion = wsManifest?.version ?? '0.0.0'
  const wsId = `${parsed.name}@${wsVersion}`
  if (!context.seenNodeIds.has(wsId)) {
    context.seenNodeIds.add(wsId)
    context.builder.addNode({
      id: wsId,
      name: parsed.name,
      version: wsVersion,
      peerContext: [],
      workspacePath: parsed.path,
    })
  }
  context.workspaceByPath.set(parsed.path, wsId)
  if (wsManifest !== undefined) {
    context.workspaceSidecar.set(parsed.path, { path: parsed.path, manifest: wsManifest })
  }
  context.nodeSidecar.set(wsId, { packagesKey })
  context.entriesByKey.set(packagesKey, { id: wsId })
}

function registerRegularPackageEntry(
  context: BunTextParseContext,
  packagesKey: string,
  idToken: string,
  raw: unknown[],
): void {
  // Regular package: `[id, "", inner, integrity]`.
  const parsed = parsePackageId(idToken)
  if (parsed === undefined) {
    context.diagnostics.push({
      code: 'BUN_TEXT_BAD_ENTRY',
      severity: 'warning',
      message: `bun-text id ${JSON.stringify(idToken)} unparseable; skipping`,
    })
    return
  }
  const { name, version } = parsed
  const nodeId = `${name}@${version}`
  const inner = (raw.length >= 3 && raw[2] !== null && typeof raw[2] === 'object' && !Array.isArray(raw[2]))
    ? raw[2] as BunTextInner
    : undefined
  const integrity = raw.length >= 4 && typeof raw[3] === 'string' && raw[3].length > 0
    ? raw[3] as string
    : undefined

  if (!context.seenNodeIds.has(nodeId)) {
    context.seenNodeIds.add(nodeId)
    context.builder.addNode({
      id: nodeId,
      name,
      version,
      peerContext: [],
    })
    setBunTarball(context, name, version, nodeId, integrity)
  }
  context.nodeSidecar.set(nodeId, { inner, packagesKey })
  context.entriesByKey.set(packagesKey, { id: nodeId, inner, integrity })
}

function setBunTarball(
  context: BunTextParseContext,
  name: string,
  version: string,
  nodeId: string,
  integrity: string | undefined,
): void {
  if (integrity === undefined) return
  const parsed = parseSri(integrity, 'sri')
  if (isEmptyIntegrity(parsed)) {
    context.diagnostics.push(invalidIntegrityDiagnostic('BUN_TEXT', nodeId, integrity))
  } else {
    context.builder.setTarball({ name, version }, { integrity: parsed })
  }
}

export function stringify(
  graph: Graph,
  options: BunTextStringifyOptions = {},
  generation: BunTextGeneration = BUN_TEXT_V1,
): string {
  const sidecar = sidecarByGraph.get(graph)
  const emitDiagnostic = (diagnostic: Diagnostic): void => options.onDiagnostic?.(diagnostic)

  const warnedPatches = new Set<string>()
  const warnedPeerVirt = new Set<string>()

  const rootNode = locateAuthoritativeRootNode(graph, sidecar)
  const memberNodes = Array.from(graph.nodes())
    .filter(n => n.workspacePath !== undefined && n.workspacePath !== '')
    .sort((a, b) => cmpStr(a.workspacePath!, b.workspacePath!))

  // Build `workspaces` block: root + members.
  const workspacesBlock: Record<string, BunTextWorkspaceManifest> = {
    '': buildWorkspaceManifest(
      graph, rootNode, sidecar?.workspaces.get('')?.manifest, emitDiagnostic,
      sidecar?.peerDeclarations, sidecar?.workspaces.get('')?.unknownKeys,
    ),
  }
  for (const member of memberNodes) {
    const path = member.workspacePath!
    workspacesBlock[path] = buildWorkspaceManifest(
      graph, member, sidecar?.workspaces.get(path)?.manifest, emitDiagnostic,
      sidecar?.peerDeclarations, sidecar?.workspaces.get(path)?.unknownKeys,
    )
  }

  // Build `packages` block: workspace members (1-elem tuples) then regular packages
  // (4-elem tuples), both sorted alphabetically by emit key.
  const replayNativePackages = sidecar?.exactPackageReplay === true
    && sidecar.nativePackages !== undefined
  const packagesBlock: Record<string, unknown[]> = replayNativePackages
    ? { ...sidecar.nativePackages! }
    : {}
  for (const member of [...memberNodes].sort((a, b) => cmpStr(a.name, b.name))) {
    if (!replayNativePackages) {
      packagesBlock[member.name] = [`${member.name}@workspace:${member.workspacePath}`]
    }
  }
  // Sort: unpatched nodes first (patch === undefined) for any given
  // `<name>@<version>` tuple, so the dedup loop below keeps the cleaner shape
  // and the patched siblings are dropped via `reportPatchDrop` /
  // RECIPE_FEATURE_DROPPED. bun-text has no patch protocol, so patched and
  // unpatched siblings of the same `<name>@<version>` collapse onto one
  // entry on reparse — emit only one to keep the seal invariant.
  const regularNodes = Array.from(graph.nodes())
    .filter(n => n.id !== rootNode?.id && n.workspacePath === undefined)
    .sort((a, b) =>
      cmpStr(a.name, b.name)
        || cmpStr(a.version, b.version)
        || ((a.patch === undefined ? 0 : 1) - (b.patch === undefined ? 0 : 1)),
    )
  const warnedResolutions = new Set<string>()
  const emittedNameVersion = new Set<string>()
  for (const node of regularNodes) {
    reportPatchDrop(node, warnedPatches, emitDiagnostic)
    reportPeerVirt(node, warnedPeerVirt, emitDiagnostic)
    reportResolutionDrop(graph, node, warnedResolutions, emitDiagnostic)
    if (replayNativePackages) continue

    const nameVersion = `${node.name}@${node.version}`
    if (emittedNameVersion.has(nameVersion)) {
      // Patched sibling of a `<name>@<version>` already emitted — bun-text
      // has no patch protocol, so this would collapse onto the same key on
      // reparse and break the seal with a duplicate-edge error. Drop the
      // duplicate emit; the `reportPatchDrop` diagnostic already encodes the
      // RECIPE_FEATURE_DROPPED loss.
      continue
    }
    emittedNameVersion.add(nameVersion)

    const inner = buildInnerBlock(graph, node, sidecar)
    const tarballSrc = graph.tarballOf(node.id)
    const integrity = emitSriForRegistry(tarballSrc?.integrity, tarballSrc?.nativeResolution) ?? ''
    const key = chooseNodeEmitKey(graph, node, sidecar, packagesBlock)
    packagesBlock[key] = [`${node.name}@${node.version}`, '', inner, integrity]
  }

  // Top-level fidelity blocks (spec/formats/bun-text.md). Key
  // order mirrors bun's emit: workspaces, overrides, packages, then the
  // trailing reproducibility blocks. `overrides` source precedence matches the
  // npm-core precedent:
  //   1. caller `options.overrides` (canonical) → project via npm grammar
  //      (bun's block is npm-shaped). An explicit `[]` suppresses the carrier.
  //   2. else the VERBATIM parse-time block (lossless same-PM round-trip).
  //   3. else a canonical-only carrier (cross-PM capture) → project.
  const overridesBlock = resolveOverridesBlock(options.overrides, sidecar, emitDiagnostic)

  const out: Record<string, unknown> = {
    // The TARGET generation, not the source's: with one id per generation the caller
    // has already said which bun this lock is for.
    lockfileVersion: generation.lockfileVersion,
  }
  // Top-level schedule, measured across the corpus: `packages` is LAST in every
  // one of the 173 real locks, and the reproducibility blocks sit between
  // `workspaces` and it — `patchedDependencies` and `trustedDependencies`
  // before `overrides`, never after `packages`.
  if (sidecar?.configVersion !== undefined) out.configVersion = sidecar.configVersion
  out.workspaces = workspacesBlock
  // Both blocks are VERBATIM same-format carriers (spec: "round-trips
  // verbatim"), and bun keeps the order the project authored — `trustedDependencies`
  // is an allowlist, not a set to normalise. Sorting them here rewrote the
  // producer's schedule; replay it instead. No determinism is lost: the values
  // come from parse, and a graph without the sidecar emits no block at all.
  if (sidecar?.patchedDependencies !== undefined && Object.keys(sidecar.patchedDependencies).length > 0) {
    out.patchedDependencies = { ...sidecar.patchedDependencies }
  }
  if (sidecar?.trustedDependencies !== undefined && sidecar.trustedDependencies.length > 0) {
    out.trustedDependencies = [...sidecar.trustedDependencies]
  }
  if (overridesBlock !== undefined && Object.keys(overridesBlock).length > 0) {
    out.overrides = overridesBlock
  }
  out.packages = packagesBlock

  const merged = mergeUnknownTopLevel(out, sidecar?.unknownTopLevel)
  const json = renderJsonc(merged)
  return options.lineEnding === 'crlf' ? json.replace(/\n/g, '\r\n') : json
}

export function enrich(
  graph: Graph,
  options: BunTextEnrichOptions = {},
): { graph: Graph; diagnostics: Diagnostic[] } {
  const sidecar = sidecarByGraph.get(graph)
  const diagnostics: Diagnostic[] = []

  if (options.manifests === undefined) {
    // No manifests provided — peer-virt structurally absent, workspace block
    // already carries member tagging from parse. Return graph as-is.
    return { graph, diagnostics }
  }

  // Manifest-driven workspace concretisation: synthesize workspace member nodes
  // not already present, tag existing nodes whose name matches a manifest.
  const memberByName = new Map<string, { path: string; manifest: BunTextManifest }>()
  for (const [path, manifest] of Object.entries(options.manifests)) {
    if (path === '' || manifest.name === undefined) continue
    memberByName.set(manifest.name, { path, manifest })
  }

  const addMemberNodes: Node[] = []
  const memberReplacements: Node[] = []

  for (const node of graph.nodes()) {
    if (node.workspacePath !== undefined) continue
    const member = memberByName.get(node.name)
    if (member === undefined) continue
    if (member.manifest.version !== undefined && node.version !== member.manifest.version) continue
    if (graph.tarball({ name: node.name, version: node.version }) !== undefined) continue
    memberReplacements.push({ ...node, workspacePath: member.path })
  }

  for (const [name, { path, manifest }] of memberByName) {
    const memberVersion = manifest.version ?? '0.0.0'
    const memberId = `${name}@${memberVersion}`
    const existing = graph.getNode(memberId)
    if (existing !== undefined) {
      if (existing.workspacePath === path) continue
      if (memberReplacements.some(n => n.id === memberId)) continue
      memberReplacements.push({ ...existing, workspacePath: path })
      continue
    }
    if (memberReplacements.some(n => n.id === memberId)) continue
    addMemberNodes.push({
      id: memberId,
      name,
      version: memberVersion,
      peerContext: [],
      workspacePath: path,
    })
  }

  if (addMemberNodes.length === 0 && memberReplacements.length === 0) {
    return { graph, diagnostics }
  }

  const result = graph.mutate(m => {
    for (const node of addMemberNodes) {
      m.addNode(node)
    }
    for (const replacement of memberReplacements) {
      m.replaceNode(replacement.id, replacement)
    }
  })

  if (sidecar !== undefined) {
    rememberSidecar(result.graph, { ...sidecar, exactPackageReplay: false })
  }
  return { graph: result.graph, diagnostics }
}

export function optimize(
  graph: Graph,
  _options: BunTextOptimizeOptions = {},
): { graph: Graph; diagnostics: Diagnostic[] } {
  const sidecar = sidecarByGraph.get(graph)
  const result = optimizeUnreachable(graph, {
    seeds: Array.from(graph.roots()),
    compare: cmpStr,
    edgeSeparator: ' ',
    tarballInputs: node => ({ name: node.name, version: node.version, patch: node.patch }),
    skipMissingTarballs: true,
  })

  if (result.graph !== graph && sidecar !== undefined) {
    rememberSidecar(result.graph, pruneSidecar(sidecar, result.graph))
  }
  return result
}

// === PARSE ==================================================================

interface BunTextDepBlocks {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}

// Adds dep / dev / optional / peer edges from a block-bearing source (workspace
// manifest or inner-block of a packages entry). For source = 'manifest',
// workspace-protocol ranges resolve via `workspaceByPath`; otherwise we
// rely on the pre-scoped `byName` map. Peer ranges are stashed declaratively
// bun encodes peers as data, not graph edges (§C enrich).
export function addBlockEdges(
  builder: ReturnType<typeof newBuilder>,
  diagnostics: Diagnostic[],
  srcId: string,
  blocks: BunTextDepBlocks,
  byName: Map<string, string>,
  workspaceByPath: Map<string, string> | undefined,
  peerDeclarations: Map<string, string>,
  channel?: 'workspace' | 'package',
): void {
  const sections: Array<[EdgeKind, Record<string, string> | undefined]> = [
    ['dep', blocks.dependencies],
    ['dev', blocks.devDependencies],
    ['optional', blocks.optionalDependencies],
    ['peer', blocks.peerDependencies],
  ]
  for (const [kind, deps] of sections) {
    if (deps === undefined) continue
    for (const [depName, range] of Object.entries(deps).sort((a, b) => cmpStr(a[0], b[0]))) {
      if (kind === 'peer') {
        peerDeclarations.set(`${srcId}|${depName}`, range)
        continue
      }
      const dstId = workspaceByPath !== undefined && isWorkspaceProtocolRange(range)
        ? resolveWorkspaceTarget(depName, workspaceByPath)
        : byName.get(depName)
      if (dstId === undefined) {
        diagnostics.push({
          code: 'BUN_TEXT_UNRESOLVED_DEP',
          severity: 'warning',
          subject: srcId,
          message: `${srcId}: unresolved ${kind} ${depName}@${range}`,
          data: unresolvedDependencyData({
            src: srcId,
            kind,
            name: depName,
            descriptor: range,
            ...(channel === undefined ? {} : { channel }),
          }),
        })
        continue
      }
      const attrs: { range: string; alias?: string; workspace?: boolean; workspaceRange?: { specifier: string; resolvedVersion?: string } } = { range }
      // EdgeAttrs.alias — the DECLARED dependency name, kept whenever it
      // differs from the resolved target's own name. bun encodes an npm alias
      // by keying both the dependency map and the `packages` entry under the
      // declared name while the tuple id slot holds the canonical
      // `<name>@<version>` (`"pm-x": ["@yarnpkg/cli-dist@4.17.1", …]`).
      // Resolution above already followed that channel, so the mismatch
      // between `depName` and the dst node's name is exactly the alias. It is
      // NOT recoverable from the target node, so it has to ride the edge —
      // without it the emitter re-keys the map by the package name and the
      // emitted lock no longer resolves.
      if (depName !== nameOf(dstId)) attrs.alias = depName
      if (isWorkspaceProtocolRange(range)) {
        attrs.workspace = true
        // bun-text member-ref form has no version range;
        // canonical specifier is `workspace:*` (bun's coarse default). The
        // verbatim source-side richer specifier survives in `attrs.range`
        // for same-format roundtrip; the canonical workspaceRange flags the
        // coarse identity to cross-format consumers. resolvedVersion is
        // best-effort — extracted from the canonical NodeId.
        const dstVersion = nodeVersionOf(dstId)
        attrs.workspaceRange = dstVersion !== undefined && dstVersion !== ''
          ? { specifier: 'workspace:*', resolvedVersion: dstVersion }
          : { specifier: 'workspace:*' }
      }
      try {
        builder.addEdge(srcId, dstId, kind, attrs)
      } catch (error) {
        if (error instanceof GraphError && error.code === 'INVARIANT_VIOLATION') continue
        throw error
      }
    }
  }
}

// === JSONC helpers ==========================================================

function parseJsonc(input: string): BunTextLockfile {
  // Strip line + block comments + trailing commas, then JSON.parse.
  // bun-text's JSONC subset = comments + trailing commas only.
  const stripped = stripJsoncExtensions(input)
  let parsed: unknown
  try {
    parsed = JSON.parse(stripped)
  } catch (error) {
    throw new LockfileError({
      code: 'FORMAT_MISMATCH',
      message: `bun-text adapter: input is not valid JSONC: ${(error as Error).message}`,
      cause: error,
    })
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new LockfileError({
      code: 'FORMAT_MISMATCH',
      message: 'bun-text adapter: top-level value must be a JSON object',
    })
  }
  return parsed as BunTextLockfile
}

function stripJsoncExtensions(input: string): string {
  // State-machine pass: skip line-comments + block-comments + trailing
  // commas before `}` / `]`. Strings and escape sequences are honored so we
  // don't corrupt embedded `//` / `/*` inside string values.
  const out: string[] = []
  const len = input.length
  let i = 0
  let inString = false
  let escape = false

  while (i < len) {
    const c = input[i]!
    if (inString) {
      out.push(c)
      if (escape) {
        escape = false
      } else if (c === '\\') {
        escape = true
      } else if (c === '"') {
        inString = false
      }
      i++
      continue
    }
    if (c === '"') {
      inString = true
      out.push(c)
      i++
      continue
    }
    // Line comment `// ... \n`.
    if (c === '/' && i + 1 < len && input[i + 1] === '/') {
      i += 2
      while (i < len && input[i] !== '\n') i++
      continue
    }
    // Block comment `/* ... */`.
    if (c === '/' && i + 1 < len && input[i + 1] === '*') {
      i += 2
      while (i + 1 < len && !(input[i] === '*' && input[i + 1] === '/')) i++
      i += 2
      continue
    }
    // Trailing comma: `,` followed by whitespace + (`}` or `]`).
    if (c === ',') {
      let j = i + 1
      while (j < len && /\s/.test(input[j]!)) j++
      if (j < len && (input[j] === '}' || input[j] === ']')) {
        // Skip the comma; whitespace + closer follow as normal.
        i++
        continue
      }
    }
    out.push(c)
    i++
  }
  return out.join('')
}

// === Parse helpers ==========================================================

function normalizeLineEndings(input: string): string {
  return input.replace(/\r\n/g, '\n')
}

function parsePackageId(token: string): { name: string; version: string } | undefined {
  // Last `@` (after index 0 so scoped names keep their leading `@`) separates
  // name from version. Returns undefined for workspace-form IDs (those route
  // through `parseWorkspaceRef`).
  const lastAt = token.lastIndexOf('@')
  if (lastAt <= 0) return undefined
  const name = token.slice(0, lastAt)
  const version = token.slice(lastAt + 1)
  if (name.length === 0 || version.length === 0) return undefined
  if (version.startsWith('workspace:')) return undefined
  return { name, version }
}

function parseWorkspaceRef(token: string): { name: string; path: string } | undefined {
  // `<name>@workspace:<path>` — last `@` before `workspace:`.
  const idx = token.indexOf('@workspace:')
  if (idx <= 0) return undefined
  const name = token.slice(0, idx)
  const path = token.slice(idx + '@workspace:'.length)
  if (name.length === 0 || path.length === 0) return undefined
  return { name, path }
}

// Build a flat depname -> NodeId index from `packages` keys (regular entries
// only; workspace refs resolve via `workspaceByPath`). Scoped names (`@foo/bar`)
// are top-level keys c a single `/` and a leading `@`; de-hoisted entries
// (`<consumer>/<dep>`) carry a `/` without the leading `@` and are SKIPPED here —
// `buildConsumerScope` layers them in per-consumer.
function buildPackageByName(packages: Record<string, unknown[]>): Map<string, string> {
  const byName = new Map<string, string>()
  for (const [packagesKey, raw] of Object.entries(packages)) {
    if (!Array.isArray(raw) || raw.length < 2) continue
    const idToken = raw[0]
    if (typeof idToken !== 'string') continue
    const parsed = parsePackageId(idToken)
    if (parsed === undefined) continue
    if (!packagesKey.includes('/') || packagesKey.startsWith('@')) {
      if (!byName.has(packagesKey)) {
        byName.set(packagesKey, `${parsed.name}@${parsed.version}`)
      }
    }
  }
  return byName
}

function buildConsumerScope(
  consumerKey: string,
  packages: Record<string, unknown[]>,
  flatByName: Map<string, string>,
): Map<string, string> {
  // Returns a name -> NodeId map with de-hoisted overrides applied.
  // De-hoisted keys: `<consumerKey>/<dep-name>`.
  const scoped = new Map<string, string>(flatByName)
  const prefix = `${consumerKey}/`
  for (const [pkgKey, raw] of Object.entries(packages)) {
    if (!pkgKey.startsWith(prefix)) continue
    const localName = pkgKey.slice(prefix.length)
    if (!Array.isArray(raw) || raw.length === 0) continue
    const idToken = raw[0]
    if (typeof idToken !== 'string') continue
    const parsed = parsePackageId(idToken)
    if (parsed === undefined) continue
    // De-hoist shadows the flat-hoist key for this consumer.
    scoped.set(localName, `${parsed.name}@${parsed.version}`)
  }
  return scoped
}

function resolveWorkspaceTarget(name: string, workspaceByPath: Map<string, string>): string | undefined {
  // workspace:<path> | workspace:* | workspace:^ | workspace:<version> — bun
  // resolves all variants to the same member; lookup by member name suffices.
  for (const [path, nodeId] of workspaceByPath) {
    if (path === '') continue
    if (nodeId.startsWith(`${name}@`)) return nodeId
  }
  return undefined
}

function isWorkspaceProtocolRange(range: string): boolean {
  return range.startsWith('workspace:')
}

// === SERIALIZE ==============================================================

export function resolveOverridesBlock(
  callerOverrides: OverrideConstraint[] | undefined,
  sidecar: BunTextSidecar | undefined,
  emitDiagnostic: (d: Diagnostic) => void,
): Record<string, unknown> | undefined {
  if (callerOverrides !== undefined) {
    return callerOverrides.length > 0
      ? projectOverrides(callerOverrides, 'bun', emitDiagnostic)
      : undefined
  }
  if (sidecar?.nativeOverrides !== undefined) return sidecar.nativeOverrides
  if (sidecar?.canonicalOverrides !== undefined && sidecar.canonicalOverrides.length > 0) {
    return projectOverrides(sidecar.canonicalOverrides, 'bun', emitDiagnostic)
  }
  return undefined
}

export function renderValue(value: unknown, depth: number, isTopLevel: boolean): string {
  if (Array.isArray(value)) return renderArray(value)
  if (value !== null && typeof value === 'object') return renderObject(value as Record<string, unknown>, depth, isTopLevel)
  return renderInlineValue(value)
}

export function renderInlineValue(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null'
  if (typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) {
    return `[${value.map(item => renderInlineValue(item)).join(', ')}]`
  }
  if (typeof value === 'object') {
    return renderInlineObject(value as Record<string, unknown>)
  }
  return 'null'
}

// Dependency-map slot for an edge. bun keys `dependencies` /
// `devDependencies` / `optionalDependencies` by the DECLARED name, which for
// an npm alias is the alias (`"string-width-cjs": "npm:string-width@^4.2.0"`)
// and not the resolved package name. `EdgeAttrs.alias` carries that declared
// name; a bare dep has none and falls back to the target's own name, leaving
// the non-aliased emit byte-unchanged.
function declaredNameOf(edge: Edge, dst: Node): string {
  return edge.attrs?.alias ?? dst.name
}

export function buildWorkspaceManifest(
  graph: Graph,
  workspaceNode: Node | undefined,
  sidecarManifest: BunTextWorkspaceManifest | undefined,
  emitDiagnostic: (d: Diagnostic) => void = () => undefined,
  peerDeclarations?: Map<string, string>,
  unknownKeys?: UnknownTopLevelState,
): BunTextWorkspaceManifest {
  // Workspace manifest emitted to the `workspaces` block. Pulls structural data
  // from the graph (edges out of the workspace node) and falls back to sidecar
  // for the name / version pin.
  const out: BunTextWorkspaceManifest = {}
  if (workspaceNode !== undefined) {
    captureGraphWorkspaceManifest(out, graph, workspaceNode, emitDiagnostic, sidecarManifest, peerDeclarations)
  } else if (sidecarManifest !== undefined) {
    captureSidecarWorkspaceManifest(out, sidecarManifest)
  }

  // Merge the verbatim carrier behind the modelled output, exactly as the
  // project top level does: modelled fields win, and the source key schedule
  // restores each unmodelled key to the position the producer wrote it in.
  return mergeUnknownTopLevel(
    out as Readonly<Record<string, unknown>>,
    unknownKeys,
  ) as BunTextWorkspaceManifest
}

// bun omits `name` / `version` from a `workspaces` entry when the project's
// package.json carries none. Parse fills the canonical defaults (`''` and
// `'0.0.0'`) so the node has an identity, which means re-emitting them would
// ADD two lines the producer never wrote. Omit only when the parse-time
// manifest also omitted the key AND the node still holds exactly the default
// a reparse re-derives — so omission can never lose identity. With no
// parse-time manifest (cross-format projection) nothing is known to have been
// omitted, and both keys are emitted as before.
function omitsSynthesizedName(
  sidecarManifest: BunTextWorkspaceManifest | undefined,
  node: Node,
): boolean {
  return sidecarManifest !== undefined && sidecarManifest.name === undefined && node.name === ''
}

function omitsSynthesizedVersion(
  sidecarManifest: BunTextWorkspaceManifest | undefined,
  node: Node,
): boolean {
  return sidecarManifest !== undefined && sidecarManifest.version === undefined && node.version === '0.0.0'
}

function captureGraphWorkspaceManifest(
  out: BunTextWorkspaceManifest,
  graph: Graph,
  workspaceNode: Node,
  emitDiagnostic: (d: Diagnostic) => void,
  sidecarManifest: BunTextWorkspaceManifest | undefined,
  peerDeclarations: Map<string, string> | undefined,
): void {
  if (!omitsSynthesizedName(sidecarManifest, workspaceNode)) {
    out.name = workspaceNode.name
  }
  if (workspaceNode.workspacePath !== '' && !omitsSynthesizedVersion(sidecarManifest, workspaceNode)) {
    out.version = workspaceNode.version
  }
  // Walk dep / dev / optional / peer edges and emit ranges.
  const dependencies: Record<string, string> = {}
  const devDependencies: Record<string, string> = {}
  const optionalDependencies: Record<string, string> = {}
  const peerDependencies: Record<string, string> = {}
  for (const edge of graph.out(workspaceNode.id)) {
    const dst = graph.getNode(edge.dst)
    if (dst === undefined) continue
    const range = edge.attrs?.range
    if (typeof range !== 'string') continue
    const target = edge.kind === 'dep' ? dependencies
      : edge.kind === 'dev' ? devDependencies
        : edge.kind === 'optional' ? optionalDependencies
          : edge.kind === 'peer' ? peerDependencies
            : undefined
    if (target === undefined) continue
    // bun-text canonical specifier is `workspace:*`
    // (member-ref form has no version range). Cross-format sources that
    // carry richer `^|~|<exact>` specifiers surface a collapse diagnostic;
    // the verbatim range is preserved in the manifest dep block (bun
    // tolerates richer protocol shapes on disk — the diagnostic is
    // observability, not destructive).
    if (isWorkspaceEdge(edge)) {
      const ws = workspaceRangeOfEdge(edge, dst)
      if (ws !== undefined && bunTextWouldCollapse(ws.specifier)) {
        emitWorkspaceCollapsed(
          { src: edge.src, dst: edge.dst, kind: edge.kind },
          ws.specifier,
          emitDiagnostic,
        )
      }
    }
    target[declaredNameOf(edge, dst)] = range
  }
  Object.assign(
    dependencies,
    mergeUnresolvedDependencyDeclarations(
      graph,
      workspaceNode.id,
      'dep',
      dependencies,
      item => item.descriptor,
      'workspace',
    ),
  )
  Object.assign(
    devDependencies,
    mergeUnresolvedDependencyDeclarations(
      graph,
      workspaceNode.id,
      'dev',
      devDependencies,
      item => item.descriptor,
      'workspace',
    ),
  )
  Object.assign(
    optionalDependencies,
    mergeUnresolvedDependencyDeclarations(
      graph,
      workspaceNode.id,
      'optional',
      optionalDependencies,
      item => item.descriptor,
      'workspace',
    ),
  )
  // Recover declarative `peerDependencies` stashed on the parse-time sidecar —
  // the same recovery `buildInnerBlock` performs for a package's inner block.
  // bun encodes peer-deps as DATA, not graph edges, so parse routes a workspace
  // manifest's peer block into `peerDeclarations` and leaves no edge behind for
  // the walk above to find. A graph peer edge (cross-format source) still wins;
  // the sidecar only fills what the graph cannot carry.
  for (const [key, range] of peerDeclarations ?? []) {
    const sep = key.indexOf('|')
    if (sep < 0 || key.slice(0, sep) !== workspaceNode.id) continue
    const peerName = key.slice(sep + 1)
    if (peerDependencies[peerName] === undefined) peerDependencies[peerName] = range
  }

  if (Object.keys(dependencies).length > 0) out.dependencies = sortRecord(dependencies)
  if (Object.keys(devDependencies).length > 0) out.devDependencies = sortRecord(devDependencies)
  if (Object.keys(optionalDependencies).length > 0) out.optionalDependencies = sortRecord(optionalDependencies)
  if (Object.keys(peerDependencies).length > 0) out.peerDependencies = sortRecord(peerDependencies)
}

function captureSidecarWorkspaceManifest(
  out: BunTextWorkspaceManifest,
  sidecarManifest: BunTextWorkspaceManifest,
): void {
  if (sidecarManifest.name !== undefined) out.name = sidecarManifest.name
  if (sidecarManifest.version !== undefined) out.version = sidecarManifest.version
  if (sidecarManifest.dependencies !== undefined) out.dependencies = sortRecord(sidecarManifest.dependencies)
  if (sidecarManifest.devDependencies !== undefined) out.devDependencies = sortRecord(sidecarManifest.devDependencies)
  if (sidecarManifest.optionalDependencies !== undefined) out.optionalDependencies = sortRecord(sidecarManifest.optionalDependencies)
  if (sidecarManifest.peerDependencies !== undefined) out.peerDependencies = sortRecord(sidecarManifest.peerDependencies)
}

export function buildInnerBlock(graph: Graph, node: Node, sidecar: BunTextSidecar | undefined): BunTextInner {
  const dependencies: Record<string, string> = {}
  const optionalDependencies: Record<string, string> = {}
  const peerDependencies: Record<string, string> = {}
  for (const edge of graph.out(node.id)) {
    const dst = graph.getNode(edge.dst)
    if (dst === undefined) continue
    const range = edge.attrs?.range
    if (typeof range !== 'string') continue
    const target = edge.kind === 'dep' || edge.kind === 'dev' ? dependencies
      : edge.kind === 'optional' ? optionalDependencies
        : edge.kind === 'peer' ? peerDependencies
          : undefined
    if (target !== undefined) target[declaredNameOf(edge, dst)] = range
  }
  Object.assign(
    dependencies,
    mergeUnresolvedDependencyDeclarations(
      graph,
      node.id,
      'dep',
      dependencies,
      item => item.descriptor,
      'package',
    ),
  )
  Object.assign(
    optionalDependencies,
    mergeUnresolvedDependencyDeclarations(
      graph,
      node.id,
      'optional',
      optionalDependencies,
      item => item.descriptor,
      'package',
    ),
  )
  // Recover declarative `peerDependencies` stashed on the parse-time sidecar
  // (bun encodes peers as data, not graph edges).
  for (const [key, range] of sidecar?.peerDeclarations ?? []) {
    const sep = key.indexOf('|')
    if (sep < 0 || key.slice(0, sep) !== node.id) continue
    const peerName = key.slice(sep + 1)
    if (peerDependencies[peerName] === undefined) peerDependencies[peerName] = range
  }

  const inner: BunTextInner = {}
  if (Object.keys(dependencies).length > 0) inner.dependencies = sortRecord(dependencies)
  if (Object.keys(optionalDependencies).length > 0) inner.optionalDependencies = sortRecord(optionalDependencies)
  if (Object.keys(peerDependencies).length > 0) inner.peerDependencies = sortRecord(peerDependencies)

  // Recover `bin` field from parse-time inner-block stash.
  const stashedBin = sidecar?.nodes.get(node.id)?.inner?.bin
  if (stashedBin !== undefined) inner.bin = stashedBin

  return inner
}

// JSONC emitter with trailing commas on every `}` and `]` (one space leading,
// matching bun's exact emit style; verified against the 7 fixtures).
//
// Pretty-print algorithm: standard 2-space indent for objects; arrays
// always emit inline (tuple slot mode) because bun-text's tuple-form
// packages entries are single-line.
function renderJsonc(value: unknown): string {
  return renderValue(value, 0, true) + '\n'
}

function renderArray(arr: unknown[]): string {
  // Arrays in bun-text are always positional tuples (1-elem for workspace refs,
  // 4-elem for regular packages) — both short and single-line.
  return `[${arr.map(renderInlineValue).join(', ')}]`
}

// An array that is the value of a MULTI-LINE object (top-level
// `trustedDependencies`, a workspace entry's `optionalPeers`) is written one
// element per line with a trailing comma — the same always-trailing-comma style
// the surrounding object uses. This is NOT the positional `packages` tuple,
// which stays inline via `renderArray`, and not an array nested in an INLINE
// object (a package's `os` / `cpu`), which bun pads on one line.
function renderBlockArray(arr: unknown[], depth: number): string {
  if (arr.length === 0) return '[]'
  const indent = INDENT.repeat(depth + 1)
  const closeIndent = INDENT.repeat(depth)
  return `[\n${arr.map(v => `${indent}${renderInlineValue(v)},`).join('\n')}\n${closeIndent}]`
}

function renderInlineObject(obj: Record<string, unknown>): string {
  const keys = Object.keys(obj)
  if (keys.length === 0) return '{}'
  const parts = keys.map(k => `${JSON.stringify(k)}: ${renderInlineValue(obj[k])}`)
  return `{ ${parts.join(', ')} }`
}

// The `packages` block is rendered unlike every other object, in two ways that
// travel together: bun separates its entries with a blank line, and its values
// are POSITIONAL TUPLES written inline rather than element-per-line lists.
//
// The blank line is unconditional, NOT a `configVersion` era: across the
// real-world corpus every lock with two or more `packages` entries separates
// all of them (the sole exception is a hand-authored turborepo test fixture,
// identifiable by its 3-slot multi-line tuples and absent trailing commas),
// and the committed `lockfiles/*/bun-text.lock` — an older,
// `configVersion`-less bun generation — separates them too. `workspaces` is
// never separated, and its array values are lists, not tuples.
const PACKAGES_BLOCK = 'packages'

function renderObject(
  obj: Record<string, unknown>,
  depth: number,
  isTopLevel: boolean,
  isPackagesBlock = false,
): string {
  const keys = Object.keys(obj)
  if (keys.length === 0) return '{}'
  const indent = INDENT.repeat(depth + 1)
  const closeIndent = INDENT.repeat(depth)
  const entries: string[] = []
  // Walk keys. Each entry indented to depth+1. Trailing commas after every
  // value (bun-text always-trailing-comma style); the outer-most object emits
  // no trailing comma on its last entry to match the fixture shape.
  for (const key of keys) {
    const val = obj[key]
    const rendered = Array.isArray(val)
      ? (isPackagesBlock ? renderArray(val) : renderBlockArray(val, depth + 1))
      : (val !== null && typeof val === 'object'
        ? renderObject(
          val as Record<string, unknown>,
          depth + 1,
          false,
          isTopLevel && key === PACKAGES_BLOCK,
        )
        : renderInlineValue(val))
    entries.push(`${indent}${JSON.stringify(key)}: ${rendered},`)
  }
  if (isTopLevel) {
    entries[entries.length - 1] = entries[entries.length - 1]!.replace(/,$/, '')
  }
  // One blank line BETWEEN entries only — never leading, trailing, or doubled,
  // so a single-entry block stays dense.
  return `{\n${entries.join(isPackagesBlock ? '\n\n' : '\n')}\n${closeIndent}}`
}

// === Serialize helpers ======================================================

function chooseNodeEmitKey(
  graph: Graph,
  node: Node,
  sidecar: BunTextSidecar | undefined,
  alreadyEmitted: Record<string, unknown>,
): string {
  // Preserve the parse-time packagesKey (which may carry the de-hoisting
  // `<consumer-path>/<name>` form) when available and not yet taken.
  const stored = sidecar?.nodes.get(node.id)?.packagesKey
  if (stored !== undefined && alreadyEmitted[stored] === undefined) {
    return stored
  }
  // A `packages` key is the name bun hoists the package to, so an npm-aliased
  // dependency is keyed by its alias — the same slot its dependency-map entry
  // uses. Without a parse-time key (cross-format projection, mutator-minted
  // node) the alias has to come off the edges, else the emitted `workspaces`
  // key and `packages` key disagree and bun cannot resolve the dependency.
  const aliasKey = unanimousAliasOf(graph, node)
  if (aliasKey !== undefined && alreadyEmitted[aliasKey] === undefined) return aliasKey
  // Fallback: bare name. If the bare key is already taken (different version
  // of the same name), append `@<version>` as a disambiguator. The disambiguated
  // form is admittedly non-canonical, but bun's de-hoisting layer outside this
  // adapter's reach — mutator-added duplicates fall back here.
  if (alreadyEmitted[node.name] === undefined) return node.name
  return `${node.name}@${node.version}`
}

// The alias every incoming dependency declaration agrees on, or undefined.
// bun writes one `packages` entry per hoist directory, so a node reached both
// under its own name and under an alias gets two entries there; this emitter
// writes one entry per node and therefore only adopts an alias key when no
// consumer refers to the node by its canonical name.
function unanimousAliasOf(graph: Graph, node: Node): string | undefined {
  let alias: string | undefined
  for (const edge of graph.in(node.id)) {
    const slot = edge.attrs?.alias
    if (slot === undefined) return undefined
    if (alias !== undefined && slot !== alias) return undefined
    alias = slot
  }
  return alias
}

function reportPatchDrop(
  node: Node,
  warned: Set<string>,
  emitDiagnostic: (diagnostic: Diagnostic) => void,
): void {
  if (node.patch === undefined || warned.has(node.id)) return
  warned.add(node.id)
  patchEmitDropped(
    node.id,
    'patch',
    `bun-text cannot encode patches; ${JSON.stringify(node.patch)} dropped`,
    emitDiagnostic,
  )
}

// stringify table — bun-text encodes only registry tarballs
// (URL derived by convention from name@version) and workspace members
// (via the `workspaces` block). git / directory / unknown F3 cases have
// no representation in bun-text and are dropped with RECIPE_FEATURE_DROPPED.
// Nodes that ALSO drop patch (F2) skip the F3 drop — the patch diagnostic
// already represents the loss (the F3 unknown shape is the patch locator).
function reportResolutionDrop(
  graph: Graph,
  node: Node,
  warned: Set<string>,
  emitDiagnostic: (diagnostic: Diagnostic) => void,
): void {
  if (warned.has(node.id)) return
  const canonical = graph.tarballOf(node.id)?.resolution
  if (canonical === undefined) return
  if (canonical.type === 'tarball') return
  if (canonical.type === 'unknown' && node.patch !== undefined) return
  warned.add(node.id)
  recipeEmitDropped(
    node.id,
    canonical.type,
    `bun-text cannot encode ${canonical.type} resolution for ${node.id}`,
    emitDiagnostic,
  )
}

function reportPeerVirt(
  node: Node,
  warned: Set<string>,
  emitDiagnostic: (diagnostic: Diagnostic) => void,
): void {
  if (node.peerContext.length === 0 || warned.has(node.id)) return
  warned.add(node.id)
  emitDiagnostic({
    code: 'BUN_TEXT_PEER_VIRT_FLATTENED',
    severity: 'warning',
    subject: node.id,
    message: `peerContext ${JSON.stringify(node.peerContext)} is flattened on emit in bun-text (declarative peer-deps only)`,
  })
}

// === OPTIMIZE ===============================================================

function pruneSidecar(sidecar: BunTextSidecar, graph: Graph): BunTextSidecar {
  const reachableIds = new Set(Array.from(graph.nodes(), node => node.id))
  const nodes = new Map<string, BunTextNodeSidecar>()
  for (const [nodeId, sc] of sidecar.nodes) {
    if (reachableIds.has(nodeId)) nodes.set(nodeId, sc)
  }
  const workspaceByPath = new Map<string, string>()
  for (const [path, nodeId] of sidecar.workspaceByPath) {
    if (reachableIds.has(nodeId)) workspaceByPath.set(path, nodeId)
  }
  return {
    configVersion: sidecar.configVersion,
    nativePackages: sidecar.nativePackages,
    exactPackageReplay: false,
    rootId: sidecar.rootId !== undefined && reachableIds.has(sidecar.rootId) ? sidecar.rootId : undefined,
    rootManifest: sidecar.rootManifest,
    workspaces: new Map(sidecar.workspaces),
    workspaceByPath,
    nodes,
    peerDeclarations: new Map(
      Array.from(sidecar.peerDeclarations).filter(([key]) => {
        const [srcId] = key.split('|')
        return srcId !== undefined && reachableIds.has(srcId)
      }),
    ),
    // Top-level fidelity blocks are project-global (not per-node), so they
    // survive an orphan-prune verbatim — pruning unreachable nodes never
    // invalidates a declared override / trusted / patched entry.
    nativeOverrides: sidecar.nativeOverrides,
    canonicalOverrides: sidecar.canonicalOverrides,
    trustedDependencies: sidecar.trustedDependencies,
    patchedDependencies: sidecar.patchedDependencies,
    unknownTopLevel: sidecar.unknownTopLevel,
  }
}
