// pnpm-v9 adapter — pnpm `pnpm-lock.yaml` lockfileVersion 9.0.
//
// Thin entry threading the `v9-importers-snapshots` profile through
// `_pnpm-flat-core.ts`. Per ADR-0022 §5 mining strategy r2, the extraction
// mirrors the npm-flat family core boundary. All
// version-agnostic logic lives in `_pnpm-flat-core.ts`; this module owns
// the v9 profile + v9-specific option/result types.
//
// §A pinning per ADR-0022 §A.pnpm-v9:
//   - top-level `lockfileVersion: '9.0'` literal handshake (quoted string).
//   - top-level `settings` always emitted.
//   - top-level `importers` ALWAYS present (single-importer collapses to `.`).
//   - `packages` map: static manifest info, bare `name@version` keys.
//   - `snapshots` map: resolved tree info, peer-virt-disambiguated keys.
//   - Cross-block consistency: every `snapshots[id]` MUST have matching
//     `packages[bare-id]` baseline.

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

const CONFIG: PnpmLayoutProfile = { profile: 'v9-importers-snapshots' }

export type PnpmV9ParseOptions = PnpmFamilyParseOptions
export type PnpmV9StringifyOptions = PnpmFamilyStringifyOptions
export type PnpmV9EnrichOptions = PnpmFamilyEnrichOptions
export type PnpmV9OptimizeOptions = PnpmFamilyOptimizeOptions

export type PnpmV9Manifest = PnpmManifest
export type PnpmV9Settings = PnpmSettings

export function check(input: string): boolean {
  return checkFamily(input, CONFIG)
}

export function parse(input: string, options: PnpmV9ParseOptions = {}): Graph {
  return parseFamily(input, options, CONFIG)
}

export function stringify(graph: Graph, options: PnpmV9StringifyOptions = {}): string {
  return stringifyFamily(graph, CONFIG, options)
}

export function enrich(
  graph: Graph,
  options: PnpmV9EnrichOptions = {},
): { graph: Graph; diagnostics: Diagnostic[] } {
  return enrichFamily(graph, CONFIG, options)
}

export function optimize(
  graph: Graph,
  options: PnpmV9OptimizeOptions = {},
): { graph: Graph; diagnostics: Diagnostic[] } {
  return optimizeFamily(graph, CONFIG, options)
}
