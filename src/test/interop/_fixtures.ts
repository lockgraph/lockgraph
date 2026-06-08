import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { YarnClassicManifest } from '../../main/ts/formats/yarn-classic.ts'
import type { FormatId } from './_types.ts'

const here = dirname(fileURLToPath(import.meta.url))

export function fixtureLockfile(fixtureName: string, format: FormatId): string {
  return readFileSync(
    resolve(here, '../resources/fixtures/lockfiles', fixtureName, `${format}.lock`),
    'utf8',
  )
}

export const WORKSPACE_MANIFESTS: Record<string, YarnClassicManifest> = {
  '': {
    name: 'case-workspaces-basic',
    version: '0.0.0',
    dependencies: { '@case-ws/a': 'workspace:*' },
    devDependencies: { '@case-ws/b': 'workspace:^' },
    optionalDependencies: { ms: '2.1.3' },
  },
  'packages/a': {
    name: '@case-ws/a',
    version: '1.0.0',
    dependencies: { ms: '2.1.3' },
  },
  'packages/b': {
    name: '@case-ws/b',
    version: '1.1.0',
    dependencies: { ms: '2.1.3' },
  },
}

// Classic-compatible shared corpus:
// - bundled-deps excluded because no yarn-classic fixture exists on disk
// - patch-yarn excluded because yarn-classic cannot represent patch slots;
//   patch-loss path covered by synthetic graph
//   (cross-family/yarn-berry-to-yarn-classic.test.ts:97-157), TODO
//   real-fixture coverage tracked under `interop-real-diagnostic-emission` stub
// - workspace-cross-refs excluded because no yarn-classic fixture exists on disk
export const CLASSIC_SHARED_FIXTURES = [
  'deps-with-scopes',
  'git-github-tarball',
  'peers-basic',
  'peers-multi',
  'simple',
  'workspaces-basic',
  'yarn-crlf',
] as const

// Shared berry corpus across v4/v5/v6/v8 pairs:
// - bundled-deps excluded because no yarn-berry fixture exists on disk
// - patch-yarn excluded because only yarn-berry-v9.lock exists on disk
// - workspace-cross-refs excluded because yarn-berry-v4.lock is absent
export const BERRY_SHARED_FIXTURES = [
  'deps-with-scopes',
  'git-github-tarball',
  'peers-basic',
  'peers-multi',
  'simple',
  'workspaces-basic',
  'yarn-crlf',
] as const

// Shared berry corpus for v9<->v4 pairs: derives from BERRY_SHARED_FIXTURES minus
// `git-github-tarball` (yarn-berry-v9.lock absent on disk).
export const BERRY_SHARED_NO_GIT_FOR_V9 = BERRY_SHARED_FIXTURES.filter(
  (fixture): fixture is Exclude<typeof BERRY_SHARED_FIXTURES[number], 'git-github-tarball'> =>
    fixture !== 'git-github-tarball',
)

// Workspace-focused berry corpus for v5/v6/v8/v9 pairs: derives from
// BERRY_SHARED_NO_GIT_FOR_V9 plus `workspace-cross-refs` (workspace-only signal).
export const BERRY_WORKSPACE_FIXTURES = [
  ...BERRY_SHARED_NO_GIT_FOR_V9,
  'workspace-cross-refs' as const,
]

// pnpm intra-family shared corpus (available across pnpm-v5, pnpm-v6, pnpm-v9):
// - bundled-deps excluded: no pnpm fixtures on disk
// - git-github-tarball excluded: no pnpm fixtures on disk
// - patch-yarn excluded: only pnpm-v6/v9 fixtures exist (pnpm-v5 has no
//   patchedDependencies / overrides:patch primitive per ADR-0022 §A.pnpm-v5).
//   Pairs where source ∈ {v6, v9} use `PNPM_V6_V9_FIXTURES` below to exercise
//   the patch-yarn path so the downgrade-to-v5 patch-loss contract actually
//   fires per ADR-0020 §2 honesty principle.
export const PNPM_SHARED_FIXTURES = [
  'deps-with-scopes',
  'peers-basic',
  'peers-multi',
  'simple',
  'workspace-cross-refs',
  'workspaces-basic',
  'yarn-crlf',
] as const

