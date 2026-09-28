# PM_COMPARE — what the package managers actually do differently

[PM.md](./PM.md) is the census — every manager that exists, the lockfile it writes
and the registry it leans on. This file is the comparison: the five that matter,
version by version, answering why there are so many of them. The registries
themselves are in [REGISTRIES.md](./REGISTRIES.md).

## Versions, dates and the runtime they need

Last release of each major line, its date, and the Node range the package declares.
Read 2026-09-28 from the npm registry; Deno from its GitHub releases.

| Manager | Major | Last release | Date | Node range |
| --- | --- | --- | --- | --- |
| npm | 6 | 6.14.18 | 2022-12-21 | `6 >=6.2.0 \|\| 8 \|\| >=9.3.0` |
| npm | 7 | 7.24.2 | 2021-10-04 | `>=10` |
| npm | 8 | 8.19.4 | 2023-02-14 | `^12.13.0 \|\| ^14.15.0 \|\| >=16.0.0` |
| npm | 9 | 9.9.4 | 2024-12-09 | `^14.17.0 \|\| ^16.13.0 \|\| >=18.0.0` |
| npm | 10 | 10.9.9 | 2026-07-29 | `^18.17.0 \|\| >=20.5.0` |
| npm | 11 | 11.20.0 | 2026-09-22 | `^20.17.0 \|\| >=22.9.0` |
| npm | 12 | 12.1.0 | 2026-09-22 | `^22.22.2 \|\| ^24.15.0 \|\| >=26.0.0` |
| Yarn Classic | 1 | 1.22.22 | 2024-03-09 | `>=4.0.0` |
| Yarn Berry | 2 | 2.4.3 | 2021-09-06 | `>=10.19.0` |
| Yarn Berry | 3 | 3.8.7 | 2024-12-04 | `>=12 <14 \|\| 14.2 - 14.9 \|\| >14.10.0` |
| Yarn Berry | 4 | 4.18.1 | 2026-09-24 | `>=18.12.0` |
| pnpm | 6 | 6.35.1 | 2022-11-11 | `>=12.17` |
| pnpm | 7 | 7.33.7 | 2024-02-15 | `>=14.6` |
| pnpm | 8 | 8.15.9 | 2024-07-17 | `>=16.14` |
| pnpm | 9 | 9.15.9 | 2025-03-10 | `>=18.12` |
| pnpm | 10 | 10.34.5 | 2026-07-10 | `>=18.12` |
| pnpm | 11 | 11.27.1 | 2026-09-20 | `>=22.13` |
| pnpm | 12 | 12.6.0 | 2026-09-22 | `>=18.*` |
| Bun | 1 | 1.4.2 | 2026-09-05 | — |
| Deno | 2 | 2.9.6 | 2026-08-27 | — |

Every Node-hosted manager tightens its range with each major: npm 12 will not start
on Node 20. Bun and Deno declare none, so the manager can never be too old for the
runtime — it *is* the runtime. pnpm 12 has joined them: its package ships a native
executable, so the `>=18.*` it still declares — looser than pnpm 11's — does not describe
a runtime it needs.

npm 11 and 12 were published the same day, and all three lines last shipped together on
2026-07-29. Each major is pinned to a slice of
Node's supported lines, so npm carries three parallel lines because Node does.

## What each version reads and writes

| | npm 6 | npm 7–8 | npm 9–11 | npm 12 | Yarn 1 | Yarn 2 | Yarn 3 | Yarn 4 | pnpm 6 | pnpm 7–8 | pnpm 9–10 | pnpm 11 | Bun 1.0–1.1 | Bun 1.2+ | Deno 1 | Deno 2 |
| --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| **Reads** | v1 | v1, v2, v3 | ← | ← + v4 | classic | berry v4 | berry v4–v6 | berry v6–v10 | pnpm v5 | v5, v6 | v6, v9 | ← | `.lockb` | `.lockb`, `.lock` | deno v2–v3 | deno v2–v5 |
| **Writes** | v1 | v2 | v3 | v3, v4 ⚠️ | classic | berry v4 | v5 / v6 ⚠️ | v8 / v9 / v10 ⚠️ | v5 | v6 | v9 | ← | `.lockb` | `.lock` | v3 | v4 / v5 ⚠️ |

