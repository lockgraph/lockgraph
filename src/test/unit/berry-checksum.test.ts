// yarn-berry `checksum` computation, conformance gates.
//
// The digest is all-or-nothing: a single divergent byte in the reproduced
// cache zip changes the SHA-512. The static fixture below is yarn's own ground
// truth (the checksum it wrote for `ms@2.1.3` in a real yarn-berry lockfile,
// `src/test/resources/fixtures/lockfiles/yarn-crlf/yarn-berry-v8.lock:27`).

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'
import { computeBerryChecksum, cacheKeyCompressionLevel, crc32Table } from '../../main/ts/recipe/berry-checksum.ts'
import {
  ArtifactEnvelopeError,
  ArtifactLiveMeter,
  artifactResourceLimits,
} from '../../main/ts/recipe/artifact-envelope.ts'

const here = dirname(fileURLToPath(import.meta.url))
const tarball = (rel: string): Buffer => readFileSync(resolve(here, '../resources/fixtures/tarballs', rel))

describe('recipe/berry-checksum ()', () => {
  it('reproduces ms@2.1.3 berry checksum byte-exact (STORE / 10c0)', () => {
    const hex = computeBerryChecksum(tarball('ms-2.1.3.tgz'), 'ms', '10c0')
    expect(hex).toBe(
      'd924b57e7312b3b63ad21fc5b3dc0af5e78d61a1fc7cfb5457edaf26326bf62be5307cc87ffb6862ef1c2b33b0233cdb5d4f01c4c958cc0d660948b65a287a48',
    )
  })

  it('reproduces a SCOPED package checksum (node_modules/@scope/name/ vendor path)', () => {
    // @kwsites/file-exists@1.1.1 — ground truth from the @yarnpkg/core oracle
    // (live-oracle gate), which itself matches real yarn output.
    const hex = computeBerryChecksum(tarball('kwsites-file-exists-1.1.1.tgz'), '@kwsites/file-exists', '10c0')
    expect(hex).toBe(
      '39e693239a72ccd8408bb618a0200e4a8d61682057ca7ae2c87668d7e69196e8d7e2c9cde73db6b23b3b0230169a15e5f1bfe086539f4be43e767b2db68e8ee4',
    )
  })

  it('reproduces is-buffer@2.0.5 checksum (second unscoped package)', () => {
    const hex = computeBerryChecksum(tarball('is-buffer-2.0.5.tgz'), 'is-buffer', '10c0')
    expect(hex).toBe(
      'e603f6fced83cf94c53399cff3bda1a9f08e391b872b64a73793b0928be3e5f047f2bcece230edb7632eaea2acdbfcb56c23b33d8a20c820023b230f1485679a',
    )
  })

  // `mixed` cacheKey 8 (yarn 3.x default) — DEFLATE-iff-smaller via pako. Ground
  // truth is the BARE checksum yarn 3.8.7 wrote in qiwi/mware's real yarn.lock
  // (`__metadata.cacheKey: 8`); all three fixtures compress at least one file, so
  // these exercise the DEFLATE path (digest differs from the 10c0 STORE one).
  it('reproduces ms@2.1.3 berry checksum byte-exact (mixed / cacheKey 8)', () => {
    const hex = computeBerryChecksum(tarball('ms-2.1.3.tgz'), 'ms', '8')
    expect(hex).toBe(
      'aa92de608021b242401676e35cfa5aa42dd70cbdc082b916da7fb925c542173e36bce97ea3e804923fe92c0ad991434e4a38327e15a1b5b5f945d66df615ae6d',
    )
  })

  it('reproduces a SCOPED package checksum at mixed cacheKey 8 (@kwsites/file-exists)', () => {
    const hex = computeBerryChecksum(tarball('kwsites-file-exists-1.1.1.tgz'), '@kwsites/file-exists', '8')
    expect(hex).toBe(
      '4ff945de7293285133aeae759caddc71e73c4a44a12fac710fdd4f574cce2671a3f89d8165fdb03d383cfc97f3f96f677d8de3c95133da3d0e12a123a23109fe',
    )
  })

  // `mixed` cacheKey 9 (Yarn-4 RC window `4.0.0-rc.27…4.0.0`, lockfile v7) — same
  // container as cacheKey 8 (SAFE_TIME), but the DEFLATE stream matches pako's
  // "nodejs-compatible" match-hash (`legacyHash:false`), NOT the legacy hash. Ground
  // truth is the real sha512 a Yarn-4 RC wrote to its cache for ms@2.1.3 (a
  // DEFLATE-carrying package, so this exercises the hash difference).
  it('reproduces ms@2.1.3 berry checksum byte-exact (mixed / cacheKey 9, nodejs-hash)', () => {
    const hex = computeBerryChecksum(tarball('ms-2.1.3.tgz'), 'ms', '9')
    expect(hex).toBe(
      '78c12f6b473a022ebacc393fc14b76fe40b8feda7218124b86c4684e440e10377a063bec1d3902df1f74714f02b74b36ad7d3a6de9e2fbffa26fc29e5ce018fc',
    )
    // the nodejs-hash (v9) differs from the legacy hash (v8) → distinct DEFLATE bytes.
    expect(hex).not.toBe(computeBerryChecksum(tarball('ms-2.1.3.tgz'), 'ms', '8'))
  })

  it('STORE is era-independent — cacheKey 8c0 reproduces the same digest as 10c0', () => {
    // STORE has no compressed stream and uses SAFE_TIME at every era >= 8, so the
    // zip bytes (hence the digest) do not depend on the cacheKey NUMBER.
    const v8 = computeBerryChecksum(tarball('ms-2.1.3.tgz'), 'ms', '8c0')
    const v10 = computeBerryChecksum(tarball('ms-2.1.3.tgz'), 'ms', '10c0')
    expect(v8).toBe(v10)
  })

  it('dirsFirst entry order changes the digest for a MULTI-directory package, not a flat one', () => {
    // yarn builds vary in container entry order (lazy tar-order vs all-dirs-first); the
    // orders diverge ONLY when a package has nested directories. A flat, single-dir
    // package is order-invariant (non-discriminating for calibration).
    const flat = tarball('ms-2.1.3.tgz')                    // single directory
    expect(computeBerryChecksum(flat, 'ms', '8', true)).toBe(computeBerryChecksum(flat, 'ms', '8', false))
    const nested = tarball('kwsites-file-exists-1.1.1.tgz') // has a nested dir → discriminating
    expect(computeBerryChecksum(nested, '@kwsites/file-exists', '8', true))
      .not.toBe(computeBerryChecksum(nested, '@kwsites/file-exists', '8', false))
  })

  it('throws on every non-byte-reproducible cacheKey (defer, never a wrong digest)', () => {
    const ms = tarball('ms-2.1.3.tgz')
    // explicit DEFLATE level (`cN`, N>=1) — unverified against libzip.
    expect(() => computeBerryChecksum(ms, 'ms', '10c5')).toThrow(/reproducible/)
    // mixed cacheKey 10 (yarn-4 mixed) — a libzip-vendored zlib the pure-JS port
    // matches at neither hash; refuse rather than emit a digest yarn would reject.
    // (cacheKey 9 IS reproducible via the nodejs-hash — covered above, not here.)
    expect(() => computeBerryChecksum(ms, 'ms', '10')).toThrow(/reproducible/)
    // STORE below cacheKey 8 — yarn 2.x never wrote STORE; the DOS-epoch-vs-
    // SAFE_TIME mtime there is unproven, so refuse rather than guess.
    expect(() => computeBerryChecksum(ms, 'ms', '7c0')).toThrow(/reproducible/)
    expect(() => computeBerryChecksum(ms, 'ms', '5c0')).toThrow(/reproducible/)
    // malformed keys must reject, not `parseInt`-coerce into a wrong path.
    expect(() => computeBerryChecksum(ms, 'ms', '8c')).toThrow(/reproducible/)
    expect(() => computeBerryChecksum(ms, 'ms', 'x10c0')).toThrow(/reproducible/)
    expect(() => computeBerryChecksum(ms, 'ms', '')).toThrow(/reproducible/)
  })

  it('reads the compression level out of a cacheKey', () => {
    expect(cacheKeyCompressionLevel('10c0')).toBe(0)
    expect(cacheKeyCompressionLevel('10c5')).toBe(5)
    expect(cacheKeyCompressionLevel('8')).toBe(-1) // mixed (no `cN` suffix)
  })

  it('table CRC-32 matches native zlib.crc32 where available (Node >=22)', () => {
    const native = (zlib as { crc32?: (b: Uint8Array, v?: number) => number }).crc32
    if (typeof native !== 'function') return // Node <22 ships only the table path
    const sample = Buffer.from('the quick brown fox\0ÿ jumps', 'latin1')
    expect(crc32Table(sample) >>> 0).toBe(native(sample) >>> 0)
  })

  it('enforces exact pako repack and operation-wide live ceilings', () => {
    const bytes = tarball('ms-2.1.3.tgz')
    const repackLimits = artifactResourceLimits({
      defaults: { maxRepackedBytes: 1 },
    }, 'ms@2.1.3')
    expect(() => computeBerryChecksum(
      bytes,
      'ms',
      '10c0',
      false,
      repackLimits,
    )).toThrow(ArtifactEnvelopeError)

    const livePolicy = { maxLiveBytes: bytes.byteLength + 1 }
    const liveLimits = artifactResourceLimits(livePolicy, 'ms@2.1.3')
    const liveMeter = new ArtifactLiveMeter(livePolicy)
    const release = liveMeter.acquire(bytes.byteLength)
    try {
      expect(() => computeBerryChecksum(
        bytes,
        'ms',
        '10c0',
        false,
        liveLimits,
        liveMeter,
      )).toThrow(ArtifactEnvelopeError)
    } finally {
      release()
    }
  })
})
