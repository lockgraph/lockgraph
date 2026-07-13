import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import {
  canonicalHashOfBytes,
  isCanonicalHash,
  isSentinelPatch,
  sentinelHashOf,
  sentinelHashOfLocator,
  validateCanonicalHash,
} from '../../main/ts/recipe/patch.ts'
import {
  dropAllPatchSlots,
  emitDropped,
} from '../../main/ts/recipe/diagnostics.ts'
import type { Diagnostic } from '../../main/ts/graph.ts'
import { newBuilder, toTarballKey } from '../../main/ts/graph.ts'
import { convert, parse, stringify } from '../../main/ts/index.ts'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = (rel: string): string =>
  readFileSync(resolve(here, '../resources/fixtures/lockfiles', rel), 'utf8')
const templateDir = (rel: string): string =>
  resolve(here, '../resources/fixtures/templates', rel)

const PATCH_BYTES = readFileSync(
  resolve(templateDir('patch-yarn'), '.yarn/patches/lodash-npm-4.17.21-6382451519.patch'),
)
const EXPECTED_PATCH_HASH = createHash('sha512').update(PATCH_BYTES).digest('hex')
const patchedNodeId = (name: string, version: string, patch: string): string =>
  toTarballKey({ name, version, patch })

describe('recipe/patch — isCanonicalHash', () => {
  it('accepts exactly 128 lowercase hex chars', () => {
    expect(isCanonicalHash('a'.repeat(128))).toBe(true)
    expect(isCanonicalHash('0123456789abcdef'.repeat(8))).toBe(true)
    expect(isCanonicalHash(EXPECTED_PATCH_HASH)).toBe(true)
  })
  it('rejects wrong length', () => {
    expect(isCanonicalHash('a'.repeat(127))).toBe(false)
    expect(isCanonicalHash('a'.repeat(129))).toBe(false)
    expect(isCanonicalHash('')).toBe(false)
  })
  it('rejects uppercase / non-hex', () => {
    expect(isCanonicalHash('A'.repeat(128))).toBe(false)
    expect(isCanonicalHash('g'.repeat(128))).toBe(false)
  })
  it('rejects sentinel form (different shape per ADR-0011)', () => {
    expect(isCanonicalHash('unresolved-' + 'a'.repeat(64))).toBe(false)
  })
})

describe('recipe/patch — isSentinelPatch', () => {
  it('accepts ADR-0011 sentinel form: unresolved-<sha256-hex>', () => {
    expect(isSentinelPatch('unresolved-' + 'a'.repeat(64))).toBe(true)
    expect(isSentinelPatch('unresolved-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef')).toBe(true)
  })
  it('rejects canonical hash form (different shape)', () => {
    expect(isSentinelPatch('a'.repeat(128))).toBe(false)
  })
  it('rejects wrong sentinel length', () => {
    expect(isSentinelPatch('unresolved-' + 'a'.repeat(63))).toBe(false)
    expect(isSentinelPatch('unresolved-' + 'a'.repeat(65))).toBe(false)
  })
  it('rejects missing prefix', () => {
    expect(isSentinelPatch('a'.repeat(64))).toBe(false)
  })
})

describe('recipe/patch — validateCanonicalHash', () => {
  it('returns the hash verbatim when canonical', () => {
    expect(validateCanonicalHash(EXPECTED_PATCH_HASH)).toBe(EXPECTED_PATCH_HASH)
  })
  it('returns undefined for non-canonical inputs (sentinel, malformed)', () => {
    expect(validateCanonicalHash('unresolved-' + 'a'.repeat(64))).toBeUndefined()
    expect(validateCanonicalHash('not-a-hash')).toBeUndefined()
    expect(validateCanonicalHash('a'.repeat(127))).toBeUndefined()
  })
})

describe('recipe/patch — canonicalHashOfBytes', () => {
  it('computes sha512-hex from raw bytes (F2 r1; F5 byte-normalisation deferred)', () => {
    expect(canonicalHashOfBytes(PATCH_BYTES)).toBe(EXPECTED_PATCH_HASH)
    expect(canonicalHashOfBytes('hello')).toMatch(/^[0-9a-f]{128}$/)
  })
})

