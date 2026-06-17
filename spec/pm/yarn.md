# `yarn` — Yarn package manager (classic v1 + berry v2+)

> Status: **preview** (docs+source-grounded) — yarnpkg.com docs + `yarnpkg/berry`
> source; web-sourced 2026-06-16.
> Updated: 2026-06-16.
> Provenance: **Source-only** — yarnpkg.com docs + the `yarnpkg/berry`
> source are authoritative; classic is `classic.yarnpkg.com` + the frozen
> `yarnpkg/yarn` v1 parser. No single normative "yarn spec" exists; the
> running installer is the spec, and (uniquely for berry) the
> [PnP Specification](https://yarnpkg.com/advanced/pnp-spec) is published.
> Family: **two lineages** — `yarn-classic` (v1, maintenance/legacy) and
> `yarn-berry` (v2/v3/v4, active). They share a name and a CLI surface and
> almost nothing else.

This is a **behavior spec for the package manager**, not for its lockfile
(those live under [`spec/formats/`](../formats/) — `yarn-classic.md`,
`yarn-berry-v3.md` … `yarn-berry-v10.md`) nor for its registry transport
(that is [`spec/registry/`](../registry/) — `yarn-mirror.md`, `npm.md`).
It records what yarn does to the **Node.js resolution substrate**: how it
lays packages on disk, and — for berry — how it *replaces Node's module
resolver wholesale*. The Node substrate that yarn extends is
[`_common.md`](./_common.md); this doc records only yarn's deviations from
it.

> **The one load-bearing fact.** Classic yarn is an npm-shaped installer: it
> writes a flat, hoisted `node_modules/` that stock Node resolves with its
> normal directory walk. **Berry's default linker (PnP) deletes that
> substrate entirely** — there is no `node_modules`, and Node's resolver is
> swapped for a generated lookup table (`.pnp.cjs`). Berry is the family's
> headline example of **resolver mutation** ([§3](#3-resolver-mutation--the-centerpiece)),
> and everything else about berry (zip cache, virtual packages, strictness,
> SDKs) falls out of that one decision.

## Lineage map

| | **yarn classic** | **yarn berry** |
|---|---|---|
| semver | `>=1 <2` (1.22.x is the last) | `>=2` (v2/v3/v4; internal lockfile schema versions ≠ release majors) |
| status | maintenance / "Classic"; frozen 2020 | active trunk (`yarnpkg/berry`) |
| config file | `.yarnrc` (custom kv) | `.yarnrc.yml` (YAML) |
| default layout | **hoisted `node_modules/`** | **PnP, no `node_modules/`** |
| lockfile | `yarn.lock` v1 (custom grammar) | `yarn.lock` v2+ (true YAML / SYML) |
| Node resolver | **stock** (directory walk) | **replaced** (PnP) by default |
| distribution | single global binary | per-repo binary in `.yarn/releases/`, pinned by `yarnPath` / Corepack |

Cite version-specific behaviour explicitly: where this doc says "berry"
unqualified it means current (v4) behaviour, and a v2/v3 divergence is
flagged inline. Releases vs lockfile schema versions are independent — a
yarn 4 release can emit `__metadata.version: 8`; the mapping is in the
[format specs](../formats/).

---

## 1. Resolution

### 1.1 Classic (v1)

Classic resolves like **npm v3**: it walks `dependencies` /
`devDependencies` / `optionalDependencies`, applies semver against the
registry, and records the result in `yarn.lock` v1. The lockfile's
distinguishing trait is **multi-range merge**: every descriptor that
resolves to the same version is folded under one comma-joined entry —

```
"foo@^1.0.5", "foo@~1.0.5":
  version "1.0.7"
  resolved "https://registry.yarnpkg.com/foo/-/foo-1.0.7.tgz#…"
  integrity sha512-…
```

so the v1 lockfile is keyed by **descriptor-set → resolution**, not by
install path. There is no `peerDependencies` virtualization: classic emits
peer-dep *warnings* and otherwise leans on hoisting to satisfy them, exactly
as npm did pre-v7. Grammar and field schedule:
[`spec/formats/yarn-classic.md`](../formats/yarn-classic.md).

### 1.2 Berry — descriptors, locators, idents

Berry formalizes resolution into three objects
([Lexicon](https://yarnpkg.com/advanced/lexicon)):

- **Ident** — name (+ scope), e.g. `lodash`, `@babel/core`.
- **Descriptor** — ident + **range**, e.g. `lodash@^1.0.0`. Identifies a
  *set* of candidate packages (the input to resolution).
- **Locator** — ident + **reference**, e.g. `lodash@npm:1.2.3`. Identifies
  a *single unique* package (the output of resolution). Locators carry an
  extra comparator hash, which is how virtual instances stay distinct
  ([§1.5](#15-peer-dependency-virtualization-virtual-locators)).

A **Resolver** turns descriptors into locators and extracts manifests; a
**Fetcher** turns a locator's reference into package data
([Lexicon](https://yarnpkg.com/advanced/lexicon)). Each protocol
([§1.4](#14-protocols)) plugs in its own resolver+fetcher pair.

### 1.3 `resolutions` field

Both lineages honour the top-level `resolutions` field in `package.json`
to force a transitive dependency to a chosen version (a yarn extension that
predates npm `overrides`). Berry additionally exposes
**`packageExtensions`** in `.yarnrc.yml` to *add* missing
dependencies/peerDependencies to third-party manifests without forking them
— the supported way to repair under-declared packages that PnP's
strictness ([§3.4](#34-strictness--undeclared-dependency-errors)) would
otherwise reject.

### 1.4 Protocols (berry)

Berry's reference is a fully-qualified locator whose reference is
prefixed by a **protocol**. The default (a bare semver range) is the
`npm:` protocol. The full set
([yarnpkg.com/protocols](https://yarnpkg.com/protocols)):

| Protocol | Form | Points at | On-disk effect |
|---|---|---|---|
| `npm:` | `npm:^1.0.0`, `npm:name@range` (alias) | registry | fetched archive in cache |
| *(default)* | `^1.0.0` | registry (= `npm:`) | as above |
| `workspace:` | `workspace:^`, `workspace:*`, `workspace:path` | a sibling workspace in the monorepo | symlink/`SOFT` link; the range token rewrites the *published* dep range, not local resolution ([Workspace Protocol](https://yarnpkg.com/protocol/workspace)) |
| `patch:` | `patch:base#./patch.diff` | a patched copy of another locator | patched package; pairs with `yarn patch` / `yarn patch-commit` ([Patch](https://yarnpkg.com/protocol/patch)) |
| `portal:` | `portal:../pkg` | a folder on disk, **with** its deps | symlink (`SOFT`) that *also* gets a PnP dependency map — unlike `link:` ([Portal](https://yarnpkg.com/protocol/portal)) |
| `link:` | `link:../folder` | an arbitrary folder, **no** deps | bare symlink; cannot carry dependencies (use `portal:` for that) ([Link](https://yarnpkg.com/protocol/link)) |
| `file:` | `file:./pkg.tgz`, `file:../dir` | local tarball / directory | copied into cache |
| `git:` / `github:` | `git@github.com:o/r.git#commit=…` | a git remote | cloned + packed; selectors below |
| `http:` / `https:` | `https://…/pkg.tgz` | a remote tarball | fetched into cache |
| `exec:` | `exec:./gen.js` | a generator script's stdout | script-produced package (experimental) |
| `jsr:` | `jsr:@scope/name` | the JSR registry | npm-compat tarball (newer berry) |

**Git selectors** use `#` + `&`-joined params, **not** `::`
([Git Protocol](https://yarnpkg.com/protocol/git)):
`#commit=<sha>`, `#head=<branch>`, `#tag=<tag>`, `#workspace=<name>`
(e.g. `org/app#head=next&workspace=my-pkg` clones a single workspace out
of a monorepo).

### 1.5 `::` bind modifiers and `__archiveUrl`

Distinct from the git `#…` selector, a `::` in a locator is a **bind
modifier** — it pins resolution-time binding parameters onto the locator.
The one seen in lockfiles is **`__archiveUrl`**: when a package is fetched
from a non-default registry that can't be reconstructed from
`npmRegistryServer` alone, berry binds the exact tarball URL into the
resolution key, e.g.

```
"react@npm:16.14.0::__archiveUrl=https://…/react/-/react-16.14.0.tgz"
```

Berry emits these when **multiple registries share one hostname but differ
by path**, or for registries like AWS CodeArtifact / JFrog Artifactory /
Nexus ([berry#4910](https://github.com/yarnpkg/berry/issues/4910),
[#6021](https://github.com/yarnpkg/berry/issues/6021)). They are a known
**portability hazard**: a lockfile carrying `__archiveUrl` for a host that
CI cannot reach fails with `ENOTFOUND`. The converter must treat the
`::__archiveUrl=` suffix as part of the locator identity, not strip it.
Lockfile-level handling: the berry format specs
([`spec/formats/yarn-berry-v4.md`](../formats/yarn-berry-v4.md) onward).

### 1.6 Peer-dependency virtualization (virtual locators)

Berry's signature resolution behaviour. A package with `peerDependencies`
cannot have one global instance, because the peer it sees must be the
*same object* its consumer sees. Berry therefore mints a **virtual
package** per distinct peer-set: a specialized instance whose locator
reference encodes the resolved peer dependencies via a hash
([Lexicon](https://yarnpkg.com/advanced/lexicon),
[Virtual Package](https://yarnpkg.com/advanced/lexicon)). On disk (and in
the PnP map) virtual instances live under a path scheme

```
…/__virtual__/<hash>/<n>/…
```

where `<n>` is a dirname-pop count applied after stripping the
`__virtual__/<hash>/<n>` segment, so the virtual path physically maps back
onto the single cached copy ([PnP Spec](https://yarnpkg.com/advanced/pnp-spec)).
This guarantees the peer-identity contract without duplicating bytes. It is
also why one `react` in `yarn info` can appear as many
`@virtual:…#npm:18.2.0` locators — each is a different peer context, not a
different download. The graph model's peer-context handling cross-refs
[`spec/decisions/0006-pnpm-style-peer-context.md`](../decisions/0006-pnpm-style-peer-context.md)
and the yarn-berry completeness ADRs.

---

## 2. Linking / layout

What "install" *writes to disk*. This is where classic and berry diverge
hardest.

### 2.1 Classic — hoisted `node_modules`

Classic produces a **flat, hoisted `node_modules/`** identical in shape to
npm's: shared transitive deps float to the top, version conflicts nest.
Stock Node resolution applies unchanged ([§3.1](#31-stock-node-resolution-the-baseline)).
Consequence: classic inherits npm's **ghost-dependency** hazard (a package
can `require` something it never declared, because hoisting happens to put
it on an ancestor path).

### 2.2 Berry — the three linkers (`nodeLinker`)

Berry's `nodeLinker` setting selects one of three layout strategies; **PnP
is the default** ([Install modes](https://yarnpkg.com/features/linkers)):

| `nodeLinker` | On-disk layout | `node_modules`? | Node resolver | Notes |
|---|---|:---:|---|---|
| **`pnp`** *(default)* | packages stay zipped in `.yarn/cache/`; a generated `.pnp.cjs` maps locator → location | **no** | **replaced** ([§3](#3-resolver-mutation--the-centerpiece)) | fastest; enables zero-installs; blocks ghost deps; needs editor SDKs |
| **`node-modules`** | classic-style **hoisted `node_modules/`**; optional hardlinks via `nmMode` | yes | stock | "perfect ecosystem compatibility"; no ghost-dep protection; imperfect hoisting |
| **`pnpm`** | `node_modules/.store` with one folder per dep, hardlinked from a global content-addressable store (default `~/.yarn/berry/index`), then **symlinked** into each consumer's `node_modules` | yes (symlink farm) | stock (via symlinks) | "middle ground": isolation of pnpm with broader compat than PnP; symlinks/hardlinks can confuse some tools |

`node-modules` and `pnpm` keep stock Node resolution; only `pnp` mutates
it. The layout model in the project: [`spec/04-layouts.md`](../04-layouts.md),
[`spec/decisions/0026-layout-attribution.md`](../decisions/0026-layout-attribution.md).

### 2.3 The zip cache and zero-installs

Berry stores every package as a **single zip** under `.yarn/cache/`
(`cacheFolder`, default `./.yarn/cache`; `compressionLevel` default `0`).
Under PnP, packages are **read directly out of the zip** at runtime — there
is no unzip-and-copy step ([Install modes](https://yarnpkg.com/features/linkers)).
A global cache is shared across projects by default (`enableGlobalCache:
true`). Committing `.yarn/cache/` + `.pnp.cjs` to VCS yields a
**zero-install** repo: `git clone` is already installed, `yarn install` is
a no-op ([PnP](https://yarnpkg.com/features/pnp)).

---

## 3. Resolver mutation — the centerpiece

> **This is the family's defining trait and the reason this spec exists.**
> Stock Node finds a module by walking `node_modules` up the directory
> tree. Berry's PnP linker **removes `node_modules` and replaces that walk
> with a table lookup.** Classic does *not* do this (it ships a real
> `node_modules`); berry's `node-modules`/`pnpm` linkers do *not* either.
> Resolver mutation is **PnP-specific**.

### 3.1 Stock Node resolution (the baseline)

For contrast, the substrate PnP replaces
([`_common.md`](./_common.md#1-module-resolution--commonjs)): `require('x')` /
`import 'x'` from a file triggers `LOAD_NODE_MODULES`, which probes
`./node_modules/x`, then `../node_modules/x`, up to the filesystem root,
honouring `package.json` `main`/`exports`. The lookup is a **filesystem
walk**; what's installed is whatever physically sits in those directories.

### 3.2 What PnP generates

A PnP install emits (at the project root):

- **`.pnp.cjs`** — the **runtime + data**: a self-contained CommonJS file
  carrying the resolution tables *and* the code that installs them into
  Node. Loading it patches Node's resolver and `fs`
  ([PnP](https://yarnpkg.com/features/pnp)).
- **`.pnp.data.json`** — the **data alone**, machine-readable, for tools
  that want the tables without executing the runtime
  ([PnP Spec](https://yarnpkg.com/advanced/pnp-spec)). `.pnp.cjs` embeds /
  reads this same data.
- **`.pnp.loader.mjs`** — the **ESM loader** (only when
  `pnpEnableEsmLoader: true`, or auto in newer berry for ESM projects). It
  exports Node `resolve`/`load` hooks and is injected via
  `--experimental-loader`, because `import` does not go through the CJS
  `require` patch ([berry#2161](https://github.com/yarnpkg/berry/pull/2161),
  [#3782](https://github.com/yarnpkg/berry/issues/3782)).

The data is a `packageRegistryData` table mapping
**ident → reference → package object**, each object carrying
([PnP Spec](https://yarnpkg.com/advanced/pnp-spec)):

- `packageLocation` — relative path (into `.yarn/cache/…zip/` or an
  unplugged folder), always ending `/`.
- `packageDependencies` — tuples mapping each declared dependency name to
  the **reference** it resolves to (the edge set).
- `linkType` — `"HARD"` (package-manager-owned, e.g. a cached zip) or
  `"SOFT"` (a user location, e.g. a `portal:`/`link:`/`workspace:` target).
- `discardFromLookup` (optional).

Plus the fallback controls: `enableTopLevelFallback`, `fallbackPool`,
`fallbackExclusionList` ([§3.5](#35-fallback-pnpfallbackmode)).

### 3.3 How `.pnp.cjs` gets into the process — and how resolution then works

`.pnp.cjs` is inert until it is **loaded into the Node process**. Yarn
arranges that three ways ([PnP](https://yarnpkg.com/features/pnp)):

1. **`yarn run <script>` / binaries** — yarn sets the run context so the
   `.pnp.cjs` is registered automatically; any direct/indirect `node`
   spawned from a script entry inherits it as a runtime dependency.
2. **`yarn node …`** — the recommended interpreter; forward-compatible
   shim that boots Node with PnP active.
3. **Manual** — `node --require ./.pnp.cjs script.js` (a.k.a.
   `node -r ./.pnp.cjs …`), or `NODE_OPTIONS="--require $(pwd)/.pnp.cjs"`.

Once loaded, the runtime installs **`PNP_RESOLVE(specifier, parentURL)`**
in front of Node's resolver ([PnP Spec](https://yarnpkg.com/advanced/pnp-spec)):

- Node **builtins** (`fs`, `path`, …) pass through unchanged.
- **relative/absolute** specifiers (`./`, `../`, `/`) use ordinary Node
  resolution.
- **bare** specifiers (`lodash`, `@scope/x`) go to
  **`RESOLVE_TO_UNQUALIFIED`**: parse name + subpath → find the *issuer's*
  package via `findPackageLocator` → look the name up in that package's
  `packageDependencies` → return the dependency's `packageLocation`
  (then a qualify step adds the file extension / `main`).

The lookup is **O(1) table access**, not a directory walk, and it can only
ever return an **explicitly declared** edge — which is the whole point
([§3.4](#34-strictness--undeclared-dependency-errors)). Because packages
live inside zips, the runtime also **patches `fs`** so `fs.readFile` et al.
transparently read paths *inside* the cached `.zip` archives
([Install modes](https://yarnpkg.com/features/linkers)).

The programmatic surface is the global **`pnpapi`** module
(`require('pnpapi')`), documented at
[advanced/pnpapi](https://yarnpkg.com/advanced/pnpapi):

| Member | Role |
|---|---|
| `resolveToUnqualified(request, issuer, opts?)` | core lookup → path without extension |
| `resolveUnqualified(unqualified, opts?)` | add extension / folder-index |
| `resolveRequest(request, issuer, opts?)` | the two combined → fs-ready path |
| `getPackageInformation(locator)` | `{ packageLocation, packageDependencies, linkType }` for a locator |
| `getLocator(name, referencish)` | build a `{name, reference}` locator |
| `getDependencyTreeRoots()` | root locators (one per workspace) |
| `findPackageLocator(location)` | filesystem path → owning locator |
| `resolveVirtual(path)` *(yarn ext)* | strip `__virtual__/<hash>/<n>` back to the physical path |
| `VERSIONS` (`{ std: 3, … }`), `topLevel` (`{name:null, reference:null}`) | API version + root locator |

A **PackageLocator** is `{ name, reference }` (top-level uses `null`/`null`);
a **PackageInformation** is the per-package object above. Peer dependencies
surface as `packageDependencies` values that are `null` until virtualization
binds them ([advanced/pnpapi](https://yarnpkg.com/advanced/pnpapi)).

### 3.4 Strictness — undeclared-dependency errors

The mutation's biggest behavioural consequence. Under default **strict**
mode (`pnpMode: strict`, the default), PnP **refuses** to resolve any
specifier not present in the issuer's `packageDependencies` — even if some
*other* package depends on it. The error is the well-known:

```
Your application tried to access X, but it isn't declared in your
dependencies; this makes the require call ambiguous and unsound.
```

([berry#1487](https://github.com/yarnpkg/berry/issues/1487)). This
**eliminates ghost dependencies** by construction: in `node_modules` a
package can accidentally resolve an undeclared module that happened to be
hoisted to an ancestor; PnP makes that a hard failure
([berry#3033](https://github.com/yarnpkg/berry/issues/3033)). Packages
that under-declare must be repaired via `packageExtensions`
([§1.3](#13-resolutions-field)). This strictness is the single most common
source of "works in npm, breaks in PnP" friction, and the reason editor
SDKs ([§4.5](#45-editor-sdks)) are mandatory.

### 3.5 Fallback (`pnpFallbackMode`)

To soften strictness, PnP keeps a **fallback pool** of packages it *would*
have hoisted to the top level. `pnpFallbackMode`
([yarnrc](https://yarnpkg.com/configuration/yarnrc),
default `dependencies-only`) controls who may use it:

- `none` — fully strict, no fallback.
- `dependencies-only` *(default)* — third-party packages get **no**
  fallback; only the top-level project may fall back (so your app's stray
  undeclared `require` resolves, but a dependency's does not).
- `all` — everyone may fall back (loosest).

Separately, **`pnpMode: loose`** generates the fallback-pool list and lets
resolution fall through to it for would-have-been-hoisted packages
([berry PnP](https://yarnpkg.com/features/pnp)) — a compatibility shim, not
the recommended end state. These map to `enableTopLevelFallback` /
`fallbackPool` / `fallbackExclusionList` in the
[PnP data](https://yarnpkg.com/advanced/pnp-spec).

### 3.6 The `unplugged` escape hatch

PnP's "packages stay zipped" model breaks for packages that must exist as
**real files on disk** — those with **postinstall scripts**, **native
artifacts**, or that read/modify their own source. Such packages are
**unplugged**: unzipped into `pnpUnpluggedFolder` (default
`./.yarn/unplugged`) and pointed at from the PnP map with a real path
([Lexicon](https://yarnpkg.com/advanced/lexicon),
[yarnrc](https://yarnpkg.com/configuration/yarnrc)). A package is unplugged
**implicitly** when it declares a postinstall script or ships native files,
or **explicitly** via `dependenciesMeta.<pkg>.unplugged: true` /
`preferUnplugged: true` in its manifest. Unplugging is the controlled crack
in the "no `node_modules`" wall — and the bridge to the lifecycle axis
([§5](#5-lifecycle)), since a build script *implies* an unplug.

### 3.7 Contrast, in one line

Stock Node / classic / berry-`node-modules`: *"resolve X" = walk
directories until X is found on disk.* Berry-PnP: *"resolve X" = look X up
in the issuer's declared dependency table; if it's not there, throw.* The
first is permissive and filesystem-shaped; the second is strict and
graph-shaped. That inversion is the whole story of this section.

---

## 4. Environment

### 4.1 Config files — `.yarnrc` vs `.yarnrc.yml`

- **Classic:** `.yarnrc` — a **custom** key/value format (not YAML),
  cosgmiconfig-adjacent; keys like `registry`, `yarn-offline-mirror`,
  `--install.*` flag defaults. Also reads `.npmrc` for registry/auth.
- **Berry:** `.yarnrc.yml` — **YAML**, a closed/validated key set
  ([Settings](https://yarnpkg.com/configuration/yarnrc)). The two formats
  are **not** interchangeable; migrating v1→berry requires rewriting config.

Berry settings that change behaviour elsewhere in this spec
([Settings](https://yarnpkg.com/configuration/yarnrc); defaults pinned
2026-06-16):

| Key | Values | Default | Axis |
|---|---|---|---|
| `nodeLinker` | `pnp` \| `node-modules` \| `pnpm` | `pnp` | [§2.2](#22-berry--the-three-linkers-nodelinker) |
| `pnpMode` | `strict` \| `loose` | `strict` | [§3.4](#34-strictness--undeclared-dependency-errors) |
| `pnpFallbackMode` | `none` \| `dependencies-only` \| `all` | `dependencies-only` | [§3.5](#35-fallback-pnpfallbackmode) |
| `pnpEnableEsmLoader` | bool | `false` | [§3.2](#32-what-pnp-generates) |
| `pnpUnpluggedFolder` | path | `./.yarn/unplugged` | [§3.6](#36-the-unplugged-escape-hatch) |
| `cacheFolder` | path | `./.yarn/cache` | [§2.3](#23-the-zip-cache-and-zero-installs) |
| `enableGlobalCache` | bool | `true` | [§2.3](#23-the-zip-cache-and-zero-installs) |
| `compressionLevel` | `0`–`9` \| `mixed` | `0` | [§2.3](#23-the-zip-cache-and-zero-installs) |
| `enableScripts` | bool | **`false`** | [§5](#5-lifecycle) |
| `enableImmutableInstalls` | bool | `false` (auto-`true` in CI) | lockfile |
| `npmRegistryServer` | URL | `https://registry.yarnpkg.com` | [§6](#6-lockfile--registry) |
| `npmScopes` | object | — | [§6](#6-lockfile--registry) |
| `packageExtensions` | object | — | [§1.3](#13-resolutions-field) |
| `supportedArchitectures` | `{os,cpu,libc}` | host | optional-dep selection |
| `yarnPath` | path | — | [§4.2](#42-the-per-repo-binary) |
| `plugins` | list | — | [§4.4](#44-plugins) |

> **Version flag.** `enableScripts` defaulting to **`false`** (third-party
> postinstall blocked unless allowlisted) is **current (v4) behaviour**
> ([Settings](https://yarnpkg.com/configuration/yarnrc),
> [Manifest](https://yarnpkg.com/configuration/manifest)). Earlier berry
> (and the v2 launch posture) ran build scripts more liberally; treat the
> default as version-dependent and read the project's pinned yarn release.
> See [§5](#5-lifecycle).

### 4.2 The per-repo binary

Berry is normally **vendored into the repository**, not installed globally:
`yarn set version <x>` downloads a release into **`.yarn/releases/`** and
sets **`yarnPath:`** in `.yarnrc.yml`. The global `yarn` shim detects the
project's `.yarnrc.yml` and **delegates** to that pinned binary — so every
contributor and CI runs the *exact same* yarn ([yarn set version](https://yarnpkg.com/cli/set/version)).
Yarn 4 + `yarn init` instead prefer **Corepack** (the `packageManager`
field in `package.json`), downloading to `.yarn/releases/` only when the
release can't be expressed that way or `yarnPath` is already set
([Release 4.0](https://yarnpkg.com/blog/release/4.0),
[berry#4063](https://github.com/yarnpkg/berry/issues/4063)). Classic has no
equivalent — it's a single global binary.

### 4.3 `yarn dlx`

Berry's `yarn dlx <pkg>` (download-and-execute) runs a package's binary in
a throwaway temp project without polluting the local install — the berry
analogue of `npx`. Because it spins an ephemeral PnP environment, the
executed tool resolves under PnP too.

### 4.4 Plugins

Berry is plugin-extensible (`yarn plugin import`; recorded under `plugins:`
in `.yarnrc.yml`, stored in `.yarn/plugins/`). Plugins add resolvers,
fetchers, commands, and linkers — e.g. the constraints engine and the
TypeScript plugin. Classic is not pluggable.

### 4.5 Editor SDKs

Because there is no `node_modules`, editors and CLI tools that hard-code a
`node_modules` walk (TypeScript `tsc`/`tsserver`, ESLint, Prettier, etc.)
**cannot find packages under PnP**. Berry ships **`yarn dlx @yarnpkg/sdks`**
(e.g. `yarn dlx @yarnpkg/sdks vscode`) which writes shim SDKs under
`.yarn/sdks/` that point those tools at the PnP API
([berry SDKs](https://yarnpkg.com/getting-started/editor-sdks)). This is a
**direct cost of the resolver mutation** — under `node-modules`/`pnpm`
linkers it is unnecessary.

---

## 5. Lifecycle

### 5.1 Classic

Classic runs the npm lifecycle (`preinstall`/`install`/`postinstall`,
`prepare`, `pre`/`post` wrappers around run-scripts) for dependencies and
the root, like npm. No allowlist by default.

### 5.2 Berry — scripts off by default

Berry's stance is **security-first**: with **`enableScripts: false`**
(current default), `yarn install` **does not run third-party
`postinstall`** scripts ([Settings](https://yarnpkg.com/configuration/yarnrc)).
**Workspaces are exempt** — your own workspaces' scripts still run, since
running an install inside your repo implies trust. To re-enable a specific
dependency's build:

- **`dependenciesMeta.<pkg>.built: true`** in `package.json` — an
  **allowlist**: only packages explicitly marked `built` run their build
  step; `built: false` downgrades a build-script warning to a notice
  ([Manifest](https://yarnpkg.com/configuration/manifest),
  [berry#1605](https://github.com/yarnpkg/berry/issues/1605)).

A built package is, by necessity, **unplugged** ([§3.6](#36-the-unplugged-escape-hatch))
— it must exist as real files for its script to touch them. So lifecycle
and layout are coupled under PnP in a way they never are under
`node_modules`.

> **Version flag.** The `enableScripts: false` allowlist posture is the
> matured (v4-era) model. The original Yarn 2 launch
> ([Introducing Yarn 2](https://dev.to/arcanis/introducing-yarn-2-4eh1))
> ran scripts by default; the default tightened over the 3.x→4.x line.
> Pin behaviour to the project's `yarnPath`/`packageManager` release, not
> to "berry" generically.

### 5.3 Constraints

Berry ships a **constraints** engine (`yarn constraints`; historically
Prolog-based `constraints.pro`, now also a JS `yarn.config.cjs` API) that
declaratively enforces invariants across workspaces — e.g. "every
workspace must pin `react` to the same range", "no workspace may depend on
package X". It is a lint/repair layer over the manifest set, unique to
berry, with no classic or npm analogue.

---

## 6. Lockfile + registry

**Interaction only** — the byte-level grammar lives in the format specs,
the transport in the registry specs.

### 6.1 Lockfile

| | file | format | keyed by | cross-ref |
|---|---|---|---|---|
| classic | `yarn.lock` | custom YAML-like v1 (not valid YAML; `#`-comment header `# yarn lockfile v1`) | descriptor-set → resolution | [`spec/formats/yarn-classic.md`](../formats/yarn-classic.md) |
| berry | `yarn.lock` | **SYML** (true-YAML superset) with `__metadata.version` | locator → `{version, resolution, dependencies, checksum, …}` | [`spec/formats/yarn-berry-v3.md`](../formats/yarn-berry-v3.md) … [`v10.md`](../formats/yarn-berry-v10.md) |

Berry **auto-migrates** an older lockfile (including a v1 via
`yarn import`, or any older `__metadata.version`) to its current schema on
install. The `resolution` field is the **fully-qualified locator** —
including any `::__archiveUrl=…` bind ([§1.5](#15--bind-modifiers-and-__archiveurl))
— and `checksum` carries the integrity (prefixed with `__metadata.cacheKey`
in newer schemas). Emit invariants shared across the berry family:
[`spec/formats/_common.md` §1](../formats/_common.md#1-yarn-berry-emit-invariants-version-invariant).

### 6.2 Registry

Both lineages default to **`registry.yarnpkg.com`** (`npmRegistryServer`),
a field-identical mirror of public npm whose tarball URLs point at
`registry.npmjs.org` — so default-registry lockfiles stay portable
([`spec/registry/yarn-mirror.md`](../registry/yarn-mirror.md)). Per-scope
routing is `npmScopes:` (berry) / `@scope:registry=` in `.npmrc` (classic).
The npm-shape read/advisory contract is
[`spec/registry/_common.md`](../registry/_common.md); the `npm:` protocol's
fetcher speaks exactly that surface. Non-default registries are where
`__archiveUrl` binds appear ([§1.5](#15--bind-modifiers-and-__archiveurl)).

---

## Quirks

- **`enableScripts` default is `false`** in current berry (third-party
  postinstall blocked; workspaces exempt) — but it was looser in early
  berry. **Version-pin before asserting.**
- **`__archiveUrl` poisons portability** — a berry lockfile built against a
  private/host-pathed registry binds absolute tarball URLs into resolution
  keys that other environments can't reach
  ([berry#4910](https://github.com/yarnpkg/berry/issues/4910)).
- **PnP strictness ≠ a bug** — "tried to access X but it isn't declared" is
  PnP working as designed; the fix is declaring the dep or a
  `packageExtensions` entry, not loosening PnP.
- **Virtual locators inflate the apparent graph** — N `@virtual:…` instances
  of one package are N peer-contexts over **one** cached copy, not N
  downloads.
- **`yarn import`** converts a v1 `yarn.lock` once; berry then owns the file
  and never reads v1 again.
- **Releases ≠ schema versions** — yarn 4 may write `__metadata.version: 8`;
  do not infer one from the other.
- **`link:` can't carry deps; `portal:` can** — a frequent footgun; a
  `link:` to a package with its own deps silently lacks them.
- **`compressionLevel: 0` by default** — zips are *stored*, not deflated, so
  `.yarn/cache/` is larger than a naive guess but faster to read.

---

## Adapter mapping (this project)

| Concern | Classic | Berry |
|---|---|---|
| lockfile reader | `yarn-classic` parser | `yarn-berry-vN` (SYML) parser |
| layout the graph implies | hoisted `node_modules` | PnP map (default) / `node-modules` / `pnpm` store |
| resolver model | stock Node walk | PnP table (locator→deps), virtual peer contexts |
| protocol set | semver + `link:`/`file:`/git | full berry protocol matrix ([§1.4](#14-protocols)) |
| registry adapter | `live` (yarn-mirror = npm) | `live`, plus `::__archiveUrl=` carry-through |
| modifier locus | `resolutions` | `resolutions` + `packageExtensions` + `::` binds |

The converter consumes yarn at the **lockfile + manifest** boundary; it
does **not** run PnP, but it must model PnP-shaped facts (virtual locators,
`__archiveUrl` binds, protocol prefixes) faithfully so a berry→other or
other→berry conversion round-trips. PnP's *runtime* (`.pnp.cjs`) is an
**output of install**, downstream of the graph, and out of scope for the
reader; it is documented here because it is the behaviour that makes a
yarn-berry graph mean what it means.

---

## Sources

Primary (yarnpkg.com / berry source), fetched/searched 2026-06-16:

- [Plug'n'Play](https://yarnpkg.com/features/pnp) — PnP overview, `.pnp.cjs`, zero-installs, injection.
- [PnP Specification](https://yarnpkg.com/advanced/pnp-spec) — `PNP_RESOLVE`/`RESOLVE_TO_UNQUALIFIED`, `packageRegistryData`, `linkType`, `__virtual__/<hash>/<n>`, fallback fields.
- [PnP API](https://yarnpkg.com/advanced/pnpapi) — `resolveRequest`/`resolveToUnqualified`/`getPackageInformation`/`findPackageLocator`/`VERSIONS`/`topLevel`, locator + package-information shapes.
- [Install modes (linkers)](https://yarnpkg.com/features/linkers) — `nodeLinker` pnp/node-modules/pnpm, zip cache, fs patching, pnpm store.
- [Protocols](https://yarnpkg.com/protocols) + per-protocol pages: [workspace](https://yarnpkg.com/protocol/workspace), [patch](https://yarnpkg.com/protocol/patch), [portal](https://yarnpkg.com/protocol/portal), [link](https://yarnpkg.com/protocol/link), [git](https://yarnpkg.com/protocol/git).
- [Lexicon](https://yarnpkg.com/advanced/lexicon) — Descriptor/Locator/Ident, Virtual Package, Linker/Fetcher/Resolver, Hoisting, Unplugged.
- [Settings (.yarnrc.yml)](https://yarnpkg.com/configuration/yarnrc) — config keys + defaults (incl. `enableScripts: false`, `nodeLinker: pnp`, `pnpMode: strict`).
- [Manifest (package.json)](https://yarnpkg.com/configuration/manifest) — `dependenciesMeta.built`/`unplugged`, `resolutions`.
- [yarn set version](https://yarnpkg.com/cli/set/version), [Release 4.0](https://yarnpkg.com/blog/release/4.0) — `yarnPath`, `.yarn/releases/`, Corepack/`packageManager`.
- berry issues/PRs corroborating runtime detail: [#2161 (ESM loader)](https://github.com/yarnpkg/berry/pull/2161), [#1487 (undeclared-dep error text)](https://github.com/yarnpkg/berry/issues/1487), [#3033 (ghost deps)](https://github.com/yarnpkg/berry/issues/3033), [#4910](https://github.com/yarnpkg/berry/issues/4910)/[#6021 (`__archiveUrl`)](https://github.com/yarnpkg/berry/issues/6021), [#1605 (`dependenciesMeta.built`)](https://github.com/yarnpkg/berry/issues/1605).
- Classic: [classic.yarnpkg.com/en/docs/yarn-lock](https://classic.yarnpkg.com/en/docs/yarn-lock) (lockfile), [classic workspaces](https://classic.yarnpkg.com/lang/en/docs/workspaces/).

Cross-references inside this repo: Node substrate
[`_common.md`](./_common.md); lockfile grammar
[`spec/formats/yarn-classic.md`](../formats/yarn-classic.md) +
[`yarn-berry-v3.md`](../formats/yarn-berry-v3.md)…[`v10.md`](../formats/yarn-berry-v10.md)
+ [`_common.md` §1](../formats/_common.md#1-yarn-berry-emit-invariants-version-invariant);
registry [`spec/registry/yarn-mirror.md`](../registry/yarn-mirror.md),
[`npm.md`](../registry/npm.md), [`_common.md`](../registry/_common.md);
model [`spec/04-layouts.md`](../04-layouts.md),
[`spec/05-protocols.md`](../05-protocols.md),
[`spec/06-modifiers.md`](../06-modifiers.md); peer context
[`spec/decisions/0006-pnpm-style-peer-context.md`](../decisions/0006-pnpm-style-peer-context.md).

## Uncertainty / open

- **`enableScripts` default by release.** Current docs say `false`; the
  exact release where the default flipped (and the precise v2/v3 posture)
  is **not pinned here** — verify against the project's vendored yarn
  before relying on it. *(Flagged version-specific.)*
- **`.pnp.loader.mjs` auto-generation.** Whether the ESM loader is emitted
  automatically vs only under `pnpEnableEsmLoader: true` has shifted across
  berry minors; treat as version-dependent.
- **`pnpm` linker store path** (`~/.yarn/berry/index`) is the documented
  default but OS/-config dependent; not independently probed.
- **`jsr:` / `exec:` protocols** are newer/experimental; presence depends on
  the yarn release and enabled plugins.
- Classic-specific `.yarnrc` keys and v1 lockfile edge fields were
  **not re-fetched live** (classic.yarnpkg.com fetch was blocked this
  session); they are cross-referenced to
  [`spec/formats/yarn-classic.md`](../formats/yarn-classic.md), which was
  built from the v1 parser source.
