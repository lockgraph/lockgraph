// L2 model — see spec/02-graph.md (gitignored locally).
// Public surface follows spec/bindings/ts.md#graph-types.

import { LockfileError } from './api/errors.ts'
import { inheritMutationLineage } from './api/mutation-lineage.ts'
import type { Integrity } from './recipe/integrity.ts'
import type { ResolutionCanonical } from './recipe/resolution.ts'
import type { WorkspaceRange } from './recipe/workspace.ts'

// === TYPES ==================================================================

export type NodeId = string

/** `${name}@${version}[+patch=…][+src=…]` — NodeId stripped of peerContext. Per ADR-0010/0011/0032. */
export type TarballKey = string
export type Patch = string
/** ADR-0032 — the `+src=` slot value: 16 lowercase-hex chars (sha256 prefix of
 *  the F3-canonical source string), or `undefined` for the bare default-registry
 *  / directory majority. Derived by `recipe/resolution.sourceDiscriminatorOf`. */
export type SourceDiscriminator = string
export interface TarballKeyInputs {
  name:    string
  version: string
  patch?:  Patch
  // ADR-0032 — discriminates NON-REGISTRY sources that share `name@version`
  // (a registry copy vs a git fork). Sorts AFTER `patch=` in the slot list.
  // `undefined` for the registry-tarball / directory majority → BARE key
  // (zero registry blast radius).
  source?: SourceDiscriminator
}

export type EdgeKind = 'dep' | 'dev' | 'optional' | 'peer' | 'bundled'

export interface Node {
  id:             NodeId
  name:           string
  version:        string
  peerContext:    NodeId[]
  patch?:         Patch
  // ADR-0032 — the `+src=` slot carrier. The 16-hex source discriminator for a
  // NON-REGISTRY node (git / non-registry-host tarball / unknown), so the node's
  // identity is re-derivable from the Node alone at seal time (parallels how
  // `patch` carries the `+patch=` slot). `undefined` for the bare registry /
  // directory majority — those NodeIds are byte-identical to the pre-ADR-0032
  // form. Populated by `recipe/resolution.sourceDiscriminatorOf(node's
  // ResolutionCanonical)` at construction.
  source?:        SourceDiscriminator
  workspacePath?: string
}

/** Cross-format artefact metadata, shared across peer-virt siblings. Per ADR-0010 + 11-enrich.md. */
export interface TarballPayload {
  // ADR-0031 — multi-hash carrier tagged by origin. `undefined` iff no hash is
  // known (kept undefined-when-empty so presence checks stay a plain
  // `!== undefined`). A tarball digest (`origin !== 'berry-zip'`) and a
  // yarn-berry zip-cache digest (`origin === 'berry-zip'`) are NOT
  // interchangeable; emit is origin-aware (see recipe/integrity.ts).
  integrity?:           Integrity
  // ADR-0031 round-trip sidecar — the `<cacheKey>` prefix of a yarn-berry
  // `checksum: <cacheKey>/<hex>` captured verbatim at parse, so emit can
  // reproduce it byte-for-byte for EVERY berry generation (yarn-2.0 v4 `2/`,
  // v8/v9 `10c0/`). Per-node because a single lock may legitimately mix
  // prefixed and bare entries; absence means the source checksum was bare
  // (the cacheKey lives only inside the digest, never in an SRI).
  berryChecksumCacheKey?: string
  engines?:             Record<string, string>
  funding?:             unknown
  license?:             string
  bin?:                 string | Record<string, string>
  deprecated?:          string
  cpu?:                 string[]
  os?:                  string[]
  libc?:                string[]
  // npm computes `hasInstallScript: true` for a package with install/preinstall/
  // postinstall scripts. Carried verbatim so an npm round-trip re-emits it and a
  // mutable `npm install` does not re-add it (byte-identity). Manifest-derived,
  // like `funding`/`deprecated`; non-npm emitters ignore it.
  hasInstallScript?:    boolean
  bundledDependencies?: string[]
  // Declared peer requirements from the package manifest (ADR-0023 §4.2). Carried
  // on the payload so a COMPLETION-added yarn-berry node can re-emit its
  // `peerDependencies:` / `peerDependenciesMeta:` blocks: completion cannot wire a
  // `peer` EDGE for an unresolved/optional peer (there is no target node in the
  // graph), and a minted node has no parse sidecar, so without this the berry emit
  // drops both blocks and `yarn install --immutable` re-adds them (YN0028). Parsed
  // berry nodes round-trip via the berry sidecar instead; non-yarn emitters ignore these.
  peerDependencies?:     Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
  // ADR-0014 §4.F3 — typed canonical resolution. Distinct from
  // `nativeResolution` (PM-native verbatim string sidecar per ADR-0013): this
  // carrier holds the 4-case discriminated union (tarball | git | directory |
  // unknown) populated at adapter parse via `recipe/resolution.parse()`.
  // Adapter stringify projects back to PM-native via `recipe/resolution.stringifyFor*`.
  resolution?:          ResolutionCanonical
  // ADR-0013 — PM-native verbatim resolution string sidecar. Captured at
  // adapter parse verbatim (e.g. yarn-classic `resolved`, npm `resolved`,
  // yarn-berry/pnpm resolution locators) and replayed at same-format stringify
  // for byte-exact round-trip + patch/file/link-locator retrieval. Per-tarball
  // (NOT node identity — it is invariant across peer-virtual siblings sharing a
  // TarballKey): yarn-berry siblings copy the base locator, pnpm sources it from
  // the shared bare key, npm/yarn-classic are flat, bun-text never sets it.
  nativeResolution?:    string
}

