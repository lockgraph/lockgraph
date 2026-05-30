// ADR-0025 §3 — F6 manifest override capture primitive.
//
// Covers (a) each PM grammar rule in isolation (synthetic cases), (b) the
// scoped-name + version-split edge, (c) RECIPE_OVERRIDE_NORMALISED emission,
// and (d) real-manifest capture against the directus (pnpm, 22) / storybook
// (yarn, 18) / vscode (npm, 5) fixture package.json files — asserting the
// canonical entry count, representative entries, and verbatim `native.*`.

import { describe, expect, it } from 'vitest'
import {
  captureOverrides,
  noteYarnOverridesNotProjected,
  projectOverrides,
  splitNameVersion,
  type CapturedOverrides,
} from '../../main/ts/recipe/overrides.ts'
import { recipeOverrideNormalised } from '../../main/ts/recipe/diagnostics.ts'
import type { Diagnostic, OverrideConstraint } from '../../main/ts/graph.ts'

// Real override blocks copied VERBATIM from the committed real-world fixture
// package.json files (the load-bearing data those manifests carry):
//   - directus/directus  main@4290f6e   `pnpm.overrides`     (22 entries)
//   - storybookjs/storybook next@d6ce689 `resolutions`        (18 entries)
//   - microsoft/vscode   main@ddd12d5   `overrides`          (5 entries)
// Inlined rather than file-read so this primitive's unit suite stays
// self-contained and independent of the heavyweight real-world fixture
// scan (which expects lockfiles, not bare package.json, in those dirs).
const DIRECTUS_PNPM_OVERRIDES: Record<string, string> = {
  '@directus/license>@directus/types': 'workspace:*',
  'fast-xml-parser': '5.8.0',
  '@yarnpkg/shell>cross-spawn': '7.0.6',
  tar: '7.5.15',
  qs: '6.15.2',
  'minimatch@10': '10.2.5',
  'minimatch@9': '9.0.9',
  'basic-ftp': '5.3.1',
  underscore: '1.13.8',
  flatted: '3.4.2',
  'express@4>path-to-regexp': '0.1.13',
  'micromatch>picomatch': '2.3.2',
  'anymatch>picomatch': '2.3.2',
  picomatch: '4.0.4',
  defu: '6.1.7',
  'unplugin-vue>vite': '8.0.14',
  'vitest@3>vite': '7.3.2',
  protobufjs: '7.5.6',
  'js-beautify>js-cookie': '3.0.7',
  'pm2-sysmonit>systeminformation': '5.31.6',
  'ajv>fast-uri': '3.1.2',
  'braintrust>simple-git': '3.36.0',
}

const STORYBOOK_RESOLUTIONS: Record<string, string> = {
  '@babel/runtime': 'latest',
  '@babel/traverse': 'latest',
  '@babel/types': '^7.28.4',
  '@playwright/test': '1.58.2',
  '@testing-library/user-event@npm:^14.4.0':
    'patch:@testing-library/user-event@npm%3A14.6.1#~/.yarn/patches/@testing-library-user-event-npm-14.6.1-5da7e1d4e2.patch',
  '@testing-library/user-event@npm:^14.6.1':
    'patch:@testing-library/user-event@npm%3A14.6.1#~/.yarn/patches/@testing-library-user-event-npm-14.6.1-5da7e1d4e2.patch',
  '@types/babel__traverse@npm:*':
    'patch:@types/babel__traverse@npm%3A7.20.6#~/.yarn/patches/@types-babel__traverse-npm-7.20.6-fac4243243.patch',
  '@types/babel__traverse@npm:^7.18.0':
    'patch:@types/babel__traverse@npm%3A7.20.6#~/.yarn/patches/@types-babel__traverse-npm-7.20.6-fac4243243.patch',
  '@types/node': '^22.19.1',
  '@types/react': '^18.0.0',
  '@vitest/expect@npm:3.2.4':
    'patch:@vitest/expect@npm%3A3.2.4#~/.yarn/patches/@vitest-expect-npm-3.2.4-97c526d5cc.patch',
  'aria-query@5.3.0': '^5.3.0',
  esbuild: '^0.27.0',
  playwright: '1.58.2',
  'playwright-core': '1.58.2',
  react: '^18.2.0',
  'react-joyride/type-fest': '~2.19',
  typescript: '^5.9.3',
}

