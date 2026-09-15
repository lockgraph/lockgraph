// Whole-0.6 operation-spine contract, measured after the source/store boundary.
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as publicApi from '../../main/ts/index.ts'
import {
  complete,
  certifyFrozen,
  convert,
  enrich,
  modify,
  parse,
  prepareFrozen,
  stringify,
} from '../../main/ts/index.ts'
import type { Diagnostic } from '../../main/ts/graph.ts'
import { addEdge, addPackage, graphOf } from './_modify-test-utils.ts'
import {
  artifactStore,
  lockgraphStore,
} from '../../main/ts/enrich/artifact-store.ts'
import { normalizeArtifactSources } from '../../main/ts/enrich/artifact-sources.ts'
import type { EnrichOptions } from '../../main/ts/enrich/facade.ts'
import type { ConvertOptions } from '../../main/ts/convert/types.ts'
import { pruneOrphans } from '../../main/ts/optimize/prune.ts'
import type {
  Packument,
  PackumentVersion,
  RegistryAdapter,
  RemoteArtifactRegistry,
} from '../../main/ts/registry/types.ts'

const roots: string[] = []

afterEach(() => {
  vi.unstubAllEnvs()
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function freshDir(prefix: string): string {
  const root = mkdtempSync(resolve(tmpdir(), prefix))
  roots.push(root)
  return root
}

function filesUnder(path: string): string[] {
  if (!existsSync(path)) return []
  return readdirSync(path, { withFileTypes: true }).flatMap(entry => {
    const child = resolve(path, entry.name)
    return entry.isDirectory() ? filesUnder(child) : [child]
  })
}

function tarballOf(text = 'module.exports = 1\n'): Uint8Array {
  const body = Buffer.from(text)
  const header = Buffer.alloc(512)
  header.write('package/index.js', 0, 'utf8')
  header.write('0000644\0', 100, 'ascii')
  header.write('0000000\0', 108, 'ascii')
  header.write('0000000\0', 116, 'ascii')
  header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124, 'ascii')
  header.write('00000000000\0', 136, 'ascii')
  header.fill(0x20, 148, 156)
  header[156] = '0'.charCodeAt(0)
  header.write('ustar\0', 257, 'ascii')
  header.write('00', 263, 'ascii')
  const checksum = [...header].reduce((sum, byte) => sum + byte, 0)
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii')
  const padding = Buffer.alloc((512 - (body.length % 512)) % 512)
  return new Uint8Array(gzipSync(Buffer.concat([
    header,
    body,
    padding,
    Buffer.alloc(1024),
  ])))
}

function sri(bytes: Uint8Array): string {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`
}

function npmLock(bytes: Uint8Array): string {
  return `${JSON.stringify({
    name: 'fixture',
    version: '1.0.0',
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': {
        name: 'fixture',
        version: '1.0.0',
        dependencies: { pkg: '1.0.0' },
      },
      'node_modules/pkg': {
        version: '1.0.0',
        resolved: 'https://registry.test/npm/pkg/-/pkg-1.0.0.tgz',
        integrity: sri(bytes),
      },
    },
  }, null, 2)}\n`
}

function remote(bytes: Uint8Array): Readonly<{
  registry: RemoteArtifactRegistry
  fetch: ReturnType<typeof vi.fn>
}> {
  const tarball = 'https://registry.test/npm/pkg/-/pkg-1.0.0.tgz'
  const version: PackumentVersion = {
    name: 'pkg',
    version: '1.0.0',
    tarball,
  }
  const packument: Packument = {
    name: 'pkg',
    distTags: {},
    versions: { '1.0.0': version },
  }
  const fetchSpy = vi.fn(async () => new Response(bytes))
  const registry: RemoteArtifactRegistry = {
    async packument() { return packument },
    async resolve() { return version },
    artifactRoute(name: string) {
      return {
        registryUrl: 'https://registry.test/npm',
        fetch: fetchSpy as unknown as typeof fetch,
        authHeaderFor: () => undefined,
        limit: <T,>(task: () => Promise<T>) => task(),
        name,
      }
    },
  }
  return { registry, fetch: fetchSpy }
}

function output(result: Awaited<ReturnType<typeof enrich>>): string {
  return stringify('yarn-berry-v8', result.graph, { strict: false })
}

async function enrichNext(
  lockfile: string,
  options: Omit<EnrichOptions, 'target' | 'contract'>,
) {
  return enrich(parse('npm-3', lockfile), {
    target: 'yarn-berry-v8',
    contract: 'snapshot',
    cacheKey: '10c0',
    ...options,
  })
}

async function convertNext(
  lockfile: string,
  options: Omit<Extract<ConvertOptions, { target: unknown }>, 'target'>,
) {
  return convert(lockfile, {
    target: 'yarn-berry-v8',
    strict: false,
    cacheKey: '10c0',
    ...options,
  })
}

describe('0.6 operation spine — public declaration', () => {
  it('exposes exactly the ratified root runtime facade', () => {
    expect(Object.keys(publicApi).sort()).toEqual([
      'LockfileError',
      'assertSource',
      'certifyFrozen',
      'check',
      'complete',
      'convert',
      'defaultFetch',
      'detect',
      'engines',
      'enrich',
      'frozenRegistry',
      'license',
      'liveRegistry',
      'lockgraphStore',
      'modify',
      'overrideSource',
      'parse',
      'parseSourceRule',
      'prepareFrozen',
      'refurbish',
      'removeUnreachable',
      'resolveRegistry',
      'selectConstrained',
      'stringify',
    ])
  })

  it('exports the complete common spine with implementable types', () => {
    const root = process.cwd()
    const directory = resolve(root, 'target', 'operation-spine-contract')
    rmSync(directory, { recursive: true, force: true })
    mkdirSync(directory, { recursive: true })
    const file = resolve(directory, 'contract.ts')
    writeFileSync(file, `
