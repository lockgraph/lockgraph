// ADR-0023 §9.2 — find-up resolve unit suite.

import { describe, expect, it } from 'vitest'
import { ancestorsOf, resolveFindUp } from '../../main/ts/complete/find-up.ts'
import { addEdge, addPackage, graphOf } from './_modify-test-utils.ts'

describe('complete/find-up', () => {
  it('reuse — finds satisfying sibling at the closest ancestor', async () => {
    const graph = graphOf(builder => {
      const ws = addPackage(builder, { name: 'app', version: '0.0.0', workspacePath: '.' })
      const a = addPackage(builder, { name: 'a', version: '1.0.0' })
      const lodash = addPackage(builder, { name: 'lodash', version: '4.17.21' })
      addEdge(builder, ws, a, 'dep')
      addEdge(builder, ws, lodash, 'dep')
    })

    expect(resolveFindUp(graph, 'a@1.0.0', 'lodash', '^4.17.0')).toBe('lodash@4.17.21')
  })

  it('block-hoist — ancestor has the name but version conflicts → undefined', async () => {
    const graph = graphOf(builder => {
      const ws = addPackage(builder, { name: 'app', version: '0.0.0', workspacePath: '.' })
      const a = addPackage(builder, { name: 'a', version: '1.0.0' })
      const lodashOld = addPackage(builder, { name: 'lodash', version: '3.10.1' })
      addEdge(builder, ws, a, 'dep')
      addEdge(builder, ws, lodashOld, 'dep')
    })

    // Ancestor 'app' declares lodash@3.10.1; consumer 'a' wants ^4 → conflict.
    expect(resolveFindUp(graph, 'a@1.0.0', 'lodash', '^4.0.0')).toBeUndefined()
  })

  it('returns undefined when no ancestor declares the name', async () => {
    const graph = graphOf(builder => {
      const ws = addPackage(builder, { name: 'app', version: '0.0.0', workspacePath: '.' })
      const a = addPackage(builder, { name: 'a', version: '1.0.0' })
      addEdge(builder, ws, a, 'dep')
    })

    expect(resolveFindUp(graph, 'a@1.0.0', 'lodash', '^4')).toBeUndefined()
  })

  it('F1 tiebreaker — highest semver-version wins on multiple satisfying candidates', async () => {
    const graph = graphOf(builder => {
      const ws = addPackage(builder, { name: 'app', version: '0.0.0', workspacePath: '.' })
      const a = addPackage(builder, { name: 'a', version: '1.0.0' })
      const lodash1 = addPackage(builder, { name: 'lodash', version: '4.17.20' })
      const lodash2 = addPackage(builder, { name: 'lodash', version: '4.17.21' })
      const lodash3 = addPackage(builder, { name: 'lodash', version: '4.0.0' })
      addEdge(builder, ws, a, 'dep')
      addEdge(builder, ws, lodash1, 'dep')
      addEdge(builder, ws, lodash2, 'dep')
      addEdge(builder, ws, lodash3, 'dep')
    })

    expect(resolveFindUp(graph, 'a@1.0.0', 'lodash', '^4.0.0')).toBe('lodash@4.17.21')
  })

  it('F1 tiebreaker — on version tie, lowest NodeId lex wins', async () => {
    // Two react-dom siblings same version, distinct peer slots.
    const graph = graphOf(builder => {
      const ws = addPackage(builder, { name: 'app', version: '0.0.0', workspacePath: '.' })
      const reactA = addPackage(builder, { name: 'react', version: '18.0.0' })
      const reactB = addPackage(builder, { name: 'react', version: '18.0.1' })
      const rd1 = addPackage(builder, {
        name: 'react-dom',
        version: '18.0.0',
        peerContext: [reactA],
      })
      const rd2 = addPackage(builder, {
        name: 'react-dom',
        version: '18.0.0',
        peerContext: [reactB],
      })
      addEdge(builder, ws, rd1, 'dep')
      addEdge(builder, ws, rd2, 'dep')
      addEdge(builder, rd1, reactA, 'peer')
      addEdge(builder, rd2, reactB, 'peer')
      // consumer
      const a = addPackage(builder, { name: 'a', version: '1.0.0' })
      addEdge(builder, ws, a, 'dep')
    })

    // Both react-dom@18.0.0 peer-virt siblings satisfy; tiebreaker = lowest NodeId lex.
    const id = resolveFindUp(graph, 'a@1.0.0', 'react-dom', '^18')
    // Lowest lex of:
    //   react-dom@18.0.0(react@18.0.0)
    //   react-dom@18.0.0(react@18.0.1)
    expect(id).toBe('react-dom@18.0.0(react@18.0.0)')
  })

  it('ancestor enumeration is BFS over incoming edges with cycle tolerance', async () => {
    const graph = graphOf(builder => {
      const ws = addPackage(builder, { name: 'app', version: '0.0.0', workspacePath: '.' })
      const a = addPackage(builder, { name: 'a', version: '1.0.0' })
      const b = addPackage(builder, { name: 'b', version: '1.0.0' })
      addEdge(builder, ws, a, 'dep')
      addEdge(builder, a, b, 'dep')
      // Synthetic cycle (allowed at graph layer; topoSort handles SCCs).
      addEdge(builder, b, a, 'dep')
    })

    const ancestors = ancestorsOf(graph, 'b@1.0.0').map(n => n.id)
    expect(ancestors).toContain('b@1.0.0')
    expect(ancestors).toContain('a@1.0.0')
    expect(ancestors).toContain('app@0.0.0')
    // BFS order: b first, then a (one-hop), then app (two-hop).
    expect(ancestors[0]).toBe('b@1.0.0')
  })

  it('exact-version range — pin-exact behaves identically to range satisfaction', async () => {
    const graph = graphOf(builder => {
      const ws = addPackage(builder, { name: 'app', version: '0.0.0', workspacePath: '.' })
      const a = addPackage(builder, { name: 'a', version: '1.0.0' })
      const lodash = addPackage(builder, { name: 'lodash', version: '4.17.21' })
      addEdge(builder, ws, a, 'dep')
      addEdge(builder, ws, lodash, 'dep')
    })

    expect(resolveFindUp(graph, 'a@1.0.0', 'lodash', '4.17.21')).toBe('lodash@4.17.21')
  })
})
