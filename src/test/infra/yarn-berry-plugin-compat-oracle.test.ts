import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { newBuilder, type Graph } from '../../main/ts/graph.ts'
import { enrich } from '../../main/ts/enrich/facade.ts'
import type { Packument, PackumentVersion, RegistryAdapter } from '../../main/ts/registry/types.ts'
import type { TarballSource } from '../../main/ts/enrich/refurbish.ts'
import * as yarnBerryV8 from '../../main/ts/formats/yarn-berry-v8.ts'
import * as yarnBerryV9 from '../../main/ts/formats/yarn-berry-v9.ts'
import {
  createNativeLock,
  FROZEN_ORACLE_MATRIX,
  runFrozenOracle,
  type FrozenOracleAdapter,
  type FrozenOracleCandidate,
} from '../helpers/frozen-oracle.ts'
import {
  startFrozenRegistry,
  stopFrozenRegistry,
  type FrozenRegistryProcess,
} from '../helpers/frozen-registry-process.ts'

const here = dirname(fileURLToPath(import.meta.url))
const tarballPath = resolve(here, '../resources/fixtures/tarballs/ms-2.1.3.tgz')
const resolveTarballPath = resolve(
  here,
  '../resources/fixtures/tarballs/resolve-1.22.8.tgz',
)
const typescriptTarballPath = resolve(
  here,
  '../resources/fixtures/tarballs/typescript-5.6.2.tgz',
)
const registryScript = resolve(here, '../helpers/frozen-registry.mjs')
const tarballBytes = readFileSync(tarballPath)
const resolveTarballBytes = readFileSync(resolveTarballPath)
const typescriptTarballBytes = readFileSync(typescriptTarballPath)
const fseventsVersions = ['2.3.2', '2.3.3'] as const
type FseventsVersion = typeof fseventsVersions[number]
const fseventsSource = `/*
 ** © 2020 by Philipp Dunkel, Ben Noordhuis, Elan Shankar, Paul Miller
 ** Licensed under MIT License.
 */

/* jshint node:true */
"use strict";

if (process.platform !== "darwin") {
  throw new Error(\`Module 'fsevents' is not compatible with platform '\${process.platform}'\`);
}

const Native = require("./fsevents.node");
const events = Native.constants;

function watch(path, since, handler) {
  if (typeof path !== "string") {
    throw new TypeError(\`fsevents argument 1 must be a string and not a \${typeof path}\`);
  }
  if ("function" === typeof since && "undefined" === typeof handler) {
    handler = since;
    since = Native.flags.SinceNow;
  }
  if (typeof since !== "number") {
    throw new TypeError(\`fsevents argument 2 must be a number and not a \${typeof since}\`);
  }
  if (typeof handler !== "function") {
    throw new TypeError(\`fsevents argument 3 must be a function and not a \${typeof handler}\`);
  }

  let instance = Native.start(Native.global, path, since, handler);
  if (!instance) throw new Error(\`could not watch: \${path}\`);
  return () => {
    const result = instance ? Promise.resolve(instance).then(Native.stop) : Promise.resolve(undefined);
    instance = undefined;
    return result;
  };
}

function getInfo(path, flags) {
  return {
    path,
    flags,
    event: getEventType(flags),
    type: getFileType(flags),
    changes: getFileChanges(flags),
  };
}

function getFileType(flags) {
  if (events.ItemIsFile & flags) return "file";
  if (events.ItemIsDir & flags) return "directory";
  if (events.MustScanSubDirs & flags) return "directory"; 
  if (events.ItemIsSymlink & flags) return "symlink";
}
function anyIsTrue(obj) {
  for (let key in obj) {
    if (obj[key]) return true;
  }
  return false;
}
function getEventType(flags) {
  if (events.ItemRemoved & flags) return "deleted";
  if (events.ItemRenamed & flags) return "moved";
  if (events.ItemCreated & flags) return "created";
  if (events.ItemModified & flags) return "modified";
  if (events.RootChanged & flags) return "root-changed";
  if (events.ItemCloned & flags) return "cloned";
  if (anyIsTrue(flags)) return "modified";
  return "unknown";
}
function getFileChanges(flags) {
  return {
    inode: !!(events.ItemInodeMetaMod & flags),
    finder: !!(events.ItemFinderInfoMod & flags),
    access: !!(events.ItemChangeOwner & flags),
    xattrs: !!(events.ItemXattrMod & flags),
  };
}

exports.watch = watch;
exports.getInfo = getInfo;
exports.constants = events;
`

