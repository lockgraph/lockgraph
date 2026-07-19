// pnpm-v5 adapter — pnpm `pnpm-lock.yaml` lockfileVersion 5.4.
//
// Standalone-fit per ADR-0022 §5: v5 (decimal `5.4`
// handshake, `specifiers` + bare-version `dependencies`,
// `/<name>/<version>` slash-separator packages keys, underscore peer-
// context syntax) is fundamentally different from the flat-core v6/v9
// shared shape (quoted `'6.0'`/`'9.0'`, `{specifier, version}`
// importer values, `@`-separator packages keys, parens peer-context).
// Forcing a unified pipeline rots both sides; this module owns its
// own parse / stringify / enrich / optimize pipeline.
//
// Dependency direction (parallel to npm-1 / yarn-classic standalone
// precedents): this module imports YAML primitives from
// `_pnpm-yaml.ts`, graph types from `../graph.ts`, AND family-internal
// pnpm helpers from `_pnpm-flat-core.ts` (peer-candidate derivation,
// sidecar pruning, workspace path math, micro-utils). It does NOT
// call `parseFamily` / `stringifyFamily` — those are v6/v9-shape
// specific. `_pnpm-yaml.ts` and `_pnpm-flat-core.ts` do NOT import
// this module — dependency is one-way (v5 → family infra).
//
// §A pinning per ADR-0022 §A.pnpm-v5:
//   - top-level `lockfileVersion: 5.<digit>` decimal scalar
//     (NOT quoted). Parse rejects v6/v9 (quoted) and other PM
//     families via `FORMAT_MISMATCH`. Emit canonicalises to `5.4`.
//   - NO `settings` block (v5 predates the pnpm settings table).
//     Graphs carrying settings via cross-version composition trigger
//     a `PNPM_V5_SETTINGS_DROPPED` warning on emit.
//   - top-level `overrides:` block (pnpm 6–7) — captured verbatim + re-emitted
//     after `lockfileVersion`. pnpm frozen-compares it against config
//     (`getOutdatedLockfileSetting` deep-equality), so an override-using project
//     needs the block to stay `--frozen-lockfile`-clean. `patch:` entries
//     round-trip verbatim but are not compiled (v5 has no patch slot per §B).
//   - top-level layout — `specifiers` + `dependencies` blocks
//     (single-importer collapsed-root) OR `importers` block
//     (multi-importer workspaces). Mutually exclusive on emit;
//     `PNPM_V5_DUAL_TOP_LEVEL_DRIFT` warning on parse if both present.
//   - `dependencies.<name>` shape — bare version string, optionally
//     peer-context-suffixed: `<name>: <version>_<peer>@<peer-version>`.
//   - `packages` block — slash-separator keys `/<name>/<version>`
//     (vs v6/v9's `<name>@<version>`). Peer-context renders as
//     underscore suffix `/<name>/<version>_<peer>@<peer-version>`;
//     multi-peer concatenated alphabetically. Parse uses the
//     right-to-left peel grammar per ADR-0022 §A.pnpm-v5.
//   - Inline transitives via `dependencies:` block in packages
//     entries (same shape as v6).
//   - `dev: false|true` per-entry flag (same as v6).
//   - NO `snapshots` block (v9-only).
//
// §B Lossy-but-acceptable (pnpm-v5 specific):
//   - `RECIPE_FEATURE_DROPPED` (feature='patch') — patch slot drops on
//     emit because v5 has no on-disk `patch:` protocol slot, per
//     ADR-0014 §5 canonical loss code.
//   - `PNPM_V5_SETTINGS_DROPPED` — sidecar `settings` block dropped
//     when present (v5 schema has no settings).
//   - `PNPM_V5_DUAL_TOP_LEVEL_DRIFT` — both `specifiers`/`dependencies`
//     AND `importers` present on parse (hand-edit drift); `importers`
//     wins.
//
// §C enrich:
//   - peer-virt FIRST-CLASS per ADR-0006 — parse reads peer-context
//     from the underscore-suffixed packages key (dominant path).
//   - peer-virt three-branch derivation (1 / ≥2 / 0 candidates) as
//     fallback when on-disk peer-context is incomplete.
//   - workspace concretisation from `importers` + manifest input.
//
// §D optimize: prune unreachable from `graph.roots()` BFS — verbatim
// ADR-0016 §D.

import {
  GraphError,
  newBuilder,
  serializeNodeId,
  stripPeerContextFromNodeId,
  type Diagnostic,
  type Edge,
  type EdgeKind,
  type Graph,
  type Node,
  type OverrideConstraint,
} from '../graph.ts'
import { emitSriForRegistry } from '../recipe/integrity.ts'
import { captureOverrides, projectOverrides } from '../recipe/overrides.ts'
import { governingOverrideFor } from '../recipe/descriptor-resolve.ts'
import { LockfileError } from '../api/errors.ts'
import { nodeVersionOf } from './_node-id.ts'
import { optimizeUnreachable } from './_optimize.ts'
import { emitDropped as patchEmitDropped } from '../recipe/diagnostics.ts'
import {
  DEFAULT_NPM_REGISTRY,
  stringifyForPnpm,
  stripRegistrySha1Fragment,
  type ResolutionCanonical,
} from '../recipe/resolution.ts'
import { readYaml, emitYaml, flowMap, type YamlMap } from './_pnpm-yaml.ts'
import {
  cmpStr,
  derivePeerCandidates,
  isPlainObject,
  locatePnpmRootNode,
  normalizeLineEndings,
  prunePnpmSidecar,
  relativeImporterPath,
  resolveLinkPath,
  resolvePeerTargetById,
  sortRecord,
  tarballPayloadOf,
} from './_pnpm-flat-core.ts'

// === CONSTANTS ==============================================================

const V5_LOCKFILE_VERSION_CANONICAL = 5.4
// Accepted on-disk literals (parsed back as bare strings by `_pnpm-yaml.ts`'s
// reader, which never coerces scalars to numbers). The 5.0 → 5.4 minor-bump
// range is collapsed to canonical `5.4` on emit per ADR-0022 §A.pnpm-v5.
const V5_LOCKFILE_VERSION_ACCEPTED = new Set(['5.0', '5.1', '5.2', '5.3', '5.4'])

const TOP_LEVEL_ORDER: readonly string[] = [
  'lockfileVersion',
  'overrides',
  'specifiers',
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'importers',
  'packages',
]

const TOP_LEVEL_SECTION_KEYS: readonly string[] = ['importers', 'packages']

// Per ADR-0022 §A.pnpm-v5: right-to-left peel grammar.
// Anchored at end-of-string; peer-name captures optional leading `@`
// for scoped peers, optional `/sub` segment for scoped names, then
// `@<version>` up to the next `_` boundary.
const PEER_TAIL_RE = /_(@?[^_@]+(?:\/[^_@]+)?)@([^_]+)$/

// === TYPES =================================================================

export interface PnpmV5ParseOptions {}

export interface PnpmV5StringifyOptions {
  lineEnding?: 'lf' | 'crlf'
  onDiagnostic?: (diagnostic: Diagnostic) => void
  /** Caller-declared overrides (ADR-0025 §4) overlaid onto the captured
   *  lock-borne `overrides:` block (caller wins per key). pnpm 6–7 read this
   *  top-level block and frozen-compare it against config. */
  overrides?: OverrideConstraint[]
}

export interface PnpmV5StringifyInternalOptions {
  readonly workspaceNames?: ReadonlyMap<string, string>
}

export interface PnpmV5Manifest {
  name?: string
  version?: string
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}

export interface PnpmV5EnrichOptions {
  manifests?: Record<string, PnpmV5Manifest>
}

export interface PnpmV5OptimizeOptions {}

// v5 has NO settings block in its own schema — this interface only exists for
// cross-version sidecar shape parity (e.g. a graph parsed via v6 then emitted
// via v5 carries the v6 settings on the sidecar; we surface them on
// `PNPM_V5_SETTINGS_DROPPED` then discard).
export interface PnpmV5SettingsCrossVersion {
  autoInstallPeers?: boolean
  excludeLinksFromLockfile?: boolean
}

// === SIDECAR ================================================================

