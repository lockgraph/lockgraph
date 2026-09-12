// _npm-2-mirror.ts — npm-2 dual-mode reconciliation + legacy mirror.
//
// npm-2-only logic split out of `_npm-core.ts` per mining
// strategy fix-up and cycle-break. The core (`_npm-core.ts`) handles
// the flat `packages` block shared with npm-3; this module owns:
//
//   - parse-time dual-mode `dependencies` requirement, with npm's exact
//     dependency-free root-only omission (validateTopLevel)
//   - parse-time dual-mode drift detection (`detectDualModeDrift`,
//     wired via `emitParseDiagnostics`)
//   - emit-time legacy `dependencies` mirror reconstruction
//     (`buildLegacyDependenciesMirror`, wired via `enrichStringifyOut`)
//   - the npm-2-only composed sidecar (`Npm2MirrorSidecar`) that captures
//     the on-disk `resolved` URL needed to replay it on both the
//     `packages` and `dependencies` blocks (npm-3 has no mirror).
//
// Dependency direction (cycle-break):
//   - this module imports ONLY from `_npm-flat-types.ts` + `../graph.ts`.
//   - it does NOT import from `_npm-core.ts`.
//   - `_npm-core.ts` does NOT import this module.
//   - `npm-2.ts` thin entry wires the hook surface together.
//
// Mirror contract per -2 *Body field schedule (legacy mirror)*:
//   - Bare-name keys at top level (no `node_modules/` prefix).
//   - `version` is the resolved version (or `file:<wsPath>` for workspace members).
//   - `resolved` / `integrity` populated for non-workspace nodes.
//   - `requires: {…}` replaces inner-block `dependencies` (the npm-1 convention).
//   - Nested `dependencies` block carries de-hoisted nested installs.
//   - No `peerDependencies` (legacy mirror is npm-1-shape).
//
// The mirror is RECONSTRUCTED FROM THE SAME GRAPH that emits the `packages`
// block, so the two are consistent by construction.

import { type Diagnostic, type Edge, type Graph, type Node } from '../graph.ts'
import { emitSriForRegistry } from '../recipe/integrity.ts'
import { LockfileError } from '../api/errors.ts'
import {
  isYarnBerryLocator,
  stringifyForNpm,
  stripRegistrySha1Fragment,
  type ResolutionCanonical,
} from '../recipe/resolution.ts'
import {
  NPM_EDGE_RANGE_ATTR,
  cmpStr,
  edgeTripleKey,
  sortRecord,
  type NpmEntry,
  type NpmFamilyHooks,
  type NpmLegacyEntry,
  type NpmLockfile,
  type NpmSidecar,
} from './_npm-flat-types.ts'

// === CONSTANTS ==============================================================

// The npm-2 hooks share one parse capture until the family parse call returns.
let currentParseCapture: Map<string, string> | undefined

// === TYPES ==================================================================

// npm-2-only composed sidecar — recovered `resolved` URLs per NodeId,
// keyed for emit-time mirror reconstruction. Absent on npm-3.
export interface Npm2MirrorSidecar {
  resolvedByNodeId: Map<string, string>
  legacyEntriesByInstallPath: Map<string, Npm2LegacyEntryCapture>
  legacyRequiresByEdge: Map<string, Npm2LegacyRequireCapture>
  // Presence, not producer preference: an explicit empty source mirror is
  // replayed only by the original parsed Graph. Rebinding clears this bit.
  sourceAuthoredEmptyMirror: boolean
}

interface Npm2LegacyEntryCapture {
  nodeId: string
  version?: string
  inBundle?: boolean
}

interface Npm2LegacyRequireCapture {
  src: string
  dst: string
  sourceRange: string
  mirrorRange: string
}

interface LegacyMirrorContext {
  graph: Graph
  sidecar: NpmSidecar | undefined
  mirrorSidecar: Npm2MirrorSidecar | undefined
  rootId: string | undefined
  // workspacePath -> NodeId for recognized workspace-symlink install paths.
  workspacePathToId: Map<string, string>
  // NodeId -> workspacePath for the reverse lookup.
  workspacePathById: Map<string, string>
}