- **npm 12** — v3 for ordinary projects, v4 only when native `npm patch`,
  `packageExtensions` or `.npm-extension` state is present. Feature-triggered, not
  version-triggered.
- **Yarn 3** — v5 existed for exactly one release, 3.1.0. Yarn 3.0.x wrote v4 and
  3.2.0 jumped to v6.
- **Yarn 4** — v8 from 4.0, v9 from 4.14.0, v10 from 4.17.1. v7 exists only in the
  4.0 RC window; no stable release writes it.
- **pnpm 12** — not yet a column in these tables; what is measured so far is here. It
  writes `'9.0'`, byte-identical to pnpm 11.28.1 for the same project (12.6.0 and
  12.8.0), and reads a v6 lock only to migrate it. Under
  `--frozen-lockfile` pnpm 9 installs from a v6 lock; 10 and 11 refuse it with
  `ERR_PNPM_LOCKFILE_BREAKING_CHANGE`, and 12 with `ERR_PNPM_BROKEN_LOCKFILE`.
- **Deno 2** — 2.2.8 writes v4, 2.9.4 writes v5. No released Deno writes v2: every
  pinned binary rewrites a v2 lock to its own version on install.

Writing an older version back needs an explicit flag on npm and is impossible
everywhere else. The lockfile is a one-way ratchet, which is why a team cannot
casually try another manager.

## Registry

| | npm 6 | npm 7–8 | npm 9–11 | npm 12 | Yarn 1 | Yarn 2 | Yarn 3 | Yarn 4 | pnpm 6 | pnpm 7–8 | pnpm 9–10 | pnpm 11 | Bun 1.0–1.1 | Bun 1.2+ | Deno 1 | Deno 2 |
| --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| Reads `.npmrc` | ✅ | ← | ← | ← | ✅ | ✅ | ← | ← | ✅ | ← | ← | ← | ✅ | ← | ✅ | ← |
| Own config file | ❌ | ← | ← | ← | `.yarnrc` | `.yarnrc.yml` | ← | ← | ❌ | ← | ← | ← | `bunfig.toml` | ← | `deno.json` | ← |

