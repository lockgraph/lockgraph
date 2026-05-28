// Phase D-B3 — `pnpmCache` (pnpm v3 store CacheAdapter) unit suite.
//
// All tests build a temp `v3/` store dir and populate it with synthetic
// `<2-hex>/<rest-of-hex>-index.json` files matching the
// `PackageFilesIndex` shape pnpm writes under
// `<storeDir>/files/<2-hex>/<rest-of-hex>-index.json`. No real pnpm
// store or binary involvement.

import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { pnpmCache } from '../../main/ts/index.ts'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function freshStore(setup: (filesDir: string) => void = () => {}): string {
  const storeDir = mkdtempSync(resolve(tmpdir(), 'lockfile-pnpmcache-'))
  dirs.push(storeDir)
  const filesDir = resolve(storeDir, 'files')
  mkdirSync(filesDir, { recursive: true })
  setup(filesDir)
  return storeDir
}

interface IndexInput {
  name:             string
  version:          string
  /** Override the sha512 hex used to derive the bucket path. Defaults to a hash of name@version. */
  digestSeed?:      string
  /** Extra fields to merge into manifest. */
  manifestExtra?:   Record<string, unknown>
  /** When set, replaces the entire on-disk JSON (raw mode) — used for malformed-record tests. */
  rawJson?:         string
}

function placeIndex(filesDir: string, input: IndexInput): string {
  const seed = input.digestSeed ?? `${input.name}@${input.version}`
  const hex  = createHash('sha512').update(seed).digest('hex')
  const dir  = resolve(filesDir, hex.slice(0, 2))
  mkdirSync(dir, { recursive: true })

  const indexPath = resolve(dir, `${hex.slice(2)}-index.json`)
  if (input.rawJson !== undefined) {
    writeFileSync(indexPath, input.rawJson)
    return indexPath
  }

  const manifest = {
    name:    input.name,
    version: input.version,
    ...input.manifestExtra,
  }
  const payload = {
    manifest,
    algo:  'sha512',
    files: [],
  }
  writeFileSync(indexPath, JSON.stringify(payload, null, 2))
  return indexPath
}

