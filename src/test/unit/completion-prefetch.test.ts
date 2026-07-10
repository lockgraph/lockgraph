// Parallel packument prefetch — the fetches run concurrently (bounded by the
// registry's own limit), but resolution stays sequential + ordered, so the lock
// is byte-identical regardless of fetch-completion timing.

import { describe, expect, it } from 'vitest'
import semver from 'semver'
import { completeTransitives } from '../../main/ts/complete/tree-complete.ts'
import type { Packument, PackumentVersion, RegistryAdapter } from '../../main/ts/registry/types.ts'
import { addEdge, addPackage, graphOf } from './_modify-test-utils.ts'

interface Stats { active: number; peak: number }

// A registry whose packument() takes a per-name delay (to force out-of-order
// completion) and records peak concurrency.
function mkRegistry(
  pkgs: Record<string, Record<string, PackumentVersion>>,
  stats: Stats,
  delayMs: (name: string) => number,
): RegistryAdapter {
  const packumentOf = (name: string): Packument | undefined => {
    const versions = pkgs[name]
    if (versions === undefined) return undefined
    const latest = semver.maxSatisfying(Object.keys(versions), '*') ?? Object.keys(versions)[0]!
    return { name, distTags: { latest }, versions }
  }
  return {
    async packument(name) {
      stats.active++
      stats.peak = Math.max(stats.peak, stats.active)
      try {
        await new Promise(r => setTimeout(r, delayMs(name)))
        return packumentOf(name)
      } finally {
        stats.active--
      }
    },
    // resolve is NOT tracked/delayed — we measure the #1 prefetch concurrency only.
    async resolve(name, range) {
      const p = packumentOf(name)
      if (p === undefined) return undefined
      const v = p.versions[range] !== undefined
        ? range
        : (p.distTags[range] ?? semver.maxSatisfying(Object.keys(p.versions), range) ?? undefined)
      return v !== undefined ? p.versions[v] : undefined
    },
  }
}

// app(ws) → a, b, c (three siblings); a→d, b→d (a shared descriptor), c→e.
const pkgs = (): Record<string, Record<string, PackumentVersion>> => ({
  a: { '1.0.0': { name: 'a', version: '1.0.0', dependencies: { d: '^1.0.0' } } },
  b: { '1.0.0': { name: 'b', version: '1.0.0', dependencies: { d: '^1.0.0' } } },
  c: { '1.0.0': { name: 'c', version: '1.0.0', dependencies: { e: '^1.0.0' } } },
  d: { '1.0.0': { name: 'd', version: '1.0.0' }, '1.2.0': { name: 'd', version: '1.2.0' } },
  e: { '1.0.0': { name: 'e', version: '1.0.0' } },
})
const seed = () => graphOf(builder => {
  const app = addPackage(builder, { name: 'app', version: '0.0.0', workspacePath: '.' })
  for (const name of ['a', 'b', 'c']) {
    const n = addPackage(builder, { name, version: '1.0.0' })
    addEdge(builder, app, n, 'dep', '^1.0.0')
  }
})

describe('complete/prefetch — parallel packument fetch', () => {
  it('fetches sibling packuments CONCURRENTLY (peak > 1)', async () => {
    const stats: Stats = { active: 0, peak: 0 }
    await completeTransitives(seed(), mkRegistry(pkgs(), stats, () => 10))
    // a, b, c are pushed together when the workspace is walked → all prefetch at once.
    expect(stats.peak).toBeGreaterThan(1)
  })

  it('is BYTE-IDENTICAL regardless of fetch-completion order (determinism)', async () => {
    const s1: Stats = { active: 0, peak: 0 }
    const s2: Stats = { active: 0, peak: 0 }
    // Run 1: 'a' slow, 'e' fast. Run 2: the exact opposite ordering.
    const order = ['a', 'b', 'c', 'd', 'e']
    const r1 = await completeTransitives(seed(), mkRegistry(pkgs(), s1, n => (order.indexOf(n) + 1) * 8))
    const r2 = await completeTransitives(seed(), mkRegistry(pkgs(), s2, n => (order.length - order.indexOf(n)) * 8))
    // Different fetch-completion order (proven: some concurrency happened)…
    expect(s1.peak).toBeGreaterThan(1)
    // …but identical result: same added nodes, same wired edges, same shared-descriptor dedup.
    expect(r1.added.slice().sort()).toEqual(r2.added.slice().sort())
    expect(r1.wired).toEqual(r2.wired)
    expect(r1.graph.getNode('d@1.2.0')).toEqual(r2.graph.getNode('d@1.2.0'))
    // d is shared by a and b → exactly ONE d node minted (dedup held under concurrency)
    const dNodes = r1.added.filter(id => id.startsWith('d@'))
    expect(dNodes).toEqual(['d@1.2.0'])
  })

  it('a packument fetch is issued at most ONCE per name (memoised)', async () => {
    const calls: string[] = []
    const stats: Stats = { active: 0, peak: 0 }
    const base = mkRegistry(pkgs(), stats, () => 1)
    const counting: RegistryAdapter = {
      packument: n => { calls.push(n); return base.packument(n) },
      resolve: (n, r) => base.resolve(n, r),
    }
    await completeTransitives(seed(), counting)
    // d is reached from both a and b, but its packument is fetched once.
    expect(calls.filter(n => n === 'd')).toHaveLength(1)
  })
})
