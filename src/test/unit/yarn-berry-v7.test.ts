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
  check as checkV7,
  enrich as enrichV7,
  optimize as optimizeV7,
  parse as parseV7,
  stringify as stringifyV7,
} from '../../main/ts/formats/yarn-berry-v7.ts'
import { parse as parseV4 } from '../../main/ts/formats/yarn-berry-v4.ts'
import { parse as parseV5 } from '../../main/ts/formats/yarn-berry-v5.ts'
import { check as checkV6, parse as parseV6 } from '../../main/ts/formats/yarn-berry-v6.ts'
import { check as checkV8, parse as parseV8 } from '../../main/ts/formats/yarn-berry-v8.ts'
import { check as checkV9, parse as parseV9 } from '../../main/ts/formats/yarn-berry-v9.ts'

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
  return parseV7(fixture(`${name}/yarn-berry-v7.lock`))
}

function stringifyWithDiagnostics(graph: Graph) {
  const diagnostics: Diagnostic[] = []
  const lockfile = stringifyV7(graph, {
    onDiagnostic(diagnostic) {
      diagnostics.push(diagnostic)
    },
  })

  return { lockfile, diagnostics }
}

describe('yarn-berry-v7 — discriminant and isolation', () => {
  it('accepts v7 lockfile header and rejects v6/v8/v9 headers', () => {
    expect(checkV7(fixture('simple/yarn-berry-v7.lock'))).toBe(true)
    expect(checkV7(fixture('simple/yarn-berry-v6.lock'))).toBe(false)
    expect(checkV7(fixture('simple/yarn-berry-v8.lock'))).toBe(false)
    expect(checkV7(fixture('simple/yarn-berry-v9.lock'))).toBe(false)
    expect(checkV6(fixture('simple/yarn-berry-v7.lock'))).toBe(false)
    expect(checkV8(fixture('simple/yarn-berry-v7.lock'))).toBe(false)
    expect(checkV9(fixture('simple/yarn-berry-v7.lock'))).toBe(false)
  })

  it('parses with the matching adapter and rejects mismatched lockfileVersion', () => {
    expect(parseV7(fixture('simple/yarn-berry-v7.lock')).getNode('case-simple@0.0.0-use.local')).toBeDefined()
    expect(parseV6(fixture('simple/yarn-berry-v6.lock')).getNode('case-simple@0.0.0-use.local')).toBeDefined()
    expect(parseV8(fixture('simple/yarn-berry-v8.lock')).getNode('case-simple@0.0.0-use.local')).toBeDefined()
    expect(parseV9(fixture('simple/yarn-berry-v9.lock')).getNode('case-simple@0.0.0-use.local')).toBeDefined()

    for (const lock of [
      '__metadata:\n  version: 4\n',
      '__metadata:\n  version: 5\n',
      '__metadata:\n  version: 6\n',
      fixture('simple/yarn-berry-v8.lock'),
      fixture('simple/yarn-berry-v9.lock'),
    ]) {
      expect(() => parseV7(lock)).toThrow(LockfileError)
      try {
        parseV7(lock)
      } catch (error) {
        expect((error as LockfileError).code).toBe('FORMAT_MISMATCH')
      }
    }

    expect(() => parseV4('__metadata:\n  version: 7\n')).toThrow(LockfileError)
    expect(() => parseV5('__metadata:\n  version: 7\n')).toThrow(LockfileError)
    expect(() => parseV6('__metadata:\n  version: 7\n')).toThrow(LockfileError)
    expect(() => parseV8('__metadata:\n  version: 7\n')).toThrow(LockfileError)
    expect(() => parseV9('__metadata:\n  version: 7\n')).toThrow(LockfileError)
  })
})

describe('yarn-berry-v7 — parse fixtures', () => {
  it.each(FIXTURES)('parses %s fixture', (fixtureName) => {
    const graph = parseFixtureGraph(fixtureName)

    expect(Array.from(graph.nodes())).not.toHaveLength(0)
  })
})