describe('registry/cache-pnpm — pnpmCache packument()', () => {
  it('returns a Packument for a single package index', async () => {
    const storeDir = freshStore(filesDir => {
      placeIndex(filesDir, { name: 'lodash', version: '4.17.21' })
    })
    const cache = pnpmCache({ storeDir })

    const packument = await cache.packument('lodash')
    expect(packument).toBeDefined()
    expect(packument!.name).toBe('lodash')
    expect(Object.keys(packument!.versions)).toEqual(['4.17.21'])
    expect(packument!.versions['4.17.21']).toEqual({
      name:    'lodash',
      version: '4.17.21',
    })
    expect(packument!.distTags).toEqual({})
  })

  it('aggregates multiple versions of the same package', async () => {
    const storeDir = freshStore(filesDir => {
      placeIndex(filesDir, { name: 'lodash', version: '4.16.0' })
      placeIndex(filesDir, { name: 'lodash', version: '4.17.20' })
      placeIndex(filesDir, { name: 'lodash', version: '4.17.21' })
    })
    const cache = pnpmCache({ storeDir })

    const packument = await cache.packument('lodash')
    expect(packument).toBeDefined()
    expect(Object.keys(packument!.versions).sort()).toEqual([
      '4.16.0',
      '4.17.20',
      '4.17.21',
    ])
  })

  it('parses scoped packages from the bundled manifest', async () => {
    const storeDir = freshStore(filesDir => {
      placeIndex(filesDir, { name: '@types/node', version: '20.0.0' })
      placeIndex(filesDir, { name: '@types/node', version: '22.0.0' })
    })
    const cache = pnpmCache({ storeDir })

    const packument = await cache.packument('@types/node')
    expect(packument).toBeDefined()
    expect(packument!.name).toBe('@types/node')
    expect(Object.keys(packument!.versions).sort()).toEqual(['20.0.0', '22.0.0'])
  })

  it('propagates dependency-map + engines + bin from the bundled manifest', async () => {
    const storeDir = freshStore(filesDir => {
      placeIndex(filesDir, {
        name:    'foo',
        version: '1.0.0',
        manifestExtra: {
          dependencies:    { lodash: '^4.17.0' },
          devDependencies: { vitest: '^1.0.0' },
          engines:         { node: '>=18' },
          bin:             { foo: 'bin/foo.js' },
          os:              ['linux', 'darwin'],
          cpu:             ['x64'],
          deprecated:      'use bar instead',
        },
      })
    })
    const cache = pnpmCache({ storeDir })

    const packument = await cache.packument('foo')
    const v = packument!.versions['1.0.0']!
    expect(v.dependencies).toEqual({ lodash: '^4.17.0' })
    expect(v.devDependencies).toEqual({ vitest: '^1.0.0' })
    expect(v.engines).toEqual({ node: '>=18' })
    expect(v.bin).toEqual({ foo: 'bin/foo.js' })
    expect(v.os).toEqual(['linux', 'darwin'])
    expect(v.cpu).toEqual(['x64'])
    expect(v.deprecated).toBe('use bar instead')
  })

  it('returns undefined when no index matches', async () => {
    const storeDir = freshStore(filesDir => {
      placeIndex(filesDir, { name: 'react', version: '18.0.0' })
    })
    const cache = pnpmCache({ storeDir })

    const packument = await cache.packument('lodash')
    expect(packument).toBeUndefined()
  })

  it('returns undefined when the store dir does not exist', async () => {
    const cache = pnpmCache({ storeDir: resolve(tmpdir(), 'lockfile-pnpmcache-missing-' + Date.now()) })
    const packument = await cache.packument('lodash')
    expect(packument).toBeUndefined()
  })

  it('falls back to <storeDir> as the files/ root if files/ is absent', async () => {
    // Some installations point storeDir directly at the `files/` bucket
    // root. We should still find indexes there.
    const root = mkdtempSync(resolve(tmpdir(), 'lockfile-pnpmcache-flat-'))
    dirs.push(root)
    // Note: no `files/` subdir. Drop the bucket directly under root.
    placeIndex(root, { name: 'lodash', version: '4.17.21' })

    const cache = pnpmCache({ storeDir: root })
    const packument = await cache.packument('lodash')
    expect(packument).toBeDefined()
    expect(Object.keys(packument!.versions)).toEqual(['4.17.21'])
  })

  it('skips malformed index files silently', async () => {
    const storeDir = freshStore(filesDir => {
      // valid record
      placeIndex(filesDir, { name: 'lodash', version: '4.17.21' })
      // garbled JSON
      placeIndex(filesDir, {
        name:        'unused',
        version:     'unused',
        digestSeed:  'garbled',
        rawJson:     'not-actually-json {{{',
      })
      // valid JSON but no manifest
      placeIndex(filesDir, {
        name:        'unused',
        version:     'unused',
        digestSeed:  'no-manifest',
        rawJson:     JSON.stringify({ algo: 'sha512', files: [] }),
      })
      // manifest без name/version
      placeIndex(filesDir, {
        name:        'unused',
        version:     'unused',
        digestSeed:  'no-name',
        rawJson:     JSON.stringify({ manifest: { something: 'else' }, algo: 'sha512', files: [] }),
      })
      // null manifest
      placeIndex(filesDir, {
        name:        'unused',
        version:     'unused',
        digestSeed:  'null-manifest',
        rawJson:     JSON.stringify({ manifest: null, algo: 'sha512', files: [] }),
      })
    })
    const cache = pnpmCache({ storeDir })

    const packument = await cache.packument('lodash')
    expect(packument).toBeDefined()
    expect(Object.keys(packument!.versions)).toEqual(['4.17.21'])
  })

  it('ignores non-index files in the bucket dirs', async () => {
    const storeDir = freshStore(filesDir => {
      const indexPath = placeIndex(filesDir, { name: 'lodash', version: '4.17.21' })
      // Drop a non-executable content blob and an executable blob in
      // the same bucket dir — both should be skipped.
      const bucketDir = resolve(indexPath, '..')
      writeFileSync(resolve(bucketDir, 'abc123def456'),       Buffer.from([0xde, 0xad]))
      writeFileSync(resolve(bucketDir, 'abc123def456-exec'),  Buffer.from([0xbe, 0xef]))
    })
    const cache = pnpmCache({ storeDir })

    const packument = await cache.packument('lodash')
    expect(packument).toBeDefined()
    expect(Object.keys(packument!.versions)).toEqual(['4.17.21'])
  })

  it('skips non-hex-pair bucket directories', async () => {
    const storeDir = freshStore(filesDir => {
      mkdirSync(resolve(filesDir, 'zz'),     { recursive: true }) // bad: not hex
      mkdirSync(resolve(filesDir, 'abcd'),   { recursive: true }) // bad: 4 chars
      writeFileSync(resolve(filesDir, 'zz', 'whatever-index.json'),
        JSON.stringify({ manifest: { name: 'lodash', version: '99.0.0' }, algo: 'sha512', files: [] }))
      placeIndex(filesDir, { name: 'lodash', version: '4.17.21' })
    })
    const cache = pnpmCache({ storeDir })

    const packument = await cache.packument('lodash')
    expect(Object.keys(packument!.versions)).toEqual(['4.17.21'])
  })
})

