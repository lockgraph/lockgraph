import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const MODIFIED_HEX = createHash('sha512').update('modified-ms-integrity').digest('hex')
const MODIFIED_SRI = 'sha512-' + createHash('sha512').update('modified-ms-integrity').digest('base64')
import { type Diagnostic, type Graph, type GraphDiff } from '../../main/ts/graph.ts'
import { LockfileError } from '../../main/ts/errors.ts'
import {
  check as checkV8,
  enrich as enrichV8,
  optimize as optimizeV8,
  parse as parseV8,
  stringify as stringifyV8,
} from '../../main/ts/formats/yarn-berry-v8.ts'
import { parse as parseV4 } from '../../main/ts/formats/yarn-berry-v4.ts'
import { parse as parseV5 } from '../../main/ts/formats/yarn-berry-v5.ts'
import { parse as parseV6 } from '../../main/ts/formats/yarn-berry-v6.ts'
import { check as checkV9, parse as parseV9 } from '../../main/ts/formats/yarn-berry-v9.ts'
import { mkIntegrity } from '../_integrity-fixtures.ts'
import { parseBerryChecksum } from '../../main/ts/recipe/integrity.ts'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = (rel: string): string =>
  readFileSync(resolve(here, '../resources/fixtures/lockfiles', rel), 'utf8')

const FIXTURES = [
  'deps-with-scopes',
  'git-github-tarball',
  'peers-basic',
  'peers-multi',
  'simple',
  'workspace-cross-refs',
  'workspaces-basic',
  'yarn-crlf',
] as const

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

function parseFixtureGraph(name: typeof FIXTURES[number]): Graph {
  return parseV8(fixture(`${name}/yarn-berry-v8.lock`))
}

function stringifyWithDiagnostics(graph: Graph) {
  const diagnostics: Diagnostic[] = []
  const lockfile = stringifyV8(graph, {
    onDiagnostic(diagnostic) {
      diagnostics.push(diagnostic)
    },
  })

  return { lockfile, diagnostics }
}

describe('yarn-berry-v8 — discriminant and isolation', () => {
  it('accepts v8 lockfile header and rejects v9 header', () => {
    expect(checkV8(fixture('simple/yarn-berry-v8.lock'))).toBe(true)
    expect(checkV8(fixture('simple/yarn-berry-v9.lock'))).toBe(false)
    expect(checkV9(fixture('simple/yarn-berry-v8.lock'))).toBe(false)
  })

  it('parses with the matching adapter and rejects mismatched lockfileVersion', () => {
    expect(parseV8(fixture('simple/yarn-berry-v8.lock')).getNode('case-simple@0.0.0-use.local')).toBeDefined()
    expect(parseV9(fixture('simple/yarn-berry-v9.lock')).getNode('case-simple@0.0.0-use.local')).toBeDefined()

    for (const lock of [
      '__metadata:\n  version: 4\n',
      '__metadata:\n  version: 5\n',
      '__metadata:\n  version: 6\n',
      fixture('simple/yarn-berry-v9.lock'),
    ]) {
      expect(() => parseV8(lock)).toThrow(LockfileError)
      try {
        parseV8(lock)
      } catch (error) {
        expect((error as LockfileError).code).toBe('FORMAT_MISMATCH')
      }
    }

    expect(() => parseV4('__metadata:\n  version: 8\n')).toThrow(LockfileError)
    expect(() => parseV5('__metadata:\n  version: 8\n')).toThrow(LockfileError)
    expect(() => parseV6('__metadata:\n  version: 8\n')).toThrow(LockfileError)
    expect(() => parseV9(fixture('simple/yarn-berry-v8.lock'))).toThrow(LockfileError)
  })
})

