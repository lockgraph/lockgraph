// Phase D-B — `fsCache` (yarn-berry filesystem CacheAdapter) unit suite.
//
// All tests construct a temp directory and populate it with empty
// `.zip` files matching the yarn-berry cache filename convention. No
// real yarn cache or PM binary is required — we exercise filename
// parsing, packument synthesis, and the cache-folder probe order.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fsCache } from '../../main/ts/index.ts'

function fixtureCache(setup: (cacheDir: string) => void): string {
  const cacheDir = mkdtempSync(resolve(tmpdir(), 'lockfile-fscache-'))
  setup(cacheDir)
  return cacheDir
}

function touchZip(cacheDir: string, name: string): void {
  writeFileSync(resolve(cacheDir, name), Buffer.alloc(0))
}

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function freshCache(setup: (cacheDir: string) => void = () => {}): string {
  const cacheDir = fixtureCache(setup)
  dirs.push(cacheDir)
  return cacheDir
}

describe('registry/cache — fsCache packument()', () => {
  it('returns a Packument for a single matched zip', async () => {
    const cacheDir = freshCache(dir => {
      touchZip(dir, 'lodash-npm-4.17.21-c8c0e3a1bc-10c0.zip')
    })
    const cache = fsCache({ cacheFolder: cacheDir })

    const packument = await cache.packument('lodash')
    expect(packument).toBeDefined()
    expect(packument!.name).toBe('lodash')
    expect(Object.keys(packument!.versions)).toEqual(['4.17.21'])
    expect(packument!.versions['4.17.21']).toEqual({
      name:    'lodash',
      version: '4.17.21',
    })
    // No reliable on-disk dist-tag → empty
    expect(packument!.distTags).toEqual({})
  })

  it('aggregates multiple versions of the same package', async () => {
    const cacheDir = freshCache(dir => {
      touchZip(dir, 'lodash-npm-4.16.0-aaaaaaaaaa-10c0.zip')
      touchZip(dir, 'lodash-npm-4.17.20-bbbbbbbbbb-10c0.zip')
      touchZip(dir, 'lodash-npm-4.17.21-cccccccccc-10c0.zip')
    })
    const cache = fsCache({ cacheFolder: cacheDir })

    const packument = await cache.packument('lodash')
    expect(packument).toBeDefined()
    expect(Object.keys(packument!.versions).sort()).toEqual([
      '4.16.0',
      '4.17.20',
      '4.17.21',
    ])
  })

  it('parses scoped package filenames (@types/node → @types-node-npm-...)', async () => {
    const cacheDir = freshCache(dir => {
      touchZip(dir, '@types-node-npm-20.0.0-abcdef1234-10c0.zip')
      touchZip(dir, '@types-node-npm-22.0.0-aaaaaaaaaa-10c0.zip')
    })
    const cache = fsCache({ cacheFolder: cacheDir })

    const packument = await cache.packument('@types/node')
    expect(packument).toBeDefined()
    expect(packument!.name).toBe('@types/node')
    expect(Object.keys(packument!.versions).sort()).toEqual(['20.0.0', '22.0.0'])
    expect(packument!.versions['20.0.0']).toEqual({
      name:    '@types/node',
      version: '20.0.0',
    })
  })

  it('returns undefined when no zip matches', async () => {
    const cacheDir = freshCache(dir => {
      touchZip(dir, 'react-npm-18.0.0-abcdef1234-10c0.zip')
    })
    const cache = fsCache({ cacheFolder: cacheDir })

    const packument = await cache.packument('lodash')
    expect(packument).toBeUndefined()
  })

  it('returns undefined when the cache folder does not exist', async () => {
    const cache = fsCache({ cacheFolder: resolve(tmpdir(), 'lockfile-fscache-missing-' + Date.now()) })
    const packument = await cache.packument('lodash')
    expect(packument).toBeUndefined()
  })

  it('accepts the checksum-only filename shape (no trailing cacheKey)', async () => {
    // Format B from Cache.getLocatorPath: <slug>-<checksumSlice10>.zip
    const cacheDir = freshCache(dir => {
      touchZip(dir, 'lodash-npm-4.17.21-abcdef1234.zip')
    })
    const cache = fsCache({ cacheFolder: cacheDir })

    const packument = await cache.packument('lodash')
    expect(packument).toBeDefined()
    expect(Object.keys(packument!.versions)).toEqual(['4.17.21'])
  })

  it('recovers pre-release versions (1.0.0-beta.1)', async () => {
    const cacheDir = freshCache(dir => {
      touchZip(dir, 'somepkg-npm-1.0.0-beta.1-abcdef1234-10c0.zip')
    })
    const cache = fsCache({ cacheFolder: cacheDir })

    const packument = await cache.packument('somepkg')
    expect(packument).toBeDefined()
    expect(Object.keys(packument!.versions)).toEqual(['1.0.0-beta.1'])
  })

  it('skips unknown filename patterns silently (does not throw)', async () => {
    const cacheDir = freshCache(dir => {
      touchZip(dir, 'lodash-npm-4.17.21-c8c0e3a1bc-10c0.zip') // valid
      touchZip(dir, 'lodash-npm-garbage.zip')                  // bad: no 10hex
      touchZip(dir, 'lodash-npm-4.17.21-short-10c0.zip')      // bad: hash too short
      touchZip(dir, 'lodash.txt')                              // bad: not zip
      writeFileSync(resolve(dir, 'random.zip'), Buffer.alloc(0)) // bad: no slug
    })
    const cache = fsCache({ cacheFolder: cacheDir })

    const packument = await cache.packument('lodash')
    expect(packument).toBeDefined()
    expect(Object.keys(packument!.versions)).toEqual(['4.17.21'])
  })

  it('does not bleed across package names with similar prefixes', async () => {
    const cacheDir = freshCache(dir => {
      touchZip(dir, 'lodash-npm-4.17.21-cccccccccc-10c0.zip')
      touchZip(dir, 'lodash-es-npm-4.17.21-dddddddddd-10c0.zip')
    })
    const cache = fsCache({ cacheFolder: cacheDir })

    const lodash = await cache.packument('lodash')
    expect(Object.keys(lodash!.versions)).toEqual(['4.17.21'])

    const lodashEs = await cache.packument('lodash-es')
    expect(Object.keys(lodashEs!.versions)).toEqual(['4.17.21'])
  })
})

