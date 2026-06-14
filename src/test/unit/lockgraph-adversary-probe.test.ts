import { describe, expect, it } from 'vitest'
import { newBuilder, serializeNodeId, type Graph } from '../../main/ts/graph.ts'
import { parse, stringify } from '../../main/ts/formats/lockgraph.ts'
import { expectEmptyGraphDiff, graphSnapshot } from '../helpers/lockfile-test-utils.ts'

const PINNED = '2026-01-01T00:00:00Z'

function rt(g: Graph): string {
  const t1 = stringify(g, { generatedAt: PINNED })
  const g2 = parse(t1)
  expectEmptyGraphDiff(g.diff(g2))
  expectEmptyGraphDiff(g2.diff(g))
  expect(graphSnapshot(g2)).toEqual(graphSnapshot(g))
  const t2 = stringify(g2, { generatedAt: PINNED })
  expect(t2).toBe(t1)
  return t1
}

function rowOf(text: string, name: string): string {
  return text.split('\n').find(l => l.startsWith(name + '\t'))!
}

describe('adversary probe — recompose fidelity', () => {
  it('V1 @scope/pkg fragment-form classic URL', () => {
    const b = newBuilder()
    const url = 'https://registry.npmjs.org/@vue/shared/-/shared-3.4.0.tgz'
    const sha1 = 'a'.repeat(40)
    const id = serializeNodeId('@vue/shared', '3.4.0', [])
    b.addNode({ id, name: '@vue/shared', version: '3.4.0', peerContext: [] })
    b.setTarball({ name: '@vue/shared', version: '3.4.0' }, { resolution: { type: 'tarball', url }, nativeResolution: `${url}#${sha1}` })
    const text = rt(b.seal())
    const row = rowOf(text, '@vue/shared')
    expect(row.split('\t')[3]).toBe(`usha1-${sha1}`)
    // the native rides the u-member, so no F nativeResolution slot for this tarball.
    expect(text.split('\n').some(l => l.startsWith('@vue/shared@3.4.0\t'))).toBe(false)
  })

  it('V2 name with dots and dashes', () => {
    const b = newBuilder()
    const url = 'https://registry.npmjs.org/lodash.merge/-/lodash.merge-4.6.2.tgz'
    const sha1 = 'b'.repeat(40)
    const id = serializeNodeId('lodash.merge', '4.6.2', [])
    b.addNode({ id, name: 'lodash.merge', version: '4.6.2', peerContext: [] })
    b.setTarball({ name: 'lodash.merge', version: '4.6.2' }, { resolution: { type: 'tarball', url }, nativeResolution: `${url}#${sha1}` })
    const text = rt(b.seal())
    expect(rowOf(text, 'lodash.merge').split('\t')[3]).toBe(`usha1-${sha1}`)
  })

  it('V3 %2f-encoded scope separator in URL', () => {
    // npm sometimes encodes the scope slash as %2f in the resolved URL path.
    const b = newBuilder()
    const url = 'https://registry.npmjs.org/@babel%2fcore/-/core-7.0.0.tgz'
    const sha1 = 'c'.repeat(40)
    const id = serializeNodeId('@babel/core', '7.0.0', [])
    b.addNode({ id, name: '@babel/core', version: '7.0.0', peerContext: [] })
    b.setTarball({ name: '@babel/core', version: '7.0.0' }, { resolution: { type: 'tarball', url }, nativeResolution: `${url}#${sha1}` })
    const text = rt(b.seal())
    const row = rowOf(text, '@babel/core')
    // exact-match should FAIL (url has %2f, recompose uses /), so nativeResolution= verbatim.
    // Either outcome must round-trip — assertion is identity (rt already checks).
    expect(row).toBeTruthy()
  })

  it('V4 yarnpkg.com host vs npmjs.org', () => {
    const b = newBuilder()
    const url = 'https://registry.yarnpkg.com/JSV/-/JSV-4.0.2.tgz'
    const sha1 = 'd'.repeat(40)
    const id = serializeNodeId('JSV', '4.0.2', [])
    b.addNode({ id, name: 'JSV', version: '4.0.2', peerContext: [] })
    b.setTarball({ name: 'JSV', version: '4.0.2' }, { resolution: { type: 'tarball', url }, nativeResolution: `${url}#${sha1}` })
    const text = rt(b.seal())
    expect(rowOf(text, 'JSV').split('\t')[3]).toBe(`usha1-${sha1}`)
  })

  it('V5 berry locator for npm-ALIASED package (node.name == target)', () => {
    const b = newBuilder()
    const id = serializeNodeId('string-width', '4.2.3', [])
    b.addNode({ id, name: 'string-width', version: '4.2.3', peerContext: [] })
    b.setTarball({ name: 'string-width', version: '4.2.3' }, { resolution: { type: 'tarball', url: 'https://registry.yarnpkg.com/string-width/-/string-width-4.2.3.tgz' }, nativeResolution: 'string-width@npm:4.2.3' })
    const text = rt(b.seal())
    const fRow = text.split('\n').find(l => l.startsWith('string-width@4.2.3\t'))!
    expect(fRow).toContain('\tnativeResolution.berry=')
  })

  it('V6 payload.resolution with EXTRA keys (hostingProvider on tarball)', () => {
    const b = newBuilder()
    const url = 'https://registry.npmjs.org/x/-/x-1.0.0.tgz'
    const id = serializeNodeId('x', '1.0.0', [])
    b.addNode({ id, name: 'x', version: '1.0.0', peerContext: [] })
    // Artificially attach hostingProvider to a registry tarball (3 keys). The
    // extra key means it is NOT the bare recomposable 2-key shape, so the WHOLE
    // union flattens under the F row's `resolution.*` dot-path slots (no JSON).
    b.setTarball({ name: 'x', version: '1.0.0' }, { resolution: { type: 'tarball', url, hostingProvider: 'github' } })
    const text = rt(b.seal())
    const fRow = text.split('\n').find(l => l.startsWith('x@1.0.0\t'))!
    expect(fRow).toBeDefined()
    expect(fRow).toContain('\tresolution.hostingProvider=github')
  })

  it('V7 tarball with NO nativeResolution but hosted npm payload — stays undefined', () => {
    const b = newBuilder()
    const url = 'https://registry.npmjs.org/ms/-/ms-2.1.3.tgz'
    const id = serializeNodeId('ms', '2.1.3', [])
    b.addNode({ id, name: 'ms', version: '2.1.3', peerContext: [] })
    b.setTarball({ name: 'ms', version: '2.1.3' }, { resolution: { type: 'tarball', url } })
    const text = rt(b.seal())
    const g2 = parse(text)
    expect(g2.tarball({ name: 'ms', version: '2.1.3' })!.nativeResolution).toBeUndefined()
  })

  it('V8 HARDEST: undefined nativeResolution + hosted payload + payload has OTHER fields', () => {
    // Does the recompose mint a phantom resolution? And does the omitted
    // payload.resolution survive next to residual fields?
    const b = newBuilder()
    const url = 'https://registry.npmjs.org/ms/-/ms-2.1.3.tgz'
    const id = serializeNodeId('ms', '2.1.3', [])
    b.addNode({ id, name: 'ms', version: '2.1.3', peerContext: [] })
    b.setTarball({ name: 'ms', version: '2.1.3' }, {
      resolution: { type: 'tarball', url },
      license: 'MIT',
      engines: { node: '>=4' },
    })
    const text = rt(b.seal())
    const g2 = parse(text)
    expect(g2.tarball({ name: 'ms', version: '2.1.3' })!.nativeResolution).toBeUndefined()
    expect(g2.tarball({ name: 'ms', version: '2.1.3' })!.resolution).toEqual({ type: 'tarball', url })
    expect(g2.tarball({ name: 'ms', version: '2.1.3' })!.license).toBe('MIT')
  })

  it('V9 berry locator BUT no payload.resolution at all (hostedBase undefined)', () => {
    // A bare berry node with NO payload.resolution: R row is npm + `-`. The
    // native rides the F berry-marker, recomposed from the TarballKey.
    const b = newBuilder()
    const id = serializeNodeId('react', '18.0.0', [])
    b.addNode({ id, name: 'react', version: '18.0.0', peerContext: [] })
    b.setTarball({ name: 'react', version: '18.0.0' }, { nativeResolution: 'react@npm:18.0.0' })
    const text = rt(b.seal())
    const fRow = text.split('\n').find(l => l.startsWith('react@18.0.0\t'))!
    expect(fRow).toContain('\tnativeResolution.berry=')
  })

  it('V10 undefined resolution + NO payload at all (R = npm + dash) stays undefined', () => {
    const b = newBuilder()
    const id = serializeNodeId('bare', '1.0.0', [])
    b.addNode({ id, name: 'bare', version: '1.0.0', peerContext: [] })
    const text = rt(b.seal())
    const g2 = parse(text)
    expect(g2.tarball({ name: 'bare', version: '1.0.0' })?.nativeResolution).toBeUndefined()
    // R row should be npm \t -, and parse must NOT recompose a payload.resolution
    // because there was no payload (recomposePR requires hostedBase, which is
    // undefined for url === '-').
    expect(g2.tarball({ name: 'bare', version: '1.0.0' })).toBeUndefined()
  })

  it('V11 DANGER: undefined resolution, no payload.resolution, but payload HAS other fields + hosted-looking R', () => {
    // The node has a payload (so a tarball key exists) with NO resolution field,
    // but its R row is npm + `-` (host unrecorded, because no canonical
    // resolution). hostedBase is undefined → recomposePR false → no phantom.
    const b = newBuilder()
    const id = serializeNodeId('nores', '1.0.0', [])
    b.addNode({ id, name: 'nores', version: '1.0.0', peerContext: [] })
    b.setTarball({ name: 'nores', version: '1.0.0' }, { license: 'ISC' })
    const text = rt(b.seal())
    const g2 = parse(text)
    const p = g2.tarball({ name: 'nores', version: '1.0.0' })!
    expect(p.nativeResolution).toBeUndefined()
    expect(p.resolution).toBeUndefined()  // must NOT be invented
    expect(p.license).toBe('ISC')
  })
})