describe('yarn-berry-v8 — parse fixtures', () => {
  it.each(FIXTURES)('parses %s fixture', (fixtureName) => {
    const graph = parseFixtureGraph(fixtureName)

    expect(Array.from(graph.nodes())).not.toHaveLength(0)
  })

  // Real-world regression: when a workspace package is also published to
  // npm (e.g. `@scope/pkg` published as `1.6.8`),
  // yarn-berry may collapse the npm alias и workspace specs onto the same
  // entry. The compound entry-key lists `<n>@npm:<ver>` before
  // `<n>@workspace:<path>` lexically; the resolution stays
  // `<n>@workspace:<path>`. Workspace identification must key off the
  // resolution (canonical, per ADR-0014 §4.F3), not `specs[0].protocol`,
  // else the node loses its `workspacePath` и the seal rejects it under
  // ADR-0017 (the source of any `workspace:^` incoming edge is now a
  // workspace node that doesn't look like one).
  it('treats a compound `@npm:<ver>, @workspace:<path>` entry as a workspace node', () => {
    const input =
      '__metadata:\n' +
      '  version: 8\n' +
      '  cacheKey: 10c0\n\n' +
      '"@scope/lib@npm:1.6.8, @scope/lib@workspace:*, @scope/lib@workspace:^, @scope/lib@workspace:packages/lib":\n' +
      '  version: 0.0.0-use.local\n' +
      '  resolution: "@scope/lib@workspace:packages/lib"\n' +
      '  languageName: unknown\n' +
      '  linkType: soft\n\n' +
      '"@scope/consumer@workspace:packages/consumer":\n' +
      '  version: 0.0.0-use.local\n' +
      '  resolution: "@scope/consumer@workspace:packages/consumer"\n' +
      '  dependencies:\n' +
      '    "@scope/lib": "workspace:^"\n' +
      '  languageName: unknown\n' +
      '  linkType: soft\n'

    const graph = parseV8(input)
    const lib = graph.getNode('@scope/lib@0.0.0-use.local')
    const consumer = graph.getNode('@scope/consumer@0.0.0-use.local')

    expect(lib?.workspacePath).toBe('packages/lib')
    expect(consumer?.workspacePath).toBe('packages/consumer')
    expect(graph.in('@scope/lib@0.0.0-use.local')).toHaveLength(1)
  })

  // Real-world regression: a package declares BOTH a canonical dep AND an
  // npm-aliased dep (a `--variant`-suffixed alias of the same package)
  // pointing at the SAME resolved target. Two edges from the same parent to
  // the same dst with the same kind used to trip the seal's
  // duplicate-`(src, dst, kind)` invariant; edge identity now includes
  // `attrs.alias`, so alias-distinct siblings are permitted. Pin the parse,
  // both edges' presence, и stringify round-trip.
  it('preserves npm-aliased dep + canonical dep against the same target as alias-distinct edges', () => {
    const input =
      '__metadata:\n' +
      '  version: 8\n' +
      '  cacheKey: 10c0\n\n' +
      '"@babel/traverse--for-generate-function-map@npm:@babel/traverse@^7.25.3, @babel/traverse@npm:^7.25.3":\n' +
      '  version: 7.25.3\n' +
      '  resolution: "@babel/traverse@npm:7.25.3"\n' +
      '  languageName: node\n' +
      '  linkType: hard\n\n' +
      '"metro-source-map@npm:0.83.2":\n' +
      '  version: 0.83.2\n' +
      '  resolution: "metro-source-map@npm:0.83.2"\n' +
      '  dependencies:\n' +
      '    "@babel/traverse": "npm:^7.25.3"\n' +
      '    "@babel/traverse--for-generate-function-map": "npm:@babel/traverse@^7.25.3"\n' +
      '  languageName: node\n' +
      '  linkType: hard\n'

    expect(() => parseV8(input)).not.toThrow()
    const graph = parseV8(input)
    // String construction avoids editor email-redaction on `name@version`.
    const at = '@'
    const metro = `metro-source-map${at}0.83.2`
    const traverse = `${at}babel/traverse${at}7.25.3`
    expect(graph.getNode(metro)).toBeDefined()
    expect(graph.getNode(traverse)).toBeDefined()

    const outs = graph.out(metro, 'dep').filter(e => e.dst === traverse)
    expect(outs).toHaveLength(2)
    // Canonical edge has alias=undefined; aliased edge carries the
    // descriptor key as the alias slot. Iteration order is content-sorted
    // (ADR-0007) — alias=undefined sorts before any string alias.
    const aliases = outs.map(e => e.attrs?.alias)
    expect(aliases).toContain(undefined)
    expect(aliases).toContain('@babel/traverse--for-generate-function-map')

    // Round-trip preserves both descriptors in the emitted dependencies block.
    const emitted = stringifyV8(graph)
    expect(emitted).toContain('"@babel/traverse--for-generate-function-map": "npm:@babel/traverse@^7.25.3"')
    expect(emitted).toContain('"@babel/traverse": "npm:^7.25.3"')

    const reparsed = parseV8(emitted)
    expect(graphSnapshot(reparsed)).toEqual(graphSnapshot(graph))
  })

  // Real-world regression: yarn 4 emits
  // a compound entry-key where one half is a bare `<name>@<version>` token
  // (no `<protocol>:` colon) when a workspace package is also published to
  // the npm registry — `"@scope/pkg@1.14.1, @scope/pkg@workspace:packages/pkg"`.
  // The shared `parseSpec` tokenizer previously threw `PARSE_FAILED` on the
  // bare half (`bad entry-spec, no protocol colon: <raw>`). The fix
  // synthesises `npm:` per ADR-0016 §B (matches `entryKeyRangeOf`'s default
  // for cross-family input), keeping the grammar uniform downstream without
  // throwing. Pin the behavior so the bare-name-version half parses cleanly
  // and the resulting node is identified as a workspace via its `resolution`.
  it('parses bare `<name>@<version>` half in compound entry-key (synthesises `npm:`)', () => {
    const input =
      '__metadata:\n' +
      '  version: 8\n' +
      '  cacheKey: 10c0\n\n' +
      '"@qiwi/mware-context@1.14.1, @qiwi/mware-context@workspace:packages/context":\n' +
      '  version: 0.0.0-use.local\n' +
      '  resolution: "@qiwi/mware-context@workspace:packages/context"\n' +
      '  languageName: unknown\n' +
      '  linkType: soft\n'

    expect(() => parseV8(input)).not.toThrow()
    const graph = parseV8(input)
    const node = graph.getNode('@qiwi/mware-context@0.0.0-use.local')
    expect(node?.workspacePath).toBe('packages/context')
  })
})

