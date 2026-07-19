// ADR-0035 — Yarn-berry `checksum` computation (zero-dependency recompute).
//
// Reproduces yarn's lockfile `checksum` digest = `sha512(cache.zip)` from the
// npm tarball, with NO `@yarnpkg/*` runtime dependency — only Node built-ins
// (`node:zlib`, `node:crypto`). The caller prefixes the `<cacheKey>/`.
//
// A yarn cache `.zip` is yarn's re-pack of the tarball; reproducing it
// byte-for-byte (so the SHA-512 matches) is deterministic for two of yarn's
// `compressionLevel` modes:
//   • `0` = STORE (Yarn-4 default, cacheKey `…c0`) — no deflate stream.
//   • `mixed` (cacheKey with NO `cN` suffix) — each file is DEFLATE'd iff that
//     shrinks it, else STORE'd. The DEFLATE stream is reproduced byte-exact by
//     `pako` (pure-JS, portable — NOT `node:zlib`, whose bundled zlib varies
//     across our Node 14–24 floor) at `{ level: 9, strategy: 0, memLevel: 9 }`
//     (raw deflate) for cacheKey VERSIONS 7, 8 AND 9 — the ONLY variable across
//     these three generations is pako's match-finding hash (spec/formats/_common.md
//     §1.7 checksum matrix):
//       – cacheKey 7/8 (yarn 2.4 / 3.1–3.8): pako's LEGACY hash (`legacyHash:true`),
//         proven over real cache archives (ADR-0035 §7).
//       – cacheKey 9  (yarn 4.0.0-rc.27…4.0.0 — the Yarn-4 RC window, lockfile v7):
//         pako's "nodejs-compatible" hash (`legacyHash:false`) — verified byte-exact
//         over the real v7 cache archive.
//     cacheKey 10 (yarn-4 stable `mixed`) is built by yarn's zlib-ng, whose DEFLATE pako
//     matches at NEITHER hash — so v10-`mixed` throws and the caller soft-falls-back
//     to the OPTIONAL `@yarnpkg/libzip` backend (when installed — yarn's OWN packer,
//     which reproduces its generation), then its `berryChecksum` oracle (yarn's own
//     `.yarn/cache`), else defers (a wrong checksum hard-fails `--immutable`,
//     strictly worse than a missing one). An explicit `cN` (N>=1) level likewise throws.
//
// Entry ORDER also varies across yarn builds (NOT encoded in the cacheKey): some
// emit each directory lazily before its first file (tar order), others emit ALL
// directories first then all files. `dirsFirst` selects it; the caller (refurbish)
// CALIBRATES which one a lock used against a discriminating sibling checksum.
//
// The container is emitted with libzip's exact conventions, proven byte-
// identical to yarn's own output (ADR-0035 §1.3): entries under
// `node_modules/<ident>/`, fixed SAFE_TIME mtime, mode `0644` (files) / `0755`
// (dirs & exec), version-made-by `0x033F`; per-entry version-needed + gp-flag +
// method follow STORE (`10`/`0`/`0`) or DEFLATE (`20`/`2`/`8`); no extra field,
// no comment; entry order per `dirsFirst` (lazy tar order, or all-dirs-then-files).

import zlib, { gunzipSync } from 'node:zlib'
import { createHash } from 'node:crypto'
// pako's DEFLATE match-finding hash decides the exact compressed bytes, and it is
// what distinguishes yarn's cache-zip generations: pako 2.2.0 added a faster
// "nodejs-compatible" hash (opt-in; `legacyHash` default `true`); pako 3.0.0
// flipped that default to `false`. yarn 2.4–3.8 (cacheKey 7/8) emit bytes matching
// pako's LEGACY hash; the Yarn-4 RC window (cacheKey 9, lockfile v7) matches the
// "nodejs-compatible" hash.
// So `legacyHash` MUST be selected PER cacheKey VERSION (7/8 → true, 9 → false;
// `berryLegacyHash`) and passed EXPLICITLY at the deflateRaw call — the flag is
// pako-version-INDEPENDENT (verified byte-identical on pako 2.x AND 3.x), so it is
// exactly what keeps us yarn-stable regardless of which pako we ship. Do not drop
// or hard-code it (a wrong hash → wrong bytes → wrong checksum → YN0018).
import { deflateRaw } from 'pako'

// pako 2.2.0's bundled .d.ts omits `legacyHash` (a real runtime option it added);
// declare it in so the explicit flag below type-checks.
type DeflateOpts = NonNullable<Parameters<typeof deflateRaw>[1]> & { legacyHash: boolean }