interface PnpmV5NodeSidecar {
  peerDependencies?: Record<string, string>
  engines?: Record<string, string>
  hasBin?: boolean
  os?: string[]
  cpu?: string[]
  dev?: boolean
  optional?: boolean
}

interface PnpmV5EdgeSidecar {
  /** Resolved on-disk version field (preserves peer-context underscore tail). */
  resolvedVersion?: string
  /** Importer-declared specifier (the `specifiers` block value). */
  specifier?: string
}

interface PnpmV5Sidecar {
  rootId: string
  importerPaths: string[]
  importerByPath: Map<string, string>
  /** Importer specifiers, keyed by importer path. */
  importerSpecifiers: Map<string, Record<string, string>>
  nodes: Map<string, PnpmV5NodeSidecar>
  importerEdges: Map<string, PnpmV5EdgeSidecar>
  /** Cross-version settings stash (for PNPM_V5_SETTINGS_DROPPED). */
  inboundSettings?: PnpmV5SettingsCrossVersion
  /** Top-level `overrides:` block, verbatim (pnpm 6–7 carry + frozen-compare it). */
  overrides?: Record<string, string>
}

const sidecarByGraph = new WeakMap<Graph, PnpmV5Sidecar>()

export function hasAdapterState(graph: Graph): boolean {
  return sidecarByGraph.has(graph)
}

function rememberSidecar(graph: Graph, sidecar: PnpmV5Sidecar): void {
  sidecarByGraph.set(graph, sidecar)
}

export function rebindAdapterState(
  source: Graph,
  target: Graph,
): Readonly<{ graph: Graph; invalidated: readonly string[] }> {
  const sidecar = sidecarByGraph.get(source)
  if (sidecar === undefined) return { graph: target, invalidated: [] }
  const pruned = prunePnpmSidecar(sidecar, target)
  rememberSidecar(target, pruned)
  const invalidated = [
    ...[...sidecar.nodes.keys()].filter(id => !pruned.nodes.has(id)),
    ...[...sidecar.importerEdges.keys()].filter(key => !pruned.importerEdges.has(key)),
  ].sort()
  return { graph: target, invalidated }
}

/**
 * Lock-borne pnpm-v5 overrides as canonical `OverrideConstraint[]`, for
 * `overridesOf`. Reads the verbatim `sidecar.overrides` block; `patch:` entries
 * are skipped (v5 has no patch slot). Returns undefined when the graph carries
 * no pnpm-v5 overrides block.
 */
export function getPnpmV5OverridesCanonical(graph: Graph): OverrideConstraint[] | undefined {
  const sidecar = sidecarByGraph.get(graph)
  if (sidecar?.overrides === undefined) return undefined
  const versionOnly: Record<string, string> = {}
  for (const [key, value] of Object.entries(sidecar.overrides)) {
    if (!value.startsWith('patch:')) versionOnly[key] = value
  }
  return captureOverrides(versionOnly, 'pnpm').canonical
}

// === PARSE =================================================================