export const PNPM_V6_V9_FIXTURES = [
  ...PNPM_SHARED_FIXTURES,
  'patch-yarn' as const,
]

// Cross-family yarn-berry-v9 <-> npm-3 shared corpus (ADR-0020 Phase C-iii):
// fixtures with both `yarn-berry-v9.lock` AND `npm-3.lock` on disk. Workspace
// identity convention aligns across both PMs (`<name>@0.0.0-use.local`), so
// the corpus is wider than the yb9 <-> pnpm-v9 case (no workspace-rekey
// loss); `git-github-tarball` excluded because `yarn-berry-v9.lock` is absent
// on disk (mirrors BERRY_SHARED_NO_GIT_FOR_V9 rationale).
export const CROSS_FAMILY_YB9_NPM3_FIXTURES = [
  'deps-with-scopes',
  'peers-basic',
  'peers-multi',
  'simple',
  'workspaces-basic',
  'yarn-crlf',
] as const

// Cross-family yarn-berry-v4 <-> npm-3 shared corpus (ADR-0020 Phase E-i):
// fixtures with both `yarn-berry-v4.lock` AND `npm-3.lock` on disk. Unlike
// the yb9 pair, `git-github-tarball` is INCLUDED because the v4 source lockfile
// exists there. Exclusions are the remaining non-intersection cases:
//   - `bundled-deps`: no yarn-berry-v4 fixture on disk
//   - `patch-yarn`: neither side has a matching shared fixture
//   - `workspace-cross-refs`: no npm-3 fixture on disk
//
// This yields a 7-fixture corpus; the git fixture is load-bearing for the
// reverse `npm-3 -> yarn-berry-v4` tarball-loss rationale in `_matrix.ts`.
export const CROSS_FAMILY_YB4_NPM3_FIXTURES = [
  'deps-with-scopes',
  'git-github-tarball',
  'peers-basic',
  'peers-multi',
  'simple',
  'workspaces-basic',
  'yarn-crlf',
] as const

// Cross-family yarn-berry-v{5,6,8} <-> npm-3 shared corpus (ADR-0020 Phase
// E-ii): fixtures with all three mid-berry lockfiles plus `npm-3.lock` on
// disk. Same 7-fixture shape as the yb4 pair:
//   - `bundled-deps`: no yarn-berry-v{5,6,8} fixture on disk
//   - `patch-yarn`: no npm-3 fixture on disk
//   - `workspace-cross-refs`: no npm-3 fixture on disk
//
// `git-github-tarball` stays INCLUDED because the v5/v6/v8 fixtures exist
// there. Conditions support in v5+ remains out-of-corpus: no shared fixture
// with a `conditions` block exists on disk.
export const CROSS_FAMILY_YB_MID_NPM3_FIXTURES = [
  'deps-with-scopes',
  'git-github-tarball',
  'peers-basic',
  'peers-multi',
  'simple',
  'workspaces-basic',
  'yarn-crlf',
] as const

// ADR-0032 — FORWARD-only (yarn-berry -> npm-3) corpora narrow
// `git-github-tarball` AWAY. A git source carries a `+src=` NodeId discriminator
// on the yarn-berry side, but npm-3 emit writes the berry `<name>@<locator>`
// envelope verbatim into `resolved:`, which npm-3 reparse degrades to canonical
// `unknown` -> BARE (no `+src=`). The git node's identity therefore legitimately
// diverges across the forward boundary (berry `is-git@6.3.1+src=…` vs npm
// `is-git@6.3.1`), an irreducible shape collision — narrowed rather than
// declared as a node-identity loss feature, exactly as the npm-1 git path does
// (see `_matrix.NPM_TO_NPM_1_EXCLUDED`). The REVERSE direction (npm-3 ->
// yarn-berry) keeps the git fixture: npm-3's canonical git/tarball URLs survive
// yarn-berry parse, so identity aligns there.
export const CROSS_FAMILY_YB4_NPM3_FORWARD_FIXTURES =
  CROSS_FAMILY_YB4_NPM3_FIXTURES.filter(f => f !== 'git-github-tarball')
