// Bug #99 — descriptor→node resolution ladder primitives (pure math).
//
// Covers `semverResolve` (Rung 3, source-gated max-satisfying + tie handling +
// the single-candidate structural short-circuit) and `overrideTargetFor`
// (Rung 2, version-condition + parentPath matching, specificity, self-ref skip).

import { describe, expect, it } from 'vitest'
import {
  overrideTargetFor,
  semverResolve,
  type SemverCandidate,
} from '../../main/ts/recipe/descriptor-resolve.ts'
import type { OverrideConstraint } from '../../main/ts/graph.ts'

const tarball = (id: string, version: string): SemverCandidate => ({ id, version, sourceType: 'tarball' })

describe('semverResolve — Rung 3 source-gated max-satisfying semver', () => {
  it('binds the max-satisfying tarball version among several', () => {
    const candidates = [tarball('csstype@2.6.21', '2.6.21'), tarball('csstype@3.0.9', '3.0.9'), tarball('csstype@3.1.3', '3.1.3')]
    // ^3.0.2 → {3.0.9, 3.1.3} satisfy → MAX = 3.1.3
    expect(semverResolve('npm:^3.0.2', candidates)).toEqual({ kind: 'bound', id: 'csstype@3.1.3' })
  })

  it('accepts a bare (no-protocol) range as a registry range', () => {
    const candidates = [tarball('a@1.0.0', '1.0.0'), tarball('a@1.5.0', '1.5.0')]
    expect(semverResolve('^1.0.0', candidates)).toEqual({ kind: 'bound', id: 'a@1.5.0' })
  })

  it('short-circuits to the single eligible candidate even on a NON-satisfying version', () => {
    // Exactly one tarball sibling → bind it structurally (the pin yarn chose),
    // even though 3.0.9 does NOT satisfy ^3.1.3.
    expect(semverResolve('npm:^3.1.3', [tarball('csstype@3.0.9', '3.0.9')]))
      .toEqual({ kind: 'bound', id: 'csstype@3.0.9' })
  })

  it('returns none when no eligible candidate satisfies (≥2 candidates)', () => {
    const candidates = [tarball('a@1.0.0', '1.0.0'), tarball('a@1.2.0', '1.2.0')]
    expect(semverResolve('^2.0.0', candidates)).toEqual({ kind: 'none' })
  })

  it('NEVER binds a git / directory / unknown / absent-source node to an npm: range (#91 safety)', () => {
    const nonRegistry: SemverCandidate[] = [
      { id: 'forked@1.0.0', version: '1.0.0', sourceType: 'git' },
      { id: 'local@1.0.0', version: '1.0.0', sourceType: 'directory' },
      { id: 'weird@1.0.0', version: '1.0.0', sourceType: 'unknown' },
      { id: 'ws@1.0.0', version: '1.0.0', sourceType: 'absent' },
    ]
    expect(semverResolve('npm:^1.0.0', nonRegistry)).toEqual({ kind: 'none' })
    expect(semverResolve('^1.0.0', nonRegistry)).toEqual({ kind: 'none' })
  })

  it('a git sibling is invisible; a tarball sibling of the same name still binds', () => {
    const mixed: SemverCandidate[] = [
      { id: 'pkg@1.0.0', version: '1.0.0', sourceType: 'git' },
      tarball('pkg@1.2.0', '1.2.0'),
    ]
    // Only the tarball is eligible → single eligible → structural short-circuit.
    expect(semverResolve('npm:^1.0.0', mixed)).toEqual({ kind: 'bound', id: 'pkg@1.2.0' })
  })

  it('declines (none) for any non-npm protocol range', () => {
    const candidates = [tarball('a@1.0.0', '1.0.0'), tarball('a@2.0.0', '2.0.0')]
    expect(semverResolve('patch:a@npm%3A1.0.0#x.patch', candidates)).toEqual({ kind: 'none' })
    expect(semverResolve('git@github.com:o/r.git#abc', candidates)).toEqual({ kind: 'none' })
    expect(semverResolve('workspace:^', candidates)).toEqual({ kind: 'none' })
  })

  it('reports ambiguity (no guess) on a tie at the max satisfying version', () => {
    // Two DISTINCT ids at the same max version (e.g. peer-virt siblings).
    const tie: SemverCandidate[] = [
      tarball('a@1.5.0', '1.5.0'),
      tarball('a@1.5.0(b@1.0.0)', '1.5.0'),
      tarball('a@1.0.0', '1.0.0'),
    ]
    const result = semverResolve('^1.0.0', tie)
    expect(result.kind).toBe('ambiguous')
    expect(result.kind === 'ambiguous' && result.candidateIds.sort()).toEqual(['a@1.5.0', 'a@1.5.0(b@1.0.0)'])
  })

  it('returns none for an empty candidate list', () => {
    expect(semverResolve('^1.0.0', [])).toEqual({ kind: 'none' })
  })
})

