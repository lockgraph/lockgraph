// bun-text adapter — bun `bun.lock` text lockfile (lockfileVersion 1).
//
// Standalone-fit per yarn-classic / npm-1 / pnpm-v5 precedent. bun-text's
// schema (JSON-with-trailing-commas; positional `[id, "", inner, integrity]`
// tuples под `packages`; declarative `workspaces` map) is unique и does not
// share a flat-shape core с npm-flat or pnpm-flat. Reuses only
// shape-compatible micro-utilities (cmpStr / sortRecord) из `_npm-flat-types`.
//
// §A pinning (see spec/formats/bun-text.md):
//   - top-level numeric `lockfileVersion: 1`; `workspaces` + `packages` blocks.
//   - JSONC subset: trailing commas + comments. Stripped pre-`JSON.parse`,
//     replayed по emit.
//   - `packages` values: `[<id>, "", <inner?>, "<integrity>"]` (len 4) for
//     regular packages, `[<name>@workspace:<path>]` (len 1) for workspace refs.
//
// §B Lossy-but-acceptable:
//   - `BUN_TEXT_PATCH_DROPPED` — bun cannot encode patches; drop on emit.
//   - `BUN_TEXT_PEER_VIRT_FLATTENED` — bun's peer-deps are declarative;
//     peer-virt NodeIds (`<id>(<peer>@<v>)`) flatten on emit.
//
// §C enrich: workspace concretisation from manifests. peer-virt structurally
// absent (declarative peer-deps live в the inner-block).
// §D optimize: prune unreachable from `graph.roots()` BFS (ADR-0016 §D).

import {
  GraphError,
  newBuilder,
  toTarballKey,
  type Diagnostic,
  type Edge,
  type EdgeKind,
  type Graph,
  type Node,
  type TarballKeyInputs,
} from '../graph.ts'
import { LockfileError } from '../errors.ts'
import { cmpStr, sortRecord } from './_npm-flat-types.ts'

// === Public option types ====================================================

export interface BunTextParseOptions {}

export interface BunTextStringifyOptions {
  lineEnding?: 'lf' | 'crlf'
  onDiagnostic?: (diagnostic: Diagnostic) => void
}

export interface BunTextManifest {
  name?: string
  version?: string
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}

export interface BunTextEnrichOptions {
  manifests?: Record<string, BunTextManifest>
}

export interface BunTextOptimizeOptions {}

// === Schema types ===========================================================

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
  workspaces?: Record<string, BunTextWorkspaceManifest>
  packages?: Record<string, unknown[]>
  trustedDependencies?: string[]
  patchedDependencies?: Record<string, string>
  overrides?: Record<string, string>
  [key: string]: unknown
}

// === Sidecar ================================================================

interface BunTextNodeSidecar {
  inner?: BunTextInner
  packagesKey?: string
}

interface BunTextWorkspaceSidecar {
  path: string
  manifest: BunTextWorkspaceManifest
}

interface BunTextSidecar {
  rootId?: string
  rootManifest?: BunTextWorkspaceManifest
  workspaces: Map<string, BunTextWorkspaceSidecar>
  /** workspacePath -> NodeId (members + root). */
  workspaceByPath: Map<string, string>
  /** NodeId -> { inner, packagesKey } from parse-time `packages` block. */
  nodes: Map<string, BunTextNodeSidecar>
  /** declared peer ranges keyed by `<srcId>|<peerName>`. */
  peerDeclarations: Map<string, string>
}

const sidecarByGraph = new WeakMap<Graph, BunTextSidecar>()

function rememberSidecar(graph: Graph, sidecar: BunTextSidecar): void {
  sidecarByGraph.set(graph, sidecar)
}

// === Public API: check / parse / stringify / enrich / optimize =============

