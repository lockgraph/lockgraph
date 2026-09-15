// _npm-core.ts — npm-flat-family (npm-2 / npm-3 / npm-4) shared core.
//
// Scope: the install-path-keyed `packages` block layout (npm
// lockfileVersion 2 + 3 + 4). Per-version thin entries (`npm-2.ts`,
// `npm-3.ts`, `npm-4.ts`) thread an `NpmFamilyConfig` through the shared parse /
// stringify / enrich / optimize implementations. The core itself
// contains NO per-version branches except those routed via the
// `topLevelShape` / `diagnosticPrefix` config fields and the optional
// `hooks` slot.
//
// Layout decisions encoded by config:
//
// - `topLevelShape: 'packages-only'` (npm-3) — only the `packages` block
//   is authoritative; any top-level `dependencies` is anomalous and
//   surfaces `NPM_V3_UNEXPECTED_LEGACY_MIRROR` on parse.
// - `topLevelShape: 'dual'` (npm-2) — `packages` plus the legacy
//   `dependencies` mirror are expected except for npm's dependency-free
//   root-only omission. `packages` wins on disagreement; per-entry drift
//   surfaces `NPM_V2_DUAL_MODE_DRIFT`. The npm-2-only dual-mode drift
//   detection + legacy-mirror reconstruction lives in `_npm-2-mirror.ts`
//   and is wired in via the `hooks` slot of `NpmFamilyConfig`. CORE
//   itself does NOT import the mirror module — the hook contract keeps
//   the dependency direction one-way (mirror → types ← core).
//
// npm-1 (recursive `dependencies` tree shape) is OUT OF SCOPE for this
// core — the tree walker is fundamentally different from the flat-shape
// `packages` reader/writer and forcing a unified pipeline rots both
// sides. The npm-1 adapter reuses the standalone utilities
// (`cmpStr`, `sortRecord`, `derivePeerCandidates`, `pruneSidecar`,
// `resolveDepTarget`) but own its top-level parse/stringify pipeline,
// matching the yarn-classic precedent.
//
// Diagnostic codes carry the per-version prefix from
// `config.diagnosticPrefix` (e.g. `NPM_V2_PEER_VIRT_FLATTENED`).

import semver from 'semver'
import {
  GraphError,
  nameOf,
  newBuilder,
  serializeNodeId,
  type Diagnostic,
  type Edge,
  type EdgeKind,
  type Graph,
  type Node,
  type TarballPayload,
} from '../graph.ts'
import { optimizeUnreachable } from './_optimize.ts'
import { locateAuthoritativeRootNode } from './_root-authority.ts'
import { LockfileError } from '../api/errors.ts'
import { parseSri, emitSriForRegistry, isEmptyIntegrity } from '../recipe/integrity.ts'
import {
  emitDropped as patchEmitDropped,
  emitWorkspaceResolved,
  emitWorkspaceUnresolved,
  interopOverrideNotProjected,
  invalidIntegrityDiagnostic,
  unknownResolutionDiagnostic,
} from '../recipe/diagnostics.ts'
import { patchNormalizedDiagnostic } from '../recipe/diagnostics.ts'
import {
  isYarnBerryLocator,
  parse as parseResolutionRecipe,
  registryTarballUrl,
  sourceDiscriminatorOf,
  stringifyForNpm,
  stripRegistrySha1Fragment,
  type ResolutionCanonical,
} from '../recipe/resolution.ts'
import {
  isWorkspaceEdge,
  shouldEmitWorkspaceResolved,
  stringifyForVersionOnly,
  workspaceRangeOfEdge,
} from '../recipe/workspace.ts'
import { captureOverrides } from '../recipe/overrides.ts'
import {
  mergeUnresolvedDependencyDeclarations,
  unresolvedDependencyData,
} from '../recipe/unresolved-dependency.ts'
import {
  NPM_EDGE_RANGE_ATTR,
  cmpStr,
  edgeTripleKey,
  sortRecord,
  stringifyNpmLock,
  type NpmEntry,
  type NpmFamilyConfig,
  type NpmFamilyEnrichOptions,
  type NpmFamilyOptimizeOptions,
  type NpmFamilyParseOptions,
  type NpmFamilyStringifyOptions,
  type NpmFlatSidecar,
  type NpmLockfile,
  type NpmLinkEntrySidecar,
  type NpmPackageEntrySidecar,
  type NpmRootMeta,
  type NpmSidecar,
  type NpmWorkspacesField,
} from './_npm-flat-types.ts'
import {
  captureUnknownTopLevel,
  mergeUnknownTopLevel,
  unknownTopLevelSubjects,
} from './_unknown-top-level.ts'

// === TYPES ==================================================================

export type PeerCandidateOutcome =
  | { kind: 'single'; candidate: string }
  | { kind: 'ambiguous'; candidates: string[] }
  | { kind: 'unsatisfied' }

interface NpmParseContext {
  config: NpmFamilyConfig
  lf: NpmLockfile
  packages: Record<string, NpmEntry>
  rootEntry: NpmEntry
  rootName: string
  rootVersion: string
  rootId: string
  builder: ReturnType<typeof newBuilder>
  diagnostics: Diagnostic[]
  nodeSidecar: Map<string, NpmFlatSidecar>
  packageEntriesByPath: Map<string, NpmPackageEntrySidecar>
  linkEntriesByPath: Map<string, NpmLinkEntrySidecar>
  edgeRanges: Map<string, string>
  edgeDeclaredNames: Map<string, string>
  reservedEdgeRanges: Map<string, string>
  workspaceByPath: Map<string, string>
  pathToId: Map<string, string>
  patchByPath: Map<string, string>
  idToEntry: Map<string, NpmEntry>
  linkNameByPath: Map<string, string>
  options: NpmFamilyParseOptions
}

// === SIDECAR ================================================================

const sidecarByGraph = new WeakMap<Graph, NpmSidecar>()

export function hasAdapterState(graph: Graph): boolean {
  return sidecarByGraph.has(graph)
}

export function adapterStateSubjects(graph: Graph): readonly string[] {
  const sidecar = sidecarByGraph.get(graph)
  const rootSubjects = Object.entries(sidecar?.rootMeta?.nativeRootEntry?.value ?? {})
    .filter(([key, value]) => rootEntryKeyNeedsNativeCarrier(key, value))
    .map(([key]) => `root-entry:${key}`)
  const packageEntrySubjects = packageEntryStateSubjects(sidecar?.packageEntriesByPath)
  const linkEntrySubjects = [...(sidecar?.linkEntriesByPath?.keys() ?? [])]
    .map(path => `package-link:${path}`)
  return [
    ...unknownTopLevelSubjects(sidecar?.unknownTopLevel),
    ...rootSubjects,
    ...packageEntrySubjects,
    ...linkEntrySubjects,
  ].sort(cmpStr)
}

const PACKAGE_ENTRY_DEPENDENCY_KEYS = new Set([
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
])

function packageEntryStateSubjects(
  entries: ReadonlyMap<string, NpmPackageEntrySidecar> | undefined,
): string[] {
  if (entries === undefined) return []
  const byNodeId = new Map<string, NpmPackageEntrySidecar[]>()
  for (const entry of entries.values()) {
    const siblings = byNodeId.get(entry.nodeId) ?? []
    siblings.push(entry)
    byNodeId.set(entry.nodeId, siblings)
  }
  const subjects: string[] = []
  for (const [path, entry] of entries) {
    const siblings = byNodeId.get(entry.nodeId) ?? [entry]
    for (const [key, value] of Object.entries(entry.nativeEntry)) {
      if (!packageEntryKeyNeedsNativeCarrier(key, value, entry, siblings)) continue
      subjects.push(`package-entry:${path}:${key}`)
    }
  }
  return subjects.sort(cmpStr)
}

function packageEntryKeyNeedsNativeCarrier(
  key: string,
  value: unknown,
  entry: NpmPackageEntrySidecar,
  siblings: readonly NpmPackageEntrySidecar[],
): boolean {
  if (key === 'name' || key === 'version' || key === 'link') return false
  if (PACKAGE_ENTRY_DEPENDENCY_KEYS.has(key)
    && value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).length > 0) return false
  if (!jsonValueEqual(value, entry.canonicalEntry?.[key])) return true
  return siblings.some(sibling => !jsonValueEqual(value, sibling.nativeEntry[key]))
}

function rootEntryKeyNeedsNativeCarrier(key: string, value: unknown): boolean {
  if (key === 'name' || key === 'version') return false
  if (key !== 'dependencies'
    && key !== 'devDependencies'
    && key !== 'peerDependencies'
    && key !== 'optionalDependencies') return true
  return value === null
    || typeof value !== 'object'
    || Array.isArray(value)
    || Object.keys(value).length === 0
}

// === Access =================================================================

export function getFlatSidecar(graph: Graph): NpmSidecar | undefined {
  return sidecarByGraph.get(graph)
}

export function rebindAdapterState(
  source: Graph,
  target: Graph,
): Readonly<{ graph: Graph; invalidated: readonly string[] }> {
  const sidecar = sidecarByGraph.get(source)
  if (sidecar === undefined) return { graph: target, invalidated: [] }
  const pruned = pruneSidecar(sidecar, target)
  sidecarByGraph.set(target, pruned)
  const retainedPackageEntrySubjects = new Set(packageEntryStateSubjects(pruned.packageEntriesByPath))
  const retainedLinkPaths = new Set(pruned.linkEntriesByPath?.keys() ?? [])
  const invalidated = [
    ...[...sidecar.nodes.keys()].filter(id => !pruned.nodes.has(id)),
    ...[...sidecar.edgeRanges.keys()].filter(key => !pruned.edgeRanges.has(key)),
    ...[...sidecar.workspaceByPath.entries()]
      .filter(([path, id]) => pruned.workspaceByPath.get(path) !== id)
      .map(([path]) => `workspace:${path}`),
    ...packageEntryStateSubjects(sidecar.packageEntriesByPath)
      .filter(subject => !retainedPackageEntrySubjects.has(subject)),
    ...[...(sidecar.linkEntriesByPath?.keys() ?? [])]
      .filter(path => !retainedLinkPaths.has(path))
      .map(path => `package-link:${path}`),
  ].sort()
  return { graph: target, invalidated }
}

// === API ====================================================================