const VSCODE_OVERRIDES: Record<string, unknown> = {
  'node-gyp-build': '4.8.1',
  'kerberos@2.1.1': { 'node-addon-api': '7.1.0' },
  'serialize-javascript': '^7.0.3',
  ssh2: { 'cpu-features': '0.0.0' },
  yauzl: '^3.3.1',
}

// Find the single canonical entry matching a (package[, parentPath]) selector.
const find = (
  cs: OverrideConstraint[],
  pkg: string,
  parentPath?: string[],
): OverrideConstraint | undefined =>
  cs.find(
    c =>
      c.package === pkg &&
      JSON.stringify(c.parentPath ?? null) === JSON.stringify(parentPath ?? null),
  )

// === splitNameVersion (helper) ==============================================

describe('recipe/overrides — splitNameVersion', () => {
  it('bare name → no version condition', () => {
    expect(splitNameVersion('foo')).toEqual({ package: 'foo' })
  })
  it('pnpm-style foo@2 → versionCondition 2', () => {
    expect(splitNameVersion('foo@2')).toEqual({ package: 'foo', versionCondition: '2' })
  })
  it('scoped name keeps its leading @, no condition', () => {
    expect(splitNameVersion('@scope/pkg')).toEqual({ package: '@scope/pkg' })
  })
  it('scoped name + range splits at the LAST @ (not the scope @)', () => {
    expect(splitNameVersion('@scope/pkg@^1')).toEqual({
      package: '@scope/pkg',
      versionCondition: '^1',
    })
  })
  it('yarn npm: protocol range is carried verbatim into versionCondition', () => {
    expect(splitNameVersion('@testing-library/user-event@npm:^14.4.0')).toEqual({
      package: '@testing-library/user-event',
      versionCondition: 'npm:^14.4.0',
    })
  })
})

// === npm overrides (nested) =================================================

describe('recipe/overrides — npm grammar', () => {
  it('global string override', () => {
    const { canonical } = captureOverrides({ foo: '1.0.0' }, 'npm')
    expect(canonical).toEqual([{ package: 'foo', to: '1.0.0' }])
  })

  it('single-parent nested scope → parentPath', () => {
    const { canonical } = captureOverrides({ parent: { foo: '1.0.0' } }, 'npm')
    expect(canonical).toEqual([
      { package: 'foo', parentPath: ['parent'], to: '1.0.0' },
    ])
  })

  it('`.` self-key overrides the enclosing parent; siblings get parentPath', () => {
    const { canonical } = captureOverrides(
      { foo: { '.': '1.0.0', bar: '2.0.0' } },
      'npm',
    )
    expect(find(canonical, 'foo')).toEqual({ package: 'foo', to: '1.0.0' })
    expect(find(canonical, 'bar', ['foo'])).toEqual({
      package: 'bar',
      parentPath: ['foo'],
      to: '2.0.0',
    })
    expect(canonical).toHaveLength(2)
  })

  it('`$name` value → selfRef flag', () => {
    const { canonical } = captureOverrides({ foo: '$bar' }, 'npm')
    expect(canonical).toEqual([{ package: 'foo', to: '$bar', selfRef: true }])
  })

  it('recurses multi-level nested parents into a parentPath chain', () => {
    const { canonical } = captureOverrides(
      { a: { b: { c: '1.0.0' } } },
      'npm',
    )
    expect(canonical).toEqual([
      { package: 'c', parentPath: ['a', 'b'], to: '1.0.0' },
    ])
  })

  it('version-qualified parent key keeps the bare name in parentPath', () => {
    // npm `{ "kerberos@2.1.1": { "node-addon-api": "7.1.0" } }`
    const { canonical } = captureOverrides(
      { 'kerberos@2.1.1': { 'node-addon-api': '7.1.0' } },
      'npm',
    )
    expect(canonical).toEqual([
      { package: 'node-addon-api', parentPath: ['kerberos'], to: '7.1.0' },
    ])
  })

  it('native.npmOverrides holds the verbatim block', () => {
    const block = { foo: { '.': '1.0.0', bar: '2.0.0' } }
    const { native } = captureOverrides(block, 'npm')
    expect(native.npmOverrides).toBe(block)
    expect(native.yarnResolutions).toBeUndefined()
    expect(native.pnpmOverrides).toBeUndefined()
  })
})

