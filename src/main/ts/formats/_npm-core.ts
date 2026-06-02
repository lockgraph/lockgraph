// _npm-core.ts — npm-flat-family (npm-2 / npm-3) shared core.
//
// Scope: the install-path-keyed `packages` block layout (npm
// lockfileVersion 2 + 3). Per-version thin entries (`npm-2.ts`,
// `npm-3.ts`) thread an `NpmFamilyConfig` through the shared parse /
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
// - `topLevelShape: 'dual'` (npm-2) — BOTH `packages` and `dependencies`
//   blocks are expected. `packages` wins on disagreement; per-entry drift
//   surfaces `NPM_V2_DUAL_MODE_DRIFT`. The npm-2-only dual-mode drift
//   detection + legacy-mirror reconstruction lives in `_npm-2-mirror.ts`
//   and is wired in via the `hooks` slot of `NpmFamilyConfig`. CORE
//   itself does NOT import the mirror module — the hook contract keeps
//   the dependency direction one-way (mirror → types ← core).
//
// npm-1 (recursive `dependencies` tree shape) is OUT OF SCOPE for this
// core — the tree walker is fundamentally different from the flat-shape
// `packages` reader/writer and forcing a unified pipeline rots both
// sides. The future npm-1 adapter will reuse the standalone utilities
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
  toTarballKey,
  type Diagnostic,
  type Edge,
  type EdgeKind,
  type Graph,
  type Node,
  type TarballKeyInputs,
  type TarballPayload,
} from '../graph.ts'
import { LockfileError } from '../errors.ts'
import { validateCanonical as integrityValidateCanonical } from '../recipe/integrity.ts'
import {
  emitDropped as patchEmitDropped,
  emitWorkspaceResolved,
  emitWorkspaceUnresolved,
  invalidIntegrityDiagnostic,
  unknownResolutionDiagnostic,
} from '../recipe/diagnostics.ts'
import {
  parse as parseResolutionRecipe,
  stringifyForNpm,
  type ResolutionCanonical,
} from '../recipe/resolution.ts'
import {
  isWorkspaceEdge,
  shouldEmitWorkspaceResolved,
  stringifyForVersionOnly,
  workspaceRangeOfEdge,
} from '../recipe/workspace.ts'
import { captureOverrides, projectOverrides } from '../recipe/overrides.ts'
import {
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
} from './_npm-flat-types.ts'

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

const sidecarByGraph = new WeakMap<Graph, NpmSidecar>()

// === checkFamily ===========================================================

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
      // npm-2: requires both `packages` and `dependencies` keys at top level.
      return /"packages"\s*:\s*\{/.test(input) && /"dependencies"\s*:\s*\{/.test(input)
  }
}

// === parseFamily ===========================================================

