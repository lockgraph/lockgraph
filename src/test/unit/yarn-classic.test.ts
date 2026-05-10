import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { type Graph, type GraphDiff } from '../../main/ts/graph.ts'
import { LockfileError } from '../../main/ts/errors.ts'
import { check as checkV4, parse as parseV4 } from '../../main/ts/formats/yarn-berry-v4.ts'
import { check as checkV5, parse as parseV5 } from '../../main/ts/formats/yarn-berry-v5.ts'
import { check as checkV6, parse as parseV6 } from '../../main/ts/formats/yarn-berry-v6.ts'
import { check as checkV8, parse as parseV8 } from '../../main/ts/formats/yarn-berry-v8.ts'
import { check as checkV9, parse as parseV9 } from '../../main/ts/formats/yarn-berry-v9.ts'
import { check, parse, stringify } from '../../main/ts/formats/yarn-classic.ts'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = (rel: string): string =>
  readFileSync(resolve(here, '../resources/fixtures/lockfiles', rel), 'utf8')

const FIXTURES = [
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
  return parse(fixture(`${name}/yarn-classic.lock`))
}

describe('yarn-classic — discriminant and isolation', () => {
  it('accepts the classic header and rejects yarn-berry headers', () => {
    const classic = fixture('simple/yarn-classic.lock')
    const v4 = fixture('simple/yarn-berry-v4.lock')
    const v5 = fixture('simple/yarn-berry-v5.lock')
    const v6 = fixture('simple/yarn-berry-v6.lock')
    const v8 = fixture('simple/yarn-berry-v8.lock')
    const v9 = fixture('simple/yarn-berry-v9.lock')

    expect(check(classic)).toBe(true)
    expect(check(v4)).toBe(false)
    expect(check(v5)).toBe(false)
    expect(check(v6)).toBe(false)
    expect(check(v8)).toBe(false)
    expect(check(v9)).toBe(false)

    expect(checkV4(classic)).toBe(false)
    expect(checkV5(classic)).toBe(false)
    expect(checkV6(classic)).toBe(false)
    expect(checkV8(classic)).toBe(false)
    expect(checkV9(classic)).toBe(false)
  })

  it('parses only with the matching adapter', () => {
    const classic = fixture('simple/yarn-classic.lock')
    const v4 = fixture('simple/yarn-berry-v4.lock')
    const v5 = fixture('simple/yarn-berry-v5.lock')
    const v6 = fixture('simple/yarn-berry-v6.lock')
    const v8 = fixture('simple/yarn-berry-v8.lock')
    const v9 = fixture('simple/yarn-berry-v9.lock')

    expect(parse(classic).getNode('lodash@4.17.21')).toBeDefined()
    expect(parseV4(v4).getNode('case-simple@0.0.0-use.local')).toBeDefined()
    expect(parseV5(v5).getNode('case-simple@0.0.0-use.local')).toBeDefined()
    expect(parseV6(v6).getNode('case-simple@0.0.0-use.local')).toBeDefined()
    expect(parseV8(v8).getNode('case-simple@0.0.0-use.local')).toBeDefined()
    expect(parseV9(v9).getNode('case-simple@0.0.0-use.local')).toBeDefined()

    for (const lock of [v4, v5, v6, v8, v9]) {
      expect(() => parse(lock)).toThrow(LockfileError)
      try {
        parse(lock)
      } catch (error) {
        expect((error as LockfileError).code).toBe('FORMAT_MISMATCH')
      }
    }

    for (const parseOther of [parseV4, parseV5, parseV6, parseV8, parseV9]) {
      expect(() => parseOther(classic)).toThrow()
    }
  })
})

describe('yarn-classic — parse fixtures', () => {
  it.each(FIXTURES)('parses %s fixture', (fixtureName) => {
    const graph = parseFixtureGraph(fixtureName)
    expect(Array.from(graph.nodes())).not.toHaveLength(0)
  })
})

describe('yarn-classic — stringify', () => {
  it.each(FIXTURES.filter(name => name !== 'yarn-crlf'))('roundtrips %s at Graph level', (fixtureName) => {
    const original = parseFixtureGraph(fixtureName)
    const emitted = stringify(original)
    const reparsed = parse(emitted)

    expect(graphSnapshot(reparsed)).toEqual(graphSnapshot(original))
    expectEmptyGraphDiff(original.diff(reparsed))
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
})