describe('registry/cache — fsCache tarball()', () => {
  it('returns the zip bytes on cache hit', async () => {
    const cacheDir = freshCache(dir => {
      writeFileSync(
        resolve(dir, 'lodash-npm-4.17.21-c8c0e3a1bc-10c0.zip'),
        Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xde, 0xad, 0xbe, 0xef]),
      )
    })
    const cache = fsCache({ cacheFolder: cacheDir })

    const bytes = await cache.tarball!('lodash', '4.17.21')
    expect(bytes).toBeDefined()
    expect(bytes!.length).toBe(8)
    expect(bytes![0]).toBe(0x50)
    expect(bytes![1]).toBe(0x4b)
    expect(bytes![2]).toBe(0x03)
    expect(bytes![3]).toBe(0x04)
  })

  it('returns undefined on cache miss (no zip)', async () => {
    const cacheDir = freshCache(dir => {
      touchZip(dir, 'react-npm-18.0.0-abcdef1234-10c0.zip')
    })
    const cache = fsCache({ cacheFolder: cacheDir })

    const bytes = await cache.tarball!('lodash', '4.17.21')
    expect(bytes).toBeUndefined()
  })

  it('returns undefined when a matching zip exists for a different version', async () => {
    const cacheDir = freshCache(dir => {
      touchZip(dir, 'lodash-npm-4.16.0-aaaaaaaaaa-10c0.zip')
    })
    const cache = fsCache({ cacheFolder: cacheDir })

    const bytes = await cache.tarball!('lodash', '4.17.21')
    expect(bytes).toBeUndefined()
  })

  it('handles scoped package tarball lookups', async () => {
    const cacheDir = freshCache(dir => {
      writeFileSync(
        resolve(dir, '@types-node-npm-20.0.0-abcdef1234-10c0.zip'),
        Buffer.from([0xca, 0xfe]),
      )
    })
    const cache = fsCache({ cacheFolder: cacheDir })

    const bytes = await cache.tarball!('@types/node', '20.0.0')
    expect(bytes).toBeDefined()
    expect(bytes!.length).toBe(2)
    expect(bytes![0]).toBe(0xca)
    expect(bytes![1]).toBe(0xfe)
  })
})

