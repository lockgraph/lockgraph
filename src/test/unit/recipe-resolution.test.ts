import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import {
  isCanonical,
  isUnknown,
  parse as parseResolution,
  stringifyForNpm,
  stringifyForPnpm,
  stringifyForYarnBerry,
  stringifyForYarnClassic,
  type ResolutionCanonical,
} from '../../main/ts/recipe/resolution.ts'
import { emitUnknownResolution } from '../../main/ts/recipe/diagnostics.ts'
import type { Diagnostic } from '../../main/ts/graph.ts'
import { convert, parse, stringify } from '../../main/ts/index.ts'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = (rel: string): string =>
  readFileSync(resolve(here, '../resources/fixtures/lockfiles', rel), 'utf8')

// === Primitive — parse ======================================================

describe('recipe/resolution — parse tarball case', () => {
  it('npmjs registry URL → tarball canonical', () => {
    const c = parseResolution('https://registry.npmjs.org/ms/-/ms-2.1.3.tgz', { sourceKind: 'npm-resolved' })
    expect(c).toEqual({ type: 'tarball', url: 'https://registry.npmjs.org/ms/-/ms-2.1.3.tgz' })
  })
  it('yarnpkg URL with sha1 fragment → strips fragment to tarball', () => {
    const c = parseResolution(
      'https://registry.yarnpkg.com/ms/-/ms-2.1.3.tgz#574c8138ce1d2b5861f0b44579dbadd60c6615b2',
      { sourceKind: 'yarn-classic-resolved' },
    )
    expect(c).toEqual({ type: 'tarball', url: 'https://registry.yarnpkg.com/ms/-/ms-2.1.3.tgz' })
  })
  it('yarn-berry `<n>@npm:<ver>` locator → tarball with npmjs default URL', () => {
    const c = parseResolution('ms@npm:2.1.3', { sourceKind: 'yarn-berry-locator', name: 'ms' })
    expect(c).toEqual({
      type: 'tarball',
      url:  'https://registry.npmjs.org/ms/-/ms-2.1.3.tgz',
    })
  })
  it('yarn-berry scoped alias `<n>@npm:<scope/pkg>@<ver>` derives URL on aliased package', () => {
    const c = parseResolution('debug-alias@npm:debug@4.3.4', { sourceKind: 'yarn-berry-locator', name: 'debug-alias' })
    expect(c).toEqual({
      type: 'tarball',
      url:  'https://registry.npmjs.org/debug/-/debug-4.3.4.tgz',
    })
  })
})

describe('recipe/resolution — parse git case', () => {
  it('codeload-tarball → git canonical with upstream URL + sha + github hint', () => {
    const c = parseResolution(
      'https://codeload.github.com/sindresorhus/is/tar.gz/47f49741eacf0a3678684738159a87c2011bb026',
      { sourceKind: 'yarn-classic-resolved' },
    )
    expect(c).toEqual({
      type: 'git',
      url:  'https://github.com/sindresorhus/is.git',
      sha:  '47f49741eacf0a3678684738159a87c2011bb026',
      hostingProvider: 'github',
    })
  })
  it('codeload-tarball with `#commit=<sha>` fragment → upstream URL + fragment-sha wins', () => {
    // Bug repro (codex r2 B1): the `#commit=<sha>` form was falling through to
    // the generic fragment path, keeping the codeload URL verbatim. After r3
    // fix, fragment shape lifts to upstream URL identically.
    const c = parseResolution(
      'https://codeload.github.com/sindresorhus/is/tar.gz/47f49741eacf0a3678684738159a87c2011bb026#commit=70f5e45c32620c7c3007ab43cab48d017ffaadff',
      { sourceKind: 'yarn-classic-resolved' },
    )
    expect(c).toEqual({
      type: 'git',
      url:  'https://github.com/sindresorhus/is.git',
      // explicit `#commit=<sha2>` fragment wins over the URL-path sha
      // (matches yarn-berry locator intent).
      sha:  '70f5e45c32620c7c3007ab43cab48d017ffaadff',
      hostingProvider: 'github',
    })
  })
  it('git+https://<host>/...#<sha> → git canonical', () => {
    const c = parseResolution(
      'git+https://github.com/sindresorhus/is.git#47f49741eacf0a3678684738159a87c2011bb026',
      { sourceKind: 'npm-resolved' },
    )
    expect(c).toEqual({
      type: 'git',
      url:  'https://github.com/sindresorhus/is.git',
      sha:  '47f49741eacf0a3678684738159a87c2011bb026',
      hostingProvider: 'github',
    })
  })
  it('git+ssh://git@<host>/...#<sha> → git canonical', () => {
    const c = parseResolution(
      'git+ssh://git@github.com/sindresorhus/is.git#47f49741eacf0a3678684738159a87c2011bb026',
      { sourceKind: 'npm-resolved' },
    )
    expect(c).toEqual({
      type: 'git',
      url:  'ssh://git@github.com/sindresorhus/is.git',
      sha:  '47f49741eacf0a3678684738159a87c2011bb026',
      hostingProvider: 'github',
    })
  })
  it('yarn-berry git locator with `#commit=<sha>` fragment → git canonical', () => {
    const c = parseResolution(
      'is-git@https://github.com/sindresorhus/is.git#commit=70f5e45c32620c7c3007ab43cab48d017ffaadff',
      { sourceKind: 'yarn-berry-locator', name: 'is-git' },
    )
    expect(c).toEqual({
      type: 'git',
      url:  'https://github.com/sindresorhus/is.git',
      sha:  '70f5e45c32620c7c3007ab43cab48d017ffaadff',
      hostingProvider: 'github',
    })
  })
  it('gitlab hostingProvider detection', () => {
    const c = parseResolution(
      'git+https://gitlab.com/owner/repo.git#abcdef1234567890',
      { sourceKind: 'npm-resolved' },
    )
    expect((c as { hostingProvider?: string }).hostingProvider).toBe('gitlab')
  })
})

