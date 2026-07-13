// Override-honoring remediation (yaf consult): Gap 2 PM-faithful tie-break,
// Gap 3 governingOverrideFor export, Confirm A pinOverride → overridesOf fold
// (pnpm frozen-acceptance). Gap 1 (completion) is in overrides-completion below.

import { describe, expect, it } from 'vitest'
import { governingOverrideFor, overridesOf, stringify } from '../../main/ts/index.ts'
import { captureOverrides } from '../../main/ts/recipe/overrides.ts'
import { completeTransitives } from '../../main/ts/complete/tree-complete.ts'
import { frozenRegistry } from '../../main/ts/registry/frozen.ts'
import type { Packument, RegistryAdapter } from '../../main/ts/registry/types.ts'
import { pinOverride } from '../../main/ts/modify/pin-override.ts'
import { addEdge, addPackage, graphOf } from './_modify-test-utils.ts'

describe('overrides — Gap 2: PM-faithful tie-break (origin-driven)', () => {
  it('npm is FIRST-MATCH in declaration order, NOT most-specific (RFC 0036)', () => {
    // Both `foo` (global, declared first) and `bar>foo` (scoped, declared second)
    // match foo-under-bar. npm returns the FIRST matching rule → global `foo`.
    const { canonical } = captureOverrides({ foo: '1.0.0', bar: { foo: '2.0.0' } }, 'npm')
    expect(governingOverrideFor('foo', ['bar'], canonical)?.to).toBe('1.0.0')
    // reversed declaration order flips the winner (proves it's order, not specificity)
    const rev = captureOverrides({ bar: { foo: '2.0.0' }, foo: '1.0.0' }, 'npm')
    expect(governingOverrideFor('foo', ['bar'], rev.canonical)?.to).toBe('2.0.0')
  })

  it('yarn is MOST-SPECIFIC — a scoped key beats the global regardless of order', () => {
    const { canonical } = captureOverrides({ foo: '1.0.0', 'bar/foo': '2.0.0' }, 'yarn')
    expect(governingOverrideFor('foo', ['bar'], canonical)?.to).toBe('2.0.0')
    const rev = captureOverrides({ 'bar/foo': '2.0.0', foo: '1.0.0' }, 'yarn')
    expect(governingOverrideFor('foo', ['bar'], rev.canonical)?.to).toBe('2.0.0')
  })

  it('a global override still applies when nothing more specific competes', () => {
    const { canonical } = captureOverrides({ lodash: '4.17.21' }, 'npm')
    expect(governingOverrideFor('lodash', ['anything'], canonical)?.to).toBe('4.17.21')
  })

  it('any unstamped constraint present falls back to most-specific (npm first-match needs a fully-stamped set)', () => {
    const { canonical } = captureOverrides({ foo: '1.0.0', bar: { foo: '2.0.0' } }, 'npm')
    const mixed = [...canonical, { package: 'foo', parentPath: ['bar'], to: '9.9.9' }] // hand-built, no origin
    // an unstamped ("unknown PM") constraint → conservative most-specific, NOT npm
    // first-match. Pins fold via mergeOverrides tuple-collision (global) so they
    // REPLACE rather than mix — this sharp edge stays rare in practice.
    expect(governingOverrideFor('foo', ['bar'], mixed)?.to).toBe('2.0.0')
  })
})

describe('overrides — Gap 3: governingOverrideFor (public policy query)', () => {
  it('returns the whole constraint, or undefined when none governs', () => {
    const { canonical } = captureOverrides({ lodash: '4.17.21' }, 'npm')
    expect(governingOverrideFor('lodash', [], canonical)).toMatchObject({ package: 'lodash', to: '4.17.21' })
    expect(governingOverrideFor('missing', [], canonical)).toBeUndefined()
  })
})

describe('overrides — Confirm A: pinOverride survives mutate via overridesOf (frozen-clean)', () => {
  it('overridesOf folds the pin post-mutate and pnpm re-emits the overrides: block', async () => {
    const graph = graphOf(builder => {
      const ws = addPackage(builder, { name: 'app', version: '0.0.0', workspacePath: '.' })
      const old = addPackage(builder, { name: 'axios', version: '1.5.0' })
      addPackage(builder, { name: 'axios', version: '1.6.0' })
      addEdge(builder, ws, old, 'dep', '^1.5.0')
    })

    const { graph: pinned } = await pinOverride(graph, 'axios', '1.6.0', { registry: frozenRegistry(graph) })

    // overridesOf now reflects the pin — the parse-carriers would return [] here.
    expect(overridesOf(pinned)).toContainEqual({ package: 'axios', to: '1.6.0' })

    // The documented idiom re-emits the pnpm `overrides:` block → a later
    // `pnpm install --frozen-lockfile` stays clean (no CONFIG_MISMATCH).
    const out = stringify('pnpm-v9', pinned, { overrides: overridesOf(pinned), strict: false })
    expect(out).toContain('overrides:')
    expect(out).toContain('axios: 1.6.0')
  })
})

