import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { type Graph, type GraphDiff } from '../../main/ts/graph.ts'
import { LockfileError } from '../../main/ts/errors.ts'
import { check, parse, stringify } from '../../main/ts/formats/npm-3.ts'
import { parse as parseClassic } from '../../main/ts/formats/yarn-classic.ts'
import { parse as parseV9 } from '../../main/ts/formats/yarn-berry-v9.ts'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = (rel: string): string =>
  readFileSync(resolve(here, '../resources/fixtures/lockfiles', rel), 'utf8')

// Phase §A working fixture set per ADR-0021 §"Acceptance gate — per-version".
const FIXTURES = [
  'bundled-deps',
  'deps-with-scopes',
  'git-github-tarball',
  'peers-basic',
  'peers-multi',
  'simple',
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
    tarballs: Array.from(graph.tarballs(), ([key, payload]) => [key, payload] as const),
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
  return parse(fixture(`${name}/npm-3.lock`))
}

describe('npm-3 — discriminant and isolation (§A cross-version)', () => {
  it('accepts an npm-3 header and rejects npm-1 / npm-2 / yarn-* / pnpm-* / bun-text', () => {
    const v3 = fixture('simple/npm-3.lock')
    const v1 = fixture('simple/npm-1.lock')
    const v2 = fixture('simple/npm-2.lock')
    const yarnClassic = fixture('simple/yarn-classic.lock')
    const yarnBerry = fixture('simple/yarn-berry-v9.lock')

    expect(check(v3)).toBe(true)
    expect(check(v1)).toBe(false)
    expect(check(v2)).toBe(false)
    expect(check(yarnClassic)).toBe(false)
    expect(check(yarnBerry)).toBe(false)
  })

  it('parse rejects lockfileVersion 1 with FORMAT_MISMATCH', () => {
    const v1 = fixture('simple/npm-1.lock')
    expect(() => parse(v1)).toThrow(LockfileError)
    try { parse(v1) } catch (error) {
      expect((error as LockfileError).code).toBe('FORMAT_MISMATCH')
      expect((error as LockfileError).message).toContain('lockfileVersion 3')
    }
  })

  it('parse rejects lockfileVersion 2 with FORMAT_MISMATCH', () => {
    const v2 = fixture('simple/npm-2.lock')
    expect(() => parse(v2)).toThrow(LockfileError)
    try { parse(v2) } catch (error) {
      expect((error as LockfileError).code).toBe('FORMAT_MISMATCH')
      expect((error as LockfileError).message).toContain('lockfileVersion 3')
    }
  })

  it('parse rejects yarn-classic input with FORMAT_MISMATCH (non-JSON)', () => {
    const yarnClassic = fixture('simple/yarn-classic.lock')
    expect(() => parse(yarnClassic)).toThrow(LockfileError)
    try { parse(yarnClassic) } catch (error) {
      expect((error as LockfileError).code).toBe('FORMAT_MISMATCH')
    }
  })

  it('parse rejects yarn-berry-v9 input with FORMAT_MISMATCH (non-JSON)', () => {
    const yarnBerry = fixture('simple/yarn-berry-v9.lock')
    expect(() => parse(yarnBerry)).toThrow(LockfileError)
    try { parse(yarnBerry) } catch (error) {
      expect((error as LockfileError).code).toBe('FORMAT_MISMATCH')
    }
  })

  it('cross-adapter probe: yarn-classic / yarn-berry-v9 parsers reject npm-3 input', () => {
    const v3 = fixture('simple/npm-3.lock')
    expect(() => parseClassic(v3)).toThrow()
    expect(() => parseV9(v3)).toThrow()
  })
})

