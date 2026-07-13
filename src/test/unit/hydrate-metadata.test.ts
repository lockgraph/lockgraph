import { describe, expect, it } from 'vitest'
import {
  newBuilder,
  serializeNodeId,
  type Graph,
  type NodeId,
  type TarballKeyInputs,
  type TarballPayload,
} from '../../main/ts/graph.ts'
import {
  hydrateMetadata,
  type HydrateMetadataResult,
} from '../../main/ts/enrich/index.ts'
import type { PackageManifestEvidence } from '../../main/ts/completeness/types.ts'
import { packageMetadataOfPayload } from '../../main/ts/registry/payload.ts'
import type { PackumentVersion } from '../../main/ts/registry/types.ts'
import { sentinelHashOf } from '../../main/ts/recipe/patch.ts'
import { mkIntegrity } from '../_integrity-fixtures.ts'

const manifest: PackumentVersion = {
  name: 'pkg',
  version: '1.0.0',
  engines: { node: '>=18' },
  funding: { type: 'individual', url: 'https://example.test/fund' },
  license: 'MIT',
  bin: { pkg: 'bin.js' },
  deprecated: 'retired',
  cpu: ['x64'],
  os: ['linux'],
  libc: ['glibc'],
  hasInstallScript: true,
  bundledDependencies: ['bundled'],
  peerDependencies: { peer: '^1.0.0' },
  peerDependenciesMeta: { peer: { optional: true } },
}

function evidence(
  authority: PackageManifestEvidence['authority'],
  manifests: Record<string, PackumentVersion>,
): PackageManifestEvidence {
  return { kind: 'package-manifests', authority, manifests }
}

function subjectGraph(
  inputs: TarballKeyInputs = { name: 'pkg', version: '1.0.0' },
  payload?: TarballPayload,
): { graph: Graph; id: NodeId } {
  const builder = newBuilder()
  const id = serializeNodeId(inputs.name, inputs.version, [], inputs.patch, inputs.source)
  builder.addNode({
    id,
    name: inputs.name,
    version: inputs.version,
    peerContext: [],
    patch: inputs.patch,
    source: inputs.source,
  })
  if (payload !== undefined) builder.setTarball(inputs, payload)
  return { graph: builder.seal(), id }
}