describe('recipe/patch — sentinelHashOf', () => {
  it('returns unresolved-<sha256-hex> for any string', () => {
    const sentinel = sentinelHashOf('patch:foo@npm%3A1.0.0#./.yarn/patches/foo.patch')
    expect(sentinel).toMatch(/^unresolved-[0-9a-f]{64}$/)
    expect(isSentinelPatch(sentinel)).toBe(true)
  })
  it('is deterministic per input', () => {
    const a = sentinelHashOf('patch:foo@npm%3A1.0.0#./.yarn/patches/foo.patch')
    const b = sentinelHashOf('patch:foo@npm%3A1.0.0#./.yarn/patches/foo.patch')
    expect(a).toBe(b)
  })
  it('matches sha256(input) byte-for-byte', () => {
    const input = 'lodash@4.17.21:lodash@^4'
    const expected = 'unresolved-' + createHash('sha256').update(input, 'utf8').digest('hex')
    expect(sentinelHashOf(input)).toBe(expected)
  })
  it('sentinelHashOfLocator is the byte-equal alias kept for yarn-berry call sites', () => {
    const s = 'patch:lodash@npm%3A4.17.21#./patches/lodash.patch'
    expect(sentinelHashOfLocator(s)).toBe(sentinelHashOf(s))
  })
})

describe('recipe/patch — emitDropped', () => {
  it('fires RECIPE_FEATURE_DROPPED with subject=nodeId, severity=warning', () => {
    const diags: Diagnostic[] = []
    emitDropped('lodash@4.17.21', 'patch', 'target lacks patch:', d => diags.push(d))
    expect(diags).toHaveLength(1)
    expect(diags[0]).toEqual(
      expect.objectContaining({
        code:     'RECIPE_FEATURE_DROPPED',
        severity: 'warning',
        subject:  'lodash@4.17.21',
      }),
    )
    expect(diags[0]?.message).toContain('patch')
    expect(diags[0]?.message).toContain('target lacks patch:')
  })
  it('is a no-op when onDiagnostic is undefined', () => {
    expect(() => emitDropped('foo@1.0.0', 'patch', 'no callback')).not.toThrow()
  })
})

describe('recipe/patch — dropAllPatchSlots', () => {
  it('fires once per Node.patch !== undefined', () => {
    const b = newBuilder()
    b.addNode({ id: patchedNodeId('a', '1.0.0', 'a'.repeat(128)), name: 'a', version: '1.0.0', peerContext: [], patch: 'a'.repeat(128) })
    b.addNode({ id: patchedNodeId('b', '1.0.0', 'b'.repeat(128)), name: 'b', version: '1.0.0', peerContext: [], patch: 'b'.repeat(128) })
    b.addNode({ id: 'c@1.0.0', name: 'c', version: '1.0.0', peerContext: [] })
    const g = b.seal()
    const diags: Diagnostic[] = []
    dropAllPatchSlots(g, d => diags.push(d))
    expect(diags.map(d => d.subject).sort()).toEqual([
      patchedNodeId('a', '1.0.0', 'a'.repeat(128)),
      patchedNodeId('b', '1.0.0', 'b'.repeat(128)),
    ])
    expect(diags.every(d => d.code === 'RECIPE_FEATURE_DROPPED')).toBe(true)
  })
  it('is a no-op when onDiagnostic is undefined', () => {
    const b = newBuilder()
    b.addNode({ id: patchedNodeId('a', '1.0.0', 'a'.repeat(128)), name: 'a', version: '1.0.0', peerContext: [], patch: 'a'.repeat(128) })
    const g = b.seal()
    expect(() => dropAllPatchSlots(g)).not.toThrow()
  })
})

// === Integration: parse-side patch slot extraction ==========================

describe('recipe/patch — yarn-berry-v9 parse extracts canonical hash from patch fixture', () => {
  it('populates Node.patch with sha512-hex of patch bytes when workspaceRoot supplied', () => {
    const graph = parse('yarn-berry-v9', fixture('patch-yarn/yarn-berry-v9.lock'), {
      workspaceRoot: templateDir('patch-yarn'),
    })
    const lodash = graph.getNode(patchedNodeId('lodash', '4.17.21', EXPECTED_PATCH_HASH))
    expect(lodash?.patch).toBe(EXPECTED_PATCH_HASH)
    expect(isCanonicalHash(lodash!.patch!)).toBe(true)
  })
})

describe('recipe/patch — pnpm-v9 parse extracts canonical hash from overrides block', () => {
  it('populates Node.patch with sha512-hex of patch bytes when workspaceRoot supplied', () => {
    const graph = parse('pnpm-v9', fixture('patch-yarn/pnpm-v9.lock'), {
      workspaceRoot: templateDir('patch-yarn'),
    })
    const lodash = graph.getNode('lodash@4.17.21')
    expect(lodash?.patch).toBe(EXPECTED_PATCH_HASH)
  })
  it('falls back to sentinel when workspaceRoot is absent', () => {
    const graph = parse('pnpm-v9', fixture('patch-yarn/pnpm-v9.lock'))
    const lodash = graph.getNode('lodash@4.17.21')
    expect(lodash?.patch).toMatch(/^unresolved-[0-9a-f]{64}$/)
  })
})