// MS-DOS mtime fields folded into every entry. The fixed constant changed
// across cache eras: cacheKey 8+ uses @yarnpkg/fslib SAFE_TIME = 456789000
// (1984-06-22T21:50:00Z); cacheKey 7 (yarn 2.x) left the mtime unset, which
// libzip wrote as the DOS epoch (1980-01-01T00:00:00, time field 0).
const SAFE_DOS_TIME  = 0xae40
const SAFE_DOS_DATE  = 0x08d6
const EPOCH_DOS_TIME = 0x0000
const EPOCH_DOS_DATE = 0x0021
const MADE_BY  = 0x033f                      // Unix (3) << 8 | ZIP spec 6.3 (0x3F)
const EMPTY    = Buffer.alloc(0)

// ── CRC-32 (IEEE). Native `zlib.crc32` (Node >=22) when present, else the table
// fallback below — our floor is Node 14.18, and CI on Node 20 exercises the
// fallback. Both yield identical IEEE CRC-32 (locked by a test).
const CRC_TABLE = ((): Uint32Array => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

/** Table-based IEEE CRC-32. Exported only so a test can lock it against the
 *  native `zlib.crc32` where that exists. */
export function crc32Table(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = (CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8)) >>> 0
  return (c ^ 0xffffffff) >>> 0
}

const nativeCrc32 = (zlib as { crc32?: (data: Uint8Array, value?: number) => number }).crc32
const crc32: (buf: Buffer) => number =
  typeof nativeCrc32 === 'function' ? (buf) => nativeCrc32(buf) >>> 0 : crc32Table

export interface TarFile { name: string; mode: number; data: Buffer }

const tarField = (b: Buffer, off: number, len: number): string => {
  const slice = b.subarray(off, off + len)
  const nul = slice.indexOf(0)
  return slice.toString('latin1', 0, nul === -1 ? len : nul)
}

// Minimal ustar reader: regular files (`typeflag` '0'/''), honouring the `prefix`
// long-path field. Directory ('5') and PAX/global ('x'/'g') entries are skipped —
// dirs are synthesised by mkdirp (§zip below) and PAX metadata is carried by the
// ustar fields for these tarballs. Any OTHER type — symlink ('2'), hardlink ('1'),
// device, GNU-long-name — carries content/naming yarn PUTS IN the cache zip that we
// do NOT reproduce; SILENTLY skipping it would mis-hash (a wrong checksum hard-fails
// `--immutable`, worse than a miss), so we THROW and the packer DEFERS. Exported so
// a test can exercise the unsupported-entry guard directly.
export function parseTar(tar: Buffer): TarFile[] {
  const out: TarFile[] = []
  for (let o = 0; o + 512 <= tar.length; ) {
    const header = tar.subarray(o, o + 512)
    let allZero = true
    for (let i = 0; i < 512; i++) if (header[i] !== 0) { allZero = false; break }
    if (allZero) break                       // two zero blocks terminate the archive
    const prefix = tarField(header, 345, 155)
    const rawName = tarField(header, 0, 100)
    const name = prefix !== '' ? `${prefix}/${rawName}` : rawName
    const size = parseInt(tarField(header, 124, 12).trim() || '0', 8) || 0
    const mode = parseInt(tarField(header, 100, 8).trim() || '0', 8) || 0
    const type = String.fromCharCode(header[156] ?? 0)
    o += 512
    if (type === '0' || type === '\0' || type === '') {
      out.push({ name, mode, data: tar.subarray(o, o + size) })
    } else if (type !== '5' && type !== 'x' && type !== 'g') {
      // symlink / hardlink / device / GNU-long — not reproduced; defer, never mis-hash.
      throw new Error(`berry-checksum: unsupported tar entry type '${type}' for '${name}'`)
    }
    o += Math.ceil(size / 512) * 512
  }
  return out
}

interface ZipEntry { name: string; dir: boolean; mode: number; data: Buffer }

interface CdEntry { name: Buffer; crc: number; csize: number; usize: number; vn: number; gp: number; method: number; ext: number; off: number }