describe('overrideTargetFor — Rung 2 override-map forced link', () => {
  const csstypeOverrides: OverrideConstraint[] = [
    { package: 'csstype', versionCondition: 'npm:^3.0.2', to: '3.0.9' },
    { package: 'csstype', versionCondition: 'npm:^3.1.3', to: '3.0.9' },
  ]

  it('matches a version-conditioned override (protocol-insensitive)', () => {
    // captured condition `npm:^3.1.3` matches declared `npm:^3.1.3`
    expect(overrideTargetFor('csstype', 'npm:^3.1.3', [], csstypeOverrides)).toBe('3.0.9')
    // …and matches a BARE declared range too (npm: stripped on both sides)
    expect(overrideTargetFor('csstype', '^3.0.2', [], csstypeOverrides)).toBe('3.0.9')
  })

  it('does NOT match a range outside any version condition', () => {
    expect(overrideTargetFor('csstype', 'npm:^2.0.0', [], csstypeOverrides)).toBeUndefined()
  })

  it('matches an unconditional (global) override for any range', () => {
    const global: OverrideConstraint[] = [{ package: 'lodash', to: '4.17.21' }]
    expect(overrideTargetFor('lodash', 'npm:^4.0.0', [], global)).toBe('4.17.21')
    expect(overrideTargetFor('lodash', '^3.0.0', [], global)).toBe('4.17.21')
  })

  it('returns undefined when the package name does not match', () => {
    expect(overrideTargetFor('react', 'npm:^18.0.0', [], csstypeOverrides)).toBeUndefined()
  })

  it('honours parentPath as a suffix of the consumer chain', () => {
    const scoped: OverrideConstraint[] = [{ package: 'ast-types', parentPath: ['recast'], to: 'patch:ast-types@npm%3A0.16.1#x.patch' }]
    // consumer chain ends in `recast` → matches
    expect(overrideTargetFor('ast-types', 'npm:^0.16.1', ['recast'], scoped)).toBe('patch:ast-types@npm%3A0.16.1#x.patch')
    // consumer chain is some OTHER parent → no match (does not over-bind)
    expect(overrideTargetFor('ast-types', 'npm:^0.16.1', ['jscodeshift'], scoped)).toBeUndefined()
    // empty consumer chain can't satisfy a 1-segment parentPath
    expect(overrideTargetFor('ast-types', 'npm:^0.16.1', [], scoped)).toBeUndefined()
  })

  it('prefers the MORE SPECIFIC constraint on a tie (version-conditioned beats global)', () => {
    const mixed: OverrideConstraint[] = [
      { package: 'x', to: '1.0.0' }, // global
      { package: 'x', versionCondition: '^2.0.0', to: '2.5.0' }, // conditioned
    ]
    expect(overrideTargetFor('x', '^2.0.0', [], mixed)).toBe('2.5.0')
    // a range matching ONLY the global still resolves to the global
    expect(overrideTargetFor('x', '^9.0.0', [], mixed)).toBe('1.0.0')
  })

  it('skips an npm $name self-ref (unresolvable here)', () => {
    const selfRef: OverrideConstraint[] = [{ package: 'foo', to: '$bar', selfRef: true }]
    expect(overrideTargetFor('foo', '^1.0.0', [], selfRef)).toBeUndefined()
  })

  it('returns undefined for an empty override list', () => {
    expect(overrideTargetFor('anything', '^1.0.0', [], [])).toBeUndefined()
  })
})
