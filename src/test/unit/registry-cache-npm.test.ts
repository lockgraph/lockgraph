// Phase D-B2 — `npmCache` (cacache CacheAdapter) unit suite.
//
// All tests build a temp `_cacache/` directory and populate it with
// synthetic index-v5 bucket files + content-v2 tarball blobs that
// mirror what `npm install` would produce. No real npm cache or
// binary involvement — we exercise key parsing, integrity → content
// path translation, и the cache-folder probe order.

import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { npmCache } from '../../main/ts/index.ts'
import { parseSri } from '../../main/ts/recipe/integrity.ts'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function freshCache(setup: (cacheDir: string) => void = () => {}): string {
  const cacheDir = mkdtempSync(resolve(tmpdir(), 'lockfile-npmcache-'))
  dirs.push(cacheDir)
  mkdirSync(resolve(cacheDir, 'index-v5'), { recursive: true })
  mkdirSync(resolve(cacheDir, 'content-v2'), { recursive: true })
  setup(cacheDir)
  return cacheDir
}

function bucketPathFor(cacheDir: string, key: string): string {
  // Mirror cacache `hashKey` (sha256-hex) + `hashToSegments`.
  const sha = createHash('sha256').update(key).digest('hex')
  const dir = resolve(cacheDir, 'index-v5', sha.slice(0, 2), sha.slice(2, 4))
  mkdirSync(dir, { recursive: true })
  return resolve(dir, sha.slice(4))
}

function buildKey(name: string, version: string, encodedScope: boolean = true): string {
  const encoded = name.startsWith('@')
    ? (encodedScope ? name.replace('/', '%2f') : name)
    : name
  const lastComponent = name.includes('/') ? name.slice(name.indexOf('/') + 1) : name
  return `make-fetch-happen:request-cache:https://registry.npmjs.org/${encoded}/-/${lastComponent}-${version}.tgz`
}

interface IndexRecord {
  key:       string
  integrity?: string
  time?:     number
  size?:     number
}

function recordLine(record: IndexRecord): string {
  const json = JSON.stringify({
    key:       record.key,
    integrity: record.integrity,
    time:      record.time ?? Date.now(),
    size:      record.size ?? 0,
    metadata:  null,
  })
  const hash = createHash('sha1').update(json).digest('hex')
  return `\n${hash}\t${json}`
}

function writeBucket(cacheDir: string, records: IndexRecord[]): void {
  // cacache buckets are per-key (one bucket per hashed key, since
  // hashToSegments is keyed on the request URL). But a single key
  // may have multiple appended records — we keep that flexibility
  // by grouping records that hash to the same bucket.
  const byBucket = new Map<string, IndexRecord[]>()
  for (const rec of records) {
    const bp = bucketPathFor(cacheDir, rec.key)
    if (!byBucket.has(bp)) byBucket.set(bp, [])
    byBucket.get(bp)!.push(rec)
  }
  for (const [bp, recs] of byBucket) {
    writeFileSync(bp, recs.map(recordLine).join(''))
  }
}

function writeContent(cacheDir: string, integrity: string, bytes: Buffer): void {
  // SRI → content-v2/<algo>/<2>/<2>/<rest-of-hex>
  const dash = integrity.indexOf('-')
  const algo = integrity.slice(0, dash)
  const b64  = integrity.slice(dash + 1)
  const hex  = Buffer.from(b64, 'base64').toString('hex')
  const dir  = resolve(cacheDir, 'content-v2', algo, hex.slice(0, 2), hex.slice(2, 4))
  mkdirSync(dir, { recursive: true })
  writeFileSync(resolve(dir, hex.slice(4)), bytes)
}

function fakeSri(seed: string): string {
  // 64-byte sha512 → base64 with `==` padding. Deterministic per seed.
  const bytes = createHash('sha512').update(seed).digest()
  return `sha512-${bytes.toString('base64')}`
}