export function parseFamily(
  input: string,
  _options: NpmFamilyParseOptions,
  config: NpmFamilyConfig,
): Graph {
  const lf = parseJson(input, config)

  if (lf.lockfileVersion !== config.lockfileVersion) {
    throw new LockfileError({
      code: 'FORMAT_MISMATCH',
      message: `npm-${config.lockfileVersion} adapter: expected lockfileVersion ${config.lockfileVersion}, got ${JSON.stringify(lf.lockfileVersion)}`,
    })
  }

  // Top-level layout handshake.
  const hasPackages = lf.packages !== undefined
    && typeof lf.packages === 'object'
    && !Array.isArray(lf.packages)

  if (!hasPackages) {
    throw new LockfileError({
      code: 'FORMAT_MISMATCH',
      message: `npm-${config.lockfileVersion} adapter: top-level "packages" map is required`,
    })
  }

  // Adapter-specific top-level validation (npm-2: requires `dependencies`).
  config.hooks?.validateTopLevel?.(lf)

  const packages = lf.packages as Record<string, NpmEntry>
  const rootEntry = packages['']
  if (rootEntry === undefined) {
    throw parseFailed(config, 'missing root entry under "packages"')
  }

  const builder = newBuilder()
  const diagnostics: Diagnostic[] = []
  const nodeSidecar = new Map<string, NpmFlatSidecar>()
  const edgeRanges = new Map<string, string>()
  const edgeDeclaredNames = new Map<string, string>()
  const workspaceByPath = new Map<string, string>()
  const pathToId = new Map<string, string>()
  const idToEntry = new Map<string, NpmEntry>()

  // npm's `packages[""]` (the project root, a workspace node per ADR-0017)
  // legitimately omits `name` and/or `version` for private / unpublished
  // roots — the dominant shape for apps and monorepo roots (some omit both;
  // some carry a name but no version).
  // Synthesize the missing pieces rather than refusing to parse: name falls
  // back to npm's own root key `.`; version to the unpublished sentinel
  // `0.0.0` (cf. yarn-berry's `0.0.0-use.local`, ADR-0017). A diagnostic
  // records the synthesis so the round-trip stays auditable. Workspace
  // MEMBERS (below) keep the strict name/version requirement.
  const rootName = rootEntry.name ?? lf.name ?? '.'
  const rootVersion = rootEntry.version ?? lf.version ?? '0.0.0'
  if (rootEntry.version === undefined && lf.version === undefined) {
    builder.diagnostic({
      code:     `${config.diagnosticPrefix}_ROOT_VERSION_SYNTHESIZED`,
      severity: 'info',
      subject:  'graph',
      message:  `private root entry carries no version; synthesised '${rootVersion}'`,
    })
  }
  const rootId = `${rootName}@${rootVersion}`
  pathToId.set('', rootId)
  idToEntry.set(rootId, rootEntry)
  builder.addNode({
    id: rootId,
    name: rootName,
    version: rootVersion,
    peerContext: [],
    workspacePath: '',
  })

  // npm `link: true` entries are the symlinks (`node_modules/<pkgname>` →
  // `resolved: <member-path>`) through which the rest of the tree references
  // a workspace member. They are the authoritative source of a member's
  // package name when the member's own `packages/<path>` entry omits it
  // (private workspaces routinely do — a member's `packages/<dir>` entry can
  // carry a version but no name). Unlike the path's last segment, the link
  // name handles scoped packages (`@scope/pkg` linked from a `packages/pkg`
  // dir). Build the path → link-name map up front.
  const linkNameByPath = new Map<string, string>()
  for (const [key, entry] of Object.entries(packages)) {
    if (entry.link !== true || typeof entry.resolved !== 'string') continue
    const at = key.lastIndexOf('node_modules/')
    if (at < 0) continue
    const linkName = key.slice(at + 'node_modules/'.length)
    if (!linkNameByPath.has(entry.resolved)) linkNameByPath.set(entry.resolved, linkName)
  }

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

  // Pass 1b: node_modules/... entries.
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
    const id = `${tailName}@${version}`
    pathToId.set(path, id)

    const existing = idToEntry.get(id)
    if (existing === undefined) {
      idToEntry.set(id, entry)
      builder.addNode({
        id,
        name: tailName,
        version,
        peerContext: [],
      })
      if (entry.integrity !== undefined || hasTarballPayload(entry)) {
        builder.setTarball({ name: tailName, version }, tarballPayloadOf(entry, id, diagnostics))
      }
    }
  }

  // Pass 2: edges + per-node sidecar data.
  for (const [path, entry] of Object.entries(packages)) {
    const srcId = pathToId.get(path)
    if (srcId === undefined) continue
    if (entry.link === true && path !== '') continue

    const nodeSide = ensureSidecar(nodeSidecar, srcId)
    if (entry.inBundle === true) nodeSide.inBundle = true
    if (entry.dev === true) nodeSide.dev = true
    if (entry.optional === true) nodeSide.optional = true
    if (entry.peer === true) nodeSide.peer = true
    // WS-LINK (ADR-0027 §4): capture npm's `extraneous` flag so a workspace
    // member that npm did NOT link (present on disk, absent from the install
    // graph) re-emits without a top-level link on replay.
    if (entry.extraneous === true) nodeSide.extraneous = true

    // Adapter-specific per-entry capture (npm-2 mirror: stash `resolved`
    // URL for legacy-mirror emit). Core stays version-neutral — it does
    // not know what the hook is for.
    config.hooks?.captureEntry?.(srcId, entry)

    const isRoot = path === ''
    const isWorkspaceMember = workspaceByPath.has(path)
    const treatAsManifest = isRoot || isWorkspaceMember

    addDepEdges(builder, edgeRanges, edgeDeclaredNames, path, srcId, entry.dependencies, 'dep', pathToId, diagnostics)
    addDepEdges(builder, edgeRanges, edgeDeclaredNames, path, srcId, entry.optionalDependencies, 'optional', pathToId, diagnostics)

    if (treatAsManifest) {
      addDepEdges(builder, edgeRanges, edgeDeclaredNames, path, srcId, entry.devDependencies, 'dev', pathToId, diagnostics)
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

  // Pass 3: root meta.
  const rootMeta: NpmRootMeta = {
    name: lf.name ?? rootEntry.name,
    version: lf.version ?? rootEntry.version,
    requires: lf.requires,
  }
  if (rootEntry.workspaces !== undefined) rootMeta.workspaces = rootEntry.workspaces.slice()
  if (rootEntry.bundleDependencies !== undefined) {
    rootMeta.bundleDependencies = Array.isArray(rootEntry.bundleDependencies)
      ? rootEntry.bundleDependencies.slice()
      : rootEntry.bundleDependencies
  }
  if (rootEntry.devDependencies !== undefined) rootMeta.devDependencies = { ...rootEntry.devDependencies }
  if (rootEntry.peerDependencies !== undefined) rootMeta.peerDependencies = { ...rootEntry.peerDependencies }
  if (rootEntry.optionalDependencies !== undefined) rootMeta.optionalDependencies = { ...rootEntry.optionalDependencies }

  // ADR-0025 §3 — capture the root entry's `overrides` block (npm mirrors the
  // root manifest's overrides into `packages[""]`). Store BOTH the verbatim
  // block (`nativeOverrides`, the lossless same-PM round-trip carrier symmetric
  // to pnpm's `sidecar.overrides`) AND the canonical name-chain (`overrides`,
  // for cross-PM projection / query). F6 capture is recipe-pure; the
  // RECIPE_OVERRIDE_NORMALISED info funnels through the same `diagnostics`
  // buffer the rest of parse uses.
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

  try {
    const graph = builder.seal()
    sidecarByGraph.set(graph, {
      rootId,
      rootMeta,
      edgeRanges,
      edgeDeclaredNames,
      nodes: nodeSidecar,
      workspaceByPath,
    })
    config.hooks?.afterParse?.({ graph, lf, packages, rootId })
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

// === stringifyFamily =======================================================

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

  const rootNode = locateRootNode(graph, sidecar)
  const rootMeta = sidecar?.rootMeta
  const rootName = rootMeta?.name ?? rootNode?.name ?? ''
  const rootVersion = rootMeta?.version ?? rootNode?.version ?? '0.0.0'
  const plannedInstallPaths = deriveInstallPathsForStringify(graph, sidecar, rootNode, emitDiagnostic)

  const packages: Record<string, unknown> = {}

  if (rootNode !== undefined) {
    packages[''] = buildRootEntry(graph, rootNode, rootMeta, sidecar, emitDiagnostic)
  } else if (rootMeta !== undefined) {
    packages[''] = buildSyntheticRootEntry(rootMeta)
  } else {
    // Empty graph / no root info: emit a minimal root entry so the lockfile
    // remains parseable (parseFamily rejects a `packages` map missing the
    // `''` key — see this module's parse path).
    packages[''] = { name: rootName, version: rootVersion }
  }

  // ADR-0025 §3/§4 — emit the root entry's `overrides` block. Source precedence:
  //   1. caller `options.overrides` (canonical) → project to npm nested form.
  //      An explicit `[]` (not undefined) emits nothing — the caller asked for
  //      none, suppressing the captured fallback.
  //   2. else the VERBATIM lock-borne block (`rootMeta.nativeOverrides`) →
  //      re-emit byte-for-byte: the lossless same-PM round-trip carrier,
  //      symmetric to pnpm's `sidecar.overrides`. Preferred over canonical
  //      because the name-chain abstraction drops npm tails (`pkg@version` key
  //      qualifiers, self-key ordering) per ADR-0025 §2.
  //   3. else a canonical-only carrier (`rootMeta.overrides`, e.g. captured from
  //      a cross-PM manifest with no npm verbatim — the A2 path) → project.
  // Only the packages-keyed shape (lockfileVersion ≥ 2) carries it.
  let overrideBlock: Record<string, unknown> | undefined
  if (options.overrides !== undefined) {
    if (options.overrides.length > 0) {
      overrideBlock = projectOverrides(options.overrides, 'npm', emitDiagnostic)
    }
  } else if (rootMeta?.nativeOverrides !== undefined) {
    overrideBlock = rootMeta.nativeOverrides
  } else if (rootMeta?.overrides !== undefined && rootMeta.overrides.length > 0) {
    overrideBlock = projectOverrides(rootMeta.overrides, 'npm', emitDiagnostic)
  }
  if (overrideBlock !== undefined) {
    const rootEntry = packages['']
    if (config.lockfileVersion >= 2 && typeof rootEntry === 'object' && rootEntry !== null) {
      ;(rootEntry as Record<string, unknown>).overrides = overrideBlock
    } else {
      // Defensive only: every FormatId routed through `stringifyFamily` today
      // pins lockfileVersion ≥ 2 (npm-2 → 2, npm-3 → 3), and npm-1 owns a
      // separate tree-shape pipeline that never reaches here. This branch
      // guards a hypothetical future flat npm-1 reuse of the core.
      emitDiagnostic({
        code:     `${config.diagnosticPrefix}_OVERRIDES_UNSUPPORTED`,
        severity: 'warning',
        message:  `lockfileVersion ${config.lockfileVersion} has no packages[""].overrides slot; ${Object.keys(overrideBlock).length} override key(s) not projected`,
      })
    }
  }

  const workspaceMembers: Node[] = []
  for (const node of graph.nodes()) {
    warnPatchDrop(config, node, warnedPatches, emitDiagnostic)
    warnPeerContextFlatten(config, node, warnedPeerVirt, emitDiagnostic)
    if (rootNode !== undefined && node.id === rootNode.id) continue
    if (node.workspacePath !== undefined && node.workspacePath !== '') {
      workspaceMembers.push(node)
    }
  }
  for (const node of workspaceMembers) {
    packages[node.workspacePath!] = buildWorkspaceMemberEntry(graph, node, sidecar, emitDiagnostic)
    // WS-LINK (ADR-0027 §4): emit the top-level node_modules/<name> symlink for a
    // workspace member UNLESS it is `extraneous` — npm omits the link for a member
    // present on disk but absent from the install graph (an extraneous member would
    // otherwise emit one extra top-level link beyond npm's set). The
    // flag is captured layout attribution, replayed here. A cross-PM / post-mutate
    // graph carries no sidecar, so the default (no flag ⇒ linked) links every
    // member — matching the prior unconditional behaviour for the generate path.
    const extraneous = sidecar?.nodes.get(node.id)?.extraneous === true
    if (!extraneous) {
      packages[`node_modules/${node.name}`] = {
        resolved: node.workspacePath,
        link: true,
      }
    }
  }

  for (const node of graph.nodes()) {
    if (rootNode !== undefined && node.id === rootNode.id) continue
    if (node.workspacePath !== undefined) continue

    const nodeSide = sidecar?.nodes.get(node.id)
    const paths = plannedInstallPaths.get(node.id) ?? [`node_modules/${node.name}`]
    const entry = buildNodeModulesEntry(graph, node, nodeSide, config, emitDiagnostic)
    for (const path of paths) {
      packages[path] = entry
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

  const text = JSON.stringify(out, null, 2) + '\n'
  return options.lineEnding === 'crlf' ? text.replace(/\n/g, '\r\n') : text
}

// === enrichFamily ==========================================================

export function enrichFamily(
  graph: Graph,
  config: NpmFamilyConfig,
  _options: NpmFamilyEnrichOptions = {},
): { graph: Graph; diagnostics: Diagnostic[] } {
  const sidecar = sidecarByGraph.get(graph)
  const diagnostics: Diagnostic[] = []
  const workspaceEdgesToMark: Edge[] = []

  // Pass 1: peer derivation for diagnostic surfacing only. The graph-side
  // peer edge is NOT added (per ADR-0021 §C.npm-* peer-flat outcome).
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

// === optimizeFamily ========================================================

export function optimizeFamily(
  graph: Graph,
  config: NpmFamilyConfig,
  _options: NpmFamilyOptimizeOptions = {},
): { graph: Graph; diagnostics: Diagnostic[] } {
  const sidecar = sidecarByGraph.get(graph)
  const reachable = new Set(graph.walk(Array.from(graph.roots())))
  const unreachableNodes = Array.from(graph.nodes(), node => node.id)
    .filter(nodeId => !reachable.has(nodeId))
    .sort(cmpStr)

  if (unreachableNodes.length === 0) {
    return {
      graph,
      diagnostics: graph.diagnostics().filter(diagnostic => diagnostic.severity === 'warning'),
    }
  }

  const unreachable = new Set(unreachableNodes)
  const referencedTarballs = new Set<string>()
  const tarballsToRemove = new Map<string, TarballKeyInputs>()
  const internalEdges = unreachableNodes
    .flatMap(src =>
      graph.out(src)
        .filter(edge => unreachable.has(edge.dst))
        .map(edge => ({ src: edge.src, dst: edge.dst, kind: edge.kind })),
    )
    .sort((a, b) =>
      cmpStr(`${a.src} ${a.kind} ${a.dst}`, `${b.src} ${b.kind} ${b.dst}`),
    )

  for (const node of graph.nodes()) {
    const inputs = { name: node.name, version: node.version, patch: node.patch }
    const key = toTarballKey(inputs)
    if (unreachable.has(node.id)) {
      tarballsToRemove.set(key, inputs)
      continue
    }
    referencedTarballs.add(key)
  }

  const result = graph.mutate(m => {
    for (const edge of internalEdges) {
      m.removeEdge(edge.src, edge.dst, edge.kind)
    }
    for (const nodeId of unreachableNodes) {
      m.removeNode(nodeId)
    }
    for (const [key, inputs] of Array.from(tarballsToRemove.entries()).sort((a, b) => cmpStr(a[0], b[0]))) {
      if (!referencedTarballs.has(key)) {
        m.removeTarball(inputs)
      }
    }
  })

  if (sidecar !== undefined) {
    sidecarByGraph.set(result.graph, pruneSidecar(sidecar, result.graph))
  }
  config.hooks?.rebindGraph?.(graph, result.graph)
  const reachableIds = new Set(Array.from(result.graph.nodes(), n => n.id))
  config.hooks?.pruneToNodes?.(result.graph, reachableIds)
  return { graph: result.graph, diagnostics: result.unresolved }
}

// === derivePeerCandidates (exported for cross-format reuse) ===============

export type PeerCandidateOutcome =
  | { kind: 'single'; candidate: string }
  | { kind: 'ambiguous'; candidates: string[] }
  | { kind: 'unsatisfied' }

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

// === pruneSidecar ==========================================================

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
    if (reachableIds.has(nodeId)) workspaceByPath.set(path, nodeId)
  }
  return {
    rootId: sidecar.rootId !== undefined && reachableIds.has(sidecar.rootId) ? sidecar.rootId : undefined,
    rootMeta: sidecar.rootMeta,
    nodes,
    edgeRanges,
    edgeDeclaredNames,
    workspaceByPath,
  }
}

// === Sidecar accessor (exported for hook implementations) =================

export function getFlatSidecar(graph: Graph): NpmSidecar | undefined {
  return sidecarByGraph.get(graph)
}

// === Helpers ===============================================================

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

function nameFromInstallPath(config: NpmFamilyConfig, path: string, entry: NpmEntry): string {
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
    || entry.resolved !== undefined
}

function tarballPayloadOf(entry: NpmEntry, subject: string, diagnostics: Diagnostic[]): TarballPayload {
  const payload: TarballPayload = {}
  if (entry.integrity !== undefined) {
    const canonical = integrityValidateCanonical(entry.integrity)
    if (canonical === undefined) {
      diagnostics.push(invalidIntegrityDiagnostic('NPM', subject, entry.integrity))
    } else {
      payload.integrity = canonical
    }
  }
  if (entry.engines !== undefined) payload.engines = { ...entry.engines }
  if (entry.funding !== undefined) payload.funding = entry.funding
  if (entry.license !== undefined) payload.license = entry.license
  if (entry.bin !== undefined) payload.bin = typeof entry.bin === 'string' ? entry.bin : { ...entry.bin }
  if (entry.deprecated !== undefined) payload.deprecated = entry.deprecated
  if (entry.cpu !== undefined) payload.cpu = entry.cpu.slice()
  if (entry.os !== undefined) payload.os = entry.os.slice()
  if (entry.libc !== undefined) payload.libc = entry.libc.slice()
  // ADR-0014 §4.F3 — canonical resolution from npm `resolved` URL.
  if (typeof entry.resolved === 'string' && !entry.link) {
    const canonical = parseResolutionRecipe(entry.resolved, { sourceKind: 'npm-resolved' })
    if (canonical.type === 'unknown') {
      diagnostics.push(unknownResolutionDiagnostic(subject, entry.resolved))
    }
    payload.resolution = canonical
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
  edgeRanges: Map<string, string>,
  edgeDeclaredNames: Map<string, string>,
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
      })
      continue
    }
    // EdgeAttrs.alias — preserved when the manifest dep key differs from
    // the target's actual name. npm encodes aliases via `node_modules/<alias>`
    // entries whose `entry.name` is the target's real name; we already
    // resolve dstId through that channel, so a mismatch between `name`
    // (the manifest key) and the dst node's name reveals the alias.
    // `edgeRanges` / `edgeDeclaredNames` keep the existing 3-part key
    // shape (pruneSidecar splits on `|`); cross-format consumers that
    // need per-alias data read `edge.attrs.alias` directly.
    const aliasSlot = name === nameOf(dstId) ? undefined : name
    const edgeKey = edgeTripleKey(srcId, kind, dstId)
    if (edgeRanges.has(edgeKey) && aliasSlot === undefined) continue
    if (aliasSlot === undefined) {
      edgeRanges.set(edgeKey, range)
      edgeDeclaredNames.set(edgeKey, name)
    } else if (!edgeRanges.has(edgeKey)) {
      edgeRanges.set(edgeKey, range)
      edgeDeclaredNames.set(edgeKey, name)
    }
    try {
      const attrs: { range: string; alias?: string } = { range }
      if (aliasSlot !== undefined) attrs.alias = aliasSlot
      builder.addEdge(srcId, dstId, kind, attrs)
    } catch (error) {
      if (error instanceof GraphError && error.code === 'INVARIANT_VIOLATION') {
        continue
      }
      throw error
    }
  }
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
  // `pkg@1.0.0`). Node-flat sources (npm-2 / npm-3) carry sidecar
  // install paths that have already filled every position above, so this
  // BFS is a no-op for them.
  // ADR-0026 replay vs generate. When every resolved node carries a
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
    // ADR-0026 §Diagnostics — the emitted tree is a re-synthesised valid
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

function fallbackInstallPathForNode(node: Node, pathToId: ReadonlyMap<string, string>): string {
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

function buildRootEntry(
  graph: Graph,
  rootNode: Node,
  rootMeta: NpmRootMeta | undefined,
  sidecar: NpmSidecar | undefined,
  emitDiagnostic: (d: Diagnostic) => void = () => undefined,
): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  body.name = rootMeta?.name ?? rootNode.name
  body.version = rootMeta?.version ?? rootNode.version

  const blocks = collectManifestBlocks(graph, rootNode.id, sidecar, emitDiagnostic)
  if (Object.keys(blocks.dep).length > 0) body.dependencies = blocks.dep
  if (Object.keys(blocks.dev).length > 0) body.devDependencies = blocks.dev
  if (Object.keys(blocks.peer).length > 0) body.peerDependencies = blocks.peer
  else if (rootMeta?.peerDependencies !== undefined) body.peerDependencies = sortRecord(rootMeta.peerDependencies)
  if (Object.keys(blocks.optional).length > 0) body.optionalDependencies = blocks.optional
  else if (rootMeta?.optionalDependencies !== undefined) body.optionalDependencies = sortRecord(rootMeta.optionalDependencies)
  if (rootMeta?.workspaces !== undefined) body.workspaces = rootMeta.workspaces
  if (rootMeta?.bundleDependencies !== undefined) body.bundleDependencies = rootMeta.bundleDependencies
  return reorderEntry(body)
}

function buildSyntheticRootEntry(rootMeta: NpmRootMeta): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  if (rootMeta.name !== undefined) body.name = rootMeta.name
  if (rootMeta.version !== undefined) body.version = rootMeta.version
  if (rootMeta.workspaces !== undefined) body.workspaces = rootMeta.workspaces
  if (rootMeta.bundleDependencies !== undefined) body.bundleDependencies = rootMeta.bundleDependencies
  return reorderEntry(body)
}

