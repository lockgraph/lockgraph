// lockgraph size measurement (#101 deliverable 3) — the format vs the source PM
// lock, raw and gzipped, on a large real fixture (backstage, a ~1.79 MB
// yarn-berry-v8 monorepo lock). Also doubles as the large-fixture graph-identity
// stress test: backstage exercises peer-virt fan-out, npm-aliases, git deps,
// patches, and hundreds of workspaces.
//
// Reports the compaction ratio via console.log; the assertion guards that the
// round-trip stays graph-identical at scale. The reworked format optimizes for
// FIDELITY + READABILITY over raw size (store-everything: full integrity
// multiset, verbatim ranges/resolutions, full TarballPayload residual, no `=`
// derive-when-equal sentinels, no registry canonicalization) while DERIVING the
// mechanical paths (tarball URLs recomposed from the registry type, not stored).
// Net raw size therefore VARIES by source — materially smaller where path
// duplication dominated (yarn-classic, npm; backstage ~0.61×), near the
// irreducible integrity-hash floor elsewhere — so the test reports the real ratio
// instead of asserting a fixed bound (spec § Design rationale).

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { gzipSync } from 'node:zlib'
import { parse as parseYarnBerryV8 } from '../../main/ts/formats/yarn-berry-v8.ts'
import { parse as parseLockgraph, stringify as stringifyLockgraph } from '../../main/ts/formats/lockgraph.ts'
import { expectEmptyGraphDiff, graphSnapshot } from '../helpers/lockfile-test-utils.ts'

const here = dirname(fileURLToPath(import.meta.url))
const BACKSTAGE = resolve(
  here,
  '../resources/fixtures/real-world/backstage-backstage-master-b55138e/yarn.lock',
)

const kib = (bytes: number): string => `${(bytes / 1024).toFixed(1)} KiB`
const bytesOf = (s: string): number => Buffer.byteLength(s, 'utf8')

describe('lockgraph — size measurement on backstage (yarn-berry-v8)', () => {
  it('round-trips graph-identical AND reports compaction vs the source lock', () => {
    const source = readFileSync(BACKSTAGE, 'utf8')
    const g = parseYarnBerryV8(source)

    const text = stringifyLockgraph(g, { generatedAt: '2026-01-01T00:00:00Z' })

    // --- graph-IDENTITY at scale ---
    const g2 = parseLockgraph(text)
    expectEmptyGraphDiff(g.diff(g2))
    expectEmptyGraphDiff(g2.diff(g))
    expect(graphSnapshot(g2)).toEqual(graphSnapshot(g))
    // re-serialize byte-identical
    expect(stringifyLockgraph(g2, { generatedAt: '2026-01-01T00:00:00Z' })).toBe(text)

    // --- size measurement ---
    const srcRaw = bytesOf(source)
    const lgRaw = bytesOf(text)
    const srcGz = gzipSync(source).length
    const lgGz = gzipSync(text).length

    const nodeCount = Array.from(g.nodes()).length
    const tarballCount = Array.from(g.tarballs()).length

    /* eslint-disable no-console */
    console.log('\n=== lockgraph size measurement: backstage (yarn-berry-v8) ===')
    console.log(`  graph: ${nodeCount} nodes, ${tarballCount} tarball entries`)
    console.log(`  source yarn.lock  raw: ${kib(srcRaw)}   gzip: ${kib(srcGz)}`)
    console.log(`  lockgraph (text)  raw: ${kib(lgRaw)}   gzip: ${kib(lgGz)}`)
    console.log(`  RAW  ratio  lockgraph/source = ${(lgRaw / srcRaw).toFixed(3)}  ` +
      `(${(100 * (1 - lgRaw / srcRaw)).toFixed(1)}% smaller)`)
    console.log(`  GZIP ratio  lockgraph/source = ${(lgGz / srcGz).toFixed(3)}  ` +
      `(${(100 * (1 - lgGz / srcGz)).toFixed(1)}% smaller)`)
    console.log('============================================================\n')
    /* eslint-enable no-console */

    // Size posture — recompose derives the mechanical paths, so the raw body is
    // often SMALLER than the source (e.g. backstage ~0.61×); the irreducible floor
    // is the integrity-hash multiset. We assert only that both encodings are
    // non-empty and report the real ratio above; the graph-identity assertions
    // (the round-trip block) are the substantive guard at scale.
    expect(lgRaw).toBeGreaterThan(0)
    expect(srcRaw).toBeGreaterThan(0)
  })
})
