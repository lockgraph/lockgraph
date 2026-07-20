// npm-1 adapter — npm `package-lock.json` lockfileVersion 1 (nested-tree shape).
//
// Standalone adapter per ADR-0021 §5: the npm-1
// recursive `dependencies` tree shape is fundamentally different from the
// flat `packages` block layout shared by npm-2/npm-3. Forcing a unified
// pipeline rots both sides; this module owns its own parse / stringify
// pipeline and reuses ONLY shape-compatible utilities from
// `_npm-flat-types.ts` + `_npm-core.ts` (cmpStr, sortRecord, edgeTripleKey,
// NPM_EDGE_RANGE_ATTR, NpmSidecar, derivePeerCandidates, pruneSidecar).
//
// Dependency direction (parallel to yarn-classic precedent):
//   - this module imports from `_npm-flat-types.ts` (types + tiny utilities)
//     and `_npm-core.ts` (cross-format peer derivation, sidecar pruning).
//   - it does NOT call `parseFamily` / `stringifyFamily` — those are
//     flat-shape specific.
//   - `_npm-core.ts` does NOT import this module.
//
// §A pinning per ADR-0021 §A.npm-1:
//   - top-level `lockfileVersion: 1` literal handshake; reject `packages`-
//     shape inputs (npm-2/npm-3) with FORMAT_MISMATCH.
//   - top-level `dependencies` recursive map; entries carry `version` +
//     optional `resolved` / `integrity` / `dev` / `optional` / `bundled` /
//     `requires` / nested `dependencies`.
//   - JSON canonical 2-space indent, alphabetical sort, trailing `\n`.
//
// §B Lossy-but-acceptable (npm-1 specific):
//   - `NPM_V1_PEER_DROPPED` — peer edges drop on emit (no on-disk slot).
//   - `NPM_V1_PEER_VIRT_FLATTENED` — peer-virt NodeIds flatten on emit.
//   - `NPM_V1_PATCH_DROPPED` — patch slot drops on emit (no `patch:` protocol).
//   - `NPM_V1_WORKSPACES_UNSAFE` — workspace members omitted on emit.
//
// §C enrich:
//   - peer-virt structurally absent (no on-disk peer block).
//   - workspace concretisation from `manifests` only; `NPM_V1_NO_MANIFESTS`
//     warning when manifests absent.
//
// §D optimize: prune unreachable from `graph.roots()` BFS — inherits
// ADR-0016 §D verbatim via the same algorithm shape as `_npm-core.ts`.

import {
  GraphError,
  newBuilder,
  serializeNodeId,
  type DependencyManifest,
  type Diagnostic,
  type Edge,
  type EdgeKind,
  type Graph,
  type Node,
  type TarballPayload,
} from '../graph.ts'
import { LockfileError } from '../api/errors.ts'
import { parseSri, emitSriForRegistry, isEmptyIntegrity } from '../recipe/integrity.ts'
import {
  NPM_EDGE_RANGE_ATTR,
  cmpStr,
  edgeTripleKey,
  sortRecord,
  stringifyNpmLock,
  type NpmFlatSidecar,
  type NpmSidecar,
} from './_npm-flat-types.ts'
import { optimizeUnreachable } from './_optimize.ts'
import { derivePeerCandidates, pruneSidecar } from './_npm-core.ts'
import { emitDropped as patchEmitDropped, emitDropped as recipeEmitDropped } from '../recipe/diagnostics.ts'
import {
  isYarnBerryLocator,
  parse as parseResolutionRecipe,
  sourceDiscriminatorOf,
  stringifyForNpm,
  stripRegistrySha1Fragment,
  type ResolutionCanonical,
} from '../recipe/resolution.ts'

// === TYPES ==================================================================

export interface Npm1ParseOptions {}

export interface Npm1StringifyOptions {
  lineEnding?: 'lf' | 'crlf'
  onDiagnostic?: (diagnostic: Diagnostic) => void
}

export interface Npm1Manifest extends DependencyManifest {}

export interface Npm1EnrichOptions {
  manifests?: Record<string, Npm1Manifest>
}

export interface Npm1OptimizeOptions {}

// === On-disk schema =========================================================

interface Npm1Entry {
  version?: string
  resolved?: string
  integrity?: string
  from?: string
  dev?: boolean
  optional?: boolean
  bundled?: boolean
  requires?: Record<string, string>
  dependencies?: Record<string, Npm1Entry>
  // npm v5/v6 may carry `peerDependencies` in newer fixtures; sidecar
  // captures it but emit elides per ADR-0021 §A.npm-1.
  peerDependencies?: Record<string, string>
}

interface Npm1Lockfile {
  name?: string
  version?: string
  lockfileVersion?: number
  requires?: boolean
  dependencies?: Record<string, Npm1Entry>
  packages?: unknown
}

interface Npm1ParseContext {
  readonly lf: Npm1Lockfile
  readonly builder: ReturnType<typeof newBuilder>
  readonly diagnostics: Diagnostic[]
  readonly nodeSidecar: Map<string, NpmFlatSidecar>
  readonly edgeRanges: Map<string, string>
  readonly edgeDeclaredNames: Map<string, string>
  readonly seenIds: Set<string>
  readonly parentScopes: Array<Record<string, Npm1Entry>>
  readonly rootId: string
}

interface Npm1WalkFrame {
  readonly deps: Record<string, Npm1Entry> | undefined
  readonly parentPath: string
  readonly inheritedDev: boolean
  readonly inheritedOptional: boolean
}

interface Npm1EntryIdentity {
  readonly id: string
  readonly version: string
  readonly resolved: string | undefined
  readonly source: string | undefined
  readonly installPath: string
}

interface Npm1StringifyContext {
  readonly graph: Graph
  readonly sidecar: NpmSidecar | undefined
  readonly emitDiagnostic: (diagnostic: Diagnostic) => void
  readonly warnedPeerVirt: Set<string>
  readonly warnedPatches: Set<string>
  readonly warnedPeerEdges: Set<string>
  readonly warnedWorkspaces: Set<string>
  readonly emittableIds: Set<string>
  readonly rootNode: Node | undefined
  readonly rootName: string
  readonly rootVersion: string
}