function ustarFile(name: string, data: Buffer): Buffer {
  const header = Buffer.alloc(512)
  header.write(name, 0, 'utf8')
  header.write('0000644\0', 100)
  header.write('0000000\0', 108)
  header.write('0000000\0', 116)
  header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124)
  header.write('00000000000\0', 136)
  header.fill(0x20, 148, 156)
  header.write('0', 156)
  header.write('ustar\0', 257)
  header.write('00', 263)
  header.write('root', 265)
  header.write('root', 297)
  const checksum = header.reduce((sum, byte) => sum + byte, 0)
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148)
  return Buffer.concat([
    header,
    data,
    Buffer.alloc(Math.ceil(data.length / 512) * 512 - data.length),
  ])
}

function fseventsTarball(version: FseventsVersion): Buffer {
  const manifest = `${JSON.stringify({
    name: 'fsevents',
    version,
    main: 'fsevents.js',
    os: ['darwin'],
  }, null, 2)}\n`
  return gzipSync(Buffer.concat([
    ustarFile('package/package.json', Buffer.from(manifest)),
    ustarFile('package/fsevents.js', Buffer.from(fseventsSource)),
    Buffer.alloc(1024),
  ]))
}

const fseventsTarballs = new Map<FseventsVersion, Buffer>(
  fseventsVersions.map(version => [version, fseventsTarball(version)]),
)

interface CompatOracleCase {
  readonly name: string
  readonly version: string
  readonly source: string
  readonly locatorHash: string
  readonly rootKind: 'dep' | 'optional'
  readonly tarball: Buffer
  readonly manifest: Omit<PackumentVersion, 'name' | 'version'>
  readonly patchChecksum?: string
}

const compatCases: readonly CompatOracleCase[] = Object.freeze([
  ...fseventsVersions.map(version => Object.freeze({
    name: 'fsevents',
    version,
    source: 'optional!builtin<compat/fsevents>',
    locatorHash: 'df0bf1',
    rootKind: 'optional' as const,
    tarball: fseventsTarballs.get(version)!,
    manifest: Object.freeze({ os: ['darwin'] }),
  })),
  Object.freeze({
    name: 'resolve',
    version: '1.22.8',
    source: 'optional!builtin<compat/resolve>',
    locatorHash: 'c3c19d',
    rootKind: 'dep' as const,
    tarball: resolveTarballBytes,
    manifest: Object.freeze({
      dependencies: Object.freeze({
        'is-core-module': '^2.13.0',
        'path-parse': '^1.0.7',
        'supports-preserve-symlinks-flag': '^1.0.0',
      }),
      bin: Object.freeze({ resolve: 'bin/resolve' }),
    }),
    patchChecksum: '0446f024439cd2e50c6c8fa8ba77eaa8370b4180f401a96abf3d1ebc770ac51c1955e12764cde449fde3fff480a61f84388e3505ecdbab778f4bef5f8212c729',
  }),
  Object.freeze({
    name: 'typescript',
    version: '5.6.2',
    source: 'optional!builtin<compat/typescript>',
    locatorHash: '8c6c40',
    rootKind: 'dep' as const,
    tarball: typescriptTarballBytes,
    manifest: Object.freeze({
      bin: Object.freeze({
        tsc: 'bin/tsc',
        tsserver: 'bin/tsserver',
      }),
    }),
    patchChecksum: '94eb47e130d3edd964b76da85975601dcb3604b0c848a36f63ac448d0104e93819d94c8bdf6b07c00120f2ce9c05256b8b6092d23cf5cf1c6fa911159e4d572f',
  }),
])

const dependencyFixtures = Object.freeze({
  'is-core-module': Object.freeze({ version: '2.13.1', range: '^2.13.0' }),
  'path-parse': Object.freeze({ version: '1.0.7', range: '^1.0.7' }),
  'supports-preserve-symlinks-flag': Object.freeze({
    version: '1.0.0',
    range: '^1.0.0',
  }),
  'node-gyp': Object.freeze({ version: '11.5.0', range: 'npm:latest' }),
})
let registryProcess: FrozenRegistryProcess | undefined
let registryFixtureRoot: string | undefined

interface BerryAdapter {
  readonly native: FrozenOracleAdapter
  parse(input: string): Graph
  stringify(graph: Graph): string
  optimize(graph: Graph): { graph: Graph }
}

function fixtureTgzIntegrity(
  bytes: Buffer,
): NonNullable<PackumentVersion['integrity']> {
  return {
    hashes: [{
      algorithm: 'sha512',
      digest: createHash('sha512').update(bytes).digest('hex'),
      origin: 'registry',
    }],
  }
}

