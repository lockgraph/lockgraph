// npm cacache CacheAdapter — Phase D-B2.
//
// Reads the cacache layout that `npm install` populates under
// `~/.npm/_cacache/` (override via `$NPM_CONFIG_CACHE`). Two on-disk
// stores cooperate per <https://github.com/npm/cacache>:
//
//   index-v5/<2-hex>/<2-hex>/<rest-of-sha256-hex>
//     Newline-delimited bucket files where each non-blank line has the
//     shape `<sha1-of-json>\t<json>`. JSON is `{ key, integrity, time,
//     size, metadata }`. The bucket directory is the SHA-256 hex of the
//     entry's `key`, split into three segments by cacache's
//     `hashToSegments` (slice 0..2 / 2..4 / 4..). Many entries can share
//     a bucket; a single key can also accumulate multiple appended
//     records — the highest-`time` record per (name, version) wins.
//   content-v2/<algorithm>/<2-hex>/<2-hex>/<rest-of-hex>
//     Raw tarball bytes addressed by the integrity (typically
//     sha512). The algorithm subdir matches the SRI prefix; the hex
//     segmentation is `hashToSegments` again. This is what we serve
//     from `tarball()`.
//
// Index entry `key` examples (matching `make-fetch-happen`'s
// `request-cache` convention):
//   make-fetch-happen:request-cache:https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz
//   make-fetch-happen:request-cache:https://registry.npmjs.org/@types%2fnode/-/node-20.0.0.tgz
// The tarball URL's `/<name>/-/<name>-<version>.tgz` suffix exposes
// name + version unambiguously. Scoped packages keep the `@scope/`
// segment as `@scope%2f` or `@scope/` depending on the registry
// response; we accept both.
//
// We index ALL bucket files on first call and reuse the cache across
// `packument()` / `tarball()` lookups since cacache offers no
// name-keyed lookup — the layout is fully content-addressable over the
// request URL, which forces a full scan to enumerate versions of a
// given package.

import { readFile, readdir } from 'node:fs/promises'
import { parseSri, isEmptyIntegrity } from '../recipe/integrity.ts'
import path from 'node:path'
import type { CacheAdapter, Packument, PackumentVersion } from './types.ts'

export interface NpmCacheOptions {
  /**
   * cacache root directory (the `_cacache` folder itself, NOT npm's
   * parent cache dir). If absent, probe in order:
   *   1. process.env.NPM_CONFIG_CACHE → `<env>/_cacache`
   *      (npm's `cache` config points to the parent that owns `_cacache`)
   *   2. ~/.npm/_cacache
   */
  cacheDir?: string
}

interface IndexedEntry {
  readonly name:      string
  readonly version:   string
  readonly integrity: string | undefined
}

type CacheIndex = Map<string, Map<string, IndexedEntry>>

// `https://<host>/<encoded-name>/-/<file-name>-<version>.tgz`
// scoped:   /@types%2fnode/-/node-20.0.0.tgz   OR   /@types/node/-/node-20.0.0.tgz
// unscoped: /lodash/-/lodash-4.17.21.tgz
const KEY_URL_RE =
  /\/(?<encoded>(?:@[^/]+(?:%2[fF]|\/))?[^/]+)\/-\/(?<filename>[^/]+)\.tgz(?:\?|$)/

// === API ====================================================================

