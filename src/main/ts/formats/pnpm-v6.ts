// pnpm-v6 adapter — pnpm `pnpm-lock.yaml` lockfileVersion 6.0.
//
// Thin entry threading the `v6-collapsed-root` profile through
// `_pnpm-flat-core.ts`. Per ADR-0022 §A.pnpm-v6 — second pnpm-family
// adapter, anchored on the pre-snapshots-split schema (single packages
// block with inline transitives + dev flags).
//
// §A pinning per ADR-0022 §A.pnpm-v6:
//   - top-level `lockfileVersion: '6.0'` literal handshake (quoted string).
//   - top-level `settings` always emitted.
//   - top-level `dependencies` (collapsed single-importer) OR
//     `importers` (multi-importer workspaces).
//   - `packages` map: keys `/<name>@<version>` (slash-leading) or
//     `/<name>@<version>(peer@version)` (peer-virt directly on the key —
//     v9 carries this in `snapshots` block; v6 inlines it).
//   - NO `snapshots` block — transitives are inlined under each
//     `packages[id].dependencies`.
//   - `dev: false|true` per-entry flag (absent in v9).

import type { Diagnostic, Graph } from '../graph.ts'
import {
  checkFamily,
  enrichFamily,
  optimizeFamily,
  parseFamily,
  stringifyFamily,
  type PnpmFamilyEnrichOptions,
  type PnpmFamilyOptimizeOptions,
  type PnpmFamilyParseOptions,
  type PnpmFamilyStringifyOptions,
  type PnpmLayoutProfile,
  type PnpmManifest,
  type PnpmSettings,
} from './_pnpm-flat-core.ts'

const CONFIG: PnpmLayoutProfile = { profile: 'v6-collapsed-root' }

export type PnpmV6ParseOptions = PnpmFamilyParseOptions
export type PnpmV6StringifyOptions = PnpmFamilyStringifyOptions
export type PnpmV6EnrichOptions = PnpmFamilyEnrichOptions
export type PnpmV6OptimizeOptions = PnpmFamilyOptimizeOptions

export type PnpmV6Manifest = PnpmManifest
export type PnpmV6Settings = PnpmSettings

export function check(input: string): boolean {
  return checkFamily(input, CONFIG)
}

export function parse(input: string, options: PnpmV6ParseOptions = {}): Graph {
  return parseFamily(input, options, CONFIG)
}

export function stringify(graph: Graph, options: PnpmV6StringifyOptions = {}): string {
  return stringifyFamily(graph, CONFIG, options)
}

export function enrich(
  graph: Graph,
  options: PnpmV6EnrichOptions = {},
): { graph: Graph; diagnostics: Diagnostic[] } {
  return enrichFamily(graph, CONFIG, options)
}

export function optimize(
  graph: Graph,
  options: PnpmV6OptimizeOptions = {},
): { graph: Graph; diagnostics: Diagnostic[] } {
  return optimizeFamily(graph, CONFIG, options)
}