describe('yarn-berry-v8 — stringify', () => {
  it.each(FIXTURES.filter(name => name !== 'yarn-crlf'))('roundtrips %s at Graph level', (fixtureName) => {
    const original = parseFixtureGraph(fixtureName)
    const emitted = stringifyV8(original)
    const reparsed = parseV8(emitted)

    expect(graphSnapshot(reparsed)).toEqual(graphSnapshot(original))
  })

  it('roundtrips yarn-crlf at Graph level when CRLF is requested', () => {
    const original = parseFixtureGraph('yarn-crlf')
    const emitted = stringifyV8(original, { lineEnding: 'crlf' })
    const reparsed = parseV8(emitted)

    expect(emitted).toContain('\r\n')
    expect(graphSnapshot(reparsed)).toEqual(graphSnapshot(original))
  })

  it('preserves parsed conditions and compressionLevel sidecars', () => {
    const PKG_HEX = createHash('sha512').update('pkg-1.0.0').digest('hex')
    const input =
      '__metadata:\n' +
      '  version: 8\n' +
      '  cacheKey: 10c0\n' +
      '  compressionLevel: 0\n\n' +
      '"pkg@npm:1.0.0":\n' +
      '  version: 1.0.0\n' +
      '  resolution: "pkg@npm:1.0.0"\n' +
      '  conditions: os=linux\n' +
      `  checksum: 10c0/${PKG_HEX}\n` +
      '  languageName: node\n' +
      '  linkType: hard\n'

    const original = parseV8(input)
    const emitted = stringifyV8(original)
    const reparsed = parseV8(emitted)

    expect(emitted).toContain('__metadata:\n  version: 8\n  cacheKey: 10c0\n  compressionLevel: 0\n')
    expect(emitted).toContain('  conditions: os=linux\n')
    expect(emitted).not.toContain('compressionLevel: "0"')
    expect(graphSnapshot(reparsed)).toEqual(graphSnapshot(original))
  })
})

