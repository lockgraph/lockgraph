import { describe, expect, it } from 'vitest'
import {
  canonicalDigest,
  emitBerryChecksum,
  emitSri,
  emptyIntegrity,
  integrityEquivalent,
  isEmptyIntegrity,
  isTarballOrigin,
  mergeIntegrity,
  parseBerryChecksum,
  parseSri,
  pickAlgorithm,
  pickTarballSha512,
  tarballHashes,
  type Integrity,
} from '../../main/ts/recipe/integrity.ts'

// ms@2.1.3 digests across artefacts/algorithms.
const MS_NPM_SRI  = 'sha512-6FlzubTLZG3J2a/NVCAleEhjzq5oxgHyaCU9yYXvcLsvoVaHJq/s5xXI6/XXP6tz7R9xAOtHnSO/tXtF3WRTlA=='
const MS_NPM_HEX  = 'e85973b9b4cb646dc9d9afcd542025784863ceae68c601f268253dc985ef70bb2fa1568726afece715c8ebf5d73fab73ed1f7100eb479d23bfb57b45dd645394'
const MS_YARN_HEX = 'd924b57e7312b3b63ad21fc5b3dc0af5e78d61a1fc7cfb5457edaf26326bf62be5307cc87ffb6862ef1c2b33b0233cdb5d4f01c4c958cc0d660948b65a287a48'
const MS_YARN_CKEY = `10c0/${MS_YARN_HEX}`
const MS_SHA1_SRI = 'sha1-VgiurfwAvmwpAd9fmGF4jeDVl8g='
const MS_SHA1_HEX = Buffer.from(MS_SHA1_SRI.slice('sha1-'.length), 'base64').toString('hex')
// A real-world multi-hash SRI: npm's sha1→sha512 transition emitted both.
const MS_MULTI_SRI = `${MS_SHA1_SRI} ${MS_NPM_SRI}`

describe('integrity/parseSri', () => {
  it('parses a single sha512 SRI to one tarball-origin hash (hex digest)', () => {
    const i = parseSri(MS_NPM_SRI)
    expect(i.hashes).toEqual([{ algorithm: 'sha512', digest: MS_NPM_HEX, origin: 'sri' }])
  })
  it('preserves a sha1-only SRI verbatim (no longer dropped)', () => {
    const i = parseSri(MS_SHA1_SRI)
    expect(i.hashes).toEqual([{ algorithm: 'sha1', digest: MS_SHA1_HEX, origin: 'sri' }])
  })
  it('parses a space-joined multi-hash SRI preserving member order', () => {
    const i = parseSri(MS_MULTI_SRI)
    expect(i.hashes.map(h => h.algorithm)).toEqual(['sha1', 'sha512'])
    expect(i.hashes.map(h => h.digest)).toEqual([MS_SHA1_HEX, MS_NPM_HEX])
  })
  it('honours an explicit origin (registry ingestion)', () => {
    expect(parseSri(MS_NPM_SRI, 'registry').hashes[0]!.origin).toBe('registry')
  })
  it('skips a member whose base64 decodes to the wrong byte length for a known algorithm', () => {
    // sha512 prefix but a 20-byte (sha1-length) payload — malformed, dropped.
    expect(parseSri(`sha512-${Buffer.from(MS_SHA1_HEX, 'hex').toString('base64')}`).hashes).toEqual([])
  })
  it('yields an empty carrier for unparseable input', () => {
    expect(parseSri('not-a-hash').hashes).toEqual([])
    expect(parseSri('').hashes).toEqual([])
  })
})

describe('integrity/emitSri', () => {
  it('round-trips a single sha512 SRI byte-for-byte', () => {
    expect(emitSri(parseSri(MS_NPM_SRI))).toBe(MS_NPM_SRI)
  })
  it('round-trips a multi-hash SRI preserving member order', () => {
    expect(emitSri(parseSri(MS_MULTI_SRI))).toBe(MS_MULTI_SRI)
  })
  it('returns undefined for an empty carrier (adapter omits the field)', () => {
    expect(emitSri(emptyIntegrity())).toBeUndefined()
  })
  it('excludes berry-zip hashes — a zip digest is not a valid SRI', () => {
    const mixed: Integrity = {
      hashes: [
        { algorithm: 'sha512', digest: MS_NPM_HEX,  origin: 'sri' },
        { algorithm: 'sha512', digest: MS_YARN_HEX, origin: 'berry-zip' },
      ],
    }
    expect(emitSri(mixed)).toBe(MS_NPM_SRI)
  })
})

describe('integrity/parseBerryChecksum', () => {
  it('parses a cacheKey-prefixed checksum to a berry-zip sha512 + cacheKey', () => {
    const { integrity, cacheKey } = parseBerryChecksum(MS_YARN_CKEY)
    expect(cacheKey).toBe('10c0')
    expect(integrity.hashes).toEqual([{ algorithm: 'sha512', digest: MS_YARN_HEX, origin: 'berry-zip' }])
  })
  it('parses a bare 128-hex checksum (v4–v6) with no cacheKey', () => {
    const { integrity, cacheKey } = parseBerryChecksum(MS_YARN_HEX)
    expect(cacheKey).toBeUndefined()
    expect(integrity.hashes[0]).toEqual({ algorithm: 'sha512', digest: MS_YARN_HEX, origin: 'berry-zip' })
  })
  it('yields an empty carrier for a non-128-hex body', () => {
    expect(parseBerryChecksum('10c0/deadbeef').integrity.hashes).toEqual([])
  })
})