export const CROSS_FAMILY_YB_MID_NPM3_FORWARD_FIXTURES =
  CROSS_FAMILY_YB_MID_NPM3_FIXTURES.filter(f => f !== 'git-github-tarball')

// Cross-family pnpm-v9 <-> npm-3 shared corpus (ADR-0020 Phase C-iv): fixtures
// with both `pnpm-v9.lock` AND `npm-3.lock` on disk. Same six-fixture list as
// CROSS_FAMILY_YB9_NPM3_FIXTURES (the npm-3 ∩ pnpm-v9 disk intersection happens
// to match the yb9 ∩ npm-3 intersection); kept as a distinct const so the
// rationale stays per-pair (workspace identity convention DIVERGES across this
// pair, unlike yb9 ↔ npm-3 where both PMs use `<name>@0.0.0-use.local` —
// see _matrix.ts pnpm-v9 ↔ npm-3 contract block for the workspace-rekey
// derivation). `git-github-tarball` excluded because `pnpm-v9.lock` is absent
// on disk; `patch-yarn` excluded because `npm-3.lock` is absent;
// `workspace-cross-refs` excluded because `npm-3.lock` is absent.
export const CROSS_FAMILY_PNPM9_NPM3_FIXTURES = [
  'deps-with-scopes',
  'peers-basic',
  'peers-multi',
  'simple',
  'workspaces-basic',
  'yarn-crlf',
] as const

// Cross-family pnpm-v5 <-> npm-3 shared corpus (ADR-0020 Phase E-iv): same
// six-fixture disk intersection shape as the pnpm-v9 pair:
//   - `git-github-tarball`: no `pnpm-v5.lock` on disk
//   - `patch-yarn`: no `pnpm-v5.lock` on disk (v5 has no patch primitive)
//   - `workspace-cross-refs`: no `npm-3.lock` on disk
export const CROSS_FAMILY_PNPM5_NPM3_FIXTURES = [
  ...CROSS_FAMILY_PNPM9_NPM3_FIXTURES,
] as const

// Cross-family pnpm-v6 <-> npm-3 shared corpus (ADR-0020 Phase E-iv): same
// disk intersection as the pnpm-v9 pair. `patch-yarn` remains absent because
// the npm-3 side has no fixture on disk.
export const CROSS_FAMILY_PNPM6_NPM3_FIXTURES = [
  ...CROSS_FAMILY_PNPM9_NPM3_FIXTURES,
] as const

// Cross-family yarn-classic -> pnpm-v9 corpus (ADR-0020 Phase D-i): start
// from the 6-fixture disk intersection of CLASSIC_SHARED_FIXTURES and
// PNPM_SHARED_FIXTURES, then EXCLUDE `workspaces-basic`. The naive
// yarn-classic source lockfile carries only the external `ms@2.1.3` entry on
// disk (no root/member workspace nodes per ADR-0019 §C), so cross-family
// stringify into pnpm-v9 synthesises only the importer root (`.@0.0.0`) and
// drops the external node entirely. That is an incomplete-source artifact, not
// the target pair's honest graph-loss profile; classic -> berry already covers
// the enrich-aware workspace path separately. Keep the forward corpus to the
// 5 fixtures where the classic on-disk graph is complete.
export const CROSS_FAMILY_CLASSIC_PNPM9_FIXTURES = [
  'deps-with-scopes',
  'peers-basic',
  'peers-multi',
  'simple',
  'yarn-crlf',
] as const

