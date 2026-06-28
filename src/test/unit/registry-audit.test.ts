// registry/liveRegistry.audit — thin RAW bulk-advisory fetch (no normalization).

import { describe, it, expect } from 'vitest'
import { liveRegistry } from '../../main/ts/registry/live.ts'

type SpyInit = { method?: string; body?: string; headers?: Record<string, string> }
const okJson = (value: unknown) => ({ ok: true, status: 200, json: async () => value })

describe('registry/liveRegistry.audit (raw bulk-advisory)', () => {
  it('POSTs the bulk endpoint with auth and returns the raw advisories', async () => {
    const calls: Array<{ url: string; init?: SpyInit }> = []
    const fetchSpy = (async (url: string, init?: SpyInit) => {
      calls.push({ url: String(url), init })
      return okJson({ lodash: [{ id: 1, severity: 'high' }] })
    }) as unknown as typeof fetch

    const reg = liveRegistry({ url: 'https://reg.example.com', auth: 'TOK', fetch: fetchSpy })
    const res = await reg.audit({ lodash: ['4.17.20'], minimist: ['1.2.0'] })

    expect(calls[0]!.url).toBe('https://reg.example.com/-/npm/v1/security/advisories/bulk')
    expect(calls[0]!.init?.method).toBe('POST')
    expect(calls[0]!.init?.headers?.authorization).toBe('Bearer TOK')
    expect(JSON.parse(calls[0]!.init!.body!)).toEqual({ lodash: ['4.17.20'], minimist: ['1.2.0'] })
    expect(res).toEqual({ lodash: [{ id: 1, severity: 'high' }] }) // raw; only pkgs WITH advisories
  })

  it('chunks large maps and merges the raw results', async () => {
    const seen: Array<Record<string, string[]>> = []
    const fetchSpy = (async (_url: string, init?: SpyInit) => {
      const batch = JSON.parse(init!.body!) as Record<string, string[]>
      seen.push(batch)
      const name = Object.keys(batch)[0]!
      return okJson({ [name]: [{ pkg: name }] })
    }) as unknown as typeof fetch

    const reg = liveRegistry({ fetch: fetchSpy })
    const res = await reg.audit({ a: ['1.0.0'], b: ['2.0.0'], c: ['3.0.0'] }, { chunkSize: 1 })

    expect(seen.length).toBe(3)
    expect(res).toEqual({ a: [{ pkg: 'a' }], b: [{ pkg: 'b' }], c: [{ pkg: 'c' }] })
  })

  it('no packages → no request, empty result', async () => {
    let called = false
    const fetchSpy = (async () => { called = true; return okJson({}) }) as unknown as typeof fetch
    const reg = liveRegistry({ fetch: fetchSpy })
    expect(await reg.audit({})).toEqual({})
    expect(called).toBe(false)
  })
})
