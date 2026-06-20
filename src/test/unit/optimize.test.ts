// ADR-0024 §9.2 — optimize phase acceptance gates.
//
// Covers all 9 §9.2 scenarios:
//   1. Noop roundtrip (fully-reachable graph)
//   2. replaceVersion-then-optimize merge-branch orphan trail
//   3. removeDependency-then-optimize cascade
//   4. Workspace preserved even when otherwise unreachable
//   5. Sentinel-keyed unreachable collected normally
//   6. preserve option pins a node
//   7. Idempotency — optimize(optimize(g).graph)
//   8. Peer-edge reachability — peerContext walk preserves the peer
//   9. Determinism — content-sort iteration order is byte-stable
//
// Plus a dual-channel test (OPTIMIZE_* lands on Graph.diagnostics() AND
// result.unresolved) per ADR §6.3 / ADR-0023 §8.6.

import { describe, expect, it } from 'vitest'
import { removeDependency } from '../../main/ts/modify/remove-dependency.ts'
import { optimize } from '../../main/ts/optimize/optimize.ts'
import { addEdge, addPackage, graphOf } from './_modify-test-utils.ts'

describe('optimize/mark-and-sweep', () => {
  // ────────────────────────────────────────────────────────────────
  // Gate 1 — Noop roundtrip
  // ────────────────────────────────────────────────────────────────
  it('§9.2 — noop on a fully-reachable graph', () => {
    const graph = graphOf(builder => {
      const ws = addPackage(builder, { name: 'app', version: '0.0.0', workspacePath: '.' })
      const a  = addPackage(builder, { name: 'a',   version: '1.0.0' })
      const b  = addPackage(builder, { name: 'b',   version: '1.0.0' })
      addEdge(builder, ws, a, 'dep')
      addEdge(builder, a,  b, 'dep')
    })

    const result = optimize(graph)
    expect(result.removed).toEqual([])
    const codes = result.unresolved.map(d => d.code)
    expect(codes).toEqual(['OPTIMIZE_NOOP'])
    // graph state preserved — every original node still present.
    expect(result.graph.getNode('app@0.0.0')).toBeDefined()
    expect(result.graph.getNode('a@1.0.0')).toBeDefined()
    expect(result.graph.getNode('b@1.0.0')).toBeDefined()
  })

  // ────────────────────────────────────────────────────────────────
  // Gate 2 — replaceVersion-style merge-branch orphan trail
  // ────────────────────────────────────────────────────────────────
  //
  // Simulate the §1.3 visible symptom: after a hypothetical
  // replaceVersion(lodash, '4.17.20', '4.17.21') merges into an existing
  // lodash@4.17.21 sibling, the old lodash@4.17.20 node remains with no
  // incoming edges (the modifier retargeted the consumer's edge to the
  // survivor before removing edges). optimize sweeps it; the survivor and
  // its transitives stay.
  it('§9.2 — replaceVersion merge-branch orphan removed; survivor intact', () => {
    const graph = graphOf(builder => {
      const ws  = addPackage(builder, { name: 'app',     version: '0.0.0', workspacePath: '.' })
      const old = addPackage(builder, { name: 'lodash',  version: '4.17.20', integrity: 'sha512-fake-old' })
      const neu = addPackage(builder, { name: 'lodash',  version: '4.17.21', integrity: 'sha512-fake-new' })
      const dep = addPackage(builder, { name: 'transitive', version: '1.0.0' })
      // Consumer was retargeted to the survivor before the orphan landed.
      addEdge(builder, ws, neu, 'dep')
      addEdge(builder, neu, dep, 'dep')
      // `old` carries zero in-edges = the merge-branch orphan trail.
      // (No edges to `old` at all — replaceVersion's merge branch leaves
      // the bare node behind.)
      void old
    })

    const result = optimize(graph)
    expect(result.removed).toContain('lodash@4.17.20')
    expect(result.graph.getNode('lodash@4.17.20')).toBeUndefined()
    expect(result.graph.tarball({ name: 'lodash', version: '4.17.20' })).toBeUndefined()
    // Survivor and its transitive both reachable from the workspace root.
    expect(result.graph.getNode('lodash@4.17.21')).toBeDefined()
    expect(result.graph.getNode('transitive@1.0.0')).toBeDefined()
  })

  // ────────────────────────────────────────────────────────────────
  // Gate 3 — removeDependency cascade
  // ────────────────────────────────────────────────────────────────
  //
  // removeDependency already runs recursive GC inline (modify/remove-
  // dependency.ts) so the post-modify graph carries no orphans. To exercise
  // the optimize path with a real cascade, we build a synthetic post-modify
  // state where a → b → c chain lost its `ws → a` edge (the modifier
  // primitive would have GC'd already; we simulate "stuck" orphans the
  // optimize phase exists to sweep).
  it('§9.2 — removeDependency-style cascade swept; content-sort emit order', () => {
    const graph = graphOf(builder => {
      const ws = addPackage(builder, { name: 'app', version: '0.0.0', workspacePath: '.' })
      const a  = addPackage(builder, { name: 'a',   version: '1.0.0' })
      const b  = addPackage(builder, { name: 'b',   version: '1.0.0' })
      const c  = addPackage(builder, { name: 'c',   version: '1.0.0' })
      // ws → a is the edge the modifier *would* have removed. We start
      // from the post-removal state: a / b / c stand without ws.
      addEdge(builder, a, b, 'dep')
      addEdge(builder, b, c, 'dep')
      void ws
    })

    const result = optimize(graph)
    expect(result.removed).toEqual(['a@1.0.0', 'b@1.0.0', 'c@1.0.0'])  // content-sort
    expect(result.graph.getNode('a@1.0.0')).toBeUndefined()
    expect(result.graph.getNode('b@1.0.0')).toBeUndefined()
    expect(result.graph.getNode('c@1.0.0')).toBeUndefined()
    // Emission order tracks content-sort iteration (§4.5 / §7 item 3).
    const removedDiags = result.unresolved.filter(d => d.code === 'OPTIMIZE_NODE_REMOVED')
    expect(removedDiags.map(d => d.subject)).toEqual(['a@1.0.0', 'b@1.0.0', 'c@1.0.0'])
  })

  // ────────────────────────────────────────────────────────────────
  // Gate 4 — Workspace preserved even when orphaned
  // ────────────────────────────────────────────────────────────────
  it('§9.2 — workspace stays even with zero incoming edges; no UNREACHABLE diagnostic', () => {
    const graph = graphOf(builder => {
      addPackage(builder, { name: 'app', version: '0.0.0', workspacePath: '.' })
      // No incoming edges — but it's a workspace, mark-phase pins it.
    })

    const result = optimize(graph)
    expect(result.removed).toEqual([])
    expect(result.graph.getNode('app@0.0.0')).toBeDefined()
    const codes = result.unresolved.map(d => d.code)
    expect(codes).not.toContain('OPTIMIZE_WORKSPACE_UNREACHABLE')  // §6 reserved — v1 never emits
    expect(codes).toEqual(['OPTIMIZE_NOOP'])
  })

  // ────────────────────────────────────────────────────────────────
  // Gate 5 — Sentinel-keyed unreachable collected normally
  // ────────────────────────────────────────────────────────────────
  //
  // ADR-0011 sentinel patches carry pure-deletion carve-out
  // (graph.ts:248-265). optimize MAY remove unreachable sentinel-keyed
  // nodes — no sentinel-specific warning, just OPTIMIZE_NODE_REMOVED.
  it('§9.2 — sentinel-keyed orphan removed without special pleading', () => {
    const sentinel = 'unresolved-deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef'
    const graph = graphOf(builder => {
      const ws = addPackage(builder, { name: 'app', version: '0.0.0', workspacePath: '.' })
      addPackage(builder, {
        name:     'leftpad',
        version:  '1.0.0',
        patch:    sentinel,
        integrity: 'sha512-sentinel-fake',
      })
      void ws
    })

    const result = optimize(graph)
    const sentinelId = `leftpad@1.0.0+patch=${sentinel}`
    expect(result.removed).toContain(sentinelId)
    expect(result.graph.getNode(sentinelId)).toBeUndefined()
    expect(result.graph.tarball({ name: 'leftpad', version: '1.0.0', patch: sentinel })).toBeUndefined()
    // No sentinel-specific code — emission is a normal NODE_REMOVED.
    const codesForSentinel = result.unresolved.filter(d => d.subject === sentinelId).map(d => d.code)
    expect(codesForSentinel).toEqual(['OPTIMIZE_NODE_REMOVED'])
  })

  // ────────────────────────────────────────────────────────────────
  // Gate 6 — preserve option pins a node
  // ────────────────────────────────────────────────────────────────
  it('§9.2 — preserve keeps a node alive even with zero incoming edges', () => {
    const graph = graphOf(builder => {
      addPackage(builder, { name: 'app',     version: '0.0.0', workspacePath: '.' })
      addPackage(builder, { name: 'pinned',  version: '1.0.0' })
      addPackage(builder, { name: 'orphan',  version: '1.0.0' })
    })

    const result = optimize(graph, { preserve: new Set(['pinned@1.0.0']) })
    expect(result.removed).toEqual(['orphan@1.0.0'])
    expect(result.graph.getNode('pinned@1.0.0')).toBeDefined()
    expect(result.graph.getNode('orphan@1.0.0')).toBeUndefined()
  })

  // ────────────────────────────────────────────────────────────────
  // Gate 7 — Idempotency
  // ────────────────────────────────────────────────────────────────
  it('§9.2 — optimize(optimize(g).graph) is a noop (idempotent)', () => {
    const graph = graphOf(builder => {
      const ws  = addPackage(builder, { name: 'app',    version: '0.0.0', workspacePath: '.' })
      const a   = addPackage(builder, { name: 'a',      version: '1.0.0' })
      const orp = addPackage(builder, { name: 'orphan', version: '1.0.0' })
      addEdge(builder, ws, a, 'dep')
      void orp
    })

    const first = optimize(graph)
    expect(first.removed).toEqual(['orphan@1.0.0'])

    const second = optimize(first.graph)
    expect(second.removed).toEqual([])
    expect(second.unresolved.map(d => d.code)).toEqual(['OPTIMIZE_NOOP'])

    // Node set byte-equal between first and second (the diagnostic list
    // grew, but the structural state is stable per §7 item 4).
    const firstIds  = Array.from(first.graph.nodes()).map(n => n.id).sort()
    const secondIds = Array.from(second.graph.nodes()).map(n => n.id).sort()
    expect(secondIds).toEqual(firstIds)
  })

  // ────────────────────────────────────────────────────────────────
  // Gate 8 — Peer-edge reachability
  // ────────────────────────────────────────────────────────────────
  it('§9.2 — node referenced only via peer edge stays live', () => {
    // peer-edge ↔ peerContext coherence (graph.ts:418-425) requires that
    // peerContext on a node list the same NodeIds as its out('peer')
    // targets. So if `consumer` has a peer edge to `peerDep`, peerDep
    // must be in consumer.peerContext.
    const graph = graphOf(builder => {
      const ws     = addPackage(builder, { name: 'app',     version: '0.0.0', workspacePath: '.' })
      const peerD  = addPackage(builder, { name: 'peerDep', version: '1.0.0' })
      const consumer = addPackage(builder, {
        name:         'consumer',
        version:      '1.0.0',
        peerContext:  ['peerDep@1.0.0'],
      })
      addEdge(builder, ws, consumer, 'dep')
      addEdge(builder, consumer, peerD, 'peer')
    })

    const result = optimize(graph)
    expect(result.removed).toEqual([])
    expect(result.graph.getNode('peerDep@1.0.0')).toBeDefined()
  })

  // ────────────────────────────────────────────────────────────────
  // Gate 9 — Determinism
  // ────────────────────────────────────────────────────────────────
  it('§9.2 — deterministic removed-set across runs (content-sort)', () => {
    const make = () => graphOf(builder => {
      const ws  = addPackage(builder, { name: 'app',    version: '0.0.0', workspacePath: '.' })
      const z   = addPackage(builder, { name: 'z',      version: '1.0.0' })
      const a   = addPackage(builder, { name: 'a',      version: '1.0.0' })
      const m   = addPackage(builder, { name: 'm',      version: '1.0.0' })
      void ws; void z; void a; void m
    })

    const r1 = optimize(make())
    const r2 = optimize(make())
    expect(r1.removed).toEqual(r2.removed)
    // Content-sort: 'a@1.0.0' < 'm@1.0.0' < 'z@1.0.0'.
    expect(r1.removed).toEqual(['a@1.0.0', 'm@1.0.0', 'z@1.0.0'])
  })

  // ────────────────────────────────────────────────────────────────
  // Dual-channel: diagnostics on Graph.diagnostics() AND unresolved
  // ────────────────────────────────────────────────────────────────
  it('§6.3 / ADR-0023 §8.6 — OPTIMIZE_* lands on Graph.diagnostics() + unresolved', () => {
    const graph = graphOf(builder => {
      addPackage(builder, { name: 'app',    version: '0.0.0', workspacePath: '.' })
      addPackage(builder, { name: 'orphan', version: '1.0.0' })
    })

    const result = optimize(graph)
    const graphCodes = result.graph.diagnostics().map(d => d.code)
    const callCodes  = result.unresolved.map(d => d.code)

    expect(callCodes).toContain('OPTIMIZE_NODE_REMOVED')
    expect(graphCodes).toContain('OPTIMIZE_NODE_REMOVED')
    // Subject coherence — both channels see the same NodeId on the event.
    const onCall  = result.unresolved.find(d => d.code === 'OPTIMIZE_NODE_REMOVED')
    const onGraph = result.graph.diagnostics().find(d => d.code === 'OPTIMIZE_NODE_REMOVED')
    expect(onCall?.subject).toBe('orphan@1.0.0')
    expect(onGraph?.subject).toBe('orphan@1.0.0')
  })

  // ────────────────────────────────────────────────────────────────
  // onDiagnostic callback streams events
  // ────────────────────────────────────────────────────────────────
  it('§3 — onDiagnostic streams each emit in order', () => {
    const graph = graphOf(builder => {
      addPackage(builder, { name: 'app',    version: '0.0.0', workspacePath: '.' })
      addPackage(builder, { name: 'orphan', version: '1.0.0' })
    })

    const observed: string[] = []
    const result = optimize(graph, { onDiagnostic: d => { observed.push(d.code) } })
    expect(observed).toEqual(result.unresolved.map(d => d.code))
    expect(observed).toContain('OPTIMIZE_NODE_REMOVED')
  })

  // ────────────────────────────────────────────────────────────────
  // Composition — modifier then optimize
  // ────────────────────────────────────────────────────────────────
  //
  // Smoke test: a removeDependency call already GCs inline (per ADR-0023
  // §3.2 / its own tests) — running optimize on the result must be a
  // strict noop, demonstrating the optimize phase composes cleanly even
  // when the modifier ran a fully-converged GC pass.
  it('composes cleanly after removeDependency (post-GC noop)', async () => {
    const graph = graphOf(builder => {
      const ws = addPackage(builder, { name: 'app', version: '0.0.0', workspacePath: '.' })
      const a  = addPackage(builder, { name: 'a',   version: '1.0.0' })
      const b  = addPackage(builder, { name: 'b',   version: '1.0.0' })
      addEdge(builder, ws, a, 'dep')
      addEdge(builder, a,  b, 'dep')
    })

    const modified = await removeDependency(graph, 'app@0.0.0', 'a')
    const optimized = optimize(modified.graph)
    expect(optimized.removed).toEqual([])  // removeDependency already swept the cascade
    expect(optimized.unresolved.map(d => d.code)).toEqual(['OPTIMIZE_NOOP'])
  })

  // ────────────────────────────────────────────────────────────────
  // Rootless guard (§4.1 edge case / §6 r3) — non-workspace graphs
  // ────────────────────────────────────────────────────────────────
  //
  // Classic lockfiles carry no `workspacePath` on any node, so the mark
  // phase seeds an EMPTY live set. Without the guard the §4.3 sweep would
  // remove every node — wiping the whole graph (adoption finding #3). With
  // it, optimize keeps all nodes and surfaces OPTIMIZE_NO_ROOTS instead.
  it('§6 r3 — rootless (classic) graph kept intact, not wiped; OPTIMIZE_NO_ROOTS', () => {
    const graph = graphOf(builder => {
      // No node carries workspacePath — the classic-lockfile shape.
      const top = addPackage(builder, { name: 'simple-git', version: '3.27.0' })
      const dep = addPackage(builder, { name: 'debug',      version: '4.3.4'  })
      const old = addPackage(builder, { name: 'simple-git', version: '3.16.0' })  // would-be orphan
      addEdge(builder, top, dep, 'dep')
      void old
    })

    const result = optimize(graph)
    // Nothing removed — the whole point of the guard.
    expect(result.removed).toEqual([])
    expect(result.graph.getNode('simple-git@3.27.0')).toBeDefined()
    expect(result.graph.getNode('debug@4.3.4')).toBeDefined()
    expect(result.graph.getNode('simple-git@3.16.0')).toBeDefined()
    // Surfaced as a per-call warning, NOT a silent noop.
    const diags = result.unresolved
    expect(diags.map(d => d.code)).toEqual(['OPTIMIZE_NO_ROOTS'])
    expect(diags[0]!.severity).toBe('warning')
    expect(diags[0]!.subject).toBe('graph')
    // Dual-channel — also lands on Graph.diagnostics() per §6.3.
    expect(result.graph.diagnostics().map(d => d.code)).toContain('OPTIMIZE_NO_ROOTS')

    // Idempotent (§7 item 4): a second pass on the unchanged graph removes
    // nothing and re-emits NO_ROOTS, not NOOP.
    const again = optimize(result.graph)
    expect(again.removed).toEqual([])
    expect(again.unresolved.map(d => d.code)).toEqual(['OPTIMIZE_NO_ROOTS'])
  })

  // A caller that DOES want orphan GC on a rootless graph passes the real
  // roots via `preserve` — the guard then stands down and the sweep runs.
  it('§6 r3 — preserve on a rootless graph re-enables the sweep', () => {
    const graph = graphOf(builder => {
      const top = addPackage(builder, { name: 'simple-git', version: '3.27.0' })
      const dep = addPackage(builder, { name: 'debug',      version: '4.3.4'  })
      const old = addPackage(builder, { name: 'simple-git', version: '3.16.0' })  // orphan
      addEdge(builder, top, dep, 'dep')
      void old
    })

    const result = optimize(graph, { preserve: new Set(['simple-git@3.27.0']) })
    // With a real root pinned, the orphaned old version is swept; the
    // reachable subtree survives.
    expect(result.removed).toEqual(['simple-git@3.16.0'])
    expect(result.graph.getNode('simple-git@3.27.0')).toBeDefined()
    expect(result.graph.getNode('debug@4.3.4')).toBeDefined()
    expect(result.graph.getNode('simple-git@3.16.0')).toBeUndefined()
  })
})
