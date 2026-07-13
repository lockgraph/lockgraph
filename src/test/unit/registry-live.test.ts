// Phase D-A — `liveRegistry` HTTPS adapter unit suite.
//
// All tests use a mock `fetch` (vi.fn) — NEVER hit a real network. The
// suite covers the contract surface (packument 200/404/5xx, scoped name
// encoding, auth header, custom URL) and the resolve() dispatch matrix
// (exact / dist-tag / range / unresolved / unknown package).

import { describe, expect, it, vi } from 'vitest'
import { liveRegistry, type LiveRegistryOptions } from '../../main/ts/index.ts'
import { canonicalDigest } from '../../main/ts/recipe/integrity.ts'

const LODASH_BODY = {
  name: 'lodash',
  'dist-tags': { latest: '4.17.21' },
  versions: {
    '4.16.0': {
      name:    'lodash',
      version: '4.16.0',
      dist:    {
        tarball:   'https://registry.npmjs.org/lodash/-/lodash-4.16.0.tgz',
        integrity: 'sha512-aaa==',
      },
    },
    '4.17.20': {
      name:    'lodash',
      version: '4.17.20',
      dist:    {
        tarball:   'https://registry.npmjs.org/lodash/-/lodash-4.17.20.tgz',
        integrity: 'sha512-bbb==',
      },
    },
    '4.17.21': {
      name:         'lodash',
      version:      '4.17.21',
      dist:         {
        tarball:   'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz',
        integrity: 'sha512-6IMTriUmvsjHUjNtEDudZfuDQUoWXVxKHhlEGSk81n4YFS+r/Kl99wXiwlVXtPBtJenozv2P+hxDsw9eA7Xo6g==',
      },
      dependencies: { 'pretend-dep': '^1.0.0' },
      engines:      { node: '>=4' },
      funding:      { url: 'https://example.test/fund' },
      scripts:      { install: 'node install.js' },
    },
  },
}

interface MockResponseInit {
  status?:   number
  body?:     unknown
  jsonThrows?: boolean
}

function mockResponse({ status = 200, body = {}, jsonThrows = false }: MockResponseInit = {}) {
  return {
    ok:     status >= 200 && status < 300,
    status,
    json:   async () => {
      if (jsonThrows) throw new Error('invalid json')
      return body
    },
  } as Response
}

function buildOpts(spy: typeof fetch, extras: Partial<LiveRegistryOptions> = {}): LiveRegistryOptions {
  return { fetch: spy, ...extras }
}

describe('registry/live — packument()', () => {
  it('returns a normalised Packument on 200', async () => {
    const spy = vi.fn(async () => mockResponse({ body: LODASH_BODY }))
    const reg = liveRegistry(buildOpts(spy as unknown as typeof fetch))

    const packument = await reg.packument('lodash')
    expect(packument).toBeDefined()
    expect(packument!.name).toBe('lodash')
    expect(packument!.distTags).toEqual({ latest: '4.17.21' })
    expect(Object.keys(packument!.versions).sort())
      .toEqual(['4.16.0', '4.17.20', '4.17.21'])
    // dist.tarball / dist.integrity lifted to flat PackumentVersion fields
    const v = packument!.versions['4.17.21']!
    expect(v.tarball).toBe('https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz')
    expect(canonicalDigest(v.integrity!)).toBe('sha512-6IMTriUmvsjHUjNtEDudZfuDQUoWXVxKHhlEGSk81n4YFS+r/Kl99wXiwlVXtPBtJenozv2P+hxDsw9eA7Xo6g==')
    expect(v.dependencies).toEqual({ 'pretend-dep': '^1.0.0' })
    expect(v.engines).toEqual({ node: '>=4' })
    expect(v.funding).toEqual({ url: 'https://example.test/fund' })
    expect(v.hasInstallScript).toBe(true)
  })

  it('returns undefined on 404 (no throw)', async () => {
    const spy = vi.fn(async () => mockResponse({ status: 404 }))
    const reg = liveRegistry(buildOpts(spy as unknown as typeof fetch))

    const packument = await reg.packument('does-not-exist')
    expect(packument).toBeUndefined()
  })

  it('throws on 500 with status and URL in message', async () => {
    const spy = vi.fn(async () => mockResponse({ status: 500 }))
    const reg = liveRegistry(buildOpts(spy as unknown as typeof fetch))

    await expect(reg.packument('lodash')).rejects.toThrow(/500/)
    await expect(reg.packument('lodash')).rejects.toThrow(/lodash/)
  })

  it('encodes scoped package names (@scope/pkg → @scope%2Fpkg)', async () => {
    const spy = vi.fn(async () => mockResponse({ body: { name: '@scope/pkg', 'dist-tags': {}, versions: {} } }))
    const reg = liveRegistry(buildOpts(spy as unknown as typeof fetch))

    await reg.packument('@scope/pkg')
    expect(spy).toHaveBeenCalledOnce()
    const [url] = (spy as any).mock.calls[0]
    expect(url).toContain('@scope%2Fpkg')
    expect(url).not.toContain('@scope/pkg')
  })

  it('sends Authorization: Bearer header when opts.auth is set', async () => {
    const spy = vi.fn(async () => mockResponse({ body: { name: 'private-pkg', 'dist-tags': {}, versions: {} } }))
    const reg = liveRegistry(buildOpts(spy as unknown as typeof fetch, { auth: 'secret-token' }))

    await reg.packument('private-pkg')
    const [, init] = (spy as any).mock.calls[0]
    const headers = init.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer secret-token')
  })

  it('omits Authorization header when opts.auth is absent', async () => {
    const spy = vi.fn(async () => mockResponse({ body: { name: 'lodash', 'dist-tags': {}, versions: {} } }))
    const reg = liveRegistry(buildOpts(spy as unknown as typeof fetch))

    await reg.packument('lodash')
    const [, init] = (spy as any).mock.calls[0]
    const headers = init.headers as Record<string, string>
    expect(headers.authorization).toBeUndefined()
  })

  it('sends compact-form Accept header', async () => {
    const spy = vi.fn(async () => mockResponse({ body: { name: 'lodash', 'dist-tags': {}, versions: {} } }))
    const reg = liveRegistry(buildOpts(spy as unknown as typeof fetch))

    await reg.packument('lodash')
    const [, init] = (spy as any).mock.calls[0]
    const headers = init.headers as Record<string, string>
    expect(headers.accept).toContain('application/vnd.npm.install-v1+json')
  })

  it('respects a custom registry URL', async () => {
    const spy = vi.fn(async () => mockResponse({ body: { name: 'lodash', 'dist-tags': {}, versions: {} } }))
    const reg = liveRegistry(buildOpts(spy as unknown as typeof fetch, { url: 'https://npm.example.com' }))

    await reg.packument('lodash')
    const [url] = (spy as any).mock.calls[0]
    expect(url).toBe('https://npm.example.com/lodash')
  })

  it('strips a trailing slash on the registry URL', async () => {
    const spy = vi.fn(async () => mockResponse({ body: { name: 'lodash', 'dist-tags': {}, versions: {} } }))
    const reg = liveRegistry(buildOpts(spy as unknown as typeof fetch, { url: 'https://npm.example.com/' }))

    await reg.packument('lodash')
    const [url] = (spy as any).mock.calls[0]
    expect(url).toBe('https://npm.example.com/lodash')
  })
})

