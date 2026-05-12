// npm-3 adapter — npm `package-lock.json` lockfileVersion 3.
//
// Per ADR-0021 §A.npm-3 (RATIFIED 2026-05-12). Phase §A: parse + stringify
// against the Graph-level roundtrip predicate (parse(stringify(parse(x)))
// .diff(parse(x)) is empty). §B/§C/§D land in follow-up phases; this round
// exposes their entry points as no-op stubs to honour the uniform adapter
// surface (ADR-0021 §"Adapter API surface").
//
// Mined from legacy/main/ts/formats/npm-3.ts (parsePackages, parseResolution).
// _npm-core.ts extraction is deferred to the npm-2 implementation per
// ADR-0021 §5 mining strategy.
//
// Install-layout fidelity:
// - `packages` keys ("", "node_modules/<pkg>", "node_modules/<a>/node_modules/<b>",
//   "<wsPath>", "<wsPath>/node_modules/<pkg>") collapse to graph NodeIds by
//   (name, version) per ADR-0006. The install-path -> node-id mapping is held
//   in a per-graph sidecar so stringify replays the exact layout. Mutators
//   that introduce new nodes flat-emit under `node_modules/<name>` (the
//   simplest topology that survives re-parse).

import {
  GraphError,
  newBuilder,
  type Diagnostic,
  type EdgeKind,
  type Graph,
  type Node,
  type TarballPayload,
} from '../graph.ts'
import { LockfileError } from '../errors.ts'

// HOIST: cmpStr + sortRecord identical to _yarn-berry-core.ts:30 + similar
// sort helpers. Mechanically extract к shared utility on _npm-core.ts
// extraction round (per ADR-0021 §5, deferred к npm-2 implementation).
const cmpStr = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0

const NPM3_EDGE_RANGE_ATTR = 'range'

// Edge sidecar key: ${src}|${kind}|${dst} — pipe-separated since `|` cannot
// appear in NodeIds (per ADR-0006 grammar) or EdgeKind tokens. Kept identical
// across parse-side population and stringify-side lookup so the sidecar
// retrieves the declared dep-name verbatim.
function edgeTripleKey(src: string, kind: EdgeKind, dst: string): string {
  return `${src}|${kind}|${dst}`
}

// JSON-shape of an npm-3 `packages` entry. We accept unknown fields and
// preserve them in a per-node sidecar when graph-level facts cannot carry
// them (only the body order is normalised on emit).
interface Npm3Entry {
  name?: string
  version?: string
  resolved?: string
  integrity?: string
  link?: boolean
  dev?: boolean
  optional?: boolean
  peer?: boolean
  inBundle?: boolean
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  bin?: string | Record<string, string>
  engines?: Record<string, string>
  funding?: unknown
  license?: string
  workspaces?: string[]
  bundleDependencies?: string[] | boolean
  hasShrinkwrap?: boolean
  deprecated?: string
  cpu?: string[]
  os?: string[]
  libc?: string[]
  [key: string]: unknown
}

interface Npm3Lockfile {
  name?: string
  version?: string
  lockfileVersion?: number
  requires?: boolean
  packages?: Record<string, Npm3Entry>
  dependencies?: unknown
}

interface Npm3RootMeta {
  name?: string
  version?: string
  requires?: boolean
  workspaces?: string[]
  bundleDependencies?: string[] | boolean
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
}