describe('recipe/patch — pnpm-v6 parse extracts canonical hash from overrides block', () => {
  it('populates Node.patch with sha512-hex of patch bytes when workspaceRoot supplied', () => {
    const graph = parse('pnpm-v6', fixture('patch-yarn/pnpm-v6.lock'), {
      workspaceRoot: templateDir('patch-yarn'),
    })
    const lodash = graph.getNode('lodash@4.17.21')
    expect(lodash?.patch).toBe(EXPECTED_PATCH_HASH)
  })
})

// === Integration: cross-format conversion ===================================

describe('recipe/patch — convert preserves the patch slot across supporting pairs', () => {
  it('yarn-berry-v9 → pnpm-v9 — overrides block carries the same canonical hash', async () => {
    const diagnostics: Diagnostic[] = []
    const output = await convert(fixture('patch-yarn/yarn-berry-v9.lock'), {
      from: 'yarn-berry-v9',
      to:   'pnpm-v9',
      strict: false,
      workspaceRoot: templateDir('patch-yarn'),
      onDiagnostic: d => diagnostics.push(d),
    })
    expect(output).toContain('overrides:')
    expect(output).toContain('patch:')
    // Re-parsing the pnpm-v9 output with the same workspaceRoot recovers
    // the canonical hash byte-equal.
    const reparsed = parse('pnpm-v9', output, { workspaceRoot: templateDir('patch-yarn') })
    expect(reparsed.getNode('lodash@4.17.21')?.patch).toBe(EXPECTED_PATCH_HASH)
    // No RECIPE_FEATURE_DROPPED on the patch — both adapters support patches.
    const drops = diagnostics.filter(d => d.code === 'RECIPE_FEATURE_DROPPED')
    expect(drops).toHaveLength(0)
  })
  // OUT-OF-F2-SCOPE: pnpm-v9 → yarn-berry-v9 patch synthesis. The yarn-berry
  // The stringify side reads Node.resolution for the `patch:` locator URL; when
  // the source is pnpm, that locator is not present on the node, and synthesis
  // from scratch needs an additional sidecar bridge to carry the pnpm overrides
  // attribution onto the yarn-berry emit path. Tracked as a follow-up: the
  // F2 forward path (yarn-berry → pnpm) is enough to prove the canonical
  // hash travels through the recipe layer.

})

describe('recipe/patch — convert emits RECIPE_FEATURE_DROPPED when target is patch-incapable', () => {
  it('yarn-berry-v9 → bun-text emits RECIPE_FEATURE_DROPPED for the patched node', async () => {
    const diagnostics: Diagnostic[] = []
    await convert(fixture('patch-yarn/yarn-berry-v9.lock'), {
      from: 'yarn-berry-v9',
      to:   'bun-text',
      strict: false,
      workspaceRoot: templateDir('patch-yarn'),
      onDiagnostic: d => diagnostics.push(d),
    })
    const drops = diagnostics.filter(d => d.code === 'RECIPE_FEATURE_DROPPED' && d.subject === patchedNodeId('lodash', '4.17.21', EXPECTED_PATCH_HASH))
    expect(drops).toHaveLength(1)
  })
  it('yarn-berry-v9 → npm-3 emits RECIPE_FEATURE_DROPPED for the patched node', async () => {
    const diagnostics: Diagnostic[] = []
    await convert(fixture('patch-yarn/yarn-berry-v9.lock'), {
      from: 'yarn-berry-v9',
      to:   'npm-3',
      strict: false,
      workspaceRoot: templateDir('patch-yarn'),
      onDiagnostic: d => diagnostics.push(d),
    })
    const drops = diagnostics.filter(d => d.code === 'RECIPE_FEATURE_DROPPED' && d.subject === patchedNodeId('lodash', '4.17.21', EXPECTED_PATCH_HASH))
    expect(drops).toHaveLength(1)
  })
  it('pnpm-v9 → yarn-classic emits RECIPE_FEATURE_DROPPED for the patched node', async () => {
    const diagnostics: Diagnostic[] = []
    await convert(fixture('patch-yarn/pnpm-v9.lock'), {
      from: 'pnpm-v9',
      to:   'yarn-classic',
      strict: false,
      workspaceRoot: templateDir('patch-yarn'),
      onDiagnostic: d => diagnostics.push(d),
    })
    const drops = diagnostics.filter(d => d.code === 'RECIPE_FEATURE_DROPPED' && d.subject === 'lodash@4.17.21')
    expect(drops).toHaveLength(1)
  })
})

