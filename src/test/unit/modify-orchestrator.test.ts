// ADR-0023 §8.2 — `modify()` orchestrator + ModifyResult discriminated union.
//
// Smoke-tests that `modify(graph, primitive, opts)` dispatches on
// `primitive.kind` to the per-primitive impl and that the returned
// ModifyResult carries the matching `kind` discriminator for downstream
// type narrowing.

import { describe, expect, it } from 'vitest'
import { modify } from '../../main/ts/modify/modify.ts'
import { frozenRegistry } from '../../main/ts/registry/frozen.ts'
import type { ModifyContext } from '../../main/ts/modify/context.ts'
import { addEdge, addPackage, graphOf } from './_modify-test-utils.ts'

function ctxFrom(graph: ReturnType<typeof graphOf>): ModifyContext {
  return { registry: frozenRegistry(graph) }
}

describe('modify() orchestrator — §8.2 single dispatch entry', () => {
  it('dispatches replaceVersion and carries kind discriminator', async () => {
    const graph = graphOf(builder => {
      const ws = addPackage(builder, { name: 'app', version: '0.0.0', workspacePath: '.' })
      addPackage(builder, { name: 'lodash', version: '4.17.20' })
      addPackage(builder, { name: 'lodash', version: '4.17.21' })
      addEdge(builder, ws, 'lodash@4.17.20', 'dep')
    })

    const result = await modify(
      graph,
      { kind: 'replaceVersion', selector: { name: 'lodash' }, toRange: '4.17.21' },
      { context: ctxFrom(graph) },
    )
    expect(result.kind).toBe('replaceVersion')
    if (result.kind === 'replaceVersion') {
      // Narrowed — primitive-specific fields visible
      expect(Array.isArray(result.replaced)).toBe(true)
    }
  })

  it('dispatches pinOverride and carries kind discriminator', async () => {
    const graph = graphOf(builder => {
      const ws = addPackage(builder, { name: 'app', version: '0.0.0', workspacePath: '.' })
      addPackage(builder, { name: 'lodash', version: '4.17.20' })
      addPackage(builder, { name: 'lodash', version: '4.17.21' })
      addEdge(builder, ws, 'lodash@4.17.20', 'dep')
    })

    const result = await modify(
      graph,
      { kind: 'pinOverride', name: 'lodash', range: '4.17.21' },
      { context: ctxFrom(graph) },
    )
    expect(result.kind).toBe('pinOverride')
  })

  it('dispatches addDependency and carries kind discriminator', async () => {
    const graph = graphOf(builder => {
      const ws = addPackage(builder, { name: 'app', version: '0.0.0', workspacePath: '.' })
      addPackage(builder, { name: 'lodash', version: '4.17.21' })
    })

    const result = await modify(
      graph,
      {
        kind:     'addDependency',
        parentId: 'app@0.0.0',
        name:     'lodash',
        range:    '4.17.21',
        depKind:  'dep',
      },
      { context: ctxFrom(graph) },
    )
    expect(result.kind).toBe('addDependency')
  })

  it('dispatches removeDependency and carries kind discriminator', async () => {
    const graph = graphOf(builder => {
      const ws = addPackage(builder, { name: 'app', version: '0.0.0', workspacePath: '.' })
      addPackage(builder, { name: 'lodash', version: '4.17.21' })
      addEdge(builder, ws, 'lodash@4.17.21', 'dep')
    })

    const result = await modify(graph, {
      kind:     'removeDependency',
      parentId: 'app@0.0.0',
      name:     'lodash',
    })
    expect(result.kind).toBe('removeDependency')
  })

  it('dispatches filterLicense and carries kind discriminator', async () => {
    const graph = graphOf(builder => {
      const ws = addPackage(builder, { name: 'app', version: '0.0.0', workspacePath: '.' })
      addPackage(builder, { name: 'mit-lib', version: '1.0.0', license: 'MIT' })
      addEdge(builder, ws, 'mit-lib@1.0.0', 'dep')
    })

    const result = await modify(graph, {
      kind:  'filterLicense',
      allow: ['MIT'],
      mode:  'diagnostic-only',
    })
    expect(result.kind).toBe('filterLicense')
  })

  it('ModifyResult union narrows by kind — type-level discrimination', async () => {
    // This is primarily a compile-time check; at runtime we just verify
    // that the per-kind branches are reachable without TS gymnastics.
    const graph = graphOf(builder => {
      const ws = addPackage(builder, { name: 'app', version: '0.0.0', workspacePath: '.' })
      addPackage(builder, { name: 'lodash', version: '4.17.21' })
      addEdge(builder, ws, 'lodash@4.17.21', 'dep')
    })

    const result = await modify(graph, {
      kind:     'removeDependency',
      parentId: 'app@0.0.0',
      name:     'lodash',
    })

    // Every variant shares the §7.5 base fields.
    expect(result.unresolved).toBeInstanceOf(Array)
    expect(result.recentlyAdded).toBeInstanceOf(Set)
    expect(result.recentlyOrphaned).toBeInstanceOf(Set)
    expect(result.graph).toBeDefined()
  })
})
