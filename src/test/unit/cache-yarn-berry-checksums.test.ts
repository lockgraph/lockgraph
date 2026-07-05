// `withYarnCacheChecksums` — the security-preserving path for a `mixed` (or any
// unreproducible) berry checksum: the berry `checksum:` IS `sha512(yarn's cache zip)`
// (ADR-0035), so we READ yarn's OWN output from `.yarn/cache/` and hash it, rather
// than REPRODUCE it (impossible off-Node for `mixed`). Result: the bumped dep is
// PINNED, not omitted — no supply-chain-integrity regression when yarn is installed.

import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { refurbish, type TarballSource } from '../../main/ts/enrich/refurbish.ts'
import { withYarnCacheChecksums } from '../../main/ts/registry/cache-yarn-berry.ts'
import { emitBerryChecksum } from '../../main/ts/recipe/integrity.ts'
import { graphOf, addPackage } from './_modify-test-utils.ts'

const baseNoTarball: TarballSource = { async tarball() { return undefined } }

describe('withYarnCacheChecksums — fill a mixed berry checksum from yarn\'s OWN cache zip', () => {
  it('PINS the exact checksum = sha512(cache zip) for a mixed cacheKey (no reproduction)', async () => {
    // A yarn-4 cache zip for selfsigned@5.5.0 under cacheKey `10` (mixed). The bytes are
    // arbitrary — the point is the helper hashes THIS file (yarn's actual output), which
    // by ADR-0035 IS the berry checksum, so it's correct even where reproduction fails.
    const dir = mkdtempSync(join(tmpdir(), 'ycache-'))
    const zipBytes = Buffer.from('PK fake yarn-4 cache zip for selfsigned 5.5.0 (mixed)')
    writeFileSync(join(dir, 'selfsigned-npm-5.5.0-abcdef0123-10.zip'), zipBytes)
    const expected = createHash('sha512').update(zipBytes).digest('hex')

    const graph = graphOf(b => {
      addPackage(b, { name: 'app',        version: '0.0.0', workspacePath: '.' })
      addPackage(b, { name: 'selfsigned', version: '5.5.0' })
    })
    const r = await refurbish(graph, 'yarn-berry-v10', withYarnCacheChecksums(baseNoTarball, { cacheFolder: dir }), { cacheKey: '10' })

    expect(r.enriched).toEqual(['selfsigned@5.5.0'])
    expect(emitBerryChecksum(r.graph.tarballOf('selfsigned@5.5.0')!.integrity!)).toBe(expected)
  })

  it('DEFERS when the cache has no matching zip (nothing to pin, still no wrong value)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ycache-'))   // empty cache
    const graph = graphOf(b => {
      addPackage(b, { name: 'app',        version: '0.0.0', workspacePath: '.' })
      addPackage(b, { name: 'selfsigned', version: '5.5.0' })
    })
    const r = await refurbish(graph, 'yarn-berry-v10', withYarnCacheChecksums(baseNoTarball, { cacheFolder: dir }), { cacheKey: '10' })

    expect(r.enriched).toEqual([])
    expect(r.graph.tarballOf('selfsigned@5.5.0')?.integrity).toBeUndefined()
  })

  it('picks the zip whose filename cacheKey matches (mixed `10` ≠ STORE `10c0`)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ycache-'))
    const mixedBytes = Buffer.from('mixed-10 zip bytes')
    const storeBytes = Buffer.from('store-10c0 zip bytes — DIFFERENT')
    writeFileSync(join(dir, 'selfsigned-npm-5.5.0-abcdef0123-10.zip'), mixedBytes)
    writeFileSync(join(dir, 'selfsigned-npm-5.5.0-abcdef0123-10c0.zip'), storeBytes)

    const graph = graphOf(b => {
      addPackage(b, { name: 'app',        version: '0.0.0', workspacePath: '.' })
      addPackage(b, { name: 'selfsigned', version: '5.5.0' })
    })
    const r = await refurbish(graph, 'yarn-berry-v10', withYarnCacheChecksums(baseNoTarball, { cacheFolder: dir }), { cacheKey: '10' })

    expect(emitBerryChecksum(r.graph.tarballOf('selfsigned@5.5.0')!.integrity!))
      .toBe(createHash('sha512').update(mixedBytes).digest('hex'))   // the `-10` zip, not `-10c0`
  })
})