describe('enrich/hydrateMetadata', () => {
  for (const authority of [
    'full-packument',
    'version-manifest',
    'tarball-manifest',
  ] as const) {
    it(`fills absent canonical fields from ${authority} authority`, () => {
      const initialPayload: TarballPayload = {
        integrity: mkIntegrity('seed'),
        berryChecksumCacheKey: '10c0',
        resolution: { type: 'tarball', url: 'https://example.test/pkg.tgz' },
        nativeResolution: 'https://example.test/pkg.tgz#seed',
      }
      const { graph, id } = subjectGraph(undefined, initialPayload)
      const result: HydrateMetadataResult = hydrateMetadata(
        graph,
        evidence(authority, { 'pkg@1.0.0': manifest }),
      )

      expect(result.hydrated).toEqual(['pkg@1.0.0'])
      expect(result.diagnostics).toHaveLength(12)
      expect(result.diagnostics.every(item => item.code === 'ENRICH_FIELD_FILLED')).toBe(true)
      expect(packageMetadataOfPayload(result.graph.tarballOf(id))).toEqual(
        packageMetadataOfPayload(manifest),
      )
      expect(result.graph.tarballOf(id)).toMatchObject(initialPayload)
      expect(graph.tarballOf(id)).toEqual(initialPayload)
      expect(result.graph).not.toBe(graph)
      expect(result.graph.diagnostics()).toEqual(result.diagnostics)
      expect(result.observations).toEqual(evidence(authority, { 'pkg@1.0.0': manifest }))
      expect(Object.isFrozen(result)).toBe(true)
      expect(Object.isFrozen(result.hydrated)).toBe(true)
      expect(Object.isFrozen(result.diagnostics)).toBe(true)
      expect(Object.isFrozen(result.observations.manifests)).toBe(true)
      expect(Object.isFrozen(result.observations.manifests['pkg@1.0.0'])).toBe(true)
    })
  }

  it('hydrates a shared tarball once across peer variants', () => {
    const builder = newBuilder()
    const peerId = serializeNodeId('peer', '1.0.0', [])
    const baseId = serializeNodeId('pkg', '1.0.0', [])
    const variantId = serializeNodeId('pkg', '1.0.0', [peerId])
    builder.addNode({ id: peerId, name: 'peer', version: '1.0.0', peerContext: [] })
    builder.addNode({ id: baseId, name: 'pkg', version: '1.0.0', peerContext: [] })
    builder.addNode({
      id: variantId,
      name: 'pkg',
      version: '1.0.0',
      peerContext: [peerId],
    })
    builder.addEdge(variantId, peerId, 'peer')
    const graph = builder.seal()

    const result = hydrateMetadata(graph, evidence('version-manifest', {
      'pkg@1.0.0': { name: 'pkg', version: '1.0.0', license: 'MIT' },
    }))

    expect(result.hydrated).toEqual(['pkg@1.0.0'])
    expect(result.diagnostics).toHaveLength(1)
    expect(result.graph.tarballOf(baseId)).toBe(result.graph.tarballOf(variantId))
    expect(result.graph.tarballOf(baseId)?.license).toBe('MIT')
    expect([...result.graph.tarballs()]).toHaveLength(1)
  })

  it('treats canonical equality and asymmetric empty values as a true no-op', () => {
    const { graph } = subjectGraph(undefined, {
      engines: { node: '>=18', npm: '>=9' },
      hasInstallScript: false,
      cpu: [],
      bin: {},
      peerDependenciesMeta: { peer: { optional: false } },
    })
    const result = hydrateMetadata(graph, evidence('version-manifest', {
      'pkg@1.0.0': {
        name: 'pkg',
        version: '1.0.0',
        engines: { npm: '>=9', node: '>=18' },
      },
    }))

    expect(result.graph).toBe(graph)
    expect(result.hydrated).toEqual([])
    expect(result.diagnostics).toEqual([])
  })

  it('blocks the whole subject on one conflicting canonical field', () => {
    const { graph, id } = subjectGraph(undefined, { license: 'MIT' })
    const result = hydrateMetadata(graph, evidence('version-manifest', {
      'pkg@1.0.0': {
        name: 'pkg',
        version: '1.0.0',
        license: 'Apache-2.0',
        os: ['linux'],
      },
      'unrelated@1.0.0': { name: 'unrelated', version: '1.0.0', license: 'MIT' },
    }))

    expect(result.hydrated).toEqual([])
    expect(result.graph).not.toBe(graph)
    expect(result.graph.tarballOf(id)).toEqual({ license: 'MIT' })
    expect(result.diagnostics.map(item => item.code)).toEqual([
      'COMPLETENESS_PACKAGE_METADATA_MISMATCH',
    ])
    expect(result.graph.diagnostics()).toEqual(result.diagnostics)
    expect(Object.keys(result.observations.manifests)).toEqual(['pkg@1.0.0'])
  })

  it('rejects manifest identity mismatch without partial mutation', () => {
    const { graph } = subjectGraph()
    const result = hydrateMetadata(graph, evidence('version-manifest', {
      'pkg@1.0.0': { name: 'other', version: '1.0.0', license: 'MIT' },
    }))

    expect(result.hydrated).toEqual([])
    expect(result.diagnostics.map(item => item.code)).toEqual([
      'COMPLETENESS_PACKAGE_METADATA_MISMATCH',
    ])
  })

  it('rejects custom sources even with tarball-manifest authority', () => {
    const source = '0123456789abcdef'
    const { graph, id } = subjectGraph({ name: 'pkg', version: '1.0.0', source })
    const key = `pkg@1.0.0+src=${source}`
    const result = hydrateMetadata(graph, evidence('tarball-manifest', {
      [key]: { name: 'pkg', version: '1.0.0', license: 'MIT' },
    }))

    expect(result.graph.tarballOf(id)).toBeUndefined()
    expect(result.hydrated).toEqual([])
    expect(result.diagnostics.map(item => item.code)).toEqual([
      'COMPLETENESS_PACKAGE_METADATA_SOURCE_UNSUPPORTED',
    ])
  })

  it('rejects registry authority and sentinel mutation over patches', () => {
    const patch = 'a'.repeat(128)
    const mutable = subjectGraph({ name: 'pkg', version: '1.0.0', patch })
    const mutableKey = `pkg@1.0.0+patch=${patch}`
    const registryResult = hydrateMetadata(mutable.graph, evidence('version-manifest', {
      [mutableKey]: { name: 'pkg', version: '1.0.0', license: 'MIT' },
    }))

    const sentinel = sentinelHashOf('pkg@1.0.0#builtin')
    const immutable = subjectGraph({ name: 'pkg', version: '1.0.0', patch: sentinel })
    const sentinelKey = `pkg@1.0.0+patch=${sentinel}`
    const sentinelResult = hydrateMetadata(immutable.graph, evidence('tarball-manifest', {
      [sentinelKey]: { name: 'pkg', version: '1.0.0', license: 'MIT' },
    }))

    expect(registryResult.graph.tarballOf(mutable.id)).toBeUndefined()
    expect(registryResult.diagnostics[0]?.code).toBe(
      'COMPLETENESS_PACKAGE_METADATA_SOURCE_UNSUPPORTED',
    )
    expect(sentinelResult.graph.tarballOf(immutable.id)).toBeUndefined()
    expect(sentinelResult.diagnostics[0]?.code).toBe(
      'COMPLETENESS_PACKAGE_METADATA_SOURCE_UNSUPPORTED',
    )
  })

  it('hydrates a mutable patch only from exact tarball-manifest authority', () => {
    const patch = 'b'.repeat(128)
    const { graph, id } = subjectGraph({ name: 'pkg', version: '1.0.0', patch })
    const key = `pkg@1.0.0+patch=${patch}`
    const result = hydrateMetadata(graph, evidence('tarball-manifest', {
      [key]: { name: 'pkg', version: '1.0.0', license: 'MIT' },
    }))

    expect(result.hydrated).toEqual([key])
    expect(result.graph.tarballOf(id)?.license).toBe('MIT')
  })

  it('is idempotent and deterministic', () => {
    const { graph } = subjectGraph()
    const authority = evidence('version-manifest', {
      'pkg@1.0.0': { name: 'pkg', version: '1.0.0', license: 'MIT', os: ['linux'] },
    })
    const left = hydrateMetadata(graph, authority)
    const right = hydrateMetadata(graph, authority)
    const repeated = hydrateMetadata(left.graph, authority)

    expect([...left.graph.tarballs()]).toEqual([...right.graph.tarballs()])
    expect(left.diagnostics).toEqual(right.diagnostics)
    expect(repeated.graph).toBe(left.graph)
    expect(repeated.hydrated).toEqual([])
    expect(repeated.diagnostics).toEqual([])
  })

  it('does not duplicate a persistent conflict diagnostic', () => {
    const { graph } = subjectGraph(undefined, { license: 'MIT' })
    const authority = evidence('version-manifest', {
      'pkg@1.0.0': { name: 'pkg', version: '1.0.0', license: 'Apache-2.0' },
    })
    const first = hydrateMetadata(graph, authority)
    const repeated = hydrateMetadata(first.graph, authority)

    expect(repeated.graph).toBe(first.graph)
    expect(repeated.diagnostics).toEqual([])
    expect(repeated.graph.diagnostics()).toHaveLength(1)
  })
})