// Cross-family yarn-classic -> pnpm-v5 corpus (ADR-0020 Phase E-iv): mirrors
// the pnpm-v9 forward corpus exactly. `workspaces-basic` stays excluded for the
// same incomplete classic-source artifact; there is no patch-bearing v5 source
// fixture on disk.
export const CROSS_FAMILY_CLASSIC_PNPM5_FIXTURES = [
  ...CROSS_FAMILY_CLASSIC_PNPM9_FIXTURES,
] as const

// Cross-family yarn-classic -> pnpm-v6 corpus (ADR-0020 Phase E-iv): same
// honest five-fixture shape as the pnpm-v9 pair. `patch-yarn` is source-only
// on pnpm-v6, so it is irrelevant on the classic -> pnpm-v6 direction.
export const CROSS_FAMILY_CLASSIC_PNPM6_FIXTURES = [
  ...CROSS_FAMILY_CLASSIC_PNPM9_FIXTURES,
] as const

// Cross-family pnpm-v9 -> yarn-classic corpus (ADR-0020 Phase D-i): start
// from PNPM_V6_V9_FIXTURES, then EXCLUDE `workspace-cross-refs`. Probe
// surfaced an adapter-layer blocker on that reverse-only fixture: classic
// stringify emits member references that reparse with
// `YARN_CLASSIC_MISSING_ENTRY`, dropping 3 workspace edges unrelated to the
// intended classic limitations (`workspace` protocol resolution and metadata
// drop). `patch-yarn` remains included so the classic patch-loss path is
// exercised on a real pnpm-v9 source fixture.
export const CROSS_FAMILY_PNPM9_CLASSIC_FIXTURES = [
  'deps-with-scopes',
  'peers-basic',
  'peers-multi',
  'simple',
  'workspaces-basic',
  'yarn-crlf',
  'patch-yarn',
] as const

// Cross-family pnpm-v5 -> yarn-classic corpus (ADR-0020 Phase E-iv): same
// honest reverse shape as the pnpm-v9 pair MINUS `patch-yarn`, which has no
// pnpm-v5 fixture on disk.
export const CROSS_FAMILY_PNPM5_CLASSIC_FIXTURES = [
  'deps-with-scopes',
  'peers-basic',
  'peers-multi',
  'simple',
  'workspaces-basic',
  'yarn-crlf',
] as const

// Cross-family pnpm-v6 -> yarn-classic corpus (ADR-0020 Phase E-iv): mirrors
// the pnpm-v9 reverse corpus exactly. `workspace-cross-refs` remains excluded
// due to the classic-side missing-entry blocker already documented for the
// modern pnpm pair.
export const CROSS_FAMILY_PNPM6_CLASSIC_FIXTURES = [
  ...CROSS_FAMILY_PNPM9_CLASSIC_FIXTURES,
] as const

// Cross-family yarn-classic -> npm-3 corpus (ADR-0020 Phase D-ii): start
// from the 7-fixture disk intersection of CLASSIC_SHARED_FIXTURES and
// NPM_SHARED_FIXTURES, then EXCLUDE:
//   - `workspaces-basic`: the naive yarn-classic source lockfile carries only
//     the external `ms@2.1.3` entry on disk (no root/member workspace nodes
//     per ADR-0019 §C). npm-3 stringify reparses that lone node as the root
//     package (`workspacePath: ''`) and drops its tarball payload entirely.
//     Incomplete classic-source artifact; mirrors the classic -> pnpm-v9
//     workspace exclusion rationale.
export const CROSS_FAMILY_CLASSIC_NPM3_FIXTURES = [
  'deps-with-scopes',
  'git-github-tarball',
  'peers-basic',
  'peers-multi',
  'simple',
  'yarn-crlf',
] as const

