import { describe, expect, it } from 'vitest'
import {
  newBuilder,
  GraphError,
  serializeNodeId,
  nameOf,
  stripPeerContextFromNodeId,
  toTarballKey,
  type Node,
  type NodeId,
} from '../../main/ts/graph.ts'
import { LockfileError } from '../../main/ts/errors.ts'
import { mkIntegrity } from '../_integrity-fixtures.ts'

const n = (id: NodeId, name: string, version: string, peers: NodeId[] = [], extra: Partial<Node> = {}): Node => ({
  id,
  name,
  version,
  peerContext: peers,
  ...extra,
})

describe('nameOf', () => {
  it('plain', () => {
    expect(nameOf('lodash@4.17.21')).toBe('lodash')
  })
  it('scoped', () => {
    expect(nameOf('@scope/lib@1.0.0')).toBe('@scope/lib')
  })
  it('with peerContext', () => {
    expect(nameOf('react-dom@18.0.0(react@18.0.0)')).toBe('react-dom')
  })
  it('scoped with scoped peer', () => {
    expect(nameOf('@scope/lib@1.0.0(@scope/peer@2.0.0)')).toBe('@scope/lib')
  })
})

describe('serializeNodeId', () => {
  it('no peers', () => {
    expect(serializeNodeId('lodash', '4.17.21', [])).toBe('lodash@4.17.21')
  })
  it('one peer', () => {
    expect(serializeNodeId('react-dom', '18.0.0', ['react@18.0.0'])).toBe('react-dom@18.0.0(react@18.0.0)')
  })
  it('two peers', () => {
    expect(serializeNodeId('apollo', '3.7.0', ['graphql@16.6.0', 'react@18.0.0']))
      .toBe('apollo@3.7.0(graphql@16.6.0)(react@18.0.0)')
  })
})

describe('stripPeerContextFromNodeId', () => {
  it('plain id is its own ADR-0010 base key', () => {
    expect(stripPeerContextFromNodeId('lodash@4.17.21')).toBe('lodash@4.17.21')
  })
  it('strips peer-context', () => {
    expect(stripPeerContextFromNodeId('react-dom@18.0.0(react@18.0.0)')).toBe('react-dom@18.0.0')
  })
  it('strips nested peer-context', () => {
    expect(stripPeerContextFromNodeId('apollo@3.7.0(graphql@16.6.0)(react@18.0.0(react-dom@18.0.0))'))
      .toBe('apollo@3.7.0')
  })
  it('keeps scoped names intact', () => {
    expect(stripPeerContextFromNodeId('@scope/lib@1.0.0(@scope/peer@2.0.0)')).toBe('@scope/lib@1.0.0')
  })
})

describe('toTarballKey', () => {
  it('builds the unsuffixed key when no slots are present', () => {
    expect(toTarballKey({ name: 'lodash', version: '4.17.21' })).toBe('lodash@4.17.21')
  })

  it('adds the patch slot when present', () => {
    const patch = 'a'.repeat(128)
    expect(toTarballKey({ name: 'lodash', version: '4.17.21', patch })).toBe(`lodash@4.17.21+patch=${patch}`)
  })

  it('accepts unresolved patch sentinels', () => {
    const patch = `unresolved-${'a'.repeat(64)}`
    expect(toTarballKey({ name: 'lodash', version: '4.17.21', patch })).toBe(`lodash@4.17.21+patch=${patch}`)
  })

  it('rejects invalid patch slot shapes', () => {
    expect(() => toTarballKey({ name: 'lodash', version: '4.17.21', patch: '' })).toThrow(LockfileError)
    try {
      toTarballKey({ name: 'lodash', version: '4.17.21', patch: '' })
    } catch (e) {
      expect((e as LockfileError).code).toBe('INVALID_INPUT')
    }
    expect(() => toTarballKey({ name: 'lodash', version: '4.17.21', patch: 'bad token' })).toThrow(/invalid token shape|whitespace/)
  })
})

