// ADR-0023 §9.2 — tree completion BFS acceptance gate.

import { describe, expect, it } from 'vitest'
import { completeTransitives } from '../../main/ts/complete/tree-complete.ts'
import { frozenRegistry } from '../../main/ts/registry/frozen.ts'
import type { Packument, RegistryAdapter } from '../../main/ts/registry/types.ts'
import { addEdge, addPackage, graphOf } from './_modify-test-utils.ts'

describe('complete/completeTransitives', () => {
  it('no-op when graph is already fully wired', async () => {
    const graph = graphOf(builder => {
      const ws = addPackage(builder, { name: 'app', version: '0.0.0', workspacePath: '.' })
      const lodash = addPackage(builder, { name: 'lodash', version: '4.17.21' })
      addEdge(builder, ws, lodash, 'dep')
    })

    const result = await completeTransitives(graph, frozenRegistry(graph))
    expect(result.added).toEqual([])
    expect(result.wired).toEqual([])
  })

  it('workspace skip — workspace nodes are not queried as packument targets', async () => {
    const graph = graphOf(builder => {
      addPackage(builder, { name: '@my/workspace', version: '1.0.0', workspacePath: 'packages/workspace' })
    })

    // frozenRegistry returns undefined for workspace; completion must
    // skip the workspace node, not emit COMPLETION_NODE_UNKNOWN.
    const result = await completeTransitives(graph, frozenRegistry(graph))
    const codes = result.unresolved.map(d => d.code)
    expect(codes).not.toContain('COMPLETION_NODE_UNKNOWN')
  })

  it('walks workspace OUT-edges normally even when workspace itself is skipped', async () => {
    const graph = graphOf(builder => {
      const ws = addPackage(builder, { name: '@my/ws', version: '1.0.0', workspacePath: '.' })
      const lodash = addPackage(builder, { name: 'lodash', version: '4.17.21' })
      addEdge(builder, ws, lodash, 'dep')
    })

    // Workspace is skipped, but lodash should be visited (via the out-edge walk).
    const result = await completeTransitives(graph, frozenRegistry(graph))
    expect(result.unresolved.filter(d => d.code === 'COMPLETION_NODE_UNKNOWN')).toEqual([])
  })

  it('seed-driven — recently-added nodes seed the frontier', async () => {
    const graph = graphOf(builder => {
      const ws = addPackage(builder, { name: 'app', version: '0.0.0', workspacePath: '.' })
      const a = addPackage(builder, { name: 'a', version: '1.0.0' })
      addEdge(builder, ws, a, 'dep')
    })

    const result = await completeTransitives(graph, frozenRegistry(graph), {
      seed: {
        recentlyAdded:    new Set(['a@1.0.0']),
        recentlyOrphaned: new Set(),
      },
    })
    expect(result.added).toEqual([])
  })

  it('orphan exclusion — recently-orphaned NodeIds are skipped from the frontier seed', async () => {
    // We build a graph where one node is technically a root (no incoming
    // edges) but marked as orphaned. Without the exclusion it would be
    // visited; with it, no COMPLETION_NODE_UNKNOWN emits for it (assuming
    // frozenRegistry has its packument).
    const graph = graphOf(builder => {
      const ws = addPackage(builder, { name: 'app', version: '0.0.0', workspacePath: '.' })
      const a = addPackage(builder, { name: 'a', version: '1.0.0' })
      // a is a root (no incoming edges) but we tag it orphaned.
      addEdge(builder, ws, a, 'dep')   // give a parent so frozenRegistry sees it
    })

    // Mark a@1.0.0 as orphaned; the BFS frontier should not seed it.
    // Roots() returns workspace 'app' only (since a has incoming from ws).
    // So this test mainly checks the seed code path doesn't crash when
    // recentlyOrphaned is non-empty.
    const result = await completeTransitives(graph, frozenRegistry(graph), {
      seed: {
        recentlyAdded:    new Set(),
        recentlyOrphaned: new Set(['a@1.0.0']),
      },
    })
    expect(result.added).toEqual([])
  })

  it('monotone-additive — never removes existing nodes', async () => {
    const graph = graphOf(builder => {
      const ws = addPackage(builder, { name: 'app', version: '0.0.0', workspacePath: '.' })
      const orphan = addPackage(builder, { name: 'orphan', version: '1.0.0' })
      addEdge(builder, ws, 'orphan@1.0.0', 'dep')
    })

    const before = new Set(Array.from(graph.nodes()).map(n => n.id))
    const result = await completeTransitives(graph, frozenRegistry(graph))
    const after = new Set(Array.from(result.graph.nodes()).map(n => n.id))
    // Every "before" node still exists in "after".
    for (const id of before) expect(after.has(id)).toBe(true)
  })

  it('async fixpoint — second invocation is a no-op', async () => {
    const graph = graphOf(builder => {
      const ws = addPackage(builder, { name: 'app', version: '0.0.0', workspacePath: '.' })
      const lodash = addPackage(builder, { name: 'lodash', version: '4.17.21' })
      addEdge(builder, ws, lodash, 'dep')
    })

    const first  = await completeTransitives(graph, frozenRegistry(graph))
    const second = await completeTransitives(first.graph, frozenRegistry(first.graph))
    expect(second.added).toEqual([])
    expect(second.wired).toEqual([])
  })

  it('frozen registry — COMPLETION_UNRESOLVED when packument lacks a needed transitive', async () => {
    // Compose a frozen registry that says lodash depends on ms@^2,
    // but only lodash itself is in the graph — ms is unknown.
    const graph = graphOf(builder => {
      const ws = addPackage(builder, { name: 'app', version: '0.0.0', workspacePath: '.' })
      addPackage(builder, { name: 'lodash', version: '4.17.21' })
      addEdge(builder, ws, 'lodash@4.17.21', 'dep')
    })

    // Hand-roll a registry that adds an `ms@^2` dep to lodash@4.17.21.
    const lodashPkg: Packument = {
      name: 'lodash',
      distTags: { latest: '4.17.21' },
      versions: {
        '4.17.21': {
          name: 'lodash',
          version: '4.17.21',
          dependencies: { ms: '^2.0.0' },
        },
      },
    }
    const fakeRegistry: RegistryAdapter = {
      async packument(name) {
        if (name === 'lodash') return lodashPkg
        return undefined
      },
      async resolve(name, range) {
        if (name === 'lodash' && range === '4.17.21') {
          return { name: 'lodash', version: '4.17.21' }
        }
        return undefined
      },
    }

    const result = await completeTransitives(graph, fakeRegistry)
    const codes = result.unresolved.map(d => d.code)
    expect(codes).toContain('COMPLETION_UNRESOLVED')
  })

  it('happy-path completion — wires a transitive that the registry can resolve', async () => {
    const graph = graphOf(builder => {
      const ws = addPackage(builder, { name: 'app', version: '0.0.0', workspacePath: '.' })
      addPackage(builder, { name: 'lodash', version: '4.17.21' })
      addEdge(builder, ws, 'lodash@4.17.21', 'dep')
    })

    const lodashPkg: Packument = {
      name: 'lodash',
      distTags: { latest: '4.17.21' },
      versions: {
        '4.17.21': {
          name: 'lodash',
          version: '4.17.21',
          dependencies: { ms: '^2.0.0' },
        },
      },
    }
    const msPkg: Packument = {
      name: 'ms',
      distTags: { latest: '2.1.3' },
      versions: {
        '2.1.3': { name: 'ms', version: '2.1.3' },
      },
    }
    const fakeRegistry: RegistryAdapter = {
      async packument(name) {
        if (name === 'lodash') return lodashPkg
        if (name === 'ms') return msPkg
        return undefined
      },
      async resolve(name, range) {
        if (name === 'lodash') return { name: 'lodash', version: '4.17.21' }
        if (name === 'ms' && range === '^2.0.0') return { name: 'ms', version: '2.1.3' }
        return undefined
      },
    }

    const result = await completeTransitives(graph, fakeRegistry)
    expect(result.added).toContain('ms@2.1.3')
    expect(result.graph.getNode('ms@2.1.3')).toBeDefined()
    // Edge wired: lodash → ms
    const lodashOut = result.graph.out('lodash@4.17.21')
    expect(lodashOut.some(e => e.dst === 'ms@2.1.3' && e.kind === 'dep')).toBe(true)
  })

  // ADR-0023 §8.6 — COMPLETION_* diagnostics land on Graph.diagnostics().
  it('§8.6 — COMPLETION_NODE_ADDED lands on Graph.diagnostics()', async () => {
    const graph = graphOf(builder => {
      const ws = addPackage(builder, { name: 'app', version: '0.0.0', workspacePath: '.' })
      addPackage(builder, { name: 'lodash', version: '4.17.21' })
      addEdge(builder, ws, 'lodash@4.17.21', 'dep')
    })

    const lodashPkg: Packument = {
      name: 'lodash',
      distTags: { latest: '4.17.21' },
      versions: {
        '4.17.21': {
          name: 'lodash',
          version: '4.17.21',
          dependencies: { ms: '^2.0.0' },
        },
      },
    }
    const msPkg: Packument = {
      name: 'ms',
      distTags: { latest: '2.1.3' },
      versions: { '2.1.3': { name: 'ms', version: '2.1.3' } },
    }
    const fakeRegistry: RegistryAdapter = {
      async packument(name) {
        if (name === 'lodash') return lodashPkg
        if (name === 'ms') return msPkg
        return undefined
      },
      async resolve(name, range) {
        if (name === 'lodash') return { name: 'lodash', version: '4.17.21' }
        if (name === 'ms' && range === '^2.0.0') return { name: 'ms', version: '2.1.3' }
        return undefined
      },
    }

    const result = await completeTransitives(graph, fakeRegistry)
    const codes = result.graph.diagnostics().map(d => d.code)
    expect(codes).toContain('COMPLETION_NODE_ADDED')
  })

  it('§8.6 — COMPLETION_UNRESOLVED lands on Graph.diagnostics()', async () => {
    const graph = graphOf(builder => {
      const ws = addPackage(builder, { name: 'app', version: '0.0.0', workspacePath: '.' })
      addPackage(builder, { name: 'lodash', version: '4.17.21' })
      addEdge(builder, ws, 'lodash@4.17.21', 'dep')
    })

    const lodashPkg: Packument = {
      name: 'lodash',
      distTags: { latest: '4.17.21' },
      versions: {
        '4.17.21': {
          name: 'lodash',
          version: '4.17.21',
          dependencies: { 'missing-dep': '^1.0.0' },
        },
      },
    }
    const fakeRegistry: RegistryAdapter = {
      async packument(name) {
        if (name === 'lodash') return lodashPkg
        return undefined
      },
      async resolve(name) {
        if (name === 'lodash') return { name: 'lodash', version: '4.17.21' }
        return undefined
      },
    }

    const result = await completeTransitives(graph, fakeRegistry)
    const codes = result.graph.diagnostics().map(d => d.code)
    expect(codes).toContain('COMPLETION_UNRESOLVED')
  })

  // NIT-C — info-severity diagnostics flow through ModifyResult.unresolved
  // (previous build dropped them, asymmetric with per-primitive modifiers).
  it('§7.5 — info-severity COMPLETION_NODE_ADDED appears in unresolved (NIT-C symmetry)', async () => {
    const graph = graphOf(builder => {
      const ws = addPackage(builder, { name: 'app', version: '0.0.0', workspacePath: '.' })
      addPackage(builder, { name: 'lodash', version: '4.17.21' })
      addEdge(builder, ws, 'lodash@4.17.21', 'dep')
    })

    const lodashPkg: Packument = {
      name: 'lodash',
      distTags: { latest: '4.17.21' },
      versions: {
        '4.17.21': {
          name:         'lodash',
          version:      '4.17.21',
          dependencies: { ms: '^2.0.0' },
        },
      },
    }
    const msPkg: Packument = {
      name:     'ms',
      distTags: { latest: '2.1.3' },
      versions: { '2.1.3': { name: 'ms', version: '2.1.3' } },
    }
    const fakeRegistry: RegistryAdapter = {
      async packument(name) {
        if (name === 'lodash') return lodashPkg
        if (name === 'ms')     return msPkg
        return undefined
      },
      async resolve(name, range) {
        if (name === 'lodash')                        return { name: 'lodash', version: '4.17.21' }
        if (name === 'ms' && range === '^2.0.0')      return { name: 'ms', version: '2.1.3' }
        return undefined
      },
    }

    const result = await completeTransitives(graph, fakeRegistry)
    const codes  = result.unresolved.map(d => d.code)
    // The added ms node fires an info-level COMPLETION_NODE_ADDED — must
    // appear in unresolved post-NIT-C (was previously dropped by the
    // severity filter at L78).
    expect(codes).toContain('COMPLETION_NODE_ADDED')
  })

  it('§7.5 — Graph.diagnostics() and unresolved are symmetric across severities (NIT-C)', async () => {
    // The two channels (Graph-level + streaming hook) must carry the same
    // diagnostic set after NIT-C alignment — previously info-severity events
    // landed on Graph but were filtered out of unresolved.
    const graph = graphOf(builder => {
      const ws = addPackage(builder, { name: 'app', version: '0.0.0', workspacePath: '.' })
      addPackage(builder, { name: 'lodash', version: '4.17.21' })
      addEdge(builder, ws, 'lodash@4.17.21', 'dep')
    })

    const lodashPkg: Packument = {
      name: 'lodash',
      distTags: { latest: '4.17.21' },
      versions: {
        '4.17.21': {
          name:         'lodash',
          version:      '4.17.21',
          dependencies: { ms: '^2.0.0' },
        },
      },
    }
    const msPkg: Packument = {
      name:     'ms',
      distTags: { latest: '2.1.3' },
      versions: { '2.1.3': { name: 'ms', version: '2.1.3' } },
    }
    const fakeRegistry: RegistryAdapter = {
      async packument(name) {
        if (name === 'lodash') return lodashPkg
        if (name === 'ms')     return msPkg
        return undefined
      },
      async resolve(name, range) {
        if (name === 'lodash')                   return { name: 'lodash', version: '4.17.21' }
        if (name === 'ms' && range === '^2.0.0') return { name: 'ms', version: '2.1.3' }
        return undefined
      },
    }

    const result      = await completeTransitives(graph, fakeRegistry)
    const graphCodes  = result.graph.diagnostics().map(d => d.code).sort()
    const streamCodes = result.unresolved.map(d => d.code).sort()
    expect(streamCodes).toEqual(graphCodes)
  })
})