describe('registry/cache-npm — npmCache packument()', () => {
  it('returns a Packument for a single matched entry', async () => {
    const sri = fakeSri('lodash@4.17.21')
    const cacheDir = freshCache(dir => {
      writeBucket(dir, [{ key: buildKey('lodash', '4.17.21'), integrity: sri }])
    })
    const cache = npmCache({ cacheDir })

    const packument = await cache.packument('lodash')
    expect(packument).toBeDefined()
    expect(packument!.name).toBe('lodash')
    expect(Object.keys(packument!.versions)).toEqual(['4.17.21'])
    expect(packument!.versions['4.17.21']).toEqual({
      name:      'lodash',
      version:   '4.17.21',
      integrity: parseSri(sri, 'registry'),
    })
    expect(packument!.distTags).toEqual({})
  })

  it('aggregates multiple versions of the same package', async () => {
    const cacheDir = freshCache(dir => {
      writeBucket(dir, [
        { key: buildKey('lodash', '4.16.0'),  integrity: fakeSri('lodash@4.16.0') },
        { key: buildKey('lodash', '4.17.20'), integrity: fakeSri('lodash@4.17.20') },
        { key: buildKey('lodash', '4.17.21'), integrity: fakeSri('lodash@4.17.21') },
      ])
    })
    const cache = npmCache({ cacheDir })

    const packument = await cache.packument('lodash')
    expect(packument).toBeDefined()
    expect(Object.keys(packument!.versions).sort()).toEqual([
      '4.16.0',
      '4.17.20',
      '4.17.21',
    ])
  })

  it('parses scoped package keys (encoded /@types%2fnode/)', async () => {
    const cacheDir = freshCache(dir => {
      writeBucket(dir, [
        { key: buildKey('@types/node', '20.0.0'), integrity: fakeSri('@types/node@20') },
        { key: buildKey('@types/node', '22.0.0'), integrity: fakeSri('@types/node@22') },
      ])
    })
    const cache = npmCache({ cacheDir })

    const packument = await cache.packument('@types/node')
    expect(packument).toBeDefined()
    expect(packument!.name).toBe('@types/node')
    expect(Object.keys(packument!.versions).sort()).toEqual(['20.0.0', '22.0.0'])
  })

  it('parses scoped package keys when slash is NOT percent-encoded', async () => {
    const cacheDir = freshCache(dir => {
      writeBucket(dir, [{
        key: buildKey('@types/node', '20.0.0', /* encoded= */ false),
        integrity: fakeSri('@types/node@20-noenc'),
      }])
    })
    const cache = npmCache({ cacheDir })

    const packument = await cache.packument('@types/node')
    expect(packument).toBeDefined()
    expect(Object.keys(packument!.versions)).toEqual(['20.0.0'])
  })

  it('returns undefined when no entry matches', async () => {
    const cacheDir = freshCache(dir => {
      writeBucket(dir, [{ key: buildKey('react', '18.0.0'), integrity: fakeSri('react@18') }])
    })
    const cache = npmCache({ cacheDir })

    const packument = await cache.packument('lodash')
    expect(packument).toBeUndefined()
  })

  it('returns undefined when the cache folder does not exist', async () => {
    const cache = npmCache({ cacheDir: resolve(tmpdir(), 'lockfile-npmcache-missing-' + Date.now()) })
    const packument = await cache.packument('lodash')
    expect(packument).toBeUndefined()
  })

  it('skips malformed bucket lines silently', async () => {
    const cacheDir = freshCache(dir => {
      // Valid record gets ingested; everything else is dropped без throw.
      const goodKey = buildKey('lodash', '4.17.21')
      const goodSri = fakeSri('lodash@4.17.21')
      const goodLine = recordLine({ key: goodKey, integrity: goodSri, time: 1 })

      const bp = bucketPathFor(dir, goodKey)
      const garbled = [
        goodLine,
        '\nnotahash\tnotjson',
        '\nfeedfacefeedface\t{"key":null}',
        '\nfeedfacefeedface\t{"key":"weird key with no tarball url"}',
        '\nfeedfacefeedface\t{}',
        '\nfeedfacefeedface\tnonjson{',
        '\n   ',
      ].join('')
      writeFileSync(bp, garbled)
    })
    const cache = npmCache({ cacheDir })

    const packument = await cache.packument('lodash')
    expect(packument).toBeDefined()
    expect(Object.keys(packument!.versions)).toEqual(['4.17.21'])
  })

  it('keeps the most recent record per (name, version) when a key is appended multiple times', async () => {
    const cacheDir = freshCache(dir => {
      // Two records for the same (name, version) — second has higher time
      // и a different integrity. Last-write-wins by `time`.
      writeBucket(dir, [
        { key: buildKey('lodash', '4.17.21'), integrity: fakeSri('lodash@4.17.21-old'), time: 1 },
        { key: buildKey('lodash', '4.17.21'), integrity: fakeSri('lodash@4.17.21-new'), time: 2 },
      ])
    })
    const cache = npmCache({ cacheDir })

    const packument = await cache.packument('lodash')
    expect(packument!.versions['4.17.21']!.integrity).toEqual(parseSri(fakeSri('lodash@4.17.21-new'), 'registry'))
  })

  it('does not bleed across packages with overlapping name prefixes', async () => {
    const cacheDir = freshCache(dir => {
      writeBucket(dir, [
        { key: buildKey('lodash',    '4.17.21'), integrity: fakeSri('lodash@4.17.21') },
        { key: buildKey('lodash-es', '4.17.21'), integrity: fakeSri('lodash-es@4.17.21') },
      ])
    })
    const cache = npmCache({ cacheDir })

    const lodash = await cache.packument('lodash')
    expect(Object.keys(lodash!.versions)).toEqual(['4.17.21'])

    const lodashEs = await cache.packument('lodash-es')
    expect(Object.keys(lodashEs!.versions)).toEqual(['4.17.21'])
  })
})