describe('Builder + seal', () => {
  it('seals a single-node graph', () => {
    const b = newBuilder()
    b.addNode(n('foo@1.0.0', 'foo', '1.0.0'))
    const g = b.seal()
    expect(g.getNode('foo@1.0.0')?.name).toBe('foo')
    expect([...g.nodes()].map(x => x.id)).toEqual(['foo@1.0.0'])
  })

  it('builder setTarball populates Graph.tarballs', () => {
    const b = newBuilder()
    b.addNode(n('foo@1.0.0', 'foo', '1.0.0'))
    b.setTarball({ name: 'foo', version: '1.0.0' }, { integrity: mkIntegrity('sha512-x'), license: 'MIT' })
    const g = b.seal()
    expect(g.tarball({ name: 'foo', version: '1.0.0' })?.license).toBe('MIT')
    expect(g.tarballOf('foo@1.0.0')?.integrity).toEqual(mkIntegrity('sha512-x'))
    // virt-instances of same name@version share the tarball
    expect(g.tarballOf('foo@1.0.0')).toBe(g.tarball({ name: 'foo', version: '1.0.0' }))
  })

  it('tarballs() iterates content-sorted', () => {
    const b = newBuilder()
    b.addNode(n('a@1.0.0', 'a', '1.0.0'))
    b.addNode(n('b@1.0.0', 'b', '1.0.0'))
    b.setTarball({ name: 'b', version: '1.0.0' }, { license: 'MIT' })
    b.setTarball({ name: 'a', version: '1.0.0' }, { license: 'Apache-2.0' })
    const g = b.seal()
    expect([...g.tarballs()].map(([k]) => k)).toEqual(['a@1.0.0', 'b@1.0.0'])
  })

  it('tarballOf derives the patched key from Node.patch', () => {
    const patch = 'a'.repeat(128)
    const b = newBuilder()
    b.addNode(n('foo@1.0.0', 'foo', '1.0.0', [], { patch }))
    b.setTarball({ name: 'foo', version: '1.0.0', patch }, { integrity: mkIntegrity('sha512-x') })
    const g = b.seal()
    expect(g.tarballOf('foo@1.0.0')?.integrity).toEqual(mkIntegrity('sha512-x'))
    expect(g.tarball({ name: 'foo', version: '1.0.0' })).toBeUndefined()
  })

  it('forward-refs allowed: edge added before its target', () => {
    const b = newBuilder()
    b.addEdge('a@1.0.0', 'b@1.0.0', 'dep')
    b.addNode(n('a@1.0.0', 'a', '1.0.0'))
    b.addNode(n('b@1.0.0', 'b', '1.0.0'))
    expect(() => b.seal()).not.toThrow()
  })

  it('rejects edge with missing target', () => {
    const b = newBuilder()
    b.addNode(n('a@1.0.0', 'a', '1.0.0'))
    b.addEdge('a@1.0.0', 'ghost@1.0.0', 'dep')
    expect(() => b.seal()).toThrow(GraphError)
  })

  it('rejects duplicate (src,dst,kind) edge', () => {
    const b = newBuilder()
    b.addNode(n('a@1.0.0', 'a', '1.0.0'))
    b.addNode(n('b@1.0.0', 'b', '1.0.0'))
    b.addEdge('a@1.0.0', 'b@1.0.0', 'dep')
    b.addEdge('a@1.0.0', 'b@1.0.0', 'dep')
    expect(() => b.seal()).toThrow(/duplicate edge/)
  })

  it('rejects NodeId disagreeing with derived id', () => {
    const b = newBuilder()
    b.addNode(n('foo@1.0.0', 'foo', '9.9.9'))
    expect(() => b.seal()).toThrow(/disagrees with derived id/)
  })

  it('rejects peer-edge / peerContext mismatch', () => {
    const b = newBuilder()
    b.addNode(n('react@18.0.0', 'react', '18.0.0'))
    b.addNode(n('react-dom@18.0.0(react@18.0.0)', 'react-dom', '18.0.0', ['react@18.0.0']))
    // No `peer` edge added → peerContext disagrees
    expect(() => b.seal()).toThrow(/peer edges of .* disagree with peerContext/)
  })

  it('seals a transitive peer whose edge targets a peer-variant (base-key projection, ADR-0017)', () => {
    // pnpm v9: `a`'s peer `b` is itself a peer-variant `b@1.0.0(c@1.0.0)`.
    // peerContext records the BARE base key `b@1.0.0`; the peer edge targets
    // the fully-qualified variant. Base-key projection makes them cohere.
    const b = newBuilder()
    b.addNode(n('c@1.0.0', 'c', '1.0.0'))
    b.addNode(n('b@1.0.0(c@1.0.0)', 'b', '1.0.0', ['c@1.0.0']))
    b.addNode(n('a@1.0.0(b@1.0.0)', 'a', '1.0.0', ['b@1.0.0']))
    b.addEdge('b@1.0.0(c@1.0.0)', 'c@1.0.0', 'peer')
    b.addEdge('a@1.0.0(b@1.0.0)', 'b@1.0.0(c@1.0.0)', 'peer') // target is the VARIANT
    expect(() => b.seal()).not.toThrow()
  })

  it('still rejects a peer edge whose base-key is absent from peerContext (projection not gutted)', () => {
    // The loosened seal must not accept arbitrary peer edges: projecting to
    // base keys, `wrong@1.0.0` ≠ peerContext `right@1.0.0`.
    const b = newBuilder()
    b.addNode(n('right@1.0.0', 'right', '1.0.0'))
    b.addNode(n('wrong@2.0.0', 'wrong', '2.0.0'))
    b.addNode(n('a@1.0.0(right@1.0.0)', 'a', '1.0.0', ['right@1.0.0']))
    b.addEdge('a@1.0.0(right@1.0.0)', 'wrong@2.0.0', 'peer') // base-key not in peerContext
    expect(() => b.seal()).toThrow(/peer edges of .* disagree with peerContext/)
  })

  // === ADR-0030 (#69): hashed peer-set token is non-edge-bearing ===

  it('seals a node whose ONLY peerContext entry is a bare-hex hashed peer-set token, with NO peer edge', () => {
    // ADR-0030 — pnpm-v9 abbreviates a long resolved peer-set into one bare-hex
    // digest. The token is an opaque identity discriminator that bears NO peer
    // edge (the real peers are hidden in the hash). The seal must NOT demand a
    // peer edge for it. The derived-id check is unchanged — the token still
    // participates in serializeNodeId, so the id must include it.
    const id = serializeNodeId('lib', '1.0.0', ['deadbeef00112233'])
    expect(id).toBe('lib@1.0.0(deadbeef00112233)')
    const b = newBuilder()
    b.addNode(n(id, 'lib', '1.0.0', ['deadbeef00112233']))
    expect(() => b.seal()).not.toThrow()
  })

  it('seals a MIXED peerContext (real edge-bearing peer + hashed token): the real peer needs its edge, the hash does not', () => {
    // The exemption is surgical: only the hashed token is dropped from the
    // edge↔context compare; the real `react@18.0.0` peer still requires a peer
    // edge.
    const id = serializeNodeId('lib', '1.0.0', ['cafebabe99887766', 'react@18.0.0'])
    const b = newBuilder()
    b.addNode(n('react@18.0.0', 'react', '18.0.0'))
    b.addNode(n(id, 'lib', '1.0.0', ['cafebabe99887766', 'react@18.0.0']))
    b.addEdge(id, 'react@18.0.0', 'peer') // real peer edge; NO edge for the hash
    expect(() => b.seal()).not.toThrow()
  })

  it('NEGATIVE: a real edge-bearing peer absent from peerContext STILL fails even when a hashed token is present (exemption not over-broad)', () => {
    // Gate 3 — the opaque-token exemption must not gut the coherence check. A
    // node carrying a hashed token AND a real peer edge whose base-key is NOT
    // in peerContext must still throw.
    const id = serializeNodeId('lib', '1.0.0', ['deadbeef00112233', 'react@18.0.0'])
    const b = newBuilder()
    b.addNode(n('react@18.0.0', 'react', '18.0.0'))
    b.addNode(n('vue@3.0.0', 'vue', '3.0.0'))
    b.addNode(n(id, 'lib', '1.0.0', ['deadbeef00112233', 'react@18.0.0']))
    // Wire a peer edge to `vue` — whose base-key is NOT in peerContext (only
    // `react` is, besides the exempt hash). The hash being present must not
    // mask the real mismatch.
    b.addEdge(id, 'vue@3.0.0', 'peer')
    expect(() => b.seal()).toThrow(/peer edges of .* disagree with peerContext/)
  })

  it('workspace nodes must have no incoming edges from non-workspace nodes', () => {
    const b = newBuilder()
    b.addNode(n('app@1.0.0', 'app', '1.0.0', [], { workspacePath: '' }))
    b.addNode(n('a@1.0.0', 'a', '1.0.0'))
    b.addEdge('a@1.0.0', 'app@1.0.0', 'dep')
    expect(() => b.seal()).toThrow(/workspace node has incoming edges/)
  })

  it.each(['dep', 'dev', 'optional'] as const)(
    'workspace nodes may have incoming %s edges from other workspace nodes',
    (kind) => {
      const b = newBuilder()
      b.addNode(n('app@1.0.0', 'app', '1.0.0', [], { workspacePath: '' }))
      b.addNode(n('core@1.0.0', 'core', '1.0.0', [], { workspacePath: 'packages/core' }))
      b.addEdge('app@1.0.0', 'core@1.0.0', kind)
      expect(() => b.seal()).not.toThrow()
    },
  )

  it('workspace nodes may have incoming peer edges from other workspace nodes', () => {
    const b = newBuilder()
    b.addNode(n('app@1.0.0(core@1.0.0)', 'app', '1.0.0', ['core@1.0.0'], { workspacePath: '' }))
    b.addNode(n('core@1.0.0', 'core', '1.0.0', [], { workspacePath: 'packages/core' }))
    b.addEdge('app@1.0.0(core@1.0.0)', 'core@1.0.0', 'peer')
    expect(() => b.seal()).not.toThrow()
  })

  // === ADR-0017 amendment (Bug #4): published-self-link carve-out ===
  // A workspace node MAY have an incoming edge from a non-workspace node iff the
  // edge's descriptor uses a registry protocol (npm: / bare semver) — yarn
  // resolved a published dependency onto a co-located workspace.

  it('permits a published self-link (npm: range) and emits SEAL_PUBLISHED_SELF_LINK', () => {
    const b = newBuilder()
    b.addNode(n('ws@0.0.0-use.local', 'ws', '0.0.0-use.local', [], { workspacePath: 'packages/ws' }))
    b.addNode(n('publisher@1.0.0', 'publisher', '1.0.0'))
    b.addEdge('publisher@1.0.0', 'ws@0.0.0-use.local', 'dep', { range: 'npm:^1.0.0' })
    let g: ReturnType<typeof b.seal> | undefined
    expect(() => { g = b.seal() }).not.toThrow()
    const diag = g!.diagnostics().filter(d => d.code === 'SEAL_PUBLISHED_SELF_LINK')
    expect(diag).toHaveLength(1)
    expect(diag[0]?.severity).toBe('info')
    expect(diag[0]?.subject).toBe('ws@0.0.0-use.local')
    expect(diag[0]?.message).toContain('publisher@1.0.0')
    expect(diag[0]?.message).toContain('npm:^1.0.0')
  })

  it('permits a published self-link with a BARE semver range (registry-equivalent)', () => {
    const b = newBuilder()
    b.addNode(n('ws@0.0.0-use.local', 'ws', '0.0.0-use.local', [], { workspacePath: 'packages/ws' }))
    b.addNode(n('publisher@1.0.0', 'publisher', '1.0.0'))
    b.addEdge('publisher@1.0.0', 'ws@0.0.0-use.local', 'dep', { range: '^1.0.0' })
    let g: ReturnType<typeof b.seal> | undefined
    expect(() => { g = b.seal() }).not.toThrow()
    expect(g!.diagnostics().filter(d => d.code === 'SEAL_PUBLISHED_SELF_LINK')).toHaveLength(1)
  })

  it('rejects a non-workspace incoming edge with a link: range (not a published self-link)', () => {
    const b = newBuilder()
    b.addNode(n('ws@0.0.0-use.local', 'ws', '0.0.0-use.local', [], { workspacePath: 'packages/ws' }))
    b.addNode(n('publisher@1.0.0', 'publisher', '1.0.0'))
    b.addEdge('publisher@1.0.0', 'ws@0.0.0-use.local', 'dep', { range: 'link:../ws' })
    expect(() => b.seal()).toThrow(/workspace node has incoming edges/)
  })

  it.each(['file:./ws', 'portal:../ws', 'patch:ws@npm%3A1.0.0#~/p.patch', 'git+https://x/ws.git', 'https://x/ws.tgz', 'workspace:*'])(
    'rejects a non-workspace incoming edge with a non-registry range %s',
    (range) => {
      const b = newBuilder()
      b.addNode(n('ws@0.0.0-use.local', 'ws', '0.0.0-use.local', [], { workspacePath: 'packages/ws' }))
      b.addNode(n('publisher@1.0.0', 'publisher', '1.0.0'))
      b.addEdge('publisher@1.0.0', 'ws@0.0.0-use.local', 'dep', { range })
      expect(() => b.seal()).toThrow(/workspace node has incoming edges/)
    },
  )

  it('rejects a non-workspace incoming edge with an ABSENT range (conservative reject)', () => {
    const b = newBuilder()
    b.addNode(n('ws@0.0.0-use.local', 'ws', '0.0.0-use.local', [], { workspacePath: 'packages/ws' }))
    b.addNode(n('publisher@1.0.0', 'publisher', '1.0.0'))
    b.addEdge('publisher@1.0.0', 'ws@0.0.0-use.local', 'dep') // no attrs.range
    expect(() => b.seal()).toThrow(/workspace node has incoming edges/)
  })

  it('does not emit SEAL_PUBLISHED_SELF_LINK for a workspace→workspace edge', () => {
    const b = newBuilder()
    b.addNode(n('app@1.0.0', 'app', '1.0.0', [], { workspacePath: '' }))
    b.addNode(n('core@1.0.0', 'core', '1.0.0', [], { workspacePath: 'packages/core' }))
    b.addEdge('app@1.0.0', 'core@1.0.0', 'dep', { range: 'workspace:*' })
    const g = b.seal()
    expect(g.diagnostics().filter(d => d.code === 'SEAL_PUBLISHED_SELF_LINK')).toHaveLength(0)
  })

  it('rejects ANY genuinely-forbidden edge even when another permitted self-link is present', () => {
    const b = newBuilder()
    b.addNode(n('ws@0.0.0-use.local', 'ws', '0.0.0-use.local', [], { workspacePath: 'packages/ws' }))
    b.addNode(n('ok@1.0.0', 'ok', '1.0.0'))
    b.addNode(n('bad@1.0.0', 'bad', '1.0.0'))
    b.addEdge('ok@1.0.0', 'ws@0.0.0-use.local', 'dep', { range: 'npm:^1.0.0' })
    b.addEdge('bad@1.0.0', 'ws@0.0.0-use.local', 'dep', { range: 'link:../ws' })
    expect(() => b.seal()).toThrow(/workspace node has incoming edges/)
  })

  // ADR-0017 §Local-directory sources (2026-06-04) — the discriminator is the
  // SOURCE node's canonical resolution locality, not the edge range. These pin
  // the carve-out AND the bus-factor guarantee it must preserve. (The negatives
  // above carry NO tarball on the source, so they never reach this branch.)
  it('PERMITS a local-directory source → workspace (portal:/link:/file: local link)', () => {
    const b = newBuilder()
    b.addNode(n('ws@0.0.0-use.local', 'ws', '0.0.0-use.local', [], { workspacePath: 'packages/ws' }))
    b.addNode(n('local@0.0.0-use.local', 'local', '0.0.0-use.local'))
    b.setTarball({ name: 'local', version: '0.0.0-use.local' }, { resolution: { type: 'directory', path: './local' } })
    b.addEdge('local@0.0.0-use.local', 'ws@0.0.0-use.local', 'dep', { range: 'workspace:^' })
    expect(() => b.seal()).not.toThrow()
  })

  it('STILL THROWS for a published TARBALL source → workspace (bus-factor preserved)', () => {
    const b = newBuilder()
    b.addNode(n('ws@0.0.0-use.local', 'ws', '0.0.0-use.local', [], { workspacePath: 'packages/ws' }))
    b.addNode(n('pub@1.0.0', 'pub', '1.0.0'))
    b.setTarball({ name: 'pub', version: '1.0.0' }, { resolution: { type: 'tarball', url: 'https://registry.npmjs.org/pub/-/pub-1.0.0.tgz' } })
    b.addEdge('pub@1.0.0', 'ws@0.0.0-use.local', 'dep', { range: 'workspace:^' })
    expect(() => b.seal()).toThrow(/workspace node has incoming edges/)
  })

  it('STILL THROWS for a git source → workspace (bus-factor preserved)', () => {
    const b = newBuilder()
    b.addNode(n('ws@0.0.0-use.local', 'ws', '0.0.0-use.local', [], { workspacePath: 'packages/ws' }))
    b.addNode(n('gitpkg@1.0.0', 'gitpkg', '1.0.0'))
    b.setTarball({ name: 'gitpkg', version: '1.0.0' }, { resolution: { type: 'git', url: 'https://github.com/x/gitpkg.git', sha: '0123456789abcdef0123456789abcdef01234567' } })
    b.addEdge('gitpkg@1.0.0', 'ws@0.0.0-use.local', 'dep', { range: 'workspace:^' })
    expect(() => b.seal()).toThrow(/workspace node has incoming edges/)
  })

  it('rejects error-severity diagnostics at seal', () => {
    const b = newBuilder()
    b.addNode(n('a@1.0.0', 'a', '1.0.0'))
    b.diagnostic({ code: 'BAD', severity: 'error', message: 'x' })
    expect(() => b.seal()).toThrow(/unresolved error diagnostic/)
  })

  it('warning-severity diagnostics do not block seal', () => {
    const b = newBuilder()
    b.addNode(n('a@1.0.0', 'a', '1.0.0'))
    b.diagnostic({ code: 'PEER_UNFULFILLED', severity: 'warning', message: 'x' })
    expect(() => b.seal()).not.toThrow()
  })

  it('builder rejects further calls after seal', () => {
    const b = newBuilder()
    b.addNode(n('a@1.0.0', 'a', '1.0.0'))
    b.seal()
    expect(() => b.addNode(n('b@1.0.0', 'b', '1.0.0'))).toThrow(/after seal/)
  })
})