// === B1: pnpm override key grammar (ADR-0011 / pnpm docs) ==================
//
// Three literal-key shapes must be recognised against lodash@4.17.21:
//   - bare       `lodash`           → matches every lodash node
//   - range      `lodash@^4`        → semver-satisfies match
//   - exact      `lodash@4.17.21`   → literal version match
// Plus the `npm:` protocol prefix is admissible on the version half
// (e.g. `lodash@npm:4.17.21`).

const PNPM_V9_WITH_OVERRIDE = (literalKey: string): string => `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

overrides:
  ${literalKey}: patch:lodash@npm%3A4.17.21#./.yarn/patches/lodash-npm-4.17.21-6382451519.patch

importers:

  .:
    dependencies:
      lodash:
        specifier: 4.17.21
        version: 4.17.21

packages:

  lodash@4.17.21:
    resolution: {integrity: sha512-v2kDEe57lecTulaDIuNTPy3Ry4gLGJ6Z1O3vE1krgXZNrsQ+LFTGHVxVjcXPs17LhbZVGedAJv8XZ1tvj5FvSg==}

snapshots:

  lodash@4.17.21: {}
`

describe('recipe/patch — B1: pnpm overrides key grammar', () => {
  for (const [shape, literalKey] of [
    ['bare',           'lodash'],
    ['range',          'lodash@^4'],
    ['exact',          'lodash@4.17.21'],
    ['exact with npm:', 'lodash@npm:4.17.21'],
  ] as const) {
    it(`canonical hash extracted for ${shape} override key ${JSON.stringify(literalKey)}`, () => {
      const graph = parse('pnpm-v9', PNPM_V9_WITH_OVERRIDE(literalKey), {
        workspaceRoot: templateDir('patch-yarn'),
      })
      const lodash = graph.getNode('lodash@4.17.21')
      expect(lodash?.patch).toBe(EXPECTED_PATCH_HASH)
    })

    it(`sentinel fallback uses sha256(<bare-id>:<literal-key>) for ${shape} key`, () => {
      // No workspaceRoot → bytes unreadable → sentinel path.
      const graph = parse('pnpm-v9', PNPM_V9_WITH_OVERRIDE(literalKey))
      const lodash = graph.getNode('lodash@4.17.21')
      const expected = 'unresolved-' + createHash('sha256')
        .update(`lodash@4.17.21:${literalKey}`, 'utf8')
        .digest('hex')
      expect(lodash?.patch).toBe(expected)
    })
  }

  it('non-matching override key leaves Node.patch absent', () => {
    // Range that does NOT cover 4.17.21.
    const graph = parse('pnpm-v9', PNPM_V9_WITH_OVERRIDE('lodash@^5'), {
      workspaceRoot: templateDir('patch-yarn'),
    })
    expect(graph.getNode('lodash@4.17.21')?.patch).toBeUndefined()
  })

  it('non-pnpm override values (string overrides without patch:) are ignored', () => {
    const input = PNPM_V9_WITH_OVERRIDE('lodash@^4').replace(
      'patch:lodash@npm%3A4.17.21#./.yarn/patches/lodash-npm-4.17.21-6382451519.patch',
      '4.17.21',
    )
    const graph = parse('pnpm-v9', input)
    expect(graph.getNode('lodash@4.17.21')?.patch).toBeUndefined()
  })

  it('pnpm-v6 honours the same key grammar (bare key)', () => {
    const v6 = `lockfileVersion: '6.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

overrides:
  lodash: patch:lodash@npm%3A4.17.21#./.yarn/patches/lodash-npm-4.17.21-6382451519.patch

dependencies:
  lodash:
    specifier: 4.17.21
    version: 4.17.21

packages:

  /lodash@4.17.21:
    resolution: {integrity: sha512-v2kDEe57lecTulaDIuNTPy3Ry4gLGJ6Z1O3vE1krgXZNrsQ+LFTGHVxVjcXPs17LhbZVGedAJv8XZ1tvj5FvSg==}
    dev: false
`
    const graph = parse('pnpm-v6', v6, { workspaceRoot: templateDir('patch-yarn') })
    expect(graph.getNode('lodash@4.17.21')?.patch).toBe(EXPECTED_PATCH_HASH)
  })

  it('round-trip: parse → stringify keeps overrides covering the patched node', () => {
    const graph = parse('pnpm-v9', PNPM_V9_WITH_OVERRIDE('lodash@^4'), {
      workspaceRoot: templateDir('patch-yarn'),
    })
    const out = stringify('pnpm-v9', graph, { strict: false })
    // Either the original `^4` override is preserved verbatim or a
    // synthesised `lodash@npm:4.17.21` entry covers the patched node —
    // either way the overrides block carries a patch: entry.
    expect(out).toMatch(/overrides:[\s\S]+patch:/)
  })
})

