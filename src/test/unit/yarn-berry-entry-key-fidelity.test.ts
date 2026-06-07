// B-EXACT — yarn-berry emit must NOT synthesize an exact-resolved-version
// descriptor into entry keys that the source lock wrote range-only.
//
// yarn keys each entry by the DESCRIPTOR(s) that reference it (e.g. a range
// `npm:^1.2.3`); the resolved version lives in the entry's `version:` /
// `resolution:` fields, NEVER as a key descriptor. Re-emitting the resolved
// version into the key (`"<name>@npm:1.2.6, <name>@npm:^1.2.3"`) breaks
// byte-fidelity and makes `yarn install --immutable` see the lock as changed.
//
// The distinction preserved here: an exact-version key descriptor is legitimate
// ONLY when the source lock genuinely had it (a real `resolutions` pin / exact
// dep). An ordinary range-only entry must round-trip with NO exact-version
// descriptor synthesized.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { parse as parseV10, stringify as stringifyV10 } from '../../main/ts/formats/yarn-berry-v10.ts'
import { parse as parseV8, stringify as stringifyV8, enrich as enrichV8, optimize as optimizeV8 } from '../../main/ts/formats/yarn-berry-v8.ts'

const here = dirname(fileURLToPath(import.meta.url))
const realWorldRoot = resolve(here, '../resources/fixtures/real-world/yarnpkg-berry-master-6861e75')
const realWorldLock = readFileSync(resolve(realWorldRoot, 'yarn.lock'), 'utf8')

