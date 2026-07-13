import { describe, expect, it } from 'vitest'
import { LockfileError, stringify, type FormatId } from '../../main/ts/index.ts'
import { newBuilder, type Graph } from '../../main/ts/graph.ts'
import * as yarnBerryV9 from '../../main/ts/formats/yarn-berry-v9.ts'
import type { Integrity } from '../../main/ts/recipe/integrity.ts'

const sriIntegrity: Integrity = {
  hashes: [{ algorithm: 'sha512', digest: 'ab'.repeat(64), origin: 'sri' }],
}

const berryIntegrity: Integrity = {
  hashes: [{ algorithm: 'sha512', digest: 'cd'.repeat(64), origin: 'berry-zip' }],
}

function metadataGraph(integrity: Integrity = sriIntegrity): Graph {
  const builder = newBuilder()
  builder.addNode({
    id: 'project@0.0.0',
    name: 'project',
    version: '0.0.0',
    peerContext: [],
    workspacePath: '',
  })
  builder.addNode({ id: 'dep@1.0.0', name: 'dep', version: '1.0.0', peerContext: [] })
  builder.addEdge('project@0.0.0', 'dep@1.0.0', 'dep', { range: '1.0.0' })
  builder.setTarball({ name: 'dep', version: '1.0.0' }, {
    integrity: { hashes: [...integrity.hashes] },
    license: 'MIT',
    peerDependencies: { peer: '^1.0.0' },
    peerDependenciesMeta: { peer: { optional: true } },
    resolution: { type: 'tarball', url: 'https://registry.example/dep/-/dep-1.0.0.tgz' },
  })
  return builder.seal()
}

function peerContextGraph(): Graph {
  const builder = newBuilder()
  builder.addNode({
    id: 'project@0.0.0',
    name: 'project',
    version: '0.0.0',
    peerContext: [],
    workspacePath: '',
  })
  builder.addNode({ id: 'peer@1.0.0', name: 'peer', version: '1.0.0', peerContext: [] })
  builder.addNode({
    id: 'consumer@1.0.0(peer@1.0.0)',
    name: 'consumer',
    version: '1.0.0',
    peerContext: ['peer@1.0.0'],
  })
  builder.addEdge('project@0.0.0', 'consumer@1.0.0(peer@1.0.0)', 'dep', { range: '1.0.0' })
  builder.addEdge('consumer@1.0.0(peer@1.0.0)', 'peer@1.0.0', 'peer', { range: '^1.0.0' })
  for (const name of ['peer', 'consumer']) {
    builder.setTarball({ name, version: '1.0.0' }, {
      integrity: { hashes: [...sriIntegrity.hashes] },
      resolution: { type: 'tarball', url: `https://registry.example/${name}/-/${name}-1.0.0.tgz` },
    })
  }
  return builder.seal()
}

function caught(format: FormatId, graph: Graph): LockfileError {
  try {
    stringify(format, graph)
  } catch (error) {
    expect(error).toBeInstanceOf(LockfileError)
    return error as LockfileError
  }
  throw new Error(`expected strict ${format} stringify to reject a projection loss`)
}

describe('strict projection gate', () => {
  it.each([
    'npm-1',
    'pnpm-v5',
    'pnpm-v6',
    'pnpm-v9',
    'yarn-classic',
    'bun-text',
  ] as const)('%s rejects a held metadata fact its emitter cannot carry', format => {
    const error = caught(format, metadataGraph())
    expect(error.code).toBe('IRREDUCIBLE_LOSS')
    expect(error.losses?.some(loss => loss.feature === 'metadata:license')).toBe(true)
  })

  it.each([
    'yarn-berry-v4',
    'yarn-berry-v5',
    'yarn-berry-v6',
    'yarn-berry-v7',
    'yarn-berry-v8',
    'yarn-berry-v9',
    'yarn-berry-v10',
  ] as const)('%s rejects a held metadata fact with an otherwise valid checksum', format => {
    const error = caught(format, metadataGraph(berryIntegrity))
    expect(error.code).toBe('IRREDUCIBLE_LOSS')
    expect(error.losses?.some(loss => loss.feature === 'metadata:license')).toBe(true)
    expect(error.losses?.some(loss => loss.feature === 'metadata:peer-declarations')).toBe(false)
  })

  it.each(['npm-2', 'npm-3'] as const)('%s rejects virtual peer identity flattening', format => {
    const error = caught(format, peerContextGraph())
    expect(error.code).toBe('IRREDUCIBLE_LOSS')
    expect(error.losses?.some(loss => loss.feature === 'peer-context')).toBe(true)
  })

  it('classifies a missing Berry checksum as enrichable and exposes deterministic losses', () => {
    const error = caught('yarn-berry-v9', metadataGraph())
    expect(error.code).toBe('IRREDUCIBLE_LOSS')
    expect(error.message).toMatch(/^inherent-meaningful projection loss/)
    expect(error.losses).toBeDefined()
    expect(error.losses?.some(loss => loss.class === 'berry-checksum')).toBe(true)
    expect(Object.isFrozen(error.losses)).toBe(true)
  })

  it('uses ENRICH_REQUIRED when Berry checksum is the only loss', () => {
    const graph = metadataGraph().mutate(mutator => {
      mutator.setTarball({ name: 'dep', version: '1.0.0' }, {
        integrity: { hashes: [...sriIntegrity.hashes] },
        resolution: { type: 'tarball', url: 'https://registry.example/dep/-/dep-1.0.0.tgz' },
      })
    }).graph
    const error = caught('yarn-berry-v9', graph)
    expect(error.code).toBe('ENRICH_REQUIRED')
    expect(error.losses?.map(loss => loss.class)).toEqual(['berry-checksum'])
  })

  it('strict:false preserves legacy bytes and reports accepted loss', () => {
    const graph = metadataGraph()
    const diagnostics: string[] = []
    const expected = yarnBerryV9.stringify(graph)
    const output = stringify('yarn-berry-v9', graph, {
      strict: false,
      onDiagnostic: diagnostic => diagnostics.push(diagnostic.code),
    })
    expect(output).toBe(expected)
    expect(diagnostics).toContain('PROJECTION_LOSS')
  })

  it('lockgraph remains lossless for a source-less hand-built graph', () => {
    expect(() => stringify('lockgraph', metadataGraph())).not.toThrow()
  })
})
