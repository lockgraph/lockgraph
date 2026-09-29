import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  complete,
  LockfileError,
  parse,
  stringify,
} from '../../main/ts/index.ts'
import { stringifyProjected } from '../../main/ts/api/format-api.ts'
import { completeTransitives } from '../../main/ts/complete/tree-complete.ts'
import { serializeNodeId } from '../../main/ts/graph.ts'
import type { Packument, PackumentVersion, RegistryAdapter } from '../../main/ts/registry/types.ts'
import {
  materializeYarnBerryPluginCompat,
  supportsYarnBerryPluginCompat,
  yarnBerryPluginCompatRegistry,
} from '../../main/ts/enrich/yarn-berry-plugin-compat.ts'
import { refurbish } from '../../main/ts/enrich/refurbish.ts'
import {
  yarnBerryBuiltinCompatIdentityOfResolution,
  yarnBerryFseventsCompatResolution,
} from '../../main/ts/recipe/yarn-berry-builtin-compat.ts'
import { parse as parseV8, stringify as stringifyV8 } from '../../main/ts/formats/yarn-berry-v8.ts'
import { enrich } from '../../main/ts/enrich/facade.ts'
import { addEdge, addPackage, graphOf } from './_modify-test-utils.ts'

const target = { format: 'yarn-berry-v8', managerVersion: '4.13.0' } as const
const profileVersions = ['2.3.2', '2.3.3'] as const
const familyProfiles = [
  {
    name: 'fsevents',
    version: '2.3.2',
    source: 'optional!builtin<compat/fsevents>',
    hash: 'df0bf1',
    checksum: undefined,
  },
  {
    name: 'fsevents',
    version: '2.3.3',
    source: 'optional!builtin<compat/fsevents>',
    hash: 'df0bf1',
    checksum: undefined,
  },
  {
    name: 'resolve',
    version: '1.22.8',
    source: 'optional!builtin<compat/resolve>',
    hash: 'c3c19d',
    checksum: '0446f024439cd2e50c6c8fa8ba77eaa8370b4180f401a96abf3d1ebc770ac51c1955e12764cde449fde3fff480a61f84388e3505ecdbab778f4bef5f8212c729',
  },
  {
    name: 'typescript',
    version: '5.6.2',
    source: 'optional!builtin<compat/typescript>',
    hash: '8c6c40',
    checksum: '94eb47e130d3edd964b76da85975601dcb3604b0c848a36f63ac448d0104e93819d94c8bdf6b07c00120f2ce9c05256b8b6092d23cf5cf1c6fa911159e4d572f',
  },
] as const

function compatResolution(profile: typeof familyProfiles[number]): string {
  return `${profile.name}@patch:${profile.name}@npm%3A${profile.version}#${profile.source}::version=${profile.version}&hash=${profile.hash}`
}

function seed(versions: readonly string[] = ['2.3.3']) {
  return graphOf(builder => {
    const root = addPackage(builder, { name: 'root', version: '1.0.0', workspacePath: '' })
    const nodeGyp = addPackage(builder, { name: 'node-gyp', version: '11.5.0' })
    for (const version of versions) {
      const consumer = versions.length === 1
        ? root
        : addPackage(builder, { name: `consumer-${version}`, version: '1.0.0' })
      const fsevents = addPackage(builder, {
        name: 'fsevents',
        version,
        os: ['darwin'],
        integrity: 'sha512-ZnNldmVudHM=',
      })
      if (consumer !== root) addEdge(builder, root, consumer, 'dep', 'npm:1.0.0')
      addEdge(builder, consumer, fsevents, 'optional', `npm:^${version}`)
      addEdge(builder, fsevents, nodeGyp, 'dep', 'npm:latest')
    }
  })
}

