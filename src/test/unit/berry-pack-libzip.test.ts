// Optional `@yarnpkg/libzip` recompute backend (the cacheKeys pako can't do).
//
// Ground truth = the sha512 of the REAL `<pkg>-<hash>-10.zip` yarn 4 wrote
// (cacheKey 10, `mixed`). The installed `@yarnpkg/libzip` 3.x is yarn-4 era, so
// it reproduces these byte-exact (linchpin probe: 6/6 over real caches, incl.
// packages where cacheKey 10 differs from 8 — the case pako CANNOT reproduce).

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { computeBerryChecksumViaLibzip } from '../../main/ts/recipe/berry-pack-libzip.ts'
import { storeFallbackArchive } from '../helpers/berry-archives.ts'
import {
  ArtifactEnvelopeError,
  artifactResourceLimits,
} from '../../main/ts/recipe/artifact-envelope.ts'

const here = dirname(fileURLToPath(import.meta.url))
const tgz = (rel: string): Buffer => readFileSync(resolve(here, '../resources/fixtures/tarballs', rel))

// Skip gracefully if the optional backend isn't installed (it's a devDep here,
// so normally it runs); never fail CI just because the opt-in dep is absent.
const hasLibzip = await import('@yarnpkg/libzip').then(() => true, () => false)

describe('recipe/berry-pack-libzip (optional @yarnpkg/libzip backend)', () => {
  it.skipIf(!hasLibzip)('reproduces ms@2.1.3 cacheKey-10 (mixed) byte-exact', async () => {
    expect(await computeBerryChecksumViaLibzip(tgz('ms-2.1.3.tgz'), 'ms', '10')).toBe(
      'aa92de608021b242401676e35cfa5aa42dd70cbdc082b916da7fb925c542173e36bce97ea3e804923fe92c0ad991434e4a38327e15a1b5b5f945d66df615ae6d',
    )
  })

  it.skipIf(!hasLibzip)('reproduces is-buffer@2.0.5 cacheKey-10 (mixed) byte-exact', async () => {
    expect(await computeBerryChecksumViaLibzip(tgz('is-buffer-2.0.5.tgz'), 'is-buffer', '10')).toBe(
      '3261a8b858edcc6c9566ba1694bf829e126faa88911d1c0a747ea658c5d81b14b6955e3a702d59dabadd58fdd440c01f321aa71d6547105fd21d03f94d0597e7',
    )
  })

  // Ground truth: the checksums yarn 4.18.1 wrote with `compressionLevel: mixed`.
  it.skipIf(!hasLibzip)('reproduces an archive that lists its directories (diff@4.0.4)', async () => {
    expect(await computeBerryChecksumViaLibzip(tgz('diff-4.0.4.tgz'), 'diff', '10')).toBe(
      '5019b3f5ae124ea9e95137119e1a83a59c252c75ddac873cc967832fd7a834570a58a4d58b941bdbd07832ebf98dcb232b27c561b7f5584357da6dae59bcac62',
    )
  })

  it.skipIf(!hasLibzip)('reproduces incompressible entries on both sides of the STORE fallback', async () => {
    expect(await computeBerryChecksumViaLibzip(storeFallbackArchive(), 'rnd', '10')).toBe(
      'c363f1e46091e33cfe90bf818726010b3992b0f19932fbe61223857d844d7a1356373f1d6603bd91cb9f38b39962b1ba1eec9bf3893c0f3bdb188b05068d65e6',
    )
  })

  it('returns undefined for a malformed cacheKey — caller defers', async () => {
    expect(await computeBerryChecksumViaLibzip(tgz('ms-2.1.3.tgz'), 'ms', 'nope')).toBeUndefined()
  })

  it.skipIf(!hasLibzip)('enforces the exact libzip repacked-byte ceiling', async () => {
    const limits = artifactResourceLimits({
      defaults: { maxRepackedBytes: 1 },
    }, 'ms@2.1.3')
    await expect(computeBerryChecksumViaLibzip(
      tgz('ms-2.1.3.tgz'),
      'ms',
      '10',
      limits,
    )).rejects.toBeInstanceOf(ArtifactEnvelopeError)
  })
})
