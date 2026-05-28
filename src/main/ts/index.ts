// Public surface — ADR-0014 §3.
//
// Exposes both the `convert()` sugar и the underlying primitives
// (`parse / stringify / check / detect`). Recipe-layer normalisation
// (ADR-0014 §4) lands per-feature in subsequent implementer rounds —
// this skeleton dispatches to existing adapter parse / stringify
// hooks без plumbing recipe primitives yet.

import type { Diagnostic, Graph } from './graph.ts'

import * as bunText      from './formats/bun-text.ts'
import * as npm1         from './formats/npm-1.ts'
import * as npm2         from './formats/npm-2.ts'
import * as npm3         from './formats/npm-3.ts'
import * as pnpmV5       from './formats/pnpm-v5.ts'
import * as pnpmV6       from './formats/pnpm-v6.ts'
import * as pnpmV9       from './formats/pnpm-v9.ts'
import * as yarnBerryV4  from './formats/yarn-berry-v4.ts'
import * as yarnBerryV5  from './formats/yarn-berry-v5.ts'
import * as yarnBerryV6  from './formats/yarn-berry-v6.ts'
import * as yarnBerryV7  from './formats/yarn-berry-v7.ts'
import * as yarnBerryV8  from './formats/yarn-berry-v8.ts'
import * as yarnBerryV9  from './formats/yarn-berry-v9.ts'
import * as yarnClassic  from './formats/yarn-classic.ts'

export const version = '0.0.0'

export { LockfileError, type LockfileErrorCode } from './errors.ts'
export type { Diagnostic, Graph } from './graph.ts'

// Registry adapter contract (Phase C) — re-exported for caller-side
// frozen-registry construction and live-adapter authoring. Phase D-A
// adds `liveRegistry` (HTTPS-backed) alongside the offline frozen
// reference impl; Phase D-B adds the filesystem CacheAdapter family —
// `fsCache` over yarn-berry `.yarn/cache/`, `npmCache` over the
// cacache CAS under `~/.npm/_cacache/`, and `pnpmCache` over the
// pnpm content-addressable store under `~/.pnpm-store/v3/`. All
// honour the same registry/cache adapter shapes.
export { frozenRegistry } from './registry/frozen.ts'
export { liveRegistry, type LiveRegistryOptions } from './registry/live.ts'
export { fsCache, type FsCacheOptions } from './registry/cache.ts'
export { npmCache, type NpmCacheOptions } from './registry/cache-npm.ts'
export { pnpmCache, type PnpmCacheOptions } from './registry/cache-pnpm.ts'
export type {
  CacheAdapter,
  Packument,
  PackumentVersion,
  RegistryAdapter,
} from './registry/types.ts'

// ADR-0023 §8.2 — `modify()` orchestrator + its `Primitive` discriminated
// union and unified `ModifyResult` shape. The orchestrator is the single
// dispatch entry point for the modifier vocabulary; per-primitive functions
// remain individually importable via `@antongolub/lockfile/modify`.
export { modify } from './modify/modify.ts'
export type {
  ModifyResult,
  ModifyResultBase,
  Primitive,
} from './modify/modify.ts'
export type {
  ModifyContext,
  ModifyOptions,
} from './modify/context.ts'

// ADR-0024 — `optimize()` post-completion, pre-stringify orphan GC.
// Monotone-reductive: removes unreachable nodes from the
// roots/workspaces/preserve mark-set, never adds. Per-primitive importable
// via `@antongolub/lockfile/optimize`.
export { optimize } from './optimize/optimize.ts'
export type { OptimizeOptions, OptimizeResult } from './optimize/optimize.ts'

export type FormatId =
  | 'yarn-berry-v4'
  | 'yarn-berry-v5'
  | 'yarn-berry-v6'
  | 'yarn-berry-v7'
  | 'yarn-berry-v8'
  | 'yarn-berry-v9'
  | 'yarn-classic'
  | 'npm-1'
  | 'npm-2'
  | 'npm-3'
  | 'pnpm-v5'
  | 'pnpm-v6'
  | 'pnpm-v9'
  | 'bun-text'

// NOTE: per ADR-0014 §3 the public surface also lists `Manifest`,
// `ResolutionCanonical`, `WorkspaceRange` types и a `manifests?` option
// on Parse/ConvertOptions. These land с the recipe-layer primitive rounds
// (F1-F5 per §4); authoring them aspirationally в this skeleton would
// publish types that don't exist в owning modules yet и a dead option
// that parseOne can't consume. Held back until the recipe primitives land.

export type ParseOptions = {
  /**
   * Filesystem root для adapter parse hooks that read out-of-lockfile
   * sources (yarn-berry / pnpm v6 / pnpm v9 patch byte hashing per
   * ADR-0014 §4.F2). Adapters without out-of-lockfile reads ignore it.
   */
  workspaceRoot?: string
  onDiagnostic?:  (d: Diagnostic) => void
}

export type StringifyOptions = {
  lineEnding?:   'lf' | 'crlf'
  cacheKey?:     string
  onDiagnostic?: (d: Diagnostic) => void
}

export type ConvertOptions = {
  to:             FormatId
  from?:          FormatId
  workspaceRoot?: string
  lineEnding?:    'lf' | 'crlf'
  cacheKey?:      string
  onDiagnostic?:  (d: Diagnostic) => void
}

