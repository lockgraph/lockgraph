// Bug #99 — descriptor→node resolution ladder, proven on the committed
// backstage/backstage lock (a 1.8 MB yarn-berry-v8 monorepo lock + its root
// package.json `resolutions`).
//
// backstage pins csstype via VERSION-CONDITIONED resolutions:
//   "csstype@npm:^3.0.2": "3.0.9", "csstype@npm:^3.1.2": "3.0.9",
//   "csstype@npm:^3.1.3": "3.0.9"
// The pinned entry key is `csstype@npm:3.0.9`; every consumer's range
// (`^3.0.2` / `^3.1.2` / `^3.1.3`) misses that exact key (Rung 0).
//
// Pre-fix the consumer ranges either (a) resolved to the WRONG node via
// max-satisfying semver — `^3.1.3` → csstype 3.1.3 (the lock also carries a
// `csstype@npm:^3.0.10` → 3.1.3 entry) — leaving the PINNED 3.0.9 node orphaned
// (0 incoming edges), which optimize would GC and the dependency would vanish on
// round-trip; or (b) where no satisfying sibling existed, dropped outright. The
// override map (from the root manifest — yarn writes no lock-borne resolutions)
// re-points every csstype consumer onto the pinned 3.0.9 node.
//
// Empirically on this fixture: 9 csstype consumer edges. WITHOUT manifests →
// 9 land on csstype 3.1.3 and the pinned csstype 3.0.9 has 0 incoming; WITH
// manifests → those 9 land on csstype 3.0.9 (override) and 3.1.3 has 0.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse, stringify } from '../../../main/ts/index.ts'
import type { Graph, Manifest } from '../../../main/ts/graph.ts'

const here = dirname(fileURLToPath(import.meta.url))
const fixtureDir = resolve(here, '../../resources/fixtures/real-world/backstage-backstage-master-b55138e')
const lock = readFileSync(resolve(fixtureDir, 'yarn.lock'), 'utf8')
const rootPkg = JSON.parse(readFileSync(resolve(fixtureDir, 'package.json'), 'utf8')) as {
  resolutions?: Record<string, string>
}

// Only the root manifest's `resolutions` is needed for the override map (the
// csstype pins are global — no parent scope). yarn writes no lock-borne
// resolutions, so this is the sole source of the override constraints.
const manifests: Record<string, Manifest> = {
  '': { native: { yarnResolutions: rootPkg.resolutions } },
}

const CSSTYPE_309 = 'csstype@3.0.9' // the PINNED node
const CSSTYPE_313 = 'csstype@3.1.3' // the (non-pin) max-satisfying sibling

const depIncoming = (g: Graph, id: string): number =>
  g.in(id).filter(e => e.kind === 'dep' || e.kind === 'optional').length

// Resolved csstype-edge target versions across the whole graph → count by version.
function csstypeTargets(g: Graph): Map<string, number> {
  const out = new Map<string, number>()
  for (const n of g.nodes()) {
    for (const e of g.out(n.id)) {
      const dst = g.getNode(e.dst)
      if (dst?.name !== 'csstype') continue
      out.set(dst.version, (out.get(dst.version) ?? 0) + 1)
    }
  }
  return out
}