export function check(input: string): boolean {
  // Probe top-level `lockfileVersion: 5.<digit>` as a decimal scalar.
  // Reject quoted strings (v6/v9 use `'6.0'`/`'9.0'`).
  return /^\s*lockfileVersion\s*:\s*5\.\d+\s*(?:#.*)?$/m.test(input)
}

export function parse(input: string, _options: PnpmV5ParseOptions = {}): Graph {
  const normalized = normalizeLineEndings(input)
  const yaml = readYaml(normalized)
  assertPnpmV5Version(normalized, yaml)
  const context = createPnpmV5ParseContext(yaml)
  addPnpmV5PackageNodes(context)
  const importers = collectPnpmV5Importers(context)
  addPnpmV5ImporterNodes(context, importers)
  addPnpmV5ImporterEdges(context, importers)
  addPnpmV5ResolvedTreeEdges(context)
  return sealPnpmV5Parse(context)
}

interface PnpmV5ParseContext {
  yaml: YamlMap
  builder: ReturnType<typeof newBuilder>
  diagnostics: Diagnostic[]
  sidecar: PnpmV5Sidecar
  packagesMap: Record<string, unknown>
  seenIds: Set<string>
  idByPackagesKey: Map<string, string>
}

interface PnpmV5ImporterLayout {
  effective: Record<string, unknown>
  paths: string[]
  rootPath: string
}

interface PnpmV5ImporterEdgeContext {
  parse: PnpmV5ParseContext
  importerPath: string
  srcId: string
  specMap: Record<string, unknown> | undefined
}

function assertPnpmV5Version(normalized: string, yaml: YamlMap): void {
  if (!/^\s*lockfileVersion\s*:\s*5\.\d+\s*(?:#.*)?$/m.test(normalized)) {
    throw new LockfileError({
      code: 'FORMAT_MISMATCH',
      message: `pnpm-v5 adapter: lockfileVersion must be an unquoted decimal scalar (5.0…5.4); got ${JSON.stringify(yaml.lockfileVersion)}`,
    })
  }
  const versionStr = String(yaml.lockfileVersion)
  if (!V5_LOCKFILE_VERSION_ACCEPTED.has(versionStr)) {
    throw new LockfileError({
      code: 'FORMAT_MISMATCH',
      message: `pnpm-v5 adapter: expected lockfileVersion in {5.0…5.4}, got ${JSON.stringify(yaml.lockfileVersion)}`,
    })
  }
}

function createPnpmV5ParseContext(yaml: YamlMap): PnpmV5ParseContext {
  const sidecar: PnpmV5Sidecar = {
    rootId: '', importerPaths: [], importerByPath: new Map(),
    importerSpecifiers: new Map(), nodes: new Map(), importerEdges: new Map(),
  }
  if (yaml.overrides !== undefined && typeof yaml.overrides === 'object') {
    sidecar.overrides = { ...(yaml.overrides as Record<string, string>) }
  }
  return {
    yaml,
    builder: newBuilder(),
    diagnostics: [],
    sidecar,
    packagesMap: isPlainObject(yaml.packages) ? yaml.packages : {},
    seenIds: new Set(),
    idByPackagesKey: new Map(),
  }
}

// Pass 1: package keys carry the v5 underscore peer context.
function addPnpmV5PackageNodes(context: PnpmV5ParseContext): void {
  for (const pkgKey of Object.keys(context.packagesMap)) {
    const parsed = parsePackagesKey(pkgKey)
    if (parsed === undefined) {
      context.diagnostics.push({
        code: 'PNPM_BAD_ENTRY',
        severity: 'warning',
        message: `pnpm-v5 packages key ${JSON.stringify(pkgKey)} not parseable`,
      })
      continue
    }
    const { name, version: ver, peers } = parsed
    const peerContext = peers.map(p => `${p.name}@${p.version}`).sort(cmpStr)
    const nodeId = serializeNodeId(name, ver, peerContext)
    if (context.seenIds.has(nodeId)) continue
    context.seenIds.add(nodeId)
    context.idByPackagesKey.set(pkgKey, nodeId)
    addPackageNode(
      context.builder, context.sidecar, name, ver, peerContext, nodeId,
      context.packagesMap[pkgKey], context.diagnostics,
    )
  }
}

// Pass 2 layout: `importers` wins over a hand-edited collapsed-root duplicate.
function collectPnpmV5Importers(context: PnpmV5ParseContext): PnpmV5ImporterLayout {
  const { yaml } = context
  const importersMap = isPlainObject(yaml.importers) ? yaml.importers : undefined
  const hasTopLevelDeps = hasPnpmV5TopLevelDependencies(yaml)
  if (importersMap !== undefined && hasTopLevelDeps) {
    context.diagnostics.push({
      code: 'PNPM_V5_DUAL_TOP_LEVEL_DRIFT',
      severity: 'warning',
      message: 'pnpm-v5: input carries both top-level `specifiers`/`dependencies` and `importers`; `importers` wins',
    })
  }
  const effective: Record<string, unknown> = {}
  if (importersMap !== undefined) {
    for (const key of Object.keys(importersMap)) effective[key] = importersMap[key]
  } else if (hasTopLevelDeps) {
    effective['.'] = buildCollapsedRootImporter(yaml)
  }
  if (Object.keys(effective).length === 0) effective['.'] = {}
  const paths = Object.keys(effective).sort(cmpStr)
  return { effective, paths, rootPath: paths.includes('.') ? '.' : (paths[0] ?? '.') }
}

function hasPnpmV5TopLevelDependencies(yaml: YamlMap): boolean {
  return yaml.specifiers !== undefined
    || yaml.dependencies !== undefined
    || yaml.devDependencies !== undefined
    || yaml.optionalDependencies !== undefined
}

function addPnpmV5ImporterNodes(context: PnpmV5ParseContext, layout: PnpmV5ImporterLayout): void {
  const rootId = '.@0.0.0'
  context.builder.addNode({ id: rootId, name: '.', version: '0.0.0', peerContext: [], workspacePath: '' })
  context.sidecar.rootId = rootId
  context.sidecar.importerByPath.set(layout.rootPath, rootId)
  for (const importerPath of layout.paths) {
    if (importerPath === layout.rootPath) continue
    const memberName = importerPath
    const memberId = `${memberName}@0.0.0`
    context.sidecar.importerByPath.set(importerPath, memberId)
    context.builder.addNode({ id: memberId, name: memberName, version: '0.0.0', peerContext: [], workspacePath: importerPath })
  }
  context.sidecar.importerPaths = layout.paths.slice()
}

// Pass 3: importer specifiers and resolved dependency edges.
function addPnpmV5ImporterEdges(context: PnpmV5ParseContext, layout: PnpmV5ImporterLayout): void {
  for (const importerPath of layout.paths) {
    const srcId = context.sidecar.importerByPath.get(importerPath)
    if (srcId === undefined) continue
    const importerEntry = layout.effective[importerPath]
    if (!isPlainObject(importerEntry)) continue
    const specMap = isPlainObject(importerEntry.specifiers) ? importerEntry.specifiers : undefined
    capturePnpmV5ImporterSpecifiers(context, importerPath, specMap)
    const edgeContext: PnpmV5ImporterEdgeContext = { parse: context, importerPath, srcId, specMap }
    for (const [kind, blockName] of [
      ['dep', 'dependencies'],
      ['dev', 'devDependencies'],
      ['optional', 'optionalDependencies'],
    ] as const) {
      addPnpmV5ImporterBlockEdges(edgeContext, importerEntry[blockName], kind)
    }
  }
}

function capturePnpmV5ImporterSpecifiers(
  context: PnpmV5ParseContext,
  importerPath: string,
  specMap: Record<string, unknown> | undefined,
): void {
  if (specMap === undefined) return
  const localSpecs: Record<string, string> = {}
  for (const [key, value] of Object.entries(specMap)) {
    if (typeof value === 'string') localSpecs[key] = value
  }
  if (Object.keys(localSpecs).length > 0) context.sidecar.importerSpecifiers.set(importerPath, localSpecs)
}

function addPnpmV5ImporterBlockEdges(
  context: PnpmV5ImporterEdgeContext,
  block: unknown,
  kind: 'dep' | 'dev' | 'optional',
): void {
  if (!isPlainObject(block)) return
  for (const [depName, depValue] of Object.entries(block).sort((a, b) => cmpStr(a[0], b[0]))) {
    if (typeof depValue !== 'string') continue
    const rawSpecifier = context.specMap?.[depName]
    const specifier = typeof rawSpecifier === 'string' ? rawSpecifier : undefined
    addPnpmV5ImporterDependency(context, kind, depName, depValue, specifier)
  }
}

function addPnpmV5ImporterDependency(
  context: PnpmV5ImporterEdgeContext,
  kind: 'dep' | 'dev' | 'optional',
  depName: string,
  depValue: string,
  specifier: string | undefined,
): void {
  if (depValue.startsWith('link:')) {
    addPnpmV5WorkspaceDependency(context, kind, depName, depValue, specifier)
  } else {
    addPnpmV5ResolvedDependency(context, kind, depName, depValue, specifier)
  }
}

function addPnpmV5WorkspaceDependency(
  context: PnpmV5ImporterEdgeContext,
  kind: 'dep' | 'dev' | 'optional',
  depName: string,
  depValue: string,
  specifier: string | undefined,
): void {
  const { parse, importerPath, srcId } = context
  const linkPath = resolveLinkPath(importerPath, depValue.slice(5))
  const targetId = parse.sidecar.importerByPath.get(linkPath)
  if (targetId === undefined) {
    parse.diagnostics.push({
      code: 'PNPM_UNRESOLVED_DEP', severity: 'warning', subject: srcId,
      message: `pnpm-v5: importer ${JSON.stringify(importerPath)} dep ${depName} resolves to unknown workspace ${JSON.stringify(linkPath)}`,
    })
    return
  }
  const targetVersion = nodeVersionOf(targetId)
  const workspaceRange = targetVersion !== undefined && targetVersion !== ''
    ? { specifier: specifier ?? '', resolvedVersion: targetVersion }
    : { specifier: specifier ?? '' }
  const added = tryAddPnpmV5Edge(parse.builder, srcId, targetId, kind, {
    range: specifier ?? depValue, workspace: true, workspaceRange,
  })
  if (!added) return
  parse.sidecar.importerEdges.set(`${srcId}\0${kind}\0${targetId}\0`, { resolvedVersion: depValue, specifier })
}

function addPnpmV5ResolvedDependency(
  context: PnpmV5ImporterEdgeContext,
  kind: 'dep' | 'dev' | 'optional',
  depName: string,
  depValue: string,
  specifier: string | undefined,
): void {
  const { parse, importerPath, srcId } = context
  let targetId = resolveDependencyTarget(parse.seenIds, depName, depValue)
  let aliasSlot: string | undefined
  if (targetId === undefined) {
    targetId = resolveAliasedDependencyTarget(parse.seenIds, depValue)
    if (targetId !== undefined) aliasSlot = depName
  }
  if (targetId === undefined) {
    parse.diagnostics.push({
      code: 'PNPM_UNRESOLVED_DEP', severity: 'warning', subject: srcId,
      message: `pnpm-v5: importer ${JSON.stringify(importerPath)} dep ${depName}@${depValue} resolves to no packages entry`,
    })
    return
  }
  const attrs: { range: string; alias?: string } = { range: specifier ?? depValue }
  if (aliasSlot !== undefined) attrs.alias = aliasSlot
  if (!tryAddPnpmV5Edge(parse.builder, srcId, targetId, kind, attrs)) return
  parse.sidecar.importerEdges.set(
    `${srcId}\0${kind}\0${targetId}\0${aliasSlot ?? ''}`,
    { resolvedVersion: depValue, specifier },
  )
}

function tryAddPnpmV5Edge(
  builder: ReturnType<typeof newBuilder>,
  srcId: string,
  targetId: string,
  kind: 'dep' | 'dev' | 'optional',
  attrs: Edge['attrs'],
): boolean {
  try {
    builder.addEdge(srcId, targetId, kind, attrs)
    return true
  } catch (error) {
    if (error instanceof GraphError && error.code === 'INVARIANT_VIOLATION') return false
    throw error
  }
}

// Pass 4: inline package dependency trees.
function addPnpmV5ResolvedTreeEdges(context: PnpmV5ParseContext): void {
  for (const pkgKey of Object.keys(context.packagesMap)) {
    const srcId = context.idByPackagesKey.get(pkgKey)
    if (srcId === undefined) continue
    const parsed = parsePackagesKey(pkgKey)
    if (parsed === undefined) continue
    const pkgEntry = context.packagesMap[pkgKey]
    if (!isPlainObject(pkgEntry)) continue
    addResolvedTreeEdges(
      context.builder, context.diagnostics, srcId, pkgEntry, parsed.peers,
      context.seenIds, context.sidecar,
    )
  }
}

function sealPnpmV5Parse(context: PnpmV5ParseContext): Graph {
  for (const diagnostic of context.diagnostics) context.builder.diagnostic(diagnostic)
  try {
    const graph = context.builder.seal()
    rememberSidecar(graph, context.sidecar)
    return graph
  } catch (error) {
    if (error instanceof GraphError) {
      throw new LockfileError({
        code: 'PARSE_FAILED',
        message: `pnpm-v5 seal failed: ${error.message}`,
      })
    }
    throw error
  }
}

// === SERIALIZE ==============================================================

export function stringify(
  graph: Graph,
  options: PnpmV5StringifyOptions = {},
  internal: PnpmV5StringifyInternalOptions = {},
): string {
  const context = createPnpmV5StringifyContext(graph, options, internal)
  reportPnpmV5UnsupportedFeatures(context)
  const nodes = partitionPnpmV5StringifyNodes(context)
  const out = createPnpmV5Output(context)
  writePnpmV5Overrides(context, out)
  writePnpmV5ImporterLayout(context, nodes.workspace, out)
  writePnpmV5Packages(context, nodes.resolved, out)
  assertResolveValid(graph, out, context.rootNode, nodes.resolved, context.emitDiagnostic)
  const text = emitYaml(out, { topLevelOrder: TOP_LEVEL_ORDER, topLevelSectionKeys: TOP_LEVEL_SECTION_KEYS })
  return options.lineEnding === 'crlf' ? text.replace(/\n/g, '\r\n') : text
}

interface PnpmV5StringifyContext {
  graph: Graph
  options: PnpmV5StringifyOptions
  internal: PnpmV5StringifyInternalOptions
  sidecar: PnpmV5Sidecar | undefined
  rootNode: Node | undefined
  emitDiagnostic: (diagnostic: Diagnostic) => void
}

function createPnpmV5StringifyContext(
  graph: Graph,
  options: PnpmV5StringifyOptions,
  internal: PnpmV5StringifyInternalOptions,
): PnpmV5StringifyContext {
  const sidecar = sidecarByGraph.get(graph)
  return {
    graph, options, internal, sidecar,
    rootNode: locatePnpmRootNode(graph, sidecar),
    emitDiagnostic: diagnostic => options.onDiagnostic?.(diagnostic),
  }
}

function reportPnpmV5UnsupportedFeatures(context: PnpmV5StringifyContext): void {
  const warnedPatches = new Set<string>()
  for (const node of context.graph.nodes()) {
    if (node.patch !== undefined && !warnedPatches.has(node.id)) {
      warnedPatches.add(node.id)
      patchEmitDropped(
        node.id,
        'patch',
        `pnpm-v5 has no patch slot in the working corpus; ${JSON.stringify(node.patch)} dropped`,
        context.emitDiagnostic,
      )
    }
  }
  if (context.sidecar?.inboundSettings !== undefined && Object.keys(context.sidecar.inboundSettings).length > 0) {
    context.emitDiagnostic({
      code: 'PNPM_V5_SETTINGS_DROPPED',
      severity: 'warning',
      message: 'pnpm-v5 has no `settings` block; dropping cross-version settings on emit',
    })
  }
}

function partitionPnpmV5StringifyNodes(
  context: PnpmV5StringifyContext,
): { workspace: Node[]; resolved: Node[] } {
  const workspaceNodes: Node[] = []
  const resolvedNodes: Node[] = []
  for (const node of context.graph.nodes()) {
    if (node.id === context.rootNode?.id) continue
    if (node.workspacePath !== undefined && node.workspacePath !== '') {
      workspaceNodes.push(node)
    } else {
      resolvedNodes.push(node)
    }
  }
  workspaceNodes.sort((a, b) => cmpStr(a.workspacePath ?? '', b.workspacePath ?? ''))
  resolvedNodes.sort((a, b) => cmpStr(packagesKeyForNode(a), packagesKeyForNode(b)))
  return { workspace: workspaceNodes, resolved: resolvedNodes }
}

function createPnpmV5Output(_context: PnpmV5StringifyContext): YamlMap {
  const out: YamlMap = {}
  out.lockfileVersion = V5_LOCKFILE_VERSION_CANONICAL
  return out
}

function writePnpmV5Overrides(context: PnpmV5StringifyContext, out: YamlMap): void {
  let effectiveOverrides: Record<string, string> | undefined = context.sidecar?.overrides
  if (context.options.overrides !== undefined) {
    const projected = context.options.overrides.length > 0
      ? (projectOverrides(context.options.overrides, 'pnpm', context.emitDiagnostic) as Record<string, string>)
      : {}
    effectiveOverrides = { ...(context.sidecar?.overrides ?? {}), ...projected }
  }
  if (effectiveOverrides !== undefined && Object.keys(effectiveOverrides).length > 0) {
    out.overrides = sortRecord(effectiveOverrides) as YamlMap
  }
}

function writePnpmV5ImporterLayout(
  context: PnpmV5StringifyContext,
  workspaceNodes: readonly Node[],
  out: YamlMap,
): void {
  if (workspaceNodes.length > 0) {
    const importers: YamlMap = {}
    importers['.'] = buildImporterEntry(
      context.graph,
      context.sidecar,
      context.rootNode,
      '.',
      context.options.overrides,
      context.internal.workspaceNames,
    )
    for (const wsNode of workspaceNodes) {
      const wsPath = wsNode.workspacePath ?? wsNode.name
      importers[wsPath] = buildImporterEntry(
        context.graph,
        context.sidecar,
        wsNode,
        wsPath,
        context.options.overrides,
        context.internal.workspaceNames,
      )
    }
    out.importers = sortRecord(importers) as YamlMap
    return
  }
  const rootEntry = buildImporterEntry(
    context.graph, context.sidecar, context.rootNode, '.',
    context.options.overrides, context.internal.workspaceNames,
  )
  out.specifiers = rootEntry.specifiers ?? {}
  if (rootEntry.dependencies !== undefined) out.dependencies = rootEntry.dependencies
  if (rootEntry.devDependencies !== undefined) out.devDependencies = rootEntry.devDependencies
  if (rootEntry.optionalDependencies !== undefined) out.optionalDependencies = rootEntry.optionalDependencies
}

function writePnpmV5Packages(
  context: PnpmV5StringifyContext,
  resolvedNodes: readonly Node[],
  out: YamlMap,
): void {
  const packages: YamlMap = {}
  for (const node of resolvedNodes) {
    const key = packagesKeyForNode(node)
    packages[key] = buildPackageEntry(context.graph, context.sidecar, node)
  }
  out.packages = packages
}

// === SERIALIZE — VALIDATION =================================================

// ADR-0028 INV-RESOLVE (pnpm v5) — the resolution-graph verifier, mirroring the
// v6/v9 `assertResolveValid` (`_pnpm-flat-core.ts`) over v5's standalone layout:
//
//   - consumer hop (`c` is the root or a workspace importer): `importers[path]`
//     `dependencies`/`devDependencies`/`optionalDependencies` (bare-string
//     values), or — single-importer collapsed-root — the top-level `out`
//     blocks. (The parallel `specifiers` map is the DESCRIPTOR, not a resolved
//     ref, so it is not resolved here.)
//   - package hop (`c` is a resolved package): the INLINE
//     `packages[key(c)].dependencies`/`optionalDependencies` (v5 has no
//     `snapshots:` block) — bare-string values.
//
// Resolution uses v5's own oracle (`resolveDependencyTarget` /
// `resolveAliasedDependencyTarget`) over the emitted packages-key NodeId set.
// Workspace-target (`link:`) edges are skipped. A miss is a soft
// `LAYOUT_RESOLVE_VIOLATION` (error) — no throw.
const PNPM_V5_CONSUMER_BLOCKS = ['dependencies', 'devDependencies', 'optionalDependencies'] as const
const PNPM_V5_PACKAGE_BLOCKS = ['dependencies', 'optionalDependencies'] as const

function pnpmV5ConsumerBlock(
  out: YamlMap,
  importersMap: Record<string, unknown> | undefined,
  rootNode: Node | undefined,
  consumer: Node,
): Record<string, unknown> | undefined {
  const path = consumer.id === rootNode?.id ? '.' : (consumer.workspacePath ?? consumer.name)
  if (importersMap !== undefined) {
    const block = importersMap[path]
    return isPlainObject(block) ? (block as Record<string, unknown>) : undefined
  }
  return consumer.id === rootNode?.id ? (out as Record<string, unknown>) : undefined
}

function pnpmV5PackageBlock(
  packagesMap: Record<string, unknown> | undefined,
  pkg: Node,
): Record<string, unknown> | undefined {
  const entry = packagesMap?.[packagesKeyForNode(pkg)]
  return isPlainObject(entry) ? (entry as Record<string, unknown>) : undefined
}

function pnpmV5SlotValue(
  block: Record<string, unknown>,
  blockNames: readonly string[],
  seg: string,
): string | undefined {
  for (const blockName of blockNames) {
    const sub = block[blockName]
    if (!isPlainObject(sub)) continue
    const raw = (sub as Record<string, unknown>)[seg]
    if (typeof raw === 'string') return raw
  }
  return undefined
}

function isPnpmV5Importer(node: Node, rootNode: Node | undefined): boolean {
  return node.id === rootNode?.id || (node.workspacePath !== undefined && node.workspacePath !== '')
}

interface PnpmV5ResolveValidationContext {
  graph:       Graph
  rootNode:    Node | undefined
  seenIds:     Set<string>
  onDiagnostic: (d: Diagnostic) => void
}

function validatePnpmV5ResolvedEdge(
  context: PnpmV5ResolveValidationContext,
  consumer: Node,
  consumerIsImporter: boolean,
  block: Record<string, unknown>,
  blockNames: readonly string[],
  edge: Edge,
): void {
  if (edge.kind !== 'dep' && edge.kind !== 'dev' && edge.kind !== 'optional') return
  const dst = context.graph.getNode(edge.dst)
  if (dst === undefined) return
  if (dst.workspacePath !== undefined && dst.workspacePath !== '') return
  if (!consumerIsImporter && (dst.id === consumer.id || dst.id === context.rootNode?.id)) return

  const seg = edge.attrs?.alias ?? dst.name
  const value = pnpmV5SlotValue(block, blockNames, seg)
  const resolved = value === undefined
    ? undefined
    : (resolveDependencyTarget(context.seenIds, seg, value)
      ?? resolveAliasedDependencyTarget(context.seenIds, value))
  if (resolved === dst.id) return
  context.onDiagnostic({
    code: 'LAYOUT_RESOLVE_VIOLATION',
    severity: 'error',
    subject: { src: edge.src, dst: edge.dst, kind: edge.kind },
    message:
      `INV-RESOLVE violated: ${consumer.id} resolves ${JSON.stringify(seg)} to ` +
      `${value === undefined ? '(no slot)' : (resolved === undefined ? `${JSON.stringify(value)} → (nothing)` : resolved)}, ` +
      `expected ${dst.id} (pnpm-v5 encoding defect — ADR-0028 INV-RESOLVE)`,
  })
}

function validatePnpmV5Consumer(
  context: PnpmV5ResolveValidationContext,
  out: YamlMap,
  importersMap: Record<string, unknown> | undefined,
  packagesMap: Record<string, unknown> | undefined,
  consumer: Node,
): void {
  const consumerIsImporter = isPnpmV5Importer(consumer, context.rootNode)
  if (!consumerIsImporter && !context.seenIds.has(consumer.id)) return
  const block = consumerIsImporter
    ? pnpmV5ConsumerBlock(out, importersMap, context.rootNode, consumer)
    : pnpmV5PackageBlock(packagesMap, consumer)
  if (block === undefined) return
  const blockNames = consumerIsImporter ? PNPM_V5_CONSUMER_BLOCKS : PNPM_V5_PACKAGE_BLOCKS
  for (const edge of context.graph.out(consumer.id)) {
    validatePnpmV5ResolvedEdge(context, consumer, consumerIsImporter, block, blockNames, edge)
  }
}

function assertResolveValid(
  graph: Graph,
  out: YamlMap,
  rootNode: Node | undefined,
  resolvedNodes: readonly Node[],
  onDiagnostic: (d: Diagnostic) => void,
): void {
  const seenIds = new Set<string>(resolvedNodes.map(n => n.id))
  const importersMap = isPlainObject(out.importers) ? (out.importers as Record<string, unknown>) : undefined
  const packagesMap = isPlainObject(out.packages) ? (out.packages as Record<string, unknown>) : undefined
  const context: PnpmV5ResolveValidationContext = { graph, rootNode, seenIds, onDiagnostic }
  for (const consumer of graph.nodes()) {
    validatePnpmV5Consumer(context, out, importersMap, packagesMap, consumer)
  }
}

// === ENRICH =================================================================

export function enrich(
  graph: Graph,
  options: PnpmV5EnrichOptions = {},
): { graph: Graph; diagnostics: Diagnostic[] } {
  const sidecar = sidecarByGraph.get(graph)
  const diagnostics = collectPnpmV5PeerDiagnostics(graph, sidecar)
  if (options.manifests === undefined) {
    reportPnpmV5MissingManifests(graph, diagnostics)
    return { graph, diagnostics }
  }
  const plan = planManifestEnrich(graph, sidecar, options.manifests)
  if (plan.addRootEdges.length === 0 && plan.markWorkspaceEdges.length === 0) {
    return { graph, diagnostics }
  }
  const enriched = applyPnpmV5ManifestPlan(graph, plan)
  if (sidecar !== undefined) rememberSidecar(enriched, sidecar)
  return { graph: enriched, diagnostics }
}

function collectPnpmV5PeerDiagnostics(
  graph: Graph,
  sidecar: PnpmV5Sidecar | undefined,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = []
  for (const node of graph.nodes()) {
    const nodeSc = sidecar?.nodes.get(node.id)
    const rawPeers = nodeSc?.peerDependencies
    if (rawPeers === undefined) continue
    for (const peerName of Object.keys(rawPeers).sort(cmpStr)) {
      const peerRange = rawPeers[peerName]
      if (peerRange === undefined) continue
      const alreadyBound = node.peerContext.some(p => stripPeerContextFromNodeId(p).startsWith(`${peerName}@`))
      if (alreadyBound) continue
      diagnostics.push(pnpmV5PeerDiagnostic(graph, node, peerName, peerRange))
    }
  }
  return diagnostics
}

function pnpmV5PeerDiagnostic(
  graph: Graph,
  node: Node,
  peerName: string,
  peerRange: string,
): Diagnostic {
  const candidates = derivePeerCandidates(graph, peerName, peerRange)
  if (candidates.length === 1) {
    return {
      code: 'PNPM_V5_PEER_BOUND', severity: 'info', subject: node.id,
      message: `peer ${JSON.stringify(peerName)} range ${JSON.stringify(peerRange)} → ${candidates[0]} (1-candidate fallback; on-disk peer-context absent)`,
    }
  }
  if (candidates.length === 0) {
    return {
      code: 'PNPM_V5_PEER_UNSATISFIED', severity: 'warning', subject: node.id,
      message: `peer ${JSON.stringify(peerName)} range ${JSON.stringify(peerRange)} matches no installed version`,
    }
  }
  return {
    code: 'PNPM_V5_PEER_AMBIGUOUS', severity: 'warning', subject: node.id,
    message: `peer ${JSON.stringify(peerName)} range ${JSON.stringify(peerRange)} matches multiple candidates: ${candidates.join(', ')}`,
  }
}

function reportPnpmV5MissingManifests(graph: Graph, diagnostics: Diagnostic[]): void {
  const hasWorkspaceHint = Array.from(graph.nodes())
    .some(node => node.workspacePath !== undefined && node.workspacePath !== '')
  if (!hasWorkspaceHint) return
  diagnostics.push({
    code: 'PNPM_V5_NO_MANIFESTS',
    severity: 'warning',
    message: 'pnpm-v5 workspace concretisation requires manifests; leaving graph unclassified',
  })
}

type PnpmV5ManifestPlan = ReturnType<typeof planManifestEnrich>

function applyPnpmV5ManifestPlan(graph: Graph, plan: PnpmV5ManifestPlan): Graph {
  return graph.mutate(m => {
    for (const edge of plan.addRootEdges) {
      m.addEdge(edge.src, edge.dst, edge.kind, edge.attrs)
    }
    for (const edge of plan.markWorkspaceEdges) {
      m.removeEdge(edge.src, edge.dst, edge.kind)
      m.addEdge(edge.src, edge.dst, edge.kind, edge.attrs)
    }
  }).graph
}

// === OPTIMIZE ===============================================================

export function optimize(
  graph: Graph,
  _options: PnpmV5OptimizeOptions = {},
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
    rememberSidecar(result.graph, prunePnpmSidecar(sidecar, result.graph))
  }
  return result
}

// === HELPERS — PARSE ========================================================

export interface PeerEntry { name: string; version: string }
export interface ParsedPackagesKey { name: string; version: string; peers: PeerEntry[] }

/**
 * Right-to-left peel grammar per ADR-0022 §A.pnpm-v5. Given
 * `<version>[_<peer>@<v>…]`, peel `_<peerName>@<peerVersion>` segments
 * from the tail while PEER_TAIL_RE matches; returns the bare version
 * (unconsumed remainder) and peers in canonical order. Returns undefined
 * for an empty input or fully-consumed remainder (no base version
 * left).
 *
 * v5-scoped-peer-grammar edge per ADR-0022 stub: scoped peers containing
 * underscores in path segments are theoretically ambiguous. PEER_TAIL_RE
 * handles the common scoped-peer shape
 * `@scope/name@version` correctly.
 */
export function peelPeerTail(input: string): { version: string; peers: PeerEntry[] } | undefined {
  if (input.length === 0) return undefined
  let rest = input
  const peers: PeerEntry[] = []
  while (rest.length > 0) {
    const m = rest.match(PEER_TAIL_RE)
    if (m === null) break
    peers.unshift({ name: m[1]!, version: m[2]! })
    rest = rest.slice(0, rest.length - m[0]!.length)
  }
  if (rest.length === 0) return undefined
  return { version: rest, peers }
}

/**
 * Parse a v5 `/<name>/<version>[<peer-tail>]` packages key. Strip the
 * leading `/`, split on the LAST `/` for name vs `<version><peer-tail>`
 * (the version segment contains no `/`, so the rule applies uniformly
 * to scoped and unscoped names), then peel the peer tail right-to-left.
 */
export function parsePackagesKey(key: string): ParsedPackagesKey | undefined {
  if (!key.startsWith('/')) return undefined
  const body = key.slice(1)
  const lastSlash = body.lastIndexOf('/')
  if (lastSlash <= 0) return undefined
  const name = body.slice(0, lastSlash)
  const tail = body.slice(lastSlash + 1)
  if (name.length === 0) return undefined
  const peeled = peelPeerTail(tail)
  if (peeled === undefined) return undefined
  return { name, version: peeled.version, peers: peeled.peers }
}

export function resolveDependencyTarget(
  seenIds: Set<string>,
  depName: string,
  rawValue: string,
): string | undefined {
  const peeled = peelPeerTail(rawValue)
  if (peeled === undefined) return undefined
  const peerContext = peeled.peers.map(p => `${p.name}@${p.version}`).sort(cmpStr)
  const candidate = serializeNodeId(depName, peeled.version, peerContext)
  if (seenIds.has(candidate)) return candidate
  const bare = `${depName}@${peeled.version}`
  if (seenIds.has(bare)) return bare
  return undefined
}

/** pnpm v5 npm-alias variant: rawValue carries `<target>@<version>` rather than a bare version. */
export function resolveAliasedDependencyTarget(
  seenIds: Set<string>,
  rawValue: string,
): string | undefined {
  if (rawValue.indexOf('@', 1) <= 0) return undefined
  // Split at last `@` to peel target name + version (peer-tail handled
  // independently via peelPeerTail).
  let lastAt = -1
  for (let i = 1; i < rawValue.length; i++) {
    if (rawValue[i] === '@' && (rawValue[i + 1] !== undefined && rawValue[i + 1] !== '(')) lastAt = i
  }
  if (lastAt <= 0) return undefined
  const targetName = rawValue.slice(0, lastAt)
  const rest = rawValue.slice(lastAt + 1)
  const peeled = peelPeerTail(rest)
  if (peeled === undefined) return undefined
  const peerContext = peeled.peers.map(p => `${p.name}@${p.version}`).sort(cmpStr)
  const candidate = serializeNodeId(targetName, peeled.version, peerContext)
  if (seenIds.has(candidate)) return candidate
  const bare = `${targetName}@${peeled.version}`
  if (seenIds.has(bare)) return bare
  return undefined
}

function addPackageNode(
  builder: ReturnType<typeof newBuilder>,
  sidecar: PnpmV5Sidecar,
  name: string,
  version: string,
  peerContext: string[],
  nodeId: string,
  pkgEntry: unknown,
  diagnostics: Diagnostic[],
): void {
  const node: Node = {
    id: nodeId,
    name,
    version,
    peerContext,
  }
  builder.addNode(node)

  const nodeSc: PnpmV5NodeSidecar = {}
  if (isPlainObject(pkgEntry)) {
    if (isPlainObject(pkgEntry.peerDependencies)) {
      nodeSc.peerDependencies = { ...(pkgEntry.peerDependencies as Record<string, string>) }
    }
    if (isPlainObject(pkgEntry.engines)) {
      nodeSc.engines = { ...(pkgEntry.engines as Record<string, string>) }
    }
    if (pkgEntry.hasBin === true) nodeSc.hasBin = true
    if (Array.isArray(pkgEntry.os)) nodeSc.os = (pkgEntry.os as string[]).slice()
    if (Array.isArray(pkgEntry.cpu)) nodeSc.cpu = (pkgEntry.cpu as string[]).slice()
    if (typeof pkgEntry.dev === 'boolean') nodeSc.dev = pkgEntry.dev
    if (typeof pkgEntry.optional === 'boolean') nodeSc.optional = pkgEntry.optional
  }
  sidecar.nodes.set(nodeId, nodeSc)

  const payload = tarballPayloadOf(pkgEntry, nodeId, diagnostics) ?? {}
  if (nodeSc.peerDependencies !== undefined) {
    payload.peerDependencies = { ...nodeSc.peerDependencies }
  }
  if (Object.keys(payload).length > 0) {
    builder.setTarball({ name, version }, payload)
  }
}

function addResolvedTreeEdges(
  builder: ReturnType<typeof newBuilder>,
  diagnostics: Diagnostic[],
  srcId: string,
  entry: Record<string, unknown>,
  peers: Array<{ name: string; version: string }>,
  seenIds: Set<string>,
  sidecar: PnpmV5Sidecar,
): void {
  for (const [kind, blockName] of [
    ['dep', 'dependencies'],
    ['optional', 'optionalDependencies'],
  ] as const) {
    const block = entry[blockName]
    if (!isPlainObject(block)) continue
    const entries = Object.entries(block).sort((a, b) => cmpStr(a[0], b[0]))
    for (const [depName, rawValue] of entries) {
      if (typeof rawValue !== 'string') continue
      let targetId = resolveDependencyTarget(seenIds, depName, rawValue)
      let aliasSlot: string | undefined
      if (targetId === undefined) {
        const aliased = resolveAliasedDependencyTarget(seenIds, rawValue)
        if (aliased !== undefined) {
          targetId = aliased
          aliasSlot = depName
        }
      }
      if (targetId === undefined) {
        diagnostics.push({
          code: 'PNPM_UNRESOLVED_DEP',
          severity: 'warning',
          subject: srcId,
          message: `pnpm-v5: ${srcId} dep ${depName}@${rawValue} resolves to no packages entry`,
        })
        continue
      }
      try {
        const attrs: { range: string; alias?: string } = { range: rawValue }
        if (aliasSlot !== undefined) attrs.alias = aliasSlot
        builder.addEdge(srcId, targetId, kind, attrs)
      } catch (error) {
        if (error instanceof GraphError && error.code === 'INVARIANT_VIOLATION') continue
        throw error
      }
    }
  }

  // Peer edges — derive from the parsed peers chain.
  for (const peer of peers) {
    const peerNodeId = resolvePeerTargetById(seenIds, peer.name, peer.version)
    if (peerNodeId === undefined) {
      diagnostics.push({
        code: 'PNPM_UNRESOLVED_DEP',
        severity: 'warning',
        subject: srcId,
        message: `pnpm-v5: ${srcId} peer ${peer.name}@${peer.version} resolves to no packages entry`,
      })
      continue
    }
    try {
      const sc = sidecar.nodes.get(srcId)
      const peerRange = sc?.peerDependencies?.[peer.name] ?? peer.version
      builder.addEdge(srcId, peerNodeId, 'peer', { range: peerRange })
    } catch (error) {
      if (error instanceof GraphError && error.code === 'INVARIANT_VIOLATION') continue
      throw error
    }
  }
}

function buildCollapsedRootImporter(yaml: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (yaml.specifiers !== undefined) out.specifiers = yaml.specifiers
  if (yaml.dependencies !== undefined) out.dependencies = yaml.dependencies
  if (yaml.devDependencies !== undefined) out.devDependencies = yaml.devDependencies
  if (yaml.optionalDependencies !== undefined) out.optionalDependencies = yaml.optionalDependencies
  return out
}

// === HELPERS — SERIALIZE ====================================================

function tailOfName(name: string): string {
  return name.startsWith('@') ? name.split('/').slice(1).join('/') : name
}

function derivePnpmResolutionFromCanonical(
  canonical: ResolutionCanonical | undefined,
): { tarball?: string; directory?: string } | undefined {
  if (canonical === undefined) return undefined
  const out = stringifyForPnpm(canonical)
  if (out === undefined) return undefined
  const result: { tarball?: string; directory?: string } = {}
  if (out.tarball !== undefined) result.tarball = out.tarball
  if (out.directory !== undefined) result.directory = out.directory
  if (out.tarball === undefined && out.directory === undefined && out.extra?.tarball !== undefined) {
    result.tarball = out.extra.tarball
  }
  return result.tarball === undefined && result.directory === undefined ? undefined : result
}

function packagesKeyForNode(node: Node): string {
  // v5: `/<name>/<version>[_<peer>@<v>…]` — slash separator, underscore peers.
  const tail = node.peerContext.length === 0
    ? ''
    : node.peerContext.map(p => `_${p}`).join('')
  return `/${node.name}/${node.version}${tail}`
}

function nodeIdToDependencyValue(node: Node): string {
  // Importer-side `dependencies.<name>: <value>` rendering: bare version with
  // underscore peer-context tail. Mirrors the packages-key tail rule.
  const tail = node.peerContext.length === 0
    ? ''
    : node.peerContext.map(p => `_${p}`).join('')
  return `${node.version}${tail}`
}

// ADR-0028 INV-RESOLVE — the (slot-key, slot-value) pair for one dependency
// edge in a v5 `dependencies` / `specifiers` / inline-transitive block. A
// plain dep is `<dst.name>: <version>[_<peer>@v]` (pnpm-v5's bare encoding);
// an npm-aliased dep (`edge.attrs.alias` set) keys by the alias descriptor and
// values the CANONICAL `<dst.name>@<version>[_<peer>@v]`, the form parse's
// resolveAliasedDependencyTarget reconstructs (`pnpm-v5.ts:771-792`).
function aliasedDependencySlot(edge: Edge, dst: Node): { key: string; value: string } {
  const bareValue = nodeIdToDependencyValue(dst)
  const alias = edge.attrs?.alias
  if (alias === undefined) return { key: dst.name, value: bareValue }
  return { key: alias, value: `${dst.name}@${bareValue}` }
}

function buildImporterEntry(
  graph: Graph,
  sidecar: PnpmV5Sidecar | undefined,
  node: Node | undefined,
  importerPath: string,
  overrides: readonly OverrideConstraint[] | undefined,
  workspaceNames: ReadonlyMap<string, string> | undefined,
): YamlMap {
  const entry: YamlMap = {}
  if (node === undefined) return entry

  const specifiers: Record<string, string> = {}
  const blocks: Record<EdgeKind, Record<string, string>> = {
    dep: {},
    dev: {},
    optional: {},
    peer: {},
    bundled: {},
  }

  const importerSpecs = sidecar?.importerSpecifiers.get(importerPath)

  for (const edge of graph.out(node.id)) {
    if (edge.kind === 'peer' || edge.kind === 'bundled') continue
    const dst = graph.getNode(edge.dst)
    if (dst === undefined) continue
    const isWorkspaceTarget = dst.workspacePath !== undefined && dst.workspacePath !== ''
    const edgeKey = `${edge.src}\0${edge.kind}\0${edge.dst}\0${edge.attrs?.alias ?? ''}`
    const edgeSc = sidecar?.importerEdges.get(edgeKey)

    // ADR-0028 INV-RESOLVE — key both `specifiers` and the dep block by the
    // DESCRIPTOR segment (alias when set, else the package name) and emit the
    // CANONICAL `<name>@<version>` dep value for an alias. pnpm-v5 keys both
    // maps by the descriptor (`react-is-cjs:` in both), so an npm-aliased dep
    // must emit under the alias slot, not `dst.name`. The `importerEdges`
    // sidecar key now carries the alias slot, so an aliased and a direct edge to
    // the SAME node no longer collide — each reads back its OWN descriptor (a
    // plain `react` no longer inherits an `react-alias: npm:react@…` descriptor).
    // The per-edge preference below still computes the aliased canonical
    // `<name>@<version>` value; non-aliased edges keep the capture verbatim.
    const slot = aliasedDependencySlot(edge, dst)
    const isAliased = edge.attrs?.alias !== undefined
    const range = edge.attrs?.range
    const specifierFromSidecar = importerSpecs?.[slot.key]
    const captureIsAliasConsistent = edgeSc?.resolvedVersion?.startsWith(`${dst.name}@`) === true
    const declaredSpecifier = isAliased
      ? (range ?? specifierFromSidecar ?? edgeSc?.specifier ?? dst.version)
      : (edgeSc?.specifier ?? specifierFromSidecar ?? range ?? dst.version)
    const override = overrides === undefined
      ? undefined
      : governingOverrideFor(
          slot.key,
          [workspaceNames?.get(node.id) ?? node.name],
          overrides,
          declaredSpecifier,
        )
    const specifier = override?.to ?? declaredSpecifier
    const version = isWorkspaceTarget
      ? `link:${relativeImporterPath(importerPath, dst.workspacePath ?? dst.name)}`
      : isAliased
        ? (captureIsAliasConsistent ? edgeSc!.resolvedVersion! : slot.value)
        : (edgeSc?.resolvedVersion ?? slot.value)

    blocks[edge.kind][slot.key] = version
    specifiers[slot.key] = specifier
  }

  if (Object.keys(specifiers).length > 0) {
    entry.specifiers = sortRecord(specifiers) as YamlMap
  } else if (importerSpecs !== undefined && Object.keys(importerSpecs).length > 0) {
    // Empty edge set but importer had declared specifiers — preserve them.
    entry.specifiers = sortRecord(importerSpecs) as YamlMap
  } else {
    // Always emit `specifiers: {}` for non-root importers when empty
    // (root single-importer collapsed-root handles its own emit).
  }

  for (const [kind, blockName] of [
    ['dep', 'dependencies'],
    ['dev', 'devDependencies'],
    ['optional', 'optionalDependencies'],
  ] as const) {
    const block = blocks[kind]
    if (Object.keys(block).length > 0) {
      entry[blockName] = sortRecord(block) as YamlMap
    }
  }

  return entry
}

function buildPackageEntry(
  graph: Graph,
  sidecar: PnpmV5Sidecar | undefined,
  representative: Node,
): YamlMap {
  const entry: YamlMap = {}
  const tarball = graph.tarballOf(representative.id)
  // ADR-0014 §4.F3 — see pnpm-flat-core for the field semantics. Suppress
  // registry-default URLs (pnpm's implicit convention) and emit verbatim
  // URL only for non-registry shapes.
  const nativeResolution = tarball?.nativeResolution
  const nativeIsPnpmUrl = nativeResolution !== undefined
    && (nativeResolution.startsWith('http://')
      || nativeResolution.startsWith('https://'))
  const derivedPnpm = derivePnpmResolutionFromCanonical(tarball?.resolution)
  const derivedTarballIsRegistryDefault = tarball?.resolution?.type === 'tarball'
    && tarball.resolution.url === `${DEFAULT_NPM_REGISTRY}/${representative.name}/-/${tailOfName(representative.name)}-${representative.version}.tgz`
  if (tarball !== undefined) {
    const resolution: YamlMap = {}
    const integ = emitSriForRegistry(tarball.integrity, nativeResolution)
    if (integ !== undefined) resolution.integrity = integ
    if (nativeIsPnpmUrl) resolution.tarball = stripRegistrySha1Fragment(nativeResolution!)
    else if (derivedPnpm?.tarball !== undefined && !derivedTarballIsRegistryDefault) resolution.tarball = derivedPnpm.tarball
    else if (derivedPnpm?.directory !== undefined) resolution.directory = derivedPnpm.directory
    if (Object.keys(resolution).length > 0) entry.resolution = flowMap(resolution)
  } else if (nativeIsPnpmUrl) {
    entry.resolution = flowMap({ tarball: nativeResolution! })
  } else if (derivedPnpm?.tarball !== undefined && !derivedTarballIsRegistryDefault) {
    entry.resolution = flowMap({ tarball: derivedPnpm.tarball })
  } else if (derivedPnpm?.directory !== undefined) {
    entry.resolution = flowMap({ directory: derivedPnpm.directory })
  }

  const nodeSc = sidecar?.nodes.get(representative.id)
  if (nodeSc?.engines !== undefined && Object.keys(nodeSc.engines).length > 0) {
    entry.engines = flowMap({ ...nodeSc.engines })
  } else if (tarball?.engines !== undefined && Object.keys(tarball.engines).length > 0) {
    entry.engines = flowMap({ ...tarball.engines })
  }
  if (nodeSc?.hasBin === true) entry.hasBin = true
  const os = nodeSc?.os ?? tarball?.os
  const cpu = nodeSc?.cpu ?? tarball?.cpu
  if (os !== undefined && os.length > 0) entry.os = os.slice()
  if (cpu !== undefined && cpu.length > 0) entry.cpu = cpu.slice()
  const peerDependencies = nodeSc?.peerDependencies ?? tarball?.peerDependencies
  if (peerDependencies !== undefined && Object.keys(peerDependencies).length > 0) {
    entry.peerDependencies = sortRecord(peerDependencies) as YamlMap
  }

  // Inline transitive dependencies.
  const blocks: Record<'dep' | 'optional', Record<string, string>> = { dep: {}, optional: {} }
  for (const edge of graph.out(representative.id)) {
    if (edge.kind !== 'dep' && edge.kind !== 'optional') continue
    const dst = graph.getNode(edge.dst)
    if (dst === undefined) continue
    if (dst.workspacePath !== undefined && dst.workspacePath !== '') continue
    if (dst.id === sidecar?.rootId) continue
    const block = blocks[edge.kind]!
    // ADR-0028 INV-RESOLVE — alias slot keying + canonical value (see
    // buildImporterEntry / aliasedDependencySlot).
    const slot = aliasedDependencySlot(edge, dst)
    block[slot.key] = slot.value
  }
  for (const [kind, blockName] of [['dep', 'dependencies'], ['optional', 'optionalDependencies']] as const) {
    const block = blocks[kind]
    if (Object.keys(block).length > 0) {
      entry[blockName] = sortRecord(block) as YamlMap
    }
  }

  // dev / optional per-entry flags.
  const dev = nodeSc?.dev ?? false
  entry.dev = dev
  if (nodeSc?.optional === true) entry.optional = true

  return entry
}

// === ENRICH — PLANNING ======================================================

interface EnrichPlan {
  addRootEdges: Edge[]
  markWorkspaceEdges: Edge[]
}

type PnpmV5MemberManifest = { path: string; manifest: PnpmV5Manifest }

function pnpmV5MemberManifests(manifests: Record<string, PnpmV5Manifest>): Map<string, PnpmV5MemberManifest> {
  const memberByName = new Map<string, PnpmV5MemberManifest>()
  for (const [path, manifest] of Object.entries(manifests)) {
    if (path === '' || manifest.name === undefined) continue
    memberByName.set(manifest.name, { path, manifest })
  }
  return memberByName
}

function pnpmV5WorkspaceRange(range: string, dst: Node | undefined): { specifier: string; resolvedVersion?: string } {
  const rawSpecifier = isWorkspaceProtocolRange(range) ? range : ''
  return dst?.version !== undefined && dst.version !== ''
    ? { specifier: rawSpecifier, resolvedVersion: dst.version }
    : { specifier: rawSpecifier }
}

function desiredPnpmV5RootEdges(
  graph: Graph,
  rootNodeId: string,
  rootManifest: PnpmV5Manifest,
  memberByName: Map<string, PnpmV5MemberManifest>,
): Edge[] {
  const desired: Edge[] = []
  for (const [kind, deps] of [
    ['dep', rootManifest.dependencies],
    ['dev', rootManifest.devDependencies],
    ['optional', rootManifest.optionalDependencies],
    ['peer', rootManifest.peerDependencies],
  ] as const) {
    if (deps === undefined) continue
    for (const [name, range] of Object.entries(deps).sort((a, b) => cmpStr(a[0], b[0]))) {
      const dstId = resolveManifestTarget(graph, name, range, memberByName)
      if (dstId === undefined) continue
      const attrs: {
        range: string
        workspace?: boolean
        workspaceRange?: { specifier: string; resolvedVersion?: string }
      } = { range }
      if (isWorkspaceProtocolRange(range) || memberByName.has(name)) {
        attrs.workspace = true
        attrs.workspaceRange = pnpmV5WorkspaceRange(range, graph.getNode(dstId))
      }
      desired.push({ src: rootNodeId, dst: dstId, kind, attrs })
    }
  }
  return desired
}

function reconcilePnpmV5RootEdges(graph: Graph, rootNodeId: string, desired: readonly Edge[], plan: EnrichPlan): void {
  const existing = graph.out(rootNodeId)
  for (const want of desired) {
    const match = existing.find(c => c.kind === want.kind && c.dst === want.dst)
    if (match === undefined) {
      plan.addRootEdges.push(want)
      continue
    }
    const wantRange = want.attrs?.range
    const curRange = match.attrs?.range
    const wantWs = want.attrs?.workspace ?? false
    const curWs = match.attrs?.workspace ?? false
    if (wantRange !== curRange || wantWs !== curWs) plan.markWorkspaceEdges.push(want)
  }
}

function markPnpmV5WorkspaceEdges(graph: Graph, plan: EnrichPlan): void {
  for (const node of graph.nodes()) {
    for (const edge of graph.out(node.id)) {
      if (edge.kind === 'peer') continue
      if (edge.attrs?.workspace === true) continue
      const dst = graph.getNode(edge.dst)
      if (dst === undefined) continue
      if (dst.workspacePath === undefined || dst.workspacePath === '') continue
      const range = edge.attrs?.range !== undefined && edge.attrs.range.startsWith('workspace:')
        ? edge.attrs.range
        : ''
      const workspaceRange = pnpmV5WorkspaceRange(range, dst)
      plan.markWorkspaceEdges.push({
        src: edge.src,
        dst: edge.dst,
        kind: edge.kind,
        attrs: { ...edge.attrs, workspace: true, workspaceRange },
      })
    }
  }
}

function planManifestEnrich(
  graph: Graph,
  sidecar: PnpmV5Sidecar | undefined,
  manifests: Record<string, PnpmV5Manifest>,
): EnrichPlan {
  const rootManifest = manifests['']
  const rootNodeId = sidecar?.rootId
  const plan: EnrichPlan = { addRootEdges: [], markWorkspaceEdges: [] }
  const memberByName = pnpmV5MemberManifests(manifests)
  if (rootManifest !== undefined && rootNodeId !== undefined) {
    const desired = desiredPnpmV5RootEdges(graph, rootNodeId, rootManifest, memberByName)
    reconcilePnpmV5RootEdges(graph, rootNodeId, desired, plan)
  }
  markPnpmV5WorkspaceEdges(graph, plan)
  return plan
}

function resolveManifestTarget(
  graph: Graph,
  name: string,
  range: string,
  memberByName: Map<string, { path: string; manifest: PnpmV5Manifest }>,
): string | undefined {
  if (isWorkspaceProtocolRange(range) || memberByName.has(name)) {
    const member = memberByName.get(name)
    if (member !== undefined) {
      for (const node of graph.nodes()) {
        if (node.workspacePath === member.path) return node.id
      }
    }
  }
  const candidates = graph.byName(name)
  if (candidates.length === 1) return candidates[0]
  for (const id of candidates) {
    const node = graph.getNode(id)
    if (node?.version === range) return id
  }
  return undefined
}

function isWorkspaceProtocolRange(range: string): boolean {
  return range.startsWith('workspace:')
}
