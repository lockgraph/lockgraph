import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseV9, stringify as stringifyV9, optimize as optimizeV9 } from '../../main/ts/formats/pnpm-v9.ts'
import { parse as parseV6, stringify as stringifyV6 } from '../../main/ts/formats/pnpm-v6.ts'
import { stringify as stringifyNpm3 } from '../../main/ts/formats/npm-3.ts'
import { GraphError, newBuilder, toTarballKey, type Diagnostic } from '../../main/ts/graph.ts'
import {
  resolvePnpmWorkspacePeerProjection,
  stringifyFamily,
} from '../../main/ts/formats/_pnpm-flat-core.ts'
import { internalEvidenceOf } from '../../main/ts/completeness/evidence.ts'
import {
  evidenceOf,
  parse,
  stringifyAssessed,
  withEvidence,
} from '../../main/ts/index.ts'

// A workspace package satisfying a peer requirement is a `peer` edge into the workspace
// node; the peerContext carries the workspace node id and emit reconstructs the native
// `name@packages+dir` locator from sidecar attribution.

// importer `packages/host` publishes `@scope/host`; registry `dep` peers on it.
const WS_PEER =
  `lockfileVersion: '9.0'\n\n` +
  `importers:\n\n` +
  `  .:\n    dependencies:\n      dep:\n        specifier: 1.0.0\n        version: 1.0.0(@scope/host@packages+host)\n` +
  `  packages/host:\n    dependencies:\n      dep:\n        specifier: 1.0.0\n        version: 1.0.0(@scope/host@packages+host)\n\n` +
  `packages:\n\n` +
  `  dep@1.0.0:\n    resolution: {integrity: sha512-x}\n    peerDependencies:\n      '@scope/host': '*'\n\n` +
  `snapshots:\n\n` +
  `  dep@1.0.0(@scope/host@packages+host):\n    dependencies:\n      '@scope/host': link:packages/host\n`

const STATE3 =
  `lockfileVersion: '9.0'\n\n` +
  `importers:\n\n` +
  `  .:\n    dependencies:\n` +
  `      consumer:\n        specifier: 1.0.0\n        version: 1.0.0(mid@1.0.0(@scope/host@packages+host))\n` +
  `      consumer-alias:\n        specifier: npm:consumer@1.0.0\n        version: consumer@1.0.0(mid@1.0.0(@scope/host@packages+host))\n` +
  `  packages/host:\n    dependencies: {}\n\n` +
  `packages:\n\n` +
  `  consumer@1.0.0:\n    resolution: {integrity: sha512-6FlzubTLZG3J2a/NVCAleEhjzq5oxgHyaCU9yYXvcLsvoVaHJq/s5xXI6/XXP6tz7R9xAOtHnSO/tXtF3WRTlA==}\n    peerDependencies:\n      mid: '*'\n` +
  `  mid@1.0.0:\n    resolution: {integrity: sha512-v2kDEe57lecTulaDIuNTPy3Ry4gLGJ6Z1O3vE1krgXZNrsQ+LFTGHVxVjcXPs17LhbZVGedAJv8XZ1tvj5FvSg==}\n    peerDependencies:\n      '@scope/host': '*'\n\n` +
  `snapshots:\n\n` +
  `  mid@1.0.0(@scope/host@packages+host):\n    dependencies:\n      '@scope/host': link:packages/host\n` +
  `  consumer@1.0.0(mid@1.0.0(@scope/host@packages+host)):\n    dependencies:\n      mid: 1.0.0(@scope/host@packages+host)\n`

describe('workspace-peer round-trip', () => {
  it('reconstructs the native locator at emit; the canonical id never leaks', () => {
    const out = stringifyV9(parseV9(WS_PEER))
    expect(out).toContain('dep@1.0.0(@scope/host@packages+host)')
    expect(out).not.toContain('packages/host@0.0.0')
  })

  it('is idempotent', () => {
    const once = stringifyV9(parseV9(WS_PEER))
    expect(stringifyV9(parseV9(once))).toBe(once)
  })
})

