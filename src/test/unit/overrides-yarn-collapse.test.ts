// Regression (yaf .85 freeze-oracle bug): a BARE yarn `resolutions`/override pins a
// package that a COMPLETED edge also reaches. yarn rewrites EVERY matching descriptor
// to the pin and collapses the entry to a single key; the lib must do the same, else
// the extra raw-range descriptor makes `yarn install --immutable` fail YN0028.
//
// Fix: completion stamps the override pin as `EdgeAttrs.overrideRange`; the yarn
// adapters key the entry by it in BOTH paths — live edge reconstruction
// (`entryKeyOfNode` / `entrySpecsOfNode`) for a minted node, and the parse-captured
// `entryKeyDescriptors` sidecar maintained across `mutate` (`incomingKeyDescriptors`,
// the actual path yaf hit) for a node already in the baseline lock. npm/pnpm are
// unaffected — they pre-resolve, so the declared range stays in the parent's deps.

import { describe, expect, it } from 'vitest'
import { parse, stringify } from '../../main/ts/index.ts'
import { completeTransitives } from '../../main/ts/complete/tree-complete.ts'
import type { Packument, RegistryAdapter } from '../../main/ts/registry/types.ts'
import { newBuilder } from '../../main/ts/graph.ts'
import { addPackage } from './_modify-test-utils.ts'

// minimist has two consumers: `hba` via an exact 1.2.5 range, `hbb` via a raw ^1.2.5
// that a `resolutions: { minimist: 1.2.5 }` pinned (as a completed edge carries it —
// `overrideRange` stamped). A programmatic (unparsed) graph has NO sidecar, so this
// exercises the LIVE reconstruction path.
const stampedGraph = (overrideStamp: boolean) => {
  const b = newBuilder()
  const ws  = addPackage(b, { name: 'app', version: '0.0.0', workspacePath: '.' })
  const hba = addPackage(b, { name: 'hba', version: '1.0.0' })
  const hbb = addPackage(b, { name: 'hbb', version: '1.0.0' })
  const m   = addPackage(b, { name: 'minimist', version: '1.2.5' })
  b.addEdge(ws, hba, 'dep', { range: '^1.0.0' })
  b.addEdge(ws, hbb, 'dep', { range: '^1.0.0' })
  b.addEdge(hba, m, 'dep', { range: '1.2.5' })
  b.addEdge(hbb, m, 'dep', overrideStamp ? { range: '^1.2.5', overrideRange: '1.2.5' } : { range: '^1.2.5' })
  return b.seal()
}

