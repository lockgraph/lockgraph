import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { canonicalDigest, pickAlgorithm } from '../../main/ts/recipe/integrity.ts'
import type { Diagnostic } from '../../main/ts/graph.ts'
import { convert, parse } from '../../main/ts/index.ts'

// Adapter-level integrity BEHAVIOUR under ADR-0031 (the multi-hash carrier).
// Codec units (parseSri/emitSri/parseBerryChecksum/…) live in
// `recipe-integrity-multihash.test.ts`; this file pins how each adapter parses
// and emits integrity, and the cross-family origin-aware emit contract.

const here = dirname(fileURLToPath(import.meta.url))
const fixture = (rel: string): string =>
  readFileSync(resolve(here, '../resources/fixtures/lockfiles', rel), 'utf8')

// ms@2.1.3 real digests.
const MS_NPM_SRI  = 'sha512-6FlzubTLZG3J2a/NVCAleEhjzq5oxgHyaCU9yYXvcLsvoVaHJq/s5xXI6/XXP6tz7R9xAOtHnSO/tXtF3WRTlA=='
const MS_NPM_HEX  = 'e85973b9b4cb646dc9d9afcd542025784863ceae68c601f268253dc985ef70bb2fa1568726afece715c8ebf5d73fab73ed1f7100eb479d23bfb57b45dd645394'
const MS_YARN_HEX = 'd924b57e7312b3b63ad21fc5b3dc0af5e78d61a1fc7cfb5457edaf26326bf62be5307cc87ffb6862ef1c2b33b0233cdb5d4f01c4c958cc0d660948b65a287a48'
const MS_SHA1_SRI = 'sha1-VgiurfwAvmwpAd9fmGF4jeDVl8g='
// Real sha256/sha384 SRIs (preserved verbatim now that the sha512-only filter is gone).
const SHA256_SRI = `sha256-${createHash('sha256').update('lockfile').digest('base64')}`
const SHA384_SRI = `sha384-${createHash('sha384').update('lockfile').digest('base64')}`

const npm3With = (integrity: string): string => JSON.stringify({
  name: 'x', version: '0.0.0', lockfileVersion: 3, requires: true,
  packages: {
    '': { name: 'x', version: '0.0.0', dependencies: { ms: '2.1.3' } },
    'node_modules/ms': {
      version:   '2.1.3',
      resolved:  'https://registry.npmjs.org/ms/-/ms-2.1.3.tgz',
      integrity,
    },
  },
})

describe('integrity parse — preserves every algorithm (ADR-0031)', () => {
  it('npm-3: a sha1-only SRI is preserved, not dropped, no diagnostic', () => {
    const g = parse('npm-3', npm3With(MS_SHA1_SRI))
    const integ = g.tarballOf('ms@2.1.3')?.integrity
    expect(integ).toBeDefined()
    expect(pickAlgorithm(integ!, 'sha1')).toBeDefined()
    expect(g.diagnostics().some(d => d.code === 'NPM_INVALID_INTEGRITY')).toBe(false)
  })

  it('npm-3: a space-joined multi-hash SRI keeps every member in source order', () => {
    const g = parse('npm-3', npm3With(`${MS_SHA1_SRI} ${MS_NPM_SRI}`))
    const integ = g.tarballOf('ms@2.1.3')!.integrity!
    expect(integ.hashes.map(h => h.algorithm)).toEqual(['sha1', 'sha512'])
    expect(canonicalDigest(integ)).toBe(MS_NPM_SRI) // strongest tarball digest
  })

  it('npm-3: sha256 + sha384 are preserved verbatim (no longer dropped as non-sha512)', () => {
    const g = parse('npm-3', npm3With(`${SHA256_SRI} ${SHA384_SRI}`))
    const integ = g.tarballOf('ms@2.1.3')!.integrity!
    expect(integ.hashes.map(h => h.algorithm)).toEqual(['sha256', 'sha384'])
    expect(g.diagnostics().some(d => d.code === 'NPM_INVALID_INTEGRITY')).toBe(false)
  })

  it('npm-3: a canonical sha512 round-trips through canonicalDigest', () => {
    const g = parse('npm-3', npm3With(MS_NPM_SRI))
    expect(canonicalDigest(g.tarballOf('ms@2.1.3')!.integrity!)).toBe(MS_NPM_SRI)
    expect(pickAlgorithm(g.tarballOf('ms@2.1.3')!.integrity!, 'sha512')!.digest).toBe(MS_NPM_HEX)
  })
})

