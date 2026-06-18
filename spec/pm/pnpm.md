# `pnpm` — performant npm (content-addressed store + symlinked node_modules)

> Status: **preview** (docs+source-grounded) — pnpm.io docs + pnpm/pnpm source.
> Updated: 2026-06-17.
> Provenance: **Official** (pnpm.io docs are the spec of record; the running
> client is the tiebreaker).
> Family: **npm-substrate** — pnpm is a *consumer* of the Node.js resolution
> substrate ([`_common.md`](./_common.md)), not a replacement for it.

pnpm ("performant npm") is an open-source package manager by Zoltan Kochan et al.
It runs on the **stock Node.js module resolver** — the same `node_modules` walk +
`fs.realpath()` collapse every other npm-family PM relies on
([`_common.md`](./_common.md)) — but materialises a radically different on-disk
shape. Its two headline divergences, and the spine of this doc:

1. a global **content-addressable store** (CAS): every file of every version is
   stored once, keyed by content hash, and **hard-linked** (or reflink-cloned)
   into projects — so N projects sharing a dependency cost ~one copy on disk
   ([`motivation`](https://pnpm.io/motivation));
2. a **non-flat, symlinked `node_modules`**: direct deps are symlinks into a
   per-project virtual store (`node_modules/.pnpm`), where each
   `pkg@version` gets its own real dir holding symlinks to exactly its declared
   deps ([`symlinked-node-modules-structure`](https://pnpm.io/symlinked-node-modules-structure)).

The payoff is **strictness without a custom resolver**: because the layout
hands each package only its declared dependencies, undeclared/"phantom" deps are
unreachable — enforced by the *shape* of the tree plus Node's own realpath
behaviour, not by intercepting `require`. Everything pnpm does is best read as a
delta on the [Node.js substrate](./_common.md); this doc records that delta along
the six family axes (see [`_common.md`](./_common.md) for the template).

> **Version note.** pnpm moves fast and several axes shifted under v10 → v11.
> Major breaks flagged inline: settings left `package.json` for
> `pnpm-workspace.yaml` (v11); the build allow-list moved from
> `onlyBuiltDependencies`/`neverBuiltDependencies` to `allowBuilds` (v11); `pnpm
> env` deprecated for `pnpm runtime` (v11); the global virtual store became the
> default for `dlx`/global installs (v11). Defaults below are pnpm 10/11 unless
> noted.

---

## 1 · Resolution

Semver resolution is the [substrate's](./_common.md) — pnpm reads the same
`package.json` range vocabulary and resolves against the same npm-shape registry
metadata ([`spec/registry/`](../registry/)). The pnpm-specific layer:

- **Strictness is a resolution invariant, not just a layout one.** In one
  project, a given `name@version` has exactly **one** set of dependencies — the
  central guarantee pnpm advertises — *except* for packages with peer deps
  ([`how-peers-are-resolved`](https://pnpm.io/how-peers-are-resolved)). A package
  can only `require` what it declares; there is no flat floor to fall through to
  (cf. npm/yarn-classic hoisting).

- **Peer resolution forks the graph (peer-dependency suffixing).** Peers are
  resolved **bottom-up**, "from dependencies installed higher in the dependency
  graph" — so the *ancestor* that satisfies a peer determines which instance a
  package binds to. If `foo@1.0.0` has peers `bar` + `baz` and two ancestors
  supply different `baz` versions, `foo` is instantiated **twice**, each with its
  own dep set ([`how-peers-are-resolved`](https://pnpm.io/how-peers-are-resolved)).
  This is the source of the **peer-suffix node identity** that propagates into
  the lockfile and the on-disk farm (see §2, §6). Forking is **transitive**: a
  peer-free package whose own deps have ancestor-resolved peers itself splits
  into multiple instances (`a@1.0.0_c@1.0.0` vs `a@1.0.0_c@1.1.0`).

  - **`autoInstallPeers`** (default **`true`**) — missing non-optional peers are
    installed automatically; on **conflicting** peer ranges pnpm installs nothing
    and warns ([`settings#autoinstallpeers`](https://pnpm.io/settings#autoinstallpeers)).
  - **`strictPeerDependencies`** (default **`false`**) — when `true`, a
    missing/invalid peer fails the command.
  - **`dedupePeerDependents`** (default **`true`**) — collapses peer-forked
    instances that have *no conflicting* peers back onto one instance across
    workspace projects, reducing instance count
    ([`settings#dedupepeerdependents`](https://pnpm.io/settings#dedupepeerdependents)).
  - **`dedupePeers`** (default `false`, **v10.33+**) — changes the suffix
    *encoding* to version-only (`name@version`) so nested suffixes like
    `(foo@1.0.0(bar@2.0.0))` collapse; affects lockfile node ids, not just disk.
  - **`peerDependencyRules`** (`ignoreMissing`, `allowedVersions`, …) mute or
    widen peer checks.

- **`overrides`** — force any node in the graph (incl. peers) to a version, a
  fork (`npm:@org/pkg@^1`), or **removal** (`-`). Selectors target a sub-edge via
  `parent>child` (`qar@1>zoo`, `react-dom>react`). Root-only. Since **v11** it
  lives in `pnpm-workspace.yaml`, not `package.json`
  ([`settings#overrides`](https://pnpm.io/settings#overrides)).

- **`packageExtensions`** — graft missing `dependencies` / `peerDependencies` /
  `peerDependenciesMeta` onto published packages to patch broken metadata; shares
  the **`@yarnpkg/extensions`** community DB with Yarn
  ([`settings#packageextensions`](https://pnpm.io/settings#packageextensions)).
  Resolution-affecting: it changes what edges exist.

- **Catalogs** (`catalog:` protocol) — workspace-level named version constants in
  `pnpm-workspace.yaml` (`catalog:` = default catalog, `catalog:<name>` = named),
  usable in `dependencies`/`devDependencies`/`peerDependencies`/
  `optionalDependencies` and in `overrides`. Stripped (inlined to the resolved
  range) on `pnpm publish`/`pnpm pack`
  ([`catalogs`](https://pnpm.io/catalogs)). Lockfile carries a `catalogs:` block
  (pnpm 9.5+) — see [`spec/formats/pnpm-v9.md`](../formats/pnpm-v9.md).

- **Workspaces** — `pnpm-workspace.yaml` `packages:` globs define members;
  local-package edges use the **`workspace:` protocol**
  (`workspace:*`/`~`/`^`/`<version>`), replaced with a concrete range on publish
  ([`workspaces`](https://pnpm.io/workspaces)). One `importers` entry per member
  in the lockfile.

- **`resolutionMode`** (default **`highest`**; was `lowest-direct` in v8.0–v8.6)
  — `time-based` resolves direct deps to their lowest matching version and
  sub-deps to versions published before the newest direct dep (subdependency-
  hijack hardening); needs registry full-metadata `time`
  ([`settings#resolutionmode`](https://pnpm.io/settings#resolutionmode)).

- **Supply-chain gates (v10.10+/v11)** that also shape resolution: `minimumReleaseAge`
  (quarantine just-published versions), `trustPolicy`/`trustLockfile`,
  `blockExoticSubdeps`, `allowedDeprecatedVersions`. Cross-ref the
  advisory/registry axis in [`spec/registry/`](../registry/) for the network side.

---

## 2 · Linking / Layout — the symlink farm (centerpiece)

This is pnpm's defining mechanism. The default `nodeLinker: isolated` materialises
a graph in three on-disk tiers.

### 2.1 The content-addressable store (tier 0)

A single global store holds every file once, content-keyed; package files are
**hard-linked** out of it, so disk cost is ~proportional to *distinct file
content*, not to (projects × deps)
([`motivation`](https://pnpm.io/motivation)). Default `storeDir`
([`settings#storedir`](https://pnpm.io/settings#storedir)):

| OS | Default store path |
|----|--------------------|
| `$PNPM_HOME` set | `$PNPM_HOME/store` |
| `$XDG_DATA_HOME` set | `$XDG_DATA_HOME/pnpm/store` |
| Linux | `~/.local/share/pnpm/store` |
| macOS | `~/Library/pnpm/store` |
| Windows | `~/AppData/Local/pnpm/store` |

One store **per disk** (hard links can't cross filesystems); a store on another
disk degrades to **copy**. The store is a **trust domain** — shared writability is
a security boundary; `index.db` records hashes used to verify cached files
([`settings#storedir`](https://pnpm.io/settings#storedir)).

**`packageImportMethod`** (default **`auto`**) picks how store files reach a
project: `auto` (clone→hardlink→copy), `hardlink`, `clone` (CoW/reflink — safest,
edits don't bleed into the store; needs a CoW FS like Btrfs/APFS/ReFS),
`clone-or-copy`, `copy`. **Note:** this controls *store→node_modules* writes, not
symlinking — disabling symlinks is `nodeLinker`, not this
([`settings#packageimportmethod`](https://pnpm.io/settings#packageimportmethod)).
`verifyStoreIntegrity` (default `true`) re-checks a store file's content before
linking.

### 2.2 The per-project virtual store `node_modules/.pnpm` (tier 1)

Default `virtualStoreDir: node_modules/.pnpm`
([`settings#virtualstoredir`](https://pnpm.io/settings#virtualstoredir)). For each
resolved instance, pnpm creates a real directory
`node_modules/.pnpm/<pkg>@<ver>/node_modules/<pkg>/` whose **files are the
hard/clone links** from the store — *these are the only "real" files in
`node_modules`* ([`global-virtual-store`](https://pnpm.io/global-virtual-store)).
Alongside the package's own real dir, its **dependencies are symlinks** to *their*
`.pnpm` instances. Verbatim from the docs
([`symlinked-node-modules-structure`](https://pnpm.io/symlinked-node-modules-structure)),
`foo@1.0.0` → `bar@1.0.0` → `qar@2.0.0`:

```text
node_modules
├── foo -> ./.pnpm/foo@1.0.0/node_modules/foo        ← tier 2: direct dep
└── .pnpm
    ├── bar@1.0.0
    │   └── node_modules
    │       ├── bar -> <store>                         ← hard link to CAS
    │       └── qar -> ../../qar@2.0.0/node_modules/qar
    ├── foo@1.0.0
    │   └── node_modules
    │       ├── foo -> <store>
    │       ├── bar -> ../../bar@1.0.0/node_modules/bar
    │       └── qar -> ../../qar@2.0.0/node_modules/qar
    └── qar@2.0.0
        └── node_modules
            └── qar -> <store>
```

Key invariant: **constant filesystem depth** regardless of graph depth — every
instance is exactly `.pnpm/<id>/node_modules/<pkg>`, and cross-instance edges are
sibling `../../` symlinks. A package's `node_modules` contains *only its declared
deps* (plus itself), which is what produces strictness.

### 2.3 Top-level `node_modules` (tier 2)

Only the project's **direct** dependencies are symlinked into the top-level
`node_modules` (e.g. `foo -> ./.pnpm/foo@1.0.0/node_modules/foo`). Undeclared
transitive packages are **not** present at the top level — that's the
"semistrict" default ([`motivation`](https://pnpm.io/motivation),
[`settings#shamefullyhoist`](https://pnpm.io/settings#shamefullyhoist)).

### 2.4 Peer-suffixed instance directories (the `_`/`+` farm)

When peers fork an instance (§1), pnpm names the on-disk dirs with a **filesystem
peer suffix**: `_` separates the base from its peers, `+` joins multiple peers
([`how-peers-are-resolved`](https://pnpm.io/how-peers-are-resolved)):

```text
node_modules
└── .pnpm
    ├── foo@1.0.0_bar@1.0.0+baz@1.0.0
    │   └── node_modules
    │       ├── foo
    │       ├── bar -> ../../bar@1.0.0/node_modules/bar
    │       └── baz -> ../../baz@1.0.0/node_modules/baz
    ├── foo@1.0.0_bar@1.0.0+baz@1.1.0
    │   └── node_modules
    │       ├── foo
    │       ├── bar -> ../../bar@1.0.0/node_modules/bar
    │       └── baz -> ../../baz@1.1.0/node_modules/baz
    ├── bar@1.0.0
    ├── baz@1.0.0
    └── baz@1.1.0
```

> **Encoding boundary.** This `_`/`+` form is the **on-disk** suffix; the
> **lockfile** encodes the same fork with parenthesised `(peer@ver)` segments
> (pnpm 6+/9). They are two renderings of one identity (the model's
> [`NodeId`/`peerContext`](../formats/_common.md#41-nodeid)). Long peer sets are
> abbreviated to a hex digest segment; `peersSuffixMaxLength` bounds the disk
> name. See [`spec/formats/pnpm-v9.md`](../formats/pnpm-v9.md) for the lockfile
> grammar (nested suffixes, hashed peer-set tokens) — do not duplicate it here.

### 2.5 `node-linker` modes (the layout knobs)

`nodeLinker` ([`settings#nodelinker`](https://pnpm.io/settings#nodelinker)):

| Mode | Default? | Shape | Maps to project [layout strategy](../04-layouts.md) |
|------|:--------:|-------|------------------------------------------------------|
| **`isolated`** | ✓ | the symlink farm above | `isolated` |
| **`hoisted`** | | flat `node_modules`, no symlinks — npm/yarn-classic-like (uses a Yarn hoisting lib); for tooling that breaks on symlinks (React Native), serverless w/o symlink support, `bundledDependencies`, `--preserve-symlinks` | `hoisted` / `nm-linked` |
| **`pnp`** | | no `node_modules` — Yarn-Berry-style Plug'n'Play; pair with `symlink: false` | `pnp` |

Hoisting controls (apply to where deps float):

- **`hoistPattern`** (default `['*']`) — which packages hoist into the **hidden**
  `node_modules/.pnpm/node_modules` (reachable by *other deps*, the semistrict
  escape hatch); narrow it to only patch phantom-dep offenders.
- **`publicHoistPattern`** (default `[]`) — hoist matches to the **root**
  `node_modules` (reachable by *app code* — re-introduces phantom-dep risk).
- **`shamefullyHoist`** (default `false`) — sugar for `publicHoistPattern: ['*']`;
  hoists everything to the root, npm-like, for "flawed pluggable tools".
- **`hoistingLimits`** (v11.5+, `none`/`workspaces`/`dependencies`) — mirrors
  Yarn's `nmHoistingLimits` under `nodeLinker: hoisted`.

### 2.6 Global virtual store (v10.12+, default for `dlx`/global in v11)

`enableGlobalVirtualStore: true` replaces each project's `.pnpm` with symlinks into
**one shared** virtual store at `<store>/links/`, where each instance dir is named
by the **hash of its dependency graph** (NixOS-style) — so identical subgraphs are
shared across all projects and worktrees, and a fresh checkout gets a near-free
`node_modules` ([`global-virtual-store`](https://pnpm.io/global-virtual-store)).
Auto-disabled in CI (cold cache). **ESM caveat:** hoisting under this mode leans on
`NODE_PATH`, which Node ignores for ESM imports — undeclared ESM imports fail
(fix via `packageExtensions` or `@pnpm/plugin-esm-node-path`).

### 2.7 Injected workspace deps

`dependenciesMeta.<pkg>.injected: true` installs a local workspace package as a
**hard-linked copy** in the virtual store instead of a source symlink — the one
way for a workspace package's peer (e.g. `react`) to resolve **differently per
consumer** ([`package_json#dependenciesmetainjected`](https://pnpm.io/package_json#dependenciesmetainjected)).

### 2.8 Focused / partial workspace installs

Two distinct mechanisms scope work to a subset of a workspace. Both narrow *which
projects* participate; only `deploy` changes the resulting on-disk shape.

**`pnpm --filter <selector>... install`** restricts the command to the matched
workspace projects. The selector grammar (verbatim from the CLI's filtering help,
pnpm 10.0.0 — `common-cli-options-help/lib`, the `FILTERING` block; mirrors
[pnpm.io/filtering](https://pnpm.io/filtering)):

| Selector | Selects |
|----------|---------|
| `<pattern>` | projects whose **name** matches the glob (e.g. `foo`, `"@bar/*"`) |
| `<pattern>...` | the matched projects **plus all their direct and indirect dependencies** |
| `<pattern>^...` | **only** those dependencies, **excluding** the matched projects themselves |
| `...<pattern>` | the matched projects **plus all their direct and indirect dependents** |
| `...^<pattern>` | **only** those dependents, excluding the matched projects |
| `./<dir>` / `.` | projects inside a subdirectory / under the cwd |
| `{<dir>}` | projects under a directory (combinable with `...` and `[<since>]`) |
| `[<since>]` | projects **changed since** a commit/branch (e.g. `"[origin/master]"`); combinable with `...` for changed-plus-dependents |
| `!<selector>` | **excludes** the matched projects |

(`^` must be doubled in the Windows Command Prompt. `--filter-prod` is the same but
ignores `devDependencies` when walking dependents/dependencies; `--fail-if-no-match`
exits non-zero on an empty match set.) For **`install`** specifically, a filter is
a *project* selector, not a partial-graph fetch: pnpm still computes and writes the
**whole-workspace** lockfile and the shared virtual store, then materialises
`node_modules` for the **selected importers** (and the dependency projects a `...`
selector pulls in). The store is content-addressable and shared regardless, so a
filtered install does not produce a smaller or differently-keyed store — it bounds
*what gets linked into project `node_modules`*, not the CAS.

> **Open:** the exact set of `node_modules` trees written by a bare
> `--filter <name> install` (selected importer only, vs. selected importer + its
> workspace-dependency importers) is version-sensitive and is not asserted here;
> the lockfile remains workspace-wide in all observed versions.

**`pnpm --filter=<project> deploy <target-dir>`** is the closest analogue to
`yarn workspaces focus`: it produces a **self-contained, isolated deployable
directory** for **exactly one** workspace project. Source-grounded behaviour
(pnpm 10.0.0 — `releasing/plugin-commands-deploy/lib/deploy.js`; help string
`"Experimental! Deploy a package from a workspace"`; mirrors
[pnpm.io/cli/deploy](https://pnpm.io/cli/deploy)):

- **One project only.** The command requires being inside a workspace
  (error code `CANNOT_DEPLOY` otherwise), selects via `--filter`, and errors if zero
  (`NOTHING_TO_DEPLOY`) or more than one (`CANNOT_DEPLOY_MANY`) project is matched,
  or if the target argument is missing (`INVALID_DEPLOY_TARGET`).
- **The project's own files are copied** into `<target-dir>` (via the indexed
  importer in `clone-or-copy` mode — reflink/clone where the FS allows, else copy),
  defaulting to the package's published file set (`includeOnlyPackageFiles`;
  `--deploy-all-files` copies everything).
- **The dependency closure is inlined into an isolated `node_modules` *inside the
  target dir*.** `deploy` runs the normal installer with
  `virtualStoreDir = <target-dir>/node_modules/.pnpm` and
  `modulesDir = <target-dir>/node_modules`, i.e. it builds a fresh isolated
  symlink farm (§2.2) rooted in the deploy directory whose files are
  **hard/clone links from the global store** — so the result is a stand-alone
  directory that needs no access to the original workspace to run.
- Dependency-type flags: `--prod`/`-P` (omit `devDependencies`), `--dev`/`-D`
  (only `devDependencies`), `--no-optional` (omit `optionalDependencies`).
- **Version caveat (pnpm 10).** `deploy` requires `inject-workspace-packages=true`
  (else `DEPLOY_NONINJECTED_WORKSPACE`); workspace-package deps are materialised as
  hard-linked copies (§2.7) rather than source symlinks, which is what makes the
  output relocatable. With a shared workspace lockfile it derives a project-scoped
  lockfile + manifest for the deploy dir; `--legacy` (`force-legacy-deploy`) forces
  the pre-shared-lockfile implementation. `deploy` does **not** currently combine
  with `nodeLinker: hoisted` or `dedupePeerDependents`.

> **Open:** whether `inject-workspace-packages=true` remains a hard precondition
> for `deploy` is pnpm-version-specific (it is required in 10.0.0); later releases
> may relax it. Confirm against the target version before relying on it.

---

## 3 · Resolver mutation — *none* (realpath does the work)

**pnpm does not replace, patch, or shim Node's module resolver in the default
(`isolated`) and `hoisted` modes.** Concretely, pnpm ships **no injected resolver
and no serialized resolution data file** — there is no `.pnp.cjs`/`.pnp.data.json`
analogue, no `require` monkey-patch, no loader hook, and no
`NODE_OPTIONS=--require …` preamble in these modes. The on-disk *shape* of the
symlinked virtual store (`node_modules/.pnpm`, §2.2) plus stock Node's own path
resolution is the entire mechanism: each `bar` symlink in a consumer's
`node_modules` points at exactly the resolved instance
(`.pnpm/bar@<ver>/node_modules/bar`), so a stock, unflagged `node` binary —
running the same algorithm it uses for any `node_modules` tree — lands on exactly
the version pnpm resolved, with no pnpm code in the resolution path. It relies
entirely on two stock Node behaviours:

1. the ordinary `node_modules` upward walk, and
2. **`fs.realpath()` symlink collapse** — Node resolves a module to its *physical*
   path before walking parents. When `foo`'s code `require('bar')`, the `bar`
   symlink in `foo`'s `node_modules` resolves to the real
   `.pnpm/bar@1.0.0/node_modules/bar`; the parent-dir walk then proceeds from
   `bar`'s *physical* location, where it sees only **bar's** declared deps
   ([Node module resolution / `fs.realpath`](https://pnpm.io/symlinked-node-modules-structure),
   [pnpm#244](https://github.com/pnpm/pnpm/issues/244)).

So the **symlink topology + Node's default realpath** together produce strictness
with zero resolver code.

> **Contrast vs Yarn Plug'n'Play.** These are opposite strategies for the same
> goal (strict, declared-only resolution). pnpm (default/`hoisted`) uses **real
> on-disk symlinks resolved by Node's own realpath walk** — no data file, no
> injected resolver. Yarn Berry PnP instead serializes the whole resolution into a
> **lookup map** (`.pnp.cjs` / `.pnp.data.json`) and **injects a custom resolver**
> that answers `require` from that map, with **no `node_modules`** to walk
> ([`spec/pm/yarn.md` §3](./yarn.md#3-resolver-mutation--the-centerpiece)). pnpm's
> `nodeLinker: pnp` mode is the one exception — it borrows Yarn's mechanism (below).

Two consequences worth flagging:

- **`--preserve-symlinks` breaks pnpm.** That flag tells Node to walk the *logical*
  (symlink) path instead of realpath — collapsing every package back to its
  linker's vantage point and defeating isolation. pnpm explicitly chose hard links
  over store-symlinks partly to avoid requiring this flag
  ([pnpm#244](https://github.com/pnpm/pnpm/issues/244)). (This is also why
  `hoisted` mode is the recommended escape for `--preserve-symlinks` setups.)
- **`pnp` is the one mode that DOES mutate resolution.** `nodeLinker: pnp` emits a
  Plug'n'Play manifest (Yarn-Berry mechanism) and there is **no `node_modules`** —
  resolution is table-driven, not filesystem-driven. This is the only pnpm linker
  that intercepts `require` (cross-ref [`spec/pm/yarn.md` §3](./yarn.md#3-resolver-mutation--the-centerpiece) for the PnP
  substrate). Maps to the [`pnp` layout strategy](../04-layouts.md).

For this project's resolver model (full vs partial re-resolve, peer bottom-up),
see [`03-resolver.md`](../03-resolver.md): pnpm's peer strategy is the reference
the model's peer-resolution borrows.

---

## 4 · Environment & config

- **Config split (v11 break).** Auth/registry settings live in **`.npmrc`**
  (npm-style INI); **all other settings** (`nodeLinker`, `hoistPattern`,
  `overrides`, `packageExtensions`, `allowBuilds`, catalogs, …) live in
  **`pnpm-workspace.yaml`** (or global `~/.config/pnpm/config.yaml`). pnpm **no
  longer reads the `pnpm` field of `package.json`** as of v11
  ([`package_json`](https://pnpm.io/package_json),
  [`settings`](https://pnpm.io/settings)). Pre-v11 these lived under
  `package.json#pnpm` / `.npmrc`.

- **`.npmrc` (auth only, modern).** pnpm reads npm-style `.npmrc` for credentials
  and registries: `<url>:_authToken`, `tokenHelper`, `ca`/`cert`/`key`, scope→
  registry routing. Auth-file precedence: project `<root>/.npmrc` → `<pnpm
  config>/auth.ini` (where `pnpm login` writes) → `~/.npmrc`
  ([`npmrc`](https://pnpm.io/npmrc)). **Security hardening:** since v11.5.3, `${ENV}`
  expansion is **disabled** in the *project* `.npmrc` for registry/proxy URLs and
  credential keys — a committed `.npmrc` can't exfiltrate CI secrets to an
  attacker registry (GHSA-3qhv-2rgh-x77r); use `pnpm config set`, user-level
  `~/.npmrc`, or `pnpm_config_//host/:_authToken=…` env form instead.

- **`pnpm-workspace.yaml`** — `packages:` globs (workspace membership) + the
  settings surface + `catalog`/`catalogs` + `overrides` + `packageExtensions`.

- **Store / config dirs** — store per §2.1; pnpm config dir is
  `$XDG_CONFIG_HOME/pnpm` / `~/Library/Preferences/pnpm` (macOS) /
  `~/.config/pnpm` (Linux) / `~/AppData/Local/pnpm/config` (Windows)
  ([`npmrc`](https://pnpm.io/npmrc)).

- **Task running** — `pnpm run <script>`, `pnpm exec <bin>` (run a project bin),
  `pnpm dlx <pkg>` / `pnpx` (fetch-and-run, ephemeral; uses the global virtual
  store + a dlx cache in v11). `verifyDepsBeforeRun` (default `install`) can
  auto-install before `run`/`exec`. v11 stopped populating `npm_config_*` env vars
  during scripts (Yarn-like) ([`scripts`](https://pnpm.io/scripts)).

- **pnpm manages Node.js itself.** Historically `pnpm env use --global <ver>`
  downloaded/activated Node versions. **Deprecated in v11** in favour of
  **`pnpm runtime`** (e.g. `pnpm runtime set node lts -g`)
  ([`env`](https://pnpm.io/cli/env)). Newer, manifest-driven: `engines.runtime` /
  `devEngines.runtime` (v10.14+/v10.21+) let a package *declare* a required Node
  (or Deno/Bun) runtime with `onFail: download`, and pnpm fetches it and binds
  CLIs/`postinstall` scripts to it; the exact version + checksum land in the
  lockfile ([`package_json#devenginesruntime`](https://pnpm.io/package_json#devenginesruntime)).
  `nodeVersion` + `engineStrict` pin the version used for `engines` checks;
  `nodeDownloadMirrors` redirects the runtime fetch. **This is a notable pnpm
  capability:** the package manager doubles as a Node version manager.

---

## 5 · Lifecycle & the build allow-list

pnpm's headline lifecycle property is **opt-in trust for dependency build
scripts** — unlike npm, a dependency's `preinstall`/`install`/`postinstall` does
**not** run by default.

- **Build allow-list (v11 model — `allowBuilds`).** Default posture: a package not
  listed in `allowBuilds` is **unreviewed** and its build scripts are **not run**;
  `strictDepBuilds` (v10.3+, default **`true`**) makes the install **exit
  non-zero** (`ERR_PNPM_IGNORED_BUILDS`) until you adjudicate, and pnpm auto-adds
  the offenders to `pnpm-workspace.yaml` with a placeholder
  ([`settings#allowbuilds`](https://pnpm.io/settings#allowbuilds),
  [`settings#strictdepbuilds`](https://pnpm.io/settings#strictdepbuilds)):

  ```yaml
  allowBuilds:
    esbuild: true
    core-js: false
    nx@21.6.4 || 21.6.5: true   # version-matched
  ```

  Approve interactively with **`pnpm approve-builds`** or
  `pnpm add --allow-build=<pkg>`.

- **v10 → v11 break.** v11 **removed** `onlyBuiltDependencies`,
  `onlyBuiltDependenciesFile`, `neverBuiltDependencies`,
  `ignoredBuiltDependencies`, and `ignoreDepScripts`, folding all of them into the
  single `allowBuilds` map (`onlyBuilt → true`, `neverBuilt/ignored → false`).
  Codemod: `pnpx codemod run pnpm-v10-to-v11`
  ([`settings#allowbuilds`](https://pnpm.io/settings#allowbuilds)). When citing a
  pre-v11 lockfile/config, expect the old keys.

- **Escape hatches.** `dangerouslyAllowAllBuilds` (v10.9+, default `false`) runs
  *all* dep build scripts with no approval — docs flag it as a standing supply-
  chain risk. `ignoreScripts` skips scripts wholesale.

- **Pre/post scripts.** `enablePrePostScripts` default **`true`** — `pnpm foo`
  expands to `pnpm prefoo && pnpm foo && pnpm postfoo`
  ([`settings#enableprepostscripts`](https://pnpm.io/settings#enableprepostscripts)).
  (npm gates the analogous behaviour behind an opt-in; pnpm defaults it on.)

- **Root lifecycle.** `pnpm:devPreinstall` runs once on local `pnpm install`,
  before any dependency installs, only from the root manifest. Lifecycle env:
  `npm_package_name`, `npm_package_version`, `npm_lifecycle_event`
  ([`scripts`](https://pnpm.io/scripts)).

- **`side-effects-cache`** caches the *result* of a package's build so identical
  store entries skip re-building.

---

## 6 · Lockfile & registry

- **Lockfile.** `pnpm-lock.yaml` (YAML; `lockfileVersion` is a **string**).
  Schema lineage and all round-trip quirks are owned by the format specs — this
  doc references them for *interaction only*, never duplicating schema:
  - [`spec/formats/pnpm-v5.md`](../formats/pnpm-v5.md) — 5.x (`/<name>/<ver>` ids;
    `_peer-hash` suffix);
  - [`spec/formats/pnpm-v6.md`](../formats/pnpm-v6.md) — 6.x (`/<name>@<ver>`,
    `(peer)` suffix, `settings` block);
  - [`spec/formats/pnpm-v9.md`](../formats/pnpm-v9.md) — 9.0 (the v7/v8 numbers
    were skipped); `packages` (identity/integrity) vs `snapshots` (peer-bound
    edges) split; `catalogs:` block; nested + hashed peer-set tokens.

  The lockfile's parenthesised peer suffix is the **same node identity** as §2.4's
  on-disk `_`/`+` farm — both are renderings of the model
  [`NodeId`/`peerContext`](../formats/_common.md#41-nodeid), which pnpm's own
  package-id grammar defines. Sibling files: `node_modules/.modules.yaml`
  (install state), `.pnpm/` (the farm), `.pnpmfile.cjs` (resolve hooks).

- **Registry & store fetch.** pnpm speaks the **npm-shape registry contract** for
  metadata + tarballs — see [`spec/registry/`](../registry/) (default
  `registry.npmjs.org`; routing via `.npmrc`). pnpm-specific: it identifies a
  registry tarball by its **integrity** and omits the implicit default-registry
  URL from the lockfile (`lockfileIncludeTarballUrl` opts the URL back in);
  fetched tarballs are unpacked into the **CAS** (§2.1), then linked. The
  advisory/audit axis (the audit-fix driver feature) is the registry's, not
  pnpm's — [`spec/registry/_common.md §8`](../registry/_common.md#8-advisories--audit-api).

### Integrity verification

pnpm's integrity model is **content-addressing**, not a separate verification
pass bolted onto an opaque cache: the store is *keyed by* the digests, so a
correct store read is an integrity-addressed read by construction.

- **Where the expected digest lives.** Each package's tarball digest is recorded
  in `pnpm-lock.yaml` under `resolution: { integrity: sha512-… }` (an
  [SRI](https://www.w3.org/TR/SRI/) string; `pnpm store status` reads exactly
  `pkgSnapshot.resolution.integrity` — pnpm 10.0.0,
  `plugin-commands-store/lib/storeStatus/index.js`). The lockfile schema for this
  field is owned by the [format specs](../formats/pnpm-v9.md), not duplicated here.

- **The store is a content-addressable store (CAS) keyed by integrity.** Inside
  the store dir (`<store>/<STORE_VERSION>`, §2.1) every individual file is written
  at a path **derived from its own content hash** —
  `<store>/files/<hex[0:2]>/<hex[2:]>` (with an `-exec` suffix for executables),
  computed from the file's SRI by `getFilePathByModeInCafs`. Each package gets a
  per-package **index** file at `<store>/index/<hex[0:2]>/<hex[2:]>-<pkgId>.json`,
  whose path is derived from the **package tarball's integrity**; the index lists
  every member file with its own `integrity`, `size`, and `mode` (pnpm 10.0.0,
  `store/cafs/lib/getFilePathInCafs.js`, `…/checkPkgFilesIntegrity.js`). Because the
  lookup key *is* the digest, asking the store for content under a given integrity
  can only ever return bytes that hash to that integrity.

  > **Store-version note.** The version segment is `STORE_VERSION` — `v10` in
  > pnpm 10 (older pnpm lines used `v3`); the historical `~/.pnpm-store/v3` layout
  > is the same scheme under an earlier constant. The fallback off-home location is
  > `<mountpoint>/.pnpm-store/<STORE_VERSION>` when the store cannot live under the
  > home dir (pnpm 10.0.0, `store-path` resolution).

- **When verification happens, and against what bytes.**
  1. **Fetch → store write.** A fetched/unpacked tarball is added to the CAS under
     content-derived paths; the network/tarball layer rejects a tarball whose bytes
     fail their expected integrity (`ERR_PNPM_TARBALL_INTEGRITY`/`BAD_TARBALL_SIZE`),
     and retries the fetch. So writing to the store is itself gated on the bytes
     hashing to the expected digest.
  2. **Store → project link.** Before linking store content into a project, pnpm
     reads the package index and, when `verify-store-integrity` is **`true`**
     (default), runs `checkPkgFilesIntegrity`: for each index entry it reads the
     **CAS file** and checks the raw bytes with `ssri.checkData(data, entry.integrity)`
     (a fast mtime/size short-circuit via `checkedAt`/`size` precedes the full
     digest re-check). A file that is missing, size-mismatched, or fails the SRI
     check is treated as not-verified and **unlinked** from the store; a file whose
     index entry has no `integrity` raises `Integrity checksum is missing`
     (pnpm 10.0.0, `store/cafs/lib/checkPkgFilesIntegrity.js`, worker
     `readPkgFromCafs` handler). `--no-verify-store-integrity` skips this re-check
     ("doesn't check whether packages in the store were mutated").

- **On mismatch → refetch, then error.** If a package's store index/files fail to
  verify (or carry no integrity), pnpm logs `Refetching <pkg> to store. It was
  either modified or had no integrity checksums` and re-runs the fetch for that
  package's `resolution` (pnpm 10.0.0, `package-requester`); a tarball that still
  fails integrity surfaces as a hard error. Separately, if the store content found
  under a given integrity has a **name/version** that disagrees with the lockfile,
  `strictStorePkgContentCheck` (default **`true`**) throws
  `ERR_PNPM_UNEXPECTED_PKG_CONTENT_IN_STORE`.

- **Explicit store check.** `pnpm store status` walks `pnpm-lock.yaml`, locates each
  package's CAS **index by its `resolution.integrity`**, and compares the bytes
  currently linked into the project's virtual store
  (`<virtualStoreDir>/<dep>/node_modules/<name>`) against that index; it returns the
  list of modified packages and exits non-zero (`ERR_PNPM_MODIFIED_DEPENDENCY`) if
  any differ — *"Returns exit code 0 if the content of the package is the same as it
  was at the time of unpacking"* (pnpm 10.0.0,
  `plugin-commands-store/lib/store.js`, `…/storeStatus/index.js`). Sibling
  store subcommands: `add`, `prune` / `prune --force`, `path`.

> **Open:** the store's hashing algorithm is **SHA-512** for registry tarballs (the
> `sha512-` SRI prefix throughout the lockfile and CAS); whether any package source
> can land a non-`sha512` SRI in the store on current pnpm is not asserted here.

---

## Capabilities

| Capability | pnpm | Notes |
|------------|:----:|-------|
| Non-flat / strict `node_modules` (no phantom deps) | ✓ (default) | semistrict; `shamefullyHoist` opts out |
| Content-addressable store + hard/clone links | ✓ | `packageImportMethod` |
| Peer-dependency virtualisation (graph fork) | ✓ | `_`/`+` on disk, `(peer)` in lock |
| `node-linker` = isolated / hoisted / pnp | ✓ | only `pnp` mutates resolution |
| Catalogs (`catalog:`) | ✓ (9.5+) | workspace version constants |
| `overrides` / `packageExtensions` | ✓ | `pnpm-workspace.yaml` (v11) |
| `workspace:` / `file:` / `link:` / `portal:` / `git`/`patch:` protocols | ✓ | see format specs |
| Focused install by selector (`--filter <sel>...`) | ✓ | scopes which projects/`node_modules`; lockfile stays workspace-wide (§2.8) |
| Self-contained workspace deploy (`pnpm deploy`) | ✓ (exp.) | one project → isolated, store-linked dir; analogue of `yarn workspaces focus` (§2.8) |
| Integrity-keyed CAS + store verification (`store status`, `verify-store-integrity`) | ✓ | store keyed by SRI; refetch on mismatch (§6) |
| Opt-in dep build trust (`allowBuilds`) | ✓ | strict-by-default |
| Manages Node.js runtime (`pnpm runtime` / `engines.runtime`) | ✓ | doubles as a version manager |
| Global virtual store (shared, hashed) | ✓ (exp.) | default for `dlx`/global in v11 |
| Custom `require` resolver | ✗ (except `pnp`) | realpath does the work |

---

## Quirks

- **Two peer-suffix encodings** for one identity: filesystem `_`/`+` (§2.4) vs
  lockfile `(peer@ver)` (§6). Round-trip fidelity rules live in
  [`pnpm-v9.md`](../formats/pnpm-v9.md).
- **`--preserve-symlinks` is incompatible** with isolated mode — it defeats the
  realpath collapse that creates strictness (§3); use `nodeLinker: hoisted`.
- **`lockfileVersion` is a string** (`'9.0'`), and pnpm **skipped 7 & 8** (6.x →
  9.0) so the lockfile version aligns with the pnpm release that introduced it.
- **Semistrict ≠ strict:** by default, *other dependencies* (not app code) can
  still reach hoisted packages in `.pnpm/node_modules`; only `hoistPattern: []`
  is fully strict ([`settings#shamefullyhoist`](https://pnpm.io/settings#shamefullyhoist)).
- **Store is a trust boundary:** a writable shared store can poison hard-linked
  package content *and* the integrity metadata used to verify it
  ([`settings#storedir`](https://pnpm.io/settings#storedir)).
- **Project `.npmrc` env-var expansion disabled (v11.5.3+)** for URLs/credentials
  (GHSA-3qhv-2rgh-x77r) — a behavioural change that can silently drop a
  previously-working `_authToken=${NPM_TOKEN}` line.
- **`pnpm env` deprecated** → `pnpm runtime` (v11); old invocations warn.

---

## Sources

Authoritative, in descending load-bearing order:

- **pnpm.io docs** (the spec of record):
  [motivation](https://pnpm.io/motivation) ·
  [symlinked-node-modules-structure](https://pnpm.io/symlinked-node-modules-structure) ·
  [how-peers-are-resolved](https://pnpm.io/how-peers-are-resolved) ·
  [global-virtual-store](https://pnpm.io/global-virtual-store) ·
  [Settings (pnpm-workspace.yaml)](https://pnpm.io/settings) ·
  [Authentication Settings (.npmrc)](https://pnpm.io/npmrc) ·
  [catalogs](https://pnpm.io/catalogs) ·
  [workspaces](https://pnpm.io/workspaces) ·
  [package.json](https://pnpm.io/package_json) ·
  [scripts](https://pnpm.io/scripts) ·
  [cli/env](https://pnpm.io/cli/env) ·
  [filtering](https://pnpm.io/filtering) ·
  [cli/deploy](https://pnpm.io/cli/deploy) ·
  [cli/store](https://pnpm.io/cli/store)
  (fetched via the [`pnpm/pnpm.io`](https://github.com/pnpm/pnpm.io) repo,
  `docs/`, 2026-06-16; `filtering`/`cli/deploy`/`cli/store` added 2026-06-17 and
  cross-checked against the bundled client below).
- **Running client (tiebreaker, this revision):** the bundled **pnpm 10.0.0**
  distribution (`node_modules/pm-pnpm-10/dist/pnpm.cjs` + `dist/worker.js`),
  read directly for §2.8 and §6 Integrity verification. Load-bearing modules:
  `common-cli-options-help/lib` (the `FILTERING` selector help),
  `releasing/plugin-commands-deploy/lib/deploy.js` (deploy behaviour + help),
  `store/cafs/lib/getFilePathInCafs.js` and `…/checkPkgFilesIntegrity.js` (CAS
  keying + integrity check), `store/plugin-commands-store/lib/store.js` and
  `…/storeStatus/index.js` (`store status`), `store-path` (store dir resolution),
  `package-requester` (refetch-on-mismatch). Upstream permalinks:
  [`pnpm/pnpm` `store/cafs/src/`](https://github.com/pnpm/pnpm/tree/main/store/cafs/src) ·
  [`store/plugin-commands-store/src/`](https://github.com/pnpm/pnpm/tree/main/store/plugin-commands-store/src) ·
  [`releasing/plugin-commands-deploy/src/`](https://github.com/pnpm/pnpm/tree/main/releasing/plugin-commands-deploy/src).
- **pnpm/pnpm source & issues:** [pnpm#244 "Preserve symlinks"](https://github.com/pnpm/pnpm/issues/244)
  (realpath rationale); lockfile types under
  [`pnpm/pnpm` `lockfile/`](https://github.com/pnpm/pnpm/tree/main/lockfile).
- **Lockfile schema spec:** [`pnpm/spec`](https://github.com/pnpm/spec) — see the
  format specs in [`spec/formats/`](../formats/).
- **Substrate & cross-refs:** [`_common.md`](./_common.md) (Node.js resolution
  substrate), [`spec/registry/`](../registry/) (npm-shape registry contract),
  [`spec/04-layouts.md`](../04-layouts.md), [`spec/03-resolver.md`](../03-resolver.md).

## Uncertainty / flags

- `spec/pm/_common.md` (the Node.js-substrate family doc this spec deltas against)
  and `spec/pm/yarn.md` (the PnP cross-ref in §3, retargeted from the planned
  standalone `yarn-berry.md` to the single classic+berry `yarn.md` §3) are both
  present in `spec/pm/`; the cross-refs above resolve into them.
- `pnpm.io` is unreachable via direct fetch from this environment (503/blocked);
  all docs were pulled from the **`pnpm/pnpm.io` GitHub source** (`docs/*.md`,
  current `main`) — equivalent content, but anchor slugs were inferred from
  headings and not all verified against the rendered site. For this revision the
  network was fully blocked (pnpm.io, raw.githubusercontent.com, and the GitHub
  API all unreachable), so **§2.8 (focused installs) and §6 Integrity verification
  were grounded in the bundled pnpm 10.0.0 client source** (see Sources) rather
  than the docs; the `filtering`/`cli/deploy`/`cli/store` doc URLs are provided for
  the reader but were not re-fetched here.
- **§2.8 / Integrity verification are pnpm 10.0.0-specific where versioned.** The
  `deploy` `inject-workspace-packages=true` precondition, the `STORE_VERSION=v10`
  segment, the error-code names, and the exact filter/deploy flag set are read off
  the 10.0.0 bundle; selector grammar and the CAS keying scheme are stable across
  recent majors, but confirm version-tagged details (store-version segment, deploy
  preconditions) against the target client. Marked `> **Open:**` inline where
  genuinely unresolved.
- **Version drift is the main risk.** v11 is recent; several defaults/keys cited
  (config in `pnpm-workspace.yaml`, `allowBuilds`, `pnpm runtime`, global virtual
  store defaults, project-`.npmrc` env hardening) are **v11-specific** and post-
  date some installed pnpm versions. Pre-v11 projects use the older surface
  (`package.json#pnpm`, `onlyBuiltDependencies`, `pnpm env`). Treat the inline
  "Added in / removed in" flags as load-bearing.
- `resolutionMode` default flipped historically (`lowest-direct` in v8.0–8.6,
  else `highest`); confirm against the target pnpm version if it matters for a
  fixture.
