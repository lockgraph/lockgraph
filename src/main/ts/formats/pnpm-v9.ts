// pnpm-v9 adapter — pnpm `pnpm-lock.yaml` lockfileVersion 9.0.
//
// Thin entry threading the `v9-importers-snapshots` profile through
// `_pnpm-flat-core.ts`. Per ADR-0022 §5 mining strategy r2 — extraction
// round (mirrors npm-flat family core-extraction precedent). All
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

const PROFILE: PnpmLayoutProfile = { profile: 'v9-importers-snapshots' }

export interface PnpmV9ParseOptions extends PnpmFamilyParseOptions {}
export interface PnpmV9StringifyOptions extends PnpmFamilyStringifyOptions {}
export interface PnpmV9EnrichOptions extends PnpmFamilyEnrichOptions {}
export interface PnpmV9OptimizeOptions extends PnpmFamilyOptimizeOptions {}

export interface PnpmV9Manifest extends PnpmManifest {}
export interface PnpmV9Settings extends PnpmSettings {}

export function check(input: string): boolean {
  return checkFamily(input, PROFILE)
}

export function parse(input: string, options: PnpmV9ParseOptions = {}): Graph {
  return parseFamily(input, options, PROFILE)
}

export function stringify(graph: Graph, options: PnpmV9StringifyOptions = {}): string {
  return stringifyFamily(graph, PROFILE, options)
}

export function enrich(
  graph: Graph,
  options: PnpmV9EnrichOptions = {},
): { graph: Graph; diagnostics: Diagnostic[] } {
  return enrichFamily(graph, PROFILE, options)
}

export function optimize(
  graph: Graph,
  options: PnpmV9OptimizeOptions = {},
): { graph: Graph; diagnostics: Diagnostic[] } {
  return optimizeFamily(graph, PROFILE, options)
}