// === SIDECAR ================================================================

// Per-graph mirror sidecar storage, independent of the core flat sidecar.
const mirrorSidecarByGraph = new WeakMap<Graph, Npm2MirrorSidecar>()

export function getMirrorSidecar(graph: Graph): Npm2MirrorSidecar | undefined {
  return mirrorSidecarByGraph.get(graph)
}

export function setMirrorSidecar(graph: Graph, sidecar: Npm2MirrorSidecar): void {
  mirrorSidecarByGraph.set(graph, sidecar)
}

export function rebindNpm2MirrorState(
  source: Graph,
  target: Graph,
): readonly string[] {
  const sidecar = mirrorSidecarByGraph.get(source)
  if (sidecar === undefined) return []
  const carriedNodeIds = new Set([
    ...sidecar.resolvedByNodeId.keys(),
    ...[...sidecar.legacyEntriesByInstallPath.values()].map(entry => entry.nodeId),
  ])
  const invalidated = [...carriedNodeIds]
    .filter(id => target.getNode(id) === undefined)
    .sort()
  NPM2_HOOKS.rebindGraph?.(source, target)
  NPM2_HOOKS.pruneToNodes?.(target, new Set([...target.nodes()].map(node => node.id)))
  return invalidated
}

// === API ====================================================================

export const NPM2_HOOKS: NpmFamilyHooks = {
  validateTopLevel(lf: NpmLockfile): void {
    const hasDependencies = lf.dependencies !== undefined
      && lf.dependencies !== null
      && typeof lf.dependencies === 'object'
      && !Array.isArray(lf.dependencies)
    if (!hasDependencies && !hasOnlyRootPackage(lf.packages)) {
      throw new LockfileError({
        code: 'FORMAT_MISMATCH',
        message: 'npm-2 adapter: top-level "dependencies" mirror is required when "packages" contains installed entries',
      })
    }
    // Begin per-parse capture buffer.
    currentParseCapture = new Map<string, string>()
  },

  captureEntry(srcId: string, entry: NpmEntry): void {
    if (currentParseCapture === undefined) return
    if (typeof entry.resolved !== 'string') return
    // First-write-wins matches npm's own behaviour for multi-path entries.
    if (currentParseCapture.has(srcId)) return
    currentParseCapture.set(srcId, entry.resolved)
  },

  emitParseDiagnostics(ctx: { lf: NpmLockfile; packages: Record<string, NpmEntry>; diagnostics: Diagnostic[] }): void {
    const { lf, packages, diagnostics } = ctx
    if (lf.dependencies === undefined) return
    const drift = detectDualModeDrift(
      packages,
      lf.dependencies as Record<string, NpmLegacyEntry>,
    )
    for (const subject of drift) {
      diagnostics.push({
        code: 'NPM_V2_DUAL_MODE_DRIFT',
        severity: 'warning',
        subject,
        message: `npm-2 dual-mode drift: "packages" and "dependencies" disagree on ${subject}; "packages" wins`,
      })
    }
  },

  afterParse(ctx): void {
    const buffer = currentParseCapture ?? new Map<string, string>()
    currentParseCapture = undefined
    const legacy = (ctx.lf.dependencies ?? {}) as Record<string, NpmLegacyEntry>
    const captured = captureLegacyMirror(ctx.graph, ctx.packages, legacy)
    mirrorSidecarByGraph.set(ctx.graph, {
      resolvedByNodeId: buffer,
      ...captured,
      sourceAuthoredEmptyMirror: ctx.lf.dependencies !== undefined
        && ctx.lf.dependencies !== null
        && typeof ctx.lf.dependencies === 'object'
        && !Array.isArray(ctx.lf.dependencies)
        && Object.keys(ctx.lf.dependencies).length === 0,
    })
  },

  enrichStringifyOut(ctx): void {
    const mirror = buildLegacyDependenciesMirror(ctx.graph, ctx.rootNode, ctx.sidecar)
    const sourceAuthoredEmpty = mirrorSidecarByGraph.get(ctx.graph)?.sourceAuthoredEmptyMirror === true
    // npm's omission is keyed to the complete output layout, not merely to
    // whether this reconstruction found a legacy entry. Rootless and
    // cross-format Graphs can emit installed packages with an empty mirror;
    // v2 still requires the explicit mirror key for those layouts.
    const outputIsRootOnly = hasOnlyRootPackage(ctx.out.packages)
    if (!outputIsRootOnly || Object.keys(mirror).length > 0 || sourceAuthoredEmpty) {
      ctx.out.dependencies = mirror
    }
  },

  recoverResolvedForNode(graph: Graph, node: Node): string | undefined {
    return mirrorSidecarByGraph.get(graph)?.resolvedByNodeId.get(node.id)
  },

  rebindGraph(oldGraph: Graph, newGraph: Graph): void {
    const existing = mirrorSidecarByGraph.get(oldGraph)
    if (existing !== undefined) {
      mirrorSidecarByGraph.set(newGraph, {
        ...existing,
        sourceAuthoredEmptyMirror: false,
      })
    }
  },

  pruneToNodes(graph: Graph, reachableNodeIds: ReadonlySet<string>): void {
    const existing = mirrorSidecarByGraph.get(graph)
    if (existing === undefined) return
    const pruned = new Map<string, string>()
    for (const [nodeId, resolved] of existing.resolvedByNodeId) {
      if (reachableNodeIds.has(nodeId)) pruned.set(nodeId, resolved)
    }
    const legacyEntriesByInstallPath = new Map<string, Npm2LegacyEntryCapture>()
    for (const [path, entry] of existing.legacyEntriesByInstallPath) {
      if (reachableNodeIds.has(entry.nodeId)) legacyEntriesByInstallPath.set(path, entry)
    }
    const legacyRequiresByEdge = new Map<string, Npm2LegacyRequireCapture>()
    for (const [key, entry] of existing.legacyRequiresByEdge) {
      if (reachableNodeIds.has(entry.src) && reachableNodeIds.has(entry.dst)) {
        legacyRequiresByEdge.set(key, entry)
      }
    }
    mirrorSidecarByGraph.set(graph, {
      resolvedByNodeId: pruned,
      legacyEntriesByInstallPath,
      legacyRequiresByEdge,
      sourceAuthoredEmptyMirror: existing.sourceAuthoredEmptyMirror,
    })
  },
}