// Emit the libzip container. `compress` selects yarn's `compressionLevel`:
// `false` = STORE-only (level `0`), `true` = `mixed` (per file: DEFLATE iff the
// raw-deflate stream is STRICTLY smaller than the input, else STORE). Empty
// files and directories are always STORE. The DEFLATE bytes come from `pako` at
// `{ level: 9, strategy: 0, memLevel: 9 }` — libzip's max-compression params.
// `dosTime`/`dosDate` carry the era's fixed mtime (SAFE_TIME vs DOS epoch);
// `legacyHash` selects pako's match-hash for the era (cacheKey 7/8 → true, 9 → false).
function buildZip(entries: ZipEntry[], compress: boolean, dosTime: number, dosDate: number, legacyHash: boolean): Buffer {
  const parts: Buffer[] = []
  const central: CdEntry[] = []
  let off = 0
  for (const e of entries) {
    const nm = Buffer.from(e.name, 'latin1')
    const raw = e.dir ? EMPTY : e.data
    const crc = e.dir ? 0 : crc32(raw)
    let method = 0                                              // STORE by default
    let gp = 0                                                  // gp-flag 0 (STORE)
    let vn = e.dir ? 20 : 10                                    // version-needed: 2.0 dir / 1.0 file
    let stored = raw
    if (compress && !e.dir && raw.length > 0) {
      const def = Buffer.from(deflateRaw(raw, { level: 9, strategy: 0, memLevel: 9, legacyHash } as DeflateOpts))
      if (def.length < raw.length) { method = 8; gp = 2; vn = 20; stored = def }  // DEFLATE iff it shrinks
    }
    const ext = e.dir ? 0x41ed0000                             // 0o40755 << 16
      : (e.mode & 0o111) !== 0 ? 0x81ed0000                    // 0o100755 << 16 (exec)
      : 0x81a40000                                             // 0o100644 << 16
    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(vn, 4)    // sig, version-needed
    lh.writeUInt16LE(gp, 6); lh.writeUInt16LE(method, 8)        // gp-flag, method
    lh.writeUInt16LE(dosTime, 10); lh.writeUInt16LE(dosDate, 12)
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(stored.length, 18); lh.writeUInt32LE(raw.length, 22)
    lh.writeUInt16LE(nm.length, 26); lh.writeUInt16LE(0, 28)    // name-len, extra-len 0
    parts.push(lh, nm, stored)
    central.push({ name: nm, crc, csize: stored.length, usize: raw.length, vn, gp, method, ext, off })
    off += 30 + nm.length + stored.length
  }
  const cdStart = off
  for (const c of central) {
    const h = Buffer.alloc(46)
    h.writeUInt32LE(0x02014b50, 0); h.writeUInt16LE(MADE_BY, 4); h.writeUInt16LE(c.vn, 6)
    h.writeUInt16LE(c.gp, 8); h.writeUInt16LE(c.method, 10)     // gp-flag, method
    h.writeUInt16LE(dosTime, 12); h.writeUInt16LE(dosDate, 14); h.writeUInt32LE(c.crc, 16)
    h.writeUInt32LE(c.csize, 20); h.writeUInt32LE(c.usize, 24); h.writeUInt16LE(c.name.length, 28)
    h.writeUInt16LE(0, 30); h.writeUInt16LE(0, 32); h.writeUInt16LE(0, 34)  // extra/comment/disk
    h.writeUInt16LE(0, 36); h.writeUInt32LE(c.ext, 38); h.writeUInt32LE(c.off, 42)  // int-attr, ext-attr, local-off
    parts.push(h, c.name)
    off += 46 + c.name.length
  }
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(central.length, 8); eocd.writeUInt16LE(central.length, 10)
  eocd.writeUInt32LE(off - cdStart, 12); eocd.writeUInt32LE(cdStart, 16)
  parts.push(eocd)
  return Buffer.concat(parts)
}

/** The compression level a cacheKey encodes, or -1 for `mixed`/unknown.
 *  `cacheKey = <CACHE_VERSION><spec>` where spec is `c<level>` or '' (mixed). */
export function cacheKeyCompressionLevel(cacheKey: string): number {
  const m = /c(\d)$/.exec(cacheKey)
  return m ? Number(m[1]) : -1
}


/** Strictly parse `<CACHE_VERSION>` (mixed) or `<CACHE_VERSION>c<level>` into
 *  `{ version, level }` (level -1 = mixed), or `null` for a malformed key — so a
 *  garbage `__metadata.cacheKey` REJECTS rather than `parseInt`-coercing into a
 *  wrong-mtime path. */
function parseCacheKey(cacheKey: string): { version: number; level: number } | null {
  const m = /^(\d+)(?:c(\d))?$/.exec(cacheKey)
  return m === null ? null : { version: Number(m[1]), level: m[2] === undefined ? -1 : Number(m[2]) }
}

/** cacheKey VERSIONS whose `mixed` DEFLATE stream `pako` reproduces byte-exact:
 *  7/8 (yarn 2.4 / 3.1–3.8) via the LEGACY match-hash, 9 (yarn 4.0.0-rc window,
 *  lockfile v7) via the "nodejs-compatible" hash (`berryLegacyHash` selects per
 *  version — both pure pako, portable). v10 (yarn-4 stable) vendors a zlib-ng pako
 *  matches at neither hash. */
const PAKO_MIXED_CACHE_VERSIONS: ReadonlySet<number> = new Set([7, 8, 9])

/** pako's match-finding hash for a `mixed` cacheKey VERSION: the LEGACY hash for
 *  yarn 2.4–3.8 (cacheKey 7/8), the "nodejs-compatible" hash for the Yarn-4 RC
 *  (cacheKey 9). Pure-pako + pako-version-independent — NOT `node:zlib`. */
const berryLegacyHash = (version: number): boolean => version <= 8

