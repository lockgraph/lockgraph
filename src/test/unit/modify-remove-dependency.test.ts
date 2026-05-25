// ADR-0023 §9.2 — removeDependency acceptance gate.

import { describe, expect, it } from 'vitest'
import { frozenRegistry } from '../../main/ts/registry/frozen.ts'
import { removeDependency } from '../../main/ts/modify/remove-dependency.ts'
import { addEdge, addPackage, graphOf } from './_modify-test-utils.ts'

describe('modify/removeDependency', () => {
  it('happy path — removes a single edge', async () => {
    const graph = graphOf(builder => {
      const ws = addPackage(builder, { name: 'app', version: '0.0.0', workspacePath: '.' })
      const dot = addPackage(builder, { name: 'dotenv', version: '16.3.0' })
      addEdge(builder, ws, dot, 'dep')
    })

    const result = await removeDependency(graph, 'app@0.0.0', 'dotenv')

    expect(result.graph.out('app@0.0.0').some(e => e.dst === 'dotenv@16.3.0')).toBe(false)
    // Orphan GC: dotenv had no other parents → removed.
    expect(result.removed).toContain('dotenv@16.3.0')
    expect(result.graph.getNode('dotenv@16.3.0')).toBeUndefined()
  })

  it('recursive GC sweeps transitive orphans', async () => {
    const graph = graphOf(builder => {
      const ws = addPackage(builder, { name: 'app', version: '0.0.0', workspacePath: '.' })
      const a = addPackage(builder, { name: 'a', version: '1.0.0' })
      const b = addPackage(builder, { name: 'b', version: '1.0.0' })
      const c = addPackage(builder, { name: 'c', version: '1.0.0' })
      addEdge(builder, ws, a, 'dep')
      addEdge(builder, a, b, 'dep')
      addEdge(builder, b, c, 'dep')
    })

    const result = await removeDependency(graph, 'app@0.0.0', 'a')

    expect(result.removed).toEqual(expect.arrayContaining(['a@1.0.0', 'b@1.0.0', 'c@1.0.0']))
    expect(result.graph.getNode('a@1.0.0')).toBeUndefined()
    expect(result.graph.getNode('b@1.0.0')).toBeUndefined()
    expect(result.graph.getNode('c@1.0.0')).toBeUndefined()
  })

  it('keeps a transitive that has another parent', async () => {
    const graph = graphOf(builder => {
      const ws = addPackage(builder, { name: 'app', version: '0.0.0', workspacePath: '.' })
      const a = addPackage(builder, { name: 'a', version: '1.0.0' })
      const b = addPackage(builder, { name: 'b', version: '1.0.0' })
      const c = addPackage(builder, { name: 'c', version: '1.0.0' })
      addEdge(builder, ws, a, 'dep')
      addEdge(builder, ws, b, 'dep')
      addEdge(builder, a, c, 'dep')
      addEdge(builder, b, c, 'dep')
    })

    const result = await removeDependency(graph, 'app@0.0.0', 'a')

    expect(result.removed).toContain('a@1.0.0')
    expect(result.removed).not.toContain('c@1.0.0')   // still pulled by b
    expect(result.graph.getNode('c@1.0.0')).toBeDefined()
  })

  it('workspace nodes are never GC-ed even if orphaned', async () => {
    const graph = graphOf(builder => {
      const root = addPackage(builder, { name: 'root', version: '0.0.0', workspacePath: '.' })
      const wsChild = addPackage(builder, { name: 'app', version: '0.0.0', workspacePath: 'packages/app' })
      addEdge(builder, root, wsChild, 'dep')
    })

    const result = await removeDependency(graph, 'root@0.0.0', 'app')
    // Workspace child loses incoming edge but must NOT be removed.
    expect(result.removed).not.toContain('app@0.0.0')
    expect(result.graph.getNode('app@0.0.0')).toBeDefined()
  })

  it('idempotent — second call is a no-op', async () => {
    const graph = graphOf(builder => {
      const ws = addPackage(builder, { name: 'app', version: '0.0.0', workspacePath: '.' })
      const a = addPackage(builder, { name: 'a', version: '1.0.0' })
      addEdge(builder, ws, a, 'dep')
    })

    const first = await removeDependency(graph, 'app@0.0.0', 'a')
    expect(first.removed.length).toBeGreaterThan(0)

    const second = await removeDependency(first.graph, 'app@0.0.0', 'a')
    expect(second.removed).toEqual([])
  })

  // ADR-0023 §8.6 — MODIFY_NODE_REMOVED lands on Graph.diagnostics().
  it('§8.6 — MODIFY_NODE_REMOVED lands on Graph.diagnostics()', async () => {
    const graph = graphOf(builder => {
      const ws = addPackage(builder, { name: 'app', version: '0.0.0', workspacePath: '.' })
      const a = addPackage(builder, { name: 'a', version: '1.0.0' })
      addEdge(builder, ws, a, 'dep')
    })

    const result = await removeDependency(graph, 'app@0.0.0', 'a')
    const codes = result.graph.diagnostics().map(d => d.code)
    expect(codes).toContain('MODIFY_NODE_REMOVED')
  })
})
