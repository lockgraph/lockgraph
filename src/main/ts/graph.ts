// L2 model — see spec/02-graph.md (gitignored locally).
// Public surface follows spec/bindings/ts.md#graph-types.

import { LockfileError } from './errors.ts'
import type { ResolutionCanonical } from './recipe/resolution.ts'
import type { WorkspaceRange } from './recipe/workspace.ts'

export type NodeId = string

/** `${name}@${version}[+patch=…]` — NodeId stripped of peerContext. Per ADR-0010/0011. */
export type TarballKey = string
export type Patch = string
export interface TarballKeyInputs {
  name:    string
  version: string
  patch?:  Patch
}

export type EdgeKind = 'dep' | 'dev' | 'optional' | 'peer' | 'bundled'

export interface Node {
  id:             NodeId
  name:           string
  version:        string
  peerContext:    NodeId[]
  patch?:         Patch
  workspacePath?: string
  resolution?:    string
}

/** Cross-format artefact metadata, shared across peer-virt siblings. Per ADR-0010 + 11-enrich.md. */
export interface TarballPayload {
  integrity?:           string
  engines?:             Record<string, string>
  funding?:             unknown
  license?:             string
  bin?:                 string | Record<string, string>
  deprecated?:          string
  cpu?:                 string[]
  os?:                  string[]
  libc?:                string[]
  bundledDependencies?: string[]
  // ADR-0014 §4.F3 — typed canonical resolution. Distinct from `Node.resolution`
  // (PM-native verbatim string sidecar per ADR-0013): this carrier holds the
  // 5-case discriminated union populated at adapter parse via `recipe/
  // resolution.parse()`. Adapter stringify projects back to PM-native via
  // `recipe/resolution.stringifyFor*`. `Node.resolution` retains its role as
  // verbatim sidecar for same-format round-trip and patch-locator retrieval.
  resolution?:          ResolutionCanonical
}

export type EdgeAttrs = {
  range?:          string
  optional?:       boolean
  workspace?:      boolean
  // ADR-0014 §4.F4 — canonical workspace-specifier pair. Populated by
  // adapters at parse time on edges where `workspace === true`; consumed
  // at stringify time to drive RECIPE_WORKSPACE_* diagnostics.
  workspaceRange?: WorkspaceRange
}

export interface Edge {
  src:    NodeId
  dst:    NodeId
  kind:   EdgeKind
  attrs?: EdgeAttrs
}

export type EdgeTriple = { src: NodeId; dst: NodeId; kind: EdgeKind }

export interface Diagnostic {
  code:     string
  subject?: NodeId | EdgeTriple
  severity: 'info' | 'warning' | 'error'
  message:  string
}

export interface LayoutHints {
  strategy?: 'isolated' | 'hoisted' | 'pnp' | 'nm-linked'
}

export interface WalkOpts {
  direction?: 'out' | 'in'
  kinds?:     EdgeKind[]
  maxDepth?:  number
}

export type ChangeRecord =
  | { kind: 'node-added';            subject: NodeId }
  | { kind: 'node-removed';          subject: NodeId }
  | { kind: 'node-replaced';         subject: NodeId }
  | { kind: 'edge-added';            subject: EdgeTriple }
  | { kind: 'edge-removed';          subject: EdgeTriple }
  | { kind: 'peer-context-replaced'; subject: NodeId }
  | { kind: 'tarball-set';           subject: TarballKey }
  | { kind: 'tarball-removed';       subject: TarballKey }

export interface GraphDiff {
  addedNodes:   NodeId[]
  removedNodes: NodeId[]
  changedNodes: NodeId[]
  addedEdges:   EdgeTriple[]
  removedEdges: EdgeTriple[]
}

export interface MutateResult {
  graph:      Graph
  applied:    ChangeRecord[]
  unresolved: Diagnostic[]
}

