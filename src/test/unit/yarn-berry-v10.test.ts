import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { type Diagnostic, type Graph, type GraphDiff } from '../../main/ts/graph.ts'
import { LockfileError } from '../../main/ts/errors.ts'
import {
  check as checkV10,
  enrich as enrichV10,
  optimize as optimizeV10,
  parse as parseV10,
  stringify as stringifyV10,
} from '../../main/ts/formats/yarn-berry-v10.ts'
import { check as checkV9, parse as parseV9, stringify as stringifyV9 } from '../../main/ts/formats/yarn-berry-v9.ts'
import { check as checkV8 } from '../../main/ts/formats/yarn-berry-v8.ts'
import { detect } from '../../main/ts/index.ts'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = (rel: string): string =>
  readFileSync(resolve(here, '../resources/fixtures/lockfiles', rel), 'utf8')

// v10 fixtures are synthesised from v9 by re-stringifying a v9-parsed graph
// through the v10 emitter (which only differs from v9 in the
// `__metadata.version: 10` field). Matches the v7-from-v8 synthetic-fixture
// precedent in spec/formats/yarn-berry-v7.md.
const SYNTH_FIXTURES = [
  'simple',
  'peers-basic',
  'peers-multi',
  'workspaces-basic',
  'deps-with-scopes',
  'workspace-cross-refs',
] as const

function synthesiseFromV9(name: typeof SYNTH_FIXTURES[number]): string {
  // v9 → v10 is a `version: 9` → `version: 10` bump in __metadata. Direct
  // string-replace on the v9 fixture is the lowest-fidelity transform that
  // still round-trips через parse/stringify; matches v7's synthetic
  // fixture pattern.
  return fixture(`${name}/yarn-berry-v9.lock`).replace(/(^__metadata:\s*\n\s+version:\s*)9(\s)/m, '$110$2')
}

function graphSnapshot(graph: Graph) {
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
    diagnostics: graph.diagnostics().map(diagnostic => ({ ...diagnostic })),
  }
}

function expectEmptyGraphDiff(diff: GraphDiff) {
  expect(diff).toEqual({
    addedNodes: [],
    removedNodes: [],
    changedNodes: [],
    addedEdges: [],
    removedEdges: [],
  })
}

describe('yarn-berry-v10 — discriminant and isolation', () => {
  it('accepts v10 lockfile header and rejects v8 / v9 headers', () => {
    expect(checkV10(synthesiseFromV9('simple'))).toBe(true)
    expect(checkV10(fixture('simple/yarn-berry-v9.lock'))).toBe(false)
    expect(checkV10(fixture('simple/yarn-berry-v8.lock'))).toBe(false)
    expect(checkV9(synthesiseFromV9('simple'))).toBe(false)
    expect(checkV8(synthesiseFromV9('simple'))).toBe(false)
  })

  it('parses with the matching adapter and rejects mismatched lockfileVersion', () => {
    expect(parseV10(synthesiseFromV9('simple')).getNode('case-simple@0.0.0-use.local')).toBeDefined()

    // v9 input → v10 parser must FORMAT_MISMATCH.
    expect(() => parseV10(fixture('simple/yarn-berry-v9.lock'))).toThrow(LockfileError)
    try {
      parseV10(fixture('simple/yarn-berry-v9.lock'))
    } catch (error) {
      expect((error as LockfileError).code).toBe('FORMAT_MISMATCH')
    }

    // v10 input → v9 parser must FORMAT_MISMATCH.
    expect(() => parseV9(synthesiseFromV9('simple'))).toThrow(LockfileError)
  })

  it('detect() routes a v10 lockfile to the v10 adapter (DETECT_ORDER newest-first)', () => {
    expect(detect(synthesiseFromV9('simple'))).toBe('yarn-berry-v10')
    // Existing v9 lockfiles still resolve to v9 — v10 detection is
    // strictly version-pinned.
    expect(detect(fixture('simple/yarn-berry-v9.lock'))).toBe('yarn-berry-v9')
  })
})

describe('yarn-berry-v10 — parse + stringify roundtrip', () => {
  it.each(SYNTH_FIXTURES)('roundtrips %s at Graph level', (fixtureName) => {
    const original = parseV10(synthesiseFromV9(fixtureName))
    const emitted = stringifyV10(original)
    const reparsed = parseV10(emitted)

    expect(emitted).toContain('__metadata:\n  version: 10\n')
    expect(graphSnapshot(reparsed)).toEqual(graphSnapshot(original))
  })

  it('emits __metadata.version: 10 unquoted (matches family writer convention)', () => {
    const emitted = stringifyV10(parseV10(synthesiseFromV9('simple')), { cacheKey: '10c0' })

    expect(emitted).toContain('__metadata:\n  version: 10\n  cacheKey: 10c0\n')
    expect(emitted).not.toContain('version: "10"')
  })

  it('produces a graph structurally identical to the v9 parse of the same content', () => {
    // Sanity: same fixture, only the metadata version differs — the parse
    // graph (nodes, edges, tarballs) must match exactly between v9 and v10.
    const fromV9 = parseV9(fixture('simple/yarn-berry-v9.lock'))
    const fromV10 = parseV10(synthesiseFromV9('simple'))

    expectEmptyGraphDiff(fromV9.diff(fromV10))
  })
})

