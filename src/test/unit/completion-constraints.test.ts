// ADR-0037 — completion constraints: node-local acceptance filter.

import { describe, expect, it } from 'vitest'
import semver from 'semver'
import {
  completeTransitives,
} from '../../main/ts/complete/tree-complete.ts'
import {
  engines,
  license,
  selectConstrained,
  type Condition,
  type ConditionContext,
} from '../../main/ts/complete/constraints.ts'
import type { Packument, PackumentVersion, RegistryAdapter } from '../../main/ts/registry/types.ts'
import { parseSri } from '../../main/ts/recipe/integrity.ts'
import { addEdge, addPackage, graphOf } from './_modify-test-utils.ts'

// ── helpers ──────────────────────────────────────────────────────────────────

const ctxOf = (corgi: PackumentVersion, full?: PackumentVersion): ConditionContext => ({
  name: corgi.name, version: corgi.version, corgi, manifest: async () => full, limit: task => task(),
})

interface MockOpts {
  /** full single-version manifests (with license / libc), keyed name→version. */
  manifests?: Record<string, Record<string, PackumentVersion>>
  /** manifest() call recorder. */
  onManifest?: (name: string, version: string) => void
  /** drop `manifest` from the adapter (corgi-only adapter). */
  noManifest?: boolean
}

function mockRegistry(pkgs: Record<string, Record<string, PackumentVersion>>, opts: MockOpts = {}): RegistryAdapter {
  const packumentOf = (name: string): Packument | undefined => {
    const versions = pkgs[name]
    if (versions === undefined) return undefined
    const latest = semver.maxSatisfying(Object.keys(versions), '*') ?? Object.keys(versions)[0]!
    return { name, distTags: { latest }, versions }
  }
  const manifestFn = async (name: string, version: string): Promise<PackumentVersion | undefined> => {
    opts.onManifest?.(name, version)
    return opts.manifests?.[name]?.[version] ?? pkgs[name]?.[version]
  }
  const adapter: RegistryAdapter = {
    async packument(name) { return packumentOf(name) },
    async resolve(name, range) {
      const p = packumentOf(name)
      if (p === undefined) return undefined
      const v = p.versions[range] !== undefined
        ? range
        : (p.distTags[range] ?? semver.maxSatisfying(Object.keys(p.versions), range) ?? undefined)
      if (v === undefined) return undefined
      const base = p.versions[v]
      if (base === undefined) return undefined
      // Mirror liveRegistry.resolve's libc backfill so this mock is a FAITHFUL
      // oracle for the frozen-clean parity test (constrained mint == unconstrained).
      if (!opts.noManifest && base.os?.includes('linux') === true && base.libc === undefined) {
        const full = await manifestFn(name, v)
        if (full !== undefined) return full
      }
      return base
    },
  }
  if (!opts.noManifest) adapter.manifest = manifestFn
  return adapter
}

// app(ws) → foo@1.0.0; foo's packument declares the transitive deps under test.
const seedFooGraph = () => graphOf(builder => {
  const ws = addPackage(builder, { name: 'app', version: '0.0.0', workspacePath: '.' })
  const foo = addPackage(builder, { name: 'foo', version: '1.0.0' })
  addEdge(builder, ws, foo, 'dep', '^1.0.0')
})

// ── engines factory (pure evaluate) ──────────────────────────────────────────

