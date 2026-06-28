// OPTIONAL byte-exact recompute backend for the yarn-berry `checksum` cacheKeys
// the pinned `pako` path can't reproduce (mixed cacheKey 9/10, explicit `cN`).
//
// It drives `@yarnpkg/libzip`'s `ZipFS` — yarn's OWN packer — so it reproduces,
// CORRECT-BY-CONSTRUCTION, whatever cache generation the INSTALLED
// `@yarnpkg/libzip` matches (proven byte-exact over real caches: libzip 3.x →
// yarn-4 cacheKey 10). It is a soft `import()`: absent → `undefined`, and the
// caller defers exactly as it would without this module — so the lib's core
// keeps ZERO mandatory `@yarnpkg` dependency.
//
// CRITICAL: the installed libzip matches only ITS OWN generation (libzip 3.x
// does NOT reproduce cacheKey 9). The caller (`refurbish`) MUST CALIBRATE —
// reproduce one EXISTING lock checksum with this backend and compare — before
// trusting any fill; otherwise a cacheKey-9 lock refurbished against a
// cacheKey-10 libzip would get wrong digests (and a wrong digest hard-fails
// `yarn install --immutable`, strictly worse than a missing one).
//
// Orchestration mirrors yarn's `tgzUtils.extractArchiveTo`: stripComponents:1,
// re-root under `node_modules/<ident>`, fixed SAFE_TIME mtime, mkdirp parents at
// mode 0o755, file mode from the tar header.

import { gunzipSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import { parseTar } from './berry-checksum.ts'

const SAFE_TIME = 456789000 // @yarnpkg/fslib SAFE_TIME (1984-06-22T21:50:00Z)

// The minimal `ZipFS` surface this module drives. The real type brands paths as
// `PortablePath`; the structural cast at the import lets us pass plain strings.
interface ZipFsLike {
  mkdirpSync(p: string, opts: { chmod: number; utimes: [number, number] }): void
  writeFileSync(p: string, data: Buffer, opts: { mode: number }): void
  utimesSync(p: string, atime: number, mtime: number): void
  getBufferAndClose(): Uint8Array
}
type LibzipModule = { ZipFS: new (src: null, opts: { level: number | 'mixed' }) => ZipFsLike }

/** The ZipFS compression level for a cacheKey: `mixed` (no `cN`) → `'mixed'`,
 *  `cN` → `N`; `null` for a malformed cacheKey. */
function levelOf(cacheKey: string): number | 'mixed' | null {
  const m = /^(\d+)(?:c(\d))?$/.exec(cacheKey)
  if (m === null) return null
  return m[2] === undefined ? 'mixed' : Number(m[2])
}

/**
 * Reproduce yarn-berry's `checksum` digest via `@yarnpkg/libzip`, for any
 * cacheKey the installed libzip's generation matches. Returns `undefined` when
 * `@yarnpkg/libzip` is not installed, the cacheKey is malformed, or packing
 * throws — the caller then defers (and MUST calibrate before trusting a match).
 * `ident` is `name` or `@scope/name`.
 */
export async function computeBerryChecksumViaLibzip(
  tgz: Uint8Array,
  ident: string,
  cacheKey: string,
): Promise<string | undefined> {
  const level = levelOf(cacheKey)
  if (level === null) return undefined

  let ZipFS: LibzipModule['ZipFS']
  try {
    ;({ ZipFS } = (await import('@yarnpkg/libzip')) as unknown as LibzipModule)
  } catch {
    return undefined // not installed → caller defers
  }

  try {
    const tar = gunzipSync(Buffer.from(tgz))
    const zipFs = new ZipFS(null, { level })
    const prefix = `/node_modules/${ident}`
    for (const f of parseTar(tar)) {
      const rel = f.name.split('/').slice(1).join('/') // stripComponents:1
      if (rel === '') continue
      const full = `${prefix}/${rel}`
      zipFs.mkdirpSync(full.slice(0, full.lastIndexOf('/')), { chmod: 0o755, utimes: [SAFE_TIME, SAFE_TIME] })
      zipFs.writeFileSync(full, f.data, { mode: f.mode })
      zipFs.utimesSync(full, SAFE_TIME, SAFE_TIME)
    }
    return createHash('sha512').update(Buffer.from(zipFs.getBufferAndClose())).digest('hex')
  } catch {
    return undefined // pack failed → caller defers
  }
}
