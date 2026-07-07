# `_common` — the canonical npm registry HTTP contract

> Status: preview (live-probed core 2026-06-08–09; advisory/keys sections from npm CLI source; open probe items below).
> Updated: 2026-06-16
> This is the shared **published** source for the registry API that every
> npm-shape backend implements or narrows. Where a per-registry spec under
> [`spec/registry/`](./) says "the canonical packument", "the abbreviated
> form", "the audit API", or "the signing-keys endpoint", that reference
> resolves here. Self-contained: no private note or ADR knowledge assumed.

This document is normative for the **npm-shape family**. A per-registry spec
MAY narrow (drop an endpoint, strip a field, mandate auth) or extend (add a
header, rewrite a URL); on any conflict the per-registry spec wins for that
registry and states the divergence explicitly. Non-npm registries (e.g.
[JSR](./jsr.md)) document their own protocol and reference this only for
contrast.

The reference implementation is **public npm** (`registry.npmjs.org`); its
shape is the canonical baseline, probed live and pinned in [§4](#4-the-packument-full-document).
The registry API has **no single versioned specification** — the only
authoritative source is the running server plus the npm CLI's fetch/audit
code. The historical [`npm/registry` `REGISTRY-API.md`][registry-api] documents
the URL surface but its field lists predate `integrity`, `signatures`,
`unpackedSize`, and the entire advisory API. This document supersedes it for
our purposes.

[registry-api]: https://github.com/npm/registry/blob/master/docs/REGISTRY-API.md

---

## §1 Addressing & name encoding

### 1.1 Base URL

A registry is identified by a base URL (`https://registry.npmjs.org`,
no trailing slash canonical). All paths below are relative to it. Clients
discover it from `.npmrc` (`registry=`, `@scope:registry=`), `bunfig.toml`,
yarn's `npmRegistryServer`, or env (`npm_config_registry`).

### 1.2 Package-name routing

| Name kind | On-the-wire path | Note |
|-----------|------------------|------|
| unscoped `lodash` | `/lodash` | |
| scoped `@babel/core` | `/@babel%2fcore` **or** `/@babel/core` | the `/` MAY be percent-encoded as `%2f` |

The scoped-name `%2f` encoding is **load-bearing and quirk-prone**: npm's own
client encodes the separator (`/@babel%2fcore`) for the packument GET, but most
servers also accept the literal slash. A registry behind a path-normalising
proxy MAY 404 on one form — record which forms a given registry accepts in its
per-registry Quirks. The **tarball** path always uses the literal slash
(`/@babel/core/-/core-7.0.0.tgz`).

### 1.3 Tarball URL

The tarball location is **not** computed by the client — it is read verbatim
from `dist.tarball` ([§6](#6-single-version-manifest--the-dist-object)).
Canonical npm uses
`{base}/{name}/-/{unscoped-name}-{version}.tgz`
(e.g. `https://registry.npmjs.org/@babel/core/-/core-7.0.0.tgz`), but a client
MUST treat `dist.tarball` as opaque: proxy registries rewrite it
([§6.2](#62-the-tarball-url-rewrite-hazard)), and a lockfile records whatever
URL the producing registry served. **Never reconstruct a tarball URL from
name+version** when `dist.tarball` is present.

---

## §2 Authentication

Read access to public npm is **anonymous**. Private and proxy registries
gate reads. The mechanisms, in the order the npm client applies them:

| Mechanism | `.npmrc` key | Header sent |
|-----------|--------------|-------------|
| Bearer token (modern) | `//host/path/:_authToken=TOKEN` | `Authorization: Bearer TOKEN` |
| Basic (legacy `_auth`) | `//host/path/:_auth=BASE64` | `Authorization: Basic BASE64` |
| Basic (split) | `:username` + `:_password` (base64) | `Authorization: Basic …` |
| `always-auth` | `//host/:always-auth=true` | forces auth on tarball GETs too |

Auth is **scoped by URL prefix** (`//host/path/:`), so a single client can hold
different credentials per registry and per scope. Tokens may be sent on
**tarball** requests only when `always-auth` is set or the tarball host matches
an auth-bearing prefix — a frequent failure mode when `dist.tarball` is rewritten
to a host with no configured credential.

> A registry that mandates auth for **reads** (GitHub Packages) cannot serve the
> anonymous probe public npm does; the converter surfaces a `401` as a
> configuration diagnostic, never as "package not found".

The mechanisms above are the **read** credential. The **write**-side account
security — 2FA, the OTP challenge, and the token taxonomy (legacy vs granular) —
is in [§15](#15-two-factor-auth--token-taxonomy); **public vs private** access in
[§16](#16-access-control).

---

## §3 Read endpoints

The converter consults **read** endpoints. The **write / lifecycle** surface
(publish, deprecate, unpublish, dist-tag) and the **account** surface (2FA,
tokens, access) are specified in [§14](#14-package-lifecycle-writes) /
[§15](#15-two-factor-auth--token-taxonomy) / [§16](#16-access-control) for
ecosystem completeness — the resolver never calls them.

| Method | Path | Purpose | Used by converter |
|--------|------|---------|:-----------------:|
| `GET` | `/{name}` | full **or** abbreviated packument (Accept-negotiated) | ✅ |
| `GET` | `/{name}/{version}` | single-version manifest | ✅ |
| `GET` | `/{name}/-/{file}.tgz` | tarball bytes | ✅ (tarball tier) |
| `GET` | `/-/v1/search?text=…` | search | — |
| `GET` | `/-/package/{name}/dist-tags` | dist-tag map | ◐ ([§7](#7-dist-tags)) |
| `POST` | `/-/npm/v1/security/advisories/bulk` | bulk advisories (npm 7+) | ✅ (audit) |
| `POST` | `/-/npm/v1/security/audits/quick` | quick audit (npm 6) | ◐ |
| `POST` | `/-/npm/v1/security/audits` | full audit + actions (npm 6) | ◐ |
| `GET` | `/-/npm/v1/keys` | registry signing keys | ◐ (signatures) |
| `GET` | `/-/npm/v1/attestations/{name}@{ver}` | provenance bundles ([§13](#13-provenance--attestations)) | ◐ |
| `GET` | `/-/ping` | health | — |
| `GET` | `/-/whoami` | identity (auth) | — |
| `PUT` | `/{name}` | publish / deprecate ([§14](#14-package-lifecycle-writes)) | ✗ (write) |
| `PUT`/`DELETE` | `/-/package/{name}/dist-tags/{tag}` | dist-tag write ([§14.3](#143-dist-tag-writes)) | ✗ (write) |

`◐` = consulted by specific modifiers (audit-fix, signature verification) but
not on the steady-state resolve path.

---

## §4 The packument (full document)

`GET /{name}` with `Accept: application/json` returns the **full packument**.
Live-probed top-level keys (`registry.npmjs.org/lodash`, 2026-04-27):

```
_id, _rev, name, description,
dist-tags, versions,
time, author, contributors, maintainers, users,
homepage, bugs, repository, license, keywords,
readme, readmeFilename
```

- `versions` — `{ "<version>": <single-version-doc> }` (full manifests, [§6](#6-single-version-manifest--the-dist-object)).
- `dist-tags` — `{ "latest": "<version>", … }`. **`latest` is the only
  guaranteed tag.** Other tags (`next`, `beta`) are publisher-defined.
- `time` — `{ "<version>": "<ISO-8601>", "created": …, "modified": … }`.
  Carries publish + the **`unpublished`** marker for removed versions.
- `_id` / `_rev` — CouchDB document identity; `_rev` is mutation-control,
  not stable across reads. Ignore for identity.

The full document is **large** (lodash ≈ 1 MB) and carries human-facing fields
(`readme`, `users`, `description`) the installer never needs. Production PMs
fetch the abbreviated form ([§5](#5-abbreviated-packument-corgi)) instead.

---

## §5 Abbreviated packument ("corgi")

`GET /{name}` with `Accept: application/vnd.npm.install-v1+json` returns the
**abbreviated** ("corgi") packument — the trimmed projection npm, pnpm, and yarn
actually fetch on install. Same URL, content-negotiated by `Accept`.

```
{
  "name":      "<name>",
  "modified":  "<ISO-8601>",          // last-modified, for cache validation
  "dist-tags": { … },
  "versions": {
    "<version>": {
      name, version,
      dependencies, devDependencies, optionalDependencies,
      peerDependencies, peerDependenciesMeta, bundleDependencies,
      bin, directories, dist, engines,
      os, cpu, libc, deprecated, hasInstallScript, _hasShrinkwrap, funding
    }
  }
}
```

Probed 2026-06-09 (negotiated `Content-Type: application/vnd.npm.install-v1+json`):
top-level keys are exactly `name, modified, dist-tags, versions`; `express@4.17.1`'s
version object is `dependencies, devDependencies, dist, engines, name, version` —
dependency-class fields are present, the conditional fields above appear only when
the package has them.

Load-bearing differences from the full form:

- **The dependency maps are RETAINED — including `devDependencies`.** The
  abbreviated form is a **metadata trim, not a dependency trim** — the common
  "corgi drops devDependencies" belief is **wrong** (probe above). A converter
  reading a published package's `devDependencies` need **not** fetch the full doc.
- **What is stripped:** `readme`, `time`, `users`, `maintainers`, `author`, the raw
  `scripts` map, and other human/registry-facing fields — the top-level shrinks to
  `{ name, modified, dist-tags, versions }`.
- **`hasInstallScript`** is a server-computed boolean (any `install` /
  `preinstall` / `postinstall` script present) — a corgi-only convenience standing
  in for the stripped `scripts` map.
- `dist` is **identical** to the full form (integrity / signatures intact).
- **`libc` is DROPPED by npm's corgi in practice — even when the package declares it.**
  Despite `libc` appearing in the nominal field list above, `registry.npmjs.org`'s
  abbreviated form omits it (re-probed 2026-07-04: `@napi-rs/nice-linux-x64-gnu@1.0.1`
  corgi → no `libc`; full doc → `libc: ["glibc"]`), while `os` / `cpu` ARE retained. So
  the "conditional fields appear only when the package has them" rule has a **`libc`
  exception**: the package has it, corgi still strips it. A consumer needing
  libc-accurate platform metadata — a yarn-berry `conditions:` emitter, where a missing
  `& libc=<glibc|musl>` on a linux entry fails `yarn install --immutable` (YN0028) —
  MUST backfill from the FULL single-version manifest (`GET /{name}/{version}`, ~1–2 KB).
  `liveRegistry.resolve()` does this for linux versions (non-linux carry no libc → corgi
  is already complete → no extra fetch).

> A registry that ignores the `Accept` header and always returns the full
> document is **conformant but wasteful**; one that returns a *malformed*
> abbreviated doc (missing `dist`) breaks installs. Per-registry specs record
> corgi support explicitly — older Nexus/Artifactory are the usual offenders.

The field set is npm-CLI-defined (`npm-registry-fetch` / `pacote`), not formally
specified, but **pinned above** against a live corgi-`Accept` probe (2026-06-09).

---

## §6 Single-version manifest & the `dist` object

`GET /{name}/{version}` (or each entry of `versions`) is a package's
`package.json` plus registry-injected fields:

```
_id, _nodeVersion, _npmUser, _npmVersion, _npmOperationalInternal, _hasShrinkwrap,
name, version, description,
dependencies, devDependencies, peerDependencies, peerDependenciesMeta,
optionalDependencies, bundleDependencies,
engines, cpu, os, libc,
bin, main, directories, scripts,
gitHead, dist, …
```

The **`dist` object is the load-bearing payload** for this project:

```
dist: {
  tarball:       string,   // absolute URL — opaque, see §1.3 / §6.2
  shasum:        string,   // sha1, lowercase hex (legacy integrity)
  integrity:     string,   // sha512 SRI (RFC 6920) — the modern hash
  fileCount:     number,
  unpackedSize:  number,
  signatures?:   [{ keyid: string, sig: string }],  // registry signature, npm 7+
  attestations?: { url: string, provenance: { predicateType: string } }, // npm 9+ — provenance link, see §13
  "npm-signature"?: string,  // legacy single-signature; broadly present but deprecated
}
```

### 6.1 The integrity fields

- **`dist.integrity`** (sha512 SRI) is the **single irreducible field** for our
  enrich phase: it bridges a source lockfile's sha1-only or berry-zip hashes to
  a canonical sha512 ([`spec/formats/_common §3`](../formats/_common.md#3-integrity-model)
  integrity model). A registry that omits it forces a tarball download to
  recompute. Everything else in `dist` can be absent and the converter degrades
  gracefully.
- **`dist.shasum`** is the legacy sha1. Always present; never sufficient alone
  for a sha512-requiring target.
- A registry `dist.integrity` is parsed with `origin: 'registry'`
  ([integrity model §3.2](../formats/_common.md#32-origin-tags--the-load-bearing-addition)) —
  a tarball-SRI digest, **not** interchangeable with a yarn-berry `checksum`.

### 6.2 The tarball-URL rewrite hazard

`dist.tarball` is **the** cross-registry portability hazard. Proxy/private
registries (Verdaccio, Artifactory) rewrite it to their **own** host so clients
fetch bytes locally; the tarball **bytes** match upstream but the **URL** does
not. A lockfile produced against such a registry carries URLs that resolve
**only inside that network**. Others (Nexus) deliberately leave the upstream
URL intact. This per-registry policy (`passthrough` / `rewrite` / `own`) is
documented in every per-registry spec and surfaced to the adapter via a
URL-remap hook ([§11](#11-mapping-to-registryadapter)).

### 6.3 Signatures, provenance, attestations

- **`dist.signatures`** — the registry's own ECDSA signature over
  `{name}@{version}:{integrity}`, verifiable against [§9](#9-registry-signing-keys)
  keys. Present on every modern npmjs entry; **stripped by registries that do
  not re-sign** (GitHub Packages, often Nexus/Artifactory). Absence breaks
  `npm audit signatures` but **not** installation — installers fall back to
  `integrity`.
- **`attestations`** — link to the SLSA build-provenance + npm-publish attestations
  (npm 9+ `--provenance`); full API in [§13](#13-provenance--attestations).
  Public-npm only; everything else omits it (`null` / 404).
- **`npm-signature`** — legacy single PGP signature; still emitted broadly
  (present on the pinned `lodash@4.17.21` probe) but **deprecated** — superseded
  by `signatures` for verification.

### 6.4 Tarball HTTP semantics

Probed 2026-06-09 (`registry.npmjs.org/lodash/-/lodash-4.17.21.tgz`):
`Content-Type: application/octet-stream`, explicit `Content-Length`,
`Accept-Ranges: bytes` (a `Range:` request yields `206 Partial Content`), and
`Cache-Control: public, immutable, max-age=31557600` (content-addressed → immutable).
Public npm serves the bytes **directly** (`200`, Cloudflare-fronted) — **no
redirect**; proxy / mirror registries MAY `30x` to a CDN ([`npmmirror`](./npmmirror.md)
→ `cdn.npmmirror.com`). Across a cross-host redirect the `Authorization` header is
**not** resent unless the target host carries its own auth prefix
([§2](#2-authentication)) — a frequent private-registry tarball-fetch failure.

---

## §7 dist-tags

`dist-tags` appear inline in the packument ([§4](#4-the-packument-full-document)/[§5](#5-abbreviated-packument-corgi))
and are also exposed standalone at `GET /-/package/{name}/dist-tags`. A tag is a
**moving channel pointer** (`latest`, `next`, `beta`), not a version. Resolution
implications:

- A descriptor whose token is a **tag** (`semver.validRange(tag) === null`)
  resolves via the tag map, not a semver scan — mirrors the yarn-family
  [dist-tag rung](../formats/_common.md#52-the-resolution-ladder-normative) (Rung 3.5).
- `latest` is guaranteed; any other tag is publisher-defined and MAY be absent
  or point at an **older** version than `latest` (`next` frequently does).
- Tags are **registry state at fetch time** — never baked into a lockfile and
  not portable across registries.

---

## §8 Advisories & audit API

> **This is the audit-fix-relevant surface and the sharpest point of divergence
> across registries.** The whole [audit-fix driver feature](../00-overview.md)
> depends on knowing which registry can answer "is `name@version` vulnerable?".

Public npm serves advisories from the **GitHub Advisory Database** (npm's own
advisory DB was migrated to GHSA). Two generations of endpoint exist:

### 8.1 Bulk advisories — `POST /-/npm/v1/security/advisories/bulk` (npm 7+)

The modern path — **the only first-hand-verified client is `npm audit` (npm 7+)**.
`pnpm audit`, yarn-classic `yarn audit`, AND yarn-berry `yarn npm audit` do **not**
use this endpoint — they all POST a tree to the legacy
[§8.2](#82-quick--full-audit--post--npmv1securityauditsquick-npm-6) `/audits` family
(pnpm 6 / 9 / 10 + yarn-classic 1.22.22 → full `/audits`; yarn-berry 2.4.3 →
`/audits/quick`). Client split by endpoint, not by age; see
[`spec/pm/audit-fix.md §2`](../pm/audit-fix.md#2-advisory-transport--which-client-hits-which-endpoint).

- **Request** (gzipped JSON): `{ "<name>": ["<version>", …], … }` — the flat set
  of installed name→versions.
- **Response:** a **single JSON object** (one document, **not** JSONL), keyed by
  package name — `{ "<name>": [ <advisory>, … ] }`; **only** packages with ≥1
  advisory appear. An advisory:

  ```
  { id:    1106913,                       // numeric npm advisory id
    url:    "https://github.com/advisories/GHSA-…",   // GHSA permalink
    title, severity,                      // 'info'|'low'|'moderate'|'high'|'critical'
    vulnerable_versions,                  // semver range, e.g. "<4.17.21"
    cwe: string[], cvss: { score, vectorString } }
  ```

This is the endpoint our audit-fix modifier targets: send the graph's
`{name: [versions]}`, receive the vulnerable set, compute the minimal
satisfying bump.

*(Probed 2026-06-09: `bulk {"lodash":["4.17.15","4.17.20"],"minimist":["1.2.0"]}`
→ `200`, a **single JSON object** `{ lodash:[…], minimist:[…] }` (not
newline-delimited); each advisory exactly `{ id, url, title, severity,
vulnerable_versions, cwe[], cvss{score,vectorString} }` — shape confirmed. The
line-delimited form in npm's API is the [§18](#18-replication--mirror-sync)
`_changes` feed, not advisories.)*

### 8.2 Quick / full audit — `POST /-/npm/v1/security/audits[/quick]` (npm 6)

The legacy path. Request is a **lockfile-shaped tree** (`{ name, version,
requires, dependencies }`, gzipped). `/quick` returns advisories only; the full
`/audits` additionally returns a **remediation `actions` plan** the server
computes. This is **not** a mere legacy fallback: besides npm 6, **`pnpm audit`
(all versions, verified 6 / 9 / 10) and yarn-classic `yarn audit`** post the tree to
full `/audits`, and **yarn-berry `yarn npm audit`** posts it to `/audits/quick`
(verified 2.4.3) — all first-hand from the installed PM source, none use the §8.1
bulk path. `pnpm` ignores the server `actions` plan and computes its
own overrides ([`spec/pm/audit-fix.md §4.3`](../pm/audit-fix.md#43-pnpm--override-pin));
npm 6 consumes it. npm 11 dropped only the `/quick` variant.

#### 8.2.1 Full-audit response envelope

`/audits` (unlike `/quick`) returns a server-computed remediation plan
(npm-audit-report / arborist shape):

```
{ actions: [ { action: "install"|"update"|"review", module, target /* fix version */,
               isMajor?, resolves: [ { id, path, dev, optional } ], depth? } ],
  advisories: { "<id>": { …§8.1 advisory… } },
  muted: [],
  metadata: { vulnerabilities: { info, low, moderate, high, critical },
              dependencies, devDependencies, optionalDependencies, totalDependencies } }
```

The **request** body (both `/audits` and `/quick`, gzipped) is a lockfile-derived
tree: `{ name, version, requires:{…}, dependencies:{ "<dep>": { version, integrity?,
requires?, dependencies? } } }`. The server-computed `actions` plan is exactly what
the audit-fix modifier **replaces** with its own graph-level resolution — useful as a
cross-check, never a dependency.

### 8.3 The "no advisories" class

Many registries implement **none** of [§8.1](#81-bulk-advisories--post--npmv1securityadvisoriesbulk-npm-7)/[§8.2](#82-quick--full-audit--post--npmv1securityauditsquick-npm-6).
A request returns `404`, `400`, or `501`. **Sonatype Nexus is the canonical
example** — `npm audit` against a Nexus npm repo fails outright
([npm/cli#5479][cli5479]). Consequences for this project:

- The audit-fix modifier MUST treat "registry has no advisory endpoint" as a
  first-class state, not an error: it either (a) re-points advisory queries at a
  configurable advisory source (public npm / GHSA) while resolving versions
  against the private registry, or (b) emits a diagnostic and skips the audit
  pass. The version-resolution and advisory-source registries are **separable**.
- Verdaccio is a special case: it ships the **`verdaccio-audit`** plugin which
  *proxies* audit requests to its npm uplink — so a default Verdaccio **does**
  answer audits, by forwarding ([verdaccio.md](./verdaccio.md)).

[cli5479]: https://github.com/npm/cli/issues/5479

---

## §9 Registry signing keys

`GET /-/npm/v1/keys` returns the registry's public signing keys for verifying
`dist.signatures` ([§6.3](#63-signatures-provenance-attestations)):

```
{ "keys": [ { expires: "<ISO|null>", keyid: "SHA256:jl3bwswu80…",
              keytype: "ecdsa-sha2-nistp256", scheme: "ecdsa-sha2-nistp256",
              key: "MFkwEwYHKoZIzj0CAQ…"  /* base64 SPKI public key */ } ] }
```

*(Probed 2026-06-09.)* The `keyid` matches the `dist.signatures[].keyid` it
verifies — e.g. `@babel/core@7.0.0` carries `dist.signatures[0] = { keyid:
"SHA256:jl3bwswu80…", sig: "MEYCIQ…" }`, signed by this key. Consumed by
`npm audit signatures`. **Registry-wide** (one key set for the whole
host), distinct from the per-version `dist.signatures` field. Registries that do
not re-sign return `404`/`400` here (Nexus 3.33 returns `400` —
[npm/cli#5479][cli5479]) and `npm audit signatures` is unavailable; this is
independent of whether per-version `dist.signatures` survive.

---

## §10 Status, caching & error conventions

- **404** — unknown package/version. Body shape varies (`{ "error": "Not
  found" }` on npmjs; differs per server — record in per-registry Quirks).
  A 404 means "not here", which for a non-proxying private registry does **not**
  mean "does not exist on npmjs".
- **401 / 403** — missing/insufficient auth. Distinguish from 404: a registry
  that mandates auth returns 401 on the anonymous probe, not 404.
- **Conditional GET** — packuments carry `ETag` + `Last-Modified`; clients send
  `If-None-Match` / `If-Modified-Since` and accept `304`. The abbreviated
  `modified` field ([§5](#5-abbreviated-packument-corgi)) supports the same.
- **Rate limiting** — `429` with `Retry-After`. Adapters retry with backoff.
- **Compression** — request bodies for audit are `Content-Encoding: gzip`;
  responses are `gzip`/`br`.

---

## §11 Mapping to `RegistryAdapter`

The landed code contract ([`src/main/ts/registry/types.ts`](../../src/main/ts/registry/types.ts))
is the abstraction every backend in this directory implements:

```ts
interface RegistryAdapter {
  packument(name: string): Promise<Packument | undefined>          // §4/§5 → Packument
  resolve(name: string, range: string): Promise<PackumentVersion | undefined>  // §6 + semver/§7
}
```

- **`Packument`** = `{ name, distTags, versions }` — the abbreviated projection
  ([§5](#5-abbreviated-packument-corgi)) is sufficient to populate it; the full
  form is never required on the resolve path.
- **`PackumentVersion.integrity`** carries the [§6.1](#61-the-integrity-fields)
  sha512 with `origin: 'registry'`; `tarball` carries `dist.tarball` **verbatim**
  ([§1.3](#13-tarball-url)). (The wire field `bundleDependencies` maps to
  `PackumentVersion.bundledDependencies` — npm accepts both spellings.)
- **`resolve(name, range)`** applies semver to `versions` and falls through to
  `distTags` for a tag token ([§7](#7-dist-tags)).

Per-registry divergence (auth, URL rewrite, missing audit) does **not** change
this interface. The note in [`spec/03-resolver.md`](../03-resolver.md#registry-interface)
proposes three adapter-level (not interface-level) hooks to absorb the variety:

| Hook | Absorbs |
|------|---------|
| `headers(request)` | auth ([§2](#2-authentication)), custom headers |
| `mapTarballUrl(url)` | the [§6.2](#62-the-tarball-url-rewrite-hazard) rewrite hazard |
| strip-policy → `Diagnostic` | "registry returned a strict subset" (absent `signatures`) is a diagnostic, not an error |

> **Spec↔code drift.** [`spec/03-resolver.md`](../03-resolver.md#registry-interface)
> still describes an older `Registry { versions(); manifest(); tarball?() }`
> stub; the landed code uses `packument()`/`resolve()` above. Reconciling the
> resolver spec to the landed shape is tracked in [`spec/QUEUE.md`](../QUEUE.md).

---

## §12 Conformance — minimum mock contract

A `RegistryAdapter` mock (test bench) MUST implement:

```
GET /{name}            → 200 + { name, dist-tags:{latest:<v>}, versions:{<v>:<doc>} }
GET /{name}/{version}  → 200 + { name, version, dist:{ tarball, integrity } }
GET /{name}/-/{file}   → 200 + tarball bytes  OR  302 redirect to the bytes
```

`dist.integrity` is the only field whose **absence** breaks enrich
([§6.1](#61-the-integrity-fields)); every other field may be absent and the
converter degrades. A mock MAY compose these flags to reproduce a specific
registry's quirks:

| Flag | Reproduces |
|------|-----------|
| `auth: 'required'` | GitHub Packages, private Verdaccio |
| `scope: 'mandatory'` | GitHub Packages |
| `strip: ['signatures']` | GitHub Packages, typical Nexus/Artifactory |
| `strip: ['_npmOperationalInternal']` | typical Artifactory |
| `rewriteTarball: '<base>'` | Verdaccio, Artifactory |
| `noUpstreamFallback: true` | GitHub Packages (no public-npm proxy) |
| `audit: 'absent'` | Nexus (no `/-/npm/v1/security/*`) |
| `corgi: 'ignored'` | older Nexus/Artifactory (always full doc) |

> The mock above covers the **read / resolve / audit** surface. The publish-side
> and account surface — provenance ([§13](#13-provenance--attestations)), lifecycle
> writes ([§14](#14-package-lifecycle-writes)), 2FA + tokens
> ([§15](#15-two-factor-auth--token-taxonomy)), access ([§16](#16-access-control)) —
> is documented below for ecosystem completeness; a mock needs it only when a test
> exercises those flows.

---

## §13 Provenance & attestations

> Supply-chain provenance — the signed record of *how* and *from where* a package
> was built and published. **Public npm only**; the per-registry docs mark it absent
> everywhere else. Extends [§6.3](#63-signatures-provenance-attestations) (the `dist`
> link) and [§9](#9-registry-signing-keys) (the ECDSA signature).

### 13.1 The attestations endpoint

`GET /-/npm/v1/attestations/{name}@{version}` returns the Sigstore attestation
bundles for a version (live-probed `sigstore@1.0.0`, `tuf-js@1.0.0`, 2026-06-08):

```
{ "attestations": [
  { "predicateType": "https://github.com/npm/attestation/tree/main/specs/publish/v0.1",
    "bundle": { "mediaType": "application/vnd.dev.sigstore.bundle+json;version=0.1",
                "dsseEnvelope": {…}, "verificationMaterial": {…} } },
  { "predicateType": "https://slsa.dev/provenance/v0.2",
    "bundle": {…} } ] }
```

A provenanced version carries **two** attestations, each a **Sigstore DSSE bundle**
(`dsseEnvelope` = an in-toto statement + signatures; `verificationMaterial` = the
Fulcio X.509 cert chain + Rekor transparency-log entries):

| Predicate | `predicateType` | Records |
|-----------|-----------------|---------|
| npm publish | `…/npm/attestation/…/publish/v0.1` | the publish event (name, version, registry) |
| SLSA build provenance | `https://slsa.dev/provenance/v0.2` | the build (builder identity, source git URI, CI workflow, materials) |

`404` if the version was **not** published with `--provenance` (or predates
npm 9.5). Probed negatives: `lodash@4.17.21` → 404, `chalk@5.0.0` →
`dist.attestations: null`.

*(Probed 2026-06-09: current packages emit **SLSA `v1`** — `sigstore@2.0.0`'s build
predicate is `https://slsa.dev/provenance/v1`; the `v0.2` shown above is what
`sigstore@1.0.0` / `tuf-js@1.0.0` carried. Both exist in the wild; the predicate
version is fixed per-publish, so a reader must accept either.)*

### 13.2 The `dist.attestations` link

The packument `dist` ([§6](#6-single-version-manifest--the-dist-object)) carries a
**link** to [§13.1](#131-the-attestations-endpoint), present iff the version is
provenanced (else `null`):

```
dist.attestations = { url: "…/-/npm/v1/attestations/{name}@{version}",
                      provenance: { predicateType: "https://slsa.dev/provenance/v0.2" } }
```

`provenance.predicateType` names only the SLSA build record; the endpoint holds
both bundles. A converter MAY record `dist.attestations` as attribution; it is
**not** an enrich input and **not** a resolver precondition.

### 13.3 The publish flow

`npm publish --provenance` (npm 9.5+) is **keyless**: from an OIDC-enabled CI
(GitHub Actions, GitLab CI/CD), npm exchanges the CI's OIDC token for a short-lived
**Sigstore Fulcio** certificate, builds the two attestations, records them in the
**Rekor** transparency log, and stores them server-side — no publisher key. Requires
a **public** package and a matching repository URL. `npm audit signatures` verifies
both the registry ECDSA ([§9](#9-registry-signing-keys)) and the Sigstore / Rekor
chain.

### 13.4 Per-registry

**Public npm only.** GitHub Packages, Nexus, Artifactory, Verdaccio, the cloud
registries, and JSR do **not** expose `/-/npm/v1/attestations/*` (404) and omit
`dist.attestations`. A proxy MUST NOT synthesize the link — a client would follow a
dead URL and fail verification. Absence is a first-class fact (the README matrix
`Attestations` column), not an error. "Absent" means the **npm attestations
endpoint** specifically — [`jsr`](./jsr.md), for one, ships its *own* Sigstore-based
provenance on its native side, just not reachable via `/-/npm/v1/attestations/*`.

---

## §14 Package lifecycle writes

> The write surface that *shapes* read-side metadata. The converter performs **no**
> writes; this is documented so the spec is a complete ecosystem reference, and so
> the meaning of read-side fields (`deprecated`, `time.unpublished`, dist-tags) is
> grounded in how they are set. All are **auth-gated** ([§2](#2-authentication)) and
> are **2FA writes** in `auth-and-writes` mode ([§15.1](#151-2fa-modes)).

### 14.1 Deprecate

`npm deprecate <pkg>[@range] "<message>"` writes (`PUT /{name}`) a `deprecated:
"<message>"` string onto each matching version's manifest; an empty string
**un-deprecates**. A bare `<pkg>` deprecates **all** versions. The `deprecated`
field then surfaces in the full and corgi packuments
([§4](#4-the-packument-full-document)/[§5](#5-abbreviated-packument-corgi)) —
installers print a warning but still install. **Relevance:** audit-fix SHOULD treat
a `deprecated` target as a fix signal, not just CVEs.

### 14.2 Unpublish

`npm unpublish` removes versions, gated by a **72-hour window**: within 72 h of first
publish, a version (or the whole package) can be **fully** removed — it vanishes from
`versions` and `time`; after 72 h npm permits only single-version removal under
policy, leaving an `unpublished` tombstone in `time`
([§4](#4-the-packument-full-document)).
**Hazard:** a lockfile pinning an unpublished version cannot be re-resolved from
metadata (the tarball may persist in caches / proxies).

> **Open:** does `GET /{name}/{version}` return 404 or a tombstone after a >72 h
> single-version unpublish? Live-probe an unpublished version.

### 14.3 Dist-tag writes

`npm dist-tag add <pkg>@<ver> <tag>` → `PUT /-/package/{name}/dist-tags/{tag}` (body
= the version); `rm` → `DELETE`. Tags are registry state at fetch time and never
pinned in a lockfile ([§7](#7-dist-tags)).

---

## §15 Two-factor auth & token taxonomy

> Extends [§2](#2-authentication) with the **account-security** surface: who can
> write, and how 2FA gates it. Read-only resolution never triggers any of this; it
> matters for adapter config (which token type) and for understanding CI publish.

### 15.1 2FA modes

Configurable at **account** level **and** **package** level — a package owner can
**require 2FA** for that package's publishes independently of the publisher's own
account setting. Two levels:

| Mode | Gates |
|------|-------|
| `auth-only` | login + profile / token changes |
| `auth-and-writes` | the above **plus** publish, unpublish, deprecate, dist-tag, `npm access`, owner changes |

Methods: **TOTP** authenticator, **WebAuthn / security keys** (passkeys — under
`auth-and-writes` the key handles the write automatically, no typed code), and
single-use recovery codes; SMS is no longer offered.

### 15.2 The OTP wire protocol

A 2FA-gated write carries the one-time password in the **`npm-otp`** request header
(`npm <cmd> --otp=<code>`). A write missing a required OTP returns **`401`** with a
`www-authenticate: OTP` challenge (the npm client detects the `otp` token in that
header, prompts, and retries; there is no `x-npm-otp` *response* header —
[§10](#10-status-caching--error-conventions)).

### 15.3 The "window without confirm"

There is **no documented account-level configurable time-grace window** for 2FA
writes. The supported ways a write proceeds **without typing a fresh OTP** are:

1. **A granular token with `Bypass 2FA` = true** ([§15.4](#154-token-taxonomy)) — a
   per-token opt-out that **takes precedence over account- and package-level 2FA**
   (npm docs, verbatim). This is the supported automation path and the closest match
   to an "optional [exemption] without confirmation".
2. **Security keys (WebAuthn / passkeys)** — under `auth-and-writes` the key handles
   the write automatically (a touch, not a typed code).
3. **TOTP validity (~30 s)** — a code is valid only for its time-step; the npm CLI
   keeps an **in-memory OTP cache per registry** and reuses a still-valid code within
   a single run (e.g. a workspace multi-publish) instead of re-prompting. This is a
   CLI detail, **not** a server grace — once the code expires (~30 s) or the process
   exits, a fresh OTP is required.

So an interactive `auth-and-writes` publisher re-confirms per write (modulo the
~30 s in-run code reuse); true "no confirmation" comes from **opting a scoped
granular token out via Bypass-2FA**, not from a configurable time window.

### 15.4 Token taxonomy

**As of November 2025, npm supports only granular access tokens** — the legacy
`read-only` / `publish` / `automation` tokens were **removed** (existing ones
invalidated). A granular token:

| Property | Value |
|----------|-------|
| Scope | **per-package / per-scope / per-org** (not account-wide) |
| Permission | **read** or **read-write** |
| Expiry | **mandatory**, ≥ 1 day; no documented maximum |
| IP allowlist | optional CIDR |
| **Bypass 2FA** | optional per-token toggle — when `true` it **overrides account- and package-level 2FA** ([§15.3](#153-the-window-without-confirm)) |

The **Bypass-2FA** toggle is the supported automation / CI path — it replaces the
old legacy `automation` token (which bypassed 2FA and never expired); the exemption
now lives on a granular token **with a mandatory expiry and a narrow scope**, a
strict improvement for blast-radius.

> **Open:** the documented minimum granular-token validity is "at least one day"; no
> maximum is stated — confirm whether an org policy can cap it.
>
> **Historical note.** Lockfiles / `.npmrc` predating Nov 2025 may still reference
> legacy token *shapes*; the wire form ([§2](#2-authentication)) is unchanged
> (`Authorization: Bearer`), so an adapter need not distinguish — only the
> token-issuance UX changed.

---

## §16 Access control

> Public vs restricted (private), and org RBAC — what a credential is *allowed* to
> see and do. Determines whether a private package is even resolvable by a given
> adapter.

### 16.1 Public vs restricted

| | `public` | `restricted` (private) |
|---|---|---|
| Read | anonymous | bearer token **+ org / user membership** |
| Search / listing | yes | hidden |
| Default for | **unscoped** (always public) | **scoped** `@scope/name` on publish |

A scoped package publishes **restricted by default**; `--access public` (or
`publishConfig.access: "public"`) overrides. **Unscoped packages are always
public** — there is no private unscoped package. Private packages require a **paid
plan** (individual, or org / Teams); reading one needs a token with access **and**
(for org-scoped packages) org membership.

### 16.2 `npm access` RBAC

`npm access` manages package access and org-team grants: `set public|restricted`,
`grant <read-only|read-write> <scope:team> [pkg]`, `revoke`, `ls-packages`,
`ls-collaborators`. **Org teams** carry **read-only** vs **read-write**; a user may
be in several. (Per-collaborator grants are the legacy, pre-team mechanism.)

### 16.3 Lockfile implications

- A lockfile that resolved a **private** package is tied to the **credential** used
  — its tarball URLs are unresolvable without auth, and committing it to a public
  repo **leaks private package names** (they appear as keys even though the bytes are
  gated).
- A cross-org graph (`@org-a/x` → `@org-b/private`) needs the consumer authed to
  **both** orgs.
- Names are **not** stripped from lockfiles for privacy (resolution + audit need
  them) — treat private-package-name exposure as a known property, not a bug.

### 16.4 Org / team registry endpoints

The HTTP surface behind `npm org` / `npm team` / `npm access` (routes from
`libnpmorg` / `libnpmteam` / `libnpmaccess`; **source-derived**):

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/-/org/{org}/user` | org roster → `{ "<user>": "owner" \| "admin" \| "developer" }` |
| `PUT` / `DELETE` | `/-/org/{org}/user` | set / remove a member's role |
| `GET` | `/-/team/{org}:{team}/package` | team's package → permission map |
| `PUT` / `DELETE` | `/-/team/{org}:{team}/package` | grant / revoke `read-only` \| `read-write` |
| `GET` / `PUT` / `DELETE` | `/-/team/{org}/{team}/user` | team membership |

All require auth → `401` unauthenticated, `404` if the org / team is invisible to the
caller. Off the resolver path; documented for surface-completeness.

---

## §17 Search API

Package **discovery** — not on the resolver's read path. `GET /-/v1/search` (live-probed
2026-06-09); widely implemented across npm-shape registries (npm, yarn-mirror), absent on
GitHub Packages (GraphQL instead) and typically on cloud / proxy backends.

### 17.1 Request

| Param | Default | Notes |
|-------|---------|-------|
| `text` | — (**required**) | query; embeds qualifiers. Missing → `400` |
| `size` | 20 | page size (server-capped) |
| `from` | 0 | offset; paginate `from += size` |

Qualifiers embedded in `text` (space-separated, AND-combined): `author:<u>`,
`maintainer:<u>`, `keywords:<k>`, `scope:@s`, `is:deprecated` / `is:insecure`,
`not:unstable` / `not:insecure`, plus exact-name boosting.

### 17.2 Response

```
{ "objects": [ {
    "package": { name, version, description, keywords, date, links, publisher, maintainers },
    "score":   { "final": <0–1>, "detail": { "quality": <0–1>, "popularity": <0–1>, "maintenance": <0–1> } },
    "searchScore": <number>,            // query-relevance
    "flags": { "insecure": 0|1 } } ],
  "total": <n>, "time": "<ISO>" }
```

`score.final` blends quality / popularity / maintenance; `searchScore` is query-match
relevance. The legacy whole-index dump `GET /-/all` is **disabled** on npmjs.

> **Open:** the `size` cap and full qualifier grammar are server-defined; pin against a
> probe if a tool relies on them.

---

## §18 Replication & mirror sync

How mirrors (npmmirror / cnpm, Verdaccio uplinks, corporate proxies) stay current — the
mechanism behind "the same package across many stores". **Mirror-only, not a resolver
concern** (the converter fetches packuments directly via [§3](#3-read-endpoints)).

### 18.1 The replication endpoint

`https://replicate.npmjs.com/` is a CouchDB-shaped mirror of the `registry` database.
Root (probed 2026-06-09): `{ db_name:"registry", engine:"npm-replicate", doc_count:~4.1M,
update_seq:<int> }` — `update_seq` is the monotonic high-water mark.

### 18.2 The `_changes` feed

`GET /_changes?since=<seq>&limit=<n>` streams packages changed after `<seq>` (probed):

```
{ "results": [ { "seq": <int>, "id": "<pkg>", "changes": [ { "rev": "<rev>" } ] } ],
  "last_seq": <int> }
```

`rev` is an opaque CouchDB revision (followers ignore it). `since=0` walks from the
start; `feed=continuous` streams.

### 18.3 The follower model

A mirror: (1) reads `update_seq`; (2) loops `GET /_changes?since=<stored>` → for each
changed `id`, fetch the packument ([§5](#5-abbreviated-packument-corgi)) and (eagerly or
on-miss) the tarballs → persist → advance `stored = last_seq`; (3) resumes from the
durable `since` on restart. npm is the single writer, so the feed is append-only and
deterministic (no merge conflicts); sync lag is the poll interval, not server lag.

### 18.4 Per-mirror

| Mirror | Sync | Lag |
|--------|------|-----|
| npmmirror / cnpm | follows replicate (cnpmcore worker; also on-demand `PUT /{pkg}/sync`) | ~minutes |
| Verdaccio | uplink proxy + cache, pull-on-miss ([verdaccio](./verdaccio.md)) | on-demand |
| Nexus / Artifactory / cloud | `remote` / proxy repo, pull-on-miss (no `_changes`) | on-demand |
| GitHub Packages | no replication; own packages only | n/a |

A private network that cannot reach `replicate.npmjs.com` runs a border-gateway follower,
proxies npm on cache-miss, or seeds from a one-off snapshot (stale-risk).

> **Open:** cnpmcore's exact sync trigger (`PUT /{pkg}/sync` → `logId`) and poll cadence —
> probe `registry.npmmirror.com` to pin.

---

## §19 Account, identity & token endpoints

The **account** surface — off the resolver path, needed for publish / private access / CI.
All require auth ([§2](#2-authentication)); anon → `401` (or `{}` for `whoami`).

| Endpoint | Purpose |
|----------|---------|
| `GET /-/whoami` | `{ username }` for the current credential |
| `GET /-/npm/v1/user` | profile (email, `tfa`, …); `POST` updates it (a 2FA write) |
| `POST /-/v1/login` | **web login** (`--auth-type=web`) → `{ loginUrl, doneUrl }`; the browser authenticates, the client polls `doneUrl` for the token |
| `PUT /-/user/org.couchdb.user:<name>` | **legacy CouchDB login** (`--auth-type=legacy`): a basic-auth user doc → `{ token }`. Still used by older / private registries (Verdaccio, Artifactory); public npm prefers web login |

**Token CRUD.** The legacy `GET/POST/DELETE /-/npm/v1/tokens` endpoints still answer on
npmjs but are **no longer the token channel**: since the Nov-2025 granular-only switch
([§15.4](#154-token-taxonomy)), tokens are minted / revoked **via the website**
(`npmjs.com/settings/tokens`); CI pre-issues a token in the UI and mounts it in `.npmrc`.
Private registries MAY still implement the legacy token API — per their docs.

> **Open:** the exact `/-/v1/login` poll protocol and the `whoami` anon body (`{}` vs
> `401`) vary; pin against a probe when wiring an auth adapter.

---

## §20 Security holds & malware quarantine

When npm Security confirms **malware**, a **name-squat**, or a **compromised maintainer**,
it takes over the name and publishes a **security hold** — distinct from a CVE advisory
([§8](#8-advisories--audit-api)) and from unpublish ([§14.2](#142-unpublish)). Audit-fix-relevant.

### 20.1 The `0.0.1-security` placeholder

npm republishes a single inert placeholder — conventionally **`0.0.1-security`** — with
`description: "security holding package"` and `repository → npm/security-holder`. Live
example (probed 2026-06-09): `http@0.0.1-security` carries exactly that description. Prior
(malicious / squatted) versions stay **listed** in `versions` / `time` but are no longer
`latest`, and their manifests / tarballs typically `404`.

### 20.2 Resolver hazard

A lockfile pinning a now-held version fails to re-resolve: the packument lists the version
key, but `GET /{name}/{version}` and the tarball return **404** — a hard stop, not an
advisory. The fix is a **bump to a safe version** (or dropping the name), not `audit fix`'s
semver nudge.

### 20.3 Hold ≠ advisory

A hold is a **policy takeover** (npm-issued, no CVE, version unfetchable); a CVE advisory
([§8](#8-advisories--audit-api)) leaves the version installable and is what `npm audit fix`
acts on. `npm audit` does **not** flag a held version. A resolver SHOULD recognise the
`0.0.1-security` signal and surface a bump-or-drop diagnostic. **Public npm only** — other
registries don't auto-take-over names; a private breach is handled by manual unpublish /
deprecate ([§14](#14-package-lifecycle-writes)).

---

## Sources

- Live probe: `curl https://registry.npmjs.org/lodash/4.17.21` (2026-04-27) —
  pinned shape in [§4](#4-the-packument-full-document)/[§6](#6-single-version-manifest--the-dist-object).
- [`npm/registry`][registry-api] — URL surface (field lists stale).
- npm CLI: `npm-registry-fetch`, `pacote`, `@npmcli/arborist` audit — the
  authoritative source for [§5](#5-abbreviated-packument-corgi)/[§8](#8-advisories--audit-api)/[§9](#9-registry-signing-keys).
- [npm/cli#5479][cli5479] — Nexus audit/keys gap.
- Provenance ([§13](#13-provenance--attestations)) live-probed 2026-06-08:
  `GET /-/npm/v1/attestations/{sigstore,tuf-js}@1.0.0` (two predicates),
  `chalk@5.0.0` / `lodash@4.17.21` (null / 404); predicates per
  [npm/attestation](https://github.com/npm/attestation) +
  [SLSA](https://slsa.dev/provenance/v0.2), signing via [Sigstore](https://docs.sigstore.dev/).
- 2FA / tokens / access ([§15](#15-two-factor-auth--token-taxonomy)/[§16](#16-access-control)),
  fetched 2026-06-09: [about-access-tokens](https://docs.npmjs.com/about-access-tokens/)
  (**granular-only since Nov 2025**; `Bypass 2FA` overrides account/package 2FA;
  expiry ≥ 1 day, no max), [configuring-2fa](https://docs.npmjs.com/configuring-two-factor-authentication/),
  [requiring-2fa-for-publishing](https://docs.npmjs.com/requiring-2fa-for-package-publishing-and-settings-modification/)
  (package-level 2FA), + `npm-registry-fetch` (`npm-otp` header, in-memory OTP cache).
- Prior internal probe note (superseded by this published spec):
  `.artel/research/registry-implementations.md`.