export function npmCache(opts: NpmCacheOptions = {}): CacheAdapter {
  const cacheDir = resolveCacheDir(opts)

  let indexPromise: Promise<CacheIndex> | undefined
  const getIndex = (): Promise<CacheIndex> => {
    if (indexPromise === undefined) indexPromise = buildIndex(cacheDir)
    return indexPromise
  }

  return {
    async packument(name) {
      const index = await getIndex()
      const byVersion = index.get(name)
      if (byVersion === undefined || byVersion.size === 0) return undefined

      const versions: Record<string, PackumentVersion> = {}
      for (const [version, entry] of byVersion) {
        const out: PackumentVersion = {
          name:    entry.name,
          version: entry.version,
        }
        if (entry.integrity !== undefined) {
          const integrity = parseSri(entry.integrity, 'registry')
          if (!isEmptyIntegrity(integrity)) out.integrity = integrity
        }
        versions[version] = out
      }
      if (Object.keys(versions).length === 0) return undefined

      const packument: Packument = {
        name,
        distTags: {},
        versions,
      }
      return packument
    },

    async tarball(name, version) {
      const index = await getIndex()
      const entry = index.get(name)?.get(version)
      if (entry === undefined || entry.integrity === undefined) return undefined

      const contentPath = contentPathForIntegrity(cacheDir, entry.integrity)
      if (contentPath === undefined) return undefined

      try {
        const bytes = await readFile(contentPath)
        return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      } catch {
        return undefined
      }
    },
  }
}

// === INTERNALS ==============================================================

function resolveCacheDir(opts: NpmCacheOptions): string {
  if (opts.cacheDir !== undefined) return opts.cacheDir

  const envDir = process.env.NPM_CONFIG_CACHE
  if (envDir !== undefined && envDir.length > 0) {
    // `$NPM_CONFIG_CACHE` is the npm cache root (parent of `_cacache`),
    // matching npm config-key semantics.
    return path.join(envDir, '_cacache')
  }

  return path.join(userHome(), '.npm', '_cacache')
}

function userHome(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? '.'
}

interface BuildSlot {
  entry: IndexedEntry
  time:  number
}

async function buildIndex(cacheDir: string): Promise<CacheIndex> {
  const accum: Map<string, Map<string, BuildSlot>> = new Map()
  const bucketRoot = path.join(cacheDir, 'index-v5')

  // index-v5 / <2-hex> / <2-hex> / <rest-hex>
  let topDirs: string[]
  try {
    topDirs = await readdir(bucketRoot)
  } catch {
    return new Map()
  }

  for (const top of topDirs) {
    if (!isHexPair(top)) continue
    const topPath = path.join(bucketRoot, top)
    let midDirs: string[]
    try {
      midDirs = await readdir(topPath)
    } catch {
      continue
    }
    for (const mid of midDirs) {
      if (!isHexPair(mid)) continue
      const midPath = path.join(topPath, mid)
      let bucketFiles: string[]
      try {
        bucketFiles = await readdir(midPath)
      } catch {
        continue
      }
      for (const bucket of bucketFiles) {
        const bucketPath = path.join(midPath, bucket)
        await ingestBucket(bucketPath, accum)
      }
    }
  }

  const result: CacheIndex = new Map()
  for (const [name, byVersion] of accum) {
    const out: Map<string, IndexedEntry> = new Map()
    for (const [version, slot] of byVersion) {
      out.set(version, slot.entry)
    }
    result.set(name, out)
  }
  return result
}

async function ingestBucket(
  bucketPath: string,
  accum: Map<string, Map<string, BuildSlot>>,
): Promise<void> {
  let contents: string
  try {
    contents = await readFile(bucketPath, 'utf8')
  } catch {
    return
  }

  // Per cacache's `entry-index.js#insert`: each record is appended as
  // `\n<sha1>\t<json>` so a populated bucket starts with a leading
  // newline. Blank leading/trailing splits are ignored.
  for (const line of contents.split('\n')) {
    if (line.length === 0) continue
    const tabIdx = line.indexOf('\t')
    if (tabIdx === -1) continue

    const json = line.slice(tabIdx + 1)
    let record: any
    try {
      record = JSON.parse(json)
    } catch {
      continue
    }
    if (record === null || typeof record !== 'object') continue

    const key = typeof record.key === 'string' ? record.key : undefined
    if (key === undefined) continue

    const parsed = parseKey(key)
    if (parsed === undefined) continue

    const integrity = typeof record.integrity === 'string' ? record.integrity : undefined
    const time      = typeof record.time === 'number'      ? record.time      : 0

    let byVersion = accum.get(parsed.name)
    if (byVersion === undefined) {
      byVersion = new Map()
      accum.set(parsed.name, byVersion)
    }
    const prior = byVersion.get(parsed.version)
    if (prior !== undefined && prior.time >= time) continue

    byVersion.set(parsed.version, {
      entry: {
        name:      parsed.name,
        version:   parsed.version,
        integrity,
      },
      time,
    })
  }
}