/** Detects whether input belongs to the configured npm layout. */
export function checkFamily(input: string, config: NpmFamilyConfig): boolean {
  const versionRe = new RegExp(`"lockfileVersion"\\s*:\\s*${config.lockfileVersion}\\b`)
  if (!versionRe.test(input)) return false
  switch (config.topLevelShape) {
    case 'packages-only':
      // npm-3: requires `packages`; rejects if a top-level `dependencies` map appears.
      // Cheap anchor: presence of `packages` is sufficient — a legacy mirror
      // is anomalous on npm-3 input and surfaces as a parse-time warning.
      return /"packages"\s*:\s*\{/.test(input)
    case 'dual':
      // npm-2 normally carries both maps. npm itself omits the empty legacy
      // mirror for a dependency-free lock whose packages map contains only
      // the root entry, so that exact producer shape is also npm-2.
      if (!/"packages"\s*:\s*\{/.test(input)) return false
      if (/"dependencies"\s*:\s*\{/.test(input)) return true
      try {
        const parsed: unknown = JSON.parse(input)
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return false
        return hasOnlyRootPackage((parsed as { packages?: unknown }).packages)
      } catch {
        return false
      }
  }
}

function hasOnlyRootPackage(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const packages = value as Record<string, unknown>
  if (Object.keys(packages).length !== 1 || !Object.hasOwn(packages, '')) return false
  const root = packages['']
  return root !== null && typeof root === 'object' && !Array.isArray(root)
}

/** Parses the configured npm layout while preserving adapter sidecar state. */
export function parseFamily(
  input: string,
  options: NpmFamilyParseOptions,
  config: NpmFamilyConfig,
): Graph {
  const context = createNpmParseContext(input, options, config)
  addNpmRootNode(context)

  indexNpmWorkspaceLinkNames(context)

  addWorkspaceMemberNodes(context)

  addInstalledPackageNodes(context)

  addNpmPackageEdges(context)

  const rootMeta = captureNpmRootMeta(context)
  emitNpmParseDiagnostics(context)
  const graph = sealNpmParseContext(context, rootMeta)
  if (options.onDiagnostic !== undefined) {
    for (const diagnostic of graph.diagnostics()) options.onDiagnostic(diagnostic)
  }
  return graph
}

/** Serializes a graph through the configured npm layout. */
export function stringifyFamily(
  graph: Graph,
  config: NpmFamilyConfig,
  options: NpmFamilyStringifyOptions = {},
): string {
  const sidecar = sidecarByGraph.get(graph)
  const warnedPeerVirt = new Set<string>()
  const warnedPatches = new Set<string>()
  const emitDiagnostic = (diagnostic: Diagnostic): void => {
    options.onDiagnostic?.(diagnostic)
  }

  const rootNode = locateAuthoritativeRootNode(graph, sidecar)
  const rootMeta = sidecar?.rootMeta
  const rootName = rootMeta?.name ?? rootNode?.name ?? ''
  const rootVersion = rootMeta?.version ?? rootNode?.version ?? '0.0.0'
  const plannedInstallPaths = deriveInstallPathsForStringify(graph, sidecar, rootNode, emitDiagnostic)

  const packages: Record<string, unknown> = {}

  if (rootNode !== undefined) {
    packages[''] = buildRootEntry(graph, rootNode, rootMeta, sidecar, config, emitDiagnostic)
  } else if (rootMeta !== undefined) {
    packages[''] = buildSyntheticRootEntry(rootMeta, config)
  } else {
    // Empty graph / no root info: emit a minimal root entry so the lockfile
    // remains parseable (parseFamily rejects a `packages` map missing the
    // `''` key — see this module's parse path).
    packages[''] = { name: rootName, version: rootVersion }
  }

  // npm reads its override POLICY from the root MANIFEST's `overrides`, never
  // from `package-lock.json`: real npm locks carry no `packages[""].overrides`
  // (canary: overrides-canary.test.ts), and npm — unlike pnpm 6–10, which
  // deep-compare a lock `overrides` block in frozen mode — does not consume such
  // a field. Stringify does NOT synthesize it into npm output: it cannot preserve
  // policy (npm ignores it) and would create false `npm ci` confidence while
  // weakening byte-stability. When there IS an override policy to carry (caller
  // `options.overrides`, or one captured from a non-native lock / a manifest), it
  // belongs in a companion package.json patch — surfaced here via
  // INTEROP_OVERRIDE_NOT_PROJECTED and owed to the project-level conversion API
  // (ADR TBD). An explicit `options.overrides = []` means "none" → no diagnostic.
  const npmOverrideCount =
    options.overrides !== undefined
      ? options.overrides.length
      : rootMeta?.nativeOverrides !== undefined
        ? Object.keys(rootMeta.nativeOverrides).length
        : rootMeta?.overrides?.length ?? 0
  if (npmOverrideCount > 0) {
    emitDiagnostic(interopOverrideNotProjected('npm', npmOverrideCount))
  }

  const workspaceMembers: Node[] = []
  for (const node of graph.nodes()) {
    reportPatchDrop(graph, sidecar, config, node, warnedPatches, emitDiagnostic)
    reportPeerContextFlatten(config, node, warnedPeerVirt, emitDiagnostic)
    if (rootNode !== undefined && node.id === rootNode.id) continue
    if (node.workspacePath !== undefined && node.workspacePath !== '') {
      workspaceMembers.push(node)
    }
  }
  const capturedLinkTargetIds = new Set(
    [...(sidecar?.linkEntriesByPath?.values() ?? [])].map(entry => entry.targetNodeId),
  )
  for (const node of workspaceMembers) {
    const path = node.workspacePath!
    const canonicalEntry = buildWorkspaceMemberEntry(graph, node, sidecar, config, emitDiagnostic)
    const pathState = sidecar?.packageEntriesByPath?.get(path)
    packages[path] = buildPackageEntryAtPath(canonicalEntry, pathState, node.id)
    // WS-LINK: emit the top-level node_modules/<name> symlink for a
    // workspace member UNLESS it is `extraneous` — npm omits the link for a member
    // present on disk but absent from the install graph (an extraneous member would
    // otherwise emit one extra top-level link beyond npm's set). The
    // flag is captured layout attribution, replayed here. A cross-PM / post-mutate
    // graph carries no sidecar, so the default (no flag ⇒ linked) links every
    // member.
    const extraneous = sidecar?.nodes.get(node.id)?.extraneous === true
    if (!extraneous && !capturedLinkTargetIds.has(node.id)) {
      packages[`node_modules/${node.name}`] = {
        resolved: node.workspacePath,
        link: true,
      }
    }
  }

  // npm's link key is physical layout, not canonical package identity. Replay
  // the exact authored alias path while deriving its target from the current
  // root/workspace node, so rebinding cannot retain a stale `resolved` path.
  for (const [path, linkState] of sidecar?.linkEntriesByPath ?? []) {
    const target = graph.getNode(linkState.targetNodeId)
    if (target === undefined) continue
    const nativeResolved = linkState.nativeEntry.resolved
    const installedTargets = plannedInstallPaths.get(target.id) ?? []
    const resolved = target.workspacePath
      ?? (typeof nativeResolved === 'string' && installedTargets.includes(nativeResolved)
        ? nativeResolved
        : installedTargets[0])
    if (resolved === undefined) continue
    packages[path] = {
      ...cloneNpmRootEntry(linkState.nativeEntry),
      resolved,
      link: true,
    }
  }

  // A package can also be installed at a node_modules path whose canonical
  // identity is the project root or a workspace manifest node. npm records
  // those as distinct physical placements even though the graph deliberately
  // collapses their identity onto the manifest node. Replay only paths that
  // were captured from the source; never synthesize a manifest-node placement.
  const manifestNodes = rootNode === undefined
    ? workspaceMembers
    : [rootNode, ...workspaceMembers]
  for (const node of manifestNodes) {
    const nodeSide = sidecar?.nodes.get(node.id)
    const paths = nodeSide?.installPaths ?? []
    if (paths.length === 0) continue
    for (const path of paths) {
      const pathState = sidecar?.packageEntriesByPath?.get(path)
      const entry = buildManifestPlacementEntry(
        graph,
        node,
        nodeSide,
        paths,
        pathState,
        config,
        emitDiagnostic,
      )
      packages[path] = buildPackageEntryAtPath(entry, pathState, node.id)
    }
  }

  for (const node of graph.nodes()) {
    if (rootNode !== undefined && node.id === rootNode.id) continue
    if (node.workspacePath !== undefined) continue

    const nodeSide = sidecar?.nodes.get(node.id)
    const paths = plannedInstallPaths.get(node.id) ?? [`node_modules/${node.name}`]
    const entry = buildNodeModulesEntry(graph, node, nodeSide, paths, config, emitDiagnostic)
    for (const path of paths) {
      const pathState = sidecar?.packageEntriesByPath?.get(path)
      packages[path] = buildPackageEntryAtPath(entry, pathState, node.id)
    }
  }

  const out: Record<string, unknown> = {
    name: rootName,
    version: rootVersion,
    lockfileVersion: config.lockfileVersion,
    requires: rootMeta?.requires ?? true,
    packages: sortRecord(packages),
  }

  // Adapter-specific top-level enrichment (npm-2: legacy `dependencies`
  // mirror reconstructed from the same graph by `_npm-2-mirror.ts`).
  config.hooks?.enrichStringifyOut?.({ graph, rootNode, sidecar, out })

  const merged = mergeUnknownTopLevel(out, sidecar?.unknownTopLevel)
  const text = stringifyNpmLock(
    merged,
    sidecar?.unknownTopLevel === undefined ? undefined : Object.keys(merged),
    nativeRootEntryPortableTo(rootMeta, config),
  )
  return options.lineEnding === 'crlf' ? text.replace(/\n/g, '\r\n') : text
}

/** Enriches a graph with declared npm manifest data. */
export function enrichFamily(
  graph: Graph,
  config: NpmFamilyConfig,
  _options: NpmFamilyEnrichOptions = {},
): { graph: Graph; diagnostics: Diagnostic[] } {
  const sidecar = sidecarByGraph.get(graph)
  const diagnostics: Diagnostic[] = []
  const workspaceEdgesToMark: Edge[] = []

  // Pass 1: peer derivation for diagnostic surfacing only. The graph-side
  // peer edge is NOT added (per -* peer-flat outcome).
  for (const node of graph.nodes()) {
    const nodeSide = sidecar?.nodes.get(node.id)
    const rawPeers = nodeSide?.peerDependencies
    if (rawPeers === undefined) continue

    for (const [peerName, range] of Object.entries(rawPeers).sort((a, b) => cmpStr(a[0], b[0]))) {
      const outcome = derivePeerCandidates(graph, peerName, range)
      if (outcome.kind === 'single') continue
      if (outcome.kind === 'unsatisfied') {
        diagnostics.push({
          code: `${config.diagnosticPrefix}_PEER_UNSATISFIED`,
          severity: 'warning',
          subject: node.id,
          message: `peer "${peerName}" range "${range}" matches no installed version`,
        })
        continue
      }
      diagnostics.push({
        code: `${config.diagnosticPrefix}_PEER_AMBIGUOUS`,
        severity: 'warning',
        subject: node.id,
        message: `peer "${peerName}" range "${range}" matches multiple candidates: ${outcome.candidates.join(', ')}`,
      })
    }
  }

  // Pass 2: workspace edge attribution. Marks `workspace: true` AND
  // populates `attrs.workspaceRange` (F4 canonical sidecar) — npm-2/3
  // link entries carry no on-disk specifier, so the F4 carrier holds
  // the empty pending sentinel + `dst.version` as `resolvedVersion`.
  for (const node of graph.nodes()) {
    for (const edge of graph.out(node.id)) {
      if (edge.kind === 'peer') continue
      if (edge.attrs?.workspace === true) continue
      const dst = graph.getNode(edge.dst)
      if (dst === undefined) continue
      if (dst.workspacePath === undefined || dst.workspacePath === '') continue
      const workspaceRange = dst.version !== undefined && dst.version !== ''
        ? { specifier: '', resolvedVersion: dst.version }
        : { specifier: '' }
      workspaceEdgesToMark.push({
        src: edge.src,
        dst: edge.dst,
        kind: edge.kind,
        attrs: { ...edge.attrs, workspace: true, workspaceRange },
      })
    }
  }

  if (workspaceEdgesToMark.length === 0) {
    return { graph, diagnostics }
  }

  const result = graph.mutate(m => {
    for (const edge of workspaceEdgesToMark) {
      m.removeEdge(edge.src, edge.dst, edge.kind)
      m.addEdge(edge.src, edge.dst, edge.kind, edge.attrs)
    }
  })

  if (sidecar !== undefined) {
    sidecarByGraph.set(result.graph, sidecar)
  }
  config.hooks?.rebindGraph?.(graph, result.graph)
  return { graph: result.graph, diagnostics }
}

/** Optimizes a graph without changing its npm serialization contract. */
export function optimizeFamily(
  graph: Graph,
  config: NpmFamilyConfig,
  _options: NpmFamilyOptimizeOptions = {},
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
    sidecarByGraph.set(result.graph, pruneSidecar(sidecar, result.graph))
  }
  if (result.graph !== graph) {
    config.hooks?.rebindGraph?.(graph, result.graph)
    const reachableIds = new Set(Array.from(result.graph.nodes(), node => node.id))
    config.hooks?.pruneToNodes?.(result.graph, reachableIds)
  }
  return result
}

// === PARSE ==================================================================

export function nameFromInstallPath(config: NpmFamilyConfig, path: string, entry: NpmEntry): string {
  if (entry.name !== undefined && entry.link !== true) {
    return entry.name
  }
  const chain = ('/' + path).split('/node_modules/').filter(Boolean)
  const tail = chain[chain.length - 1]
  if (tail === undefined || tail === '') {
    throw parseFailed(config, `cannot derive name from install path ${JSON.stringify(path)}`)
  }
  return tail
}

// === Handshake ==============================================================

function createNpmParseContext(
  input: string,
  options: NpmFamilyParseOptions,
  config: NpmFamilyConfig,
): NpmParseContext {
  const lf = parseJson(input, config)
  if (lf.lockfileVersion !== config.lockfileVersion) {
    throw new LockfileError({
      code: 'FORMAT_MISMATCH',
      message: `npm-${config.lockfileVersion} adapter: expected lockfileVersion ${config.lockfileVersion}, got ${JSON.stringify(lf.lockfileVersion)}`,
    })
  }

  const hasPackages = lf.packages !== undefined
    && typeof lf.packages === 'object'
    && !Array.isArray(lf.packages)
  if (!hasPackages) {
    throw new LockfileError({
      code: 'FORMAT_MISMATCH',
      message: `npm-${config.lockfileVersion} adapter: top-level "packages" map is required`,
    })
  }

  config.hooks?.validateTopLevel?.(lf)
  const packages = lf.packages as Record<string, NpmEntry>
  const rootEntry = packages['']
  if (rootEntry === undefined) {
    throw parseFailed(config, 'missing root entry under "packages"')
  }

  const rootName = rootEntry.name ?? lf.name ?? '.'
  const rootVersion = rootEntry.version ?? lf.version ?? '0.0.0'
  return {
    config,
    lf,
    packages,
    rootEntry,
    rootName,
    rootVersion,
    rootId: `${rootName}@${rootVersion}`,
    builder: newBuilder(),
    diagnostics: [],
    nodeSidecar: new Map(),
    packageEntriesByPath: new Map(),
    linkEntriesByPath: new Map(),
    edgeRanges: new Map(),
    edgeDeclaredNames: new Map(),
    reservedEdgeRanges: new Map(),
    workspaceByPath: new Map(),
    pathToId: new Map(),
    patchByPath: new Map(),
    idToEntry: new Map(),
    linkNameByPath: new Map(),
    options,
  }
}

function parseJson(input: string, config: NpmFamilyConfig): NpmLockfile {
  let parsed: unknown
  try {
    parsed = JSON.parse(input)
  } catch (error) {
    throw new LockfileError({
      code: 'FORMAT_MISMATCH',
      message: `npm-${config.lockfileVersion} adapter: input is not valid JSON: ${(error as Error).message}`,
      cause: error,
    })
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new LockfileError({
      code: 'FORMAT_MISMATCH',
      message: `npm-${config.lockfileVersion} adapter: top-level value must be a JSON object`,
    })
  }
  return parsed as NpmLockfile
}

// === Graph construction =====================================================

function addNpmRootNode(context: NpmParseContext): void {
  const { builder, config, idToEntry, lf, pathToId, rootEntry, rootId, rootName, rootVersion } = context
  // npm's `packages[""]` (the project root, a workspace node per)
  // legitimately omits `name` and/or `version` for private / unpublished
  // roots — the dominant shape for apps and monorepo roots (some omit both;
  // some carry a name but no version).
  // Synthesize the missing pieces rather than refusing to parse: name falls
  // back to npm's own root key `.`; version to the unpublished sentinel
  // `0.0.0` (cf. yarn-berry's `0.0.0-use.local`,). A diagnostic
  // records the synthesis so the round-trip stays auditable. Workspace
  // MEMBERS (below) keep the strict name/version requirement.
  if (rootEntry.version === undefined && lf.version === undefined) {
    builder.diagnostic({
      code:     `${config.diagnosticPrefix}_ROOT_VERSION_SYNTHESIZED`,
      severity: 'info',
      subject:  'graph',
      message:  `private root entry carries no version; synthesised '${rootVersion}'`,
    })
  }
  pathToId.set('', rootId)
  idToEntry.set(rootId, rootEntry)
  builder.addNode({
    id: rootId,
    name: rootName,
    version: rootVersion,
    peerContext: [],
    workspacePath: '',
  })
}

function indexNpmWorkspaceLinkNames(context: NpmParseContext): void {
  const { linkNameByPath, packages } = context
  // npm `link: true` entries are the symlinks (`node_modules/<pkgname>` →
  // `resolved: <member-path>`) through which the rest of the tree references
  // a workspace member. They are the authoritative source of a member's
  // package name when the member's own `packages/<path>` entry omits it
  // (private workspaces routinely do — a member's `packages/<dir>` entry can
  // carry a version but no name). Unlike the path's last segment, the link
  // name handles scoped packages (`@scope/pkg` linked from a `packages/pkg`
  // dir). Build the path → link-name map up front.
  for (const [key, entry] of Object.entries(packages)) {
    if (entry.link !== true || typeof entry.resolved !== 'string') continue
    const at = key.lastIndexOf('node_modules/')
    if (at < 0) continue
    const linkName = key.slice(at + 'node_modules/'.length)
    if (!linkNameByPath.has(entry.resolved)) linkNameByPath.set(entry.resolved, linkName)
  }
}

function addWorkspaceMemberNodes(context: NpmParseContext): void {
  const { builder, config, idToEntry, linkNameByPath, packages, pathToId, workspaceByPath } = context
  // Pass 1a: workspace member entries (under bare `<wsPath>` keys).
  for (const [path, entry] of Object.entries(packages)) {
    if (path === '' || path.startsWith('node_modules/')) continue
    if (path.includes('/node_modules/')) continue
    if (entry.link === true) continue
    // Synthesize a missing name from the symlink that references this member
    // (falling back to the path's last segment), and a missing version from
    // the unpublished sentinel `0.0.0` (cf. the root entry above). A private
    // workspace member legitimately omits either.
    const synthName = entry.name ?? linkNameByPath.get(path) ?? path.slice(path.lastIndexOf('/') + 1)
    const synthVersion = entry.version ?? '0.0.0'
    if (entry.name === undefined || entry.version === undefined) {
      builder.diagnostic({
        code:     `${config.diagnosticPrefix}_WORKSPACE_MEMBER_SYNTHESIZED`,
        severity: 'info',
        subject:  'graph',
        message:  `private workspace member ${JSON.stringify(path)} omits ${entry.name === undefined ? 'name' : ''}${entry.name === undefined && entry.version === undefined ? '/' : ''}${entry.version === undefined ? 'version' : ''}; synthesised ${synthName}@${synthVersion}`,
      })
    }
    const name = synthName
    const version = synthVersion
    const id = `${name}@${version}`
    if (idToEntry.has(id) && idToEntry.get(id) !== entry) {
      throw new LockfileError({
        code: 'IRREDUCIBLE_LOSS',
        message: `two npm-${config.lockfileVersion} entries collapse onto NodeId ${id}`,
      })
    }
    pathToId.set(path, id)
    idToEntry.set(id, entry)
    workspaceByPath.set(path, id)
    builder.addNode({
      id,
      name,
      version,
      peerContext: [],
      workspacePath: path,
    })
  }
}

function addInstalledPackageNodes(context: NpmParseContext): void {
  const {
    builder,
    config,
    diagnostics,
    idToEntry,
    linkEntriesByPath,
    options,
    packages,
    patchByPath,
    pathToId,
    rootId,
    workspaceByPath,
  } = context
  const manifestNodeIds = new Set([rootId, ...workspaceByPath.values()])
  // Pass 1b: node_modules/... entries. Workspace-member paths must already be
  // indexed because link resolution below reads `pathToId`.
  for (const [path, entry] of Object.entries(packages)) {
    if (!path.startsWith('node_modules/') && !path.includes('/node_modules/')) continue

    if (entry.link === true) {
      const target = entry.resolved
      if (target === undefined) {
        throw parseFailed(config, `link entry ${JSON.stringify(path)} missing resolved`)
      }
      const targetId = pathToId.get(target)
      if (targetId === undefined) {
        throw parseFailed(config, `link entry ${JSON.stringify(path)} resolves to unknown workspace ${JSON.stringify(target)}`)
      }
      pathToId.set(path, targetId)
      linkEntriesByPath.set(path, {
        targetNodeId: targetId,
        nativeEntry: entry,
      })
      continue
    }

    // An uninstalled optional dependency: npm records a bare `{optional: true}`
    // placeholder (no version / resolved / integrity) for a platform-specific
    // optional native it did not install on this platform — e.g. a nested
    // `node_modules/<pkg>/node_modules/<native-addon>` placeholder. There is
    // no resolved instance to model, so skip it; the consumer's
    // `optionalDependencies` edge simply finds no target, which is valid for
    // an optional dep (emits a benign unresolved-dep warning at most).
    if (entry.version === undefined && entry.resolved === undefined && entry.optional === true) {
      continue
    }

    const tailName = nameFromInstallPath(config, path, entry)
    const version = entry.version
    if (version === undefined) {
      throw parseFailed(config, `entry ${JSON.stringify(path)} missing version`)
    }
    // fold the `+src=` non-registry discriminator into the NodeId so a
    // git `is@6.3.1` cannot collapse onto a registry `is@6.3.1`.
    const source = sourceDiscriminatorOfNpmEntry(entry)
    const resolvedPatch = config.hooks?.resolvePatch?.({
      path,
      name: tailName,
      version,
      source,
      entry,
      options,
    })
    const patch = resolvedPatch?.patch
    const id = serializeNodeId(tailName, version, [], patch, source)
    if (resolvedPatch?.diagnostic !== undefined) {
      diagnostics.push(resolvedPatch.diagnostic)
    }
    if (resolvedPatch?.normalised === true) {
      diagnostics.push(patchNormalizedDiagnostic(id))
    }
    pathToId.set(path, id)
    if (patch !== undefined) patchByPath.set(path, patch)

    const existing = idToEntry.get(id)
    if (existing === undefined) {
      idToEntry.set(id, entry)
      const node: Node = {
        id,
        name: tailName,
        version,
        peerContext: [],
      }
      if (patch !== undefined) node.patch = patch
      // carry the slot on the Node so the seal re-derives the id.
      if (source !== undefined) node.source = source
      builder.addNode(node)
      if (entry.inBundle !== true || entry.integrity !== undefined || hasTarballPayload(entry)) {
        builder.setTarball(
          { name: tailName, version, patch, source },
          tarballPayloadOf(entry, id, diagnostics, tailName, version, options.registryFor),
        )
      }
    } else if (manifestNodeIds.has(id)) {
      // Root/workspace manifest nodes and installed package entries can share
      // one canonical identity. The physical entry is captured per path in
      // pass 2; do not leak its tarball payload onto the project manifest node.
      // That keeps generated/cross-format graph semantics unchanged while the
      // exact native placement remains available for same-format replay.
    } else if (Array.isArray(entry.bundleDependencies)
      && !Array.isArray(existing.bundleDependencies)) {
      // npm can omit a package's native bundle carrier at one install path and
      // include it at another path that collapses to the same canonical node.
      // Merge the carrier into the already-selected payload rather than making
      // parse order decide whether the canonical metadata survives.
      const merged = {
        ...existing,
        bundleDependencies: entry.bundleDependencies.slice(),
      }
      idToEntry.set(id, merged)
      builder.setTarball(
        { name: tailName, version, patch, source },
        tarballPayloadOf(merged, id, diagnostics, tailName, version, options.registryFor),
      )
    }
  }
}

function addNpmPackageEdges(context: NpmParseContext): void {
  const {
    builder,
    config,
    diagnostics,
    edgeDeclaredNames,
    edgeRanges,
    packageEntriesByPath,
    linkEntriesByPath,
    reservedEdgeRanges,
    nodeSidecar,
    patchByPath,
    packages,
    pathToId,
    workspaceByPath,
  } = context
  const linkedWorkspaceIds = new Set<string>()
  for (const [path, entry] of Object.entries(packages)) {
    if (entry.link !== true || path === '') continue
    const targetId = pathToId.get(path)
    if (targetId !== undefined) linkedWorkspaceIds.add(targetId)
  }
  // Pass 2: edges + per-node sidecar data. `pathToId` is total before this
  // phase begins, so dependency resolution cannot observe a partial node pass.
  for (const [path, entry] of Object.entries(packages)) {
    const srcId = pathToId.get(path)
    if (srcId === undefined) continue
    if (entry.link === true && path !== '') continue

    const nodeSide = ensureSidecar(nodeSidecar, srcId)
    if (entry.inBundle === true) nodeSide.inBundle = true
    if (entry.dev === true) nodeSide.dev = true
    if (entry.optional === true) nodeSide.optional = true
    if (entry.peer === true) nodeSide.peer = true
    // WS-LINK: capture npm's `extraneous` flag so a workspace
    // member that npm did NOT link (present on disk, absent from the install
    // graph) re-emits without a top-level link on replay.
    if (entry.extraneous === true) nodeSide.extraneous = true
    if (path !== '' && entry.link !== true) {
      packageEntriesByPath.set(path, {
        nodeId: srcId,
        nativeEntry: entry,
      })
    }

    // Adapter-specific per-entry capture (npm-2 mirror: stash `resolved`
    // URL for legacy-mirror emit). Core stays version-neutral — it does
    // not know what the hook is for.
    config.hooks?.captureEntry?.(srcId, entry)
    config.hooks?.captureNodeSidecar?.({
      path,
      srcId,
      patch: patchByPath.get(path),
      entry,
      nodeSidecar: nodeSide,
    })

    const isRoot = path === ''
    const isWorkspaceMember = workspaceByPath.has(path)
    const treatAsManifest = isRoot || isWorkspaceMember
    // Same-format replay must not manufacture the conventional top-level
    // workspace link when the source packages table omitted it. Reuse the
    // existing layout flag consumed by stringify; generated/foreign graphs
    // have no npm sidecar and retain the normal synthesize-link behaviour.
    if (isWorkspaceMember && !linkedWorkspaceIds.has(srcId)) {
      nodeSide.extraneous = true
    }

    addDepEdges(builder, config, edgeRanges, edgeDeclaredNames, reservedEdgeRanges, path, srcId, entry.dependencies, 'dep', pathToId, diagnostics)
    addDepEdges(builder, config, edgeRanges, edgeDeclaredNames, reservedEdgeRanges, path, srcId, entry.optionalDependencies, 'optional', pathToId, diagnostics)

    if (treatAsManifest) {
      addDepEdges(builder, config, edgeRanges, edgeDeclaredNames, reservedEdgeRanges, path, srcId, entry.devDependencies, 'dev', pathToId, diagnostics)
    } else if (entry.devDependencies !== undefined) {
      nodeSide.devDependencies = { ...entry.devDependencies }
    }

    if (entry.peerDependencies !== undefined) {
      nodeSide.peerDependencies = { ...entry.peerDependencies }
    }
    if (entry.optionalDependencies !== undefined && !treatAsManifest) {
      nodeSide.optionalDependencies = { ...entry.optionalDependencies }
    }

    if (path !== '' && !workspaceByPath.has(path)) {
      nodeSide.installPaths.push(path)
    }
  }
}

function captureNpmRootMeta(context: NpmParseContext): NpmRootMeta {
  const { config, diagnostics, lf, nodeSidecar, rootEntry } = context
  // Pass 3: root meta.
  const rootMeta: NpmRootMeta = {
    name: lf.name ?? rootEntry.name,
    version: lf.version ?? rootEntry.version,
    requires: lf.requires,
    ...(config.lockfileVersion === 2 || config.lockfileVersion === 3
      ? {
          nativeRootEntry: {
            lockfileVersion: config.lockfileVersion,
            value: cloneNpmRootEntry(rootEntry),
          },
        }
      : {}),
  }
  context.config.hooks?.captureRootMeta?.({ lf, rootEntry, rootMeta })
  const workspaces = captureWorkspacesField(rootEntry.workspaces, rootMeta, diagnostics)
  if (workspaces !== undefined) rootMeta.workspaces = workspaces
  if (rootEntry.bundleDependencies !== undefined) {
    rootMeta.bundleDependencies = Array.isArray(rootEntry.bundleDependencies)
      ? rootEntry.bundleDependencies.slice()
      : rootEntry.bundleDependencies
  }
  if (rootEntry.devDependencies !== undefined) rootMeta.devDependencies = { ...rootEntry.devDependencies }
  if (rootEntry.peerDependencies !== undefined) rootMeta.peerDependencies = { ...rootEntry.peerDependencies }
  if (rootEntry.optionalDependencies !== undefined) rootMeta.optionalDependencies = { ...rootEntry.optionalDependencies }

  // Defensive capture ONLY. Real npm `package-lock.json` carries NO
  // `packages[""].overrides` — npm reads the override policy from the root
  // MANIFEST, never the lock (canary: overrides-canary.test.ts). This fires only
  // for a non-native lock that happens to carry the field; capture preserves it
  // in the graph (`nativeOverrides` verbatim + `overrides` canonical for query) but
  // NEVER re-emit it into npm output (see stringify — the field is not npm-native
  // and cannot preserve policy). F6 capture is recipe-pure; RECIPE_OVERRIDE_
  // NORMALISED funnels through the same `diagnostics` buffer as the rest of parse.
  if (rootEntry.overrides !== undefined) {
    const captured = captureOverrides(rootEntry.overrides, 'npm', d => diagnostics.push(d))
    if (captured.canonical.length > 0) rootMeta.overrides = captured.canonical
    if (captured.native.npmOverrides !== undefined) {
      rootMeta.nativeOverrides = captured.native.npmOverrides as Record<string, unknown>
    }
  }

  for (const sc of nodeSidecar.values()) {
    sc.installPaths = Array.from(new Set(sc.installPaths)).sort(cmpStr)
  }
  return rootMeta
}

// `packages[""].workspaces` as npm itself copies it out of the root manifest.
// BOTH npm spellings are legitimate and are carried VERBATIM: the array form
// `["a", "b"]`, and the object form `{ "packages": ["a"], "nohoist": [...] }`
// that `@npmcli/map-workspaces` reads (npm's own arborist fixtures use it).
// Nothing in the graph iterates this value — it is metadata replayed on emit —
// so normalising the object form down to its `packages` array would buy nothing
// and would re-emit a root entry that differs from the one npm writes.
// Anything that is neither shape is not a field npm can read back, so it is
// reported against the root package by NAME (its entry key is the empty string,
// which would be a useless subject) and dropped.
function captureWorkspacesField(
  value: NpmEntry['workspaces'],
  rootMeta: NpmRootMeta,
  diagnostics: Diagnostic[],
): NpmWorkspacesField | undefined {
  const raw: unknown = value
  if (raw === undefined) return undefined
  if (Array.isArray(raw)) return raw.slice() as string[]
  if (raw !== null && typeof raw === 'object') return { ...raw as Record<string, unknown> }
  diagnostics.push({
    code: 'NPM_BAD_ROOT_WORKSPACES',
    severity: 'warning',
    subject: rootMeta.name ?? 'packages[""]',
    message: `root "workspaces" must be an array or an object, got ${raw === null ? 'null' : typeof raw}; dropping`,
  })
  return undefined
}

function emitNpmParseDiagnostics(context: NpmParseContext): void {
  const { builder, config, diagnostics, lf, packages } = context
  // Top-level `dependencies` handling: packages-only emits the legacy-mirror
  // warning unconditionally; dual delegates drift detection to the hook
  // (which has the npm-2-specific shape knowledge).
  if (lf.dependencies !== undefined && config.topLevelShape === 'packages-only') {
    diagnostics.push({
      code: `${config.diagnosticPrefix}_UNEXPECTED_LEGACY_MIRROR`,
      severity: 'warning',
      message: `npm-${config.lockfileVersion} lockfile carries a top-level "dependencies" mirror; dropping on parse`,
    })
  }
  config.hooks?.emitParseDiagnostics?.({ lf, packages, diagnostics })

  for (const diagnostic of diagnostics) {
    builder.diagnostic(diagnostic)
  }
}

function sealNpmParseContext(context: NpmParseContext, rootMeta: NpmRootMeta): Graph {
  const {
    builder,
    config,
    edgeDeclaredNames,
    edgeRanges,
    lf,
    linkEntriesByPath,
    nodeSidecar,
    packageEntriesByPath,
    packages,
    rootId,
    workspaceByPath,
    options,
  } = context
  try {
    const graph = builder.seal()
    const sidecar: NpmSidecar = {
      rootId,
      rootMeta,
      edgeRanges,
      edgeDeclaredNames,
      nodes: nodeSidecar,
      packageEntriesByPath,
      linkEntriesByPath,
      workspaceByPath,
      unknownTopLevel: captureUnknownTopLevel(lf as Readonly<Record<string, unknown>>, [
        'name',
        'version',
        'lockfileVersion',
        'requires',
        'packages',
        'dependencies',
      ]),
    }
    sidecarByGraph.set(graph, sidecar)
    config.hooks?.afterParse?.({ graph, lf, packages, rootId, options })
    captureCanonicalPackageEntries(graph, sidecar, config)
    return graph
  } catch (error) {
    if (error instanceof GraphError) {
      throw new LockfileError({
        code: 'PARSE_FAILED',
        message: `npm-${config.lockfileVersion} seal failed: ${error.message}`,
      })
    }
    throw error
  }
}

function captureCanonicalPackageEntries(
  graph: Graph,
  sidecar: NpmSidecar,
  config: NpmFamilyConfig,
): void {
  const entries = sidecar.packageEntriesByPath
  if (entries === undefined) return
  const entriesByNodeId = new Map<string, NpmPackageEntrySidecar[]>()
  for (const entry of entries.values()) {
    const siblings = entriesByNodeId.get(entry.nodeId) ?? []
    siblings.push(entry)
    entriesByNodeId.set(entry.nodeId, siblings)
  }
  const differingNodeIds = new Set<string>()
  for (const [nodeId, siblings] of entriesByNodeId) {
    const [firstEntry] = siblings
    if (firstEntry === undefined || siblings.length < 2) continue
    const first = firstEntry.nativeEntry
    if (siblings.some(entry => !packageEntryMetadataEqual(first, entry.nativeEntry))) {
      differingNodeIds.add(nodeId)
    }
  }
  for (const [path, entry] of entries) {
    const node = graph.getNode(entry.nodeId)
    const isManifestPlacement = node?.workspacePath !== undefined
    // Sibling disagreement is one reason the projection would not reproduce a
    // key. A key the projection cannot emit AT ALL is another, and it needs no
    // sibling to be lost — `hasShrinkwrap`, `extraneous`, `devOptional` and any
    // npm key we have not modelled reach the emit with nowhere to come from.
    const carriesUnprojectableKey = Object.entries(entry.nativeEntry)
      .some(([key, value]) => !NODE_MODULES_ENTRY_KEYS.has(key)
        || (RECORD_SHAPED_PAYLOAD_KEYS.has(key) && Array.isArray(value)))
    if (!differingNodeIds.has(entry.nodeId) && !isManifestPlacement && !carriesUnprojectableKey) {
      entries.delete(path)
    }
  }
  const canonicalEntriesByNodeId = new Map<string, Readonly<Record<string, unknown>>>()
  for (const [path, entry] of entries) {
    const node = graph.getNode(entry.nodeId)
    if (node === undefined) continue
    const nodeSidecar = sidecar.nodes.get(node.id)
    const installPaths = nodeSidecar?.installPaths ?? [path]
    let canonicalEntry = node.workspacePath === undefined
      ? canonicalEntriesByNodeId.get(node.id)
      : undefined
    if (canonicalEntry === undefined) {
      if (node.workspacePath === undefined) {
        canonicalEntry = buildNodeModulesEntry(graph, node, nodeSidecar, installPaths, config)
      } else if (node.workspacePath === path) {
        // A bare workspace member and an installed self-placement are distinct
        // npm projections. Baseline the former with the workspace builder;
        // using buildManifestPlacementEntry here would make the native merge
        // overlay the wrong canonical values while still looking plausible.
        canonicalEntry = buildWorkspaceMemberEntry(graph, node, sidecar, config)
      } else {
        canonicalEntry = buildManifestPlacementEntry(
          graph,
          node,
          nodeSidecar,
          installPaths,
          entry,
          config,
        )
      }
      if (node.workspacePath === undefined) canonicalEntriesByNodeId.set(node.id, canonicalEntry)
    }
    entry.canonicalEntry = canonicalEntry
  }
}

function hasTarballPayload(entry: NpmEntry): boolean {
  return entry.integrity !== undefined
    || entry.engines !== undefined
    || entry.funding !== undefined
    || entry.license !== undefined
    || entry.bin !== undefined
    || entry.deprecated !== undefined
    || entry.cpu !== undefined
    || entry.os !== undefined
    || entry.libc !== undefined
    || entry.peerDependencies !== undefined
    || entry.peerDependenciesMeta !== undefined
    || entry.hasInstallScript !== undefined
    || Array.isArray(entry.bundleDependencies)
    || entry.resolved !== undefined
}

// the `+src=` discriminator for an npm entry's NON-REGISTRY source.
// npm keys an install entry's node by `<name>@<version>` (the resolution URL is
// only the `resolved:` field), so a registry `is@6.3.1` and a git `is@6.3.1`
// would collapse onto one NodeId. Derived from the same `resolved`-URL
// canonical as `tarballPayloadOf`; bare for registry / directory / link / absent
// (zero registry blast radius). A `link:` entry is a workspace/local link whose
// identity is on Node.workspacePath, never source-discriminated.
function sourceDiscriminatorOfNpmEntry(entry: NpmEntry): string | undefined {
  if (typeof entry.resolved !== 'string' || entry.link) return undefined
  return sourceDiscriminatorOf(parseResolutionRecipe(entry.resolved, { sourceKind: 'npm-resolved' }))
}

function tarballPayloadOf(
  entry: NpmEntry,
  subject: string,
  diagnostics: Diagnostic[],
  name: string,
  version: string,
  registryFor?: (packageName: string) => string | undefined,
): TarballPayload {
  const payload: TarballPayload = {}
  if (entry.integrity !== undefined) {
    const integrity = parseSri(entry.integrity, 'sri')
    if (isEmptyIntegrity(integrity)) {
      diagnostics.push(invalidIntegrityDiagnostic('NPM', subject, entry.integrity))
    } else {
      payload.integrity = integrity
    }
  }
  // npm tolerates a legacy ARRAY `engines` (`["node >= 0.8.0"]`). Spreading it
  // into the record-shaped canonical field turns it into `{"0": "node >= 0.8.0"}`
  // — a different value, not a different spelling. Decline the shape here so the
  // exact-path native record stays its only carrier; `RECORD_SHAPED_PAYLOAD_KEYS`
  // makes retention fire for it.
  if (entry.engines !== undefined && !Array.isArray(entry.engines)) {
    payload.engines = { ...entry.engines }
  }
  if (entry.funding !== undefined) payload.funding = entry.funding
  if (entry.license !== undefined) payload.license = entry.license
  if (entry.bin !== undefined) payload.bin = typeof entry.bin === 'string' ? entry.bin : { ...entry.bin }
  if (entry.deprecated !== undefined) payload.deprecated = entry.deprecated
  if (entry.cpu !== undefined) payload.cpu = entry.cpu.slice()
  if (entry.os !== undefined) payload.os = entry.os.slice()
  if (entry.libc !== undefined) payload.libc = entry.libc.slice()
  if (entry.peerDependencies !== undefined) payload.peerDependencies = { ...entry.peerDependencies }
  if (entry.peerDependenciesMeta !== undefined) {
    payload.peerDependenciesMeta = Object.fromEntries(
      Object.entries(entry.peerDependenciesMeta).map(([peer, meta]) => [peer, { ...meta }]))
  }
  if (entry.hasInstallScript !== undefined) payload.hasInstallScript = entry.hasInstallScript
  if (Array.isArray(entry.bundleDependencies)) {
    payload.bundledDependencies = entry.bundleDependencies.slice()
  }
  // canonical resolution from npm `resolved` URL.
  if (typeof entry.resolved === 'string' && !entry.link) {
    const canonical = parseResolutionRecipe(entry.resolved, { sourceKind: 'npm-resolved' })
    // A local directory may use `file:`, `link:`, or `portal:` spelling.
    // Canonical F3 intentionally collapses those spellings, so retain the
    // native npm entry value for exact same-format replay.
    if (canonical.type === 'directory') {
      payload.nativeResolution = entry.resolved
    }
    if (canonical.type === 'unknown') {
      diagnostics.push(unknownResolutionDiagnostic(subject, entry.resolved))
    }
    payload.resolution = canonical
  } else if (!entry.link && entry.inBundle !== true) {
    const registry = registryFor?.(name)
    payload.resolution = registry === undefined
      ? { type: 'registry' }
      : { type: 'tarball', url: registryTarballUrl(name, version, registry) }
  }
  return payload
}

function ensureSidecar(map: Map<string, NpmFlatSidecar>, id: string): NpmFlatSidecar {
  let sc = map.get(id)
  if (sc === undefined) {
    sc = { installPaths: [] }
    map.set(id, sc)
  }
  return sc
}

function addDepEdges(
  builder: ReturnType<typeof newBuilder>,
  config: NpmFamilyConfig,
  edgeRanges: Map<string, string>,
  edgeDeclaredNames: Map<string, string>,
  reservedEdgeRanges: Map<string, string>,
  srcPath: string,
  srcId: string,
  deps: Record<string, string> | undefined,
  kind: EdgeKind,
  pathToId: Map<string, string>,
  diagnostics: Diagnostic[],
): void {
  if (deps === undefined) return
  for (const [name, range] of Object.entries(deps).sort((a, b) => cmpStr(a[0], b[0]))) {
    const dstId = resolveDepTarget(srcPath, name, pathToId)
    if (dstId === undefined) {
      diagnostics.push({
        code: 'NPM_UNRESOLVED_DEP',
        severity: 'warning',
        subject: srcId,
        message: `${srcId}: unresolved ${kind} ${name}@${range}`,
        data: unresolvedDependencyData({
          src: srcId,
          kind,
          name,
          descriptor: range,
        }),
      })
      continue
    }
    // EdgeAttrs.alias — preserved when the manifest dep key differs from
    // the target's actual name. npm encodes aliases via `node_modules/<alias>`
    // entries whose `entry.name` is the target's real name; resolution already
    // follows that channel, so a mismatch between `name`
    // (the manifest key) and the dst node's name reveals the alias.
    // `edgeRanges` / `edgeDeclaredNames` keep the existing 3-part key
    // shape (pruneSidecar splits on `|`); cross-format consumers that
    // need per-alias data read `edge.attrs.alias` directly.
    const aliasSlot = name === nameOf(dstId) ? undefined : name
    const edgeKey = edgeTripleKey(srcId, kind, dstId)
    // npm can install the same package@version at multiple paths. Those paths
    // intentionally collapse onto one graph NodeId, so their identical
    // outgoing declarations must collapse too. Alias is part of graph edge
    // identity: two different declared names may legally target the same node.
    // A repeated identity with a different range is not safely reducible.
    const reservedEdgeKey = `${srcId}\u0000${kind}\u0000${dstId}\u0000${aliasSlot ?? ''}`
    const reservedRange = reservedEdgeRanges.get(reservedEdgeKey)
    if (reservedRange !== undefined) {
      if (reservedRange === range) continue
      throw new LockfileError({
        code: 'IRREDUCIBLE_LOSS',
        message: `npm-${config.lockfileVersion} repeated edge ${srcId} →${kind} ${dstId}${aliasSlot === undefined ? '' : ` (alias=${aliasSlot})`} carries incompatible ranges ${JSON.stringify(reservedRange)} and ${JSON.stringify(range)}`,
      })
    }
    reservedEdgeRanges.set(reservedEdgeKey, range)
    if (aliasSlot === undefined) {
      edgeRanges.set(edgeKey, range)
      edgeDeclaredNames.set(edgeKey, name)
    } else if (!edgeRanges.has(edgeKey)) {
      edgeRanges.set(edgeKey, range)
      edgeDeclaredNames.set(edgeKey, name)
    }
    const attrs: { range: string; alias?: string } = { range }
    if (aliasSlot !== undefined) attrs.alias = aliasSlot
    builder.addEdge(srcId, dstId, kind, attrs)
  }
}

function parseFailed(config: NpmFamilyConfig, message: string): LockfileError {
  return new LockfileError({
    code: 'PARSE_FAILED',
    message: `npm-${config.lockfileVersion}: ${message}`,
  })
}

// === SERIALIZE ==============================================================

export function fallbackInstallPathForNode(node: Node, pathToId: ReadonlyMap<string, string>): string {
  const primary = `node_modules/${node.name}`
  const occupant = pathToId.get(primary)
  if (occupant === undefined || occupant === node.id) return primary

  let ordinal = 1
  while (true) {
    const synthetic = `node_modules/.lockfile-${encodeURIComponent(node.name)}-${encodeURIComponent(node.version)}-${ordinal}/node_modules/${node.name}`
    const existing = pathToId.get(synthetic)
    if (existing === undefined || existing === node.id) return synthetic
    ordinal++
  }
}

export function buildSyntheticRootEntry(
  rootMeta: NpmRootMeta,
  config?: NpmFamilyConfig,
): Record<string, unknown> {
  const body = cloneNativeRootEntry(rootMeta, config)
  if (rootMeta.name !== undefined) body.name = rootMeta.name
  if (rootMeta.version !== undefined) body.version = rootMeta.version
  if (rootMeta.workspaces !== undefined) body.workspaces = rootMeta.workspaces
  if (rootMeta.bundleDependencies !== undefined) body.bundleDependencies = rootMeta.bundleDependencies
  delete body.overrides
  return body
}

function cloneNpmRootEntry(value: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>
}

function buildPackageEntryAtPath(
  canonicalEntry: Readonly<Record<string, unknown>>,
  pathState: NpmPackageEntrySidecar | undefined,
  nodeId: string,
): Record<string, unknown> {
  if (pathState?.nodeId !== nodeId || pathState.canonicalEntry === undefined) {
    return cloneNpmRootEntry(canonicalEntry)
  }
  const body = cloneNpmRootEntry(pathState.nativeEntry)
  const baseline = pathState.canonicalEntry
  const canonicalKeys = new Set([...Object.keys(baseline), ...Object.keys(canonicalEntry)])
  for (const key of canonicalKeys) {
    if (!PACKAGE_ENTRY_DEPENDENCY_KEYS.has(key)
      && jsonValueEqual(baseline[key], canonicalEntry[key])) continue
    if (Object.hasOwn(canonicalEntry, key)) {
      body[key] = cloneJsonValue(canonicalEntry[key])
    } else {
      delete body[key]
    }
  }
  return body
}

function cloneJsonValue(value: unknown): unknown {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

function packageEntryMetadataEqual(
  left: Readonly<Record<string, unknown>>,
  right: Readonly<Record<string, unknown>>,
): boolean {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)])
  for (const key of keys) {
    if (PACKAGE_ENTRY_DEPENDENCY_KEYS.has(key)) continue
    if (!jsonValueEqual(left[key], right[key])) return false
  }
  return true
}

function jsonValueEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') {
    return false
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
    return left.every((value, index) => jsonValueEqual(value, right[index]))
  }
  const leftRecord = left as Readonly<Record<string, unknown>>
  const rightRecord = right as Readonly<Record<string, unknown>>
  const leftKeys = Object.keys(leftRecord)
  if (leftKeys.length !== Object.keys(rightRecord).length) return false
  return leftKeys.every(key => Object.hasOwn(rightRecord, key)
    && jsonValueEqual(leftRecord[key], rightRecord[key]))
}

function cloneNativeRootEntry(
  rootMeta: NpmRootMeta | undefined,
  config: NpmFamilyConfig | undefined,
): Record<string, unknown> {
  const native = rootMeta?.nativeRootEntry
  return native !== undefined && nativeRootEntryPortableTo(rootMeta, config)
    ? cloneNpmRootEntry(native.value)
    : {}
}

function nativeRootEntryPortableTo(
  rootMeta: NpmRootMeta | undefined,
  config: NpmFamilyConfig | undefined,
): boolean {
  const sourceVersion = rootMeta?.nativeRootEntry?.lockfileVersion
  const targetVersion = config?.lockfileVersion
  return (sourceVersion === 2 || sourceVersion === 3)
    && (targetVersion === 2 || targetVersion === 3)
}

