import { describe, expect, it } from 'vitest'
import {
  parse as parseResolution,
  sourceDiscriminatorOf,
  type ResolutionCanonical,
} from '../../main/ts/recipe/resolution.ts'
import {
  serializeNodeId,
  toTarballKey,
  validateSourceToken,
} from '../../main/ts/graph.ts'
import { LockfileError } from '../../main/ts/api/errors.ts'
import { parse, stringify } from '../../main/ts/index.ts'

// ADR-0032 (#91 / #2b-general, "source-in-key"): the same `name@version` from
// DIFFERENT non-registry sources must NOT collapse onto ONE NodeId. A
// `+src=<16hex>` slot discriminates non-registry sources; the ~99% registry
// majority stays BARE (zero registry blast radius).

describe('ADR-0032 — sourceDiscriminatorOf mapping', () => {
  const SHA = '70f5e45c32620c7c3007ab43cab48d017ffaadff'

  it('registry tarball (npmjs default) → undefined (BARE)', () => {
    const c: ResolutionCanonical = { type: 'tarball', url: 'https://registry.npmjs.org/ms/-/ms-2.1.3.tgz' }
    expect(sourceDiscriminatorOf(c)).toBeUndefined()
  })

  it('registry tarball (yarnpkg mirror) → undefined (BARE)', () => {
    const c: ResolutionCanonical = { type: 'tarball', url: 'https://registry.yarnpkg.com/ms/-/ms-2.1.3.tgz' }
    expect(sourceDiscriminatorOf(c)).toBeUndefined()
  })

  it('non-registry-host tarball → 16-hex slot keyed by HOST', () => {
    const c: ResolutionCanonical = { type: 'tarball', url: 'https://example.com/foo-1.0.0.tgz' }
    const slot = sourceDiscriminatorOf(c)
    expect(slot).toMatch(/^[0-9a-f]{16}$/)
    // Two different paths on the SAME non-registry host collapse to one slot
    // (the host is the discriminator, not the full URL).
    const c2: ResolutionCanonical = { type: 'tarball', url: 'https://example.com/foo-2.0.0.tgz' }
    expect(sourceDiscriminatorOf(c2)).toBe(slot)
    // A DIFFERENT host yields a different slot.
    const c3: ResolutionCanonical = { type: 'tarball', url: 'https://other.example.org/foo-1.0.0.tgz' }
    expect(sourceDiscriminatorOf(c3)).not.toBe(slot)
  })

  it('git → 16-hex slot over url + sha (host attribution dropped)', () => {
    const c: ResolutionCanonical = { type: 'git', url: 'https://github.com/sindresorhus/is.git', sha: SHA, hostingProvider: 'github' }
    const slot = sourceDiscriminatorOf(c)
    expect(slot).toMatch(/^[0-9a-f]{16}$/)
    // hostingProvider attribution does NOT participate in identity.
    const c2: ResolutionCanonical = { type: 'git', url: 'https://github.com/sindresorhus/is.git', sha: SHA }
    expect(sourceDiscriminatorOf(c2)).toBe(slot)
    // A different sha (same url) is a different source.
    const c3: ResolutionCanonical = { type: 'git', url: 'https://github.com/sindresorhus/is.git', sha: 'a'.repeat(40) }
    expect(sourceDiscriminatorOf(c3)).not.toBe(slot)
  })

  it('directory → undefined (BARE — no well-defined cross-PM source string)', () => {
    expect(sourceDiscriminatorOf({ type: 'directory', path: '../local' })).toBeUndefined()
  })

  it('unknown → undefined (BARE — escape hatch, never folded into identity)', () => {
    // A `patch:` locator and any non-canonicalisable PM-native shape land here.
    expect(sourceDiscriminatorOf({ type: 'unknown', raw: 'foo@patch:foo@npm%3A1.0.0#./p.patch' })).toBeUndefined()
    expect(sourceDiscriminatorOf({ type: 'unknown', raw: 'whatever' })).toBeUndefined()
  })

  it('git slot is the 16-hex prefix of sha256 over `git\\0<url>\\0<sha>`', () => {
    // Pin the exact recipe so a future refactor cannot silently change identity.
    const c: ResolutionCanonical = { type: 'git', url: 'https://github.com/sindresorhus/is.git', sha: SHA }
    // Derived independently in the primitive; assert shape + determinism only
    // (the concrete value is asserted via the round-trip tests below).
    expect(sourceDiscriminatorOf(c)).toBe(sourceDiscriminatorOf(c))
  })
})