describe('npm-3 — parse fixtures', () => {
  it.each(FIXTURES)('parses %s fixture', (fixtureName) => {
    const graph = parseFixtureGraph(fixtureName)
    expect(Array.from(graph.nodes())).not.toHaveLength(0)
  })

  it('parses the root node with workspacePath = ""', () => {
    const graph = parseFixtureGraph('simple')
    const root = graph.getNode('case-simple@0.0.0')
    expect(root).toBeDefined()
    expect(root?.workspacePath).toBe('')
  })

  it('parses node_modules entries into (name, version) graph nodes with tarball payload', () => {
    const graph = parseFixtureGraph('simple')
    const ms = graph.getNode('ms@2.1.3')
    expect(ms).toBeDefined()
    expect(ms?.peerContext).toEqual([])
    const tarball = graph.tarballOf('ms@2.1.3')
    expect(tarball?.integrity).toBe('sha512-6FlzubTLZG3J2a/NVCAleEhjzq5oxgHyaCU9yYXvcLsvoVaHJq/s5xXI6/XXP6tz7R9xAOtHnSO/tXtF3WRTlA==')
  })

  it('parses root dependencies into dep edges from the root node', () => {
    const graph = parseFixtureGraph('simple')
    const out = graph.out('case-simple@0.0.0')
    const depEdges = out.filter(edge => edge.kind === 'dep').map(edge => edge.dst).sort()
    expect(depEdges).toEqual(['lodash@4.17.21', 'ms@2.1.3'])
  })

  it('does not derive peer edges in phase A (ADR-0021 §A.npm-3 inherits ADR-0016 §A.4 known degradation)', () => {
    // peerDependencies blocks are stashed in the parse-time sidecar so
    // stringify can round-trip them on-disk, but they are NOT converted
    // into graph peer edges until §C lands (parser-side peer derivation).
    const graph = parseFixtureGraph('peers-basic')
    expect(graph.out('react-dom@18.2.0', 'peer')).toEqual([])
    // Roundtrip preserves the peer block on disk despite zero graph edges.
    const emitted = stringify(graph)
    const parsed = JSON.parse(emitted)
    expect(parsed.packages['node_modules/react-dom']?.peerDependencies).toEqual({
      react: '^18.2.0',
    })
  })

  it('parses workspace entries with workspacePath set + symlink resolution', () => {
    const graph = parseFixtureGraph('workspaces-basic')
    const memberA = graph.getNode('@case-ws/a@0.0.0')
    const memberB = graph.getNode('@case-ws/b@0.0.0')
    expect(memberA?.workspacePath).toBe('packages/a')
    expect(memberB?.workspacePath).toBe('packages/b')
    // Each member depends on ms.
    const memberAOut = graph.out('@case-ws/a@0.0.0', 'dep')
    expect(memberAOut.map(e => e.dst)).toEqual(['ms@2.1.3'])
  })

  it('parses de-hoisted nested entries by collapsing onto the canonical NodeId', () => {
    const graph = parseFixtureGraph('peers-multi')
    // peers-multi has root @ 17 + packages/b @ 18 nested. The 18 nodes are
    // canonical regardless of install path.
    expect(graph.getNode('react@17.0.2')).toBeDefined()
    expect(graph.getNode('react@18.2.0')).toBeDefined()
    expect(graph.getNode('react-dom@17.0.2')).toBeDefined()
    expect(graph.getNode('react-dom@18.2.0')).toBeDefined()
  })

  it('records integrity SRI for tarball entries', () => {
    const graph = parseFixtureGraph('deps-with-scopes')
    const t = graph.tarballOf('@sindresorhus/is@6.3.1')
    expect(t?.integrity).toMatch(/^sha512-/)
  })

  it('records resolution URL on node for tarball entries', () => {
    const graph = parseFixtureGraph('simple')
    const ms = graph.getNode('ms@2.1.3')
    expect(ms?.resolution).toBeUndefined() // resolution is not synced from `resolved` to Node; lives in sidecar / tarball flow.
  })

  it('emits NPM_V3_UNEXPECTED_LEGACY_MIRROR when input carries top-level dependencies', () => {
    const malformed = JSON.stringify({
      name: 'x',
      version: '0.0.0',
      lockfileVersion: 3,
      requires: true,
      dependencies: { ms: { version: '2.1.3' } },
      packages: {
        '': { name: 'x', version: '0.0.0', dependencies: { ms: '2.1.3' } },
        'node_modules/ms': { version: '2.1.3', resolved: 'https://registry.npmjs.org/ms/-/ms-2.1.3.tgz', integrity: 'sha512-abc' },
      },
    }, null, 2)
    const graph = parse(malformed)
    const codes = graph.diagnostics().map(d => d.code)
    expect(codes).toContain('NPM_V3_UNEXPECTED_LEGACY_MIRROR')
  })
})