function overlayRootBlock(
  body: Record<string, unknown>,
  key: 'dependencies' | 'devDependencies' | 'peerDependencies' | 'optionalDependencies',
  value: Record<string, string> | undefined,
): void {
  if (value !== undefined && Object.keys(value).length > 0) {
    const native = body[key]
    if (native !== null && typeof native === 'object' && !Array.isArray(native)) {
      const overlaid: Record<string, string> = {}
      for (const nativeKey of Object.keys(native)) {
        if (Object.hasOwn(value, nativeKey)) overlaid[nativeKey] = value[nativeKey]!
      }
      for (const valueKey of Object.keys(value)) {
        if (!Object.hasOwn(overlaid, valueKey)) overlaid[valueKey] = value[valueKey]!
      }
      body[key] = overlaid
    } else {
      body[key] = value
    }
    return
  }
  const native = body[key]
  const nativeIsExplicitEmpty = native !== null
    && typeof native === 'object'
    && !Array.isArray(native)
    && Object.keys(native).length === 0
  if (!nativeIsExplicitEmpty) delete body[key]
}

export function collectManifestBlocks(
  graph: Graph,
  srcId: string,
  sidecar: NpmSidecar | undefined,
  emitDiagnostic: (d: Diagnostic) => void = () => undefined,
): {
  dep: Record<string, string>
  dev: Record<string, string>
  peer: Record<string, string>
  optional: Record<string, string>
} {
  const dep: Record<string, string> = {}
  const dev: Record<string, string> = {}
  const peer: Record<string, string> = {}
  const optional: Record<string, string> = {}
  for (const edge of graph.out(srcId)) {
    const dst = graph.getNode(edge.dst)
    if (dst === undefined) continue
    const rawRange = edge.attrs?.[NPM_EDGE_RANGE_ATTR]
    if (typeof rawRange !== 'string') continue
    const target = edge.kind === 'dep' ? dep
      : edge.kind === 'dev' ? dev
      : edge.kind === 'peer' ? peer
      : edge.kind === 'optional' ? optional
      : undefined
    if (target === undefined) continue
    const edgeKey = edgeTripleKey(edge.src, edge.kind, edge.dst)
    // EdgeAttrs.alias is the canonical source for the per-edge declared
    // descriptor key — sidecar.edgeDeclaredNames is a legacy parse-side
    // cache kept for the rare case where the edge lost its attrs through
    // a cross-format detour. Prefer the attrs slot; fall back to sidecar;
    // fall back to dst.name (canonical descriptor).
    const declaredName = edge.attrs?.alias ?? sidecar?.edgeDeclaredNames.get(edgeKey) ?? dst.name

    // workspace edges: npm lacks the `workspace:` protocol
    // entirely (link entries carry workspace identity; the dep range itself
    // is a concrete version). When the source carried a non-empty workspace
    // specifier, fire RECIPE_WORKSPACE_RESOLVED; when no resolvedVersion is
    // available, fire RECIPE_WORKSPACE_UNRESOLVED and drop the entry.
    if (isWorkspaceEdge(edge)) {
      const ws = workspaceRangeOfEdge(edge, dst)
      if (ws !== undefined) {
        const resolved = stringifyForVersionOnly(ws)
        if (resolved === undefined) {
          emitWorkspaceUnresolved(
            { src: edge.src, dst: edge.dst, kind: edge.kind },
            emitDiagnostic,
          )
          continue
        }
        if (shouldEmitWorkspaceResolved(ws)) {
          emitWorkspaceResolved(
            { src: edge.src, dst: edge.dst, kind: edge.kind },
            ws.specifier,
            resolved,
            emitDiagnostic,
          )
        }
        target[declaredName] = resolved
        continue
      }
    }
    target[declaredName] = rawRange
  }
  return {
    dep: sortRecord(mergeUnresolvedDependencyDeclarations(graph, srcId, 'dep', dep)),
    dev: sortRecord(mergeUnresolvedDependencyDeclarations(graph, srcId, 'dev', dev)),
    peer: sortRecord(peer),
    optional: sortRecord(mergeUnresolvedDependencyDeclarations(graph, srcId, 'optional', optional)),
  }
}