describe('recipe/resolution — workspace shapes BYPASS the primitive', () => {
  // Per ADR-0014 §4.F3 (narrowed to 4 cases): workspace identity is NOT part
  // of F3 canonical — it lives on `Node.workspacePath`. Adapters detect
  // workspace shape ahead of time and route around the primitive. When a
  // workspace-shaped string reaches the primitive defensively, it falls back
  // to `unknown` rather than synthesising a (now-absent) workspace canonical.
  it('yarn-berry `<n>@workspace:<path>` reaches `unknown` (adapter expected to bypass)', () => {
    const c = parseResolution('case-root@workspace:.', { sourceKind: 'yarn-berry-locator', name: 'case-root' })
    expect(c.type).toBe('unknown')
  })
  it('pnpm `link:./../sibling` reaches `unknown` (adapter expected to bypass)', () => {
    // `link:` is not handled at the primitive — pnpm-flat-core detects it
    // earlier and threads workspace via Node.workspacePath instead.
    const c = parseResolution('link:./../shared', { sourceKind: 'pnpm-tarball' })
    expect(c.type).toBe('unknown')
  })
  it('yarn-berry adapter does not synthesise a workspace tarball entry', () => {
    // Integration check: workspace member entries land on Node.workspacePath,
    // never on TarballPayload.resolution (the F3 canonical carrier).
    const g = parse('yarn-berry-v9', fixture('simple/yarn-berry-v9.lock'))
    expect(g.tarball({ name: 'case-simple', version: '0.0.0-use.local' })).toBeUndefined()
  })
})

describe('recipe/resolution — parse directory case', () => {
  it('npm `file:./<path>` non-workspace → directory canonical', () => {
    const c = parseResolution('file:./vendor/local-pkg', { sourceKind: 'npm-resolved' })
    expect(c).toEqual({ type: 'directory', path: './vendor/local-pkg' })
  })
  it('yarn-berry `<n>@portal:<path>` → directory canonical', () => {
    const c = parseResolution('foo@portal:./../some/dir', { sourceKind: 'yarn-berry-locator', name: 'foo' })
    expect(c).toEqual({ type: 'directory', path: './../some/dir' })
  })
})

describe('recipe/resolution — parse unknown case', () => {
  it('garbage string → unknown', () => {
    const c = parseResolution('this-is-not-a-resolution', { sourceKind: 'npm-resolved' })
    expect(c).toEqual({ type: 'unknown', raw: 'this-is-not-a-resolution' })
  })
  it('patch: locator preserved verbatim as unknown', () => {
    const raw = 'lodash@patch:lodash@npm%3A4.17.21#./.yarn/patches/lodash.patch::version=4.17.21'
    const c = parseResolution(raw, { sourceKind: 'yarn-berry-locator', name: 'lodash' })
    expect(c).toEqual({ type: 'unknown', raw })
  })
})