/** First cacheKey VERSION at which STORE (`cN0`) is real: yarn 3.1 (cacheKey 8)
 *  added a configurable `compressionLevel`; yarn 2.x (cacheKey <= 7) always wrote
 *  `mixed`, never STORE. STORE's container uses the SAFE_TIME mtime, proven only
 *  for this era — so a (non-existent) STORE key below it is refused, not guessed. */
const STORE_MIN_CACHE_VERSION = 8

/** Whether `computeBerryChecksum` can byte-reproduce a digest for `cacheKey`:
 *  STORE (`cN0`) at cacheKey VERSION >= 8, or `mixed` at cacheKey VERSION 7/8/9.
 *  Keyed off the PER-LOCK cacheKey, not the lockfile format version (so a bare-
 *  era v6 lock at cacheKey 8 — yarn 3.8 — is fillable; a cacheKey-10
 *  `mixed`, an explicit `cN`, STORE below v8, or a malformed key defers). */
export function berryCacheKeyReproducible(cacheKey: string): boolean {
  const p = parseCacheKey(cacheKey)
  if (p === null) return false
  if (p.level === 0)  return p.version >= STORE_MIN_CACHE_VERSION      // STORE — SAFE_TIME, proven v8+
  if (p.level === -1) return PAKO_MIXED_CACHE_VERSIONS.has(p.version)  // mixed — pako, v7/v8
  return false                                                        // explicit cN (N>=1)
}

/**
 * Reproduce yarn-berry's `checksum` digest (the 128-hex after `<cacheKey>/`)
 * for `(tarball, ident, cacheKey)`. Reproduces STORE (`cN0`, cacheKey VERSION
 * >= 8) and `mixed` for cacheKey VERSIONS 7/8/9 (pako, portable — per-version
 * match-hash); throws on `mixed` for cacheKey 10 (a zlib pako matches at neither
 * hash), STORE below v8, an explicit DEFLATE level `cN` (N>=1), and a malformed
 * cacheKey — the caller soft-falls-back rather than emit a digest yarn would
 * reject. `ident` is `name`/`@scope/name`. `dirsFirst` picks the container's entry
 * order (default: lazy/tar order; `true`: all directories first, then all files) —
 * the caller calibrates which order a lock used against a discriminating sibling.
 */
export function computeBerryChecksum(tgz: Uint8Array, ident: string, cacheKey: string, dirsFirst = false): string {
  const p = parseCacheKey(cacheKey)
  if (p === null || !berryCacheKeyReproducible(cacheKey))
    throw new Error(`computeBerryChecksum: cacheKey '${cacheKey}' is not byte-reproducible (only STORE 'cN0' v8+, or mixed cacheKey 7/8)`)
  const compress = p.level === -1                             // mixed → DEFLATE-iff-smaller; STORE → none
  const legacyHash = berryLegacyHash(p.version)               // 7/8 → true, 9 → false (STORE ignores it)

  // Only the `mixed` cacheKey-7 era (yarn 2.x) wrote the DOS-epoch mtime; mixed
  // cacheKey 8+ and STORE (v8+) use SAFE_TIME. STORE v<=7 is refused above.
  const dosEpoch = p.level === -1 && p.version <= 7
  const dosTime = dosEpoch ? EPOCH_DOS_TIME : SAFE_DOS_TIME
  const dosDate = dosEpoch ? EPOCH_DOS_DATE : SAFE_DOS_DATE

  const tar = gunzipSync(Buffer.from(tgz))
  const prefix = `node_modules/${ident}/`
  const entries: ZipEntry[] = []
  const seen = new Set<string>()
  const parsed = parseTar(tar)
    .map(f => ({ full: prefix + f.name.split('/').slice(1).join('/'), mode: f.mode, data: f.data }))  // stripComponents:1
    .filter(f => f.full !== prefix)                            // drop the bare 'package/' root
  const mkdirp = (full: string): void => {                     // synthesise parent dirs in first-encounter order
    const segs = full.split('/'); segs.pop()
    let cur = ''
    for (const s of segs) { cur += `${s}/`; if (!seen.has(cur)) { seen.add(cur); entries.push({ name: cur, dir: true, mode: 0o755, data: EMPTY }) } }
  }
  const pushFile = (f: { full: string; mode: number; data: Buffer }): void => { entries.push({ name: f.full, dir: false, mode: f.mode, data: f.data }) }
  if (dirsFirst) {
    for (const f of parsed) mkdirp(f.full)                     // ALL directories first (discovery order)…
    for (const f of parsed) pushFile(f)                        // …then all files
  } else {
    for (const f of parsed) { mkdirp(f.full); pushFile(f) }    // lazy: each file preceded by its new ancestor dirs
  }
  return createHash('sha512').update(buildZip(entries, compress, dosTime, dosDate, legacyHash)).digest('hex')
}