// Reconstruct the nested-tree shape for emit. Strategy (mining legacy
// `preformat`): walk BFS from the root, hoist each transitive in the
// shallowest level that does not introduce a version conflict with an
// already-hoisted sibling. Conflicts fall to nested `<parent>.dependencies`.
//
// Sidecar installPaths are an authoritative hint: if the parse-time tree
// placed a node at a specific path, mirror that placement (this preserves
// the `parse → stringify → parse` invariant for fixture inputs). Mutator-
// added nodes have no install path; they get hoisted to the root level
// unless that introduces a conflict.
type PlacementQueueItem = { id: string; parentPath: string }

interface EnrichPlan {
  rootNodeReplacement: Node | undefined
  addMemberNodes: Node[]
  memberNodeReplacements: Node[]
  addRootEdges: Edge[]
  removeRootEdges: Edge[]
  markWorkspaceEdges: Edge[]
}

type Npm1MemberManifest = { path: string; manifest: Npm1Manifest }

// === SIDECAR ================================================================

const sidecarByGraph = new WeakMap<Graph, NpmSidecar>()

export function hasAdapterState(graph: Graph): boolean {
  return sidecarByGraph.has(graph)
}

function rememberSidecar(graph: Graph, sidecar: NpmSidecar): void {
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
    ...[...sidecar.edgeRanges.keys()].filter(key => !pruned.edgeRanges.has(key)),
  ].sort()
  return { graph: target, invalidated }
}

// === API ====================================================================