describe('Queries', () => {
  const build = () => {
    const b = newBuilder()
    b.addNode(n('app@1.0.0', 'app', '1.0.0', [], { workspacePath: '' }))
    b.addNode(n('a@1.0.0', 'a', '1.0.0'))
    b.addNode(n('a@2.0.0', 'a', '2.0.0'))
    b.addNode(n('b@1.0.0', 'b', '1.0.0'))
    b.addEdge('app@1.0.0', 'a@1.0.0', 'dep')
    b.addEdge('app@1.0.0', 'b@1.0.0', 'dev')
    b.addEdge('a@1.0.0', 'b@1.0.0', 'dep')
    return b.seal()
  }

  it('byName returns sorted NodeIds', () => {
    const g = build()
    expect(g.byName('a')).toEqual(['a@1.0.0', 'a@2.0.0'])
  })

  it('roots = workspace nodes (no incoming)', () => {
    const g = build()
    expect([...g.roots()].sort()).toEqual(['a@2.0.0', 'app@1.0.0'])
  })

  it('out filters by kind', () => {
    const g = build()
    expect(g.out('app@1.0.0', 'dep').map(e => e.dst)).toEqual(['a@1.0.0'])
    expect(g.out('app@1.0.0', 'dev').map(e => e.dst)).toEqual(['b@1.0.0'])
    expect(g.out('app@1.0.0').map(e => e.dst).sort()).toEqual(['a@1.0.0', 'b@1.0.0'])
  })

  it('in returns sorted incoming edges', () => {
    const g = build()
    expect(g.in('b@1.0.0').map(e => e.src)).toEqual(['a@1.0.0', 'app@1.0.0'])
  })

  it('nodes() iterates content-sorted', () => {
    const g = build()
    expect([...g.nodes()].map(x => x.id)).toEqual([
      'a@1.0.0',
      'a@2.0.0',
      'app@1.0.0',
      'b@1.0.0',
    ])
  })
})

