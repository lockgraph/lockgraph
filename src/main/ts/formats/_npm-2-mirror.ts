// _npm-2-mirror.ts — npm-2 dual-mode reconciliation + legacy mirror.
//
// npm-2-only logic split out of `_npm-core.ts` per ADR-0021 §5 mining
// strategy r1 fix-up + r2 cycle-break. The core (`_npm-core.ts`) handles
// the flat `packages` block shared with npm-3; this module owns:
//
//   - parse-time dual-mode `dependencies` requirement (validateTopLevel)
//   - parse-time dual-mode drift detection (`detectDualModeDrift`,
//     wired via `emitParseDiagnostics`)
//   - emit-time legacy `dependencies` mirror reconstruction
//     (`buildLegacyDependenciesMirror`, wired via `enrichStringifyOut`)
//   - the npm-2-only composed sidecar (`Npm2MirrorSidecar`) that captures
//     the on-disk `resolved` URL needed to replay it on both the
//     `packages` and `dependencies` blocks (npm-3 has no mirror).
//
// Dependency direction (per r2 cycle-break):
//   - this module imports ONLY from `_npm-flat-types.ts` + `../graph.ts`.
//   - it does NOT import from `_npm-core.ts`.
//   - `_npm-core.ts` does NOT import this module.
//   - `npm-2.ts` thin entry wires the hook surface together.
//
// Mirror contract per ADR-0021 §A.npm-2 *Body field schedule (legacy mirror)*:
//   - Bare-name keys at top level (no `node_modules/` prefix).
//   - `version` is the resolved version (or `file:<wsPath>` for workspace members).
//   - `resolved` / `integrity` populated for non-workspace nodes.
//   - `requires: {…}` replaces inner-block `dependencies` (the npm-1 convention).
//   - Nested `dependencies` block carries de-hoisted nested installs.
//   - No `peerDependencies` (legacy mirror is npm-1-shape).
//
// The mirror is RECONSTRUCTED FROM THE SAME GRAPH that emits the `packages`
// block, so the two are consistent by construction.

import { type Graph, type Node, type Diagnostic } from '../graph.ts'
import { emitSriForRegistry } from '../recipe/integrity.ts'
import { LockfileError } from '../errors.ts'
import {
  isYarnBerryLocator,
  stringifyForNpm,
  stripRegistrySha1Fragment,
  type ResolutionCanonical,
} from '../recipe/resolution.ts'

function deriveLegacyResolvedFromCanonical(canonical: ResolutionCanonical | undefined): string | undefined {
  if (canonical === undefined) return undefined
  return stringifyForNpm(canonical)
}
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

// === Sidecar state ==========================================================

// npm-2-only composed sidecar — recovered `resolved` URLs per NodeId,
// keyed for emit-time mirror reconstruction. Absent on npm-3.
export interface Npm2MirrorSidecar {
  resolvedByNodeId: Map<string, string>
}

// Per-graph mirror sidecar storage, independent of the core flat sidecar.
const mirrorSidecarByGraph = new WeakMap<Graph, Npm2MirrorSidecar>()

// In-flight `resolved` capture for the currently-parsing lockfile.
// Populated by `captureEntry` and committed to the WeakMap in
// `afterParse`. Keyed by NodeId (srcId).
let currentParseCapture: Map<string, string> | undefined

export function getMirrorSidecar(graph: Graph): Npm2MirrorSidecar | undefined {
  return mirrorSidecarByGraph.get(graph)
}

export function setMirrorSidecar(graph: Graph, sidecar: Npm2MirrorSidecar): void {
  mirrorSidecarByGraph.set(graph, sidecar)
}

// === Public hooks (wired by `npm-2.ts` into NpmFamilyConfig.hooks) =========