// === Primitive — predicates / emit ==========================================

describe('recipe/resolution — isCanonical predicate', () => {
  it('accepts valid tarball / git / directory / unknown (4-case canonical)', () => {
    expect(isCanonical({ type: 'tarball', url: 'x' })).toBe(true)
    expect(isCanonical({ type: 'git', url: 'x', sha: 'y' })).toBe(true)
    expect(isCanonical({ type: 'directory', path: '.' })).toBe(true)
    expect(isCanonical({ type: 'unknown', raw: 'x' })).toBe(true)
  })
  it('rejects shape mismatches (workspace is no longer canonical)', () => {
    expect(isCanonical(null)).toBe(false)
    expect(isCanonical(undefined)).toBe(false)
    expect(isCanonical({ type: 'tarball' })).toBe(false)
    expect(isCanonical({ type: 'foo', url: 'x' })).toBe(false)
    expect(isCanonical({ type: 'workspace', path: '.' })).toBe(false)
  })
})

describe('recipe/resolution — isUnknown discriminator', () => {
  it('narrows to unknown variant', () => {
    expect(isUnknown({ type: 'unknown', raw: 'x' })).toBe(true)
    expect(isUnknown({ type: 'tarball', url: 'x' })).toBe(false)
  })
})

describe('recipe/resolution — emitUnknownResolution', () => {
  it('emits RECIPE_RESOLUTION_UNKNOWN with warning severity', () => {
    const diags: Diagnostic[] = []
    emitUnknownResolution('foo@1.0.0', 'garbage', d => diags.push(d))
    expect(diags).toHaveLength(1)
    expect(diags[0]).toMatchObject({
      code:     'RECIPE_RESOLUTION_UNKNOWN',
      severity: 'warning',
      subject:  'foo@1.0.0',
    })
    expect(diags[0]?.message).toContain('garbage')
  })
  it('is a no-op when onDiagnostic is undefined', () => {
    expect(() => emitUnknownResolution('foo@1.0.0', 'x')).not.toThrow()
  })
})

// === Primitive — per-target stringify =======================================

describe('recipe/resolution — stringifyForYarnBerry', () => {
  it('tarball → `<n>@npm:<ver>` locator', () => {
    const can: ResolutionCanonical = { type: 'tarball', url: 'https://registry.npmjs.org/ms/-/ms-2.1.3.tgz' }
    expect(stringifyForYarnBerry(can, { name: 'ms', version: '2.1.3' }))
      .toBe('ms@npm:2.1.3')
  })
  it('git → `<n>@<url>#commit=<sha>` locator', () => {
    const can: ResolutionCanonical = {
      type: 'git',
      url:  'https://github.com/sindresorhus/is.git',
      sha:  '70f5e45c',
      hostingProvider: 'github',
    }
    expect(stringifyForYarnBerry(can, { name: 'is', version: '6.3.1' }))
      .toBe('is@https://github.com/sindresorhus/is.git#commit=70f5e45c')
  })
  it('directory → `<n>@portal:<path>` locator', () => {
    expect(stringifyForYarnBerry({ type: 'directory', path: './vendor/foo' }, { name: 'foo', version: '1.0.0' }))
      .toBe('foo@portal:./vendor/foo')
  })
  it('unknown → raw verbatim', () => {
    const raw = 'foo@some-weird-protocol:opaque-spec'
    expect(stringifyForYarnBerry({ type: 'unknown', raw }, { name: 'foo', version: '1.0.0' }))
      .toBe(raw)
  })
})

describe('recipe/resolution — stringifyForYarnClassic', () => {
  it('tarball → bare URL (or with sha1 fragment when sidecar present)', () => {
    expect(stringifyForYarnClassic({ type: 'tarball', url: 'https://x.tgz' }))
      .toBe('https://x.tgz')
    expect(stringifyForYarnClassic({ type: 'tarball', url: 'https://x.tgz' }, { sha1Fragment: 'a'.repeat(40) }))
      .toBe(`https://x.tgz#${'a'.repeat(40)}`)
  })
  it('git github → codeload tarball form', () => {
    const can: ResolutionCanonical = {
      type: 'git',
      url:  'https://github.com/owner/repo.git',
      sha:  'abcdef',
      hostingProvider: 'github',
    }
    expect(stringifyForYarnClassic(can))
      .toBe('https://codeload.github.com/owner/repo/tar.gz/abcdef')
  })
  it('directory → `file:./<path>`', () => {
    expect(stringifyForYarnClassic({ type: 'directory', path: 'vendor/foo' }))
      .toBe('file:./vendor/foo')
  })
})