describe('registry/cache-pnpm — pnpmCache tarball() is architecturally undefined', () => {
  it('returns undefined even when packument() would succeed', async () => {
    const storeDir = freshStore(filesDir => {
      placeIndex(filesDir, { name: 'lodash', version: '4.17.21' })
    })
    const cache = pnpmCache({ storeDir })

    // Sanity: packument() works.
    const packument = await cache.packument('lodash')
    expect(packument).toBeDefined()

    // tarball() never returns bytes — pnpm decomposes archives into
    // per-file content-addressable blobs and discards the original.
    const bytes = await cache.tarball!('lodash', '4.17.21')
    expect(bytes).toBeUndefined()
  })

  it('returns undefined on clean miss too', async () => {
    const storeDir = freshStore()
    const cache = pnpmCache({ storeDir })
    const bytes = await cache.tarball!('lodash', '4.17.21')
    expect(bytes).toBeUndefined()
  })
})

describe('registry/cache-pnpm — store-folder probe order', () => {
  const savedEnv = process.env.PNPM_STORE_DIR
  beforeEach(() => {
    delete process.env.PNPM_STORE_DIR
  })
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.PNPM_STORE_DIR
    else process.env.PNPM_STORE_DIR = savedEnv
  })

  it('honours explicit opts.storeDir over everything else', async () => {
    const explicitStore = freshStore(filesDir => {
      placeIndex(filesDir, { name: 'lodash', version: '1.0.0' })
    })
    const envStore = freshStore(filesDir => {
      placeIndex(filesDir, { name: 'lodash', version: '2.0.0' })
    })
    process.env.PNPM_STORE_DIR = envStore

    const cache = pnpmCache({ storeDir: explicitStore })
    const packument = await cache.packument('lodash')
    expect(Object.keys(packument!.versions)).toEqual(['1.0.0'])
  })

  it('honours $PNPM_STORE_DIR over the default fallback', async () => {
    const envStore = freshStore(filesDir => {
      placeIndex(filesDir, { name: 'lodash', version: '2.0.0' })
    })
    process.env.PNPM_STORE_DIR = envStore

    const cache = pnpmCache()
    const packument = await cache.packument('lodash')
    expect(Object.keys(packument!.versions)).toEqual(['2.0.0'])
  })

  it('falls back to ~/.pnpm-store/v3 when env is unset', async () => {
    const fakeHome = mkdtempSync(resolve(tmpdir(), 'lockfile-pnpmcache-home-'))
    dirs.push(fakeHome)
    const storeDir = resolve(fakeHome, '.pnpm-store', 'v3')
    const filesDir = resolve(storeDir, 'files')
    mkdirSync(filesDir, { recursive: true })
    placeIndex(filesDir, { name: 'lodash', version: '3.0.0' })

    const savedHome = process.env.HOME
    const savedUserProfile = process.env.USERPROFILE
    try {
      process.env.HOME = fakeHome
      delete process.env.USERPROFILE

      const cache = pnpmCache()
      const packument = await cache.packument('lodash')
      expect(Object.keys(packument!.versions)).toEqual(['3.0.0'])
    } finally {
      if (savedHome === undefined) delete process.env.HOME
      else process.env.HOME = savedHome
      if (savedUserProfile !== undefined) process.env.USERPROFILE = savedUserProfile
    }
  })
})