export type PackageMetadataField =
  | 'engines'
  | 'funding'
  | 'license'
  | 'bin'
  | 'deprecated'
  | 'cpu'
  | 'os'
  | 'libc'
  | 'hasInstallScript'
  | 'bundledDependencies'
  | 'peerDependencies'
  | 'peerDependenciesMeta'

export type EdgeAttrs = {
  range?:          string
  // The override-FORCED descriptor range for this edge (ADR-0025), set by
  // completion/replace when a project override/resolution redirected this edge's
  // resolution. `range` stays the DECLARED range (what npm/pnpm write in the
  // parent's deps); the yarn adapters emit `overrideRange` as the ENTRY-KEY
  // descriptor instead — yarn rewrites `foo@^1` → `foo@<pin>` for a bare
  // resolution and collapses the entry, so a completed edge must key by the pin,
  // not its raw range (else `--immutable` YN0028). Opaque per-instance metadata,
  // NOT part of edge identity (unlike `alias`). Absent = no override governs.
  overrideRange?:  string
  optional?:       boolean
  workspace?:      boolean
  // Local descriptor name when it differs from the target node's actual
  // name — i.e. npm-alias deps like
  //   `"@scope/pkg--variant": "npm:@scope/pkg@…"`
  //   `"react-is-18": "npm:react-is@^18"`,
  // and `dependencies.foo: "npm:bar@…"` in npm/pnpm/bun manifests. Unlike
  // the other attrs (which are opaque per-instance metadata), `alias`
  // PARTICIPATES IN EDGE IDENTITY: two edges (src, dst, kind) from the
  // same source to the same target are permitted iff their `alias` slots
  // differ. `alias === undefined` denotes the canonical descriptor where
  // the parent's dependencies-block key matches `dst`'s actual name; a
  // string value is the alias. Sort key: tertiary after (dst, kind) per
  // ADR-0007.
  alias?:          string
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
  /** Optional structured payload for machine consumers (e.g. a pinned-override
   *  record `{ package, to }` that `overridesOf` folds back). Absent on
   *  human-only diagnostics — never affects equality of those. */
  data?:    Record<string, unknown>
}

export interface LayoutHints {
  strategy?: 'isolated' | 'hoisted' | 'pnp' | 'nm-linked'
}

/**
 * Canonical, PM-neutral declaration that a dependency's resolution is forced —
 * the common form of npm `overrides`, yarn `resolutions`, and pnpm
 * `pnpm.overrides` (ADR-0025). A *declared* L1 input, never a resolved Graph
 * instance. Modelled on npm's nested form (the only one expressing
 * parent-scoping); pnpm `>`-chains and yarn flat patterns derive from it.
 */
export interface OverrideConstraint {
  /** Package whose resolution is forced. */
  package: string
  /** Ancestor scope — the override applies only when `package` is reached
   *  under this consumer chain. Absent/empty = global. One segment for the
   *  common single-parent case; multiple for pnpm `a>b>c` chains. */
  parentPath?: string[]
  /** Version condition gating the override (pnpm `foo@2`, yarn `foo@range`).
   *  Absent = unconditional. */
  versionCondition?: string
  /** The forced resolution — a version, range, dist-tag, `npm:` alias, or an
   *  npm `$name` parent-version back-reference. Carried verbatim. */
  to: string
  /** `to` is an npm `$name` self-ref (no yarn/pnpm equivalent). */
  selfRef?: boolean
  /** Source PM grammar (stamped at capture). Drives the PM-faithful override
   *  tie-break: npm/bun = first-match in declaration order, yarn/pnpm =
   *  most-specific. */
  origin?: OverridePM
  /** Declaration order within its capture (0-based) — carries npm's
   *  first-match ordering through `mergeOverrides`' key-sort. */
  captureIndex?: number
}

/** Package-manager grammar an override was declared in (ADR-0025). */
export type OverridePM = 'npm' | 'yarn' | 'pnpm'

/**
 * L1 Manifest — declared constraints from a `package.json` (ADR-0001 §L1,
 * materialised by ADR-0025). PM-neutral; supplied keyed by workspace path as
 * `Record<string, Manifest>`. Distinct from the resolved Graph (L2): a
 * Manifest is what was *declared*, not what was *resolved*.
 */
export interface Manifest {
  name?:    string
  version?: string
  dependencies?:         Record<string, string>
  devDependencies?:      Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?:     Record<string, string>
  workspaces?:           string[]
  /** Canonical override declarations (load-bearing per ADR-0013). */
  overrides?: OverrideConstraint[]
  /** Verbatim PM-native override blocks — attribution per ADR-0013, kept for
   *  lossless same-PM round-trip. At most one is populated per manifest. */
  native?: {
    npmOverrides?:    unknown
    yarnResolutions?: Record<string, string>
    pnpmOverrides?:   Record<string, string>
  }
}

export interface WalkOpts {
  direction?: 'out' | 'in'
  kinds?:     EdgeKind[]
  maxDepth?:  number
}