describe('walk', () => {
  const buildLine = () => {
    const b = newBuilder()
    b.addNode(n('a@1.0.0', 'a', '1.0.0'))
    b.addNode(n('b@1.0.0', 'b', '1.0.0'))
    b.addNode(n('c@1.0.0', 'c', '1.0.0'))
    b.addEdge('a@1.0.0', 'b@1.0.0', 'dep')
    b.addEdge('b@1.0.0', 'c@1.0.0', 'dep')
    return b.seal()
  }

  it('walks reachable nodes', () => {
    const g = buildLine()
    expect([...g.walk('a@1.0.0')].sort()).toEqual(['a@1.0.0', 'b@1.0.0', 'c@1.0.0'])
  })

  it('respects maxDepth', () => {
    const g = buildLine()
    expect([...g.walk('a@1.0.0', { maxDepth: 1 })].sort()).toEqual(['a@1.0.0', 'b@1.0.0'])
  })

  it('terminates on cycles', () => {
    const b = newBuilder()
    b.addNode(n('a@1.0.0', 'a', '1.0.0'))
    b.addNode(n('b@1.0.0', 'b', '1.0.0'))
    b.addEdge('a@1.0.0', 'b@1.0.0', 'dep')
    b.addEdge('b@1.0.0', 'a@1.0.0', 'dep')
    const g = b.seal()
    expect([...g.walk('a@1.0.0')].sort()).toEqual(['a@1.0.0', 'b@1.0.0'])
  })

  it('direction:in walks dependents', () => {
    const g = buildLine()
    expect([...g.walk('c@1.0.0', { direction: 'in' })].sort()).toEqual(['a@1.0.0', 'b@1.0.0', 'c@1.0.0'])
  })

  it('filters by edge kind', () => {
    const b = newBuilder()
    b.addNode(n('a@1.0.0', 'a', '1.0.0'))
    b.addNode(n('b@1.0.0', 'b', '1.0.0'))
    b.addNode(n('c@1.0.0', 'c', '1.0.0'))
    b.addEdge('a@1.0.0', 'b@1.0.0', 'dep')
    b.addEdge('a@1.0.0', 'c@1.0.0', 'dev')
    const g = b.seal()
    expect([...g.walk('a@1.0.0', { kinds: ['dep'] })].sort()).toEqual(['a@1.0.0', 'b@1.0.0'])
  })
})