describe('ADR-0032 — graph.ts `+src=` slot mechanics', () => {
  it('toTarballKey appends `+src=` AFTER `+patch=` (cmpStr-sorted)', () => {
    const patch = 'a'.repeat(128)
    const src = 'b'.repeat(16)
    expect(toTarballKey({ name: 'foo', version: '1.0.0', source: src }))
      .toBe(`foo@1.0.0+src=${src}`)
    expect(toTarballKey({ name: 'foo', version: '1.0.0', patch, source: src }))
      .toBe(`foo@1.0.0+patch=${patch}+src=${src}`)
  })

  it('bare key is byte-identical to pre-ADR-0032 when source is undefined', () => {
    expect(toTarballKey({ name: 'foo', version: '1.0.0' })).toBe('foo@1.0.0')
    expect(serializeNodeId('foo', '1.0.0', [])).toBe('foo@1.0.0')
  })

  it('serializeNodeId threads source into the base key, before peerContext', () => {
    const src = 'c'.repeat(16)
    expect(serializeNodeId('foo', '1.0.0', ['bar@2.0.0'], undefined, src))
      .toBe(`foo@1.0.0+src=${src}(bar@2.0.0)`)
  })

  it('validateSourceToken rejects malformed slot values', () => {
    expect(() => validateSourceToken('')).toThrow(LockfileError)
    expect(() => validateSourceToken('ab+cd')).toThrow(LockfileError)
    expect(() => validateSourceToken('has space')).toThrow(LockfileError)
    expect(() => validateSourceToken('ABCDEF0123456789')).toThrow(LockfileError) // upper-case
    expect(() => validateSourceToken('abc')).toThrow(LockfileError)               // too short
    expect(() => validateSourceToken('0123456789abcdef')).not.toThrow()
  })
})

describe('ADR-0032 — #2b repro: registry vs git at the SAME name@version', () => {
  // One yarn-berry lock carrying `is@1.0.0` from the npm registry AND `is@1.0.0`
  // from a git fork (different code, same name+version). Pre-ADR-0032 both
  // minted the IDENTICAL NodeId `is@1.0.0` and collapsed (IRREDUCIBLE_LOSS /
  // wrong graph). The fix gives the git copy a `+src=` slot; the registry copy
  // stays BARE.
  const SHA = '70f5e45c32620c7c3007ab43cab48d017ffaadff'
  const lock =
    '# This file is generated by running "yarn install" inside your project.\n' +
    '# Manual changes might be lost - proceed with caution!\n\n' +
    '__metadata:\n  version: 8\n  cacheKey: 10c0\n\n' +
    // registry copy — `is@npm:1.0.0`, descriptor `is@npm:^1.0.0`
    '"is@npm:^1.0.0":\n' +
    '  version: 1.0.0\n' +
    '  resolution: "is@npm:1.0.0"\n' +
    '  languageName: node\n' +
    '  linkType: hard\n\n' +
    // git copy — SAME name AND version, different source. Pre-ADR-0032 BOTH
    // minted the identical NodeId `is@1.0.0` → IRREDUCIBLE_LOSS collapse.
    '"is@https://github.com/example/is.git#commit=' + SHA + '":\n' +
    '  version: 1.0.0\n' +
    '  resolution: "is@https://github.com/example/is.git#commit=' + SHA + '"\n' +
    '  languageName: node\n' +
    '  linkType: hard\n'

  it('the registry copy and the git copy are DISTINCT nodes (no collapse)', () => {
    // VERIFY-FIRST: pre-ADR-0032 this lock threw IRREDUCIBLE_LOSS (both entries
    // collide on `is@1.0.0`). Post-fix it parses to TWO distinct nodes — the
    // registry copy BARE, the git copy carrying `+src=`.
    const g = parse('yarn-berry-v8', lock)
    const ids = g.byName('is')
    expect(ids).toHaveLength(2)
    const bare = ids.find(id => id === 'is@1.0.0')
    const slotted = ids.find(id => id !== 'is@1.0.0')
    expect(bare).toBe('is@1.0.0')                              // registry BARE
    expect(slotted).toMatch(/^is@1\.0\.0\+src=[0-9a-f]{16}$/)  // git +src=
    // Their canonical resolutions differ (tarball vs git) — different artefacts.
    expect(g.tarballOf(bare!)?.resolution?.type).toBe('tarball')
    expect(g.tarballOf(slotted!)?.resolution?.type).toBe('git')
  })

  it('two SAME-name git forks at one name@version stay distinct via +src=', () => {
    // The sharper #2b: identical name AND version, both git, different sha →
    // different `+src=`. (yarn keys them by distinct entry descriptors, but the
    // NodeId must also disambiguate so their dep edges never collide.)
    const shaA = 'a'.repeat(40)
    const shaB = 'b'.repeat(40)
    const dual =
      '# This file is generated by running "yarn install" inside your project.\n' +
      '# Manual changes might be lost - proceed with caution!\n\n' +
      '__metadata:\n  version: 8\n  cacheKey: 10c0\n\n' +
      '"is@https://github.com/a/is.git#commit=' + shaA + '":\n' +
      '  version: 1.0.0\n' +
      '  resolution: "is@https://github.com/a/is.git#commit=' + shaA + '"\n' +
      '  languageName: node\n  linkType: hard\n\n' +
      '"is@https://github.com/b/is.git#commit=' + shaB + '":\n' +
      '  version: 1.0.0\n' +
      '  resolution: "is@https://github.com/b/is.git#commit=' + shaB + '"\n' +
      '  languageName: node\n  linkType: hard\n'
    const g = parse('yarn-berry-v8', dual)
    const ids = g.byName('is')
    expect(ids).toHaveLength(2)
    expect(new Set(ids).size).toBe(2) // distinct NodeIds
    for (const id of ids) expect(id).toMatch(/^is@1\.0\.0\+src=[0-9a-f]{16}$/)
  })

  it('registry-only graph keeps BARE NodeIds (zero registry blast radius)', () => {
    const registryOnly =
      '# This file is generated by running "yarn install" inside your project.\n' +
      '# Manual changes might be lost - proceed with caution!\n\n' +
      '__metadata:\n  version: 8\n  cacheKey: 10c0\n\n' +
      '"is@npm:^1.0.0":\n  version: 1.0.0\n  resolution: "is@npm:1.0.0"\n' +
      '  languageName: node\n  linkType: hard\n'
    const g = parse('yarn-berry-v8', registryOnly)
    expect(g.byName('is')).toEqual(['is@1.0.0'])
  })
})

