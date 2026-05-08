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
  lockfileVersion: 5,
  defaultCacheKey: '8',
  codePrefix: 'YARN_BERRY_V5',
  rangeEmit: 'bare',
  checksumPrefix: false,
  conditionsAllowed: true,
} as const

export interface YarnBerryParseOptions extends YarnBerryFamilyParseOptions {}
export interface YarnBerryStringifyOptions extends YarnBerryFamilyStringifyOptions {}
export interface YarnBerryEnrichOptions extends YarnBerryFamilyEnrichOptions {}
export interface YarnBerryOptimizeOptions extends YarnBerryFamilyOptimizeOptions {}

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
