// refurbish + the OPTIONAL `@yarnpkg/libzip` backend. libzip reproduces a FIXED
// compression level deterministically (every file compresses identically, so a
// one-anchor calibration validates ALL files), but it CANNOT reproduce yarn's
// per-file `mixed` heuristic (deflate iff smaller) — the era-specific zlib DEFLATE
// bytes differ, and one-anchor calibration is UNSOUND for mixed: a STORE-able anchor
// calibrates PASS while a DEFLATE'd target mis-hashes → `yarn install --immutable`
// YN0018 (yaf pijma `selfsigned` under `compressionLevel: mixed`). So a `mixed`
// cacheKey (v9/10) DEFERS — a clean omit yarn recomputes on install, never a wrong
// value `--immutable` rejects.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { refurbish, type TarballSource } from '../../main/ts/enrich/refurbish.ts'
import { emptyIntegrity, mergeIntegrity } from '../../main/ts/recipe/integrity.ts'
import { graphOf, addPackage } from './_modify-test-utils.ts'

const here = dirname(fileURLToPath(import.meta.url))
const tgz = (rel: string): Buffer => readFileSync(resolve(here, '../resources/fixtures/tarballs', rel))
const sourceOf = (map: Record<string, Buffer>): TarballSource => ({
  // eslint-disable-next-line @typescript-eslint/require-await
  async tarball(name: string, version: string): Promise<Uint8Array | undefined> { return map[`${name}@${version}`] },
})

// The REAL cacheKey-10 (yarn-4 mixed) checksum yarn wrote for `ms` — a VALID
// calibration anchor. libzip reproduces it, yet that does NOT make the mixed path
// trustworthy for OTHER files (yaf's `selfsigned` mis-hashed while siblings matched).
const MS_10 = 'aa92de608021b242401676e35cfa5aa42dd70cbdc082b916da7fb925c542173e36bce97ea3e804923fe92c0ad991434e4a38327e15a1b5b5f945d66df615ae6d'
const berryZip = (hex: string) =>
  mergeIntegrity(emptyIntegrity(), { hashes: [{ algorithm: 'sha512', digest: hex, origin: 'berry-zip' }] })

// Opt-in dep; never fail CI if it didn't install.
const hasLibzip = await import('@yarnpkg/libzip').then(() => true, () => false)

describe('enrich/refurbish — a `mixed` cacheKey DEFERS (libzip is unsound for the per-file heuristic)', () => {
  it.skipIf(!hasLibzip)('DEFERS a mixed cacheKey (10) even with libzip installed AND a valid calibration anchor', async () => {
    // `ms` carries its real cacheKey-10 (mixed) checksum, so libzip WOULD calibrate
    // on it — but mixed is per-FILE, so a pass on `ms` does not validate `is-buffer`.
    // Pre-fix this filled `is-buffer` (and mis-filled a `selfsigned`-shaped target);
    // refurbish must DEFER instead.
    const graph = graphOf(b => {
      addPackage(b, { name: 'ms',        version: '2.1.3' })
      addPackage(b, { name: 'is-buffer', version: '2.0.5' })
      b.setTarball({ name: 'ms', version: '2.1.3' }, { integrity: berryZip(MS_10) })
    })
    const r = await refurbish(graph, 'yarn-berry-v10', sourceOf({
      'ms@2.1.3':        tgz('ms-2.1.3.tgz'),
      'is-buffer@2.0.5': tgz('is-buffer-2.0.5.tgz'),
    }), { cacheKey: '10' })

    expect(r.enriched).toEqual([])                                          // no fill — deferred
    expect(r.graph.tarballOf('is-buffer@2.0.5')?.integrity).toBeUndefined() // never wrote a wrong checksum
  })
})