export type ChangeRecord =
  | { kind: 'node-added';            subject: NodeId }
  | { kind: 'node-removed';          subject: NodeId }
  // `subject` is the NEW id; `oldSubject` is the id that was re-keyed away
  // (present iff the op changed the id — `newNode.id !== id`). Re-keying drops
  // the old id from the graph, so a per-NodeId sidecar (yarn entry-key
  // descriptors, berry conditions / meta) cannot membership-survive on the new
  // id without this old→new pair. Absent when the replace kept the same id
  // (`newNode.id === id`), since no remap is then needed (#114).
  | { kind: 'node-replaced';         subject: NodeId; oldSubject?: NodeId }
  | { kind: 'edge-added';            subject: EdgeTriple }
  | { kind: 'edge-removed';          subject: EdgeTriple }
  // `oldSubject` is the pre-rekey id when the peerContext change shifted the id
  // (`newId !== id`); absent when the context change left the id unchanged. Same
  // role as on `node-replaced` — lets a per-NodeId sidecar follow the rename (#114).
  | { kind: 'peer-context-replaced'; subject: NodeId; oldSubject?: NodeId }
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

/**
 * Result of a graph-transforming operation.
 * @internal
 */
export interface GraphResult {
  readonly graph: Graph
  readonly diagnostics: readonly Diagnostic[]
}

/**
 * Manifest fields accepted by dependency-declaration consumers.
 * @internal
 */
export type DependencyManifest = Pick<
  Manifest,
  | 'name'
  | 'version'
  | 'dependencies'
  | 'devDependencies'
  | 'optionalDependencies'
  | 'peerDependencies'
>

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

/** Reports graph invariant and patch-operation failures. */
export class GraphError extends Error {
  readonly code: 'INVARIANT_VIOLATION' | 'PATCH_REJECTED'

  constructor(code: 'INVARIANT_VIOLATION' | 'PATCH_REJECTED', message: string) {
    super(message)
    this.name = 'GraphError'
    this.code = code
  }
}

// === API ====================================================================

/** Creates a mutable builder for one graph construction. */
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

// === NodeId helpers (per spec/02-graph.md#canonical-nodeid-form, ADR-0006) ==

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
  source?: SourceDiscriminator,
): NodeId {
  const base = toTarballKey({ name, version, patch, source })
  if (peerContext.length === 0) return base
  return base + peerContext.map(p => `(${p})`).join('')
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

// Patch-token grammar predicates owned by `recipe/patch.ts` per ADR-0014
// §4.F2 + ADR-0011 §Decision. graph.ts consumes them — there is no local
// regex shadow here so the token grammar stays single-source.
import { isCanonicalHash, isHashedPeerSetToken, isSentinelPatch as recipeIsSentinelPatch } from './recipe/patch.ts'

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

export function validateSourceToken(source: string): void {
  if (source.length === 0) {
    throw new LockfileError({ code: 'INVALID_INPUT', message: `source slot must not be empty` })
  }
  if (source.includes('+')) {
    throw new LockfileError({ code: 'INVALID_INPUT', message: `source slot must not contain '+'` })
  }
  if (/\s/.test(source)) {
    throw new LockfileError({ code: 'INVALID_INPUT', message: `source slot must not contain whitespace` })
  }
  if (!SRC_TOKEN_RE.test(source)) {
    throw new LockfileError({ code: 'INVALID_INPUT', message: `source slot must be 16 lowercase-hex chars` })
  }
}

export function toTarballKey(inputs: TarballKeyInputs): TarballKey {
  const slots: string[] = []
  if (inputs.patch !== undefined) {
    validatePatchToken(inputs.patch)
    slots.push(`patch=${inputs.patch}`)
  }
  // ADR-0032 — the `+src=` slot. `cmpStr`-sorted alongside `patch=`; since
  // `'patch' < 'src'` the canonical order is `…+patch=…+src=…`. Bare for the
  // registry / directory majority (`source === undefined`) → zero-blast-radius.
  if (inputs.source !== undefined) {
    validateSourceToken(inputs.source)
    slots.push(`src=${inputs.source}`)
  }
  return slots.length === 0
    ? `${inputs.name}@${inputs.version}`
    : `${inputs.name}@${inputs.version}+${slots.sort(cmpStr).join('+')}`
}

// === INTERNALS ==============================================================

function acceptedNodeIds(node: Node): readonly NodeId[] {
  // ADR-0032 — the `+src=` slot ALWAYS participates in the derived id (it
  // describes which non-registry source minted the node and, unlike `patch`,
  // has no bare/slotted duality: a node either is from a discriminated source
  // or is bare). Thread `node.source` through every candidate so re-derivation
  // is exact; the bare majority (`source === undefined`) is unaffected.
  const bare = serializeNodeId(node.name, node.version, node.peerContext, undefined, node.source)
  if (node.patch === undefined) return [bare]
  const patched = serializeNodeId(node.name, node.version, node.peerContext, node.patch, node.source)
  return bare === patched ? [bare] : [bare, patched]
}

function carriesPatchInNodeId(node: Pick<Node, 'id' | 'name' | 'version' | 'patch' | 'source'>): boolean {
  if (node.patch === undefined) return false
  return stripPeerContextFromNodeId(node.id) === toTarballKey({
    name: node.name,
    version: node.version,
    patch: node.patch,
    source: node.source,
  })
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

// ADR-0032 — the `+src=` slot value is the 16-lowercase-hex source discriminator
// minted by `recipe/resolution.sourceDiscriminatorOf`. Guard the slot grammar
// (no `+`/whitespace so the `+`-joined slot list stays parseable) exactly as
// `validatePatchToken` guards `+patch=`. The 16-hex shape is asserted too — the
// only legitimate producer is the recipe primitive, so a malformed value is a
// caller bug, not lossy data.
const SRC_TOKEN_RE = /^[0-9a-f]{16}$/

function tarballKeyInputsOfNode(node: Pick<Node, 'name' | 'version' | 'patch' | 'source'>): TarballKeyInputs {
  return {
    name: node.name,
    version: node.version,
    patch: node.patch,
    source: node.source,
  }
}

// === Comparators ============================================================

const cmpStr = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0

// Tertiary key on alias (ADR-0007 — content-sorted iteration). `undefined`
// sorts before any string so canonical descriptors lead aliased siblings.
const cmpAlias = (a: string | undefined, b: string | undefined): number =>
  a === b ? 0 : a === undefined ? -1 : b === undefined ? 1 : cmpStr(a, b)

const cmpEdgeBy = (end: 'dst' | 'src') => (a: Edge, b: Edge): number => {
  const c = cmpStr(end === 'dst' ? a.dst : a.src, end === 'dst' ? b.dst : b.src)
  if (c !== 0) return c
  const k = cmpStr(a.kind, b.kind)
  if (k !== 0) return k
  return cmpAlias(a.attrs?.alias, b.attrs?.alias)
}

// === Internal state =========================================================

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

// Identity key. `alias` (when set) is the 4th component — two edges with
// the same (src, dst, kind) but distinct aliases are distinct edges. The
// empty-string slot for `alias === undefined` ensures the canonical-edge
// key remains `src\0kind\0dst\0` (deterministic regardless of attrs).
// Callers that supply only an EdgeTriple (e.g. removeEdge change-records,
// diff output) pass no attrs and land on the canonical-slot variant.
const tripleKey = (e: { src: NodeId; dst: NodeId; kind: EdgeKind; attrs?: EdgeAttrs }): string =>
  `${e.src}\0${e.kind}\0${e.dst}\0${e.attrs?.alias ?? ''}`

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
      // Alias participates in identity (per EdgeAttrs.alias comment) — when
      // two outgoing edges share (src, kind, dst) but carry distinct aliases,
      // each one rebinds its OWN paired incoming-side entry, not the first
      // tripleKey match.
      const idx = peerInc.findIndex(x =>
        x.src === oldId && x.kind === e.kind && x.dst === e.dst && x.attrs?.alias === e.attrs?.alias,
      )
      if (idx >= 0) peerInc[idx] = e
    }
  }

  const ins = (s.incoming.get(oldId) ?? []).map(e => ({ ...e, dst: newId }))
  s.incoming.delete(oldId)
  if (ins.length > 0) s.incoming.set(newId, ins)
  for (const e of ins) {
    const peerOut = s.outgoing.get(e.src)
    if (peerOut) {
      const idx = peerOut.findIndex(x =>
        x.src === e.src && x.kind === e.kind && x.dst === oldId && x.attrs?.alias === e.attrs?.alias,
      )
      if (idx >= 0) peerOut[idx] = e
    }
  }
}