function hasOnlyRootPackage(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const packages = value as Record<string, unknown>
  if (Object.keys(packages).length !== 1 || !Object.hasOwn(packages, '')) return false
  const root = packages['']
  return root !== null && typeof root === 'object' && !Array.isArray(root)
}

// === PARSE ==================================================================

function captureLegacyMirror(
  graph: Graph,
  packages: Record<string, NpmEntry>,
  legacy: Record<string, NpmLegacyEntry>,
): Pick<Npm2MirrorSidecar, 'legacyEntriesByInstallPath' | 'legacyRequiresByEdge'> {
  const legacyEntriesByInstallPath = new Map<string, Npm2LegacyEntryCapture>()
  const legacyRequiresByEdge = new Map<string, Npm2LegacyRequireCapture>()

  const visit = (entries: Record<string, NpmLegacyEntry>, parentPath: string): void => {
    for (const [slot, entry] of Object.entries(entries)) {
      if (entry === null || typeof entry !== 'object') continue
      const installPath = parentPath === ''
        ? `node_modules/${slot}`
        : `${parentPath}/node_modules/${slot}`
      const node = resolveLegacyEntryNode(graph, packages, installPath)
      if (node !== undefined) {
        const capture: Npm2LegacyEntryCapture = { nodeId: node.id }
        if (typeof entry.version === 'string') capture.version = entry.version
        if (packages[installPath]?.inBundle === true) capture.inBundle = true
        legacyEntriesByInstallPath.set(installPath, capture)

        for (const [declaredName, mirrorRange] of Object.entries(entry.requires ?? {})) {
          const edge = [...graph.out(node.id)].find(candidate => (
            candidate.kind !== 'peer'
            && declaredNameOf(graph, candidate) === declaredName
          ))
          const sourceRange = edge?.attrs?.[NPM_EDGE_RANGE_ATTR]
          if (edge === undefined || typeof sourceRange !== 'string') continue
          legacyRequiresByEdge.set(mirrorEdgeKey(edge), {
            src: edge.src,
            dst: edge.dst,
            sourceRange,
            mirrorRange,
          })
        }
      }
      if (entry.dependencies !== undefined) visit(entry.dependencies, installPath)
    }
  }

  visit(legacy, '')
  return { legacyEntriesByInstallPath, legacyRequiresByEdge }
}