function deriveInstallPathsForStringify(
  graph: Graph,
  sidecar: NpmSidecar | undefined,
  rootNode: Node | undefined,
  onDiagnostic?: (d: Diagnostic) => void,
): Map<string, string[]> {
  const byNodeId = new Map<string, Set<string>>()
  const pathToId = new Map<string, string>()
  const seenConsumers = new Set<string>()
  const queue: Array<{ nodeId: string; path: string }> = []

  const addConsumer = (nodeId: string, consumerPath: string): void => {
    const key = `${nodeId}\u0000${consumerPath}`
    if (seenConsumers.has(key)) return
    seenConsumers.add(key)
    queue.push({ nodeId, path: consumerPath })
  }

  const addPlacement = (nodeId: string, installPath: string): void => {
    const occupant = pathToId.get(installPath)
    if (occupant !== undefined && occupant !== nodeId) {
      throw new LockfileError({
        code: 'IRREDUCIBLE_LOSS',
        message: `install path ${JSON.stringify(installPath)} collides between ${occupant} and ${nodeId}`,
      })
    }
    pathToId.set(installPath, nodeId)
    let paths = byNodeId.get(nodeId)
    if (paths === undefined) {
      paths = new Set<string>()
      byNodeId.set(nodeId, paths)
    }
    const sizeBefore = paths.size
    paths.add(installPath)
    if (paths.size !== sizeBefore) {
      addConsumer(nodeId, installPath)
    }
  }

  if (rootNode !== undefined) {
    addConsumer(rootNode.id, '')
  }

  const workspaceMembers = Array.from(graph.nodes())
    .filter(node => node.workspacePath !== undefined && node.workspacePath !== '')
    .sort((a, b) => cmpStr(a.workspacePath!, b.workspacePath!))
  for (const node of workspaceMembers) {
    addConsumer(node.id, node.workspacePath!)
  }

  const seededNodes = Array.from(graph.nodes())
    .filter(node => node.workspacePath === undefined)
    .sort((a, b) => cmpStr(a.id, b.id))
  for (const node of seededNodes) {
    const installPaths = sidecar?.nodes.get(node.id)?.installPaths ?? []
    for (const installPath of installPaths) {
      addPlacement(node.id, installPath)
    }
  }

  // Shared BFS body for both passes below: pop a consumer, place each
  // non-peer, non-workspace dep at `<consumer-path>/node_modules/<dep-name>`
  // if not already routable from there. `addPlacement` enqueues the dst,
  // which feeds further iterations of this loop. Edge sort follows the
  // (kind, dst) order shared via `compareEdgesForBfs`.
  const drainBfsQueue = (): void => {
    while (queue.length > 0) {
      const current = queue.shift()!
      const edges = graph.out(current.nodeId)
        .filter(edge => edge.kind !== 'peer')
        .slice()
        .sort(compareEdgesForBfs)
      for (const edge of edges) {
        const dst = graph.getNode(edge.dst)
        if (dst === undefined || dst.workspacePath !== undefined) continue
        // npm installs an npm-aliased dep under its ALIAS directory, not the
        // real package name (`string-width-cjs: npm:string-width@^4` lives at
        // `node_modules/string-width-cjs`). Keying the path tail off the real
        // name collides when a consumer has both a direct dep and an aliased
        // dep onto the same package at different versions (the `*-cjs`
        // dual-publish pattern under `@isaacs/cliui`). Use the edge's alias
        // when present. `buildNodeModulesEntry` re-emits `name:` whenever the
        // path tail differs from the node name, so the round-trip stays sound.
        const segment = edge.attrs?.alias ?? dst.name
        if (resolveDepTarget(current.path, segment, pathToId) === dst.id) continue
        const installPath = current.path === ''
          ? `node_modules/${segment}`
          : `${current.path}/node_modules/${segment}`
        addPlacement(dst.id, installPath)
      }
    }
  }

  // Root-reachable BFS placement runs BEFORE the lexicographic fallback so
  // that the version each root / workspace consumer actually depends on
  // claims `node_modules/<name>` first. Cross-family input (yarn-berry,
  // pnpm, bun-text) carries no sidecar install paths; without this
  // ordering, the fallback assigned `node_modules/<name>` by node-ID sort
  // and any root-direct edge to a non-lexicographically-first version then
  // collided at root (e.g. a root-direct `pkg@0.0.10` vs a deeper
  // `pkg@1.0.0`). Node-flat sources (npm-2 / npm-3 / npm-4) carry sidecar
  // install paths that have already filled every position above, so this
  // BFS is a no-op for them.
  // replay vs generate. When every resolved node carries a
  // parse-captured install path (an un-mutated same-PM npm round-trip), the
  // seeded placement IS npm's own authoritative, valid, collision-free tree —
  // SKIP the re-hoisting BFS entirely. The BFS re-derives synthetic nested
  // paths and can route two versions onto one (`IRREDUCIBLE_LOSS`, e.g. two
  // versions of a deep-nested `…/<pkg>/node_modules/<dep>`) even though
  // the captured tree is sound. Otherwise — cross-PM input or a post-`mutate`
  // graph (no sidecar, or partial capture) — GENERATE the placement via the BFS
  // + lexicographic fallback.
  const captureComplete =
    seededNodes.length > 0 &&
    seededNodes.every(node => (sidecar?.nodes.get(node.id)?.installPaths?.length ?? 0) > 0)
  if (!captureComplete) {
    drainBfsQueue()

    // Lexicographic fallback for nodes not reachable from any root or
    // workspace consumer (e.g. orphaned packages preserved by the graph but
    // disconnected from the root manifest). After each fallback placement
    // re-drain the consumer queue so the orphan's transitive dependencies
    // nest under its install path. Without the per-iteration drain, a non-
    // dominant version reached only via the synthetic fallback path (e.g.
    // peers-multi `react-dom@18.2.0` in the yarn-classic shape) cannot pull
    // its scoped deps (`scheduler@0.23.2`) into its capsule and npm's
    // node-resolution at parse time falls back to the dominant root version
    // of the same name.
    for (const node of seededNodes) {
      if (byNodeId.has(node.id)) continue
      addPlacement(node.id, fallbackInstallPathForNode(node, pathToId))
      drainBfsQueue()
    }
    // the emitted tree is a re-synthesized valid
    // projection, not a byte/structure copy of any original (cross-PM input or
    // post-mutate). Surface it so byte-divergence is attributed, not silent.
    onDiagnostic?.({
      code: 'LAYOUT_PLACEMENT_RESYNTHESISED',
      severity: 'info',
      message:
        'npm install-path layout re-synthesised — no complete parse-captured placement ' +
        '(cross-PM input or post-mutate graph); emitted a valid find-up tree, not the original projection',
    })
  }

  const planned = new Map<string, string[]>()
  for (const [nodeId, installPaths] of byNodeId) {
    planned.set(nodeId, Array.from(installPaths).sort(cmpStr))
  }
  return planned
}