describe('registry/cache-npm — npmCache tarball()', () => {
  it('returns content bytes on cache hit', async () => {
    const sri = fakeSri('lodash@4.17.21')
    const tarballBytes = Buffer.from([0x1f, 0x8b, 0x08, 0xde, 0xad, 0xbe, 0xef])
    const cacheDir = freshCache(dir => {
      writeBucket(dir, [{ key: buildKey('lodash', '4.17.21'), integrity: sri }])
      writeContent(dir, sri, tarballBytes)
    })
    const cache = npmCache({ cacheDir })

    const bytes = await cache.tarball!('lodash', '4.17.21')
    expect(bytes).toBeDefined()
    expect(bytes!.length).toBe(tarballBytes.length)
    expect(bytes![0]).toBe(0x1f)
    expect(bytes![1]).toBe(0x8b)
  })

  it('returns undefined when index entry exists but content blob is missing', async () => {
    const sri = fakeSri('lodash@4.17.21-orphan')
    const cacheDir = freshCache(dir => {
      writeBucket(dir, [{ key: buildKey('lodash', '4.17.21'), integrity: sri }])
      // no writeContent — the content-v2 blob is absent
    })
    const cache = npmCache({ cacheDir })

    const bytes = await cache.tarball!('lodash', '4.17.21')
    expect(bytes).toBeUndefined()
  })

  it('returns undefined when no index entry matches (clean miss)', async () => {
    const cacheDir = freshCache(dir => {
      writeBucket(dir, [{ key: buildKey('react', '18.0.0'), integrity: fakeSri('react@18') }])
    })
    const cache = npmCache({ cacheDir })

    const bytes = await cache.tarball!('lodash', '4.17.21')
    expect(bytes).toBeUndefined()
  })

  it('returns undefined for a version mismatch when other versions are present', async () => {
    const cacheDir = freshCache(dir => {
      const sri = fakeSri('lodash@4.16.0')
      writeBucket(dir, [{ key: buildKey('lodash', '4.16.0'), integrity: sri }])
      writeContent(dir, sri, Buffer.from([0x1f, 0x8b]))
    })
    const cache = npmCache({ cacheDir })

    const bytes = await cache.tarball!('lodash', '4.17.21')
    expect(bytes).toBeUndefined()
  })

  it('handles scoped package tarball retrieval', async () => {
    const sri = fakeSri('@types/node@20.0.0')
    const tarballBytes = Buffer.from([0xca, 0xfe, 0xba, 0xbe])
    const cacheDir = freshCache(dir => {
      writeBucket(dir, [{ key: buildKey('@types/node', '20.0.0'), integrity: sri }])
      writeContent(dir, sri, tarballBytes)
    })
    const cache = npmCache({ cacheDir })

    const bytes = await cache.tarball!('@types/node', '20.0.0')
    expect(bytes).toBeDefined()
    expect(bytes!.length).toBe(4)
    expect(bytes![0]).toBe(0xca)
    expect(bytes![3]).toBe(0xbe)
  })
})

