// npm-1 adapter — npm `package-lock.json` lockfileVersion 1 (nested-tree shape).
//
// Standalone adapter per ADR-0021 §5 + r2 collab gate verdict: the npm-1
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
import { parseSri, emitSri, isEmptyIntegrity } from '../recipe/integrity.ts'
import {
  NPM_EDGE_RANGE_ATTR,
  cmpStr,
  edgeTripleKey,
  sortRecord,
  stringifyNpmLock,
  type NpmFlatSidecar,
  type NpmSidecar,
} from './_npm-flat-types.ts'
import { derivePeerCandidates, pruneSidecar } from './_npm-core.ts'
import { emitDropped as patchEmitDropped, emitDropped as recipeEmitDropped } from '../recipe/diagnostics.ts'
import {
  isYarnBerryLocator,
  parse as parseResolutionRecipe,
  sourceDiscriminatorOf,
  stringifyForNpm,
  type ResolutionCanonical,
} from '../recipe/resolution.ts'

// === Public option types ====================================================

export interface Npm1ParseOptions {}
export interface Npm1StringifyOptions {
  lineEnding?: 'lf' | 'crlf'
  onDiagnostic?: (diagnostic: Diagnostic) => void
}

export interface Npm1Manifest {
  name?: string
  version?: string
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}

export interface Npm1EnrichOptions {
  manifests?: Record<string, Npm1Manifest>
}

export interface Npm1OptimizeOptions {}

// === npm-1 JSON schema ======================================================

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

// === Sidecar (reuses NpmSidecar shape from _npm-flat-types.ts) =============

const sidecarByGraph = new WeakMap<Graph, NpmSidecar>()

function rememberSidecar(graph: Graph, sidecar: NpmSidecar): void {
  sidecarByGraph.set(graph, sidecar)
}

// === Public API: check / parse / stringify / enrich / optimize =============