describe('integrity/emitBerryChecksum', () => {
  it('round-trips a berry-zip checksum body (bare hex; adapter adds cacheKey)', () => {
    expect(emitBerryChecksum(parseBerryChecksum(MS_YARN_CKEY).integrity)).toBe(MS_YARN_HEX)
  })
  it('returns undefined when no berry-zip digest exists', () => {
    expect(emitBerryChecksum(emptyIntegrity())).toBeUndefined()
  })
})

// The two properties the whole ADR exists to enforce: a digest is never
// re-encoded across the tarball/zip boundary.
describe('integrity — anti-fabrication invariants', () => {
  it('a tarball sha512 (npm/pnpm) is NEVER emitted as a yarn-berry checksum', () => {
    expect(emitBerryChecksum(parseSri(MS_NPM_SRI))).toBeUndefined()
  })
  it('a berry-zip sha512 is NEVER emitted as an SRI', () => {
    expect(emitSri(parseBerryChecksum(MS_YARN_CKEY).integrity)).toBeUndefined()
  })
  it('within-family round-trips still succeed (npm→npm, berry→berry)', () => {
    expect(emitSri(parseSri(MS_NPM_SRI))).toBe(MS_NPM_SRI)
    expect(emitBerryChecksum(parseBerryChecksum(MS_YARN_CKEY).integrity)).toBe(MS_YARN_HEX)
  })
})

describe('integrity/queries', () => {
  it('isTarballOrigin is true for every origin except berry-zip', () => {
    expect(isTarballOrigin('sri')).toBe(true)
    expect(isTarballOrigin('registry')).toBe(true)
    expect(isTarballOrigin('url-fragment')).toBe(true)
    expect(isTarballOrigin('recomputed')).toBe(true)
    expect(isTarballOrigin('berry-zip')).toBe(false)
  })
  it('tarballHashes excludes berry-zip', () => {
    const i = mergeIntegrity(parseSri(MS_NPM_SRI), parseBerryChecksum(MS_YARN_CKEY).integrity)
    expect(tarballHashes(i).map(h => h.origin)).toEqual(['sri'])
  })
  it('pickAlgorithm / pickTarballSha512 select the right member', () => {
    const i = parseSri(MS_MULTI_SRI)
    expect(pickAlgorithm(i, 'sha1')!.digest).toBe(MS_SHA1_HEX)
    expect(pickTarballSha512(i)!.digest).toBe(MS_NPM_HEX)
  })
  it('pickTarballSha512 ignores a berry-zip sha512', () => {
    expect(pickTarballSha512(parseBerryChecksum(MS_YARN_CKEY).integrity)).toBeUndefined()
  })
  it('isEmptyIntegrity reflects hash count', () => {
    expect(isEmptyIntegrity(emptyIntegrity())).toBe(true)
    expect(isEmptyIntegrity(parseSri(MS_NPM_SRI))).toBe(false)
  })
})

describe('integrity/canonicalDigest', () => {
  it('returns the strongest tarball digest as a canonical SRI', () => {
    expect(canonicalDigest(parseSri(MS_MULTI_SRI))).toBe(MS_NPM_SRI)
    expect(canonicalDigest(parseSri(MS_SHA1_SRI))).toBe(MS_SHA1_SRI)
  })
  it('returns undefined when only a berry-zip digest is present (needs fetch)', () => {
    expect(canonicalDigest(parseBerryChecksum(MS_YARN_CKEY).integrity)).toBeUndefined()
  })
})

describe('integrity/mergeIntegrity', () => {
  it('unions a-then-b, de-duplicating by (algorithm, origin, digest)', () => {
    const merged = mergeIntegrity(parseSri(MS_SHA1_SRI), parseSri(MS_MULTI_SRI))
    // sha1 from a, then sha1 (dup, dropped) + sha512 from b.
    expect(merged.hashes.map(h => `${h.algorithm}:${h.digest}`)).toEqual([
      `sha1:${MS_SHA1_HEX}`,
      `sha512:${MS_NPM_HEX}`,
    ])
  })
  it('keeps same-digest hashes that differ only by origin', () => {
    const a = parseSri(MS_NPM_SRI)                       // sha512 origin 'sri'
    const b = parseSri(MS_NPM_SRI, 'registry')           // sha512 origin 'registry'
    expect(mergeIntegrity(a, b).hashes).toHaveLength(2)
  })
})

describe('integrity/integrityEquivalent', () => {
  it('is true for identical SRIs and order-independent within an origin class', () => {
    expect(integrityEquivalent(parseSri(MS_NPM_SRI), parseSri(MS_NPM_SRI))).toBe(true)
    expect(integrityEquivalent(
      parseSri(`${MS_SHA1_SRI} ${MS_NPM_SRI}`),
      parseSri(`${MS_NPM_SRI} ${MS_SHA1_SRI}`),
    )).toBe(true)
  })
  it('ignores origin provenance within the tarball class (sri ≡ registry)', () => {
    expect(integrityEquivalent(parseSri(MS_NPM_SRI), parseSri(MS_NPM_SRI, 'registry'))).toBe(true)
  })
  it('is false when one side dropped a hash (masks no loss)', () => {
    expect(integrityEquivalent(parseSri(MS_MULTI_SRI), parseSri(MS_NPM_SRI))).toBe(false)
  })
  it('is false across the tarball/zip boundary (a fabricated berry checksum is caught)', () => {
    // Same algorithm+digest bytes but one is tarball-origin, one berry-zip.
    const tarball: Integrity = { hashes: [{ algorithm: 'sha512', digest: MS_NPM_HEX, origin: 'sri' }] }
    const zip:     Integrity = { hashes: [{ algorithm: 'sha512', digest: MS_NPM_HEX, origin: 'berry-zip' }] }
    expect(integrityEquivalent(tarball, zip)).toBe(false)
  })
})