// Cross-family npm-3 -> yarn-classic corpus (ADR-0020 Phase D-ii): start
// from the same 7-fixture intersection, then EXCLUDE `git-github-tarball`.
// Probe surfaced a classic-side parse/stringify handshake bug on that
// reverse-only fixture: yarn-classic stringify emits the npm-derived git
// payload as `resolved "ssh://git@github.com/...#<commit>"`, and the classic
// parser rejects that URL form with `PARSE_FAILED unsupported resolved URL`.
// Keep the remaining 6 fixtures (including peers-multi + workspaces-basic)
// where the reverse path is graph-honest.
export const CROSS_FAMILY_NPM3_CLASSIC_FIXTURES = [
  'deps-with-scopes',
  'peers-basic',
  'peers-multi',
  'simple',
  'workspaces-basic',
  'yarn-crlf',
] as const

// Cross-family npm-3 <-> bun-text shared corpus (ADR-0020 Phase C-vii):
// fixtures with both `npm-3.lock` AND `bun-text.lock` on disk. Same six-file
// intersection as the npm-3 modern cross-family pairs above; `git-github-tarball`
// excluded because `npm-3.lock` is absent on disk; `patch-yarn` excluded because
// `npm-3.lock` is absent and bun-text has no patch primitive per ADR-0014 §4.F2;
// `workspace-cross-refs` excluded because `npm-3.lock` is absent.
//
// Direction-specific narrowing is applied inline in `_matrix.ts`: `peers-multi`
// remains excluded only on the FORWARD `npm-3 -> bun-text` direction because
// bun-text still drifts on consumer-scoped de-hoist reconstruction there. The
// REVERSE `bun-text -> npm-3` direction now round-trips the multi-version stack
// cleanly.
export const CROSS_FAMILY_NPM3_BUN_FIXTURES = [
  'deps-with-scopes',
  'peers-basic',
  'peers-multi',
  'simple',
  'workspaces-basic',
  'yarn-crlf',
] as const

// Cross-family yarn-classic <-> bun-text shared corpus (ADR-0020 Phase D-iii):
// fixtures with both `yarn-classic.lock` AND `bun-text.lock` on disk. This is
// the CLASSIC_SHARED_FIXTURES ∩ bun-text intersection:
//   - `git-github-tarball` excluded because `bun-text.lock` is absent
//   - `workspace-cross-refs` excluded because `yarn-classic.lock` is absent
//
// Direction-specific narrowing is applied inline in `_matrix.ts`: the forward
// direction excludes `peers-multi` (bun-text consumer-scope resolution drift on
// classic-shaped multi-version input) and `workspaces-basic` (incomplete
// yarn-classic source artifact), while the reverse direction excludes
// `peers-multi` (bun-text parse-side version-selection blocker exposed by the
// classic round-trip).
export const CROSS_FAMILY_CLASSIC_BUN_FIXTURES = [
  'deps-with-scopes',
  'peers-basic',
  'peers-multi',
  'simple',
  'workspaces-basic',
  'yarn-crlf',
] as const

// Cross-family yarn-berry-v4 <-> bun-text shared corpus (ADR-0020 Phase
// E-iii): fixtures with both `yarn-berry-v4.lock` AND `bun-text.lock` on disk.
// Same disk intersection as the yb4 modern pairs:
//   - `git-github-tarball`: no `bun-text.lock` on disk
//   - `patch-yarn`: no `yarn-berry-v4.lock` on disk, and bun-text has no patch
//     primitive per ADR-0014 §4.F2
//   - `workspace-cross-refs`: no `yarn-berry-v4.lock` on disk
export const CROSS_FAMILY_YB4_BUN_FIXTURES = [
  'deps-with-scopes',
  'peers-basic',
  'peers-multi',
  'simple',
  'workspaces-basic',
  'yarn-crlf',
] as const

