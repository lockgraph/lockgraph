// bun-text npm-alias identity. bun keys BOTH the dependency maps (`workspaces`
// and the `packages` inner blocks) and the `packages` entry itself by the
// DECLARED name, while the tuple id slot carries the resolved
// `<name>@<version>`. The declared name therefore has to ride the canonical
// graph as `EdgeAttrs.alias` — it is not derivable from the target
// node. Fixtures under `resources/fixtures/alias/bun-1.3.14-*` are verbatim,
// unedited output of the pinned `bun` 1.3.14 devDependency.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { newBuilder, type Edge, type Graph } from '../../main/ts/graph.ts'
import { parse, stringify } from '../../main/ts/formats/bun-text.ts'
import {
  parse as parseStrict,
  stringify as stringifyStrict,
} from '../../main/ts/index.ts'

const here = dirname(fileURLToPath(import.meta.url))
const aliasFixture = (slug: string): string =>
  readFileSync(resolve(here, `../resources/fixtures/alias/${slug}/bun.lock`), 'utf8')

const WORKSPACE_ALIAS = aliasFixture('bun-1.3.14-workspace-alias')
const WORKSPACE_ALIAS_MIXED = aliasFixture('bun-1.3.14-workspace-alias-mixed')
const TRANSITIVE_ALIAS = aliasFixture('bun-1.3.14-transitive-alias')
const DUPLICATE_DECLARATION = aliasFixture('bun-1.3.14-duplicate-declaration')

const edgeTo = (graph: Graph, src: string, dst: string): Edge | undefined =>
  graph.out(src).find(e => e.dst === dst)

const dependenciesOf = (lock: string, workspacePath: string): Record<string, string> =>
  JSON.parse(lock.replace(/,(\s*[}\]])/g, '$1')).workspaces[workspacePath].dependencies

const packagesOf = (lock: string): Record<string, unknown[]> =>
  JSON.parse(lock.replace(/,(\s*[}\]])/g, '$1')).packages

const packageEntryOf = (lock: string, packagesKey: string): unknown[] => {
  const entry = packagesOf(lock)[packagesKey]
  expect(entry, `packages[${JSON.stringify(packagesKey)}]`).toBeDefined()
  return entry!
}

const innerDependenciesOf = (lock: string, packagesKey: string): Record<string, string> =>
  (packageEntryOf(lock, packagesKey)[2] as { dependencies: Record<string, string> }).dependencies

describe('parse', () => {
  it('records the declared alias name on a workspace dependency edge', () => {
    const graph = parse(WORKSPACE_ALIAS)
    const edge = edgeTo(graph, 'f@0.0.0', '@yarnpkg/cli-dist@4.17.1')
    expect(edge?.attrs?.alias).toBe('pm-x')
  })

  it('resolves an aliased workspace dependency to the canonical package identity', () => {
    const graph = parse(WORKSPACE_ALIAS)
    expect([...graph.nodes()].map(n => n.id).sort())
      .toEqual(['@yarnpkg/cli-dist@4.17.1', 'f@0.0.0'])
    const edge = edgeTo(graph, 'f@0.0.0', '@yarnpkg/cli-dist@4.17.1')
    expect(edge?.attrs?.range).toBe('npm:@yarnpkg/cli-dist@4.17.1')
  })

  it('leaves a non-aliased sibling in the same dependency map without an alias slot', () => {
    const graph = parse(WORKSPACE_ALIAS_MIXED)
    expect(edgeTo(graph, 'f@0.0.0', 'chalk@5.3.0')?.attrs?.alias).toBeUndefined()
    expect(edgeTo(graph, 'f@0.0.0', '@yarnpkg/cli-dist@4.17.1')?.attrs?.alias).toBe('pm-x')
  })

  it('records the declared alias name on a package inner-block dependency edge', () => {
    const graph = parse(TRANSITIVE_ALIAS)
    const src = '@isaacs/cliui@8.0.2'
    expect(edgeTo(graph, src, 'string-width@4.2.3')?.attrs?.alias).toBe('string-width-cjs')
    expect(edgeTo(graph, src, 'strip-ansi@6.0.1')?.attrs?.alias).toBe('strip-ansi-cjs')
    expect(edgeTo(graph, src, 'wrap-ansi@7.0.0')?.attrs?.alias).toBe('wrap-ansi-cjs')
    // Non-aliased siblings resolved out of the same inner block.
    expect(edgeTo(graph, src, 'string-width@5.1.2')?.attrs?.alias).toBeUndefined()
    expect(edgeTo(graph, src, 'strip-ansi@7.2.0')?.attrs?.alias).toBeUndefined()
    expect(edgeTo(graph, src, 'wrap-ansi@8.1.0')?.attrs?.alias).toBeUndefined()
  })

  it('admits one consumer declaring the same target canonically and under an alias', () => {
    // `metro-source-map` depends on `@babel/traverse` twice — bare and as
    // `@babel/traverse--for-generate-function-map` — and both bind the same
    // NodeId. `alias` is the 4th component of edge identity, so without it the
    // two declarations collapse to one edge key and seal rejects the lock.
    const graph = parse(DUPLICATE_DECLARATION)
    const src = 'metro-source-map@0.83.3'
    const edges = graph.out(src).filter(e => e.dst === '@babel/traverse@7.29.8')
    expect(edges.map(e => e.attrs?.alias).sort())
      .toEqual(['@babel/traverse--for-generate-function-map', undefined])
    expect(edges.map(e => e.attrs?.range).sort())
      .toEqual(['^7.25.3', 'npm:@babel/traverse@^7.25.3'])
  })
})

