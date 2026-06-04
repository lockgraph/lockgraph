import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { newBuilder, serializeNodeId, type Builder } from '../../main/ts/graph.ts'
import {
  frozenRegistry,
  parse,
  type CacheAdapter,
  type Packument,
  type PackumentVersion,
  type RegistryAdapter,
} from '../../main/ts/index.ts'
import type { Integrity } from '../../main/ts/recipe/integrity.ts'
import { sri } from '../_integrity-fixtures.ts'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = (scenario: string, file: string): string =>
  readFileSync(resolve(here, '../resources/fixtures/lockfiles', scenario, file), 'utf8')

function graphOf(build: (builder: Builder) => void) {
  const builder = newBuilder()
  build(builder)
  return builder.seal()
}

function addPackage(
  builder: Builder,
  {
    name,
    version,
    peerContext = [],
    workspacePath,
    integrity,
    tarball,
    engines,
    os,
    cpu,
    libc,
    deprecated,
    bin,
    bundledDependencies,
  }: {
    name: string
    version: string
    peerContext?: string[]
    workspacePath?: string
    integrity?: Integrity
    tarball?: string
    engines?: Record<string, string>
    os?: string[]
    cpu?: string[]
    libc?: string[]
    deprecated?: string
    bin?: string | Record<string, string>
    bundledDependencies?: string[]
  },
): string {
  const id = serializeNodeId(name, version, peerContext)
  builder.addNode({
    id,
    name,
    version,
    peerContext,
    workspacePath,
  })
  if (
    integrity !== undefined
    || tarball !== undefined
    || engines !== undefined
    || os !== undefined
    || cpu !== undefined
    || libc !== undefined
    || deprecated !== undefined
    || bin !== undefined
    || bundledDependencies !== undefined
  ) {
    builder.setTarball(
      { name, version },
      {
        integrity,
        engines,
        os,
        cpu,
        libc,
        deprecated,
        bin,
        bundledDependencies,
        resolution: tarball === undefined ? undefined : { type: 'tarball', url: tarball },
      },
    )
  }
  return id
}

function assertExportSurface(
  registry: RegistryAdapter,
  cache: CacheAdapter | undefined,
  packument: Packument | undefined,
  version: PackumentVersion | undefined,
): void {
  expect(registry).toBeDefined()
  expect(cache).toBeUndefined()
  expect(packument === undefined || typeof packument.name === 'string').toBe(true)
  expect(version === undefined || typeof version.version === 'string').toBe(true)
}