// === yarn resolutions (flat patterns) =======================================

describe('recipe/overrides — yarn grammar', () => {
  it('flat name override', () => {
    const { canonical } = captureOverrides({ foo: '1.0.0' }, 'yarn')
    expect(canonical).toEqual([{ package: 'foo', to: '1.0.0' }])
  })

  it('parent/child → single-segment parentPath', () => {
    const { canonical } = captureOverrides({ 'parent/foo': '1.0.0' }, 'yarn')
    expect(canonical).toEqual([
      { package: 'foo', parentPath: ['parent'], to: '1.0.0' },
    ])
  })

  it('**/child deep-glob → package only, NO parentPath (irreducible tail)', () => {
    const { canonical } = captureOverrides({ '**/foo': '1.0.0' }, 'yarn')
    expect(canonical).toEqual([{ package: 'foo', to: '1.0.0' }])
  })

  it('foo@range → versionCondition (range stripped from selector)', () => {
    const { canonical } = captureOverrides({ 'foo@^1': '1.0.0' }, 'yarn')
    expect(canonical).toEqual([
      { package: 'foo', versionCondition: '^1', to: '1.0.0' },
    ])
  })

  it('foo@npm:^1 → versionCondition carries the protocol verbatim', () => {
    const { canonical } = captureOverrides({ 'foo@npm:^1': '1.0.0' }, 'yarn')
    expect(canonical).toEqual([
      { package: 'foo', versionCondition: 'npm:^1', to: '1.0.0' },
    ])
  })

  it('scoped parent/child keeps the scope intact on both sides', () => {
    const { canonical } = captureOverrides(
      { '@scope/parent/@scope/foo': '1.0.0' },
      'yarn',
    )
    expect(canonical).toEqual([
      { package: '@scope/foo', parentPath: ['@scope/parent'], to: '1.0.0' },
    ])
  })

  it('native.yarnResolutions holds the verbatim flat record', () => {
    const block = { foo: '1.0.0', 'parent/bar': '2.0.0' }
    const { native } = captureOverrides(block, 'yarn')
    expect(native.yarnResolutions).toEqual(block)
    expect(native.npmOverrides).toBeUndefined()
  })
})

// === pnpm overrides (flat selectors) ========================================

describe('recipe/overrides — pnpm grammar', () => {
  it('flat name override', () => {
    const { canonical } = captureOverrides({ foo: '1.0.0' }, 'pnpm')
    expect(canonical).toEqual([{ package: 'foo', to: '1.0.0' }])
  })

  it('foo@2 → versionCondition', () => {
    const { canonical } = captureOverrides({ 'foo@2': '3.0.0' }, 'pnpm')
    expect(canonical).toEqual([
      { package: 'foo', versionCondition: '2', to: '3.0.0' },
    ])
  })

  it('a>b → single-parent chain', () => {
    const { canonical } = captureOverrides({ 'a>b': '1.0.0' }, 'pnpm')
    expect(canonical).toEqual([
      { package: 'b', parentPath: ['a'], to: '1.0.0' },
    ])
  })

  it('a>b>c → multi-segment chain', () => {
    const { canonical } = captureOverrides({ 'a>b>c': '1.0.0' }, 'pnpm')
    expect(canonical).toEqual([
      { package: 'c', parentPath: ['a', 'b'], to: '1.0.0' },
    ])
  })

  it('leading >foo → package only (transitive-only tail dropped)', () => {
    const { canonical } = captureOverrides({ '>foo': '1.0.0' }, 'pnpm')
    expect(canonical).toEqual([{ package: 'foo', to: '1.0.0' }])
  })

  it('version-qualified parent (express@4>child) → bare parent name', () => {
    const { canonical } = captureOverrides(
      { 'express@4>path-to-regexp': '0.1.13' },
      'pnpm',
    )
    expect(canonical).toEqual([
      { package: 'path-to-regexp', parentPath: ['express'], to: '0.1.13' },
    ])
  })

  it('native.pnpmOverrides holds the verbatim flat record', () => {
    const block = { foo: '1.0.0', 'a>b': '2.0.0' }
    const { native } = captureOverrides(block, 'pnpm')
    expect(native.pnpmOverrides).toEqual(block)
    expect(native.npmOverrides).toBeUndefined()
  })
})

