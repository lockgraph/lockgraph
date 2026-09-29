import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { gzipSync } from 'node:zlib'
import { describe, expect, it, vi } from 'vitest'
import {
  enrich,
  lockgraphStore,
  parse,
} from '../../main/ts/index.ts'
import { liveRegistry } from '../../main/ts/registry/live.ts'
import * as enrichDiagnostics from '../../main/ts/enrich/diagnostics.ts'
import { computeBerryChecksum } from '../../main/ts/recipe/berry-checksum.ts'
import type {
  Packument,
  PackumentVersion,
  RegistryAdapter,
  RemoteArtifactRegistry,
} from '../../main/ts/registry/types.ts'

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

function sri(bytes: Uint8Array, algorithm = 'sha512'): string {
  return `${algorithm}-${createHash(algorithm).update(bytes).digest('base64')}`
}

function npmGraph(
  bytes: Uint8Array,
  options: {
    integrity?: string
    name?: string
    url?: string
  } = {},
) {
  const name = options.name ?? 'pkg'
  const url = options.url ?? `https://registry.test/npm/${name}/-/${name}-1.0.0.tgz`
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
        dependencies: { [name]: '1.0.0' },
      },
      [`node_modules/${name}`]: entry,
    },
  }, null, 2)}\n`)
}

interface RouteOptions {
  registryUrl?: string
  attestedName?: string
  attestedUrl?: string
  authHeader?: string
  fetch?: typeof fetch
  route?: boolean
}

function remote(options: RouteOptions = {}): RemoteArtifactRegistry {
  const registryUrl = options.registryUrl ?? 'https://registry.test/npm'
  const attestedName = options.attestedName ?? 'pkg'
  const attestedUrl = options.attestedUrl
    ?? `https://registry.test/npm/${attestedName}/-/${attestedName}-1.0.0.tgz`
  const version: PackumentVersion = {
    name: attestedName,
    version: '1.0.0',
    tarball: attestedUrl,
  }
  const packument: Packument = {
    name: attestedName,
    distTags: {},
    versions: { '1.0.0': version },
  }
  const registry: RemoteArtifactRegistry = {
    packument: vi.fn(async () => packument),
    resolve: vi.fn(async () => version),
    artifactRoute: vi.fn((name: string) => options.route === false
      ? undefined
      : {
          registryUrl,
          fetch: options.fetch ?? vi.fn(async () => new Response(null, { status: 404 })),
          authHeaderFor: () => options.authHeader,
          limit: <T,>(task: () => Promise<T>) => task(),
          name,
        }),
  }
  return registry
}

async function run(
  graph: ReturnType<typeof npmGraph>,
  registries: readonly RemoteArtifactRegistry[],
  artifactResources?: unknown,
) {
  return enrich(graph, {
    store: false,
    sources: {
      artifacts: registries,
    },
    target: 'yarn-berry-v8',
    contract: 'snapshot',
    cacheKey: '10c0',
    ...(artifactResources === undefined ? {} : { artifactResources }),
  } as never)
}

async function runLocal(
  graph: ReturnType<typeof npmGraph>,
  bytes: Uint8Array,
  artifactResources?: unknown,
) {
  return enrich(graph, {
    store: false,
    sources: {
      artifacts: {
        npmTarballs: { async tarball() { return bytes } },
      },
    },
    target: 'yarn-berry-v8',
    contract: 'snapshot',
    cacheKey: '10c0',
    ...(artifactResources === undefined ? {} : { artifactResources }),
  } as never)
}

function codes(result: Awaited<ReturnType<typeof run>>): string[] {
  return result.diagnostics.map(item => item.code)
}

function hashes(
  result: Awaited<ReturnType<typeof run>>,
  name = 'pkg',
) {
  const id = result.graph.byName(name)[0]
  return id === undefined
    ? []
    : result.graph.tarballOf(id)?.integrity?.hashes ?? []
}

function filesBelow(root: string): string[] {
  if (!existsSync(root)) return []
  const files: string[] = []
  const visit = (path: string): void => {
    for (const name of readdirSync(path)) {
      const child = resolve(path, name)
      if (statSync(child).isDirectory()) visit(child)
      else files.push(child)
    }
  }
  visit(root)
  return files
}