export function check(input: string): boolean {
  // The numeric version literal is the primary discriminator; an empty lock
  // may omit `dependencies`.
  if (!/"lockfileVersion"\s*:\s*1\b/.test(input)) return false
  // Reject inputs carrying a flat `packages` map (npm-2/npm-3 shape).
  if (/"packages"\s*:\s*\{/.test(input)) return false
  return true
}

export function parse(input: string, _options: Npm1ParseOptions = {}): Graph {
  const lf = parseJson(input)
  assertNpm1Shape(lf)
  const context = createNpm1ParseContext(lf)
  addNpm1TreeNodes(context, { deps: lf.dependencies, parentPath: '', inheritedDev: false, inheritedOptional: false })
  addNpm1RootEdges(context)
  normalizeNpm1InstallPaths(context)
  return sealNpm1Parse(context)
}

export function stringify(graph: Graph, options: Npm1StringifyOptions = {}): string {
  const context = createNpm1StringifyContext(graph, options)
  collectNpm1EmittableNodes(context)
  reportNpm1PeerEdgeDrops(context)
  const out = buildNpm1Output(context)
  return renderNpm1Output(out, options)
}

export function enrich(
  graph: Graph,
  options: Npm1EnrichOptions = {},
): { graph: Graph; diagnostics: Diagnostic[] } {
  const sidecar = sidecarByGraph.get(graph)
  const diagnostics = collectNpm1PeerDiagnostics(graph, sidecar)
  if (options.manifests === undefined) {
    reportNpm1MissingManifests(graph, diagnostics)
    return { graph, diagnostics }
  }
  const plan = planManifestEnrich(graph, sidecar, options.manifests)
  if (isNpm1EnrichPlanEmpty(plan)) return { graph, diagnostics }
  return applyNpm1EnrichPlan(graph, sidecar, plan, diagnostics)
}

export function optimize(
  graph: Graph,
  _options: Npm1OptimizeOptions = {},
): { graph: Graph; diagnostics: Diagnostic[] } {
  const sidecar = sidecarByGraph.get(graph)
  const result = optimizeUnreachable(graph, {
    seeds: Array.from(graph.roots()),
    compare: cmpStr,
    edgeSeparator: ' ',
    tarballInputs: node => ({
      name: node.name,
      version: node.version,
      patch: node.patch,
      source: node.source,
    }),
    skipMissingTarballs: false,
  })

  if (result.graph !== graph && sidecar !== undefined) {
    rememberSidecar(result.graph, pruneSidecar(sidecar, result.graph))
  }
  return result
}

// === PARSE ==================================================================

// === Parse helpers ==========================================================

function assertNpm1Shape(lf: Npm1Lockfile): void {
  if (lf.lockfileVersion !== 1) {
    throw new LockfileError({
      code: 'FORMAT_MISMATCH',
      message: `npm-1 adapter: expected lockfileVersion 1, got ${JSON.stringify(lf.lockfileVersion)}`,
    })
  }
  if (lf.packages !== undefined && lf.packages !== null) {
    throw new LockfileError({
      code: 'FORMAT_MISMATCH',
      message: 'npm-1 adapter: input carries flat "packages" map; route to npm-2/npm-3',
    })
  }
}

function createNpm1ParseContext(lf: Npm1Lockfile): Npm1ParseContext {
  const builder = newBuilder()
  const rootName = lf.name ?? ''
  const rootVersion = lf.version ?? '0.0.0'
  const rootId = `${rootName}@${rootVersion}`
  builder.addNode({
    id: rootId,
    name: rootName,
    version: rootVersion,
    peerContext: [],
    workspacePath: '',
  })
  return {
    lf,
    builder,
    diagnostics: [],
    nodeSidecar: new Map<string, NpmFlatSidecar>(),
    edgeRanges: new Map<string, string>(),
    edgeDeclaredNames: new Map<string, string>(),
    seenIds: new Set<string>(),
    parentScopes: [],
    rootId,
  }
}

function addNpm1TreeNodes(context: Npm1ParseContext, frame: Npm1WalkFrame): void {
  if (frame.deps === undefined) return
  const entries = Object.entries(frame.deps).sort((a, b) => cmpStr(a[0], b[0]))
  for (const [declaredName, entry] of entries) {
    addNpm1TreeEntry(context, frame, declaredName, entry)
  }
}

function addNpm1TreeEntry(
  context: Npm1ParseContext,
  frame: Npm1WalkFrame,
  declaredName: string,
  entry: Npm1Entry,
): void {
  if (entry === null || typeof entry !== 'object') return
  if (typeof entry.version !== 'string') {
    context.diagnostics.push({
      code: 'NPM_BAD_ENTRY',
      severity: 'warning',
      message: `npm-1 entry ${JSON.stringify(declaredName)} at ${JSON.stringify(frame.parentPath)} missing version`,
    })
    return
  }
  const identity = npm1EntryIdentity(declaredName, entry.version, entry, frame.parentPath)
  addNpm1EntryNode(context, declaredName, entry, identity)
  const flags = updateNpm1EntrySidecar(context, entry, identity, frame)
  addNpm1EntryEdges(context, frame.deps!, entry, identity)
  context.parentScopes.push(frame.deps!)
  addNpm1TreeNodes(context, {
    deps: entry.dependencies,
    parentPath: identity.installPath,
    inheritedDev: flags.isDev,
    inheritedOptional: flags.isOptional,
  })
  context.parentScopes.pop()
}

function npm1EntryIdentity(
  declaredName: string,
  version: string,
  entry: Npm1Entry,
  parentPath: string,
): Npm1EntryIdentity {
  const resolved = entry.resolved ?? (isUrlLikeVersion(version) ? version : undefined)
  const source = resolved !== undefined
    ? sourceDiscriminatorOf(parseResolutionRecipe(resolved, { sourceKind: 'npm-resolved' }))
    : undefined
  return {
    id: serializeNodeId(declaredName, version, [], undefined, source),
    version,
    resolved,
    source,
    installPath: parentPath === ''
      ? `node_modules/${declaredName}`
      : `${parentPath}/node_modules/${declaredName}`,
  }
}

function addNpm1EntryNode(
  context: Npm1ParseContext,
  declaredName: string,
  entry: Npm1Entry,
  identity: Npm1EntryIdentity,
): void {
  if (context.seenIds.has(identity.id)) return
  context.seenIds.add(identity.id)
  const node: Node = {
    id: identity.id,
    name: declaredName,
    version: identity.version,
    peerContext: [],
  }
  if (identity.source !== undefined) node.source = identity.source
  context.builder.addNode(node)
  const payload = npm1TarballPayload(context, entry, identity)
  if (Object.keys(payload).length > 0) {
    context.builder.setTarball(
      { name: declaredName, version: identity.version, source: identity.source },
      payload,
    )
  }
}

function npm1TarballPayload(
  context: Npm1ParseContext,
  entry: Npm1Entry,
  identity: Npm1EntryIdentity,
): TarballPayload {
  const payload: TarballPayload = {}
  if (entry.integrity !== undefined) {
    const integrity = parseSri(entry.integrity, 'sri')
    if (!isEmptyIntegrity(integrity)) payload.integrity = integrity
  }
  if (identity.resolved === undefined) return payload
  payload.nativeResolution = identity.resolved
  const canonical = parseResolutionRecipe(identity.resolved, { sourceKind: 'npm-resolved' })
  if (canonical.type === 'unknown') {
    context.diagnostics.push({
      code: 'RECIPE_RESOLUTION_UNKNOWN',
      severity: 'warning',
      subject: identity.id,
      message: `resolution shape not canonicalizable: ${JSON.stringify(identity.resolved)}`,
    })
  }
  payload.resolution = canonical
  return payload
}

function updateNpm1EntrySidecar(
  context: Npm1ParseContext,
  entry: Npm1Entry,
  identity: Npm1EntryIdentity,
  frame: Npm1WalkFrame,
): Readonly<{ isDev: boolean; isOptional: boolean }> {
  const sc = ensureSidecar(context.nodeSidecar, identity.id)
  sc.installPaths.push(identity.installPath)
  const isDev = entry.dev === true || frame.inheritedDev
  const isOptional = entry.optional === true || frame.inheritedOptional
  if (isDev) sc.dev = true
  if (isOptional) sc.optional = true
  if (entry.bundled === true) sc.inBundle = true
  if (entry.peerDependencies !== undefined) sc.peerDependencies = { ...entry.peerDependencies }
  return { isDev, isOptional }
}

function addNpm1EntryEdges(
  context: Npm1ParseContext,
  deps: Record<string, Npm1Entry>,
  entry: Npm1Entry,
  identity: Npm1EntryIdentity,
): void {
  const requires = collectRequires(entry)
  if (requires === undefined) return
  for (const [reqName, range] of Object.entries(requires).sort((a, b) => cmpStr(a[0], b[0]))) {
    const target = resolveTreeTarget(reqName, identity.installPath, deps, context.parentScopes)
    if (target === undefined) {
      context.diagnostics.push({
        code: 'NPM_UNRESOLVED_DEP',
        severity: 'warning',
        subject: identity.id,
        message: `${identity.id}: unresolved dep ${reqName}@${range}`,
      })
      continue
    }
    addNpm1DependencyEdge(context, identity.id, target, range, reqName)
  }
}

function addNpm1DependencyEdge(
  context: Npm1ParseContext,
  src: string,
  target: string,
  range: string,
  declaredName: string,
): void {
  const edgeKey = edgeTripleKey(src, 'dep', target)
  if (context.edgeRanges.has(edgeKey)) return
  context.edgeRanges.set(edgeKey, range)
  context.edgeDeclaredNames.set(edgeKey, declaredName)
  try {
    context.builder.addEdge(src, target, 'dep', { range })
  } catch (error) {
    if (error instanceof GraphError && error.code === 'INVARIANT_VIOLATION') return
    throw error
  }
}

function addNpm1RootEdges(context: Npm1ParseContext): void {
  if (context.lf.dependencies === undefined) return
  const entries = Object.entries(context.lf.dependencies).sort((a, b) => cmpStr(a[0], b[0]))
  for (const [declaredName, entry] of entries) {
    if (entry === null || typeof entry !== 'object' || typeof entry.version !== 'string') continue
    const dstId = `${declaredName}@${entry.version}`
    if (!context.seenIds.has(dstId)) continue
    addNpm1DependencyEdge(context, context.rootId, dstId, entry.version, declaredName)
  }
}

function normalizeNpm1InstallPaths(context: Npm1ParseContext): void {
  for (const sc of context.nodeSidecar.values()) {
    sc.installPaths = Array.from(new Set(sc.installPaths)).sort(cmpStr)
  }
}

function sealNpm1Parse(context: Npm1ParseContext): Graph {
  for (const diagnostic of context.diagnostics) context.builder.diagnostic(diagnostic)
  try {
    const graph = context.builder.seal()
    rememberSidecar(graph, {
      rootId: context.rootId,
      rootMeta: {
        name: context.lf.name,
        version: context.lf.version,
        requires: context.lf.requires,
      },
      edgeRanges: context.edgeRanges,
      edgeDeclaredNames: context.edgeDeclaredNames,
      nodes: context.nodeSidecar,
      workspaceByPath: new Map<string, string>(),
    })
    return graph
  } catch (error) {
    if (error instanceof GraphError) {
      throw new LockfileError({
        code: 'PARSE_FAILED',
        message: `npm-1 seal failed: ${error.message}`,
      })
    }
    throw error
  }
}

function parseJson(input: string): Npm1Lockfile {
  let parsed: unknown
  try {
    parsed = JSON.parse(input)
  } catch (error) {
    throw new LockfileError({
      code: 'FORMAT_MISMATCH',
      message: `npm-1 adapter: input is not valid JSON: ${(error as Error).message}`,
      cause: error,
    })
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new LockfileError({
      code: 'FORMAT_MISMATCH',
      message: 'npm-1 adapter: top-level value must be a JSON object',
    })
  }
  return parsed as Npm1Lockfile
}

function ensureSidecar(map: Map<string, NpmFlatSidecar>, id: string): NpmFlatSidecar {
  let sc = map.get(id)
  if (sc === undefined) {
    sc = { installPaths: [] }
    map.set(id, sc)
  }
  return sc
}

function collectRequires(entry: Npm1Entry): Record<string, string> | undefined {
  if (entry.requires !== undefined) return entry.requires
  // Fall back: legacy npm v5 fixtures sometimes encode declared deps via
  // the nested `dependencies` block alone (with version pin as range).
  if (entry.dependencies !== undefined) {
    const out: Record<string, string> = {}
    for (const [name, child] of Object.entries(entry.dependencies)) {
      if (child !== null && typeof child === 'object' && typeof child.version === 'string') {
        out[name] = child.version
      }
    }
    return Object.keys(out).length > 0 ? out : undefined
  }
  return undefined
}

function isUrlLikeVersion(version: string): boolean {
  return version.startsWith('git+')
    || version.startsWith('git:')
    || version.startsWith('http://')
    || version.startsWith('https://')
    || version.startsWith('github:')
    || version.startsWith('file:')
}

// Resolve a `requires` target to the closest hoisted parent. The
// resolution chain mirrors npm v6's `findDependency`: try current scope
// first, then walk ancestor scopes outward. Returns the matched NodeId
// or undefined.
function resolveTreeTarget(
  name: string,
  _installPath: string,
  currentDeps: Record<string, Npm1Entry>,
  parentScopes: Array<Record<string, Npm1Entry>>,
): string | undefined {
  if (currentDeps[name] !== undefined && typeof currentDeps[name].version === 'string') {
    return `${name}@${currentDeps[name].version}`
  }
  for (let i = parentScopes.length - 1; i >= 0; i--) {
    const scope = parentScopes[i]
    if (scope === undefined) continue
    const entry = scope[name]
    if (entry !== undefined && typeof entry.version === 'string') {
      return `${name}@${entry.version}`
    }
  }
  return undefined
}

// === SERIALIZE ==============================================================

export function buildDependenciesTree(
  graph: Graph,
  sidecar: NpmSidecar | undefined,
  rootId: string,
  emittableIds: ReadonlySet<string>,
): Record<string, Npm1Entry> | undefined {
  // First, plan placements. `placements: Map<NodeId, parentPath>`. The empty
  // string parentPath means top-level. Placement comes from either the sidecar
  // installPaths (parse-time hint) or the BFS-with-conflict-resolution
  // fallback (mutator state).
  const placements = new Map<string, Set<string>>()
  const hoistedByName = new Map<string, string>() // top-level name -> NodeId

  replayNpm1InstallPaths(graph, sidecar, emittableIds, placements, hoistedByName)
  placeReachableNpm1Nodes(graph, sidecar, rootId, emittableIds, placements, hoistedByName)
  placeOrphanNpm1Nodes(emittableIds, placements)
  const treeByParent = npm1TreeByParent(graph, placements)

  const top = treeByParent.get('')
  if (top === undefined || top.size === 0) {
    // Root may also have no out-edges (workspaces-only graph); return empty.
    if (emittableIds.size === 0) return undefined
    return {}
  }

  return buildLayer(top, '', graph, sidecar, treeByParent)
}

export function parentPathFromInstall(installPath: string): string | undefined {
  // Strip the trailing `/node_modules/<name>` segment.
  const idx = installPath.lastIndexOf('/node_modules/')
  if (idx < 0) {
    // Top-level — `node_modules/<name>` becomes parent = ''.
    if (installPath.startsWith('node_modules/')) return ''
    return undefined
  }
  return installPath.slice(0, idx)
}

export function firstConsumerInstallPath(
  graph: Graph,
  sidecar: NpmSidecar | undefined,
  id: string,
  emittableIds: ReadonlySet<string>,
): string | undefined {
  // Find an incoming edge from an emittable consumer; return that consumer's
  // first install path + `/node_modules/<name>`. Used when a node conflicts
  // at root and needs to be placed inside its consumer's nested tree.
  const node = graph.getNode(id)
  if (node === undefined) return undefined
  for (const incoming of graph.in(id)) {
    if (incoming.kind === 'peer') continue
    if (!emittableIds.has(incoming.src)) continue
    const consumer = graph.getNode(incoming.src)
    if (consumer === undefined) continue
    if (consumer.workspacePath === '') continue // root — already handled
    const consumerPaths = sidecar?.nodes.get(consumer.id)?.installPaths ?? []
    if (consumerPaths.length === 0) continue
    return `${consumerPaths[0]}/node_modules/${node.name}`
  }
  return undefined
}

function createNpm1StringifyContext(
  graph: Graph,
  options: Npm1StringifyOptions,
): Npm1StringifyContext {
  const sidecar = sidecarByGraph.get(graph)
  const rootNode = locateRootNode(graph, sidecar)
  return {
    graph,
    sidecar,
    emitDiagnostic: diagnostic => options.onDiagnostic?.(diagnostic),
    warnedPeerVirt: new Set<string>(),
    warnedPatches: new Set<string>(),
    warnedPeerEdges: new Set<string>(),
    warnedWorkspaces: new Set<string>(),
    emittableIds: new Set<string>(),
    rootNode,
    rootName: sidecar?.rootMeta?.name ?? rootNode?.name ?? '',
    rootVersion: sidecar?.rootMeta?.version ?? rootNode?.version ?? '0.0.0',
  }
}

function collectNpm1EmittableNodes(context: Npm1StringifyContext): void {
  for (const node of context.graph.nodes()) {
    reportPatchDrop(node, context.warnedPatches, context.emitDiagnostic)
    reportPeerContextFlatten(node, context.warnedPeerVirt, context.emitDiagnostic)
    if (context.rootNode !== undefined && node.id === context.rootNode.id) continue
    if (node.workspacePath !== undefined && node.workspacePath !== '') {
      reportNpm1WorkspaceDrop(context, node)
      continue
    }
    context.emittableIds.add(node.id)
  }
}

function reportNpm1WorkspaceDrop(context: Npm1StringifyContext, node: Node): void {
  if (context.warnedWorkspaces.has(node.id)) return
  context.warnedWorkspaces.add(node.id)
  context.emitDiagnostic({
    code: 'NPM_V1_WORKSPACES_UNSAFE',
    severity: 'warning',
    subject: node.id,
    message: `workspace member ${node.id} at ${JSON.stringify(node.workspacePath)} is unsupported in npm-1; omitting from emit`,
  })
  recipeEmitDropped(
    node.id,
    'workspace',
    'npm-1 has no workspace primitive (ADR-0021 §A.npm-1)',
    context.emitDiagnostic,
  )
}

function reportNpm1PeerEdgeDrops(context: Npm1StringifyContext): void {
  for (const node of context.graph.nodes()) {
    for (const edge of context.graph.out(node.id, 'peer')) reportNpm1PeerEdgeDrop(context, edge)
  }
}

function reportNpm1PeerEdgeDrop(context: Npm1StringifyContext, edge: Edge): void {
  const key = `${edge.src}\u0000${edge.dst}\u0000${edge.attrs?.range ?? ''}`
  if (context.warnedPeerEdges.has(key)) return
  context.warnedPeerEdges.add(key)
  const dst = context.graph.getNode(edge.dst)
  context.emitDiagnostic({
    code: 'NPM_V1_PEER_DROPPED',
    severity: 'warning',
    subject: edge.src,
    message: dst === undefined || edge.attrs?.range === undefined
      ? `peer edge ${edge.src} -> ${edge.dst} is unsupported in npm-1; dropping on emit`
      : `peer edge ${edge.src} -> ${dst.name}@${edge.attrs.range} is unsupported in npm-1; dropping on emit`,
  })
}

function buildNpm1Output(context: Npm1StringifyContext): Record<string, unknown> {
  const rootId = context.rootNode?.id ?? `${context.rootName}@${context.rootVersion}`
  const dependencies = buildDependenciesTree(
    context.graph,
    context.sidecar,
    rootId,
    context.emittableIds,
  )
  const out: Record<string, unknown> = {
    name: context.rootName,
    version: context.rootVersion,
    lockfileVersion: 1,
    requires: context.sidecar?.rootMeta?.requires ?? true,
  }
  if (dependencies !== undefined && Object.keys(dependencies).length > 0) {
    out.dependencies = sortRecord(dependencies)
  } else if (context.emittableIds.size === 0 && context.warnedWorkspaces.size > 0) {
    delete out.requires
  }
  return out
}

function renderNpm1Output(out: Record<string, unknown>, options: Npm1StringifyOptions): string {
  const text = stringifyNpmLock(out)
  return options.lineEnding === 'crlf' ? text.replace(/\n/g, '\r\n') : text
}

function isHttpUrl(value: string): boolean {
  return value.startsWith('https://') || value.startsWith('http://')
}

function locateRootNode(graph: Graph, sidecar: NpmSidecar | undefined): Node | undefined {
  if (sidecar?.rootId !== undefined) {
    const node = graph.getNode(sidecar.rootId)
    if (node !== undefined) return node
  }
  for (const node of graph.nodes()) {
    if (node.workspacePath === '') return node
  }
  const roots = Array.from(graph.roots())
  if (roots.length === 1) {
    const sole = roots[0]
    if (sole !== undefined) return graph.getNode(sole)
  }
  return undefined
}

// === Tree placement =========================================================

function replayNpm1InstallPaths(
  graph: Graph,
  sidecar: NpmSidecar | undefined,
  emittableIds: ReadonlySet<string>,
  placements: Map<string, Set<string>>,
  hoistedByName: Map<string, string>,
): void {
  if (sidecar === undefined) return
  for (const [nodeId, sc] of sidecar.nodes) {
    if (!emittableIds.has(nodeId)) continue
    for (const installPath of sc.installPaths) {
      const parentPath = parentPathFromInstall(installPath)
      if (parentPath === undefined) continue
      ensureSet(placements, nodeId).add(parentPath)
      if (parentPath === '') {
        const node = graph.getNode(nodeId)
        if (node !== undefined) hoistedByName.set(node.name, nodeId)
      }
    }
  }
}

function seedNpm1PlacementQueue(
  graph: Graph,
  rootId: string,
  emittableIds: ReadonlySet<string>,
): PlacementQueueItem[] {
  const queue: PlacementQueueItem[] = []
  const seenRoot = new Set<string>()
  for (const edge of graph.out(rootId)) {
    if (edge.kind === 'peer') continue
    const dst = graph.getNode(edge.dst)
    if (dst === undefined) continue
    if (!emittableIds.has(edge.dst)) continue
    if (seenRoot.has(edge.dst)) continue
    seenRoot.add(edge.dst)
    queue.push({ id: edge.dst, parentPath: '' })
  }
  return queue
}

function chooseNpm1Placement(
  graph: Graph,
  sidecar: NpmSidecar | undefined,
  emittableIds: ReadonlySet<string>,
  placements: Map<string, Set<string>>,
  hoistedByName: Map<string, string>,
  node: Node,
  parentPath: string,
): string {
  let chosen = parentPath
  const existingAt = hoistedAtPath(hoistedByName, placements, graph, chosen, node.name)
  if (existingAt !== undefined && existingAt !== node.id) {
    // Conflict at chosen level; place during parent (de-hoist).
    chosen = parentPath
    if (chosen === '') {
      // Root-level conflicts de-hoist under the first incoming consumer's
      // install path.
      const consumerPath = firstConsumerInstallPath(graph, sidecar, node.id, emittableIds)
      if (consumerPath !== undefined) chosen = consumerPath
    }
  } else if (chosen === '') {
    hoistedByName.set(node.name, node.id)
  }
  return chosen
}

function placeNpm1Node(
  graph: Graph,
  sidecar: NpmSidecar | undefined,
  emittableIds: ReadonlySet<string>,
  placements: Map<string, Set<string>>,
  hoistedByName: Map<string, string>,
  node: Node,
  parentPath: string,
): void {
  if (placements.has(node.id) && placements.get(node.id)!.size > 0) return
  const chosen = chooseNpm1Placement(
    graph, sidecar, emittableIds, placements, hoistedByName, node, parentPath,
  )
  ensureSet(placements, node.id).add(chosen)
}

function enqueueNpm1Children(
  graph: Graph,
  emittableIds: ReadonlySet<string>,
  placements: Map<string, Set<string>>,
  rootId: string,
  node: Node,
  queue: PlacementQueueItem[],
): void {
  const chosenSet = placements.get(node.id)!
  const childParent = chooseDeepest(chosenSet)
  const childInstallPath = childParent === ''
    ? `node_modules/${node.name}`
    : `${childParent}/node_modules/${node.name}`
  for (const edge of graph.out(node.id)) {
    if (edge.kind === 'peer') continue
    const dst = graph.getNode(edge.dst)
    if (dst === undefined) continue
    if (!emittableIds.has(edge.dst)) continue
    if (edge.dst === rootId) continue
    queue.push({ id: edge.dst, parentPath: childInstallPath })
  }
}

function placeReachableNpm1Nodes(
  graph: Graph,
  sidecar: NpmSidecar | undefined,
  rootId: string,
  emittableIds: ReadonlySet<string>,
  placements: Map<string, Set<string>>,
  hoistedByName: Map<string, string>,
): void {
  const queue = seedNpm1PlacementQueue(graph, rootId, emittableIds)
  const visited = new Set<string>()
  while (queue.length > 0) {
    const { id, parentPath } = queue.shift()!
    if (visited.has(`${id}|${parentPath}`)) continue
    visited.add(`${id}|${parentPath}`)
    const node = graph.getNode(id)
    if (node === undefined) continue
    placeNpm1Node(graph, sidecar, emittableIds, placements, hoistedByName, node, parentPath)
    enqueueNpm1Children(graph, emittableIds, placements, rootId, node, queue)
  }
}

function placeOrphanNpm1Nodes(emittableIds: ReadonlySet<string>, placements: Map<string, Set<string>>): void {
  for (const id of emittableIds) {
    if (placements.has(id) && placements.get(id)!.size > 0) continue
    ensureSet(placements, id).add('')
  }
}

function npm1TreeByParent(graph: Graph, placements: Map<string, Set<string>>): Map<string, Map<string, string>> {
  const treeByParent = new Map<string, Map<string, string>>()
  for (const [id, parentSet] of placements) {
    for (const parentPath of parentSet) {
      const layer = ensureMap(treeByParent, parentPath)
      const node = graph.getNode(id)
      if (node === undefined) continue
      layer.set(node.name, id)
    }
  }
  return treeByParent
}

function buildLayer(
  layer: Map<string, string>,
  parentPath: string,
  graph: Graph,
  sidecar: NpmSidecar | undefined,
  treeByParent: Map<string, Map<string, string>>,
): Record<string, Npm1Entry> {
  const out: Record<string, Npm1Entry> = {}
  for (const [name, id] of layer) {
    const node = graph.getNode(id)
    if (node === undefined) continue
    out[name] = buildEntry(node, parentPath === '' ? `node_modules/${name}` : `${parentPath}/node_modules/${name}`, graph, sidecar, treeByParent)
  }
  return sortRecord(out)
}

function buildEntry(
  node: Node,
  installPath: string,
  graph: Graph,
  sidecar: NpmSidecar | undefined,
  treeByParent: Map<string, Map<string, string>>,
): Npm1Entry {
  const entry: Npm1Entry = { version: node.version }
  const nodeSide = sidecar?.nodes.get(node.id)

  // Resolved / from / integrity. npm v6 convention: git/github resolutions
  // live in `version` directly (`version: "git+https://..."`); direct tarball
  // URLs (`https://.../<tgz>`) live in `version` IFF the node's version was
  // parsed as a URL (preserving the parse-time shape per ADR-0021 §A.npm-1);
  // otherwise the URL goes under `resolved`.
  const tarball = graph.tarballOf(node.id)
  // ADR-0014 §4.F3 cross-format fallback: when PM-native `nativeResolution`
  // is absent (cross-format input), derive from canonical.
  const native = tarball?.nativeResolution
  const resolutionStr = (native !== undefined && !isYarnBerryLocator(native) ? native : undefined)
    ?? deriveResolvedFromCanonical(tarball?.resolution)
  // A yarn-berry locator that leaked from a cross-format source (a `patch:` /
  // `::`-bound shape the canonical could not reduce to a URL) is not a valid npm
  // `resolved`/`version` — skip it (npm re-resolves from the range) so the lock
  // stays structurally valid.
  if (resolutionStr !== undefined && !isYarnBerryLocator(resolutionStr)) {
    if (/^(git[+:]|github:)/.test(resolutionStr)) {
      entry.version = resolutionStr
    } else if (isHttpUrl(resolutionStr) && isHttpUrl(node.version)) {
      entry.version = node.version
    } else {
      entry.resolved = stripRegistrySha1Fragment(resolutionStr)
    }
  }
  if (!/^(git[+:]|github:)/.test(entry.version ?? '')) {
    const sri = emitSriForRegistry(tarball?.integrity, native)
    if (sri !== undefined) entry.integrity = sri
  }
  if (nodeSide?.dev === true) entry.dev = true
  if (nodeSide?.optional === true) entry.optional = true
  if (nodeSide?.inBundle === true) entry.bundled = true

  // `requires` block — dep / dev / optional edges out, excluding peers
  // (npm-1 has no peer-block; peer edges drop with NPM_V1_PEER_DROPPED).
  const requires: Record<string, string> = {}
  for (const edge of graph.out(node.id)) {
    if (edge.kind === 'peer') continue
    const range = edge.attrs?.[NPM_EDGE_RANGE_ATTR]
    if (typeof range !== 'string') continue
    const dst = graph.getNode(edge.dst)
    if (dst === undefined) continue
    const edgeKey = edgeTripleKey(edge.src, edge.kind, edge.dst)
    const declaredName = sidecar?.edgeDeclaredNames.get(edgeKey) ?? dst.name
    requires[declaredName] = range
  }
  if (Object.keys(requires).length > 0) entry.requires = sortRecord(requires)

  // Nested dependencies under this entry's install path.
  const nestedLayer = treeByParent.get(installPath)
  if (nestedLayer !== undefined && nestedLayer.size > 0) {
    entry.dependencies = buildLayer(nestedLayer, installPath, graph, sidecar, treeByParent)
  }

  return entry
}

// ADR-0014 §4.F3 — project canonical resolution → npm-1 `resolved` URL.
// Workspace canonical returns undefined (npm-1 predates workspaces).
function deriveResolvedFromCanonical(canonical: ResolutionCanonical | undefined): string | undefined {
  if (canonical === undefined) return undefined
  return stringifyForNpm(canonical)
}

function ensureSet<K>(map: Map<K, Set<string>>, key: K): Set<string> {
  let s = map.get(key)
  if (s === undefined) {
    s = new Set<string>()
    map.set(key, s)
  }
  return s
}

function ensureMap<K, V>(map: Map<K, Map<string, V>>, key: K): Map<string, V> {
  let s = map.get(key)
  if (s === undefined) {
    s = new Map<string, V>()
    map.set(key, s)
  }
  return s
}

function chooseDeepest(set: Set<string>): string {
  let deepest = ''
  let depth = -1
  for (const path of set) {
    const d = path === '' ? 0 : path.split('/node_modules/').length
    if (d > depth) {
      depth = d
      deepest = path
    }
  }
  return deepest
}

function hoistedAtPath(
  hoistedByName: Map<string, string>,
  placements: Map<string, Set<string>>,
  graph: Graph,
  parentPath: string,
  name: string,
): string | undefined {
  if (parentPath === '') {
    return hoistedByName.get(name)
  }
  // Walk all known placements; find any with parentPath matching and name equal.
  for (const [id, pSet] of placements) {
    if (!pSet.has(parentPath)) continue
    const node = graph.getNode(id)
    if (node !== undefined && node.name === name) return id
  }
  return undefined
}

// === Loss diagnostics =======================================================

function reportPeerContextFlatten(
  node: Node,
  warned: Set<string>,
  emitDiagnostic: (diagnostic: Diagnostic) => void,
): void {
  if (node.peerContext.length === 0 || warned.has(node.id)) return
  warned.add(node.id)
  emitDiagnostic({
    code: 'NPM_V1_PEER_VIRT_FLATTENED',
    severity: 'warning',
    subject: node.id,
    message: `peerContext ${JSON.stringify(node.peerContext)} is unsupported in npm-1; flattening on emit`,
  })
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
    `npm-1 has no patch: protocol; ${JSON.stringify(node.patch)} dropped`,
    emitDiagnostic,
  )
}