describe('npm-3 — stringify (§A.4 Graph-level roundtrip)', () => {
  // §A.4 predicate per ADR-0016 §A.4: parse(stringify(parse(x))).diff(parse(x))
  // is structurally empty + tarballs() iteration-equal.
  it.each(FIXTURES.filter(name => name !== 'yarn-crlf'))('roundtrips %s at Graph level', (fixtureName) => {
    const original = parseFixtureGraph(fixtureName)
    const emitted = stringify(original)
    const reparsed = parse(emitted)

    expect(graphSnapshot(reparsed)).toEqual(graphSnapshot(original))
    expectEmptyGraphDiff(original.diff(reparsed))
    expect(Array.from(reparsed.tarballs())).toEqual(Array.from(original.tarballs()))
  })

  it('emits well-formed JSON (re-parsing through JSON.parse succeeds)', () => {
    const graph = parseFixtureGraph('simple')
    const text = stringify(graph)
    expect(() => JSON.parse(text)).not.toThrow()
    const parsed = JSON.parse(text)
    expect(parsed.lockfileVersion).toBe(3)
    expect(parsed.packages).toBeDefined()
    expect(typeof parsed.packages).toBe('object')
  })

  it('emits canonical 2-space indent + trailing newline', () => {
    const graph = parseFixtureGraph('simple')
    const text = stringify(graph)
    expect(text.endsWith('\n')).toBe(true)
    expect(text).toContain('\n  "name":')
    expect(text).toContain('\n    "":')
  })

  it('emits packages map sorted alphabetically', () => {
    const graph = parseFixtureGraph('simple')
    const text = stringify(graph)
    const obj = JSON.parse(text)
    const keys = Object.keys(obj.packages)
    expect(keys).toEqual([...keys].sort())
  })

  it('roundtrips yarn-crlf at Graph level when CRLF is requested', () => {
    const original = parseFixtureGraph('yarn-crlf')
    const emitted = stringify(original, { lineEnding: 'crlf' })
    const reparsed = parse(emitted)

    expect(emitted).toContain('\r\n')
    expect(emitted.replace(/\r\n/g, '\n')).toBe(stringify(original))
    expect(graphSnapshot(reparsed)).toEqual(graphSnapshot(original))
    expectEmptyGraphDiff(original.diff(reparsed))
  })

  it('preserves bundleDependencies on the root entry across roundtrip', () => {
    const original = parseFixtureGraph('bundled-deps')
    const emitted = stringify(original)
    const parsed = JSON.parse(emitted)
    expect(parsed.packages[''].bundleDependencies).toEqual(['ms'])
  })

  it('preserves workspaces array on the root entry across roundtrip', () => {
    const original = parseFixtureGraph('workspaces-basic')
    const emitted = stringify(original)
    const parsed = JSON.parse(emitted)
    expect(parsed.packages[''].workspaces).toEqual(['packages/*'])
  })

  it('preserves the workspace symlink shape (link: true + resolved: <wsPath>) on roundtrip', () => {
    const original = parseFixtureGraph('workspaces-basic')
    const emitted = stringify(original)
    const parsed = JSON.parse(emitted)
    expect(parsed.packages['node_modules/@case-ws/a']).toEqual({
      resolved: 'packages/a',
      link: true,
    })
    expect(parsed.packages['packages/a']).toMatchObject({
      name: '@case-ws/a',
      version: '0.0.0',
    })
  })
})