describe('registry/live — resolve()', () => {
  it('resolves an exact version', async () => {
    const spy = vi.fn(async () => mockResponse({ body: LODASH_BODY }))
    const reg = liveRegistry(buildOpts(spy as unknown as typeof fetch))

    const v = await reg.resolve('lodash', '4.17.21')
    expect(v?.version).toBe('4.17.21')
    expect(v?.tarball).toBe('https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz')
  })

  it('resolves a dist-tag (latest)', async () => {
    const spy = vi.fn(async () => mockResponse({ body: LODASH_BODY }))
    const reg = liveRegistry(buildOpts(spy as unknown as typeof fetch))

    const v = await reg.resolve('lodash', 'latest')
    expect(v?.version).toBe('4.17.21')
  })

  it('resolves a semver range via maxSatisfying', async () => {
    const spy = vi.fn(async () => mockResponse({ body: LODASH_BODY }))
    const reg = liveRegistry(buildOpts(spy as unknown as typeof fetch))

    const v = await reg.resolve('lodash', '^4.17.0')
    expect(v?.version).toBe('4.17.21')
  })

  it('resolves a semver range when only an older satisfier exists', async () => {
    const spy = vi.fn(async () => mockResponse({ body: LODASH_BODY }))
    const reg = liveRegistry(buildOpts(spy as unknown as typeof fetch))

    const v = await reg.resolve('lodash', '4.16.x')
    expect(v?.version).toBe('4.16.0')
  })

  it('returns undefined when the package is unknown (404 packument)', async () => {
    const spy = vi.fn(async () => mockResponse({ status: 404 }))
    const reg = liveRegistry(buildOpts(spy as unknown as typeof fetch))

    const v = await reg.resolve('does-not-exist', '^1.0.0')
    expect(v).toBeUndefined()
  })

  it('returns undefined for an unsatisfiable range', async () => {
    const spy = vi.fn(async () => mockResponse({ body: LODASH_BODY }))
    const reg = liveRegistry(buildOpts(spy as unknown as typeof fetch))

    const v = await reg.resolve('lodash', '^9999.0.0')
    expect(v).toBeUndefined()
  })

  it('returns undefined for a malformed range without throwing', async () => {
    const spy = vi.fn(async () => mockResponse({ body: LODASH_BODY }))
    const reg = liveRegistry(buildOpts(spy as unknown as typeof fetch))

    const v = await reg.resolve('lodash', 'not-a-valid-range >>>')
    expect(v).toBeUndefined()
  })
})

