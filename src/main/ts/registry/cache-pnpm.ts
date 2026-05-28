// pnpm store CacheAdapter — Phase D-B3.
//
// Reads the on-disk content-addressable store that recent pnpm (≤ v9)
// populates under `~/.pnpm-store/v3/` (override via `$PNPM_STORE_DIR`).
// The layout (verified against pnpm v8.6.0 `store/cafs/src/getFilePathInCafs.ts`):
//
//   <storeDir>/files/<2-hex>/<rest-of-hex>             — non-executable file content (raw bytes)
//   <storeDir>/files/<2-hex>/<rest-of-hex>-exec        — executable file content
//   <storeDir>/files/<2-hex>/<rest-of-hex>-index.json  — PER-PACKAGE INDEX JSON (this is what we parse)
//
// The `<hex>` for `-index.json` is the sha512 hex digest of the package
// tarball's integrity. The JSON shape is `PackageFilesIndex` per
// `store/cafs/src/checkPkgFilesIntegrity.ts`:
//   {
//     manifest?: BundledManifest,  // { name, version, bin, engines, … }
//     algo:      'sha512',
//     files:     [ [relativePath, { mode, size, digest, … }], … ],
//     sideEffects?: …,
//   }
// We aggregate by `manifest.name` (when present) into Packument shapes;
// the bundled manifest carries everything we need for `packument()` —
// name, version, and dist-tag-irrelevant version-level metadata.
//
// `tarball(name, version)` returns `undefined` BY DESIGN. pnpm
// decomposes tarballs into per-file content-addressable blobs at
// install time and discards the original archive. Re-tarring on demand
// would require reading every file referenced by the index, applying
// the mode, и rebuilding gzip bytes — out of scope for v1, and the
// caller cannot trust the bytes against the original tarball integrity
// since gzip is not deterministic across implementations.
//
// SQLite migration. pnpm CHANGELOG v1001.0.0 (post-pnpm-10) migrates
// the index from `.mpk` (MessagePack) files to a single `index.db`
// SQLite. We intentionally target the JSON-`-index.json` layout that
// every released pnpm v7/v8/v9 ships; SQLite + `.mpk` are tracked
// follow-ups when those release lines harden.

import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import type { CacheAdapter, Packument, PackumentVersion } from './types.ts'

export interface PnpmCacheOptions {
  /**
   * pnpm store root directory (the `v3` folder itself). If absent, probe in order:
   *   1. process.env.PNPM_STORE_DIR
   *   2. ~/.pnpm-store/v3
   *   3. ~/.local/share/pnpm/store/v3   (linux XDG path some installers use)
   */
  storeDir?: string
}

interface IndexedEntry {
  readonly name:    string
  readonly version: string
  readonly meta:    BundledManifest
}

interface BundledManifest {
  readonly name?:                 unknown
  readonly version?:              unknown
  readonly dependencies?:         unknown
  readonly devDependencies?:      unknown
  readonly optionalDependencies?: unknown
  readonly peerDependencies?:     unknown
  readonly peerDependenciesMeta?: unknown
  readonly engines?:              unknown
  readonly os?:                   unknown
  readonly cpu?:                  unknown
  readonly libc?:                 unknown
  readonly deprecated?:           unknown
  readonly bin?:                  unknown
  readonly bundleDependencies?:   unknown
  readonly bundledDependencies?:  unknown
}

type CacheIndex = Map<string, Map<string, IndexedEntry>>

export function pnpmCache(opts: PnpmCacheOptions = {}): CacheAdapter {
  const storeDir = resolveStoreDir(opts)

  let indexPromise: Promise<CacheIndex> | undefined
  const getIndex = (): Promise<CacheIndex> => {
    if (indexPromise === undefined) indexPromise = buildIndex(storeDir)
    return indexPromise
  }

  return {
    async packument(name) {
      const index = await getIndex()
      const byVersion = index.get(name)
      if (byVersion === undefined || byVersion.size === 0) return undefined

      const versions: Record<string, PackumentVersion> = {}
      for (const [version, entry] of byVersion) {
        versions[version] = materialise(entry)
      }
      if (Object.keys(versions).length === 0) return undefined

      const packument: Packument = {
        name,
        distTags: {},
        versions,
      }
      return packument
    },

    // Architectural miss: pnpm does not retain original tarballs — the
    // content-addressable store holds per-file decomposed blobs only.
    // Returning undefined is correct, not a defect.
    async tarball() {
      return undefined
    },
  }
}