function compareEdgesForBfs(a: Edge, b: Edge): number {
  const byKind = cmpStr(a.kind, b.kind)
  if (byKind !== 0) return byKind
  return cmpStr(a.dst, b.dst)
}

function buildRootEntry(
  graph: Graph,
  rootNode: Node,
  rootMeta: NpmRootMeta | undefined,
  sidecar: NpmSidecar | undefined,
  config: NpmFamilyConfig,
  emitDiagnostic: (d: Diagnostic) => void = () => undefined,
): Record<string, unknown> {
  const body = cloneNativeRootEntry(rootMeta, config)
  body.name = rootNode.name
  body.version = rootNode.version

  const blocks = collectManifestBlocks(graph, rootNode.id, sidecar, emitDiagnostic)
  overlayRootBlock(body, 'dependencies', blocks.dep)
  overlayRootBlock(body, 'devDependencies', blocks.dev)
  overlayRootBlock(
    body,
    'peerDependencies',
    Object.keys(blocks.peer).length > 0
      ? blocks.peer
      : rootMeta?.peerDependencies === undefined
        ? undefined
        : sortRecord(rootMeta.peerDependencies),
  )
  overlayRootBlock(
    body,
    'optionalDependencies',
    Object.keys(blocks.optional).length > 0
      ? blocks.optional
      : rootMeta?.optionalDependencies === undefined
        ? undefined
        : sortRecord(rootMeta.optionalDependencies),
  )
  if (rootMeta?.workspaces !== undefined) body.workspaces = rootMeta.workspaces
  if (rootMeta?.bundleDependencies !== undefined) body.bundleDependencies = rootMeta.bundleDependencies
  delete body.overrides
  config.hooks?.enrichPackageEntry?.({
    graph,
    node: rootNode,
    nodeSidecar: sidecar?.nodes.get(rootNode.id),
    body,
    kind: 'root',
  })
  return body
}