export interface Mutator {
  replaceNode(id: NodeId, newNode: Node):                                   void
  addNode(node: Node):                                                      void
  removeNode(id: NodeId):                                                   void
  addEdge(src: NodeId, dst: NodeId, kind: EdgeKind, attrs?: EdgeAttrs):     void
  removeEdge(src: NodeId, dst: NodeId, kind: EdgeKind):                     void
  replacePeerContext(id: NodeId, peers: NodeId[]):                          void
  setTarball(inputs: TarballKeyInputs, payload: TarballPayload):            void
  removeTarball(inputs: TarballKeyInputs):                                  void
  // ADR-0023 §8.6 — write-side diagnostic surface. Appends the supplied
  // Diagnostic to the resulting Graph's diagnostic list; visible via
  // Graph.diagnostics() once the surrounding mutate() call settles.
  // Mirrors Builder.diagnostic so parse-time and modify-time emit paths
  // share one implementation.
  diagnostic(d: Diagnostic):                                                void
}

export interface Graph {
  getNode(id: NodeId):                                  Node | undefined
  nodes():                                              IterableIterator<Node>
  byName(name: string):                                 readonly NodeId[]
  roots():                                              ReadonlySet<NodeId>
  out(id: NodeId, kind?: EdgeKind):                     readonly Edge[]
  in(id: NodeId, kind?: EdgeKind):                      readonly Edge[]
  walk(seeds: NodeId | NodeId[], opts?: WalkOpts):      IterableIterator<NodeId>
  topoSort():                                           readonly (readonly NodeId[])[]
  subgraph(seeds: NodeId | NodeId[], opts?: WalkOpts):  Graph
  diff(other: Graph):                                   GraphDiff
  tarball(inputs: TarballKeyInputs):                    TarballPayload | undefined
  tarballOf(nodeId: NodeId):                            TarballPayload | undefined
  tarballs():                                           IterableIterator<[TarballKey, TarballPayload]>
  diagnostics():                                        readonly Diagnostic[]
  layoutHints():                                        LayoutHints | undefined
  mutate(transaction: (m: Mutator) => void):            MutateResult
}

export interface Builder {
  addNode(node: Node):                                                      void
  addEdge(src: NodeId, dst: NodeId, kind: EdgeKind, attrs?: EdgeAttrs):     void
  setTarball(inputs: TarballKeyInputs, payload: TarballPayload):            void
  diagnostic(d: Diagnostic):                                                void
  layoutHints(h: LayoutHints):                                              void
  seal():                                                                   Graph
}

export class GraphError extends Error {
  readonly code: 'INVARIANT_VIOLATION' | 'PATCH_REJECTED'

  constructor(code: 'INVARIANT_VIOLATION' | 'PATCH_REJECTED', message: string) {
    super(message)
    this.name = 'GraphError'
    this.code = code
  }
}

// === NodeId helpers (per spec/02-graph.md#canonical-nodeid-form, ADR-0006) ===

/** Last `@` at depth 0 separates name from version+peerContext. Scoped names keep their leading `@`. */
export function nameOf(id: NodeId): string {
  let depth = 0
  let lastAt = -1
  for (let i = 0; i < id.length; i++) {
    const c = id[i]
    if (c === '(') depth++
    else if (c === ')') depth--
    else if (c === '@' && depth === 0 && i > 0) lastAt = i
  }
  return lastAt < 0 ? id : id.slice(0, lastAt)
}

/** peerContext is expected pre-sorted alphabetically by name (caller's contract per ADR-0006). */
export function serializeNodeId(
  name: string,
  version: string,
  peerContext: readonly NodeId[],
  patch?: Patch,
): NodeId {
  const base = toTarballKey({ name, version, patch })
  if (peerContext.length === 0) return base
  return base + peerContext.map(p => `(${p})`).join('')
}

function acceptedNodeIds(node: Node): readonly NodeId[] {
  const bare = serializeNodeId(node.name, node.version, node.peerContext)
  if (node.patch === undefined) return [bare]
  const patched = serializeNodeId(node.name, node.version, node.peerContext, node.patch)
  return bare === patched ? [bare] : [bare, patched]
}

function carriesPatchInNodeId(node: Pick<Node, 'id' | 'name' | 'version' | 'patch'>): boolean {
  if (node.patch === undefined) return false
  return stripPeerContextFromNodeId(node.id) === toTarballKey({
    name: node.name,
    version: node.version,
    patch: node.patch,
  })
}

