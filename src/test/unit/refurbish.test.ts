// ADR-0034 enrich phase / `refurbish` — install-completeness for the berry
// `checksum`. The recompute (ADR-0035) is exercised against vendored tarballs.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LockfileError, parse, stringify } from '../../main/ts/index.ts'
import { refurbish, type TarballSource } from '../../main/ts/enrich/refurbish.ts'
import { computeBerryChecksum } from '../../main/ts/recipe/berry-checksum.ts'
import { emitBerryChecksum, emptyIntegrity, mergeIntegrity } from '../../main/ts/recipe/integrity.ts'
import { sentinelHashOf } from '../../main/ts/recipe/patch.ts'
import { graphOf, addPackage } from './_modify-test-utils.ts'

const here = dirname(fileURLToPath(import.meta.url))
const tgz = (rel: string): Buffer => readFileSync(resolve(here, '../resources/fixtures/tarballs', rel))
const berryV8Lock = (): string => readFileSync(
  resolve(here, '../resources/fixtures/lockfiles/simple/yarn-berry-v8.lock'),
  'utf8',
)

const sourceOf = (map: Record<string, Buffer>): TarballSource => ({
  // eslint-disable-next-line @typescript-eslint/require-await
  async tarball(name: string, version: string): Promise<Uint8Array | undefined> {
    return map[`${name}@${version}`]
  },
})

const checksumSource = (hex = 'ab'.repeat(64)): TarballSource => ({
  // eslint-disable-next-line @typescript-eslint/require-await
  async tarball(): Promise<undefined> { return undefined },
  // eslint-disable-next-line @typescript-eslint/require-await
  async berryChecksum(): Promise<string> { return hex },
})

// A `berry-zip` sha512 as an integrity carrier — used to seed a sibling ANCHOR
// checksum that `calibrate` vets the pure-JS port against.
const berryZip = (hex: string) =>
  mergeIntegrity(emptyIntegrity(), { hashes: [{ algorithm: 'sha512', digest: hex, origin: 'berry-zip' }] })

// A synthetic gzipped ustar with the given regular-file entries — lets a test build a
// MULTI-DIRECTORY package (a nested `lib/`), so the two container entry orders (lazy vs
// dirs-first) yield DIFFERENT digests and `selectPakoProfile` has a discriminating anchor.
const ustarFile = (name: string, data: Buffer): Buffer => {
  const h = Buffer.alloc(512)
  h.write(name, 0, 'utf8')
  h.write('0000644\0', 100); h.write(data.length.toString(8).padStart(11, '0') + '\0', 124); h.write('0', 156)
  h.write('ustar\0', 257); h.write('00', 263)
  return Buffer.concat([h, data, Buffer.alloc(Math.ceil(data.length / 512) * 512 - data.length)])
}
// index.js (STORE-tiny) + a nested lib/deep.js (DEFLATE-compressible) → discriminating + mixed.
const multiDirTgz = (): Buffer => gzipSync(Buffer.concat([
  ustarFile('package/index.js', Buffer.from('module.exports = 1\n')),
  ustarFile('package/lib/deep.js', Buffer.from('a'.repeat(400))),
  Buffer.alloc(1024),
]))

