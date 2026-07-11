import { describe, expect, it } from 'vitest'
import { overridesOf, parse, stringify } from '../../main/ts/index.ts'
import type { Diagnostic, OverrideConstraint } from '../../main/ts/graph.ts'
import { fixture } from '../helpers/lockfile-test-utils.ts'

// StringifyOptions.overrides projection (ADR-0025 §4, corrected). Caller-declared
// canonical OverrideConstraint[] lower into each target PM's AUTHORITATIVE
// override carrier on stringify:
//   - pnpm-v6/v9 → top-level `overrides:` (the lock IS the carrier pnpm frozen-
//     compares — cf. pnpm 6–10 getOutdatedLockfileSetting deep-equality; flat
//     `>`-selectors)
//   - npm (2/3), yarn (classic + berry) → NO lock carrier. The policy lives in
//     the ROOT MANIFEST, never the lock: npm reads `package.json.overrides` and
//     real npm locks carry no `packages[""].overrides` (canary). We emit
//     INTEROP_OVERRIDE_NOT_PROJECTED; the declaration is owed to a companion
//     package.json patch (project-level conversion API, ADR TBD).
// bun-text / npm-1 / pnpm-v5 override carriers are tracked follow-ups.

const OVERRIDES: OverrideConstraint[] = [
  { package: 'lodash', to: '4.17.21' }, // global
  { package: 'foo', parentPath: ['bar'], to: '1.0.0' }, // scoped under `bar`
]