describe('registry/cache-npm — cache-folder probe order', () => {
  const savedEnv = process.env.NPM_CONFIG_CACHE
  beforeEach(() => {
    delete process.env.NPM_CONFIG_CACHE
  })
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.NPM_CONFIG_CACHE
    else process.env.NPM_CONFIG_CACHE = savedEnv
  })

  it('honours explicit opts.cacheDir over everything else', async () => {
    const explicitDir = freshCache(dir => {
      writeBucket(dir, [{ key: buildKey('lodash', '1.0.0'), integrity: fakeSri('lodash@1') }])
    })
    const envParent = mkdtempSync(resolve(tmpdir(), 'lockfile-npmcache-envparent-'))
    dirs.push(envParent)
    const envCache = resolve(envParent, '_cacache')
    mkdirSync(resolve(envCache, 'index-v5'), { recursive: true })
    writeBucket(envCache, [{ key: buildKey('lodash', '2.0.0'), integrity: fakeSri('lodash@2') }])
    process.env.NPM_CONFIG_CACHE = envParent

    const cache = npmCache({ cacheDir: explicitDir })
    const packument = await cache.packument('lodash')
    expect(Object.keys(packument!.versions)).toEqual(['1.0.0'])
  })

  it('appends _cacache to $NPM_CONFIG_CACHE when probing', async () => {
    const envParent = mkdtempSync(resolve(tmpdir(), 'lockfile-npmcache-envparent-'))
    dirs.push(envParent)
    const envCache = resolve(envParent, '_cacache')
    mkdirSync(resolve(envCache, 'index-v5'), { recursive: true })
    mkdirSync(resolve(envCache, 'content-v2'), { recursive: true })
    writeBucket(envCache, [{ key: buildKey('lodash', '2.0.0'), integrity: fakeSri('lodash@2') }])
    process.env.NPM_CONFIG_CACHE = envParent

    const cache = npmCache()
    const packument = await cache.packument('lodash')
    expect(Object.keys(packument!.versions)).toEqual(['2.0.0'])
  })

  it('falls back to ~/.npm/_cacache when env is unset', async () => {
    const fakeHome = mkdtempSync(resolve(tmpdir(), 'lockfile-npmcache-home-'))
    dirs.push(fakeHome)
    const cacheDir = resolve(fakeHome, '.npm', '_cacache')
    mkdirSync(resolve(cacheDir, 'index-v5'), { recursive: true })
    writeBucket(cacheDir, [{ key: buildKey('lodash', '3.0.0'), integrity: fakeSri('lodash@3') }])

    const savedHome = process.env.HOME
    const savedUserProfile = process.env.USERPROFILE
    try {
      process.env.HOME = fakeHome
      delete process.env.USERPROFILE

      const cache = npmCache()
      const packument = await cache.packument('lodash')
      expect(Object.keys(packument!.versions)).toEqual(['3.0.0'])
    } finally {
      if (savedHome === undefined) delete process.env.HOME
      else process.env.HOME = savedHome
      if (savedUserProfile !== undefined) process.env.USERPROFILE = savedUserProfile
    }
  })
})
