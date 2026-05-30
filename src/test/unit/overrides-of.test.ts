import { describe, expect, it } from 'vitest'
import { overridesOf, parse, stringify } from '../../main/ts/index.ts'
import { mergeOverrides } from '../../main/ts/recipe/override-carrier.ts'
import type { Manifest, OverrideConstraint } from '../../main/ts/graph.ts'
import { fixture } from '../helpers/lockfile-test-utils.ts'

// A2 (ADR-0025 §6) — `overridesOf(graph)` folds lock-borne + parse-time-manifest
// overrides into one canonical list (manifest wins on collision), read off the
// parsed-graph handle (read-before-modify). Plus the manifest-F6 capture path
// (`ParseOptions.manifests`) and the cross-PM carry it enables.

const NPM3_WITH_OVERRIDES = JSON.stringify(
  {
    name: 'x',
    version: '0.0.0',
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': { name: 'x', version: '0.0.0', dependencies: { ms: '2.1.3' }, overrides: { lodash: '4.17.21', bar: { foo: '1.0.0' } } },
      'node_modules/ms': { version: '2.1.3', resolved: 'https://registry.npmjs.org/ms/-/ms-2.1.3.tgz', integrity: 'sha512-abc' },
    },
  },
  null,
  2,
)

const PNPM9_WITH_OVERRIDES = `lockfileVersion: '9.0'
settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false
overrides:
  lodash: 4.17.21
  bar>foo: 1.0.0
importers:
  .:
    dependencies:
      ms:
        specifier: 2.1.3
        version: 2.1.3
packages:
  ms@2.1.3:
    resolution: {integrity: sha512-abc}
snapshots:
  ms@2.1.3: {}
`

describe('overridesOf — lock-borne sources (ADR-0025 §6, A2)', () => {
  it('surfaces npm packages[""].overrides as canonical', () => {
    const g = parse('npm-3', NPM3_WITH_OVERRIDES)
    expect(overridesOf(g)).toEqual([
      { package: 'foo', parentPath: ['bar'], to: '1.0.0' },
      { package: 'lodash', to: '4.17.21' },
    ])
  })

  it('surfaces pnpm overrides: as canonical (>-selectors → parentPath)', () => {
    const g = parse('pnpm-v9', PNPM9_WITH_OVERRIDES)
    expect(overridesOf(g)).toEqual([
      { package: 'foo', parentPath: ['bar'], to: '1.0.0' },
      { package: 'lodash', to: '4.17.21' },
    ])
  })

  it('returns [] for a graph with no overrides from any source', () => {
    const g = parse('npm-3', fixture('simple/npm-3.lock'))
    expect(overridesOf(g)).toEqual([])
  })
})

describe('overridesOf — manifest-F6 capture (ParseOptions.manifests)', () => {
  it('captures yarn resolutions from a supplied manifest (no lock overrides block)', () => {
    const manifests: Record<string, Manifest> = {
      '.': { native: { yarnResolutions: { lodash: '4.17.21', 'bar/foo': '1.0.0' } } },
    }
    const g = parse('yarn-berry-v9', fixture('simple/yarn-berry-v9.lock'), { manifests })
    expect(overridesOf(g)).toEqual([
      { package: 'foo', parentPath: ['bar'], to: '1.0.0' },
      { package: 'lodash', to: '4.17.21' },
    ])
  })

  it('prefers a manifest that already carries canonical overrides', () => {
    const manifests: Record<string, Manifest> = {
      '.': { overrides: [{ package: 'left-pad', to: '1.3.0' }] },
    }
    const g = parse('yarn-berry-v9', fixture('simple/yarn-berry-v9.lock'), { manifests })
    expect(overridesOf(g)).toEqual([{ package: 'left-pad', to: '1.3.0' }])
  })

  it('no manifests supplied → only lock-borne (here: none) → []', () => {
    const g = parse('yarn-berry-v9', fixture('simple/yarn-berry-v9.lock'))
    expect(overridesOf(g)).toEqual([])
  })
})

describe('overridesOf — precedence (manifest-F6 wins over lock-borne)', () => {
  it('manifest entry overrides the lock-borne entry for the same tuple', () => {
    const manifests: Record<string, Manifest> = {
      '.': { native: { npmOverrides: { lodash: '9.9.9' } } }, // collides with lock's lodash 4.17.21
    }
    const g = parse('npm-3', NPM3_WITH_OVERRIDES, { manifests })
    const ov = overridesOf(g)
    expect(ov).toContainEqual({ package: 'lodash', to: '9.9.9' }) // manifest wins
    expect(ov).not.toContainEqual({ package: 'lodash', to: '4.17.21' })
    expect(ov).toContainEqual({ package: 'foo', parentPath: ['bar'], to: '1.0.0' }) // lock-only survives
  })
})

describe('overridesOf — cross-PM carry (parse yarn+resolutions → stringify npm)', () => {
  it('yarn resolutions reach npm packages[""].overrides via overridesOf thread', () => {
    const manifests: Record<string, Manifest> = {
      '.': { native: { yarnResolutions: { lodash: '4.17.21' } } },
    }
    const g = parse('yarn-berry-v9', fixture('simple/yarn-berry-v9.lock'), { manifests })
    const out = JSON.parse(stringify('npm-3', g, { overrides: overridesOf(g) }))
    expect(out.packages[''].overrides).toEqual({ lodash: '4.17.21' })
  })
})

describe('mergeOverrides — tuple-keyed, winners win', () => {
  it('winner overwrites base on (package, parentPath, versionCondition) collision', () => {
    const base: OverrideConstraint[] = [
      { package: 'a', to: '1' },
      { package: 'b', parentPath: ['p'], to: '2' },
    ]
    const winners: OverrideConstraint[] = [
      { package: 'a', to: '9' }, // collides with base a
      { package: 'b', parentPath: ['q'], to: '3' }, // different parentPath → distinct
    ]
    expect(mergeOverrides(base, winners)).toEqual([
      { package: 'a', to: '9' },
      { package: 'b', parentPath: ['p'], to: '2' },
      { package: 'b', parentPath: ['q'], to: '3' },
    ])
  })

  it('is pure — does not mutate inputs', () => {
    const base: OverrideConstraint[] = [{ package: 'a', to: '1' }]
    const winners: OverrideConstraint[] = [{ package: 'a', to: '2' }]
    mergeOverrides(base, winners)
    expect(base).toEqual([{ package: 'a', to: '1' }])
    expect(winners).toEqual([{ package: 'a', to: '2' }])
  })
})