// === ENRICH =================================================================

function collectNpm1PeerDiagnostics(
  graph: Graph,
  sidecar: NpmSidecar | undefined,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = []
  for (const node of graph.nodes()) {
    const rawPeers = sidecar?.nodes.get(node.id)?.peerDependencies
    if (rawPeers === undefined) continue
    for (const [peerName, range] of Object.entries(rawPeers).sort((a, b) => cmpStr(a[0], b[0]))) {
      const outcome = derivePeerCandidates(graph, peerName, range)
      if (outcome.kind === 'single') continue
      diagnostics.push(outcome.kind === 'unsatisfied'
        ? {
            code: 'NPM_V1_PEER_UNSATISFIED',
            severity: 'warning',
            subject: node.id,
            message: `peer "${peerName}" range "${range}" matches no installed version`,
          }
        : {
            code: 'NPM_V1_PEER_AMBIGUOUS',
            severity: 'warning',
            subject: node.id,
            message: `peer "${peerName}" range "${range}" matches multiple candidates: ${outcome.candidates.join(', ')}`,
          })
    }
  }
  return diagnostics
}

function reportNpm1MissingManifests(graph: Graph, diagnostics: Diagnostic[]): void {
  const hasWorkspaceHint = Array.from(graph.nodes())
    .some(node => node.workspacePath !== undefined && node.workspacePath !== '')
  if (!hasWorkspaceHint) return
  diagnostics.push({
    code: 'NPM_V1_NO_MANIFESTS',
    severity: 'warning',
    message: 'workspace concretisation requires manifests; leaving npm-1 graph unclassified',
  })
}

