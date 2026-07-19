import type { Diagnostic, Graph } from '../graph.ts'
import {
  checkFamily,
  enrichFamily,
  optimizeFamily,
  parseFamily,
  stringifyFamily,
  type YarnBerryFamilyEnrichOptions,
  type YarnBerryFamilyOptimizeOptions,
  type YarnBerryFamilyParseOptions,
  type YarnBerryFamilyStringifyOptions,
} from './_yarn-berry-core.ts'

// `__metadata.version: 10` — yarn 5 dev-branch / yarnpkg-berry master.
// The structural body currently matches v9; the bump is mechanical (`version:
// N` only). Family config tracks v9's `quoted-protocol` range emit,
// `cachekey-prefixed` checksum, and permitted `conditions:` block, but remains
// separately owned so future v10 changes cannot alter v9 identity.
const CONFIG = {
  lockfileVersion: 10,
  codePrefix: 'YARN_BERRY_V10',
  rangeEmit: 'quoted-protocol',
  checksumPrefix: true,
  conditionsAllowed: true,
} as const

export type YarnBerryParseOptions = YarnBerryFamilyParseOptions
export type YarnBerryStringifyOptions = YarnBerryFamilyStringifyOptions
export type YarnBerryEnrichOptions = YarnBerryFamilyEnrichOptions
export type YarnBerryOptimizeOptions = YarnBerryFamilyOptimizeOptions

export function check(input: string): boolean {
  return checkFamily(input, CONFIG)
}

export function parse(input: string, options: YarnBerryParseOptions = {}): Graph {
  return parseFamily(input, options, CONFIG).graph
}

export function stringify(graph: Graph, options: YarnBerryStringifyOptions = {}): string {
  return stringifyFamily(graph, CONFIG, options).lockfile
}

export function enrich(
  graph: Graph,
  options: YarnBerryEnrichOptions = {},
): { graph: Graph; diagnostics: Diagnostic[] } {
  return enrichFamily(graph, CONFIG, options)
}

export function optimize(
  graph: Graph,
  options: YarnBerryOptimizeOptions = {},
): { graph: Graph; diagnostics: Diagnostic[] } {
  return optimizeFamily(graph, options)
}
