// npm-3 adapter — npm `package-lock.json` lockfileVersion 3.
//
// Thin entry that threads the npm-3 config through `_npm-core.ts`:
//   - lockfileVersion: 3
//   - topLevelShape: 'packages-only' (no legacy `dependencies` mirror; a
//     mirror, if present, surfaces NPM_V3_UNEXPECTED_LEGACY_MIRROR)
//   - diagnosticPrefix: 'NPM_V3'
//
// All §A/§B/§C/§D behaviour lives in `_npm-core.ts` per ADR-0021 §5 core
// extraction. This module is the public surface only.

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

const CONFIG: NpmFamilyConfig = {
  lockfileVersion: 3,
  topLevelShape: 'packages-only',
  diagnosticPrefix: 'NPM_V3',
}

export interface Npm3ParseOptions extends NpmFamilyParseOptions {}
export interface Npm3StringifyOptions extends NpmFamilyStringifyOptions {}
export interface Npm3EnrichOptions extends NpmFamilyEnrichOptions {}
export interface Npm3OptimizeOptions extends NpmFamilyOptimizeOptions {}

export function check(input: string): boolean {
  return checkFamily(input, CONFIG)
}

export function parse(input: string, options: Npm3ParseOptions = {}): Graph {
  return parseFamily(input, options, CONFIG)
}

export function stringify(graph: Graph, options: Npm3StringifyOptions = {}): string {
  return stringifyFamily(graph, CONFIG, options)
}

export function enrich(
  graph: Graph,
  options: Npm3EnrichOptions = {},
): { graph: Graph; diagnostics: Diagnostic[] } {
  return enrichFamily(graph, CONFIG, options)
}

export function optimize(
  graph: Graph,
  options: Npm3OptimizeOptions = {},
): { graph: Graph; diagnostics: Diagnostic[] } {
  return optimizeFamily(graph, CONFIG, options)
}
