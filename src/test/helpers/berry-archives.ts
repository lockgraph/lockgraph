// Deterministic package archives whose yarn cache checksums were measured on real
// yarn builds. Built in memory so a test needs neither the network nor a vendored blob.

import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'

/** Incompressible, reproducible bytes: a SHA-256 chain truncated to `n`. */
export function noise(n: number, seed: string): Buffer {
  const blocks: Buffer[] = []
  for (let i = 0; blocks.length * 32 < n; i++) {
    blocks.push(createHash('sha256').update(`${seed}:${i}`).digest())
  }
  return Buffer.concat(blocks).subarray(0, n)
}

/** One regular-file ustar member, mode 0644, with a valid header checksum. */
function ustarFile(name: string, data: Buffer): Buffer {
  const header = Buffer.alloc(512)
  header.write(name, 0, 'utf8')
  header.write('0000644\0', 100)
  header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124)
  header.write('0', 156)
  header.write('ustar\0', 257)
  header.write('00', 263)
  header.fill(0x20, 148, 156)
  let sum = 0
  for (const byte of header) sum += byte
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1')
  const padding = Buffer.alloc(Math.ceil(data.length / 512) * 512 - data.length)
  return Buffer.concat([header, data, padding])
}

/**
 * `rnd@1.0.0`: incompressible entries on both sides of libzip's STORE fallback limit
 * — 8186 bytes (deflate stream 8191, stored) and 8187 bytes (stream 8192, deflated) —
 * plus a 12000-byte one (deflated although it grows) and a 100-byte one (stored).
 */
export function storeFallbackArchive(): Buffer {
  return gzipSync(Buffer.concat([
    ustarFile('package/package.json', Buffer.from('{"name":"rnd","version":"1.0.0"}\n')),
    ustarFile('package/store-8186.bin', noise(8186, 'a')),
    ustarFile('package/deflate-8187.bin', noise(8187, 'b')),
    ustarFile('package/big-12000.bin', noise(12000, 'c')),
    ustarFile('package/tiny-100.bin', noise(100, 'd')),
    Buffer.alloc(1024),
  ]))
}
