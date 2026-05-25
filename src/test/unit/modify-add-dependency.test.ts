// ADR-0023 §9.2 — addDependency acceptance gate.

import { describe, expect, it } from 'vitest'
import { LockfileError } from '../../main/ts/errors.ts'
import { frozenRegistry } from '../../main/ts/registry/frozen.ts'
import { addDependency } from '../../main/ts/modify/add-dependency.ts'
import { addEdge, addPackage, graphOf } from './_modify-test-utils.ts'

describe('modify/addDependency', () => {
  it('happy path — adds a fresh node when no satisfying sibling exists', async () => {
    const graph = graphOf(builder => {
      addPackage(builder, { name: 'app', version: '0.0.0', workspacePath: '.' })
    })

    const fakeRegistry = {
      async packument() { return undefined },
      async resolve(name: string, range: string) {
        if (name === 'dotenv' && range === '^16.0.0') {
          return { name: 'dotenv', version: '16.3.1' }
        }
        return undefined
      },
    }

    const result = await addDependency(
      graph,
      'app@0.0.0',
      'dotenv',
      '^16.0.0',
      'dep',
      { registry: fakeRegistry },
    )

    expect(result.added).toEqual(['dotenv@16.3.1'])
    expect(result.graph.getNode('dotenv@16.3.1')).toBeDefined()
    expect(result.graph.out('app@0.0.0').some(e => e.dst === 'dotenv@16.3.1' && e.kind === 'dep')).toBe(true)

    const codes = result.unresolved.map(d => d.code)
    expect(codes).toContain('MODIFY_NODE_ADDED')
  })

  it('reuse branch — wires to an existing satisfying sibling found via find-up', async () => {
    const graph = graphOf(builder => {
      const ws = addPackage(builder, { name: 'app', version: '0.0.0', workspacePath: '.' })
      const dotenvId = addPackage(builder, { name: 'dotenv', version: '16.3.0' })
      addEdge(builder, ws, dotenvId, 'dep')
      // Add a non-workspace child that wants dotenv@^16.0.0
      const childId = addPackage(builder, { name: 'mylib', version: '1.0.0' })
      addEdge(builder, ws, childId, 'dep')
    })

    const result = await addDependency(
      graph,
      'mylib@1.0.0',
      'dotenv',
      '^16.0.0',
      'dep',
      { registry: frozenRegistry(graph) },
    )

    expect(result.added).toEqual([])
    expect(result.graph.out('mylib@1.0.0').some(e => e.dst === 'dotenv@16.3.0' && e.kind === 'dep')).toBe(true)
    const codes = result.unresolved.map(d => d.code)
    expect(codes).toContain('MODIFY_EDGE_REWIRED')
  })

  it('B2 — peer kind throws INVALID_INPUT', async () => {
    const graph = graphOf(builder => {
      addPackage(builder, { name: 'app', version: '0.0.0', workspacePath: '.' })
    })

    await expect(
      addDependency(
        graph,
        'app@0.0.0',
        'react',
        '^18',
        'peer' as unknown as 'dep',
        { registry: frozenRegistry(graph) },
      ),
    ).rejects.toThrow(LockfileError)
  })

  it('B2 — bundled kind throws INVALID_INPUT', async () => {
    const graph = graphOf(builder => {
      addPackage(builder, { name: 'app', version: '0.0.0', workspacePath: '.' })
    })

    try {
      await addDependency(
        graph,
        'app@0.0.0',
        'tar',
        '^6',
        'bundled' as unknown as 'dep',
        { registry: frozenRegistry(graph) },
      )
      throw new Error('expected addDependency to throw')
    } catch (e) {
      expect(e).toBeInstanceOf(LockfileError)
      expect((e as LockfileError).code).toBe('INVALID_INPUT')
    }
  })

  it('MODIFY_RESOLVE_FAILED when registry cannot resolve', async () => {
    const graph = graphOf(builder => {
      addPackage(builder, { name: 'app', version: '0.0.0', workspacePath: '.' })
    })

    const result = await addDependency(
      graph,
      'app@0.0.0',
      'nonexistent',
      '^1',
      'dep',
      { registry: frozenRegistry(graph) },
    )

    expect(result.added).toEqual([])
    expect(result.unresolved.map(d => d.code)).toContain('MODIFY_RESOLVE_FAILED')
  })

  it('async fixpoint — second call is a no-op (idempotent)', async () => {
    const graph = graphOf(builder => {
      addPackage(builder, { name: 'app', version: '0.0.0', workspacePath: '.' })
    })

    const fake = {
      async packument() { return undefined },
      async resolve() { return { name: 'dotenv', version: '16.3.1' } },
    }

    const first = await addDependency(graph, 'app@0.0.0', 'dotenv', '^16', 'dep', { registry: fake })
    expect(first.added).toEqual(['dotenv@16.3.1'])

    const second = await addDependency(first.graph, 'app@0.0.0', 'dotenv', '^16', 'dep', { registry: fake })
    expect(second.added).toEqual([])
  })

  // ADR-0023 §8.6 — MODIFY_NODE_ADDED lands on Graph.diagnostics().
  it('§8.6 — MODIFY_NODE_ADDED lands on Graph.diagnostics()', async () => {
    const graph = graphOf(builder => {
      addPackage(builder, { name: 'app', version: '0.0.0', workspacePath: '.' })
    })
    const fake = {
      async packument() { return undefined },
      async resolve() { return { name: 'dotenv', version: '16.3.1' } },
    }
    const result = await addDependency(graph, 'app@0.0.0', 'dotenv', '^16', 'dep', { registry: fake })
    const codes = result.graph.diagnostics().map(d => d.code)
    expect(codes).toContain('MODIFY_NODE_ADDED')
  })
})
