// _npm-flat-types.ts — neutral type + utility module for the npm-flat-family.
//
// Holds the shared schema (NpmEntry / NpmLegacyEntry / NpmFlatSidecar /
// NpmSidecar), the family config interface, and tiny utilities (cmpStr,
// sortRecord, edgeTripleKey) that BOTH `_npm-core.ts` and adapter-specific
// extension modules (e.g. `_npm-2-mirror.ts`) consume. Both sides import
// from here — neither imports the other — so the dependency graph stays
// acyclic and core remains a standalone-reuse surface for future
// flat-family adapters.
//
// Layered constraint, breaking the import cycle:
// - core: depends on types only.
// - mirror (npm-2-only): depends on types only.
// - npm-{2,3,4}.ts thin entries: wire core + (optional) extensions via the
// `hooks` slot on `NpmFamilyConfig` so core never imports mirror.

import { type Diagnostic, type EdgeKind, type Graph, type Node, type OverrideConstraint } from '../graph.ts'
import type { UnknownTopLevelState } from './_unknown-top-level.ts'

// === Tiny utilities =========================================================

export const cmpStr = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0

export function sortRecord<V>(record: Record<string, V>): Record<string, V> {
  const out: Record<string, V> = {}
  for (const key of Object.keys(record).sort(cmpStr)) {
    out[key] = record[key]!
  }
  return out
}

// npm serializes `package-lock.json` via `json-stringify-nice` (see arborist
// `lib/shrinkwrap.js`), NOT plain `JSON.stringify`. Its key order is: keys whose
// value is a nested object sort AFTER keys whose value is scalar/array; within
// each group a preferred-key prefix (`NPM_SW_KEY_ORDER`) leads, then the
// remainder is alphabetical by `localeCompare('en')`. Emitting in that exact
// order keeps a generated lock stable under a MUTABLE `npm install`, not only
// `npm ci` (which is order-insensitive). The same ordering applies recursively,
// including `packages`/`dependencies` MAP keys, which npm sorts
// `localeCompare` rather than the codepoint `cmpStr` used elsewhere here.
const NPM_SW_KEY_ORDER = [
  'name', 'version', 'lockfileVersion', 'resolved', 'integrity',
  'requires', 'packages', 'dependencies',
]

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)

const compareNpmKeys = (a: string, b: string): number => {
  const ai = NPM_SW_KEY_ORDER.indexOf(a)
  const bi = NPM_SW_KEY_ORDER.indexOf(b)
  if (ai !== -1 && bi === -1) return -1
  if (bi !== -1 && ai === -1) return 1
  if (ai !== -1 && bi !== -1) return ai - bi
  return a.localeCompare(b, 'en')
}

// Recursively reorder object keys to match json-stringify-nice. Scalars/arrays
// precede nested objects; within each group NPM_SW_KEY_ORDER leads, then
// localeCompare. Arrays are mapped so any object elements are reordered too.
// `out` is a fresh acyclic plain-object tree, so no cycle guard is needed.
const npmNiceOrder = (
  val: unknown,
  preserveOrder = false,
  path: readonly string[] = [],
  preserveNativeRootEntryOrder = false,
): unknown => {
  if (Array.isArray(val)) {
    return val.map(item => npmNiceOrder(item, preserveOrder, path, preserveNativeRootEntryOrder))
  }
  if (!isPlainObject(val)) return val
  const entries = Object.entries(val)
  if (!preserveOrder) {
    entries.sort(([ak, av], [bk, bv]) => {
      const aObj = isPlainObject(av)
      const bObj = isPlainObject(bv)
      return aObj === bObj ? compareNpmKeys(ak, bk) : aObj ? 1 : -1
    })
  }
  const ordered: Record<string, unknown> = {}
  for (const [k, v] of entries) {
    const childPath = [...path, k]
    const preserveChild = preserveOrder || (
      preserveNativeRootEntryOrder
      && path.length === 1
      && path[0] === 'packages'
      && k === ''
    )
    ordered[k] = npmNiceOrder(v, preserveChild, childPath, preserveNativeRootEntryOrder)
  }
  return ordered
}