describe('yarn-berry-v10 — enrich / optimize delegate to family core', () => {
  // Family-core delegation: v10 binds the same enrich / optimize entry
  // points as v9; only the codePrefix differs (`YARN_BERRY_V10_*`).

  it('enrich derives a peer edge when one candidate matches', () => {
    const input =
      '__metadata:\n  version: 10\n\n' +
      '"host@npm:1.0.0":\n' +
      '  version: 1.0.0\n' +
      '  resolution: "host@npm:1.0.0"\n' +
      '  peerDependencies:\n' +
      '    react: ^18.0.0\n' +
      '"react@npm:18.2.0":\n' +
      '  version: 18.2.0\n' +
      '  resolution: "react@npm:18.2.0"\n'

    const result = enrichV10(parseV10(input))
    expect(result.diagnostics).toEqual([])
    expect(result.graph.getNode('host@1.0.0(react@18.2.0)')).toBeDefined()
  })

  it('enrich emits YARN_BERRY_V10_PEER_AMBIGUOUS prefix when ambiguous', () => {
    const input =
      '__metadata:\n  version: 10\n\n' +
      '"host@npm:1.0.0":\n' +
      '  version: 1.0.0\n' +
      '  resolution: "host@npm:1.0.0"\n' +
      '  peerDependencies:\n' +
      '    react: "*"\n' +
      '"react@npm:17.0.2":\n' +
      '  version: 17.0.2\n' +
      '  resolution: "react@npm:17.0.2"\n' +
      '"react@npm:18.2.0":\n' +
      '  version: 18.2.0\n' +
      '  resolution: "react@npm:18.2.0"\n'

    expect(enrichV10(parseV10(input)).diagnostics).toEqual([
      {
        code: 'YARN_BERRY_V10_PEER_AMBIGUOUS',
        severity: 'warning',
        subject: 'host@1.0.0',
        message: 'peer "react" matches multiple installed versions: [react@17.0.2, react@18.2.0]',
      },
    ])
  })

  it('optimize prunes unreachable nodes and tarballs', () => {
    const base = parseV10(synthesiseFromV9('simple'))
    const withOrphan = base.mutate(m => {
      m.addNode({
        id: 'orphan@9.9.9',
        name: 'orphan',
        version: '9.9.9',
        peerContext: [],
        resolution: 'orphan@npm:9.9.9',
      })
      m.addEdge('orphan@9.9.9', 'orphan@9.9.9', 'dep', { range: 'npm:9.9.9' })
      m.setTarball({ name: 'orphan', version: '9.9.9' }, { integrity: 'orphan' })
    }).graph

    const result = optimizeV10(withOrphan)
    expect(result.graph.getNode('orphan@9.9.9')).toBeUndefined()
    expect(result.graph.tarball({ name: 'orphan', version: '9.9.9' })).toBeUndefined()
  })
})

describe('yarn-berry-v10 — link: locator disambiguation parity with v9 (sister-session bug #2)', () => {
  it('does NOT trip IRREDUCIBLE_LOSS on backstage-style link: + workspace: collision', () => {
    const input =
      '__metadata:\n  version: 10\n  cacheKey: 10c0\n\n' +
      '"example-app@link:../app::locator=example-backend%40workspace%3Apackages%2Fbackend":\n' +
      '  version: 0.0.0-use.local\n' +
      '  resolution: "example-app@link:../app::locator=example-backend%40workspace%3Apackages%2Fbackend"\n' +
      '  languageName: node\n' +
      '  linkType: soft\n\n' +
      '"example-app@workspace:packages/app":\n' +
      '  version: 0.0.0-use.local\n' +
      '  resolution: "example-app@workspace:packages/app"\n' +
      '  languageName: unknown\n' +
      '  linkType: soft\n'

    expect(() => parseV10(input)).not.toThrow()
    const graph = parseV10(input)
    expect(graph.byName('example-app')).toHaveLength(2)
  })
})

describe('yarn-berry-v10 — stringify emits onDiagnostic callback contract', () => {
  it('relays onDiagnostic to the supplied callback (same shape as v9)', () => {
    const graph = parseV10(synthesiseFromV9('simple'))
    const diagnostics: Diagnostic[] = []
    stringifyV10(graph, { onDiagnostic: d => diagnostics.push(d) })
    // The simple fixture emits RECIPE_INTEGRITY_TRANSLATED (sri → cachekey-
    // prefixed) per the standard v8/v9/v10 checksum-prefix recipe — verify
    // the callback delivers each diagnostic produced by the family core.
    // Codes are family-shared (recipe-layer), not codePrefix-scoped.
    expect(diagnostics.length).toBeGreaterThan(0)
    expect(diagnostics.every(d => d.code === 'RECIPE_INTEGRITY_TRANSLATED')).toBe(true)
  })

  it('parity check: v9 and v10 emit equivalent stringify diagnostics on the same content', () => {
    const v10Graph = parseV10(synthesiseFromV9('simple'))
    const v9Graph = parseV9(fixture('simple/yarn-berry-v9.lock'))
    const v10Diags: Diagnostic[] = []
    const v9Diags: Diagnostic[] = []
    stringifyV10(v10Graph, { onDiagnostic: d => v10Diags.push(d) })
    stringifyV9(v9Graph, { onDiagnostic: d => v9Diags.push(d) })

    expect(v10Diags.map(d => d.code).sort()).toEqual(v9Diags.map(d => d.code).sort())
  })
})