// Collect every entry-key string (the quoted-or-bare top-level block key) from a
// yarn-berry lockfile body, mapped to its sorted descriptor SET (the `, `-joined
// key split into individual descriptors).
function entryKeyDescriptorSets(lockfile: string): Map<string, string[]> {
  const result = new Map<string, string[]>()
  for (const rawLine of lockfile.split('\n')) {
    // A top-level entry key line: no leading indent, ends with `:`, not a
    // comment / the `__metadata` block.
    if (rawLine.startsWith(' ') || rawLine.startsWith('#') || rawLine.startsWith('__metadata')) continue
    const m = /^("?)(.+?)\1:\s*$/.exec(rawLine)
    if (!m) continue
    const key = m[2]!
    const descriptors = key.split(', ').sort()
    result.set(key, descriptors)
  }
  return result
}

describe('B-EXACT — yarn-berry entry-key descriptor fidelity', () => {
  it('a plain range-only entry does NOT gain an exact `@npm:<version>` descriptor on emit', () => {
    const g = parseV10(realWorldLock, { workspaceRoot: realWorldRoot })
    const out = stringifyV10(g)

    // `@aashutoshrathi/word-wrap` is keyed `npm:^1.2.3` in the source, resolved
    // to 1.2.6 — the exact `1.2.6` must NEVER appear in the key.
    const outLine = out.split('\n').find(l => l.includes('@aashutoshrathi/word-wrap@npm:'))
    expect(outLine).toBeDefined()
    expect(outLine).toContain('@aashutoshrathi/word-wrap@npm:^1.2.3')
    expect(outLine).not.toContain('@aashutoshrathi/word-wrap@npm:1.2.6')

    // Likewise `@actions/core@npm:^1.2.6` resolves to 1.2.6 — no synthesized
    // `@actions/core@npm:1.2.6` descriptor.
    const coreLine = out.split('\n').find(l => l.includes('@actions/core@npm:'))
    expect(coreLine).toBeDefined()
    expect(coreLine).toContain('@actions/core@npm:^1.2.6')
    expect(coreLine).not.toContain(', @actions/core@npm:1.2.6')
  })

  it('the full entry-key descriptor set round-trips with no synthesized descriptors (real-world v10)', () => {
    const srcSets = entryKeyDescriptorSets(realWorldLock)
    const g = parseV10(realWorldLock, { workspaceRoot: realWorldRoot })
    const out = stringifyV10(g)
    const outSets = entryKeyDescriptorSets(out)

    // Every source key must reappear verbatim; no key may grow extra descriptors.
    const missing: string[] = []
    for (const key of srcSets.keys()) {
      if (!outSets.has(key)) missing.push(key)
    }
    const synthesized: string[] = []
    for (const key of outSets.keys()) {
      if (!srcSets.has(key)) synthesized.push(key)
    }

    expect({ missing: missing.slice(0, 10), synthesized: synthesized.slice(0, 10) })
      .toEqual({ missing: [], synthesized: [] })
    expect(outSets.size).toBe(srcSets.size)
  })

  it('byte-identical entry-key region for the first 200 entries (no exact-version pollution)', () => {
    const g = parseV10(realWorldLock, { workspaceRoot: realWorldRoot })
    const out = stringifyV10(g)
    const srcKeys = realWorldLock.split('\n').filter(l => !l.startsWith(' ') && /^"?.+?"?:\s*$/.test(l) && !l.startsWith('#') && !l.startsWith('__metadata'))
    const outKeys = out.split('\n').filter(l => !l.startsWith(' ') && /^"?.+?"?:\s*$/.test(l) && !l.startsWith('#') && !l.startsWith('__metadata'))
    // Both sorted the same way (cmpStr on the joined key) — compare the lists.
    expect(outKeys).toEqual(srcKeys)
  })

  // The other half of the invariant: a GENUINE `resolutions`-pinned entry keyed
  // by its exact resolved version (`csstype@npm:3.0.9`) MUST keep that exact
  // descriptor on emit. The fix removes only the SPURIOUS per-entry synthesis,
  // never a descriptor the source genuinely carried.
  const PIN_LOCK = `# This file is generated by running "yarn install" inside your project.
# Manual changes might be lost - proceed with caution!

__metadata:
  version: 8
  cacheKey: 10

"csstype@npm:3.0.9":
  version: 3.0.9
  resolution: "csstype@npm:3.0.9"
  languageName: node
  linkType: hard

"csstype@npm:^2.5.2":
  version: 2.6.21
  resolution: "csstype@npm:2.6.21"
  languageName: node
  linkType: hard

"root@workspace:.":
  version: 0.0.0-use.local
  resolution: "root@workspace:."
  dependencies:
    csstype: "npm:^3.0.2"
  languageName: unknown
  linkType: soft
`

  it('a genuine resolutions-pinned entry keeps its exact `@npm:<version>` key descriptor', () => {
    const g = parseV8(PIN_LOCK)
    const out = stringifyV8(g)
    // The pinned entry's exact descriptor survives verbatim.
    expect(out).toContain('"csstype@npm:3.0.9":')
    // The satisfying-range entry stays range-keyed (no synthesized 2.6.21).
    expect(out).toContain('"csstype@npm:^2.5.2":')
    expect(out).not.toContain('csstype@npm:2.6.21,')
    expect(out).not.toContain(', csstype@npm:2.6.21')
  })

  it('PIN_LOCK entry keys round-trip byte-identically (descriptor sets unchanged)', () => {
    // Scoped to entry-KEY fidelity (the B-EXACT surface). Field-internal ordering
    // (`languageName`/`linkType`) is a separate concern and intentionally not
    // asserted here.
    const g = parseV8(PIN_LOCK)
    const out = stringifyV8(g)
    const srcKeys = PIN_LOCK.split('\n').filter(l => !l.startsWith(' ') && /^"?.+?"?:\s*$/.test(l) && !l.startsWith('#') && !l.startsWith('__metadata'))
    const outKeys = out.split('\n').filter(l => !l.startsWith(' ') && /^"?.+?"?:\s*$/.test(l) && !l.startsWith('#') && !l.startsWith('__metadata'))
    expect(outKeys).toEqual(srcKeys)
  })

  // The verbatim key sidecar is per-NodeId and must survive the graph rebuilds in
  // enrich (peer derivation remaps ids) and optimize (GC prunes orphans). A peer
  // entry keeps the same package+version, so its source key stays valid; a node
  // that survives optimize keeps its key.
  function keyLines(s: string): string[] {
    return s.split('\n').filter(l => !l.startsWith(' ') && /^"?.+?"?:\s*$/.test(l) && !l.startsWith('#') && !l.startsWith('__metadata'))
  }

  // A peer-bearing lock: `enrich` derives the peer edge and rebuilds the graph
  // (remapping NodeIds + the key sidecar). The range-keyed `host`/`peerpkg`
  // entries must keep their range-only keys (no synthesized resolved version)
  // through enrich.
  const PEER_LOCK = `# This file is generated by running "yarn install" inside your project.
# Manual changes might be lost - proceed with caution!

__metadata:
  version: 8
  cacheKey: 10

"host@npm:^1.0.0":
  version: 1.2.0
  resolution: "host@npm:1.2.0"
  peerDependencies:
    peerpkg: ^2.0.0
  languageName: node
  linkType: hard

"peerpkg@npm:^2.0.0":
  version: 2.3.0
  resolution: "peerpkg@npm:2.3.0"
  languageName: node
  linkType: hard

"root@workspace:.":
  version: 0.0.0-use.local
  resolution: "root@workspace:."
  dependencies:
    host: "npm:^1.0.0"
    peerpkg: "npm:^2.0.0"
  languageName: unknown
  linkType: soft
`

  it('verbatim entry keys survive enrich (peer derivation rebuild) — no synthesized descriptors', () => {
    const parsed = parseV8(PEER_LOCK)
    const srcKeys = keyLines(stringifyV8(parsed))
    const enriched = enrichV8(parsed).graph
    const outKeys = keyLines(stringifyV8(enriched))
    expect(outKeys).toEqual(srcKeys)
    // explicit: no resolved-version pollution
    expect(stringifyV8(enriched)).not.toContain('host@npm:1.2.0,')
    expect(stringifyV8(enriched)).not.toContain('peerpkg@npm:2.3.0,')
  })

  it('verbatim entry keys survive optimize() — surviving keys stay a synthesized-free subset', () => {
    // PIN_LOCK's `csstype@npm:^2.5.2` (2.6.21) is unreachable from root → optimize
    // GCs it; the surviving keys must remain a subset of the source keys with no
    // exact-version descriptor synthesized onto any of them.
    const parsed = parseV8(PIN_LOCK)
    const srcKeys = keyLines(stringifyV8(parsed))
    const optimized = optimizeV8(parsed).graph
    const outKeys = keyLines(stringifyV8(optimized))
    for (const k of outKeys) expect(srcKeys).toContain(k)
    // the genuine pin survives with its exact descriptor intact
    expect(stringifyV8(optimized)).toContain('"csstype@npm:3.0.9":')
  })
})