describe('overrides — bare yarn resolution collapses a completed descriptor (yaf freeze-oracle)', () => {
  it('yarn-berry (reconstruction): the two descriptors collapse to the single pinned key', () => {
    const out = stringify('yarn-berry-v8', stampedGraph(true))
    expect(out).toContain('"minimist@npm:1.2.5":')
    expect(out).not.toContain('minimist@npm:^1.2.5') // stale range descriptor gone
  })

  it('yarn-classic (reconstruction): same collapse', () => {
    const out = stringify('yarn-classic', stampedGraph(true))
    expect(out).toMatch(/minimist@1\.2\.5/)
    expect(out).not.toContain('minimist@^1.2.5')
  })

  it('WITHOUT the override stamp, both descriptors survive (collapse is override-gated, not blanket)', () => {
    const out = stringify('yarn-berry-v8', stampedGraph(false))
    expect(out).toContain('minimist@npm:^1.2.5')
  })

  // lockgraph is the graph-identity interchange format; a governed edge's overrideRange
  // must survive its E-row codec (`or=` slot) or a graph→lockgraph→graph hop silently
  // drops the pin and re-breaks the collapse downstream (adversary finding).
  it('lockgraph round-trip preserves overrideRange (governed edge stays collapsed)', () => {
    const round = parse('lockgraph', stringify('lockgraph', stampedGraph(true)))
    const out = stringify('yarn-berry-v8', round)
    expect(out).toContain('"minimist@npm:1.2.5":')
    expect(out).not.toContain('minimist@npm:^1.2.5')
  })

  // yaf's EXACT bug: minimist is already in the baseline lock (sidecar
  // `["minimist@npm:1.2.5"]`), and completion wires a SECOND consumer to it. The
  // sidecar must survive the mutate collapsed — the raw ^1.2.5 must never join it.
  const sidecarRegistry: RegistryAdapter = {
    async packument(name): Promise<Packument | undefined> {
      // `other` is in the lock but its transitive minimist dep is not yet resolved.
      if (name === 'other')    return { name, distTags: { latest: '1.0.0' }, versions: { '1.0.0': { name, version: '1.0.0', dependencies: { minimist: '^1.2.5' } } } }
      if (name === 'existing') return { name, distTags: { latest: '1.0.0' }, versions: { '1.0.0': { name, version: '1.0.0', dependencies: { minimist: '1.2.5' } } } }
      if (name === 'minimist') return { name, distTags: { latest: '1.2.8' }, versions: { '1.2.5': { name, version: '1.2.5' }, '1.2.8': { name, version: '1.2.8' } } }
      return undefined
    },
    async resolve(name, range) {
      const p = await this.packument(name)
      if (p === undefined) return undefined
      return p.versions[range] ?? p.versions['1.2.8'] ?? Object.values(p.versions)[0] // exact (override target), else highest
    },
  }

  // Baseline berry lock: `existing` binds minimist via an EXACT 1.2.5 descriptor, so
  // the entry is keyed `minimist@npm:1.2.5` and its sidecar is `["minimist@npm:1.2.5"]`.
  // `other` is present but its minimist dep is not yet in the closure.
  const sidecarLock = [
    '# This file is generated by running "yarn install" inside your project.',
    '# Manual changes might be lost - proceed with caution!',
    '',
    '__metadata:',
    '  version: 8',
    '  cacheKey: 10c0',
    '',
    '"app@workspace:.":',
    '  version: 0.0.0-use.local',
    '  resolution: "app@workspace:."',
    '  dependencies:',
    '    existing: ^1.0.0',
    '    other: ^1.0.0',
    '  languageName: unknown',
    '  linkType: soft',
    '',
    '"existing@npm:^1.0.0":',
    '  version: 1.0.0',
    '  resolution: "existing@npm:1.0.0"',
    '  dependencies:',
    '    minimist: 1.2.5',
    '  languageName: node',
    '  linkType: hard',
    '',
    '"minimist@npm:1.2.5":',
    '  version: 1.2.5',
    '  resolution: "minimist@npm:1.2.5"',
    '  languageName: node',
    '  linkType: hard',
    '',
    '"other@npm:^1.0.0":',
    '  version: 1.0.0',
    '  resolution: "other@npm:1.0.0"',
    '  languageName: node',
    '  linkType: hard',
    '',
  ].join('\n')

  const runSidecar = async (withOverride: boolean) => {
    const graph = parse('yarn-berry-v8', sidecarLock)
    const result = await completeTransitives(graph, sidecarRegistry, {
      overrides: withOverride ? [{ package: 'minimist', to: '1.2.5' }] : [],
    })
    return { out: stringify('yarn-berry-v8', result.graph), result }
  }

  it('yarn-berry (sidecar): completion adding a 2nd consumer keeps the parse sidecar collapsed', async () => {
    const { out, result } = await runSidecar(true)
    // Non-vacuity: completion actually wired `other` → minimist (else the collapse is trivial).
    expect(result.wired.length).toBeGreaterThan(0)
    expect(out).toContain('"minimist@npm:1.2.5":')
    expect(out).not.toContain('minimist@npm:^1.2.5') // the completed consumer's raw range did NOT join the sidecar
  })

  it('yarn-berry (sidecar): WITHOUT the override the same completion DOES leak the raw range (proves the guard is load-bearing)', async () => {
    const { out, result } = await runSidecar(false)
    expect(result.wired.length).toBeGreaterThan(0)          // same edge wired…
    expect(out).toContain('minimist@npm:^1.2.5')            // …but now its raw range joins the sidecar → YN0028
  })
})
