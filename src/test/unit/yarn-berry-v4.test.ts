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
  check as checkV4,
  enrich as enrichV4,
  optimize as optimizeV4,
  parse as parseV4,
  stringify as stringifyV4,
} from '../../main/ts/formats/yarn-berry-v4.ts'
import { check as checkV5, parse as parseV5 } from '../../main/ts/formats/yarn-berry-v5.ts'
import { check as checkV6, parse as parseV6 } from '../../main/ts/formats/yarn-berry-v6.ts'
import { check as checkV8, parse as parseV8, stringify as stringifyV8 } from '../../main/ts/formats/yarn-berry-v8.ts'
import { mkIntegrity } from '../_integrity-fixtures.ts'
import { parseBerryChecksum } from '../../main/ts/recipe/integrity.ts'
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
  // Note: workspace-cross-refs not generated for v4 (yarn 1.x predates the
  // workspace cross-ref form exercised by that template).
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
  return parseV4(fixture(`${name}/yarn-berry-v4.lock`))
}

function stringifyWithDiagnostics(graph: Graph) {
  const diagnostics: Diagnostic[] = []
  const lockfile = stringifyV4(graph, {
    onDiagnostic(diagnostic) {
      diagnostics.push(diagnostic)
    },
  })

  return { lockfile, diagnostics }
}

describe('yarn-berry-v4 — discriminant and isolation', () => {
  it('accepts v4 lockfile header and rejects v5/v6/v8/v9 headers', () => {
    expect(checkV4(fixture('simple/yarn-berry-v4.lock'))).toBe(true)
    expect(checkV4(fixture('simple/yarn-berry-v5.lock'))).toBe(false)
    expect(checkV4(fixture('simple/yarn-berry-v6.lock'))).toBe(false)
    expect(checkV4(fixture('simple/yarn-berry-v8.lock'))).toBe(false)
    expect(checkV4(fixture('simple/yarn-berry-v9.lock'))).toBe(false)
    expect(checkV5(fixture('simple/yarn-berry-v4.lock'))).toBe(false)
    expect(checkV6(fixture('simple/yarn-berry-v4.lock'))).toBe(false)
    expect(checkV8(fixture('simple/yarn-berry-v4.lock'))).toBe(false)
    expect(checkV9(fixture('simple/yarn-berry-v4.lock'))).toBe(false)
  })

  it('parses with the matching adapter and rejects mismatched lockfileVersion', () => {
    expect(parseV4(fixture('simple/yarn-berry-v4.lock')).getNode('case-simple@0.0.0-use.local')).toBeDefined()
    expect(parseV5(fixture('simple/yarn-berry-v5.lock')).getNode('case-simple@0.0.0-use.local')).toBeDefined()
    expect(parseV6(fixture('simple/yarn-berry-v6.lock')).getNode('case-simple@0.0.0-use.local')).toBeDefined()
    expect(parseV8(fixture('simple/yarn-berry-v8.lock')).getNode('case-simple@0.0.0-use.local')).toBeDefined()
    expect(parseV9(fixture('simple/yarn-berry-v9.lock')).getNode('case-simple@0.0.0-use.local')).toBeDefined()

    for (const lock of [
      fixture('simple/yarn-berry-v5.lock'),
      fixture('simple/yarn-berry-v6.lock'),
      fixture('simple/yarn-berry-v8.lock'),
      fixture('simple/yarn-berry-v9.lock'),
    ]) {
      expect(() => parseV4(lock)).toThrow(LockfileError)
      try {
        parseV4(lock)
      } catch (error) {
        expect((error as LockfileError).code).toBe('FORMAT_MISMATCH')
      }
    }
  })
})

describe('yarn-berry-v4 — parse fixtures', () => {
  it.each(FIXTURES)('parses %s fixture', (fixtureName) => {
    const graph = parseFixtureGraph(fixtureName)

    expect(Array.from(graph.nodes())).not.toHaveLength(0)
  })
})