function resolveLegacyEntryNode(
  graph: Graph,
  packages: Record<string, NpmEntry>,
  installPath: string,
): Node | undefined {
  const entry = packages[installPath]
  if (entry?.link === true && typeof entry.resolved === 'string') {
    return [...graph.nodes()].find(node => node.workspacePath === entry.resolved)
  }
  const name = entry?.name ?? installPathTail(installPath)
  const candidates = graph.byName(name)
    .map(id => graph.getNode(id))
    .filter((node): node is Node => node !== undefined)
  if (typeof entry?.version === 'string') {
    const exact = candidates.find(node => node.version === entry.version)
    if (exact !== undefined) return exact
  }
  return candidates.length === 1 ? candidates[0] : undefined
}

function mirrorEdgeKey(edge: Edge): string {
  return `${edge.src}\0${edge.kind}\0${edge.dst}\0${edge.attrs?.alias ?? ''}`
}

function declaredNameOf(graph: Graph, edge: Edge): string | undefined {
  return edge.attrs?.alias ?? graph.getNode(edge.dst)?.name
}

function installPathTail(path: string): string {
  const chain = (`/${path}`).split('/node_modules/').filter(Boolean)
  return chain[chain.length - 1] ?? path
}

// === Dual-mode drift ========================================================

// Detect mismatches between `packages` and the legacy `dependencies` mirror
// for npm-2 dual-mode reconciliation. Returns the set of mirror entry names
// that disagree on version / resolved / integrity. Walks the legacy mirror
// shallowly (top-level + per-entry nested `dependencies` blocks) since the
// mirror under packages/<wsPath>/node_modules/... is captured by the
// authoritative `packages` block; the legacy mirror's nesting is informational.
export function detectDualModeDrift(
  packages: Record<string, NpmEntry>,
  legacy: Record<string, NpmLegacyEntry>,
): string[] {
  const drift = new Set<string>()
  for (const [name, legacyEntry] of Object.entries(legacy)) {
    if (legacyEntry === null || typeof legacyEntry !== 'object') continue
    // Skip workspace members in the legacy mirror — they carry `version: "file:..."`
    // and `requires:` blocks, which intentionally differ from the `packages` entry.
    const lv = legacyEntry.version
    if (typeof lv === 'string' && lv.startsWith('file:')) continue

    const pkgEntry = packages[`node_modules/${name}`]
    if (pkgEntry === undefined) continue
    if (pkgEntry.link === true) continue

    if (lv !== undefined && pkgEntry.version !== undefined && lv !== pkgEntry.version) {
      drift.add(name)
      continue
    }
    if (
      legacyEntry.resolved !== undefined
      && pkgEntry.resolved !== undefined
      && legacyEntry.resolved !== pkgEntry.resolved
    ) {
      drift.add(name)
      continue
    }
    if (
      legacyEntry.integrity !== undefined
      && pkgEntry.integrity !== undefined
      && legacyEntry.integrity !== pkgEntry.integrity
    ) {
      drift.add(name)
      continue
    }
  }
  return Array.from(drift).sort(cmpStr)
}

// === SERIALIZE ==============================================================

// === Legacy mirror ==========================================================