describe('topoSort', () => {
  it('sorts a DAG by reverse-finish (sources first)', () => {
    const b = newBuilder()
    b.addNode(n('a@1.0.0', 'a', '1.0.0'))
    b.addNode(n('b@1.0.0', 'b', '1.0.0'))
    b.addNode(n('c@1.0.0', 'c', '1.0.0'))
    b.addEdge('a@1.0.0', 'b@1.0.0', 'dep')
    b.addEdge('b@1.0.0', 'c@1.0.0', 'dep')
    const g = b.seal()
    const flat = g.topoSort().flatMap(scc => scc)
    // 'a' must come before 'b'; 'b' before 'c'
    expect(flat.indexOf('a@1.0.0')).toBeLessThan(flat.indexOf('b@1.0.0'))
    expect(flat.indexOf('b@1.0.0')).toBeLessThan(flat.indexOf('c@1.0.0'))
  })

  it('returns a cycle as a single SCC', () => {
    const b = newBuilder()
    b.addNode(n('a@1.0.0', 'a', '1.0.0'))
    b.addNode(n('b@1.0.0', 'b', '1.0.0'))
    b.addEdge('a@1.0.0', 'b@1.0.0', 'dep')
    b.addEdge('b@1.0.0', 'a@1.0.0', 'dep')
    const g = b.seal()
    const sccs = g.topoSort()
    const cycle = sccs.find(scc => scc.length === 2)
    expect(cycle).toBeDefined()
    expect(cycle!.slice().sort()).toEqual(['a@1.0.0', 'b@1.0.0'])
  })
})

describe('subgraph', () => {
  it('extracts the reachable closure', () => {
    const b = newBuilder()
    b.addNode(n('a@1.0.0', 'a', '1.0.0'))
    b.addNode(n('b@1.0.0', 'b', '1.0.0'))
    b.addNode(n('c@1.0.0', 'c', '1.0.0'))
    b.addNode(n('d@1.0.0', 'd', '1.0.0'))
    b.addEdge('a@1.0.0', 'b@1.0.0', 'dep')
    b.addEdge('b@1.0.0', 'c@1.0.0', 'dep')
    // d is unreachable from a
    const g = b.seal()
    const sub = g.subgraph('a@1.0.0')
    expect([...sub.nodes()].map(x => x.id).sort()).toEqual(['a@1.0.0', 'b@1.0.0', 'c@1.0.0'])
  })
})

describe('diff', () => {
  it('detects added, removed, and changed nodes', () => {
    const b1 = newBuilder()
    b1.addNode(n('a@1.0.0', 'a', '1.0.0', [], { resolution: 'https://x/a-1.0.0.tgz' }))
    b1.addNode(n('b@1.0.0', 'b', '1.0.0'))
    const g1 = b1.seal()

    const b2 = newBuilder()
    b2.addNode(n('a@1.0.0', 'a', '1.0.0', [], { resolution: 'https://y/a-1.0.0.tgz' }))   // changed
    b2.addNode(n('c@1.0.0', 'c', '1.0.0'))                                  // added
    const g2 = b2.seal()

    const d = g1.diff(g2)
    expect(d.removedNodes).toEqual(['b@1.0.0'])
    expect(d.addedNodes).toEqual(['c@1.0.0'])
    expect(d.changedNodes).toEqual(['a@1.0.0'])
  })

  it('detects added and removed edges', () => {
    const b1 = newBuilder()
    b1.addNode(n('a@1.0.0', 'a', '1.0.0'))
    b1.addNode(n('b@1.0.0', 'b', '1.0.0'))
    b1.addEdge('a@1.0.0', 'b@1.0.0', 'dep')
    const g1 = b1.seal()

    const b2 = newBuilder()
    b2.addNode(n('a@1.0.0', 'a', '1.0.0'))
    b2.addNode(n('b@1.0.0', 'b', '1.0.0'))
    b2.addEdge('a@1.0.0', 'b@1.0.0', 'dev')   // kind changed
    const g2 = b2.seal()

    const d = g1.diff(g2)
    expect(d.removedEdges).toEqual([{ src: 'a@1.0.0', dst: 'b@1.0.0', kind: 'dep' }])
    expect(d.addedEdges).toEqual([{ src: 'a@1.0.0', dst: 'b@1.0.0', kind: 'dev' }])
  })
})