describe('workspace preserved through optimize', () => {
  it('keeps the importer and its incoming peer edge', () => {
    const g = optimizeV9(parseV9(WS_PEER)).graph
    expect(new Set([...g.nodes()].map(n => n.id)).has('packages/host@0.0.0')).toBe(true)
    const peerIntoWs = [...g.nodes()].some(n =>
      [...g.out(n.id)].some(e => e.kind === 'peer' && e.dst === 'packages/host@0.0.0'),
    )
    expect(peerIntoWs).toBe(true)
    expect(stringifyV9(g)).toContain('@scope/host@packages+host')
  })

  it('anchors a workspace reachable only via an unreachable consumer cycle', () => {
    // ghostA <-> ghostB is an unreachable cycle (neither is in-degree-0); ghostB owns the
    // only inbound to the workspace. Optimization seeds workspace nodes, so the workspace
    // survives while the cycle is collected.
    const b = newBuilder()
    b.addNode({ id: '.@0.0.0', name: '.', version: '0.0.0', peerContext: [], workspacePath: '' })
    b.addNode({ id: 'packages/host@0.0.0', name: 'packages/host', version: '0.0.0', peerContext: [], workspacePath: 'packages/host' })
    b.addNode({ id: 'ghostA@1.0.0', name: 'ghostA', version: '1.0.0', peerContext: [] })
    b.addNode({ id: 'ghostB@1.0.0(packages/host@0.0.0)', name: 'ghostB', version: '1.0.0', peerContext: ['packages/host@0.0.0'] })
    b.addEdge('ghostA@1.0.0', 'ghostB@1.0.0(packages/host@0.0.0)', 'dep', { range: '1.0.0' })
    b.addEdge('ghostB@1.0.0(packages/host@0.0.0)', 'ghostA@1.0.0', 'dep', { range: '1.0.0' })
    b.addEdge('ghostB@1.0.0(packages/host@0.0.0)', 'packages/host@0.0.0', 'peer', { range: '*' })
    const { graph } = optimizeV9(b.seal())
    expect(graph.getNode('packages/host@0.0.0')).toBeDefined()
    expect(graph.getNode('ghostA@1.0.0')).toBeUndefined()
    expect(graph.getNode('ghostB@1.0.0(packages/host@0.0.0)')).toBeUndefined()
  })

  it('preserves a workspace -> dep -> peer -> same-workspace cycle', () => {
    const b = newBuilder()
    b.addNode({ id: '.@0.0.0', name: '.', version: '0.0.0', peerContext: [], workspacePath: '' })
    b.addNode({ id: 'packages/host@0.0.0', name: 'packages/host', version: '0.0.0', peerContext: [], workspacePath: 'packages/host' })
    b.addNode({ id: 'dep@1.0.0(packages/host@0.0.0)', name: 'dep', version: '1.0.0', peerContext: ['packages/host@0.0.0'] })
    b.addEdge('packages/host@0.0.0', 'dep@1.0.0(packages/host@0.0.0)', 'dep', { range: '1.0.0' })
    b.addEdge('dep@1.0.0(packages/host@0.0.0)', 'packages/host@0.0.0', 'peer', { range: '*' })
    const { graph } = optimizeV9(b.seal())
    expect(graph.getNode('packages/host@0.0.0')).toBeDefined()
    expect(graph.getNode('dep@1.0.0(packages/host@0.0.0)')).toBeDefined()
  })
})