/** Strips peerContext from a NodeId to derive the ADR-0010/0011 base key (`${name}@${version}[+patch=…]`). */
export function stripPeerContextFromNodeId(id: NodeId): TarballKey {
  // Find first depth-0 `(` — that's where peerContext begins. Scoped names are unaffected.
  let depth = 0
  for (let i = 0; i < id.length; i++) {
    const c = id[i]
    if (c === '(' && depth === 0) return id.slice(0, i)
    if (c === '(') depth++
    else if (c === ')') depth--
  }
  return id
}

// Patch-token grammar предикаты owned by `recipe/patch.ts` per ADR-0014
// §4.F2 + ADR-0011 §Decision. graph.ts consumes them — there is no local
// regex shadow here so the token grammar stays single-source.
import { isCanonicalHash, isSentinelPatch as recipeIsSentinelPatch } from './recipe/patch.ts'

export function validatePatchToken(patch: string): void {
  if (patch.length === 0) {
    throw new LockfileError({ code: 'INVALID_INPUT', message: `patch slot must not be empty` })
  }
  if (patch.includes('+')) {
    throw new LockfileError({ code: 'INVALID_INPUT', message: `patch slot must not contain '+'` })
  }
  if (/\s/.test(patch)) {
    throw new LockfileError({ code: 'INVALID_INPUT', message: `patch slot must not contain whitespace` })
  }
  if (!isCanonicalHash(patch) && !recipeIsSentinelPatch(patch)) {
    throw new LockfileError({ code: 'INVALID_INPUT', message: `patch slot has invalid token shape` })
  }
}

function isSentinelPatch(patch: string): boolean {
  return recipeIsSentinelPatch(patch)
}

// ADR-0011:282-304 — sentinel-keyed mutator coherence rule.
//
// A 'sentinel-keyed entry' is a Node whose .patch satisfies the spec-defined
// predicate startsWith('unresolved-'). At the Mutator layer, ANY operation
// that modifies-or-forks the bytes of a sentinel-keyed Node throws
// LockfileError({ code: 'IRREDUCIBLE_LOSS' }). Pure-deletion ops do NOT fork
// siblings (ADR-0011:301-304 explicitly carves out removeTarball; the same
// logic extends to removeNode); they are permitted. Edge-structure ops
// (addEdge, removeEdge) do not touch the Node's bytes; permitted. Builder is
// parse-time and must remain unguarded — that is how sentinels land in the
// graph.
function refuseSentinelMutation(patch: Patch | undefined, opName: string, subject: string): void {
  if (patch !== undefined && isSentinelPatch(patch)) {
    throw new LockfileError({
      code: 'IRREDUCIBLE_LOSS',
      message: `${opName}: sentinel-keyed entries refuse mutation (${subject})`,
    })
  }
}

export function toTarballKey(inputs: TarballKeyInputs): TarballKey {
  const slots: string[] = []
  if (inputs.patch !== undefined) {
    validatePatchToken(inputs.patch)
    slots.push(`patch=${inputs.patch}`)
  }
  return slots.length === 0
    ? `${inputs.name}@${inputs.version}`
    : `${inputs.name}@${inputs.version}+${slots.sort(cmpStr).join('+')}`
}

function tarballKeyInputsOfNode(node: Pick<Node, 'name' | 'version' | 'patch'>): TarballKeyInputs {
  return {
    name: node.name,
    version: node.version,
    patch: node.patch,
  }
}

// === Comparators ===

const cmpStr = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0

const cmpEdgeBy = (end: 'dst' | 'src') => (a: Edge, b: Edge): number => {
  const c = cmpStr(end === 'dst' ? a.dst : a.src, end === 'dst' ? b.dst : b.src)
  return c !== 0 ? c : cmpStr(a.kind, b.kind)
}

// === Internal state ===

interface State {
  nodes:        Map<NodeId, Node>
  outgoing:     Map<NodeId, Edge[]>
  incoming:     Map<NodeId, Edge[]>
  byName:       Map<string, NodeId[]>
  roots:        Set<NodeId>
  tarballs:     Map<TarballKey, TarballPayload>
  diagnostics:  Diagnostic[]
  layoutHints?: LayoutHints
}

function emptyState(): State {
  return {
    nodes:       new Map(),
    outgoing:    new Map(),
    incoming:    new Map(),
    byName:      new Map(),
    roots:       new Set(),
    tarballs:    new Map(),
    diagnostics: [],
  }
}

