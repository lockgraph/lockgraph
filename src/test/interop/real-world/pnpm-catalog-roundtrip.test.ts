import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse, stringify } from '../../../main/ts/index.ts'

const here = dirname(fileURLToPath(import.meta.url))
const realWorld = (rel: string): string =>
  readFileSync(resolve(here, '../../resources/fixtures/real-world', rel), 'utf8')

// pnpm catalog: protocol — round-trip BLOCKER regression (#56).
// Before the fix the adapter dropped the top-level `catalogs:` block on emit
// while re-emitting `specifier: 'catalog:'` importer refs, producing a
// STRUCTURALLY INVALID pnpm lockfile (the catalog refs resolve to nothing).
// A real-world lock carries the full feature: a top-level `catalogs:` block + hundreds
// of `catalog:` importer refs. The fix captures the block verbatim and replays
// it (TOP_LEVEL_ORDER_V9: settings → catalogs → overrides).
//
// NOTE (out of scope here, tracked separately): a handful of `catalog:` importer
// EDGE refs (dev-tooling) are not
// yet round-tripped — that is the importer-edge path, distinct from this
// top-level-block fix; it is a fidelity follow-up, not the BLOCKER.

const catalogBlock = (s: string): string =>
  s.match(/^catalogs:\n([\s\S]*?)(?=^\S)/m)?.[1] ?? ''

const catalogEntryNames = (s: string): string[] =>
  [...catalogBlock(s).matchAll(/^\s{4}(\S[^:]*):\n\s{6}specifier:/gm)].map(m => m[1]!).sort()

describe('pnpm catalog: round-trip (#56)', () => {
  it('preserves the top-level catalogs: block and re-parses (BLOCKER)', () => {
    const lock = realWorld('directus-directus-main-4290f6e/pnpm-lock.yaml')
    const out = stringify('pnpm-v9', parse('pnpm-v9', lock))

    // The catalogs: block must survive — its loss is the BLOCKER (orphaned refs).
    expect(/^catalogs:/m.test(out)).toBe(true)
    // The emitted lock must RE-PARSE — dropping the block produced an invalid one.
    expect(() => parse('pnpm-v9', out)).not.toThrow()
    // Every catalog definition round-trips (same set of catalog entries).
    expect(catalogEntryNames(out)).toEqual(catalogEntryNames(lock))
    expect(catalogEntryNames(out).length).toBeGreaterThan(100)
  })

  it('round-trip is idempotent on the catalogs block', () => {
    const lock = realWorld('directus-directus-main-4290f6e/pnpm-lock.yaml')
    const out1 = stringify('pnpm-v9', parse('pnpm-v9', lock))
    const out2 = stringify('pnpm-v9', parse('pnpm-v9', out1))
    expect(catalogBlock(out2)).toEqual(catalogBlock(out1))
  })
})