export const NPM2_HOOKS: NpmFamilyHooks = {
  validateTopLevel(lf: NpmLockfile): void {
    const hasDependencies = lf.dependencies !== undefined
      && typeof lf.dependencies === 'object'
      && !Array.isArray(lf.dependencies)
    if (!hasDependencies) {
      throw new LockfileError({
        code: 'FORMAT_MISMATCH',
        message: 'npm-2 adapter: top-level "dependencies" mirror is required (dual-mode)',
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

  afterParse(ctx: { graph: Graph }): void {
    const buffer = currentParseCapture ?? new Map<string, string>()
    currentParseCapture = undefined
    mirrorSidecarByGraph.set(ctx.graph, { resolvedByNodeId: buffer })
  },

  enrichStringifyOut(ctx): void {
    ctx.out.dependencies = buildLegacyDependenciesMirror(ctx.graph, ctx.rootNode, ctx.sidecar)
  },

  recoverResolvedForNode(graph: Graph, node: Node): string | undefined {
    return mirrorSidecarByGraph.get(graph)?.resolvedByNodeId.get(node.id)
  },

  rebindGraph(oldGraph: Graph, newGraph: Graph): void {
    const existing = mirrorSidecarByGraph.get(oldGraph)
    if (existing !== undefined) {
      mirrorSidecarByGraph.set(newGraph, existing)
    }
  },

  pruneToNodes(graph: Graph, reachableNodeIds: ReadonlySet<string>): void {
    const existing = mirrorSidecarByGraph.get(graph)
    if (existing === undefined) return
    const pruned = new Map<string, string>()
    for (const [nodeId, resolved] of existing.resolvedByNodeId) {
      if (reachableNodeIds.has(nodeId)) pruned.set(nodeId, resolved)
    }
    mirrorSidecarByGraph.set(graph, { resolvedByNodeId: pruned })
  },
}

// === Dual-mode drift detection (parse-side) ================================

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

// === Legacy mirror reconstruction (stringify-side) =========================

interface LegacyMirrorContext {
  graph: Graph
  sidecar: NpmSidecar | undefined
  rootId: string | undefined
  // workspacePath -> NodeId for "we recognise this install path as a
  // workspace symlink" lookups when building nested mirrors.
  workspacePathToId: Map<string, string>
  // NodeId -> workspacePath for the reverse lookup.
  workspacePathById: Map<string, string>
}

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

  // Hoisted `node_modules/<name>` entries: pick the unique NodeId whose
  // sidecar has `node_modules/<n>` (no `/node_modules/` boundary) among
  // its install paths. Fall back to flat-emit by graph.byName(name) when
  // sidecar is absent (post-mutation new nodes).
  for (const node of graph.nodes()) {
    if (node.id === rootNode.id) continue
    if (workspacePathById.has(node.id)) continue
    const nodeSide = sidecar?.nodes.get(node.id)
    const hoistedPath = `node_modules/${node.name}`
    const installedHoisted = nodeSide?.installPaths.includes(hoistedPath)
    if (installedHoisted || nodeSide === undefined || nodeSide.installPaths.length === 0) {
      top[node.name] = buildLegacyNodeEntry(ctx, node, '')
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
    requires[declaredName] = range
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
  parentInstallPrefix: string,
): NpmLegacyEntry {
  const entry: NpmLegacyEntry = {}
  if (node.version !== undefined) entry.version = node.version

  const tarball = ctx.graph.tarballOf(node.id)
  const native = tarball?.nativeResolution
  // npm-2 stores the package URL in the `packages` block's `resolved` field
  // and mirrors it in the legacy `dependencies` block too. The graph holds
  // the URL via the per-tarball `nativeResolution`; the npm-N parser sometimes
  // leaves it unset (URL lives only on the on-disk `resolved` slot). Recover via
  // the npm-2 mirror sidecar when available. ADR-0014 §4.F3 cross-format
  // fallback: derive from canonical resolution as last resort.
  const sourceResolved = sidecarResolvedFor(ctx, node)
    ?? deriveLegacyResolvedFromCanonical(tarball?.resolution)
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
      entry.resolved = stripRegistrySha1Fragment(native)
    }
  } else if (sourceResolved !== undefined && !isYarnBerryLocator(sourceResolved)) {
    // Same git-vs-tarball discrimination on the recovered URL.
    const looksLikeGit = /^git[+@]/.test(sourceResolved)
    if (looksLikeGit) {
      entry.version = sourceResolved
      const fromSpec = synthesizeFromSpec(ctx, node)
      if (fromSpec !== undefined) entry.from = fromSpec
    } else {
      entry.resolved = stripRegistrySha1Fragment(sourceResolved)
    }
  }

  if (entry.from === undefined) {
    const sri = emitSriForRegistry(tarball?.integrity, native)
    if (sri !== undefined) entry.integrity = sri
  }

  const nodeSide = ctx.sidecar?.nodes.get(node.id)
  if (nodeSide?.dev === true) entry.dev = true
  if (nodeSide?.optional === true) entry.optional = true

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
    requires[declaredName] = range
  }
  if (Object.keys(requires).length > 0) entry.requires = sortRecord(requires)

  // De-hoisted nested entries for this consumer (only when parent has a prefix).
  if (parentInstallPrefix !== '') {
    const nestedDeps = collectNestedMirror(ctx, `${parentInstallPrefix}/node_modules/${node.name}`)
    if (Object.keys(nestedDeps).length > 0) entry.dependencies = sortRecord(nestedDeps)
  }

  return entry
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
      if (!installPath.startsWith(prefix)) continue
      const tail = installPath.slice(prefix.length)
      if (tail.includes('/node_modules/')) continue
      if (tail.includes('/')) continue
      if (seen.has(installPath)) continue
      seen.add(installPath)
      const node = ctx.graph.getNode(nodeId)
      if (node === undefined) continue
      nested[tail] = buildLegacyNodeEntry(ctx, node, installPath)
    }
  }
  return nested
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
