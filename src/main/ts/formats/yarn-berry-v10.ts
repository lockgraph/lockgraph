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
// Bumped in `Project.ts` (LOCKFILE_VERSION constant) ahead of yarn 5 GA. Structural
// body is identical to v9 at the time of this adapter's introduction —
// the bump is mechanical (`version: N` field only). Family config tracks
// v9 verbatim: `quoted-protocol` range emit, `cachekey-prefixed` checksum,
// `conditions:` block permitted on entries. When yarn 5 ships a real
// structural change in the lockfile body, fork the family config from this
// constant rather than re-pointing v10 to share v9's identity.
const CONFIG = {
  lockfileVersion: 10,
  codePrefix: 'YARN_BERRY_V10',
  rangeEmit: 'quoted-protocol',
  checksumPrefix: true,
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
