# `bun` — the installer **and** the runtime

> Status: **preview** (docs+source-grounded) — bun.com/docs + oven-sh/bun source
> & blog; selected behaviours version-pinned below.
> Updated: 2026-06-16.
> Provenance: **Official** (bun.com/docs + oven-sh/bun source & blog).
> Substrate: **Node.js** — see [`_common.md`](./_common.md). This doc records only
> bun's **extension** of (and divergence from) that substrate.

Bun is unusual in this family: it is **both** a package manager *and* a JavaScript
runtime with its **own module resolver**. The two faces are independent surfaces
that happen to ship in one binary:

- **As an installer** (`bun install`) it materialises a real, npm-compatible
  `node_modules` on disk — so anything that reads that tree (including stock
  `node`) works. This face is npm-shaped and inherits the
  [Node.js substrate](./_common.md): `package.json`, semver, `node_modules`
  resolution.
- **As a runtime** (`bun <file>` / `bun run`) it **replaces** Node's module
  resolution at execution time with its own implementation — resolving and
  transpiling TS/JSX directly, honouring `tsconfig` `paths`, and adding a
  `"bun"` export condition. The on-disk `node_modules` is the *input*; the
  runtime resolver is a *different* code path from `node`'s.

A converter cares about the installer face (it shapes the graph + writes the
lockfile). The runtime face is documented here because it changes which files a
given `node_modules` resolves to — material when reasoning about whether a layout
is "equivalent" across PMs ([§3](#3-resolver-mutation)).

> **Fast-moving target.** Bun ships breaking installer behaviour on minor
> versions. Every version-gated claim below carries the introducing version
> inline. The single largest moving piece is the **lockfile**:
> `bun.lockb` (binary, original) → `bun.lock` (text), introduced in **1.1.39**
> behind `--save-text-lockfile` and made the **default in 1.2**
> ([§6](#6-lockfile--registry)). The second is the **linker**: hoisted-only →
> `--linker=isolated` (pnpm-style) shipped in **1.2.19**, made the **default for
> workspaces in 1.3** ([§2](#2-linking--layout)).

---

## 1. Resolution

`bun install` resolves a `package.json` constraint set into a fully-pinned graph,
recorded in the lockfile. It reuses the [Node.js substrate's](./_common.md)
notion of dependency kinds (`dependencies` / `devDependencies` /
`optionalDependencies` / `peerDependencies`) and **npm semver** ranges; the
deltas are below.

### Semver & version selection

- Standard npm semver ranges. When a `bun.lock` is present and `package.json` is
  unchanged, bun treats the lockfile as authoritative and "downloads missing
  dependencies lazily" rather than re-resolving.
  [bun.com/docs/cli/install]
- **Minimum-release-age gate** (`minimumReleaseAge`, default `null`): when set,
  bun refuses to select a version younger than *N* seconds and falls back to a
  more mature one; "a stability check detects rapid bugfix patterns" and can
  prefer an older release. `minimumReleaseAgeExcludes` exempts named packages.
  This is a *supply-chain* control that perturbs which version is pinned —
  relevant to reproducibility. [bun.com/docs/cli/install,
  bun.com/docs/runtime/bunfig]

### Dedup & graph shape

- Dedup/hoisting is a **layout** concern, not a resolution one — see
  [§2](#2-linking--layout). The resolved graph is the same set of
  `name@version` instances regardless of `--linker`; only the physical
  placement changes.

### Workspaces

- `"workspaces"` in the root `package.json` (array of globs) declares members,
  same shape as npm/yarn. [bun.com/docs/pm/workspaces]
- **`workspace:` protocol** (`workspace:*`, `workspace:^`, `workspace:~`,
  `workspace:<range>`) is first-class for cross-member deps — it pins to the
  local member and is rewritten to a concrete range on publish, as in
  yarn/pnpm.
- `--filter <pattern>` scopes an install/run to a workspace subset (glob or
  path, negatable: `--filter '!pkg-c'`). [bun.com/docs/cli/install]
- `linkWorkspacePackages` (bunfig `[install]`, default `true`) controls whether
  matching local members satisfy a dependency instead of the registry.

### Catalogs

- **Catalogs** centralise a dependency version across workspace members: define
  it once in the **root** `package.json` and reference it from members via the
  **`catalog:`** protocol. A single default catalog plus **named** catalogs are
  supported — referenced as `"catalog:"` and `"catalog:<name>"` respectively
  (e.g. `"catalog:v1"`). Updating the catalog updates every referrer.
  [bun.com/docs/pm/workspaces; announced
  twitter.com/bunjavascript/status/1925074467518353452 — ships in the Bun
  release following that announcement (≈ 1.2.x mid-2025)]
  > **Open:** pin the exact introducing minor for `catalog:` / `catalogs`, and
  > confirm how a catalog reference is rendered **inside** `bun.lock` (resolved
  > to the concrete version, or carried as a `catalog:` marker). Known rough
  > edges as of 2025: `bun update` did not handle catalogs/monorepos
  > (oven-sh/bun#21236), and same-dep-different-catalog installs had bugs
  > (oven-sh/bun#21238) — flag as fidelity risks, not settled behaviour.

### Overrides & resolutions — **bun reads both**

- Bun honours **both** npm's `"overrides"` **and** yarn's `"resolutions"` in
  `package.json` for forcing a transitive dependency's version.
  [bun.com/docs/cli/install] This is the channel an **audit-fix** uses to pin a
  vulnerable transitive onto a safe version.
- In `bun.lock` the forced versions surface as a top-level **`overrides`** block
  (npm-shaped) regardless of which input field declared them — see
  [`bun-text.md`](../formats/bun-text.md) for the on-disk encoding and the
  verbatim round-trip / `overridesOf` projection.

### Peer dependencies

- "Peer dependencies are handled similarly to yarn. `bun install` will
  automatically install peer dependencies." Optional peers are satisfied by an
  existing dependency when one is present, else skipped.
  [bun.com/docs/cli/install]
- **No on-disk peer virtualization.** Unlike pnpm/yarn-berry, bun does **not**
  materialise peer-context nodes; peers are recorded **declaratively** in each
  package's inner block in `bun.lock`. The converter therefore parses no
  peer-virt nodes from a bun source and flattens inbound `peerContext` on emit
  (`BUN_TEXT_PEER_VIRT_FLATTENED`) — see
  [`bun-text.md`](../formats/bun-text.md).

### `trustedDependencies` (resolution-adjacent)

`trustedDependencies` is a `package.json` array that gates **lifecycle-script
execution**, not version selection — covered under [§5](#5-lifecycle). It is
load-bearing for reproducibility (it changes what ends up on disk after
postinstall) and round-trips verbatim in `bun.lock`.

---

## 2. Linking / layout

Bun installs a **real `node_modules`** by default — this is the defining
difference from yarn-berry PnP. Two linker strategies exist; the resolved graph
([§1](#1-resolution)) is identical between them, only placement differs.

### Linker strategies (`--linker`, bunfig `[install] linker`)

| Strategy | On-disk shape | Default | Since |
|----------|---------------|---------|-------|
| `hoisted` | flat, npm/yarn-classic-style shared `node_modules` (dedup by hoisting) | single-package projects | original |
| `isolated` | pnpm-style: central store at **`node_modules/.bun/`**, top-level `node_modules` holds **symlinks** into the store; a dep only sees what its own `package.json` declares | **workspaces** (since **1.3**); opt-in via `--linker=isolated` since **1.2.19** | 1.2.19 |

[bun.com/docs/install/isolated, bun.com/blog/bun-v1.2.19,
bun.com/blog/bun-v1.3.1] The isolated linker closes bun's "ghost dependency" gap
and is the structural analog of pnpm's `node_modules/.pnpm` store. A later
**global virtual store** (shared across projects) was added for the isolated
linker (1.3.1, oven-sh/bun#29489; bunfig `globalStore`).

- `node-linker` (`.npmrc`) / `install-strategy` are accepted as `.npmrc`
  spellings of the same choice. [bun.com/docs/pm/npmrc]
- Hoisting tunables for the isolated store: `hoistPattern` (virtual-store
  hoisting) and `publicHoistPattern` (hoist to the **root** `node_modules`),
  pnpm-compatible globs.

### Global cache

- Packages are cached **once per machine** at
  **`~/.bun/install/cache/${name}@${version}`** (pre/build tags hashed to dodge
  long-path limits). npm registry metadata is cached as a binary
  `~/.bun/install/cache/*.npm` (filenames keyed by a package-name hash).
  [bun.com/docs/cli/install] Configurable via bunfig `[install.cache] dir`;
  `disable` turns the cache off; `disableManifest` forces re-resolution of the
  latest versions.

### `--backend` (how files land from cache into `node_modules`)

Orthogonal to `--linker` — this is the **copy mechanism**, chosen for speed by
OS:

| `--backend` | Mechanism | Default on |
|-------------|-----------|------------|
| `hardlink` | hard links from cache | **Linux** |
| `clonefile` | CoW `clonefile()` | **macOS** |
| `clonefile_each_dir` | per-directory clone (slower) | — |
| `copyfile` | `fcopyfile()` (macOS) / `copy_file_range()` (Linux) fallback | — |
| `symlink` | symlinks into cache; requires `--preserve-symlinks` | — |

[bun.com/docs/cli/install] None of these change graph identity — they are
performance/COW knobs and carry no fact the converter records.

---

## 3. Resolver mutation

> This is the face that makes bun more than "a faster npm." When you execute with
> **`bun`**, module resolution is bun's own implementation, **not** Node's — even
> though it starts from the same `node_modules`.

### What bun's runtime resolver does

- **Algorithm:** bun implements "the Node.js module resolution algorithm" — bare
  specifiers walk up `node_modules`. [bun.com/docs/runtime/modules] So a
  `node_modules` produced by *any* PM resolves under bun. But the resolver is
  bun's code, with extensions Node lacks:
- **TS/JSX execute directly.** `bun ./app.ts` resolves *and transpiles*
  TypeScript/JSX transparently at load — no build step, no loader hook. Stock
  `node` cannot (pre-`--experimental-strip-types`) execute `.ts` at all.
- **Extensionless resolution order** (an import of `./hello` is probed as):
  `.tsx`, `.jsx`, `.ts`, `.mjs`, `.js`, `.cjs`, `.json`, then the `/index.*`
  directory variants in the same order. "If an extension is present, Bun will
  only check for a file with that exact extension." When importing a `.js{x}`
  specifier bun *also* probes the sibling `.ts{x}` (TS-ESM rewrite
  compatibility). [bun.com/docs/runtime/modules]
- **`tsconfig.json` `compilerOptions.paths`** are honoured for import remapping
  at runtime (also `jsconfig.json`; and `package.json` `#`-subpath imports).
  Stock `node` ignores `tsconfig` entirely.
- **`exports` condition order** bun applies, first-match-wins:
  **`"bun"` → `"node"` → `"require"` → `"import"` → `"default"`**. Falls back to
  `"module"` then `"main"` when there is no `exports`.
  [bun.com/docs/runtime/modules]
- **The `"bun"` export condition** lets a library ship **un-transpiled
  TypeScript** to npm and have bun pick it up — a bun-only resolution input that
  stock `node` and other PMs never select.
- **CJS ⇄ ESM interop is permissive:** `require()` and `import` may co-occur in
  one file; `require()` of an ES module yields its namespace object; importing
  CJS exposes `module.exports` as default + keys as named. Top-level `await` is
  the one thing that blocks `require()` (synchronicity). [bun.com/docs/runtime/modules]

### Contrast: `bun <file>` / `bun run` vs stock `node`

| Aspect | `bun <file>` | `node <file>` |
|--------|--------------|---------------|
| `.ts` / `.tsx` | runs (transpiles) | needs build / `--experimental-strip-types` |
| `tsconfig paths` | honoured | ignored |
| extra export condition | adds `"bun"` (first) | none |
| extensionless probe set | TS-aware (`.tsx/.ts/...`) | `.js/.json/.node` only |
| shebang `#!/usr/bin/env node` | spawns a real `node` (bun respects shebangs) | n/a |

[bun.com/docs/runtime/modules, bun.com/docs/pm/bunx] The shebang behaviour
matters for `bunx`: an executable marked `#!/usr/bin/env node` is run under
`node`, not bun, unless the script forces bun.

- **`bun run <script>`** runs a `package.json` script; **`bun <file>`** executes
  a file directly. `[run] bun = true` (bunfig) auto-aliases `node` to bun
  inside scripts (prepends a bun symlink to `$PATH`), so a script that shells
  out to `node` transparently gets bun. `[run] shell` selects bun's own shell
  vs the system shell. [bun.com/docs/runtime/bunfig]

> **Converter relevance.** Two `node_modules` trees that are graph-equivalent can
> still resolve to **different files** under bun vs node (TS source picked via
> `"bun"`, `paths` remaps, `.ts`-over-`.js`). "Layout equivalence" claims must be
> qualified by *which runtime* reads the tree. The converter models the graph,
> not the runtime resolver — so this is a documented limit, not something it
> reconciles.

---

## 4. Environment

Configuration is layered: `bunfig.toml` (bun-native) + `.npmrc` (npm-compat) +
CLI flags, with CLI winning.

### `bunfig.toml`

Optional; bun otherwise reads `package.json` / `tsconfig.json`. Local
**`./bunfig.toml`** overrides the global **`$HOME/.bunfig.toml`** (or
`$XDG_CONFIG_HOME/.bunfig.toml`); CLI flags override both.
[bun.com/docs/runtime/bunfig] It is **one file for two faces**:

- **Runtime keys:** `preload` (scripts/plugins before run), `jsx` /
  `jsxFactory` / `jsxFragment` / `jsxImportSource`, `smol` (low-memory),
  `logLevel`, `define` (identifier→constant), `loader` (ext→loader), `telemetry`,
  `env` (toggle `.env` autoload), `console.depth`; plus `[serve]`, `[test]`,
  `[run]` blocks.
- **Install keys** (`[install]`): `registry` (URL or `{ url, token }`),
  `[install.scopes]` (per-scope registry+auth), `[install.cache]`
  (`dir`/`disable`/`disableManifest`), `dev` / `optional` / `peer` (all default
  `true`), `production`, `exact`, `ignoreScripts`, `concurrentScripts`,
  `frozenLockfile`, `dryRun`, `auto` (`"auto"|"force"|"disable"|"fallback"`),
  `prefer` (`"online"|"offline"|"latest"`), `globalDir`, `globalBinDir`,
  `linkWorkspacePackages`, `linker`, `globalStore`, `hoistPattern`,
  `publicHoistPattern`, `[install.lockfile]` (`save` default `true`, `print`
  e.g. `"yarn"`), `saveTextLockfile`, `[install.security] scanner`,
  `minimumReleaseAge` / `minimumReleaseAgeExcludes`, `ca` / `cafile`, `logLevel`.
  [bun.com/docs/runtime/bunfig]

### `.npmrc` compatibility

Bun **reads `.npmrc`** for registry + auth so existing projects work unchanged.
Honoured keys include: `registry`, `@<scope>:registry`,
`//<host>/:_authToken`, `//<host>/:_auth` (base64 `user:pass`),
`//<host>/:username` + `//<host>/:_password`, `//<host>/:email`, `ca`, `cafile`,
plus install-behaviour spellings `link-workspace-packages`, `save-exact`,
`ignore-scripts`, `dry-run`, `cache`, `omit`/`include`, `install-strategy` /
`node-linker`, `public-hoist-pattern` / `hoist-pattern`.
[bun.com/docs/pm/npmrc] Bun recommends migrating `.npmrc` → `bunfig.toml`.
  > **Open:** `.npmrc` `always-auth` and `strict-ssl` are **absent** from the
  > docs list — likely unsupported, but treat as docs-omission (unverified)
  > rather than asserted-absent until probed. Also unstated: precise
  > `.npmrc` vs `bunfig.toml` precedence when both set the same registry.

### `bunx` / `bun x` / `bun run`

- **`bunx <pkg>`** (alias **`bun x`**) auto-installs and runs a package's `bin`:
  checks the local `node_modules` first, else installs into the **global cache**
  and runs from there — bun's `npx`. ~100× faster than `npx` for locally
  installed bins. `--package <name>` disambiguates when the bin name ≠ package
  name. Respects shebangs (see [§3](#3-resolver-mutation)).
  [bun.com/docs/pm/bunx]

### `.env` auto-load

Bun **auto-loads `.env` files at runtime** (node does not). The standard
cascade — `.env`, `.env.local`, and `NODE_ENV`-specific
(`.env.development` / `.env.production` / `.env.test`) — is read into
`process.env` / `Bun.env` automatically; `[env]` / `env = false` in bunfig
disables it.
  > **Open:** confirm the exact precedence order and the full `.env.*` set bun
  > honours against `bun.com/docs/runtime/env` (page 503'd at write time).

### Bin shims

Dependency `bin` entries are linked into `node_modules/.bin` (hoisted) or
resolved through the isolated store, runnable via `bun run <bin>` /
`bunx <bin>`. Globally installed bins live under `globalBinDir`.

---

## 5. Lifecycle

Bun's headline lifecycle divergence from npm is **scripts-off-by-default**.

- **Lifecycle scripts are NOT run by default** for installed dependencies — a
  deliberate supply-chain guard. A blocked package still **installs**; only its
  `preinstall`/`install`/`postinstall` are skipped (silently).
  [bun.com/docs/guides/install/trusted]
- **`trustedDependencies`** (`package.json` array) is the opt-in: list a package
  name to permit *its* lifecycle scripts. Trust is **non-transitive** — it
  authorises only the named package, **not** that package's own dependencies;
  each must be listed individually. [bun.com/docs/guides/install/trusted]
- **Built-in default allowlist.** Bun ships a curated list of popular packages
  with known-safe install scripts (e.g. `esbuild`, `fsevents`) whose scripts run
  **without** an explicit `trustedDependencies` entry. This default applies
  **only to packages installed from npm**; `file:` / `link:` / `git:` /
  `github:` sources always require an explicit `trustedDependencies` entry.
  [bun.com/docs/guides/install/trusted]
- **Tooling:** `bun pm trust <pkg>` adds + runs a package's scripts;
  `bun pm untrusted` lists installed deps with un-run scripts awaiting trust.
- **`--concurrent-scripts`** caps parallelism (default ≈ 2× CPU count /
  `GOMAXPROCS`).
- **`--ignore-scripts`** (bunfig `ignoreScripts` / `.npmrc ignore-scripts`)
  disables **all** lifecycle scripts, including the **root** project's.
- **`[install.security] scanner`** (bunfig) registers a security-scanner package
  consulted during install — bun's prevention hook, distinct from advisory
  *audit*. Available in recent bun (1.3 Security Scanner API).

> **Converter relevance.** `trustedDependencies` is bun-only. It is not
> resolution data but it changes the installed tree, so the converter carries it
> **verbatim** through a bun→bun round-trip and **strips** it for npm/yarn/pnpm
> targets — see [`bun-text.md`](../formats/bun-text.md) degradation rules.

---

## 6. Lockfile + registry

### Lockfile

Cross-ref [`bun-text.md`](../formats/bun-text.md) /
[`bun-binary.md`](../formats/bun-binary.md) — **interaction only** here; the
on-disk encoding lives in those format specs.

- **`bun.lock`** (text, JSONC) is the **current default** lockfile, since
  **1.2**; introduced **1.1.39** behind **`--save-text-lockfile`**. Top-level
  `lockfileVersion` + `workspaces` + `packages` (+ optional `overrides`,
  `patchedDependencies`, `trustedDependencies`). The full positional encoding,
  the `configVersion` sibling, and the `lockfileVersion` value (`0` in early
  text emits, `1` in current) are specified in
  [`bun-text.md`](../formats/bun-text.md) — **not duplicated here**.
  [bun.com/docs/pm/lockfile, bun.com/blog/bun-lock-text-lockfile]
- **`bun.lockb`** (binary, original; default **<1.2**) is a **detect-and-reject**
  input for this project — never parsed. Migrate with
  `bun install --save-text-lockfile --frozen-lockfile --lockfile-only` then
  delete `bun.lockb`. See [`bun-binary.md`](../formats/bun-binary.md).
- **Commit it.** Bun's docs say `bun.lock` *should* be committed.
- **`--lockfile-only`** writes the lockfile without populating `node_modules`
  (but still warms the global cache with registry metadata + git/tarball deps).
  **`--no-save`** installs without writing one. **`--frozen-lockfile`** (alias
  **`bun ci`**) installs exactly from `bun.lock` and errors on `package.json`
  drift. **`[install.lockfile] print = "yarn"`** (or `--yarn`) additionally
  emits a `yarn.lock` alongside. [bun.com/docs/install/lockfile,
  bun.com/docs/cli/install]
- **Cross-PM lockfile migration (read).** On the first `bun install` with no
  `bun.lock`, bun **auto-migrates** an existing **`yarn.lock` (v1)**,
  **`package-lock.json`** (npm), or **`pnpm-lock.yaml`** (pnpm), preserving
  resolutions; the original file is left in place for manual removal.
  [bun.com/docs/install/lockfile] (This is bun's *own* importer — orthogonal to
  this project's converter, but worth noting: bun is itself a multi-format
  reader.)

### Registry

Cross-ref [`registry/bun.md`](../registry/bun.md) +
[`registry/npm.md`](../registry/npm.md).

- Bun ships **no registry of its own** — `bun install` is a pure **npm-shape
  client** ([`registry/_common.md`](../registry/_common.md)), default
  `registry.npmjs.org`, configured via `bunfig.toml` `[install] registry` /
  `[install.scopes]` or `.npmrc`. No bun-specific wire protocol; addressing /
  tarball / metadata are whatever the configured backend serves.
- **`bun audit`** queries the configured registry's **npm advisory API** — so it
  inherits that backend's advisory support (full on npm/yarn-mirror, absent on
  nexus/npmmirror/github-packages). See
  [`registry/bun.md`](../registry/bun.md).
  > **Open (carried from `registry/bun.md`):** which advisory endpoint
  > `bun audit` calls (`advisories/bulk` vs `audits/quick`) and whether the
  > fetcher sends the corgi `Accept` header by default.

---

## Sources

Authoritative (bun.com/docs + oven-sh blog/source), fetched/searched 2026-06-16:

- [bun.com/docs/cli/install](https://bun.com/docs/cli/install) — `bun install`,
  `--linker` / `--backend` / `--filter` / `--frozen-lockfile` / `--omit`,
  cache path, overrides+resolutions, peers, minimum-release-age.
- [bun.com/docs/install/lockfile](https://bun.com/docs/install/lockfile) — text
  default since 1.2, migration command, `--lockfile-only` / `--no-save` /
  `--yarn`, auto-migration of yarn/npm/pnpm lockfiles.
- [bun.com/docs/install/isolated](https://bun.com/docs/install/isolated) +
  [blog 1.2.19](https://bun.com/blog/bun-v1.2.19) +
  [blog 1.3.1](https://bun.com/blog/bun-v1.3.1) — isolated linker, `node_modules/.bun`
  store, default-for-workspaces in 1.3, global virtual store.
- [bun.com/docs/runtime/modules](https://bun.com/docs/runtime/modules) — runtime
  resolver, extension order, `tsconfig paths`, `exports` condition order, `"bun"`
  condition, CJS/ESM interop.
- [bun.com/docs/runtime/bunfig](https://bun.com/docs/runtime/bunfig) — full
  `bunfig.toml` key surface (runtime + `[install]`), global vs local precedence.
- [bun.com/docs/pm/npmrc](https://bun.com/docs/pm/npmrc) — `.npmrc` honoured keys
  + auth.
- [bun.com/docs/pm/bunx](https://bun.com/docs/pm/bunx) — `bunx` / `bun x`,
  auto-install to global cache, shebang respect, `--package`.
- [bun.com/docs/pm/workspaces](https://bun.com/docs/pm/workspaces) — workspaces,
  `workspace:` + `catalog:` protocols.
- [bun.com/docs/guides/install/trusted](https://bun.com/docs/guides/install/trusted) —
  `trustedDependencies`, default allowlist, non-transitivity, `bun pm trust` /
  `bun pm untrusted`.
- [bun.com/blog/bun-lock-text-lockfile](https://bun.com/blog/bun-lock-text-lockfile) —
  text lockfile rationale + 1.1.39 intro / 1.2 default.
- Cross-refs: substrate [`_common.md`](./_common.md); formats
  [`bun-text.md`](../formats/bun-text.md) / [`bun-binary.md`](../formats/bun-binary.md);
  registry [`registry/bun.md`](../registry/bun.md) /
  [`registry/npm.md`](../registry/npm.md).

## Open questions

> Consolidated from the inline `> **Open:**` markers above:
> 1. Exact introducing minor for `catalog:` / named `catalogs`, and how a
>    catalog reference is rendered inside `bun.lock`.
> 2. `.npmrc` `always-auth` / `strict-ssl` support (docs-omission → unverified)
>    and `.npmrc` vs `bunfig.toml` registry precedence.
> 3. Full `.env.*` cascade + precedence (`runtime/env` page 503'd at write time).
> 4. (carried) `bun audit` advisory endpoint + corgi `Accept` header.
