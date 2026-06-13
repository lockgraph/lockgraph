// ADVERSARIAL recompose-fidelity probe — round-trip regression coverage for the
// res=/payload omit-or-verbatim recomposition (undefined-resolution phantom guard,
// scoped-name basename, non-npmjs host, berry locator, url-fragment u-member).
import { describe, expect, it } from 'vitest'
import { newBuilder, serializeNodeId, type Graph, type Node, type TarballPayload } from '../../main/ts/graph.ts'
import { parse, stringify } from '../../main/ts/formats/lockgraph.ts'
import { graphSnapshot, expectEmptyGraphDiff } from '../helpers/lockfile-test-utils.ts'
import { sri } from '../_integrity-fixtures.ts'

const PINNED = '2026-01-01T00:00:00Z'
const realSri = () => sri('sha512-' + 'a'.repeat(86) + '==')

function rt(g: Graph): { text1: string; g2: Graph } {
  const text1 = stringify(g, { generatedAt: PINNED })
  const g2 = parse(text1)
  expectEmptyGraphDiff(g.diff(g2))
  expectEmptyGraphDiff(g2.diff(g))
  expect(graphSnapshot(g2)).toEqual(graphSnapshot(g))
  const text2 = stringify(g2, { generatedAt: PINNED })
  expect(text2).toBe(text1)
  return { text1, g2 }
}

// Build a graph with a root workspace + one registry node carrying a given payload.
function single(name: string, version: string, payload: TarballPayload, resolution?: string): Graph {
  const b = newBuilder()
  const rootId = serializeNodeId('root', '0.0.0', [])
  const root: Node = { id: rootId, name: 'root', version: '0.0.0', peerContext: [], workspacePath: '' }
  b.addNode(root)
  const id = serializeNodeId(name, version, [])
  const node: Node = { id, name, version, peerContext: [] }
  if (resolution !== undefined) node.resolution = resolution
  b.addNode(node)
  b.setTarball({ name, version }, payload)
  return b.seal()
}

const NPMJS = 'https://registry.npmjs.org'
const YARNPKG = 'https://registry.yarnpkg.com'
const canon = (base: string, name: string, version: string) => {
  const basename = name.startsWith('@') ? name.slice(name.indexOf('/') + 1) : name
  return `${base}/${name}/-/${basename}-${version}.tgz`
}

describe('recompose adversarial', () => {
  it('S1 @scope/pkg basename canonical recompose', () => {
    rt(single('@vue/shared', '3.4.0', {
      integrity: realSri(),
      resolution: { type: 'tarball', url: canon(NPMJS, '@vue/shared', '3.4.0') },
    }))
  })

  it('S2 names with dots and dashes', () => {
    rt(single('lodash.merge', '4.6.2', {
      integrity: realSri(),
      resolution: { type: 'tarball', url: canon(NPMJS, 'lodash.merge', '4.6.2') },
    }))
  })

  it('S3 yarnpkg.com host', () => {
    rt(single('lodash', '4.17.3', {
      integrity: realSri(),
      resolution: { type: 'tarball', url: canon(YARNPKG, 'lodash', '4.17.3') },
    }, `${canon(YARNPKG, 'lodash', '4.17.3')}#d077f6825571f82132f9dffaed587b4029feff57`))
  })

  it('S4 berry locator for npm-ALIASED package (Node.resolution = name@npm:version)', () => {
    rt(single('react-is', '18.2.0', {
      integrity: realSri(),
      resolution: { type: 'tarball', url: canon(NPMJS, 'react-is', '18.2.0') },
    }, 'react-is@npm:18.2.0'))
  })

  it('S5 HIGHEST RISK — Node.resolution undefined, payload.resolution canonical tarball (hosted R row)', () => {
    // Node.resolution intentionally OMITTED. payload.resolution is canonical tarball.
    const g = single('@scope/x', '1.0.0', {
      integrity: realSri(),
      resolution: { type: 'tarball', url: canon(NPMJS, '@scope/x', '1.0.0') },
    })
    const { g2 } = rt(g)
    // The reconstructed node MUST NOT have invented a Node.resolution string.
    const n = Array.from(g2.nodes()).find(n => n.name === '@scope/x')!
    expect(n.resolution).toBeUndefined()
  })

  it('S6 payload.resolution with EXTRA key hostingProvider — stays verbatim', () => {
    rt(single('@scope/y', '2.0.0', {
      integrity: realSri(),
      resolution: { type: 'tarball', url: canon(NPMJS, '@scope/y', '2.0.0'), hostingProvider: 'github' },
    }))
  })

  it('S7 fragment-less classic URL (Node.resolution = canonical URL, NO #sha1)', () => {
    rt(single('foo', '1.0.0', {
      integrity: realSri(),
      resolution: { type: 'tarball', url: canon(NPMJS, 'foo', '1.0.0') },
    }, canon(NPMJS, 'foo', '1.0.0')))
  })

  it('S8 registry node with NO payload.resolution at all (npm + - row), Node.resolution undefined', () => {
    const g = single('bare', '1.0.0', { integrity: realSri() })
    const { g2, text1 } = rt(g)
    const n = Array.from(g2.nodes()).find(n => n.name === 'bare')!
    expect(n.resolution).toBeUndefined()
    // payload.resolution must STAY undefined — no hosted base existed.
    expect(g2.tarball({ name: 'bare', version: '1.0.0' })?.resolution).toBeUndefined()
    // sanity: the R row is `npm\t-`
    expect(text1).toContain('npm\t-')
  })

  it('S9 %2f-encoded scope separator in URL (non-canonical shape) stays verbatim', () => {
    // npm sometimes encodes the slash; basename strip uses indexOf("/") which
    // won't match %2f, so npmRegistryBaseOf should fail → verbatim tarball R row.
    const url = `${NPMJS}/@scope%2fz/-/z-1.0.0.tgz`
    rt(single('@scope/z', '1.0.0', {
      integrity: realSri(),
      resolution: { type: 'tarball', url },
    }))
  })

  it('S10 payload.resolution canonical tarball BUT Node.resolution is a DIFFERENT verbatim string', () => {
    // hosted R row (from payload.resolution) + a Node.resolution that is NOT the
    // berry locator and NOT canonicalURL#sha1 → res= verbatim, payload omitted.
    rt(single('mixed', '1.0.0', {
      integrity: realSri(),
      resolution: { type: 'tarball', url: canon(NPMJS, 'mixed', '1.0.0') },
    }, 'mixed@npm:1.0.0::__archiveUrl=weird'))
  })
})
