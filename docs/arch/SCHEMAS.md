# Lockfile schemas

Public reference for every lockfile schema this project recognises:
how to identify each, which package-manager versions emit it by
default, and which can install from it. Adapter ids match the
`FormatId` literal accepted by `parse({ format })` and required by
`stringify({ format })`.

## npm

| Adapter id | Marker | Default writer | Reader |
|------------|--------|----------------|--------|
| `npm-1`    | `lockfileVersion: 1` | npm `>=5 <7` | npm `>=5` |
| `npm-2`    | `lockfileVersion: 2` | npm `>=7 <9` | npm `>=7` |
| `npm-3`    | `lockfileVersion: 3` | npm `>=9` (default unless v4 features are active) | npm `>=7` |
| `npm-4`    | `lockfileVersion: 4` | npm `>=12` (patch / extension features) | npm `>=12` |

`npm install --lockfile-version=N` overrides the writer choice within
the supported range. npm 12 still writes v3 for an ordinary project; native
`npm patch`, `packageExtensions`, or `.npm-extension` state activates v4.
npm 11 can accept a v4-shaped file without a syntax error but does not apply
its patch semantics, so it is not a compatible v4 reader.


### The `node_modules/.lockfile-…` placeholder key

An npm lock addresses every package by its **install path**, so a package needs a place
in the tree to exist at all. A node with no consumer to nest under and whose hoisted slot
`node_modules/<name>` is already taken by a different node has no such place: npm's format
simply cannot express it. Rather than drop it — a dropped entry takes its checksum with
it, which is a bug and never an acceptable simplification — the emit parks it at

```
node_modules/.lockfile-<name>-<version>-<n>/node_modules/<name>
```

**This is a placeholder, not an install path. npm has no such store, and a lock carrying
one is not installable as-is.** How loudly it is reported depends on whether the emitting graph
also fails the completeness comparison, which is not the same question as whether a path was
invented. Measured on one stale-entry lock:

```
orphan bound through manifests    strict ACCEPTS   LAYOUT_PLACEMENT_RESYNTHESISED (info) only
orphan left unbound               strict REFUSES   + COMPLETENESS_OUTPUT_GRAPH_MISMATCH (error)
                                                   + PROJECTION_LOSS, IRREDUCIBLE_LOSS
```

So `strict` is not a reliable guard against this key: the better-formed input is the one that
gets through. Callers who must not receive an uninstallable lock should scan the emitted
`packages` keys for `node_modules/.lockfile-` rather than rely on strict mode.

Reaching it at all takes one of two things, and the first is a caller error rather than a
property of any lockfile:

- **Mixing the public and `@internal` codec overloads.** `parse` and `stringify` each accept a
  documented order and a pre-0.6 compatibility order. Pairing a modern `parse(input, format)`
  with the target-first `stringify(format, graph)` passes a PUBLIC graph wrapper into the
  internal serializer, which loses the internal graph and sidecar semantics and emits a flat
  tree with every duplicate parked. Measured on one pnpm lock: that pairing yields 1,086 keys
  with 161 parked and nothing nested, while the other three pairings all yield 4,558 keys,
  4,443 nested and zero parked. Keep both halves of a call in the same generation.
- **A duplicate whose only consumer is the root.** Everything a root depends on hoists to top
  level by definition, so a second version whose consumer is the root has nowhere to nest.
  npm's format cannot express it and parking is the honest answer.

`npm-1` has no `packages` map and cannot park: it emits a nested `dependencies` tree and drops
what it cannot place, reporting `PROJECTION_LOSS` per node, `COMPLETENESS_OUTPUT_GRAPH_MISMATCH`
at severity `error`, and `IRREDUCIBLE_LOSS` under `strict`.

Manifests decide the root's dependency EDGES, not merely its override declarations — with a
declared root manifest a 750-node yarn-classic lock has root out-degree 1, without one the
synthesised root claims 51 direct dependencies. Note that only the pre-0.6 argument order
`parse(format, input, { manifests })` honours them: the documented `parse(input, format,
{ manifests })` discards the option, and its output is byte-identical to passing no options.

