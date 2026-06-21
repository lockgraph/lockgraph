// ADR-0023 §9.2 — replaceVersion acceptance gate.

import { describe, expect, it } from 'vitest'
import { frozenRegistry } from '../../main/ts/registry/frozen.ts'
import { replaceVersion } from '../../main/ts/modify/replace-version.ts'
import { sentinelHashOf } from '../../main/ts/recipe/patch.ts'
import { addEdge, addPackage, graphOf } from './_modify-test-utils.ts'

describe('modify/replaceVersion', () => {
  it('happy path — replaces a version that already exists as a sibling (merge branch)', async () => {
    const graph = graphOf(builder => {
      const workspaceId = addPackage(builder, {
        name: 'app',
        version: '0.0.0',
        workspacePath: '.',
      })
      const oldLodashId = addPackage(builder, { name: 'lodash', version: '4.17.20' })
      const newLodashId = addPackage(builder, { name: 'lodash', version: '4.17.21' })
      addEdge(builder, workspaceId, oldLodashId, 'dep', '^4.17.0')
      // newLodashId is a root sibling with no incoming edges yet.
    })

    const ctx = { registry: frozenRegistry(graph) }
    const result = await replaceVersion(
      graph,
      { name: 'lodash', fromRange: '4.17.20' },
      '4.17.21',
      ctx,
    )

    expect(result.replaced).toEqual([{ from: 'lodash@4.17.20', to: 'lodash@4.17.21' }])
    expect(result.removed).toContain('lodash@4.17.20')
    expect(result.graph.getNode('lodash@4.17.20')).toBeUndefined()
    expect(result.graph.getNode('lodash@4.17.21')).toBeDefined()
    // Workspace's edge now points at the new lodash.
    const wsOut = result.graph.out('app@0.0.0').map(e => `${e.kind}:${e.dst}`)
    expect(wsOut).toContain('dep:lodash@4.17.21')
  })

  it('happy path — rebinds when target NodeId is fresh (no collision)', async () => {
    const graph = graphOf(builder => {
      const wsId = addPackage(builder, { name: 'app', version: '0.0.0', workspacePath: '.' })
      const oldId = addPackage(builder, { name: 'lodash', version: '4.17.20' })
      addEdge(builder, wsId, oldId, 'dep', '^4.17.0')
    })

    // frozenRegistry of THIS graph only knows lodash@4.17.20 — adding the
    // target manually via a richer registry. We pass a hand-rolled registry.
    const fakeRegistry = {
      async packument() { return undefined },
      async resolve(name: string, range: string) {
        if (name === 'lodash' && range === '4.17.21') {
          return { name: 'lodash', version: '4.17.21' }
        }
        return undefined
      },
    }

    const result = await replaceVersion(
      graph,
      { name: 'lodash', fromRange: '*' },
      '4.17.21',
      { registry: fakeRegistry },
    )

    expect(result.replaced).toEqual([{ from: 'lodash@4.17.20', to: 'lodash@4.17.21' }])
    expect(result.added).toContain('lodash@4.17.21')
    expect(result.recentlyAdded.has('lodash@4.17.21')).toBe(true)
    expect(result.graph.getNode('lodash@4.17.21')).toBeDefined()
    expect(result.graph.getNode('lodash@4.17.20')).toBeUndefined()
  })

  it('a dependency-changing bump clears the old version\'s outgoing deps (yaf lockgraph-message)', async () => {
    // handlebars@4.0.0 declares async/optimist; @4.7.9 drops them for a fresh
    // set. The bump must NOT leave the 4.0.0 deps on the node — completeTransitives
    // (additive) cannot remove them, so replaceVersion clears them.
    const graph = graphOf(builder => {
      const ws       = addPackage(builder, { name: 'app',        version: '0.0.0', workspacePath: '.' })
      const hb       = addPackage(builder, { name: 'handlebars', version: '4.0.0' })
      const asyncDep = addPackage(builder, { name: 'async',      version: '1.0.0' })
      const optimist = addPackage(builder, { name: 'optimist',   version: '0.6.1' })
      addEdge(builder, ws, hb,       'dep', '^4.0.0')
      addEdge(builder, hb, asyncDep, 'dep', '^1.4.0')   // 4.0.0-era deps — stale post-bump
      addEdge(builder, hb, optimist, 'dep', '^0.6.1')
    })
    const fakeRegistry = {
      async packument() { return undefined },
      async resolve(name: string, range: string) {
        return name === 'handlebars' && range === '4.7.9'
          ? { name: 'handlebars', version: '4.7.9' }
          : undefined
      },
    }

    const result = await replaceVersion(
      graph, { name: 'handlebars', fromRange: '4.0.0' }, '4.7.9', { registry: fakeRegistry },
    )

    expect(result.graph.getNode('handlebars@4.7.9')).toBeDefined()
    // the bumped node carries NO stale outgoing deps; completion rewires fresh.
    const out = [...result.graph.out('handlebars@4.7.9')].filter(e => e.kind === 'dep')
    expect(out).toEqual([])
    // a REBIND removes no node, so the dropped-edge targets that lost their last
    // incoming edge are the only orphan signal — reported via recentlyOrphaned so
    // a seeded pruneOrphans can retire them (yaf .69: empty res.removed on rebind).
    expect([...result.recentlyOrphaned].sort()).toEqual(['async@1.0.0', 'optimist@0.6.1'])
  })

  it('fromRange="*" matches every version of the named package', async () => {
    const graph = graphOf(builder => {
      const ws = addPackage(builder, { name: 'app', version: '0.0.0', workspacePath: '.' })
      const a = addPackage(builder, { name: 'lodash', version: '4.17.20' })
      const b = addPackage(builder, { name: 'lodash', version: '3.10.1' })
      const c = addPackage(builder, { name: 'lodash', version: '4.17.21' })
      addEdge(builder, ws, a, 'dep')
      addEdge(builder, ws, b, 'dep')
    })

    const result = await replaceVersion(
      graph,
      { name: 'lodash', fromRange: '*' },
      '4.17.21',
      { registry: frozenRegistry(graph) },
    )

    // Three lodash versions exist; the target one is itself, so it's a no-op.
    // The other two merge into 4.17.21.
    expect(result.replaced.length).toBe(2)
    expect(result.graph.getNode('lodash@4.17.21')).toBeDefined()
    expect(result.graph.getNode('lodash@4.17.20')).toBeUndefined()
    expect(result.graph.getNode('lodash@3.10.1')).toBeUndefined()
  })

  it('B1 — sentinel-keyed source emits MODIFY_SENTINEL_REFUSED and skips, no throw', async () => {
    const sentinel = sentinelHashOf('lodash@4.17.20:literal-key')
    const graph = graphOf(builder => {
      const ws = addPackage(builder, { name: 'app', version: '0.0.0', workspacePath: '.' })
      const sentinelLodash = addPackage(builder, {
        name: 'lodash',
        version: '4.17.20',
        patch: sentinel,
      })
      const cleanLodash = addPackage(builder, { name: 'lodash', version: '4.17.21' })
      addEdge(builder, ws, sentinelLodash, 'dep')
      addEdge(builder, ws, cleanLodash, 'dep')
    })

    const result = await replaceVersion(
      graph,
      { name: 'lodash', fromRange: '*' },
      '4.17.22',
      {
        registry: {
          async packument() { return undefined },
          async resolve(name, range) {
            if (name === 'lodash' && range === '4.17.22') {
              return { name: 'lodash', version: '4.17.22' }
            }
            return undefined
          },
        },
      },
    )

    // Sentinel node skipped; clean node replaced.
    const codes = result.unresolved.map(d => d.code)
    expect(codes).toContain('MODIFY_SENTINEL_REFUSED')
    expect(result.replaced.map(r => r.from)).toContain('lodash@4.17.21')
    expect(result.replaced.map(r => r.from)).not.toContain(`lodash@4.17.20+patch=${sentinel}`)
    expect(result.graph.getNode(`lodash@4.17.20+patch=${sentinel}`)).toBeDefined()
  })

  it('MODIFY_RESOLVE_FAILED when registry.resolve returns undefined', async () => {
    const graph = graphOf(builder => {
      const ws = addPackage(builder, { name: 'app', version: '0.0.0', workspacePath: '.' })
      addPackage(builder, { name: 'lodash', version: '4.17.20' })
      addEdge(builder, ws, 'lodash@4.17.20', 'dep')
    })

    const result = await replaceVersion(
      graph,
      { name: 'lodash' },
      '^9.999.0',
      { registry: frozenRegistry(graph) },
    )

    expect(result.unresolved.map(d => d.code)).toContain('MODIFY_RESOLVE_FAILED')
    expect(result.replaced).toEqual([])
    // Graph unchanged.
    expect(result.graph.getNode('lodash@4.17.20')).toBeDefined()
  })

  it('async fixpoint — re-invoking the same primitive on the post-modify graph is a no-op', async () => {
    const graph = graphOf(builder => {
      const ws = addPackage(builder, { name: 'app', version: '0.0.0', workspacePath: '.' })
      addPackage(builder, { name: 'lodash', version: '4.17.20' })
      addPackage(builder, { name: 'lodash', version: '4.17.21' })
      addEdge(builder, ws, 'lodash@4.17.20', 'dep')
    })

    const ctx = { registry: frozenRegistry(graph) }
    const first = await replaceVersion(
      graph,
      { name: 'lodash', fromRange: '4.17.20' },
      '4.17.21',
      ctx,
    )
    expect(first.replaced.length).toBe(1)

    const second = await replaceVersion(
      first.graph,
      { name: 'lodash', fromRange: '4.17.20' },
      '4.17.21',
      { registry: frozenRegistry(first.graph) },
    )
    expect(second.replaced.length).toBe(0)
  })

  // ADR-0023 §8.6 — MODIFY_* diagnostics also land on Graph.diagnostics()
  // so stringify-side adapters see them via the canonical read channel.
  it('§8.6 — MODIFY_NODE_REPLACED lands on Graph.diagnostics() (merge branch)', async () => {
    const graph = graphOf(builder => {
      const ws = addPackage(builder, { name: 'app', version: '0.0.0', workspacePath: '.' })
      const oldId = addPackage(builder, { name: 'lodash', version: '4.17.20' })
      addPackage(builder, { name: 'lodash', version: '4.17.21' })
      addEdge(builder, ws, oldId, 'dep', '^4.17.0')
    })

    const result = await replaceVersion(
      graph,
      { name: 'lodash', fromRange: '4.17.20' },
      '4.17.21',
      { registry: frozenRegistry(graph) },
    )

    const codes = result.graph.diagnostics().map(d => d.code)
    expect(codes).toContain('MODIFY_NODE_REPLACED')
  })

  it('§8.6 — MODIFY_RESOLVE_FAILED lands on Graph.diagnostics()', async () => {
    const graph = graphOf(builder => {
      const ws = addPackage(builder, { name: 'app', version: '0.0.0', workspacePath: '.' })
      addPackage(builder, { name: 'lodash', version: '4.17.20' })
      addEdge(builder, ws, 'lodash@4.17.20', 'dep')
    })

    const result = await replaceVersion(
      graph,
      { name: 'lodash' },
      '^9.999.0',
      { registry: frozenRegistry(graph) },
    )

    const codes = result.graph.diagnostics().map(d => d.code)
    expect(codes).toContain('MODIFY_RESOLVE_FAILED')
  })

  it('preserves peerContext on the rebound NodeId', async () => {
    const graph = graphOf(builder => {
      const reactId = addPackage(builder, { name: 'react', version: '18.0.0' })
      const oldId = addPackage(builder, {
        name: 'react-dom',
        version: '18.0.0',
        peerContext: [reactId],
      })
      addEdge(builder, oldId, reactId, 'peer', '^18.0.0')
    })

    const result = await replaceVersion(
      graph,
      { name: 'react-dom' },
      '18.0.1',
      {
        registry: {
          async packument() { return undefined },
          async resolve(name, range) {
            if (name === 'react-dom' && range === '18.0.1') {
              return { name: 'react-dom', version: '18.0.1' }
            }
            return undefined
          },
        },
      },
    )

    // peerContext preserved → new id has the same parenthesised peer slot.
    expect(result.replaced[0]?.to).toBe('react-dom@18.0.1(react@18.0.0)')
    expect(result.graph.getNode('react-dom@18.0.1(react@18.0.0)')).toBeDefined()
  })
})