// Serialise an npm lock object exactly as npm would: json-stringify-nice key
// order, two-space indent, trailing newline. Drop-in for `JSON.stringify(out,
// null, 2) + '\n'` at every npm-family emit site.
export const stringifyNpmLock = (
  out: unknown,
  topLevelOrder?: readonly string[],
  preserveNativeRootEntryOrder = false,
): string => {
  const ordered = npmNiceOrder(out, false, [], preserveNativeRootEntryOrder)
  if (topLevelOrder === undefined || !isPlainObject(ordered)) {
    return JSON.stringify(ordered, null, 2) + '\n'
  }
  const root: Record<string, unknown> = {}
  for (const key of topLevelOrder) {
    if (Object.prototype.hasOwnProperty.call(ordered, key)) root[key] = ordered[key]
  }
  for (const [key, value] of Object.entries(ordered)) {
    if (!Object.prototype.hasOwnProperty.call(root, key)) root[key] = value
  }
  return JSON.stringify(root, null, 2) + '\n'
}

export const NPM_EDGE_RANGE_ATTR = 'range'

export function edgeTripleKey(src: string, kind: EdgeKind, dst: string): string {
  return `${src}|${kind}|${dst}`
}

// === Family config + options ================================================

// Top-level layout shapes recognised by the flat-family core. The
// `dependencies-tree` (npm-1) shape is intentionally absent —
// `_npm-core.ts` header.
export type NpmTopLevelShape = 'dual' | 'packages-only'

export interface NpmFamilyConfig {
  lockfileVersion: 2 | 3 | 4
  topLevelShape: NpmTopLevelShape
  diagnosticPrefix: 'NPM_V2' | 'NPM_V3' | 'NPM_V4'
  // Adapter-specific hook surface. Core invokes these at strategic points
  // but knows nothing about their implementation. npm-2 wires its
  // `_npm-2-mirror.ts` functions here; npm-3 leaves the slot unset.
  hooks?: NpmFamilyHooks
}

export interface NpmFamilyParseHookContext {
  graph: Graph
  lf: NpmLockfile
  packages: Record<string, NpmEntry>
  rootId: string
  options: NpmFamilyParseOptions
}

export interface NpmFamilyStringifyHookContext {
  graph: Graph
  rootNode: Node | undefined
  sidecar: NpmSidecar | undefined
  out: Record<string, unknown>
}

export interface NpmFamilyHooks {
  // Pre-main-parse extra top-level validation (e.g. dual-mode `dependencies`
  // requirement). Throws LockfileError on rejection.
  validateTopLevel?: (lf: NpmLockfile) => void
  // Resolve an adapter-native patch record into the canonical Node.patch
  // identity before the node is inserted. npm-4 uses this for `patched`;
  // npm-2/3 leave it unset.
  resolvePatch?: (ctx: {
    path: string
    name: string
    version: string
    source?: string
    entry: NpmEntry
    options: NpmFamilyParseOptions
  }) => Readonly<{
    patch: string
    normalised?: boolean
    diagnostic?: Diagnostic
  }> | undefined
  // Capture per-entry adapter state during pass-2 of parse (e.g.
  // npm-2 mirror's `resolved` URL by NodeId).
  captureEntry?: (srcId: string, entry: NpmEntry) => void
  // Capture adapter-native per-entry state into the common node sidecar after
  // canonical identity has been resolved.
  captureNodeSidecar?: (ctx: {
    path: string
    srcId: string
    patch?: string
    entry: NpmEntry
    nodeSidecar: NpmFlatSidecar
  }) => void
  // Capture adapter-native root metadata after the common fields are built.
  captureRootMeta?: (ctx: {
    lf: NpmLockfile
    rootEntry: NpmEntry
    rootMeta: NpmRootMeta
  }) => void
  // Emit pre-seal diagnostics (e.g. dual-mode drift).
  emitParseDiagnostics?: (ctx: { lf: NpmLockfile; packages: Record<string, NpmEntry>; diagnostics: Diagnostic[] }) => void
  // After the graph is sealed, finalise adapter-specific state attached
  // to it (e.g. npm-2 mirror sidecar stash).
  afterParse?: (ctx: NpmFamilyParseHookContext) => void
  // After stringify-out is built, enrich it with adapter-specific top-level
  // keys (e.g. npm-2 legacy `dependencies` mirror).
  enrichStringifyOut?: (ctx: NpmFamilyStringifyHookContext) => void
  // Add adapter-native state to a `packages` entry. The sidecar is replay
  // authority; cross-family graphs do not fabricate npm-native fingerprints.
  enrichPackageEntry?: (ctx: {
    graph: Graph
    node: Node
    nodeSidecar: NpmFlatSidecar | undefined
    body: Record<string, unknown>
    kind: 'root' | 'workspace' | 'installed'
  }) => void
  // True iff an adapter can faithfully emit this node's canonical patch.
  canEmitPatch?: (graph: Graph, node: Node, sidecar: NpmSidecar | undefined) => boolean
  // Per-entry stringify-time `resolved` URL recovery. npm-2 stashes the
  // on-disk URL in the mirror sidecar and replays it here when
  // `node.resolution` is unset (parser does not sync `resolved` → node).
  recoverResolvedForNode?: (graph: Graph, node: Node) => string | undefined
  // Propagate adapter state across a graph mutation (enrich / optimize
  // produce a new Graph instance; mirror sidecar's WeakMap must move).
  rebindGraph?: (oldGraph: Graph, newGraph: Graph) => void
  // Prune adapter state to a node set after optimize.
  pruneToNodes?: (graph: Graph, reachableNodeIds: ReadonlySet<string>) => void
}