function buildWorkspaceMemberEntry(
  graph: Graph,
  node: Node,
  sidecar: NpmSidecar | undefined,
  config: NpmFamilyConfig,
  emitDiagnostic: (d: Diagnostic) => void = () => undefined,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: node.name,
    version: node.version,
  }
  const blocks = collectManifestBlocks(graph, node.id, sidecar, emitDiagnostic)
  const nodeSide = sidecar?.nodes.get(node.id)
  if (Object.keys(blocks.dep).length > 0) body.dependencies = blocks.dep
  if (Object.keys(blocks.dev).length > 0) body.devDependencies = blocks.dev
  if (Object.keys(blocks.peer).length > 0) body.peerDependencies = blocks.peer
  else if (nodeSide?.peerDependencies !== undefined) body.peerDependencies = sortRecord(nodeSide.peerDependencies)
  if (Object.keys(blocks.optional).length > 0) body.optionalDependencies = blocks.optional
  config.hooks?.enrichPackageEntry?.({
    graph,
    node,
    nodeSidecar: nodeSide,
    body,
    kind: 'workspace',
  })
  return body
}

/**
 * Every key `buildNodeModulesEntry` is capable of writing.
 *
 * Declared beside the builder rather than inferred from a corpus, so the two
 * are maintained together; `npm-entry-key-drift.test.ts` walks the corpus and
 * fails if the builder ever emits a key this set does not name.
 *
 * The set answers ONE question — can the canonical projection reproduce this
 * key at all? A source key outside it is unreachable by projection and its only
 * carrier is the exact-path native record, which is why retention consults this
 * rather than building a projection per entry to compare values.
 */
/**
 * Canonical payload keys the projection stores as a RECORD.
 *
 * npm tolerates a legacy array spelling for some of these. An array cannot be
 * reproduced from a record-shaped canonical field, so the projection declines it
 * and the exact-path native record becomes its only carrier — the same rule as a
 * key the projection cannot emit at all, applied to a shape instead of a name.
 *
 * Declared beside `tarballPayloadOf` for the same reason as
 * `NODE_MODULES_ENTRY_KEYS`: the copy code and its contract stay together.
 */
export const RECORD_SHAPED_PAYLOAD_KEYS: ReadonlySet<string> = new Set([
  'engines',
  'peerDependencies',
  'peerDependenciesMeta',
])

export const NODE_MODULES_ENTRY_KEYS: ReadonlySet<string> = new Set([
  'name',
  'version',
  'resolved',
  'integrity',
  'dev',
  'optional',
  'peer',
  'inBundle',
  'bundleDependencies',
  'dependencies',
  'peerDependencies',
  'peerDependenciesMeta',
  'optionalDependencies',
  'devDependencies',
  'engines',
  'funding',
  'license',
  'bin',
  'deprecated',
  'cpu',
  'os',
  'libc',
  'hasInstallScript',
  'link',
  'workspaces',
])

