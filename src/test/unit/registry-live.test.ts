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
  it('throws at construction when no fetch is available and none supplied', () => {
    const originalFetch = (globalThis as any).fetch
    try {
      delete (globalThis as any).fetch
      expect(() => liveRegistry()).toThrow(/fetch/)
    } finally {
      ;(globalThis as any).fetch = originalFetch
    }
  })
})