import { lockgraphStore } from '../../src/main/ts/index.ts'
import type {
  ArtifactSource, ByteSize, DiagnosticCode, DiagnosticObserver,
  DiagnosticSeverity, FileSource, GraphOperationResult, GuardProfile,
  ObserveOptions, OperationOptions, OperationResult, OperationSources,
  PackageManager, Resolution, Store, TargetRequest,
} from '../../src/main/ts/index.ts'
const size: ByteSize = '384 MiB'
const source: ArtifactSource = 'npm'
const fileSource: FileSource = { 'package.json': '{}' }
const severity: DiagnosticSeverity = 'warning'
const code: DiagnosticCode = 'STORE_PATH_RESOLVED'
const observer: DiagnosticObserver = diagnostic => void diagnostic
const observe: ObserveOptions = { onDiagnostic: observer }
const store: Store = lockgraphStore()
// @ts-expect-error Store handles are opaque and must come from lockgraphStore()
const forgedStore: Store = { kind: 'lockgraph-artifact-store', path: '/tmp/store', maxBytes: 1 }
const berryTarget: TargetRequest = { format: 'yarn-berry-v10', cacheKey: '10c0' }
// @ts-expect-error cacheKey belongs only to Yarn Berry targets
const npmTarget: TargetRequest = { format: 'npm-3', cacheKey: '10c0' }
const sources: OperationSources = { artifacts: [source], manifests: fileSource }
const guards: readonly GuardProfile[] = [{ artifactCompressed: size }]
declare const operation: OperationOptions
declare const result: OperationResult
declare const graphResult: GraphOperationResult
declare const manager: PackageManager
declare const resolution: Resolution
void [severity, code, observe, store, forgedStore, berryTarget, npmTarget, sources, guards, operation, result, graphResult, manager, resolution]
`)
    const tsc = resolve(root, 'node_modules', 'typescript', 'bin', 'tsc')
    const compiled = spawnSync(process.execPath, [
      tsc,
      '--ignoreConfig',
      '--pretty', 'false',
      '--strict',
      '--target', 'ES2022',
      '--module', 'NodeNext',
      '--moduleResolution', 'NodeNext',
      '--types', 'node',
      '--skipLibCheck',
      '--allowImportingTsExtensions',
      '--noEmit',
      file,
    ], { cwd: root, encoding: 'utf8' })
    expect(`${compiled.stdout}${compiled.stderr}`).toBe('')
    expect(compiled.status).toBe(0)
  })

  it('exports the lockgraphStore constructor at root', () => {
    expect((publicApi as Record<string, unknown>).lockgraphStore)
      .toBeTypeOf('function')
  })
})

describe('0.6 operation spine — modify', () => {
  it('applies an ordered batch and collects one authoritative result', async () => {
    const graph = graphOf(builder => {
      const workspace = addPackage(builder, {
        name: 'app',
        version: '0.0.0',
        workspacePath: '.',
      })
      const first = addPackage(builder, { name: 'first', version: '1.0.0' })
      const second = addPackage(builder, { name: 'second', version: '1.0.0' })
      addEdge(builder, workspace, first, 'dep')
      addEdge(builder, workspace, second, 'dev')
    })
    const observed: Diagnostic[] = []

    const result = await modify(graph, [
      { kind: 'removeDependency', parent: 'app@0.0.0', name: 'first' },
      { kind: 'removeDependency', parent: 'app@0.0.0', name: 'second', edge: 'dev' },
    ], {
      target: 'lockgraph',
      onDiagnostic: diagnostic => observed.push(diagnostic),
    })

    expect([...result.graph.nodes()].map(node => node.name)).toEqual(['app'])
    expect(result.diagnostics).toEqual(observed)
    expect(result.frontier.added).toEqual(new Set())
    expect(result.frontier.orphaned).toEqual(new Set([
      'first@1.0.0',
      'second@1.0.0',
    ]))
    expect(result.applied).toEqual(expect.arrayContaining([
      { kind: 'node-removed', subject: 'first@1.0.0' },
      { kind: 'node-removed', subject: 'second@1.0.0' },
    ]))
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.diagnostics)).toBe(true)
    expect(Object.isFrozen(result.applied)).toBe(true)
  })

  it('derives a live orphan seed from the whole operation', async () => {
    const graph = graphOf(builder => {
      const workspace = addPackage(builder, {
        name: 'app',
        version: '0.0.0',
        workspacePath: '.',
      })
      const old = addPackage(builder, { name: 'pkg', version: '1.0.0' })
      const target = addPackage(builder, { name: 'pkg', version: '2.0.0' })
      const child = addPackage(builder, { name: 'child', version: '1.0.0' })
      const leaf = addPackage(builder, { name: 'leaf', version: '1.0.0' })
      addEdge(builder, workspace, old, 'dep', '^1.0.0')
      addEdge(builder, workspace, target, 'dev', '2.0.0')
      addEdge(builder, old, child, 'dep', '1.0.0')
      addEdge(builder, child, leaf, 'dep', '1.0.0')
    })
    const version: PackumentVersion = {
      name: 'pkg',
      version: '2.0.0',
    }
    const registry: RegistryAdapter = {
      async packument() {
        return { name: 'pkg', distTags: {}, versions: { '2.0.0': version } }
      },
      async resolve() { return version },
    }

    const result = await modify(graph, {
      kind: 'replaceVersion',
      selector: { name: 'pkg', fromRange: '1.0.0' },
      to: '2.0.0',
    }, {
      target: 'lockgraph',
      sources: { packuments: [registry] },
    })

    expect(result.graph.getNode('pkg@1.0.0')).toBeUndefined()
    expect(result.frontier.added).toEqual(new Set(['pkg@2.0.0']))
    expect(result.frontier.orphaned).toEqual(new Set(['pkg@1.0.0', 'child@1.0.0']))
    const pruned = pruneOrphans(result.graph, { seed: result.frontier.orphaned })
    expect(pruned.removed).toEqual(['child@1.0.0', 'leaf@1.0.0'])
  })

  it('seeds completion when a merge target already has consumers', async () => {
    const graph = graphOf(builder => {
      const workspace = addPackage(builder, {
        name: 'app',
        version: '0.0.0',
        workspacePath: '.',
      })
      const old = addPackage(builder, { name: 'pkg', version: '1.0.0' })
      const target = addPackage(builder, { name: 'pkg', version: '2.0.0' })
      addEdge(builder, workspace, old, 'dep', '^1.0.0')
      addEdge(builder, workspace, target, 'dev', '2.0.0')
    })
    const versions: Record<string, PackumentVersion> = {
      pkg: { name: 'pkg', version: '2.0.0', dependencies: { child: '1.0.0' } },
      child: { name: 'child', version: '1.0.0' },
    }
    const registry: RegistryAdapter = {
      async packument(name) {
        const version = versions[name]
        return version === undefined
          ? undefined
          : { name, distTags: {}, versions: { [version.version]: version } }
      },
      async resolve(name) { return versions[name] },
    }
    const modified = await modify(graph, {
      kind: 'replaceVersion',
      selector: { name: 'pkg', fromRange: '1.0.0' },
      to: '2.0.0',
    }, {
      target: 'lockgraph',
      sources: { packuments: [registry] },
    })

    expect(modified.frontier.added).toEqual(new Set(['pkg@2.0.0']))
    const completed = await complete(modified.graph, {
      target: 'lockgraph',
      sources: { packuments: [registry] },
      seed: modified.frontier,
    })
    expect(completed.graph.byName('child')).toEqual(['child@1.0.0'])
  })

  it('retains full-packument funding/license while Yarn classifies their omission', async () => {
    const graph = graphOf(builder => {
      const project = addPackage(builder, { name: 'app', version: '0.0.0' })
      const old = addPackage(builder, { name: 'pkg', version: '1.0.0' })
      addEdge(builder, project, old, 'dep', '^1.0.0')
    })
    const version: PackumentVersion = {
      name: 'pkg',
      version: '2.0.0',
      integrity: {
        hashes: [{ algorithm: 'sha512', digest: 'ef'.repeat(64), origin: 'sri' }],
      },
      // Funding/license projection is under test here; use the bare public
      // registry class so this fixture does not also invent a +src identity.
      tarball: 'https://registry.npmjs.org/pkg/-/pkg-2.0.0.tgz',
      funding: { url: 'https://example.test/fund' },
      license: 'MIT',
    }
    const registry: RegistryAdapter = {
      async packument() {
        return { name: 'pkg', distTags: {}, versions: { '2.0.0': version } }
      },
      async resolve() { return version },
    }

    const result = await modify(graph, {
      kind: 'replaceVersion',
      selector: { name: 'pkg' },
      to: '2.0.0',
    }, {
      target: 'yarn-classic',
      sources: { packuments: [registry] },
    })

    expect(result.graph.tarball({ name: 'pkg', version: '2.0.0' })).toEqual(
      expect.objectContaining({ funding: version.funding, license: version.license }),
    )
    expect(() => stringify('yarn-classic', result.graph)).not.toThrow()
  })
})

describe('0.6 operation spine — complete', () => {
  it('uses ordered packument authority and returns collected diagnostics', async () => {
    const graph = graphOf(builder => {
      const workspace = addPackage(builder, {
        name: 'app',
        version: '0.0.0',
        workspacePath: '.',
      })
      const foo = addPackage(builder, { name: 'foo', version: '1.0.0' })
      addEdge(builder, workspace, foo, 'dep', '1.0.0')
    })
    const versions: Record<string, PackumentVersion> = {
      foo: { name: 'foo', version: '1.0.0', dependencies: { bar: '1.0.0' } },
      bar: { name: 'bar', version: '1.0.0' },
    }
    const registry: RegistryAdapter = {
      async packument(name) {
        const version = versions[name]
        return version === undefined
          ? undefined
          : { name, distTags: {}, versions: { [version.version]: version } }
      },
      async resolve(name) { return versions[name] },
    }
    const observed: Diagnostic[] = []

    const result = await complete(graph, {
      target: 'lockgraph',
      sources: { packuments: [registry] },
      onDiagnostic: diagnostic => observed.push(diagnostic),
    })

    expect(result.graph.byName('bar')).toEqual(['bar@1.0.0'])
    expect(result.added).toContain('bar@1.0.0')
    expect(result.diagnostics).toEqual(observed)
    expect(result.removed).toEqual([])
    expect(Object.isFrozen(result)).toBe(true)
  })
})

describe('0.6 operation spine — artifact source admission', () => {
  it('rejects pnpm because it supplies neither retained tgz nor lock-carried checksum', () => {
    expect(() => normalizeArtifactSources(['pnpm'] as never))
      .toThrow(/retained registry tarball.*lock-carried archive checksum/i)
  })

  it('rejects persistence descriptors in the ordered artifact-source list', () => {
    const root = resolve(freshDir('lockgraph-spine-source-'), 'store')
    expect(() => normalizeArtifactSources([artifactStore({ path: root })] as never))
      .toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }))
    expect(existsSync(root)).toBe(false)
  })
})

describe('0.6 operation spine — store', () => {
  it('uses the omitted global store and reports its path exactly once before mutation', async () => {
    const xdg = freshDir('lockgraph-spine-xdg-')
    vi.stubEnv('XDG_CACHE_HOME', xdg)
    const bytes = tarballOf()
    const route = remote(bytes)
    const result = await enrichNext(npmLock(bytes), {
      sources: { artifacts: [route.registry] },
    })
    const root = resolve(xdg, 'lockgraph')
    const paths = result.diagnostics.filter(diagnostic =>
      diagnostic.code === 'STORE_PATH_RESOLVED')
    expect(paths).toEqual([
      expect.objectContaining({ data: expect.objectContaining({ path: root }) }),
    ])
    expect(existsSync(root)).toBe(true)
  })

  it('substitutes a reverified custom-store hit when ordinary sources are absent', async () => {
    const root = resolve(freshDir('lockgraph-spine-custom-'), 'store')
    const bytes = tarballOf()
    const route = remote(bytes)
    const store = lockgraphStore(root)
    const fresh = await enrichNext(npmLock(bytes), {
      store,
      sources: { artifacts: [route.registry] },
    })
    const hit = await enrichNext(npmLock(bytes), { store })
    expect(output(hit)).toBe(output(fresh))
    expect(hit.diagnostics).toEqual(fresh.diagnostics)
  })

  it('always reads a populated store before a later cold remote source', async () => {
    const root = resolve(freshDir('lockgraph-spine-priority-'), 'store')
    const bytes = tarballOf()
    const store = lockgraphStore(root)
    const warm = remote(bytes)
    await enrichNext(npmLock(bytes), {
      store,
      sources: { artifacts: [warm.registry] },
    })
    const cold = remote(bytes)
    cold.fetch.mockRejectedValue(new Error('cold source must not run'))
    await enrichNext(npmLock(bytes), {
      store,
      sources: { artifacts: [cold.registry] },
    })
    expect(cold.fetch).not.toHaveBeenCalled()
  })

  it('forwards a custom store through convert and reproduces source-absent bytes', async () => {
    const root = resolve(freshDir('lockgraph-spine-convert-'), 'store')
    const bytes = tarballOf()
    const route = remote(bytes)
    const store = lockgraphStore(root)
    const freshDiagnostics: Diagnostic[] = []
    const hitDiagnostics: Diagnostic[] = []
    const fresh = await convertNext(npmLock(bytes), {
      store,
      sources: { artifacts: [route.registry] },
      onDiagnostic: diagnostic => freshDiagnostics.push(diagnostic),
    })
    const hit = await convertNext(npmLock(bytes), {
      store,
      onDiagnostic: diagnostic => hitDiagnostics.push(diagnostic),
    })
    expect(hit).toBe(fresh)
    expect(hitDiagnostics).toEqual(freshDiagnostics)
  })

  it.each(['enrich', 'convert'] as const)('%s store:false performs no persistence', async operation => {
    const xdg = freshDir(`lockgraph-spine-${operation}-off-`)
    vi.stubEnv('XDG_CACHE_HOME', xdg)
    const bytes = tarballOf()
    const route = remote(bytes)
    const diagnostics: Diagnostic[] = []
    if (operation === 'enrich') {
      const result = await enrichNext(npmLock(bytes), {
        store: false,
        sources: { artifacts: [route.registry] },
        onDiagnostic: diagnostic => diagnostics.push(diagnostic),
      })
      diagnostics.push(...result.diagnostics.filter(diagnostic =>
        !diagnostics.includes(diagnostic)))
    } else {
      await convertNext(npmLock(bytes), {
        store: false,
        sources: { artifacts: [route.registry] },
        onDiagnostic: diagnostic => diagnostics.push(diagnostic),
      })
    }
    expect(existsSync(resolve(xdg, 'lockgraph'))).toBe(false)
    expect(diagnostics.map(diagnostic => diagnostic.code))
      .not.toContain('STORE_PATH_RESOLVED')
  })
})

describe('0.6 operation spine — cwd, guards, and observer', () => {
  it('returns a project lockfile and complete companion files from FileSource input', async () => {
    const lockfile = `${JSON.stringify({
      name: 'fixture',
      version: '1.0.0',
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': { name: 'fixture', version: '1.0.0' },
      },
    }, null, 2)}\n`
    const result = await convert({
      'package.json': `${JSON.stringify({
        name: 'fixture',
        version: '1.0.0',
        overrides: { foo: '1.0.0' },
      }, null, 2)}\n`,
      'package-lock.json': lockfile,
    }, {
      target: { format: 'npm-3', managerVersion: '9.9.4' },
      store: false,
      sources: {
        policy: {
          kind: 'pm-config',
          manager: 'npm',
          version: '9.9.4',
          source: 'package.json',
          surface: 'overrides',
          coverage: 'complete',
          overrides: [{ name: 'foo', to: '1.0.0' }],
        },
      },
    })
    expect(result.lockfile).toBe(lockfile)
    expect(result.companions).toEqual([{
      path: 'package.json',
      content: `${JSON.stringify({
        name: 'fixture',
        version: '1.0.0',
        overrides: { foo: '1.0.0' },
      }, null, 2)}\n`,
    }])
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.companions)).toBe(true)
  })

  it('converts an already parsed Graph without a stringify/parse detour', async () => {
    const bytes = tarballOf()
    const lockfile = npmLock(bytes)
    const options = {
      store: false,
      target: 'npm-3',
      strict: false,
    } as const
    const fromText = await convert(lockfile, options)
    const fromGraph = await convert(parse('npm-3', lockfile), options)
    expect(fromGraph).toBe(fromText)
  })

  it('uses cwd to resolve a bare Yarn cache source', async () => {
    vi.stubEnv('YARN_CACHE_FOLDER', '')
    const root = freshDir('lockgraph-spine-cwd-')
    const cache = resolve(root, '.yarn', 'cache')
    mkdirSync(cache, { recursive: true })
    writeFileSync(
      resolve(cache, 'pkg-npm-1.0.0-aaaaaaaaaa-10c0.zip'),
      new Uint8Array([1, 2, 3, 4]),
    )
    const bytes = tarballOf()
    const fromCwd = await enrichNext(npmLock(bytes), {
      cwd: root,
      store: false,
      sources: { artifacts: ['yarn-berry'] },
    })
    const explicit = await enrichNext(npmLock(bytes), {
      store: false,
      sources: { artifacts: [`yarn-berry:${cache}`] },
    })
    expect(output(fromCwd)).toBe(output(explicit))
    expect(fromCwd.diagnostics).toEqual(explicit.diagnostics)
  })

  it('enforces human-readable compressed-byte guards', async () => {
    const bytes = tarballOf()
    const route = remote(bytes)
    const result = await enrichNext(npmLock(bytes), {
      store: false,
      guards: [{ artifactCompressed: '1 B' }],
      sources: { artifacts: [route.registry] },
    })
    expect(result.diagnostics.map(diagnostic => diagnostic.code))
      .toContain('ENRICH_ARTIFACT_COMPRESSED_LIMIT')
  })

  it('rejects a fallback guard before a later patterned profile and before fetch', async () => {
    const bytes = tarballOf()
    const route = remote(bytes)
    await expect(enrichNext(npmLock(bytes), {
      store: false,
      guards: [{}, { patterns: ['pkg@1.0.0'], artifactCompressed: '1 MiB' }],
      sources: { artifacts: [route.registry] },
    })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(route.fetch).not.toHaveBeenCalled()
  })

  it('enforces the atomic cumulative network-traffic guard', async () => {
    const bytes = tarballOf()
    const route = remote(bytes)
    const root = resolve(freshDir('lockgraph-spine-traffic-'), 'store')
    const result = await enrichNext(npmLock(bytes), {
      store: lockgraphStore(root),
      guards: [{ networkTraffic: '1 B' }],
      sources: { artifacts: [route.registry] },
    })
    expect(result.diagnostics.map(diagnostic => diagnostic.code))
      .toContain('ENRICH_ARTIFACT_TRAFFIC_LIMIT')
    expect(filesUnder(resolve(root, 'objects'))).toEqual([])
    expect(filesUnder(resolve(root, 'aliases'))).toEqual([])
  })

  it('rejects Content-Length over the traffic guard before body read or store write', async () => {
    const bytes = tarballOf()
    const route = remote(bytes)
    const root = resolve(freshDir('lockgraph-spine-content-length-'), 'store')
    const getReader = vi.fn(() => {
      throw new Error('body must not be read after Content-Length refusal')
    })
    route.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-length': String(bytes.byteLength) }),
      body: { getReader },
    } as unknown as Response)
    const result = await enrichNext(npmLock(bytes), {
      store: lockgraphStore(root),
      guards: [{ networkTraffic: '1 B' }],
      sources: { artifacts: [route.registry] },
    })
    expect(result.diagnostics.map(diagnostic => diagnostic.code))
      .toContain('ENRICH_ARTIFACT_TRAFFIC_LIMIT')
    expect(getReader).not.toHaveBeenCalled()
    expect(filesUnder(resolve(root, 'objects'))).toEqual([])
    expect(filesUnder(resolve(root, 'aliases'))).toEqual([])
  })

  it('mirrors collected enrich diagnostics to the notification-only observer', async () => {
    const bytes = tarballOf()
    const observed: Diagnostic[] = []
    const result = await enrichNext(npmLock(bytes), {
      store: false,
      guards: [{ artifactCompressed: '1 B' }],
      sources: { artifacts: [remote(bytes).registry] },
      onDiagnostic: diagnostic => observed.push(diagnostic),
    })
    expect(observed).toEqual(result.diagnostics)
  })
})

describe('0.6 operation spine — frozen certification', () => {
  it('certifies only exact post-run files and the exact pinned producer', async () => {
    const lockfile = `${JSON.stringify({
      name: 'fixture',
      version: '1.0.0',
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': { name: 'fixture', version: '1.0.0' },
      },
    }, null, 2)}\n`
    const prepared = await prepareFrozen({
      'package.json': `${JSON.stringify({
        name: 'fixture',
        version: '1.0.0',
      }, null, 2)}\n`,
      'package-lock.json': lockfile,
    }, {
      target: { format: 'npm-3', managerVersion: '9.9.4' },
      store: false,
    })
    const postRunFiles = Object.fromEntries([
      ['package-lock.json', prepared.candidate.lockfile],
      ...prepared.candidate.companions.map(file => [file.path, file.content] as const),
    ])
    const certified = await certifyFrozen(prepared.candidate, {
      files: postRunFiles,
      manager: 'npm',
      version: ' v9.9.4\n',
      platform: 'test-platform',
    })

    expect(certified.lockfile).toBe(prepared.candidate.lockfile)
    expect(certified.companions).toBe(prepared.candidate.companions)
    expect(certified.assessment).toBe(prepared.assessment)
    expect(certified.verification).toEqual(expect.objectContaining({
      projectionDigest: prepared.candidate.projectionDigest,
      platform: 'test-platform',
      oracle: {
        protocol: 'lockgraph-native-frozen/v1',
        manager: 'npm',
        version: '9.9.4',
      },
    }))
    expect(Object.isFrozen(certified)).toBe(true)
    expect(Object.isFrozen(certified.verification)).toBe(true)

    await expect(certifyFrozen(prepared.candidate, {
      files: { ...postRunFiles, 'package-lock.json': `${lockfile} ` },
      manager: 'npm',
      version: '9.9.4',
    })).rejects.toMatchObject({
      code: 'FORMAT_MISMATCH',
      diagnostics: [expect.objectContaining({
        code: 'CONVERT_FROZEN_ORACLE_MISMATCH',
      })],
    })
    await expect(certifyFrozen(prepared.candidate, {
      files: postRunFiles,
      manager: 'pnpm',
      version: '9.9.4',
    })).rejects.toMatchObject({ code: 'FORMAT_MISMATCH' })
  })
})
