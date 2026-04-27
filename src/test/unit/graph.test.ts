import { describe, expect, it } from 'vitest'
import {
  newBuilder,
  GraphError,
  serializeNodeId,
  nameOf,
  type Node,
  type NodeId,
} from '../../main/ts/graph.ts'

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

describe('Builder + seal', () => {
  it('seals a single-node graph', () => {
    const b = newBuilder()
    b.addNode(n('foo@1.0.0', 'foo', '1.0.0'))
    const g = b.seal()
    expect(g.getNode('foo@1.0.0')?.name).toBe('foo')
    expect([...g.nodes()].map(x => x.id)).toEqual(['foo@1.0.0'])
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

  it('workspace nodes must have no incoming edges', () => {
    const b = newBuilder()
    b.addNode(n('app@1.0.0', 'app', '1.0.0', [], { workspacePath: '' }))
    b.addNode(n('a@1.0.0', 'a', '1.0.0'))
    b.addEdge('a@1.0.0', 'app@1.0.0', 'dep')
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
    b1.addNode(n('a@1.0.0', 'a', '1.0.0', [], { payload: { license: 'MIT' } }))
    b1.addNode(n('b@1.0.0', 'b', '1.0.0'))
    const g1 = b1.seal()

    const b2 = newBuilder()
    b2.addNode(n('a@1.0.0', 'a', '1.0.0', [], { payload: { license: 'Apache-2.0' } }))   // changed
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

  it('replaceNode same id swaps payload', () => {
    const g = seed()
    const { graph: g2 } = g.mutate(m => {
      m.replaceNode('a@1.0.0', n('a@1.0.0', 'a', '1.0.0', [], { payload: { license: 'MIT' } }))
    })
    expect(g2.getNode('a@1.0.0')?.payload?.license).toBe('MIT')
    // edges preserved
    expect(g2.out('a@1.0.0').map(e => e.dst)).toEqual(['b@1.0.0'])
    expect(g2.in('a@1.0.0').map(e => e.src)).toEqual(['app@1.0.0'])
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
})