// === Diagnostics ============================================================

describe('recipe/overrides — RECIPE_OVERRIDE_NORMALISED', () => {
  it('emits once per capture with the PM and canonical count', () => {
    const seen: Diagnostic[] = []
    captureOverrides({ foo: '1.0.0', 'a>b': '2.0.0' }, 'pnpm', d => seen.push(d))
    expect(seen).toHaveLength(1)
    expect(seen[0]).toEqual(recipeOverrideNormalised('pnpm', 2))
    expect(seen[0]!.code).toBe('RECIPE_OVERRIDE_NORMALISED')
    expect(seen[0]!.severity).toBe('info')
  })

  it('does not emit for a null/non-object block', () => {
    const seen: Diagnostic[] = []
    captureOverrides(undefined, 'npm', d => seen.push(d))
    captureOverrides(null, 'yarn', d => seen.push(d))
    captureOverrides('nope', 'pnpm', d => seen.push(d))
    expect(seen).toHaveLength(0)
  })

  it('singular vs plural message form', () => {
    expect(recipeOverrideNormalised('npm', 1).message).toContain('1 npm override into')
    expect(recipeOverrideNormalised('npm', 3).message).toContain('3 npm overrides into')
  })
})

// === Non-object / empty inputs ==============================================

describe('recipe/overrides — degenerate inputs', () => {
  it('undefined → empty canonical + empty native', () => {
    const r: CapturedOverrides = captureOverrides(undefined, 'pnpm')
    expect(r.canonical).toEqual([])
    expect(r.native).toEqual({})
  })

  it('empty object → empty canonical, native key present but empty', () => {
    expect(captureOverrides({}, 'pnpm').canonical).toEqual([])
    expect(captureOverrides({}, 'yarn').native.yarnResolutions).toEqual({})
  })
})

// === Real manifests =========================================================

