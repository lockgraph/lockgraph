import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import {
  detectEncoding,
  emitTranslation,
  fromCanonical,
  isCanonical,
  toCanonical,
  tryDetectEncoding,
  validateCanonical,
} from '../../main/ts/recipe/integrity.ts'
import type { Diagnostic } from '../../main/ts/graph.ts'
import { LockfileError } from '../../main/ts/errors.ts'
import { convert, parse } from '../../main/ts/index.ts'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = (rel: string): string =>
  readFileSync(resolve(here, '../resources/fixtures/lockfiles', rel), 'utf8')

// Real ms@2.1.3 sha512 from npm-3 fixture (registry-tarball SRI).
const MS_NPM_SRI = 'sha512-6FlzubTLZG3J2a/NVCAleEhjzq5oxgHyaCU9yYXvcLsvoVaHJq/s5xXI6/XXP6tz7R9xAOtHnSO/tXtF3WRTlA=='
const MS_NPM_HEX = 'e85973b9b4cb646dc9d9afcd542025784863ceae68c601f268253dc985ef70bb2fa1568726afece715c8ebf5d73fab73ed1f7100eb479d23bfb57b45dd645394'
// Yarn-berry computes its own sha512 over the cached zip — different artefact
// than the registry tarball, so the byte values diverge from MS_NPM_*. Both
// are valid `sha512-<base64>` SRIs at the canonical recipe layer (ADR-0014
// §4.F1 cares about encoding, not artefact identity).
const MS_YARN_HEX = 'd924b57e7312b3b63ad21fc5b3dc0af5e78d61a1fc7cfb5457edaf26326bf62be5307cc87ffb6862ef1c2b33b0233cdb5d4f01c4c958cc0d660948b65a287a48'
const MS_YARN_SRI = 'sha512-2SS1fnMSs7Y60h/Fs9wK9eeNYaH8fPtUV+2vJjJr9ivlMHzIf/toYu8cKzOwIzzbXU8BxMlYzA1mCUi2Wih6SA=='
const MS_YARN_CKEY = `10c0/${MS_YARN_HEX}`
// Pad-bit alias of MS_NPM_SRI: identical 64-byte decoding, different trailing
// base64 char. Both round-trip via Buffer.from(...,'base64') to the same bytes
// but only one canonical re-encoding exists. ADR-0014 §4.F1 requires byte-
// exact round-trip; the alias must fail isCanonical / validateCanonical.
const MS_NPM_SRI_PADBIT_ALIAS =
  'sha512-6FlzubTLZG3J2a/NVCAleEhjzq5oxgHyaCU9yYXvcLsvoVaHJq/s5xXI6/XXP6tz7R9xAOtHnSO/tXtF3WRTlB=='

describe('recipe/integrity — isCanonical', () => {
  it('accepts canonical sha512 SRI (88 chars after prefix, == padding)', () => {
    expect(isCanonical(MS_NPM_SRI)).toBe(true)
    expect(isCanonical(MS_YARN_SRI)).toBe(true)
  })
  it('rejects non-sha512 SRI (sha1/sha256/sha384)', () => {
    expect(isCanonical('sha1-AAAA==')).toBe(false)
    expect(isCanonical('sha256-' + 'A'.repeat(43) + '=')).toBe(false)
  })
  it('rejects short/long base64 payloads', () => {
    expect(isCanonical('sha512-AAAA==')).toBe(false)
    expect(isCanonical('sha512-' + 'A'.repeat(200) + '==')).toBe(false)
  })
  it('rejects sentinel placeholders', () => {
    expect(isCanonical('sha512-modified-ms-integrity')).toBe(false)
    expect(isCanonical('')).toBe(false)
    expect(isCanonical('not-a-hash')).toBe(false)
  })
  it('rejects pad-bit-aliased base64 (decodes к same bytes, different trailing char)', () => {
    // Both encode 64 identical bytes; only the canonical re-encoding is accepted.
    expect(Buffer.from(MS_NPM_SRI_PADBIT_ALIAS.slice(7), 'base64').toString('base64'))
      .toBe(MS_NPM_SRI.slice(7))
    expect(isCanonical(MS_NPM_SRI_PADBIT_ALIAS)).toBe(false)
    expect(isCanonical(MS_NPM_SRI)).toBe(true)
  })
})

