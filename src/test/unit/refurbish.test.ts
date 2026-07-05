// ADR-0034 enrich phase / `refurbish` — install-completeness for the berry
// `checksum`. The recompute (ADR-0035) is exercised against vendored tarballs.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { refurbish, type TarballSource } from '../../main/ts/enrich/refurbish.ts'
import { computeBerryChecksum } from '../../main/ts/recipe/berry-checksum.ts'
import { emitBerryChecksum } from '../../main/ts/recipe/integrity.ts'
import { sentinelHashOf } from '../../main/ts/recipe/patch.ts'
import { graphOf, addPackage } from './_modify-test-utils.ts'

const here = dirname(fileURLToPath(import.meta.url))
const tgz = (rel: string): Buffer => readFileSync(resolve(here, '../resources/fixtures/tarballs', rel))

const sourceOf = (map: Record<string, Buffer>): TarballSource => ({
  // eslint-disable-next-line @typescript-eslint/require-await
  async tarball(name: string, version: string): Promise<Uint8Array | undefined> {
    return map[`${name}@${version}`]
  },
})

describe('enrich/refurbish (ADR-0034 + ADR-0035)', () => {
  it('recomputes a missing berry checksum from the tarball (STORE)', async () => {
    const graph = graphOf(b => { addPackage(b, { name: 'ms', version: '2.1.3' }) })
    const r = await refurbish(graph, 'yarn-berry-v8', sourceOf({ 'ms@2.1.3': tgz('ms-2.1.3.tgz') }))

    expect(r.enriched).toEqual(['ms@2.1.3'])
    const payload = r.graph.tarballOf('ms@2.1.3')
    // A fill never sets `berryChecksumCacheKey` (that field round-trips a PARSED
    // prefix); the prefix-era `<cacheKey>/` rendering is the format's job.
    expect(payload?.berryChecksumCacheKey).toBeUndefined()
    expect(emitBerryChecksum(payload!.integrity!)).toBe(
      computeBerryChecksum(tgz('ms-2.1.3.tgz'), 'ms', '10c0'),
    )
    expect(r.unresolved.map(d => d.code)).toEqual(['ENRICH_FIELD_FILLED'])
    // dual-channel — also on Graph.diagnostics()
    expect(r.graph.diagnostics().map(d => d.code)).toContain('ENRICH_FIELD_FILLED')
  })

  it('defers (warning, line omitted) when the tarball is unavailable', async () => {
    const graph = graphOf(b => { addPackage(b, { name: 'ms', version: '2.1.3' }) })
    const r = await refurbish(graph, 'yarn-berry-v8', sourceOf({}))

    expect(r.enriched).toEqual([])
    expect(r.unresolved.map(d => d.code)).toEqual(['ENRICH_CHECKSUM_DEFERRED'])
    expect(r.unresolved[0]!.severity).toBe('warning')
    expect(r.graph.tarballOf('ms@2.1.3')?.integrity).toBeUndefined()
  })

  it('defers a sentinel-patched node — never setTarball on a sentinel (fsevents @patch:!builtin)', async () => {
    // A `@patch:…#optional!builtin` node (e.g. fsevents) carries a SENTINEL patch
    // (unresolved bytes). It has a checksum gap, but its digest hashes the PATCHED
    // zip — and a sentinel refuses setTarball outright. refurbish must DEFER it,
    // not crash. (Real yaf run on qiwi/mware: `setTarball: sentinel-keyed entries
    // refuse mutation (fsevents@2.3.3)`.)
    const sentinel = sentinelHashOf('fsevents@npm:2.3.3#optional!builtin<compat/fsevents>')
    const graph = graphOf(b => { addPackage(b, { name: 'fsevents', version: '2.3.3', patch: sentinel }) })
    // a base tarball IS available — refurbish must STILL skip via the patch guard,
    // proving it's not the no-tarball defer path.
    const r = await refurbish(graph, 'yarn-berry-v8', sourceOf({ 'fsevents@2.3.3': tgz('ms-2.1.3.tgz') }))

    expect(r.enriched).toEqual([])
    expect(r.unresolved.map(d => d.code)).toEqual(['ENRICH_CHECKSUM_DEFERRED'])
    expect(r.graph.getNode(`fsevents@2.3.3+patch=${sentinel}`)).toBeDefined()
  })

  it('defers a bare-era v6 lock when the cacheKey is indeterminable — never guesses a 10c0 yarn-3 rejects', async () => {
    // A bare-era lock (v4–v7) carries NO per-node `<cacheKey>/` prefix, so with
    // no `opts.cacheKey` the target cacheKey is unknowable. refurbish must DEFER
    // even though a tarball is available, NOT fabricate a yarn-4 `10c0/` STORE
    // digest (wrong value AND wrong format — yarn-3 rewrites the whole lock).
    const graph = graphOf(b => { addPackage(b, { name: 'ms', version: '2.1.3' }) })
    const r = await refurbish(graph, 'yarn-berry-v6', sourceOf({ 'ms@2.1.3': tgz('ms-2.1.3.tgz') }))

    expect(r.enriched).toEqual([])
    expect(r.unresolved.map(d => d.code)).toEqual(['ENRICH_CHECKSUM_DEFERRED'])
    expect(r.graph.tarballOf('ms@2.1.3')?.integrity).toBeUndefined()
  })

  it('fills a bare-era v6 lock from opts.cacheKey (mixed cacheKey 8 — qiwi/mware path)', async () => {
    // The real driving case: yarn 3.8 pins `__metadata.cacheKey: 8` with BARE
    // checksums. Given that cacheKey, ADR-0035 reproduces the `mixed` digest
    // byte-exact (pako). The fill carries the cacheKey-8 value and leaves the
    // bare-vs-prefix rendering to the v6 format (`checksumPrefix: false`) — so a
    // fill never forces a foreign `8/` prefix into the bare lock.
    const graph = graphOf(b => { addPackage(b, { name: 'ms', version: '2.1.3' }) })
    const r = await refurbish(graph, 'yarn-berry-v6', sourceOf({ 'ms@2.1.3': tgz('ms-2.1.3.tgz') }), { cacheKey: '8' })

    expect(r.enriched).toEqual(['ms@2.1.3'])
    expect(emitBerryChecksum(r.graph.tarballOf('ms@2.1.3')!.integrity!)).toBe(
      computeBerryChecksum(tgz('ms-2.1.3.tgz'), 'ms', '8'),
    )
    // no forced prefix → the v6 (bare-era) emit renders the hex without `8/`.
    expect(r.graph.tarballOf('ms@2.1.3')?.berryChecksumCacheKey).toBeUndefined()
  })

  it('recomputes CONCURRENTLY — parallel tarball fetch, not one-at-a-time', async () => {
    const graph = graphOf(b => {
      addPackage(b, { name: 'ms',                   version: '2.1.3' })
      addPackage(b, { name: 'is-buffer',            version: '2.0.5' })
      addPackage(b, { name: '@kwsites/file-exists', version: '1.1.1' })
    })
    const bytes: Record<string, Buffer> = {
      'ms@2.1.3':                   tgz('ms-2.1.3.tgz'),
      'is-buffer@2.0.5':            tgz('is-buffer-2.0.5.tgz'),
      '@kwsites/file-exists@1.1.1': tgz('kwsites-file-exists-1.1.1.tgz'),
    }
    let inFlight = 0
    let peak = 0
    const source: TarballSource = {
      async tarball(name, version) {
        inFlight++; peak = Math.max(peak, inFlight)
        await new Promise(r => setTimeout(r, 15))   // hold the slot so overlap is observable
        inFlight--
        return bytes[`${name}@${version}`]
      },
    }
    const r = await refurbish(graph, 'yarn-berry-v8', source)
    expect(r.enriched.length).toBe(3)
    expect(peak).toBeGreaterThan(1)                 // fetches overlapped (serial would peak at 1)
    // order preserved (content-sorted node order), regardless of fetch race.
    expect(r.enriched).toEqual([...r.enriched].sort())
  })

  it('uses a caller-supplied cached berryChecksum — NO tarball fetch, no recompute', async () => {
    const graph = graphOf(b => { addPackage(b, { name: 'ms', version: '2.1.3' }) })
    // the true STORE digest, supplied "from .yarn/cache" — tarball must NOT be touched.
    const cachedHex = computeBerryChecksum(tgz('ms-2.1.3.tgz'), 'ms', '10c0')
    let tarballCalled = false
    const source: TarballSource = {
      async tarball() { tarballCalled = true; return undefined },
      async berryChecksum(name, version, cacheKey) {
        return name === 'ms' && version === '2.1.3' && cacheKey === '10c0' ? cachedHex : undefined
      },
    }
    const r = await refurbish(graph, 'yarn-berry-v8', source)

    expect(tarballCalled).toBe(false)                  // fast path — no fetch, no recompute
    expect(r.enriched).toEqual(['ms@2.1.3'])
    expect(emitBerryChecksum(r.graph.tarballOf('ms@2.1.3')!.integrity!)).toBe(cachedHex)
  })

  it('falls back to tarball recompute when berryChecksum misses (cache miss)', async () => {
    const graph = graphOf(b => { addPackage(b, { name: 'ms', version: '2.1.3' }) })
    let tarballCalled = false
    const source: TarballSource = {
      async tarball(name) { tarballCalled = true; return name === 'ms' ? tgz('ms-2.1.3.tgz') : undefined },
      async berryChecksum() { return undefined },      // cache miss → fall back
    }
    const r = await refurbish(graph, 'yarn-berry-v8', source)

    expect(tarballCalled).toBe(true)
    expect(r.enriched).toEqual(['ms@2.1.3'])
    expect(emitBerryChecksum(r.graph.tarballOf('ms@2.1.3')!.integrity!)).toBe(
      computeBerryChecksum(tgz('ms-2.1.3.tgz'), 'ms', '10c0'),
    )
  })

  it('noop on a non-berry target (npm/pnpm integrity is completion-filled)', async () => {
    const graph = graphOf(b => { addPackage(b, { name: 'ms', version: '2.1.3' }) })
    const r = await refurbish(graph, 'npm-3', sourceOf({}))

    expect(r.enriched).toEqual([])
    expect(r.unresolved.map(d => d.code)).toEqual(['ENRICH_NOOP'])
  })

  it('is idempotent — a second pass fills nothing (checksum now present)', async () => {
    const graph = graphOf(b => { addPackage(b, { name: 'ms', version: '2.1.3' }) })
    const src = sourceOf({ 'ms@2.1.3': tgz('ms-2.1.3.tgz') })
    const first = await refurbish(graph, 'yarn-berry-v8', src)
    const second = await refurbish(first.graph, 'yarn-berry-v8', src)

    expect(second.enriched).toEqual([])
    expect(second.unresolved.map(d => d.code)).toEqual(['ENRICH_NOOP'])
  })

  it('fills every gap node in a changed subtree (multi-node, no seed)', async () => {
    const graph = graphOf(b => {
      addPackage(b, { name: 'ms',                   version: '2.1.3' })
      addPackage(b, { name: 'is-buffer',            version: '2.0.5' })
      addPackage(b, { name: '@kwsites/file-exists', version: '1.1.1' })
    })
    const src = sourceOf({
      'ms@2.1.3':                   tgz('ms-2.1.3.tgz'),
      'is-buffer@2.0.5':            tgz('is-buffer-2.0.5.tgz'),
      '@kwsites/file-exists@1.1.1': tgz('kwsites-file-exists-1.1.1.tgz'),
    })
    const r = await refurbish(graph, 'yarn-berry-v8', src)

    expect([...r.enriched].sort()).toEqual(
      ['@kwsites/file-exists@1.1.1', 'is-buffer@2.0.5', 'ms@2.1.3'],
    )
    for (const [id, ident, file] of [
      ['ms@2.1.3', 'ms', 'ms-2.1.3.tgz'],
      ['is-buffer@2.0.5', 'is-buffer', 'is-buffer-2.0.5.tgz'],
      ['@kwsites/file-exists@1.1.1', '@kwsites/file-exists', 'kwsites-file-exists-1.1.1.tgz'],
    ] as const) {
      expect(emitBerryChecksum(r.graph.tarballOf(id)!.integrity!))
        .toBe(computeBerryChecksum(tgz(file), ident, '10c0'))
    }
  })

  it('seed bounds the fill — an unseeded gap node is untouched', async () => {
    const graph = graphOf(b => {
      addPackage(b, { name: 'ms',        version: '2.1.3' })
      addPackage(b, { name: 'is-buffer', version: '2.0.5' })
    })
    const src = sourceOf({ 'ms@2.1.3': tgz('ms-2.1.3.tgz'), 'is-buffer@2.0.5': tgz('is-buffer-2.0.5.tgz') })
    const r = await refurbish(graph, 'yarn-berry-v8', src, { seed: new Set(['ms@2.1.3']) })

    expect(r.enriched).toEqual(['ms@2.1.3'])
    expect(r.graph.tarballOf('is-buffer@2.0.5')?.integrity).toBeUndefined()
  })

  it('DEFERS a `mixed` cacheKey — never writes a wrong berry checksum (yaf pijma compressionLevel: mixed)', async () => {
    // pijma pins `compressionLevel: mixed` → cacheKey `10` (no `cN` suffix). pako
    // can't reproduce v10 mixed and libzip's one-anchor calibration is unsound for
    // the per-file heuristic, so a gap must DEFER: a wrong value hard-fails
    // `yarn install --immutable` (YN0018), a clean omit yarn recomputes on install.
    // The source must not even be consulted (a defer candidate skips fetch + fast-path).
    const graph = graphOf(b => {
      addPackage(b, { name: 'app',        version: '0.0.0', workspacePath: '.' })
      addPackage(b, { name: 'selfsigned', version: '5.5.0' })
    })
    let consulted = false
    const source: TarballSource = {
      async tarball() { consulted = true; return undefined },
      async berryChecksum() { consulted = true; return 'ab'.repeat(64) },
    }
    const r = await refurbish(graph, 'yarn-berry-v10', source, { cacheKey: '10' })

    expect(r.enriched).toEqual([])
    expect(r.graph.tarballOf('selfsigned@5.5.0')?.integrity).toBeUndefined()
    expect(consulted).toBe(false)
  })
})
