// _pnpm-flat-test-utils.ts — pnpm-flat-family spec metadata + per-family wrappers.
//
// Re-exports family-agnostic helpers from `src/test/helpers/lockfile-test-utils.ts`
// and adds the pnpm-flat-specific spec type + fixture catalogue. NO
// describe()/it() registrations — those live in `_pnpm-flat-suite.ts`.
//
// Resolves r1 collab F3 — eliminates near-duplicate helper code by
// hoisting family-agnostic utilities к a neutral location.

import { type Diagnostic, type Graph } from '../../main/ts/graph.ts'
import {
  fixture,
  graphSnapshot,
  expectEmptyGraphDiff,
  templateRootOf,
  stringifyWithDiagnostics as sharedStringifyWithDiagnostics,
} from '../helpers/lockfile-test-utils.ts'

export { fixture, graphSnapshot, expectEmptyGraphDiff, templateRootOf }

// 8-fixture matrix per ADR-0022 §A.pnpm-* acceptance gate.
export const FIXTURES = [
  'simple',
  'peers-basic',
  'peers-multi',
  'deps-with-scopes',
  'workspaces-basic',
  'workspace-cross-refs',
  'patch-yarn',
  'yarn-crlf',
] as const

export type FixtureName = typeof FIXTURES[number]

export interface PnpmFamilyAdapter {
  check(input: string): boolean
  parse(input: string, options?: { workspaceRoot?: string; onDiagnostic?: (d: Diagnostic) => void }): Graph
  stringify(graph: Graph, options?: { lineEnding?: 'lf' | 'crlf'; onDiagnostic?: (d: Diagnostic) => void }): string
  enrich(graph: Graph, options?: { manifests?: Record<string, any> }): { graph: Graph; diagnostics: Diagnostic[] }
  optimize(graph: Graph, options?: {}): { graph: Graph; diagnostics: Diagnostic[] }
}

export interface PnpmFamilySpec {
  /** Display label, e.g. 'pnpm-v6', 'pnpm-v9'. */
  label: string
  /** Lockfile version literal (quoted string scalar). */
  lockfileVersion: '6.0' | '9.0'
  /** Diagnostic prefix per ADR-0022. */
  diagPrefix: 'PNPM_V6' | 'PNPM_V9'
  /** Fixture file extension (matches the version slug). */
  fixtureSuffix: 'pnpm-v6.lock' | 'pnpm-v9.lock'
  /** Adapter under test. */
  adapter: PnpmFamilyAdapter
  /** Cross-version sibling fixture suffixes that this adapter must reject. */
  crossVersionRejects: ReadonlyArray<'pnpm-v5.lock' | 'pnpm-v6.lock' | 'pnpm-v9.lock'>
}

export function parseFixtureGraph(spec: PnpmFamilySpec, name: FixtureName): Graph {
  // Thread workspaceRoot so the family-common patch-yarn fixture exercises
  // canonical byte hashing (ADR-0014 §4.F2) rather than the sentinel
  // fallback. A workspaceRoot pointing at a fixture без `.yarn/patches/`
  // is a no-op for patch-free fixtures.
  return spec.adapter.parse(
    fixture(`${name}/${spec.fixtureSuffix}`),
    { workspaceRoot: templateRootOf(name) },
  )
}

export function stringifyWithDiagnostics(
  spec: PnpmFamilySpec,
  graph: Graph,
): { lockfile: string; diagnostics: Diagnostic[] } {
  return sharedStringifyWithDiagnostics(spec.adapter, graph)
}
