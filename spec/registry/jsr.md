# `jsr` — JSR, the JavaScript Registry (`jsr.io` / `npm.jsr.io`)

> Status: stable (npm-compat live-probed 2026-06-08; native API shape partial).
> Updated: 2026-06-16
> Provenance: **Official** (jsr.io/docs).
> Family: **non-npm** (native `jsr.io`) + **npm-shape** (compat `npm.jsr.io`).

JSR is a TypeScript-first registry by the Deno team. It has two faces: a **native
protocol** at `jsr.io` (serves source modules + a metadata/manifest API, sha256
checksums) and an **npm-compatibility layer** at `npm.jsr.io` so npm / yarn / pnpm
can install JSR packages as ordinary scoped npm packages. The converter consults
the **npm-compat face**; the native API is documented here for contrast. This is
the directory's one **non-npm** entry.

## Identity & addressing

- **npm-compat base URL:** `https://npm.jsr.io` · **native base URL:** `https://jsr.io`
- **Scope requirement (npm-compat):** **scoped-only** — every package is under the
  `@jsr` scope. A native `@<scope>/<name>` is mangled to the npm name
  `@jsr/<scope>__<name>` (**double underscore**). Probe (2026-06-08): native
  `@std/encoding` → `https://npm.jsr.io/@jsr/std__encoding`, `.name =
  "@jsr/std__encoding"`.
- **Tarball URL policy:** `own` — `dist.tarball` =
  `https://npm.jsr.io/~/<n>/@jsr/<scope>__<name>/<version>.tgz` (an internal
  `~/<n>/` prefix). Probe: `…/~/11/@jsr/std__encoding/1.0.10.tgz` → 200,
  `immutable`, year-long cache. Non-portable off JSR.
- **`.npmrc` selector:** `@jsr:registry=https://npm.jsr.io`. A consumer manifest
  records a JSR dep as the npm alias `"@luca/cases": "npm:@jsr/luca__cases@1"`
  (per jsr docs).

## Authentication

Anonymous reads (packument + tarball). No token for public JSR.

## Endpoints

The npm-compat face implements a **narrow** read subset
([§3](./_common.md#3-read-endpoints)): `GET /{name}`, `/{name}/{version}`,
`/{name}/-/…tgz`. **Absent:** all `/-/npm/v1/security/*` and `/-/npm/v1/keys`
(`GET /-/npm/v1/keys` → 404, probed). The **native** API (`jsr.io`) is separate
and non-npm: `GET /@scope/name/meta.json`, `/@scope/name/<version>_meta.json`
(manifest + exports + moduleGraph + sha256 checksums), serving source, not
tarballs.

## Metadata deltas

npm-compat `dist` carries **only** `{ tarball (own), integrity (sha512 SRI),
shasum (sha1) }` — **no `signatures`, no attestations**. Probe (2026-06-08,
`@jsr/std__encoding@1.0.10`): `integrity: sha512-WK2n…`, `shasum: 160429…`.
`dist.integrity` present ⇒ enrich works. `npm.jsr.io` serves the abbreviated
(corgi-equivalent) shape **unconditionally** — it does not negotiate on `Accept`
(probed 2026-06-09). Native checksums are **sha256** (`sha256-…` per file) — a different model from the npm
tarball SRI; do not cross them.

## Advisories & audit

**None** — the [no-advisories class](./_common.md#83-the-no-advisories-class)
(`/keys` → 404). Same posture as [`nexus`](./nexus.md) / [`npmmirror`](./npmmirror.md):
decouple the advisory source from resolution. Resolution + integrity unaffected.

## Capabilities

| Capability | Supported | Notes |
|------------|:---------:|-------|
| Unscoped packages | **✗** | npm-compat is `@jsr/*` only |
| Scoped packages | ✓ | |
| Abbreviated packument (corgi) | ✓ | abbreviated-only; no `Accept` toggle |
| `dist.integrity` (sha512) | ✓ | |
| `dist.signatures` | **✗** | |
| Provenance / attestations | **✗** | |
| Bulk advisories | **✗** | |
| Registry signing keys | **✗** | |
| Proxy of upstream npm | n/a | own ecosystem, not a proxy |

## Quirks

- **`@jsr/<scope>__<name>` mangling** — a converter seeing `@jsr/std__encoding`
  must understand it is JSR `@std/encoding`; the npm-alias form `npm:@jsr/…` is how
  it lands in a lockfile.
- **`~/<n>/` tarball prefix** — an opaque internal segment in the tarball path;
  probed (2026-06-09) to **vary across versions** of one package — treat
  `dist.tarball` as wholly opaque ([§1.3](./_common.md#13-tarball-url)).
- **Two integrity models** — npm-compat emits sha512 SRI; native emits per-file
  sha256.
- **Source-served native packages** — `jsr.io` serves modules, not prebuilt
  tarballs; `npm.jsr.io` synthesizes npm tarballs for compatibility.

## Adapter mapping

| Concern | Setting |
|---------|---------|
| `headers()` | none (anonymous) |
| tarball URL remap | required — `npm.jsr.io/~/…` is non-portable |
| degraded facts | signatures + advisories + keys absent → route advisories elsewhere |

## Probes & fixtures

- **Probes (2026-06-08):** `npm.jsr.io/@jsr/std__encoding` (packument; `dist` =
  tarball + integrity + shasum, no sigs); `-I …/~/11/@jsr/std__encoding/1.0.10.tgz`
  (200, immutable); `jsr.io/@std/encoding/1.0.10_meta.json` (native: manifest +
  sha256 checksums + exports); `npm.jsr.io/-/npm/v1/keys` (404).
- **Mock flags:** `{ scope: 'mandatory', strip: ['signatures'], audit: 'absent' }`.

## Open questions

*(Probed 2026-06-09: `npm.jsr.io` serves the **abbreviated form only** — it does not
toggle on `Accept`, but the shape is corgi-equivalent; `%2f`-encoded scoped names
**work** (`/@jsr%2fstd__encoding` → 200); the `~/<n>/` tarball prefix **varies across
versions**. Native `jsr.io`: `meta.json` = `{ latest, name, scope, versions }`,
per-version `<v>_meta.json` = `{ exports, manifest, moduleGraph2 }`.)*

> **Open:** the native `manifest` / `moduleGraph2` sub-shapes (per-file checksums,
> export map) are only partially pinned — expand if a native-JSR adapter is built.

## Sources

- Live probes (2026-06-08): `npm.jsr.io/@jsr/std__encoding`, tarball HEAD,
  `jsr.io/@std/encoding/1.0.10_meta.json`, `npm.jsr.io/-/npm/v1/keys`.
- [JSR npm-compatibility docs](https://jsr.io/docs/npm-compatibility) ·
  [JSR repo](https://github.com/jsr-io/jsr).
