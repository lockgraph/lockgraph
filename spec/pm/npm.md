# `npm` — the npm CLI (`npm/cli`, Arborist)

> Status: **preview** (docs+source-grounded) — docs-anchored, Arborist
> source-derived core; `npm@12` trust change tracked but unreleased at time of
> writing.
> Updated: 2026-06-16.
> Provenance: **Official** — npm is the reference PM; behaviour is documented at
> [docs.npmjs.com](https://docs.npmjs.com/cli/v10/) and the running CLI +
> [`npm/cli`](https://github.com/npm/cli) source (Arborist) are the ground truth.
> Family: **npm-shape** — this **is** the family's reference point.

npm is the original Node package manager, maintained by GitHub/Microsoft. It is
the **baseline of the npm-shape PM family** in the same way public npm is the
baseline of the [registry family](../registry/npm.md): every other npm-shape PM
(yarn-classic, and — for the `package-lock` lineage — the npm-compatible install
paths of others) is described as a *delta* from npm's behaviour. The single most
load-bearing fact about npm is what it does **not** do: it performs **no resolver
mutation**. npm relies on **stock Node.js `node_modules` resolution** (documented
in [`_common.md`](./_common.md) — the Node substrate) and its entire job is to
*shape the `node_modules` tree on disk* so that stock Node resolution finds the
right thing. pnpm (symlink farm + a `.pnpm` virtual store) and yarn-berry (PnP,
a resolver replacement) diverge from this baseline by mutating or bypassing Node
resolution; npm never does. **Read [`_common.md`](./_common.md) first** — this
doc records only npm's *extension* of that substrate and does not re-derive Node
module resolution, the `node_modules` walk, or the `.bin`/PATH mechanics that the
substrate defines.

This doc follows the six-axis [Axis template](./_common.md#7-axis-template--what-every-per-pm-doc-covers) shared
by every PM in the family.

---

## Axis 1 — Resolution

**Engine: Arborist.** All of npm's dependency resolution since npm 7 lives in
[`@npmcli/arborist`](https://github.com/npm/cli/tree/latest/workspaces/arborist)
(vendored into the CLI at `workspaces/arborist`). Arborist is "npm's tree doctor":
it reasons over three trees
([Arborist deep dive](https://blog.npmjs.org/post/618653678433435649/npm-v7-series-arborist-deep-dive.html)):

| Tree | Built from | Role |
|------|------------|------|
| **actual** | a real `node_modules` on disk (read by walking it) | what *is* installed |
| **virtual** | `package-lock.json` (or `npm-shrinkwrap.json`) | what the lock *says* |
| **ideal** | the root `package.json` + the lock + registry metadata | what *should* be |

`buildIdealTree()` is the resolver entry point: it "figures out what the
`node_modules` folder should be, either by reading the lockfile, or working it
out from the `package.json`" (Arborist
[`ideal-tree.md`](https://github.com/npm/cli/blob/latest/workspaces/arborist/docs/ideal-tree.md)).
`reify()` then diffs ideal against actual and applies the minimum filesystem
changes. Install = `buildIdealTree → reify`.

### Semver satisfaction & registry input

For each dependency edge, npm fetches the **packument** (the registry document,
[`registry/_common.md §4`](../registry/_common.md#4-the-packument-full-document))
and picks the **highest version satisfying the declared range** that is also
**consistent with the rest of the tree**. The registry-fetch half of this axis
is specced in [`registry/npm.md`](../registry/npm.md) and
[`registry/_common.md`](../registry/_common.md); this doc covers only the
*placement* of the chosen versions. npm honours the same dependency classes Node
ignores: `dependencies`, `devDependencies` (root/workspace only — npm does **not**
install a transitive package's devDependencies), `optionalDependencies`,
`peerDependencies`, `bundleDependencies`.

### Placement, hoisting & dedup (the core algorithm)

Placement is delegated to the
[`PlaceDep`/`CanPlaceDep`](https://github.com/npm/arborist/commit/35c9d7cec3e091eb70b36a176d694369e7a8d2cc)
pair (unified into both `buildIdealTree` and `reify` in npm 7). The governing
rule is **hoist-to-shallowest-non-conflicting**:

- A dependency is placed at the **shallowest `node_modules` directory** on the
  consumer's ancestor chain where it does **not** conflict with a different
  version already claiming that name's slot.
- This is sound because Node resolution is **find-up**: from a consumer's
  directory, Node walks **up** the `node_modules` ancestor chain and takes the
  **first** match
  ([`_common.md` — Node resolution](./_common.md#1-module-resolution--commonjs)). A dep
  hoisted to a shallow `node_modules` is therefore reachable by every deeper
  consumer that has no closer copy.
- When two consumers need **incompatible** versions of the same name, only one
  can win the shallow slot; the loser is **nested** at
  `…/<consumer>/node_modules/<name>` (a "doppelganger"). This is why duplicates
  in a flat tree appear as **deep nesting**, not as version-suffixed directories.
- The choice among valid trees is a product of **install history** (order of
  adds, what was hoisted when each arrived, dedupe passes since) — it is **not a
  pure function of the manifest**. Two developers with the same `package.json`
  can commit byte-different but resolution-equivalent locks. *(This project's
  own L3 layout model formalises the same find-up oracle —
  `resolveDepTarget` — and the under-determination it implies; see
  [ADR-0027](../decisions/0027-npm-layout-generator.md).)*

`npm dedupe` (a.k.a. `npm ddp`) is a **separate pass** that "scans a tree for
duplicated modules and works to squash them down as much as possible while
maintaining dependency correctness" — i.e. it re-hoists already-installed
duplicates to shallower slots where a single version can now satisfy multiple
ranges. Ordinary `npm install` already de-dupes opportunistically during
`buildIdealTree`; `npm dedupe` forces a full pass.

### Peer dependencies (npm 7+ is the breaking change)

This is the single biggest resolution behaviour change in npm's history.

- **npm ≤ 6:** peer dependencies were **only warned about**, never installed.
- **npm ≥ 7:** npm **installs `peerDependencies` automatically** and enforces
  them. ([npm 7 release notes / many corroborating sources.](https://blog.openreplay.com/fix-npm-err-eresolve-dependency/))

Peers are resolved as a **set against the consuming context**: a peer is
satisfied by a copy of the peer package placed *at or above* the consumer's
location such that find-up resolves it. An edge of type `peer` whose placed
target does **not** satisfy the edge's range is a **peer conflict**. When
Arborist cannot find a single placement satisfying all overlapping peer
constraints, it raises **`ERESOLVE` — "unable to resolve dependency tree"** and
**aborts the install** (peer conflicts from a transitive dep, or under `--force`,
downgrade to a warning and continue —
[`build-ideal-tree.js`](https://github.com/npm/cli/blob/main/workspaces/arborist/lib/arborist/build-ideal-tree.js)).
Escape hatches:

| Flag | Effect |
|------|--------|
| `--legacy-peer-deps` | reverts to npm 6 semantics: **ignore** `peerDependencies` entirely (do not auto-install, do not error). Narrow — touches only peers. |
| `--force` | bypass **all** conflicts and warnings, install a (possibly broken) tree anyway. Broad. |
| `--strict-peer-deps` | promote transitive peer conflicts (normally a warning) to a hard `ERESOLVE` error. |

`peerDependenciesMeta.<name>.optional: true` marks a peer as **optional** — its
absence is not a conflict. *(Note: npm's lock writer and this project's npm core
do not always round-trip `peerDependenciesMeta` — flagged in
[ADR-0021](../decisions/0021-npm-family-completeness-contract.md) as out of the
current family-contract scope.)*

### `overrides` (manifest-driven forced replacement)

`overrides` (root `package.json`, npm 8.3+) **forces** a version/spec for a
package anywhere in the tree, overriding what semver resolution would pick. It is
**resolve-time manifest input, not lockfile output** — npm reads it from
`package.json` and applies it while building the ideal tree; it is never written
*into* `package-lock.json` as an `overrides` block (the lock records only the
resolved result). Rules, quoting
[docs v10 — package.json#overrides](https://docs.npmjs.com/cli/v10/configuring-npm/package-json):

- **Flat form:** `{ "overrides": { "foo": "1.0.0" } }` — force `foo` to `1.0.0`
  everywhere.
- **The `"."` key** means *the package itself* (vs its children):
  `{ "overrides": { "foo": { ".": "1.0.0", "bar": "1.0.0" } } }`.
- **Nested keys** scope by ancestry — `{ "overrides": { "baz": { "bar": { "foo": "1.0.0" } } } }`
  overrides `foo` only when reached through `baz > bar`. Version-pinned keys
  (`"bar@2.0.0": { … }`) scope by the parent's resolved version.
- **Direct-dependency restriction (load-bearing):** *"You may not set an override
  for a package that you directly depend on unless both the dependency and the
  override itself share the exact same spec."* The escape is the **`$<name>`
  reference**, which points an override at a direct dependency's own spec so the
  two cannot drift. *(This project models `overrides` as
  [ADR-0025 manifest overrides](../decisions/0025-manifest-overrides.md), passed
  as `StringifyOptions.overrides` per
  [ADR-0027 §5](../decisions/0027-npm-layout-generator.md) — never as a lockfile
  field.)*

npm's `overrides` is the analogue of yarn's `resolutions`; they are not
interchangeable on disk but cover the same need.

### Workspaces

`workspaces` (root `package.json`, an **array of globs** —
`["packages/*"]`) makes npm an **npm-native monorepo** manager (npm 7+).
Resolution treats each matched member as a **first-class package within one
ideal tree**:

- Members are **symlinked into the root `node_modules`** as
  `node_modules/<member-name> → <member-dir>` (so a sibling member resolves a
  workspace dependency via the symlink).
- Members' own dependencies hoist into the **single shared root `node_modules`**
  alongside the root's — one tree, one lock, one `node_modules`.
- npm has **no `workspace:` protocol** on disk (unlike yarn-berry/pnpm). A
  member-to-member dependency is declared with an ordinary semver range that the
  local member satisfies; npm links the local copy when its version matches.
  *(Confirmed against this project's fixtures in
  [ADR-0021](../decisions/0021-npm-family-completeness-contract.md): npm-2/3 locks
  carry `link: true` + `resolved: "<wsPath>"` symlink entries, never a
  `workspace:` range.)*
- `--workspace=<name>` / `--workspaces` scope a command to one or all members.

---

## Axis 2 — Linking / Layout

**Shape: a single, flat, hoisted `node_modules`.** npm's on-disk output is the
**flat `node_modules`** introduced in npm 3 — the defining layout of the family.
There is no virtual store, no symlink farm for registry deps, no PnP zip. Real
package directories sit directly under `node_modules/`:

```
node_modules/
  lodash/              ← hoisted to root (the common case)
  express/
    node_modules/
      ms/              ← nested: a conflicting version that lost the root slot
  .bin/                ← executable shims (see Axis 3)
  .package-lock.json   ← the hidden lockfile (see below)
```

- **Hoisting** flattens the tree (Axis 1's placement algorithm decides what lands
  where). The *goal* is to keep `node_modules` as shallow as possible.
- **Nesting** is the duplicate-disambiguation mechanism. A name can only appear
  once per directory, so a second incompatible version must live in a deeper
  `node_modules`. This makes npm trees **non-deterministic in shape** but
  **deterministic in resolution** (every find-up still lands on the intended
  version).
- **`bundleDependencies`** are *not* re-resolved — they ship inside the
  depender's own tarball and npm unpacks them in place (`inBundle: true` /
  `bundled: true` markers in the lock).
- **Scoped packages** nest one level: `node_modules/@scope/name/`.

### The hidden lockfile — `node_modules/.package-lock.json`

Since npm 7, npm writes a **hidden lockfile** at `node_modules/.package-lock.json`
to avoid re-walking the whole `node_modules` on every command
([docs — package-lock.json](https://docs.npmjs.com/cli/v7/configuring-npm/package-lock-json/)).
It is an exact `lockfileVersion: 3` snapshot of the *actual* tree on disk
(distinct from the committed `package-lock.json`, which a given npm may write at
v2). It is used **in lieu of reading the entire hierarchy** only if every package
folder it references exists, no unlisted folders exist, and its mtime is at least
as recent as everything it references — "if another CLI mutates the tree in any
way, this will be detected, and the hidden lockfile will be ignored." It is **not
committed** and is an optimisation, not a source of truth.

### On-disk shape vs. the committed lock

The committed `package-lock.json` records both *resolution* (versions, integrity,
URLs) and, since v2/v3, *placement* (install-path-keyed `packages` entries). The
install-path keys (`node_modules/a`, `node_modules/a/node_modules/b`) **are** the
layout — they encode exactly the nesting described above. Cross-reference the
lockfile schema docs in
[`formats/npm-1.md`](../formats/npm-1.md) / [`npm-2.md`](../formats/npm-2.md) /
[`npm-3.md`](../formats/npm-3.md); see Axis 6.

---

## Axis 3 — Resolver mutation

**None. This is the family's contrast baseline.**

npm installs **zero** runtime resolution machinery. It writes real directories
into `node_modules` and lets **stock Node.js `require`/`import` resolution**
([`_common.md` — Node module resolution](./_common.md#1-module-resolution--commonjs))
find them by the standard find-up walk. There is:

- **no `.pnp.cjs`** / PnP loader (yarn-berry),
- **no symlink-farm + `.pnpm` virtual store** indirection (pnpm),
- **no `--preserve-symlinks` requirement**, no loader hooks, no `NODE_OPTIONS`
  injection.

A program installed by npm resolves its dependencies identically whether it was
launched directly by `node`, by `npm run`, or by any other tool — because the
on-disk `node_modules` is the *only* thing doing the resolving. This is the
property that makes npm output the **lowest-common-denominator** target: any tool
that understands a flat `node_modules` can consume it.

### Binary shims — `node_modules/.bin`

The one place npm writes "linking" artefacts is **executable shims**. For every
installed package that declares a `bin` field, npm (via
[`@npmcli/bin-links`](https://github.com/npm/cli/commit/3c5a866cc6e58e660a0aedb8ce6fec258e523a21))
creates an entry in `node_modules/.bin/`:

- **POSIX:** a **symlink** to the package's bin script.
- **Windows:** generated **`.cmd` / `.ps1` shims** via
  [`cmd-shim`](https://github.com/npm/cmd-shim) (symlinks are unsuitable there).

`node_modules/.bin` (and each parent `node_modules/.bin` up the chain) is
prepended to `PATH` for `npm run` / `npm exec` scripts — the substrate-level
mechanic is in [`_common.md`](./_common.md#44-bin-shims--path--how-a-packages-executable-runs); npm is just the
writer. This is **not** resolver mutation — it affects shell `PATH` lookup of
executables, not Node's module resolver.

---

## Axis 4 — Environment

### The `.npmrc` cascade

npm configuration is layered; **all files are loaded and resolved in priority
order**, highest wins
([docs v10 — npmrc](https://docs.npmjs.com/cli/v10/configuring-npm/npmrc)):

| Priority | Source | Location |
|:--------:|--------|----------|
| 1 (highest) | command-line flags | `--key=value` / `--key` |
| 2 | environment variables | `npm_config_<key>` (lower-cased, `-`→`_`) |
| 3 | **per-project** `.npmrc` | `<project>/.npmrc` |
| 4 | **per-user** `.npmrc` | `~/.npmrc` (`$HOME`; override via `--userconfig`) |
| 5 | **global** `npmrc` | `$PREFIX/etc/npmrc` (override via `--globalconfig`) |
| 6 (lowest) | npm **builtin** | shipped inside the npm install dir |

"A setting in the userconfig file would override the setting in the globalconfig
file." Any config key can be set via the `npm_config_*` env form (e.g.
`npm_config_registry`, `npm_config_cache`).

### Registry, auth & scopes

Routing into the [registry layer](../registry/_common.md#1-addressing--name-encoding)
is configured in `.npmrc`:

- **Default registry:** `registry=https://registry.npmjs.org/`.
- **Scoped routing:** `@scope:registry=https://other.example/` sends a whole
  scope to a different host (the mechanism every private-registry setup uses).
- **Auth, per host:** `//registry.host/:_authToken=<token>` (bearer), or
  `_auth` / `username` + `_password` (Basic). Auth is keyed by **registry
  host**, so a scoped registry carries its own credentials. Full auth taxonomy:
  [`registry/_common.md §2`](../registry/_common.md#2-authentication).

### Running things — `npm run`, `npm exec`, `npx`

- **`npm run <script>`** executes a `scripts.<name>` entry from `package.json` in
  a shell with `node_modules/.bin` on `PATH` (Axis 3) and the `npm_*` env (below).
  `npm test` / `npm start` / `npm restart` / `npm stop` are built-in aliases.
- **`npm exec` / `npx`** — `npx` is an **alias for `npm exec`**
  ([docs v10 — npm-exec](https://docs.npmjs.com/cli/v10/commands/npm-exec)). It
  resolves a command by checking **local `node_modules/.bin` first**; if absent,
  it **installs the package into a folder in the npm cache** ("which is added to
  the `PATH` environment variable in the executed process") and runs it from
  there. `--package=<name>@<version>` pins what to fetch; `--yes`/`--no` controls
  the install prompt. The npx-vs-exec difference is purely argument parsing
  (`npx` wants flags before positionals; `npm exec` uses a `--` separator).

### The `npm_*` lifecycle environment

When npm runs **any** script (lifecycle or `npm run`), it injects an environment
([docs — scripts](https://docs.npmjs.com/cli/v10/using-npm/scripts);
[RFC-0021 — reduced lifecycle env](https://github.com/npm/rfcs/blob/main/implemented/0021-reduce-lifecycle-script-environment.md)):

| Variable(s) | Contents |
|-------------|----------|
| `npm_package_<field>` | the root `package.json` values (`npm_package_name`, `npm_package_version`, …). **npm 7+ flattened/reduced** the set exposed vs npm ≤ 6 (RFC-0021). |
| `npm_config_<key>` | resolved npm config (the cascade above). |
| `npm_lifecycle_event` | the stage being run (e.g. `postinstall`, or the `run` script name). |
| `npm_lifecycle_script` | the command string being executed. |
| `npm_execpath` | path to the npm CLI (`require.main`), so scripts can re-invoke npm portably. |
| `npm_node_execpath` | path to the `node` binary npm is using. |
| `PATH` | prepended with `node_modules/.bin` for this and each parent dir. |

`npm config get/set/list/edit` reads and mutates the cascade; `npm config list -l`
dumps the fully-resolved set; `npm run env` prints the script environment.

---

## Axis 5 — Lifecycle

npm runs **lifecycle scripts** declared in a package's `scripts` block at defined
points ([docs v10 — scripts](https://docs.npmjs.com/cli/v10/using-npm/scripts)).

### Install-time order

On `npm install` (no args, installing the local project), after modules are on
disk npm runs, **in order, with no internal actions between them**:

```
preinstall → install → postinstall → prepublish → preprepare → prepare → postprepare
```

For an **installed dependency**, the relevant hooks are
`preinstall` / `install` / `postinstall` (the classic "install scripts" attack
surface — they run with the **full permissions of the invoking user** the moment
`npm install` runs). `prepare` additionally runs:

- after `npm install` is run in the **local** package directory (so a freshly
  cloned repo's `prepare` builds it), and
- **for a git dependency** — "*its `dependencies` and `devDependencies` will be
  installed, and the prepare script will be run, before the package is packaged
  and installed.*" This is how `git+https://…` deps get built on install.

`prepublishOnly` runs **only** on `npm publish` (not on install/pack);
`prepack`/`postpack` wrap `npm pack` and the pack step of `publish`. The legacy
`prepublish` (runs on both publish *and* plain install) is deprecated in favour
of `prepublishOnly` + `prepare`. **As of npm 7, lifecycle scripts run in the
background** — use `--foreground-scripts` to see their output.

`npm rebuild` re-runs `preinstall`/`install`/`postinstall` (and `prepare` for
symlinked dirs) **without** re-resolving — used after a Node ABI change to
rebuild native addons.

### `--ignore-scripts`

`--ignore-scripts` (or `ignore-scripts=true` in `.npmrc`) **disables all
lifecycle scripts** for the command — both the project's and every dependency's.
It is the blunt, all-or-nothing mitigation.

### Trust model — weak by default, opt-in arriving

Historically npm's trust model is **implicit**: *any* dependency at *any* depth
can execute arbitrary code via `preinstall`/`install`/`postinstall` on `npm
install`, with no allowlist and no prompt. GitHub has called this "the single
largest code-execution surface" in the ecosystem, and it has been the vector for
the major 2025 supply-chain campaigns (Shai-Hulud, Nx s1ngularity), which used
`postinstall` hooks to exfiltrate credentials
([Snyk](https://snyk.io/articles/npm-security-best-practices-shai-hulud-attack/)).

> **Version-specific — `npm@12` (planned ~July 2026): scripts blocked by
> default.** npm v12 is announced to ship `allowScripts: off` as the **default**,
> so `npm install` will **no longer** auto-run dependency `preinstall`/`install`/
> `postinstall`. Scripts run only for packages on an **explicit allowlist**, built
> with `npm approve-scripts` and trimmed with `npm deny-scripts`, committed to the
> repo — moving npm from *implicit* to *explicit* trust, matching pnpm v10
> (Jan 2025) and yarn-berry/bun
> ([Aikido](https://www.aikido.dev/blog/npm-v12-block-postinstall),
> [Snyk](https://snyk.io/articles/npm-security-best-practices-shai-hulud-attack/)).
> **Uncertainty flag:** at the time this doc was written (mid-2026) npm v12 had
> **not shipped**; exact command names (`approve-scripts`/`deny-scripts`),
> config key (`allowScripts`), and the migration deadline are from
> pre-release announcements and may shift. The **current** stable default is
> still implicit script execution. Pre-12 mitigation: set `ignore-scripts=true`
> globally and grant per-install with `--ignore-scripts=false` for trusted
> packages.

---

## Axis 6 — Lockfile + registry

### Lockfile: `package-lock.json` (cross-ref the format specs)

npm writes **`package-lock.json`** (or, if the author wants to ship it inside the
published tarball, **`npm-shrinkwrap.json`** — same schema, different name). The
**three lockfileVersions** are three layouts over one field universe; they are
fully specced in [`formats/npm-1.md`](../formats/npm-1.md),
[`npm-2.md`](../formats/npm-2.md), [`npm-3.md`](../formats/npm-3.md) and modelled
by [ADR-0021](../decisions/0021-npm-family-completeness-contract.md) — **not
re-documented here**. The npm-CLI↔version interaction only:

| `lockfileVersion` | Written by | Shape | Read by |
|:-----------------:|------------|-------|---------|
| **1** | npm **5–6** | nested `dependencies` tree only | npm 5+ |
| **2** | npm **7–8** | **dual**: `packages` (flat, install-path-keyed, authoritative) **+** `dependencies` (legacy mirror for npm 6 readers) | npm 7+ |
| **3** | npm **9+** (default) | `packages` only — **drops** the legacy mirror | npm **7+** (npm 5/6 **cannot** read v3) |

([docs — package-lock.json](https://docs.npmjs.com/cli/v11/configuring-npm/package-lock-json/);
`defaultLockfileVersion = 3` in
[`shrinkwrap.js`](https://github.com/npm/cli/blob/v9.9.4/workspaces/arborist/lib/shrinkwrap.js#L13).)
`--lockfile-version=N` forces a specific output version on a writer that supports
it. `npm install` updates the lock to reflect the resolved tree; **`npm ci`**
installs *strictly* from an existing lock (errors if `package.json` and the lock
disagree, deletes `node_modules` first, never writes the lock) — the
reproducible-build path.

Key interactions worth stating once:

- The lock's `packages` keys **are the layout** (Axis 2) — install paths, not
  package names; `""` is the root manifest mirror.
- `resolved` is the registry tarball URL (Axis-6 registry half), `integrity` an
  SRI hash ([`formats/_common.md` integrity model](../formats/_common.md#3-integrity-model)).
- npm's lock **never** records peer-virtualised identities, `patch:` protocols,
  or `workspace:` ranges — those are yarn/pnpm refinements npm has not adopted
  (the basis of the npm-family completeness contract,
  [ADR-0021](../decisions/0021-npm-family-completeness-contract.md)).

### Registry fetch

The supply side — packument fetch, abbreviated (`corgi`) metadata, tarball
download, integrity verification, and the **audit** endpoints that audit-fix
drives — is fully specced in [`registry/npm.md`](../registry/npm.md) (public npm)
and [`registry/_common.md`](../registry/_common.md) (the shared HTTP contract).
npm is the **reference client** for that contract: it issues the canonical
`Accept: application/vnd.npm.install-v1+json` corgi request, performs
`POST /-/npm/v1/security/advisories/bulk` for `npm audit`, and verifies
`dist.integrity` + `dist.signatures` against `/-/npm/v1/keys`. **Not
re-documented here** — see the registry specs.

---

## Quirks (npm-specific, not obvious from "it makes a `node_modules`")

- **Tree shape is install-history-dependent.** Same `package.json`, different
  byte-level `package-lock.json` / `node_modules` nesting, depending on add
  order and dedupe history. Resolution is identical; shape is not. `npm ci` +
  a committed lock is the only way to pin shape.
- **Phantom dependencies.** Because hoisting floats transitive deps to the root
  `node_modules`, code can `require` a package it never declared and it
  *resolves* — until a dedupe/version change moves it. npm does nothing to
  prevent this (pnpm's strict store does).
- **npm 7 peer auto-install is a hard break.** Projects that installed cleanly
  on npm 6 can fail with `ERESOLVE` on npm 7+. `--legacy-peer-deps` is the
  compatibility shim, not a fix.
- **`overrides` is input-only.** It never appears in the lockfile; the lock shows
  only the overridden *result*. Diffing a lock won't reveal that an override is
  in play.
- **Hidden vs committed lock version mismatch.** `node_modules/.package-lock.json`
  is always v3 even when the committed `package-lock.json` is v2 — they are
  different files with different roles.
- **`optionalDependencies` swallow failures.** A failed-to-install optional dep
  (e.g. platform mismatch, build failure) is **not** an install error — npm
  records the absence and moves on (`optional: true` markers).
- **Background scripts since npm 7.** Lifecycle script output is hidden unless
  `--foreground-scripts` is passed — surprising when a `postinstall` fails
  quietly.

## Sources

Authoritative, cited inline above; consolidated:

- npm docs v10/v11 — [scripts](https://docs.npmjs.com/cli/v10/using-npm/scripts),
  [npmrc](https://docs.npmjs.com/cli/v10/configuring-npm/npmrc),
  [package.json (`overrides`/`workspaces`/peers)](https://docs.npmjs.com/cli/v10/configuring-npm/package-json),
  [npm-exec](https://docs.npmjs.com/cli/v10/commands/npm-exec),
  [package-lock.json](https://docs.npmjs.com/cli/v11/configuring-npm/package-lock-json/),
  [hidden lockfile (v7)](https://docs.npmjs.com/cli/v7/configuring-npm/package-lock-json/).
- npm/CLI + Arborist source —
  [`workspaces/arborist`](https://github.com/npm/cli/tree/latest/workspaces/arborist),
  [`ideal-tree.md`](https://github.com/npm/cli/blob/latest/workspaces/arborist/docs/ideal-tree.md),
  [`build-ideal-tree.js`](https://github.com/npm/cli/blob/main/workspaces/arborist/lib/arborist/build-ideal-tree.js),
  [`shrinkwrap.js#L13`](https://github.com/npm/cli/blob/v9.9.4/workspaces/arborist/lib/shrinkwrap.js#L13),
  [`PlaceDep`/`CanPlaceDep` unification](https://github.com/npm/arborist/commit/35c9d7cec3e091eb70b36a176d694369e7a8d2cc),
  [`bin-links`](https://github.com/npm/cli/commit/3c5a866cc6e58e660a0aedb8ce6fec258e523a21),
  [`cmd-shim`](https://github.com/npm/cmd-shim),
  [Arborist deep-dive (npm v7 blog)](https://blog.npmjs.org/post/618653678433435649/npm-v7-series-arborist-deep-dive.html).
- RFCs — [RFC-0021 reduced lifecycle env](https://github.com/npm/rfcs/blob/main/implemented/0021-reduce-lifecycle-script-environment.md).
- `npm@12` script-trust change (unreleased) —
  [Aikido](https://www.aikido.dev/blog/npm-v12-block-postinstall),
  [Snyk](https://snyk.io/articles/npm-security-best-practices-shai-hulud-attack/)
  *(pre-release; flagged in Axis 5)*.
- This project's internal model (cross-references, not external authority):
  [ADR-0021](../decisions/0021-npm-family-completeness-contract.md),
  [ADR-0025](../decisions/0025-manifest-overrides.md),
  [ADR-0027](../decisions/0027-npm-layout-generator.md);
  [`registry/npm.md`](../registry/npm.md), [`registry/_common.md`](../registry/_common.md);
  [`formats/npm-{1,2,3}.md`](../formats/npm-3.md).

## Open questions

- **`_common.md` substrate doc.** This spec references
  [`./_common.md`](./_common.md) for the Node.js resolution substrate and the
  shared Axis template. That doc is a sibling deliverable of the `spec/pm/`
  family and is present; the anchors used here
  (`#1-module-resolution--commonjs`,
  `#44-bin-shims--path--how-a-packages-executable-runs`,
  `#7-axis-template--what-every-per-pm-doc-covers`) resolve into it.
- **`npm@12` specifics.** Confirm final command/config names and the default
  flip once v12 GAs (Axis 5 uncertainty flag).
- **`peerDependenciesMeta` round-trip.** npm records optional-peer metadata that
  the current npm-family contract does not fully model
  ([ADR-0021](../decisions/0021-npm-family-completeness-contract.md) scope note) —
  revisit if a fixture forces it.