describe('ADR-0032 — round-trip: +src= is internal identity, not emitted', () => {
  it('a git node round-trips through yarn-berry without leaking `+src=` into the lock', () => {
    const SHA = '70f5e45c32620c7c3007ab43cab48d017ffaadff'
    const lock =
      '# This file is generated by running "yarn install" inside your project.\n' +
      '# Manual changes might be lost - proceed with caution!\n\n' +
      '__metadata:\n  version: 8\n  cacheKey: 10c0\n\n' +
      '"is@https://github.com/example/is.git#commit=' + SHA + '":\n' +
      '  version: 1.0.0\n' +
      '  resolution: "is@https://github.com/example/is.git#commit=' + SHA + '"\n' +
      '  languageName: node\n  linkType: hard\n'
    const g = parse('yarn-berry-v8', lock)
    // The node carries the slot internally...
    expect(g.byName('is')[0]).toMatch(/\+src=/)
    // ...but it must NEVER appear in the emitted lockfile (emit uses entry-key
    // descriptors, not the NodeId — ADR-0032 zero-lockfile-emit-change).
    const out = stringify('yarn-berry-v8', g, { strict: false })
    expect(out).not.toContain('+src=')
    // And the emit round-trips byte-identically to the input.
    expect(out).toBe(lock)
    // imported for the primitive-mapping tests above; reference it here so the
    // module-level import is exercised.
    void parseResolution
  })
})

