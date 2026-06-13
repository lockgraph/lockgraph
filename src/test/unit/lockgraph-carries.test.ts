// lockgraph `carries` — the META fidelity-envelope line (#101).
//
// `carries <token> <token> …` is a self-describing, AUTO-DERIVED declaration of
// which VARIABLE detail facets the graph actually holds — the sorted union of
// the facet tokens for which ≥1 element in the graph carries that detail. It is
// an honest mirror of content, NOT a promise, and it is provenance-class: NOT
// part of graph identity, so parse IGNORES it and re-derives it identically on
// every emit (round-trip stays byte-stable).
//
// Coverage:
//   §1  payload facets (engines + bin) appear, sorted
//   §2  a berry-style payload (bin, no engines) → has `bin` not `engines`
//   §3  a payload-less registry graph → minimal `carries integrity resolution`
//   §4  identity facets — patch / src / peer
//   §5  edge facets — alias / workspace / optional
//   §6  graph-level — layout
//   §7  determinism + sortedness of the token set
//   §8  parse IGNORES `carries`; round-trip byte-stable (the line re-derives)
//   §9  the empty envelope omits the line entirely
//   §10 real fixtures — the envelope mirrors actual content

import { describe, expect, it } from 'vitest'
import {
  newBuilder,
  serializeNodeId,
  type Graph,
  type Node,
  type TarballPayload,
} from '../../main/ts/graph.ts'
import { parse, stringify } from '../../main/ts/formats/lockgraph.ts'
import { parse as parseYarnBerryV8 } from '../../main/ts/formats/yarn-berry-v8.ts'
import { parse as parsePnpmV9 } from '../../main/ts/formats/pnpm-v9.ts'
import { fixture, graphSnapshot, expectEmptyGraphDiff } from '../helpers/lockfile-test-utils.ts'
import { sri } from '../_integrity-fixtures.ts'

const PINNED = '2026-01-01T00:00:00Z'

// Extract the sorted token array of the META `carries` line, or `undefined` when
// the line is absent (the empty-envelope case).
function carriesOf(text: string): string[] | undefined {
  const line = text.split(/\r?\n/).find(l => l.startsWith('carries '))
  if (line === undefined) return undefined
  return line.slice('carries '.length).split(' ')
}

// Serialize with a pinned generatedAt and return the `carries` tokens.
function carriesFor(g: Graph): string[] | undefined {
  return carriesOf(stringify(g, { generatedAt: PINNED }))
}

// Assert a token array is exactly `expected` AND is sorted (ascending). The
// emitter sorts under cmpStr (plain `<`), which for these lowercase ASCII tokens
// is ordinary lexical order.
function expectSortedExactly(actual: string[] | undefined, expected: string[]): void {
  expect(actual).toEqual(expected)
  expect(actual).toEqual([...expected].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)))
}

// A real-looking single SRI for a node, so `integrity` is genuinely present.
const realSri = (seed: string): TarballPayload['integrity'] =>
  sri('sha512-' + seed.repeat(86).slice(0, 86) + '==')

// =====================================================================================
// §1 — payload facets: engines + bin
// =====================================================================================

describe('lockgraph carries §1 — payload facets engines + bin', () => {
  // A registry graph where one node carries `engines` and another carries `bin`.
  // The envelope must include both tokens (plus the always-present integrity /
  // resolution for hosted registry nodes).
  function build(): Graph {
    const b = newBuilder()
    const rootId = serializeNodeId('root', '0.0.0', [])
    const enginesId = serializeNodeId('has-engines', '1.0.0', [])
    const binId = serializeNodeId('has-bin', '2.0.0', [])
    b.addNode({ id: rootId, name: 'root', version: '0.0.0', peerContext: [], workspacePath: '' })
    b.addNode({ id: enginesId, name: 'has-engines', version: '1.0.0', peerContext: [] })
    b.addNode({ id: binId, name: 'has-bin', version: '2.0.0', peerContext: [] })
    b.addEdge(rootId, enginesId, 'dep', { range: '^1.0.0' })
    b.addEdge(rootId, binId, 'dep', { range: '^2.0.0' })
    b.setTarball({ name: 'has-engines', version: '1.0.0' }, {
      integrity: realSri('a'),
      engines: { node: '>=18' },
      resolution: { type: 'tarball', url: 'https://registry.npmjs.org/has-engines/-/has-engines-1.0.0.tgz' },
    })
    b.setTarball({ name: 'has-bin', version: '2.0.0' }, {
      integrity: realSri('b'),
      bin: { 'has-bin': 'cli.js' },
      resolution: { type: 'tarball', url: 'https://registry.npmjs.org/has-bin/-/has-bin-2.0.0.tgz' },
    })
    return b.seal()
  }

  it('carries includes both `bin` and `engines`, sorted', () => {
    const carries = carriesFor(build())
    expect(carries).toContain('bin')
    expect(carries).toContain('engines')
    // bin sorts before engines; the integrity/resolution facets ride along.
    expectSortedExactly(carries, ['bin', 'engines', 'integrity', 'resolution'])
  })
})

