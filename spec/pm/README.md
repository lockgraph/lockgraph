# `spec/pm/` — package-manager behavior specs

> Status: **preview** (reference family; deno frontier) — grounded in official docs, not all live-probed — see [§ Grounding](#grounding--status).
> Updated: 2026-06-17.
> Provenance: **External** — these document how the *real* package managers behave; this library reads/writes their artefacts.
> Family: foundational reference — git-tracked and published alongside [`spec/formats/`](../formats/) and [`spec/registry/`](../registry/).

A package manager is **not only an installer.** It (1) resolves and fetches
dependencies, (2) **lays them out on disk**, (3) often **mutates the module
resolver** itself, (4) manages a **config/runtime environment**, and (5)
governs a **lifecycle / trust** policy. This family documents all five, per PM.

## The thesis — Node substrate vs PM extension

There is the fixed Node.js runtime and resolution substrate, and there is each
package manager's extension or mutation of it.

There is a fixed **substrate** — Node.js module resolution + runtime mechanics
(the `node_modules` walk, `exports`/`imports`/conditions, the CJS/ESM rules, the
hook points by which the resolver can be intercepted or replaced). Every PM
builds on it, and each one **extends or replaces** some part of it. The
substrate is documented ONCE in **[`_common.md`](./_common.md)**; each per-PM
doc says, per topic, *"Node does X; this PM changes/replaces it with Y."*

Read `_common.md` first; it also defines the **axis template** every per-PM doc
follows.

## The six axes (every per-PM doc covers these)

1. **Resolution** — version selection (semver, dedup, peers, overrides, workspaces/catalogs).
2. **Linking / layout** — how dependencies are materialised on disk.
3. **Resolver mutation** — does it use STOCK Node resolution, or inject/replace the resolver? *(the reason this family exists)*
4. **Environment** — config files + precedence, env vars, registry/auth, the run/exec context, bin/PATH.
5. **Lifecycle** — install scripts + the build-trust model.
6. **Lockfile + registry** — what it persists (→ [`spec/formats/`](../formats/)) + how it fetches (→ [`spec/registry/`](../registry/)).

## The family

| doc | PM | linker / on-disk layout | **resolver mutation** | lockfile (→ formats) | runtime |
|---|---|---|---|---|---|
| [`npm.md`](./npm.md) | npm | flat-hoisted `node_modules` | **none** — stock Node | `package-lock.json` v1/2/3 | `node` |
| [`yarn.md`](./yarn.md) | yarn **classic** | flat-hoisted `node_modules` | **none** — stock Node | `yarn.lock` v1 | `node` |
| [`yarn.md`](./yarn.md) | yarn **berry** | **PnP** (default, no `node_modules`) / `node-modules` / `pnpm` linkers | **REPLACED** — `.pnp.cjs` is the resolver | `yarn.lock` v2+ | `yarn node` / `node -r .pnp.cjs` |
| [`pnpm.md`](./pnpm.md) | pnpm | **symlink farm** — content-addressed store + `.pnpm/` symlinks | **none** — stock Node + `realpath` ⇒ strictness | `pnpm-lock.yaml` v5/6/9 | `node` |
| [`bun.md`](./bun.md) | bun | flat-hoisted (or **isolated** ≥1.3) | installer: none · **runtime: bun's OWN resolver** | `bun.lockb` → `bun.lock` | `bun` (own) / `node` |
| [`deno.md`](./deno.md) | deno *(frontier)* | **none by default** — URL / `jsr:` / `npm:` cache; `node_modules` opt-in | **REPLACED** — URL + import-map + specifier resolver | `deno.lock` | `deno` (own) |

## The resolver-mutation spectrum (the headline)

- **Stock Node resolution, reshaped layout** — npm, yarn-classic (flat hoist), **pnpm** (a symlink farm that Node's own `realpath` walks → each package sees only its declared deps, *no custom resolver*).
- **Resolver replaced** — **yarn-berry PnP** (`.pnp.cjs` answers every `require`/`import` from the zip cache; no `node_modules` walk), **bun** (its own runtime resolver when you `bun <file>`), **deno** (URL/import-map/specifier resolution instead of the `node_modules` walk).

That split — who keeps Node's resolver vs who supplants it — is what `spec/pm/`
exists to make precise, because it dictates what a faithful FS-projection (L3)
and a cross-PM convert must reproduce.

## Monorepo focused-install modes

How each PM narrows an install to part of a workspace. Details + citations in each per-PM doc.

| PM | workspace filter | focused single-member install | self-contained deploy / copy-out |
|----|------------------|-------------------------------|----------------------------------|
| npm | `-w` / `--workspace`, `--workspaces`, `--include-workspace-root` | — (no first-class focus) | — |
| yarn classic | — | — | — |
| yarn berry | — | **`yarn workspaces focus [--production] [--all]`** (deps closure of selected workspaces only) | — |
| pnpm | **`--filter <selector>...`** (dependents / dependencies / path / since selectors) | via `--filter … install` | **`pnpm deploy`** (isolated, dependency-closure-inlined dir) |
| bun | **`--filter <pattern>`** | — (open) | — |
| deno *(frontier)* | `--filter` / `--recursive` (command dispatch) | `deno install --entrypoint <file>` (import-graph reachability) | — |

## Integrity verification

How each PM checks that fetched bytes match the lock. Details + citations in each per-PM doc; the shared SRI substrate is [`spec/formats/_common.md` §3](../formats/_common.md#3-integrity-model).

| PM | algorithm | digest stored in | verified when | against what | on mismatch |
|----|-----------|------------------|---------------|--------------|-------------|
| npm | SRI `sha512` (+ legacy `sha1`) | `package-lock.json` `integrity` | fetch → cache (`ssri` + `cacache`) | fetched tarball bytes | `EINTEGRITY` (hard fail) |
| yarn classic | SRI `sha512` (+ legacy `sha1` in `resolved#`) | `integrity` | on tarball extract | fetched tarball | error |
| yarn berry | `sha512`, cacheKey-prefixed | `checksum` (`<cacheKey>/<hex>`) | on cache-zip access (incl. zero-install) | `.yarn/cache/*.zip` | `YN0018`; tunable via `checksumBehavior` |
| pnpm | SRI `sha512` | `pnpm-lock.yaml` `resolution.integrity` | fetch → store, store → link (`verify-store-integrity`) | content-addressed store objects | unlink + refetch, then error |
| bun | SRI `sha512` | `bun.lock` / `bun.lockb` | pre-extraction (`skip_verify` gate) | fetched / cached tarball | `IntegrityCheckFailed` |
| deno *(frontier)* | `sha256` (remote / `jsr:`), SRI `sha512` (`npm:`) | `deno.lock` | on fetch / cache-read; `--frozen` / `deno ci` | fetched source / tarball | lockfile verification error |

## Cross-references

- **Lockfile encodings** live in [`spec/formats/`](../formats/) — these docs cite them for *what* is persisted, they don't re-document the byte grammar.
- **Registry wire contracts** live in [`spec/registry/`](../registry/) — cited for *how* artefacts are fetched.
- The end-to-end chain (runtime ↔ PM ↔ lockfile ↔ FS-projection ↔ registries) is the subject of the planned relationships doc.

## Grounding & status

These are **foundational reference** docs, git-tracked and published alongside
[`spec/formats/`](../formats/) and [`spec/registry/`](../registry/) (the rest of the
`spec/` tree stays contributor-private). They were composed from
**authoritative sources** — official docs (`nodejs.org/api`, `docs.npmjs.com`,
`yarnpkg.com`, `pnpm.io`, `bun.com`, `docs.deno.com`), PM source/issues, and
this repo's own format/registry specs — with inline citations.

Caveats, by design:
- **Grounding varies.** npm / bun / `_common` / yarn / pnpm were largely
  fetched from primary docs/source; **deno is the lightest** (search-grade, no
  live byte-probe) and is marked **frontier** throughout.
- **Forward-looking / version-specific claims are hedged**, not asserted —
  notably npm's announced default script-blocking, pnpm v11 defaults, bun ≥1.3
  isolated-linker defaults, and deno lockfile internals. Verify against a pinned
  PM version before relying.