describe('seal — incoming edges into a workspace node', () => {
  const ws = { id: 'packages/host@0.0.0', name: 'packages/host', version: '0.0.0', peerContext: [] as string[], workspacePath: 'packages/host' }

  it('rejects non-peer edges from a non-workspace node', () => {
    // Non-registry range so the published-self-link carve-out (registry ranges only) does
    // not apply; only a `peer` edge into a workspace is permitted.
    for (const kind of ['dep', 'dev', 'optional', 'bundled'] as const) {
      const b = newBuilder()
      b.addNode({ ...ws, peerContext: [] })
      b.addNode({ id: 'consumer@1.0.0', name: 'consumer', version: '1.0.0', peerContext: [] })
      b.addEdge('consumer@1.0.0', 'packages/host@0.0.0', kind, { range: 'file:./host' })
      expect(() => b.seal(), `${kind} into workspace must reject`).toThrow(GraphError)
    }
  })

  it('permits a peer edge whose peerContext token matches the target', () => {
    const b = newBuilder()
    b.addNode({ ...ws, peerContext: [] })
    b.addNode({ id: 'consumer@1.0.0(packages/host@0.0.0)', name: 'consumer', version: '1.0.0', peerContext: ['packages/host@0.0.0'] })
    b.addEdge('consumer@1.0.0(packages/host@0.0.0)', 'packages/host@0.0.0', 'peer', { range: '*' })
    expect(() => b.seal()).not.toThrow()
  })
})

describe('distinct workspace instances stay distinct', () => {
  it('two importers publishing the same name get distinct tokens and locators', () => {
    const lock =
      `lockfileVersion: '9.0'\n\n` +
      `importers:\n\n` +
      `  .:\n    dependencies:\n      a:\n        specifier: 1.0.0\n        version: 1.0.0(@scope/dup@packages+a)\n` +
      `      b:\n        specifier: 1.0.0\n        version: 1.0.0(@scope/dup@packages+b)\n` +
      `  packages/a:\n    dependencies: {}\n  packages/b:\n    dependencies: {}\n\n` +
      `packages:\n\n  a@1.0.0:\n    resolution: {integrity: sha512-a}\n    peerDependencies:\n      '@scope/dup': '*'\n` +
      `  b@1.0.0:\n    resolution: {integrity: sha512-b}\n    peerDependencies:\n      '@scope/dup': '*'\n\n` +
      `snapshots:\n\n` +
      `  a@1.0.0(@scope/dup@packages+a):\n    dependencies:\n      '@scope/dup': link:packages/a\n` +
      `  b@1.0.0(@scope/dup@packages+b):\n    dependencies:\n      '@scope/dup': link:packages/b\n`
    const g = parseV9(lock)
    const tokens = [...g.nodes()].flatMap(n => n.peerContext).filter(p => p.startsWith('packages/'))
    expect(new Set(tokens).size).toBe(2)
    expect(tokens).toContain('packages/a@0.0.0')
    expect(tokens).toContain('packages/b@0.0.0')
    const out = stringifyV9(g)
    expect(out).toContain('@scope/dup@packages+a')
    expect(out).toContain('@scope/dup@packages+b')
  })

  it('keeps distinct sub-dir locators per owner (packages+lib vs packages+lib+build)', () => {
    // Both locators walk to the same ancestor importer; per-owner attribution keeps each
    // consumer's original locator instead of last-write-wins.
    const lock =
      `lockfileVersion: '9.0'\n\n` +
      `importers:\n\n` +
      `  .:\n    dependencies:\n` +
      `      depa:\n        specifier: 1.0.0\n        version: 1.0.0(@x/lib@packages+lib)\n` +
      `      depb:\n        specifier: 1.0.0\n        version: 1.0.0(@x/y@packages+lib+build)\n` +
      `  packages/lib:\n    dependencies: {}\n\n` +
      `packages:\n\n` +
      `  depa@1.0.0:\n    resolution: {integrity: sha512-a}\n    peerDependencies:\n      '@x/lib': '*'\n` +
      `  depb@1.0.0:\n    resolution: {integrity: sha512-b}\n    peerDependencies:\n      '@x/y': '*'\n\n` +
      `snapshots:\n\n` +
      `  depa@1.0.0(@x/lib@packages+lib):\n    dependencies:\n      '@x/lib': link:packages/lib\n` +
      `  depb@1.0.0(@x/y@packages+lib+build):\n    dependencies:\n      '@x/y': link:packages/lib/build\n`
    const out = stringifyV9(parseV9(lock))
    expect(out).toContain('depa@1.0.0(@x/lib@packages+lib)')
    expect(out).toContain('depb@1.0.0(@x/y@packages+lib+build)')
  })
})