// Per-NodeId sidecar: the install path the entry was originally keyed by,
// plus any inner-block records we cannot reconstruct from graph edges alone.
interface Npm3NodeSidecar {
  installPaths: string[]
  inBundle?: boolean
  dev?: boolean
  optional?: boolean
  peer?: boolean
  peerDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

interface Npm3Sidecar {
  rootId?: string
  rootMeta?: Npm3RootMeta
  // Edge-level: range record per edgeTripleKey(src, kind, dst).
  edgeRanges: Map<string, string>
  // Edge-level: declared dep-name in the source manifest. Differs from
  // dst.name when the consumer imports via an `npm:` alias or a workspace
  // symlink (`is-git` aliasing `@sindresorhus/is`; `<wsName>` symlinking a
  // workspace member). Used by stringify to round-trip the consumer's
  // import-name.
  edgeDeclaredNames: Map<string, string>
  // Node-level sidecar keyed by NodeId.
  nodes: Map<string, Npm3NodeSidecar>
  // Workspace member path lookup: workspacePath -> NodeId.
  workspaceByPath: Map<string, string>
}

export interface Npm3ParseOptions {}
export interface Npm3StringifyOptions {
  lineEnding?: 'lf' | 'crlf'
  onDiagnostic?: (diagnostic: Diagnostic) => void
}
export interface Npm3EnrichOptions {}
export interface Npm3OptimizeOptions {}

const sidecarByGraph = new WeakMap<Graph, Npm3Sidecar>()

// === Public surface =========================================================

// Cheap discriminant: mirrors the legacy substring probe but anchored to the
// canonical npm-cli emit shape (lockfileVersion: 3 literal + top-level
// `packages` map). Distinct from npm-1 (no `packages` key) and from
// non-JSON yarn formats.
export function check(input: string): boolean {
  return /"lockfileVersion"\s*:\s*3\b/.test(input) && /"packages"\s*:\s*\{/.test(input)
}

export function parse(input: string, _options: Npm3ParseOptions = {}): Graph {
  const lf = parseJson(input)

  if (lf.lockfileVersion !== 3) {
    throw new LockfileError({
      code: 'FORMAT_MISMATCH',
      message: `npm-3 adapter: expected lockfileVersion 3, got ${JSON.stringify(lf.lockfileVersion)}`,
    })
  }
  if (lf.packages === undefined || typeof lf.packages !== 'object' || Array.isArray(lf.packages)) {
    throw new LockfileError({
      code: 'FORMAT_MISMATCH',
      message: `npm-3 adapter: top-level "packages" map is required`,
    })
  }

  const packages = lf.packages
  const rootEntry = packages['']
  if (rootEntry === undefined) {
    throw parseFailed('missing root entry under "packages"')
  }

  const builder = newBuilder()
  const diagnostics: Diagnostic[] = []
  const nodeSidecar = new Map<string, Npm3NodeSidecar>()
  const edgeRanges = new Map<string, string>()
  const edgeDeclaredNames = new Map<string, string>()
  const workspaceByPath = new Map<string, string>()
  const pathToId = new Map<string, string>()
  const idToEntry = new Map<string, Npm3Entry>()

  // Pass 1: derive a NodeId per install path; create graph nodes. Workspace
  // symlinks (`link: true`) follow their `resolved` target to the member
  // entry under `<wsPath>` (that path holds the canonical body). Per
  // ADR-0021 §A.npm-3 *Name-mode* clauses.

  const rootName = rootEntry.name ?? lf.name
  const rootVersion = rootEntry.version ?? lf.version
  if (rootName === undefined || rootVersion === undefined) {
    throw parseFailed('root entry must carry name and version')
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

  // Index workspace member entries first (so node_modules/<wsName> link
  // entries can resolve to them). A workspace-member path NEVER traverses a
  // `/node_modules/` boundary; entries under `<wsPath>/node_modules/...`
  // are the workspace's own nested deps and parse through pass 2.
  for (const [path, entry] of Object.entries(packages)) {
    if (path === '' || path.startsWith('node_modules/')) continue
    if (path.includes('/node_modules/')) continue
    if (entry.link === true) continue
    const name = entry.name
    const version = entry.version
    if (name === undefined || version === undefined) {
      throw parseFailed(`workspace entry ${JSON.stringify(path)} missing name/version`)
    }
    const id = `${name}@${version}`
    if (idToEntry.has(id) && idToEntry.get(id) !== entry) {
      // Two workspace entries collapse onto the same NodeId: should not
      // happen on the working fixture set; refuse rather than silently merge.
      throw new LockfileError({
        code: 'IRREDUCIBLE_LOSS',
        message: `two npm-3 entries collapse onto NodeId ${id}`,
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

  // Then index node_modules/... entries. Any path that traverses a
  // `node_modules/` boundary is a nested-install entry; the entry body
  // mirrors a `package.json` minus manifest metadata.
  for (const [path, entry] of Object.entries(packages)) {
    if (!path.startsWith('node_modules/') && !path.includes('/node_modules/')) continue

    if (entry.link === true) {
      const target = entry.resolved
      if (target === undefined) {
        throw parseFailed(`link entry ${JSON.stringify(path)} missing resolved`)
      }
      const targetId = pathToId.get(target)
      if (targetId === undefined) {
        throw parseFailed(`link entry ${JSON.stringify(path)} resolves to unknown workspace ${JSON.stringify(target)}`)
      }
      pathToId.set(path, targetId)
      continue
    }

    const tailName = nameFromInstallPath(path, entry)
    const version = entry.version
    if (version === undefined) {
      throw parseFailed(`entry ${JSON.stringify(path)} missing version`)
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
        builder.setTarball({ name: tailName, version }, tarballPayloadOf(entry))
      }
    }
    // Duplicate install paths for the same (name, version) collapse silently
    // (the graph node identity is (name, version) per ADR-0006).
  }

  // Pass 2: derive sidecar bodies and edges from `dependencies`/
  // `optionalDependencies`/`devDependencies` blocks. Edges resolve via
  // nearest-ancestor `node_modules/...` lookup, mirroring npm's runtime
  // resolution (legacy getClosestPkg). `peerDependencies` are NOT converted
  // to graph peer edges in phase A (ADR-0021 §A.npm-3 inherits ADR-0016
  // §A.4's *Known degradation* clause: peer derivation is §C's job).
  for (const [path, entry] of Object.entries(packages)) {
    const srcId = pathToId.get(path)
    if (srcId === undefined) continue
    if (entry.link === true && path !== '') continue
    // Skip aliased link consumers (the workspace path itself carries edges).

    const nodeSide = ensureSidecar(nodeSidecar, srcId)
    if (entry.inBundle === true) nodeSide.inBundle = true
    if (entry.dev === true) nodeSide.dev = true
    if (entry.optional === true) nodeSide.optional = true
    if (entry.peer === true) nodeSide.peer = true

    const isRoot = path === ''
    const isWorkspaceMember = workspaceByPath.has(path)
    const treatAsManifest = isRoot || isWorkspaceMember

    addDepEdges(builder, edgeRanges, edgeDeclaredNames, path, srcId, entry.dependencies, 'dep', pathToId, diagnostics)
    addDepEdges(builder, edgeRanges, edgeDeclaredNames, path, srcId, entry.optionalDependencies, 'optional', pathToId, diagnostics)

    if (treatAsManifest) {
      addDepEdges(builder, edgeRanges, edgeDeclaredNames, path, srcId, entry.devDependencies, 'dev', pathToId, diagnostics)
    } else if (entry.devDependencies !== undefined) {
      // Inner-block `devDependencies` is unusual but record on sidecar for
      // verbatim re-emit if encountered.
      nodeSide.devDependencies = { ...entry.devDependencies }
    }

    // peerDependencies stashed verbatim on sidecar (no graph peer edges in
    // phase A) so stringify round-trips the on-disk block.
    if (entry.peerDependencies !== undefined) {
      nodeSide.peerDependencies = { ...entry.peerDependencies }
    }
    if (entry.optionalDependencies !== undefined && !treatAsManifest) {
      nodeSide.optionalDependencies = { ...entry.optionalDependencies }
    }

    // Install-path index: every install path that resolves to this NodeId is
    // recorded so stringify can replay the exact layout.
    if (path !== '' && !workspaceByPath.has(path)) {
      nodeSide.installPaths.push(path)
    }
  }

  // Pass 3: root meta (lockfile-level fields we re-emit verbatim).
  const rootMeta: Npm3RootMeta = {
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

  // Sort install paths so emit order is stable across parse/stringify.
  for (const sc of nodeSidecar.values()) {
    sc.installPaths = Array.from(new Set(sc.installPaths)).sort(cmpStr)
  }

  // Top-level `dependencies` mirror under lockfileVersion 3 is an anomaly
  // per ADR-0021 §A.npm-3: drop with a warning.
  if (lf.dependencies !== undefined) {
    diagnostics.push({
      code: 'NPM_V3_UNEXPECTED_LEGACY_MIRROR',
      severity: 'warning',
      message: 'npm-3 lockfile carries a top-level "dependencies" mirror; dropping on parse',
    })
  }

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
    return graph
  } catch (error) {
    if (error instanceof GraphError) {
      throw new LockfileError({
        code: 'PARSE_FAILED',
        message: `npm-3 seal failed: ${error.message}`,
      })
    }
    throw error
  }
}

export function stringify(graph: Graph, options: Npm3StringifyOptions = {}): string {
  const sidecar = sidecarByGraph.get(graph)
  const warnedPeerVirt = new Set<string>()
  const warnedPatches = new Set<string>()
  const emitDiagnostic = (diagnostic: Diagnostic): void => {
    options.onDiagnostic?.(diagnostic)
  }

  // Locate the root: prefer the sidecar (parse-time); else the workspace=''
  // node; else fall back to no root (empty graph).
  const rootNode = locateRootNode(graph, sidecar)
  const rootMeta = sidecar?.rootMeta
  const rootName = rootMeta?.name ?? rootNode?.name ?? ''
  const rootVersion = rootMeta?.version ?? rootNode?.version ?? '0.0.0'

  const packages: Record<string, unknown> = {}

  if (rootNode !== undefined) {
    packages[''] = buildRootEntry(graph, rootNode, rootMeta, sidecar)
  } else if (rootMeta !== undefined) {
    packages[''] = buildSyntheticRootEntry(rootMeta)
  }

  // Workspace member entries + their node_modules/<wsName> link entries.
  const workspaceMembers: Node[] = []
  for (const node of graph.nodes()) {
    if (rootNode !== undefined && node.id === rootNode.id) continue
    warnPatchDrop(node, warnedPatches, emitDiagnostic)
    warnPeerContextFlatten(node, warnedPeerVirt, emitDiagnostic)
    if (node.workspacePath !== undefined && node.workspacePath !== '') {
      workspaceMembers.push(node)
    }
  }
  for (const node of workspaceMembers) {
    packages[node.workspacePath!] = buildWorkspaceMemberEntry(graph, node, sidecar)
    packages[`node_modules/${node.name}`] = {
      resolved: node.workspacePath,
      link: true,
    }
  }

  // node_modules entries: replay sidecar install paths verbatim; flat-emit
  // any nodes that lack a sidecar (post-mutation new nodes).
  for (const node of graph.nodes()) {
    if (rootNode !== undefined && node.id === rootNode.id) continue
    if (node.workspacePath !== undefined) continue

    const nodeSide = sidecar?.nodes.get(node.id)
    const paths = nodeSide?.installPaths.length ? nodeSide.installPaths : [`node_modules/${node.name}`]
    const entry = buildNodeModulesEntry(graph, node, nodeSide, sidecar)
    for (const path of paths) {
      packages[path] = entry
    }
  }

  const out: Record<string, unknown> = {
    name: rootName,
    version: rootVersion,
    lockfileVersion: 3,
    requires: rootMeta?.requires ?? true,
    packages: sortRecord(packages),
  }

  const text = JSON.stringify(out, null, 2) + '\n'
  return options.lineEnding === 'crlf' ? text.replace(/\n/g, '\r\n') : text
}

// §C/§D stubs: out of scope for phase A per the dispatcher's brief. Future
// phases replace these with derivation / pruning implementations. Signature
// matches family-uniform shape per ADR-0021 §5 (graph, options) — sidecar
// threaded through WeakMap registry, not parameter.
export function enrich(
  graph: Graph,
  _options: Npm3EnrichOptions = {},
): { graph: Graph; diagnostics: Diagnostic[] } {
  return { graph, diagnostics: [] }
}

export function optimize(
  graph: Graph,
  _options: Npm3OptimizeOptions = {},
): { graph: Graph; diagnostics: Diagnostic[] } {
  return { graph, diagnostics: [] }
}

// === Helpers ================================================================

function parseJson(input: string): Npm3Lockfile {
  let parsed: unknown
  try {
    parsed = JSON.parse(input)
  } catch (error) {
    throw new LockfileError({
      code: 'FORMAT_MISMATCH',
      message: `npm-3 adapter: input is not valid JSON: ${(error as Error).message}`,
      cause: error,
    })
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new LockfileError({
      code: 'FORMAT_MISMATCH',
      message: `npm-3 adapter: top-level value must be a JSON object`,
    })
  }
  return parsed as Npm3Lockfile
}

function nameFromInstallPath(path: string, entry: Npm3Entry): string {
  // Per ADR-0021 §A.npm-3 *Name-mode* clause #2: an `npm:` alias OR a
  // re-keyed entry that carries body `name` overrides the path-derived name.
  // Plain `node_modules/foo` -> `foo`; scoped `node_modules/@scope/foo` -> that.
  if (entry.name !== undefined && entry.link !== true) {
    return entry.name
  }
  // Path-derived: chop down to the last `node_modules/<tail>` segment.
  // Legacy uses `('/' + path).split('/node_modules/').filter(Boolean)`; we
  // mirror that for the tail extraction.
  const chain = ('/' + path).split('/node_modules/').filter(Boolean)
  const tail = chain[chain.length - 1]
  if (tail === undefined || tail === '') {
    throw parseFailed(`cannot derive name from install path ${JSON.stringify(path)}`)
  }
  return tail
}

function hasTarballPayload(entry: Npm3Entry): boolean {
  return entry.integrity !== undefined
    || entry.engines !== undefined
    || entry.funding !== undefined
    || entry.license !== undefined
    || entry.bin !== undefined
    || entry.deprecated !== undefined
    || entry.cpu !== undefined
    || entry.os !== undefined
    || entry.libc !== undefined
}

function tarballPayloadOf(entry: Npm3Entry): TarballPayload {
  const payload: TarballPayload = {}
  if (entry.integrity !== undefined) payload.integrity = entry.integrity
  if (entry.engines !== undefined) payload.engines = { ...entry.engines }
  if (entry.funding !== undefined) payload.funding = entry.funding
  if (entry.license !== undefined) payload.license = entry.license
  if (entry.bin !== undefined) payload.bin = typeof entry.bin === 'string' ? entry.bin : { ...entry.bin }
  if (entry.deprecated !== undefined) payload.deprecated = entry.deprecated
  if (entry.cpu !== undefined) payload.cpu = entry.cpu.slice()
  if (entry.os !== undefined) payload.os = entry.os.slice()
  if (entry.libc !== undefined) payload.libc = entry.libc.slice()
  return payload
}

function ensureSidecar(map: Map<string, Npm3NodeSidecar>, id: string): Npm3NodeSidecar {
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
    // Skip self-loop dups: builder rejects duplicate edges; if multiple
    // declared names (e.g. `is-git`, `is-github`) target the same NodeId,
    // the first declaration wins and edgeDeclaredNames records it.
    const edgeKey = edgeTripleKey(srcId, kind, dstId)
    if (edgeRanges.has(edgeKey)) continue
    edgeRanges.set(edgeKey, range)
    edgeDeclaredNames.set(edgeKey, name)
    try {
      builder.addEdge(srcId, dstId, kind, { range })
    } catch (error) {
      if (error instanceof GraphError && error.code === 'INVARIANT_VIOLATION') {
        // Duplicate edge across kinds (e.g. same name in both `dependencies`
        // and `optionalDependencies`): silently coalesce; first kind wins.
        continue
      }
      throw error
    }
  }
}

function resolveDepTarget(srcPath: string, name: string, pathToId: Map<string, string>): string | undefined {
  // npm install-time resolution: walk up parents from the source path's
  // install context, try `<parent>/node_modules/<name>` at each level.
  // The legacy parser does this in `getClosestPkg`
  // (legacy/main/ts/formats/npm-3.ts:63-82).
  //
  // Source-path classes (per ADR-0021 §A.npm-3 *Entry key shape*):
  //   - ""                                       -> root manifest
  //   - "node_modules/<a>" / nested              -> npm-installed dep
  //   - "<wsPath>"                               -> workspace member manifest
  //   - "<wsPath>/node_modules/<a>" / nested     -> workspace's nested dep
  //
  // The parent-walk schedule below covers all four. A workspace member at
  // `<wsPath>` first tries `<wsPath>/node_modules/<name>`, then falls back
  // to the hoisted root `node_modules/<name>` (the same algorithm npm uses).

  const candidates: string[] = []

  // Strip a trailing `/node_modules/<tail>` repeatedly to climb the install
  // chain. Each level emits one candidate `<parent>/node_modules/<name>`.
  // For root (srcPath === ""), the only level is the empty prefix.
  let current = srcPath
  while (true) {
    candidates.push(current === '' ? `node_modules/${name}` : `${current}/node_modules/${name}`)
    const idx = current.lastIndexOf('/node_modules/')
    if (idx < 0) break
    current = current.slice(0, idx)
  }
  // After the loop, also probe the bare-root level (`node_modules/<name>`)
  // for workspace-member sources whose path doesn't pass through any
  // `/node_modules/` boundary.
  if (srcPath !== '' && !srcPath.startsWith('node_modules/') && !srcPath.includes('/node_modules/')) {
    candidates.push(`node_modules/${name}`)
  }

  for (const candidate of candidates) {
    const id = pathToId.get(candidate)
    if (id !== undefined) return id
  }
  return undefined
}

function locateRootNode(graph: Graph, sidecar: Npm3Sidecar | undefined): Node | undefined {
  if (sidecar?.rootId !== undefined) {
    const node = graph.getNode(sidecar.rootId)
    if (node !== undefined) return node
  }
  for (const node of graph.nodes()) {
    if (node.workspacePath === '') return node
  }
  // Fall back: any single root in the graph that has no incoming edges.
  const roots = Array.from(graph.roots())
  if (roots.length === 1) {
    const sole = roots[0]
    if (sole !== undefined) return graph.getNode(sole)
  }
  return undefined
}

function buildRootEntry(
  graph: Graph,
  rootNode: Node,
  rootMeta: Npm3RootMeta | undefined,
  sidecar: Npm3Sidecar | undefined,
): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  body.name = rootMeta?.name ?? rootNode.name
  body.version = rootMeta?.version ?? rootNode.version

  const blocks = collectManifestBlocks(graph, rootNode.id, sidecar)
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

function buildSyntheticRootEntry(rootMeta: Npm3RootMeta): Record<string, unknown> {
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
  sidecar: Npm3Sidecar | undefined,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: node.name,
    version: node.version,
  }
  const blocks = collectManifestBlocks(graph, node.id, sidecar)
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
  nodeSide: Npm3NodeSidecar | undefined,
  sidecar: Npm3Sidecar | undefined,
): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  // npm-3 alias entries carry body `name` distinct from path-tail; re-emit
  // `name` only when present in the sidecar paths (path-tail != node.name).
  if (nodeSide !== undefined && nodeSide.installPaths.some(p => installPathTail(p) !== node.name)) {
    body.name = node.name
  }
  body.version = node.version

  const tarball = graph.tarballOf(node.id)
  const resolved = resolutionToResolved(node, tarball)
  if (resolved !== undefined) body.resolved = resolved
  if (tarball?.integrity !== undefined) body.integrity = tarball.integrity
  if (nodeSide?.dev === true) body.dev = true
  if (nodeSide?.optional === true) body.optional = true
  if (nodeSide?.peer === true) body.peer = true
  if (nodeSide?.inBundle === true) body.inBundle = true

  // Inner-block dependencies: combine dep + dev per the spec body-field
  // schedule (npm doesn't carry per-entry dev/optional separately; those
  // flags live at the entry meta level, not the deps block level).
  const blocks = collectManifestBlocks(graph, node.id, sidecar)
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

function installPathTail(path: string): string {
  const chain = ('/' + path).split('/node_modules/').filter(Boolean)
  return chain[chain.length - 1] ?? path
}

function collectManifestBlocks(
  graph: Graph,
  srcId: string,
  sidecar: Npm3Sidecar | undefined,
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
    const range = edge.attrs?.[NPM3_EDGE_RANGE_ATTR]
    if (typeof range !== 'string') continue
    const target = edge.kind === 'dep' ? dep
      : edge.kind === 'dev' ? dev
      : edge.kind === 'peer' ? peer
      : edge.kind === 'optional' ? optional
      : undefined
    if (target === undefined) continue
    const edgeKey = edgeTripleKey(edge.src, edge.kind, edge.dst)
    const declaredName = sidecar?.edgeDeclaredNames.get(edgeKey) ?? dst.name
    target[declaredName] = range
  }
  return {
    dep: sortRecord(dep),
    dev: sortRecord(dev),
    peer: sortRecord(peer),
    optional: sortRecord(optional),
  }
}

function resolutionToResolved(node: Node, _tarball: TarballPayload | undefined): string | undefined {
  // The graph's resolution field is the source-of-truth URL for npm-3 (a
  // tarball URL or a git resolution). Phase A does not re-derive; just
  // pass through.
  return node.resolution
}

function sortRecord<V>(record: Record<string, V>): Record<string, V> {
  const out: Record<string, V> = {}
  for (const key of Object.keys(record).sort(cmpStr)) {
    out[key] = record[key]!
  }
  return out
}


// Per ADR-0021 §A.npm-3 *Body field schedule*: fixed canonical order. Any
// field not present is omitted.
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
  // Any unknown keys (defensively) emitted afterwards in input-string order.
  for (const key of Object.keys(body)) {
    if (!(key in out)) out[key] = body[key]
  }
  return out
}

function warnPeerContextFlatten(
  node: Node,
  warned: Set<string>,
  emitDiagnostic: (diagnostic: Diagnostic) => void,
): void {
  if (node.peerContext.length === 0 || warned.has(node.id)) return
  warned.add(node.id)
  emitDiagnostic({
    code: 'NPM_V3_PEER_VIRT_FLATTENED',
    severity: 'warning',
    subject: node.id,
    message: `peerContext ${JSON.stringify(node.peerContext)} is unsupported in npm-3; flattening on emit`,
  })
}

function warnPatchDrop(
  node: Node,
  warned: Set<string>,
  emitDiagnostic: (diagnostic: Diagnostic) => void,
): void {
  if (node.patch === undefined || warned.has(node.id)) return
  warned.add(node.id)
  emitDiagnostic({
    code: 'NPM_V3_PATCH_DROPPED',
    severity: 'warning',
    subject: node.id,
    message: `patch slot ${JSON.stringify(node.patch)} is unsupported in npm-3; dropping on emit`,
  })
}

function parseFailed(message: string): LockfileError {
  return new LockfileError({ code: 'PARSE_FAILED', message: `npm-3: ${message}` })
}