// === Published-self-link seal carve-out (ADR-0017 amendment, Bug #4) ========

// Extracts the protocol prefix of a descriptor range (the substring before the
// first `:`), or `undefined` for a bare/unprefixed range. Mirrors the
// `hasExplicitProtocol` detector in `_yarn-berry-core.ts` but lives here because
// graph.ts is the platform-invariant layer and must not import format internals.
// A bare range (`^1.0.0`, `1.2.3`, `*`, `~2`) has no protocol and is treated as
// registry-equivalent (npm:) by `isPublishedSelfLink`.
function protocolOf(range: string): string | undefined {
  const colonIdx = range.indexOf(':')
  if (colonIdx <= 0) return undefined
  const prefix = range.slice(0, colonIdx)
  return /^[a-z][a-z0-9+.-]*$/i.test(prefix) ? prefix : undefined
}

// A workspace node MAY have an incoming edge from a non-workspace node iff the
// edge is a *published self-link*: its source descriptor uses a registry
// protocol (`npm:` or a bare/unprefixed semver range, treated as
// registry-equivalent) AND the workspace is the resolution yarn recorded for
// that descriptor. The structural signal (the edge resolved to a workspace
// node, i.e. it exists targeting `n`) is the faithful one — we do NOT
// `semver.satisfies`-test the workspace's sentinel version (ADR-0011's
// `0.0.0-use.local` does not satisfy e.g. `^30.0.0`; the satisfaction was
// performed by yarn at install time and recorded structurally via entry-key
// fusion, not re-derivable here). Every other protocol
// (`file:`/`link:`/`portal:`/`patch:`/`git`/`git+*`/`http(s):`/`workspace:`)
// stays a seal failure. Conservative fallback: a range that is ABSENT
// (undefined) is NOT a published self-link — the safe direction per the
// amendment's cross-adapter caveat (an adapter that drops the range correctly
// rejects rather than admits an unattested shape).
function isPublishedSelfLink(edge: Edge): boolean {
  const range = edge.attrs?.range
  if (range === undefined) return false
  const proto = protocolOf(range)
  // Registry-class iff `npm:` prefix OR no protocol prefix at all (bare semver).
  return proto === undefined || proto === 'npm'
}

// === Validation =============================================================

function validateDiagnostics(s: State): void {
  for (const d of s.diagnostics) {
    if (d.severity === 'error') {
      throw new GraphError('INVARIANT_VIOLATION', `unresolved error diagnostic: ${d.code} — ${d.message}`)
    }
  }
}