describe('recipe/overrides — real manifests', () => {
  it('directus pnpm.overrides → 22 canonical entries + verbatim native', () => {
    const block = DIRECTUS_PNPM_OVERRIDES
    const { canonical, native } = captureOverrides(block, 'pnpm')

    expect(canonical).toHaveLength(22)
    // flat
    expect(find(canonical, 'fast-xml-parser')).toEqual({
      package: 'fast-xml-parser',
      to: '5.8.0',
    })
    // version-conditional
    expect(find(canonical, 'minimatch')).toBeDefined()
    expect(canonical.filter(c => c.package === 'minimatch').map(c => c.versionCondition).sort())
      .toEqual(['10', '9'])
    // a>b chain (scoped parent + scoped child)
    expect(find(canonical, '@directus/types', ['@directus/license'])).toEqual({
      package: '@directus/types',
      parentPath: ['@directus/license'],
      to: 'workspace:*',
    })
    // version-qualified parent → bare name
    expect(find(canonical, 'path-to-regexp', ['express'])).toEqual({
      package: 'path-to-regexp',
      parentPath: ['express'],
      to: '0.1.13',
    })
    // same child under two distinct parents stays two entries
    expect(canonical.filter(c => c.package === 'picomatch')).toHaveLength(3)

    expect(native.pnpmOverrides).toEqual(block)
  })

  it('storybook resolutions → 18 canonical entries + verbatim native', () => {
    const block = STORYBOOK_RESOLUTIONS
    const { canonical, native } = captureOverrides(block, 'yarn')

    expect(canonical).toHaveLength(18)
    // flat scoped
    expect(find(canonical, '@babel/runtime')).toEqual({
      package: '@babel/runtime',
      to: 'latest',
    })
    // scoped name + npm: range condition (LAST-@ split, not the scope @)
    expect(find(canonical, '@testing-library/user-event')).toBeDefined()
    expect(
      canonical
        .filter(c => c.package === '@testing-library/user-event')
        .map(c => c.versionCondition)
        .sort(),
    ).toEqual(['npm:^14.4.0', 'npm:^14.6.1'])
    // parent/child (both unscoped)
    expect(find(canonical, 'type-fest', ['react-joyride'])).toEqual({
      package: 'type-fest',
      parentPath: ['react-joyride'],
      to: '~2.19',
    })
    // bare-version condition on a scoped pkg
    expect(find(canonical, 'aria-query')).toEqual({
      package: 'aria-query',
      versionCondition: '5.3.0',
      to: '^5.3.0',
    })

    expect(native.yarnResolutions).toEqual(block)
  })

  it('vscode overrides → 5 canonical entries + verbatim native', () => {
    const block = VSCODE_OVERRIDES
    const { canonical, native } = captureOverrides(block, 'npm')

    expect(canonical).toHaveLength(5)
    // globals
    expect(find(canonical, 'node-gyp-build')).toEqual({
      package: 'node-gyp-build',
      to: '4.8.1',
    })
    expect(find(canonical, 'yauzl')).toEqual({ package: 'yauzl', to: '^3.3.1' })
    // nested path-scoped
    expect(find(canonical, 'cpu-features', ['ssh2'])).toEqual({
      package: 'cpu-features',
      parentPath: ['ssh2'],
      to: '0.0.0',
    })
    // version-qualified parent key → bare name in parentPath
    expect(find(canonical, 'node-addon-api', ['kerberos'])).toEqual({
      package: 'node-addon-api',
      parentPath: ['kerberos'],
      to: '7.1.0',
    })

    expect(native.npmOverrides).toBe(block)
  })
})

describe('projectOverrides — canonical → PM-native (ADR-0025 §4)', () => {
  it('npm: capture → project round-trips the nested block', () => {
    const npm = { foo: '1.0.0', parent: { bar: '2.0.0' }, baz: { '.': '3.0.0', qux: '4.0.0' } }
    const { canonical } = captureOverrides(npm, 'npm')
    expect(projectOverrides(canonical, 'npm')).toEqual(npm)
  })

  it('pnpm: capture → project round-trips flat `>`/`@`/global selectors', () => {
    const pnpm = { foo: '1.0.0', 'a>b': '2.0.0', 'a>b>c': '3.0.0', 'minimatch@9': '9.9.9' }
    const { canonical } = captureOverrides(pnpm, 'pnpm')
    expect(projectOverrides(canonical, 'pnpm')).toEqual(pnpm)
  })

  it('npm keeps a `$name` self-ref; projecting it to pnpm warns', () => {
    const { canonical } = captureOverrides({ react: { 'react-dom': '$react' } }, 'npm')
    // npm projection preserves the self-ref verbatim, no diagnostic.
    const npmDiags: string[] = []
    const npmBlock = projectOverrides(canonical, 'npm', d => npmDiags.push(d.code))
    expect(npmBlock).toEqual({ react: { 'react-dom': '$react' } })
    expect(npmDiags).toEqual([])
    // pnpm has no back-reference → loss diagnostic.
    const pnpmDiags: string[] = []
    projectOverrides(canonical, 'pnpm', d => pnpmDiags.push(d.code))
    expect(pnpmDiags).toContain('OVERRIDE_PARENT_REF_DROPPED')
  })

  it('yarn note emits INTEROP_OVERRIDE_NOT_PROJECTED when overrides are present', () => {
    const diags: string[] = []
    noteYarnOverridesNotProjected(3, d => diags.push(d.code))
    expect(diags).toEqual(['INTEROP_OVERRIDE_NOT_PROJECTED'])
    // No diagnostic for an empty override set.
    const none: string[] = []
    noteYarnOverridesNotProjected(0, d => none.push(d.code))
    expect(none).toEqual([])
  })
})