function familySeed() {
  return graphOf(builder => {
    const root = addPackage(builder, { name: 'root', version: '1.0.0', workspacePath: '' })
    const nodeGyp = addPackage(builder, { name: 'node-gyp', version: '11.5.0' })
    const isCoreModule = addPackage(builder, { name: 'is-core-module', version: '2.13.1' })
    const pathParse = addPackage(builder, { name: 'path-parse', version: '1.0.7' })
    const preserveSymlinks = addPackage(builder, {
      name: 'supports-preserve-symlinks-flag',
      version: '1.0.0',
    })
    for (const profile of familyProfiles) {
      const consumer = addPackage(builder, {
        name: `consumer-${profile.name}-${profile.version}`,
        version: '1.0.0',
      })
      const base = addPackage(builder, {
        name: profile.name,
        version: profile.version,
        ...(profile.name === 'fsevents' ? { os: ['darwin'] } : {}),
        ...(profile.name === 'resolve' ? { bin: { resolve: 'bin/resolve' } } : {}),
        ...(profile.name === 'typescript' ? {
          bin: { tsc: 'bin/tsc', tsserver: 'bin/tsserver' },
        } : {}),
        integrity: 'sha512-Y29tcGF0',
      })
      addEdge(
        builder,
        consumer,
        base,
        profile.name === 'fsevents' ? 'optional' : 'dep',
        `npm:${profile.version}`,
      )
      addEdge(builder, root, consumer, 'dep', 'npm:1.0.0')
      if (profile.name === 'fsevents') {
        addEdge(builder, base, nodeGyp, 'dep', 'npm:latest')
      }
      if (profile.name === 'resolve') {
        addEdge(builder, base, isCoreModule, 'dep', 'npm:^2.13.0')
        addEdge(builder, base, pathParse, 'dep', 'npm:^1.0.7')
        addEdge(builder, base, preserveSymlinks, 'dep', 'npm:^1.0.0')
      }
    }
  })
}

describe('Yarn Berry plugin-compat profile', () => {
  it('is keyed by pinned manager era, never by lockfile version alone', () => {
    expect(supportsYarnBerryPluginCompat(target)).toBe(true)
    expect(supportsYarnBerryPluginCompat({
      format: 'yarn-berry-v9',
      managerVersion: '4.14.1',
    })).toBe(true)
    expect(supportsYarnBerryPluginCompat({
      format: 'yarn-berry-v8',
      managerVersion: '4.12.0',
    })).toBe(false)
    expect(supportsYarnBerryPluginCompat({
      format: 'yarn-berry-v9',
      managerVersion: '4.13.0',
    })).toBe(false)
    expect(supportsYarnBerryPluginCompat({ format: 'yarn-berry-v8' })).toBe(false)
  })

})

