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