export function check(input: string): boolean {
  // bun-text discriminant: `lockfileVersion: 1` numeric literal AND both
  // `workspaces` + `packages` blocks present. Distinguishes от npm-1 (which
  // carries `dependencies` instead и has no `workspaces` block) и от
  // npm-2/npm-3 (whose `lockfileVersion` is 2 or 3).
  if (!/"lockfileVersion"\s*:\s*1\b/.test(input)) return false
  if (!/"workspaces"\s*:\s*\{/.test(input)) return false
  if (!/"packages"\s*:\s*\{/.test(input)) return false
  return true
}

export function parse(input: string, _options: BunTextParseOptions = {}): Graph {
  const normalized = normalizeLineEndings(input)
  const lf = parseJsonc(normalized)

  if (lf.lockfileVersion !== 1) {
    throw new LockfileError({
      code: 'FORMAT_MISMATCH',
      message: `bun-text adapter: expected lockfileVersion 1, got ${JSON.stringify(lf.lockfileVersion)}`,
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

  // === Pass 1: register all packages entries as graph nodes ================
  //
  // bun-text `packages` map keys могут carry slash segments for hoisting
  // conflicts (`<consumer-path>/<dep-name>` form). We split на the last
  // `/` для name extraction где the leaf segment is the actual package name.
  // The id pulled из tuple slot [0] is the canonical `<name>@<version>` (или
  // workspace-form `<name>@workspace:<path>`).

  const packages = lf.packages as Record<string, unknown[]>
  const seenNodeIds = new Set<string>([rootId])
  const entriesByKey = new Map<string, { id: string; inner?: BunTextInner; integrity?: string }>()

  for (const [packagesKey, raw] of Object.entries(packages)) {
    if (!Array.isArray(raw) || raw.length === 0) {
      diagnostics.push({
        code: 'BUN_TEXT_BAD_ENTRY',
        severity: 'warning',
        message: `bun-text entry ${JSON.stringify(packagesKey)} is not a positional tuple; skipping`,
      })
      continue
    }
    const idToken = raw[0]
    if (typeof idToken !== 'string') {
      diagnostics.push({
        code: 'BUN_TEXT_BAD_ENTRY',
        severity: 'warning',
        message: `bun-text entry ${JSON.stringify(packagesKey)} missing id token`,
      })
      continue
    }

    if (raw.length === 1) {
      // Workspace member reference: `[<name>@workspace:<path>]`.
      const parsed = parseWorkspaceRef(idToken)
      if (parsed === undefined) {
        diagnostics.push({
          code: 'BUN_TEXT_BAD_ENTRY',
          severity: 'warning',
          message: `bun-text workspace-ref ${JSON.stringify(idToken)} unparseable; skipping`,
        })
        continue
      }
      const wsManifest = workspaces[parsed.path]
      const wsVersion = wsManifest?.version ?? '0.0.0'
      const wsId = `${parsed.name}@${wsVersion}`
      if (!seenNodeIds.has(wsId)) {
        seenNodeIds.add(wsId)
        builder.addNode({
          id: wsId,
          name: parsed.name,
          version: wsVersion,
          peerContext: [],
          workspacePath: parsed.path,
        })
      }
      workspaceByPath.set(parsed.path, wsId)
      if (wsManifest !== undefined) {
        workspaceSidecar.set(parsed.path, { path: parsed.path, manifest: wsManifest })
      }
      nodeSidecar.set(wsId, { packagesKey })
      entriesByKey.set(packagesKey, { id: wsId })
      continue
    }

    // Regular package: `[id, "", inner, integrity]`.
    const parsed = parsePackageId(idToken)
    if (parsed === undefined) {
      diagnostics.push({
        code: 'BUN_TEXT_BAD_ENTRY',
        severity: 'warning',
        message: `bun-text id ${JSON.stringify(idToken)} unparseable; skipping`,
      })
      continue
    }
    const { name, version } = parsed
    const nodeId = `${name}@${version}`
    const inner = (raw.length >= 3 && raw[2] !== null && typeof raw[2] === 'object' && !Array.isArray(raw[2]))
      ? raw[2] as BunTextInner
      : undefined
    const integrity = raw.length >= 4 && typeof raw[3] === 'string' && raw[3].length > 0
      ? raw[3] as string
      : undefined

    if (!seenNodeIds.has(nodeId)) {
      seenNodeIds.add(nodeId)
      builder.addNode({
        id: nodeId,
        name,
        version,
        peerContext: [],
      })
      if (integrity !== undefined) {
        builder.setTarball({ name, version }, { integrity })
      }
    }
    nodeSidecar.set(nodeId, { inner, packagesKey })
    entriesByKey.set(packagesKey, { id: nodeId, inner, integrity })
  }

  // Pre-register workspace members declared in the `workspaces` map even
  // when they don't appear in `packages` (rare; bun emits both, но if a
  // member has no installed deps the packages-side entry is still emitted).
  for (const [path, manifest] of Object.entries(workspaces)) {
    if (path === '') continue
    if (workspaceByPath.has(path)) continue
    if (manifest === null || typeof manifest !== 'object') continue
    const memberName = manifest.name
    if (typeof memberName !== 'string' || memberName.length === 0) continue
    const memberVersion = manifest.version ?? '0.0.0'
    const memberId = `${memberName}@${memberVersion}`
    if (!seenNodeIds.has(memberId)) {
      seenNodeIds.add(memberId)
      builder.addNode({
        id: memberId,
        name: memberName,
        version: memberVersion,
        peerContext: [],
        workspacePath: path,
      })
    }
    workspaceByPath.set(path, memberId)
    workspaceSidecar.set(path, { path, manifest })
  }

  // Pass 2: emit workspace-manifest edges. workspace-protocol ranges resolve
  // через `workspaceByPath` (member name lookup); plain ranges resolve через
  // the flat package index.
  const packageByName = buildPackageByName(packages)

  for (const [path, ws] of workspaceSidecar) {
    const srcId = workspaceByPath.get(path)
    if (srcId === undefined) continue
    addBlockEdges(builder, diagnostics, srcId, ws.manifest, packageByName, workspaceByPath, peerDeclarations)
  }

  // Pass 3: emit packages inner-block edges. Resolution uses a per-consumer
  // scoped index, since bun de-hoists conflicting entries под `<consumer>/<dep>`
  // packages keys и those shadow the flat lookup for that consumer.
  for (const [packagesKey, entry] of entriesByKey) {
    if (entry.inner === undefined) continue
    const consumerScope = buildConsumerScope(packagesKey, packages, packageByName)
    addBlockEdges(builder, diagnostics, entry.id, entry.inner, consumerScope, undefined, peerDeclarations)
  }

  for (const diagnostic of diagnostics) {
    builder.diagnostic(diagnostic)
  }

  try {
    const graph = builder.seal()
    const sidecar: BunTextSidecar = {
      rootId,
      rootManifest,
      workspaces: workspaceSidecar,
      workspaceByPath,
      nodes: nodeSidecar,
      peerDeclarations,
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

export function stringify(graph: Graph, options: BunTextStringifyOptions = {}): string {
  const sidecar = sidecarByGraph.get(graph)
  const emitDiagnostic = (diagnostic: Diagnostic): void => options.onDiagnostic?.(diagnostic)

  const warnedPatches = new Set<string>()
  const warnedPeerVirt = new Set<string>()

  const rootNode = locateRootNode(graph, sidecar)
  const memberNodes = Array.from(graph.nodes())
    .filter(n => n.workspacePath !== undefined && n.workspacePath !== '')
    .sort((a, b) => cmpStr(a.workspacePath!, b.workspacePath!))

  // Build `workspaces` block: root + members.
  const workspacesBlock: Record<string, BunTextWorkspaceManifest> = {
    '': buildWorkspaceManifest(graph, rootNode, sidecar?.workspaces.get('')?.manifest),
  }
  for (const member of memberNodes) {
    const path = member.workspacePath!
    workspacesBlock[path] = buildWorkspaceManifest(graph, member, sidecar?.workspaces.get(path)?.manifest)
  }

  // Build `packages` block: workspace members (1-elem tuples) then regular packages
  // (4-elem tuples), both sorted alphabetically by emit key.
  const packagesBlock: Record<string, unknown[]> = {}
  for (const member of [...memberNodes].sort((a, b) => cmpStr(a.name, b.name))) {
    packagesBlock[member.name] = [`${member.name}@workspace:${member.workspacePath}`]
  }
  const regularNodes = Array.from(graph.nodes())
    .filter(n => n.id !== rootNode?.id && n.workspacePath === undefined)
    .sort((a, b) => cmpStr(a.name, b.name) || cmpStr(a.version, b.version))
  for (const node of regularNodes) {
    warnPatchDrop(node, warnedPatches, emitDiagnostic)
    warnPeerVirt(node, warnedPeerVirt, emitDiagnostic)

    const inner = buildInnerBlock(graph, node, sidecar)
    const integrity = graph.tarballOf(node.id)?.integrity ?? ''
    const key = chooseNodeEmitKey(node, sidecar, packagesBlock)
    packagesBlock[key] = [`${node.name}@${node.version}`, '', inner, integrity]
  }

  const json = renderJsonc({
    lockfileVersion: 1,
    workspaces: workspacesBlock,
    packages: packagesBlock,
  })
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
    // already carries member tagging из parse. Return graph as-is.
    return { graph, diagnostics }
  }

  // Manifest-driven workspace concretisation: synthesise workspace member nodes
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

  if (sidecar !== undefined) rememberSidecar(result.graph, sidecar)
  return { graph: result.graph, diagnostics }
}

export function optimize(
  graph: Graph,
  _options: BunTextOptimizeOptions = {},
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
      if (!referencedTarballs.has(key) && graph.tarball(inputs) !== undefined) {
        m.removeTarball(inputs)
      }
    }
  })

  if (sidecar !== undefined) {
    rememberSidecar(result.graph, pruneSidecar(sidecar, result.graph))
  }
  return { graph: result.graph, diagnostics: result.unresolved }
}

// === Helpers: JSONC parser + emitter =======================================

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
  // commas before `}` / `]`. Strings и escape sequences are honored so we
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
    // Trailing comma: `,` followed by whitespace + (`}` или `]`).
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

// JSONC emitter с trailing commas on every `}` and `]` (one space leading,
// matching bun's exact emit style; verified against the 7 fixtures).
//
// Pretty-print algorithm: standard 2-space indent for objects; arrays
// always emit inline (tuple slot mode) because bun-text's tuple-form
// packages entries are single-line.
function renderJsonc(value: unknown): string {
  return renderValue(value, 0, true) + '\n'
}

const INDENT = '  '

function renderValue(value: unknown, depth: number, isTopLevel: boolean): string {
  if (Array.isArray(value)) return renderArray(value)
  if (value !== null && typeof value === 'object') return renderObject(value as Record<string, unknown>, depth, isTopLevel)
  return renderInlineValue(value)
}

function renderArray(arr: unknown[]): string {
  // Arrays in bun-text are always positional tuples (1-elem for workspace refs,
  // 4-elem for regular packages) — both short и single-line.
  return `[${arr.map(renderInlineValue).join(', ')}]`
}

function renderInlineValue(value: unknown): string {
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

function renderInlineObject(obj: Record<string, unknown>): string {
  const keys = Object.keys(obj)
  if (keys.length === 0) return '{}'
  const parts = keys.map(k => `${JSON.stringify(k)}: ${renderInlineValue(obj[k])}`)
  return `{ ${parts.join(', ')} }`
}

function renderObject(obj: Record<string, unknown>, depth: number, isTopLevel: boolean): string {
  const keys = Object.keys(obj)
  if (keys.length === 0) return '{}'
  const indent = INDENT.repeat(depth + 1)
  const closeIndent = INDENT.repeat(depth)
  const lines: string[] = ['{']
  // Walk keys. Each entry indented to depth+1. Trailing commas after every
  // value (bun-text always-trailing-comma style); the outer-most object emits
  // no trailing comma on its last entry to match the fixture shape.
  for (const key of keys) {
    const val = obj[key]
    const rendered = Array.isArray(val)
      ? renderArray(val)
      : (val !== null && typeof val === 'object'
        ? renderObject(val as Record<string, unknown>, depth + 1, false)
        : renderInlineValue(val))
    lines.push(`${indent}${JSON.stringify(key)}: ${rendered},`)
  }
  if (isTopLevel) {
    const last = lines.pop()!
    lines.push(last.replace(/,$/, ''))
  }
  lines.push(`${closeIndent}}`)
  return lines.join('\n')
}

// === Helpers: parsing ======================================================

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
// only; workspace refs resolve через `workspaceByPath`). Scoped names (`@foo/bar`)
// are top-level keys c a single `/` and a leading `@`; de-hoisted entries
// (`<consumer>/<dep>`) carry a `/` без the leading `@` и are SKIPPED here —
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
  // Returns a name -> NodeId map с de-hoisted overrides applied.
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

interface BunTextDepBlocks {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}

// Adds dep / dev / optional / peer edges из a block-bearing source (workspace
// manifest или inner-block of a packages entry). For source = 'manifest',
// workspace-protocol ranges resolve через `workspaceByPath`; otherwise we
// rely on the pre-scoped `byName` map. Peer ranges are stashed declaratively
// — bun encodes peers as data, not graph edges (ADR-0006 / §C enrich).
function addBlockEdges(
  builder: ReturnType<typeof newBuilder>,
  diagnostics: Diagnostic[],
  srcId: string,
  blocks: BunTextDepBlocks,
  byName: Map<string, string>,
  workspaceByPath: Map<string, string> | undefined,
  peerDeclarations: Map<string, string>,
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
        })
        continue
      }
      const attrs: { range: string; workspace?: boolean } = { range }
      if (isWorkspaceProtocolRange(range)) attrs.workspace = true
      try {
        builder.addEdge(srcId, dstId, kind, attrs)
      } catch (error) {
        if (error instanceof GraphError && error.code === 'INVARIANT_VIOLATION') continue
        throw error
      }
    }
  }
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

// === Helpers: stringify side ===============================================

function locateRootNode(graph: Graph, sidecar: BunTextSidecar | undefined): Node | undefined {
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

function buildWorkspaceManifest(
  graph: Graph,
  workspaceNode: Node | undefined,
  sidecarManifest: BunTextWorkspaceManifest | undefined,
): BunTextWorkspaceManifest {
  // Workspace manifest emitted к the `workspaces` block. Pulls structural data
  // из the graph (edges out of the workspace node) and falls back к sidecar
  // for the name / version pin.
  const out: BunTextWorkspaceManifest = {}
  if (workspaceNode !== undefined) {
    out.name = workspaceNode.name
    if (workspaceNode.workspacePath !== '') {
      out.version = workspaceNode.version
    }
  } else if (sidecarManifest !== undefined) {
    if (sidecarManifest.name !== undefined) out.name = sidecarManifest.name
    if (sidecarManifest.version !== undefined) out.version = sidecarManifest.version
  }

  // Walk dep / dev / optional / peer edges и emit ranges.
  if (workspaceNode !== undefined) {
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
      target[dst.name] = range
    }
    if (Object.keys(dependencies).length > 0) out.dependencies = sortRecord(dependencies)
    if (Object.keys(devDependencies).length > 0) out.devDependencies = sortRecord(devDependencies)
    if (Object.keys(optionalDependencies).length > 0) out.optionalDependencies = sortRecord(optionalDependencies)
    if (Object.keys(peerDependencies).length > 0) out.peerDependencies = sortRecord(peerDependencies)
  } else if (sidecarManifest !== undefined) {
    if (sidecarManifest.dependencies !== undefined) out.dependencies = sortRecord(sidecarManifest.dependencies)
    if (sidecarManifest.devDependencies !== undefined) out.devDependencies = sortRecord(sidecarManifest.devDependencies)
    if (sidecarManifest.optionalDependencies !== undefined) out.optionalDependencies = sortRecord(sidecarManifest.optionalDependencies)
    if (sidecarManifest.peerDependencies !== undefined) out.peerDependencies = sortRecord(sidecarManifest.peerDependencies)
  }

  return out
}

function buildInnerBlock(graph: Graph, node: Node, sidecar: BunTextSidecar | undefined): BunTextInner {
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
    if (target !== undefined) target[dst.name] = range
  }
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

function chooseNodeEmitKey(
  node: Node,
  sidecar: BunTextSidecar | undefined,
  alreadyEmitted: Record<string, unknown>,
): string {
  // Preserve the parse-time packagesKey (which may carry the de-hoisting
  // `<consumer-path>/<name>` form) when available и not yet taken.
  const stored = sidecar?.nodes.get(node.id)?.packagesKey
  if (stored !== undefined && alreadyEmitted[stored] === undefined) {
    return stored
  }
  // Fallback: bare name. If the bare key is already taken (different version
  // of the same name), append `@<version>` as a disambiguator. The disambiguated
  // form is admittedly non-canonical, но bun's de-hoisting layer outside this
  // adapter's reach — mutator-added duplicates fall back here.
  if (alreadyEmitted[node.name] === undefined) return node.name
  return `${node.name}@${node.version}`
}

function warnPatchDrop(
  node: Node,
  warned: Set<string>,
  emitDiagnostic: (diagnostic: Diagnostic) => void,
): void {
  if (node.patch === undefined || warned.has(node.id)) return
  warned.add(node.id)
  emitDiagnostic({
    code: 'BUN_TEXT_PATCH_DROPPED',
    severity: 'warning',
    subject: node.id,
    message: `patch slot ${JSON.stringify(node.patch)} is unsupported in bun-text; dropping on emit`,
  })
}

function warnPeerVirt(
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
  }
}