const adapters: readonly BerryAdapter[] = [
  {
    native: FROZEN_ORACLE_MATRIX.find(entry => entry.alias === 'pm-yarn-berry-v8')!,
    parse: yarnBerryV8.parse,
    stringify: yarnBerryV8.stringify,
    optimize: yarnBerryV8.optimize,
  },
  {
    native: FROZEN_ORACLE_MATRIX.find(entry => entry.alias === 'pm-yarn-berry-v9')!,
    parse: yarnBerryV9.parse,
    stringify: yarnBerryV9.stringify,
    optimize: yarnBerryV9.optimize,
  },
]

beforeAll(async () => {
  registryFixtureRoot = mkdtempSync(resolve(tmpdir(), 'lockgraph-fsevents-registry-'))
  const fsevents233TarballPath = resolve(registryFixtureRoot, 'fsevents-2.3.3.tgz')
  const fsevents232TarballPath = resolve(registryFixtureRoot, 'fsevents-2.3.2.tgz')
  writeFileSync(fsevents233TarballPath, fseventsTarballs.get('2.3.3')!)
  writeFileSync(fsevents232TarballPath, fseventsTarballs.get('2.3.2')!)
  registryProcess = await startFrozenRegistry(registryScript, [
    tarballPath,
    fsevents233TarballPath,
    fsevents232TarballPath,
    resolveTarballPath,
    typescriptTarballPath,
  ])
  if (registryProcess.registry !== undefined) {
    process.env.LOCKGRAPH_TEST_REGISTRY = registryProcess.registry
  }
})

beforeEach(context => {
  if (registryProcess?.unavailableReason !== undefined) {
    context.skip(registryProcess.unavailableReason)
  }
})

afterAll(async () => {
  delete process.env.LOCKGRAPH_TEST_REGISTRY
  await stopFrozenRegistry(registryProcess?.child)
  if (registryFixtureRoot !== undefined) rmSync(registryFixtureRoot, { recursive: true, force: true })
})

function projectFiles(
  adapter: FrozenOracleAdapter,
  profile: CompatOracleCase,
): Readonly<Record<string, string>> {
  const dependencyField = profile.rootKind === 'optional'
    ? 'optionalDependencies'
    : 'dependencies'
  return {
    'package.json': `${JSON.stringify({
      name: 'lockgraph-builtin-compat-oracle',
      version: '1.0.0',
      private: true,
      packageManager: `yarn@${adapter.version}`,
      [dependencyField]: { [profile.name]: profile.version },
    }, null, 2)}\n`,
    '.yarnrc.yml': [
      'nodeLinker: node-modules',
      'enableScripts: false',
      'unsafeHttpWhitelist:',
      '  - 127.0.0.1',
      '',
    ].join('\n'),
  }
}

function sourceGraph(adapter: BerryAdapter, profile: CompatOracleCase): Graph {
  const builder = newBuilder()
  builder.addNode({
    id: 'lockgraph-builtin-compat-oracle@0.0.0-use.local',
    name: 'lockgraph-builtin-compat-oracle',
    version: '0.0.0-use.local',
    peerContext: [],
    workspacePath: '',
  })
  builder.addNode({
    id: `${profile.name}@${profile.version}`,
    name: profile.name,
    version: profile.version,
    peerContext: [],
  })
  builder.addEdge(
    'lockgraph-builtin-compat-oracle@0.0.0-use.local',
    `${profile.name}@${profile.version}`,
    profile.rootKind,
    { range: `npm:${profile.version}` },
  )
  builder.setTarball(
    { name: profile.name, version: profile.version },
    {
      ...profile.manifest,
      cpu: profile.manifest.cpu === undefined ? undefined : [...profile.manifest.cpu],
      os: profile.manifest.os === undefined ? undefined : [...profile.manifest.os],
      libc: profile.manifest.libc === undefined ? undefined : [...profile.manifest.libc],
      bundledDependencies: profile.manifest.bundledDependencies === undefined
        ? undefined
        : [...profile.manifest.bundledDependencies],
    },
  )
  const lockfile = adapter.stringify(builder.seal()).replace(
    /^(__metadata:\n  version: \d+\n)/m,
    '$1  cacheKey: 10c0\n',
  )
  const parsed = adapter.parse(lockfile)
  const inputs = { name: profile.name, version: profile.version }
  return parsed.mutate(mutator => {
    mutator.setTarball(inputs, {
      ...parsed.tarball(inputs),
      integrity: fixtureTgzIntegrity(profile.tarball),
    })
  }).graph
}