// =====================================================================================
// §2 — berry-style payload: bin, NO engines
// =====================================================================================

describe('lockgraph carries §2 — bin without engines', () => {
  // A graph whose only variable payload facet is `bin` (no node carries
  // engines). The envelope must have `bin` and must NOT have `engines`.
  function build(): Graph {
    const b = newBuilder()
    const id = serializeNodeId('loose-envify', '1.4.0', [])
    b.addNode({ id, name: 'loose-envify', version: '1.4.0', peerContext: [] })
    b.setTarball({ name: 'loose-envify', version: '1.4.0' }, {
      integrity: realSri('c'),
      bin: { 'loose-envify': 'cli.js' },
      resolution: { type: 'tarball', url: 'https://registry.npmjs.org/loose-envify/-/loose-envify-1.4.0.tgz' },
    })
    return b.seal()
  }

  it('carries has `bin` but not `engines`', () => {
    const carries = carriesFor(build())
    expect(carries).toContain('bin')
    expect(carries).not.toContain('engines')
    expectSortedExactly(carries, ['bin', 'integrity', 'resolution'])
  })
})

// =====================================================================================
// §3 — payload-less registry graph: minimal envelope
// =====================================================================================

describe('lockgraph carries §3 — minimal envelope (integrity + resolution)', () => {
  // The common registry node carries only its hash + its (recomposed) canonical
  // resolution — no engines/bin/license/etc. The envelope is the minimal
  // `integrity resolution`.
  function build(): Graph {
    const b = newBuilder()
    const id = serializeNodeId('lodash', '4.17.21', [])
    b.addNode({ id, name: 'lodash', version: '4.17.21', peerContext: [] })
    b.setTarball({ name: 'lodash', version: '4.17.21' }, {
      integrity: realSri('d'),
      resolution: { type: 'tarball', url: 'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz' },
    })
    return b.seal()
  }

  it('carries is exactly `integrity resolution`', () => {
    expectSortedExactly(carriesFor(build()), ['integrity', 'resolution'])
  })
})

// =====================================================================================
// §4 — identity facets: patch / src / peer
// =====================================================================================

describe('lockgraph carries §4 — identity facets', () => {
  it('a +patch= node makes carries include `patch`', () => {
    const b = newBuilder()
    const patch = 'unresolved-' + 'a'.repeat(64)
    const id = serializeNodeId('left-pad', '1.3.0', [], patch)
    b.addNode({ id, name: 'left-pad', version: '1.3.0', peerContext: [], patch })
    b.setTarball({ name: 'left-pad', version: '1.3.0', patch }, { integrity: realSri('e') })
    const carries = carriesFor(b.seal())
    expect(carries).toContain('patch')
  })

  it('a +src= node makes carries include `src`', () => {
    const b = newBuilder()
    const src = 'a26ae4a95234d808'
    const id = serializeNodeId('from-git', '1.0.0', [], undefined, src)
    b.addNode({ id, name: 'from-git', version: '1.0.0', peerContext: [], source: src })
    b.setTarball({ name: 'from-git', version: '1.0.0', source: src }, {
      resolution: { type: 'git', url: 'https://github.com/o/from-git.git', sha: 'deadbeef', hostingProvider: 'github' },
    })
    const carries = carriesFor(b.seal())
    expect(carries).toContain('src')
    // a git resolution union is non-canonical → the `resolution` facet too
    expect(carries).toContain('resolution')
  })

  it('a peer-virtualised node makes carries include `peer`', () => {
    const b = newBuilder()
    const reactId = serializeNodeId('react', '18.0.0', [])
    const reactDomId = serializeNodeId('react-dom', '18.0.0', [reactId])
    b.addNode({ id: reactId, name: 'react', version: '18.0.0', peerContext: [] })
    b.addNode({ id: reactDomId, name: 'react-dom', version: '18.0.0', peerContext: [reactId] })
    b.addEdge(reactDomId, reactId, 'peer', { range: '^18.0.0' })
    b.setTarball({ name: 'react', version: '18.0.0' }, { integrity: realSri('f') })
    b.setTarball({ name: 'react-dom', version: '18.0.0' }, { integrity: realSri('0') })
    const carries = carriesFor(b.seal())
    expect(carries).toContain('peer')
  })
})