// Cross-family yarn-berry-v{5,6,8} <-> bun-text shared corpus (ADR-0020 Phase
// E-iii): fixtures with the mid-berry lockfiles plus `bun-text.lock` on disk.
// Mirrors the yb9 modern-pair intersection:
//   - `git-github-tarball`: no `bun-text.lock` on disk
//   - `patch-yarn`: only the yarn-berry-v9 side exists on disk, and bun-text
//     has no patch primitive per ADR-0014 §4.F2
//
// Unlike v4, `workspace-cross-refs` is INCLUDED because the v5/v6/v8 fixtures
// exist there.
export const CROSS_FAMILY_YB_MID_BUN_FIXTURES = [
  'deps-with-scopes',
  'peers-basic',
  'peers-multi',
  'simple',
  'workspace-cross-refs',
  'workspaces-basic',
  'yarn-crlf',
] as const

// Cross-family yarn-berry-v9 <-> bun-text shared corpus (ADR-0020 Phase C-v):
// fixtures with both `yarn-berry-v9.lock` AND `bun-text.lock` on disk.
// Exclusions vs the 7-fixture intersection:
//   - `patch-yarn`: bun-text has no `patch:` primitive (ADR-0014 §4.F2 — bun-text
//     row drops patches with RECIPE_FEATURE_DROPPED). Including it on the
//     forward direction would require declaring a `patch` LossEntry alongside
//     `workspace-rekey`; mirrors Phase C-iii/C-iv precedent of narrowing
//     patch-bearing corpora rather than overdeclaring cross-family patch loss.
//     The adapter-layer RECIPE_FEATURE_DROPPED diagnostic already represents
//     the loss honestly per ADR-0014 §5; first-class cross-family patch
//     coverage deferred (no bun-text source fixture for patch-yarn exists on
//     disk either, so the reverse direction is N/A regardless).
//   - `git-github-tarball`: `yarn-berry-v9.lock` is absent on disk for that
//     fixture (mirrors BERRY_SHARED_NO_GIT_FOR_V9 rationale).
//
// The 7-fixture corpus is shared in both directions.
export const CROSS_FAMILY_YB9_BUN_FIXTURES = [
  'deps-with-scopes',
  'peers-basic',
  'peers-multi',
  'simple',
  'workspace-cross-refs',
  'workspaces-basic',
  'yarn-crlf',
] as const

// Cross-family pnpm-v9 <-> bun-text shared corpus (ADR-0020 Phase C-vi):
// fixtures with both `pnpm-v9.lock` AND `bun-text.lock` on disk.
// Exclusions vs the 8-fixture intersection:
//   - `patch-yarn`: only the pnpm-v9 side exists on disk, and bun-text has no
//     patch primitive (ADR-0014 §4.F2). The forward adapter already emits
//     RECIPE_FEATURE_DROPPED honestly; keeping the shared corpus to the
//     bidirectional 7-fixture intersection mirrors the yb9 <-> bun-text Phase
//     C-v precedent and avoids asymmetric fixture catalog semantics.
//
// Direction-specific narrowing is still allowed inline in `_matrix.ts` if a
// future probe finds a one-sided blocker.
export const CROSS_FAMILY_PNPM9_BUN_FIXTURES = [
  'deps-with-scopes',
  'peers-basic',
  'peers-multi',
  'simple',
  'workspace-cross-refs',
  'workspaces-basic',
  'yarn-crlf',
] as const

// Cross-family pnpm-v5 <-> bun-text shared corpus (ADR-0020 Phase E-iv): same
// 7-fixture disk intersection as the pnpm-v9 pair. `patch-yarn` is absent
// because pnpm-v5 has no on-disk patch fixture and bun-text cannot encode
// patches anyway.
export const CROSS_FAMILY_PNPM5_BUN_FIXTURES = [
  ...CROSS_FAMILY_PNPM9_BUN_FIXTURES,
] as const

// Cross-family pnpm-v6 <-> bun-text shared corpus (ADR-0020 Phase E-iv):
// mirrors the pnpm-v9 7-fixture intersection. `patch-yarn` stays out of the
// shared corpus because the bun-text side has no fixture on disk.
export const CROSS_FAMILY_PNPM6_BUN_FIXTURES = [
  ...CROSS_FAMILY_PNPM9_BUN_FIXTURES,
] as const