describe('yarn-berry-v8 — modify', () => {
  it('roundtrips addEdge', () => {
    const original = parseFixtureGraph('simple')
    const result = original.mutate(m => {
      m.addEdge('lodash@4.17.21', 'ms@2.1.3', 'dep', { range: 'npm:2.1.3' })
    })
    const reparsed = parseV8(stringifyV8(result.graph))

    expectEmptyGraphDiff(result.graph.diff(reparsed))
  })

  it('roundtrips removeEdge', () => {
    const original = parseFixtureGraph('simple')
    const result = original.mutate(m => {
      m.removeEdge('case-simple@0.0.0-use.local', 'ms@2.1.3', 'dep')
    })
    const reparsed = parseV8(stringifyV8(result.graph))

    expectEmptyGraphDiff(result.graph.diff(reparsed))
  })

  it('roundtrips addNode', () => {
    const original = parseFixtureGraph('simple')
    const result = original.mutate(m => {
      m.addNode({
        id: 'debug@1.0.0',
        name: 'debug',
        version: '1.0.0',
        peerContext: [],
        resolution: 'debug@npm:1.0.0',
      })
    })
    const reparsed = parseV8(stringifyV8(result.graph))

    expectEmptyGraphDiff(result.graph.diff(reparsed))
  })

  it('roundtrips removeNode', () => {
    const original = parseFixtureGraph('simple')
    const result = original.mutate(m => {
      m.removeEdge('case-simple@0.0.0-use.local', 'ms@2.1.3', 'dep')
      m.removeNode('ms@2.1.3')
    })
    const reparsed = parseV8(stringifyV8(result.graph))

    expectEmptyGraphDiff(result.graph.diff(reparsed))
  })

  it('roundtrips replaceNode', () => {
    const original = parseFixtureGraph('simple')
    const current = original.getNode('ms@2.1.3')

    const result = original.mutate(m => {
      m.replaceNode('ms@2.1.3', {
        ...current!,
        id: 'ms@2.1.4',
        version: '2.1.4',
        resolution: 'ms@npm:2.1.4',
      })
    })
    const reparsed = parseV8(stringifyV8(result.graph))

    expectEmptyGraphDiff(result.graph.diff(reparsed))
  })

  it('roundtrips replacePeerContext to the flattened graph with a v8 warning', () => {
    const original = parseFixtureGraph('peers-basic')
    const result = original.mutate(m => {
      m.replacePeerContext('react-dom@18.2.0', ['react@18.2.0'])
    })
    const { lockfile, diagnostics } = stringifyWithDiagnostics(result.graph)
    const reparsed = parseV8(lockfile)

    expectEmptyGraphDiff(original.diff(reparsed))
    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'YARN_BERRY_V8_PEER_VIRT_FLATTENED',
        severity: 'warning',
        subject: 'react-dom@18.2.0(react@18.2.0)',
      }),
    ]))
  })

  it('roundtrips setTarball', () => {
    const original = parseFixtureGraph('simple')
    const result = original.mutate(m => {
      // yarn-berry `checksum` is a zip-cache (berry-zip) digest — ADR-0031
      // only fills it from a berry-zip-origin hash, so set one here.
      m.setTarball({ name: 'ms', version: '2.1.3' }, { integrity: parseBerryChecksum(MODIFIED_HEX).integrity })
    })
    const emitted = stringifyV8(result.graph)
    const reparsed = parseV8(emitted)

    expectEmptyGraphDiff(result.graph.diff(reparsed))
    expect(emitted).toContain(`checksum: 10c0/${MODIFIED_HEX}`)
    // ADR-0014 §4.F3 — round-trip parse re-derives canonical resolution.
    expect(reparsed.tarballOf('ms@2.1.3')?.integrity).toEqual(parseBerryChecksum(MODIFIED_HEX).integrity)
  })

  it('roundtrips removeTarball', () => {
    const original = parseFixtureGraph('simple')
    const result = original.mutate(m => {
      m.removeTarball({ name: 'ms', version: '2.1.3' })
    })
    const reparsed = parseV8(stringifyV8(result.graph))

    expectEmptyGraphDiff(result.graph.diff(reparsed))
    expect(reparsed.tarballOf('ms@2.1.3')?.integrity).toBeUndefined()
  })

  // Regression: __metadata.cacheKey was lost after any graph.mutate() call
  // because mutate() returns a new Graph instance not present in the sidecar
  // WeakMap. Fix: parseFamily wraps the returned graph so mutate() propagates
  // the sidecar (including metadata.cacheKey) to the new graph instance.
  it('preserves __metadata.cacheKey through a no-op mutate()', () => {
    const raw = fixture('simple/yarn-berry-v8.lock')
    expect(raw).toContain('cacheKey: 10c0')

    const g = parseV8(raw)
    const { graph: g2 } = g.mutate(_m => {})

    const emitted = stringifyV8(g2)
    expect(emitted).toContain('cacheKey: 10c0')
  })

  it('preserves __metadata.cacheKey through a non-trivial mutate()', () => {
    const raw = fixture('simple/yarn-berry-v8.lock')
    const g = parseV8(raw)
    const { graph: g2 } = g.mutate(m => {
      m.addEdge('lodash@4.17.21', 'ms@2.1.3', 'dep', { range: 'npm:2.1.3' })
    })

    const emitted = stringifyV8(g2)
    expect(emitted).toContain('cacheKey: 10c0')
    // verify cacheKey also propagates a second mutate hop
    const { graph: g3 } = g2.mutate(_m => {})
    expect(stringifyV8(g3)).toContain('cacheKey: 10c0')
  })
})

