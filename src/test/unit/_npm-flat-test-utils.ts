// _npm-flat-test-utils.ts — genuine shared helpers for npm-flat-family tests.
//
// Holds fixture IO, graph snapshot helpers, the adapter/spec types, and a
// couple of convenience wrappers. NO describe()/it() blocks here — those
// live in `_npm-flat-suite.ts`. Splitting the utilities out keeps the
// suite file focused on test registration and the utils importable from
// per-version delta tests without dragging the full suite in.

import { expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { type Diagnostic, type Graph, type GraphDiff } from '../../main/ts/graph.ts'

const here = dirname(fileURLToPath(import.meta.url))

export const fixture = (rel: string): string =>
  readFileSync(resolve(here, '../resources/fixtures/lockfiles', rel), 'utf8')

// Phase §A working fixture set per ADR-0021 §"Acceptance gate — per-version".
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

export function graphSnapshot(graph: Graph) {
  return {
    nodes: Array.from(graph.nodes(), node => ({ ...node })),
    edges: Array.from(graph.nodes(), node =>
      graph.out(node.id).map(edge => ({
        src: edge.src,
        dst: edge.dst,
        kind: edge.kind,
        attrs: edge.attrs === undefined ? undefined : { ...edge.attrs },
      })),
    ).flat(),
    tarballs: Array.from(graph.tarballs(), ([key, payload]) => [key, payload] as const),
  }
}

export function expectEmptyGraphDiff(diff: GraphDiff): void {
  expect(diff).toEqual({
    addedNodes: [],
    removedNodes: [],
    changedNodes: [],
    addedEdges: [],
    removedEdges: [],
  })
}

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
  const diagnostics: Diagnostic[] = []
  const lockfile = spec.adapter.stringify(graph, {
    onDiagnostic(diagnostic) {
      diagnostics.push(diagnostic)
    },
  })
  return { lockfile, diagnostics }
}