function shallowClone(s: State): State {
  return {
    nodes:       new Map(s.nodes),
    outgoing:    new Map(Array.from(s.outgoing,    ([k, v]) => [k, v.slice()])),
    incoming:    new Map(Array.from(s.incoming,    ([k, v]) => [k, v.slice()])),
    byName:      new Map(Array.from(s.byName,      ([k, v]) => [k, v.slice()])),
    roots:       new Set(s.roots),
    tarballs:    new Map(s.tarballs),
    diagnostics: s.diagnostics.slice(),
    layoutHints: s.layoutHints,
  }
}

function pushTo<K, V>(m: Map<K, V[]>, k: K, v: V): void {
  const arr = m.get(k)
  if (arr) arr.push(v); else m.set(k, [v])
}

function removeMatching<T>(arr: T[], pred: (x: T) => boolean): boolean {
  const i = arr.findIndex(pred)
  if (i < 0) return false
  arr.splice(i, 1)
  return true
}

const tripleKey = (e: { src: NodeId; dst: NodeId; kind: EdgeKind }): string =>
  `${e.src}\0${e.kind}\0${e.dst}`

/** Re-keys a node from oldId to newId, rebinding every reference. Caller's responsibility to ensure newId not in use. */
function rebindNodeId(s: State, oldId: NodeId, newId: NodeId, newNode: Node): void {
  s.nodes.set(newId, newNode)
  s.nodes.delete(oldId)

  const outs = (s.outgoing.get(oldId) ?? []).map(e => ({ ...e, src: newId }))
  s.outgoing.delete(oldId)
  if (outs.length > 0) s.outgoing.set(newId, outs)
  for (const e of outs) {
    const peerInc = s.incoming.get(e.dst)
    if (peerInc) {
      const idx = peerInc.findIndex(x => x.src === oldId && x.kind === e.kind && x.dst === e.dst)
      if (idx >= 0) peerInc[idx] = e
    }
  }

  const ins = (s.incoming.get(oldId) ?? []).map(e => ({ ...e, dst: newId }))
  s.incoming.delete(oldId)
  if (ins.length > 0) s.incoming.set(newId, ins)
  for (const e of ins) {
    const peerOut = s.outgoing.get(e.src)
    if (peerOut) {
      const idx = peerOut.findIndex(x => x.src === e.src && x.kind === e.kind && x.dst === oldId)
      if (idx >= 0) peerOut[idx] = e
    }
  }
}

// === Validation ===

function validate(s: State): void {
  for (const d of s.diagnostics) {
    if (d.severity === 'error') {
      throw new GraphError('INVARIANT_VIOLATION', `unresolved error diagnostic: ${d.code} — ${d.message}`)
    }
  }

  const seen = new Set<string>()
  for (const [src, edges] of s.outgoing) {
    if (!s.nodes.has(src)) {
      throw new GraphError('INVARIANT_VIOLATION', `edge source missing from node table: ${src}`)
    }
    for (const e of edges) {
      if (!s.nodes.has(e.dst)) {
        throw new GraphError('INVARIANT_VIOLATION', `edge target missing from node table: ${e.src} →${e.kind} ${e.dst}`)
      }
      const k = tripleKey(e)
      if (seen.has(k)) {
        throw new GraphError('INVARIANT_VIOLATION', `duplicate edge: ${e.src} →${e.kind} ${e.dst}`)
      }
      seen.add(k)
    }
  }

  for (const [id, node] of s.nodes) {
    if (node.workspacePath !== undefined) {
      const inc = s.incoming.get(id)
      // Workspace-to-workspace edges are kind-agnostic by design here; the seal only
      // blocks incoming edges sourced from non-workspace nodes.
      const hasNonWorkspaceIncoming = inc?.some(edge => s.nodes.get(edge.src)?.workspacePath === undefined) ?? false
      if (hasNonWorkspaceIncoming) {
        throw new GraphError('INVARIANT_VIOLATION', `workspace node has incoming edges: ${id}`)
      }
    }

    const expected = acceptedNodeIds(node)
    if (!expected.includes(id)) {
      throw new GraphError('INVARIANT_VIOLATION', `node id ${id} disagrees with derived id ${expected.join(' or ')}`)
    }

    const peerEdgeTargets = (s.outgoing.get(id) ?? [])
      .filter(e => e.kind === 'peer')
      .map(e => e.dst)
      .sort()
    const peerCtx = node.peerContext.slice().sort()
    if (peerEdgeTargets.length !== peerCtx.length || peerEdgeTargets.some((t, i) => t !== peerCtx[i])) {
      throw new GraphError('INVARIANT_VIOLATION', `peer edges of ${id} disagree with peerContext`)
    }
  }
}

