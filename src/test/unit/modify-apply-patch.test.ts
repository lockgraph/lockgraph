// ADR-0023 §9.2 — applyPatch acceptance gate.

import { describe, expect, it } from 'vitest'
import { applyPatch } from '../../main/ts/modify/apply-patch.ts'
import { frozenRegistry } from '../../main/ts/registry/frozen.ts'
import { canonicalHashOfBytes, sentinelHashOf } from '../../main/ts/recipe/patch.ts'
import { addEdge, addPackage, graphOf } from './_modify-test-utils.ts'

const PATCH_BYTES = '--- a/index.js\n+++ b/index.js\n@@ -1,1 +1,1 @@\n-x\n+y\n'
const EXPECTED_HASH = canonicalHashOfBytes(PATCH_BYTES)

describe('modify/applyPatch', () => {
  it('happy path — re-keys matched node with +patch slot', async () => {
    const graph = graphOf(builder => {
      const ws = addPackage(builder, { name: 'app', version: '0.0.0', workspacePath: '.' })
      const lodash = addPackage(builder, {
        name: 'lodash',
        version: '4.17.21',
        integrity: 'sha512-deadbeef',
      })
      addEdge(builder, ws, lodash, 'dep')
    })

    const result = await applyPatch(graph, { name: 'lodash' }, PATCH_BYTES, { registry: frozenRegistry(graph) })

    expect(result.patched.length).toBe(1)
    expect(result.patched[0]?.from).toBe('lodash@4.17.21')
    expect(result.patched[0]?.to).toBe(`lodash@4.17.21+patch=${EXPECTED_HASH}`)
    expect(result.graph.getNode(`lodash@4.17.21+patch=${EXPECTED_HASH}`)).toBeDefined()
    expect(result.graph.getNode('lodash@4.17.21')).toBeUndefined()

    const codes = result.unresolved.map(d => d.code)
    expect(codes).toContain('MODIFY_PATCH_APPLIED')
  })

  it('F5 normalisation — CRLF input yields the same hash as LF input', async () => {
    const graph1 = graphOf(builder => {
      const ws = addPackage(builder, { name: 'app', version: '0.0.0', workspacePath: '.' })
      const lodash = addPackage(builder, { name: 'lodash', version: '4.17.21' })
      addEdge(builder, ws, lodash, 'dep')
    })
    const graph2 = graphOf(builder => {
      const ws = addPackage(builder, { name: 'app', version: '0.0.0', workspacePath: '.' })
      const lodash = addPackage(builder, { name: 'lodash', version: '4.17.21' })
      addEdge(builder, ws, lodash, 'dep')
    })

    const lfResult   = await applyPatch(graph1, { name: 'lodash' }, PATCH_BYTES, { registry: frozenRegistry(graph1) })
    const crlfResult = await applyPatch(graph2, { name: 'lodash' }, PATCH_BYTES.replace(/\n/g, '\r\n'), { registry: frozenRegistry(graph2) })

    expect(lfResult.patched[0]?.to).toBe(crlfResult.patched[0]?.to)
  })

  it('B1 / F5 — sentinel-keyed source refused; no LockfileError escapes', async () => {
    const sentinel = sentinelHashOf('lodash@4.17.21:literal-key')
    const graph = graphOf(builder => {
      const ws = addPackage(builder, { name: 'app', version: '0.0.0', workspacePath: '.' })
      const sentLodash = addPackage(builder, {
        name: 'lodash',
        version: '4.17.21',
        patch: sentinel,
      })
      const cleanLodash = addPackage(builder, { name: 'lodash', version: '4.17.20' })
      addEdge(builder, ws, sentLodash, 'dep')
      addEdge(builder, ws, cleanLodash, 'dep')
    })

    const result = await applyPatch(graph, { name: 'lodash' }, PATCH_BYTES, { registry: frozenRegistry(graph) })
    const codes = result.unresolved.map(d => d.code)
    expect(codes).toContain('MODIFY_SENTINEL_REFUSED')
    // Clean lodash still patched.
    expect(result.patched.length).toBe(1)
    expect(result.patched[0]?.from).toBe('lodash@4.17.20')
  })

  it('async fixpoint — second invocation with same bytes is a no-op', async () => {
    const graph = graphOf(builder => {
      const ws = addPackage(builder, { name: 'app', version: '0.0.0', workspacePath: '.' })
      const lodash = addPackage(builder, { name: 'lodash', version: '4.17.21' })
      addEdge(builder, ws, lodash, 'dep')
    })

    const first = await applyPatch(graph, { name: 'lodash' }, PATCH_BYTES, { registry: frozenRegistry(graph) })
    expect(first.patched.length).toBe(1)

    const second = await applyPatch(first.graph, { name: 'lodash' }, PATCH_BYTES, { registry: frozenRegistry(first.graph) })
    // The patched node now exists with a `+patch=<hash>` slot. Selector
    // `{name:'lodash'}` matches versions across patch slots; semver range
    // is '*' default. The patched node carries patch=hash; applyPatch
    // re-derives the same hash; the would-be new id equals the existing
    // → skip path.
    expect(second.patched.length).toBe(0)
  })

  // ADR-0023 §7.4 / §9.2 — RECIPE_PATCH_NORMALISED fires once per applyPatch
  // call when F5 normalisation altered ≥ 1 byte of the patch input.
  it('§7.4 / §9.2 — emits RECIPE_PATCH_NORMALISED when CRLF input is normalised', async () => {
    const graph = graphOf(builder => {
      const ws = addPackage(builder, { name: 'app', version: '0.0.0', workspacePath: '.' })
      const lodash = addPackage(builder, { name: 'lodash', version: '4.17.21' })
      addEdge(builder, ws, lodash, 'dep')
    })

    const crlfBytes = PATCH_BYTES.replace(/\n/g, '\r\n')
    const result = await applyPatch(graph, { name: 'lodash' }, crlfBytes, { registry: frozenRegistry(graph) })

    const unresolvedCodes = result.unresolved.map(d => d.code)
    expect(unresolvedCodes).toContain('RECIPE_PATCH_NORMALISED')
    // Fires once per call.
    expect(unresolvedCodes.filter(c => c === 'RECIPE_PATCH_NORMALISED')).toHaveLength(1)

    // Also lands on Graph.diagnostics() per §8.6.
    const graphCodes = result.graph.diagnostics().map(d => d.code)
    expect(graphCodes).toContain('RECIPE_PATCH_NORMALISED')
  })

  it('§7.4 — LF-only input does NOT emit RECIPE_PATCH_NORMALISED', async () => {
    const graph = graphOf(builder => {
      const ws = addPackage(builder, { name: 'app', version: '0.0.0', workspacePath: '.' })
      const lodash = addPackage(builder, { name: 'lodash', version: '4.17.21' })
      addEdge(builder, ws, lodash, 'dep')
    })

    const result = await applyPatch(graph, { name: 'lodash' }, PATCH_BYTES, { registry: frozenRegistry(graph) })

    const codes = result.unresolved.map(d => d.code)
    expect(codes).not.toContain('RECIPE_PATCH_NORMALISED')
    const graphCodes = result.graph.diagnostics().map(d => d.code)
    expect(graphCodes).not.toContain('RECIPE_PATCH_NORMALISED')
  })

  it('§8.6 — MODIFY_PATCH_APPLIED lands on Graph.diagnostics()', async () => {
    const graph = graphOf(builder => {
      const ws = addPackage(builder, { name: 'app', version: '0.0.0', workspacePath: '.' })
      const lodash = addPackage(builder, { name: 'lodash', version: '4.17.21' })
      addEdge(builder, ws, lodash, 'dep')
    })

    const result = await applyPatch(graph, { name: 'lodash' }, PATCH_BYTES, { registry: frozenRegistry(graph) })
    const codes = result.graph.diagnostics().map(d => d.code)
    expect(codes).toContain('MODIFY_PATCH_APPLIED')
  })
})