## yarn

`yarn-classic` and `yarn-berry-*` use different lockfile schemas. The
"v" suffix on berry adapters is `__metadata.version`. Yarn classic
uses a `# yarn lockfile v1` *comment header* instead — unrelated to
berry's `__metadata`.

| Adapter id        | Marker                       | Default writer       | Reader  |
|-------------------|------------------------------|----------------------|---------|
| `yarn-classic`    | `# yarn lockfile v1` header  | yarn `>=1 <2`        | yarn `>=1 <2` (native); yarn `>=2` via `yarn import` |
| `yarn-berry-v3`   | `__metadata.version: 3`      | yarn `>=2.0.0-rc.4 <2.0.0-rc.20` (pre-release only) | yarn `>=2` |
| `yarn-berry-v4`   | `__metadata.version: 4`      | yarn `>=2.0.0-rc.20 <3.1` | yarn `>=2` |
| `yarn-berry-v5`   | `__metadata.version: 5`      | yarn `=3.1.0` (one minor) | yarn `>=3.1` |
| `yarn-berry-v6`   | `__metadata.version: 6`      | yarn `>=3.2 <4`      | yarn `>=3.2` |
| `yarn-berry-v8`   | `__metadata.version: 8`      | yarn `>=4.0 <4.14`   | yarn `>=4` |
| `yarn-berry-v9`   | `__metadata.version: 9`      | yarn `>=4.14`        | yarn `>=4.14` |
| `yarn-berry-v10`  | `__metadata.version: 10`     | yarn `>=4.17.1`      | yarn `>=4.17.1` |

**Schema numbers that don't exist:**
- `__metadata.version: 1` and `2` were never used by berry.
- `__metadata.version: 7` was skipped — yarn went `6 → 8` in 4.0.0.

`YARN_LOCKFILE_VERSION_OVERRIDE` (yarn 4+) lets one binary write any
schema version it can read; structural fidelity to the canonical
writer is not guaranteed.

## pnpm

| Adapter id | Marker                   | Default writer       |
|------------|--------------------------|----------------------|
| `pnpm-v5`  | `lockfileVersion: 5.x`   | pnpm `>=3 <8`  (pnpm 7 stayed on `5.4` by default) |
| `pnpm-v6`  | `lockfileVersion: '6.0'`/`'6.1'` | pnpm `>=8 <9` |
| `pnpm-v9`  | `lockfileVersion: '9.0'` | pnpm `>=9`           |

**Schema numbers that don't exist:** `7` and `8`. pnpm 9 jumped
straight from `6.x` to `9.0`.

## bun

| Adapter id    | Marker                          | Default writer | Status |
|---------------|---------------------------------|----------------|--------|
| `bun-text`    | `bun.lock` filename + JSONC     | bun `>=1.2`    | primary bun target |
| `bun-binary`  | `bun.lockb` filename + magic    | bun `<1.2`     | detect-only — not parsed |

`bun-binary` is a **permanent non-goal**: when `parse()` detects
`bun.lockb` magic bytes it throws with a hint to migrate via bun's
own tooling (`bun install --save-text-lockfile`). The library handles
the resulting `bun.lock` via the `bun-text` adapter. bun's own
binary reader stays in bun for back-compat — that is bun's
responsibility, not ours.

`bun-text` is generation **1**; generation **2** is the separate `bun-text-v2` id, so
the format id selects the integer rather than the source remembering it.
Released early v0 text locks fail closed. Version 2 shipped in bun 1.4.0 and is
the same schema — measured on a project exercising workspaces, an alias,
`overrides`, optional/peer deps and `trustedDependencies`, the two generations
are byte-identical apart from that integer. They coexist: bun 1.4 accepts a v1
lock and leaves it at 1, while bun 1.3 refuses a v2 and rewrites it down, so a
v1 lock stays v1 and only a NEW lock is a 2. Note that the integer collides with
npm-2's; detection separates them by the TOP-LEVEL `workspaces` object, which npm
also carries but only nested inside `packages[""]`.