function buildWorkspaceMemberEntry(
  graph: Graph,
  node: Node,
  sidecar: NpmSidecar | undefined,
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
  return reorderEntry(body)
}

function buildNodeModulesEntry(
  graph: Graph,
  node: Node,
  nodeSide: NpmFlatSidecar | undefined,
  config: NpmFamilyConfig,
  emitDiagnostic: (d: Diagnostic) => void = () => undefined,
): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  if (nodeSide !== undefined && nodeSide.installPaths.some(p => installPathTail(p) !== node.name)) {
    body.name = node.name
  }
  body.version = node.version

  const tarball = graph.tarballOf(node.id)
  // `resolved` URL: prefer `node.resolution`. Adapter-specific recovery
  // (e.g. npm-2 legacy-mirror sidecar that stashes the on-disk URL when
  // the parser does not sync it to `node.resolution`) is delegated via
  // `hooks.recoverResolvedForNode`. ADR-0014 §4.F3 cross-format fallback:
  // when neither carrier is present, derive from canonical resolution.
  const resolved = node.resolution
    ?? config.hooks?.recoverResolvedForNode?.(graph, node)
    ?? deriveResolvedFromCanonical(tarball?.resolution)
  if (resolved !== undefined) body.resolved = resolved
  if (tarball?.integrity !== undefined) body.integrity = tarball.integrity
  if (nodeSide?.dev === true) body.dev = true
  if (nodeSide?.optional === true) body.optional = true
  if (nodeSide?.peer === true) body.peer = true
  if (nodeSide?.inBundle === true) body.inBundle = true

  const sidecar = getFlatSidecar(graph)
  const blocks = collectManifestBlocks(graph, node.id, sidecar, emitDiagnostic)
  const innerDeps: Record<string, string> = { ...blocks.dep, ...blocks.dev }
  if (Object.keys(innerDeps).length > 0) body.dependencies = sortRecord(innerDeps)

  if (Object.keys(blocks.peer).length > 0) body.peerDependencies = blocks.peer
  else if (nodeSide?.peerDependencies !== undefined) body.peerDependencies = sortRecord(nodeSide.peerDependencies)

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

  return reorderEntry(body)
}