// =====================================================================================
// §5 — edge facets: alias / workspace / optional
// =====================================================================================

describe('lockgraph carries §5 — edge facets', () => {
  // A root with an optional+aliased edge to a dep, and a workspace edge to a
  // member. All three edge facets appear.
  function build(): Graph {
    const b = newBuilder()
    const root = serializeNodeId('root', '0.0.0', [])
    const dep = serializeNodeId('@scope/pkg', '2.0.0', [])
    const ws = serializeNodeId('@ws/member', '1.0.0', [])
    b.addNode({ id: root, name: 'root', version: '0.0.0', peerContext: [], workspacePath: '' })
    b.addNode({ id: dep, name: '@scope/pkg', version: '2.0.0', peerContext: [] })
    b.addNode({ id: ws, name: '@ws/member', version: '1.0.0', peerContext: [], workspacePath: 'packages/member' })
    b.addEdge(root, dep, 'optional', { range: 'npm:^2.0.0', alias: 'pkg-alias', optional: true })
    b.addEdge(root, ws, 'dep', { range: 'workspace:*', workspace: true, workspaceRange: { specifier: 'workspace:*' } })
    return b.seal()
  }

  it('carries includes `alias`, `optional`, `workspace`', () => {
    const carries = carriesFor(build())
    expect(carries).toContain('alias')
    expect(carries).toContain('optional')
    expect(carries).toContain('workspace')
  })

  it('a single workspace edge yields `workspace` without `alias`/`optional`', () => {
    const b = newBuilder()
    const root = serializeNodeId('root', '0.0.0', [])
    const ws = serializeNodeId('@ws/m', '1.0.0', [])
    b.addNode({ id: root, name: 'root', version: '0.0.0', peerContext: [], workspacePath: '' })
    b.addNode({ id: ws, name: '@ws/m', version: '1.0.0', peerContext: [], workspacePath: 'packages/m' })
    b.addEdge(root, ws, 'dep', { range: 'workspace:^', workspace: true, workspaceRange: { specifier: 'workspace:^' } })
    const carries = carriesFor(b.seal())
    expect(carries).toContain('workspace')
    expect(carries).not.toContain('alias')
    expect(carries).not.toContain('optional')
  })
})

// =====================================================================================
// §6 — graph-level: layout
// =====================================================================================

describe('lockgraph carries §6 — layout hints', () => {
  it('a graph with LayoutHints makes carries include `layout`', () => {
    const b = newBuilder()
    const id = serializeNodeId('ms', '2.1.3', [])
    b.addNode({ id, name: 'ms', version: '2.1.3', peerContext: [] })
    b.layoutHints({ strategy: 'isolated' })
    const carries = carriesFor(b.seal())
    expect(carries).toContain('layout')
  })

  it('a graph with NO LayoutHints omits `layout`', () => {
    const b = newBuilder()
    const id = serializeNodeId('ms', '2.1.3', [])
    b.addNode({ id, name: 'ms', version: '2.1.3', peerContext: [] })
    b.setTarball({ name: 'ms', version: '2.1.3' }, { integrity: realSri('1') })
    const carries = carriesFor(b.seal())
    expect(carries).not.toContain('layout')
  })
})