export interface NpmFamilyParseOptions {
  workspaceRoot?: string
  registryFor?: (packageName: string) => string | undefined
  onDiagnostic?: (diagnostic: Diagnostic) => void
}

export interface NpmFamilyStringifyOptions {
  lineEnding?: 'lf' | 'crlf'
  onDiagnostic?: (diagnostic: Diagnostic) => void
  /** Caller-declared overrides projected into the root entry's
   * `overrides` block at `packages[""]`. npm-1 (no packages block) cannot
   * carry them — a loss diagnostic fires instead. */
  overrides?: OverrideConstraint[]
}

export type NpmFamilyEnrichOptions = {}
export type NpmFamilyOptimizeOptions = {}

// === JSON entry schemas =====================================================

/** The root manifest's `workspaces` field, which npm copies into `packages[""]`
 * verbatim. npm accepts BOTH spellings and `@npmcli/map-workspaces` reads
 * either: the array form `["a", "b"]`, and the object form
 * `{ "packages": ["a"], "nohoist": [...] }` inherited from the yarn-1 era.
 * Both are carried as written — normalising the object form to its `packages`
 * array would re-emit a lock that differs from the one npm itself writes. */
export type NpmWorkspacesField =
  | string[]
  | Readonly<{ packages?: string[], [key: string]: unknown }>

// JSON-shape of an npm `packages` entry.
export interface NpmEntry {
  name?: string
  version?: string
  resolved?: string
  integrity?: string
  link?: boolean
  dev?: boolean
  optional?: boolean
  peer?: boolean
  inBundle?: boolean
  extraneous?: boolean
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
  optionalDependencies?: Record<string, string>
  bin?: string | Record<string, string>
  engines?: Record<string, string>
  funding?: unknown
  license?: string
  workspaces?: NpmWorkspacesField
  bundleDependencies?: string[] | boolean
  hasInstallScript?: boolean
  hasShrinkwrap?: boolean
  deprecated?: string
  cpu?: string[]
  os?: string[]
  libc?: string[]
  patched?: {
    integrity?: unknown
    path?: unknown
    [key: string]: unknown
  }
  packageExtensionsHash?: unknown
  npmExtensionHash?: unknown
  packageExtensionsApplied?: unknown
  npmExtensionApplied?: unknown
  [key: string]: unknown
}

// JSON-shape of an npm-1-style nested `dependencies` entry. The npm-2
// legacy mirror reuses this shape; the type is shared so the mirror
// module (which does not depend on core) can describe its emit output.
export interface NpmLegacyEntry {
  version?: string
  resolved?: string
  integrity?: string
  from?: string
  dev?: boolean
  optional?: boolean
  bundled?: boolean
  requires?: Record<string, string>
  dependencies?: Record<string, NpmLegacyEntry>
}

export interface NpmLockfile {
  name?: string
  version?: string
  lockfileVersion?: number
  requires?: boolean
  packages?: Record<string, NpmEntry>
  dependencies?: Record<string, NpmLegacyEntry> | unknown
}

