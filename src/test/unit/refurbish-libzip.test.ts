// refurbish wiring for the OPTIONAL `@yarnpkg/libzip` backend (cacheKey 10 `mixed` —
// the one the pure-JS pako path can't reproduce; pako owns STORE + mixed 7/8/9).
// libzip drives yarn's OWN ZipFS, so it reproduces the cache zip byte-exact (verified
// 190/190 real cacheKey-10 mixed zips + the selfsigned@5.5.0 mode edge) when the
// installed libzip matches the lock's generation. A wrong digest hard-fails
// `--immutable`, so refurbish CALIBRATES against one existing sibling checksum before
// trusting a fill.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { refurbish, type TarballSource } from '../../main/ts/enrich/refurbish.ts'
import { computeBerryChecksumViaLibzip } from '../../main/ts/recipe/berry-pack-libzip.ts'
import { emitBerryChecksum, emptyIntegrity, mergeIntegrity } from '../../main/ts/recipe/integrity.ts'
import { graphOf, addPackage } from './_modify-test-utils.ts'

const here = dirname(fileURLToPath(import.meta.url))
const tgz = (rel: string): Buffer => readFileSync(resolve(here, '../resources/fixtures/tarballs', rel))
const sourceOf = (map: Record<string, Buffer>): TarballSource => ({
  // eslint-disable-next-line @typescript-eslint/require-await
  async tarball(name: string, version: string): Promise<Uint8Array | undefined> { return map[`${name}@${version}`] },
})

// Real cacheKey-10 (yarn-4 mixed) checksums — the sha512 yarn 4 wrote.
const MS_10 = 'aa92de608021b242401676e35cfa5aa42dd70cbdc082b916da7fb925c542173e36bce97ea3e804923fe92c0ad991434e4a38327e15a1b5b5f945d66df615ae6d'
const IS_BUFFER_10 = '3261a8b858edcc6c9566ba1694bf829e126faa88911d1c0a747ea658c5d81b14b6955e3a702d59dabadd58fdd440c01f321aa71d6547105fd21d03f94d0597e7'
const berryZip = (hex: string) =>
  mergeIntegrity(emptyIntegrity(), { hashes: [{ algorithm: 'sha512', digest: hex, origin: 'berry-zip' }] })

// Opt-in dep; never fail CI if it didn't install.
const hasLibzip = await import('@yarnpkg/libzip').then(() => true, () => false)

describe('enrich/refurbish — optional @yarnpkg/libzip backend (cacheKey 10 mixed, calibrated)', () => {
  it.skipIf(!hasLibzip)('calibrates against a sibling checksum, then fills the mixed gap via libzip', async () => {
    // `ms` carries the REAL cacheKey-10 (mixed) checksum (the calibration anchor);
    // `is-buffer` is the gap. cacheKey 10 mixed is NOT pako-reproducible → libzip.
    const graph = graphOf(b => {
      addPackage(b, { name: 'ms',        version: '2.1.3' })
      addPackage(b, { name: 'is-buffer', version: '2.0.5' })
      b.setTarball({ name: 'ms', version: '2.1.3' }, { integrity: berryZip(MS_10) })
    })
    const r = await refurbish(graph, 'yarn-berry-v10', sourceOf({
      'ms@2.1.3':        tgz('ms-2.1.3.tgz'),
      'is-buffer@2.0.5': tgz('is-buffer-2.0.5.tgz'),
    }), { cacheKey: '10' })

    expect(r.enriched).toEqual(['is-buffer@2.0.5'])
    expect(emitBerryChecksum(r.graph.tarballOf('is-buffer@2.0.5')!.integrity!)).toBe(IS_BUFFER_10)
  })

  it.skipIf(!hasLibzip)('defers when calibration fails (installed libzip ≠ lock generation)', async () => {
    // The anchor carries a WRONG checksum → the installed libzip's reproduction won't
    // match → refurbish must NOT trust it, and the gap defers (never a wrong value).
    const graph = graphOf(b => {
      addPackage(b, { name: 'ms',        version: '2.1.3' })
      addPackage(b, { name: 'is-buffer', version: '2.0.5' })
      b.setTarball({ name: 'ms', version: '2.1.3' }, { integrity: berryZip('dead'.repeat(32)) })
    })
    const r = await refurbish(graph, 'yarn-berry-v10', sourceOf({
      'ms@2.1.3':        tgz('ms-2.1.3.tgz'),
      'is-buffer@2.0.5': tgz('is-buffer-2.0.5.tgz'),
    }), { cacheKey: '10' })

    expect(r.enriched).toEqual([])
    expect(r.graph.tarballOf('is-buffer@2.0.5')?.integrity).toBeUndefined()
  })

  it.skipIf(!hasLibzip)('a pako-reproducible cacheKey (9) NEVER falls through to libzip — pako refuses ⇒ defer', async () => {
    // Regression for the adversary's Finding A. cacheKey 9 is pako's lane. When pako
    // REFUSES a lock (a sibling foreign to its zlib/order), refurbish must DEFER — NOT
    // consult libzip. libzip 3.x is zlib-ng / cacheKey-10; it would license itself off
    // this very sibling (its `mixed` digest is version-independent) and write a
    // cacheKey-10 digest into a cacheKey-9 lock → the exact YN0018 the gate prevents.
    // Here `ms` carries libzip's OWN digest (a value pako cannot produce), so pako's
    // calibration refuses; the gap `is-buffer` must stay unfilled.
    const libzipDigest = await computeBerryChecksumViaLibzip(tgz('ms-2.1.3.tgz'), 'ms', '9')
    const graph = graphOf(b => {
      addPackage(b, { name: 'ms',        version: '2.1.3' })
      addPackage(b, { name: 'is-buffer', version: '2.0.5' })
      b.setTarball({ name: 'ms', version: '2.1.3' }, { integrity: berryZip(libzipDigest!) })
    })
    const r = await refurbish(graph, 'yarn-berry-v6', sourceOf({
      'ms@2.1.3':        tgz('ms-2.1.3.tgz'),
      'is-buffer@2.0.5': tgz('is-buffer-2.0.5.tgz'),
    }), { cacheKey: '9' })

    expect(r.enriched).toEqual([])                                          // NOT ['is-buffer@2.0.5']
    expect(r.graph.tarballOf('is-buffer@2.0.5')?.integrity).toBeUndefined()
  })
})
