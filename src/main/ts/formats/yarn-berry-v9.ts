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

const CONFIG = {
  lockfileVersion: 9,
  codePrefix: 'YARN_BERRY_V9',
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