function isNpm1EnrichPlanEmpty(plan: EnrichPlan): boolean {
  return plan.rootNodeReplacement === undefined
    && plan.addRootEdges.length === 0
    && plan.removeRootEdges.length === 0
    && plan.markWorkspaceEdges.length === 0
    && plan.memberNodeReplacements.length === 0
    && plan.addMemberNodes.length === 0
}

function applyNpm1EnrichPlan(
  graph: Graph,
  sidecar: NpmSidecar | undefined,
  plan: EnrichPlan,
  diagnostics: Diagnostic[],
): { graph: Graph; diagnostics: Diagnostic[] } {
  const result = graph.mutate(m => {
    if (plan.rootNodeReplacement !== undefined) {
      m.replaceNode(plan.rootNodeReplacement.id, plan.rootNodeReplacement)
    }
    for (const node of plan.addMemberNodes) m.addNode(node)
    for (const replacement of plan.memberNodeReplacements) {
      m.replaceNode(replacement.id, replacement)
    }
    for (const edge of plan.removeRootEdges) m.removeEdge(edge.src, edge.dst, edge.kind)
    for (const edge of plan.addRootEdges) m.addEdge(edge.src, edge.dst, edge.kind, edge.attrs)
    for (const edge of plan.markWorkspaceEdges) {
      m.removeEdge(edge.src, edge.dst, edge.kind)
      m.addEdge(edge.src, edge.dst, edge.kind, edge.attrs)
    }
  })
  if (sidecar !== undefined) rememberSidecar(result.graph, sidecar)
  return { graph: result.graph, diagnostics }
}

