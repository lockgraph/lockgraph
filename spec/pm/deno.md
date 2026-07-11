# `deno` — Deno runtime as a package manager

> Status: **frontier** (research-grade; search-only, not live-probed) —
> research-derived from docs.deno.com, JSR docs, and Deno release notes; **no**
> adapter exists; cross-referenced `spec/formats/deno.lock.md` is not yet written.
> Updated: 2026-06-17.
> Family: **non-Node** — the single most divergent entry in `spec/pm/`. Deno is a
> runtime first, PM second; its native model replaces, rather than extends, the
> Node resolver.
> Substrate: see [`_common.md`](./_common.md) for the **Node.js substrate** every
> other PM (`npm-*`, `pnpm-*`, `yarn-*`, `bun`) shares. **Deno opts out of most of
> it by default** — that opt-out is the spine of this doc.

Deno is a JavaScript/TypeScript runtime by Deno Land Inc. (Ryan Dahl et al.). It
is "PM-ish": it resolves, fetches, caches, version-locks and audits dependencies,
and ships first-class `deno add` / `deno install` / `deno audit` commands — but it
does **not**, by default, build a `node_modules` tree or walk the Node resolution
algorithm. Instead it resolves modules from **URLs**, **`jsr:`** specifiers and
**`npm:`** specifiers through a **global content-addressed cache** (`DENO_DIR`) and
an **import map** (`deno.json` `imports`). The Node model (`node_modules`,
hoisting, `package.json` `main`/`exports` walk, lifecycle scripts) is reached only
through an explicit, opt-in **npm-compatibility layer**.

Deno is scoped as foundational-but-frontier (the most divergent from the
Node/npm model). The six family axes are all covered, but several are "Deno has no
equivalent" rather than a delta from `_common.md`, and the lockfile section
cross-references a format spec that does not yet exist (`deno.lock` is a stub in
`spec/formats/`). Treat byte-level claims as **research-grade, not probe-grade**.

> **Version sensitivity is high.** Deno 1 → Deno 2 (Oct 2024) changed defaults
> across nearly every axis: `deno cache` → `deno install`, `deno install` became
> *local-by-default*, `nodeModulesDir` boolean → tri-state string, `deno vendor`
> CLI → a `deno.json` `"vendor": true` option, and `deno.land/x` (URL imports) was
> de-emphasised in favour of **JSR**. `deno audit`/`deno audit fix` are Deno **2.6+**.
> Every behaviour below is flagged with the version where known.

---

## Axis 0 — relationship to the Node substrate (the spine)

Read this before the six axes. Everything else is a consequence.

| Concern | Node substrate ([`_common.md`](./_common.md)) | Deno default | Deno npm-compat (opt-in) |
|---|---|---|---|
| Unit of dependency | a **package** (`name@semver`) from a registry | a **module** addressed by URL / `jsr:` / `npm:` specifier | a **package** via `npm:` specifier |
| Resolver | Node resolution algorithm — walk `node_modules` upward | URL + **import-map** resolution; semver only for `jsr:`/`npm:` | Node-compatible resolution, re-implemented in Rust |
| On-disk layout | a `node_modules` tree (hoisted / nested / isolated) | **none** — cached by hash in `DENO_DIR` | a materialised `node_modules` (isolated `.deno/`, or hoisted) |
| Manifest | `package.json` | `deno.json` / `deno.jsonc` (`package.json` *also* read in compat) | both `deno.json` and `package.json` |
| Lockfile | `package-lock.json` / `pnpm-lock.yaml` / `yarn.lock` / `bun.lock` | `deno.lock` (different shape — URL + jsr + npm + remote sections) | `deno.lock` |
| Lifecycle scripts | run by default (npm) | **never** (no Node lifecycle for URL/jsr modules) | **opt-in only** via `--allow-scripts` |
| Trust boundary | implicit — install = arbitrary code | **explicit permission sandbox** (`--allow-*`); nothing runs unsanctioned | sandbox still applies to executed code |

The load-bearing inversion: **for the other PMs the resolver is a layout problem
(where does the file land in `node_modules`); for Deno the resolver is a naming
problem (what URL/spec does this import map to, and is it in the cache).** "Resolver
mutation" — the project's audit-fix lever — therefore means something different
here (Axis 3).

---

## Axis 1 — RESOLUTION

Deno has **three** specifier kinds, resolved by three sub-resolvers, optionally
indirected through an **import map**.

### 1.1 URL imports (the original model)

A bare `import` of an absolute URL is fetched and cached verbatim:

```ts
import { delay } from "https://deno.land/std@0.224.0/async/delay.ts";
```

- The URL **is** the identity; there is no semver resolution — the version is
  pinned in the path (`std@0.224.0`). Re-resolution = re-fetch (or cache hit).
- `http(s):`, `file:`, `data:`, `blob:`, and `node:` (Axis 3) schemes are
  recognised. `deno.land/x` was the canonical third-party host; **Deno 2
  de-emphasises it in favour of JSR** for new code (URL imports remain
  supported). ([deno.com/blog/v2.0-release-candidate], [docs.deno.com/runtime/fundamentals/modules])

### 1.2 The import map — `deno.json` `imports`