interface KeyParse {
  readonly name:    string
  readonly version: string
}

function parseKey(key: string): KeyParse | undefined {
  // We accept any cacache key shape that embeds a tarball URL. The
  // canonical npm prefix is `make-fetch-happen:request-cache:` but
  // mirrors / future revisions may differ — we anchor on the URL
  // structure inside the key.
  const m = KEY_URL_RE.exec(key)
  if (m?.groups === undefined) return undefined

  const encoded  = m.groups.encoded
  const filename = m.groups.filename
  if (encoded === undefined || filename === undefined) return undefined

  const name = decodeName(encoded)
  if (name === undefined) return undefined

  // The trailing path segment before `.tgz` is `<lastNameComponent>-<version>`.
  // Scoped: `node-20.0.0` (after `@types/node/-/`). Unscoped: `lodash-4.17.21`.
  const lastComponent = name.includes('/') ? name.slice(name.indexOf('/') + 1) : name
  const prefix = `${lastComponent}-`
  if (!filename.startsWith(prefix)) return undefined
  const version = filename.slice(prefix.length)
  if (version.length === 0) return undefined

  return { name, version }
}

function decodeName(encoded: string): string | undefined {
  // Scoped packages may arrive as `@types%2Fnode` (npm-cli percent-encoded
  // form) or `@types/node` (some mirrors). Both decode to `@types/node`.
  try {
    return decodeURIComponent(encoded)
  } catch {
    return undefined
  }
}

function contentPathForIntegrity(cacheDir: string, integrity: string): string | undefined {
  // SRI form: `<algo>-<base64>`. cacache stores files under
  // `content-v2/<algo>/<2>/<2>/<rest-of-hex>` where `<rest-of-hex>` is
  // the HEX of the decoded digest. We pick the strongest algorithm
  // listed (npm publishes sha512; some legacy entries still ship sha1).
  const chosen = pickStrongestSri(integrity)
  if (chosen === undefined) return undefined

  const algo = chosen.algo
  const hex  = chosen.hex
  if (hex.length < 4) return undefined

  return path.join(cacheDir, 'content-v2', algo, hex.slice(0, 2), hex.slice(2, 4), hex.slice(4))
}

interface SriPick {
  readonly algo: string
  readonly hex:  string
}

function pickStrongestSri(integrity: string): SriPick | undefined {
  // Multiple SRIs may be space-separated. Strongest wins: sha512 > sha384
  // > sha256 > sha1. (npm's `ssri` ranks identically.)
  const rank: Record<string, number> = { sha512: 4, sha384: 3, sha256: 2, sha1: 1 }
  let best: SriPick | undefined
  let bestRank = 0
  for (const piece of integrity.split(/\s+/)) {
    if (piece.length === 0) continue
    const dash = piece.indexOf('-')
    if (dash === -1) continue
    const algo = piece.slice(0, dash)
    const b64  = piece.slice(dash + 1)
    const r = rank[algo]
    if (r === undefined || r <= bestRank) continue
    let bytes: Buffer
    try {
      bytes = Buffer.from(b64, 'base64')
    } catch {
      continue
    }
    if (bytes.length === 0) continue
    best = { algo, hex: bytes.toString('hex') }
    bestRank = r
  }
  return best
}

function isHexPair(s: string): boolean {
  return s.length === 2 && /^[0-9a-f]{2}$/.test(s)
}
