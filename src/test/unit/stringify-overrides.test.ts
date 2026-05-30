import { describe, expect, it } from 'vitest'
import { parse, stringify } from '../../main/ts/index.ts'
import type { Diagnostic, OverrideConstraint } from '../../main/ts/graph.ts'
import { fixture } from '../helpers/lockfile-test-utils.ts'

// Phase-1c — StringifyOptions.overrides projection end-to-end (ADR-0025 §4).
// Caller-declared canonical OverrideConstraint[] are lowered into each target
// PM's native lockfile carrier on stringify:
//   - npm-2/3 → packages[""].overrides (npm nested shape)
//   - pnpm-v6/v9 → top-level `overrides:` (flat `>`-selectors)
//   - yarn (classic + berry) → no lock carrier; INTEROP_OVERRIDE_NOT_PROJECTED
// bun-text / npm-1 / pnpm-v5 do not yet thread overrides (tracked follow-up).

const OVERRIDES: OverrideConstraint[] = [
  { package: 'lodash', to: '4.17.21' }, // global
  { package: 'foo', parentPath: ['bar'], to: '1.0.0' }, // scoped under `bar`
]

describe('StringifyOptions.overrides projection (ADR-0025 §4)', () => {
  it('npm-3 projects into packages[""].overrides (nested shape)', () => {
    const g = parse('npm-3', fixture('simple/npm-3.lock'))
    const out = JSON.parse(stringify('npm-3', g, { overrides: OVERRIDES }))
    expect(out.packages[''].overrides).toEqual({
      lodash: '4.17.21',
      bar: { foo: '1.0.0' },
    })
  })

  it('npm-3 omits the overrides block when none are supplied', () => {
    const g = parse('npm-3', fixture('simple/npm-3.lock'))
    const out = JSON.parse(stringify('npm-3', g))
    expect(out.packages['']).toBeDefined()
    expect(out.packages[''].overrides).toBeUndefined()
  })

  it('pnpm-v9 projects into top-level overrides: (flat >-selectors)', () => {
    const g = parse('pnpm-v9', fixture('simple/pnpm-v9.lock'))
    const out = stringify('pnpm-v9', g, { overrides: OVERRIDES })
    expect(out).toMatch(/^overrides:/m)
    expect(out).toContain('lodash')
    expect(out).toContain('bar>foo') // scoped constraint as a `>`-selector key
  })

  it('pnpm-v9 omits overrides: when the graph carries none and none supplied', () => {
    const g = parse('pnpm-v9', fixture('simple/pnpm-v9.lock'))
    const out = stringify('pnpm-v9', g)
    expect(out).not.toMatch(/^overrides:/m)
  })

  it('yarn-berry-v9 emits INTEROP_OVERRIDE_NOT_PROJECTED (lock carries no overrides block)', () => {
    const g = parse('yarn-berry-v9', fixture('simple/yarn-berry-v9.lock'))
    const diags: Diagnostic[] = []
    stringify('yarn-berry-v9', g, { overrides: OVERRIDES, onDiagnostic: d => diags.push(d) })
    expect(diags.map(d => d.code)).toContain('INTEROP_OVERRIDE_NOT_PROJECTED')
  })

  it('yarn-classic emits INTEROP_OVERRIDE_NOT_PROJECTED', () => {
    const g = parse('yarn-classic', fixture('simple/yarn-classic.lock'))
    const diags: Diagnostic[] = []
    stringify('yarn-classic', g, { overrides: OVERRIDES, onDiagnostic: d => diags.push(d) })
    expect(diags.map(d => d.code)).toContain('INTEROP_OVERRIDE_NOT_PROJECTED')
  })

  it('yarn emits no INTEROP diagnostic when no overrides are supplied', () => {
    const g = parse('yarn-berry-v9', fixture('simple/yarn-berry-v9.lock'))
    const diags: Diagnostic[] = []
    stringify('yarn-berry-v9', g, { onDiagnostic: d => diags.push(d) })
    expect(diags.map(d => d.code)).not.toContain('INTEROP_OVERRIDE_NOT_PROJECTED')
  })
})