describe('remote artifact bytes — authorization ladder', () => {
  it('rung 1 fetches a lock-named URL within the configured route', async () => {
    const bytes = tarballOf()
    const fetchSpy = vi.fn(async () => new Response(bytes))
    const result = await run(
      npmGraph(bytes, { integrity: sri(bytes) }),
      [remote({ fetch: fetchSpy as unknown as typeof fetch })],
    )
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(hashes(result))
      .toContainEqual(expect.objectContaining({ origin: 'berry-zip' }))
  })

  it('rung 2 accepts an exact name+version cross-origin attestation', async () => {
    const bytes = tarballOf()
    const url = 'https://cdn.test/artifacts/pkg-1.0.0.tgz'
    const fetchSpy = vi.fn(async () => new Response(bytes))
    const result = await run(
      npmGraph(bytes, { integrity: sri(bytes), url }),
      [remote({ attestedUrl: url, fetch: fetchSpy as unknown as typeof fetch })],
    )
    expect(fetchSpy).toHaveBeenCalledWith(url, expect.objectContaining({ redirect: 'manual' }))
    expect(hashes(result))
      .toContainEqual(expect.objectContaining({ origin: 'berry-zip' }))
  })

  it('does not let package B inherit package A attestation', async () => {
    const bytes = tarballOf()
    const url = 'https://cdn.test/artifacts/a-1.0.0.tgz'
    const fetchSpy = vi.fn(async () => new Response(bytes))
    const result = await run(
      npmGraph(bytes, { name: 'b', integrity: sri(bytes), url }),
      [remote({
        attestedName: 'a',
        attestedUrl: url,
        fetch: fetchSpy as unknown as typeof fetch,
      })],
    )
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(codes(result)).toContain('ENRICH_ARTIFACT_URL_UNAUTHORIZED')
  })

  it('rung 3 uses the exact-version registry URL when the lock states none', async () => {
    const bytes = tarballOf()
    const url = 'https://cdn.test/artifacts/pkg-1.0.0.tgz'
    const sourceChecksum = computeBerryChecksum(bytes, 'pkg', '8')
    const fetchSpy = vi.fn(async () => new Response(bytes))
    const graph = parse('yarn-berry-v8', `__metadata:
  version: 8
  cacheKey: 8

"pkg@npm:1.0.0":
  version: 1.0.0
  resolution: "pkg@npm:1.0.0"
  checksum: 8/${sourceChecksum}
  languageName: node
  linkType: hard
`)
    const result = await run(
      graph,
      [remote({ attestedUrl: url, fetch: fetchSpy as unknown as typeof fetch })],
    )
    expect(fetchSpy).toHaveBeenCalledWith(url, expect.objectContaining({ redirect: 'manual' }))
    const payload = result.graph.tarballOf(result.graph.byName('pkg')[0]!)
    const berryHashes = payload?.integrity?.hashes.filter(hash =>
      hash.origin === 'berry-zip') ?? []
    expect(payload?.berryChecksumCacheKey).toBe('10c0')
    expect(berryHashes).toHaveLength(1)
    expect(berryHashes[0]?.digest).toBe(
      computeBerryChecksum(bytes, 'pkg', '10c0'),
    )
  })

  it('rung 4 emits a named defer and never requests an unauthorized URL', async () => {
    const bytes = tarballOf()
    const fetchSpy = vi.fn(async () => new Response(bytes))
    const result = await run(
      npmGraph(bytes, {
        integrity: sri(bytes),
        url: 'https://hostile.test/pkg.tgz',
      }),
      [remote({ fetch: fetchSpy as unknown as typeof fetch })],
    )
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(codes(result)).toContain('ENRICH_ARTIFACT_URL_UNAUTHORIZED')
  })

  it('does not use a sibling registry as fallback', async () => {
    const bytes = tarballOf()
    const firstFetch = vi.fn(async () => { throw new Error('offline') })
    const secondFetch = vi.fn(async () => new Response(bytes))
    const result = await run(npmGraph(bytes, { integrity: sri(bytes) }), [
      remote({ fetch: firstFetch as unknown as typeof fetch }),
      remote({
        registryUrl: 'https://sibling.test/npm',
        fetch: secondFetch as unknown as typeof fetch,
      }),
    ])
    expect(secondFetch).not.toHaveBeenCalled()
    expect(codes(result)).toContain('ENRICH_ARTIFACT_ROUTE_AMBIGUOUS')
  })

  it('defers when no byte-capable route claims the package', async () => {
    const bytes = tarballOf()
    const result = await run(
      npmGraph(bytes, { integrity: sri(bytes) }),
      [remote({ route: false })],
    )
    expect(codes(result)).toContain('ENRICH_ARTIFACT_ROUTE_MISSING')
  })

  it('authorizes an anonymous configured host without treating auth as policy', async () => {
    const bytes = tarballOf()
    const fetchSpy = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('authorization')).toBeNull()
      return new Response(bytes)
    })
    const result = await run(
      npmGraph(bytes, { integrity: sri(bytes) }),
      [remote({ fetch: fetchSpy as unknown as typeof fetch })],
    )
    expect(fetchSpy).toHaveBeenCalledOnce()
    expect(codes(result)).not.toContain('ENRICH_ARTIFACT_URL_UNAUTHORIZED')
  })

  it('attaches credentials only after an HTTPS route is authorized', async () => {
    const bytes = tarballOf()
    const fetchSpy = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer secret')
      return new Response(bytes)
    })
    await run(
      npmGraph(bytes, { integrity: sri(bytes) }),
      [remote({
        authHeader: 'Bearer secret',
        fetch: fetchSpy as unknown as typeof fetch,
      })],
    )
    expect(fetchSpy).toHaveBeenCalledOnce()
  })

  it('allows explicitly configured HTTP without credentials', async () => {
    const bytes = tarballOf()
    const url = 'http://registry.test/npm/pkg/-/pkg-1.0.0.tgz'
    const fetchSpy = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('authorization')).toBeNull()
      return new Response(bytes)
    })
    const result = await run(
      npmGraph(bytes, { integrity: sri(bytes), url }),
      [remote({
        registryUrl: 'http://registry.test/npm',
        authHeader: 'Bearer must-not-leak',
        attestedUrl: url,
        fetch: fetchSpy as unknown as typeof fetch,
      })],
    )
    expect(fetchSpy).toHaveBeenCalledOnce()
    expect(codes(result)).not.toContain('ENRICH_ARTIFACT_URL_UNAUTHORIZED')
  })

  it('rejects attested cross-origin HTTP when it is not configured', async () => {
    const bytes = tarballOf()
    const url = 'http://cdn.test/pkg.tgz'
    const fetchSpy = vi.fn(async () => new Response(bytes))
    const result = await run(
      npmGraph(bytes, { integrity: sri(bytes), url }),
      [remote({ attestedUrl: url, fetch: fetchSpy as unknown as typeof fetch })],
    )
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(codes(result)).toContain('ENRICH_ARTIFACT_URL_UNAUTHORIZED')
  })

  it('uses a path boundary rather than a string prefix', async () => {
    const bytes = tarballOf()
    const url = 'https://registry.test/npm-evil/pkg.tgz'
    const fetchSpy = vi.fn(async () => new Response(bytes))
    const result = await run(
      npmGraph(bytes, { integrity: sri(bytes), url }),
      [remote({
        attestedUrl: 'https://different.test/pkg.tgz',
        fetch: fetchSpy as unknown as typeof fetch,
      })],
    )
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(codes(result)).toContain('ENRICH_ARTIFACT_URL_UNAUTHORIZED')
  })
})

