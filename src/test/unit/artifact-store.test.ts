import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve, sep } from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as publicApi from '../../main/ts/index.ts'
import {
  artifactTarballSource,
  type ArtifactTarballRequest,
  type RequestNpmTarballSource,
} from '../../main/ts/enrich/artifact-bytes.ts'
import {
  normalizeArtifactSources,
  type NormalizedArtifactSources,
} from '../../main/ts/enrich/artifact-sources.ts'
import { lockgraphStore } from '../../main/ts/enrich/artifact-store.ts'
import { computeBerryChecksum } from '../../main/ts/recipe/berry-checksum.ts'
import type {
  Diagnostic,
  Graph,
  TarballPayload,
} from '../../main/ts/graph.ts'
import type {
  NpmTarballSource,
  Packument,
  PackumentVersion,
  RegistryAdapter,
  RemoteArtifactRegistry,
} from '../../main/ts/registry/types.ts'
import { enrich, parse, stringify } from '../../main/ts/index.ts'

const DEFAULT_MAX_BYTES = 5 * 1024 ** 3
const dirs: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function freshDir(prefix = 'lockgraph-artifact-store-'): string {
  const dir = mkdtempSync(resolve(tmpdir(), prefix))
  dirs.push(dir)
  return dir
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

function digest(bytes: Uint8Array, algorithm = 'sha512'): string {
  return createHash(algorithm).update(bytes).digest('hex')
}

function sri(bytes: Uint8Array, algorithm = 'sha512'): string {
  return `${algorithm}-${createHash(algorithm).update(bytes).digest('base64')}`
}

function npmGraph(
  bytes: Uint8Array,
  options: { integrity?: string; url?: string } = {},
): Graph {
  const url = options.url ?? 'https://registry.test/npm/pkg/-/pkg-1.0.0.tgz'
  const entry: Record<string, unknown> = { version: '1.0.0', resolved: url }
  if (options.integrity !== undefined) entry.integrity = options.integrity
  return parse('npm-3', `${JSON.stringify({
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
      'node_modules/pkg': entry,
    },
  }, null, 2)}\n`)
}

function requestOf(graph: Graph): ArtifactTarballRequest {
  const id = graph.byName('pkg')[0]!
  return {
    node: graph.getNode(id)!,
    payload: graph.tarballOf(id)!,
  }
}

interface DesiredStoreSource {
  readonly kind: 'lockgraph-artifact-store'
  readonly path: string
  readonly maxBytes: number
}

interface DesiredStoreEntry {
  readonly kind: 'store'
  readonly store: DesiredStoreSource
}

function storeSource(path: string, maxBytes = DEFAULT_MAX_BYTES): DesiredStoreSource {
  return Object.freeze({ kind: 'lockgraph-artifact-store', path, maxBytes })
}

function storeEntry(path: string, maxBytes = DEFAULT_MAX_BYTES): DesiredStoreEntry {
  return Object.freeze({ kind: 'store', store: storeSource(path, maxBytes) })
}

function emptyTarballs(): NpmTarballSource {
  return Object.freeze({ async tarball() { return undefined } })
}

function normalized(
  entries: readonly unknown[],
  fallback: NpmTarballSource = emptyTarballs(),
): NormalizedArtifactSources {
  const configuredStore = entries.find(entry =>
    (entry as { kind?: string }).kind === 'store') as
      | DesiredStoreEntry
      | undefined
  return {
    refurbish: { npmTarballs: fallback },
    entries,
    caches: entries.flatMap(entry =>
      (entry as { kind?: string }).kind === 'cache'
        ? [(entry as { cache: unknown }).cache]
        : []) as never,
    remotes: entries.flatMap(entry =>
      (entry as { kind?: string }).kind === 'remote'
        ? [(entry as { registry: RegistryAdapter }).registry]
        : []),
    ...(configuredStore === undefined ? {} : { store: configuredStore.store }),
  } as never
}

function remote(bytes: Uint8Array, fetchSpy = vi.fn(async () => new Response(bytes))) {
  const version: PackumentVersion = {
    name: 'pkg',
    version: '1.0.0',
    tarball: 'https://registry.test/npm/pkg/-/pkg-1.0.0.tgz',
  }
  const packument: Packument = {
    name: 'pkg',
    distTags: {},
    versions: { '1.0.0': version },
  }
  const registry: RemoteArtifactRegistry = {
    packument: vi.fn(async () => packument),
    resolve: vi.fn(async () => version),
    artifactRoute: () => ({
      registryUrl: 'https://registry.test/npm',
      fetch: fetchSpy,
      authHeaderFor: () => undefined,
      limit: <T,>(task: () => Promise<T>) => task(),
    }),
  }
  return {
    entry: Object.freeze({ kind: 'remote', registry }),
    fetchSpy,
    registry,
  }
}

function npmCacheEntry(bytes: Uint8Array) {
  const cache: RegistryAdapter & NpmTarballSource = {
    packument: async () => undefined,
    resolve: async () => undefined,
    tarball: async () => bytes,
  }
  return Object.freeze({ kind: 'cache', family: 'npm', cache })
}

async function runSource(
  graph: Graph,
  entries: readonly unknown[],
): Promise<{
  bytes: Uint8Array | undefined
  diagnostics: Diagnostic[]
  source: RequestNpmTarballSource
}> {
  const diagnostics: Diagnostic[] = []
  const factory = artifactTarballSource as unknown as (
    artifacts: NormalizedArtifactSources,
    policy: undefined,
    onDiagnostic: (diagnostic: Diagnostic) => void,
  ) => RequestNpmTarballSource
  const source = factory(normalized(entries), undefined, diagnostic => {
    diagnostics.push(diagnostic)
  })
  const bytes = await source.tarballFor(requestOf(graph))
  if (bytes !== undefined) source.releaseTarball(bytes)
  return { bytes, diagnostics, source }
}

function objectPath(root: string, canonical: string): string {
  return resolve(root, 'objects', 'sha512', canonical.slice(0, 2), canonical.slice(2))
}

function aliasPath(
  root: string,
  namespace: 'tarball' | 'berry-zip',
  algorithm: string,
  value: string,
  cacheKey?: string,
): string {
  return resolve(
    root,
    'aliases',
    namespace,
    ...(cacheKey === undefined ? [] : [cacheKey]),
    algorithm,
    value.slice(0, 2),
    value.slice(2),
  )
}

function seedObject(root: string, bytes: Uint8Array): string {
  const canonical = digest(bytes)
  const path = objectPath(root, canonical)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, bytes)
  return canonical
}

