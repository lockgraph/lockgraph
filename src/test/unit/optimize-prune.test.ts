// yaf lockgraph-message (.69 follow-up, issue 2) — pruneOrphans acceptance.
//
// Reference-count GC: retire only nodes that lost their LAST incoming edge of
// any kind (in-degree 0), plus the closure such removals strand. The deliberate
// contrast with `optimize` (reachability): a node anything still references is
// NEVER removed, even when that referrer is unreachable from a workspace.

import { describe, expect, it } from 'vitest'
import { pruneOrphans } from '../../main/ts/optimize/prune.ts'
import { optimize } from '../../main/ts/optimize/optimize.ts'
import { addEdge, addPackage, graphOf } from './_modify-test-utils.ts'

describe('optimize/pruneOrphans', () => {
  it('retires a stranded node and the closure it transitively orphans', () => {
    // The handlebars-bump shape: `old` lost its last incoming edge (the bumped
    // node no longer points at it); `old-dep` is referenced ONLY by `old`.
    const graph = graphOf(b => {
      const ws     = addPackage(b, { name: 'app',     version: '0.0.0', workspacePath: '.' })
      const live   = addPackage(b, { name: 'live',    version: '1.0.0' })
      const old    = addPackage(b, { name: 'old',     version: '1.0.0' })
      const oldDep = addPackage(b, { name: 'old-dep', version: '1.0.0' })
      addEdge(b, ws, live, 'dep')
      addEdge(b, old, oldDep, 'dep')   // `old` itself has NO incoming edge — stranded
    })

    const result = pruneOrphans(graph)

    expect([...result.removed].sort()).toEqual(['old-dep@1.0.0', 'old@1.0.0'])
    expect(result.graph.getNode('old@1.0.0')).toBeUndefined()
    expect(result.graph.getNode('old-dep@1.0.0')).toBeUndefined()
    // the live tree is untouched
    expect(result.graph.getNode('app@0.0.0')).toBeDefined()
    expect(result.graph.getNode('live@1.0.0')).toBeDefined()
    expect(result.unresolved.map(d => d.code)).toContain('PRUNE_NODE_REMOVED')
  })

  it('keeps a referenced node even when the referrer is unreachable — no over-collect (vs optimize)', () => {
    // A 2-cycle disconnected from the workspace: every node has in-degree 1, so
    // reference-counting retires NONE. optimize (reachability) drops the whole
    // cluster — the exact over-collection yaf flagged. This pins the contrast.
    const graph = graphOf(b => {
      const ws = addPackage(b, { name: 'app', version: '0.0.0', workspacePath: '.' })
      const live = addPackage(b, { name: 'live', version: '1.0.0' })
      const a = addPackage(b, { name: 'a', version: '1.0.0' })
      const bb = addPackage(b, { name: 'b', version: '1.0.0' })
      addEdge(b, ws, live, 'dep')
      addEdge(b, a, bb, 'dep')
      addEdge(b, bb, a, 'dep')   // a <-> b cycle, no path from a workspace
    })

    const pruned = pruneOrphans(graph)
    expect(pruned.removed).toEqual([])
    expect(pruned.graph.getNode('a@1.0.0')).toBeDefined()
    expect(pruned.graph.getNode('b@1.0.0')).toBeDefined()

    // optimize, by contrast, sweeps the unreachable cluster.
    const optimized = optimize(graph)
    expect(optimized.removed).toEqual(expect.arrayContaining(['a@1.0.0', 'b@1.0.0']))
  })

  it('preserves dev/optional deps still referenced by a live node (all edge kinds counted)', () => {
    // A workspace's optional + dev deps survive — pruneOrphans counts in-degree
    // across ALL edge kinds, not just `dep`.
    const graph = graphOf(b => {
      const ws  = addPackage(b, { name: 'app', version: '0.0.0', workspacePath: '.' })
      const opt = addPackage(b, { name: 'fsevents', version: '2.3.3' })
      const dev = addPackage(b, { name: 'typescript', version: '5.0.0' })
      addEdge(b, ws, opt, 'optional')
      addEdge(b, ws, dev, 'dev')
    })

    const result = pruneOrphans(graph)
    expect(result.removed).toEqual([])
    expect(result.graph.getNode('fsevents@2.3.3')).toBeDefined()
    expect(result.graph.getNode('typescript@5.0.0')).toBeDefined()
  })

  it('never collects a workspace, even at in-degree 0', () => {
    const graph = graphOf(b => {
      addPackage(b, { name: 'root', version: '0.0.0', workspacePath: '.' })
      const member = addPackage(b, { name: '@x/member', version: '1.0.0', workspacePath: 'packages/m' })
      // member has no incoming edge but is a workspace → kept.
      void member
    })

    const result = pruneOrphans(graph)
    expect(result.removed).toEqual([])
    expect(result.graph.getNode('root@0.0.0')).toBeDefined()
    expect(result.graph.getNode('@x/member@1.0.0')).toBeDefined()
    expect(result.unresolved.map(d => d.code)).toContain('PRUNE_NOOP')
  })

  it('is idempotent — a second call removes nothing', () => {
    const graph = graphOf(b => {
      addPackage(b, { name: 'app', version: '0.0.0', workspacePath: '.' })
      addPackage(b, { name: 'stray', version: '1.0.0' })   // in-degree 0 orphan
    })

    const first = pruneOrphans(graph)
    expect(first.removed).toEqual(['stray@1.0.0'])
    const second = pruneOrphans(first.graph)
    expect(second.removed).toEqual([])
    expect(second.unresolved.map(d => d.code)).toContain('PRUNE_NOOP')
  })

  it('seed bounds the sweep — a non-seeded in-degree-0 node is left untouched', () => {
    const graph = graphOf(b => {
      addPackage(b, { name: 'app', version: '0.0.0', workspacePath: '.' })
      addPackage(b, { name: 'seeded', version: '1.0.0' })       // in-degree 0
      addPackage(b, { name: 'unseeded', version: '1.0.0' })     // in-degree 0
    })

    const result = pruneOrphans(graph, { seed: new Set(['seeded@1.0.0']) })
    expect(result.removed).toEqual(['seeded@1.0.0'])
    expect(result.graph.getNode('unseeded@1.0.0')).toBeDefined()   // not in seed → kept
  })

  it('no-roots guard — unseeded on a rootless (no-workspace) graph no-ops, never wipes', () => {
    // yarn-classic shape: no workspace node, so every top-level dep is in-degree 0.
    // An unseeded sweep would cascade-wipe the lock; the guard keeps all nodes.
    const graph = graphOf(b => {
      const a   = addPackage(b, { name: 'a',   version: '1.0.0' })   // top-level, in-degree 0
      const dep = addPackage(b, { name: 'dep', version: '1.0.0' })
      addEdge(b, a, dep, 'dep')
    })

    const result = pruneOrphans(graph)
    expect(result.removed).toEqual([])
    expect(result.graph.getNode('a@1.0.0')).toBeDefined()
    expect(result.graph.getNode('dep@1.0.0')).toBeDefined()
    expect(result.unresolved.map(d => d.code)).toContain('PRUNE_NO_ROOTS')
  })

  it('seeded sweep still works on a rootless graph — bounded, no-roots guard does not apply', () => {
    const graph = graphOf(b => {
      const a      = addPackage(b, { name: 'a',      version: '1.0.0' })   // top-level, in-degree 0
      const keep   = addPackage(b, { name: 'keep',   version: '1.0.0' })
      addPackage(b, { name: 'orphan', version: '1.0.0' })                  // in-degree 0, seeded
      addEdge(b, a, keep, 'dep')
    })

    const result = pruneOrphans(graph, { seed: new Set(['orphan@1.0.0']) })
    expect(result.removed).toEqual(['orphan@1.0.0'])
    expect(result.graph.getNode('a@1.0.0')).toBeDefined()      // top-level NOT swept (unseeded guard is moot under a seed)
    expect(result.graph.getNode('keep@1.0.0')).toBeDefined()
  })
})
