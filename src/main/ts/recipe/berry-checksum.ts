// ADR-0035 — Yarn-berry `checksum` computation (zero-dependency recompute).
//
// Reproduces yarn's lockfile `checksum` digest = `sha512(cache.zip)` from the
// npm tarball, with NO `@yarnpkg/*` runtime dependency — only Node built-ins
// (`node:zlib`, `node:crypto`). The caller prefixes the `<cacheKey>/`.
//
// A yarn cache `.zip` is yarn's re-pack of the tarball; reproducing it
// byte-for-byte (so the SHA-512 matches) is deterministic because the Yarn-4
// default `compressionLevel` is `0` = STORE — there is NO deflate stream to
// match. This module supports STORE only (cacheKey ending `c0`); DEFLATE
// cacheKeys (`cN`, N>=1) would need byte-exact zlib parity with yarn's vendored
// libzip and throw here (ADR-0035 §6 — the caller soft-falls-back).
//
// The container is emitted with libzip's exact conventions, proven byte-
// identical to yarn's own output (ADR-0035 §1.3): entries under
// `node_modules/<ident>/`, STORE method, fixed SAFE_TIME mtime, mode `0644`
// (files) / `0755` (dirs & exec), version-made-by `0x033F`, version-needed
// `20` (dir) / `10` (file), no extra field, no comment, mkdirp-then-tar-order.

import zlib, { gunzipSync } from 'node:zlib'
import { createHash } from 'node:crypto'

// SAFE_TIME = 456789000 (1984-06-22T21:50:00Z, @yarnpkg/fslib constants) folded
// to the MS-DOS date/time fields every entry carries.
const DOS_TIME = 0xae40
const DOS_DATE = 0x08d6
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

interface TarFile { name: string; mode: number; data: Buffer }

const tarField = (b: Buffer, off: number, len: number): string => {
  const slice = b.subarray(off, off + len)
  const nul = slice.indexOf(0)
  return slice.toString('latin1', 0, nul === -1 ? len : nul)
}

// Minimal ustar reader: regular files only (`typeflag` '0'/''), honouring the
// `prefix` long-path field. Directory and metadata entries are skipped — the
// zip's directory entries are synthesised by mkdirp (§zip below).
function parseTar(tar: Buffer): TarFile[] {
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
    if (type === '0' || type === '\0' || type === '') out.push({ name, mode, data: tar.subarray(o, o + size) })
    o += Math.ceil(size / 512) * 512
  }
  return out
}

interface ZipEntry { name: string; dir: boolean; mode: number; data: Buffer }

function buildStoreZip(entries: ZipEntry[]): Buffer {
  const parts: Buffer[] = []
  const central: Array<{ name: Buffer; crc: number; size: number; vn: number; ext: number; off: number }> = []
  let off = 0
  for (const e of entries) {
    const nm = Buffer.from(e.name, 'latin1')
    const data = e.dir ? EMPTY : e.data
    const crc = e.dir ? 0 : crc32(data)
    const vn = e.dir ? 20 : 10                                   // version-needed: 2.0 dir / 1.0 file
    const ext = e.dir ? 0x41ed0000                              // 0o40755 << 16
      : (e.mode & 0o111) !== 0 ? 0x81ed0000                     // 0o100755 << 16 (exec)
      : 0x81a40000                                              // 0o100644 << 16
    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(vn, 4)     // sig, version-needed
    lh.writeUInt16LE(0, 6); lh.writeUInt16LE(0, 8)              // gp-flag 0, method 0 (STORE)
    lh.writeUInt16LE(DOS_TIME, 10); lh.writeUInt16LE(DOS_DATE, 12)
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22)
    lh.writeUInt16LE(nm.length, 26); lh.writeUInt16LE(0, 28)     // name-len, extra-len 0
    parts.push(lh, nm, data)
    central.push({ name: nm, crc, size: data.length, vn, ext, off })
    off += 30 + nm.length + data.length
  }
  const cdStart = off
  for (const c of central) {
    const h = Buffer.alloc(46)
    h.writeUInt32LE(0x02014b50, 0); h.writeUInt16LE(MADE_BY, 4); h.writeUInt16LE(c.vn, 6)
    h.writeUInt16LE(0, 8); h.writeUInt16LE(0, 10)               // gp-flag, method (STORE)
    h.writeUInt16LE(DOS_TIME, 12); h.writeUInt16LE(DOS_DATE, 14); h.writeUInt32LE(c.crc, 16)
    h.writeUInt32LE(c.size, 20); h.writeUInt32LE(c.size, 24); h.writeUInt16LE(c.name.length, 28)
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

/**
 * Reproduce yarn-berry's `checksum` digest (the 128-hex after `<cacheKey>/`)
 * for `(tarball, ident, cacheKey)`. STORE only (cacheKey ending `c0`); throws
 * on DEFLATE/`mixed` (ADR-0035 §6). `ident` is `name` or `@scope/name`.
 */
export function computeBerryChecksum(tgz: Uint8Array, ident: string, cacheKey: string): string {
  if (cacheKeyCompressionLevel(cacheKey) !== 0)
    throw new Error(`computeBerryChecksum: only STORE (cacheKey ending 'c0') is supported; got '${cacheKey}'`)

  const tar = gunzipSync(Buffer.from(tgz))
  const prefix = `node_modules/${ident}/`
  const entries: ZipEntry[] = []
  const seen = new Set<string>()
  for (const f of parseTar(tar)) {
    const rel = f.name.split('/').slice(1).join('/')           // stripComponents:1 (drop leading 'package/')
    if (rel === '') continue
    const full = prefix + rel
    const segs = full.split('/'); segs.pop()                   // mkdirp parents in encounter order
    let cur = ''
    for (const s of segs) { cur += `${s}/`; if (!seen.has(cur)) { seen.add(cur); entries.push({ name: cur, dir: true, mode: 0o755, data: EMPTY }) } }
    entries.push({ name: full, dir: false, mode: f.mode, data: f.data })
  }
  return createHash('sha512').update(buildStoreZip(entries)).digest('hex')
}