describe('yarn-berry-v4 — stringify', () => {
  it.each(FIXTURES.filter(name => name !== 'yarn-crlf'))('roundtrips %s at Graph level', (fixtureName) => {
    const original = parseFixtureGraph(fixtureName)
    const emitted = stringifyV4(original)
    const reparsed = parseV4(emitted)

    expect(graphSnapshot(reparsed)).toEqual(graphSnapshot(original))
  })

  it('roundtrips yarn-crlf at Graph level when CRLF is requested', () => {
    const original = parseFixtureGraph('yarn-crlf')
    const emitted = stringifyV4(original, { lineEnding: 'crlf' })
    const reparsed = parseV4(emitted)

    expect(emitted).toContain('\r\n')
    expect(graphSnapshot(reparsed)).toEqual(graphSnapshot(original))
  })

  it('drops parsed conditions with a v4 warning and preserves canonical checksum form', () => {
    const PKG_HEX = createHash('sha512').update('pkg-1.0.0').digest('hex')
    const DEP_HEX = createHash('sha512').update('dep-2.0.0').digest('hex')
    const input =
      '__metadata:\n' +
      '  version: 4\n' +
      '  cacheKey: 7\n\n' +
      '"pkg@npm:1.0.0":\n' +
      '  version: 1.0.0\n' +
      '  resolution: "pkg@npm:1.0.0"\n' +
      '  dependencies:\n' +
      '    dep: 2.0.0\n' +
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

    const original = parseV4(input)
    const { lockfile: emitted, diagnostics } = stringifyWithDiagnostics(original)
    const reparsed = parseV4(emitted)

    expect(emitted).toContain('__metadata:\n  version: 4\n  cacheKey: 7\n')
    expect(emitted).toContain('  dep: 2.0.0\n')
    expect(emitted).toContain(`  checksum: ${PKG_HEX}\n`)
    expect(emitted).not.toContain('  conditions:\n')
    expect(emitted).not.toContain(`checksum: 7/${PKG_HEX}`)
    expect(emitted).not.toContain('compressionLevel:')
    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'YARN_BERRY_V4_CONDITIONS_DROPPED',
        severity: 'warning',
        subject: 'pkg@1.0.0',
      }),
    ]))
    expect(graphSnapshot(reparsed)).toEqual(graphSnapshot(original))
  })
})