function reindex(s: State): void {
  s.byName.clear()
  for (const [id, node] of s.nodes) pushTo(s.byName, node.name, id)
  for (const ids of s.byName.values()) ids.sort(cmpStr)

  s.roots.clear()
  for (const id of s.nodes.keys()) {
    const inc = s.incoming.get(id)
    if (!inc || inc.length === 0) s.roots.add(id)
  }

  for (const edges of s.outgoing.values()) edges.sort(cmpEdgeBy('dst'))
  for (const edges of s.incoming.values()) edges.sort(cmpEdgeBy('src'))
}

// === Graph implementation ===

class GraphImpl implements Graph {
  constructor(private readonly s: State) {}

  getNode(id: NodeId): Node | undefined {
    return this.s.nodes.get(id)
  }

  *nodes(): IterableIterator<Node> {
    const ids = Array.from(this.s.nodes.keys()).sort(cmpStr)
    for (const id of ids) {
      const n = this.s.nodes.get(id)
      if (n) yield n
    }
  }

  byName(name: string): readonly NodeId[] {
    return this.s.byName.get(name) ?? []
  }

  roots(): ReadonlySet<NodeId> {
    return this.s.roots
  }

  out(id: NodeId, kind?: EdgeKind): readonly Edge[] {
    const all = this.s.outgoing.get(id) ?? []
    return kind ? all.filter(e => e.kind === kind) : all
  }

  in(id: NodeId, kind?: EdgeKind): readonly Edge[] {
    const all = this.s.incoming.get(id) ?? []
    return kind ? all.filter(e => e.kind === kind) : all
  }

  tarball(inputs: TarballKeyInputs): TarballPayload | undefined {
    return this.s.tarballs.get(toTarballKey(inputs))
  }

  tarballOf(nodeId: NodeId): TarballPayload | undefined {
    const node = this.s.nodes.get(nodeId)
    return node ? this.s.tarballs.get(toTarballKey(tarballKeyInputsOfNode(node))) : undefined
  }

  *tarballs(): IterableIterator<[TarballKey, TarballPayload]> {
    const keys = Array.from(this.s.tarballs.keys()).sort(cmpStr)
    for (const k of keys) {
      const p = this.s.tarballs.get(k)
      if (p) yield [k, p]
    }
  }

  *walk(seeds: NodeId | NodeId[], opts?: WalkOpts): IterableIterator<NodeId> {
    const direction = opts?.direction ?? 'out'
    const kinds     = opts?.kinds
    const maxDepth  = opts?.maxDepth ?? Infinity
    const visited   = new Set<NodeId>()
    const initial   = Array.isArray(seeds) ? seeds : [seeds]
    const stack: Array<{ id: NodeId; depth: number }> = []
    for (let i = initial.length - 1; i >= 0; i--) {
      const seed = initial[i]
      if (seed !== undefined) stack.push({ id: seed, depth: 0 })
    }

    while (stack.length > 0) {
      const top = stack.pop()
      if (!top || visited.has(top.id)) continue
      visited.add(top.id)
      yield top.id
      if (top.depth >= maxDepth) continue

      const edges = (direction === 'out' ? this.s.outgoing : this.s.incoming).get(top.id) ?? []
      const filtered = kinds ? edges.filter(e => kinds.includes(e.kind)) : edges
      for (let i = filtered.length - 1; i >= 0; i--) {
        const e = filtered[i]
        if (!e) continue
        const next = direction === 'out' ? e.dst : e.src
        if (!visited.has(next)) stack.push({ id: next, depth: top.depth + 1 })
      }
    }
  }

