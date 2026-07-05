// Regression for the yaf pijma selfsigned@5.5.0 hunt:
//  (1) the libzip packer must NORMALIZE the entry mode (yarn: 0o644, or 0o755 if any
//      execute bit) — passing the RAW tar mode diverged the zip for `test/ec-keys.js`
//      (0o600) → wrong checksum `2f2f71…` vs yarn's `fe9be2…` → `--immutable` YN0018.
//  (2) `parseTar` must THROW on an entry type it does not reproduce (symlink/hardlink)
//      so the packer DEFERS rather than SILENTLY skip it and mis-hash.

import { describe, it, expect } from 'vitest'
import { gzipSync } from 'node:zlib'
import { parseTar, computeBerryChecksum } from '../../main/ts/recipe/berry-checksum.ts'
import { computeBerryChecksumViaLibzip } from '../../main/ts/recipe/berry-pack-libzip.ts'

const hasLibzip = await import('@yarnpkg/libzip').then(() => true, () => false)

// One ustar file entry: 512-byte header + NUL-padded data blocks.
const tarEntry = (name: string, mode: number, type: string, data: Buffer): Buffer => {
  const h = Buffer.alloc(512)
  h.write(name, 0, 'utf8')
  h.write(mode.toString(8).padStart(7, '0') + '\0', 100)
  h.write(data.length.toString(8).padStart(11, '0') + '\0', 124)
  h.write(type, 156)
  const pad = Buffer.alloc(Math.ceil(data.length / 512) * 512 - data.length)
  return Buffer.concat([h, data, pad])
}
const rawTar = (...entries: Buffer[]): Buffer => Buffer.concat([...entries, Buffer.alloc(1024)])
const tgz = (...entries: Buffer[]): Uint8Array => new Uint8Array(gzipSync(rawTar(...entries)))

const DATA = Buffer.from('module.exports = 1\n')

describe('berry-pack — mode normalization + unsupported-entry safety (yaf selfsigned@5.5.0)', () => {
  it.skipIf(!hasLibzip)('libzip NORMALIZES a non-standard file mode (0o600 hashes the same as 0o644)', async () => {
    const at600 = tgz(tarEntry('package/index.js', 0o600, '0', DATA))
    const at644 = tgz(tarEntry('package/index.js', 0o644, '0', DATA))
    expect(await computeBerryChecksumViaLibzip(at600, 'foo', '10'))
      .toBe(await computeBerryChecksumViaLibzip(at644, 'foo', '10'))
  })

  it.skipIf(!hasLibzip)('libzip keeps the executable distinction (0o755 ≠ 0o644)', async () => {
    const exec = tgz(tarEntry('package/run.sh', 0o755, '0', DATA))
    const norm = tgz(tarEntry('package/run.sh', 0o644, '0', DATA))
    expect(await computeBerryChecksumViaLibzip(exec, 'foo', '10'))
      .not.toBe(await computeBerryChecksumViaLibzip(norm, 'foo', '10'))
  })

  it('pako path normalizes identically (0o600 === 0o644)', () => {
    const at600 = tgz(tarEntry('package/index.js', 0o600, '0', DATA))
    const at644 = tgz(tarEntry('package/index.js', 0o644, '0', DATA))
    expect(computeBerryChecksum(at600, 'foo', '10c0')).toBe(computeBerryChecksum(at644, 'foo', '10c0'))
  })

  it('parseTar THROWS on a symlink entry (typeflag 2) so the packer defers, never mis-hashes', () => {
    const link = tarEntry('package/link', 0o777, '2', Buffer.alloc(0))
    expect(() => parseTar(rawTar(link))).toThrow(/unsupported tar entry type/)
  })

  it('parseTar THROWS on a hardlink entry (typeflag 1)', () => {
    const link = tarEntry('package/hard', 0o644, '1', Buffer.alloc(0))
    expect(() => parseTar(rawTar(link))).toThrow(/unsupported tar entry type/)
  })

  it('parseTar still accepts a plain regular file (typeflag 0)', () => {
    const file = tarEntry('package/index.js', 0o644, '0', DATA)
    const entries = parseTar(rawTar(file))
    expect(entries.map(e => e.name)).toEqual(['package/index.js'])
  })
})