// =====================================================================================
// §7 — determinism + sortedness
// =====================================================================================

describe('lockgraph carries §7 — determinism + sortedness', () => {
  // A maximally-detailed graph: exercise as many facets as one small graph can,
  // and assert the full token set is BOTH correct AND sorted.
  function buildRich(): Graph {
    const b = newBuilder()
    const root = serializeNodeId('root', '0.0.0', [])
    const lib = serializeNodeId('lib', '1.0.0', [])
    const aliased = serializeNodeId('real-name', '3.0.0', [])
    b.addNode({ id: root, name: 'root', version: '0.0.0', peerContext: [], workspacePath: '' })
    b.addNode({ id: lib, name: 'lib', version: '1.0.0', peerContext: [] })
    b.addNode({ id: aliased, name: 'real-name', version: '3.0.0', peerContext: [] })
    b.addEdge(root, lib, 'dep', { range: '^1.0.0' })
    b.addEdge(root, aliased, 'dep', { range: 'npm:real-name@^3', alias: 'real-name--alias' })
    b.setTarball({ name: 'lib', version: '1.0.0' }, {
      integrity: realSri('2'),
      engines: { node: '>=18' },
      bin: { lib: 'b.js' },
      license: 'MIT',
      deprecated: 'use lib2',
      funding: { url: 'https://funding.example' },
      cpu: ['x64'],
      os: ['linux'],
      libc: ['glibc'],
      bundledDependencies: ['nested'],
      berryChecksumCacheKey: '10c0',
      resolution: { type: 'tarball', url: 'https://registry.npmjs.org/lib/-/lib-1.0.0.tgz' },
    })
    b.setTarball({ name: 'real-name', version: '3.0.0' }, { integrity: realSri('3') })
    b.layoutHints({ strategy: 'hoisted' })
    return b.seal()
  }

  it('the full token set is correct AND sorted', () => {
    const carries = carriesFor(buildRich())
    expectSortedExactly(carries, [
      'alias', 'bin', 'bundled', 'ck', 'cpu', 'deprecated', 'engines',
      'funding', 'integrity', 'layout', 'libc', 'license', 'os', 'resolution',
    ])
  })

  it('two structurally-equal graphs produce a byte-identical carries line', () => {
    const a = carriesFor(buildRich())
    const b = carriesFor(buildRich())
    expect(a).toEqual(b)
    // and the whole document is byte-stable (pinned generatedAt)
    expect(stringify(buildRich(), { generatedAt: PINNED }))
      .toBe(stringify(buildRich(), { generatedAt: PINNED }))
  })
})

// =====================================================================================
// §8 — parse IGNORES carries; round-trip byte-stable (re-derived)
// =====================================================================================