describe('recipe/resolution — stringifyForNpm', () => {
  it('tarball → URL', () => {
    expect(stringifyForNpm({ type: 'tarball', url: 'https://x.tgz' })).toBe('https://x.tgz')
  })
  it('git → re-prefixes `git+`', () => {
    expect(stringifyForNpm({ type: 'git', url: 'https://github.com/o/r.git', sha: 'abc' }))
      .toBe('git+https://github.com/o/r.git#abc')
  })
  it('directory → `file:<path>`', () => {
    expect(stringifyForNpm({ type: 'directory', path: 'vendor/foo' }))
      .toBe('file:vendor/foo')
  })
})

describe('recipe/resolution — stringifyForPnpm', () => {
  it('tarball → { tarball: <url> }', () => {
    expect(stringifyForPnpm({ type: 'tarball', url: 'https://x.tgz' }))
      .toEqual({ tarball: 'https://x.tgz' })
  })
  it('git github → { tarball: <codeload-form> }', () => {
    expect(stringifyForPnpm({ type: 'git', url: 'https://github.com/o/r.git', sha: 'abc', hostingProvider: 'github' }))
      .toEqual({ tarball: 'https://codeload.github.com/o/r/tar.gz/abc' })
  })
  it('directory → { directory: <path> }', () => {
    expect(stringifyForPnpm({ type: 'directory', path: 'vendor/foo' }))
      .toEqual({ directory: 'vendor/foo' })
  })
  it('unknown → { extra: { tarball: <raw> } }', () => {
    expect(stringifyForPnpm({ type: 'unknown', raw: 'opaque' }))
      .toEqual({ extra: { tarball: 'opaque' } })
  })
})

// === Integration — adapter parse populates payload.resolution ===============

describe('recipe/resolution — yarn-classic parse populates canonical', () => {
  it('registry tarball with sha1 fragment → canonical tarball (frag stripped)', () => {
    const g = parse('yarn-classic', fixture('simple/yarn-classic.lock'))
    const payload = g.tarball({ name: 'ms', version: '2.1.3' })
    expect(payload?.resolution).toEqual({
      type: 'tarball',
      url:  'https://registry.yarnpkg.com/ms/-/ms-2.1.3.tgz',
    })
  })
  it('codeload-tarball form → canonical git', () => {
    const g = parse('yarn-classic', fixture('git-github-tarball/yarn-classic.lock'))
    const payload = g.tarball({ name: 'is-github', version: '6.3.1' })
    expect(payload?.resolution).toMatchObject({
      type: 'git',
      url:  'https://github.com/sindresorhus/is.git',
      hostingProvider: 'github',
    })
  })
})

describe('recipe/resolution — yarn-berry-v9 parse populates canonical', () => {
  it('npm: locator → canonical tarball (npmjs default URL)', () => {
    const g = parse('yarn-berry-v9', fixture('simple/yarn-berry-v9.lock'))
    const payload = g.tarball({ name: 'ms', version: '2.1.3' })
    expect(payload?.resolution).toEqual({
      type: 'tarball',
      url:  'https://registry.npmjs.org/ms/-/ms-2.1.3.tgz',
    })
  })
  it('workspace member: no tarball entry (workspace canonical not stored on payload)', () => {
    const g = parse('yarn-berry-v9', fixture('simple/yarn-berry-v9.lock'))
    expect(g.tarball({ name: 'case-simple', version: '0.0.0-use.local' })).toBeUndefined()
  })
})

describe('recipe/resolution — pnpm-v9 parse populates canonical', () => {
  it('registry tarball with integrity → canonical tarball', () => {
    const g = parse('pnpm-v9', fixture('simple/pnpm-v9.lock'))
    const payload = g.tarball({ name: 'ms', version: '2.1.3' })
    expect(payload?.resolution?.type).toBe('tarball')
  })
})