describe('yarn-berry-v8 — enrich', () => {
  it('derives a peer edge and virtualizes the consumer when one candidate matches', () => {
    const input =
      '__metadata:\n  version: 8\n\n' +
      '"host@npm:1.0.0":\n' +
      '  version: 1.0.0\n' +
      '  resolution: "host@npm:1.0.0"\n' +
      '  peerDependencies:\n' +
      '    react: ^18.0.0\n' +
      '"react@npm:18.2.0":\n' +
      '  version: 18.2.0\n' +
      '  resolution: "react@npm:18.2.0"\n'

    const result = enrichV8(parseV8(input))

    expect(result.diagnostics).toEqual([])
    expect(result.graph.getNode('host@1.0.0(react@18.2.0)')).toBeDefined()
  })

  it('warns when a peer range is ambiguous', () => {
    const input =
      '__metadata:\n  version: 8\n\n' +
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

    expect(enrichV8(parseV8(input)).diagnostics).toEqual([
      {
        code: 'YARN_BERRY_V8_PEER_AMBIGUOUS',
        severity: 'warning',
        subject: 'host@1.0.0',
        message: 'peer "react" matches multiple installed versions: [react@17.0.2, react@18.2.0]',
      },
    ])
  })

  it('warns when a peer range is unsatisfied', () => {
    const input =
      '__metadata:\n  version: 8\n\n' +
      '"host@npm:1.0.0":\n' +
      '  version: 1.0.0\n' +
      '  resolution: "host@npm:1.0.0"\n' +
      '  peerDependencies:\n' +
      '    react: ^18.0.0\n' +
      '"react@npm:17.0.2":\n' +
      '  version: 17.0.2\n' +
      '  resolution: "react@npm:17.0.2"\n'

    expect(enrichV8(parseV8(input)).diagnostics).toEqual([
      {
        code: 'YARN_BERRY_V8_PEER_UNSATISFIED',
        severity: 'warning',
        subject: 'host@1.0.0',
        message: 'peer "react" range "^18.0.0" matches no installed version',
      },
    ])
  })

  it('throws INVALID_INPUT on a malformed peer range', () => {
    const input =
      '__metadata:\n  version: 8\n\n' +
      '"host@npm:1.0.0":\n' +
      '  version: 1.0.0\n' +
      '  resolution: "host@npm:1.0.0"\n' +
      '  peerDependencies:\n' +
      '    react: definitely-not-a-range\n'

    expect(() => enrichV8(parseV8(input))).toThrow(LockfileError)
    try {
      enrichV8(parseV8(input))
    } catch (error) {
      expect((error as LockfileError).code).toBe('INVALID_INPUT')
    }
  })
})

describe('yarn-berry-v8 — optimize', () => {
  function graphWithOrphan(): Graph {
    const base = parseFixtureGraph('simple')
    return base.mutate(m => {
      m.addNode({
        id: 'orphan@9.9.9',
        name: 'orphan',
        version: '9.9.9',
        peerContext: [],
        resolution: 'orphan@npm:9.9.9',
      })
      m.addEdge('orphan@9.9.9', 'orphan@9.9.9', 'dep', { range: 'npm:9.9.9' })
      m.setTarball({ name: 'orphan', version: '9.9.9' }, { integrity: mkIntegrity('10c0/orphan') })
    }).graph
  }

  it('prunes unreachable nodes and tarballs', () => {
    const result = optimizeV8(graphWithOrphan())

    expect(result.graph.getNode('orphan@9.9.9')).toBeUndefined()
    expect(result.graph.tarball({ name: 'orphan', version: '9.9.9' })).toBeUndefined()
  })

  it('is idempotent across stringify/parse', () => {
    const once = optimizeV8(graphWithOrphan())
    const twice = optimizeV8(parseV8(stringifyV8(once.graph)))

    expect(graphSnapshot(twice.graph)).toEqual(graphSnapshot(once.graph))
    expect(twice.diagnostics).toEqual(once.diagnostics)
  })
})