describe('Yarn Berry plugin-compat registry view', () => {
  it('projects both profile rows and keeps non-profile observations stable ×8', async () => {
    const fsevents232: PackumentVersion = {
      name: 'fsevents',
      version: '2.3.2',
      dependencies: { existing: '^1.0.0' },
    }
    const fsevents233: PackumentVersion = {
      name: 'fsevents',
      version: '2.3.3',
      dependencies: { existing: '^1.0.0' },
    }
    const fsevents231: PackumentVersion = { name: 'fsevents', version: '2.3.1' }
    const fseventsPackument: Packument = {
      name: 'fsevents',
      distTags: { latest: '2.3.3' },
      versions: {
        '2.3.1': fsevents231,
        '2.3.2': fsevents232,
        '2.3.3': fsevents233,
      },
    }
    const ordinary: Packument = {
      name: 'ordinary',
      distTags: { latest: '1.0.0' },
      versions: { '1.0.0': { name: 'ordinary', version: '1.0.0' } },
    }
    const resolveVersion: PackumentVersion = {
      name: 'resolve',
      version: '1.22.8',
      dependencies: { existing: '^1.0.0' },
    }
    const resolvePackument: Packument = {
      name: 'resolve',
      distTags: { latest: '1.22.8' },
      versions: { '1.22.8': resolveVersion },
    }
    const typescriptVersion: PackumentVersion = {
      name: 'typescript',
      version: '5.6.2',
    }
    const typescriptPackument: Packument = {
      name: 'typescript',
      distTags: { latest: '5.6.2' },
      versions: { '5.6.2': typescriptVersion },
    }
    const adapter: RegistryAdapter = {
      async packument(name) {
        if (name === 'fsevents') return fseventsPackument
        if (name === 'resolve') return resolvePackument
        if (name === 'typescript') return typescriptPackument
        return name === 'ordinary' ? ordinary : undefined
      },
      async resolve(name, range) {
        if (name === 'resolve') return resolveVersion
        if (name === 'typescript') return typescriptVersion
        if (name !== 'fsevents') return ordinary.versions['1.0.0']
        if (range.includes('2.3.1')) return fsevents231
        if (range.includes('2.3.2')) return fsevents232
        return fsevents233
      },
    }
    const view = yarnBerryPluginCompatRegistry(adapter, target)
    for (const version of profileVersions) {
      const projected = await view.resolve('fsevents', version)
      expect(projected?.dependencies).toEqual({
        existing: '^1.0.0',
        'node-gyp': 'npm:latest',
      })
      expect(Object.isFrozen(projected)).toBe(true)
      expect(Object.isFrozen(projected?.dependencies)).toBe(true)
    }
    expect(fsevents232.dependencies).toEqual({ existing: '^1.0.0' })
    expect(fsevents233.dependencies).toEqual({ existing: '^1.0.0' })
    expect(await view.resolve('fsevents', '2.3.1')).toBe(fsevents231)
    const projectedPackument = await view.packument('fsevents')
    expect(projectedPackument?.versions['2.3.1']).toBe(fsevents231)
    expect(projectedPackument?.versions['2.3.2']?.dependencies?.['node-gyp'])
      .toBe('npm:latest')
    expect(projectedPackument?.versions['2.3.3']?.dependencies?.['node-gyp'])
      .toBe('npm:latest')
    expect(await view.resolve('resolve', '1.22.8')).toBe(resolveVersion)
    expect(await view.packument('resolve')).toBe(resolvePackument)
    expect(await view.resolve('typescript', '5.6.2')).toBe(typescriptVersion)
    expect(await view.packument('typescript')).toBe(typescriptPackument)

    const digest = (value: unknown): string =>
      createHash('sha256').update(JSON.stringify(value)).digest('hex')
    const expected = digest(ordinary)
    for (let index = 0; index < 8; index++) {
      const observed = await view.packument('ordinary')
      expect(observed).toBe(ordinary)
      expect(digest(observed)).toBe(expected)
    }
  })
})

