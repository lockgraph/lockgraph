// ADR-0023 §9.2 — pinOverride acceptance gate.

import { describe, expect, it } from 'vitest'
import { frozenRegistry } from '../../main/ts/registry/frozen.ts'
import { pinOverride } from '../../main/ts/modify/pin-override.ts'
import { addEdge, addPackage, graphOf } from './_modify-test-utils.ts'

describe('modify/pinOverride', () => {
  it('happy path — pins to a specific version graph-wide', async () => {
    const graph = graphOf(builder => {
      const ws = addPackage(builder, { name: 'app', version: '0.0.0', workspacePath: '.' })
      const oldId = addPackage(builder, { name: 'axios', version: '1.5.0' })
      addPackage(builder, { name: 'axios', version: '1.6.0' })
      addEdge(builder, ws, oldId, 'dep', '^1.5.0')
    })

    const result = await pinOverride(graph, 'axios', '1.6.0', { registry: frozenRegistry(graph) })

    expect(result.replaced).toEqual([{ from: 'axios@1.5.0', to: 'axios@1.6.0' }])
    expect(result.graph.getNode('axios@1.5.0')).toBeUndefined()
    expect(result.graph.getNode('axios@1.6.0')).toBeDefined()

    const codes = result.unresolved.map(d => d.code)
    expect(codes).toContain('MODIFY_NODE_REPLACED')
    expect(codes).toContain('MODIFY_OVERRIDE_PINNED')

    const pinned = result.unresolved.find(d => d.code === 'MODIFY_OVERRIDE_PINNED')
    expect(pinned?.subject).toBe('graph')
    expect(pinned?.message).toContain('axios')
    expect(pinned?.message).toContain('1.6.0')
  })

  it('B1 — sentinel-keyed source skipped (delegates to replaceVersion sentinel guard)', async () => {
    const sentinel = 'unresolved-' + 'a'.repeat(64)
    const graph = graphOf(builder => {
      const ws = addPackage(builder, { name: 'app', version: '0.0.0', workspacePath: '.' })
      const sentinelNode = addPackage(builder, { name: 'axios', version: '1.5.0', patch: sentinel })
      addPackage(builder, { name: 'axios', version: '1.6.0' })
      addEdge(builder, ws, sentinelNode, 'dep')
    })

    const result = await pinOverride(graph, 'axios', '1.6.0', { registry: frozenRegistry(graph) })
    const codes = result.unresolved.map(d => d.code)
    expect(codes).toContain('MODIFY_SENTINEL_REFUSED')
  })

  it('emits MODIFY_OVERRIDE_PINNED once per call (even when no nodes match)', async () => {
    const graph = graphOf(builder => {
      const ws = addPackage(builder, { name: 'app', version: '0.0.0', workspacePath: '.' })
      addPackage(builder, { name: 'axios', version: '1.6.0' })
      addEdge(builder, ws, 'axios@1.6.0', 'dep')
    })

    const result = await pinOverride(graph, 'axios', '1.6.0', { registry: frozenRegistry(graph) })
    const pinned = result.unresolved.filter(d => d.code === 'MODIFY_OVERRIDE_PINNED')
    // No version mismatch → no MODIFY_NODE_REPLACED — but the pin diagnostic
    // still fires once (graph-level intent).
    expect(pinned.length).toBe(1)
  })

  // ADR-0023 §3.2 emission path / §8.6 — pinOverride records the pin on
  // Graph.diagnostics() so stringify-side adapters can project it back to a
  // PM-native override entry. ModifyResult.unresolved is the streaming hook,
  // NOT the canonical read channel.
  it('§3.2 / §8.6 — MODIFY_OVERRIDE_PINNED lands on Graph.diagnostics()', async () => {
    const graph = graphOf(builder => {
      const ws = addPackage(builder, { name: 'app', version: '0.0.0', workspacePath: '.' })
      const oldId = addPackage(builder, { name: 'axios', version: '1.5.0' })
      addPackage(builder, { name: 'axios', version: '1.6.0' })
      addEdge(builder, ws, oldId, 'dep', '^1.5.0')
    })

    const result = await pinOverride(graph, 'axios', '1.6.0', { registry: frozenRegistry(graph) })
    const graphDiags = result.graph.diagnostics()
    const pinned = graphDiags.filter(d => d.code === 'MODIFY_OVERRIDE_PINNED')
    expect(pinned).toHaveLength(1)
    expect(pinned[0]?.subject).toBe('graph')
    expect(pinned[0]?.message).toContain('axios')
    expect(pinned[0]?.message).toContain('1.6.0')
  })

  it('§8.6 — MODIFY_NODE_REPLACED also lands on Graph.diagnostics()', async () => {
    const graph = graphOf(builder => {
      const ws = addPackage(builder, { name: 'app', version: '0.0.0', workspacePath: '.' })
      const oldId = addPackage(builder, { name: 'axios', version: '1.5.0' })
      addPackage(builder, { name: 'axios', version: '1.6.0' })
      addEdge(builder, ws, oldId, 'dep', '^1.5.0')
    })

    const result = await pinOverride(graph, 'axios', '1.6.0', { registry: frozenRegistry(graph) })
    const codes = result.graph.diagnostics().map(d => d.code)
    expect(codes).toContain('MODIFY_NODE_REPLACED')
  })
})