export interface NpmRootMeta {
  name?: string
  version?: string
  requires?: boolean
  /** Whole source-authored `packages[""]` object for npm-2/3 same-format
   * replay. The originating version prevents cross-format fabrication;
   * stringify clones the record before canonical graph fields overlay it. */
  nativeRootEntry?: Readonly<{
    lockfileVersion: 2 | 3
    value: Readonly<Record<string, unknown>>
  }>
  workspaces?: NpmWorkspacesField
  bundleDependencies?: string[] | boolean
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  /** Canonical overrides captured from the root entry's `overrides` block
   * The name-chain abstraction — used for cross-PM projection,
   * query, and the manifest-capture (A2) path where no npm verbatim exists. */
  overrides?: OverrideConstraint[]
  /** VERBATIM npm `overrides` block as written in the lock. This
   * is the lossless same-PM round-trip carrier — re-emitted byte-for-byte when
   * the caller supplies no `StringifyOptions.overrides`, symmetric to pnpm's
   * `sidecar.overrides`. Preferred over the canonical form on npm→npm re-emit
   * because the canonical name-chain drops npm-specific tails (`pkg@version`
   * key qualifiers, self-key ordering). */
  nativeOverrides?: Record<string, unknown>
  /** npm 12 v4 may omit top-level name/version even though packages[""]
   * carries them. Presence flags keep same-format replay byte-identical. */
  topLevelNamePresent?: boolean
  topLevelVersionPresent?: boolean
  /** npm 12 manifest-extension fingerprints carried by packages[""]. */
  packageExtensionsHash?: string
  npmExtensionHash?: string
}

// Per-NodeId sidecar shared by every flat-family adapter (npm-2/3/4).
// Fields here are layout-agnostic; npm-2-only mirror-emit recovery state
// lives in a SEPARATE WeakMap maintained by `_npm-2-mirror.ts`.
export interface NpmFlatSidecar {
  installPaths: string[]
  inBundle?: boolean
  dev?: boolean
  optional?: boolean
  peer?: boolean
  // npm marks a workspace member `extraneous: true` when it is present on disk
  // but not part of the install graph (no top-level `node_modules/<name>` link).
  // Captured layout attribution (WS-LINK): replayed on stringify so
  // an extraneous member re-emits WITHOUT a link, matching npm. Absent ⇒ linked.
  extraneous?: boolean
  peerDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  /** npm 12 v4 native patch carrier, replayed only while its canonical
   * identity still matches Node.patch. */
  patched?: Readonly<{ integrity: string; path: string }>
  patchIdentity?: string
  /** npm 12 v4 provenance for dependency facts already present in the normal
   * dependency blocks. Opaque, same-format replay data. */
  packageExtensionsApplied?: unknown
  npmExtensionApplied?: unknown
}

/** Native `packages[path]` state whose meaning belongs to one physical
 * installation path rather than to the canonical package identity. */
export interface NpmPackageEntrySidecar {
  nodeId: string
  /** Whole source-authored `packages[path]` record. Same-family replay uses
   * this exact-path carrier for native metadata presence and values; graph
   * identity/topology still comes from the canonical entry. */
  nativeEntry: Readonly<Record<string, unknown>>
  /** Canonical installed-entry projection at parse time. A later graph rebind
   * overlays every key whose canonical value changed, so native state cannot
   * replay a stale checksum, URL, identity, or dependency block. */
  canonicalEntry?: Readonly<Record<string, unknown>>
}

/** Native npm `link: true` entry keyed by its physical alias path. The target
 * node carries canonical workspace/root identity; the source path remains
 * layout state because it may differ from `node_modules/<target.name>`. */
export interface NpmLinkEntrySidecar {
  targetNodeId: string
  nativeEntry: Readonly<Record<string, unknown>>
}

export interface NpmSidecar {
  rootId?: string
  rootMeta?: NpmRootMeta
  // Edge-level: range record per edgeTripleKey(src, kind, dst).
  edgeRanges: Map<string, string>
  // Edge-level: declared dep-name in the source manifest. Differs
  // dst.name when the consumer imports via an `npm:` alias or a workspace
  // symlink. Used by stringify to round-trip the consumer's import-name.
  edgeDeclaredNames: Map<string, string>
  // Node-level sidecar keyed by NodeId.
  nodes: Map<string, NpmFlatSidecar>
  // Installed-entry sidecar keyed by the exact `packages` path. npm can carry
  // different whole records for two paths that collapse to one canonical NodeId.
  // Optional because npm-1 reuses NpmSidecar but has no flat `packages` table.
  packageEntriesByPath?: Map<string, NpmPackageEntrySidecar>
  // Exact source-authored link aliases. Optional because npm-1 and generated /
  // foreign graphs have no flat packages-table link carrier.
  linkEntriesByPath?: Map<string, NpmLinkEntrySidecar>
  // Workspace member path lookup: workspacePath -> NodeId.
  workspaceByPath: Map<string, string>
  /** Producer-tolerated, adapter-unknown project-level keys. Same-format only. */
  unknownTopLevel?: UnknownTopLevelState
}