export function check(input: string): boolean {
  // Empirical probe — accept loose v1 fixtures (some lack `dependencies`
  // when no deps were installed, e.g. the workspaces-basic case).
  if (!/"lockfileVersion"\s*:\s*1\b/.test(input)) return false
  // Reject inputs carrying a flat `packages` map (npm-2/npm-3 shape).
  if (/"packages"\s*:\s*\{/.test(input)) return false
  return true
}

export function parse(input: string, _options: Npm1ParseOptions = {}): Graph {
  const lf = parseJson(input)

  if (lf.lockfileVersion !== 1) {
    throw new LockfileError({
      code: 'FORMAT_MISMATCH',
      message: `npm-1 adapter: expected lockfileVersion 1, got ${JSON.stringify(lf.lockfileVersion)}`,
    })
  }

  if (lf.packages !== undefined && lf.packages !== null) {
    // Flat-shape inputs belong to npm-2/npm-3 adapters.
    throw new LockfileError({
      code: 'FORMAT_MISMATCH',
      message: 'npm-1 adapter: input carries flat "packages" map; route to npm-2/npm-3',
    })
  }

  const builder = newBuilder()
  const diagnostics: Diagnostic[] = []
  const nodeSidecar = new Map<string, NpmFlatSidecar>()
  const edgeRanges = new Map<string, string>()
  const edgeDeclaredNames = new Map<string, string>()

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

  // First pass: walk the tree, register each leaf as a graph node and
  // accumulate sidecar install paths. The npm-1 tree carries `<name>:
  // <entry>` keys where the same NodeId (name@version) can appear at
  // multiple paths (npm v6 dedup may de-hoist a transitive into a nested
  // `dependencies` block). The sidecar tracks every install path so the
  // emitter can reproduce the original hoisting.
  const seenIds = new Set<string>()
  const walk = (
    deps: Record<string, Npm1Entry> | undefined,
    parentPath: string,
    inheritedDev: boolean,
    inheritedOptional: boolean,
  ): void => {
    if (deps === undefined) return
    for (const [declaredName, entry] of Object.entries(deps).sort((a, b) => cmpStr(a[0], b[0]))) {
      if (entry === null || typeof entry !== 'object') continue
      const version = entry.version
      if (typeof version !== 'string') {
        diagnostics.push({
          code: 'NPM_BAD_ENTRY',
          severity: 'warning',
          message: `npm-1 entry ${JSON.stringify(declaredName)} at ${JSON.stringify(parentPath)} missing version`,
        })
        continue
      }
      const resolved = entry.resolved ?? (isUrlLikeVersion(version) ? version : undefined)
      // ADR-0032 — the `+src=` non-registry discriminator, folded into the
      // NodeId so a git `is@6.3.1` does not collapse onto a registry `is@6.3.1`
      // (#2b). Bare for registry / directory / absent (zero registry blast
      // radius). The full canonical (with its UNKNOWN diagnostic) is recomputed
      // inside the new-node block below where `id` is available as the subject.
      const source = resolved !== undefined
        ? sourceDiscriminatorOf(parseResolutionRecipe(resolved, { sourceKind: 'npm-resolved' }))
        : undefined
      const id = serializeNodeId(declaredName, version, [], undefined, source)
      const installPath = parentPath === '' ? `node_modules/${declaredName}` : `${parentPath}/node_modules/${declaredName}`

      if (!seenIds.has(id)) {
        seenIds.add(id)
        const node: Node = {
          id,
          name: declaredName,
          version,
          peerContext: [],
        }
        // ADR-0032 — carry the slot on the Node so the seal re-derives the id.
        if (source !== undefined) node.source = source
        builder.addNode(node)
        const payload: TarballPayload = {}
        if (entry.integrity !== undefined) {
          const integrity = parseSri(entry.integrity, 'sri')
          if (!isEmptyIntegrity(integrity)) payload.integrity = integrity
        }
        // ADR-0014 §4.F3 — canonical resolution from npm `resolved` URL +
        // ADR-0013 PM-native verbatim sidecar (per-tarball).
        if (resolved !== undefined) {
          payload.nativeResolution = resolved
          const canonical = parseResolutionRecipe(resolved, { sourceKind: 'npm-resolved' })
          if (canonical.type === 'unknown') {
            diagnostics.push({
              code:     'RECIPE_RESOLUTION_UNKNOWN',
              severity: 'warning',
              subject:  id,
              message:  `resolution shape not canonicalisable: ${JSON.stringify(resolved)}`,
            })
          }
          payload.resolution = canonical
        }
        if (Object.keys(payload).length > 0) {
          builder.setTarball({ name: declaredName, version, source }, payload)
        }
      }

      const sc = ensureSidecar(nodeSidecar, id)
      sc.installPaths.push(installPath)
      const isDev = entry.dev === true || inheritedDev
      const isOptional = entry.optional === true || inheritedOptional
      if (isDev) sc.dev = true
      if (isOptional) sc.optional = true
      if (entry.bundled === true) sc.inBundle = true
      if (entry.peerDependencies !== undefined) {
        sc.peerDependencies = { ...entry.peerDependencies }
      }

      // Edges from this entry to its declared deps (`requires` block —
      // npm-1 dialect — fall back to inner-block `dependencies` keys if
      // `requires` absent, matching legacy parser behaviour).
      const requires = collectRequires(entry)
      if (requires !== undefined) {
        for (const [reqName, range] of Object.entries(requires).sort((a, b) => cmpStr(a[0], b[0]))) {
          const target = resolveTreeTarget(reqName, parentPath === '' ? installPath : installPath, deps, parentScopes)
          if (target === undefined) {
            diagnostics.push({
              code: 'NPM_UNRESOLVED_DEP',
              severity: 'warning',
              subject: id,
              message: `${id}: unresolved dep ${reqName}@${range}`,
            })
            continue
          }
          const edgeKey = edgeTripleKey(id, 'dep', target)
          if (edgeRanges.has(edgeKey)) continue
          edgeRanges.set(edgeKey, range)
          edgeDeclaredNames.set(edgeKey, reqName)
          try {
            builder.addEdge(id, target, 'dep', { range })
          } catch (error) {
            if (error instanceof GraphError && error.code === 'INVARIANT_VIOLATION') continue
            throw error
          }
        }
      }

      // Recurse into nested `dependencies`. The walker pushes the current
      // entry's siblings + ancestor scopes so children can resolve their
      // `requires` against the closest hoisted parent.
      parentScopes.push(deps)
      walk(entry.dependencies, installPath, isDev, isOptional)
      parentScopes.pop()
    }
  }

  const parentScopes: Array<Record<string, Npm1Entry>> = []
  walk(lf.dependencies, '', false, false)

  // Root edges: top-level entries become dep edges from root.
  if (lf.dependencies !== undefined) {
    for (const [declaredName, entry] of Object.entries(lf.dependencies).sort((a, b) => cmpStr(a[0], b[0]))) {
      if (entry === null || typeof entry !== 'object') continue
      const version = entry.version
      if (typeof version !== 'string') continue
      const dstId = `${declaredName}@${version}`
      if (!seenIds.has(dstId)) continue
      const edgeKey = edgeTripleKey(rootId, 'dep', dstId)
      if (edgeRanges.has(edgeKey)) continue
      edgeRanges.set(edgeKey, version)
      edgeDeclaredNames.set(edgeKey, declaredName)
      try {
        builder.addEdge(rootId, dstId, 'dep', { range: version })
      } catch (error) {
        if (error instanceof GraphError && error.code === 'INVARIANT_VIOLATION') continue
        throw error
      }
    }
  }

  for (const sc of nodeSidecar.values()) {
    sc.installPaths = Array.from(new Set(sc.installPaths)).sort(cmpStr)
  }

  for (const diagnostic of diagnostics) {
    builder.diagnostic(diagnostic)
  }

  try {
    const graph = builder.seal()
    rememberSidecar(graph, {
      rootId,
      rootMeta: {
        name: lf.name,
        version: lf.version,
        requires: lf.requires,
      },
      edgeRanges,
      edgeDeclaredNames,
      nodes: nodeSidecar,
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

export function stringify(graph: Graph, options: Npm1StringifyOptions = {}): string {
  const sidecar = sidecarByGraph.get(graph)
  const emitDiagnostic = (diagnostic: Diagnostic): void => {
    options.onDiagnostic?.(diagnostic)
  }

  const warnedPeerVirt = new Set<string>()
  const warnedPatches = new Set<string>()
  const warnedPeerEdges = new Set<string>()
  const warnedWorkspaces = new Set<string>()

  const rootNode = locateRootNode(graph, sidecar)
  const rootMeta = sidecar?.rootMeta
  const rootName = rootMeta?.name ?? rootNode?.name ?? ''
  const rootVersion = rootMeta?.version ?? rootNode?.version ?? '0.0.0'

  // Warn on each lossy condition + collect the set of nodes to emit (excluding
  // workspace members other than the root).
  const emittableIds = new Set<string>()
  for (const node of graph.nodes()) {
    warnPatchDrop(node, warnedPatches, emitDiagnostic)
    warnPeerContextFlatten(node, warnedPeerVirt, emitDiagnostic)
    if (rootNode !== undefined && node.id === rootNode.id) continue
    if (node.workspacePath !== undefined && node.workspacePath !== '') {
      // npm-1 cannot represent workspaces — emit warning, drop node from tree.
      if (!warnedWorkspaces.has(node.id)) {
        warnedWorkspaces.add(node.id)
        emitDiagnostic({
          code: 'NPM_V1_WORKSPACES_UNSAFE',
          severity: 'warning',
          subject: node.id,
          message: `workspace member ${node.id} at ${JSON.stringify(node.workspacePath)} is unsupported in npm-1; omitting from emit`,
        })
        // ADR-0014 §4.F3 — also surface canonical RECIPE_FEATURE_DROPPED.
        recipeEmitDropped(
          node.id,
          'workspace',
          `npm-1 has no workspace primitive (ADR-0021 §A.npm-1)`,
          emitDiagnostic,
        )
      }
      continue
    }
    emittableIds.add(node.id)
  }

  // Surface peer-edge drops (one warning per affected edge).
  for (const node of graph.nodes()) {
    for (const edge of graph.out(node.id, 'peer')) {
      const key = `${edge.src}\u0000${edge.dst}\u0000${edge.attrs?.range ?? ''}`
      if (warnedPeerEdges.has(key)) continue
      warnedPeerEdges.add(key)
      const dst = graph.getNode(edge.dst)
      emitDiagnostic({
        code: 'NPM_V1_PEER_DROPPED',
        severity: 'warning',
        subject: edge.src,
        message: dst === undefined || edge.attrs?.range === undefined
          ? `peer edge ${edge.src} -> ${edge.dst} is unsupported in npm-1; dropping on emit`
          : `peer edge ${edge.src} -> ${dst.name}@${edge.attrs.range} is unsupported in npm-1; dropping on emit`,
      })
    }
  }

  // Build the hoisting plan: top-level slots first (deps reachable from the
  // root); conflicts fall to nested `<parent>.dependencies` blocks. Mirrors
  // the legacy npm v6 dedup walker.
  const rootId = rootNode?.id ?? `${rootName}@${rootVersion}`
  const dependencies = buildDependenciesTree(graph, sidecar, rootId, emittableIds)

  const out: Record<string, unknown> = {
    name: rootName,
    version: rootVersion,
    lockfileVersion: 1,
    requires: rootMeta?.requires ?? true,
  }
  // Top-level emit: legacy npm v6 writer always emits `dependencies` (may be
  // empty when nothing was installed). For graphs without any non-root nodes
  // we emit a minimal `{name, version, lockfileVersion}` matching the
  // workspaces-basic fixture shape.
  if (dependencies !== undefined && Object.keys(dependencies).length > 0) {
    out.dependencies = sortRecord(dependencies)
  } else if (emittableIds.size === 0 && warnedWorkspaces.size > 0) {
    // Workspace-only graph — minimal shape (drop `requires`).
    delete out.requires
  }

  const text = stringifyNpmLock(out)
  return options.lineEnding === 'crlf' ? text.replace(/\n/g, '\r\n') : text
}

export function enrich(
  graph: Graph,
  options: Npm1EnrichOptions = {},
): { graph: Graph; diagnostics: Diagnostic[] } {
  const sidecar = sidecarByGraph.get(graph)
  const diagnostics: Diagnostic[] = []

  // §C peer derivation surfacing (diagnostic-only — npm-1 graph carries no
  // peer edges per spec, but if sidecar.peerDependencies were captured from
  // a future npm v5 lockfile, we surface ambiguity/unsatisfied diagnostics).
  for (const node of graph.nodes()) {
    const nodeSide = sidecar?.nodes.get(node.id)
    const rawPeers = nodeSide?.peerDependencies
    if (rawPeers === undefined) continue
    for (const [peerName, range] of Object.entries(rawPeers).sort((a, b) => cmpStr(a[0], b[0]))) {
      const outcome = derivePeerCandidates(graph, peerName, range)
      if (outcome.kind === 'single') continue
      if (outcome.kind === 'unsatisfied') {
        diagnostics.push({
          code: 'NPM_V1_PEER_UNSATISFIED',
          severity: 'warning',
          subject: node.id,
          message: `peer "${peerName}" range "${range}" matches no installed version`,
        })
        continue
      }
      diagnostics.push({
        code: 'NPM_V1_PEER_AMBIGUOUS',
        severity: 'warning',
        subject: node.id,
        message: `peer "${peerName}" range "${range}" matches multiple candidates: ${outcome.candidates.join(', ')}`,
      })
    }
  }

  // Workspace concretisation from manifests only (npm-1 has no on-disk
  // workspace block). Mirrors yarn-classic §C.
  if (options.manifests === undefined) {
    // Surface the no-manifests diagnostic only if the graph contains
    // non-root workspace-like nodes — i.e. nodes bearing workspacePath
    // OTHER than the synthetic root tag. Root carries workspacePath = ''
    // unconditionally (per parse), which is not a useful signal.
    const hasWorkspaceHint = Array.from(graph.nodes())
      .some(n => n.workspacePath !== undefined && n.workspacePath !== '')
    if (hasWorkspaceHint) {
      diagnostics.push({
        code: 'NPM_V1_NO_MANIFESTS',
        severity: 'warning',
        message: 'workspace concretisation requires manifests; leaving npm-1 graph unclassified',
      })
    }
    return { graph, diagnostics }
  }

  // Manifest-driven enrich plan: synthesise workspace member nodes, attribute
  // root edges (dep / dev / optional / peer) per the root manifest, mark
  // workspace-protocol edges.
  const plan = planManifestEnrich(graph, sidecar, options.manifests)
  if (
    plan.rootNodeReplacement === undefined
    && plan.addRootEdges.length === 0
    && plan.removeRootEdges.length === 0
    && plan.markWorkspaceEdges.length === 0
    && plan.memberNodeReplacements.length === 0
    && plan.addMemberNodes.length === 0
  ) {
    return { graph, diagnostics }
  }

  const result = graph.mutate(m => {
    if (plan.rootNodeReplacement !== undefined) {
      m.replaceNode(plan.rootNodeReplacement.id, plan.rootNodeReplacement)
    }
    for (const node of plan.addMemberNodes) {
      m.addNode(node)
    }
    for (const replacement of plan.memberNodeReplacements) {
      m.replaceNode(replacement.id, replacement)
    }
    for (const edge of plan.removeRootEdges) {
      m.removeEdge(edge.src, edge.dst, edge.kind)
    }
    for (const edge of plan.addRootEdges) {
      m.addEdge(edge.src, edge.dst, edge.kind, edge.attrs)
    }
    for (const edge of plan.markWorkspaceEdges) {
      m.removeEdge(edge.src, edge.dst, edge.kind)
      m.addEdge(edge.src, edge.dst, edge.kind, edge.attrs)
    }
  })

  if (sidecar !== undefined) rememberSidecar(result.graph, sidecar)
  return { graph: result.graph, diagnostics }
}

export function optimize(
  graph: Graph,
  _options: Npm1OptimizeOptions = {},
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
    const inputs = { name: node.name, version: node.version, patch: node.patch, source: node.source }
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
    rememberSidecar(result.graph, pruneSidecar(sidecar, result.graph))
  }
  return { graph: result.graph, diagnostics: result.unresolved }
}

// === Helpers ===============================================================

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

function isHttpUrl(value: string): boolean {
  return value.startsWith('https://') || value.startsWith('http://')
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

// === Hoisting emit ==========================================================

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
function buildDependenciesTree(
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

  // Pass 1: replay sidecar install paths verbatim. The sidecar stores
  // `node_modules/<name>` or `<parent_path>/node_modules/<name>` strings.
  if (sidecar !== undefined) {
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

  // Pass 2: any emittable node without a sidecar placement hoists to the
  // shallowest non-conflicting level. Walking BFS keeps the placement order
  // deterministic; conflicting nodes fall to the parent's nested deps.
  const queue: Array<{ id: string; parentPath: string }> = []
  const visited = new Set<string>()
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

  while (queue.length > 0) {
    const { id, parentPath } = queue.shift()!
    if (visited.has(`${id}|${parentPath}`)) continue
    visited.add(`${id}|${parentPath}`)
    const node = graph.getNode(id)
    if (node === undefined) continue

    if (!placements.has(id) || placements.get(id)!.size === 0) {
      // Need to choose a placement. Try parentPath; if its containing
      // `node_modules` already holds a different version of `node.name`,
      // fall to a deeper level.
      let chosen = parentPath
      const existingAt = hoistedAtPath(hoistedByName, placements, graph, chosen, node.name)
      if (existingAt !== undefined && existingAt !== id) {
        // Conflict at chosen level; place during parent (de-hoist).
        chosen = parentPath
        if (chosen === '') {
          // Root-level conflict: must de-hoist to consumer install path.
          // We approximate by placing under the first incoming edge's
          // install path.
          const consumerPath = firstConsumerInstallPath(graph, sidecar, id, emittableIds)
          if (consumerPath !== undefined) chosen = consumerPath
        }
      } else if (chosen === '') {
        hoistedByName.set(node.name, id)
      }
      ensureSet(placements, id).add(chosen)
    }

    // Enqueue children. Each child inherits its parent's deepest placement
    // for transitive walks.
    const chosenSet = placements.get(id)!
    const childParent = chooseDeepest(chosenSet)
    const childInstallPath = childParent === '' ? `node_modules/${node.name}` : `${childParent}/node_modules/${node.name}`
    for (const edge of graph.out(id)) {
      if (edge.kind === 'peer') continue
      const dst = graph.getNode(edge.dst)
      if (dst === undefined) continue
      if (!emittableIds.has(edge.dst)) continue
      if (edge.dst === rootId) continue
      queue.push({ id: edge.dst, parentPath: childInstallPath })
    }
  }

  // Any nodes still unplaced (orphans not reachable from root but in
  // emittableIds, e.g. mutator stash) — hoist to root.
  for (const id of emittableIds) {
    if (placements.has(id) && placements.get(id)!.size > 0) continue
    ensureSet(placements, id).add('')
  }

  // Build the nested-tree from placements. We materialise a tree shape
  // keyed by parent install path. Each parentPath ∈ { '' } ∪ { node_modules/X,
  // X/node_modules/Y, ... } stores its direct children name → NodeId.
  const treeByParent = new Map<string, Map<string, string>>()
  for (const [id, parentSet] of placements) {
    for (const parentPath of parentSet) {
      const layer = ensureMap(treeByParent, parentPath)
      const node = graph.getNode(id)
      if (node === undefined) continue
      layer.set(node.name, id)
    }
  }

  const top = treeByParent.get('')
  if (top === undefined || top.size === 0) {
    // Root may also have no out-edges (workspaces-only graph); return empty.
    if (emittableIds.size === 0) return undefined
    return {}
  }

  return buildLayer(top, '', graph, sidecar, treeByParent)
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
      entry.resolved = resolutionStr
    }
  }
  if (tarball?.integrity !== undefined && !/^(git[+:]|github:)/.test(entry.version ?? '')) {
    const sri = emitSri(tarball.integrity)
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

function parentPathFromInstall(installPath: string): string | undefined {
  // Strip the trailing `/node_modules/<name>` segment.
  const idx = installPath.lastIndexOf('/node_modules/')
  if (idx < 0) {
    // Top-level — `node_modules/<name>` becomes parent = ''.
    if (installPath.startsWith('node_modules/')) return ''
    return undefined
  }
  return installPath.slice(0, idx)
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

function firstConsumerInstallPath(
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

// === Stringify-side lossy diagnostics ======================================

function warnPeerContextFlatten(
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

function warnPatchDrop(
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

// === Manifest-driven enrich plan ===========================================

interface EnrichPlan {
  rootNodeReplacement: Node | undefined
  addMemberNodes: Node[]
  memberNodeReplacements: Node[]
  addRootEdges: Edge[]
  removeRootEdges: Edge[]
  markWorkspaceEdges: Edge[]
}

function planManifestEnrich(
  graph: Graph,
  sidecar: NpmSidecar | undefined,
  manifests: Record<string, Npm1Manifest>,
): EnrichPlan {
  const rootManifest = manifests['']
  const rootNodeId = sidecar?.rootId
  const existingRoot = rootNodeId !== undefined ? graph.getNode(rootNodeId) : undefined

  const addMemberNodes: Node[] = []
  const memberNodeReplacements: Node[] = []
  const addRootEdges: Edge[] = []
  const removeRootEdges: Edge[] = []
  const markWorkspaceEdges: Edge[] = []

  const memberByName = new Map<string, { path: string; manifest: Npm1Manifest }>()
  for (const [path, manifest] of Object.entries(manifests)) {
    if (path === '' || manifest.name === undefined) continue
    memberByName.set(manifest.name, { path, manifest })
  }

  // (a) Tag existing nodes that match manifest member name+version (or
  // a workspace-protocol sentinel) with workspacePath. None likely on npm-1
  // (workspace members rarely appear in the on-disk dep tree), but
  // bookkeeping is cheap.
  for (const node of graph.nodes()) {
    if (node.workspacePath !== undefined) continue
    const member = memberByName.get(node.name)
    if (member === undefined) continue
    if (member.manifest.version !== undefined && node.version !== member.manifest.version) continue
    if (graph.tarballOf(node.id) !== undefined) continue
    memberNodeReplacements.push({ ...node, workspacePath: member.path })
  }

  // (b) Synthesise workspace member nodes from manifests if they're not
  // already in the graph. NodeId = `<name>@<manifest.version ?? '0.0.0'>`.
  for (const [name, { path, manifest }] of memberByName) {
    const memberVersion = manifest.version ?? '0.0.0'
    const memberId = `${name}@${memberVersion}`
    const existing = graph.getNode(memberId)
    if (existing !== undefined) {
      if (existing.workspacePath === path) continue
      memberNodeReplacements.push({ ...existing, workspacePath: path })
      continue
    }
    if (memberNodeReplacements.some(n => n.id === memberId)) continue
    addMemberNodes.push({
      id: memberId,
      name,
      version: memberVersion,
      peerContext: [],
      workspacePath: path,
    })
  }

  // Prospective NodeIds: workspace members we plan to synthesise. The edge
  // resolver consults this so the desired-root-edge pass binds to them even
  // before the mutator runs.
  const prospectiveIds = new Set<string>()
  for (const node of addMemberNodes) prospectiveIds.add(node.id)
  for (const node of memberNodeReplacements) prospectiveIds.add(node.id)

  // (c) Root edges per the root manifest. Mirrors yarn-classic precedent.
  const rootForEdges = existingRoot !== undefined
    && rootNodeId !== undefined
    && rootManifest !== undefined
    ? rootNodeId
    : undefined

  if (rootForEdges !== undefined && rootManifest !== undefined) {
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
        if (isWorkspaceProtocolRange(range) || memberByName.has(name)) {
          attrs.workspace = true
        }
        desired.push({ src: rootForEdges, dst: dstId, kind, attrs })
      }
    }
    const existingByDst = new Map<string, Edge[]>()
    for (const edge of graph.out(rootForEdges)) {
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
      if (!match) addRootEdges.push(edge)
    }
    // We don't actively remove root edges on npm-1 enrich — preserves the
    // parse-time edge set. Mutations are additive.
  }

  // (d) Mark edges hitting a workspace member with `workspace: true`.
  for (const node of graph.nodes()) {
    for (const edge of graph.out(node.id)) {
      if (edge.kind === 'peer') continue
      if (edge.attrs?.workspace === true) continue
      const dst = graph.getNode(edge.dst)
      if (dst === undefined) continue
      if (!memberByName.has(dst.name)) continue
      // Only mark if the dst node was tagged with workspacePath (or will be).
      const willBeMember = memberNodeReplacements.some(n => n.id === edge.dst)
        || addMemberNodes.some(n => n.id === edge.dst)
        || dst.workspacePath !== undefined
      if (!willBeMember) continue
      markWorkspaceEdges.push({
        src: edge.src,
        dst: edge.dst,
        kind: edge.kind,
        attrs: { ...edge.attrs, workspace: true },
      })
    }
  }

  let rootNodeReplacement: Node | undefined
  if (existingRoot !== undefined && existingRoot.workspacePath === undefined) {
    rootNodeReplacement = { ...existingRoot, workspacePath: '' }
  }

  return {
    rootNodeReplacement,
    addMemberNodes,
    memberNodeReplacements,
    addRootEdges,
    removeRootEdges,
    markWorkspaceEdges,
  }
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
      // Member node will be synthesised by the surrounding plan; bind to it
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