describe('recipe/resolution — npm-3 parse populates canonical', () => {
  it('registry tarball → canonical tarball', () => {
    const g = parse('npm-3', fixture('simple/npm-3.lock'))
    const payload = g.tarball({ name: 'ms', version: '2.1.3' })
    expect(payload?.resolution).toEqual({
      type: 'tarball',
      url:  'https://registry.npmjs.org/ms/-/ms-2.1.3.tgz',
    })
  })
  it('git+ssh URL → canonical git', () => {
    const g = parse('npm-3', fixture('git-github-tarball/npm-3.lock'))
    const payload = g.tarball({ name: '@sindresorhus/is', version: '6.3.1' })
    expect(payload?.resolution).toMatchObject({
      type: 'git',
      sha:  '47f49741eacf0a3678684738159a87c2011bb026',
      hostingProvider: 'github',
    })
  })
})

// === Integration — cross-format conversion ==================================

describe('recipe/resolution — convert yarn-berry-v9 → pnpm-v9 preserves resolution canonical', () => {
  it('tarball resolution survives the pair', () => {
    const output = convert(fixture('simple/yarn-berry-v9.lock'), { from: 'yarn-berry-v9', to: 'pnpm-v9' })
    const g = parse('pnpm-v9', output)
    const payload = g.tarball({ name: 'ms', version: '2.1.3' })
    expect(payload?.resolution?.type).toBe('tarball')
  })
})

describe('recipe/resolution — convert npm-3 → yarn-berry-v9 preserves git canonical', () => {
  it('git resolution survives the pair as canonical', () => {
    const output = convert(fixture('git-github-tarball/npm-3.lock'), { from: 'npm-3', to: 'yarn-berry-v9' })
    const g = parse('yarn-berry-v9', output)
    // The npm graph collapsed git aliases onto `@sindresorhus/is@6.3.1`.
    const payload = g.tarball({ name: '@sindresorhus/is', version: '6.3.1' })
    expect(payload?.resolution?.type).toBe('git')
    expect((payload?.resolution as { sha?: string }).sha)
      .toBe('47f49741eacf0a3678684738159a87c2011bb026')
  })
})

describe('recipe/resolution — RECIPE_RESOLUTION_UNKNOWN diagnostic surface', () => {
  it('primitive returns unknown for unrecognised yarn-berry locator protocol', () => {
    // `weird:` is not a recognised protocol; falls through URL detection and
    // ends as `unknown` at the recipe-primitive level.
    const c = parseResolution('foo@weird:opaque-spec', { sourceKind: 'yarn-berry-locator', name: 'foo' })
    expect(isUnknown(c)).toBe(true)
  })
  it('primitive returns unknown for non-canonicalisable bare strings', () => {
    const c = parseResolution('plain-not-a-url', { sourceKind: 'npm-resolved' })
    expect(isUnknown(c)).toBe(true)
  })
  it('emitUnknownResolution fires RECIPE_RESOLUTION_UNKNOWN at warning severity', () => {
    const diags: Diagnostic[] = []
    emitUnknownResolution('opaque@1.0.0', 'opaque-spec', d => diags.push(d))
    expect(diags).toHaveLength(1)
    expect(diags[0]?.code).toBe('RECIPE_RESOLUTION_UNKNOWN')
    expect(diags[0]?.severity).toBe('warning')
  })
  it('npm parse surfaces RECIPE_RESOLUTION_UNKNOWN on garbage `resolved`', () => {
    // npm-3 lockfile с deliberately garbage `resolved` URL — parse via the
    // public surface and assert the recipe-level diagnostic fires.
    const lockfile = JSON.stringify({
      name: 'case',
      version: '0.0.0',
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': { name: 'case', version: '0.0.0' },
        'node_modules/garbage': {
          version: '1.0.0',
          resolved: 'this-is-not-a-recognisable-url',
          integrity: 'sha512-' + 'A'.repeat(86) + '==',
        },
      },
    })
    const diags: Diagnostic[] = []
    parse('npm-3', lockfile, { onDiagnostic: d => diags.push(d) })
    expect(diags.some(d => d.code === 'RECIPE_RESOLUTION_UNKNOWN')).toBe(true)
  })
})

// === Cross-format conversion — additional pairs =============================