The `imports` field is an [Import Maps standard](https://github.com/WICG/import-maps)
map from **bare specifiers** to concrete specifiers. It is how Deno gets npm-style
`import x from "pkg"` ergonomics without `node_modules`:

```jsonc
// deno.json
{
  "imports": {
    "@luca/cases": "jsr:@luca/cases@^1.0.0",   // JSR package
    "cowsay":      "npm:cowsay@^1.6.0",         // npm package
    "chalk":       "npm:chalk@5",
    "cases":       "https://deno.land/x/case/mod.ts"  // URL
  },
  "scopes": {
    "https://deno.land/x/example/": { "chalk": "npm:chalk@4" }
  }
}
```

- Deno **extends** the standard: a trailing-slash-less key works for both the bare
  name and sub-paths (`"@std/foo"` covers `@std/foo` and `@std/foo/bar`).
  ([docs.deno.com/runtime/fundamentals/modules])
- `scopes` (`Record<string, Record<string,string>>`) overrides mappings under a URL
  prefix — the standard's per-scope mechanism. Deno also documents using `scopes`
  to **patch a single HTTPS dependency to a local file** for debugging.
  ([docs.deno.com/runtime/fundamentals/configuration])
- An import map may be **external**, referenced by `deno.json`'s `importMap` field,
  or inline in `imports`. (Both supported; inline is the Deno-2 norm.)

### 1.3 `jsr:` specifiers — the JSR registry

`jsr:@scope/name@range` resolves against **JSR** (`jsr.io`), the Deno team's
TypeScript-first registry. Cross-reference [`spec/registry/jsr.md`](../registry/jsr.md)
for the registry contract; the resolution-relevant facts:

- **Semver** range resolution (`^`, `~`, `1`, `1.0`, exact) — JSR serves a
  versions/meta document; Deno picks the max satisfying version and pins it in
  `deno.lock`.
- Native JSR checksums are **sha256** per file (not the npm sha512 tarball SRI) —
  see [`jsr.md`](../registry/jsr.md) §"Metadata deltas"; this is mirrored in
  `deno.lock`'s `jsr` section (Axis 6).
- JSR modules are **served as source** (TS/JS), not tarballs, when consumed
  natively by Deno; the `npm.jsr.io` compat tarball face is for the *other* PMs,
  not for Deno.

### 1.4 `npm:` specifiers — npm packages, Deno's way

`npm:name@range[/subpath]` resolves against the configured npm registry
(default `registry.npmjs.org`; cross-ref [`spec/registry/npm.md`](../registry/npm.md)
and [`registry/_common.md`](../registry/_common.md)):

```ts
import express from "npm:express@4";
import { z } from "npm:zod@^3.23";
```

- Semver resolution + tarball fetch + sha512 SRI integrity, **same registry
  protocol as npm** — but the *consumption* model differs (Axis 2/3): by default
  the tarball is unpacked into the **global cache**, not a project `node_modules`.
- **Deno has no concept of peer dependencies** the way npm/pnpm do — a documented
  limitation; `peerDependencies` declared by npm packages are not auto-installed
  and are not virtualised. ([questions.deno.com — peer dependency], [deno.com/learn/nodes-complexity-problem])

### 1.5 Unprefixed names & the install commands

- `deno add <name>` / `deno install <name>`: an **unprefixed** name is treated as
  **npm by default** — `deno add express` ≡ `deno add npm:express`. JSR packages
  **must** keep the `jsr:` prefix to stay unambiguous. Both write an `imports`
  entry into `deno.json(c)` and pin into `deno.lock`.
  ([docs.deno.com/runtime/fundamentals/modules], [jsr.io/docs/using-packages])
- **Deno 2 semantics:** `deno install <pkg>` installs **locally** (adds a dep,
  like `deno add`); `deno install -g/--global <pkg>` installs a global script.
  In Deno 1 `deno install` *was* the global-script command — a breaking flip.
  ([docs.deno.com/runtime/reference/cli/install], [deno.com/blog/v2.0-release-candidate])
- `deno cache` (Deno 1, "download into cache") is **deprecated** → use
  `deno install --entrypoint main.ts`. ([migration guide])
- `deno remove` removes a dep from `deno.json`/`package.json` + lockfile.

### 1.6 The global cache — `DENO_DIR`

Resolution terminates in a **single global, content-addressed cache** shared by all
projects (analogous to pnpm's store, **not** a per-project `node_modules`):

- Location is platform-specific (e.g. `~/Library/Caches/deno` on macOS); override
  with the `DENO_DIR` env var; inspect with `deno info`.
  ([docs.deno.com/runtime/reference/cli/info])
- Sub-layout (research-grade): `deps/` (remote URL modules), `npm/` (npm packages
  under a `registry.npmjs.org/...` tree), `gen/` (compiled output). `--reload`
  forces re-fetch; `--cached-only` forbids network. ([docs.deno.com/runtime/reference/cli/info])

---

## Axis 2 — LINKING / LAYOUT

> **The headline: by default, none.** This is the axis where Deno is most unlike
> every `_common.md` PM.

### 2.1 Default — no `node_modules`

Modules live in `DENO_DIR` keyed by URL/spec hash; the project directory stays
clean. `nodeModulesDir` defaults to **`"none"`** when there is no `package.json`.
([docs.deno.com/runtime/fundamentals/node]) Nothing is "linked" into the project —
the runtime resolves straight to the cache.

### 2.2 Opt-in `node_modules` — the npm-compat materialisation

When npm-package compatibility needs a real tree (dynamic `require`, `__dirname`
file access, tools that stat `node_modules`), Deno **materialises** one. Controlled
by **`nodeModulesDir`** in `deno.json` and/or `--node-modules-dir` on the CLI, a
**tri-state** (Deno 2; the old boolean is deprecated):

| Value | Behaviour | Default when |
|---|---|---|
| `"none"` | global cache only, no `node_modules` | **no `package.json`** present |
| `"auto"` | Deno **creates & manages** a local `node_modules` from the global cache (boolean `true` in Deno 1) | — |
| `"manual"` | user-managed `node_modules`; you run `deno install` after each change ("BYONM" — bring-your-own-node-modules) | **`package.json` present** (changed from `auto` in Deno 2) |

([docs.deno.com/runtime/fundamentals/node], [migration guide])

- **Linker / layout shape.** The `"auto"` tree is, by default, an **isolated**
  layout (pnpm-like): each package unpacked into a content-addressed `.deno/`
  directory and exposed by symlink, so a package sees only its declared deps. The
  global cache uses **hard links / `clonefile`** (pnpm-style) so the bytes are
  stored once. **Deno 2.8** adds an opt-in **hoisted** linker via
  **`nodeModulesLinker`** in `deno.json` (`"isolated"` default vs `"hoisted"`).
  ([deno.com/blog/v2.8], [deno.com/blog/your-new-js-package-manager])
- This is the layout most legible to this project's existing Node-family layout
  model (`spec/04-layouts.md`): when Deno *does* build `node_modules`, it is
  recognisably an isolated/hoisted Node layout.

### 2.3 `vendor` — local source mirror for remote modules

Orthogonal to `node_modules` (which is for npm packages): `vendor` materialises
**remote URL** (and JSR) source into a project `vendor/` directory + a generated
import map, for hermetic/offline/patchable builds.

- **Deno 1:** the `deno vendor` **subcommand**. **Deno 2:** replaced by a
  `deno.json` **`"vendor": true`** option (the dir is populated on run / `deno
  install`). ([migration guide], [deno.com/blog/v1.19])
- Commit `vendor/` (with `deno.json` + `deno.lock`) for a fully hermetic build; the
  lockfile alone does not protect against an upstream URL disappearing.

### 2.4 Workspaces / monorepo — and the focused-install question

Deno gained workspace/monorepo support in **Deno 1.45**. A workspace is declared by
a **`workspace` array of member directory paths** in the root `deno.json`:

```jsonc
// root deno.json
{ "workspace": ["./add", "./subtract"] }
```

- Each member directory has its **own `deno.json(c)`** (member identity is its
  `name` field; npm-style `package.json` members are also supported as a
  backwards-compatible workspace form). Members **inherit the root's `imports`**, so
  a single version of a shared dependency is managed once at the root.
  ([docs.deno.com/runtime/fundamentals/workspaces], accessed 2026-06-17;
  [deno.com/blog/v1.45], accessed 2026-06-17)
- `deno install` **with no argument** in a workspace caches the dependencies of
  workspace members (and sets up a local `node_modules` if applicable). `--recursive`
  / `-r` makes an operation span all members.
  ([docs.deno.com/runtime/fundamentals/workspaces], accessed 2026-06-17)
- A **`--filter <pattern>`** flag selects workspace members by name (newer Deno also
  matches the member directory name) and **implies `--recursive`**. It is documented
  for member-scoped command dispatch — e.g. `deno task --filter "client/" dev`,
  `deno outdated --filter …`. ([docs.deno.com/runtime/fundamentals/workspaces],
  accessed 2026-06-17; [docs.deno.com/runtime/reference/cli/outdated], accessed
  2026-06-17)
- The nearest thing to a **dependency-scoped** install is **`deno install
  --entrypoint <file>`**, which caches **only** the dependencies transitively
  imported by that entrypoint — a graph-reachability filter, not a workspace-member
  filter. ([docs.deno.com/runtime/reference/cli/install], accessed 2026-06-17)

> **Open (frontier):** Deno has **no** documented `deploy`-style or pnpm
> `--filter`-style **focused single-member *install*** that materialises only one
> member's dependency subgraph (the `--filter` flag is documented for command
> dispatch — `task`, `outdated` — not as a producer of a member-isolated install
> set; `--entrypoint` filters by import-graph reachability, not by member). Whether
> `deno install --filter <member>` resolves/installs strictly that member's subgraph
> is **not** confirmed from the docs surveyed and was **not** live-probed; this is an
> evolving area (workspace tooling changed across 2.x). Confirm against a current
> Deno before relying on it.

---

## Axis 3 — RESOLVER MUTATION (the spine, continued)

For the Node PMs, "resolver mutation" = changing **where a package lands in
`node_modules`** (hoist, dedupe, override). For Deno there are **two distinct
resolvers**, and the project's audit-fix lever attaches differently to each.

### 3.1 Deno's own resolver (URL + import map + jsr/npm specifiers)

The mutation surface is the **import map** and the **lockfile pins**, *not* a
`node_modules` walk:

- To force a transitive version, you change the **`imports`** (or `scopes`) entry,
  or re-pin in `deno.lock` — there is no hoisting to manipulate because there is no
  tree. For URL imports there is not even semver indirection: the version is the
  URL, so an "override" is a URL rewrite (often via `scopes`).
- **npm overrides** for `npm:` deps: Deno **2.7** adds npm-style `overrides`
  support so a vulnerable transitive npm dep can be force-resolved — the closest
  analog to npm `overrides` / yarn `resolutions` / bun `overrides` in the Deno
  model. ([deno.com/blog/v2.7]) (Pre-2.7 the only lever was the import map / a
  patched `vendor`.)

**Deno's resolver is built-in; there is no `.pnp` data file.** Deno resolves
through its **own** resolver — URL specifiers, the `deno.json` **import map**
(based on the [Import Maps Standard](https://github.com/WICG/import-maps)), and
`jsr:`/`npm:` specifiers — not the stock Node resolution algorithm and not a
serialized Plug'n'Play map. To resolve a bare specifier such as `"react"`, Deno
requires an `imports` entry telling it where to look; it does not auto-walk a
`node_modules` tree. ([docs.deno.com/runtime/fundamentals/modules], accessed
2026-06-17) Deno also diverges from Node resolution in two visible ways: local ES
module specifiers must carry the **full file extension** (no extension probing),
and Node built-ins must be referenced as `node:fs` rather than bare `"fs"` outside
npm dependencies. ([docs.deno.com/runtime/fundamentals/modules], accessed
2026-06-17)

> **Contrast — Deno vs yarn Plug'n'Play.** Deno's resolution is a **built-in
> URL / import-map / specifier resolver** baked into the runtime (no on-disk
> resolution database), whereas yarn PnP ships a **serialized package→location map**
> (`.pnp.cjs`/`.pnp.data.json`) plus an injected JavaScript resolver that patches
> Node's own `require`/import resolution at process start. Deno carries no PnP-style
> data file; for `npm:` specifiers it instead runs an **npm-compatibility resolver**
> (§3.2). ([docs.deno.com/runtime/fundamentals/node], accessed 2026-06-17)
> *(Frontier: contrast is doc-derived, not probe-derived.)*

### 3.2 The npm-compat resolver (how `npm:` is made to work)

This is a **re-implementation of the Node resolution algorithm in Rust**, layered
on top of Deno's own loader. It is what lets `npm:express` find its `node:`-built-in
and CJS dependencies:

- **Managed mode** (default): Deno resolves the npm dependency graph, does semver
  resolution + dedupe, and serves packages **from the global cache** with no
  `node_modules` — the runtime synthesises Node-style resolution against the cache.
  ([deepwiki — NPM Integration and Resolution])
- **BYONM / `"manual"`**: Deno defers to a real, user-managed `node_modules`
  (Node-compatible resolution against on-disk files).
- `node:` **built-in specifiers** (`import { readFile } from "node:fs"`) are served
  by Deno's Node-compat std library (Deno 1.30+ shipped the `node:` prefix; **Deno
  2.9** resolves bare built-in names like `"os"` *without* the prefix, though the
  explicit `node:` form stays preferred/portable). CommonJS (`require`, `.cjs`) is
  supported; CJS resolution typically needs `--allow-read`/`--allow-env` because
  Deno probes `package.json`/`node_modules` to resolve.
  ([deno.com/blog/v1.30], [docs.deno.com/runtime/fundamentals/node])

**Contrast — the one-liner per PM:**

| PM | "resolver mutation" lever |
|---|---|
| stock Node | none (no PM) — resolution is the `node_modules` walk as laid out |
| npm / pnpm / yarn / bun | rewrite where a package lands in `node_modules` (hoist/dedupe) + `overrides`/`resolutions` |
| **Deno (own)** | rewrite the **import map** / lockfile pins; **no tree to hoist**; URL override = URL rewrite |
| **Deno (npm-compat)** | npm-style `overrides` (2.7+); otherwise managed-mode dedupe against the **global cache**, or BYONM `node_modules` |

For this project, a Deno source is therefore **two graphs fused**: a URL/JSR module
graph (no Node analog) and an npm sub-graph (which *is* an `_common.md`-shaped npm
graph). A converter that ever ingests `deno.lock` must split them.

---

## Axis 4 — ENVIRONMENT

### 4.1 `deno.json` / `deno.jsonc` — the manifest + config

One file is manifest, import map, task runner, formatter/linter config and TS
config. Top-level fields (research-grade catalogue;
[docs.deno.com/runtime/fundamentals/configuration]):

| Field | Role |
|---|---|
| `imports` | the import map (Axis 1.2) — bare-specifier → `jsr:`/`npm:`/URL |
| `scopes` | per-URL-prefix import-map overrides |
| `importMap` | path to an **external** import map file (alternative to inline `imports`) |
| `tasks` | named scripts for `deno task` (the `npm run` analog) |
| `lint` / `fmt` / `test` | built-in linter / formatter / test-runner config |
| `compilerOptions` | a TS-config subset (Deno owns TS natively; **no** `tsconfig.json` by default) |
| `nodeModulesDir` | `"none"` / `"auto"` / `"manual"` (Axis 2.2) |
| `nodeModulesLinker` | `"isolated"` (default) / `"hoisted"` — Deno 2.8+ (Axis 2.2) |
| `vendor` | `true` ⇒ materialise remote source into `vendor/` (Axis 2.3) |
| `lock` | lockfile control: `false` to disable, or `{ "frozen": true, "path": "…" }` (Axis 6) |
| `workspace` | array of member directories — monorepo support (Deno 1.45+) |
| `patch` | (newer) point a dep at a local patched copy across a workspace |
| `name` / `version` / `exports` | **package identity** for `deno publish` → JSR (Axis 6) |
| `exclude` | paths excluded from lint/fmt/test/publish |

- **`deno.json` vs `package.json`.** Both may coexist: Deno reads **dependencies
  from each**, but takes its **own configuration only from `deno.json`** (formatter,
  linter, TS options, lockfile). In an npm-compat project `package.json`
  dependencies are honoured; `deno.json` `imports` win for Deno-native resolution.
  ([docs.deno.com/runtime/fundamentals/configuration], [deno.com/blog/package-json-support])
  (Known sharp edge: jsr-dep dedup can break when the *same* dep is declared in
  both files — denoland/deno#27380.)

### 4.2 The permissions sandbox — unique, and load-bearing for this project

Deno is **secure by default**: code cannot touch the filesystem, network,
environment or subprocesses unless granted. This is enforced by the runtime, not
the OS, and has **no analog** in any `_common.md` PM. ([docs.deno.com/runtime/fundamentals/security])

- Flags: `--allow-read[=paths]`, `--allow-write[=paths]`, `--allow-net[=hosts]`,
  `--allow-env[=vars]`, `--allow-run`, `--allow-sys`, `--allow-ffi`; `-A`/`--allow-all`
  for the unsafe blanket grant. Most are scopeable to specific resources.
- **Deno 2.5** lets you declare permissions **in `deno.json`** (per-task), not just
  on the CLI. ([deno.com/blog/v2.5])
- **Why it matters here:** install is *not* an arbitrary-code event (Axis 5), and
  even at runtime a resolved dependency runs sandboxed. This is the structural
  reason Deno's supply-chain posture differs from the Node PMs and why its
  lifecycle stance (next axis) can be "off by default" without breaking the world.

### 4.3 `deno task` / `deno run`

- `deno task <name>` runs a script from `deno.json` `tasks` (the `npm run` analog;
  cross-shell, built-in).
- `deno run [perms] <entry>` runs a module directly (URL, file, or `npm:`/`jsr:`
  specifier). `dx` (Deno 2.6) is the `npx` analog.
- `--unstable-*` flags gate not-yet-stable APIs (e.g. `--unstable-sloppy-imports`,
  `--unstable-byonm` historically). Deno 1 had a single `--unstable`; Deno 2 split
  it into named `--unstable-<feature>` flags + a `deno.json` `unstable: []` array.

---

## Axis 5 — LIFECYCLE

Deno's historical stance: **there is no Node lifecycle.** URL/JSR modules are plain
ES modules — fetched, cached, evaluated; there is no `preinstall`/`postinstall`/
`prepare` phase, because there is no "install that runs package code." This is a
deliberate supply-chain decision and the default to this day.

For **npm packages** (which *do* declare lifecycle scripts), Deno's stance is
**opt-in, never automatic**:

- Lifecycle scripts (`preinstall`/`install`/`postinstall`) are **not run by
  default** — "a common attack vector, so running them is opt-in."
  ([docs.deno.com/runtime/fundamentals/node], [docs.deno.com/runtime/reference/cli/install])
- Run them by passing **`--allow-scripts[=npm:pkg,…]`** to `deno install`. With no
  argument it is broad; scoped to specific packages it is least-privilege.
- **Constraint:** scripts only run when a **`node_modules` directory** exists
  (i.e. `nodeModulesDir` `"auto"`/`"manual"`) — there is nowhere to run a
  postinstall in the no-`node_modules` default. ([docs.deno.com — install])
- **`deno approve-scripts`** (newer subcommand) provides an interactive/managed
  approval flow, recording which packages are trusted — a more ergonomic successor
  to the bare `--allow-scripts` flag. ([docs.deno.com/runtime/reference/cli/approve_scripts])
- Known rough edges in the Deno-2 era: `--allow-scripts` "Argument list too long"
  with many packages (deno#25841/#25891); a lifecycle-warning only surfacing under
  `deno task` (deno#27682). Flag as **unstable surface**.

**Contrast with the substrate:** npm/yarn-classic run lifecycle scripts by default;
pnpm/bun gate them (`trustedDependencies` / pnpm's allow-list); **Deno gates them
*and* requires a `node_modules` to even have somewhere to run** — the strictest
default in the family. Trust state has no `deno.lock` field analogous to bun's
`trustedDependencies`; it lives in the `--allow-scripts`/`approve-scripts` decision
(research-grade — confirm whether 2.x persists approvals into config/lockfile).

---

## Axis 6 — LOCKFILE + REGISTRY

### 6.1 `deno.lock`

> **Format spec status:** there is **no** `spec/formats/deno.lock.md` — this is the
> frontier stub. Sketch below is research-grade (from real `deno.lock` corpora +
> the `deno_lockfile` crate, now folded into `denoland/deno`); promote to a full
> format spec before any byte-exact round-trip work.

- **Filename:** `deno.lock`, auto-created next to `deno.json(c)` since **Deno
  1.28**. Disable with `deno.json` `"lock": false` or CLI `--no-lock`. Frozen mode:
  `"lock": { "frozen": true }` (Deno 1.46+) or `--frozen[=true]`.
  ([docs.deno.com/runtime/reference/cli/install], [migration guide])
- **Version history** (the `"version"` top-level field — research-grade dating):
  - **v1/v2** — early flat URL→hash maps (Deno 1.x).
  - **v3** — ~Deno 1.36–1.38 (the long-lived 1.x format; many third-party tools
    pinned to it).
  - **v4** — **Deno 2.0**; "more concise, minimises diffs," introduces the
    `specifiers` indirection + structured `jsr`/`npm` sections.
  - **v5** — **Deno 2.3**; adds extra npm metadata to speed resolution/install.
    (Deno auto-migrates older lockfiles forward.) ([deno.com/blog/v2.0-release-candidate], [deno.com/blog/v2.3])

**v4 schema sketch** (sections; a file carries only those that apply):

```jsonc
{
  "version": "4",
  // bare/ranged spec  →  exact resolved version
  "specifiers": {
    "jsr:@std/assert@1":     "1.0.8",
    "npm:zod@^3.23":         "3.23.8"
  },
  // JSR packages: sha256 integrity + edges (by spec name, version resolved via `specifiers`)
  "jsr": {
    "@std/assert@1.0.8": {
      "integrity": "ebe0bd7eb488…",          // sha256, NOT prefixed
      "dependencies": ["jsr:@std/internal"]
    }
  },
  // npm packages: sha512 SRI + edges (pinned name@version keys)
  "npm": {
    "zod@3.23.8": {
      "integrity": "sha512-…",
      "dependencies": {}
    }
  },
  // URL → pinned URL  (e.g. std/foo → std@x.y.z/foo)
  "redirects": {
    "https://deno.land/std/fmt/printf.ts": "https://deno.land/std@0.105.0/fmt/printf.ts"
  },
  // remote URL modules → per-file hash (sha256, bare hex)
  "remote": {
    "https://deno.land/std@0.105.0/_util/assert.ts": "2f868145a042a11d…"
  },
  // monorepo: which specifiers each workspace member depends on
  "workspace": {
    "dependencies": ["jsr:@std/assert@1"],
    "members": { "packages/foo": { "dependencies": ["npm:zod@^3.23"] } }
  }
}
```

Load-bearing format facts (cross-cut with [`formats/_common.md` §3 integrity model](../formats/_common.md#3-integrity-model)):

- **Two integrity models in one file.** `jsr` + `remote` use **sha256 bare-hex**
  (per-file source hashes — JSR is source-served, URL modules are single files);
  `npm` uses **sha512 SRI** (tarball, the `_common.md`/`npm.md` model). A converter
  must **not** cross them.
- The `specifiers` indirection (v4+) separates the *requested range* from the
  *resolved version* — diff-minimising; the `jsr`/`npm` keys are the resolved
  identities.
- `redirects` is a Deno-only concept (URL → version-pinned URL); `remote` is the
  URL-module graph with **no Node analog** at all.
- The `workspace` section is the monorepo manifest mirror (Deno 1.45+).

### Integrity verification

`deno.lock` is the integrity record: Deno automatically maintains it with the exact
resolved version **and integrity hash of every dependency**, and **verifies cached
content against those hashes on subsequent runs**.
([docs.deno.com/runtime/fundamentals/dependency_management], accessed 2026-06-17;
[docs.deno.com/runtime/manual/basics/modules/integrity_checking], accessed
2026-06-17)

**What is hashed, per source kind** (cross-cut with §6.1 and
[`formats/_common.md` §3 integrity model](../formats/_common.md#3-integrity-model)):

- **`remote`** — each remote URL module is keyed to a **sha256 hash of the fetched
  module source** (single-file source, bare hex). This is the original
  integrity-checking case: a URL import is fetched, compiled and cached, and a later
  run on another machine must see byte-identical source or it is rejected.
  ([docs.deno.com/runtime/manual/basics/modules/integrity_checking], accessed
  2026-06-17)
- **`jsr`** — per-package **sha256** integrity entries (JSR is source-served, so the
  hash covers source, not a tarball). ([deno.com/blog/v1.45], accessed 2026-06-17)
- **`npm`** — per-package **sha512 Subresource-Integrity** entries, i.e. the npm
  `dist.integrity` tarball SRI (`sha512-…`), the same model as `npm.md`.
  ([deno.com/blog/v1.45], accessed 2026-06-17)

**When verification happens.** On dependency access — fetch and cache-read — Deno
compares the cached/just-fetched bytes against the hash stored in `deno.lock`; a new
or changed dependency is otherwise recorded **additively** into the lockfile (an
absent lockfile is created next to `deno.json`).
([docs.deno.com/runtime/manual/basics/modules/integrity_checking], accessed
2026-06-17)

**Flags.**

- `--lock[=path]` selects the lockfile to check (defaults to `./deno.lock`); a
  `deno.json` `"lock"` object configures path and behaviour, and `--no-lock`
  disables it. ([docs.deno.com/runtime/fundamentals/dependency_management], accessed
  2026-06-17)
- `--frozen[=true]` (alias `--frozen-lockfile`; also `"lock": { "frozen": true }`)
  makes Deno **error rather than write** when the lockfile would change — a new or
  unseen dependency fails the build instead of being added silently. `--frozen=false`
  / `"lock": { "frozen": false }` temporarily re-enables writes.
  ([docs.deno.com/runtime/fundamentals/dependency_management], accessed 2026-06-17)
- **Deno 2.8+** adds **`deno ci`**, documented as equivalent to `deno install
  --frozen` plus npm lifecycle-script handling — the intended "install strictly from
  the lockfile" CI entry point (errors if `deno.lock` is missing or out of date).
  ([deno.com/blog/v2.8], accessed 2026-06-17)

**Behaviour on mismatch.** A hash mismatch is a **lockfile verification error**, not
a silent re-resolve: Deno reports an integrity-check failure for the offending
specifier — the recorded message states the source does not match the expected hash
in the lock file — and surfaces the expected vs actual hash. The documented
escape hatches are to refetch the source with **`--reload`** (re-derive the hash
from the current upstream) or to regenerate the lockfile.
([docs.deno.com/runtime/manual/basics/modules/integrity_checking], accessed
2026-06-17; [questions.deno.com — deno.lock conflict], accessed 2026-06-17)

> **Open (frontier):** the precise wording/format of the integrity-failure
> diagnostic, and whether `jsr`/`npm`/`remote` are verified by exactly the same code
> path and at exactly the same lifecycle point (fetch vs cache-read vs
> type-check), are **not** byte-confirmed here — doc-derived, **not** live-probed.
> The mismatch-vs-out-of-date distinction (a *changed* hash raises an integrity
> error; a *missing/new* entry under `--frozen` raises a frozen-lockfile error) is
> stated from the docs but not exercised against a current Deno build.

### 6.2 Registries

Deno is **multi-registry by construction**, and each maps to an existing
`spec/registry/` entry:

| Source | Protocol | Integrity | Registry spec |
|---|---|---|---|
| `npm:` specifiers | npm registry protocol (default `registry.npmjs.org`) | sha512 SRI (`dist.integrity`) | [`spec/registry/npm.md`](../registry/npm.md) + [`_common.md`](../registry/_common.md) |
| `jsr:` specifiers | **native JSR** (`jsr.io`), source + meta API | sha256 per file | [`spec/registry/jsr.md`](../registry/jsr.md) (consult the **native** face, not `npm.jsr.io`) |
| URL imports | plain HTTPS GET (`deno.land/x`, `esm.sh`, any host) | sha256 per file in `remote` | n/a — not a registry; arbitrary web |

- Note the asymmetry vs [`jsr.md`](../registry/jsr.md): the **other** PMs consume
  JSR through the `npm.jsr.io` compat face (sha512 tarballs, `@jsr/scope__name`
  mangling); **Deno consumes JSR natively** (source, sha256, real `@scope/name`).
  The same registry, two contracts — Deno uses the one the other PMs don't.
- Default npm registry is overridable (`.npmrc`/`NPM_CONFIG_REGISTRY` are honoured
  in npm-compat) — so the full `spec/registry/` matrix (verdaccio, nexus,
  artifactory, mirrors) is reachable for `npm:` deps. Untested here.

### 6.3 Advisories / audit — `deno audit` (directly on this project's spine)

**Deno ships native audit *and* native remediation** — notable because it is the
**inverse** of Bun (which shipped `bun audit` scan but **not** `bun audit fix`):

- **`deno audit`** (shipped **Deno 2.6**) scans the whole dependency graph against
  the **GitHub Advisory/CVE database** (and, with `--socket` + `SOCKET_API_KEY`,
  **socket.dev**). Works across **both npm and JSR** deps.
  ([deno.com/blog/v2.6], [docs.deno.com/runtime/reference/cli/audit])
- **`deno audit --fix`** / **`deno audit fix`** automatically upgrades affected
  packages to the **nearest patched version that still satisfies your constraints**
  — i.e. Deno has a built-in equivalent of this project's driver feature.
- `--level=high` gates by severity; advisories can be **filtered by CVE id**
  (suppress accepted risk in CI). `deno ci` / config-level integration exists.

Implication for `lockgraph`: for Deno the **native** remediation path is
real and constraint-aware (unlike Bun's blunt `bun update`). The project's value-add
for Deno is narrower — cross-PM / lockfile-format breadth and the GitHub-advisory
bulk path documented in [`_common.md` §8](../registry/_common.md#8-advisories--audit-api),
not "Deno can't fix vulns natively." (The Bun status is the inverse: Bun's native
remediation is blunt, so the project's value-add there is remediation itself.)

Where deno sits among the cross-PM remediation models — native constraint-preserving
fix, no `--force` — is [`audit-fix.md §4.6`](./audit-fix.md#46-deno--native-constraint-preserving-fix).

---

## Capabilities (vs the Node substrate)

| Capability | Deno default | Notes |
|---|:---:|---|
| `node_modules` tree | **✗** | opt-in `nodeModulesDir` `"auto"`/`"manual"` only |
| Global content-addressed cache | ✓ | `DENO_DIR`; hard-link/clonefile, pnpm-like |
| Import map resolution | ✓ | `deno.json` `imports`/`scopes` (Import Maps std) |
| URL imports | ✓ | sha256-pinned in `deno.lock` `remote` |
| JSR (`jsr:`) native | ✓ | source-served, sha256 |
| npm (`npm:`) | ✓ | npm registry, sha512 SRI, via compat resolver |
| Peer dependencies | **✗** | no peer-dep concept (documented gap) |
| Overrides / resolutions | ~ | npm-style `overrides` **Deno 2.7+**; else import-map / vendor patch |
| Lifecycle scripts | **✗ default** | opt-in `--allow-scripts` + needs a `node_modules` |
| Workspaces / monorepo | ✓ | `deno.json` `workspace` (Deno 1.45+) |
| Vendoring | ✓ | `vendor: true` (Deno 2; was `deno vendor`) |
| Lockfile | ✓ | `deno.lock` v1→v5; auto, frozen, or disabled |
| Native audit + fix | ✓ | `deno audit` / `deno audit fix` (Deno 2.6+) — npm **and** JSR |
| Permission sandbox | ✓ | unique; no `_common.md` analog |

---

## Quirks

- **No tree by default** — the single biggest divergence. A `deno.lock` with only
  `specifiers`/`jsr`/`remote` and **no `node_modules`** is the normal, complete
  state; absence of a layout is not "incomplete."
- **Two integrity models in one lockfile** — sha256 bare-hex (`jsr`, `remote`) vs
  sha512 SRI (`npm`). Do not normalise across them.
- **JSR consumed natively, not via `npm.jsr.io`** — opposite of every other PM; the
  `@jsr/scope__name` mangling from [`jsr.md`](../registry/jsr.md) does **not** apply
  to Deno-native resolution.
- **`deno install` flipped meaning** Deno 1 (global script) → Deno 2 (local dep).
  Reading old docs/scripts will mislead.
- **`nodeModulesDir` default flipped** for `package.json` projects: `auto`(Deno 1)
  → `manual`(Deno 2); boolean form deprecated for the tri-state string.
- **Unprefixed `deno add` name = npm**, not JSR — JSR needs the explicit `jsr:`.
- **No peer deps** — npm packages relying on peer auto-install behave differently
  than under npm/pnpm.
- **Lifecycle scripts need a `node_modules`** — `--allow-scripts` is a no-op in the
  default no-`node_modules` mode.
- **`deno.land/x` is legacy** — URL imports still work but new code is steered to
  JSR; a Deno corpus will mix both eras.

---

## Adapter mapping

No adapter exists. If one is ever built, the shape is **unlike** the Node-family
adapters:

| Concern | Setting / note |
|---|---|
| Manifest parse | `deno.json`/`deno.jsonc` (`imports`/`scopes`/`workspace`) **+** optional `package.json` |
| Graph model | **fuse two graphs** — URL/JSR module graph (no Node analog) + npm sub-graph (`_common.md`-shaped) |
| Integrity | dual model — sha256 bare-hex for `jsr`/`remote`, sha512 SRI for `npm` |
| Layout | usually **none**; if `nodeModulesDir` ≠ `none`, an isolated (`.deno/`) or hoisted Node layout |
| Registry | per-edge: [`npm.md`](../registry/npm.md) for `npm:`, native [`jsr.md`](../registry/jsr.md) for `jsr:`, raw HTTPS for URL |
| Advisories | native `deno audit`/`fix` already constraint-aware — project value-add is breadth, not remediation |

---

## Sources

All research-grade (docs + release notes; **not** live-probed). Dated 2026-06-16
(integrity-verification, workspace focused-install and resolver/PnP-contrast
additions accessed 2026-06-17).

- **Resolution / modules / cache:** [docs.deno.com/runtime/fundamentals/modules](https://docs.deno.com/runtime/fundamentals/modules/) ·
  [docs.deno.com/runtime/packages](https://docs.deno.com/runtime/packages/) ·
  [docs.deno.com/runtime/reference/cli/info](https://docs.deno.com/runtime/reference/cli/info/) ·
  [jsr.io/docs/using-packages](https://jsr.io/docs/using-packages) ·
  [deno.com/blog/your-new-js-package-manager](https://deno.com/blog/your-new-js-package-manager)
- **Node/npm compat, `node_modules`, linker:** [docs.deno.com/runtime/fundamentals/node](https://docs.deno.com/runtime/fundamentals/node/) ·
  [deepwiki.com/denoland/deno — NPM Integration and Resolution](https://deepwiki.com/denoland/deno/) ·
  [deno.com/blog/v2.8](https://deno.com/blog/v2.8) ·
  [deno.com/blog/v1.30 — built-in node: modules](https://deno.com/blog/v1.30) ·
  [deno.com/blog/package-json-support](https://deno.com/blog/package-json-support)
- **Config (`deno.json`), workspaces, vendor, lock:** [docs.deno.com/runtime/fundamentals/configuration](https://docs.deno.com/runtime/fundamentals/configuration/) ·
  [docs.deno.com/runtime/fundamentals/workspaces](https://docs.deno.com/runtime/fundamentals/workspaces/) ·
  [docs.deno.com/runtime/reference/cli/outdated](https://docs.deno.com/runtime/reference/cli/outdated/) (`--filter`/`--recursive`) ·
  [deno.com/blog/v1.19 — vendor](https://deno.com/blog/v1.19) ·
  [deno.com/blog/v1.45 — workspaces](https://deno.com/blog/v1.45)
- **Permissions:** [docs.deno.com/runtime/fundamentals/security](https://docs.deno.com/runtime/fundamentals/security/) ·
  [docs.deno.com/runtime/reference/permissions](https://docs.deno.com/runtime/reference/permissions/) ·
  [deno.com/blog/v2.5 — permissions in config](https://deno.com/blog/v2.5)
- **Lifecycle scripts:** [docs.deno.com/runtime/reference/cli/install](https://docs.deno.com/runtime/reference/cli/install/) ·
  [docs.deno.com/runtime/reference/cli/approve_scripts](https://docs.deno.com/runtime/reference/cli/approve_scripts/) ·
  deno#25841 / #25891 / #27682 (rough edges)
- **Lockfile:** [github.com/denoland/deno_lockfile](https://github.com/denoland/deno_lockfile) (archived → folded into `denoland/deno`) ·
  [deno.com/blog/v2.0-release-candidate — lockfile v4](https://deno.com/blog/v2.0-release-candidate) ·
  [deno.com/blog/v2.3 — lockfile v5](https://deno.com/blog/v2.3) ·
  real corpora: `jsr-io/jsr`, `denoland/dnt`, `denoland/deployctl` `deno.lock`
- **Integrity verification / frozen / `deno ci`:** [docs.deno.com/runtime/fundamentals/dependency_management](https://docs.deno.com/runtime/fundamentals/dependency_management/) ·
  [docs.deno.com/runtime/manual/basics/modules/integrity_checking](https://docs.deno.com/runtime/manual/basics/modules/integrity_checking/) ·
  [deno.com/blog/v2.8 — `deno ci`](https://deno.com/blog/v2.8) ·
  [questions.deno.com — deno.lock integrity/conflict](https://questions.deno.com/m/1326700188860944395) *(community Q&A; corroborating, not primary)*
- **Audit / fix:** [docs.deno.com/runtime/reference/cli/audit](https://docs.deno.com/runtime/reference/cli/audit/) ·
  [deno.com/blog/v2.6](https://deno.com/blog/v2.6) ·
  [deno.com/blog/deno-protects-npm-exploits](https://deno.com/blog/deno-protects-npm-exploits)
- **Migration / version flips:** [docs.deno.com/runtime/reference/migration_guide](https://docs.deno.com/runtime/reference/migration_guide/) ·
  [deno.com/blog/v2.0](https://deno.com/blog/v2.0) ·
  [deno.com/blog/v2.7 — npm overrides](https://deno.com/blog/v2.7)
- **Cross-refs (this repo):** [`spec/pm/_common.md`](./_common.md) (Node substrate) ·
  [`spec/registry/jsr.md`](../registry/jsr.md) · [`spec/registry/npm.md`](../registry/npm.md) ·
  [`spec/registry/_common.md`](../registry/_common.md) · [`spec/formats/_common.md` §3 integrity](../formats/_common.md#3-integrity-model) ·
  `spec/formats/deno.lock.md` *(does not exist — frontier stub)*

## Open questions

> **Open (frontier):**
> - `deno.lock` v5's exact added npm metadata fields — not pinned; needs a v5
>   corpus diff against v4. The v4 sketch above is corroborated by real files; v5
>   deltas are not.
> - The full `npm` section sub-shape (per-package `dependencies` map, optional
>   deps, `os`/`cpu`, bin) — only the top-level structure is pinned here.
> - Whether `--allow-scripts` / `deno approve-scripts` approvals are **persisted**
>   (config? lockfile? a sidecar?) or are per-invocation — unconfirmed.
> - `nodeModulesLinker` `"hoisted"` (2.8) on-disk layout — exact hoist algorithm vs
>   the `"isolated"` `.deno/` default not characterised.
> - npm `overrides` (2.7) precise grammar in `deno.json` — npm-shaped assumed, not
>   verified.
> - Every byte-level claim here is **research-grade**; nothing in this doc is
>   live-probed. Before any `deno.lock` round-trip work, promote §6.1 to a real
>   `spec/formats/deno.lock.md` and probe a current Deno (2.8/2.9) emit.