// Cross-family yarn-berry-v9 <-> pnpm-v9 shared corpus (ADR-0020 Phase C-i):
// fixtures with both `yarn-berry-v9.lock` AND `pnpm-v9.lock` on disk MINUS
// `patch-yarn`. patch-yarn drops would require declaring a `patch-slot-divergent`
// loss (sentinel hash differs across PMs by canonical input per ADR-0011 — yarn
// hashes the patch locator, pnpm hashes `<name>@<version>:<literalKey>`) on top
// of the workspace-rekey + tarball-extras losses. Per ADR-0020 §2 honesty
// principle + Phase A's narrow-rather-than-overdeclare precedent
// (git-github-tarball exclusion from npm-1 corpus), narrow here and defer
// cross-family patch handling to a Phase C-i follow-up.
export const CROSS_FAMILY_YB9_PNPM9_FIXTURES = [
  'deps-with-scopes',
  'peers-basic',
  'peers-multi',
  'simple',
  'workspace-cross-refs',
  'workspaces-basic',
  'yarn-crlf',
] as const

// Cross-family yarn-berry-v9 <-> pnpm-v5 shared corpus (ADR-0020 Phase E-iv):
// same 7-fixture disk intersection as the pnpm-v9 pair. `patch-yarn` is absent
// because pnpm-v5 has no patch primitive, so no extra patch-slot narrowing is
// needed beyond the existing yarn/pnpm family precedent.
export const CROSS_FAMILY_YB9_PNPM5_FIXTURES = [
  ...CROSS_FAMILY_YB9_PNPM9_FIXTURES,
] as const

// Cross-family yarn-berry-v9 <-> pnpm-v6 shared corpus (ADR-0020 Phase E-iv):
// same 7-fixture honest intersection as the pnpm-v9 pair. `patch-yarn` stays
// excluded because first-class yarn↔pnpm patch-slot divergence remains deferred.
export const CROSS_FAMILY_YB9_PNPM6_FIXTURES = [
  ...CROSS_FAMILY_YB9_PNPM9_FIXTURES,
] as const

// Cross-family yarn-berry-v4 <-> pnpm-v9 shared corpus (ADR-0020 Phase E-i):
// fixtures with both `yarn-berry-v4.lock` AND `pnpm-v9.lock` on disk. Same
// narrowing logic as the yb9 pair, with one extra disk-intersection exclusion:
//   - `patch-yarn`: no yarn-berry-v4 fixture on disk, and first-class
//     cross-family patch-slot divergence remains deferred
//   - `git-github-tarball`: no pnpm-v9 fixture on disk
//   - `workspace-cross-refs`: no yarn-berry-v4 fixture on disk
//
// v4 also lacks `conditions`, so no further corpus pruning is needed.
export const CROSS_FAMILY_YB4_PNPM9_FIXTURES = [
  'deps-with-scopes',
  'peers-basic',
  'peers-multi',
  'simple',
  'workspaces-basic',
  'yarn-crlf',
] as const

// Cross-family yarn-berry-v{5,6,8} <-> pnpm-v9 shared corpus
// (ADR-0020 Phase E-ii): fixtures with all three mid-berry lockfiles plus
// `pnpm-v9.lock` on disk. Mirrors the yb9 modern-pair narrowing:
//   - `patch-yarn`: only the pnpm-v9 side exists on disk and first-class
//     cross-family patch-slot divergence remains deferred
//   - `git-github-tarball`: no pnpm-v9 fixture on disk
//
// Unlike the yb4 pair, `workspace-cross-refs` is INCLUDED because the v5/v6/v8
// fixtures exist there. Conditions support landed in v5+, but no shared-disk
// fixture carries a `conditions` block, so no extra pruning is needed.
export const CROSS_FAMILY_YB_MID_PNPM9_FIXTURES = [
  'deps-with-scopes',
  'peers-basic',
  'peers-multi',
  'simple',
  'workspace-cross-refs',
  'workspaces-basic',
  'yarn-crlf',
] as const