describe('complete/constraints — engines factory', () => {
  const gate = engines({ node: '>=18' })

  it('accepts a package whose declared engines COVER the target (>=16 ⊇ >=18)', async () => {
    expect(await gate.evaluate(ctxOf({ name: 'x', version: '1.0.0', engines: { node: '>=16' } }))).toEqual({ ok: true })
  })

  it('rejects a package that needs a newer node than the target floor (>=20 vs floor 18)', async () => {
    const v = await gate.evaluate(ctxOf({ name: 'x', version: '1.0.0', engines: { node: '>=20' } }))
    expect(v.ok).toBe(false)
  })

  it('accepts a discrete `||` declaration covering the target floor (regression — subset wrongly rejected these)', async () => {
    expect(await gate.evaluate(ctxOf({ name: 'x', version: '1.0.0', engines: { node: '^16 || ^18 || ^20' } }))).toEqual({ ok: true })
    expect(await gate.evaluate(ctxOf({ name: 'x', version: '1.0.0', engines: { node: '14 || 16 || 18' } }))).toEqual({ ok: true })
  })

  it('a point target degrades to npm-exact satisfies', async () => {
    const point = engines({ node: '18.17.0' })
    expect(await point.evaluate(ctxOf({ name: 'x', version: '1.0.0', engines: { node: '^16 || ^18 || ^20' } }))).toEqual({ ok: true })
    expect((await point.evaluate(ctxOf({ name: 'x', version: '1.0.0', engines: { node: '>=20' } }))).ok).toBe(false)
  })

  it('lenient (default) — a package with no engines is accepted (npm parity)', async () => {
    expect(await gate.evaluate(ctxOf({ name: 'x', version: '1.0.0' }))).toEqual({ ok: true })
  })

  it('strict — a package with no engines is rejected', async () => {
    const strict = engines({ node: '>=18' }, { mode: 'strict' })
    const v = await strict.evaluate(ctxOf({ name: 'x', version: '1.0.0' }))
    expect(v.ok).toBe(false)
  })

  it('engines "*" is unconstrained → accept', async () => {
    expect(await gate.evaluate(ctxOf({ name: 'x', version: '1.0.0', engines: { node: '*' } }))).toEqual({ ok: true })
  })

  it('unparseable declared range → unevaluable', async () => {
    const v = await gate.evaluate(ctxOf({ name: 'x', version: '1.0.0', engines: { node: 'not-a-range' } }))
    expect(v.ok).toBe('unevaluable')
  })

  it('is cost 0 (corgi tier)', () => {
    expect(gate.cost).toBe(0)
  })
})

// ── license factory (pure evaluate) ──────────────────────────────────────────

describe('complete/constraints — license factory', () => {
  it('denies a denied license (from the full manifest)', async () => {
    const gate = license({ deny: ['GPL-3.0'] })
    const v = await gate.evaluate(ctxOf(
      { name: 'x', version: '1.0.0' },
      { name: 'x', version: '1.0.0', license: 'GPL-3.0' },
    ))
    expect(v.ok).toBe(false)
  })

  it('accepts an allowed license', async () => {
    const gate = license({ allow: ['MIT', 'Apache-2.0'] })
    expect(await gate.evaluate(ctxOf(
      { name: 'x', version: '1.0.0' },
      { name: 'x', version: '1.0.0', license: 'MIT' },
    ))).toEqual({ ok: true })
  })

  it('SPDX expression → unevaluable (not id-comparable in v1)', async () => {
    const gate = license({ allow: ['MIT'] })
    const v = await gate.evaluate(ctxOf(
      { name: 'x', version: '1.0.0' },
      { name: 'x', version: '1.0.0', license: '(MIT OR Apache-2.0)' },
    ))
    expect(v.ok).toBe('unevaluable')
  })

  it('no manifest (corgi-only adapter) → unevaluable', async () => {
    const gate = license({ allow: ['MIT'] })
    const v = await gate.evaluate(ctxOf({ name: 'x', version: '1.0.0' })) // full=undefined
    expect(v.ok).toBe('unevaluable')
  })

  it('is cost 10 (full-manifest tier)', () => {
    expect(license({ allow: ['MIT'] }).cost).toBe(10)
  })
})

// ── selectConstrained + completeTransitives (integration) ────────────────────

