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
// Layered constraint per ADR-0021 §5 + r2 cycle-break:
//   - core: depends on types only.
//   - mirror (npm-2-only): depends on types only.
//   - npm-{2,3}.ts thin entries: wire core + (optional) mirror via the
//     `hooks` slot on `NpmFamilyConfig` so core never imports mirror.

import { type Diagnostic, type EdgeKind, type Graph, type Node } from '../graph.ts'

// === Tiny utilities ========================================================

export const cmpStr = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0

export function sortRecord<V>(record: Record<string, V>): Record<string, V> {
  const out: Record<string, V> = {}
  for (const key of Object.keys(record).sort(cmpStr)) {
    out[key] = record[key]!
  }
  return out
}

export const NPM_EDGE_RANGE_ATTR = 'range'

export function edgeTripleKey(src: string, kind: EdgeKind, dst: string): string {
  return `${src}|${kind}|${dst}`
}

// === Family config + options ==============================================

// Top-level layout shapes recognised by the flat-family core. The
// `dependencies-tree` (npm-1) shape is intentionally absent — see
// `_npm-core.ts` header.
export type NpmTopLevelShape = 'dual' | 'packages-only'

export interface NpmFamilyConfig {
  lockfileVersion: 2 | 3
  topLevelShape: NpmTopLevelShape
  diagnosticPrefix: 'NPM_V2' | 'NPM_V3'
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
  // Capture per-entry adapter state during pass-2 of parse (e.g.
  // npm-2 mirror's `resolved` URL by NodeId).
  captureEntry?: (srcId: string, entry: NpmEntry) => void
  // Emit pre-seal diagnostics (e.g. dual-mode drift).
  emitParseDiagnostics?: (ctx: { lf: NpmLockfile; packages: Record<string, NpmEntry>; diagnostics: Diagnostic[] }) => void
  // After the graph is sealed, finalise adapter-specific state attached
  // to it (e.g. npm-2 mirror sidecar stash).
  afterParse?: (ctx: NpmFamilyParseHookContext) => void
  // After stringify-out is built, enrich it with adapter-specific top-level
  // keys (e.g. npm-2 legacy `dependencies` mirror).
  enrichStringifyOut?: (ctx: NpmFamilyStringifyHookContext) => void
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

export interface NpmFamilyParseOptions {}

export interface NpmFamilyStringifyOptions {
  lineEnding?: 'lf' | 'crlf'
  onDiagnostic?: (diagnostic: Diagnostic) => void
}

export interface NpmFamilyEnrichOptions {}
export interface NpmFamilyOptimizeOptions {}

// === JSON entry schemas ====================================================

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
  workspaces?: string[]
  bundleDependencies?: string[] | boolean
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
}

// Per-NodeId sidecar shared by every flat-family adapter (npm-2 + npm-3).
// Fields here are layout-agnostic; npm-2-only mirror-emit recovery state
// lives in a SEPARATE WeakMap maintained by `_npm-2-mirror.ts`.
export interface NpmFlatSidecar {
  installPaths: string[]
  inBundle?: boolean
  dev?: boolean
  optional?: boolean
  peer?: boolean
  peerDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

export interface NpmSidecar {
  rootId?: string
  rootMeta?: NpmRootMeta
  // Edge-level: range record per edgeTripleKey(src, kind, dst).
  edgeRanges: Map<string, string>
  // Edge-level: declared dep-name in the source manifest. Differs from
  // dst.name when the consumer imports via an `npm:` alias or a workspace
  // symlink. Used by stringify to round-trip the consumer's import-name.
  edgeDeclaredNames: Map<string, string>
  // Node-level sidecar keyed by NodeId.
  nodes: Map<string, NpmFlatSidecar>
  // Workspace member path lookup: workspacePath -> NodeId.
  workspaceByPath: Map<string, string>
}
