# `_common` — the Node.js runtime substrate every package manager extends

> Status: **preview** (Node-doc-grounded, cited) — every non-obvious claim cited
> inline to the official Node.js API docs, version-flagged where behaviour is
> major-gated.
> Updated: 2026-06-16.
> Provenance: **Official** — the Node.js reference docs + the running runtime are
> the spec. Where this contradicts a blog/StackOverflow folk model, the cited
> Node doc wins.
> Layer: **Node mechanics** — *not* a package manager. The baseline a PM mutates.

This is the shared **published** substrate for the package-manager-behavior spec
family under [`spec/pm/`](./). Every per-PM doc (`npm`, `yarn`, `pnpm`, `bun`,
`deno`) references **this** for the Node baseline and then documents only how that
PM **extends** or **mutates** it. There is the Node.js runtime and resolution
mechanics, and there is the package-manager extension on top of it.

So this document is rigorous about exactly one thing: **what the `node` binary
itself does** when it resolves, loads, and runs modules — the substrate that a PM
populates (by writing files into `node_modules`) and/or intercepts (by replacing
the resolver). It deliberately stops where Node stops: it does **not** describe
version selection, fetching, lockfiles, hoisting, or lifecycle orchestration —
those are the *extensions*, enumerated in [§6](#6-what-node-does-not-do) and
specified per-PM.

A per-PM doc MAY narrow (a PM that forbids a Node seam), extend (a PM that adds a
resolver Node has no concept of — yarn PnP), or mutate (a PM that changes the
on-disk shape the algorithm below walks). On any conflict the per-PM doc wins for
that PM and states the divergence explicitly, against the axis template in
[§7](#7-axis-template--what-every-per-pm-doc-covers).

Cross-references: the **on-disk lockfile formats** a PM writes live in
[`spec/formats/`](../formats/); the **registry HTTP contracts** a PM reads to
produce them live in [`spec/registry/`](../registry/). This doc is upstream of
both — it is the runtime that ultimately *consumes* whatever layout a lockfile
materialises.

The reference runtime is **mainline Node.js** (current/LTS). Two module systems
coexist — **CommonJS** (`require`, [§1](#1-module-resolution--commonjs)) and
**ECMAScript modules** (`import`, [§2](#2-module-resolution--esm)) — sharing one
`package.json` contract ([§5](#5-the-packagejson-contract-node-honours)) and one
set of replaceable hook points ([§3](#3-the-resolver-as-a-replaceable-component)).
The resolution algorithms are reproduced from the Node docs' own normative
pseudocode; the all-caps function names below are Node's, verbatim.

---

## §1 Module resolution — CommonJS

`require(X)` from a module at path `Y` runs the algorithm Node specifies in
[`modules.md`][cjs-algo]. Reproduced verbatim (top level):

```text
require(X) from module at path Y
1. If X is a core module, return the core module. STOP.
2. If X begins with '/', set Y to the file system root.
3. If X is '.', or begins with './', '/', or '../':
   a. LOAD_AS_FILE(Y + X)
   b. LOAD_AS_DIRECTORY(Y + X)
   c. THROW "not found"
4. If X begins with '#', LOAD_PACKAGE_IMPORTS(X, dirname(Y))
5. LOAD_PACKAGE_SELF(X, dirname(Y))
6. LOAD_NODE_MODULES(X, dirname(Y))
7. THROW "not found"
```

Three specifier classes fall out of this: **core** (`fs`, or `node:fs` — the
`node:` prefix bypasses the require cache and is mandatory for a few modules such
as `node:test`, `node:sqlite`, `node:sea`); **relative/absolute** (steps 2–3,
path-based); and **bare** (`lodash`, `@scope/pkg/sub` — steps 4–6, the
`node_modules` walk). ([`modules.md`][cjs-algo].)

### 1.1 File resolution — `LOAD_AS_FILE` / extension probe

```text
LOAD_AS_FILE(X)
1. If X is a file, load X as its file-extension format. STOP.
2. If X.js is a file, load it (CJS or ESM per the nearest "type", see §1.4). STOP.
3. If X.json is a file, parse it to an object. STOP.
4. If X.node is a file, load it as a binary addon. STOP.
```

The **extension probe order is `[<exact>, .js, .json, .node]`** — load-bearing and
PM-invisible: an `import`/`require('./util')` with no extension is resolved by
*trying suffixes*, an affordance ESM removes ([§2.1](#21-specifier-classes--the-mandatory-extension-rule)).
([`modules.md`][cjs-algo].)

### 1.2 Directory resolution — `LOAD_AS_DIRECTORY`, `main`, index fallback

```text
LOAD_AS_DIRECTORY(X)
1. If X/package.json is a file:
   a. parse it, look for "main"
   b. if "main" is falsy, GOTO 2
   c. let M = X + main; LOAD_AS_FILE(M); LOAD_INDEX(M); LOAD_INDEX(X) [DEPRECATED]; THROW
2. LOAD_INDEX(X)

LOAD_INDEX(X): try X/index.js, then X/index.json, then X/index.node.
```

So a directory resolves via its `package.json` `"main"`, and **falls back to
`index.{js,json,node}`** when `main` is absent/falsy. (The `LOAD_INDEX(X)` after a
*failed* `main` is flagged DEPRECATED in the algorithm itself.)
([`modules.md`][cjs-algo].)

### 1.3 The `node_modules` walk — `LOAD_NODE_MODULES` / `NODE_MODULES_PATHS`

This is the mechanism a flat/hoisted PM layout targets:

```text
LOAD_NODE_MODULES(X, START)
1. Split X into NAME (maybe @scope/-prefixed) and SUBPATH.
2. DIRS = NODE_MODULES_PATHS(START)
3. for each DIR in DIRS:
   a. LOAD_PACKAGE_EXPORTS(SUBPATH, DIR/NAME)   # §1.5 — honours "exports"
   b. LOAD_AS_FILE(DIR/X)
   c. LOAD_AS_DIRECTORY(DIR/X)

NODE_MODULES_PATHS(START)
1. PARTS = path-split(START)
2. walk I from the deepest segment up to the root:
   - skip a segment already named "node_modules"
   - else append  join(PARTS[0..I], "node_modules")
3. return DIRS + GLOBAL_FOLDERS
```

The walk-up is the whole game: `require('x')` from
`/app/node_modules/a/node_modules/b/index.js` probes
`/app/node_modules/a/node_modules/b/node_modules/x`, then `…/a/node_modules/x`,
then `/app/node_modules/x`, then `GLOBAL_FOLDERS`. **A PM's "linking layout"
([§7](#7-axis-template--what-every-per-pm-doc-covers), axis 2) exists precisely to
make this walk succeed** — npm/yarn-classic *flatten* packages high enough that
the walk finds them; pnpm builds a symlinked store the walk traverses; yarn PnP
*deletes* the walk and substitutes a table ([§3](#3-the-resolver-as-a-replaceable-component)).
([`modules.md`][cjs-algo].)

### 1.4 CJS↔ESM determination inside the walk

When `LOAD_AS_FILE` lands on a `.js`, Node finds the **closest package scope**
(nearest enclosing `package.json`) and reads `"type"`: `"module"` ⇒ load as ESM,
`"commonjs"`/absent ⇒ load as CJS. `.mjs` is always ESM, `.cjs` always CJS,
`.json` is JSON, `.node` is a native addon. (Same rule the ESM side uses,
[§2.2](#22-the-type-field--file-format-determination).) ([`modules.md`][cjs-algo],
[`packages.md`][pkg-type].)

### 1.5 `exports`/`imports`/`self` are honoured in CJS too

Steps 1.3a / 4 / 5 above call into the **ESM** resolver's
`PACKAGE_EXPORTS_RESOLVE` / `PACKAGE_IMPORTS_RESOLVE`: the `"exports"` map,
`"imports"` map (`#`-specifiers), and package self-reference are enforced for
`require()` *and* `import` — they are **not** an ESM-only feature. The difference
is only the **conditions** applied: CJS requests resolve with
`["node", "require", "module-sync"]` (the `module-sync` condition dropped under
`--no-require-module`), ESM requests with `["node", "import"]` (plus defaults).
([`modules.md`][cjs-algo], [`packages.md`][pkg-cond].)

### 1.6 The require cache, `NODE_PATH`, realpath

- **`require.cache` (`Module._cache`)** — keyed by resolved absolute filename;
  deleting a key forces a reload on next `require` (does not apply to native
  addons). ([`modules.md`][cjs-cache].)
- **`NODE_PATH`** — a `:`-separated (`;` on Windows) list searched as a fallback,
  folded into `GLOBAL_FOLDERS`. The docs explicitly call it a **legacy** seam:
  *"still supported, but is less necessary now that the Node.js ecosystem has
  settled on a convention for locating dependent modules."* PMs do not rely on it;
  it remains a coarse override. ([`modules.md`][cjs-nodepath].)
- **realpath / symlinks** — by default Node **dereferences symlinks** and uses the
  on-disk *real path* as both the module-cache key and the root for the *next*
  `node_modules` walk. `--preserve-symlinks` makes Node keep the **symlink path**
  instead (cache key stays the realpath; `__dirname`/resolution use the link
  path). This flag is the hinge for **symlink-based layouts** — its default
  (dereference) is why a naïvely symlinked tree resolves a dependency's
  dependencies from the *target's* location, and why pnpm's nested-symlink store
  is engineered around it. `--preserve-symlinks` deliberately does **not** cover
  the entry/main module; `--preserve-symlinks-main` opts that in separately (split
  for backward compat). ([`cli.md`][cli-presym].)

---

## §2 Module resolution — ESM

`import` resolution is specified in [`esm.md`][esm-doc] / [`packages.md`][pkg-doc],
with the normative pseudocode (`ESM_RESOLVE`, `PACKAGE_RESOLVE`,
`PACKAGE_SELF_RESOLVE`, `PACKAGE_EXPORTS_RESOLVE`, `PACKAGE_IMPORTS_RESOLVE`,
`PACKAGE_TARGET_RESOLVE`, `ESM_FILE_FORMAT`) in the
[Resolution Algorithm appendix][esm-resolve-algo]. The package-walk (`PACKAGE_RESOLVE`
→ `node_modules` ascent) mirrors CJS [§1.3](#13-the-node_modules-walk--load_node_modules--node_modules_paths);
the divergences are below.

### 2.1 Specifier classes & the mandatory-extension rule

Three classes ([`esm.md`][esm-spec]):

| Class | Example | Note |
|-------|---------|------|
| **relative** | `'./startup.js'`, `'../cfg.mjs'` | **file extension is mandatory** |
| **bare** | `'pkg'`, `'pkg/feature'` | resolves via `node_modules` + `"exports"`; extension needed only for packages **without** `"exports"` |
| **absolute URL** | `'file:///opt/x.js'`, `'node:fs'`, `'data:…'` | a full URL |

The hard rule that trips every CJS→ESM port: **ESM does not probe extensions and
does not resolve directory `index.*`.** `import './util'` and
`import './startup/'` both fail — *"A file extension must be provided … Directory
indexes … must also be fully specified."* This is the single largest behavioural
gap between the two resolvers and is **Node's**, not a PM's. ESM accepts
`file:`, `node:`, and `data:` URL schemes (`data:` only resolves bare-builtin and
absolute specifiers — relative fails, `data:` not being a "special" scheme).
([`esm.md`][esm-spec].)

### 2.2 The `"type"` field & file-format determination

`ESM_FILE_FORMAT` decides per file: `.mjs` ⇒ `module`, `.cjs` ⇒ `commonjs`,
`.json` ⇒ JSON; `.js`/extensionless ⇒ whatever the **nearest `package.json`
`"type"`** says (`"module"` ⇒ ESM, `"commonjs"`/absent ⇒ CJS). `--input-type` /
`--experimental-default-type` cover the inputs that have no file (e.g. `--eval`,
stdin). When no marker is present Node may **syntax-detect** ESM in the source.
([`packages.md`][pkg-type], [`esm.md`][esm-type].)

### 2.3 `"exports"` — conditions, subpaths, encapsulation

The `"exports"` field ([`packages.md`][pkg-exports]) is the modern entry-point
contract and **takes precedence over `"main"`** when a package is imported by
name. Three powers:

**(a) Subpaths.** `"."` is the main entry; `"./feature"` etc. define additional
public entry points. **Encapsulation:** once `"exports"` exists, *only* the listed
subpaths are importable — deep paths into the package (`pkg/lib/internal.js`) are
**blocked** even though the file exists on disk. This is a Node-enforced wall a PM
cannot loosen.

**(b) Conditions (conditional exports).** A subpath may map to an object keyed by
**condition**, resolved **in key order** (object order is significant). Node's
built-in conditions, in documented priority:

| Condition | Matches |
|-----------|---------|
| `node-addons` | Node with native-addon support |
| `node` | any Node environment |
| `import` | resolution via `import` / `import()` |
| `require` | resolution via `require()` |
| `module-sync` | a loader with no top-level await (require-of-ESM, [§2.5](#25-cjsesm-interop)) |
| `default` | unconditional fallback — **must be last** |

`import`/`require` are **mutually exclusive** for a given request: an `import`
request never sees the `require` branch and vice-versa. **Custom** conditions are
added with `--conditions` / `-C` (`node -C development app.js`); the built-ins
`node`/`default`/`import`/`require` always apply on top.
([`packages.md`][pkg-cond], [`cli.md`][cli-cond].) **Tooling beyond Node reads
its own conditions** off the same map — bundlers honour `browser`/`development`/
`production`/`types`, none of which Node itself resolves; that the field is a
*convention surface* wider than the runtime is itself a Node fact worth stating.

**(c) Subpath patterns.** `"./features/*.js": "./src/features/*.js"` maps a family
of subpaths via `*` substitution; a `null` target excludes specific matches. The
`*` is a literal string splice, not a glob. ([`packages.md`][pkg-patterns].)

### 2.4 `"imports"` — private internal specifiers

The `"imports"` field maps **`#`-prefixed** specifiers, resolvable **only inside
the defining package** (`import db from '#db'`). Entries must start with `#`; they
may themselves be conditional, and commonly fork an internal dependency by
`node`/`default` or `import`/`require`. This is Node's native answer to the
"internal alias" a bundler would otherwise provide.
([`packages.md`][pkg-imports].)

### 2.5 Self-reference & CJS↔ESM interop

- **Self-reference.** A package can import **itself by name** (`import x from
  'my-pkg'`) and resolve through its own `"exports"`, iff `"exports"` is defined —
  the same map external consumers see. (`PACKAGE_SELF_RESOLVE`.)
  ([`packages.md`][pkg-self].)
- **`import` of CommonJS.** A CJS module imported from ESM is wrapped in a
  namespace whose **`default` export is `module.exports`**; additionally Node runs
  a **best-effort static analysis** ([`cjs-module-lexer`][cjs-lexer]) over the CJS
  source to surface **named exports** (`import { each } from './cjs.cjs'`). Named
  exports are heuristic — transpiled/computed exports may be missed and need the
  `default`-then-destructure form. ([`esm.md`][esm-interop].)
- **`require()` of ESM** — the interop direction that *moved*. Historically
  `require()` of an ES module threw `ERR_REQUIRE_ESM`. Node **22** added
  synchronous `require()` of ESM (graphs without top-level await) behind
  `--experimental-require-module`, **unflagged in v22.12 (LTS) and v23** (the
  `module-sync` condition exists to serve exactly this loader). A module with
  **top-level await** still throws `ERR_REQUIRE_ASYNC_MODULE` — `require` is
  synchronous and cannot await. ([Node 23 release notes][n23], [Cheung,
  *require(esm)*][joyee]; mechanism per [`esm.md`][esm-interop].)
  > **Version-flagged.** Treat "`require(esm)` works" as **true on ≥22.12 / 23**,
  > false below. A PM doc whose PM bundles/targets an older Node must say so.
- **`module.createRequire(filename)`** constructs a CJS `require` from within ESM
  (the supported way to reach CJS-only resolution semantics from an ES module).
  ([`module.md`][mod-createrequire].)

### 2.6 `import.meta`

`import.meta.url` is the module's absolute `file:` URL; **`import.meta.resolve(spec)`**
resolves a specifier against the current module and **returns a string
synchronously** (since v20.6.0 / v18.19.0 — previously a Promise; unavailable
inside customization hooks, where it would deadlock). `import.meta.dirname` /
`import.meta.filename` (stable v22.16 / v24) are the ESM analogues of
`__dirname` / `__filename`. ([`esm.md`][esm-importmeta].)

---

## §3 The resolver as a REPLACEABLE component — the hook points PMs use

**This is the crux of the whole family.** Node's resolver is not sealed: it
exposes documented seams at which resolution can be **intercepted, augmented, or
wholesale replaced**. A package manager that does not materialise a real
`node_modules` (yarn PnP) survives *only* because these seams exist. Enumerated,
most-supported first:

### 3.1 CommonJS preload — `--require` / `-r`

`node --require ./preload.cjs app.js` runs `preload.cjs` **before** the entry,
following `require()` resolution; it loads into the main thread **and every worker
/ forked / clustered child**. A preload script can therefore install a CJS
resolver patch (§3.3) before any application `require` fires. Permitted inside
`NODE_OPTIONS` ([§4](#4-runtime--environment)). This is the original PnP install
hook for the CJS world (`.pnp.cjs` is wired in via a `--require`-style preload).
([`cli.md`][cli-require].)

### 3.2 ESM customization hooks — `module.register` / `register()` (+ `--loader`)

The modern, **supported** ESM seam, replacing the deprecated `--loader`:

- **`module.register(specifier[, parentURL][, options])`** (added **v20.6.0 /
  v18.19.0**) registers a hooks module that runs on a **dedicated off-thread**
  loader; hooks are async and isolated (communicate by `MessagePort`). Must run
  **before** application code — the canonical invocation is
  `node --import ./register-hooks.mjs app.js` (so registration precedes the first
  `import`). ([`module.md`][mod-register].)
- **`module.registerHooks(options)`** (added **v22.15.0**) registers
  **synchronous, on-thread** hooks that run in the same realm as application code
  (can touch globals directly) — the in-thread counterpart for cases the off-thread
  model can't serve. ([`module.md`][mod-registerhooks].)

Hook surface (both forms):

| Hook | Signature | Returns |
|------|-----------|---------|
| `initialize` | `initialize(data)` | — (once, at registration) |
| `resolve` | `resolve(specifier, context, nextResolve)` | `{ url, format?, shortCircuit?, importAttributes? }` |
| `load` | `load(url, context, nextLoad)` | `{ format, source, shortCircuit? }` |

`context` carries **`conditions`**, **`importAttributes`**, **`parentURL`** (resolve)
/ `format`, `conditions`, `importAttributes` (load). Hooks **chain**: each calls
`nextResolve`/`nextLoad` to defer to the next-registered hook (LIFO), or returns
`shortCircuit: true` to terminate the chain. Omitting *both* the `next` call and
`shortCircuit` is an error. A `resolve` hook can rewrite a bare specifier to any
`file:`/`data:`/`node:` URL; a `load` hook can synthesise source — together they
can serve modules from a zip, a database, or a virtual FS with **no
`node_modules` on disk**. ([`module.md`][mod-hooks].)

> **Deprecated alias.** `--loader` / `--experimental-loader <mod>` still works but
> the docs **discourage** it: *"may be removed in a future version … Please use
> `--import` with `register()` instead."* It also requires `--allow-worker` under
> the Permission Model. Per-PM docs should describe the **`register()`** form and
> note the legacy flag only for old toolchains. ([`cli.md`][cli-loader].)

### 3.3 Monkey-patching the CJS internals

The **CommonJS** resolver has no public hook equivalent to `register()`, so PnP-CJS
and instrumentation tools **monkey-patch `node:module` internals** from a preload
([§3.1](#31-commonjs-preload----require---r)):

- **`Module._resolveFilename(request, parent, isMain, options)`** — the central
  CJS resolution entry; overriding it replaces the entire
  [§1](#1-module-resolution--commonjs) walk with arbitrary logic (this is exactly
  what yarn-PnP's `.pnp.cjs` does for `require`).
- **`Module._load(request, parent, isMain)`** — the load entry above the cache;
  patched to intercept what a resolved id returns.
- **`Module._extensions[...]` / `Module._cache`** — the per-extension compiler map
  and the resolved-id cache.

These are **underscore-prefixed, semi-private** — stable enough in practice that
the ecosystem depends on them, but **not** a guaranteed API; the docs steer new
code to `register()`/`registerHooks`. **`require.extensions`** is the one
*documented* member here and is explicitly **deprecated** (*"Avoid using
`require.extensions`"*). A per-PM doc that relies on `_resolveFilename` should flag
it as an unsupported-but-load-bearing seam. ([`modules.md`][cjs-reqext], landed
ecosystem practice.)

### 3.4 `NODE_OPTIONS` as the ambient injection channel

Because `--require`, `--import`, `--loader`, and `--conditions` are all permitted
inside **`NODE_OPTIONS`** ([§4](#4-runtime--environment)), a PM (or a `.npmrc` /
shell shim) can install its resolver seam **without controlling the `node`
invocation** — set `NODE_OPTIONS="--require /path/.pnp.cjs"` (or `--import` for the
ESM hooks) in the environment and every child `node` picks it up. This is the
mechanism behind "it just works in every script" for PnP-style PMs.
([`cli.md`][cli-nodeopts].)

> **Security note (substrate-level).** Every seam in this section is also an
> **arbitrary-code-execution** seam: `NODE_OPTIONS=--require evil.js`, a malicious
> `--loader`, or a tampered `.pnp.cjs` runs before app code. That the resolver is
> replaceable is the family's enabling power **and** its supply-chain attack
> surface; per-PM docs note where a PM widens or narrows it.

---

## §4 Runtime & environment

The substrate around resolution — what `node` reads from the environment, how a
PM's tools become runnable, and the global-vs-local boundary.

### 4.1 The `node` binary & preload ordering

`node [options] entry.js`. Preload order is **`--require` modules first, then
`--import` modules**, each in declaration order, with those from `NODE_OPTIONS`
ahead of command-line ones; only then does the entry run.
([`cli.md`][cli-import].)

### 4.2 `NODE_OPTIONS` — the env-var option channel & its allowlist

`NODE_OPTIONS` injects command-line options via the environment; **command-line
options take precedence** over it. It is **not** a free pass — Node enforces a
**source-level allowlist**, and a disallowed option aborts startup with
`… is not allowed in NODE_OPTIONS`. Resolver-relevant options **on** the
allowlist: `--require`/`-r`, `--import`, `--loader`/`--experimental-loader`,
`--conditions`/`-C`, `--preserve-symlinks`, `--preserve-symlinks-main`. Notably
**off** it: `-e`/`--eval`, `--env-file` (and assorted profiling/`-p` options) —
options that would change *what program runs* rather than *how modules load*.
([`cli.md`][cli-nodeopts].)
> **Mild Open.** The exact allowlist is defined in Node's source and shifts across
> majors; the resolver-relevant members above are confirmed via their own flag
> docs (each references `NODE_OPTIONS`) and the landed allowlist, but a per-PM doc
> pinning behaviour on a specific Node version should re-confirm against that
> version's `cli.md`.

### 4.3 `--conditions` / `-C`, `NODE_PATH`

`--conditions name` (`-C name`) injects a **custom** export/import condition
([§2.3](#23-exports--conditions-subpaths-encapsulation)); the built-in
`node`/`default`/`import`/`require` always also apply. `NODE_PATH`
([§1.6](#16-the-require-cache-node_path-realpath)) is the legacy global fallback,
disableable via `--no-global-search-paths`. ([`cli.md`][cli-cond].)

### 4.4 `bin` shims & `PATH` — how a package's executable runs

A package's `"bin"` ([§5](#5-the-packagejson-contract-node-honours)) becomes a
runnable command because the **PM** materialises a shim in
**`node_modules/.bin/`** (POSIX: a symlink to the target script; Windows: a
`.cmd` + a bare shell script + a `.ps1` trio). This is a **PM convention, not a
Node mechanism** — Node neither reads `"bin"` nor populates `.bin`. The runtime's
only role is being on the far side of the shim. PMs then prepend
`node_modules/.bin` (and parent `.bin` dirs walking up) to **`$PATH`** when
running scripts, so a script can invoke a dependency's CLI by bare name.
([`packages.md`][pkg-bin]; shim/`.bin` behaviour is PM-side — cited per-PM.)

### 4.5 Global vs local, and `npx`-style execution

Node itself has no "project" concept — only a cwd and the `node_modules` walk from
the entry's directory. The **global vs local** split (a global install dir vs a
project's `node_modules`) and **ephemeral execution** (`npx pkg`, `yarn dlx`,
`pnpm dlx`, `bunx` — fetch-if-absent then run a package's `bin`) are **entirely
PM-layer**: each resolves a package, ensures its `bin`, prepends `.bin` to `PATH`,
and spawns. They are listed here only to mark them **out of substrate scope** and
into the per-PM **environment** axis. The one Node primitive underneath is the
`bin` shim + `PATH` of [§4.4](#44-bin-shims--path--how-a-packages-executable-runs).

---

## §5 The `package.json` contract Node honours

`package.json` is a shared file; **only some fields are Node's** — the rest are PM
or tooling convention. The split matters because a per-PM doc must say which fields
its PM *adds meaning to* on top of Node.

| Field | Node honours it? | Role |
|-------|:----------------:|------|
| `"type"` | **yes** | `.js` ⇒ ESM/CJS for the scope ([§2.2](#22-the-type-field--file-format-determination)) |
| `"exports"` | **yes** | entry points + conditions + encapsulation; **beats `"main"`** ([§2.3](#23-exports--conditions-subpaths-encapsulation)) |
| `"imports"` | **yes** | `#`-internal specifiers ([§2.4](#24-imports--private-internal-specifiers)) |
| `"main"` | **yes** | legacy CJS entry, used iff no `"exports"` ([§1.2](#12-directory-resolution--load_as_directory-main-index-fallback)) |
| `"name"` | **yes** | enables self-reference ([§2.5](#25-self-reference--cjsesm-interop)); identity |
| `"bin"` | **partly** | Node ignores it; PMs build `.bin` shims ([§4.4](#44-bin-shims--path--how-a-packages-executable-runs)) |
| `"module"` | **no** | bundler-only "ESM entry" convention — **Node never reads it** |
| `"engines"` | **no** | advisory; **PMs** enforce/warn, Node does not |
| `"browser"` | **no** | bundler field |
| `"dependencies"` & kin | **no** | **PM-only** — Node never fetches; see [§6](#6-what-node-does-not-do) |
| `"scripts"` | **no** | **PM-only** lifecycle; Node never runs them |
| `"workspaces"` | **no** | **PM-only** monorepo glob |

The headline traps: **`"module"` is *not* a Node field** (a frequent folk error —
only `"exports"`/`"main"` drive Node), and **`"engines"` is advisory to Node**
(only PMs act on it). Everything in the bottom rows is the **extension surface**:
Node defines the *shape* of `package.json` it reads, PMs overload the rest.
([`packages.md`][pkg-doc].)

---

## §6 What Node does NOT do (and thus what PMs must add)

Node resolves and runs modules that **already exist** on disk in a shape its
algorithm understands. Everything required to *get them there and keep them
consistent* is the package-manager extension — the reason this family exists:

| Node does **not** | The PM must add (axis) | Specified in |
|-------------------|------------------------|--------------|
| **version selection / semver** | satisfy ranges → concrete versions | per-PM resolution; [`spec/registry/`](../registry/) |
| **fetch / install** | download + unpack tarballs into a layout | per-PM linking; [`spec/registry/`](../registry/) |
| **lockfiles** | pin the resolved graph deterministically | **[`spec/formats/`](../formats/)** |
| **dedup / hoisting / store layout** | shape `node_modules` so the §1.3 walk succeeds | per-PM linking-layout |
| **lifecycle scripts** | run `pre/post`-`install`, `prepare`, etc. | per-PM lifecycle |
| **workspaces / monorepo** | link local packages, share a single tree | per-PM linking-layout |
| **peer-dependency enforcement** | check/auto-install/warn on peers | per-PM resolution |
| **overrides / resolutions / patches** | force a version or mutate a package post-fetch | per-PM resolution/linking |

Node provides the **target** (a resolvable `node_modules` *or* a replaced resolver,
[§3](#3-the-resolver-as-a-replaceable-component)) and the **conventions** (the
`package.json` fields of [§5](#5-the-packagejson-contract-node-honours)); the PM
provides **the graph, the bytes, the layout, and the determinism**. The on-disk
artefact of that work is the lockfile ([`spec/formats/`](../formats/)); the wire
source is the registry ([`spec/registry/`](../registry/)). This doc is the runtime
those two ultimately feed.

---

## §7 Axis template — what every per-PM doc covers

To keep `npm` / `yarn` / `pnpm` / `bun` / `deno` uniform and diff-able, each
per-PM doc documents **the same six axes**, each phrased as *"how this PM extends
or mutates the Node baseline"*:

| # | Axis | The Node baseline it extends/mutates | Anchor |
|---|------|--------------------------------------|--------|
| 1 | **Resolution** | semver/range → concrete version; tags, peers, overrides — the selection Node lacks ([§6](#6-what-node-does-not-do)) | [`spec/registry/`](../registry/) |
| 2 | **Linking-layout** | the on-disk shape feeding §1.3 / §1.6: flat-hoist · nested-symlink store · **PnP (no `node_modules`)** · global CAS | this doc §1, §3 |
| 3 | **Resolver-mutation** | which §3 seam (if any) the PM installs — `--require` patch, `register()` hooks, `_resolveFilename` override, or *none* | this doc [§3](#3-the-resolver-as-a-replaceable-component) |
| 4 | **Environment** | `bin`/`.bin`/`PATH` shimming, `NODE_OPTIONS` injection, global-vs-local, `npx`/`dlx`/`bunx` | this doc [§4](#4-runtime--environment) |
| 5 | **Lifecycle** | install scripts, `prepare`, ordering, sandboxing, the script-`PATH` ([§4.4](#44-bin-shims--path--how-a-packages-executable-runs)) | this doc §4, §6 |
| 6 | **Lockfile + registry** | the format the PM emits and the registry contract it reads | **[`spec/formats/`](../formats/)** · **[`spec/registry/`](../registry/)** |

A per-PM doc SHOULD address all six (stating "baseline, unchanged" where it adds
nothing — e.g. npm leaves the resolver unmutated, axis 3 = *none*). Axes 1 and 6
mostly **point** at the formats/registry specs rather than re-deriving them; axes
2–5 are where a PM's real divergence from Node lives and where the prose belongs.

---

## Sources

All Node behaviour is cited to the official API docs (the `nodejs/node` `doc/api/`
markdown, which renders to `nodejs.org/api/*`); version gates to release notes /
implementer write-ups. Folk models (blogs, SO) were used only to *locate*
canonical text, never as the authority.

- **CommonJS** — [`modules.md`][cjs-algo] (the `require(X)` algorithm,
  `LOAD_AS_FILE`/`LOAD_AS_DIRECTORY`/`LOAD_NODE_MODULES`/`NODE_MODULES_PATHS`,
  `require.cache`, `NODE_PATH` legacy note, `require.extensions` deprecation).
- **ESM** — [`esm.md`][esm-doc] (specifier classes, mandatory extensions, interop,
  `import.meta`) + the [Resolution Algorithm appendix][esm-resolve-algo]
  (`ESM_RESOLVE` … `ESM_FILE_FORMAT`).
- **Packages** — [`packages.md`][pkg-doc] (`"type"`, `"exports"`, `"imports"`,
  conditions list + order, subpath patterns, self-reference, `"main"` precedence,
  `"bin"`; the `"module"`-is-not-Node and `"engines"`-is-advisory facts).
- **`node:module` API** — [`module.md`][mod-register] (`module.register` added
  v20.6.0/v18.19.0; `module.registerHooks` added v22.15.0; the
  `resolve`/`load`/`initialize` hook signatures, chaining, `createRequire`,
  `isBuiltin`, `builtinModules`).
- **CLI / env** — [`cli.md`][cli-nodeopts] (`NODE_OPTIONS` allowlist,
  `--require`/`-r`, `--import`, `--loader`/`--experimental-loader` deprecation,
  `--conditions`/`-C`, `--preserve-symlinks`/`--preserve-symlinks-main`).
- **`require(esm)` version gate** — [Node 23.0.0 release notes][n23] +
  [Joyee Cheung, *require(esm) in Node.js: from experiment to stability*][joyee]
  (experimental in 22, unflagged in **22.12/23**, `ERR_REQUIRE_ASYNC_MODULE` for
  top-level await).
- **Interop static analysis** — [`cjs-module-lexer`][cjs-lexer] (named-export
  detection over CJS source).

> **Note on access.** `nodejs.org` was unreachable from the build environment
> (enterprise fetch policy); the docs above were read from the **canonical
> `nodejs/node` repo markdown** (`raw.githubusercontent.com/nodejs/node/.../doc/api/*.md`)
> — the *same source text* that renders to `nodejs.org/api`. Anchors below point at
> the rendered docs for the reader.

[cjs-algo]: https://nodejs.org/api/modules.html#all-together
[cjs-cache]: https://nodejs.org/api/modules.html#requirecache
[cjs-nodepath]: https://nodejs.org/api/modules.html#loading-from-the-global-folders
[cjs-reqext]: https://nodejs.org/api/modules.html#requireextensions
[esm-doc]: https://nodejs.org/api/esm.html
[esm-spec]: https://nodejs.org/api/esm.html#terminology
[esm-type]: https://nodejs.org/api/esm.html#enabling
[esm-interop]: https://nodejs.org/api/esm.html#interoperability-with-commonjs
[esm-importmeta]: https://nodejs.org/api/esm.html#importmeta
[esm-resolve-algo]: https://nodejs.org/api/esm.html#resolution-algorithm-specification
[pkg-doc]: https://nodejs.org/api/packages.html
[pkg-type]: https://nodejs.org/api/packages.html#type
[pkg-exports]: https://nodejs.org/api/packages.html#exports
[pkg-cond]: https://nodejs.org/api/packages.html#conditional-exports
[pkg-patterns]: https://nodejs.org/api/packages.html#subpath-patterns
[pkg-imports]: https://nodejs.org/api/packages.html#imports
[pkg-self]: https://nodejs.org/api/packages.html#self-referencing-a-package-using-its-name
[pkg-bin]: https://nodejs.org/api/packages.html#package-entry-points
[mod-register]: https://nodejs.org/api/module.html#moduleregisterspecifier-parenturl-options
[mod-registerhooks]: https://nodejs.org/api/module.html#moduleregisterhooksoptions
[mod-hooks]: https://nodejs.org/api/module.html#customization-hooks
[mod-createrequire]: https://nodejs.org/api/module.html#modulecreaterequirefilename
[cli-nodeopts]: https://nodejs.org/api/cli.html#node_optionsoptions
[cli-require]: https://nodejs.org/api/cli.html#-r---require-module
[cli-import]: https://nodejs.org/api/cli.html#--importmodule
[cli-loader]: https://nodejs.org/api/cli.html#--experimental-loadermodule
[cli-cond]: https://nodejs.org/api/cli.html#-c-condition---conditionscondition
[cli-presym]: https://nodejs.org/api/cli.html#--preserve-symlinks
[cjs-lexer]: https://github.com/nodejs/cjs-module-lexer
[n23]: https://nodejs.org/en/blog/release/v23.0.0
[joyee]: https://joyeecheung.github.io/blog/2025/12/30/require-esm-in-node-js-from-experiment-to-stability/