describe('mutate', () => {
  const seed = () => {
    const b = newBuilder()
    b.addNode(n('app@1.0.0', 'app', '1.0.0', [], { workspacePath: '' }))
    b.addNode(n('a@1.0.0', 'a', '1.0.0'))
    b.addNode(n('b@1.0.0', 'b', '1.0.0'))
    b.addEdge('app@1.0.0', 'a@1.0.0', 'dep')
    b.addEdge('a@1.0.0', 'b@1.0.0', 'dep')
    return b.seal()
  }

  it('addNode + addEdge', () => {
    const g = seed()
    const { graph: g2, applied } = g.mutate(m => {
      m.addNode(n('c@1.0.0', 'c', '1.0.0'))
      m.addEdge('a@1.0.0', 'c@1.0.0', 'dep')
    })
    expect(g2.getNode('c@1.0.0')).toBeDefined()
    expect(g2.out('a@1.0.0').map(e => e.dst).sort()).toEqual(['b@1.0.0', 'c@1.0.0'])
    expect(applied).toHaveLength(2)
  })

  it('replaceNode same id swaps node fields', () => {
    const g = seed()
    const { graph: g2 } = g.mutate(m => {
      m.replaceNode('a@1.0.0', n('a@1.0.0', 'a', '1.0.0', [], { resolution: 'https://x/a-1.0.0.tgz' }))
    })
    expect(g2.getNode('a@1.0.0')?.resolution).toBe('https://x/a-1.0.0.tgz')
    // edges preserved
    expect(g2.out('a@1.0.0').map(e => e.dst)).toEqual(['b@1.0.0'])
    expect(g2.in('a@1.0.0').map(e => e.src)).toEqual(['app@1.0.0'])
  })

  it('setTarball / removeTarball update shared payload', () => {
    const g = seed()
    const { graph: g2 } = g.mutate(m => {
      m.setTarball({ name: 'a', version: '1.0.0' }, { license: 'MIT', integrity: mkIntegrity('sha512-abc') })
    })
    expect(g2.tarball({ name: 'a', version: '1.0.0' })?.license).toBe('MIT')
    expect(g2.tarballOf('a@1.0.0')?.integrity).toEqual(mkIntegrity('sha512-abc'))

    const { graph: g3 } = g2.mutate(m => {
      m.removeTarball({ name: 'a', version: '1.0.0' })
    })
    expect(g3.tarball({ name: 'a', version: '1.0.0' })).toBeUndefined()
  })

  it('removeTarball rejects on missing key', () => {
    const g = seed()
    expect(() => g.mutate(m => { m.removeTarball({ name: 'ghost', version: '9.9.9' }) })).toThrow(/missing/)
  })

  it('replaceNode new id rebinds incoming and outgoing edges', () => {
    const g = seed()
    const { graph: g2 } = g.mutate(m => {
      m.replaceNode('a@1.0.0', n('a@1.0.1', 'a', '1.0.1'))
    })
    expect(g2.getNode('a@1.0.0')).toBeUndefined()
    expect(g2.getNode('a@1.0.1')).toBeDefined()
    expect(g2.out('app@1.0.0').map(e => e.dst)).toEqual(['a@1.0.1'])
    expect(g2.out('a@1.0.1').map(e => e.dst)).toEqual(['b@1.0.0'])
    expect(g2.in('b@1.0.0').map(e => e.src)).toEqual(['a@1.0.1'])
  })

  it('removeEdge + removeNode (in correct order)', () => {
    const g = seed()
    const { graph: g2 } = g.mutate(m => {
      m.removeEdge('a@1.0.0', 'b@1.0.0', 'dep')
      m.removeNode('b@1.0.0')
    })
    expect(g2.getNode('b@1.0.0')).toBeUndefined()
    expect(g2.out('a@1.0.0')).toEqual([])
  })

  it('removeNode rejects when node has incoming edges', () => {
    const g = seed()
    expect(() => g.mutate(m => { m.removeNode('a@1.0.0') })).toThrow(/has incoming edges/)
  })

  it('addEdge rejects on duplicate triple', () => {
    const g = seed()
    expect(() => g.mutate(m => { m.addEdge('app@1.0.0', 'a@1.0.0', 'dep') })).toThrow(/duplicate/)
  })

  it('rolls back on throw — original graph untouched', () => {
    const g = seed()
    const before = [...g.nodes()].map(x => x.id)
    try {
      g.mutate(m => {
        m.addNode(n('c@1.0.0', 'c', '1.0.0'))
        throw new Error('abort')
      })
    } catch {/* expected */}
    expect([...g.nodes()].map(x => x.id)).toEqual(before)
    expect(g.getNode('c@1.0.0')).toBeUndefined()
  })

  it('replacePeerContext re-keys node and updates peer edges', () => {
    const b = newBuilder()
    b.addNode(n('app@1.0.0', 'app', '1.0.0', [], { workspacePath: '' }))
    b.addNode(n('react@18.0.0', 'react', '18.0.0'))
    b.addNode(n('react@17.0.0', 'react', '17.0.0'))
    b.addNode(n('rd@18.0.0(react@18.0.0)', 'rd', '18.0.0', ['react@18.0.0']))
    b.addEdge('app@1.0.0', 'rd@18.0.0(react@18.0.0)', 'dep')
    b.addEdge('rd@18.0.0(react@18.0.0)', 'react@18.0.0', 'peer')
    const g = b.seal()

    const { graph: g2, applied } = g.mutate(m => {
      m.replacePeerContext('rd@18.0.0(react@18.0.0)', ['react@17.0.0'])
    })

    const newId = 'rd@18.0.0(react@17.0.0)'
    expect(g2.getNode(newId)).toBeDefined()
    expect(g2.getNode('rd@18.0.0(react@18.0.0)')).toBeUndefined()
    // app's dep edge rebound
    expect(g2.out('app@1.0.0').map(e => e.dst)).toEqual([newId])
    // peer edge points at react@17.0.0 now
    expect(g2.out(newId, 'peer').map(e => e.dst)).toEqual(['react@17.0.0'])
    // react@18.0.0 no longer the peer target
    expect(g2.in('react@18.0.0', 'peer')).toEqual([])
    expect(applied).toEqual([{ kind: 'peer-context-replaced', subject: newId }])
  })

  it('mutate result graph and original both remain valid', () => {
    const g = seed()
    const { graph: g2 } = g.mutate(m => {
      m.addNode(n('c@1.0.0', 'c', '1.0.0'))
    })
    // both queryable, no shared mutable state leaks
    expect(g.getNode('c@1.0.0')).toBeUndefined()
    expect(g2.getNode('c@1.0.0')).toBeDefined()
  })

  // ADR-0023 §8.6 — Mutator.diagnostic write-side surface.
  it('Mutator.diagnostic appends a diagnostic to the resulting Graph', () => {
    const g = seed()
    const { graph: g2 } = g.mutate(m => {
      m.diagnostic({ code: 'TEST_INFO', severity: 'info', subject: 'graph', message: 'hello' })
    })
    const diags = g2.diagnostics()
    expect(diags).toHaveLength(1)
    expect(diags[0]).toEqual({
      code:     'TEST_INFO',
      severity: 'info',
      subject:  'graph',
      message:  'hello',
    })
    // Original graph untouched — no shared mutable state leaks.
    expect(g.diagnostics()).toHaveLength(0)
  })

  it('Mutator.diagnostic emits multiple diagnostics in one transaction', () => {
    const g = seed()
    const { graph: g2 } = g.mutate(m => {
      m.diagnostic({ code: 'A', severity: 'info', subject: 'graph', message: '1' })
      m.diagnostic({ code: 'B', severity: 'warning', subject: 'graph', message: '2' })
      m.diagnostic({ code: 'C', severity: 'info', subject: 'graph', message: '3' })
    })
    expect(g2.diagnostics().map(d => d.code)).toEqual(['A', 'B', 'C'])
  })

  it('Mutator.diagnostic survives chained mutate calls', () => {
    const g = seed()
    const { graph: g2 } = g.mutate(m => {
      m.diagnostic({ code: 'FIRST', severity: 'info', subject: 'graph', message: 'x' })
    })
    const { graph: g3 } = g2.mutate(m => {
      m.diagnostic({ code: 'SECOND', severity: 'info', subject: 'graph', message: 'y' })
    })
    expect(g3.diagnostics().map(d => d.code)).toEqual(['FIRST', 'SECOND'])
    // g2 unchanged by g3's mutation.
    expect(g2.diagnostics().map(d => d.code)).toEqual(['FIRST'])
  })

  it('Mutator.diagnostic warnings surface on MutateResult.unresolved', () => {
    const g = seed()
    const result = g.mutate(m => {
      m.diagnostic({ code: 'WARN_X', severity: 'warning', subject: 'graph', message: 'warn' })
      m.diagnostic({ code: 'INFO_Y', severity: 'info',    subject: 'graph', message: 'info' })
    })
    // MutateResult.unresolved filters to warning+ severity (graph.ts:812).
    expect(result.unresolved.map(d => d.code)).toEqual(['WARN_X'])
  })

  it('Mutator.diagnostic combines with structural mutations in one transaction', () => {
    const g = seed()
    const { graph: g2 } = g.mutate(m => {
      m.addNode(n('c@1.0.0', 'c', '1.0.0'))
      m.diagnostic({ code: 'NODE_C_ADDED', severity: 'info', subject: 'c@1.0.0', message: 'c arrived' })
      m.addEdge('a@1.0.0', 'c@1.0.0', 'dep')
    })
    expect(g2.getNode('c@1.0.0')).toBeDefined()
    expect(g2.diagnostics().map(d => d.code)).toEqual(['NODE_C_ADDED'])
  })

  it('Mutator.diagnostic rolls back when transaction throws', () => {
    const g = seed()
    try {
      g.mutate(m => {
        m.diagnostic({ code: 'WILL_ROLLBACK', severity: 'info', subject: 'graph', message: 'gone' })
        throw new Error('abort')
      })
    } catch {/* expected */}
    expect(g.diagnostics()).toHaveLength(0)
  })
})