// Ordered so first-match wins на ambiguous head. Disjoint в practice —
// adapter `check()` probes are version-pinned (yarn-berry `version: N`,
// npm `lockfileVersion: N`, pnpm `lockfileVersion: '<v>'`) — но guard
// against future loosening with newest-first / family-distinctive-first.
const DETECT_ORDER: readonly FormatId[] = [
  'bun-text',
  'yarn-berry-v9',
  'yarn-berry-v8',
  'yarn-berry-v7',
  'yarn-berry-v6',
  'yarn-berry-v5',
  'yarn-berry-v4',
  'pnpm-v9',
  'pnpm-v6',
  'pnpm-v5',
  'yarn-classic',
  'npm-3',
  'npm-2',
  'npm-1',
]

function checkOne(format: FormatId, input: string): boolean {
  switch (format) {
    case 'bun-text':      return bunText.check(input)
    case 'npm-1':         return npm1.check(input)
    case 'npm-2':         return npm2.check(input)
    case 'npm-3':         return npm3.check(input)
    case 'pnpm-v5':       return pnpmV5.check(input)
    case 'pnpm-v6':       return pnpmV6.check(input)
    case 'pnpm-v9':       return pnpmV9.check(input)
    case 'yarn-berry-v4': return yarnBerryV4.check(input)
    case 'yarn-berry-v5': return yarnBerryV5.check(input)
    case 'yarn-berry-v6': return yarnBerryV6.check(input)
    case 'yarn-berry-v7': return yarnBerryV7.check(input)
    case 'yarn-berry-v8': return yarnBerryV8.check(input)
    case 'yarn-berry-v9': return yarnBerryV9.check(input)
    case 'yarn-classic':  return yarnClassic.check(input)
  }
}

function parseOne(format: FormatId, input: string, options: ParseOptions): Graph {
  const workspaceRoot = options.workspaceRoot
  switch (format) {
    case 'bun-text':      return bunText.parse(input)
    case 'npm-1':         return npm1.parse(input)
    case 'npm-2':         return npm2.parse(input)
    case 'npm-3':         return npm3.parse(input)
    case 'pnpm-v5':       return pnpmV5.parse(input)
    case 'pnpm-v6':       return pnpmV6.parse(input, { workspaceRoot })
    case 'pnpm-v9':       return pnpmV9.parse(input, { workspaceRoot })
    case 'yarn-berry-v4': return yarnBerryV4.parse(input, { workspaceRoot })
    case 'yarn-berry-v5': return yarnBerryV5.parse(input, { workspaceRoot })
    case 'yarn-berry-v6': return yarnBerryV6.parse(input, { workspaceRoot })
    case 'yarn-berry-v7': return yarnBerryV7.parse(input, { workspaceRoot })
    case 'yarn-berry-v8': return yarnBerryV8.parse(input, { workspaceRoot })
    case 'yarn-berry-v9': return yarnBerryV9.parse(input, { workspaceRoot })
    case 'yarn-classic':  return yarnClassic.parse(input)
  }
}

function stringifyOne(format: FormatId, graph: Graph, options: StringifyOptions): string {
  const lineEnding   = options.lineEnding
  const onDiagnostic = options.onDiagnostic
  const cacheKey     = options.cacheKey
  switch (format) {
    case 'bun-text':      return bunText.stringify(graph,     { lineEnding, onDiagnostic })
    case 'npm-1':         return npm1.stringify(graph,        { lineEnding, onDiagnostic })
    case 'npm-2':         return npm2.stringify(graph,        { lineEnding, onDiagnostic })
    case 'npm-3':         return npm3.stringify(graph,        { lineEnding, onDiagnostic })
    case 'pnpm-v5':       return pnpmV5.stringify(graph,      { lineEnding, onDiagnostic })
    case 'pnpm-v6':       return pnpmV6.stringify(graph,      { lineEnding, onDiagnostic })
    case 'pnpm-v9':       return pnpmV9.stringify(graph,      { lineEnding, onDiagnostic })
    case 'yarn-berry-v4': return yarnBerryV4.stringify(graph, { lineEnding, cacheKey, onDiagnostic })
    case 'yarn-berry-v5': return yarnBerryV5.stringify(graph, { lineEnding, cacheKey, onDiagnostic })
    case 'yarn-berry-v6': return yarnBerryV6.stringify(graph, { lineEnding, cacheKey, onDiagnostic })
    case 'yarn-berry-v7': return yarnBerryV7.stringify(graph, { lineEnding, cacheKey, onDiagnostic })
    case 'yarn-berry-v8': return yarnBerryV8.stringify(graph, { lineEnding, cacheKey, onDiagnostic })
    case 'yarn-berry-v9': return yarnBerryV9.stringify(graph, { lineEnding, cacheKey, onDiagnostic })
    case 'yarn-classic':  return yarnClassic.stringify(graph, { lineEnding, onDiagnostic })
  }
}

export function check(format: FormatId, input: string): boolean {
  return checkOne(format, input)
}

export function detect(input: string): FormatId | undefined {
  for (const format of DETECT_ORDER) {
    if (checkOne(format, input)) return format
  }
  return undefined
}

export function parse(format: FormatId, input: string, options: ParseOptions = {}): Graph {
  const graph = parseOne(format, input, options)
  if (options.onDiagnostic !== undefined) {
    for (const d of graph.diagnostics()) options.onDiagnostic(d)
  }
  return graph
}

export function stringify(format: FormatId, graph: Graph, options: StringifyOptions = {}): string {
  return stringifyOne(format, graph, options)
}

export function convert(input: string, options: ConvertOptions): string {
  const from = options.from ?? detect(input)
  if (from === undefined) throw new Error('convert: source format not detected')
  const graph = parse(from, input, {
    workspaceRoot: options.workspaceRoot,
    onDiagnostic:  options.onDiagnostic,
  })
  return stringify(options.to, graph, {
    lineEnding:   options.lineEnding,
    cacheKey:     options.cacheKey,
    onDiagnostic: options.onDiagnostic,
  })
}