Which host each one defaults to is in [PM.md](./PM.md#1-primary-package-managers),
where it identifies the tool; what those hosts are is in
[REGISTRIES.md](./REGISTRIES.md). What differs *behaviourally* is the configuration.

**All five read `.npmrc`**, so a token placed there works everywhere. What they add
on top does not interoperate: Yarn Classic reads `.yarnrc`, Berry replaced it with
`.yarnrc.yml`, Bun adds `bunfig.toml`, Deno adds `deno.json`, and npm and pnpm add
nothing. A scope-to-registry mapping written for one is invisible to the others, so
resolution has to be scoped to the ecosystem asking — a planted `.yarnrc.yml` must
not influence an npm resolve.

Deno is the only one that speaks a second registry protocol natively, which is why
a `deno.lock` can hold packages no Node-family lock has anywhere to put.

## Installed layout

| | npm 6 | npm 7–8 | npm 9–11 | npm 12 | Yarn 1 | Yarn 2 | Yarn 3 | Yarn 4 | pnpm 6 | pnpm 7–8 | pnpm 9–10 | pnpm 11 | Bun 1.0–1.1 | Bun 1.2+ | Deno 1 | Deno 2 |
| --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| Hoisted `node_modules` | ✅ | ← | ← | ← | ✅ | ⚠️ | ← | ← | ⚠️ | ← | ← | ← | ✅ | ← | ⚠️ | ← |
| Symlinked isolated store | ❌ | ← | ← | ← | ❌ | ❌ | ← | ← | ✅ | ← | ← | ← | ❌ | ← | ❌ | ← |
| Plug'n'Play | ❌ | ← | ← | ← | ❌ | ✅ | ← | ← | ⚠️ | ← | ← | ← | ❌ | ← | ❌ | ← |
| Content-addressable store | ❌ | ← | ← | ← | ⚠️ | ✅ | ← | ← | ✅ | ← | ← | ← | ✅ | ← | ✅ | ← |

- **Yarn 2 hoisted** — `nodeLinker: node-modules`; PnP is the default.
- **pnpm hoisted** — `nodeLinker: hoisted`; the isolated layout is the default.
- **pnpm PnP** — `nodeLinker: pnp` exists, but is not the design centre.
- **Yarn 1 store** — the offline mirror caches tarballs; installs still copy a full
  tree per project.
- **Deno hoisted** — materialises `node_modules` only for Node compatibility.

## Dependency semantics

| | npm 6 | npm 7–8 | npm 9–11 | npm 12 | Yarn 1 | Yarn 2 | Yarn 3 | Yarn 4 | pnpm 6 | pnpm 7–8 | pnpm 9–10 | pnpm 11 | Bun 1.0–1.1 | Bun 1.2+ | Deno 1 | Deno 2 |
| --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| Workspaces | ❌ | ✅ | ← | ← | ✅ | ✅ | ← | ← | ✅ | ← | ← | ← | ✅ | ← | ⚠️ | ✅ |
| `workspace:` protocol | ❌ | ⚠️ | ← | ← | ❌ | ✅ | ← | ← | ✅ | ← | ← | ← | ✅ | ← | ❌ | ← |
| Peer context in the lock | ❌ | ← | ← | ← | ❌ | ✅ | ← | ← | ✅ | ← | ← | ← | ❌ | ← | ✅ | ← |
| `catalog:` protocol | ❌ | ← | ← | ← | ❌ | ❌ | ← | ← | ❌ | ← | ✅ | ← | ❌ | ← | ❌ | ← |
| os/cpu/libc conditions | ❌ | ← | ← | ← | ❌ | ❌ | ⚠️ | ✅ | ❌ | ← | ← | ← | ❌ | ← | ⚠️ | ← |

- **npm `workspace:`** — members are recorded as a path plus `link: true`; there is
  no protocol and no way to express a workspace range.
- **Peer context** — two installs of `react@18.2.0` under different peer sets are
  different instances. Berry encodes this as a `virtual:` locator, pnpm as a
  snapshot-key suffix, Deno as an npm-key suffix. npm, Yarn Classic and Bun model
  one instance per name+version, so converting into those formats collapses peer
  forks irreversibly.
- **Yarn 3 conditions** — the block arrives with berry wire v5, which lands in
  3.1.0; earlier Yarn 3 writes v4 and has no carrier.
- **Deno conditions** — `os` and `cpu` for npm packages, not `libc`.

## Overrides, patching, reproducibility

| | npm 6 | npm 7–8 | npm 9–11 | npm 12 | Yarn 1 | Yarn 2 | Yarn 3 | Yarn 4 | pnpm 6 | pnpm 7–8 | pnpm 9–10 | pnpm 11 | Bun 1.0–1.1 | Bun 1.2+ | Deno 1 | Deno 2 |
| --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| Forced version overrides | ❌ | ✅ | ← | ← | ✅ | ✅ | ← | ← | ✅ | ← | ← | ← | ✅ | ← | ⚠️ | ← |
| Override policy in the lock | ❌ | ← | ← | ← | ❌ | ❌ | ← | ← | ✅ | ← | ← | ⚠️ | ✅ | ← | ❌ | ← |
| Patched dependencies | ❌ | ← | ← | ✅ | ❌ | ✅ | ← | ← | ✅ | ← | ← | ← | ⚠️ | ← | ❌ | ← |
| Frozen install mode | ⚠️ | ✅ | ← | ← | ⚠️ | ✅ | ← | ← | ✅ | ← | ← | ← | ✅ | ← | ✅ | ← |

- npm reads `overrides` and Yarn reads `resolutions` from `package.json`, never
  from the lockfile. pnpm and Bun persist a carrier inside the lock and compare it
  in frozen mode. Converting pnpm → npm therefore has to edit two files; a
  converter that writes only a lockfile produces the wrong install silently.
- **pnpm 11** — the carrier moves from `package.json` `pnpm.overrides` to
  `pnpm-workspace.yaml`.
- **npm 6 / Yarn 1 frozen** — `npm ci` predates the workspace-aware lockfile;
  Yarn 1's `--frozen-lockfile` checks far less than Berry's `--immutable`.
- **Bun patches** — a top-level map, without the per-node carrier Berry and pnpm use.
- **Deno overrides** — config only, no lockfile carrier.

## Security

| | npm 6 | npm 7–8 | npm 9–11 | npm 12 | Yarn 1 | Yarn 2 | Yarn 3 | Yarn 4 | pnpm 6 | pnpm 7–8 | pnpm 9–10 | pnpm 11 | Bun 1.0–1.1 | Bun 1.2+ | Deno 1 | Deno 2 |
| --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| `audit` | ✅ | ✅ | ← | ← | ✅ | ✅ | ← | ← | ✅ | ← | ← | ← | ❌ | ✅ ⚠️ | ❌ | ✅ ⚠️ |
| `audit fix` | ✅ | ← | ← | ← | ❌ | ❌ | ← | ← | ⚠️ | ← | ← | ← | ❌ | ⚠️ | ⚠️ | ← |

- **Bun `audit`** — arrives in 1.2.15, not at the 1.2 boundary where the text
  lockfile does. **Deno `audit`** — arrives in 2.5.5; 2.2.8 has no such subcommand
  at all.
- Only npm remediates from advisories by bumping the declared range, respecting
  semver and gating a major behind `--force`. pnpm's manual channel pins an
  **override** on the vulnerable node instead — fixing at the source rather than at
  the consumer, and bypassing the declared range by design.
- Yarn has no native fix in either line; `yarn-audit-fix` implements the range-bump
  model externally.
- **Deno ⚠️ — implemented, and inert for a reason outside Deno.** `deno audit`
  arrived in 2.5.5, `--fix` in 2.8.0, and the implementation is complete: it raises
  the floor of a vulnerable direct dependency in `package.json` or `deno.json` and
  regenerates the lockfile. Against the real npm registry it fixes nothing, because
  npm's bulk advisory endpoint returns no `patched_versions` field, so Deno derives
  zero fix actions and never reaches its own install path.

  > **Measured** · `deno 2.9.4` · `deno audit --fix` on `minimist` pinned to a
  > vulnerable version, run twice against the same project with only the registry
  > host differing · against `registry.npmjs.org` both files are byte-identical
  > afterwards; against a proxy that injects `patched_versions` into the same
  > response it prints `Fixed 1 vulnerability`, rewrites the manifest `^1.2.0` →
  > `^1.2.6` and the lock to `minimist@1.2.8`. Toggling the injection alone flips
  > the outcome.

  Two consequences. The Deno gap is **registry data, not a missing feature**, so it
  can close without a Deno release — treat any position that assumes Deno will not
  remediate as having a short shelf life. And separately, transitive dependencies
  are skipped by design even when the data is present, reported as
  `could not be fixed automatically`.
- **Bun ⚠️ — documented, not in any release.**
  [Bun's documentation specifies `bun audit fix`](https://bun.com/docs/pm/cli/audit#bun-audit-fix)
  in detail: it upgrades each vulnerable package to the **lowest** non-vulnerable
  version that **every dependent's range already allows**, changes only `bun.lock`
  and `node_modules`, and re-audits afterwards, with `--latest`, `--dry-run` and
  `--ignore-scripts` flags.

  That is a third model, not a variant of the other two. It never changes what the
  project asks for and never bypasses a declared range — it re-resolves inside the
  ranges that are already there. Three consequences follow: no semver contract is
  crossed, so there is no `--force` and none is needed; it can only fix what the
  existing ranges already permit, and is powerless when they admit no safe version;
  and it moves to the *lowest* safe version rather than the newest, so a fix drags
  in no unrelated change. The one manifest edit — widening an exact pin to
  `^version` — is the same rule seen from the other side: an exact pin makes the
  allowed set a single version, leaving nothing to re-resolve.

  **Shipped in bun 1.4.0.** The implementation merged into `main` on 2026-08-14
  (PR #38333, `src/install/audit_fix.rs`) and reached a release with 1.4.0; the
  row below that predicted it is kept because the prediction was the reason to
  re-measure. Up to and including `bun-v1.3.14` (2026-05-13) no released binary
  implemented it, bun.com's docs were built from `main` rather than the release
  tag, and the published page therefore described unreleased work.

  `bun audit` itself shipped in **1.2.15** (2025-05-28); the `fix` subcommand did
  not accompany it, and an earlier attempt at one (PR #20301) was closed unmerged
  in June 2026.

  **On a pre-1.4 binary, do not detect this by exit code.** Those releases discard
  `fix` and still exit 1 because vulnerabilities remain — indistinguishable from a
  real run that found nothing to fix. Gate on the version, or look for a `fix`
  entry in `bun audit --help`.

  > **Measured** · `bun 1.3.14` · `bun audit fix` on a project pinning
  > `minimist@1.2.0` · prints the same report as `bun audit`, leaves `package.json`
  > and `bun.lock` unchanged with `minimist` still at `1.2.0`, and exits 0.
  > `bun audit <any-word>` produces identical output.

  > **Measured** · `bun 1.4.0` · same project, plus `lodash@4.17.4` · `bun audit fix`
  > reports `Fixed 12 vulnerabilities in 2 packages`, moves the lock to
  > `minimist@1.2.6` / `lodash@4.18.0` and rewrites BOTH entries in `package.json`.
  > `bun audit --help` lists the subcommand and `-L, --latest` ("Also apply fixes
  > your declared ranges exclude, rewriting package.json").

  **bun rewrites an exact pin without being asked**, which is where it parts from
  npm. Measured on `bun 1.4.0`: a declared exact `"1.2.0"` becomes a declared exact
  `"1.2.6"` under PLAIN `bun audit fix` — no `--latest`, and the result is another
  exact pin rather than npm's widened `^`. With the declaration already a range
  (`^1.2.0`, `~1.2.0`) that admits a safe version, install resolves there anyway
  and the manifest is untouched. The `--latest` boundary is quoted from its own
  help text and is NOT separately measured here — the exact-pin case reaches the
  same version with or without it.

  What works today is `bun update`, which is driven by staleness rather than by
  advisories and so cannot target the vulnerable subset — it moves every dependency
  at once. It does reach the lockfile, and it also rewrites the declared range;
  against an exact pin it refuses to move at all unless `--latest` is passed.
  (`bun upgrade`, confusingly adjacent, upgrades Bun itself.)

  > **Measured** · `bun 1.3.14` · `bun update` with `bun.lock` at the vulnerable
  > `minimist@1.2.0` and the manifest widened to `^1.2.0` · moves the lock to
  > `1.2.8` and the manifest to `^1.2.8`; `bun audit` then reports none. With the
  > manifest left at an exact `1.2.0`, `bun update` changes neither file;
  > `bun update --latest` moves both.

Three models, and the difference is where the fix lands. A **range bump** (npm)
changes what the project asks for. An **override pin** (pnpm) changes what it gets,
bypassing what it asked for. A **re-resolve** (Bun, as documented) changes what it
gets without touching what it asked for — the narrowest of the three, and the only
one that cannot reach a vulnerability the declared ranges exclude. Converting a
project between these managers moves its fix from one place to another, and the
target may not have a place to put it.

## Why there are so many

Each of them exists because it refused a constraint the previous one accepted.

**npm accepted the hoisted tree.** A flat `node_modules` lets any package require
whatever happens to be hoisted beside it — undeclared-dependency access, invisible
until it breaks. **pnpm refused it**: the symlinked store makes an undeclared import
fail immediately. The shared store was the bonus, not the thesis.

**npm accepted `node_modules` itself.** Tens of thousands of files per project,
resolved by walking directories at runtime. **Yarn Berry refused it**: PnP replaces
the walk with a lookup table and keeps packages zipped. The cost was everything that
assumed a real filesystem, which is why Berry still ships `nodeLinker: node-modules`
and why the migration stalled.

**Everyone accepted running on Node.** That caps the manager at Node's startup and
I/O and chains its release line to Node's. **Bun and Deno refused it** — which is
why they carry no Node range, and why neither could have been "a faster npm".

**Yarn Classic accepted being replaceable.** It proved determinism and workspaces
mattered, npm absorbed both by v7, and 1.x became maintenance-only. Its successor
was a rewrite, which is why `yarn` names two incompatible products.

What did not fork: all five speak the npm registry protocol and resolve semver
ranges. The disagreements are only about where files land, what the lockfile may
remember, and what runs the resolver — never about what a package is. That shared
floor is why a lockfile can be converted between them at all, and those three are
what a conversion has to negotiate.

## Sources

Versions, dates and Node ranges from the npm registry publication record, read
2026-08-15; Deno from its GitHub releases. Behavioural rows from the per-format
specs under [`docs/spec/formats`](../spec/formats/) and the per-manager specs under
[`docs/spec/pm`](../spec/pm/). A cell here that disagrees with those is wrong here.
