// ADR-0034 enrich phase / `refurbish` — install-completeness for the berry
// `checksum`. The recompute (ADR-0035) is exercised against vendored tarballs.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { refurbish, type TarballSource } from '../../main/ts/enrich/refurbish.ts'
import { computeBerryChecksum } from '../../main/ts/recipe/berry-checksum.ts'
import { emitBerryChecksum } from '../../main/ts/recipe/integrity.ts'
import { graphOf, addPackage } from './_modify-test-utils.ts'

const here = dirname(fileURLToPath(import.meta.url))
const tgz = (rel: string): Buffer => readFileSync(resolve(here, '../resources/fixtures/tarballs', rel))

const sourceOf = (map: Record<string, Buffer>): TarballSource => ({
  // eslint-disable-next-line @typescript-eslint/require-await
  async tarball(name: string, version: string): Promise<Uint8Array | undefined> {
    return map[`${name}@${version}`]
  },
})

describe('enrich/refurbish (ADR-0034 + ADR-0035)', () => {
  it('recomputes a missing berry checksum from the tarball (STORE)', async () => {
    const graph = graphOf(b => { addPackage(b, { name: 'ms', version: '2.1.3' }) })
    const r = await refurbish(graph, 'yarn-berry-v8', sourceOf({ 'ms@2.1.3': tgz('ms-2.1.3.tgz') }))

    expect(r.enriched).toEqual(['ms@2.1.3'])
    const payload = r.graph.tarballOf('ms@2.1.3')
    expect(payload?.berryChecksumCacheKey).toBe('10c0')
    expect(emitBerryChecksum(payload!.integrity!)).toBe(
      computeBerryChecksum(tgz('ms-2.1.3.tgz'), 'ms', '10c0'),
    )
    expect(r.unresolved.map(d => d.code)).toEqual(['ENRICH_FIELD_FILLED'])
    // dual-channel — also on Graph.diagnostics()
    expect(r.graph.diagnostics().map(d => d.code)).toContain('ENRICH_FIELD_FILLED')
  })

  it('defers (warning, line omitted) when the tarball is unavailable', async () => {
    const graph = graphOf(b => { addPackage(b, { name: 'ms', version: '2.1.3' }) })
    const r = await refurbish(graph, 'yarn-berry-v8', sourceOf({}))

    expect(r.enriched).toEqual([])
    expect(r.unresolved.map(d => d.code)).toEqual(['ENRICH_CHECKSUM_DEFERRED'])
    expect(r.unresolved[0]!.severity).toBe('warning')
    expect(r.graph.tarballOf('ms@2.1.3')?.integrity).toBeUndefined()
  })

  it('noop on a non-berry target (npm/pnpm integrity is completion-filled)', async () => {
    const graph = graphOf(b => { addPackage(b, { name: 'ms', version: '2.1.3' }) })
    const r = await refurbish(graph, 'npm-3', sourceOf({}))

    expect(r.enriched).toEqual([])
    expect(r.unresolved.map(d => d.code)).toEqual(['ENRICH_NOOP'])
  })

  it('is idempotent — a second pass fills nothing (checksum now present)', async () => {
    const graph = graphOf(b => { addPackage(b, { name: 'ms', version: '2.1.3' }) })
    const src = sourceOf({ 'ms@2.1.3': tgz('ms-2.1.3.tgz') })
    const first = await refurbish(graph, 'yarn-berry-v8', src)
    const second = await refurbish(first.graph, 'yarn-berry-v8', src)

    expect(second.enriched).toEqual([])
    expect(second.unresolved.map(d => d.code)).toEqual(['ENRICH_NOOP'])
  })

  it('fills every gap node in a changed subtree (multi-node, no seed)', async () => {
    const graph = graphOf(b => {
      addPackage(b, { name: 'ms',                   version: '2.1.3' })
      addPackage(b, { name: 'is-buffer',            version: '2.0.5' })
      addPackage(b, { name: '@kwsites/file-exists', version: '1.1.1' })
    })
    const src = sourceOf({
      'ms@2.1.3':                   tgz('ms-2.1.3.tgz'),
      'is-buffer@2.0.5':            tgz('is-buffer-2.0.5.tgz'),
      '@kwsites/file-exists@1.1.1': tgz('kwsites-file-exists-1.1.1.tgz'),
    })
    const r = await refurbish(graph, 'yarn-berry-v8', src)

    expect([...r.enriched].sort()).toEqual(
      ['@kwsites/file-exists@1.1.1', 'is-buffer@2.0.5', 'ms@2.1.3'],
    )
    for (const [id, ident, file] of [
      ['ms@2.1.3', 'ms', 'ms-2.1.3.tgz'],
      ['is-buffer@2.0.5', 'is-buffer', 'is-buffer-2.0.5.tgz'],
      ['@kwsites/file-exists@1.1.1', '@kwsites/file-exists', 'kwsites-file-exists-1.1.1.tgz'],
    ] as const) {
      expect(emitBerryChecksum(r.graph.tarballOf(id)!.integrity!))
        .toBe(computeBerryChecksum(tgz(file), ident, '10c0'))
    }
  })

  it('seed bounds the fill — an unseeded gap node is untouched', async () => {
    const graph = graphOf(b => {
      addPackage(b, { name: 'ms',        version: '2.1.3' })
      addPackage(b, { name: 'is-buffer', version: '2.0.5' })
    })
    const src = sourceOf({ 'ms@2.1.3': tgz('ms-2.1.3.tgz'), 'is-buffer@2.0.5': tgz('is-buffer-2.0.5.tgz') })
    const r = await refurbish(graph, 'yarn-berry-v8', src, { seed: new Set(['ms@2.1.3']) })

    expect(r.enriched).toEqual(['ms@2.1.3'])
    expect(r.graph.tarballOf('is-buffer@2.0.5')?.integrity).toBeUndefined()
  })
})