// === Planning ===============================================================

function emptyNpm1EnrichPlan(): EnrichPlan {
  return {
    rootNodeReplacement: undefined,
    addMemberNodes: [],
    memberNodeReplacements: [],
    addRootEdges: [],
    removeRootEdges: [],
    markWorkspaceEdges: [],
  }
}

function npm1MemberManifests(manifests: Record<string, Npm1Manifest>): Map<string, Npm1MemberManifest> {
  const memberByName = new Map<string, Npm1MemberManifest>()
  for (const [path, manifest] of Object.entries(manifests)) {
    if (path === '' || manifest.name === undefined) continue
    memberByName.set(manifest.name, { path, manifest })
  }
  return memberByName
}

function planExistingNpm1Members(
  graph: Graph,
  memberByName: ReadonlyMap<string, Npm1MemberManifest>,
  plan: EnrichPlan,
): void {
  for (const node of graph.nodes()) {
    if (node.workspacePath !== undefined) continue
    const member = memberByName.get(node.name)
    if (member === undefined) continue
    if (member.manifest.version !== undefined && node.version !== member.manifest.version) continue
    if (graph.tarballOf(node.id) !== undefined) continue
    plan.memberNodeReplacements.push({ ...node, workspacePath: member.path })
  }
}

function planMissingNpm1Members(
  graph: Graph,
  memberByName: ReadonlyMap<string, Npm1MemberManifest>,
  plan: EnrichPlan,
): void {
  for (const [name, { path, manifest }] of memberByName) {
    const memberVersion = manifest.version ?? '0.0.0'
    const memberId = `${name}@${memberVersion}`
    const existing = graph.getNode(memberId)
    if (existing !== undefined) {
      if (existing.workspacePath === path) continue
      plan.memberNodeReplacements.push({ ...existing, workspacePath: path })
      continue
    }
    if (plan.memberNodeReplacements.some(n => n.id === memberId)) continue
    plan.addMemberNodes.push({
      id: memberId,
      name,
      version: memberVersion,
      peerContext: [],
      workspacePath: path,
    })
  }
}

