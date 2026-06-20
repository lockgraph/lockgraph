// yarn-berry `.yarn/cache/` CacheAdapter — Phase D-B (v1).
//
// Reads a yarn-berry `.yarn/cache/` folder and synthesises thin
// `Packument`s purely from the on-disk zip filenames. No zip unpacking,
// no `package.json` peek — those upgrades are deferred to a follow-up.
// The v1 cache-hit predicate is "I see a zip matching this (name,
// version)"; the synthesised `PackumentVersion` carries only what the
// filename exposes (name + version). `integrity` / `tarball` cannot be
// reconstructed from a 10-hex slice + cacheKey suffix, so they stay
// undefined.
//
// npm + pnpm cache layouts (cacache CAS / pnpm content-addressable
// store) intentionally fall outside v1 — those land in D-B2 / D-B3.
//
// Yarn-berry cache filename research note. The two formats produced by
// `Cache.getLocatorPath`:
//   A. version-based (default, no project-local mirror):
//        <slug>-<cacheKey>.zip
//        e.g. lodash-npm-4.17.21-c8c0e3a1bc-10c0.zip
//   B. checksum-based (mirror present + checksum known):
//        <slug>-<contentChecksum-slice10>.zip
//        e.g. lodash-npm-4.17.21-abcdef1234.zip
// where `<slug>` is `<slugifyIdent>-<protocol>-<version>-<locatorHash-slice10>`
// and `<slugifyIdent>` turns `@types/node` into `@types-node`. Both
// shapes share the `-npm-<version>-<10hex>` middle, so we anchor on
// that and treat the trailing `-<cacheKey>` as optional. We accept
// both filename shapes — v1 does not need to disambiguate them.

import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import type { CacheAdapter, Packument, PackumentVersion } from './types.ts'

export interface YarnBerryCacheOptions {
  /**
   * Cache folder. If absent, probe in order:
   *   1. process.env.YARN_CACHE_FOLDER
   *   2. <workspaceRoot>/.yarn/cache
   *   3. ~/.yarn/berry/cache
   */
  cacheFolder?:   string
  workspaceRoot?: string
  /**
   * Restrict to a specific PM cache family. Default: `yarn-berry`.
   * v1 ships only `yarn-berry`; npm (cacache CAS) and pnpm
   * (content-addressable store) cache adapters are tracked under
   * D-B2 / D-B3 follow-ups since their on-disk layouts diverge
   * enough to warrant separate adapter modules.
   */
  family?:        'yarn-berry'
}

// `<slug>-npm-<version>-<10hex>[-<cacheKey>].zip` — anchor on the
// trailing `<10hex>[-<cacheKey>].zip` segment and back-extract the
// version. Pre-release versions (1.0.0-beta.1) are supported because
// the trailing 10-hex slice is unambiguous (lowercase hex, length 10).
const CACHE_ENTRY_RE =
  /^(?<rest>.+)-(?<hash>[a-f0-9]{10})(?:-(?<cacheKey>[a-z0-9]+))?\.zip$/

export function yarnBerryCache(opts: YarnBerryCacheOptions = {}): CacheAdapter {
  const cacheFolder = resolveCacheFolder(opts)

  return {
    async packument(name) {
      const entries = await scanCacheFolder(cacheFolder, name)
      if (entries.length === 0) return undefined

      const versions: Record<string, PackumentVersion> = {}
      for (const entry of entries) {
        // First match wins per version — duplicates are not expected but
        // would otherwise overwrite, so we keep the first observed entry
        // (filesystem-order from readdir).
        if (versions[entry.version] !== undefined) continue
        versions[entry.version] = {
          name:    entry.name,
          version: entry.version,
        }
      }

      const versionList = Object.keys(versions)
      if (versionList.length === 0) return undefined

      // No reliable dist-tag derivable from on-disk cache — yarn does not
      // record `latest` per version on disk. Leave distTags empty rather
      // than fake a `latest` from version order.
      const packument: Packument = {
        name,
        distTags: {},
        versions,
      }
      return packument
    },

    async tarball(name, version) {
      const entries = await scanCacheFolder(cacheFolder, name)
      const hit = entries.find(e => e.version === version)
      if (hit === undefined) return undefined
      try {
        const bytes = await readFile(path.join(cacheFolder, hit.filename))
        return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      } catch {
        return undefined
      }
    },
  }
}

interface CacheEntry {
  readonly filename: string
  readonly name:     string
  readonly version:  string
}

function resolveCacheFolder(opts: YarnBerryCacheOptions): string {
  if (opts.cacheFolder !== undefined) return opts.cacheFolder

  const envFolder = process.env.YARN_CACHE_FOLDER
  if (envFolder !== undefined && envFolder.length > 0) return envFolder

  if (opts.workspaceRoot !== undefined) {
    return path.join(opts.workspaceRoot, '.yarn', 'cache')
  }

  const home = userHome()
  return path.join(home, '.yarn', 'berry', 'cache')
}

function userHome(): string {
  // Mirror node:os.homedir() without bringing in the import for the one
  // call site. POSIX uses $HOME, Windows uses $USERPROFILE.
  return process.env.HOME ?? process.env.USERPROFILE ?? '.'
}

async function scanCacheFolder(folder: string, name: string): Promise<CacheEntry[]> {
  let files: string[]
  try {
    files = await readdir(folder)
  } catch {
    // Missing folder = empty cache. Permission errors fall through here
    // too — by design we treat the cache as opaque and miss silently.
    return []
  }

  const slugPrefix = `${slugifyIdent(name)}-npm-`
  const matches: CacheEntry[] = []
  for (const filename of files) {
    if (!filename.startsWith(slugPrefix) || !filename.endsWith('.zip')) continue

    const middle = filename.slice(slugPrefix.length) // <version>-<10hex>[-<cacheKey>].zip
    const m = CACHE_ENTRY_RE.exec(middle)
    if (m?.groups === undefined) continue

    const version = m.groups.rest
    if (version === undefined || version.length === 0) continue

    matches.push({ filename, name, version })
  }
  return matches
}

function slugifyIdent(name: string): string {
  // Yarn-berry's `structUtils.slugifyIdent`: scoped packages become
  // `@<scope>-<name>`; unscoped stay as `<name>`. Matches the cache
  // filename construction at <https://github.com/yarnpkg/berry/blob/master/packages/yarnpkg-core/sources/structUtils.ts>.
  if (!name.startsWith('@')) return name
  const slash = name.indexOf('/')
  if (slash === -1) return name
  return `${name.slice(0, slash)}-${name.slice(slash + 1)}`
}
