// Regression (yaf .85 freeze-oracle bug): a BARE yarn `resolutions`/override
// pins a package that a completed edge also reaches. yarn rewrites EVERY matching
// descriptor to the pin and collapses the entry to a single key; the lib must do
// the same, else the extra raw-range descriptor makes `yarn install --immutable`
// fail YN0028. npm/pnpm are unaffected (they pre-resolve; their range stays in the
// parent's deps block). Fix: entryKeyOfNode / entrySpecsOfNode rewrite the edge's
// descriptor via the governing override (only when overrides are threaded to stringify).

import { describe, expect, it } from 'vitest'
import { stringify } from '../../main/ts/index.ts'
import { addEdge, addPackage, graphOf } from './_modify-test-utils.ts'
import type { OverrideConstraint } from '../../main/ts/graph.ts'

// hba pins minimist@1.2.5 (resolution-rewritten descriptor); hbb reaches it via a
// raw ^1.2.5 range (as a completed edge would). One node, two incoming descriptors.
const buildGraph = () => graphOf(b => {
  const ws = addPackage(b, { name: 'app', version: '0.0.0', workspacePath: '.' })
  const h1 = addPackage(b, { name: 'hba', version: '1.0.0' })
  const h2 = addPackage(b, { name: 'hbb', version: '1.0.0' })
  const m  = addPackage(b, { name: 'minimist', version: '1.2.5' })
  addEdge(b, ws, h1, 'dep', '^1.0.0')
  addEdge(b, ws, h2, 'dep', '^1.0.0')
  addEdge(b, h1, m, 'dep', '1.2.5')
  addEdge(b, h2, m, 'dep', '^1.2.5')
})
const OVERRIDES: OverrideConstraint[] = [{ package: 'minimist', to: '1.2.5' }]

describe('overrides — bare yarn resolution collapses a completed descriptor (yaf freeze-oracle)', () => {
  it('yarn-berry: the two descriptors collapse to the single pinned key', () => {
    const out = stringify('yarn-berry-v8', buildGraph(), { overrides: OVERRIDES })
    expect(out).toContain('"minimist@npm:1.2.5":')
    expect(out).not.toContain('minimist@npm:^1.2.5') // stale range descriptor gone
  })

  it('yarn-classic: same collapse', () => {
    const out = stringify('yarn-classic', buildGraph(), { overrides: OVERRIDES })
    expect(out).toMatch(/minimist@1\.2\.5/)
    expect(out).not.toContain('minimist@^1.2.5')
  })

  it('WITHOUT the override, both descriptors survive (collapse is override-gated, not blanket)', () => {
    const out = stringify('yarn-berry-v8', buildGraph(), {})
    expect(out).toContain('minimist@npm:^1.2.5')
  })
})