describe('patch-slot intake gate (ADR-0011)', () => {
  const sentinel = `unresolved-${'a'.repeat(64)}`
  const canonical = 'a'.repeat(128)
  const fooSentinelId = toTarballKey({ name: 'foo', version: '1.0.0', patch: sentinel })
  const barSentinelId = toTarballKey({ name: 'bar', version: '1.0.0', patch: sentinel })
  const bazSentinelId = toTarballKey({ name: 'baz', version: '1.0.0', patch: sentinel })
  const fooCanonicalId = toTarballKey({ name: 'foo', version: '1.0.0', patch: canonical })
  const rdSentinelId = `${toTarballKey({ name: 'rd', version: '1.0.0', patch: sentinel })}(react@18.0.0)`

  // Sentinel-keyed Node fixture seeded via Builder (parse-time, unguarded).
  const sealWithSentinelNode = () => {
    const b = newBuilder()
    b.addNode(n('app@1.0.0', 'app', '1.0.0', [], { workspacePath: '' }))
    b.addNode(n(fooSentinelId, 'foo', '1.0.0', [], { patch: sentinel }))
    b.addNode(n('bar@1.0.0', 'bar', '1.0.0'))
    b.addEdge('app@1.0.0', fooSentinelId, 'dep')
    b.setTarball({ name: 'foo', version: '1.0.0', patch: sentinel }, { license: 'MIT' })
    return b.seal()
  }

  const expectIrreducibleLoss = (run: () => unknown) => {
    let caught: unknown
    try { run() } catch (e) { caught = e }
    expect(caught).toBeInstanceOf(LockfileError)
    expect((caught as LockfileError).code).toBe('IRREDUCIBLE_LOSS')
  }

  it('Builder.addNode rejects invalid Node.patch with LockfileError(INVALID_INPUT)', () => {
    const b = newBuilder()
    let caught: unknown
    try {
      b.addNode(n('foo@1.0.0', 'foo', '1.0.0', [], { patch: 'BAD' }))
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(LockfileError)
    expect((caught as LockfileError).code).toBe('INVALID_INPUT')
  })

  it('Mutator.replaceNode rejects invalid Node.patch with LockfileError(INVALID_INPUT)', () => {
    const b = newBuilder()
    b.addNode(n('foo@1.0.0', 'foo', '1.0.0'))
    const g = b.seal()
    let caught: unknown
    try {
      g.mutate(m => {
        m.replaceNode('foo@1.0.0', n('foo@1.0.0', 'foo', '1.0.0', [], { patch: 'BAD' }))
      })
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(LockfileError)
    expect((caught as LockfileError).code).toBe('INVALID_INPUT')
  })

  it('Builder.addNode + setTarball with sentinel SUCCEED (parse-time, unguarded)', () => {
    const g = sealWithSentinelNode()
    expect(g.getNode(fooSentinelId)?.patch).toBe(sentinel)
    expect(g.tarball({ name: 'foo', version: '1.0.0', patch: sentinel })?.license).toBe('MIT')
  })

  it('Mutator.addNode REFUSES sentinel-shaped Node.patch with IRREDUCIBLE_LOSS', () => {
    const g = sealWithSentinelNode()
    expectIrreducibleLoss(() => g.mutate(m => {
      m.addNode(n(bazSentinelId, 'baz', '1.0.0', [], { patch: sentinel }))
    }))
  })

  it('Mutator.replaceNode REFUSES when EXISTING node is sentinel-keyed (covers from-sentinel)', () => {
    const g = sealWithSentinelNode()
    expectIrreducibleLoss(() => g.mutate(m => {
      m.replaceNode(fooSentinelId, n(fooCanonicalId, 'foo', '1.0.0', [], { patch: canonical }))
    }))
  })

  it('Mutator.replaceNode REFUSES when NEW node is sentinel-keyed (covers to-sentinel)', () => {
    const g = sealWithSentinelNode()
    expectIrreducibleLoss(() => g.mutate(m => {
      m.replaceNode('bar@1.0.0', n(barSentinelId, 'bar', '1.0.0', [], { patch: sentinel }))
    }))
  })

  it('Mutator.replacePeerContext REFUSES on sentinel-keyed node (re-keys = forks)', () => {
    const b = newBuilder()
    b.addNode(n('app@1.0.0', 'app', '1.0.0', [], { workspacePath: '' }))
    b.addNode(n('react@18.0.0', 'react', '18.0.0'))
    b.addNode(n('react@17.0.0', 'react', '17.0.0'))
    b.addNode(n(rdSentinelId, 'rd', '1.0.0', ['react@18.0.0'], { patch: sentinel }))
    b.addEdge('app@1.0.0', rdSentinelId, 'dep')
    b.addEdge(rdSentinelId, 'react@18.0.0', 'peer')
    const g = b.seal()
    expectIrreducibleLoss(() => g.mutate(m => {
      m.replacePeerContext(rdSentinelId, ['react@17.0.0'])
    }))
  })

  it('Mutator.setTarball REFUSES sentinel-keyed inputs with IRREDUCIBLE_LOSS', () => {
    const g = sealWithSentinelNode()
    expectIrreducibleLoss(() => g.mutate(m => {
      m.setTarball({ name: 'foo', version: '1.0.0', patch: sentinel }, { license: 'Apache-2.0' })
    }))
  })

  it('Mutator.setTarball rejects malformed sentinel-prefixed patch with INVALID_INPUT (intake gate before sentinel-refusal)', () => {
    const g = sealWithSentinelNode()
    let caught: unknown
    try {
      g.mutate(m => {
        m.setTarball({ name: 'foo', version: '1.0.0', patch: 'unresolved-zzz' }, { license: 'MIT' })
      })
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(LockfileError)
    expect((caught as LockfileError).code).toBe('INVALID_INPUT')
  })

  it('Mutator.removeNode PERMITTED on sentinel-keyed node (deletion, no fork)', () => {
    const g = sealWithSentinelNode()
    const { graph: g2 } = g.mutate(m => {
      m.removeEdge('app@1.0.0', fooSentinelId, 'dep')
      m.removeNode(fooSentinelId)
    })
    expect(g2.getNode(fooSentinelId)).toBeUndefined()
  })

  it('Mutator.addEdge / removeEdge PERMITTED touching sentinel-keyed nodes', () => {
    const g = sealWithSentinelNode()
    const { graph: g2 } = g.mutate(m => {
      m.addEdge(fooSentinelId, 'bar@1.0.0', 'dep')
    })
    expect(g2.out(fooSentinelId).map(e => e.dst)).toEqual(['bar@1.0.0'])
    const { graph: g3 } = g2.mutate(m => {
      m.removeEdge(fooSentinelId, 'bar@1.0.0', 'dep')
    })
    expect(g3.out(fooSentinelId)).toEqual([])
  })

  it('Mutator.removeTarball PERMITTED on sentinel key (ADR-0011:301-304 carve-out)', () => {
    const g = sealWithSentinelNode()
    const { graph: g2 } = g.mutate(m => {
      m.removeTarball({ name: 'foo', version: '1.0.0', patch: sentinel })
    })
    expect(g2.tarball({ name: 'foo', version: '1.0.0', patch: sentinel })).toBeUndefined()
  })
})