// npm intra-family shared corpus (available across npm-1, npm-2, npm-3 on disk):
// - bundled-deps excluded: only npm-2/npm-3 fixtures exist; no npm-1 mirror
// - patch-yarn excluded: only npm-1 fixture exists; patches are not an npm primitive
// - workspace-cross-refs excluded: no npm-* fixture on disk
//
// The `to: npm-1` directional subset is derived inline in `_matrix.ts` next to
// the buildNpmIntraPair contract that consumes it.
export const NPM_SHARED_FIXTURES = [
  'deps-with-scopes',
  'git-github-tarball',
  'peers-basic',
  'peers-multi',
  'simple',
  'workspaces-basic',
  'yarn-crlf',
] as const

// Cross-family npm-1 <-> yarn-berry-v9 shared corpus (ADR-0020 Phase E-v):
// start from the 7-fixture disk intersection, then EXCLUDE the npm-1-unsafe
// workspace-bearing fixtures:
//   - `peers-multi`, `workspaces-basic`: npm-1's recursive tree shape on disk
//     does not preserve the workspace-member graph honestly (ADR-0021 §A.npm-1)
//   - `git-github-tarball`: no `yarn-berry-v9.lock` on disk
//
// `patch-yarn` is INCLUDED because both `npm-1.lock` and `yarn-berry-v9.lock`
// exist on disk; only the reverse `yb9 -> npm-1` direction exercises the patch
// loss.
export const CROSS_FAMILY_NPM1_YB9_FIXTURES = [
  'deps-with-scopes',
  'patch-yarn',
  'peers-basic',
  'simple',
  'yarn-crlf',
] as const

// Cross-family npm-1 <-> pnpm-v9 shared corpus (ADR-0020 Phase E-v): same
// npm-1-driven narrowing shape as the yb9 pair:
//   - `peers-multi`, `workspaces-basic`: excluded per npm-1 workspace/topology
//     limits
//   - `git-github-tarball`: no `pnpm-v9.lock` on disk
//
// `patch-yarn` is INCLUDED because both sides exist on disk; only the reverse
// `pnpm-v9 -> npm-1` direction advertises the patch loss.
export const CROSS_FAMILY_NPM1_PNPM9_FIXTURES = [
  'deps-with-scopes',
  'patch-yarn',
  'peers-basic',
  'simple',
  'yarn-crlf',
] as const

// Cross-family npm-1 <-> bun-text shared corpus (ADR-0020 Phase E-v): start
// from the 6-fixture disk intersection and EXCLUDE npm-1-unsafe
// workspace-bearing fixtures:
//   - `peers-multi`, `workspaces-basic`: excluded per ADR-0021 §A.npm-1
//   - `git-github-tarball`: no `bun-text.lock` on disk
//   - `patch-yarn`: no `bun-text.lock` on disk
export const CROSS_FAMILY_NPM1_BUN_FIXTURES = [
  'deps-with-scopes',
  'peers-basic',
  'simple',
  'yarn-crlf',
] as const

// Cross-family npm-1 <-> yarn-classic shared corpus (ADR-0020 Phase E-v):
// start from the 7-fixture disk intersection, then EXCLUDE:
//   - `peers-multi`, `workspaces-basic`: npm-1 on-disk topology does not carry
//     the workspace-member graph honestly
//   - `git-github-tarball`: the pair has no contractable steady-state profile
//     there (npm-1 -> classic reparses with an unsupported git URL; reverse
//     npm-1 emit also collapses the git node identity)
export const CROSS_FAMILY_NPM1_CLASSIC_FIXTURES = [
  'deps-with-scopes',
  'peers-basic',
  'simple',
  'yarn-crlf',
] as const