export function buildLegacyDependenciesMirror(
  graph: Graph,
  rootNode: Node | undefined,
  sidecar: NpmSidecar | undefined,
): Record<string, unknown> {
  if (rootNode === undefined) return {}

  // Build install-path indices for nested-mirror reconstruction.
  const workspacePathToId = new Map<string, string>()
  const workspacePathById = new Map<string, string>()
  for (const node of graph.nodes()) {
    if (node.workspacePath !== undefined && node.workspacePath !== '') {
      workspacePathToId.set(node.workspacePath, node.id)
      workspacePathById.set(node.id, node.workspacePath)
    }
  }

  const ctx: LegacyMirrorContext = {
    graph,
    sidecar,
    mirrorSidecar: mirrorSidecarByGraph.get(graph),
    rootId: rootNode.id,
    workspacePathToId,
    workspacePathById,
  }

  // Top-level keys: the union of (a) workspace member names + (b) all
  // hoisted `node_modules/<name>` install paths from the `packages` block.
  const top: Record<string, NpmLegacyEntry> = {}

  // Workspace members → `file:<wsPath>` entries.
  for (const node of graph.nodes()) {
    if (node.id === rootNode.id) continue
    const wsPath = workspacePathById.get(node.id)
    if (wsPath === undefined) continue
    top[node.name] = buildLegacyWorkspaceEntry(ctx, node, wsPath)
  }

  // Hoisted entries are keyed by their actual install slot. That slot differs
  // from `node.name` for npm aliases and remains part of npm-2's legacy mirror.
  for (const node of graph.nodes()) {
    if (node.id === rootNode.id) continue
    if (workspacePathById.has(node.id)) continue
    const nodeSide = sidecar?.nodes.get(node.id)
    const hoistedPaths = new Set(
      (nodeSide?.installPaths ?? []).filter(isTopLevelInstallPath),
    )
    for (const [path, entry] of ctx.mirrorSidecar?.legacyEntriesByInstallPath ?? []) {
      if (entry.nodeId === node.id && isTopLevelInstallPath(path)) hoistedPaths.add(path)
    }
    if (hoistedPaths.size === 0) {
      for (const edge of graph.out(rootNode.id)) {
        if (edge.dst !== node.id || edge.kind === 'peer' || edge.kind === 'bundled') continue
        hoistedPaths.add(`node_modules/${edge.attrs?.alias ?? node.name}`)
      }
    }
    if (hoistedPaths.size === 0 && (nodeSide === undefined || nodeSide.installPaths.length === 0)) {
      hoistedPaths.add(`node_modules/${node.name}`)
    }
    for (const installPath of [...hoistedPaths].sort(cmpStr)) {
      top[installPathTail(installPath)] = buildLegacyNodeEntry(ctx, node, installPath)
    }
  }

  return sortRecord(top)
}

function buildLegacyWorkspaceEntry(
  ctx: LegacyMirrorContext,
  node: Node,
  wsPath: string,
): NpmLegacyEntry {
  const entry: NpmLegacyEntry = { version: `file:${wsPath}` }

  // Collect direct deps from the graph + sidecar declared names.
  const requires: Record<string, string> = {}
  for (const edge of ctx.graph.out(node.id)) {
    if (edge.kind === 'peer') continue
    const range = edge.attrs?.[NPM_EDGE_RANGE_ATTR]
    if (typeof range !== 'string') continue
    const dst = ctx.graph.getNode(edge.dst)
    if (dst === undefined) continue
    const edgeKey = edgeTripleKey(edge.src, edge.kind, edge.dst)
    const declaredName = ctx.sidecar?.edgeDeclaredNames.get(edgeKey) ?? dst.name
    requires[declaredName] = legacyRequiresValue(ctx, edge, range)
  }
  if (Object.keys(requires).length > 0) entry.requires = sortRecord(requires)

  // De-hoisted nested entries: any sidecar install path under `<wsPath>/node_modules/...`
  // contributes a nested mirror under this workspace entry.
  const nestedDeps = collectNestedMirror(ctx, wsPath)
  if (Object.keys(nestedDeps).length > 0) entry.dependencies = sortRecord(nestedDeps)

  return entry
}