describe('remote artifact bytes — redirects and transport', () => {
  it('rejects an authorized hop redirecting to an unauthorized target before request', async () => {
    const bytes = tarballOf()
    const target = 'https://hostile.test/pkg.tgz'
    const fetchSpy = vi.fn(async (_url: string) => new Response(null, {
      status: 302,
      headers: { location: target },
    }))
    const result = await run(
      npmGraph(bytes, { integrity: sri(bytes) }),
      [remote({ fetch: fetchSpy as unknown as typeof fetch })],
    )
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(fetchSpy.mock.calls.some(call => call[0] === target)).toBe(false)
    expect(codes(result)).toContain('ENRICH_ARTIFACT_REDIRECT_REJECTED')
  })

  it('follows a same-route redirect with manual reauthorization', async () => {
    const bytes = tarballOf()
    const target = 'https://registry.test/npm/pkg/-/actual.tgz'
    const fetchSpy = vi.fn(async (url: string) => url === target
      ? new Response(bytes)
      : new Response(null, { status: 302, headers: { location: target } }))
    const result = await run(
      npmGraph(bytes, { integrity: sri(bytes) }),
      [remote({ fetch: fetchSpy as unknown as typeof fetch })],
    )
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(hashes(result))
      .toContainEqual(expect.objectContaining({ origin: 'berry-zip' }))
  })

  it('keeps transport failure as a named defer', async () => {
    const bytes = tarballOf()
    const result = await run(
      npmGraph(bytes, { integrity: sri(bytes) }),
      [remote({ fetch: vi.fn(async () => { throw new Error('offline') }) as unknown as typeof fetch })],
    )
    expect(codes(result)).toContain('ENRICH_ARTIFACT_FETCH_FAILED')
  })

  it('keeps terminal HTTP failure as a distinct named defer', async () => {
    const bytes = tarballOf()
    const result = await run(
      npmGraph(bytes, { integrity: sri(bytes) }),
      [remote({ fetch: vi.fn(async () => new Response(null, { status: 503 })) as unknown as typeof fetch })],
    )
    expect(codes(result)).toContain('ENRICH_ARTIFACT_HTTP_FAILED')
  })
})

