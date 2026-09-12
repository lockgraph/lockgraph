// _npm-flat-test-utils.ts — npm-flat-family spec metadata + per-family wrappers.
//
// Re-exports family-agnostic helpers from `src/test/helpers/lockfile-test-utils.ts`
// and adds the npm-flat-specific spec type + fixture catalogue. NO
// describe()/it() registrations — those live in `_npm-flat-suite.ts`.
//
// Resolves r1 collab F3 — eliminates near-duplicate helper code by
// hoisting фaмily-agnostic utilities к a neutral location.

import { type Diagnostic, type Graph } from '../../main/ts/graph.ts'
import {
  fixture,
  graphSnapshot,
  expectEmptyGraphDiff,
  stringifyWithDiagnostics as sharedStringifyWithDiagnostics,
} from '../helpers/lockfile-test-utils.ts'

export { fixture, graphSnapshot, expectEmptyGraphDiff }

// Phase §A working fixture set per §"Acceptance gate — per-version".
export const FIXTURES = [
  'bundled-deps',
  'deps-with-scopes',
  'git-github-tarball',
  'peers-basic',
  'peers-multi',
  'simple',
  'workspaces-basic',
  'yarn-crlf',
] as const

export type FixtureName = typeof FIXTURES[number]

export interface FlatFamilyAdapter {
  check(input: string): boolean
  parse(input: string, options?: { onDiagnostic?: (d: Diagnostic) => void }): Graph
  stringify(graph: Graph, options?: { lineEnding?: 'lf' | 'crlf'; onDiagnostic?: (d: Diagnostic) => void }): string
  enrich(graph: Graph, options?: {}): { graph: Graph; diagnostics: Diagnostic[] }
  optimize(graph: Graph, options?: {}): { graph: Graph; diagnostics: Diagnostic[] }
}

export interface FlatFamilySpec {
  /** Display label, e.g. 'npm-2', 'npm-3'. */
  label: string
  /** Lockfile version number used in JSON. */
  lockfileVersion: 2 | 3
  /** Diagnostic prefix, e.g. 'NPM_V2', 'NPM_V3'. */
  diagPrefix: 'NPM_V2' | 'NPM_V3'
  /** Fixture file extension (matches the version slug). */
  fixtureSuffix: 'npm-2.lock' | 'npm-3.lock'
  /** Adapter under test. */
  adapter: FlatFamilyAdapter
  /** Cross-version rejection probe: lockfiles whose parsers MUST reject the version's input. */
  crossAdapterRejectExtra?: ReadonlyArray<(input: string) => unknown>
}

export function parseFixtureGraph(spec: FlatFamilySpec, name: FixtureName): Graph {
  return spec.adapter.parse(fixture(`${name}/${spec.fixtureSuffix}`))
}

export function stringifyWithDiagnostics(
  spec: FlatFamilySpec,
  graph: Graph,
): { lockfile: string; diagnostics: Diagnostic[] } {
  return sharedStringifyWithDiagnostics(spec.adapter, graph)
}