function seedAlias(path: string, canonical: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${canonical}\n`)
}

function walkFiles(root: string): string[] {
  if (!existsSync(root)) return []
  const found: string[] = []
  const visit = (path: string): void => {
    for (const name of readdirSync(path)) {
      const child = resolve(path, name)
      if (statSync(child).isDirectory()) visit(child)
      else found.push(child)
    }
  }
  visit(root)
  return found.sort()
}

function berryGraph(bytes: Uint8Array, cacheKey = '8'): Graph {
  return parse('yarn-berry-v8', `__metadata:
  version: 8
  cacheKey: ${cacheKey}

"pkg@npm:1.0.0":
  version: 1.0.0
  resolution: "pkg@npm:1.0.0"
  checksum: ${cacheKey}/${computeBerryChecksum(bytes, 'pkg', cacheKey)}
  languageName: node
  linkType: hard
`)
}

describe('artifact store — public source contract', () => {
  it('exports only the opaque lockgraphStore operation factory', () => {
    expect((publicApi as Record<string, unknown>).lockgraphStore).toBeTypeOf('function')
    expect((publicApi as Record<string, unknown>).artifactStore).toBeUndefined()
  })

  it('rejects persistence descriptors in the ordered artifact-source list', () => {
    const root = freshDir()
    expect(() => normalizeArtifactSources([storeSource(root)] as never))
      .toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }))
  })

  it('normalizes a separate store without inserting it among external sources', () => {
    const root = resolve(freshDir(), 'not-created')
    const registry = remote(tarballOf()).registry
    const value = normalizeArtifactSources([
      'npm:/cache',
      registry,
    ], { store: storeSource(root) })
    expect(value.entries.map(entry => entry.kind))
      .toEqual(['cache', 'remote'])
    expect(value.store).toEqual(storeSource(root))
    expect(existsSync(root)).toBe(false)
  })

  it('rejects a malformed separately supplied store before filesystem access', () => {
    expect(() => normalizeArtifactSources([], {
      store: { kind: 'lockgraph-artifact-store', path: 'relative', maxBytes: 1 },
    } as never)).toThrowError(/artifact store|store path/i)
  })
})

describe('artifact store — verified persistence boundary', () => {
  it('writes a canonical SHA-512 object after a verified remote fetch', async () => {
    const root = freshDir()
    const bytes = tarballOf()
    const route = remote(bytes)
    await runSource(npmGraph(bytes, { integrity: sri(bytes) }), [
      storeEntry(root),
      route.entry,
    ])
    expect(readFileSync(objectPath(root, digest(bytes)))).toEqual(Buffer.from(bytes))
  })

  it('writes verified local npm-cache bytes through the same sink', async () => {
    const root = freshDir()
    const bytes = tarballOf()
    await runSource(npmGraph(bytes, { integrity: sri(bytes) }), [
      npmCacheEntry(bytes),
      storeEntry(root),
    ])
    expect(readFileSync(objectPath(root, digest(bytes)))).toEqual(Buffer.from(bytes))
  })

  it('writes back even when the store appears after the successful remote', async () => {
    const root = freshDir()
    const bytes = tarballOf()
    await runSource(npmGraph(bytes, { integrity: sri(bytes) }), [
      remote(bytes).entry,
      storeEntry(root),
    ])
    expect(existsSync(objectPath(root, digest(bytes)))).toBe(true)
  })

  it('keeps store read priority ahead of a later npm cache', async () => {
    const root = freshDir()
    const wanted = tarballOf('stored\n')
    const other = tarballOf('cache\n')
    seedObject(root, wanted)
    const result = await runSource(npmGraph(wanted, { integrity: sri(wanted) }), [
      storeEntry(root),
      npmCacheEntry(other),
    ])
    expect(result.bytes).toEqual(wanted)
  })

  it('creates an SHA-1 alias only after those bytes verify', async () => {
    const root = freshDir()
    const bytes = tarballOf()
    const sha1 = digest(bytes, 'sha1')
    await runSource(npmGraph(bytes, { integrity: sri(bytes, 'sha1') }), [
      storeEntry(root),
      remote(bytes).entry,
    ])
    expect(readFileSync(aliasPath(root, 'tarball', 'sha1', sha1), 'utf8').trim())
      .toBe(digest(bytes))
  })

  it('creates a Berry source-domain alias only after source checksum verification', async () => {
    const root = freshDir()
    const bytes = tarballOf()
    const source = computeBerryChecksum(bytes, 'pkg', '8')
    await runSource(berryGraph(bytes), [storeEntry(root), remote(bytes).entry])
    expect(readFileSync(aliasPath(root, 'berry-zip', 'sha512', source, '8'), 'utf8').trim())
      .toBe(digest(bytes))
  })

  it('adds no stable identifying material beyond digest addressing', async () => {
    const root = freshDir()
    const bytes = tarballOf('secret package body\n')
    await runSource(npmGraph(bytes, { integrity: sri(bytes) }), [
      storeEntry(root),
      remote(bytes).entry,
    ])
    const files = walkFiles(root)
    expect(files).toContain(objectPath(root, digest(bytes)))
    const objectsRoot = `${resolve(root, 'objects')}${sep}`
    const stableText = files.map(path =>
      `${path.slice(root.length)}\n${path.startsWith(objectsRoot)
        ? ''
        : readFileSync(path).toString('latin1')}`).join('\n')
    expect(stableText).not.toMatch(/pkg|registry\.test|authorization|Bearer|raw diagnostic/i)
  })
})

describe('artifact store — hit re-verification and fallback', () => {
  it('uses a direct canonical SHA-512 hit before a later remote', async () => {
    const root = freshDir()
    const bytes = tarballOf()
    seedObject(root, bytes)
    const route = remote(bytes)
    const result = await runSource(npmGraph(bytes, { integrity: sri(bytes) }), [
      storeEntry(root),
      route.entry,
    ])
    expect(result.bytes).toEqual(bytes)
    expect(route.fetchSpy).not.toHaveBeenCalled()
  })

  it('uses a verified SHA-1 alias hit before a later remote', async () => {
    const root = freshDir()
    const bytes = tarballOf()
    const canonical = seedObject(root, bytes)
    const sha1 = digest(bytes, 'sha1')
    seedAlias(aliasPath(root, 'tarball', 'sha1', sha1), canonical)
    const route = remote(bytes)
    const result = await runSource(npmGraph(bytes, { integrity: sri(bytes, 'sha1') }), [
      storeEntry(root),
      route.entry,
    ])
    expect(result.bytes).toEqual(bytes)
    expect(route.fetchSpy).not.toHaveBeenCalled()
  })

  it('uses a Berry alias only as an index and re-verifies current evidence', async () => {
    const root = freshDir()
    const bytes = tarballOf()
    const canonical = seedObject(root, bytes)
    const source = computeBerryChecksum(bytes, 'pkg', '8')
    seedAlias(aliasPath(root, 'berry-zip', 'sha512', source, '8'), canonical)
    const route = remote(bytes)
    const result = await runSource(berryGraph(bytes), [
      storeEntry(root),
      route.entry,
    ])
    expect(result.bytes).toEqual(bytes)
    expect(route.fetchSpy).not.toHaveBeenCalled()
  })

  it('deletes a canonical self-hash failure and falls through with a named warning', async () => {
    const root = freshDir()
    const wanted = tarballOf()
    const corrupt = tarballOf('corrupt\n')
    const path = objectPath(root, digest(wanted))
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, corrupt)
    const route = remote(wanted)
    const result = await runSource(npmGraph(wanted, { integrity: sri(wanted) }), [
      storeEntry(root),
      route.entry,
    ])
    expect(route.fetchSpy).toHaveBeenCalledOnce()
    expect(readFileSync(path)).toEqual(Buffer.from(wanted))
    expect(result.diagnostics.map(item => item.code))
      .toContain('ENRICH_ARTIFACT_STORE_CORRUPT')
  })

  it('deletes only a poisoned alias while preserving its valid canonical object', async () => {
    const root = freshDir()
    const wanted = tarballOf()
    const other = tarballOf('other\n')
    const otherCanonical = seedObject(root, other)
    const wantedSha1 = digest(wanted, 'sha1')
    const alias = aliasPath(root, 'tarball', 'sha1', wantedSha1)
    seedAlias(alias, otherCanonical)
    const route = remote(wanted)
    const result = await runSource(npmGraph(wanted, { integrity: sri(wanted, 'sha1') }), [
      storeEntry(root),
      route.entry,
    ])
    expect(route.fetchSpy).toHaveBeenCalledOnce()
    expect(readFileSync(alias, 'utf8').trim()).toBe(digest(wanted))
    expect(existsSync(objectPath(root, otherCanonical))).toBe(true)
    expect(result.diagnostics.map(item => item.code))
      .toContain('ENRICH_ARTIFACT_STORE_CORRUPT')
  })

  it('does not recompute from a poisoned alias when no later source exists', async () => {
    const root = freshDir()
    const wanted = tarballOf()
    const other = tarballOf('other\n')
    const otherCanonical = seedObject(root, other)
    seedAlias(
      aliasPath(root, 'tarball', 'sha1', digest(wanted, 'sha1')),
      otherCanonical,
    )
    const result = await runSource(
      npmGraph(wanted, { integrity: sri(wanted, 'sha1') }),
      [storeEntry(root)],
    )
    expect(result.bytes).toBeUndefined()
    expect(result.diagnostics.map(item => item.code))
      .toContain('ENRICH_ARTIFACT_STORE_CORRUPT')
  })

  it('keeps a store read failure non-fatal and falls through', async () => {
    const root = freshDir()
    const bytes = tarballOf()
    writeFileSync(resolve(root, 'objects'), 'not a directory')
    const route = remote(bytes)
    const result = await runSource(npmGraph(bytes, { integrity: sri(bytes) }), [
      storeEntry(root),
      route.entry,
    ])
    expect(route.fetchSpy).toHaveBeenCalledOnce()
    expect(result.diagnostics.map(item => item.code))
      .toContain('ENRICH_ARTIFACT_STORE_READ_FAILED')
  })
})

describe('artifact store — private atomic concurrency and recovery', () => {
  it('enforces private directory and stable-file permissions', async () => {
    const root = freshDir()
    chmodSync(root, 0o755)
    const bytes = tarballOf()
    await runSource(npmGraph(bytes, { integrity: sri(bytes) }), [
      storeEntry(root),
      remote(bytes).entry,
    ])
    expect(statSync(root).mode & 0o777).toBe(0o700)
    expect(statSync(objectPath(root, digest(bytes))).mode & 0o777).toBe(0o600)
  })

  it('enforces private permissions on digest alias files too', async () => {
    const root = freshDir()
    const bytes = tarballOf()
    const sha1 = digest(bytes, 'sha1')
    await runSource(npmGraph(bytes, { integrity: sri(bytes, 'sha1') }), [
      storeEntry(root),
      remote(bytes).entry,
    ])
    expect(statSync(aliasPath(root, 'tarball', 'sha1', sha1)).mode & 0o777)
      .toBe(0o600)
  })

  it('commits one stable object and leaves no same-filesystem temp', async () => {
    const root = freshDir()
    const bytes = tarballOf()
    await runSource(npmGraph(bytes, { integrity: sri(bytes) }), [
      storeEntry(root),
      remote(bytes).entry,
    ])
    expect(existsSync(objectPath(root, digest(bytes)))).toBe(true)
    expect(walkFiles(resolve(root, '.tmp'))).toEqual([])
  })

  it('tolerates concurrent identical writers with one canonical object', async () => {
    const root = freshDir()
    const bytes = tarballOf()
    await Promise.all(Array.from({ length: 4 }, () =>
      runSource(npmGraph(bytes, { integrity: sri(bytes) }), [
        storeEntry(root),
        remote(bytes).entry,
      ])))
    const objects = walkFiles(resolve(root, 'objects'))
    expect(objects).toEqual([objectPath(root, digest(bytes))])
    expect(readFileSync(objects[0]!)).toEqual(Buffer.from(bytes))
  })

  it('recovers a crashed writer temp owned by a dead PID', async () => {
    const root = freshDir()
    const stale = resolve(root, '.tmp', '999999-dead')
    const staleLock = resolve(root, '.tmp', '999999-stale-lock-dead')
    mkdirSync(dirname(stale), { recursive: true })
    writeFileSync(stale, 'partial')
    mkdirSync(staleLock)
    writeFileSync(resolve(staleLock, 'owner'), '999999\n')
    const bytes = tarballOf()
    await runSource(npmGraph(bytes, { integrity: sri(bytes) }), [
      storeEntry(root),
      remote(bytes).entry,
    ])
    expect(existsSync(stale)).toBe(false)
    expect(existsSync(staleLock)).toBe(false)
  })

  it('recovers a dead-owner pin before deterministic eviction', async () => {
    const root = freshDir()
    const old = tarballOf('old\n')
    const oldCanonical = seedObject(root, old)
    const pin = resolve(root, '.pins', `${oldCanonical}.999999.dead`)
    mkdirSync(dirname(pin), { recursive: true })
    writeFileSync(pin, '')
    const bytes = tarballOf('new\n')
    await runSource(npmGraph(bytes, { integrity: sri(bytes) }), [
      storeEntry(root, bytes.byteLength),
      remote(bytes).entry,
    ])
    expect(existsSync(pin)).toBe(false)
    expect(existsSync(objectPath(root, oldCanonical))).toBe(false)
    expect(existsSync(objectPath(root, digest(bytes)))).toBe(true)
  })

  it('keeps a verified result when store-root creation fails and names the write failure', async () => {
    const parent = freshDir()
    const root = resolve(parent, 'not-a-directory')
    writeFileSync(root, 'occupied')
    const bytes = tarballOf()
    const result = await runSource(npmGraph(bytes, { integrity: sri(bytes) }), [
      storeEntry(root),
      remote(bytes).entry,
    ])
    expect(result.bytes).toEqual(bytes)
    expect(result.diagnostics.map(item => item.code))
      .toContain('ENRICH_ARTIFACT_STORE_WRITE_FAILED')
  })
})

describe('artifact store — mandatory deterministic capacity', () => {
  it('evicts the oldest completed object before committing a new one', async () => {
    const root = freshDir()
    const old = tarballOf('old\n')
    const recent = tarballOf('recent\n')
    const incoming = tarballOf('incoming\n')
    const oldPath = objectPath(root, seedObject(root, old))
    const recentPath = objectPath(root, seedObject(root, recent))
    utimesSync(oldPath, new Date(1_000), new Date(1_000))
    utimesSync(recentPath, new Date(2_000), new Date(2_000))
    await runSource(npmGraph(incoming, { integrity: sri(incoming) }), [
      storeEntry(root, recent.byteLength + incoming.byteLength),
      remote(incoming).entry,
    ])
    expect(existsSync(oldPath)).toBe(false)
    expect(existsSync(recentPath)).toBe(true)
    expect(existsSync(objectPath(root, digest(incoming)))).toBe(true)
  })

  it('breaks equal-mtime eviction ties by canonical SHA-512', async () => {
    const root = freshDir()
    const first = tarballOf('first\n')
    const second = tarballOf('second\n')
    const incoming = tarballOf('incoming\n')
    const firstPath = objectPath(root, seedObject(root, first))
    const secondPath = objectPath(root, seedObject(root, second))
    const same = new Date(1_000)
    utimesSync(firstPath, same, same)
    utimesSync(secondPath, same, same)
    const ordered = [firstPath, secondPath].sort()
    await runSource(npmGraph(incoming, { integrity: sri(incoming) }), [
      storeEntry(root, Math.max(first.byteLength, second.byteLength) + incoming.byteLength),
      remote(incoming).entry,
    ])
    expect(existsSync(ordered[0]!)).toBe(false)
  })

  it('updates recency only after a hit passes current-lock verification', async () => {
    const root = freshDir()
    const bytes = tarballOf()
    const path = objectPath(root, seedObject(root, bytes))
    const old = new Date(1_000)
    utimesSync(path, old, old)
    await runSource(npmGraph(bytes, { integrity: sri(bytes) }), [storeEntry(root)])
    expect(statSync(path).mtimeMs).toBeGreaterThan(old.getTime())
  })

  it('never evicts a live-owner pinned object', async () => {
    const root = freshDir()
    const pinned = tarballOf('pinned\n')
    const unpinned = tarballOf('unpinned\n')
    const incoming = tarballOf('incoming\n')
    const pinnedCanonical = seedObject(root, pinned)
    const unpinnedPath = objectPath(root, seedObject(root, unpinned))
    const pin = resolve(root, '.pins', `${pinnedCanonical}.${process.pid}.live`)
    mkdirSync(dirname(pin), { recursive: true })
    writeFileSync(pin, '')
    await runSource(npmGraph(incoming, { integrity: sri(incoming) }), [
      storeEntry(root, pinned.byteLength + incoming.byteLength),
      remote(incoming).entry,
    ])
    expect(existsSync(objectPath(root, pinnedCanonical))).toBe(true)
    expect(existsSync(unpinnedPath)).toBe(false)
    expect(existsSync(objectPath(root, digest(incoming)))).toBe(true)
  })

  it('does not persist an individual object larger than capacity', async () => {
    const root = freshDir()
    const bytes = tarballOf()
    const result = await runSource(npmGraph(bytes, { integrity: sri(bytes) }), [
      storeEntry(root, bytes.byteLength - 1),
      remote(bytes).entry,
    ])
    expect(existsSync(objectPath(root, digest(bytes)))).toBe(false)
    expect(result.diagnostics.map(item => item.code))
      .toContain('ENRICH_ARTIFACT_STORE_CAPACITY_EXCEEDED')
  })

  it('does not commit when live pins leave insufficient evictable room', async () => {
    const root = freshDir()
    const pinned = tarballOf('pinned\n')
    const spared = tarballOf('spared\n')
    const incoming = tarballOf('incoming\n')
    const pinnedCanonical = seedObject(root, pinned)
    const sparedCanonical = seedObject(root, spared)
    const pin = resolve(root, '.pins', `${pinnedCanonical}.${process.pid}.live`)
    mkdirSync(dirname(pin), { recursive: true })
    writeFileSync(pin, '')
    const result = await runSource(npmGraph(incoming, { integrity: sri(incoming) }), [
      storeEntry(root, pinned.byteLength + incoming.byteLength - 1),
      remote(incoming).entry,
    ])
    expect(existsSync(objectPath(root, digest(incoming)))).toBe(false)
    expect(existsSync(objectPath(root, sparedCanonical))).toBe(true)
    expect(result.diagnostics.map(item => item.code))
      .toContain('ENRICH_ARTIFACT_STORE_CAPACITY_EXCEEDED')
  })

  it('counts stable digest aliases toward the configured capacity', async () => {
    const root = freshDir()
    const old = tarballOf('old\n')
    const oldCanonical = seedObject(root, old)
    const alias = aliasPath(root, 'tarball', 'sha1', digest(old, 'sha1'))
    seedAlias(alias, oldCanonical)
    const incoming = tarballOf('incoming\n')
    await runSource(npmGraph(incoming, { integrity: sri(incoming) }), [
      storeEntry(root, old.byteLength + incoming.byteLength),
      remote(incoming).entry,
    ])
    expect(existsSync(objectPath(root, oldCanonical))).toBe(false)
    expect(existsSync(alias)).toBe(false)
    expect(existsSync(objectPath(root, digest(incoming)))).toBe(true)
  })

  it('removes malformed and dangling stable entries before capacity accounting', async () => {
    const root = freshDir()
    const malformed = resolve(root, 'objects', 'sha512', 'zz', 'junk')
    mkdirSync(dirname(malformed), { recursive: true })
    writeFileSync(malformed, 'junk')
    const dangling = aliasPath(root, 'tarball', 'sha1', 'a'.repeat(40))
    seedAlias(dangling, 'b'.repeat(128))
    const incoming = tarballOf('incoming\n')
    const result = await runSource(npmGraph(incoming, { integrity: sri(incoming) }), [
      storeEntry(root, incoming.byteLength),
      remote(incoming).entry,
    ])
    expect(existsSync(malformed)).toBe(false)
    expect(existsSync(dangling)).toBe(false)
    expect(existsSync(objectPath(root, digest(incoming)))).toBe(true)
    expect(result.diagnostics.map(item => item.code))
      .toContain('ENRICH_ARTIFACT_STORE_CORRUPT')
  })
})

describe('artifact store — transparent enrichment result', () => {
  it('uses the omitted global store and reports its resolved path exactly once', async () => {
    const xdg = freshDir('lockgraph-artifact-store-xdg-')
    vi.stubEnv('XDG_CACHE_HOME', xdg)
    const root = resolve(xdg, 'lockgraph')
    const bytes = tarballOf()
    const route = remote(bytes)
    const result = await enrich(npmGraph(bytes, { integrity: sri(bytes) }), {
      sources: { artifacts: [route.registry] },
      target: 'yarn-berry-v8',
      contract: 'snapshot',
      cacheKey: '10c0',
    })
    expect(result.diagnostics.filter(diagnostic =>
      diagnostic.code === 'STORE_PATH_RESOLVED'))
      .toEqual([expect.objectContaining({
        data: expect.objectContaining({ path: root }),
      })])
    expect(existsSync(root)).toBe(true)
  })

  it('substitutes a custom-store hit when ordinary sources are absent', async () => {
    const root = resolve(freshDir(), 'store')
    const store = lockgraphStore(root)
    const bytes = tarballOf()
    const graph = npmGraph(bytes, { integrity: sri(bytes) })
    const fetched = await enrich(graph, {
      store,
      sources: { artifacts: [remote(bytes).registry] },
      target: 'yarn-berry-v8',
      contract: 'snapshot',
      cacheKey: '10c0',
    })
    const hit = await enrich(graph, {
      store,
      target: 'yarn-berry-v8',
      contract: 'snapshot',
      cacheKey: '10c0',
    })
    expect(hit.diagnostics).toEqual(fetched.diagnostics)
    expect(stringify('yarn-berry-v8', hit.graph, { strict: false }))
      .toBe(stringify('yarn-berry-v8', fetched.graph, { strict: false }))
  })

  it('reads a populated custom store before a later cold remote source', async () => {
    const root = resolve(freshDir(), 'store')
    const store = lockgraphStore(root)
    const bytes = tarballOf()
    const graph = npmGraph(bytes, { integrity: sri(bytes) })
    await enrich(graph, {
      store,
      sources: { artifacts: [remote(bytes).registry] },
      target: 'yarn-berry-v8',
      contract: 'snapshot',
      cacheKey: '10c0',
    })
    const cold = remote(bytes, vi.fn(async () => {
      throw new Error('store must win before this source')
    }))
    await enrich(graph, {
      store,
      sources: { artifacts: [cold.registry] },
      target: 'yarn-berry-v8',
      contract: 'snapshot',
      cacheKey: '10c0',
    })
    expect(cold.fetchSpy).not.toHaveBeenCalled()
  })

  it('store:false performs no read, write, or path notification', async () => {
    const xdg = freshDir('lockgraph-artifact-store-disabled-')
    vi.stubEnv('XDG_CACHE_HOME', xdg)
    const bytes = tarballOf()
    const result = await enrich(npmGraph(bytes, { integrity: sri(bytes) }), {
      store: false,
      sources: { artifacts: [remote(bytes).registry] },
      target: 'yarn-berry-v8',
      contract: 'snapshot',
      cacheKey: '10c0',
    })
    expect(existsSync(resolve(xdg, 'lockgraph'))).toBe(false)
    expect(result.diagnostics.map(diagnostic => diagnostic.code))
      .not.toContain('STORE_PATH_RESOLVED')
  })

  it('reacquires identical output and diagnostics after whole-store deletion', async () => {
    const root = resolve(freshDir(), 'store')
    const store = lockgraphStore(root)
    const bytes = tarballOf()
    const graph = npmGraph(bytes, { integrity: sri(bytes) })
    const first = await enrich(graph, {
      store,
      sources: { artifacts: [remote(bytes).registry] },
      target: 'yarn-berry-v8',
      contract: 'snapshot',
      cacheKey: '10c0',
    })
    rmSync(root, { recursive: true, force: true })
    const second = await enrich(graph, {
      store,
      sources: { artifacts: [remote(bytes).registry] },
      target: 'yarn-berry-v8',
      contract: 'snapshot',
      cacheKey: '10c0',
    })
    expect(second.diagnostics).toEqual(first.diagnostics)
    expect(stringify('yarn-berry-v8', second.graph, { strict: false }))
      .toBe(stringify('yarn-berry-v8', first.graph, { strict: false }))
  })

  it('produces identical graph, diagnostics, and emitted lock bytes on fetch and hit', async () => {
    const root = freshDir()
    const bytes = tarballOf()
    const graph = npmGraph(bytes, { integrity: sri(bytes) })
    const route = remote(bytes)
    const fetched = await enrich(graph, {
      store: lockgraphStore(root),
      sources: {
        artifacts: [route.registry],
      },
      target: 'yarn-berry-v8',
      contract: 'snapshot',
      cacheKey: '10c0',
    })
    const offline = remote(bytes, vi.fn(async () => {
      throw new Error('store hit must not fetch')
    }))
    const hit = await enrich(graph, {
      store: lockgraphStore(root),
      sources: {
        artifacts: [offline.registry],
      },
      target: 'yarn-berry-v8',
      contract: 'snapshot',
      cacheKey: '10c0',
    })
    expect(hit.graph.diff(fetched.graph)).toEqual({
      addedNodes: [],
      removedNodes: [],
      changedNodes: [],
      addedEdges: [],
      removedEdges: [],
    })
    expect(hit.diagnostics).toEqual(fetched.diagnostics)
    expect(stringify('yarn-berry-v8', hit.graph, { strict: false }))
      .toBe(stringify('yarn-berry-v8', fetched.graph, { strict: false }))
    expect(offline.fetchSpy).not.toHaveBeenCalled()
  })

  it('routes a hit through current-lock multihash verification before returning bytes', async () => {
    const root = freshDir()
    const bytes = tarballOf()
    seedObject(root, bytes)
    const inconsistent = `${sri(bytes)} ${sri(tarballOf('other\n'), 'sha1')}`
    const source = artifactTarballSource(
      normalized([storeEntry(root)]),
      undefined,
    )
    await expect(source.tarballFor(requestOf(npmGraph(bytes, {
      integrity: inconsistent,
    })))).rejects.toMatchObject({
      diagnostic: { code: 'ENRICH_ARTIFACT_INTEGRITY_MISMATCH' },
    })
  })
})