function resolveStoreDir(opts: PnpmCacheOptions): string {
  if (opts.storeDir !== undefined) return opts.storeDir

  const envDir = process.env.PNPM_STORE_DIR
  if (envDir !== undefined && envDir.length > 0) return envDir

  return path.join(userHome(), '.pnpm-store', 'v3')
}

function userHome(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? '.'
}

async function buildIndex(storeDir: string): Promise<CacheIndex> {
  const accum: CacheIndex = new Map()
  const filesRoot = path.join(storeDir, 'files')

  let topDirs: string[]
  try {
    topDirs = await readdir(filesRoot)
  } catch {
    // Older pnpm stores or alt-rooted installations may put the
    // `<2-hex>` buckets directly under the store dir. Fall back so
    // callers passing `storeDir: <files/>` still work.
    try {
      topDirs = await readdir(storeDir)
    } catch {
      return accum
    }
    return ingestBuckets(storeDir, topDirs, accum)
  }

  return ingestBuckets(filesRoot, topDirs, accum)
}

async function ingestBuckets(
  root: string,
  topDirs: string[],
  accum: CacheIndex,
): Promise<CacheIndex> {
  for (const top of topDirs) {
    if (!isHexPair(top)) continue
    const topPath = path.join(root, top)
    let entries: string[]
    try {
      entries = await readdir(topPath)
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.endsWith('-index.json')) continue
      await ingestIndexFile(path.join(topPath, entry), accum)
    }
  }
  return accum
}

async function ingestIndexFile(indexPath: string, accum: CacheIndex): Promise<void> {
  let raw: string
  try {
    raw = await readFile(indexPath, 'utf8')
  } catch {
    return
  }

  let parsed: any
  try {
    parsed = JSON.parse(raw)
  } catch {
    return
  }
  if (parsed === null || typeof parsed !== 'object') return

  const manifest = parsed.manifest
  if (manifest === null || typeof manifest !== 'object') return

  const name    = typeof manifest.name    === 'string' ? manifest.name    : undefined
  const version = typeof manifest.version === 'string' ? manifest.version : undefined
  if (name === undefined || version === undefined) return

  let byVersion = accum.get(name)
  if (byVersion === undefined) {
    byVersion = new Map()
    accum.set(name, byVersion)
  }
  // First wins for now — index files for the same (name, version)
  // shouldn't realistically clash within one store, but if they do
  // every record describes the same package contents.
  if (byVersion.has(version)) return

  byVersion.set(version, {
    name,
    version,
    meta: manifest as BundledManifest,
  })
}

function materialise(entry: IndexedEntry): PackumentVersion {
  const meta = entry.meta
  const out: PackumentVersion = {
    name:    entry.name,
    version: entry.version,
  }
  if (isStringMap(meta.dependencies))         out.dependencies         = clone(meta.dependencies)
  if (isStringMap(meta.devDependencies))      out.devDependencies      = clone(meta.devDependencies)
  if (isStringMap(meta.optionalDependencies)) out.optionalDependencies = clone(meta.optionalDependencies)
  if (isStringMap(meta.peerDependencies))     out.peerDependencies     = clone(meta.peerDependencies)
  if (isObject(meta.peerDependenciesMeta))    out.peerDependenciesMeta = clone(meta.peerDependenciesMeta as Record<string, { optional?: boolean }>)
  if (isStringMap(meta.engines))              out.engines              = clone(meta.engines)
  if (Array.isArray(meta.os))                 out.os                   = filterStrings(meta.os)
  if (Array.isArray(meta.cpu))                out.cpu                  = filterStrings(meta.cpu)
  if (Array.isArray(meta.libc))               out.libc                 = filterStrings(meta.libc)
  if (typeof meta.deprecated === 'string')    out.deprecated           = meta.deprecated
  if (typeof meta.bin === 'string' || isStringMap(meta.bin)) {
    out.bin = typeof meta.bin === 'string' ? meta.bin : clone(meta.bin as Record<string, string>)
  }
  const bundled = Array.isArray(meta.bundledDependencies)
    ? meta.bundledDependencies
    : Array.isArray(meta.bundleDependencies)
      ? meta.bundleDependencies
      : undefined
  if (bundled !== undefined) out.bundledDependencies = filterStrings(bundled)
  return out
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringMap(value: unknown): value is Record<string, string> {
  if (!isObject(value)) return false
  for (const v of Object.values(value)) {
    if (typeof v !== 'string') return false
  }
  return true
}

function clone<T extends object>(value: T): T {
  return { ...value }
}

function filterStrings(value: unknown[]): string[] {
  return value.filter((v): v is string => typeof v === 'string')
}

function isHexPair(s: string): boolean {
  return s.length === 2 && /^[0-9a-f]{2}$/.test(s)
}