// F1 (snapshot.50 round-trip sweep): a yarn-2.0 (berry v4) checksum carries a
// `<cacheKey>/<hex>` prefix (`2/d9b84e…`) just like v8/v9's `10c0/…`. Emit must
// PRESERVE the parsed prefix for every berry generation (round-trip whatever was
// parsed), not drop it for v4/v5/v6 — dropping it produces a lockfile yarn
// rejects, and is an internal inconsistency given v8's `10c0/` is already kept.
// The parsed cacheKey is threaded per-node via `TarballPayload.berryChecksumCacheKey`.
describe('yarn-berry-v4 — checksum cacheKey prefix round-trip (F1)', () => {
  const HEX = 'd9b84e0418596352f8122bf647f630e45a31e5078b663609a69ae2af7035c44a25d63aa11475fd5944360a86d28e4c4d7c538fd807a8b20fd41c1dec3e38f530'

  const v4WithChecksum = (checksum: string): string =>
    '__metadata:\n' +
    '  version: 4\n\n' +
    '"@babel/code-frame@npm:^7.0.0, @babel/code-frame@npm:^7.5.5":\n' +
    '  version: 7.5.5\n' +
    '  resolution: "@babel/code-frame@npm:7.5.5"\n' +
    `  checksum: ${checksum}\n` +
    '  languageName: node\n' +
    '  linkType: hard\n'

  it('keeps the v4 `2/` cacheKey prefix on emit (real yarn-2.0 shape)', () => {
    const out = stringifyV4(parseV4(v4WithChecksum(`2/${HEX}`)))
    expect(out).toContain(`checksum: 2/${HEX}`)
    // the bare-hex form must NOT be emitted — the prefix is preserved, not dropped
    expect(out).not.toContain(`checksum: ${HEX}\n`)
    // re-parse keeps the per-node cacheKey on the payload
    expect(parseV4(out).tarballOf('@babel/code-frame@7.5.5')?.berryChecksumCacheKey).toBe('2')
  })

  it('keeps a bare v4 checksum bare on emit (the repo\'s own bare-v4 fixture shape)', () => {
    const out = stringifyV4(parseV4(v4WithChecksum(HEX)))
    expect(out).toContain(`checksum: ${HEX}`)
    expect(out).not.toContain(`checksum: 2/${HEX}`)
    expect(out).not.toMatch(/checksum: \d+\//)
    expect(parseV4(out).tarballOf('@babel/code-frame@7.5.5')?.berryChecksumCacheKey).toBeUndefined()
  })

  it('the v4 prefix survives a parse → emit → parse round-trip (Graph stable)', () => {
    const g1 = parseV4(v4WithChecksum(`2/${HEX}`))
    const g2 = parseV4(stringifyV4(g1))
    expect(g2.tarballOf('@babel/code-frame@7.5.5')?.integrity)
      .toEqual(g1.tarballOf('@babel/code-frame@7.5.5')?.integrity)
    expect(g2.tarballOf('@babel/code-frame@7.5.5')?.berryChecksumCacheKey).toBe('2')
  })

  it('does NOT regress v8 `10c0/` (still prefixed byte-faithfully)', () => {
    const v8 =
      '__metadata:\n' +
      '  version: 8\n' +
      '  cacheKey: 10c0\n\n' +
      '"@babel/code-frame@npm:7.5.5":\n' +
      '  version: 7.5.5\n' +
      '  resolution: "@babel/code-frame@npm:7.5.5"\n' +
      `  checksum: 10c0/${HEX}\n` +
      '  languageName: node\n' +
      '  linkType: hard\n'
    const out = stringifyV8(parseV8(v8))
    expect(out).toContain(`checksum: 10c0/${HEX}`)
    expect(parseV8(out).tarballOf('@babel/code-frame@7.5.5')?.berryChecksumCacheKey).toBe('10c0')
  })
})

describe('yarn-berry-v4 — modify', () => {
  it('roundtrips addEdge', () => {
    const original = parseFixtureGraph('simple')
    const result = original.mutate(m => {
      m.addEdge('lodash@4.17.21', 'ms@2.1.3', 'dep', { range: 'npm:2.1.3' })
    })
    const reparsed = parseV4(stringifyV4(result.graph))

    expectEmptyGraphDiff(result.graph.diff(reparsed))
  })

  it('roundtrips removeEdge', () => {
    const original = parseFixtureGraph('simple')
    const result = original.mutate(m => {
      m.removeEdge('case-simple@0.0.0-use.local', 'ms@2.1.3', 'dep')
    })
    const reparsed = parseV4(stringifyV4(result.graph))

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
    const reparsed = parseV4(stringifyV4(result.graph))

    expectEmptyGraphDiff(result.graph.diff(reparsed))
  })

  it('roundtrips removeNode', () => {
    const original = parseFixtureGraph('simple')
    const result = original.mutate(m => {
      m.removeEdge('case-simple@0.0.0-use.local', 'ms@2.1.3', 'dep')
      m.removeNode('ms@2.1.3')
    })
    const reparsed = parseV4(stringifyV4(result.graph))

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
    const reparsed = parseV4(stringifyV4(result.graph))

    expectEmptyGraphDiff(result.graph.diff(reparsed))
  })

  it('roundtrips replacePeerContext to the flattened graph with a v4 warning', () => {
    const original = parseFixtureGraph('peers-basic')
    const result = original.mutate(m => {
      m.replacePeerContext('react-dom@18.2.0', ['react@18.2.0'])
    })
    const { lockfile, diagnostics } = stringifyWithDiagnostics(result.graph)
    const reparsed = parseV4(lockfile)

    expectEmptyGraphDiff(original.diff(reparsed))
    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'YARN_BERRY_V4_PEER_VIRT_FLATTENED',
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
    const emitted = stringifyV4(result.graph)
    const reparsed = parseV4(emitted)

    expectEmptyGraphDiff(result.graph.diff(reparsed))
    expect(emitted).toContain(`checksum: ${MODIFIED_HEX}`)
    expect(emitted).not.toContain(`checksum: 7/${MODIFIED_HEX}`)
    // ADR-0014 §4.F3 — the round-trip parse re-derives canonical resolution
    // from the on-disk `resolution:` line; the set-via-mutator integrity is
    // what we assert here, not the full payload shape.
    expect(reparsed.tarballOf('ms@2.1.3')?.integrity).toEqual(parseBerryChecksum(MODIFIED_HEX).integrity)
  })

  it('roundtrips removeTarball', () => {
    const original = parseFixtureGraph('simple')
    const result = original.mutate(m => {
      m.removeTarball({ name: 'ms', version: '2.1.3' })
    })
    const reparsed = parseV4(stringifyV4(result.graph))

    expectEmptyGraphDiff(result.graph.diff(reparsed))
    // ADR-0014 §4.F3 — yarn-berry always emits a `resolution:` line; the
    // round-trip parse re-derives canonical resolution onto the payload.
    // Integrity is what removeTarball was about — assert it's gone.
    expect(reparsed.tarballOf('ms@2.1.3')?.integrity).toBeUndefined()
  })
})

describe('yarn-berry-v4 — enrich', () => {
  it('derives a peer edge and virtualizes the consumer when one candidate matches', () => {
    const input =
      '__metadata:\n  version: 4\n\n' +
      '"host@npm:1.0.0":\n' +
      '  version: 1.0.0\n' +
      '  resolution: "host@npm:1.0.0"\n' +
      '  peerDependencies:\n' +
      '    react: ^18.0.0\n' +
      '"react@npm:18.2.0":\n' +
      '  version: 18.2.0\n' +
      '  resolution: "react@npm:18.2.0"\n'

    const result = enrichV4(parseV4(input))

    expect(result.diagnostics).toEqual([])
    expect(result.graph.getNode('host@1.0.0(react@18.2.0)')).toBeDefined()
  })

  it('warns when a peer range is ambiguous', () => {
    const input =
      '__metadata:\n  version: 4\n\n' +
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

    expect(enrichV4(parseV4(input)).diagnostics).toEqual([
      {
        code: 'YARN_BERRY_V4_PEER_AMBIGUOUS',
        severity: 'warning',
        subject: 'host@1.0.0',
        message: 'peer "react" matches multiple installed versions: [react@17.0.2, react@18.2.0]',
      },
    ])
  })

  it('warns when a peer range is unsatisfied', () => {
    const input =
      '__metadata:\n  version: 4\n\n' +
      '"host@npm:1.0.0":\n' +
      '  version: 1.0.0\n' +
      '  resolution: "host@npm:1.0.0"\n' +
      '  peerDependencies:\n' +
      '    react: ^18.0.0\n' +
      '"react@npm:17.0.2":\n' +
      '  version: 17.0.2\n' +
      '  resolution: "react@npm:17.0.2"\n'

    expect(enrichV4(parseV4(input)).diagnostics).toEqual([
      {
        code: 'YARN_BERRY_V4_PEER_UNSATISFIED',
        severity: 'warning',
        subject: 'host@1.0.0',
        message: 'peer "react" range "^18.0.0" matches no installed version',
      },
    ])
  })

  it('throws INVALID_INPUT on a malformed peer range', () => {
    const input =
      '__metadata:\n  version: 4\n\n' +
      '"host@npm:1.0.0":\n' +
      '  version: 1.0.0\n' +
      '  resolution: "host@npm:1.0.0"\n' +
      '  peerDependencies:\n' +
      '    react: definitely-not-a-range\n'

    expect(() => enrichV4(parseV4(input))).toThrow(LockfileError)
    try {
      enrichV4(parseV4(input))
    } catch (error) {
      expect((error as LockfileError).code).toBe('INVALID_INPUT')
    }
  })
})

describe('yarn-berry-v4 — optimize', () => {
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
      m.setTarball({ name: 'orphan', version: '9.9.9' }, { integrity: mkIntegrity('orphan') })
    }).graph
  }

  it('prunes unreachable nodes and tarballs', () => {
    const result = optimizeV4(graphWithOrphan())

    expect(result.graph.getNode('orphan@9.9.9')).toBeUndefined()
    expect(result.graph.tarball({ name: 'orphan', version: '9.9.9' })).toBeUndefined()
  })

  it('is idempotent across stringify/parse', () => {
    const once = optimizeV4(graphWithOrphan())
    const twice = optimizeV4(parseV4(stringifyV4(once.graph)))

    expect(graphSnapshot(twice.graph)).toEqual(graphSnapshot(once.graph))
    expect(twice.diagnostics).toEqual(once.diagnostics)
  })
})