describe('recipe/integrity — validateCanonical', () => {
  it('returns the canonical SRI verbatim when isCanonical', () => {
    expect(validateCanonical(MS_NPM_SRI)).toBe(MS_NPM_SRI)
    expect(validateCanonical(MS_YARN_SRI)).toBe(MS_YARN_SRI)
  })
  it('returns undefined for non-canonical inputs (legacy SRI, sentinel, alias)', () => {
    expect(validateCanonical('sha1-AAAA==')).toBeUndefined()
    expect(validateCanonical('sha512-modified-ms-integrity')).toBeUndefined()
    expect(validateCanonical(MS_NPM_SRI_PADBIT_ALIAS)).toBeUndefined()
    expect(validateCanonical(MS_YARN_HEX)).toBeUndefined()
  })
})

describe('recipe/integrity — tryDetectEncoding / detectEncoding', () => {
  it('identifies canonical sha512 SRI as `sri`', () => {
    expect(tryDetectEncoding(MS_NPM_SRI)).toBe('sri')
    expect(detectEncoding(MS_NPM_SRI)).toBe('sri')
  })
  it('identifies raw 128-hex (yarn-berry v4/v5/v6)', () => {
    expect(tryDetectEncoding(MS_YARN_HEX)).toBe('hex')
    expect(detectEncoding(MS_YARN_HEX)).toBe('hex')
  })
  it('identifies cacheKey-prefixed 128-hex (yarn-berry v8/v9)', () => {
    expect(tryDetectEncoding(MS_YARN_CKEY)).toBe('cachekey-prefixed')
    expect(detectEncoding(MS_YARN_CKEY)).toBe('cachekey-prefixed')
  })
  it('rejects non-128-char hex (would mis-decode in Buffer.from)', () => {
    expect(tryDetectEncoding('a')).toBeUndefined()
    expect(tryDetectEncoding('abc123')).toBeUndefined()
    expect(tryDetectEncoding('a'.repeat(127))).toBeUndefined()
    expect(tryDetectEncoding('a'.repeat(129))).toBeUndefined()
  })
  it('rejects non-128-char cacheKey-prefixed payloads (sentinels)', () => {
    expect(tryDetectEncoding('10c0/orphan')).toBeUndefined()
    expect(tryDetectEncoding('10c0/modified-ms-integrity')).toBeUndefined()
  })
  it('rejects legacy sha1/sha256/sha384 SRIs (not canonical, adapter must passthrough)', () => {
    expect(tryDetectEncoding('sha1-thisIsBase64AAA=')).toBeUndefined()
    expect(tryDetectEncoding('md5-AAAA==')).toBeUndefined()
  })
  it('throws on unrecognised shapes via detectEncoding', () => {
    expect(() => detectEncoding('not-a-hash')).toThrow(LockfileError)
    expect(() => detectEncoding('')).toThrow(LockfileError)
    expect(() => detectEncoding('sha1-thisIsBase64AAA=')).toThrow(LockfileError)
  })
})

describe('recipe/integrity — toCanonical (strict)', () => {
  it('hex → SRI is byte-equal to the canonical encoding of the same bytes', () => {
    expect(toCanonical(MS_NPM_HEX, 'hex')).toBe(MS_NPM_SRI)
    expect(toCanonical(MS_YARN_HEX, 'hex')).toBe(MS_YARN_SRI)
  })
  it('cachekey-prefixed → SRI strips the prefix before encoding', () => {
    expect(toCanonical(MS_YARN_CKEY, 'cachekey-prefixed')).toBe(MS_YARN_SRI)
  })
  it('canonical SRI → SRI is identity', () => {
    expect(toCanonical(MS_NPM_SRI, 'sri')).toBe(MS_NPM_SRI)
  })
  it('auto-detects source encoding when omitted', () => {
    expect(toCanonical(MS_YARN_HEX)).toBe(MS_YARN_SRI)
    expect(toCanonical(MS_YARN_CKEY)).toBe(MS_YARN_SRI)
    expect(toCanonical(MS_NPM_SRI)).toBe(MS_NPM_SRI)
  })
  it('throws when source=hex but value is not exactly 128 hex chars', () => {
    expect(() => toCanonical('abc', 'hex')).toThrow(LockfileError)
    expect(() => toCanonical('a'.repeat(127), 'hex')).toThrow(LockfileError)
  })
  it('throws when source=cachekey-prefixed but value lacks 128-hex tail', () => {
    expect(() => toCanonical('10c0/orphan', 'cachekey-prefixed')).toThrow(LockfileError)
  })
  it('throws when source=sri but value is not canonical sha512', () => {
    expect(() => toCanonical('sha1-AAAA==', 'sri')).toThrow(LockfileError)
    expect(() => toCanonical('sha512-too-short', 'sri')).toThrow(LockfileError)
  })
})