describe('enrich/refurbish (ADR-0034 + ADR-0035)', () => {
  it('recomputes a missing berry checksum from the tarball (STORE)', async () => {
    const graph = graphOf(b => { addPackage(b, { name: 'ms', version: '2.1.3' }) })
    const r = await refurbish(graph, 'yarn-berry-v8', sourceOf({ 'ms@2.1.3': tgz('ms-2.1.3.tgz') }))

    expect(r.enriched).toEqual(['ms@2.1.3'])
    const payload = r.graph.tarballOf('ms@2.1.3')
    // Prefix-era fill matches what emit→parse records on the payload.
    expect(payload?.berryChecksumCacheKey).toBe('10c0')
    expect(emitBerryChecksum(payload!.integrity!)).toBe(
      computeBerryChecksum(tgz('ms-2.1.3.tgz'), 'ms', '10c0'),
    )
    expect(r.unresolved.map(d => d.code)).toEqual(['ENRICH_FIELD_FILLED'])
    // dual-channel — also on Graph.diagnostics()
    expect(r.graph.diagnostics().map(d => d.code)).toContain('ENRICH_FIELD_FILLED')
  })

  it('strictly round-trips a prefix-era checksum filled from a tarball', async () => {
    const gap = berryV8Lock().replace(/^  checksum: 10c0\/d924[^\n]*\n/m, '')
    const graph = parse('yarn-berry-v8', gap)
    const r = await refurbish(
      graph,
      'yarn-berry-v8',
      sourceOf({ 'ms@2.1.3': tgz('ms-2.1.3.tgz') }),
    )

    expect(r.graph.tarballOf('ms@2.1.3')?.berryChecksumCacheKey).toBe('10c0')
    expect(() => stringify('yarn-berry-v8', r.graph)).not.toThrow()
  })

  it.each([
    ['yarn-berry-v8', 8, '4.13.0'],
    ['yarn-berry-v9', 9, undefined],
    ['yarn-berry-v10', 10, undefined],
  ] as const)('%s fills a fresh conditioned node on a required path but leaves an optional-only one bare', async (
    format,
    version,
    managerVersion,
  ) => {
    const lock = `__metadata:
  version: ${version}
  cacheKey: 10c0

"fixture@workspace:.":
  version: 0.0.0-use.local
  resolution: "fixture@workspace:."
  dependencies:
    "@esbuild/darwin-arm64": "npm:0.28.1"
    fsevents: "npm:2.3.3"
    ms: "npm:2.1.3"
  dependenciesMeta:
    "@esbuild/darwin-arm64":
      optional: true
  languageName: unknown
  linkType: soft

"@esbuild/darwin-arm64@npm:0.28.1":
  version: 0.28.1
  resolution: "@esbuild/darwin-arm64@npm:0.28.1"
  conditions: os=darwin & cpu=arm64
  languageName: node
  linkType: hard

"fsevents@npm:~2.3.3":
  version: 2.3.3
  resolution: "fsevents@npm:2.3.3"
  conditions: os=darwin
  languageName: node
  linkType: hard

"string-width-cjs@npm:string-width@^4.2.0":
  version: 4.2.3
  resolution: "string-width@npm:4.2.3"
  languageName: node
  linkType: hard

"ms@npm:2.1.3":
  version: 2.1.3
  resolution: "ms@npm:2.1.3"
  languageName: node
  linkType: hard
`
    const graph = parse(format, lock)
    const r = await refurbish(
      graph,
      format,
      sourceOf({
        'fsevents@2.3.3': tgz('ms-2.1.3.tgz'),
        'ms@2.1.3': tgz('ms-2.1.3.tgz'),
      }),
      managerVersion === undefined ? {} : { managerVersion },
    )

    expect(r.enriched).toEqual(['fsevents@2.3.3', 'ms@2.1.3'])
    expect(emitBerryChecksum(r.graph.tarballOf('fsevents@2.3.3')!.integrity!)).toBeDefined()
    expect(emitBerryChecksum(r.graph.tarballOf('ms@2.1.3')!.integrity!)).toBeDefined()
    // The optional-only conditioned package and alias-only entry remain bare.
    expect(r.graph.tarballOf('@esbuild/darwin-arm64@0.28.1')?.integrity).toBeUndefined()
    expect(r.graph.tarballOf('string-width@4.2.3')?.integrity).toBeUndefined()
    expect((stringify(format, r.graph, { strict: false }).match(/^  checksum:/gm) ?? [])).toHaveLength(2)
  })

  it.each([
    ['yarn-berry-v5', 5, '8'],
    ['yarn-berry-v6', 6, '8'],
    ['yarn-berry-v7', 7, '10'],
  ] as const)('%s keeps every fresh conditioned checksum gap bare', async (format, version, cacheKey) => {
    const graph = parse(format, `__metadata:
  version: ${version}
  cacheKey: ${cacheKey}

"fsevents@npm:2.3.3":
  version: 2.3.3
  resolution: "fsevents@npm:2.3.3"
  conditions: os=darwin
  languageName: node
  linkType: hard

"ms@npm:2.1.3":
  version: 2.1.3
  resolution: "ms@npm:2.1.3"
  languageName: node
  linkType: hard
`)
    const r = await refurbish(graph, format, checksumSource(), { cacheKey })

    expect(r.enriched).toEqual(['ms@2.1.3'])
    expect(r.graph.tarballOf('fsevents@2.3.3')?.integrity).toBeUndefined()
    expect(emitBerryChecksum(r.graph.tarballOf('ms@2.1.3')!.integrity!)).toBeDefined()
  })

  it('pins the lock-v8 checksum policy at Yarn 4.4.0 and fails closed when unpinned', async () => {
    const graph = parse('yarn-berry-v8', `__metadata:
  version: 8
  cacheKey: 10c0

"fixture@workspace:.":
  version: 0.0.0-use.local
  resolution: "fixture@workspace:."
  dependencies:
    fsevents: "npm:2.3.3"
  languageName: unknown
  linkType: soft

"fsevents@npm:2.3.3":
  version: 2.3.3
  resolution: "fsevents@npm:2.3.3"
  conditions: os=darwin
  languageName: node
  linkType: hard
`)

    const oldPolicy = await refurbish(graph, 'yarn-berry-v8', checksumSource(), {
      managerVersion: '4.3.1',
    })
    const newPolicy = await refurbish(graph, 'yarn-berry-v8', checksumSource(), {
      managerVersion: '4.4.0',
    })
    const ambiguous = await refurbish(graph, 'yarn-berry-v8', checksumSource())

    expect(oldPolicy.enriched).toEqual([])
    expect(oldPolicy.graph.tarballOf('fsevents@2.3.3')?.integrity).toBeUndefined()
    expect(newPolicy.enriched).toEqual(['fsevents@2.3.3'])
    expect(emitBerryChecksum(newPolicy.graph.tarballOf('fsevents@2.3.3')!.integrity!)).toBeDefined()
    expect(ambiguous.enriched).toEqual([])
    expect(ambiguous.unresolved.map(diagnostic => diagnostic.code)).toContain(
      'ENRICH_CHECKSUM_POLICY_AMBIGUOUS',
    )
  })

  it('still fails closed when a dropped checksum cannot be recomputed', async () => {
    const graph = parse('yarn-berry-v8', berryV8Lock())
    const payload = graph.tarballOf('ms@2.1.3')!
    const stripped = graph.mutate(mutator => {
      mutator.setTarball(
        { name: 'ms', version: '2.1.3' },
        { ...payload, integrity: undefined },
      )
    }).graph
    const r = await refurbish(stripped, 'yarn-berry-v8', sourceOf({}))

    expect(r.enriched).toEqual([])
    expect(r.unresolved.some(diagnostic =>
      diagnostic.code === 'ENRICH_CHECKSUM_DEFERRED')).toBe(true)
    let thrown: unknown
    try {
      stringify('yarn-berry-v8', r.graph)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(LockfileError)
    expect((thrown as LockfileError).losses?.some(loss =>
      loss.class === 'berry-checksum')).toBe(true)
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

  it('fills a `mixed` cacheKey 9 (yarn 3.6+) via the pure-JS nodejs-hash port — NO libzip', async () => {
    // cacheKey 9 `mixed` is pure-JS reproducible: pako's "nodejs-compatible" match-hash
    // (`legacyHash:false`), the ONLY delta from cacheKey 7/8. Verified byte-exact over
    // the real yarn-3.6+ cache (40/40). No `@yarnpkg/libzip` involved.
    const graph = graphOf(b => { addPackage(b, { name: 'ms', version: '2.1.3' }) })
    const r = await refurbish(graph, 'yarn-berry-v6', sourceOf({ 'ms@2.1.3': tgz('ms-2.1.3.tgz') }), { cacheKey: '9' })

    expect(r.enriched).toEqual(['ms@2.1.3'])
    expect(emitBerryChecksum(r.graph.tarballOf('ms@2.1.3')!.integrity!)).toBe(
      computeBerryChecksum(tgz('ms-2.1.3.tgz'), 'ms', '9'),
    )
  })

  it('CALIBRATES the pure-JS port — a reproducible sibling gates the fills (mixed 9)', async () => {
    // A real sibling checksum the port reproduces PROVES pako matches this lock's yarn
    // zlib → trust the fills. `is-buffer` is the anchor (real cacheKey-9 checksum),
    // `ms` the gap.
    const anchor = computeBerryChecksum(tgz('is-buffer-2.0.5.tgz'), 'is-buffer', '9')
    const graph = graphOf(b => {
      addPackage(b, { name: 'is-buffer', version: '2.0.5' })
      addPackage(b, { name: 'ms',        version: '2.1.3' })
      b.setTarball({ name: 'is-buffer', version: '2.0.5' }, { integrity: berryZip(anchor) })
    })
    const r = await refurbish(graph, 'yarn-berry-v6', sourceOf({
      'is-buffer@2.0.5': tgz('is-buffer-2.0.5.tgz'),
      'ms@2.1.3':        tgz('ms-2.1.3.tgz'),
    }), { cacheKey: '9' })

    expect(r.enriched).toEqual(['ms@2.1.3'])
    expect(emitBerryChecksum(r.graph.tarballOf('ms@2.1.3')!.integrity!)).toBe(
      computeBerryChecksum(tgz('ms-2.1.3.tgz'), 'ms', '9'),
    )
  })

  it('DEFERS when the pure-JS port MISCALIBRATES — a sibling it cannot reproduce blocks all fills', async () => {
    // The @algolia hazard: a cacheKey the port nominally covers, but the lock was
    // written by a yarn whose vendored zlib pako does NOT match. A sibling carrying a
    // checksum pako can't reproduce → calibration MISMATCH → defer the whole set rather
    // than emit wrong digests (a wrong value hard-fails `--immutable`; a clean omit
    // yarn self-heals). Never a wrong value.
    const graph = graphOf(b => {
      addPackage(b, { name: 'is-buffer', version: '2.0.5' })
      addPackage(b, { name: 'ms',        version: '2.1.3' })
      b.setTarball({ name: 'is-buffer', version: '2.0.5' }, { integrity: berryZip('dead'.repeat(32)) })
    })
    const r = await refurbish(graph, 'yarn-berry-v6', sourceOf({
      'is-buffer@2.0.5': tgz('is-buffer-2.0.5.tgz'),
      'ms@2.1.3':        tgz('ms-2.1.3.tgz'),
    }), { cacheKey: '9' })

    expect(r.enriched).toEqual([])
    expect(r.graph.tarballOf('ms@2.1.3')?.integrity).toBeUndefined()
  })

  it('CALIBRATES container ENTRY ORDER — a dirs-first sibling makes the gap fill use dirs-first', async () => {
    // yarn builds vary in entry order (lazy tar-order vs all-directories-first), not
    // encoded in the cacheKey. A DISCRIMINATING anchor (a multi-dir package) written
    // dirs-first must steer the gap fill to dirs-first, NOT the default lazy.
    const anchorTgz = multiDirTgz(), gapTgz = multiDirTgz()
    const anchorDirsFirst = computeBerryChecksum(anchorTgz, 'anchor-pkg', '8', true)
    const graph = graphOf(b => {
      addPackage(b, { name: 'anchor-pkg', version: '1.0.0' })
      addPackage(b, { name: 'gap-pkg',    version: '1.0.0' })
      b.setTarball({ name: 'anchor-pkg', version: '1.0.0' }, { integrity: berryZip(anchorDirsFirst) })
    })
    const r = await refurbish(graph, 'yarn-berry-v6', sourceOf({
      'anchor-pkg@1.0.0': anchorTgz, 'gap-pkg@1.0.0': gapTgz,
    }), { cacheKey: '8' })

    expect(r.enriched).toEqual(['gap-pkg@1.0.0'])
    // the fill used DIRS-FIRST (the anchor's order) — which is DISTINCT from lazy here.
    expect(computeBerryChecksum(gapTgz, 'gap-pkg', '8', true))
      .not.toBe(computeBerryChecksum(gapTgz, 'gap-pkg', '8', false))
    expect(emitBerryChecksum(r.graph.tarballOf('gap-pkg@1.0.0')!.integrity!))
      .toBe(computeBerryChecksum(gapTgz, 'gap-pkg', '8', true))
  })

  it('DEFERS when a discriminating sibling matches NEITHER entry order (foreign yarn build)', async () => {
    // A multi-dir anchor whose checksum neither order reproduces = the lock was written
    // by a build outside our port. selectPakoProfile returns undefined → the gap DEFERS
    // rather than fill with a guessed order (a wrong digest hard-fails --immutable).
    const graph = graphOf(b => {
      addPackage(b, { name: 'anchor-pkg', version: '1.0.0' })
      addPackage(b, { name: 'gap-pkg',    version: '1.0.0' })
      b.setTarball({ name: 'anchor-pkg', version: '1.0.0' }, { integrity: berryZip('beef'.repeat(32)) })
    })
    const r = await refurbish(graph, 'yarn-berry-v6', sourceOf({
      'anchor-pkg@1.0.0': multiDirTgz(), 'gap-pkg@1.0.0': multiDirTgz(),
    }), { cacheKey: '8' })

    expect(r.enriched).toEqual([])
    expect(r.graph.tarballOf('gap-pkg@1.0.0')?.integrity).toBeUndefined()
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

  it('DEFERS a `mixed` cacheKey with NO oracle — never writes a wrong berry checksum (yaf pijma compressionLevel: mixed)', async () => {
    // mixed v10 fills via libzip ONLY with a calibratable anchor (a sibling carrying a
    // real checksum) OR a caller `berryChecksum` oracle. This graph has NEITHER
    // (selfsigned is the sole gap, nothing to calibrate against), so it DEFERS rather
    // than fabricate — a wrong value hard-fails `--immutable` (YN0018); a clean omit
    // yarn recomputes on install. The tarball must not even be fetched.
    const graph = graphOf(b => {
      addPackage(b, { name: 'app',        version: '0.0.0', workspacePath: '.' })
      addPackage(b, { name: 'selfsigned', version: '5.5.0' })
    })
    let fetched = false
    const source: TarballSource = { async tarball() { fetched = true; return undefined } }
    const r = await refurbish(graph, 'yarn-berry-v10', source, { cacheKey: '10' })

    expect(r.enriched).toEqual([])
    expect(r.graph.tarballOf('selfsigned@5.5.0')?.integrity).toBeUndefined()
    expect(fetched).toBe(false)
  })

  it('FILLS a `mixed` cacheKey from the caller oracle (yarn digest) — PINS integrity, not omit (security)', async () => {
    // The security-preserving path: yarn is the oracle, so the caller supplies yarn's
    // OWN mixed digest via `source.berryChecksum` and a mixed bump is PINNED, not
    // omitted. refurbish must consult the oracle EVEN for a non-reproducible cacheKey.
    const graph = graphOf(b => {
      addPackage(b, { name: 'app',        version: '0.0.0', workspacePath: '.' })
      addPackage(b, { name: 'selfsigned', version: '5.5.0' })
    })
    const YARN_DIGEST = 'fe9be2'.padEnd(128, '0')   // yarn's real cacheKey-10 (mixed) sha512 (128 hex)
    const source: TarballSource = {
      async tarball() { throw new Error('must not fetch — the oracle supplies the digest') },
      async berryChecksum(name, version, cacheKey) {
        return name === 'selfsigned' && version === '5.5.0' && cacheKey === '10' ? YARN_DIGEST : undefined
      },
    }
    const r = await refurbish(graph, 'yarn-berry-v10', source, { cacheKey: '10' })

    expect(r.enriched).toEqual(['selfsigned@5.5.0'])
    expect(emitBerryChecksum(r.graph.tarballOf('selfsigned@5.5.0')!.integrity!)).toBe(YARN_DIGEST)
  })
})