describe('stringify', () => {
  it('keys the workspace dependency map by the declared alias name', () => {
    const out = stringify(parse(WORKSPACE_ALIAS))
    expect(dependenciesOf(out, '')).toEqual({ 'pm-x': 'npm:@yarnpkg/cli-dist@4.17.1' })
  })

  it('keys a non-aliased workspace dependency by the resolved package name', () => {
    const out = stringify(parse(WORKSPACE_ALIAS_MIXED))
    expect(dependenciesOf(out, '')).toEqual({
      chalk: '5.3.0',
      'pm-x': 'npm:@yarnpkg/cli-dist@4.17.1',
    })
  })

  it('round-trips the bun-authored alias lock byte-identically', () => {
    expect(stringify(parse(WORKSPACE_ALIAS))).toBe(WORKSPACE_ALIAS)
  })

  it('round-trips every multi-entry bun-authored alias lock byte-identically', () => {
    for (const [name, src] of [
      ['workspace-alias-mixed', WORKSPACE_ALIAS_MIXED],
      ['transitive-alias', TRANSITIVE_ALIAS],
      ['duplicate-declaration', DUPLICATE_DECLARATION],
    ] as const) {
      expect(stringify(parse(src)), name).toBe(src)
    }
  })

  it('keeps the aliased dependency edge when its own emit is reparsed', () => {
    const reparsed = parse(stringify(parse(WORKSPACE_ALIAS)))
    expect(edgeTo(reparsed, 'f@0.0.0', '@yarnpkg/cli-dist@4.17.1')?.attrs?.alias).toBe('pm-x')
    expect(reparsed.diagnostics().map(d => d.code)).not.toContain('BUN_TEXT_UNRESOLVED_DEP')
    expect([...reparsed.roots()]).toEqual(['f@0.0.0'])
  })

  it('keys a package inner dependency block by the declared alias name', () => {
    // Force the graph-derived inner-block emit path: a mutated graph no longer
    // replays the verbatim parse-time `packages` block.
    const mutated = parse(TRANSITIVE_ALIAS).mutate(m => {
      m.addNode({ id: 'x@1.0.0', name: 'x', version: '1.0.0', peerContext: [] })
    }).graph
    const inner = innerDependenciesOf(stringify(mutated), '@isaacs/cliui')
    expect(inner['string-width-cjs']).toBe('npm:string-width@^4.2.0')
    expect(inner['strip-ansi-cjs']).toBe('npm:strip-ansi@^6.0.1')
    expect(inner['wrap-ansi-cjs']).toBe('npm:wrap-ansi@^7.0.0')
    // Non-aliased siblings keep their package-name slot.
    expect(inner['string-width']).toBe('^5.1.2')
    expect(inner['strip-ansi']).toBe('^7.0.1')
    expect(inner['wrap-ansi']).toBe('^8.1.0')
  })

  it('keys the packages block by the declared alias name when no parse-time key survives', () => {
    // A graph minted outside bun-text (cross-format projection) carries no
    // bun sidecar, so the `packages` key has to come from the edge alias —
    // otherwise the emitted `workspaces` key and `packages` key disagree and
    // bun cannot resolve the dependency.
    const builder = newBuilder()
    builder.addNode({
      id: 'f@0.0.0', name: 'f', version: '0.0.0', peerContext: [], workspacePath: '',
    })
    builder.addNode({
      id: '@yarnpkg/cli-dist@4.17.1', name: '@yarnpkg/cli-dist', version: '4.17.1', peerContext: [],
    })
    builder.addNode({ id: 'chalk@5.3.0', name: 'chalk', version: '5.3.0', peerContext: [] })
    builder.addEdge('f@0.0.0', '@yarnpkg/cli-dist@4.17.1', 'dep', {
      range: 'npm:@yarnpkg/cli-dist@4.17.1',
      alias: 'pm-x',
    })
    builder.addEdge('f@0.0.0', 'chalk@5.3.0', 'dep', { range: '5.3.0' })

    const out = stringify(builder.seal())
    // The load-bearing property is that the two blocks agree on the slot;
    // `packages` key ORDER is a separate emit concern and not asserted here.
    expect(Object.keys(dependenciesOf(out, '')).sort()).toEqual(['chalk', 'pm-x'])
    expect(Object.keys(packagesOf(out)).sort()).toEqual(['chalk', 'pm-x'])
    expect(packageEntryOf(out, 'pm-x')[0]).toBe('@yarnpkg/cli-dist@4.17.1')
    expect(packageEntryOf(out, 'chalk')[0]).toBe('chalk@5.3.0')
  })

  it('emits an aliased bun lock without an irreducible projection loss', () => {
    const graph = parseStrict('bun-text', WORKSPACE_ALIAS)
    expect(() => stringifyStrict('bun-text', graph)).not.toThrow()
    expect(stringifyStrict('bun-text', graph)).toBe(WORKSPACE_ALIAS)
  })
})