describe('Yarn Berry plugin-compat materializer', () => {
  it.each([
    familyProfiles[1],
    familyProfiles[2],
    familyProfiles[3],
  ])('routes descriptor reuse and fresh resolution through the $name builtin patch', async profile => {
    const boundRange = `~${profile.version}`
    const patchDescriptor = `${profile.name}@patch:${profile.name}@npm%3A${boundRange}#${profile.source}`
    const lock = `__metadata:
  version: 8
  cacheKey: 10c0

"consumer@npm:1.0.0":
  version: 1.0.0
  resolution: "consumer@npm:1.0.0"
  languageName: node
  linkType: hard

"${profile.name}@npm:${boundRange}":
  version: ${profile.version}
  resolution: "${profile.name}@npm:${profile.version}"
  languageName: node
  linkType: hard

"${patchDescriptor}":
  version: ${profile.version}
  resolution: "${compatResolution(profile)}"
  languageName: node
  linkType: hard
`
    const base = parse('yarn-berry-v8', lock)
    const patchId = [...base.nodes()].find(node =>
      node.name === profile.name && node.patch !== undefined)!.id
    const registryFor = (range: string): RegistryAdapter => ({
      async packument(name) {
        if (name === 'consumer') {
          return {
            name,
            distTags: { latest: '1.0.0' },
            versions: {
              '1.0.0': {
                name,
                version: '1.0.0',
                dependencies: { [profile.name]: range },
              },
            },
          }
        }
        if (name === profile.name) {
          return {
            name,
            distTags: { latest: profile.version },
            versions: {
              [profile.version]: { name, version: profile.version },
            },
          }
        }
        return undefined
      },
      async resolve(name) {
        return name === profile.name
          ? { name, version: profile.version }
          : undefined
      },
    })

    for (const range of [boundRange, `>=${profile.version}`]) {
      const completed = await complete(base, {
        target: 'yarn-berry-v8',
        sources: { packuments: [registryFor(range)] },
        seed: { added: new Set(['consumer@1.0.0']), orphaned: new Set() },
      })
      const targetEdges = completed.graph.out('consumer@1.0.0')
        .filter(edge => completed.graph.getNode(edge.dst)?.name === profile.name)
      expect(targetEdges.map(edge => edge.dst), range).toEqual([patchId])
    }
  })

  it('mirrors a completion-added plain descriptor onto an existing builtin patch entry', () => {
    const lock = `__metadata:
  version: 8
  cacheKey: 10c0

"fsevents@npm:^2.3.2":
  version: 2.3.2
  resolution: "fsevents@npm:2.3.2"
  languageName: node
  linkType: hard

"fsevents@patch:fsevents@npm%3A^2.3.2#optional!builtin<compat/fsevents>":
  version: 2.3.2
  resolution: "fsevents@patch:fsevents@npm%3A2.3.2#optional!builtin<compat/fsevents>::version=2.3.2&hash=18f3a7"
  languageName: node
  linkType: hard

"playwright@npm:1.55.1":
  version: 1.55.1
  resolution: "playwright@npm:1.55.1"
  languageName: node
  linkType: hard
`
    const graph = parseV8(lock)
    const patchId = [...graph.nodes()].find(node =>
      node.name === 'fsevents' && node.patch !== undefined)!.id
    const completed = graph.mutate(mutation => mutation.addEdge(
      'playwright@1.55.1',
      patchId,
      'optional',
      { range: '2.3.2' },
    )).graph
    const output = stringifyV8(completed)

    expect(output).toContain(
      '"fsevents@npm:2.3.2, fsevents@npm:^2.3.2":',
    )
    expect(output).toContain(
      'fsevents@patch:fsevents@npm%3A2.3.2#optional!builtin<compat/fsevents>, '
      + 'fsevents@patch:fsevents@npm%3A^2.3.2#optional!builtin<compat/fsevents>',
    )
  })

  it('materializes the package-keyed family with row-owned injection and checksum policy', () => {
    const graph = familySeed()
    const result = materializeYarnBerryPluginCompat(graph, target)
    const patchIds = familyProfiles.map(profile => {
      const identity = yarnBerryBuiltinCompatIdentityOfResolution(
        compatResolution(profile),
      )!
      return serializeNodeId(profile.name, profile.version, [], identity.patch)
    })

    expect(result.added).toEqual(patchIds)
    for (const [index, profile] of familyProfiles.entries()) {
      const baseId = `${profile.name}@${profile.version}`
      const patchId = patchIds[index]!
      const payload = result.graph.tarballOf(patchId)
      expect(result.graph.in(baseId)).toEqual([])
      expect(result.graph.in(patchId).map(edge => edge.src)).toEqual([
        `consumer-${profile.name}-${profile.version}@1.0.0`,
      ])
      expect(result.graph.out(patchId).map(edge => edge.dst))
        .toEqual(result.graph.out(baseId).map(edge => edge.dst))
      expect(payload?.nativeResolution).toBe(compatResolution(profile))
      if (profile.checksum === undefined) {
        expect(payload?.integrity).toBeUndefined()
        expect(payload?.berryChecksumCacheKey).toBeUndefined()
      } else {
        expect(payload?.integrity?.hashes).toEqual([{
          algorithm: 'sha512',
          digest: profile.checksum,
          origin: 'berry-zip',
        }])
        expect(payload?.berryChecksumCacheKey).toBe('10c0')
      }
    }

    expect(result.graph.out(patchIds[0]!).map(edge =>
      result.graph.getNode(edge.dst)?.name)).toContain('node-gyp')
    expect(result.graph.out(patchIds[2]!).map(edge =>
      result.graph.getNode(edge.dst)?.name)).toEqual([
      'is-core-module',
      'path-parse',
      'supports-preserve-symlinks-flag',
    ])
    expect(result.graph.out(patchIds[3]!)).toEqual([])
    const lock = stringifyV8(result.graph)
    expect(lock).toContain(`resolution: "${compatResolution(familyProfiles[2])}"`)
    expect(lock).toContain(`checksum: 10c0/${familyProfiles[2].checksum}`)
    expect(lock).toContain(`resolution: "${compatResolution(familyProfiles[3])}"`)
    expect(lock).toContain(`checksum: 10c0/${familyProfiles[3].checksum}`)

    const second = materializeYarnBerryPluginCompat(result.graph, target)
    expect(second.graph).toBe(result.graph)
    expect(second.added).toEqual([])
  })

  it('materializes every table row in one deterministic sealed graph', () => {
    const graph = seed(profileVersions)
    const result = materializeYarnBerryPluginCompat(graph, target)
    const patchIds = profileVersions.map(version => {
      const identity = yarnBerryBuiltinCompatIdentityOfResolution(
        yarnBerryFseventsCompatResolution(version),
      )!
      return serializeNodeId('fsevents', version, [], identity.patch)
    })

    expect(result.added).toEqual(patchIds)
    for (const [index, version] of profileVersions.entries()) {
      const patchId = patchIds[index]!
      expect(result.graph.getNode(patchId)?.patch).not.toBe('df0bf1')
      expect(result.graph.in(`fsevents@${version}`)).toEqual([])
      expect(result.graph.in(patchId).map(edge => result.graph.getNode(edge.src)?.name))
        .toEqual([`consumer-${version}`])
      expect(result.graph.out(patchId).map(edge => result.graph.getNode(edge.dst)?.name))
        .toContain('node-gyp')
      expect(result.graph.tarballOf(patchId)?.integrity).toBeUndefined()
    }

    const second = materializeYarnBerryPluginCompat(result.graph, target)
    expect(second.graph).toBe(result.graph)
    expect(second.added).toEqual([])
  })

  it('creates the base/patch pair, rewires consumers, stays bare, and round-trips identity', () => {
    const graph = seed()
    const result = materializeYarnBerryPluginCompat(graph, target)
    const identity = yarnBerryBuiltinCompatIdentityOfResolution(
      yarnBerryFseventsCompatResolution(),
    )!
    const baseId = 'fsevents@2.3.3'
    const patchId = serializeNodeId('fsevents', '2.3.3', [], identity.patch)

    expect(result.added).toEqual([patchId])
    expect(result.graph.getNode(baseId)).toBeDefined()
    expect(result.graph.getNode(patchId)?.patch).toBe(identity.patch)
    expect(identity.patch).not.toBe('df0bf1')
    expect(result.graph.in(baseId)).toEqual([])
    expect(result.graph.in(patchId).map(edge => edge.src)).toEqual(['root@1.0.0'])
    expect(result.graph.out(baseId).map(edge => result.graph.getNode(edge.dst)?.name))
      .toContain('node-gyp')
    expect(result.graph.out(patchId).map(edge => result.graph.getNode(edge.dst)?.name))
      .toContain('node-gyp')
    expect(result.graph.tarballOf(baseId)?.integrity).toBeDefined()
    expect(result.graph.tarballOf(patchId)?.integrity).toBeUndefined()
    expect(result.graph.tarballOf(patchId)?.berryChecksumCacheKey).toBeUndefined()
    expect(result.graph.tarballOf(patchId)?.os).toEqual(['darwin'])

    const lock = stringifyV8(result.graph)
    expect(lock).toContain(
      '"fsevents@patch:fsevents@npm%3A^2.3.3#optional!builtin<compat/fsevents>":',
    )
    expect(lock).toContain(`resolution: "${yarnBerryFseventsCompatResolution()}"`)
    expect(lock).toContain('node-gyp: "npm:latest"')
    const reparsed = parseV8(lock)
    expect(reparsed.getNode(patchId)?.patch).toBe(identity.patch)
    expect(reparsed.getNode(baseId)).toBeDefined()
    expect(reparsed.out(baseId).map(edge => reparsed.getNode(edge.dst)?.name))
      .toContain('node-gyp')

    const second = materializeYarnBerryPluginCompat(result.graph, target)
    expect(second.graph).toBe(result.graph)
    expect(second.added).toEqual([])
  })

  it('fails closed when completion did not resolve node-gyp', () => {
    const graph = graphOf(builder => {
      const root = addPackage(builder, { name: 'root', version: '1.0.0', workspacePath: '' })
      const fsevents = addPackage(builder, {
        name: 'fsevents',
        version: '2.3.3',
        os: ['darwin'],
      })
      addEdge(builder, root, fsevents, 'optional', 'npm:^2.3.3')
    })
    const result = materializeYarnBerryPluginCompat(graph, target)
    expect(result.graph).toBe(graph)
    expect(result.added).toEqual([])
  })

  it('fails closed for fsevents versions outside the table', () => {
    const graph = seed(['2.3.1'])
    const result = materializeYarnBerryPluginCompat(graph, target)
    expect(result.graph).toBe(graph)
    expect(result.added).toEqual([])
  })

  it('runs around ordinary completion in the enrichment facade', async () => {
    const source = graphOf(builder => {
      const root = addPackage(builder, { name: 'root', version: '1.0.0', workspacePath: '' })
      const fsevents = addPackage(builder, {
        name: 'fsevents',
        version: '2.3.3',
        os: ['darwin'],
      })
      addEdge(builder, root, fsevents, 'optional', 'npm:^2.3.3')
    })
    const input = parseV8(stringifyV8(source))
    const fsevents: PackumentVersion = {
      name: 'fsevents',
      version: '2.3.3',
      os: ['darwin'],
    }
    const nodeGyp: PackumentVersion = { name: 'node-gyp', version: '11.5.0' }
    const packs: Record<string, Packument> = {
      fsevents: {
        name: 'fsevents',
        distTags: { latest: '2.3.3' },
        versions: { '2.3.3': fsevents },
      },
      'node-gyp': {
        name: 'node-gyp',
        distTags: { latest: '11.5.0' },
        versions: { '11.5.0': nodeGyp },
      },
    }
    const registry: RegistryAdapter = {
      async packument(name) {
        return packs[name]
      },
      async resolve(name, range) {
        if (name === 'node-gyp' && range === 'npm:latest') return nodeGyp
        return undefined
      },
    }
    const result = await enrich(input, {
      manifests: {
        '': {
          name: 'root',
          version: '1.0.0',
          optionalDependencies: { fsevents: '^2.3.3' },
          overrides: [],
        },
      },
      registry,
    }, {
      target,
      contract: 'snapshot',
    })
    const identity = yarnBerryBuiltinCompatIdentityOfResolution(
      yarnBerryFseventsCompatResolution(),
    )!
    const patchId = serializeNodeId('fsevents', '2.3.3', [], identity.patch)
    expect(result.graph.getNode('node-gyp@11.5.0')).toBeDefined()
    expect(result.graph.getNode(patchId)).toBeDefined()
    expect(result.graph.out('fsevents@2.3.3').some(edge => edge.dst === 'node-gyp@11.5.0')).toBe(true)
    expect(result.graph.out(patchId).some(edge => edge.dst === 'node-gyp@11.5.0')).toBe(true)
    expect(stringifyV8(result.graph).match(/  conditions: os=darwin/g)?.length).toBe(2)
  })

  it('names the skipped target overlay after direct completion and refurbishment', async () => {
    const source = parse(
      'yarn-berry-v8',
      '__metadata:\n' +
      '  version: 8\n' +
      '  cacheKey: 10c0\n\n' +
      '"app@workspace:.":\n' +
      '  version: 0.0.0-use.local\n' +
      '  resolution: "app@workspace:."\n' +
      '  dependencies:\n' +
      '    native-host: "npm:1.0.0"\n' +
      '  languageName: unknown\n' +
      '  linkType: soft\n\n' +
      '"native-host@npm:1.0.0":\n' +
      '  version: 1.0.0\n' +
      '  resolution: "native-host@npm:1.0.0"\n' +
      `  checksum: 10c0/${'b'.repeat(128)}\n` +
      '  languageName: node\n' +
      '  linkType: hard\n',
    )
    const nativeHost: PackumentVersion = {
      name: 'native-host',
      version: '1.0.0',
      optionalDependencies: { fsevents: 'npm:2.3.3' },
    }
    const fsevents: PackumentVersion = {
      name: 'fsevents',
      version: '2.3.3',
      os: ['darwin'],
      tarball: 'https://registry.npmjs.org/fsevents/-/fsevents-2.3.3.tgz',
    }
    const packs: Record<string, Packument> = {
      'native-host': {
        name: 'native-host',
        distTags: { latest: '1.0.0' },
        versions: { '1.0.0': nativeHost },
      },
      fsevents: {
        name: 'fsevents',
        distTags: { latest: '2.3.3' },
        versions: { '2.3.3': fsevents },
      },
    }
    const registry: RegistryAdapter = {
      async packument(name) {
        return packs[name]
      },
      async resolve(name, range) {
        const packument = packs[name]
        if (packument === undefined) return undefined
        return packument.versions[range.replace(/^npm:/, '')]
          ?? Object.values(packument.versions)[0]
      },
    }

    const completed = await completeTransitives(source, registry)
    expect(completed.added).toEqual(['fsevents@2.3.3'])
    expect(completed.graph.out('fsevents@2.3.3')).toEqual([])

    const refurbished = await refurbish(
      completed.graph,
      'yarn-berry-v8',
      {
        async tarball() {
          return undefined
        },
        async berryChecksum(name) {
          return name === 'fsevents' ? 'c'.repeat(128) : undefined
        },
      },
      { cacheKey: '10c0' },
    )
    const identity = yarnBerryBuiltinCompatIdentityOfResolution(
      yarnBerryFseventsCompatResolution(),
    )!
    const patchId = serializeNodeId('fsevents', '2.3.3', [], identity.patch)
    expect(refurbished.graph.getNode(patchId)).toBeUndefined()

    const projected = stringifyProjected('yarn-berry-v8', refurbished.graph)
    expect(projected.diagnostics).toContainEqual(expect.objectContaining({
      code: 'COMPLETENESS_TARGET_COMPATIBILITY_OVERLAY_REQUIRED',
      subject: 'fsevents@2.3.3',
      data: expect.objectContaining({
        feature: 'target-compatibility-overlay',
        derivedSibling: patchId,
        api: 'enrich',
      }),
    }))
    expect(projected.diagnostics.some(diagnostic =>
      diagnostic.code === 'COMPLETENESS_OUTPUT_GRAPH_MISMATCH')).toBe(false)
    expect(projected.losses).toContainEqual(expect.objectContaining({
      class: 'enrichable',
      feature: 'target-compatibility-overlay',
      diagnostic: expect.objectContaining({
        code: 'COMPLETENESS_TARGET_COMPATIBILITY_OVERLAY_REQUIRED',
      }),
    }))

    let error: unknown
    try {
      stringify('yarn-berry-v8', refurbished.graph)
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(LockfileError)
    expect((error as LockfileError).code).toBe('ENRICH_REQUIRED')
    expect((error as Error).message).toContain('use enrich()')

    const profiled = stringifyProjected('yarn-berry-v8', refurbished.graph, {
      targetVersion: '4.13.0',
    })
    expect(profiled.diagnostics).toContainEqual(expect.objectContaining({
      code: 'COMPLETENESS_TARGET_COMPATIBILITY_OVERLAY_REQUIRED',
      message: expect.stringContaining('target-compatibility overlay did not run'),
      data: expect.objectContaining({ managerVersion: '4.13.0' }),
    }))

    const unprofiled = stringifyProjected('yarn-berry-v8', refurbished.graph, {
      targetVersion: '4.12.0',
    })
    expect(unprofiled.diagnostics.some(diagnostic =>
      diagnostic.code === 'COMPLETENESS_TARGET_COMPATIBILITY_OVERLAY_REQUIRED')).toBe(false)
    expect(unprofiled.diagnostics.some(diagnostic =>
      diagnostic.code === 'COMPLETENESS_OUTPUT_GRAPH_MISMATCH')).toBe(false)
    expect(unprofiled.losses).toEqual([])
  })
})