describe('recipe/resolution — convert pnpm-v9 → npm-3 (link: workspace) preserves workspace membership', () => {
  it('subtype link degrades to standard workspace member on npm side', () => {
    const diags: Diagnostic[] = []
    const output = convert(fixture('workspace-cross-refs/pnpm-v9.lock'), {
      from: 'pnpm-v9',
      to:   'npm-3',
      onDiagnostic: d => diags.push(d),
    })
    // npm-3 stringify produces JSON with a `packages` block that includes
    // workspace member entries (link: true + resolved: <wsPath>). The
    // workspace canonical survives the convert; subtype 'link' has no
    // dedicated representation on the npm side и degrades silently.
    expect(output).toContain('"packages"')
    expect(output).toMatch(/"link":\s*true/)
  })
})

describe('recipe/resolution — convert yarn-berry-v8 → bun-text drops URL but preserves integrity', () => {
  it('git canonical drops с RECIPE_FEATURE_DROPPED on bun-text', () => {
    const diags: Diagnostic[] = []
    convert(fixture('git-github-tarball/yarn-berry-v8.lock'), {
      from: 'yarn-berry-v8',
      to:   'bun-text',
      onDiagnostic: d => diags.push(d),
    })
    // git resolution case on bun-text → RECIPE_FEATURE_DROPPED warning.
    const drops = diags.filter(d => d.code === 'RECIPE_FEATURE_DROPPED'
      && typeof d.message === 'string'
      && d.message.startsWith('git dropped'))
    expect(drops.length).toBeGreaterThan(0)
  })
  it('registry tarball: URL not emitted (positional slot); integrity preserved', () => {
    const output = convert(fixture('simple/yarn-berry-v9.lock'), {
      from: 'yarn-berry-v9',
      to:   'bun-text',
    })
    // bun-text positional slot 4 carries integrity; URL never appears.
    expect(output).toContain('sha512-')
    expect(output).not.toContain('registry.npmjs.org')
    // Re-parse и confirm the integrity round-trips.
    const g = parse('bun-text', output)
    expect(g.tarball({ name: 'ms', version: '2.1.3' })?.integrity).toMatch(/^sha512-/)
  })
})

describe('recipe/resolution — npm-1 cross-format wiring', () => {
  it('parse populates canonical from `resolved` URL', () => {
    const g = parse('npm-1', fixture('simple/npm-1.lock'))
    const payload = g.tarball({ name: 'ms', version: '2.1.3' })
    expect(payload?.resolution).toEqual({
      type: 'tarball',
      url:  'https://registry.npmjs.org/ms/-/ms-2.1.3.tgz',
    })
  })
  it('npm-3 → npm-1 convert: canonical survives the pair (URL re-emitted)', () => {
    const output = convert(fixture('simple/npm-3.lock'), { from: 'npm-3', to: 'npm-1' })
    expect(output).toContain('"resolved":')
    expect(output).toContain('registry.npmjs.org/ms')
  })
  it('npm-1 workspace member emits RECIPE_FEATURE_DROPPED (workspace)', () => {
    const diags: Diagnostic[] = []
    // Synthesise a graph с a workspace member by parsing pnpm and converting к npm-1.
    convert(fixture('workspace-cross-refs/pnpm-v9.lock'), {
      from: 'pnpm-v9',
      to:   'npm-1',
      onDiagnostic: d => diags.push(d),
    })
    const wsDrops = diags.filter(d => d.code === 'RECIPE_FEATURE_DROPPED'
      && typeof d.message === 'string' && d.message.startsWith('workspace dropped'))
    expect(wsDrops.length).toBeGreaterThan(0)
  })
})

describe('recipe/resolution — yarn-classic codeload canonical projects к npm git+ shape', () => {
  it('yarn-classic codeload → npm-3 emits git+https URL with sha fragment', () => {
    const out = convert(fixture('git-github-tarball/yarn-classic.lock'), {
      from: 'yarn-classic',
      to:   'npm-3',
    })
    // The codeload tarball form parsed → git canonical → npm-3 stringify
    // re-emits as `git+https://github.com/...#<sha>`. Substring assertion
    // tolerates the surrounding JSON quoting.
    expect(out).toContain('git+https://github.com/sindresorhus/is.git#47f49741eacf0a3678684738159a87c2011bb026')
  })
})
