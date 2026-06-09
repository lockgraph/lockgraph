// lockgraph — graph-identity round-trip across a DIVERSE real-world corpus.
//
// The hand-built (§A/§E) and curated-fixture (§B/§C) tests in lockgraph.test.ts
// cover the field matrix; this file stresses the format on large, messy,
// production locks spanning every family — git deps, npm-aliases, deep peer
// fan-out, patches, hundreds of workspaces, exotic resolutions — to prove the
// graph-identity property holds at real scale and shape diversity. Each case:
// parse the source PM lock → Graph → lockgraph → parse → assert diff empty (both
// directions), tarballs iteration-equal (graphSnapshot), and re-serialize
// byte-identical.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { detect, parse as dispatchParse } from '../../main/ts/index.ts'
import type { FormatId } from '../../main/ts/index.ts'
import type { Graph } from '../../main/ts/graph.ts'
import { parse as parseLockgraph, stringify as stringifyLockgraph } from '../../main/ts/formats/lockgraph.ts'
import { expectEmptyGraphDiff, graphSnapshot } from '../helpers/lockfile-test-utils.ts'

const here = dirname(fileURLToPath(import.meta.url))
const rw = (rel: string): string =>
  resolve(here, '../resources/fixtures/real-world', rel)

// A diverse slice of the real-world corpus — one or more per family, chosen for
// shape diversity (git deps, monorepo workspace fan-out, patches, npm-aliases).
const CORPUS: ReadonlyArray<{ file: string; expect: FormatId }> = [
  { file: 'backstage-backstage-master-b55138e/yarn.lock',       expect: 'yarn-berry-v8' },
  { file: 'babel-babel-main-ae57969/yarn.lock',                 expect: 'yarn-berry-v9' },
  { file: 'prettier-prettier-main-08c9bbd/yarn.lock',           expect: 'yarn-berry-v10' },
  { file: 'parcel-bundler-parcel-v2-5948485/yarn.lock',         expect: 'yarn-berry-v8' },
  { file: 'jestjs-jest-v26.6.0-b254fd8/yarn.lock',              expect: 'yarn-berry-v4' },
  { file: 'webpack-webpack-main-66f71f8/yarn.lock',             expect: 'yarn-classic' },
  { file: 'lodash-lodash-5a3ff73/yarn.lock',                    expect: 'yarn-classic' },
  { file: 'nrwl-nx-master-0939540/pnpm-lock.yaml',              expect: 'pnpm-v9' },
  { file: 'vuejs-core-main-86ad076/pnpm-lock.yaml',             expect: 'pnpm-v9' },
  { file: 'supabase-supabase-master-a4334a2/pnpm-lock.yaml',    expect: 'pnpm-v9' },
  { file: 'angular-angular-main-45e8fb5/pnpm-lock.yaml',        expect: 'pnpm-v9' },
  { file: 'microsoft-vscode-main-ddd12d5/package-lock.json',    expect: 'npm-3' },
  { file: 'microsoft-TypeScript-main-f3d3968/package-lock.json', expect: 'npm-2' },
  { file: 'socketio-socket.io-main-190572d/package-lock.json',  expect: 'npm-3' },
  { file: 'oven-sh-bun-main-3a79bd7/bun.lock',                  expect: 'bun-text' },
  { file: 'honojs-hono-main-2cbeadd/bun.lock',                  expect: 'bun-text' },
]

function assertRoundTrip(g: Graph): void {
  const text = stringifyLockgraph(g, { generatedAt: '2026-01-01T00:00:00Z' })
  const g2 = parseLockgraph(text)
  expectEmptyGraphDiff(g.diff(g2))
  expectEmptyGraphDiff(g2.diff(g))
  expect(graphSnapshot(g2)).toEqual(graphSnapshot(g))
  expect(stringifyLockgraph(g2, { generatedAt: '2026-01-01T00:00:00Z' })).toBe(text)
}

describe('lockgraph — real-world graph-identity round-trip', () => {
  for (const { file, expect: expectedFormat } of CORPUS) {
    it(`${file} (${expectedFormat})`, () => {
      const source = readFileSync(rw(file), 'utf8')
      const detected = detect(source)
      expect(detected).toBe(expectedFormat)
      const g = dispatchParse(detected!, source)
      assertRoundTrip(g)
    })
  }
})