describe('complete/constraints — engine-aware selection', () => {
  it('picks the highest ENGINE-PASSING version, skipping a higher incompatible one', async () => {
    const registry = mockRegistry({
      foo: { '1.0.0': { name: 'foo', version: '1.0.0', dependencies: { bar: '^1.0.0' } } },
      bar: {
        '1.0.0': { name: 'bar', version: '1.0.0', engines: { node: '>=16' } },
        '1.5.0': { name: 'bar', version: '1.5.0', engines: { node: '>=20' } }, // incompatible with >=18
      },
    })
    const result = await completeTransitives(seedFooGraph(), registry, {
      constraints: [engines({ node: '>=18' })],
    })
    expect(result.added).toContain('bar@1.0.0')
    expect(result.added).not.toContain('bar@1.5.0')
  })

  it('without constraints, resolves to the registry-highest (unchanged behaviour)', async () => {
    const registry = mockRegistry({
      foo: { '1.0.0': { name: 'foo', version: '1.0.0', dependencies: { bar: '^1.0.0' } } },
      bar: {
        '1.0.0': { name: 'bar', version: '1.0.0', engines: { node: '>=16' } },
        '1.5.0': { name: 'bar', version: '1.5.0', engines: { node: '>=20' } },
      },
    })
    const result = await completeTransitives(seedFooGraph(), registry)
    expect(result.added).toContain('bar@1.5.0')
  })

  it('emits a RECOVERABLE COMPLETION_NO_CANDIDATE (warning) with an attribution payload when no version passes', async () => {
    const registry = mockRegistry({
      foo: { '1.0.0': { name: 'foo', version: '1.0.0', dependencies: { bar: '^1.0.0' } } },
      bar: { '1.5.0': { name: 'bar', version: '1.5.0', engines: { node: '>=20' } } },
    })
    const result = await completeTransitives(seedFooGraph(), registry, {
      constraints: [engines({ node: '>=18' })],
    })
    const nc = result.unresolved.find(d => d.code === 'COMPLETION_NO_CANDIDATE')
    expect(nc).toBeDefined()
    expect(nc!.severity).toBe('warning') // recoverable
    expect(result.added).not.toContain('bar@1.5.0') // edge left unwired
    // load-bearing attribution: which axis rejected which version
    const data = nc!.data as { depName: string; range: string; rejected: Array<{ version: string; by: string; reason?: string }> }
    expect(data.depName).toBe('bar')
    expect(data.rejected[0]).toMatchObject({ version: '1.5.0', by: 'engines' })
    expect(data.rejected[0]!.reason).toBeTypeOf('string')
  })

  it('NO_CANDIDATE is recoverable — a sibling dep still completes', async () => {
    const registry = mockRegistry({
      foo: { '1.0.0': { name: 'foo', version: '1.0.0', dependencies: { bar: '^1.0.0', baz: '^1.0.0' } } },
      bar: { '1.5.0': { name: 'bar', version: '1.5.0', engines: { node: '>=20' } } },        // no candidate
      baz: { '1.0.0': { name: 'baz', version: '1.0.0', engines: { node: '>=16' } } },        // ok
    })
    const result = await completeTransitives(seedFooGraph(), registry, {
      constraints: [engines({ node: '>=18' })],
    })
    expect(result.unresolved.some(d => d.code === 'COMPLETION_NO_CANDIDATE')).toBe(true)
    expect(result.added).toContain('baz@1.0.0') // sibling still minted
  })
})

describe('complete/constraints — license axis + cost ordering', () => {
  it('denies by license using the FULL manifest', async () => {
    const registry = mockRegistry(
      {
        foo: { '1.0.0': { name: 'foo', version: '1.0.0', dependencies: { bar: '^1.0.0' } } },
        bar: { '1.0.0': { name: 'bar', version: '1.0.0' } }, // corgi carries no license
      },
      { manifests: { bar: { '1.0.0': { name: 'bar', version: '1.0.0', license: 'GPL-3.0' } } } },
    )
    const result = await completeTransitives(seedFooGraph(), registry, {
      constraints: [license({ deny: ['GPL-3.0'] })],
    })
    expect(result.added).not.toContain('bar@1.0.0')
    expect(result.unresolved.some(d => d.code === 'COMPLETION_NO_CANDIDATE')).toBe(true)
  })

  it('cost ordering — a version engines rejects never triggers the license manifest fetch', async () => {
    const fetched: string[] = []
    const registry = mockRegistry(
      {
        foo: { '1.0.0': { name: 'foo', version: '1.0.0', dependencies: { bar: '^1.0.0' } } },
        bar: {
          '1.0.0': { name: 'bar', version: '1.0.0', engines: { node: '>=16' } },
          '1.5.0': { name: 'bar', version: '1.5.0', engines: { node: '>=20' } }, // engines-rejected
        },
      },
      { onManifest: (n, v) => fetched.push(`${n}@${v}`) },
    )
    await completeTransitives(seedFooGraph(), registry, {
      constraints: [engines({ node: '>=18' }), license({ allow: ['MIT'] })],
    })
    // 1.5.0 fails cost-0 engines first → its manifest is never fetched
    expect(fetched).not.toContain('bar@1.5.0')
  })
})