describe('registry/frozen', () => {
  it('returns undefined packuments for an empty graph', async () => {
    const registry = frozenRegistry(graphOf(() => {}))
    const packument = await registry.packument('lodash')
    assertExportSurface(registry, undefined, packument, undefined)
    expect(packument).toBeUndefined()
  })

  it('serves a single-version packument with graph-derived metadata and dependency blocks', async () => {
    const graph = graphOf(builder => {
      const reactId = addPackage(builder, {
        name: 'react',
        version: '18.2.0',
      })
      const schedulerId = addPackage(builder, {
        name: 'scheduler',
        version: '0.23.0',
      })
      const msId = addPackage(builder, {
        name: 'ms',
        version: '2.1.3',
      })
      const debugId = addPackage(builder, {
        name: 'debug',
        version: '4.4.1',
      })
      const consumerId = addPackage(builder, {
        name: 'react-dom',
        version: '18.2.0',
        peerContext: [reactId],
        integrity: sri('sha512-6IMTriUmvsjHUjNtEDudZfuDQUoWXVxKHhlEGSk81n4YFS+r/Kl99wXiwlVXtPBtJenozv2P+hxDsw9eA7Xo6g=='),
        tarball: 'https://registry.npmjs.org/react-dom/-/react-dom-18.2.0.tgz',
        engines: { node: '>=0.10.0' },
        os: ['darwin', 'linux'],
        cpu: ['x64'],
        libc: ['glibc'],
        deprecated: 'legacy',
        bin: { 'react-dom': 'bin/react-dom.js' },
      })

      builder.addEdge(consumerId, schedulerId, 'dep', { range: '^0.23.0' })
      builder.addEdge(consumerId, reactId, 'peer', { range: '^18.2.0' })
      builder.addEdge(consumerId, debugId, 'dev', { range: '^4.4.0' })
      builder.addEdge(consumerId, msId, 'optional', { range: '^2.1.3' })
      builder.addEdge(consumerId, msId, 'bundled')
    })

    const packument = await frozenRegistry(graph).packument('react-dom')
    expect(packument).toEqual({
      name: 'react-dom',
      distTags: { latest: '18.2.0' },
      versions: {
        '18.2.0': {
          name: 'react-dom',
          version: '18.2.0',
          integrity: sri('sha512-6IMTriUmvsjHUjNtEDudZfuDQUoWXVxKHhlEGSk81n4YFS+r/Kl99wXiwlVXtPBtJenozv2P+hxDsw9eA7Xo6g=='),
          tarball: 'https://registry.npmjs.org/react-dom/-/react-dom-18.2.0.tgz',
          dependencies: { scheduler: '^0.23.0' },
          devDependencies: { debug: '^4.4.0' },
          optionalDependencies: { ms: '^2.1.3' },
          peerDependencies: { react: '^18.2.0' },
          engines: { node: '>=0.10.0' },
          os: ['darwin', 'linux'],
          cpu: ['x64'],
          libc: ['glibc'],
          deprecated: 'legacy',
          bin: { 'react-dom': 'bin/react-dom.js' },
          bundledDependencies: ['ms'],
        },
      },
    })
  })

  it('indexes all known versions of the same package', async () => {
    const graph = graphOf(builder => {
      addPackage(builder, { name: 'lodash', version: '4.17.20' })
      addPackage(builder, { name: 'lodash', version: '4.17.21' })
    })

    const packument = await frozenRegistry(graph).packument('lodash')
    expect(packument?.distTags.latest).toBe('4.17.21')
    expect(Object.keys(packument?.versions ?? {})).toEqual(['4.17.21', '4.17.20'])
  })

  it('resolves exact versions', async () => {
    const graph = graphOf(builder => {
      addPackage(builder, { name: 'lodash', version: '4.17.20' })
      addPackage(builder, { name: 'lodash', version: '4.17.21' })
    })

    const version = await frozenRegistry(graph).resolve('lodash', '4.17.21')
    expect(version?.version).toBe('4.17.21')
  })

  it('resolves semver ranges to the highest satisfying version', async () => {
    const graph = graphOf(builder => {
      addPackage(builder, { name: 'lodash', version: '4.16.0' })
      addPackage(builder, { name: 'lodash', version: '4.17.20' })
      addPackage(builder, { name: 'lodash', version: '4.17.21' })
    })

    const version = await frozenRegistry(graph).resolve('lodash', '^4.17.0')
    expect(version?.version).toBe('4.17.21')
  })

  it('resolves latest through frozen dist-tags', async () => {
    const graph = graphOf(builder => {
      addPackage(builder, { name: 'lodash', version: '4.17.20' })
      addPackage(builder, { name: 'lodash', version: '4.17.21' })
    })

    const version = await frozenRegistry(graph).resolve('lodash', 'latest')
    expect(version?.version).toBe('4.17.21')
  })

  it('returns undefined for unknown packages and unsatisfied ranges', async () => {
    const graph = graphOf(builder => {
      addPackage(builder, { name: 'lodash', version: '4.17.21' })
    })

    const registry = frozenRegistry(graph)
    expect(await registry.resolve('left-pad', '^1.3.0')).toBeUndefined()
    expect(await registry.resolve('lodash', '^9999.0.0')).toBeUndefined()
  })

  it('excludes workspace members from frozen packuments', async () => {
    const graph = graphOf(builder => {
      addPackage(builder, {
        name: '@my/workspace',
        version: '1.0.0',
        workspacePath: 'packages/workspace',
      })
    })

    expect(await frozenRegistry(graph).packument('@my/workspace')).toBeUndefined()
  })

  it('resolves a real npm-3 fixture range from lockfile-derived facts', async () => {
    const graph = parse('npm-3', fixture('peers-basic', 'npm-3.lock'))
    const version = await frozenRegistry(graph).resolve('react', '^18.0.0')

    expect(version).toMatchObject({
      name: 'react',
      version: '18.2.0',
      tarball: 'https://registry.npmjs.org/react/-/react-18.2.0.tgz',
    })
  })

  it('extracts dependency and peer ranges from a real pnpm-v9 fixture graph', async () => {
    const graph = parse('pnpm-v9', fixture('peers-basic', 'pnpm-v9.lock'))
    const reactDom = await frozenRegistry(graph).resolve('react-dom', '18.2.0')

    expect(reactDom).toMatchObject({
      name: 'react-dom',
      version: '18.2.0',
      dependencies: { scheduler: '0.23.2' },
      peerDependencies: { react: '^18.2.0' },
    })
  })
})