describe('overrides — Gap 1: completion honors declared overrides', () => {
  // A registry where `left-pad` declares a transitive dep on `lodash`, and lodash
  // is available at 4.17.20 and 4.17.21. Without an override, completion resolves
  // lodash to the highest (4.17.21); an override for lodash must redirect it.
  const registry: RegistryAdapter = {
    async packument(name): Promise<Packument | undefined> {
      if (name === 'left-pad') {
        return {
          name, distTags: { latest: '1.3.0' },
          versions: { '1.3.0': { name, version: '1.3.0', dependencies: { lodash: '^4.17.0' } } },
        }
      }
      if (name === 'lodash') {
        return {
          name, distTags: { latest: '4.17.21' },
          versions: {
            '4.17.20': { name, version: '4.17.20' },
            '4.17.21': { name, version: '4.17.21' },
          },
        }
      }
      return undefined
    },
    async resolve(name, range) {
      const p = await this.packument(name)
      if (p === undefined) return undefined
      const vs = Object.keys(p.versions).sort().reverse() // crude highest
      const hit = range.startsWith('^') || range.startsWith('~') || range === '*'
        ? vs.find(v => v.startsWith(range.replace(/^[\^~]/, '').split('.')[0]!)) ?? vs[0]
        : range
      return p.versions[hit!] ?? p.versions[vs[0]!]
    },
  }

  const seedGraph = () => graphOf(builder => {
    const ws = addPackage(builder, { name: 'app', version: '0.0.0', workspacePath: '.' })
    const lp = addPackage(builder, { name: 'left-pad', version: '1.3.0' })
    addEdge(builder, ws, lp, 'dep', '^1.3.0')
  })

  it('without an override, a new lodash edge resolves to registry-highest (4.17.21)', async () => {
    const result = await completeTransitives(seedGraph(), registry)
    expect(result.added).toContain('lodash@4.17.21')
    expect(result.added).not.toContain('lodash@4.17.20')
  })

  it('with an override, the new lodash edge binds the forced target (4.17.20) VERBATIM', async () => {
    const result = await completeTransitives(seedGraph(), registry, {
      overrides: [{ package: 'lodash', to: '4.17.20' }],
    })
    expect(result.added).toContain('lodash@4.17.20')
    expect(result.added).not.toContain('lodash@4.17.21')
  })
})

describe('overrides — HIGH-1: a scoped override must not collapse a shared descriptor', () => {
  // left-pad AND right-pad both declare lodash@^4.17.0; the override scopes lodash
  // to 4.17.20 ONLY under left-pad. The PM emits TWO lodash versions — the lib must
  // not let STEP-0 dedup serve left-pad's scoped binding to out-of-scope right-pad.
  const registry: RegistryAdapter = {
    async packument(name): Promise<Packument | undefined> {
      if (name === 'left-pad' || name === 'right-pad') {
        return { name, distTags: { latest: '1.0.0' }, versions: { '1.0.0': { name, version: '1.0.0', dependencies: { lodash: '^4.17.0' } } } }
      }
      if (name === 'lodash') {
        return { name, distTags: { latest: '4.17.21' }, versions: { '4.17.20': { name, version: '4.17.20' }, '4.17.21': { name, version: '4.17.21' } } }
      }
      return undefined
    },
    async resolve(name, range) {
      const p = await this.packument(name)
      if (p === undefined) return undefined
      return p.versions[range] ?? p.versions['4.17.21'] ?? Object.values(p.versions)[0] // exact (override target), else highest
    },
  }

  it('out-of-scope consumer resolves normally → BOTH versions present (no collapse)', async () => {
    const graph = graphOf(builder => {
      const ws = addPackage(builder, { name: 'app', version: '0.0.0', workspacePath: '.' })
      const lp = addPackage(builder, { name: 'left-pad', version: '1.0.0' })
      const rp = addPackage(builder, { name: 'right-pad', version: '1.0.0' })
      addEdge(builder, ws, lp, 'dep', '^1.0.0')
      addEdge(builder, ws, rp, 'dep', '^1.0.0')
    })
    const result = await completeTransitives(graph, registry, {
      overrides: [{ package: 'lodash', parentPath: ['left-pad'], to: '4.17.20' }],
    })
    expect(result.added).toContain('lodash@4.17.20') // left-pad, scoped
    expect(result.added).toContain('lodash@4.17.21') // right-pad, out of scope → highest
  })
})