describe('complete/constraints — override conflict + libc backfill + errors', () => {
  it('an override forcing a constraint-violating version → COMPLETION_OVERRIDE_CONSTRAINT_CONFLICT', async () => {
    const registry = mockRegistry({
      foo: { '1.0.0': { name: 'foo', version: '1.0.0', dependencies: { bar: '^1.0.0' } } },
      bar: {
        '1.0.0': { name: 'bar', version: '1.0.0', engines: { node: '>=16' } },
        '1.5.0': { name: 'bar', version: '1.5.0', engines: { node: '>=20' } },
      },
    })
    const result = await completeTransitives(seedFooGraph(), registry, {
      overrides: [{ package: 'bar', to: '1.5.0' }],
      constraints: [engines({ node: '>=18' })],
    })
    expect(result.unresolved.some(d => d.code === 'COMPLETION_OVERRIDE_CONSTRAINT_CONFLICT')).toBe(true)
    expect(result.added).not.toContain('bar@1.5.0')
  })

  it('libc backfill preserved — a linux winner with no corgi libc fetches its manifest', async () => {
    const fetched: string[] = []
    const registry = mockRegistry(
      {
        foo: { '1.0.0': { name: 'foo', version: '1.0.0', dependencies: { bar: '^1.0.0' } } },
        bar: { '1.0.0': { name: 'bar', version: '1.0.0', engines: { node: '>=16' }, os: ['linux'] } }, // corgi: no libc
      },
      {
        onManifest: (n, v) => fetched.push(`${n}@${v}`),
        manifests: { bar: { '1.0.0': { name: 'bar', version: '1.0.0', os: ['linux'], libc: ['glibc'] } } },
      },
    )
    const result = await completeTransitives(seedFooGraph(), registry, {
      constraints: [engines({ node: '>=18' })],
    })
    expect(result.added).toContain('bar@1.0.0')
    expect(fetched).toContain('bar@1.0.0') // backfill fetched the full manifest
  })

  it('a condition that THROWS hard-fails the whole call', async () => {
    const registry = mockRegistry({
      foo: { '1.0.0': { name: 'foo', version: '1.0.0', dependencies: { bar: '^1.0.0' } } },
      bar: { '1.0.0': { name: 'bar', version: '1.0.0' } },
    })
    const boom: Condition = { kind: 'boom', cost: 0, evaluate() { throw new Error('kaboom') } }
    await expect(completeTransitives(seedFooGraph(), registry, { constraints: [boom] }))
      .rejects.toThrow(/boom.*kaboom/)
  })
})

describe('complete/constraints — selectConstrained directly', () => {
  const registry = mockRegistry({
    bar: {
      '1.0.0': { name: 'bar', version: '1.0.0', engines: { node: '>=16' } },
      '1.2.0': { name: 'bar', version: '1.2.0', engines: { node: '>=18' } },
      '1.5.0': { name: 'bar', version: '1.5.0', engines: { node: '>=20' } },
    },
  })

  it('returns the highest passing version, in descending order tried', async () => {
    const sel = await selectConstrained(registry, 'bar', '^1.0.0', [engines({ node: '>=18' })], 'reject')
    expect(sel.selected?.version).toBe('1.2.0')
    // 1.5.0 was tried and rejected before 1.2.0 was accepted
    expect(sel.rejected.map(r => r.version)).toEqual(['1.5.0'])
  })

  it('unknown package → no selection, no rejections (caller emits UNRESOLVED)', async () => {
    const sel = await selectConstrained(registry, 'nope', '^1.0.0', [engines({ node: '>=18' })], 'reject')
    expect(sel.selected).toBeUndefined()
    expect(sel.rejected).toEqual([])
  })

  it('is deterministic across runs', async () => {
    const a = await selectConstrained(registry, 'bar', '>=1.0.0', [engines({ node: '>=18' })], 'reject')
    const b = await selectConstrained(registry, 'bar', '>=1.0.0', [engines({ node: '>=18' })], 'reject')
    expect(a.selected?.version).toBe(b.selected?.version)
  })
})

