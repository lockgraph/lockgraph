// ADR-0023 §9.2 — filterLicense acceptance gate.

import { describe, expect, it } from 'vitest'
import { filterLicense } from '../../main/ts/modify/filter-license.ts'
import { addEdge, addPackage, graphOf } from './_modify-test-utils.ts'

describe('modify/filterLicense', () => {
  it('diagnostic-only mode — flags deny-list licenses without removing nodes', async () => {
    const graph = graphOf(builder => {
      const ws = addPackage(builder, { name: 'app', version: '0.0.0', workspacePath: '.' })
      const ok = addPackage(builder, { name: 'a', version: '1.0.0', license: 'MIT' })
      const bad = addPackage(builder, { name: 'b', version: '1.0.0', license: 'GPL-3.0' })
      addEdge(builder, ws, ok, 'dep')
      addEdge(builder, ws, bad, 'dep')
    })

    const result = await filterLicense(graph, { deny: ['GPL-3.0'] })

    expect(result.flagged).toEqual(['b@1.0.0'])
    expect(result.removed).toEqual([])
    expect(result.graph.getNode('b@1.0.0')).toBeDefined()
    const codes = result.unresolved.map(d => d.code)
    expect(codes).toContain('MODIFY_LICENSE_FLAGGED')
    expect(codes).not.toContain('MODIFY_LICENSE_BLOCKED')
  })

  it('strict mode — removes nodes with disallowed licenses', async () => {
    const graph = graphOf(builder => {
      const ws = addPackage(builder, { name: 'app', version: '0.0.0', workspacePath: '.' })
      const ok = addPackage(builder, { name: 'a', version: '1.0.0', license: 'MIT' })
      const bad = addPackage(builder, { name: 'b', version: '1.0.0', license: 'GPL-3.0' })
      // bad is a non-workspace-rooted transitive of `ok` (so workspace block doesn't fire).
      addEdge(builder, ws, ok, 'dep')
      addEdge(builder, ok, bad, 'dep')
    })

    const result = await filterLicense(graph, { deny: ['GPL-3.0'], mode: 'strict' })

    expect(result.flagged).toEqual(['b@1.0.0'])
    expect(result.removed).toContain('b@1.0.0')
    expect(result.graph.getNode('b@1.0.0')).toBeUndefined()
  })

  it('strict mode — emits MODIFY_LICENSE_BLOCKED when removal would unwire a workspace dep', async () => {
    const graph = graphOf(builder => {
      const ws = addPackage(builder, { name: 'app', version: '0.0.0', workspacePath: '.' })
      const bad = addPackage(builder, { name: 'b', version: '1.0.0', license: 'GPL-3.0' })
      addEdge(builder, ws, bad, 'dep')
    })

    const result = await filterLicense(graph, { deny: ['GPL-3.0'], mode: 'strict' })

    const codes = result.unresolved.map(d => d.code)
    expect(codes).toContain('MODIFY_LICENSE_BLOCKED')
    // F2 — blocking is warning severity, NOT error. Modifier doesn't throw.
    const blocked = result.unresolved.find(d => d.code === 'MODIFY_LICENSE_BLOCKED')
    expect(blocked?.severity).toBe('warning')
    // Node is NOT removed — workspace declared it.
    expect(result.graph.getNode('b@1.0.0')).toBeDefined()
  })

  it('allow-list — flags everything not in allow set', async () => {
    const graph = graphOf(builder => {
      const ws = addPackage(builder, { name: 'app', version: '0.0.0', workspacePath: '.' })
      const ok = addPackage(builder, { name: 'a', version: '1.0.0', license: 'MIT' })
      const bsd = addPackage(builder, { name: 'b', version: '1.0.0', license: 'BSD-3-Clause' })
      addEdge(builder, ws, ok, 'dep')
      addEdge(builder, ws, bsd, 'dep')
    })

    const result = await filterLicense(graph, { allow: ['MIT'] })
    expect(result.flagged).toEqual(['b@1.0.0'])
  })

  it('no predicates → no work', async () => {
    const graph = graphOf(builder => {
      addPackage(builder, { name: 'a', version: '1.0.0', license: 'MIT' })
    })
    const result = await filterLicense(graph, {})
    expect(result.flagged).toEqual([])
    expect(result.unresolved).toEqual([])
  })

  // ADR-0023 §8.6 — MODIFY_LICENSE_* lands on Graph.diagnostics().
  it('§8.6 — MODIFY_LICENSE_FLAGGED lands on Graph.diagnostics()', async () => {
    const graph = graphOf(builder => {
      const ws = addPackage(builder, { name: 'app', version: '0.0.0', workspacePath: '.' })
      const bad = addPackage(builder, { name: 'b', version: '1.0.0', license: 'GPL-3.0' })
      addEdge(builder, ws, bad, 'dep')
    })
    const result = await filterLicense(graph, { deny: ['GPL-3.0'] })
    const codes = result.graph.diagnostics().map(d => d.code)
    expect(codes).toContain('MODIFY_LICENSE_FLAGGED')
  })

  it('§8.6 — MODIFY_LICENSE_BLOCKED lands on Graph.diagnostics() in strict mode', async () => {
    const graph = graphOf(builder => {
      const ws = addPackage(builder, { name: 'app', version: '0.0.0', workspacePath: '.' })
      const bad = addPackage(builder, { name: 'b', version: '1.0.0', license: 'GPL-3.0' })
      addEdge(builder, ws, bad, 'dep')
    })
    const result = await filterLicense(graph, { deny: ['GPL-3.0'], mode: 'strict' })
    const codes = result.graph.diagnostics().map(d => d.code)
    expect(codes).toContain('MODIFY_LICENSE_BLOCKED')
  })
})