describe('registry semver build-metadata is not a workspace locator', () => {
  it('leaves foo@1.0.0+build an ordinary registry peer', () => {
    const lock =
      `lockfileVersion: '9.0'\n\n` +
      `importers:\n\n  .:\n    dependencies:\n      dep:\n        specifier: 1.0.0\n        version: 1.0.0(foo@1.0.0+build)\n\n` +
      `packages:\n\n  dep@1.0.0:\n    resolution: {integrity: sha512-x}\n    peerDependencies:\n      foo: '*'\n` +
      `  foo@1.0.0+build:\n    resolution: {integrity: sha512-f}\n\n` +
      `snapshots:\n\n  foo@1.0.0+build: {}\n  dep@1.0.0(foo@1.0.0+build):\n    dependencies:\n      foo: 1.0.0+build\n`
    const out = stringifyV9(parseV9(lock))
    expect(out).toContain('dep@1.0.0(foo@1.0.0+build)')
    expect([...parseV9(lock).nodes()].some(n => n.name === 'foo' && n.workspacePath === undefined)).toBe(true)
  })
})

describe('nested workspace peer', () => {
  it('reconstructs a workspace peer nested inside a registry peer suffix', () => {
    const lock =
      `lockfileVersion: '9.0'\n\n` +
      `importers:\n\n  .:\n    dependencies:\n` +
      `      consumer:\n        specifier: 1.0.0\n        version: 1.0.0(mid@1.0.0(@scope/host@packages+host))\n` +
      `  packages/host:\n    dependencies: {}\n\n` +
      `packages:\n\n` +
      `  consumer@1.0.0:\n    resolution: {integrity: sha512-c}\n    peerDependencies:\n      mid: '*'\n` +
      `  mid@1.0.0:\n    resolution: {integrity: sha512-m}\n    peerDependencies:\n      '@scope/host': '*'\n\n` +
      `snapshots:\n\n` +
      `  mid@1.0.0(@scope/host@packages+host):\n    dependencies:\n      '@scope/host': link:packages/host\n` +
      `  consumer@1.0.0(mid@1.0.0(@scope/host@packages+host)):\n    dependencies:\n      mid: 1.0.0(@scope/host@packages+host)\n`
    const out = stringifyV9(parseV9(lock))
    expect(out).toContain('consumer@1.0.0(mid@1.0.0(@scope/host@packages+host))')
    expect(stringifyV9(parseV9(out))).toBe(out)
    expect(out).not.toContain('packages/host@0.0.0')
  })
})

describe('v6 packages-key carrier', () => {
  it('round-trips a workspace-peer relation on the packages key', () => {
    const lock =
      `lockfileVersion: '6.0'\n\n` +
      `importers:\n\n  .:\n    dependencies:\n      dep:\n        specifier: 1.0.0\n        version: 1.0.0(@scope/host@packages+host)\n` +
      `  packages/host:\n    dependencies: {}\n\n` +
      `packages:\n\n  /dep@1.0.0(@scope/host@packages+host):\n    resolution: {integrity: sha512-x}\n    peerDependencies:\n      '@scope/host': '*'\n    dependencies:\n      '@scope/host': link:packages/host\n`
    const out = stringifyV6(parseV6(lock))
    expect(out).toContain('@scope/host@packages+host')
    expect(out).not.toContain('packages/host@0.0.0')
  })
})