describe('recipe/integrity — fromCanonical (strict)', () => {
  it('SRI → hex is byte-equal to the yarn-berry-v4/v5/v6 raw form', () => {
    expect(fromCanonical(MS_YARN_SRI, 'hex')).toBe(MS_YARN_HEX)
  })
  it('SRI → cachekey-prefixed re-applies the supplied cacheKey', () => {
    expect(fromCanonical(MS_YARN_SRI, 'cachekey-prefixed', { cacheKey: '10c0' })).toBe(MS_YARN_CKEY)
  })
  it('SRI → SRI is identity', () => {
    expect(fromCanonical(MS_NPM_SRI, 'sri')).toBe(MS_NPM_SRI)
  })
  it('throws when target=cachekey-prefixed lacks options.cacheKey', () => {
    expect(() => fromCanonical(MS_NPM_SRI, 'cachekey-prefixed')).toThrow(LockfileError)
    expect(() => fromCanonical(MS_NPM_SRI, 'cachekey-prefixed', { cacheKey: '' })).toThrow(LockfileError)
  })
  it('throws when canonical is not strict sha512 SRI', () => {
    expect(() => fromCanonical('10c0/orphan', 'cachekey-prefixed', { cacheKey: '10c0' })).toThrow(LockfileError)
    expect(() => fromCanonical('sha1-AAAA==', 'hex')).toThrow(LockfileError)
    expect(() => fromCanonical('sha512-modified-ms-integrity', 'hex')).toThrow(LockfileError)
  })
})

describe('recipe/integrity — round-trips', () => {
  it('hex ↔ SRI is lossless', () => {
    expect(fromCanonical(toCanonical(MS_YARN_HEX, 'hex'), 'hex')).toBe(MS_YARN_HEX)
  })
  it('cachekey-prefixed ↔ SRI is lossless when cacheKey is preserved', () => {
    expect(
      fromCanonical(toCanonical(MS_YARN_CKEY, 'cachekey-prefixed'), 'cachekey-prefixed', { cacheKey: '10c0' }),
    ).toBe(MS_YARN_CKEY)
  })
})

describe('recipe/integrity — emitTranslation', () => {
  it('emits RECIPE_INTEGRITY_TRANSLATED with the from/to encodings', () => {
    const captured: Diagnostic[] = []
    emitTranslation('ms@2.1.3', 'cachekey-prefixed', 'sri', d => captured.push(d))
    expect(captured).toEqual([{
      code:     'RECIPE_INTEGRITY_TRANSLATED',
      severity: 'info',
      subject:  'ms@2.1.3',
      message:  'integrity translated cachekey-prefixed → sri',
    }])
  })
  it('skips emission when from === to (identity translation)', () => {
    const captured: Diagnostic[] = []
    emitTranslation('ms@2.1.3', 'sri', 'sri', d => captured.push(d))
    expect(captured).toEqual([])
  })
  it('no-op when onDiagnostic is undefined', () => {
    expect(() => emitTranslation('ms@2.1.3', 'hex', 'sri')).not.toThrow()
  })
})