function prospectiveNpm1MemberIds(plan: EnrichPlan): Set<string> {
  const prospectiveIds = new Set<string>()
  for (const node of plan.addMemberNodes) prospectiveIds.add(node.id)
  for (const node of plan.memberNodeReplacements) prospectiveIds.add(node.id)
  return prospectiveIds
}

function desiredNpm1RootEdges(
  graph: Graph,
  rootNodeId: string,
  rootManifest: Npm1Manifest,
  memberByName: Map<string, Npm1MemberManifest>,
  prospectiveIds: ReadonlySet<string>,
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
      const dstId = resolveManifestTarget(graph, name, range, memberByName, prospectiveIds)
      if (dstId === undefined) continue
      const attrs: { range: string; workspace?: boolean } = { range }
      if (isWorkspaceProtocolRange(range) || memberByName.has(name)) attrs.workspace = true
      desired.push({ src: rootNodeId, dst: dstId, kind, attrs })
    }
  }
  return desired
}

function planNpm1RootEdges(
  graph: Graph,
  rootNodeId: string | undefined,
  rootManifest: Npm1Manifest | undefined,
  memberByName: Map<string, Npm1MemberManifest>,
  prospectiveIds: ReadonlySet<string>,
  plan: EnrichPlan,
): void {
  if (rootNodeId === undefined || rootManifest === undefined) return
  const desired = desiredNpm1RootEdges(graph, rootNodeId, rootManifest, memberByName, prospectiveIds)
  const existingByDst = new Map<string, Edge[]>()
  for (const edge of graph.out(rootNodeId)) {
    const arr = existingByDst.get(edge.dst) ?? []
    arr.push(edge)
    existingByDst.set(edge.dst, arr)
  }
  for (const edge of desired) {
    const list = existingByDst.get(edge.dst) ?? []
    const match = list.some(c =>
      c.kind === edge.kind
      && c.dst === edge.dst
      && (c.attrs?.range ?? undefined) === edge.attrs?.range
      && (c.attrs?.workspace ?? undefined) === edge.attrs?.workspace,
    )
    if (!match) plan.addRootEdges.push(edge)
  }
}

