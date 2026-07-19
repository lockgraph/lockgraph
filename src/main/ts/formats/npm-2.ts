// npm-2 adapter — npm `package-lock.json` lockfileVersion 2 (dual mode).
//
// Thin entry that wires the npm-2 config + dual-mode hooks through
// `_npm-core.ts`:
//   - lockfileVersion: 2
//   - topLevelShape: 'dual' (BOTH `packages` AND `dependencies` keys at
//     top level; per ADR-0021 §A.npm-2). `packages` is authoritative;
//     the `dependencies` block is an npm-1-style legacy nested-tree
//     mirror retained for npm v6 back-compat readers.
//   - diagnosticPrefix: 'NPM_V2'
//   - hooks: NPM2_HOOKS from `_npm-2-mirror.ts` (dual-mode validation,
//     drift detection, `resolved`-URL recovery, legacy-mirror emit)
//
// Dependency direction (cycle-break): npm-2.ts imports BOTH core
// and mirror. Core does NOT import mirror; mirror does NOT import core.
// Both depend on `_npm-flat-types.ts` for shared types only. The npm-1
// adapter reuses core without pulling in npm-2 mirror baggage.

import type { Diagnostic, Graph } from '../graph.ts'
import {
  checkFamily,
  enrichFamily,
  optimizeFamily,
  parseFamily,
  stringifyFamily,
  type NpmFamilyConfig,
  type NpmFamilyEnrichOptions,
  type NpmFamilyOptimizeOptions,
  type NpmFamilyParseOptions,
  type NpmFamilyStringifyOptions,
} from './_npm-core.ts'
import { NPM2_HOOKS } from './_npm-2-mirror.ts'

const CONFIG: NpmFamilyConfig = {
  lockfileVersion: 2,
  topLevelShape: 'dual',
  diagnosticPrefix: 'NPM_V2',
  hooks: NPM2_HOOKS,
}

export type Npm2ParseOptions = NpmFamilyParseOptions
export type Npm2StringifyOptions = NpmFamilyStringifyOptions
export type Npm2EnrichOptions = NpmFamilyEnrichOptions
export type Npm2OptimizeOptions = NpmFamilyOptimizeOptions

export function check(input: string): boolean {
  return checkFamily(input, CONFIG)
}

export function parse(input: string, options: Npm2ParseOptions = {}): Graph {
  return parseFamily(input, options, CONFIG)
}

export function stringify(graph: Graph, options: Npm2StringifyOptions = {}): string {
  return stringifyFamily(graph, CONFIG, options)
}

export function enrich(
  graph: Graph,
  options: Npm2EnrichOptions = {},
): { graph: Graph; diagnostics: Diagnostic[] } {
  return enrichFamily(graph, CONFIG, options)
}

export function optimize(
  graph: Graph,
  options: Npm2OptimizeOptions = {},
): { graph: Graph; diagnostics: Diagnostic[] } {
  return optimizeFamily(graph, CONFIG, options)
}