  topoSort(): readonly (readonly NodeId[])[] {
    // Tarjan's SCC, iterative to handle deep graphs without stack overflow.
    const indexOf  = new Map<NodeId, number>()
    const lowlink  = new Map<NodeId, number>()
    const onStack  = new Set<NodeId>()
    const ssStack: NodeId[] = []
    const sccs:    NodeId[][] = []
    let next = 0

    const ids = Array.from(this.s.nodes.keys()).sort(cmpStr)

    type Frame = { v: NodeId; iter: number; succ: NodeId[] }

    const visit = (v: NodeId): Frame => {
      indexOf.set(v, next)
      lowlink.set(v, next)
      next++
      ssStack.push(v)
      onStack.add(v)
      const succ = (this.s.outgoing.get(v) ?? []).map(e => e.dst)
      return { v, iter: 0, succ }
    }

    for (const root of ids) {
      if (indexOf.has(root)) continue
      const callStack: Frame[] = [visit(root)]
      while (callStack.length > 0) {
        const frame = callStack[callStack.length - 1]
        if (!frame) break
        if (frame.iter < frame.succ.length) {
          const w = frame.succ[frame.iter++]
          if (w === undefined) continue
          if (!indexOf.has(w)) {
            callStack.push(visit(w))
          } else if (onStack.has(w)) {
            const cur = lowlink.get(frame.v) ?? 0
            const wIdx = indexOf.get(w) ?? 0
            if (wIdx < cur) lowlink.set(frame.v, wIdx)
          }
        } else {
          callStack.pop()
          if (lowlink.get(frame.v) === indexOf.get(frame.v)) {
            const scc: NodeId[] = []
            let w: NodeId | undefined
            do {
              w = ssStack.pop()
              if (w === undefined) break
              onStack.delete(w)
              scc.push(w)
            } while (w !== frame.v)
            scc.sort(cmpStr)
            sccs.push(scc)
          }
          if (callStack.length > 0) {
            const parent = callStack[callStack.length - 1]
            if (parent) {
              const pl = lowlink.get(parent.v) ?? 0
              const cl = lowlink.get(frame.v) ?? 0
              if (cl < pl) lowlink.set(parent.v, cl)
            }
          }
        }
      }
    }

    return sccs.reverse()
  }

  subgraph(seeds: NodeId | NodeId[], opts?: WalkOpts): Graph {
    const reachable = new Set<NodeId>(this.walk(seeds, opts))

    const b = newBuilder()
    for (const id of reachable) {
      const n = this.s.nodes.get(id)
      if (n) b.addNode(n)
    }
    for (const id of reachable) {
      for (const e of this.s.outgoing.get(id) ?? []) {
        if (reachable.has(e.dst)) b.addEdge(e.src, e.dst, e.kind, e.attrs)
      }
    }
    // Propagate tarballs for reachable nodes' keys
    const tarballInputs = new Map<TarballKey, TarballKeyInputs>()
    for (const id of reachable) {
      const node = this.s.nodes.get(id)
      if (!node) continue
      const inputs = tarballKeyInputsOfNode(node)
      tarballInputs.set(toTarballKey(inputs), inputs)
    }
    for (const [k, inputs] of tarballInputs) {
      const p = this.s.tarballs.get(k)
      if (p) b.setTarball(inputs, p)
    }
    if (this.s.layoutHints) b.layoutHints(this.s.layoutHints)
    return b.seal()
  }

  diff(other: Graph): GraphDiff {
    const out: GraphDiff = {
      addedNodes:   [],
      removedNodes: [],
      changedNodes: [],
      addedEdges:   [],
      removedEdges: [],
    }

    const otherIds = new Set<NodeId>()
    for (const n of other.nodes()) otherIds.add(n.id)

    for (const id of this.s.nodes.keys()) {
      if (!otherIds.has(id)) out.removedNodes.push(id)
    }
    for (const n of other.nodes()) {
      const cur = this.s.nodes.get(n.id)
      if (!cur) out.addedNodes.push(n.id)
      else if (!nodeEqual(cur, n)) out.changedNodes.push(n.id)
    }
    out.addedNodes.sort(cmpStr)
    out.removedNodes.sort(cmpStr)
    out.changedNodes.sort(cmpStr)

    const myEdges = new Map<string, Edge>()
    for (const edges of this.s.outgoing.values()) {
      for (const e of edges) myEdges.set(tripleKey(e), e)
    }
    const otherEdges = new Map<string, Edge>()
    for (const n of other.nodes()) {
      for (const e of other.out(n.id)) otherEdges.set(tripleKey(e), e)
    }
    for (const [k, e] of myEdges) {
      if (!otherEdges.has(k)) out.removedEdges.push({ src: e.src, dst: e.dst, kind: e.kind })
    }
    for (const [k, e] of otherEdges) {
      if (!myEdges.has(k)) out.addedEdges.push({ src: e.src, dst: e.dst, kind: e.kind })
    }
    const cmpTriple = (a: EdgeTriple, b: EdgeTriple): number =>
      cmpStr(tripleKey(a), tripleKey(b))
    out.addedEdges.sort(cmpTriple)
    out.removedEdges.sort(cmpTriple)
    return out
  }