function validateOutgoingEdges(s: State): void {
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
        const aliasSuffix = e.attrs?.alias !== undefined ? ` (alias=${e.attrs.alias})` : ''
        throw new GraphError('INVARIANT_VIOLATION', `duplicate edge: ${e.src} →${e.kind} ${e.dst}${aliasSuffix}`)
      }
      seen.add(k)
    }
  }
}

function validateWorkspaceIncomingEdges(s: State, id: NodeId, node: Node): void {
  if (node.workspacePath === undefined) return
  const inc = s.incoming.get(id) ?? []
  // Workspace-to-workspace edges are kind-agnostic by design here; the seal
  // blocks incoming edges sourced from non-workspace nodes — EXCEPT a
  // published self-link (ADR-0017 amendment, Bug #4): a registry-protocol
  // descriptor that yarn resolved onto a co-located workspace. Partition the
  // non-workspace incoming edges; permit published self-links (emitting an
  // info diagnostic each), reject everything else with the verbatim message.
  for (const edge of inc) {
    if (s.nodes.get(edge.src)?.workspacePath !== undefined) continue // ws→ws: permitted
    // A workspace can satisfy a peer dependency, so a `peer` edge into a workspace
    // node is permitted (ADR-0022); other kinds still reject below.
    if (edge.kind === 'peer') continue
    // ADR-0017 amendment — a LOCAL node (canonical resolution type
    // 'directory': yarn `portal:` / `link:`, npm/pnpm `file:` directory
    // link) is part of the project graph, not a published package, so it
    // may depend on a workspace — e.g. a berry `portal:` package that
    // declares `"<root>": "workspace:^"` inside its own monorepo. The
    // bus-factor concern is a *published* (registry/tarball/git) package
    // depending on a workspace; those still reject below.
    if (s.tarballs.get(stripPeerContextFromNodeId(edge.src))?.resolution?.type === 'directory') continue
    if (isPublishedSelfLink(edge)) {
      s.diagnostics.push({
        code:     'SEAL_PUBLISHED_SELF_LINK',
        subject:  id,
        severity: 'info',
        message:  `published self-link: ${edge.src} →${edge.kind} ${id} (range ${edge.attrs?.range}) — published dependency resolved to co-located workspace`,
      })
      continue
    }
    throw new GraphError('INVARIANT_VIOLATION', `workspace node has incoming edges: ${id}`)
  }
}

function validateNodeId(id: NodeId, node: Node): void {
  const expected = acceptedNodeIds(node)
  if (!expected.includes(id)) {
    throw new GraphError('INVARIANT_VIOLATION', `node id ${id} disagrees with derived id ${expected.join(' or ')}`)
  }
}

function edgeBearingPeerContext(node: Node): NodeId[] {
  return node.peerContext
    .filter(p => !isHashedPeerSetToken(stripPeerContextFromNodeId(p)))
    .map(stripPeerContextFromNodeId)
    .sort()
}

function validatePeerContext(s: State, id: NodeId, node: Node): void {
  // Peer-edge ↔ peerContext coherence is checked by BASE-KEY PROJECTION
  // (NodeId stripped of its `(...)` peer-context suffix), not full-NodeId
  // string equality. pnpm's suffix grammar (ADR-0006) is one-level: a
  // node's peerContext records bare `name@version` base keys, but a peer
  // edge must target a real node — and when that peer is itself a peer-
  // variant (transitive peer-of-a-peer, e.g. pnpm v9
  // `css-parser-algorithms@4.0.0(css-tokenizer@4.0.0)`), the edge target is
  // the fully-qualified variant NodeId. Full-id bijection only holds for
  // leaf peers; projecting both sides to base keys restores the invariant
  // at the granularity the suffix actually encodes. The no-orphan /
  // no-missing intent is preserved — just matched on base key. (ADR-0017.)
  const peerEdgeTargets = (s.outgoing.get(id) ?? [])
    .filter(e => e.kind === 'peer')
    .map(e => stripPeerContextFromNodeId(e.dst))
    .sort()
  // ADR-0030 — a pnpm-v9 HASHED PEER-SET token in the peerContext is a bare-
  // hex identity discriminator that bears NO peer edge (the real peers are
  // hidden inside the hash). Exempt it from the edge↔context coherence
  // compare so it does not look like a peerContext entry with a missing edge.
  // The derived-id check above is UNCHANGED — the token still participates in
  // `serializeNodeId`, so id re-derivation stays exact. Only EDGE-BEARING
  // peerContext entries are matched against the peer edges here.
  const peerCtx = edgeBearingPeerContext(node)
  if (peerEdgeTargets.length !== peerCtx.length || peerEdgeTargets.some((t, i) => t !== peerCtx[i])) {
    throw new GraphError('INVARIANT_VIOLATION', `peer edges of ${id} disagree with peerContext`)
  }
}

function validateNodes(s: State): void {
  for (const [id, node] of s.nodes) {
    validateWorkspaceIncomingEdges(s, id, node)
    validateNodeId(id, node)
    validatePeerContext(s, id, node)
  }
}