describe('lockgraph carries §8 — provenance-class, not identity', () => {
  function buildSample(): Graph {
    const b = newBuilder()
    const id = serializeNodeId('react', '18.0.0', [])
    const looseId = serializeNodeId('loose-envify', '1.4.0', [])
    b.addNode({ id, name: 'react', version: '18.0.0', peerContext: [] })
    b.addNode({ id: looseId, name: 'loose-envify', version: '1.4.0', peerContext: [] })
    b.addEdge(id, looseId, 'dep', { range: '^1.1.0' })
    b.setTarball({ name: 'react', version: '18.0.0' }, {
      integrity: realSri('4'), engines: { node: '>=0.10.0' },
    })
    b.setTarball({ name: 'loose-envify', version: '1.4.0' }, {
      integrity: realSri('5'), bin: { 'loose-envify': 'cli.js' },
    })
    return b.seal()
  }

  it('round-trips graph-identical with a stable re-derived carries line', () => {
    const g = buildSample()
    const text1 = stringify(g, { generatedAt: PINNED })
    const g2 = parse(text1)

    // identity holds on every axis (the carries line did not perturb parsing)
    expectEmptyGraphDiff(g.diff(g2))
    expectEmptyGraphDiff(g2.diff(g))
    expect(graphSnapshot(g2)).toEqual(graphSnapshot(g))

    // re-serialize is byte-identical — the carries line re-derived to the same bytes
    const text2 = stringify(g2, { generatedAt: PINNED })
    expect(text2).toBe(text1)
    expect(carriesOf(text2)).toEqual(carriesOf(text1))
  })

  it('parse ignores a HAND-MANGLED carries line — it is re-derived on emit', () => {
    const g = buildSample()
    const text = stringify(g, { generatedAt: PINNED })
    const truth = carriesOf(text)!

    // Replace the emitted carries line with a deliberately WRONG one (bogus
    // tokens, wrong set). Parse must not trust it; the re-emit must recompute the
    // true envelope from the reconstructed graph.
    const mangled = text.replace(/^carries .*$/m, 'carries zzz-bogus aaa-fake engines')
    expect(mangled).not.toBe(text)

    const g2 = parse(mangled)
    expectEmptyGraphDiff(g.diff(g2))
    expectEmptyGraphDiff(g2.diff(g))

    const reEmitted = carriesOf(stringify(g2, { generatedAt: PINNED }))
    expect(reEmitted).toEqual(truth)        // the truth, not the mangled tokens
    expect(reEmitted).not.toContain('zzz-bogus')
    expect(reEmitted).not.toContain('aaa-fake')
  })

  it('a document with NO carries line still parses (forward/back compat)', () => {
    const g = buildSample()
    const text = stringify(g, { generatedAt: PINNED })
    const stripped = text.replace(/^carries .*\n/m, '')
    const g2 = parse(stripped)
    expectEmptyGraphDiff(g.diff(g2))
    // and the re-emit synthesises the line from the graph
    expect(carriesOf(stringify(g2, { generatedAt: PINNED }))).toEqual(carriesOf(text))
  })
})

// =====================================================================================
// §9 — empty envelope omits the line
// =====================================================================================

describe('lockgraph carries §9 — empty envelope', () => {
  it('a graph carrying no variable detail omits the carries line', () => {
    // A bare workspace root with no integrity, no resolution, no payload, no
    // edges, no hints — nothing variable to declare.
    const b = newBuilder()
    const root = serializeNodeId('root', '0.0.0', [])
    b.addNode({ id: root, name: 'root', version: '0.0.0', peerContext: [], workspacePath: '' })
    const text = stringify(b.seal(), { generatedAt: PINNED })
    expect(carriesOf(text)).toBeUndefined()
    // explicitly: no `carries ` line anywhere in META
    expect(text.split('\n').some(l => l.startsWith('carries '))).toBe(false)
  })

  it('the carries line, when present, sits after generator', () => {
    const b = newBuilder()
    const id = serializeNodeId('ms', '2.1.3', [])
    b.addNode({ id, name: 'ms', version: '2.1.3', peerContext: [] })
    b.setTarball({ name: 'ms', version: '2.1.3' }, { integrity: realSri('6') })
    const lines = stringify(b.seal(), { generatedAt: PINNED }).split('\n')
    const gen = lines.findIndex(l => l.startsWith('generator '))
    const car = lines.findIndex(l => l.startsWith('carries '))
    expect(gen).toBeGreaterThanOrEqual(0)
    expect(car).toBe(gen + 1)
  })
})

// =====================================================================================
// §10 — real fixtures mirror actual content
// =====================================================================================

describe('lockgraph carries §10 — real fixtures', () => {
  it('peers-multi (pnpm-v9) carries bin engines integrity peer resolution', () => {
    const g = parsePnpmV9(fixture('peers-multi/pnpm-v9.lock'))
    expectSortedExactly(carriesFor(g), ['bin', 'engines', 'integrity', 'peer', 'resolution'])
  })

  it('git-github-tarball (yarn-berry-v8) carries src (non-registry source) + ck', () => {
    const g = parseYarnBerryV8(fixture('git-github-tarball/yarn-berry-v8.lock'))
    const carries = carriesFor(g)
    expect(carries).toContain('src')
    expect(carries).toContain('ck')
    expect(carries).toContain('integrity')
    expect(carries).toContain('resolution')
  })

  it('simple (pnpm-v9) is the minimal integrity + resolution envelope', () => {
    const g = parsePnpmV9(fixture('simple/pnpm-v9.lock'))
    expectSortedExactly(carriesFor(g), ['integrity', 'resolution'])
  })
})