// ADR-0014 §4.F3 — project canonical resolution → npm `resolved` URL for
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

function collectManifestBlocks(
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

    // ADR-0014 §4.F4 — workspace edges: npm lacks the `workspace:` protocol
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
    dep: sortRecord(dep),
    dev: sortRecord(dev),
    peer: sortRecord(peer),
    optional: sortRecord(optional),
  }
}

const ENTRY_FIELD_ORDER = [
  'name',
  'version',
  'resolved',
  'integrity',
  'link',
  'dev',
  'optional',
  'peer',
  'inBundle',
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
  'bin',
  'engines',
  'funding',
  'license',
  'deprecated',
  'cpu',
  'os',
  'libc',
  'workspaces',
  'bundleDependencies',
  'hasShrinkwrap',
] as const

function reorderEntry(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of ENTRY_FIELD_ORDER) {
    if (key in body) out[key] = body[key]
  }
  for (const key of Object.keys(body)) {
    if (!(key in out)) out[key] = body[key]
  }
  return out
}

function warnPeerContextFlatten(
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

function warnPatchDrop(
  config: NpmFamilyConfig,
  node: Node,
  warned: Set<string>,
  emitDiagnostic: (diagnostic: Diagnostic) => void,
): void {
  if (node.patch === undefined || warned.has(node.id)) return
  warned.add(node.id)
  patchEmitDropped(
    node.id,
    'patch',
    `npm-${config.lockfileVersion} has no patch: protocol; ${JSON.stringify(node.patch)} dropped`,
    emitDiagnostic,
  )
}

function parseFailed(config: NpmFamilyConfig, message: string): LockfileError {
  return new LockfileError({
    code: 'PARSE_FAILED',
    message: `npm-${config.lockfileVersion}: ${message}`,
  })
}