  diagnostics(): readonly Diagnostic[] {
    return this.s.diagnostics
  }

  layoutHints(): LayoutHints | undefined {
    return this.s.layoutHints
  }

  mutate(transaction: (m: Mutator) => void): MutateResult {
    const next = shallowClone(this.s)
    const applied: ChangeRecord[] = []

    const m: Mutator = {
      addNode(node) {
        if (node.patch !== undefined) validatePatchToken(node.patch)
        refuseSentinelMutation(node.patch, 'addNode', node.id)
        if (next.nodes.has(node.id)) {
          throw new GraphError('PATCH_REJECTED', `addNode: ${node.id} already exists`)
        }
        next.nodes.set(node.id, node)
        applied.push({ kind: 'node-added', subject: node.id })
      },
      removeNode(id) {
        if (!next.nodes.has(id)) {
          throw new GraphError('PATCH_REJECTED', `removeNode: ${id} missing`)
        }
        const inc = next.incoming.get(id) ?? []
        if (inc.length > 0) {
          throw new GraphError('PATCH_REJECTED', `removeNode: ${id} has incoming edges; remove them first`)
        }
        for (const e of next.outgoing.get(id) ?? []) {
          const peerInc = next.incoming.get(e.dst)
          if (peerInc) removeMatching(peerInc, x => x.src === id && x.kind === e.kind && x.dst === e.dst)
        }
        next.outgoing.delete(id)
        next.incoming.delete(id)
        next.nodes.delete(id)
        applied.push({ kind: 'node-removed', subject: id })
      },
      replaceNode(id, newNode) {
        if (newNode.patch !== undefined) validatePatchToken(newNode.patch)
        const existing = next.nodes.get(id)
        if (existing) refuseSentinelMutation(existing.patch, 'replaceNode', id)
        refuseSentinelMutation(newNode.patch, 'replaceNode', newNode.id)
        if (!existing) {
          throw new GraphError('PATCH_REJECTED', `replaceNode: ${id} missing`)
        }
        if (newNode.id === id) {
          next.nodes.set(id, newNode)
        } else {
          if (next.nodes.has(newNode.id)) {
            throw new GraphError('PATCH_REJECTED', `replaceNode: target id ${newNode.id} already exists`)
          }
          rebindNodeId(next, id, newNode.id, newNode)
        }
        applied.push({ kind: 'node-replaced', subject: newNode.id })
      },
      addEdge(src, dst, kind, attrs) {
        if (!next.nodes.has(src)) throw new GraphError('PATCH_REJECTED', `addEdge: src ${src} missing`)
        if (!next.nodes.has(dst)) throw new GraphError('PATCH_REJECTED', `addEdge: dst ${dst} missing`)
        const existing = next.outgoing.get(src) ?? []
        if (existing.some(e => e.dst === dst && e.kind === kind)) {
          throw new GraphError('PATCH_REJECTED', `addEdge: duplicate ${src} →${kind} ${dst}`)
        }
        const e: Edge = attrs ? { src, dst, kind, attrs } : { src, dst, kind }
        pushTo(next.outgoing, src, e)
        pushTo(next.incoming, dst, e)
        applied.push({ kind: 'edge-added', subject: { src, dst, kind } })
      },
      removeEdge(src, dst, kind) {
        const outs = next.outgoing.get(src)
        if (!outs || !removeMatching(outs, e => e.dst === dst && e.kind === kind)) {
          throw new GraphError('PATCH_REJECTED', `removeEdge: ${src} →${kind} ${dst} missing`)
        }
        const ins = next.incoming.get(dst)
        if (ins) removeMatching(ins, e => e.src === src && e.kind === kind)
        applied.push({ kind: 'edge-removed', subject: { src, dst, kind } })
      },
      replacePeerContext(id, peers) {
        const old = next.nodes.get(id)
        if (!old) throw new GraphError('PATCH_REJECTED', `replacePeerContext: ${id} missing`)
        refuseSentinelMutation(old.patch, 'replacePeerContext', id)
        for (const p of peers) {
          if (!next.nodes.has(p)) throw new GraphError('PATCH_REJECTED', `replacePeerContext: peer ${p} missing`)
        }

        const newId = carriesPatchInNodeId(old)
          ? serializeNodeId(old.name, old.version, peers, old.patch)
          : serializeNodeId(old.name, old.version, peers)
        if (newId !== id && next.nodes.has(newId)) {
          throw new GraphError('PATCH_REJECTED', `replacePeerContext: target id ${newId} already exists`)
        }

        const outs = next.outgoing.get(id) ?? []
        for (const e of outs.filter(e => e.kind === 'peer')) {
          const peerInc = next.incoming.get(e.dst)
          if (peerInc) removeMatching(peerInc, x => x.src === id && x.dst === e.dst && x.kind === 'peer')
        }
        next.outgoing.set(id, outs.filter(e => e.kind !== 'peer'))

        const newNode: Node = { ...old, id: newId, peerContext: peers.slice() }
        if (newId === id) {
          next.nodes.set(id, newNode)
        } else {
          rebindNodeId(next, id, newId, newNode)
        }

        for (const p of peers) {
          const e: Edge = { src: newId, dst: p, kind: 'peer' }
          pushTo(next.outgoing, newId, e)
          pushTo(next.incoming, p, e)
        }

        applied.push({ kind: 'peer-context-replaced', subject: newId })
      },
      setTarball(inputs, payload) {
        const key = toTarballKey(inputs)
        refuseSentinelMutation(inputs.patch, 'setTarball', `${inputs.name}@${inputs.version}`)
        next.tarballs.set(key, payload)
        applied.push({ kind: 'tarball-set', subject: key })
      },
      removeTarball(inputs) {
        const key = toTarballKey(inputs)
        if (!next.tarballs.delete(key)) {
          throw new GraphError('PATCH_REJECTED', `removeTarball: ${key} missing`)
        }
        applied.push({ kind: 'tarball-removed', subject: key })
      },
      // ADR-0023 §8.6 — write-side diagnostic emit. Append to the staged
      // diagnostics list; the resulting Graph.diagnostics() surfaces it
      // once mutate() settles. Same append semantics as Builder.diagnostic.
      diagnostic(d) {
        next.diagnostics.push(d)
      },
    }

    transaction(m)

    validate(next)
    reindex(next)

    return {
      graph:      new GraphImpl(next),
      applied,
      unresolved: next.diagnostics.filter(d => d.severity === 'warning'),
    }
  }
}