function validate(s: State): void {
  validateDiagnostics(s)
  validateOutgoingEdges(s)
  validateNodes(s)
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

type WalkItem = { id: NodeId; depth: number }

function walkStack(seeds: NodeId | NodeId[]): WalkItem[] {
  const initial = Array.isArray(seeds) ? seeds : [seeds]
  const stack: WalkItem[] = []
  for (let i = initial.length - 1; i >= 0; i--) {
    const seed = initial[i]
    if (seed !== undefined) stack.push({ id: seed, depth: 0 })
  }
  return stack
}

function walkEdges(s: State, id: NodeId, direction: 'out' | 'in', kinds?: EdgeKind[]): readonly Edge[] {
  const edges = (direction === 'out' ? s.outgoing : s.incoming).get(id) ?? []
  return kinds ? edges.filter(e => kinds.includes(e.kind)) : edges
}

function pushWalkSuccessors(
  stack: WalkItem[],
  visited: ReadonlySet<NodeId>,
  edges: readonly Edge[],
  direction: 'out' | 'in',
  depth: number,
): void {
  for (let i = edges.length - 1; i >= 0; i--) {
    const e = edges[i]
    if (!e) continue
    const next = direction === 'out' ? e.dst : e.src
    if (!visited.has(next)) stack.push({ id: next, depth: depth + 1 })
  }
}

function *walkGraph(s: State, seeds: NodeId | NodeId[], opts?: WalkOpts): IterableIterator<NodeId> {
  const direction = opts?.direction ?? 'out'
  const kinds     = opts?.kinds
  const maxDepth  = opts?.maxDepth ?? Infinity
  const visited   = new Set<NodeId>()
  const stack     = walkStack(seeds)

  while (stack.length > 0) {
    const top = stack.pop()
    if (!top || visited.has(top.id)) continue
    visited.add(top.id)
    yield top.id
    if (top.depth >= maxDepth) continue
    pushWalkSuccessors(stack, visited, walkEdges(s, top.id, direction, kinds), direction, top.depth)
  }
}

type TarjanFrame = { v: NodeId; iter: number; succ: NodeId[] }

interface TarjanState {
  indexOf: Map<NodeId, number>
  lowlink: Map<NodeId, number>
  onStack: Set<NodeId>
  ssStack: NodeId[]
  sccs:    NodeId[][]
  next:    number
}

function tarjanState(): TarjanState {
  return {
    indexOf: new Map(),
    lowlink: new Map(),
    onStack: new Set(),
    ssStack: [],
    sccs:    [],
    next:    0,
  }
}

function visitTarjanNode(s: State, state: TarjanState, v: NodeId): TarjanFrame {
  state.indexOf.set(v, state.next)
  state.lowlink.set(v, state.next)
  state.next++
  state.ssStack.push(v)
  state.onStack.add(v)
  const succ = (s.outgoing.get(v) ?? []).map(e => e.dst)
  return { v, iter: 0, succ }
}

function updateTarjanBackEdge(state: TarjanState, frame: TarjanFrame, w: NodeId): void {
  if (!state.onStack.has(w)) return
  const cur = state.lowlink.get(frame.v) ?? 0
  const wIdx = state.indexOf.get(w) ?? 0
  if (wIdx < cur) state.lowlink.set(frame.v, wIdx)
}

function advanceTarjanFrame(
  s: State,
  state: TarjanState,
  callStack: TarjanFrame[],
  frame: TarjanFrame,
): boolean {
  if (frame.iter >= frame.succ.length) return false
  const w = frame.succ[frame.iter++]
  if (w === undefined) return true
  if (!state.indexOf.has(w)) callStack.push(visitTarjanNode(s, state, w))
  else updateTarjanBackEdge(state, frame, w)
  return true
}

function collectTarjanComponent(state: TarjanState, root: NodeId): void {
  const scc: NodeId[] = []
  let w: NodeId | undefined
  do {
    w = state.ssStack.pop()
    if (w === undefined) break
    state.onStack.delete(w)
    scc.push(w)
  } while (w !== root)
  scc.sort(cmpStr)
  state.sccs.push(scc)
}

function propagateTarjanLowlink(state: TarjanState, callStack: TarjanFrame[], frame: TarjanFrame): void {
  const parent = callStack[callStack.length - 1]
  if (!parent) return
  const pl = state.lowlink.get(parent.v) ?? 0
  const cl = state.lowlink.get(frame.v) ?? 0
  if (cl < pl) state.lowlink.set(parent.v, cl)
}

function completeTarjanFrame(state: TarjanState, callStack: TarjanFrame[], frame: TarjanFrame): void {
  callStack.pop()
  if (state.lowlink.get(frame.v) === state.indexOf.get(frame.v)) {
    collectTarjanComponent(state, frame.v)
  }
  propagateTarjanLowlink(state, callStack, frame)
}

function runTarjanRoot(s: State, state: TarjanState, root: NodeId): void {
  const callStack: TarjanFrame[] = [visitTarjanNode(s, state, root)]
  while (callStack.length > 0) {
    const frame = callStack[callStack.length - 1]
    if (!frame) break
    if (advanceTarjanFrame(s, state, callStack, frame)) continue
    completeTarjanFrame(state, callStack, frame)
  }
}

function topologicalComponents(s: State): NodeId[][] {
  const state = tarjanState()
  const ids = Array.from(s.nodes.keys()).sort(cmpStr)
  for (const root of ids) {
    if (!state.indexOf.has(root)) runTarjanRoot(s, state, root)
  }
  return state.sccs.reverse()
}

function emptyGraphDiff(): GraphDiff {
  return {
    addedNodes:   [],
    removedNodes: [],
    changedNodes: [],
    addedEdges:   [],
    removedEdges: [],
  }
}

function diffNodes(s: State, other: Graph, out: GraphDiff): void {
  const otherIds = new Set<NodeId>()
  for (const n of other.nodes()) otherIds.add(n.id)
  for (const id of s.nodes.keys()) {
    if (!otherIds.has(id)) out.removedNodes.push(id)
  }
  for (const n of other.nodes()) {
    const cur = s.nodes.get(n.id)
    if (!cur) out.addedNodes.push(n.id)
    else if (!nodeEqual(cur, n)) out.changedNodes.push(n.id)
  }
}

function graphEdges(s: State): Map<string, Edge> {
  const edgesByKey = new Map<string, Edge>()
  for (const edges of s.outgoing.values()) {
    for (const e of edges) edgesByKey.set(tripleKey(e), e)
  }
  return edgesByKey
}

function publicGraphEdges(graph: Graph): Map<string, Edge> {
  const edgesByKey = new Map<string, Edge>()
  for (const n of graph.nodes()) {
    for (const e of graph.out(n.id)) edgesByKey.set(tripleKey(e), e)
  }
  return edgesByKey
}

function diffEdges(s: State, other: Graph, out: GraphDiff): void {
  const myEdges = graphEdges(s)
  const otherEdges = publicGraphEdges(other)
  for (const [k, e] of myEdges) {
    if (!otherEdges.has(k)) out.removedEdges.push({ src: e.src, dst: e.dst, kind: e.kind })
  }
  for (const [k, e] of otherEdges) {
    if (!myEdges.has(k)) out.addedEdges.push({ src: e.src, dst: e.dst, kind: e.kind })
  }
}

const cmpEdgeTriple = (a: EdgeTriple, b: EdgeTriple): number => cmpStr(tripleKey(a), tripleKey(b))

function sortGraphDiff(out: GraphDiff): void {
  out.addedNodes.sort(cmpStr)
  out.removedNodes.sort(cmpStr)
  out.changedNodes.sort(cmpStr)
  out.addedEdges.sort(cmpEdgeTriple)
  out.removedEdges.sort(cmpEdgeTriple)
}

function mutatorAddNode(next: State, applied: ChangeRecord[], node: Node): void {
  if (node.patch !== undefined) validatePatchToken(node.patch)
  refuseSentinelMutation(node.patch, 'addNode', node.id)
  if (next.nodes.has(node.id)) {
    throw new GraphError('PATCH_REJECTED', `addNode: ${node.id} already exists`)
  }
  next.nodes.set(node.id, node)
  applied.push({ kind: 'node-added', subject: node.id })
}

function mutatorRemoveNode(next: State, applied: ChangeRecord[], id: NodeId): void {
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
}

function mutatorReplaceNode(next: State, applied: ChangeRecord[], id: NodeId, newNode: Node): void {
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
  applied.push(newNode.id === id
    ? { kind: 'node-replaced', subject: newNode.id }
    : { kind: 'node-replaced', subject: newNode.id, oldSubject: id })
}

function mutatorAddEdge(
  next: State,
  applied: ChangeRecord[],
  src: NodeId,
  dst: NodeId,
  kind: EdgeKind,
  attrs?: EdgeAttrs,
): void {
  if (!next.nodes.has(src)) throw new GraphError('PATCH_REJECTED', `addEdge: src ${src} missing`)
  if (!next.nodes.has(dst)) throw new GraphError('PATCH_REJECTED', `addEdge: dst ${dst} missing`)
  const existing = next.outgoing.get(src) ?? []
  const newAlias = attrs?.alias
  if (existing.some(e => e.dst === dst && e.kind === kind && e.attrs?.alias === newAlias)) {
    const aliasSuffix = newAlias !== undefined ? ` (alias=${newAlias})` : ''
    throw new GraphError('PATCH_REJECTED', `addEdge: duplicate ${src} →${kind} ${dst}${aliasSuffix}`)
  }
  const e: Edge = attrs ? { src, dst, kind, attrs } : { src, dst, kind }
  pushTo(next.outgoing, src, e)
  pushTo(next.incoming, dst, e)
  applied.push({ kind: 'edge-added', subject: { src, dst, kind } })
}

function matchingEdgeIndex(edges: readonly Edge[], dst: NodeId, kind: EdgeKind): number {
  return edges.findIndex(e => e.dst === dst && e.kind === kind)
}

function removeIncomingEdge(
  next: State,
  src: NodeId,
  dst: NodeId,
  kind: EdgeKind,
  alias: string | undefined,
): void {
  const ins = next.incoming.get(dst)
  if (ins) removeMatching(ins, e => e.src === src && e.kind === kind && e.attrs?.alias === alias)
}

function mutatorRemoveEdge(
  next: State,
  applied: ChangeRecord[],
  src: NodeId,
  dst: NodeId,
  kind: EdgeKind,
): void {
  const outs = next.outgoing.get(src)
  // Identify-and-extract: capture the alias slot of the dropped
  // outgoing edge so we can purge the matching incoming-side entry
  // (avoiding alias-sibling collisions when two edges share
  // (src, dst, kind) but differ on alias). EdgeTriple change-records
  // omit `alias` — this matches the public Mutator signature; for
  // alias-precise removal callers can use the diff/replay path.
  if (!outs) {
    throw new GraphError('PATCH_REJECTED', `removeEdge: ${src} →${kind} ${dst} missing`)
  }
  const found = matchingEdgeIndex(outs, dst, kind)
  if (found < 0) throw new GraphError('PATCH_REJECTED', `removeEdge: ${src} →${kind} ${dst} missing`)
  const removedAlias = outs[found]?.attrs?.alias
  outs.splice(found, 1)
  removeIncomingEdge(next, src, dst, kind, removedAlias)
  applied.push({ kind: 'edge-removed', subject: { src, dst, kind } })
}

function peerContextNodeId(node: Node, peers: NodeId[]): NodeId {
  return carriesPatchInNodeId(node)
    ? serializeNodeId(node.name, node.version, peers, node.patch, node.source)
    : serializeNodeId(node.name, node.version, peers, undefined, node.source)
}

function removePeerEdges(next: State, id: NodeId): void {
  const outs = next.outgoing.get(id) ?? []
  for (const e of outs.filter(e => e.kind === 'peer')) {
    const peerInc = next.incoming.get(e.dst)
    if (peerInc) removeMatching(peerInc, x => x.src === id && x.dst === e.dst && x.kind === 'peer')
  }
  next.outgoing.set(id, outs.filter(e => e.kind !== 'peer'))
}

function addPeerEdges(next: State, id: NodeId, peers: NodeId[]): void {
  for (const p of peers) {
    const e: Edge = { src: id, dst: p, kind: 'peer' }
    pushTo(next.outgoing, id, e)
    pushTo(next.incoming, p, e)
  }
}

function mutatorReplacePeerContext(
  next: State,
  applied: ChangeRecord[],
  id: NodeId,
  peers: NodeId[],
): void {
  const old = next.nodes.get(id)
  if (!old) throw new GraphError('PATCH_REJECTED', `replacePeerContext: ${id} missing`)
  refuseSentinelMutation(old.patch, 'replacePeerContext', id)
  for (const p of peers) {
    if (!next.nodes.has(p)) throw new GraphError('PATCH_REJECTED', `replacePeerContext: peer ${p} missing`)
  }

  const newId = peerContextNodeId(old, peers)
  if (newId !== id && next.nodes.has(newId)) {
    throw new GraphError('PATCH_REJECTED', `replacePeerContext: target id ${newId} already exists`)
  }

  removePeerEdges(next, id)
  const newNode: Node = { ...old, id: newId, peerContext: peers.slice() }
  if (newId === id) next.nodes.set(id, newNode)
  else rebindNodeId(next, id, newId, newNode)
  addPeerEdges(next, newId, peers)

  applied.push(newId === id
    ? { kind: 'peer-context-replaced', subject: newId }
    : { kind: 'peer-context-replaced', subject: newId, oldSubject: id })
}

function mutatorSetTarball(
  next: State,
  applied: ChangeRecord[],
  inputs: TarballKeyInputs,
  payload: TarballPayload,
): void {
  const key = toTarballKey(inputs)
  refuseSentinelMutation(inputs.patch, 'setTarball', `${inputs.name}@${inputs.version}`)
  next.tarballs.set(key, payload)
  applied.push({ kind: 'tarball-set', subject: key })
}

function mutatorRemoveTarball(next: State, applied: ChangeRecord[], inputs: TarballKeyInputs): void {
  const key = toTarballKey(inputs)
  if (!next.tarballs.delete(key)) {
    throw new GraphError('PATCH_REJECTED', `removeTarball: ${key} missing`)
  }
  applied.push({ kind: 'tarball-removed', subject: key })
}

function createMutator(next: State, applied: ChangeRecord[]): Mutator {
  return {
    addNode:            node => mutatorAddNode(next, applied, node),
    removeNode:         id => mutatorRemoveNode(next, applied, id),
    replaceNode:        (id, node) => mutatorReplaceNode(next, applied, id, node),
    addEdge:            (src, dst, kind, attrs) => mutatorAddEdge(next, applied, src, dst, kind, attrs),
    removeEdge:         (src, dst, kind) => mutatorRemoveEdge(next, applied, src, dst, kind),
    replacePeerContext: (id, peers) => mutatorReplacePeerContext(next, applied, id, peers),
    setTarball:         (inputs, payload) => mutatorSetTarball(next, applied, inputs, payload),
    removeTarball:      inputs => mutatorRemoveTarball(next, applied, inputs),
    // ADR-0023 §8.6 — write-side diagnostic emit. Append to the staged
    // diagnostics list; the resulting Graph.diagnostics() surfaces it
    // once mutate() settles. Same append semantics as Builder.diagnostic.
    diagnostic:         d => next.diagnostics.push(d),
  }
}

// === Graph implementation ===================================================

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
    yield* walkGraph(this.s, seeds, opts)
  }

  topoSort(): readonly (readonly NodeId[])[] {
    // Tarjan's SCC, iterative to handle deep graphs without stack overflow.
    return topologicalComponents(this.s)
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
    const out = emptyGraphDiff()
    diffNodes(this.s, other, out)
    diffEdges(this.s, other, out)
    sortGraphDiff(out)
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

    const m = createMutator(next, applied)

    transaction(m)

    validate(next)
    reindex(next)

    const nextGraph = new GraphImpl(next)
    inheritMutationLineage(this, nextGraph)
    return {
      graph:      nextGraph,
      applied,
      unresolved: next.diagnostics.filter(d => d.severity === 'warning'),
    }
  }
}

function nodeEqual(a: Node, b: Node): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}