describe('integrity parse — still rejects GENUINELY malformed input', () => {
  // Malformed now means "no parseable hash" — a wrong byte length for the
  // algorithm, or a non-SRI / non-berry-checksum shape — NOT merely non-sha512.

  it('npm-3: a sha512 of the wrong byte length → NPM_INVALID_INTEGRITY + dropped', () => {
    const g = parse('npm-3', npm3With('sha512-AAAA')) // 3 bytes, not 64
    expect(g.tarballOf('ms@2.1.3')?.integrity).toBeUndefined()
    expect(g.diagnostics().some(d => d.code === 'NPM_INVALID_INTEGRITY' && d.subject === 'ms@2.1.3')).toBe(true)
  })

  it('pnpm-v9: a wrong-length integrity → PNPM_V9_INVALID_INTEGRITY + dropped', () => {
    const lf =
      "lockfileVersion: '9.0'\n" +
      'settings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n' +
      'importers:\n  .:\n    dependencies:\n      ms:\n        specifier: ^2.1.3\n        version: 2.1.3\n' +
      'packages:\n' +
      "  ms@2.1.3:\n    resolution: {integrity: sha512-AAAA, tarball: 'https://registry.npmjs.org/ms/-/ms-2.1.3.tgz'}\n" +
      'snapshots:\n  ms@2.1.3: {}\n'
    const g = parse('pnpm-v9', lf)
    expect(g.tarballOf('ms@2.1.3')?.integrity).toBeUndefined()
    expect(g.diagnostics().some(d => d.code.startsWith('PNPM') && d.code.endsWith('_INVALID_INTEGRITY') && d.subject === 'ms@2.1.3')).toBe(true)
  })

  it('yarn-berry-v9: a non-128-hex checksum → YARN_BERRY_V9_INVALID_INTEGRITY + dropped', () => {
    const lf =
      '__metadata:\n  version: 9\n  cacheKey: 10c0\n\n' +
      '"ms@npm:2.1.3":\n  version: 2.1.3\n  resolution: "ms@npm:2.1.3"\n  checksum: sha1-deadbeef\n' +
      '  languageName: node\n  linkType: hard\n'
    const g = parse('yarn-berry-v9', lf)
    expect(g.tarballOf('ms@2.1.3')?.integrity).toBeUndefined()
    expect(g.diagnostics().some(d => d.code === 'YARN_BERRY_V9_INVALID_INTEGRITY' && d.subject === 'ms@2.1.3')).toBe(true)
  })
})

describe('integrity parse — yarn-berry checksum is a berry-zip digest, not a tarball SRI', () => {
  it('yarn-berry-v9 fixture: integrity is a berry-zip sha512; canonicalDigest is undefined (no tarball digest)', () => {
    const g = parse('yarn-berry-v9', fixture('simple/yarn-berry-v9.lock'))
    const integ = g.tarballOf('ms@2.1.3')!.integrity!
    const sha512 = pickAlgorithm(integ, 'sha512')!
    expect(sha512.origin).toBe('berry-zip')
    expect(sha512.digest).toBe(MS_YARN_HEX)
    expect(canonicalDigest(integ)).toBeUndefined()
  })
})