## deno

| Adapter id | Marker | Verified writer | Scope |
|------------|--------|-----------------|-------|
| `deno-v2` | top-level `version: "2"` | measured corpus; parse/emit proof | same-format mutation; supported targets v3/v4 |
| `deno-v3` | top-level `version: "3"` | Deno 1.44.4 | same-format mutation; supported targets v2/v4 |
| `deno-v4` | top-level `version: "4"` | Deno 2.2.8 | same-format mutation; supported targets v2/v3 |
| `deno-v5` | top-level `version: "5"` | Deno 2.9.4 | same-format mutation; supported targets v2/v3/v4 |

Each adapter accepts exactly one layout. V1 is rejected. Unchanged same-format
input replays byte-exactly; JSR, remote, redirect, workspace, and unknown
top-level state remain in the shared native sidecar. Every concrete source also
supports manifest-backed npm-subgraph projection to the 16 Node-family
formats. Node-family → Deno and v2/v3/v4 → v5 fail closed.

## Where a source locator is recorded

Schemas disagree about whether the lockfile names where a package came from. The difference decides
what a locator rewrite can reach, and what a check of a package's origin can prove — see
[`overrideSource` / `assertSource`](./API.md#overridesource).

| Schema | Locator in the lock | Digest that guards it |
|---|---|---|
| `npm-1` | `dependencies` tree `resolved`, and a URL-valued `version` | `integrity` |
| `npm-2` | BOTH `packages[*].resolved` and the legacy `dependencies` tree — a rewrite must move both, or npm 6 and npm 7+ resolve differently from one file | `integrity` |
| `npm-3`, `npm-4` | `packages[*].resolved` | `integrity` |
| `yarn-classic` | `resolved`, carrying `#<40-hex>` | that inline `#<40-hex>`, and `integrity` when present |
| `pnpm-v5`, `pnpm-v6`, `pnpm-v9` | `resolution.tarball`, written only for a non-default registry | `integrity` |
| `deno-v2`…`deno-v5` | `npm.*.tarball`, written only for a non-default registry | `integrity` |
| `yarn-berry-*` | none for a registry package (`__archiveUrl` only for an explicit archive) | `checksum` |
| `bun-text`, `bun-text-v2` | none for a registry package | SRI on explicit tarball entries |

A package whose row says "none", or whose optional locator is absent, resolves through the package
manager's configuration — `.npmrc`, `.yarnrc.yml` (`npmRegistryServer`), `bunfig.toml` — and nothing
in the lock records which registry that is. Measured with pnpm 10 against a `.npmrc` naming a
mirror: the package is fetched from the mirror and the lock records only its integrity, byte-identical
to a lock made against the public registry.

Such a package parses to `{ kind: 'registry' }` — a registry package whose host is undetermined. No
public default is substituted, so a host read back from the model is always one the lock, the caller
or the project's configuration actually named. Supply it with `parse`'s `registry` option, or with
`cwd` so the project's own configuration is read; without either, a target that cannot express an
undetermined host omits the locator, and yarn-classic — whose format requires one — refuses.

Entries with no remote source of their own — bundled inside a parent archive, a workspace link or
member directory, a `file:`, `link:` or directory resolution — have no locator by nature. On the npm
corpus they are the majority of locator-less entries: 45,422 npm-1 `bundled: true`, 3,882 npm-2+
`inBundle`, 682 workspace links and member directories, against 12,308 registry entries whose lock
simply omits `resolved`.

## Sources

Where each schema is canonically defined. Permalinks pinned at specific
release tags / commits so claims here stay anchored.

### npm

- [npm v7 series — beta release & semver-major changes](https://blog.npmjs.org/post/626173315965468672/npm-v7-series-beta-release-and-semver-major.html)
  — introduces `lockfileVersion: 2` (`packages` block, workspaces).
- [package-lock.json docs (npm v9)](https://docs.npmjs.com/cli/v9/configuring-npm/package-lock-json/)
  — schema reference for v3.
- [GitHub: dependency-graph and Dependabot support npm v9](https://github.blog/changelog/2023-03-10-dependency-graph-and-dependabot-support-npm-v9/)
  — confirms v3 drops the legacy `dependencies` mirror.
- npm 12.0.1 native-output corpus — v4 `patched`,
  `packageExtensionsHash` / `packageExtensionsApplied`, and
  `npmExtensionHash` / `npmExtensionApplied` carriers. npm has not yet
  published a standalone v4 schema document; see
  [`docs/spec/formats/npm-4.md`](../spec/formats/npm-4.md) for the pinned empirical
  contract.

### yarn

- [`Project.ts` at @yarnpkg/cli/2.4.3](https://github.com/yarnpkg/berry/blob/@yarnpkg/cli/2.4.3/packages/yarnpkg-core/sources/Project.ts)
  — `LOCKFILE_VERSION = 4`.
- [`Project.ts` at @yarnpkg/cli/3.1.0](https://github.com/yarnpkg/berry/blob/@yarnpkg/cli/3.1.0/packages/yarnpkg-core/sources/Project.ts)
  — `LOCKFILE_VERSION = 5` (one-minor window).
- [`Project.ts` at @yarnpkg/cli/3.2.0](https://github.com/yarnpkg/berry/blob/@yarnpkg/cli/3.2.0/packages/yarnpkg-core/sources/Project.ts)
  — `LOCKFILE_VERSION = 6`.
- [`Project.ts` at @yarnpkg/cli/4.0.0](https://github.com/yarnpkg/berry/blob/@yarnpkg/cli/4.0.0/packages/yarnpkg-core/sources/Project.ts)
  — bumps to 8; `YARN_LOCKFILE_VERSION_OVERRIDE` env var introduced here.
- [`Project.ts` at @yarnpkg/cli/4.14.1](https://github.com/yarnpkg/berry/blob/@yarnpkg/cli/4.14.1/packages/yarnpkg-core/sources/Project.ts)
  — v9 baseline.
- [`Project.ts` at @yarnpkg/cli/4.17.1](https://github.com/yarnpkg/berry/blob/@yarnpkg/cli/4.17.1/packages/yarnpkg-core/sources/Project.ts)
  — stable `LOCKFILE_VERSION = 10`.
- [Yarn 4.0 release blog](https://yarnpkg.com/blog/release/4.0)
  — narrative context (no explicit lockfile-bump mention).

### pnpm

- [`pnpm/spec` — lockfile/](https://github.com/pnpm/spec/tree/master/lockfile)
  — official per-version schema docs (`5.md`, `5.2.md`, `6.0.md`, `9.0.md`).
- [`pnpm/spec/lockfile/6.0.md`](https://github.com/pnpm/spec/blob/master/lockfile/6.0.md)
  — pnpm 8's schema, including the package-id grammar shift.
- [`pnpm/spec/lockfile/9.0.md`](https://github.com/pnpm/spec/blob/master/lockfile/9.0.md)
  — pnpm 9's `packages` / `snapshots` split.
- [pnpm Discussion #6857](https://github.com/orgs/pnpm/discussions/6857)
  — maintainer rationale for the `6 → 9` jump:
  *"in the future lockfile version will equal the pnpm version in
  which it got introduced."*

### bun

- [Bun docs — Lockfile](https://bun.com/docs/pm/lockfile)
  — current schema reference for `bun.lock`.
- [Bun blog — text-based lockfile](https://bun.com/blog/bun-lock-text-lockfile)
  — text format introduced in 1.1.39, default in 1.2.
- [`bun-lock` source](https://github.com/oven-sh/bun) — `src/install/lockfile.zig`
  for the binary serializer.