// === B1/B2 semver edge cases (build metadata + prerelease) ================
//
// Override-key matching must:
//   - preserve build metadata in exact keys (`foo@1.2.3+build.1`),
//   - default to semver-standard prerelease exclusion for plain ranges
//     (`foo@^1.2.3` MUST NOT pick up `1.3.0-beta.1`),
//   - admit prereleases when the range itself names one (`foo@^1.2.3-beta`).
//
// Fixtures synthesise a single-node graph at the target version and an
// `overrides:` block carrying the key under test.

const PNPM_V9_FOR = (literalKey: string, version: string, integrity = 'sha512-' + 'a'.repeat(86) + '==') => `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

overrides:
  ${literalKey}: patch:lodash@npm%3A4.17.21#./.yarn/patches/lodash-npm-4.17.21-6382451519.patch

importers:

  .:
    dependencies:
      foo:
        specifier: ${version}
        version: ${version}

packages:

  foo@${version}:
    resolution: {integrity: ${integrity}}

snapshots:

  foo@${version}: {}
`

describe('recipe/patch — B1/B2: semver edge cases in pnpm override keys', () => {
  it('B1: exact key with build metadata matches the literal version', () => {
    const graph = parse('pnpm-v9', PNPM_V9_FOR('foo@1.2.3+build.1', '1.2.3+build.1'), {
      workspaceRoot: templateDir('patch-yarn'),
    })
    expect(graph.getNode('foo@1.2.3+build.1')?.patch).toBe(EXPECTED_PATCH_HASH)
  })

  it('B1: exact key with build metadata does NOT match the plain version (different build)', () => {
    const graph = parse('pnpm-v9', PNPM_V9_FOR('foo@1.2.3+build.1', '1.2.3'), {
      workspaceRoot: templateDir('patch-yarn'),
    })
    expect(graph.getNode('foo@1.2.3')?.patch).toBeUndefined()
  })

  it('B1: exact key with build metadata does NOT match a different build', () => {
    const graph = parse('pnpm-v9', PNPM_V9_FOR('foo@1.2.3+build.1', '1.2.3+other'), {
      workspaceRoot: templateDir('patch-yarn'),
    })
    expect(graph.getNode('foo@1.2.3+other')?.patch).toBeUndefined()
  })

  it('B2: plain caret range does NOT patch a prerelease node', () => {
    const graph = parse('pnpm-v9', PNPM_V9_FOR('foo@^1.2.3', '1.3.0-beta.1'), {
      workspaceRoot: templateDir('patch-yarn'),
    })
    expect(graph.getNode('foo@1.3.0-beta.1')?.patch).toBeUndefined()
  })

  it('B2: plain caret range DOES patch a non-prerelease node within range', () => {
    const graph = parse('pnpm-v9', PNPM_V9_FOR('foo@^1.2.3', '1.4.0'), {
      workspaceRoot: templateDir('patch-yarn'),
    })
    expect(graph.getNode('foo@1.4.0')?.patch).toBe(EXPECTED_PATCH_HASH)
  })

  // Per semver spec, a range that names a prerelease admits OTHER
  // prereleases only when they share the same [major, minor, patch]
  // tuple as a comparator in the range. `^1.2.3-beta` therefore admits
  // `1.2.3-beta.5` (same tuple) but NOT `1.3.0-beta.1` (different tuple).
  it('B2: range with explicit prerelease tag DOES patch a prerelease in the same tuple', () => {
    const graph = parse('pnpm-v9', PNPM_V9_FOR('foo@^1.2.3-beta', '1.2.3-beta.5'), {
      workspaceRoot: templateDir('patch-yarn'),
    })
    expect(graph.getNode('foo@1.2.3-beta.5')?.patch).toBe(EXPECTED_PATCH_HASH)
  })
})