// FROZEN-CLEAN: a constrained mint MUST be byte-identical to the unconstrained
// mint of the same version — else the constraint path could write a lock the PM
// rewrites (integrity/libc/field drift). This is the load-bearing guard.
describe('complete/constraints — frozen-clean parity', () => {
  const REAL_SRI = 'sha512-v2kDEe57lecTulaDIuNTPy3Ry4gLGJ6Z1O3vE1krgXZNrsQ+LFTGHqxhoLj0jyGCwlChSjhO66etF1Yx9pE7Q=='
  // bar 1.0.0 AND 1.5.0 both satisfy engines>=18 (declared >=16), so the
  // constrained path selects the SAME version the unconstrained path does (1.5.0).
  const pkgs = (): Record<string, Record<string, PackumentVersion>> => ({
    foo: { '1.0.0': { name: 'foo', version: '1.0.0', dependencies: { bar: '^1.0.0' } } },
    bar: {
      '1.0.0': { name: 'bar', version: '1.0.0', engines: { node: '>=16' } },
      '1.5.0': {
        name: 'bar', version: '1.5.0', engines: { node: '>=16' },
        tarball: 'https://registry.npmjs.org/bar/-/bar-1.5.0.tgz',
        integrity: parseSri(REAL_SRI, 'registry'),
      },
    },
  })

  it('minted node + tarball payload are byte-identical with vs without constraints (integrity/tarball preserved)', async () => {
    const plain = await completeTransitives(seedFooGraph(), mockRegistry(pkgs()))
    const gated = await completeTransitives(seedFooGraph(), mockRegistry(pkgs()), {
      constraints: [engines({ node: '>=18' })],
    })
    expect(gated.added).toContain('bar@1.5.0')
    expect(gated.graph.getNode('bar@1.5.0')).toEqual(plain.graph.getNode('bar@1.5.0'))
    expect(gated.graph.tarballOf('bar@1.5.0')).toEqual(plain.graph.tarballOf('bar@1.5.0'))
    expect(gated.graph.tarballOf('bar@1.5.0')?.integrity).toBeDefined() // integrity actually carried, not dropped
  })

  it('the wired edge (attrs, kind, endpoints) is identical with vs without constraints', async () => {
    const plain = await completeTransitives(seedFooGraph(), mockRegistry(pkgs()))
    const gated = await completeTransitives(seedFooGraph(), mockRegistry(pkgs()), {
      constraints: [engines({ node: '>=18' })],
    })
    expect(gated.wired).toEqual(plain.wired)
  })

  it('libc backfill parity — constrained linux mint == unconstrained (both backfill libc from the manifest)', async () => {
    const pkgsLibc = (): Record<string, Record<string, PackumentVersion>> => ({
      foo: { '1.0.0': { name: 'foo', version: '1.0.0', dependencies: { bar: '^1.0.0' } } },
      bar: { '1.0.0': { name: 'bar', version: '1.0.0', engines: { node: '>=16' }, os: ['linux'] } },
    })
    const manifests = { bar: { '1.0.0': { name: 'bar', version: '1.0.0', os: ['linux'], libc: ['glibc'] } } }
    const plain = await completeTransitives(seedFooGraph(), mockRegistry(pkgsLibc(), { manifests }))
    const gated = await completeTransitives(seedFooGraph(), mockRegistry(pkgsLibc(), { manifests }), {
      constraints: [engines({ node: '>=18' })],
    })
    expect(gated.graph.getNode('bar@1.0.0')).toEqual(plain.graph.getNode('bar@1.0.0'))
    expect(gated.graph.tarballOf('bar@1.0.0')).toEqual(plain.graph.tarballOf('bar@1.0.0'))
  })

  it('whole-graph determinism — two constrained runs mint the identical node', async () => {
    const a = await completeTransitives(seedFooGraph(), mockRegistry(pkgs()), { constraints: [engines({ node: '>=18' })] })
    const b = await completeTransitives(seedFooGraph(), mockRegistry(pkgs()), { constraints: [engines({ node: '>=18' })] })
    expect(a.added).toEqual(b.added)
    expect(a.graph.getNode('bar@1.5.0')).toEqual(b.graph.getNode('bar@1.5.0'))
    expect(a.graph.tarballOf('bar@1.5.0')).toEqual(b.graph.tarballOf('bar@1.5.0'))
  })
})