describe('missing attribution', () => {
  const WS_TWO =
    `lockfileVersion: '9.0'\n\n` +
    `importers:\n\n  .:\n    dependencies:\n      dep:\n        specifier: 1.0.0\n        version: 1.0.0(@scope/host@packages+host)\n` +
    `  packages/host:\n    dependencies: {}\n  packages/other:\n    dependencies: {}\n\n` +
    `packages:\n\n  dep@1.0.0:\n    resolution: {integrity: sha512-x}\n    peerDependencies:\n      '@scope/host': '*'\n\n` +
    `snapshots:\n\n  dep@1.0.0(@scope/host@packages+host):\n    dependencies:\n      '@scope/host': link:packages/host\n`

  it('emits the native locator and no loss diagnostic when attribution is present', () => {
    const diags: Diagnostic[] = []
    const out = stringifyV9(parseV9(WS_TWO), { onDiagnostic: d => diags.push(d) })
    expect(out).toContain('dep@1.0.0(@scope/host@packages+host)')
    expect(diags.map(d => d.code)).not.toContain('PNPM_WORKSPACE_PEER_ATTR_MISSING')
  })

  it('surfaces a typed loss and does not fabricate a locator when a mutation drops attribution', () => {
    // Re-point the peer to a workspace with no captured attribution.
    const g2 = parseV9(WS_TWO)
      .mutate(m => m.replacePeerContext('dep@1.0.0(packages/host@0.0.0)', ['packages/other@0.0.0'])).graph
    const diags: Diagnostic[] = []
    const out = stringifyV9(g2, { onDiagnostic: d => diags.push(d) })
    expect(diags.map(d => d.code)).toContain('PNPM_WORKSPACE_PEER_ATTR_MISSING')
    expect(out).not.toContain('packages+other')
    expect(() => parseV9(out)).not.toThrow()
  })
})