function buildLegacyNodeEntry(
  ctx: LegacyMirrorContext,
  node: Node,
  installPath: string,
): NpmLegacyEntry {
  const entry: NpmLegacyEntry = {}
  const captured = ctx.mirrorSidecar?.legacyEntriesByInstallPath.get(installPath)
  const capturedVersion = captured?.nodeId === node.id ? captured.version : undefined
  entry.version = capturedVersion ?? aliasVersionForSlot(ctx, node, installPath) ?? node.version

  const tarball = ctx.graph.tarballOf(node.id)
  const native = tarball?.nativeResolution
  // npm-2 stores the package URL in the `packages` block's `resolved` field
  // and mirrors it in the legacy `dependencies` block too. The graph holds
  // the URL via the per-tarball `nativeResolution`; the npm-N parser sometimes
  // leaves it unset (URL lives only on the on-disk `resolved` slot). Recover via
  // the npm-2 mirror sidecar when available. cross-format
  // fallback: derive from canonical resolution as last resort.
  const sourceResolved = sidecarResolvedFor(ctx, node)
    ?? deriveLegacyResolvedFromCanonical(tarball?.resolution)
  let resolved: string | undefined
  if (native !== undefined && !isYarnBerryLocator(native)) {
    // For git entries the resolution itself becomes the `version` field
    // (per the npm-2 legacy mirror fixture) and `from:` records the original
    // request spec.
    const looksLikeGit = /^git[+@]/.test(native)
    if (looksLikeGit) {
      entry.version = native
      const fromSpec = synthesizeFromSpec(ctx, node)
      if (fromSpec !== undefined) entry.from = fromSpec
    } else {
      resolved = stripRegistrySha1Fragment(native)
    }
  } else if (sourceResolved !== undefined && !isYarnBerryLocator(sourceResolved)) {
    // Same git-vs-tarball discrimination on the recovered URL.
    const looksLikeGit = /^git[+@]/.test(sourceResolved)
    if (looksLikeGit) {
      entry.version = sourceResolved
      const fromSpec = synthesizeFromSpec(ctx, node)
      if (fromSpec !== undefined) entry.from = fromSpec
    } else {
      resolved = stripRegistrySha1Fragment(sourceResolved)
    }
  }

  if (entry.from === undefined) {
    resolved = pathLocalStringField(ctx, node, installPath, 'resolved', resolved)
    if (resolved !== undefined) entry.resolved = resolved
    const canonicalSri = emitSriForRegistry(tarball?.integrity, native)
    const sri = pathLocalStringField(ctx, node, installPath, 'integrity', canonicalSri)
    if (sri !== undefined) entry.integrity = sri
  }

  const nodeSide = ctx.sidecar?.nodes.get(node.id)
  if (nodeSide?.dev === true) entry.dev = true
  if (nodeSide?.optional === true) entry.optional = true
  if (captured?.nodeId === node.id && captured.inBundle === true) entry.bundled = true

  // requires: dep + dev + optional graph edges (peer excluded — legacy mirror is npm-1-shape).
  const requires: Record<string, string> = {}
  for (const edge of ctx.graph.out(node.id)) {
    if (edge.kind === 'peer') continue
    const range = edge.attrs?.[NPM_EDGE_RANGE_ATTR]
    if (typeof range !== 'string') continue
    const dst = ctx.graph.getNode(edge.dst)
    if (dst === undefined) continue
    const edgeKey = edgeTripleKey(edge.src, edge.kind, edge.dst)
    const declaredName = ctx.sidecar?.edgeDeclaredNames.get(edgeKey) ?? dst.name
    requires[declaredName] = legacyRequiresValue(ctx, edge, range)
  }
  if (Object.keys(requires).length > 0) entry.requires = sortRecord(requires)

  const nestedDeps = collectNestedMirror(ctx, installPath)
  if (Object.keys(nestedDeps).length > 0) entry.dependencies = sortRecord(nestedDeps)

  return entry
}

function isTopLevelInstallPath(path: string): boolean {
  return path.startsWith('node_modules/')
    && !path.slice('node_modules/'.length).includes('/node_modules/')
}

function legacyRequiresValue(ctx: LegacyMirrorContext, edge: Edge, range: string): string {
  const captured = ctx.mirrorSidecar?.legacyRequiresByEdge.get(mirrorEdgeKey(edge))
  return captured?.sourceRange === range ? captured.mirrorRange : range
}