describe('remote artifact bytes — central verification', () => {
  it('does not let successful bytes reach recompute without lock integrity', async () => {
    const bytes = tarballOf()
    const fetchSpy = vi.fn(async () => new Response(bytes))
    const result = await run(
      npmGraph(bytes),
      [remote({ fetch: fetchSpy as unknown as typeof fetch })],
    )
    expect(fetchSpy).toHaveBeenCalledOnce()
    expect(codes(result)).toContain('ENRICH_ARTIFACT_INTEGRITY_MISSING')
    expect(hashes(result).some(hash => hash.origin === 'berry-zip')).toBe(false)
  })

  it('rejects bytes that mismatch lock integrity before recompute', async () => {
    const bytes = tarballOf()
    const other = tarballOf('module.exports = 2\n')
    const result = await run(
      npmGraph(bytes, { integrity: sri(other) }),
      [remote({ fetch: vi.fn(async () => new Response(bytes)) as unknown as typeof fetch })],
    )
    expect(codes(result)).toContain('ENRICH_ARTIFACT_INTEGRITY_MISMATCH')
    expect(hashes(result).some(hash => hash.origin === 'berry-zip')).toBe(false)
  })

  it('requires every supported member of a lock multihash to agree', async () => {
    const bytes = tarballOf()
    const other = tarballOf('module.exports = 3\n')
    const result = await run(
      npmGraph(bytes, { integrity: `${sri(bytes)} ${sri(other, 'sha1')}` }),
      [remote({ fetch: vi.fn(async () => new Response(bytes)) as unknown as typeof fetch })],
    )
    expect(codes(result)).toContain('ENRICH_ARTIFACT_INTEGRITY_MISMATCH')
  })

  it('distinguishes unsupported-only integrity from absence', async () => {
    const bytes = tarballOf()
    const result = await run(
      npmGraph(bytes, { integrity: 'futurehash-AAAAAAAAAAAAAAAAAAAAAA==' }),
      [remote({ fetch: vi.fn(async () => new Response(bytes)) as unknown as typeof fetch })],
    )
    expect(codes(result)).toContain('ENRICH_ARTIFACT_INTEGRITY_UNSUPPORTED')
    expect(codes(result)).not.toContain('ENRICH_ARTIFACT_INTEGRITY_MISSING')
  })

  it.each([
    ['missing', 'ENRICH_ARTIFACT_INTEGRITY_MISSING'],
    ['mismatch', 'ENRICH_ARTIFACT_INTEGRITY_MISMATCH'],
    ['envelope', 'ENRICH_ARTIFACT_COMPRESSED_LIMIT'],
  ] as const)('never persists bytes rejected for %s verification', async (kind, code) => {
    const root = mkdtempSync(resolve(tmpdir(), 'lockgraph-artifact-rejected-'))
    try {
      const bytes = tarballOf()
      const graph = kind === 'missing'
        ? npmGraph(bytes)
        : npmGraph(bytes, {
            integrity: kind === 'mismatch'
              ? sri(tarballOf('different\n'))
              : sri(bytes),
          })
      const result = await enrich(graph, {
        store: lockgraphStore(root),
        sources: {
          artifacts: [
            remote({
              fetch: vi.fn(async () => new Response(bytes)) as unknown as typeof fetch,
            }),
          ],
        },
        target: 'yarn-berry-v8',
        contract: 'snapshot',
        cacheKey: '10c0',
        ...(kind === 'envelope'
          ? { artifactResources: { defaults: { maxCompressedBytes: 1 } } }
          : {}),
      })
      expect(result.diagnostics.map(item => item.code)).toContain(code)
      expect(filesBelow(resolve(root, 'objects'))).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('remote artifact bytes — failure boundaries', () => {
  it('keeps registry metadata failure distinct from URL rejection', async () => {
    const bytes = tarballOf()
    const registry = remote({
      attestedUrl: 'https://cdn.test/pkg.tgz',
      fetch: vi.fn(async () => new Response(bytes)) as unknown as typeof fetch,
    })
    registry.resolve = vi.fn(async () => { throw new Error('metadata offline') })
    const result = await run(
      npmGraph(bytes, {
        integrity: sri(bytes),
        url: 'https://cdn.test/pkg.tgz',
      }),
      [registry],
    )
    expect(codes(result)).toContain('ENRICH_ARTIFACT_REGISTRY_METADATA_FAILED')
  })

  it('rejects a body that violates Content-Length commitment', async () => {
    const bytes = tarballOf()
    const result = await run(
      npmGraph(bytes, { integrity: sri(bytes) }),
      [remote({
        fetch: vi.fn(async () => new Response(bytes, {
          headers: { 'content-length': String(bytes.byteLength - 1) },
        })) as unknown as typeof fetch,
      })],
    )
    expect(codes(result)).toContain('ENRICH_ARTIFACT_CONTENT_LENGTH_MISMATCH')
  })

  it.each([
    ['maxCompressedBytes', 'ENRICH_ARTIFACT_COMPRESSED_LIMIT'],
    ['maxInflatedBytes', 'ENRICH_ARTIFACT_INFLATED_LIMIT'],
    ['maxTarContentBytes', 'ENRICH_ARTIFACT_TAR_CONTENT_LIMIT'],
    ['maxRepackedBytes', 'ENRICH_ARTIFACT_REPACKED_LIMIT'],
    ['maxLiveBytes', 'ENRICH_ARTIFACT_LIVE_LIMIT'],
  ])('enforces caller %s with %s', async (field, code) => {
    const bytes = tarballOf()
    const artifactResources = field === 'maxLiveBytes'
      ? { maxLiveBytes: 1 }
      : { defaults: { [field]: 1 } }
    const result = await run(
      npmGraph(bytes, { integrity: sri(bytes) }),
      [remote({ fetch: vi.fn(async () => new Response(bytes)) as unknown as typeof fetch })],
      artifactResources,
    )
    expect(codes(result)).toContain(code)
  })

  it('default limit diagnostic names the override remedy', () => {
    const factory = (enrichDiagnostics as Record<string, unknown>).enrichArtifactLimit as
      | ((...args: unknown[]) => { message: string })
      | undefined
    expect(factory).toBeTypeOf('function')
    expect(factory?.('pkg@1.0.0', 'compressed', 1, 'default').message)
      .toMatch(/override/i)
  })

  it('caller limit diagnostic says the caller limit was reached', () => {
    const factory = (enrichDiagnostics as Record<string, unknown>).enrichArtifactLimit as
      | ((...args: unknown[]) => { message: string })
      | undefined
    expect(factory).toBeTypeOf('function')
    const message = factory?.('pkg@1.0.0', 'compressed', 1, 'artifact').message ?? ''
    expect(message).toMatch(/caller|provided/i)
    expect(message).not.toMatch(/raise|increase/i)
  })

  it('applies missing-integrity verification to local npm-cache bytes too', async () => {
    const bytes = tarballOf()
    const result = await runLocal(npmGraph(bytes), bytes)
    expect(codes(result)).toContain('ENRICH_ARTIFACT_INTEGRITY_MISSING')
    expect(hashes(result).some(hash => hash.origin === 'berry-zip')).toBe(false)
  })

  it('applies mismatch verification to local npm-cache bytes too', async () => {
    const bytes = tarballOf()
    const result = await runLocal(
      npmGraph(bytes, { integrity: sri(tarballOf('different\n')) }),
      bytes,
    )
    expect(codes(result)).toContain('ENRICH_ARTIFACT_INTEGRITY_MISMATCH')
    expect(hashes(result).some(hash => hash.origin === 'berry-zip')).toBe(false)
  })

  it('verifies a Yarn Classic resolved-fragment sha1 as tarball integrity', async () => {
    const bytes = tarballOf()
    const sha1 = createHash('sha1').update(bytes).digest('hex')
    const url = `https://registry.test/npm/pkg/-/pkg-1.0.0.tgz#${sha1}`
    const fetchSpy = vi.fn(async () => new Response(bytes))
    const result = await run(
      parse('yarn-classic', `pkg@1.0.0:
  version "1.0.0"
  resolved "${url}"
`),
      [remote({
        attestedUrl: url.replace(/#[a-f0-9]+$/, ''),
        fetch: fetchSpy as unknown as typeof fetch,
      })],
    )
    expect(fetchSpy).toHaveBeenCalledOnce()
    expect(codes(result)).not.toContain('ENRICH_ARTIFACT_INTEGRITY_MISSING')
    expect(hashes(result))
      .toContainEqual(expect.objectContaining({ origin: 'berry-zip' }))
  })

  it('deduplicates equal claimed routes without treating them as ambiguous', async () => {
    const bytes = tarballOf()
    const first = vi.fn(async () => new Response(bytes))
    const second = vi.fn(async () => new Response(bytes))
    const result = await run(npmGraph(bytes, { integrity: sri(bytes) }), [
      remote({ fetch: first as unknown as typeof fetch }),
      remote({ fetch: second as unknown as typeof fetch }),
    ])
    expect(first).toHaveBeenCalledOnce()
    expect(second).not.toHaveBeenCalled()
    expect(codes(result)).not.toContain('ENRICH_ARTIFACT_ROUTE_AMBIGUOUS')
  })

  it('does not accept an attestation for the wrong exact version', async () => {
    const bytes = tarballOf()
    const url = 'https://cdn.test/pkg.tgz'
    const fetchSpy = vi.fn(async () => new Response(bytes))
    const registry = remote({ attestedUrl: url, fetch: fetchSpy as unknown as typeof fetch })
    registry.resolve = vi.fn(async () => ({
      name: 'pkg',
      version: '2.0.0',
      tarball: url,
    }))
    const result = await run(
      npmGraph(bytes, { integrity: sri(bytes), url }),
      [registry],
    )
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(codes(result)).toContain('ENRICH_ARTIFACT_URL_UNAUTHORIZED')
  })

  it('resolves a relative redirect against the authorized response URL', async () => {
    const bytes = tarballOf()
    const redirected = 'https://registry.test/npm/pkg/-/actual.tgz'
    const fetchSpy = vi.fn(async (url: string) => url === redirected
      ? new Response(bytes)
      : new Response(null, { status: 302, headers: { location: './actual.tgz' } }))
    const result = await run(
      npmGraph(bytes, { integrity: sri(bytes) }),
      [remote({ fetch: fetchSpy as unknown as typeof fetch })],
    )
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(fetchSpy.mock.calls[1]?.[0]).toBe(redirected)
    expect(hashes(result))
      .toContainEqual(expect.objectContaining({ origin: 'berry-zip' }))
  })

  it('rejects a redirect without Location', async () => {
    const bytes = tarballOf()
    const result = await run(
      npmGraph(bytes, { integrity: sri(bytes) }),
      [remote({
        fetch: vi.fn(async () => new Response(null, { status: 302 })) as unknown as typeof fetch,
      })],
    )
    expect(codes(result)).toContain('ENRICH_ARTIFACT_REDIRECT_REJECTED')
  })

  it('rejects a redirect chain beyond the fixed hop bound', async () => {
    const bytes = tarballOf()
    let hop = 0
    const fetchSpy = vi.fn(async () => {
      hop++
      return new Response(null, {
        status: 302,
        headers: { location: `https://registry.test/npm/pkg/-/hop-${hop}.tgz` },
      })
    })
    const result = await run(
      npmGraph(bytes, { integrity: sri(bytes) }),
      [remote({ fetch: fetchSpy as unknown as typeof fetch })],
    )
    expect(fetchSpy.mock.calls.length).toBeGreaterThan(1)
    expect(fetchSpy.mock.calls.length).toBeLessThanOrEqual(6)
    expect(codes(result)).toContain('ENRICH_ARTIFACT_REDIRECT_REJECTED')
  })

  it('rejects encoded path separators at a configured path boundary', async () => {
    const bytes = tarballOf()
    const url = 'https://registry.test/npm%2fevil/pkg.tgz'
    const fetchSpy = vi.fn(async () => new Response(bytes))
    const result = await run(
      npmGraph(bytes, { integrity: sri(bytes), url }),
      [remote({
        attestedUrl: 'https://different.test/pkg.tgz',
        fetch: fetchSpy as unknown as typeof fetch,
      })],
    )
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(codes(result)).toContain('ENRICH_ARTIFACT_URL_UNAUTHORIZED')
  })

  it('does not carry authorization to an unauthorized redirect target', async () => {
    const bytes = tarballOf()
    const calls: Array<{ url: string; auth: string | null }> = []
    const fetchSpy = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({
        url,
        auth: new Headers(init?.headers).get('authorization'),
      })
      return new Response(null, {
        status: 302,
        headers: { location: 'https://hostile.test/pkg.tgz' },
      })
    })
    await run(
      npmGraph(bytes, { integrity: sri(bytes) }),
      [remote({
        authHeader: 'Bearer secret',
        fetch: fetchSpy as unknown as typeof fetch,
      })],
    )
    expect(calls).toEqual([{
      url: 'https://registry.test/npm/pkg/-/pkg-1.0.0.tgz',
      auth: 'Bearer secret',
    }])
  })

  it('rejects Content-Length above the compressed ceiling before reading body', async () => {
    const bytes = tarballOf()
    let bodyReads = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        bodyReads++
        controller.enqueue(bytes)
        controller.close()
      },
    })
    const response = new Response(body, {
      headers: { 'content-length': String(bytes.byteLength) },
    })
    await Promise.resolve()
    const readsAtConstruction = bodyReads
    const result = await run(
      npmGraph(bytes, { integrity: sri(bytes) }),
      [remote({
        fetch: vi.fn(async () => response) as unknown as typeof fetch,
      })],
      { defaults: { maxCompressedBytes: bytes.byteLength - 1 } },
    )
    expect(bodyReads).toBe(readsAtConstruction)
    expect(codes(result)).toContain('ENRICH_ARTIFACT_COMPRESSED_LIMIT')
  })
})

describe('live registry — dynamic artifact routing compatibility', () => {
  it('builds a dynamic fromConfig adapter with an artifact route capability', () => {
    const registry = (liveRegistry.fromConfig as unknown as (
      cwd: string,
      options: Record<string, unknown>,
    ) => RegistryAdapter & Record<string, unknown>)('/no/files', {
      config: 'npm',
      env: { npm_config_registry: 'https://registry.test/npm' },
      home: '/no/home',
      fetch: vi.fn(),
    })
    expect(registry.artifactRoute).toBeTypeOf('function')
  })
})