function planNpm1WorkspaceEdges(
  graph: Graph,
  memberByName: ReadonlyMap<string, Npm1MemberManifest>,
  plan: EnrichPlan,
): void {
  for (const node of graph.nodes()) {
    for (const edge of graph.out(node.id)) {
      if (edge.kind === 'peer') continue
      if (edge.attrs?.workspace === true) continue
      const dst = graph.getNode(edge.dst)
      if (dst === undefined) continue
      if (!memberByName.has(dst.name)) continue
      const willBeMember = plan.memberNodeReplacements.some(n => n.id === edge.dst)
        || plan.addMemberNodes.some(n => n.id === edge.dst)
        || dst.workspacePath !== undefined
      if (!willBeMember) continue
      plan.markWorkspaceEdges.push({
        src: edge.src,
        dst: edge.dst,
        kind: edge.kind,
        attrs: { ...edge.attrs, workspace: true },
      })
    }
  }
}

function planManifestEnrich(
  graph: Graph,
  sidecar: NpmSidecar | undefined,
  manifests: Record<string, Npm1Manifest>,
): EnrichPlan {
  const rootManifest = manifests['']
  const rootNodeId = sidecar?.rootId
  const existingRoot = rootNodeId !== undefined ? graph.getNode(rootNodeId) : undefined
  const plan = emptyNpm1EnrichPlan()
  const memberByName = npm1MemberManifests(manifests)
  planExistingNpm1Members(graph, memberByName, plan)
  planMissingNpm1Members(graph, memberByName, plan)
  const prospectiveIds = prospectiveNpm1MemberIds(plan)
  const rootForEdges = existingRoot !== undefined
    && rootNodeId !== undefined
    && rootManifest !== undefined
    ? rootNodeId
    : undefined
  planNpm1RootEdges(graph, rootForEdges, rootManifest, memberByName, prospectiveIds, plan)
  planNpm1WorkspaceEdges(graph, memberByName, plan)
  if (existingRoot !== undefined && existingRoot.workspacePath === undefined) {
    plan.rootNodeReplacement = { ...existingRoot, workspacePath: '' }
  }
  return plan
}

function resolveManifestTarget(
  graph: Graph,
  name: string,
  range: string,
  memberByName: Map<string, { path: string; manifest: Npm1Manifest }>,
  prospectiveIds: ReadonlySet<string>,
): string | undefined {
  if (isWorkspaceProtocolRange(range) || memberByName.has(name)) {
    const member = memberByName.get(name)
    if (member !== undefined) {
      const memberVersion = member.manifest.version ?? '0.0.0'
      const memberId = `${name}@${memberVersion}`
      const candidate = graph.getNode(memberId)
      if (candidate !== undefined) return candidate.id
      // Member node will be synthesized by the surrounding plan; bind to it
      // prospectively so the desired-root-edge can be created.
      if (prospectiveIds.has(memberId)) return memberId
    }
  }
  // Lookup by exact (name, range) match — npm-1 ranges happen to be exact
  // version pins in many fixtures.
  const candidates = graph.byName(name)
  if (candidates.length === 1) return candidates[0]
  return candidates.find(id => graph.getNode(id)?.version === range)
}

function isWorkspaceProtocolRange(range: string): boolean {
  return range.startsWith('workspace:')
}