describe('StringifyOptions.overrides projection (ADR-0025 §4)', () => {
  it('npm-3 does NOT synthesize packages[""].overrides — surfaces INTEROP_OVERRIDE_NOT_PROJECTED', () => {
    const g = parse('npm-3', fixture('simple/npm-3.lock'))
    const diags: Diagnostic[] = []
    const out = JSON.parse(stringify('npm-3', g, { overrides: OVERRIDES, onDiagnostic: d => diags.push(d) }))
    // npm reads overrides from package.json, never the lock — the field is not npm-native.
    expect(out.packages[''].overrides).toBeUndefined()
    expect(diags.map(d => d.code)).toContain('INTEROP_OVERRIDE_NOT_PROJECTED')
  })

  it('npm-3 emits no overrides block and no diagnostic when none are supplied', () => {
    const g = parse('npm-3', fixture('simple/npm-3.lock'))
    const diags: Diagnostic[] = []
    const out = JSON.parse(stringify('npm-3', g, { onDiagnostic: d => diags.push(d) }))
    expect(out.packages[''].overrides).toBeUndefined()
    expect(diags.map(d => d.code)).not.toContain('INTEROP_OVERRIDE_NOT_PROJECTED')
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

// npm `packages[""].overrides` is NOT npm-native (real npm locks carry none —
// canary). A synthetic/non-native lock that DOES carry it is captured DEFENSIVELY
// into the graph (so the policy stays queryable + can later feed a companion
// package.json patch), but is NEVER re-emitted into npm output — npm ignores a
// lock overrides field, so re-emitting it would only forge false `npm ci`
// confidence and weaken byte-stability.

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

describe('npm lock-borne overrides are non-native — captured, never re-emitted', () => {
  it('captures the policy into the graph (overridesOf) but drops it from npm output + diagnoses', () => {
    const g = parse('npm-3', NPM3_WITH_OVERRIDES)
    expect(overridesOf(g).length).toBeGreaterThan(0) // policy preserved in the graph...
    const diags: Diagnostic[] = []
    const out = JSON.parse(stringify('npm-3', g, { onDiagnostic: d => diags.push(d) }))
    expect(out.packages[''].overrides).toBeUndefined() // ...but never written back into npm output
    expect(diags.map(d => d.code)).toContain('INTEROP_OVERRIDE_NOT_PROJECTED')
  })

  it('parse surfaces RECIPE_OVERRIDE_NORMALISED for the captured block', () => {
    const g = parse('npm-3', NPM3_WITH_OVERRIDES)
    expect(g.diagnostics().map(d => d.code)).toContain('RECIPE_OVERRIDE_NORMALISED')
  })

  it('caller options.overrides also drops for npm (no lock carrier) — diagnostic, no block', () => {
    const g = parse('npm-3', NPM3_WITH_OVERRIDES)
    const diags: Diagnostic[] = []
    const out = JSON.parse(
      stringify('npm-3', g, { overrides: [{ package: 'left-pad', to: '1.3.0' }], onDiagnostic: d => diags.push(d) }),
    )
    expect(out.packages[''].overrides).toBeUndefined()
    expect(diags.map(d => d.code)).toContain('INTEROP_OVERRIDE_NOT_PROJECTED')
  })

  it('explicit overrides: [] means "none" — no block, no diagnostic', () => {
    const g = parse('npm-3', NPM3_WITH_OVERRIDES)
    const diags: Diagnostic[] = []
    const out = JSON.parse(stringify('npm-3', g, { overrides: [], onDiagnostic: d => diags.push(d) }))
    expect(out.packages[''].overrides).toBeUndefined()
    expect(diags.map(d => d.code)).not.toContain('INTEROP_OVERRIDE_NOT_PROJECTED')
  })

  it('a real npm lock (no overrides block) captures nothing and emits nothing', () => {
    const g = parse('npm-3', fixture('simple/npm-3.lock'))
    const diags: Diagnostic[] = []
    const out = JSON.parse(stringify('npm-3', g, { onDiagnostic: d => diags.push(d) }))
    expect(out.packages[''].overrides).toBeUndefined()
    expect(diags.map(d => d.code)).not.toContain('INTEROP_OVERRIDE_NOT_PROJECTED')
  })
})

// pnpm-v5 (lockfileVersion 5.4, pnpm 6–7) DOES carry a top-level `overrides:`
// block and frozen-compares it against config (`getOutdatedLockfileSetting`
// deep-equality → `LockfileConfigMismatchError`). A v5 lock that omits the block
// for an override-using project fails `--frozen-lockfile`, so the carrier is a
// correctness fix, not polish. (Unlike npm/yarn above, pnpm's lock IS a carrier.)

const V5_MIN =
  `lockfileVersion: 5.4\n\n` +
  `specifiers:\n  ms: 2.1.3\n\n` +
  `dependencies:\n  ms: 2.1.3\n\n` +
  `packages:\n\n` +
  `  /ms/2.1.3:\n` +
  `    resolution: {integrity: sha512-6FlzubTLZG3J2a/NVCAleEhjzq5oxgHyaCU9yYXvcLsvoVaHJq/s5xXI6/XXP6tz7R9xAOtHnSO/tXtF3WRTlA==}\n` +
  `    dev: false\n`

describe('pnpm-v5 overrides carrier (ADR-0025 §4; pnpm 6–7 frozen-compare)', () => {
  it('projects caller overrides into the top-level overrides: block', () => {
    const g = parse('pnpm-v5', V5_MIN)
    const out = stringify('pnpm-v5', g, { overrides: OVERRIDES })
    expect(out).toMatch(/^overrides:/m)
    expect(out).toContain('lodash')
    expect(out).toContain('bar>foo') // scoped constraint as a `>`-selector key
  })

  it('round-trips a lock-borne overrides block byte-identically + reads it via overridesOf', () => {
    const withOvr = V5_MIN.replace('specifiers:', 'overrides:\n  ms: 2.1.3\n\nspecifiers:')
    const g = parse('pnpm-v5', withOvr)
    expect(stringify('pnpm-v5', g)).toBe(withOvr) // byte-identical, overrides after lockfileVersion
    expect(overridesOf(g)).toContainEqual({ package: 'ms', to: '2.1.3' })
  })

  it('omits overrides: when the graph carries none and none supplied', () => {
    const g = parse('pnpm-v5', V5_MIN)
    expect(stringify('pnpm-v5', g)).not.toMatch(/^overrides:/m)
  })
})