describe('state-3 evidence restoration', () => {
  const detached = () => {
    const source = parse('pnpm-v9', STATE3)
    const builder = newBuilder()
    const tarballs = new Set<string>()
    for (const node of source.nodes()) {
      builder.addNode({ ...node, peerContext: [...node.peerContext] })
      for (const edge of source.out(node.id)) {
        builder.addEdge(edge.src, edge.dst, edge.kind,
          edge.attrs === undefined ? undefined : { ...edge.attrs })
      }
      const inputs = {
        name: node.name,
        version: node.version,
        ...(node.patch === undefined ? {} : { patch: node.patch }),
        ...(node.source === undefined ? {} : { source: node.source }),
      }
      const key = toTarballKey(inputs)
      const payload = source.tarball(inputs)
      if (payload !== undefined && !tarballs.has(key)) {
        builder.setTarball(inputs, payload)
        tarballs.add(key)
      }
    }
    const layout = source.layoutHints()
    if (layout !== undefined) builder.layoutHints(layout)
    return {
      source,
      graph: builder.seal(),
    }
  }

  it('fails closed without exact workspace manifest evidence', () => {
    const { source, graph } = detached()
    const result = stringifyAssessed(graph, {
      contract: 'snapshot',
      target: { format: 'pnpm-v9', managerVersion: '9.15.0' },
      evidence: evidenceOf(source),
    })

    expect(result.output).toBeUndefined()
    expect(result.assessment.requirements).toContainEqual(expect.objectContaining({
      key: 'target:pnpm-workspace-peer-projection',
      status: 'unassessed',
    }))
  })

  it('feeds one restored plan through v9 and v6 emit paths', () => {
    const { source, graph } = detached()
    const evidence = withEvidence(evidenceOf(source), {
      kind: 'repository-manifests',
      coverage: 'complete',
      manifests: {
        '': { name: 'root' },
        'packages/host': { name: '@scope/host' },
      },
    })
    const v9 = stringifyAssessed(graph, {
      contract: 'snapshot',
      target: { format: 'pnpm-v9', managerVersion: '9.15.0' },
      evidence,
    })
    const v6 = stringifyAssessed(graph, {
      contract: 'snapshot',
      target: { format: 'pnpm-v6', managerVersion: '8.15.9' },
      evidence,
    })
    const nested = 'mid@1.0.0(@scope/host@packages+host)'

    const state = internalEvidenceOf(evidence)
    const projection = resolvePnpmWorkspacePeerProjection(graph, {
      repositoryManifests: state.repositoryManifests,
      packageManifests: state.packageManifests,
    })
    const direct = stringifyFamily(
      graph,
      { profile: 'v9-importers-snapshots' },
      {},
      { workspacePeerProjection: projection },
    )
    const reparsed = parse('pnpm-v9', direct)
    expect(graph.diff(reparsed)).toEqual({
      addedNodes: [], removedNodes: [], changedNodes: [], addedEdges: [], removedEdges: [],
    })
    expect([...reparsed.nodes()].flatMap(node => reparsed.out(node.id)))
      .toEqual([...graph.nodes()].flatMap(node => graph.out(node.id)))
    expect([...reparsed.tarballs()]).toEqual([...graph.tarballs()])

    expect(v9.assessment.status, JSON.stringify(v9.assessment.requirements)).toBe('satisfied')
    expect(v6.assessment.status, JSON.stringify(v6.assessment.requirements)).toBe('satisfied')
    expect(v9.output).toContain(`consumer@1.0.0(${nested})`)
    expect(v9.output).toContain(`version: consumer@1.0.0(${nested})`)
    expect(v9.output).toContain(`mid: 1.0.0(@scope/host@packages+host)`)
    expect(v6.output).toContain(`/consumer@1.0.0(${nested}):`)
    expect(v6.output).toContain(`/mid@1.0.0(@scope/host@packages+host):`)
    expect(v6.output).toContain(`version: consumer@1.0.0(${nested})`)
    expect(v6.output).toContain(`mid: 1.0.0(@scope/host@packages+host)`)
    expect(v9.output).not.toContain('packages/host@0.0.0')
    expect(v6.output).not.toContain('packages/host@0.0.0')
  })

  it('keeps native sidecar reads inside the projection resolver', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const source = readFileSync(resolve(here, '../../main/ts/formats/_pnpm-flat-core.ts'), 'utf8')
    expect(source.match(/workspacePeerNames\.get/g)).toHaveLength(1)
    expect(source.match(/workspacePeerCollisions\.has/g)).toHaveLength(1)
  })

  it('fails closed when descendant publish evidence is ambiguous', () => {
    const { source, graph } = detached()
    const evidence = withEvidence(evidenceOf(source), {
      kind: 'repository-manifests',
      coverage: 'complete',
      manifests: {
        '': { name: 'root' },
        'packages/host': { name: '@scope/host' },
        'packages/host/build': { name: '@scope/host' },
      },
    })
    const result = stringifyAssessed(graph, {
      contract: 'snapshot',
      target: { format: 'pnpm-v9', managerVersion: '9.15.0' },
      evidence,
    })

    expect(result.output).toBeUndefined()
    expect(result.assessment.requirements).toContainEqual(expect.objectContaining({
      key: 'target:pnpm-workspace-peer-projection',
      status: 'unsatisfied',
    }))
  })

  it('fails closed on conflicting authoritative workspace manifests', () => {
    const { source, graph } = detached()
    const first = withEvidence(evidenceOf(source), {
      kind: 'repository-manifests',
      coverage: 'complete',
      manifests: {
        '': { name: 'root' },
        'packages/host': { name: '@scope/host' },
      },
    })
    const evidence = withEvidence(first, {
      kind: 'repository-manifests',
      coverage: 'complete',
      manifests: {
        '': { name: 'root' },
        'packages/host': { name: '@scope/other' },
      },
    })
    const result = stringifyAssessed(graph, {
      contract: 'snapshot',
      target: { format: 'pnpm-v9', managerVersion: '9.15.0' },
      evidence,
    })

    expect(result.output).toBeUndefined()
    expect(result.assessment.requirements).toContainEqual(expect.objectContaining({
      key: 'target:pnpm-workspace-peer-projection',
      status: 'unsatisfied',
    }))
  })

  it.each([
    ['single-segment scoped publish', 'host', 'host', '@scope/host'],
    ['unique descendant publish', 'packages/lib', 'packages/lib/build', '@scope/lib'],
  ])('restores %s without using the directory leaf as the package name', (
    _label,
    workspacePath,
    manifestPath,
    peerName,
  ) => {
    const builder = newBuilder()
    const workspaceId = `${workspacePath}@0.0.0`
    const ownerId = `owner@2.0.0(${workspaceId})`
    builder.addNode({
      id: workspaceId,
      name: workspacePath,
      version: '0.0.0',
      peerContext: [],
      workspacePath,
    })
    builder.addNode({ id: ownerId, name: 'owner', version: '2.0.0', peerContext: [workspaceId] })
    builder.addEdge(ownerId, workspaceId, 'peer', { range: '*' })
    builder.setTarball({ name: 'owner', version: '2.0.0' }, {
      peerDependencies: { [peerName]: '*' },
    })
    const projection = resolvePnpmWorkspacePeerProjection(builder.seal(), {
      repositoryManifests: {
        coverage: 'complete',
        manifests: { [manifestPath]: { name: peerName } },
      },
    })

    expect(projection.gaps).toEqual([])
    expect(projection.conflicts).toEqual([])
    expect(projection.attribution.get(`${ownerId}\0${workspaceId}`)).toEqual({
      name: peerName,
      locator: manifestPath.replace(/\//g, '+'),
    })
  })

  it('ignores an orphaned old payload after an owner version re-key', () => {
    const builder = newBuilder()
    const workspaceId = 'packages/host@0.0.0'
    const ownerId = `owner@2.0.0(${workspaceId})`
    builder.addNode({
      id: workspaceId,
      name: 'packages/host',
      version: '0.0.0',
      peerContext: [],
      workspacePath: 'packages/host',
    })
    builder.addNode({ id: 'owner@1.0.0', name: 'owner', version: '1.0.0', peerContext: [] })
    builder.setTarball({ name: 'owner', version: '1.0.0' }, {
      peerDependencies: { stale: '*' },
    })
    builder.addNode({ id: ownerId, name: 'owner', version: '2.0.0', peerContext: [workspaceId] })
    builder.addEdge(ownerId, workspaceId, 'peer', { range: '*' })
    const graph = builder.seal()
    const repositoryManifests = {
      coverage: 'complete' as const,
      manifests: { 'packages/host': { name: '@scope/host' } },
    }

    expect(resolvePnpmWorkspacePeerProjection(graph, { repositoryManifests }).gaps)
      .toContainEqual(expect.objectContaining({ reason: 'owner-declaration-missing' }))
    const restored = resolvePnpmWorkspacePeerProjection(graph, {
      repositoryManifests,
      packageManifests: new Map([[
        'owner@2.0.0',
        { manifest: { peerDependencies: { '@scope/host': '*' } } },
      ]]),
    })
    expect(restored.gaps).toEqual([])
    expect(restored.attribution.get(`${ownerId}\0${workspaceId}`)).toEqual({
      name: '@scope/host',
      locator: 'packages+host',
    })
  })
})

describe('cross-format', () => {
  it('does not leak the pnpm locator into a non-pnpm emit', () => {
    const diags: Diagnostic[] = []
    const out = stringifyNpm3(parseV9(WS_PEER), { onDiagnostic: (d: Diagnostic) => diags.push(d) })
    expect(out).not.toContain('packages+')
    expect(out).not.toContain('packages/host@0.0.0')
    expect(diags.map(d => d.code)).toContain('NPM_V3_PEER_VIRT_FLATTENED')
  })
})