function nodeEqual(a: Node, b: Node): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

// === Builder ===

export function newBuilder(): Builder {
  const s = emptyState()
  let sealed = false

  const guard = (op: string): void => {
    if (sealed) throw new GraphError('INVARIANT_VIOLATION', `builder ${op} after seal`)
  }

  return {
    addNode(node) {
      guard('addNode')
      if (node.patch !== undefined) validatePatchToken(node.patch)
      if (s.nodes.has(node.id)) {
        throw new GraphError('INVARIANT_VIOLATION', `duplicate node id: ${node.id}`)
      }
      s.nodes.set(node.id, node)
    },
    addEdge(src, dst, kind, attrs) {
      guard('addEdge')
      const e: Edge = attrs ? { src, dst, kind, attrs } : { src, dst, kind }
      pushTo(s.outgoing, src, e)
      pushTo(s.incoming, dst, e)
    },
    setTarball(inputs, payload) {
      guard('setTarball')
      const key = toTarballKey(inputs)
      s.tarballs.set(key, payload)
    },
    diagnostic(d) {
      guard('diagnostic')
      s.diagnostics.push(d)
    },
    layoutHints(h) {
      guard('layoutHints')
      s.layoutHints = h
    },
    seal() {
      guard('seal')
      sealed = true
      validate(s)
      reindex(s)
      return new GraphImpl(s)
    },
  }
}
