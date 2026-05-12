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
//   - `packages` map: keys `/<name>@<version>` (slash-leading) или
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

const PROFILE: PnpmLayoutProfile = { profile: 'v6-collapsed-root' }

export interface PnpmV6ParseOptions extends PnpmFamilyParseOptions {}
export interface PnpmV6StringifyOptions extends PnpmFamilyStringifyOptions {}
export interface PnpmV6EnrichOptions extends PnpmFamilyEnrichOptions {}
export interface PnpmV6OptimizeOptions extends PnpmFamilyOptimizeOptions {}

export interface PnpmV6Manifest extends PnpmManifest {}
export interface PnpmV6Settings extends PnpmSettings {}

export function check(input: string): boolean {
  return checkFamily(input, PROFILE)
}

export function parse(input: string, options: PnpmV6ParseOptions = {}): Graph {
  return parseFamily(input, options, PROFILE)
}

export function stringify(graph: Graph, options: PnpmV6StringifyOptions = {}): string {
  return stringifyFamily(graph, PROFILE, options)
}

export function enrich(
  graph: Graph,
  options: PnpmV6EnrichOptions = {},
): { graph: Graph; diagnostics: Diagnostic[] } {
  return enrichFamily(graph, PROFILE, options)
}

export function optimize(
  graph: Graph,
  options: PnpmV6OptimizeOptions = {},
): { graph: Graph; diagnostics: Diagnostic[] } {
  return optimizeFamily(graph, PROFILE, options)
}