// A1 — npm lock-borne overrides round-trip (ADR-0025 §3). npm writes the root
// manifest's overrides into packages[""].overrides; parse captures that block
// into the canonical carrier (rootMeta.overrides), and stringify re-emits it
// when the caller supplies no StringifyOptions.overrides. This is the symmetric
// inverse of the Phase-1c projection above — it closes the npm→npm round-trip.

const NPM3_WITH_OVERRIDES = JSON.stringify(
  {
    name: 'x',
    version: '0.0.0',
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': {
        name: 'x',
        version: '0.0.0',
        dependencies: { ms: '2.1.3' },
        overrides: { lodash: '4.17.21', bar: { foo: '1.0.0' } },
      },
      'node_modules/ms': {
        version: '2.1.3',
        resolved: 'https://registry.npmjs.org/ms/-/ms-2.1.3.tgz',
        integrity: 'sha512-abc',
      },
    },
  },
  null,
  2,
)

describe('npm lock-borne overrides round-trip (ADR-0025 §3, A1)', () => {
  it('re-emits packages[""].overrides unchanged when no options supplied', () => {
    const g = parse('npm-3', NPM3_WITH_OVERRIDES)
    const out = JSON.parse(stringify('npm-3', g))
    expect(out.packages[''].overrides).toEqual({
      lodash: '4.17.21',
      bar: { foo: '1.0.0' },
    })
  })

  it('parse surfaces RECIPE_OVERRIDE_NORMALISED for the captured block', () => {
    const g = parse('npm-3', NPM3_WITH_OVERRIDES)
    expect(g.diagnostics().map(d => d.code)).toContain('RECIPE_OVERRIDE_NORMALISED')
  })

  it('options.overrides wins over the captured lock-borne block', () => {
    const g = parse('npm-3', NPM3_WITH_OVERRIDES)
    const out = JSON.parse(
      stringify('npm-3', g, { overrides: [{ package: 'left-pad', to: '1.3.0' }] }),
    )
    expect(out.packages[''].overrides).toEqual({ 'left-pad': '1.3.0' })
  })

  it('explicit overrides: [] suppresses the captured fallback (no block)', () => {
    const g = parse('npm-3', NPM3_WITH_OVERRIDES)
    const out = JSON.parse(stringify('npm-3', g, { overrides: [] }))
    expect(out.packages[''].overrides).toBeUndefined()
  })

  it('a lock with no overrides block captures nothing and emits no block', () => {
    const g = parse('npm-3', fixture('simple/npm-3.lock'))
    const out = JSON.parse(stringify('npm-3', g))
    expect(out.packages[''].overrides).toBeUndefined()
  })

  // The two shapes whose canonical name-chain is lossy (ADR-0025 §2): the
  // VERBATIM carrier must re-emit them byte-identically. Without it these would
  // round-trip through canonical → projectNpm and (c) drop the child override
  // destructively, (e) drop the `@2` qualifier.
  const npm3LockWithOverrides = (overrides: unknown): string =>
    JSON.stringify(
      {
        name: 'x',
        version: '0.0.0',
        lockfileVersion: 3,
        requires: true,
        packages: {
          '': { name: 'x', version: '0.0.0', dependencies: { ms: '2.1.3' }, overrides },
          'node_modules/ms': {
            version: '2.1.3',
            resolved: 'https://registry.npmjs.org/ms/-/ms-2.1.3.tgz',
            integrity: 'sha512-abc',
          },
        },
      },
      null,
      2,
    )

  it('losslessly round-trips a self-key-LAST nested block (verbatim carrier)', () => {
    const block = { bar: { foo: '1.0.0', '.': '2.0.0' } }
    const g = parse('npm-3', npm3LockWithOverrides(block))
    const out = JSON.parse(stringify('npm-3', g))
    expect(out.packages[''].overrides).toEqual(block) // not the destructive {bar:'2.0.0'}
  })

  it('losslessly round-trips a version-qualified leaf key (verbatim carrier)', () => {
    const block = { 'foo@2': '3.0.0' }
    const g = parse('npm-3', npm3LockWithOverrides(block))
    const out = JSON.parse(stringify('npm-3', g))
    expect(out.packages[''].overrides).toEqual(block) // @2 preserved, not {foo:'3.0.0'}
  })
})
