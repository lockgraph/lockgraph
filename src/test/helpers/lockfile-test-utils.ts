// lockfile-test-utils.ts — family-agnostic test utilities for lockfile adapters.
//
// Hosts helpers that are identical across families (npm-flat, pnpm-flat,
// и future ones): fixture IO rooted at `src/test/resources/fixtures/lockfiles`,
// graph snapshot comparisons, diagnostic-collecting adapter calls.
// Family-specific concerns (spec types, fixture catalogues, version literals)
// live in the per-family `_*-flat-test-utils.ts` modules and import from
// here. Resolves r1 collab F3 — eliminates near-duplicate utilities across
// `_npm-flat-test-utils.ts` and `_pnpm-flat-test-utils.ts`.
//
// NO describe() / it() registrations live here — those belong in suite
// files (`_*-flat-suite.ts`).

import { expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { type Diagnostic, type Graph, type GraphDiff } from '../../main/ts/graph.ts'

const here = dirname(fileURLToPath(import.meta.url))
const fixturesRoot = resolve(here, '../resources/fixtures/lockfiles')
const templatesRoot = resolve(here, '../resources/fixtures/templates')

/** Read a lockfile fixture by `<scenario>/<adapter>.lock` relative path. */
export const fixture = (rel: string): string =>
  readFileSync(resolve(fixturesRoot, rel), 'utf8')

/**
 * Absolute path to the template workspace directory for a fixture name,
 * e.g. `templateRootOf('patch-yarn')` →
 * `src/test/resources/fixtures/templates/patch-yarn`. The template root
 * houses the `package.json` + `.yarn/patches/...` source the canonical
 * recipe needs for `+patch=<hash>` derivation; threading it через
 * `parseFixtureGraph` (см. `_pnpm-flat-test-utils.ts`) keeps the
 * family-common patch-yarn tests on the canonical byte-hashing path
 * rather than the sentinel fallback.
 */
export const templateRootOf = (name: string): string =>
  resolve(templatesRoot, name)

/**
 * Capture a deterministic snapshot of a graph for equality assertions.
 * Both nodes and edges are cloned; tarballs are cloned per-payload to
 * avoid reference-identity false-equals в `toEqual`.
 */
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
    tarballs: Array.from(graph.tarballs(), ([key, payload]) => [key, { ...payload }] as const),
  }
}

/** Assert that `graph.diff(other)` is the empty diff. */
export function expectEmptyGraphDiff(diff: GraphDiff): void {
  expect(diff).toEqual({
    addedNodes: [],
    removedNodes: [],
    changedNodes: [],
    addedEdges: [],
    removedEdges: [],
  })
}

/**
 * Minimal adapter shape that supports diagnostic collection через emit.
 * Per-family test helpers usually have richer adapter shapes; this is
 * the narrow contract `stringifyWithDiagnostics` needs.
 */
export interface AdapterWithDiagnosticStringify {
  stringify(
    graph: Graph,
    options?: { onDiagnostic?: (d: Diagnostic) => void; lineEnding?: 'lf' | 'crlf' },
  ): string
}

/**
 * Call `adapter.stringify(graph)`, collecting diagnostics emitted through
 * the `onDiagnostic` callback. Returns both the emitted text and the
 * collected diagnostics list.
 */
export function stringifyWithDiagnostics(
  adapter: AdapterWithDiagnosticStringify,
  graph: Graph,
): { lockfile: string; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = []
  const lockfile = adapter.stringify(graph, {
    onDiagnostic(diagnostic) {
      diagnostics.push(diagnostic)
    },
  })
  return { lockfile, diagnostics }
}