function aliasVersionForSlot(
  ctx: LegacyMirrorContext,
  node: Node,
  installPath: string,
): string | undefined {
  const slot = installPathTail(installPath)
  if (slot === node.name) return undefined
  for (const owner of ctx.graph.nodes()) {
    for (const edge of ctx.graph.out(owner.id)) {
      if (edge.dst !== node.id || edge.attrs?.alias !== slot) continue
      const range = edge.attrs?.[NPM_EDGE_RANGE_ATTR]
      if (typeof range === 'string') return range
    }
  }
  return undefined
}

// Walk the sidecar's install paths for nested entries beneath a given path
// prefix. Returns a flat record of bare-name -> legacy entry, mimicking the
// npm-1 nested-tree shape at the immediate child level only (deeper nesting
// is captured recursively via `buildLegacyNodeEntry`'s own nesting pass).
function collectNestedMirror(ctx: LegacyMirrorContext, parentPath: string): Record<string, NpmLegacyEntry> {
  if (ctx.sidecar === undefined) return {}
  const prefix = `${parentPath}/node_modules/`
  const nested: Record<string, NpmLegacyEntry> = {}
  const seen = new Set<string>()
  for (const [nodeId, sc] of ctx.sidecar.nodes) {
    for (const installPath of sc.installPaths) {
      const slot = immediateInstallSlot(installPath, prefix)
      if (slot === undefined) continue
      if (seen.has(installPath)) continue
      seen.add(installPath)
      const node = ctx.graph.getNode(nodeId)
      if (node === undefined) continue
      nested[slot] = buildLegacyNodeEntry(ctx, node, installPath)
    }
  }
  return nested
}

function immediateInstallSlot(installPath: string, prefix: string): string | undefined {
  if (!installPath.startsWith(prefix)) return undefined
  const tail = installPath.slice(prefix.length)
  if (tail === '' || tail.includes('/node_modules/')) return undefined
  if (!tail.startsWith('@')) return tail.includes('/') ? undefined : tail
  const scopeSlash = tail.indexOf('/')
  if (scopeSlash <= 1 || scopeSlash === tail.length - 1) return undefined
  return tail.indexOf('/', scopeSlash + 1) === -1 ? tail : undefined
}

function pathLocalStringField(
  ctx: LegacyMirrorContext,
  node: Node,
  installPath: string,
  key: 'integrity' | 'resolved',
  canonicalValue: string | undefined,
): string | undefined {
  const state = ctx.sidecar?.packageEntriesByPath?.get(installPath)
  if (state?.nodeId !== node.id || state.canonicalEntry === undefined) return canonicalValue
  if (state.canonicalEntry[key] !== canonicalValue) return canonicalValue
  const sourceValue = state.nativeEntry[key]
  return typeof sourceValue === 'string' ? sourceValue : undefined
}

function sidecarResolvedFor(ctx: LegacyMirrorContext, node: Node): string | undefined {
  return mirrorSidecarByGraph.get(ctx.graph)?.resolvedByNodeId.get(node.id)
}

function synthesizeFromSpec(ctx: LegacyMirrorContext, node: Node): string | undefined {
  // The `from:` spec in the legacy mirror is `<declaredName>@<originalRange>`
  // where originalRange is the incoming edge's `range` attribute. Walk
  // incoming edges to find a non-workspace origin that declared this node.
  for (const otherNode of ctx.graph.nodes()) {
    for (const edge of ctx.graph.out(otherNode.id)) {
      if (edge.dst !== node.id) continue
      const range = edge.attrs?.[NPM_EDGE_RANGE_ATTR]
      if (typeof range !== 'string') continue
      const edgeKey = edgeTripleKey(edge.src, edge.kind, edge.dst)
      const declaredName = ctx.sidecar?.edgeDeclaredNames.get(edgeKey) ?? node.name
      return `${declaredName}@${range}`
    }
  }
  return undefined
}

function deriveLegacyResolvedFromCanonical(canonical: ResolutionCanonical | undefined): string | undefined {
  if (canonical === undefined) return undefined
  return stringifyForNpm(canonical)
}