describe('recipe/integrity — adapter parse-side wiring', () => {
  it('yarn-berry-v9 fixture parse → Graph integrity is canonical SRI', () => {
    const g = parse('yarn-berry-v9', fixture('simple/yarn-berry-v9.lock'))
    expect(g.tarballOf('ms@2.1.3')?.integrity).toBe(MS_YARN_SRI)
  })
  it('yarn-berry-v4 fixture parse → Graph integrity is canonical SRI', () => {
    const g = parse('yarn-berry-v4', fixture('simple/yarn-berry-v4.lock'))
    // v4 of `simple` shares the same yarn-side checksum as v9; both translate
    // to the same canonical SRI (canonical form = canonical bytes).
    expect(g.tarballOf('ms@2.1.3')?.integrity).toMatch(/^sha512-/)
  })
  it('npm-3 fixture parse → Graph integrity is canonical SRI (identity)', () => {
    const g = parse('npm-3', fixture('simple/npm-3.lock'))
    expect(g.tarballOf('ms@2.1.3')?.integrity).toBe(MS_NPM_SRI)
  })
})

describe('recipe/integrity — adapter parse-side rejects malformed integrity', () => {
  // Per ADR-0014 §4.F1 strict canonical: every adapter must reject sha1/sha256/
  // malformed inputs at parse with an adapter-prefixed `_INVALID_INTEGRITY`
  // warning, leaving Graph integrity undefined (no recipe-layer translation).

  it('npm-3 parse: legacy sha1 integrity → NPM_INVALID_INTEGRITY + integrity dropped', () => {
    const lf = JSON.stringify({
      name: 'x',
      version: '0.0.0',
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': { name: 'x', version: '0.0.0', dependencies: { ms: '2.1.3' } },
        'node_modules/ms': {
          version: '2.1.3',
          resolved: 'https://registry.npmjs.org/ms/-/ms-2.1.3.tgz',
          integrity: 'sha1-VgiurfwAvmwpAd9fmGF4jeDVl8g=',
        },
      },
    })
    const g = parse('npm-3', lf)
    expect(g.tarballOf('ms@2.1.3')?.integrity).toBeUndefined()
    expect(g.diagnostics().some(d => d.code === 'NPM_INVALID_INTEGRITY' && d.subject === 'ms@2.1.3'))
      .toBe(true)
  })

  it('pnpm-v9 parse: malformed integrity → PNPM_INVALID_INTEGRITY + integrity dropped', () => {
    const lf =
      "lockfileVersion: '9.0'\n" +
      'settings:\n' +
      '  autoInstallPeers: true\n' +
      '  excludeLinksFromLockfile: false\n' +
      'importers:\n' +
      "  .:\n" +
      '    dependencies:\n' +
      "      ms:\n" +
      "        specifier: ^2.1.3\n" +
      "        version: 2.1.3\n" +
      'packages:\n' +
      "  ms@2.1.3:\n" +
      "    resolution: {integrity: sha256-XXXBADXXXNOTAVALID256SRIXXXXXXXXXXXXXXXXXXX=, tarball: 'https://registry.npmjs.org/ms/-/ms-2.1.3.tgz'}\n" +
      'snapshots:\n' +
      "  ms@2.1.3: {}\n"
    const g = parse('pnpm-v9', lf)
    expect(g.tarballOf('ms@2.1.3')?.integrity).toBeUndefined()
    expect(g.diagnostics().some(d => d.code === 'PNPM_INVALID_INTEGRITY' && d.subject === 'ms@2.1.3'))
      .toBe(true)
  })

  it('bun-text parse: sha1 integrity → BUN_TEXT_INVALID_INTEGRITY + integrity dropped', () => {
    const lf = JSON.stringify({
      lockfileVersion: 1,
      workspaces: { '': { name: 'x' } },
      packages: {
        'ms': ['ms@2.1.3', '', { os: ['darwin'] }, 'sha1-VgiurfwAvmwpAd9fmGF4jeDVl8g='],
      },
    })
    const g = parse('bun-text', lf)
    expect(g.tarballOf('ms@2.1.3')?.integrity).toBeUndefined()
    expect(g.diagnostics().some(d => d.code === 'BUN_TEXT_INVALID_INTEGRITY' && d.subject === 'ms@2.1.3'))
      .toBe(true)
  })

  it('yarn-classic parse: sha1 integrity → YARN_CLASSIC_INVALID_INTEGRITY + integrity dropped', () => {
    const lf =
      '# THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.\n' +
      '# yarn lockfile v1\n\n\n' +
      'ms@^2.1.3:\n' +
      '  version "2.1.3"\n' +
      '  resolved "https://registry.npmjs.org/ms/-/ms-2.1.3.tgz#574c8138ce1d2b5861f0b44579dbadd60c6615b2"\n' +
      '  integrity sha1-VgiurfwAvmwpAd9fmGF4jeDVl8g=\n'
    const g = parse('yarn-classic', lf)
    expect(g.tarballOf('ms@2.1.3')?.integrity).toBeUndefined()
    expect(g.diagnostics().some(d => d.code === 'YARN_CLASSIC_INVALID_INTEGRITY' && d.subject === 'ms@2.1.3'))
      .toBe(true)
  })

  it('yarn-berry-v9 parse: non-128-hex / non-cachekey checksum → YARN_BERRY_V9_INVALID_INTEGRITY + integrity dropped', () => {
    const lf =
      '__metadata:\n' +
      '  version: 9\n' +
      '  cacheKey: 10c0\n\n' +
      '"ms@npm:2.1.3":\n' +
      '  version: 2.1.3\n' +
      '  resolution: "ms@npm:2.1.3"\n' +
      '  checksum: sha1-deadbeef\n' +
      '  languageName: node\n' +
      '  linkType: hard\n'
    const g = parse('yarn-berry-v9', lf)
    expect(g.tarballOf('ms@2.1.3')?.integrity).toBeUndefined()
    expect(g.diagnostics().some(d => d.code === 'YARN_BERRY_V9_INVALID_INTEGRITY' && d.subject === 'ms@2.1.3'))
      .toBe(true)
  })

  it('yarn-berry-v4 parse: bare sha1 hex (40 chars, not 128) → YARN_BERRY_V4_INVALID_INTEGRITY + integrity dropped', () => {
    const lf =
      '__metadata:\n' +
      '  version: 4\n' +
      '  cacheKey: 7\n\n' +
      '"ms@npm:2.1.3":\n' +
      '  version: 2.1.3\n' +
      '  resolution: "ms@npm:2.1.3"\n' +
      '  checksum: 5608aeadfc00be6c2901df5f986178c8de0d97c8\n' +
      '  languageName: node\n' +
      '  linkType: hard\n'
    const g = parse('yarn-berry-v4', lf)
    expect(g.tarballOf('ms@2.1.3')?.integrity).toBeUndefined()
    expect(g.diagnostics().some(d => d.code === 'YARN_BERRY_V4_INVALID_INTEGRITY' && d.subject === 'ms@2.1.3'))
      .toBe(true)
  })
})