function buildNodeModulesEntry(
  graph: Graph,
  node: Node,
  nodeSide: NpmFlatSidecar | undefined,
  installPaths: readonly string[],
  config: NpmFamilyConfig,
  emitDiagnostic: (d: Diagnostic) => void = () => undefined,
): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  if (installPaths.some(path => installPathTail(path) !== node.name)) {
    body.name = node.name
  }
  body.version = node.version

  const tarball = graph.tarballOf(node.id)
  // `resolved` URL: prefer `nativeResolution`, but only when it is a real npm
  // URL. A cross-format (yarn-berry) source stores its own LOCATOR there
  // (`<name>@npm:…::…`, `<name>@patch:…`) which is `npm ci`-unusable — reject it
  // and fall through to the npm-2 recovery hook, then the canonical resolution.
  const native = tarball?.nativeResolution
  let resolved = (native !== undefined && !isYarnBerryLocator(native) ? native : undefined)
    ?? config.hooks?.recoverResolvedForNode?.(graph, node)
    ?? deriveResolvedFromCanonical(tarball?.resolution)
  // A `patch:` / unknown canonical re-emits its raw yarn locator (also not a
  // URL): drop it (npm re-resolves from the range) — the patch loss is already
  // surfaced by `RECIPE_FEATURE_DROPPED(patch)`, so no extra diagnostic here.
  if (resolved !== undefined && isYarnBerryLocator(resolved)) {
    resolved = undefined
  }
  // A yarn-classic registry `resolved` may glue on a `#<sha1>` fragment — yarn
  // syntax; npm carries that sha1 in `integrity` instead, so emit a clean `.tgz`
  // and promote the fragment sha1 to integrity when it's the entry's only checksum.
  if (resolved !== undefined) body.resolved = stripRegistrySha1Fragment(resolved)
  const sri = emitSriForRegistry(tarball?.integrity, native)
  if (sri !== undefined) body.integrity = sri
  if (nodeSide?.dev === true) body.dev = true
  if (nodeSide?.optional === true) body.optional = true
  if (nodeSide?.peer === true) body.peer = true
  if (nodeSide?.inBundle === true) body.inBundle = true
  if (tarball?.bundledDependencies !== undefined) {
    body.bundleDependencies = [...tarball.bundledDependencies]
  }

  const sidecar = getFlatSidecar(graph)
  const blocks = collectManifestBlocks(graph, node.id, sidecar, emitDiagnostic)
  const innerDeps: Record<string, string> = { ...blocks.dep, ...blocks.dev }
  if (Object.keys(innerDeps).length > 0) body.dependencies = sortRecord(innerDeps)

  if (Object.keys(blocks.peer).length > 0) body.peerDependencies = blocks.peer
  else if (nodeSide?.peerDependencies !== undefined) body.peerDependencies = sortRecord(nodeSide.peerDependencies)
  else if (tarball?.peerDependencies !== undefined) body.peerDependencies = sortRecord(tarball.peerDependencies)

  if (Object.keys(blocks.optional).length > 0) body.optionalDependencies = blocks.optional
  else if (nodeSide?.optionalDependencies !== undefined) body.optionalDependencies = sortRecord(nodeSide.optionalDependencies)

  if (nodeSide?.devDependencies !== undefined) body.devDependencies = sortRecord(nodeSide.devDependencies)

  if (tarball?.bin !== undefined) body.bin = tarball.bin
  if (tarball?.engines !== undefined) body.engines = tarball.engines
  if (tarball?.funding !== undefined) body.funding = tarball.funding
  if (tarball?.license !== undefined) body.license = tarball.license
  if (tarball?.deprecated !== undefined) body.deprecated = tarball.deprecated
  if (tarball?.cpu !== undefined) body.cpu = tarball.cpu
  if (tarball?.os !== undefined) body.os = tarball.os
  if (tarball?.libc !== undefined) body.libc = tarball.libc
  if (tarball?.peerDependenciesMeta !== undefined) body.peerDependenciesMeta = tarball.peerDependenciesMeta
  if (tarball?.hasInstallScript !== undefined) body.hasInstallScript = tarball.hasInstallScript
  config.hooks?.enrichPackageEntry?.({
    graph,
    node,
    nodeSidecar: nodeSide,
    body,
    kind: 'installed',
  })

  return body
}

function buildManifestPlacementEntry(
  graph: Graph,
  node: Node,
  nodeSide: NpmFlatSidecar | undefined,
  installPaths: readonly string[],
  pathState: NpmPackageEntrySidecar | undefined,
  config: NpmFamilyConfig,
  emitDiagnostic: (d: Diagnostic) => void = () => undefined,
): Record<string, unknown> {
  const body = buildNodeModulesEntry(graph, node, nodeSide, installPaths, config, emitDiagnostic)
  // The graph edges of a root/workspace node describe that project manifest,
  // not the registry package installed at a self-placement. Keep the installed
  // entry's own dependency blocks; otherwise replay would copy root/workspace
  // declarations into a physically distinct packages[path] record.
  for (const key of PACKAGE_ENTRY_DEPENDENCY_KEYS) {
    if (pathState !== undefined && Object.hasOwn(pathState.nativeEntry, key)) {
      body[key] = cloneJsonValue(pathState.nativeEntry[key])
    } else {
      delete body[key]
    }
  }
  return body
}

// project canonical resolution → npm `resolved` URL for
// cross-format fallback. Workspace canonical returns undefined (npm encodes
// workspaces via link entries, not via `resolved`).
function deriveResolvedFromCanonical(canonical: ResolutionCanonical | undefined): string | undefined {
  if (canonical === undefined) return undefined
  return stringifyForNpm(canonical)
}

function installPathTail(path: string): string {
  const chain = ('/' + path).split('/node_modules/').filter(Boolean)
  return chain[chain.length - 1] ?? path
}

function reportPeerContextFlatten(
  config: NpmFamilyConfig,
  node: Node,
  warned: Set<string>,
  emitDiagnostic: (diagnostic: Diagnostic) => void,
): void {
  if (node.peerContext.length === 0 || warned.has(node.id)) return
  warned.add(node.id)
  emitDiagnostic({
    code: `${config.diagnosticPrefix}_PEER_VIRT_FLATTENED`,
    severity: 'warning',
    subject: node.id,
    message: `peerContext ${JSON.stringify(node.peerContext)} is unsupported in npm-${config.lockfileVersion}; flattening on emit`,
  })
}

function reportPatchDrop(
  graph: Graph,
  sidecar: NpmSidecar | undefined,
  config: NpmFamilyConfig,
  node: Node,
  warned: Set<string>,
  emitDiagnostic: (diagnostic: Diagnostic) => void,
): void {
  if (node.patch === undefined || warned.has(node.id)) return
  if (config.hooks?.canEmitPatch?.(graph, node, sidecar) === true) return
  warned.add(node.id)
  patchEmitDropped(
    node.id,
    'patch',
    `npm-${config.lockfileVersion} cannot faithfully emit ${JSON.stringify(node.patch)} from the available native adapter state; patch dropped`,
    emitDiagnostic,
  )
}

// === ENRICH =================================================================

// === Peer candidates ========================================================

export function derivePeerCandidates(graph: Graph, peerName: string, range: string): PeerCandidateOutcome {
  const normalizedRange = semver.validRange(range)
  const candidates = graph.byName(peerName)
    .filter(candidateId => {
      const candidate = graph.getNode(candidateId)
      if (candidate === undefined) return false
      if (normalizedRange === null) return true
      if (semver.valid(candidate.version) === null) return false
      return semver.satisfies(candidate.version, normalizedRange)
    })
    .slice()
    .sort(cmpStr)

  if (candidates.length === 1) return { kind: 'single', candidate: candidates[0]! }
  if (candidates.length === 0) return { kind: 'unsatisfied' }
  return { kind: 'ambiguous', candidates }
}

// === OPTIMIZE ===============================================================

// === Pruning ================================================================

export function pruneSidecar(sidecar: NpmSidecar, graph: Graph): NpmSidecar {
  const reachableIds = new Set(Array.from(graph.nodes(), node => node.id))
  const nodes = new Map<string, NpmFlatSidecar>()
  for (const [nodeId, sc] of sidecar.nodes) {
    if (reachableIds.has(nodeId)) {
      nodes.set(nodeId, sc)
    }
  }
  const edgeRanges = new Map<string, string>()
  const edgeDeclaredNames = new Map<string, string>()
  for (const [edgeKey, range] of sidecar.edgeRanges) {
    const [src, , dst] = edgeKey.split('|')
    if (src !== undefined && dst !== undefined && reachableIds.has(src) && reachableIds.has(dst)) {
      edgeRanges.set(edgeKey, range)
      const declaredName = sidecar.edgeDeclaredNames.get(edgeKey)
      if (declaredName !== undefined) edgeDeclaredNames.set(edgeKey, declaredName)
    }
  }
  const workspaceByPath = new Map<string, string>()
  for (const [path, nodeId] of sidecar.workspaceByPath) {
    if (graph.getNode(nodeId)?.workspacePath === path) workspaceByPath.set(path, nodeId)
  }
  const packageEntriesByPath = sidecar.packageEntriesByPath === undefined
    ? undefined
    : new Map<string, NpmPackageEntrySidecar>()
  for (const [path, entry] of sidecar.packageEntriesByPath ?? []) {
    if (!reachableIds.has(entry.nodeId)) continue
    const wasWorkspaceEntry = sidecar.workspaceByPath.get(path) === entry.nodeId
    if (wasWorkspaceEntry && graph.getNode(entry.nodeId)?.workspacePath !== path) continue
    packageEntriesByPath?.set(path, entry)
  }
  const linkEntriesByPath = sidecar.linkEntriesByPath === undefined
    ? undefined
    : new Map<string, NpmLinkEntrySidecar>()
  for (const [path, entry] of sidecar.linkEntriesByPath ?? []) {
    if (reachableIds.has(entry.targetNodeId)) linkEntriesByPath?.set(path, entry)
  }
  return {
    rootId: sidecar.rootId !== undefined && reachableIds.has(sidecar.rootId) ? sidecar.rootId : undefined,
    rootMeta: sidecar.rootMeta,
    nodes,
    edgeRanges,
    edgeDeclaredNames,
    workspaceByPath,
    packageEntriesByPath,
    linkEntriesByPath,
    unknownTopLevel: sidecar.unknownTopLevel,
  }
}

// === HELPERS ================================================================

// Re-export shared types/utilities so adapter thin entries that import
// from `_npm-core.ts` keep working without touching the types module
// directly.
export {
  NPM_EDGE_RANGE_ATTR,
  cmpStr,
  edgeTripleKey,
  sortRecord,
  type NpmEntry,
  type NpmFamilyConfig,
  type NpmFamilyEnrichOptions,
  type NpmFamilyOptimizeOptions,
  type NpmFamilyParseOptions,
  type NpmFamilyStringifyOptions,
  type NpmFlatSidecar,
  type NpmLockfile,
  type NpmRootMeta,
  type NpmSidecar,
}

export function resolveDepTarget(srcPath: string, name: string, pathToId: Map<string, string>): string | undefined {
  const candidates: string[] = []

  candidates.push(srcPath === '' ? `node_modules/${name}` : `${srcPath}/node_modules/${name}`)

  let current = srcPath
  while (current !== '') {
    const idx = current.lastIndexOf('/node_modules/')
    if (idx >= 0) {
      current = current.slice(0, idx)
    } else if (current.startsWith('node_modules/')) {
      current = ''
    } else {
      current = ''
    }
    candidates.push(current === '' ? `node_modules/${name}` : `${current}/node_modules/${name}`)
  }

  for (const candidate of candidates) {
    const id = pathToId.get(candidate)
    if (id !== undefined) return id
  }
  return undefined
}