describe('integrity round-trip WITHIN a family preserves the digest', () => {
  it('npm-3 → npm-3 keeps the tarball sha512 byte-exact', async () => {
    const g = parse('npm-3', await convert(fixture('simple/npm-3.lock'), { from: 'npm-3', to: 'npm-3' }))
    expect(canonicalDigest(g.tarballOf('ms@2.1.3')!.integrity!)).toBe(MS_NPM_SRI)
  })

  it('yarn-berry-v4 → yarn-berry-v9 round-trips the berry-zip checksum (cacheKey re-applied)', async () => {
    const v4src = fixture('simple/yarn-berry-v4.lock')
    const v4hex = pickAlgorithm(parse('yarn-berry-v4', v4src).tarballOf('ms@2.1.3')!.integrity!, 'sha512')!.digest
    const v9 = await convert(v4src, { from: 'yarn-berry-v4', to: 'yarn-berry-v9', cacheKey: '10c0' })
    expect(v9).toMatch(new RegExp(`checksum: 10c0/${v4hex}`))
    const sha512 = pickAlgorithm(parse('yarn-berry-v9', v9).tarballOf('ms@2.1.3')!.integrity!, 'sha512')!
    expect(sha512.origin).toBe('berry-zip')
    expect(sha512.digest).toBe(v4hex)
  })
})

describe('integrity cross-family emit — OMITS, never fabricates (the headline fix)', () => {
  it('yarn-berry-v9 → npm-3: the berry-zip digest is NOT re-encoded as an npm SRI (integrity omitted)', async () => {
    const npm3 = await convert(fixture('simple/yarn-berry-v9.lock'), { from: 'yarn-berry-v9', to: 'npm-3' })
    expect(parse('npm-3', npm3).tarballOf('ms@2.1.3')?.integrity).toBeUndefined()
  })

  it('npm-3 → yarn-berry-v9: the tarball sha512 is NOT re-encoded as a berry checksum (line omitted) + RECIPE_INTEGRITY_INCOMPLETE', async () => {
    const captured: Diagnostic[] = []
    const v9 = await convert(fixture('simple/npm-3.lock'), {
      from: 'npm-3', to: 'yarn-berry-v9', cacheKey: '10c0', onDiagnostic: d => captured.push(d),
    })
    expect(v9).not.toMatch(/checksum:/)
    expect(captured.some(d => d.code === 'RECIPE_INTEGRITY_INCOMPLETE' && d.subject === 'ms@2.1.3')).toBe(true)
  })

  // Every SRI-family source must omit-not-fabricate on →berry (same codec, but a
  // regression in one adapter's emit would otherwise slip through silently).
  it('yarn-classic → yarn-berry-v9: tarball SRI not re-encoded as a checksum (omitted) + RECIPE_INTEGRITY_INCOMPLETE', async () => {
    const classic = await convert(fixture('simple/npm-3.lock'), { from: 'npm-3', to: 'yarn-classic' })
    const captured: Diagnostic[] = []
    const v9 = await convert(classic, { from: 'yarn-classic', to: 'yarn-berry-v9', cacheKey: '10c0', onDiagnostic: d => captured.push(d) })
    expect(v9).not.toMatch(/checksum:/)
    expect(captured.some(d => d.code === 'RECIPE_INTEGRITY_INCOMPLETE' && d.subject === 'ms@2.1.3')).toBe(true)
  })

  it('bun-text → yarn-berry-v9: tarball SRI not re-encoded as a checksum (omitted) + RECIPE_INTEGRITY_INCOMPLETE', async () => {
    const bun = await convert(fixture('simple/npm-3.lock'), { from: 'npm-3', to: 'bun-text' })
    const captured: Diagnostic[] = []
    const v9 = await convert(bun, { from: 'bun-text', to: 'yarn-berry-v9', cacheKey: '10c0', onDiagnostic: d => captured.push(d) })
    expect(v9).not.toMatch(/checksum:/)
    expect(captured.some(d => d.code === 'RECIPE_INTEGRITY_INCOMPLETE' && d.subject === 'ms@2.1.3')).toBe(true)
  })
})

describe('integrity cross-family emit WITHIN the SRI family preserves the tarball digest', () => {
  it('npm-3 → pnpm-v9 keeps the tarball sha512 (both carry tarball SRIs)', async () => {
    const pnpm = await convert(fixture('simple/npm-3.lock'), { from: 'npm-3', to: 'pnpm-v9' })
    expect(canonicalDigest(parse('pnpm-v9', pnpm).tarballOf('ms@2.1.3')!.integrity!)).toBe(MS_NPM_SRI)
  })
})