describe('yarn-berry-v7 — stringify', () => {
  it.each(FIXTURES.filter(name => name !== 'yarn-crlf'))('roundtrips %s at Graph level', (fixtureName) => {
    const original = parseFixtureGraph(fixtureName)
    const emitted = stringifyV7(original)
    const reparsed = parseV7(emitted)

    expect(graphSnapshot(reparsed)).toEqual(graphSnapshot(original))
  })

  it('roundtrips yarn-crlf at Graph level when CRLF is requested', () => {
    const original = parseFixtureGraph('yarn-crlf')
    const emitted = stringifyV7(original, { lineEnding: 'crlf' })
    const reparsed = parseV7(emitted)

    expect(emitted).toContain('\r\n')
    expect(graphSnapshot(reparsed)).toEqual(graphSnapshot(original))
  })

  it('preserves parsed conditions metadata and emits raw-hex checksum + quoted-protocol ranges', () => {
    const PKG_HEX = createHash('sha512').update('pkg-1.0.0').digest('hex')
    const DEP_HEX = createHash('sha512').update('dep-2.0.0').digest('hex')
    const input =
      '__metadata:\n' +
      '  version: 7\n' +
      '  cacheKey: 10\n\n' +
      '"pkg@npm:1.0.0":\n' +
      '  version: 1.0.0\n' +
      '  resolution: "pkg@npm:1.0.0"\n' +
      '  dependencies:\n' +
      '    dep: "npm:2.0.0"\n' +
      '  conditions:\n' +
      '    os: linux\n' +
      `  checksum: ${PKG_HEX}\n` +
      '  languageName: node\n' +
      '  linkType: hard\n\n' +
      '"dep@npm:2.0.0":\n' +
      '  version: 2.0.0\n' +
      '  resolution: "dep@npm:2.0.0"\n' +
      `  checksum: ${DEP_HEX}\n` +
      '  languageName: node\n' +
      '  linkType: hard\n'

    const original = parseV7(input)
    const emitted = stringifyV7(original)
    const reparsed = parseV7(emitted)

    expect(emitted).toContain('__metadata:\n  version: 7\n  cacheKey: 10\n')
    expect(emitted).toContain('    dep: "npm:2.0.0"\n')
    expect(emitted).toContain('  conditions:\n    os: linux\n')
    expect(emitted).toContain(`  checksum: ${PKG_HEX}\n`)
    // v7 keeps the v4/v5/v6-era RAW hex shape — no `<cacheKey>/<hash>` prefix.
    expect(emitted).not.toContain(`checksum: 10/${PKG_HEX}`)
    expect(graphSnapshot(reparsed)).toEqual(graphSnapshot(original))
  })
})

describe('yarn-berry-v7 — modify', () => {
  it('roundtrips addEdge', () => {
    const original = parseFixtureGraph('simple')
    const result = original.mutate(m => {
      m.addEdge('lodash@4.17.21', 'ms@2.1.3', 'dep', { range: 'npm:2.1.3' })
    })
    const reparsed = parseV7(stringifyV7(result.graph))

    expectEmptyGraphDiff(result.graph.diff(reparsed))
  })

  it('roundtrips removeEdge', () => {
    const original = parseFixtureGraph('simple')
    const result = original.mutate(m => {
      m.removeEdge('case-simple@0.0.0-use.local', 'ms@2.1.3', 'dep')
    })
    const reparsed = parseV7(stringifyV7(result.graph))

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
    const reparsed = parseV7(stringifyV7(result.graph))

    expectEmptyGraphDiff(result.graph.diff(reparsed))
  })

  it('roundtrips removeNode', () => {
    const original = parseFixtureGraph('simple')
    const result = original.mutate(m => {
      m.removeEdge('case-simple@0.0.0-use.local', 'ms@2.1.3', 'dep')
      m.removeNode('ms@2.1.3')
    })
    const reparsed = parseV7(stringifyV7(result.graph))

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
    const reparsed = parseV7(stringifyV7(result.graph))

    expectEmptyGraphDiff(result.graph.diff(reparsed))
  })

  it('roundtrips replacePeerContext to the flattened graph with a v7 warning', () => {
    const original = parseFixtureGraph('peers-basic')
    const result = original.mutate(m => {
      m.replacePeerContext('react-dom@18.2.0', ['react@18.2.0'])
    })
    const { lockfile, diagnostics } = stringifyWithDiagnostics(result.graph)
    const reparsed = parseV7(lockfile)

    expectEmptyGraphDiff(original.diff(reparsed))
    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'YARN_BERRY_V7_PEER_VIRT_FLATTENED',
        severity: 'warning',
        subject: 'react-dom@18.2.0(react@18.2.0)',
      }),
    ]))
  })

  it('roundtrips setTarball', () => {
    const original = parseFixtureGraph('simple')
    const result = original.mutate(m => {
      m.setTarball({ name: 'ms', version: '2.1.3' }, { integrity: MODIFIED_SRI })
    })
    const emitted = stringifyV7(result.graph)
    const reparsed = parseV7(emitted)

    expectEmptyGraphDiff(result.graph.diff(reparsed))
    expect(emitted).toContain(`checksum: ${MODIFIED_HEX}`)
    expect(emitted).not.toContain(`checksum: 10/${MODIFIED_HEX}`)
    // ADR-0014 §4.F3 — round-trip parse re-derives canonical resolution.
    expect(reparsed.tarballOf('ms@2.1.3')?.integrity).toBe(MODIFIED_SRI)
  })

  it('roundtrips removeTarball', () => {
    const original = parseFixtureGraph('simple')
    const result = original.mutate(m => {
      m.removeTarball({ name: 'ms', version: '2.1.3' })
    })
    const reparsed = parseV7(stringifyV7(result.graph))

    expectEmptyGraphDiff(result.graph.diff(reparsed))
    expect(reparsed.tarballOf('ms@2.1.3')?.integrity).toBeUndefined()
  })
})