describe('recipe/integrity — cross-format conversion', () => {
  it('yarn-berry-v9 → npm-3 → integrity is SRI byte-equal to the source-side canonical', () => {
    const v9   = fixture('simple/yarn-berry-v9.lock')
    const npm3 = convert(v9, { from: 'yarn-berry-v9', to: 'npm-3' })
    const g    = parse('npm-3', npm3)
    expect(g.tarballOf('ms@2.1.3')?.integrity).toBe(MS_YARN_SRI)
  })

  it('npm-3 → yarn-berry-v9 → integrity emerges as cacheKey-prefixed', () => {
    const npm3 = fixture('simple/npm-3.lock')
    const v9   = convert(npm3, { from: 'npm-3', to: 'yarn-berry-v9', cacheKey: '10c0' })
    expect(v9).toMatch(/checksum: 10c0\/[0-9a-f]{128}/)
  })

  it('yarn-berry-v4 → yarn-berry-v9 → RECIPE_INTEGRITY_TRANSLATED fires on both parse and stringify', () => {
    const v4 = fixture('simple/yarn-berry-v4.lock')
    const captured: Diagnostic[] = []
    convert(v4, {
      from:         'yarn-berry-v4',
      to:           'yarn-berry-v9',
      cacheKey:     '10c0',
      onDiagnostic: d => captured.push(d),
    })

    const recipe = captured.filter(d => d.code === 'RECIPE_INTEGRITY_TRANSLATED')
    // parse-side (hex → sri) emits once per node, stringify-side (sri →
    // cachekey-prefixed) emits once per node. At least two distinct messages
    // expected across both translation directions.
    expect(recipe.some(d => d.message.includes('hex → sri'))).toBe(true)
    expect(recipe.some(d => d.message.includes('sri → cachekey-prefixed'))).toBe(true)
  })
})