function sources(profile: CompatOracleCase): Readonly<{
  registry: RegistryAdapter
  artifacts: TarballSource
}> {
  const primary: PackumentVersion = {
    name: profile.name,
    version: profile.version,
    ...profile.manifest,
    integrity: fixtureTgzIntegrity(profile.tarball),
  }
  const versions: Record<string, PackumentVersion> = {
    [profile.name]: primary,
    ...Object.fromEntries(Object.entries(dependencyFixtures).map(([name, fixture]) => [
      name,
      {
        name,
        version: fixture.version,
        integrity: fixtureTgzIntegrity(tarballBytes),
      },
    ])),
  }
  const packs: Record<string, Packument> = Object.fromEntries(
    Object.entries(versions).map(([name, value]) => [name, {
      name,
      distTags: { latest: value.version },
      versions: { [value.version]: value },
    }]),
  )
  return {
    registry: {
      async packument(name) {
        return packs[name]
      },
      async resolve(name, range) {
        const fixture = dependencyFixtures[name as keyof typeof dependencyFixtures]
        return fixture !== undefined && fixture.range === range
          ? versions[name]
          : undefined
      },
    },
    artifacts: {
      async tarball(name, version) {
        if (name === profile.name && version === profile.version) return profile.tarball
        const fixture = dependencyFixtures[name as keyof typeof dependencyFixtures]
        if (fixture?.version === version) return tarballBytes
        return undefined
      },
    },
  }
}

function packageSubtree(lockfile: string, packageName: string): string {
  const lines = lockfile.split('\n')
  const blocks: string[] = []
  for (let index = 0; index < lines.length; index++) {
    if (!lines[index]!.startsWith(`"${packageName}@`)) continue
    const block = [lines[index]!]
    for (index++; index < lines.length && (lines[index] === '' || lines[index]!.startsWith('  ')); index++) {
      block.push(lines[index]!)
    }
    index--
    blocks.push(block.join('\n').trimEnd())
  }
  return blocks.join('\n\n')
}

// `concurrent: false` rather than the removed `describe.sequential` (vitest 5 dropped
// `sequential` from both the chain and SuiteOptions, leaving only `concurrent`).
// Sequential is the default, but these cases each drive a real yarn binary against a
// shared cache, so the intent is stated rather than inherited.
describe('infra: Yarn Berry builtin-compat family oracle', { concurrent: false }, () => {
  for (const adapter of adapters) {
    for (const profile of compatCases) {
      it(`${adapter.native.alias} reproduces ${profile.name}@${profile.version} and accepts --immutable unchanged`, async () => {
        const files = projectFiles(adapter.native, profile)
        const native = createNativeLock(adapter.native, files)
        const dependencyField = profile.rootKind === 'optional'
          ? 'optionalDependencies'
          : 'dependencies'
        const result = await enrich(sourceGraph(adapter, profile), {
          ...sources(profile),
          manifests: {
            '': {
              name: 'lockgraph-builtin-compat-oracle',
              version: '1.0.0',
              [dependencyField]: { [profile.name]: profile.version },
              overrides: [],
            },
          },
        }, {
          store: false,
          target: {
            format: adapter.native.format,
            managerVersion: adapter.native.version,
          },
          contract: 'snapshot',
          cacheKey: '10c0',
        })
        const lockfile = adapter.stringify(adapter.optimize(result.graph).graph)
        const nativeLockfile = String(native['yarn.lock'])
        const subtree = packageSubtree(lockfile, profile.name)

        expect(subtree).toBe(packageSubtree(nativeLockfile, profile.name))
        expect(lockfile).toBe(nativeLockfile)
        expect(subtree).toContain(
          `version=${profile.version}&hash=${profile.locatorHash}`,
        )
        expect(subtree.match(/checksum:/g)?.length).toBe(
          profile.patchChecksum === undefined ? 1 : 2,
        )
        if (profile.name === 'fsevents') {
          expect(subtree).toContain('node-gyp: "npm:latest"')
        }
        if (profile.name === 'resolve') {
          expect(subtree).toContain('is-core-module: "npm:^2.13.0"')
          expect(subtree).toContain(`checksum: 10c0/${profile.patchChecksum}`)
        }
        if (profile.name === 'typescript') {
          expect(subtree).toContain(`checksum: 10c0/${profile.patchChecksum}`)
        }

        const projectionDigest = `sha256:${createHash('sha256').update(JSON.stringify({
          target: {
            format: adapter.native.format,
            managerVersion: adapter.native.version,
          },
          lockfile,
          companions: [],
        })).digest('hex')}`
        const candidate: FrozenOracleCandidate = Object.freeze({
          protocol: 'lockgraph-frozen-projection/v1',
          target: Object.freeze({
            format: adapter.native.format,
            managerVersion: adapter.native.version,
          }),
          projectionDigest,
          lockfile,
          companions: Object.freeze([]),
        })
        const oracle = runFrozenOracle(candidate, adapter.native, files)
        expect(oracle.reason).toBeUndefined()
        expect(oracle.receipt).toMatchObject({
          target: candidate.target,
          projectionDigest,
          verification: 'frozen-verified',
        })
      }, 60_000)
    }
  }
})
