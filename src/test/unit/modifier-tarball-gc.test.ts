import { describe, expect, it } from 'vitest'
import { stringify } from '../../main/ts/index.ts'
import { applyPatch } from '../../main/ts/modify/apply-patch.ts'
import { filterLicense } from '../../main/ts/modify/filter-license.ts'
import { pinOverride } from '../../main/ts/modify/pin-override.ts'
import { removeDependency } from '../../main/ts/modify/remove-dependency.ts'
import { replaceVersion } from '../../main/ts/modify/replace-version.ts'
import { frozenRegistry } from '../../main/ts/registry/frozen.ts'
import { canonicalHashOfBytes } from '../../main/ts/recipe/patch.ts'
import { addEdge, addPackage, graphOf } from './_modify-test-utils.ts'

const SRI =
  'sha512-6FlzubTLZG3J2a/NVCAleEhjzq5oxgHyaCU9yYXvcLsvoVaHJq/s5xXI6/XXP6tz7R9xAOtHnSO/tXtF3WRTlA=='
const PATCH = '--- a/index.js\n+++ b/index.js\n@@ -1 +1 @@\n-old\n+new\n'

function tarballKeys(graph: ReturnType<typeof graphOf>): string[] {
  return [...graph.tarballs()].map(([key]) => key)
}

function expectStrictPnpm(graph: ReturnType<typeof graphOf>): void {
  expect(() => stringify('pnpm-v9', graph)).not.toThrow()
}

describe('modifier orphan tarball GC', () => {
  it('removeDependency prunes the payload of its last live node', async () => {
    const graph = graphOf(builder => {
      const root = addPackage(builder, { name: '.', version: '0.0.0', workspacePath: '' })
      const dep = addPackage(builder, { name: 'dep', version: '1.0.0', integrity: SRI })
      addEdge(builder, root, dep, 'dep', '1.0.0')
    })

    const result = await removeDependency(graph, '.@0.0.0', 'dep')
    expect(tarballKeys(result.graph)).not.toContain('dep@1.0.0')
    expectStrictPnpm(result.graph)
  })

  it('replaceVersion prunes the old key after a merge into an existing target', async () => {
    const graph = graphOf(builder => {
      const root = addPackage(builder, { name: '.', version: '0.0.0', workspacePath: '' })
      const old = addPackage(builder, {
        name: 'dep', version: '1.0.0',
        tarball: 'https://cdn.example.test/dep-1.0.0.tgz',
      })
      addPackage(builder, {
        name: 'dep', version: '1.1.0',
        tarball: 'https://cdn.example.test/dep-1.1.0.tgz',
      })
      addEdge(builder, root, old, 'dep', '^1.0.0')
    })

    const result = await replaceVersion(
      graph,
      { name: 'dep', fromRange: '1.0.0' },
      '1.1.0',
      { registry: frozenRegistry(graph) },
    )
    expect(tarballKeys(result.graph)).not.toContain('dep@1.0.0')
    expect(tarballKeys(result.graph)).toContain('dep@1.1.0')
    expectStrictPnpm(result.graph)
  })

  it('applyPatch moves the payload instead of retaining the unpatched key', async () => {
    const graph = graphOf(builder => {
      const root = addPackage(builder, { name: '.', version: '0.0.0', workspacePath: '' })
      const dep = addPackage(builder, {
        name: 'dep', version: '1.0.0',
        tarball: 'https://cdn.example.test/dep-1.0.0.tgz',
      })
      addEdge(builder, root, dep, 'dep', '1.0.0')
    })

    const result = await applyPatch(
      graph,
      { name: 'dep' },
      PATCH,
      { registry: frozenRegistry(graph) },
    )
    const patchedKey = `dep@1.0.0+patch=${canonicalHashOfBytes(PATCH)}`
    expect(tarballKeys(result.graph)).not.toContain('dep@1.0.0')
    expect(tarballKeys(result.graph)).toContain(patchedKey)
    // pnpm cannot reconstruct arbitrary patch bytes from a synthesized path;
    // use the lossless lockgraph adapter for this modifier's strict-validity gate.
    expect(() => stringify('lockgraph', result.graph)).not.toThrow()
  })

  it('filterLicense prunes payloads swept by strict recursive GC', async () => {
    const graph = graphOf(builder => {
      const root = addPackage(builder, { name: '.', version: '0.0.0', workspacePath: '' })
      const bridge = addPackage(builder, { name: 'bridge', version: '1.0.0' })
      const bad = addPackage(builder, {
        name: 'bad',
        version: '1.0.0',
        integrity: SRI,
        license: 'GPL-3.0',
      })
      addEdge(builder, root, bridge, 'dep', '1.0.0')
      addEdge(builder, bridge, bad, 'dep', '1.0.0')
    })

    const result = await filterLicense(graph, { deny: ['GPL-3.0'], mode: 'strict' })
    expect(tarballKeys(result.graph)).not.toContain('bad@1.0.0')
    expectStrictPnpm(result.graph)
  })

  it('pinOverride inherits replaceVersion tarball cleanup', async () => {
    const graph = graphOf(builder => {
      const root = addPackage(builder, { name: '.', version: '0.0.0', workspacePath: '' })
      const old = addPackage(builder, {
        name: 'dep', version: '1.0.0',
        tarball: 'https://cdn.example.test/dep-1.0.0.tgz',
      })
      addPackage(builder, {
        name: 'dep', version: '1.1.0',
        tarball: 'https://cdn.example.test/dep-1.1.0.tgz',
      })
      addEdge(builder, root, old, 'dep', '^1.0.0')
    })

    const result = await pinOverride(graph, 'dep', '1.1.0', { registry: frozenRegistry(graph) })
    expect(tarballKeys(result.graph)).not.toContain('dep@1.0.0')
    expect(tarballKeys(result.graph)).toContain('dep@1.1.0')
    expectStrictPnpm(result.graph)
  })

  it('preserves a shared payload while another peer-virtual sibling is live', async () => {
    const graph = graphOf(builder => {
      const appA = addPackage(builder, { name: 'app-a', version: '0.0.0', workspacePath: 'apps/a' })
      const appB = addPackage(builder, { name: 'app-b', version: '0.0.0', workspacePath: 'apps/b' })
      const react17 = addPackage(builder, { name: 'react', version: '17.0.0' })
      const react18 = addPackage(builder, { name: 'react', version: '18.0.0' })
      const dep17 = addPackage(builder, {
        name: 'dep', version: '1.0.0', peerContext: [react17], integrity: SRI,
      })
      const dep18 = addPackage(builder, {
        name: 'dep', version: '1.0.0', peerContext: [react18], integrity: SRI,
      })
      addEdge(builder, appA, dep17, 'dep', '1.0.0')
      addEdge(builder, appB, dep18, 'dep', '1.0.0')
      addEdge(builder, dep17, react17, 'peer', '^17.0.0')
      addEdge(builder, dep18, react18, 'peer', '^18.0.0')
    })

    const result = await removeDependency(graph, 'app-a@0.0.0', 'dep')
    expect(result.graph.getNode('dep@1.0.0(react@17.0.0)')).toBeUndefined()
    expect(result.graph.getNode('dep@1.0.0(react@18.0.0)')).toBeDefined()
    expect(tarballKeys(result.graph)).toContain('dep@1.0.0')
  })
})