describe('yarn-berry-v7 — enrich', () => {
  it('derives a peer edge and virtualizes the consumer when one candidate matches', () => {
    const input =
      '__metadata:\n  version: 7\n\n' +
      '"host@npm:1.0.0":\n' +
      '  version: 1.0.0\n' +
      '  resolution: "host@npm:1.0.0"\n' +
      '  peerDependencies:\n' +
      '    react: ^18.0.0\n' +
      '"react@npm:18.2.0":\n' +
      '  version: 18.2.0\n' +
      '  resolution: "react@npm:18.2.0"\n'

    const result = enrichV7(parseV7(input))

    expect(result.diagnostics).toEqual([])
    expect(result.graph.getNode('host@1.0.0(react@18.2.0)')).toBeDefined()
  })

  it('warns when a peer range is ambiguous', () => {
    const input =
      '__metadata:\n  version: 7\n\n' +
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

    expect(enrichV7(parseV7(input)).diagnostics).toEqual([
      {
        code: 'YARN_BERRY_V7_PEER_AMBIGUOUS',
        severity: 'warning',
        subject: 'host@1.0.0',
        message: 'peer "react" matches multiple installed versions: [react@17.0.2, react@18.2.0]',
      },
    ])
  })

  it('warns when a peer range is unsatisfied', () => {
    const input =
      '__metadata:\n  version: 7\n\n' +
      '"host@npm:1.0.0":\n' +
      '  version: 1.0.0\n' +
      '  resolution: "host@npm:1.0.0"\n' +
      '  peerDependencies:\n' +
      '    react: ^18.0.0\n' +
      '"react@npm:17.0.2":\n' +
      '  version: 17.0.2\n' +
      '  resolution: "react@npm:17.0.2"\n'

    expect(enrichV7(parseV7(input)).diagnostics).toEqual([
      {
        code: 'YARN_BERRY_V7_PEER_UNSATISFIED',
        severity: 'warning',
        subject: 'host@1.0.0',
        message: 'peer "react" range "^18.0.0" matches no installed version',
      },
    ])
  })

  it('throws INVALID_INPUT on a malformed peer range', () => {
    const input =
      '__metadata:\n  version: 7\n\n' +
      '"host@npm:1.0.0":\n' +
      '  version: 1.0.0\n' +
      '  resolution: "host@npm:1.0.0"\n' +
      '  peerDependencies:\n' +
      '    react: definitely-not-a-range\n'

    expect(() => enrichV7(parseV7(input))).toThrow(LockfileError)
    try {
      enrichV7(parseV7(input))
    } catch (error) {
      expect((error as LockfileError).code).toBe('INVALID_INPUT')
    }
  })
})

describe('yarn-berry-v7 — optimize', () => {
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
      m.setTarball({ name: 'orphan', version: '9.9.9' }, { integrity: 'orphan' })
    }).graph
  }

  it('prunes unreachable nodes and tarballs', () => {
    const result = optimizeV7(graphWithOrphan())

    expect(result.graph.getNode('orphan@9.9.9')).toBeUndefined()
    expect(result.graph.tarball({ name: 'orphan', version: '9.9.9' })).toBeUndefined()
  })

  it('is idempotent across stringify/parse', () => {
    const once = optimizeV7(graphWithOrphan())
    const twice = optimizeV7(parseV7(stringifyV7(once.graph)))

    expect(graphSnapshot(twice.graph)).toEqual(graphSnapshot(once.graph))
    expect(twice.diagnostics).toEqual(once.diagnostics)
  })
})