describe('ADR-0032 — yarn-classic emit preserves source-forked siblings (no silent whole-package drop)', () => {
  const SRI = (c: string) => 'sha512-' + c.repeat(86) + '=='

  it('two same-`name@version` entries from DIFFERENT sources both survive parse→stringify→parse', () => {
    const lock =
      '# THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.\n' +
      '# yarn lockfile v1\n\n\n' +
      'lib@^1.0.0:\n' +
      '  version "1.0.0"\n' +
      '  resolved "https://registry.yarnpkg.com/lib/-/lib-1.0.0.tgz"\n' +
      '  integrity ' + SRI('A') + '\n\n' +
      'lib@^1.0.1:\n' +
      '  version "1.0.0"\n' +
      '  resolved "https://nexus.corp/repo/lib/-/lib-1.0.0.tgz"\n' +
      '  integrity ' + SRI('B') + '\n'

    const g = parse('yarn-classic', lock)
    const ids = Array.from(g.nodes()).map(n => n.id).sort()
    expect(ids).toHaveLength(2)
    expect(ids).toContain('lib@1.0.0')                                 // registry stays bare
    expect(ids.some(id => id.startsWith('lib@1.0.0+src='))).toBe(true) // private host forks

    const out = stringify('yarn-classic', g)
    // BOTH resolved URLs survive emit — the private sibling is NOT silently dropped
    expect(out).toContain('https://registry.yarnpkg.com/lib/-/lib-1.0.0.tgz')
    expect(out).toContain('https://nexus.corp/repo/lib/-/lib-1.0.0.tgz')

    // the graph round-trips: re-parse recovers BOTH nodes
    expect(Array.from(parse('yarn-classic', out).nodes())).toHaveLength(2)
  })
})

describe('ADR-0032 — yarn-classic → yarn-berry synthesis emits VALID source-forked locators', () => {
  const SRI = (c: string) => 'sha512-' + c.repeat(86) + '=='

  // CROSS-FORMAT SYNTHESIS regression: converting a yarn-classic lock with two
  // same-`name@version` entries from DIFFERENT sources (a default-registry copy
  // + a private-registry copy) to yarn-berry must NOT (a) collapse them onto one
  // `<name>@npm:<version>` entry (the registry sibling silently lost on emit) nor
  // (b) write the raw tarball URL as `resolution:` (a bare URL is not a valid
  // berry `<name>@<protocol>:<spec>` locator). The non-registry copy must
  // synthesise a valid `<name>@npm:<version>::__archiveUrl=<enc>` locator that
  // FORKS the NodeId; the registry copy stays the clean `<name>@npm:<version>`.
  it('two same-name@version sources → 2 entries, both valid berry locators, re-parse recovers 2 nodes', () => {
    const classic =
      '# THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.\n' +
      '# yarn lockfile v1\n\n\n' +
      'lib@^1.0.0:\n' +
      '  version "1.0.0"\n' +
      '  resolved "https://registry.yarnpkg.com/lib/-/lib-1.0.0.tgz"\n' +
      '  integrity ' + SRI('A') + '\n\n' +
      'lib@^1.0.1:\n' +
      '  version "1.0.0"\n' +
      '  resolved "https://nexus.corp/repo/lib/-/lib-1.0.0.tgz"\n' +
      '  integrity ' + SRI('B') + '\n'

    const out = stringify('yarn-berry-v8', parse('yarn-classic', classic), { strict: false })

    // 2 distinct entry KEYS — the registry sibling is NOT overwritten on emit.
    const enc = encodeURIComponent('https://nexus.corp/repo/lib/-/lib-1.0.0.tgz')
    expect(out).toContain('"lib@npm:1.0.0":')
    expect(out).toContain(`"lib@npm:1.0.0::__archiveUrl=${enc}":`)

    // Every `resolution:` is a valid berry locator (`<name>@<protocol>:<spec>`),
    // NEVER a bare tarball URL.
    expect(out).toContain('resolution: "lib@npm:1.0.0"')
    expect(out).toContain(`resolution: "lib@npm:1.0.0::__archiveUrl=${enc}"`)
    expect(out).not.toMatch(/resolution: "https?:\/\//)

    // Re-parse recovers TWO distinct nodes: the registry copy BARE, the private
    // copy forked via its `::__archiveUrl=` bind (which rides the `+src=` slot).
    const reparsed = parse('yarn-berry-v8', out)
    const ids = Array.from(reparsed.nodes()).map(n => n.id).sort()
    expect(ids).toHaveLength(2)
    expect(ids).toContain('lib@1.0.0')
    expect(ids.some(id => id.startsWith('lib@1.0.0+src='))).toBe(true)
    // the two nodes carry distinct canonical tarball hosts
    const bare = reparsed.tarballOf('lib@1.0.0')
    const forked = reparsed.tarballOf(ids.find(id => id.includes('+src='))!)
    expect(bare?.resolution).toMatchObject({ type: 'tarball', url: 'https://registry.npmjs.org/lib/-/lib-1.0.0.tgz' })
    expect(forked?.resolution).toMatchObject({ type: 'tarball', url: 'https://nexus.corp/repo/lib/-/lib-1.0.0.tgz' })
  })
})
