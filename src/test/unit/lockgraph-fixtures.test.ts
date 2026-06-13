// lockgraph — LIVE example fixtures guard.
//
// `src/test/resources/fixtures/lockgraph/*.lockgraph` holds one real `.lockgraph`
// rendering per PM family, generated from the real-world corpus so the format can
// be eyeballed on production data. This suite keeps those committed renderings
// honest with two guards per fixture:
//
//   (a) DRIFT  — re-parse the SOURCE lock, re-serialize to lockgraph, and assert
//                the committed fixture's BODY (the R/N/E/L regions) byte-equals
//                the fresh BODY. META (`generatedAt` + `generator …@<version>`) is
//                EXCLUDED from the comparison, so a clock or version bump never
//                trips this. An intentional emit/format change makes it fail →
//                regenerate.
//   (b) ROUND-TRIP — `parse` the committed fixture bytes back to a graph and prove
//                it is graph-identical across parse→stringify→parse (empty
//                `Graph.diff` both directions, deep graphSnapshot equality, and a
//                byte-stable BODY).
//
// There is NO checksum/seal in this format (integrity of the graph is structural,
// caught on parse/seal). The BODY (R/N/E/L) is a pure function of the graph and
// INDEPENDENT of `generatedAt` (only META carries the clock), so neither guard
// needs to match the timestamp — they compare the BODY only.
//
// REGENERATION ESCAPE HATCH — an intentional format change is a one-command refresh:
//   UPDATE_LOCKGRAPH_FIXTURES=1 npx vitest run src/test/unit/lockgraph-fixtures.test.ts
// which rewrites every fixture (with the pinned generatedAt) instead of asserting.

import { describe, expect, it } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { detect, parse as dispatchParse } from '../../main/ts/index.ts'
import type { FormatId } from '../../main/ts/index.ts'
import { parse as parseLockgraph, stringify as stringifyLockgraph } from '../../main/ts/formats/lockgraph.ts'
import { expectEmptyGraphDiff, graphSnapshot } from '../helpers/lockfile-test-utils.ts'

const here = dirname(fileURLToPath(import.meta.url))
const rw = (rel: string): string => resolve(here, '../resources/fixtures/real-world', rel)
const lg = (rel: string): string => resolve(here, '../resources/fixtures/lockgraph', rel)

// Pinned so the committed fixtures have a STABLE META block. The BODY the guards
// compare is generatedAt-independent, so this only affects the (excluded) META.
const PINNED = '2026-01-01T00:00:00Z'

// One live fixture per PM family. `source` is the corpus lock it was rendered
// from (all known to round-trip through lockgraph, see lockgraph-realworld.test.ts);
// `fixture` is the committed `.lockgraph` rendering; `format` is what `detect`
// must report for the source.
const CORPUS: ReadonlyArray<{ source: string; format: FormatId; fixture: string }> = [
  { source: 'oven-sh-bun-main-3a79bd7/bun.lock', format: 'bun-text', fixture: 'bun-bun-text.lockgraph' },
  { source: 'lodash-lodash-5a3ff73/yarn.lock', format: 'yarn-classic', fixture: 'lodash-yarn-classic.lockgraph' },
  { source: 'vuejs-core-main-86ad076/pnpm-lock.yaml', format: 'pnpm-v9', fixture: 'vue-pnpm-v9.lockgraph' },
  { source: 'prettier-prettier-main-08c9bbd/yarn.lock', format: 'yarn-berry-v10', fixture: 'prettier-yarn-berry-v10.lockgraph' },
  { source: 'microsoft-TypeScript-main-f3d3968/package-lock.json', format: 'npm-2', fixture: 'typescript-npm-2.lockgraph' },
]

// Split a lockgraph document into the volatile META (the four lines before the
// first region header) and the canonical BODY (the `R <n>` region header onward,
// i.e. R/N/E and the optional trailing L line). META carries the `generatedAt`
// and `generator @antongolub/lockfile@<version>` lines and is the only
// generatedAt/version-dependent part, so excluding it makes the guards immune to
// a clock or a version bump.
function bodyOf(text: string): string {
  const normalised = text.replace(/\r\n/g, '\n')
  const m = normalised.match(/\nR \d+\n/)
  if (m === null) throw new Error('not a lockgraph document: no `R <n>` region header')
  return normalised.slice(m.index! + 1) // from the `R <n>` line through the end
}

// Gate on a TRUTHY value only — `UPDATE_LOCKGRAPH_FIXTURES=0` (or `''`, `false`,
// `no`) must NOT trigger a rewrite. A bare presence check would treat `=0` as
// "on", silently clobbering the committed fixtures (N7).
const UPDATING = (() => {
  const v = (process.env.UPDATE_LOCKGRAPH_FIXTURES ?? '').trim().toLowerCase()
  return v !== '' && v !== '0' && v !== 'false' && v !== 'no' && v !== 'off'
})()

// Re-render a fixture's lockgraph doc from its SOURCE lock with the pinned clock.
function renderFromSource(source: string, expectedFormat: FormatId): string {
  const src = readFileSync(rw(source), 'utf8')
  const detected = detect(src)
  expect(detected).toBe(expectedFormat)
  return stringifyLockgraph(dispatchParse(detected!, src), { generatedAt: PINNED })
}

describe('lockgraph — live example fixtures', () => {
  for (const { source, format, fixture } of CORPUS) {
    describe(`${fixture} (${format})`, () => {
      it('drift guard: fixture BODY matches a fresh render of the source lock', () => {
        const fresh = renderFromSource(source, format)

        if (UPDATING) {
          writeFileSync(lg(fixture), fresh, 'utf8')
          // eslint-disable-next-line no-console
          console.log(`UPDATE_LOCKGRAPH_FIXTURES: rewrote ${fixture}`)
          return
        }

        // structural sanity on the freshly-rendered doc
        expect(fresh.startsWith('@lockgraph 1\n')).toBe(true)
        expect(fresh).toMatch(/\nR \d+\n/)
        expect(fresh).not.toMatch(/\bseal\b/) // no checksum/seal in this format
        expect(fresh.endsWith('\n')).toBe(true)

        const committed = readFileSync(lg(fixture), 'utf8')
        // BODY (R/N/E/L) must be byte-identical; META (generatedAt/generator) excluded.
        expect(bodyOf(committed)).toBe(bodyOf(fresh))
      })

      it('round-trip guard: committed fixture parses back graph-identical and byte-stable', () => {
        if (UPDATING) return // nothing to assert while regenerating

        const committed = readFileSync(lg(fixture), 'utf8')
        const g = parseLockgraph(committed)

        // parse → stringify → parse must be graph-identical on every axis.
        const reSerialized = stringifyLockgraph(g, { generatedAt: PINNED })
        const g2 = parseLockgraph(reSerialized)
        expectEmptyGraphDiff(g.diff(g2))
        expectEmptyGraphDiff(g2.diff(g))
        expect(graphSnapshot(g2)).toEqual(graphSnapshot(g))

        // the re-serialized doc's BODY is byte-stable vs the committed fixture
        // (META may differ in generatedAt/version, which we exclude).
        expect(bodyOf(reSerialized)).toBe(bodyOf(committed))
      })
    })
  }
})