describe('Bug #99 — backstage resolutions-pin ladder (real-world)', () => {
  it('WITHOUT manifests: the pinned csstype 3.0.9 node is ORPHANED (the bug)', () => {
    const g = parse('yarn-berry-v8', lock)
    expect(g.getNode(CSSTYPE_309)).toBeDefined()
    // No override map → the `^3.x` consumers mis-resolve to 3.1.3 (semver), so
    // the pinned 3.0.9 carries zero incoming dep edges — orphaned, GC-bait.
    expect(depIncoming(g, CSSTYPE_309)).toBe(0)
    // …and the mis-resolution lands on 3.1.3 instead.
    expect(depIncoming(g, CSSTYPE_313)).toBeGreaterThan(0)
  })

  it('WITH manifests: every csstype consumer re-points onto the PINNED 3.0.9 (override map)', () => {
    const withM = parse('yarn-berry-v8', lock, { manifests })
    // The override rung restores the pin: 3.0.9 gains the incoming edges…
    const before = depIncoming(parse('yarn-berry-v8', lock), CSSTYPE_309)
    const after = depIncoming(withM, CSSTYPE_309)
    expect(after).toBeGreaterThan(before)
    expect(after).toBeGreaterThan(0)
    // …and they no longer mis-resolve to the non-pinned 3.1.3.
    expect(depIncoming(withM, CSSTYPE_313)).toBeLessThan(depIncoming(parse('yarn-berry-v8', lock), CSSTYPE_313))
  })

  it('the satisfying AND non-satisfying pins both land on 3.0.9 with manifests', () => {
    // `^3.0.2` (satisfying — 3.0.9 ∈ ^3.0.2) and `^3.1.3` (NON-satisfying —
    // 3.0.9 ∉ ^3.1.3) are BOTH version-conditioned overrides to 3.0.9; with the
    // map, all csstype 3.x consumers collapse onto the single pinned node.
    const withM = parse('yarn-berry-v8', lock, { manifests })
    const targets = csstypeTargets(withM)
    expect(targets.get('3.0.9') ?? 0).toBeGreaterThan(0)
    expect(targets.get('3.1.3') ?? 0).toBe(0)
  })

  it('an override whose `to` is a patch: descriptor re-resolves to the PATCH node (Rung 2 → Rung 1)', () => {
    // backstage pins ast-types to a patch:
    //   "ast-types@npm:^0.16.1": "patch:ast-types@npm%3A0.16.1#./.yarn/patches/…"
    // The override `to` is itself a `patch:` descriptor — Rung 2 must feed it
    // BACK through Rung 1's patch-descriptor path and bind the patch node, not
    // drop. (The `to` carries its own inner name, so the reconstructed lookup is
    // `ast-types@patch:ast-types@npm%3A0.16.1#…` — the genuinely tricky shape.)
    const countPatchTargets = (g: Graph): number => {
      let n = 0
      for (const node of g.nodes()) {
        for (const e of g.out(node.id)) {
          const dst = g.getNode(e.dst)
          if (dst?.name === 'ast-types' && dst.patch !== undefined) n++
        }
      }
      return n
    }
    const astDrops = (g: Graph): number =>
      g.diagnostics().filter(d => d.code === 'YARN_BERRY_UNRESOLVED_DEP' && /dependency ast-types=/.test(d.message)).length

    const withoutM = parse('yarn-berry-v8', lock)
    const withM = parse('yarn-berry-v8', lock, { manifests })
    // Bug #104 (lock-borne patch preference): the lock carries BOTH a base
    // `ast-types@npm:0.16.1` AND a sibling `ast-types@patch:…0.16.1` node. Even
    // WITHOUT manifests, an `npm:^0.16.1` consumer binds the base (Rung 3) and the
    // Rung-3 patch-preference OVERLAY then redirects it onto the patched copy —
    // the same node yarn installs — so patch targets appear from the lock alone.
    expect(countPatchTargets(withoutM)).toBeGreaterThan(0)
    // WITH manifests the override path (Rung 2 → Rung 1) ALSO yields patch
    // targets; it additionally rescues consumers with no base sibling to bind
    // (which would otherwise drop), so the count is at least the lock-borne one
    // and the ast-types drops fall to zero.
    expect(countPatchTargets(withM)).toBeGreaterThanOrEqual(countPatchTargets(withoutM))
    expect(countPatchTargets(withM)).toBeGreaterThan(0)
    // Each redirect WITHOUT an override fires the observable `_PATCH_PREFERRED`
    // info. Supplying manifests can only REPLACE a lock-borne overlay-redirect
    // with an authoritative override-redirect (which fires no `_PATCH_PREFERRED`),
    // never add one — so the count is monotone non-increasing. (A strict
    // no-double-redirect-under-override is proven on the controlled fixture in
    // yarn-patch-preference.test.ts; the backstage corpus mixes override-covered
    // and override-uncovered ast-types consumers, so here we assert the bound.)
    const patchPreferredCount = (g: Graph): number =>
      g.diagnostics().filter(d => d.code === 'YARN_BERRY_V8_PATCH_PREFERRED' && /ast-types=/.test(d.message)).length
    expect(patchPreferredCount(withoutM)).toBeGreaterThan(0)
    expect(patchPreferredCount(withM)).toBeLessThanOrEqual(patchPreferredCount(withoutM))
    // A consumer range satisfied by no base sibling (`^0.13.4` — neither 0.14.2
    // nor 0.16.1 satisfies it) still DROPS without manifests; the override map
    // (which version-conditions `^0.13.4`) rescues it, so drops fall to zero.
    expect(astDrops(withoutM)).toBeGreaterThan(0)
    expect(astDrops(withM)).toBe(0)
  })

  it('the dropped-edge set only SHRINKS (never grows) when manifests are supplied', () => {
    const before = parse('yarn-berry-v8', lock).diagnostics()
      .filter(d => d.code === 'YARN_BERRY_UNRESOLVED_DEP').length
    const after = parse('yarn-berry-v8', lock, { manifests }).diagnostics()
      .filter(d => d.code === 'YARN_BERRY_UNRESOLVED_DEP').length
    expect(after).toBeLessThanOrEqual(before)
  })

  it('the restored csstype dependency lines round-trip back into the emitted lock', () => {
    const withM = parse('yarn-berry-v8', lock, { manifests })
    const out = stringify('yarn-berry-v8', withM)
    // A consumer re-emits its `csstype: "npm:^3.1.3"` dependency line (the
    // NON-satisfying pin) now that the edge survived to the graph.
    expect(out).toMatch(/csstype: "npm:\^3\.1\.3"/)
  })

  it('round-trips the full lock without throwing (with + without manifests)', () => {
    expect(() => stringify('yarn-berry-v8', parse('yarn-berry-v8', lock))).not.toThrow()
    expect(() => stringify('yarn-berry-v8', parse('yarn-berry-v8', lock, { manifests }))).not.toThrow()
  })
})
