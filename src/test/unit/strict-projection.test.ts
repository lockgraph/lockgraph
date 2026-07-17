import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  LockfileError,
  parse,
  stringify,
  type FormatId,
} from '../../main/ts/index.ts'
import { stringifyProjected } from '../../main/ts/api/format-api.ts'
import { isStructuralExpectedDrop } from '../../main/ts/completeness/projection.ts'
import { newBuilder, type Graph, type TarballPayload } from '../../main/ts/graph.ts'
import { rebindAdapterState as rebindPnpmFlatAdapterState } from '../../main/ts/formats/_pnpm-flat-core.ts'
import * as bunText from '../../main/ts/formats/bun-text.ts'
import * as pnpmV5 from '../../main/ts/formats/pnpm-v5.ts'
import * as yarnBerryV9 from '../../main/ts/formats/yarn-berry-v9.ts'
import type { Integrity } from '../../main/ts/recipe/integrity.ts'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = (file: string): string =>
  readFileSync(resolve(here, '../resources/fixtures/lockfiles/simple', file), 'utf8')

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

function singleMetadataGraph(
  metadata: Partial<TarballPayload>,
  integrity: Integrity = sriIntegrity,
  targetShape?: 'yarn-classic' | 'yarn-berry-v8',
): Graph {
  const builder = newBuilder()
  builder.addNode({
    id: 'project@0.0.0',
    name: 'project',
    version: '0.0.0',
    peerContext: [],
    ...(targetShape === 'yarn-classic' ? {} : { workspacePath: '' }),
  })
  builder.addNode({ id: 'dep@1.0.0', name: 'dep', version: '1.0.0', peerContext: [] })
  builder.addEdge('project@0.0.0', 'dep@1.0.0', 'dep', {
    range: targetShape === 'yarn-berry-v8' ? 'npm:1.0.0' : '1.0.0',
  })
  builder.setTarball({ name: 'dep', version: '1.0.0' }, {
    integrity: { hashes: [...integrity.hashes] },
    ...(targetShape === 'yarn-berry-v8' ? { berryChecksumCacheKey: '10c0' } : {}),
    resolution: { type: 'tarball', url: 'https://registry.npmjs.org/dep/-/dep-1.0.0.tgz' },
    ...metadata,
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

type MetadataRefusalTarget = 'bun-text' | 'pnpm-v5' | 'pnpm-v6' | 'pnpm-v9'

function addMetadataToNativeControl(
  format: MetadataRefusalTarget,
  control: Graph,
  metadata: Partial<TarballPayload>,
): Graph {
  const node = [...control.nodes()].find(candidate => candidate.name === 'lodash')
  expect(node).toBeDefined()
  const payload = control.tarballOf(node!.id)
  expect(payload).toBeDefined()
  const mutated = control.mutate(mutable => {
    mutable.setTarball({ name: node!.name, version: node!.version }, {
      ...payload,
      ...metadata,
    })
  }).graph

  if (format === 'bun-text') return bunText.rebindAdapterState(control, mutated).graph
  if (format === 'pnpm-v5') return pnpmV5.rebindAdapterState(control, mutated).graph
  return rebindPnpmFlatAdapterState(control, mutated).graph
}

describe('strict projection gate', () => {
  it.each([
    ['yarn-classic', sriIntegrity],
    ['yarn-berry-v8', berryIntegrity],
  ] as const)('%s accepts an allowlisted engines drop and reports it', (format, integrity) => {
    const graph = singleMetadataGraph({ engines: { node: '>=18' } }, integrity, format)
    const projected = stringifyProjected(format, graph)

    expect(projected.losses).toEqual(expect.arrayContaining([
      expect.objectContaining({
        class: 'structural-expected',
        feature: 'metadata:engines',
        target: format,
      }),
    ]))
    expect(() => stringify(format, graph)).not.toThrow()
    expect(projected.diagnostics.some(diagnostic =>
      diagnostic.code === 'PROJECTION_LOSS'
        && diagnostic.data?.class === 'structural-expected')).toBe(true)
  })

  it('accepts a metadata-only node whose payload projects to empty (CASE-A)', () => {
    // A completed transitive carrying ONLY engines (no integrity/resolution): its yarn-classic
    // tarball payload projects to `{}`, and the reparse emits no entry for it. The output-graph
    // snapshot must omit the empty-after-projection payload, not diff `{}` against absent.
    const builder = newBuilder()
    builder.addNode({ id: 'project@0.0.0', name: 'project', version: '0.0.0', peerContext: [] })
    builder.addNode({ id: 'dep@1.0.0', name: 'dep', version: '1.0.0', peerContext: [] })
    builder.addEdge('project@0.0.0', 'dep@1.0.0', 'dep', { range: '1.0.0' })
    builder.setTarball({ name: 'dep', version: '1.0.0' }, { engines: { node: '>=20' } })
    expect(() => stringify('yarn-classic', builder.seal())).not.toThrow()
  })

  it('still rejects a metadata-only node whose sole field is not allowlisted (empty-omit does not mask)', () => {
    const builder = newBuilder()
    builder.addNode({ id: 'project@0.0.0', name: 'project', version: '0.0.0', peerContext: [] })
    builder.addNode({ id: 'dep@1.0.0', name: 'dep', version: '1.0.0', peerContext: [] })
    builder.addEdge('project@0.0.0', 'dep@1.0.0', 'dep', { range: '1.0.0' })
    builder.setTarball({ name: 'dep', version: '1.0.0' }, { license: 'MIT' })
    expect(caught('yarn-classic', builder.seal()).code).toBe('IRREDUCIBLE_LOSS')
  })

  it('keeps the structural allowlist pair-specific', () => {
    const graph = singleMetadataGraph({
      engines: { node: '>=18' },
      deprecated: 'use dep-next',
      bin: { dep: 'cli.js' },
    }, sriIntegrity, 'yarn-classic')
    const classic = stringifyProjected('yarn-classic', graph)
    expect(classic.losses.map(loss => [loss.class, loss.feature])).toEqual([
      ['structural-expected', 'metadata:bin'],
      ['structural-expected', 'metadata:deprecated'],
      ['structural-expected', 'metadata:engines'],
    ])

    const pnpm = caught('pnpm-v9', graph)
    expect(pnpm.losses).toContainEqual(expect.objectContaining({
      class: 'inherent-meaningful',
      feature: 'completeness-output-graph-mismatch',
    }))
    expect(isStructuralExpectedDrop('bin', 'pnpm-v9')).toBe(false)

    for (const field of [
      'cpu',
      'os',
      'libc',
      'hasInstallScript',
      'funding',
      'license',
      'bundledDependencies',
    ] as const) {
      expect(isStructuralExpectedDrop(field, 'yarn-classic')).toBe(false)
    }
  })

  it('strict-passes the bun native control before refusing minted storage metadata', () => {
    const control = parse('bun-text', fixture('bun-text.lock'))
    expect(() => stringify('bun-text', control)).not.toThrow()

    const withMetadata = addMetadataToNativeControl('bun-text', control, {
      os: ['linux'],
      cpu: ['x64'],
      bin: { lodash: 'cli.js' },
      peerDependencies: { peer: '^1.0.0' },
    })
    const error = caught('bun-text', withMetadata)
    expect(error.code).toBe('IRREDUCIBLE_LOSS')
    expect(error.losses).toContainEqual(expect.objectContaining({
      class: 'inherent-meaningful',
      feature: 'completeness-output-graph-mismatch',
      diagnostic: expect.objectContaining({ code: 'COMPLETENESS_OUTPUT_GRAPH_MISMATCH' }),
    }))
    expect(error.losses?.some(loss => loss.feature.startsWith('metadata:'))).toBe(false)
  })

  it.each([
    ['pnpm-v5', 'pnpm-v5.lock'],
    ['pnpm-v6', 'pnpm-v6.lock'],
    ['pnpm-v9', 'pnpm-v9.lock'],
  ] as const)('strict-passes the %s native control before refusing minted bin metadata', (format, file) => {
    const control = parse(format, fixture(file))
    expect(() => stringify(format, control)).not.toThrow()

    const withMetadata = addMetadataToNativeControl(format, control, {
      bin: { lodash: 'cli.js' },
    })
    const error = caught(format, withMetadata)
    expect(error.code).toBe('IRREDUCIBLE_LOSS')
    expect(error.losses).toContainEqual(expect.objectContaining({
      class: 'inherent-meaningful',
      feature: 'completeness-output-graph-mismatch',
      diagnostic: expect.objectContaining({ code: 'COMPLETENESS_OUTPUT_GRAPH_MISMATCH' }),
    }))
    expect(error.losses?.some(loss => loss.feature === 'metadata:bin')).toBe(false)
  })

  it('still rejects a target-stored field when emission loses its canonical carrier', () => {
    const error = caught(
      'yarn-berry-v8',
      singleMetadataGraph(
        { os: ['linux'], cpu: ['x64'] },
        berryIntegrity,
        'yarn-berry-v8',
      ),
    )
    expect(error.code).toBe('IRREDUCIBLE_LOSS')
    expect(error.losses?.some(loss =>
      loss.feature === 'completeness-output-graph-mismatch')).toBe(true)
  })

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