describe('registry/live — option handling', () => {
  it('constructs without a global fetch — node-fetch-native is the default impl', () => {
    // The default fetch is node-fetch-native (native `fetch` on Node 18+, a
    // polyfill on 14–17), so construction never depends on `globalThis.fetch`.
    const originalFetch = (globalThis as any).fetch
    try {
      delete (globalThis as any).fetch
      const reg = liveRegistry()
      expect(typeof reg.packument).toBe('function')
      expect(typeof reg.resolve).toBe('function')
    } finally {
      ;(globalThis as any).fetch = originalFetch
    }
  })

  it('throws at construction when opts.fetch is supplied but not a function', () => {
    expect(() => liveRegistry({ fetch: 123 as unknown as typeof fetch })).toThrow(/fetch/)
  })
})

describe('registry/live — resolve() libc enrichment (corgi drops libc → YN0028 without this)', () => {
  const corgiOf = (name: string, extra: Record<string, unknown>) => ({
    name, 'dist-tags': { latest: '1.0.1' },
    versions: { '1.0.1': { name, version: '1.0.1', dist: { tarball: 't', integrity: 'sha512-x==' }, ...extra } },
  })

  it('enriches a LINUX platform version with libc from the single-version manifest', async () => {
    const corgi = corgiOf('native-linux', { os: ['linux'], cpu: ['x64'] })          // corgi: NO libc
    const full  = { name: 'native-linux', version: '1.0.1', os: ['linux'], cpu: ['x64'], libc: ['glibc'], dist: { tarball: 't', integrity: 'sha512-x==' } }
    const spy = vi.fn(async (url: string) => mockResponse({ body: String(url).endsWith('/1.0.1') ? full : corgi }))
    const reg = liveRegistry(buildOpts(spy as unknown as typeof fetch))
    const pv = await reg.resolve('native-linux', '^1.0.0')
    expect(pv?.libc).toEqual(['glibc'])
    expect(spy.mock.calls.some(c => String(c[0]).endsWith('/1.0.1'))).toBe(true)     // single-version doc consulted
  })

  it('does NOT extra-fetch for a NON-linux platform version (corgi already complete)', async () => {
    const corgi = corgiOf('native-darwin', { os: ['darwin'], cpu: ['arm64'] })
    const spy = vi.fn(async (_url: string) => mockResponse({ body: corgi }))
    const reg = liveRegistry(buildOpts(spy as unknown as typeof fetch))
    const pv = await reg.resolve('native-darwin', '^1.0.0')
    expect(pv?.os).toEqual(['darwin'])
    expect(pv?.libc).toBeUndefined()
    expect(spy.mock.calls.every(c => !String(c[0]).endsWith('/1.0.1'))).toBe(true)   // no enrichment fetch
  })

  it('falls back to the corgi version when the single-version manifest fetch fails', async () => {
    const corgi = corgiOf('native-linux', { os: ['linux'], cpu: ['x64'] })
    const spy = vi.fn(async (url: string) => String(url).endsWith('/1.0.1') ? mockResponse({ status: 500 }) : mockResponse({ body: corgi }))
    const reg = liveRegistry(buildOpts(spy as unknown as typeof fetch))
    const pv = await reg.resolve('native-linux', '^1.0.0')
    expect(pv?.os).toEqual(['linux'])                                               // still resolves, degraded (no libc, no throw)
    expect(pv?.libc).toBeUndefined()
  })
})

describe('registry/live — limit (scheduling seam)', () => {
  it('routes every registry call through the injected limiter', async () => {
    let scheduled = 0
    const limit = <T,>(task: () => Promise<T>): Promise<T> => { scheduled++; return task() }
    const spy = vi.fn(async () => mockResponse({ body: LODASH_BODY }))
    const reg = liveRegistry(buildOpts(spy as unknown as typeof fetch, { limit }))
    await reg.packument('lodash')
    expect(scheduled).toBe(1)             // the fetch was scheduled through the limiter
    expect(spy).toHaveBeenCalledTimes(1)  // and actually ran
  })

  it('surfaces the injected limiter on the adapter (.limit); a callable identity when unset', async () => {
    const limit = <T,>(task: () => Promise<T>): Promise<T> => task()
    expect(liveRegistry(buildOpts(vi.fn() as unknown as typeof fetch, { limit })).limit).toBe(limit)
    // unset ⇒ a bound identity limiter, always callable (no NPE for a direct registry.limit(task))
    const unset = liveRegistry(buildOpts(vi.fn() as unknown as typeof fetch)).limit
    expect(unset).toBeTypeOf('function')
    expect(await unset!(async () => 42)).toBe(42)
  })

  it('bounds concurrency — a pool of 1 serialises overlapping calls (peak = 1)', async () => {
    let active = 0, peak = 0, chain: Promise<unknown> = Promise.resolve()
    const limit = <T,>(task: () => Promise<T>): Promise<T> => {
      const run = chain.then(async () => {
        active++; peak = Math.max(peak, active)
        try { return await task() } finally { active-- }
      })
      chain = run.catch(() => undefined)
      return run
    }
    const spy = vi.fn(async () => mockResponse({ body: LODASH_BODY }))
    const reg = liveRegistry(buildOpts(spy as unknown as typeof fetch, { limit }))
    await Promise.all([reg.packument('a'), reg.packument('b'), reg.packument('c')])
    expect(peak).toBe(1)
    expect(spy).toHaveBeenCalledTimes(3)
  })
})