// ADR-0037 v2 — opt-in bounded-backtracking DISCOVERY. Read-only: finds a lower
// consumer version that clears a cliff and suggests the override; never mutates
// the emitted lock.
describe('complete/constraints — bounded-backtracking discovery (v2)', () => {
  // foo@1.9 → bar@^2 (only node>=20, cliffs on >=18); foo@1.4 → bar@^1 (node>=16, clean).
  const pkgs = (): Record<string, Record<string, PackumentVersion>> => ({
    foo: {
      '1.4.0': { name: 'foo', version: '1.4.0', engines: { node: '>=16' }, dependencies: { bar: '^1.0.0' } },
      '1.9.0': { name: 'foo', version: '1.9.0', engines: { node: '>=16' }, dependencies: { bar: '^2.0.0' } },
    },
    bar: {
      '1.0.0': { name: 'bar', version: '1.0.0', engines: { node: '>=16' } },
      '2.0.0': { name: 'bar', version: '2.0.0', engines: { node: '>=20' } },
    },
  })
  // app(ws) → foo@1.9.0 (declared ^1.0.0); completion walks foo, mints its bar dep → cliff.
  const seed = () => graphOf(builder => {
    const app = addPackage(builder, { name: 'app', version: '0.0.0', workspacePath: '.' })
    const foo = addPackage(builder, { name: 'foo', version: '1.9.0' })
    addEdge(builder, app, foo, 'dep', '^1.0.0')
  })

  it('finds the lower consumer version that clears the cliff + suggests the override', async () => {
    const result = await completeTransitives(seed(), mockRegistry(pkgs()), {
      constraints: [engines({ node: '>=18' })],
      budget: { maxCombinations: 10 },
    })
    const nc = result.unresolved.find(d => d.code === 'COMPLETION_NO_CANDIDATE')
    expect(nc).toBeDefined()
    expect((nc!.data as { suggestion?: { consumer: string; version: string } }).suggestion)
      .toMatchObject({ consumer: 'foo', version: '1.4.0' })
  })

  it('without a budget → no suggestion (v1 behaviour unchanged)', async () => {
    const result = await completeTransitives(seed(), mockRegistry(pkgs()), {
      constraints: [engines({ node: '>=18' })],
    })
    const nc = result.unresolved.find(d => d.code === 'COMPLETION_NO_CANDIDATE')
    expect(nc).toBeDefined()
    expect((nc!.data as Record<string, unknown>).suggestion).toBeUndefined()
  })

  it('the probe is READ-ONLY — added/wired identical with vs without a budget', async () => {
    const withB = await completeTransitives(seed(), mockRegistry(pkgs()), {
      constraints: [engines({ node: '>=18' })], budget: { maxCombinations: 10 },
    })
    const withoutB = await completeTransitives(seed(), mockRegistry(pkgs()), {
      constraints: [engines({ node: '>=18' })],
    })
    expect(withB.added).toEqual(withoutB.added)
    expect(withB.wired).toEqual(withoutB.wired)
  })

  it('budget exhausted → flagged, no suggestion', async () => {
    const result = await completeTransitives(seed(), mockRegistry(pkgs()), {
      constraints: [engines({ node: '>=18' })],
      budget: { maxCombinations: 0 },
    })
    const nc = result.unresolved.find(d => d.code === 'COMPLETION_NO_CANDIDATE')
    expect((nc!.data as Record<string, unknown>).budgetExhausted).toBe(true)
    expect((nc!.data as Record<string, unknown>).suggestion).toBeUndefined()
  })

  it('no lower consumer works → plain NO_CANDIDATE (no suggestion, not exhausted)', async () => {
    const badPkgs: Record<string, Record<string, PackumentVersion>> = {
      foo: {
        '1.4.0': { name: 'foo', version: '1.4.0', engines: { node: '>=16' }, dependencies: { bar: '^1.0.0' } },
        '1.9.0': { name: 'foo', version: '1.9.0', engines: { node: '>=16' }, dependencies: { bar: '^2.0.0' } },
      },
      bar: {
        '1.0.0': { name: 'bar', version: '1.0.0', engines: { node: '>=20' } }, // foo@1.4's bar also dirty
        '2.0.0': { name: 'bar', version: '2.0.0', engines: { node: '>=20' } },
      },
    }
    const result = await completeTransitives(seed(), mockRegistry(badPkgs), {
      constraints: [engines({ node: '>=18' })],
      budget: { maxCombinations: 10 },
    })
    const nc = result.unresolved.find(d => d.code === 'COMPLETION_NO_CANDIDATE')
    expect((nc!.data as Record<string, unknown>).suggestion).toBeUndefined()
    expect((nc!.data as Record<string, unknown>).budgetExhausted).toBeUndefined()
  })
})