describe('registry/cache — cache-folder probe order', () => {
  const savedEnv = process.env.YARN_CACHE_FOLDER
  beforeEach(() => {
    delete process.env.YARN_CACHE_FOLDER
  })
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.YARN_CACHE_FOLDER
    else process.env.YARN_CACHE_FOLDER = savedEnv
  })

  it('honours explicit opts.cacheFolder over everything else', async () => {
    const explicitDir = freshCache(dir => {
      touchZip(dir, 'lodash-npm-1.0.0-aaaaaaaaaa-10c0.zip')
    })
    const envDir = freshCache(dir => {
      touchZip(dir, 'lodash-npm-2.0.0-bbbbbbbbbb-10c0.zip')
    })
    process.env.YARN_CACHE_FOLDER = envDir

    const cache = fsCache({ cacheFolder: explicitDir })
    const packument = await cache.packument('lodash')
    expect(Object.keys(packument!.versions)).toEqual(['1.0.0'])
  })

  it('honours $YARN_CACHE_FOLDER over workspaceRoot/.yarn/cache', async () => {
    const envDir = freshCache(dir => {
      touchZip(dir, 'lodash-npm-2.0.0-bbbbbbbbbb-10c0.zip')
    })
    const workspaceRoot = freshCache(() => {})
    // Simulate a stale workspace-root cache that should be ignored.
    process.env.YARN_CACHE_FOLDER = envDir

    const cache = fsCache({ workspaceRoot })
    const packument = await cache.packument('lodash')
    expect(Object.keys(packument!.versions)).toEqual(['2.0.0'])
  })

  it('falls back to <workspaceRoot>/.yarn/cache when env is unset', async () => {
    // Build a temp dir, mkdir its .yarn/cache, drop a zip, point workspaceRoot at it.
    const workspaceRoot = mkdtempSync(resolve(tmpdir(), 'lockfile-fscache-ws-'))
    dirs.push(workspaceRoot)
    const cacheDir = resolve(workspaceRoot, '.yarn', 'cache')
    // mkdir recursive via writeFileSync into nested path is not possible — use fs.mkdirSync.
    // Inline import to keep the test file's import list tight.
    const { mkdirSync } = await import('node:fs')
    mkdirSync(cacheDir, { recursive: true })
    touchZip(cacheDir, 'lodash-npm-3.0.0-cccccccccc-10c0.zip')

    const cache = fsCache({ workspaceRoot })
    const packument = await cache.packument('lodash')
    expect(Object.keys(packument!.versions)).toEqual(['3.0.0'])
  })

  it('falls back to ~/.yarn/berry/cache when env and workspaceRoot are unset', async () => {
    const fakeHome = mkdtempSync(resolve(tmpdir(), 'lockfile-fscache-home-'))
    dirs.push(fakeHome)
    const cacheDir = resolve(fakeHome, '.yarn', 'berry', 'cache')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(cacheDir, { recursive: true })
    touchZip(cacheDir, 'lodash-npm-4.0.0-dddddddddd-10c0.zip')

    const savedHome = process.env.HOME
    const savedUserProfile = process.env.USERPROFILE
    try {
      process.env.HOME = fakeHome
      delete process.env.USERPROFILE

      const cache = fsCache()
      const packument = await cache.packument('lodash')
      expect(Object.keys(packument!.versions)).toEqual(['4.0.0'])
    } finally {
      if (savedHome === undefined) delete process.env.HOME
      else process.env.HOME = savedHome
      if (savedUserProfile !== undefined) process.env.USERPROFILE = savedUserProfile
    }
  })
})
