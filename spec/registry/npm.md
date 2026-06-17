# `npm` — public npm registry (`registry.npmjs.org`)

> Status: stable (live-probed 2026-04-27).
> Updated: 2026-06-16
> Provenance: **Official** (de-facto; the running server is the spec).
> Family: **npm-shape** — this **is** the reference shape.

Public npm, operated by GitHub/Microsoft, is the canonical npm-shape registry.
**It defines [`_common.md`](./_common.md)** — this doc records only the few
facts specific to the public instance; everything structural lives there.

## Identity & addressing

- **Default base URL:** `https://registry.npmjs.org`
- **Scope requirement:** unscoped + scoped both served from one host.
- **Tarball URL policy:** `passthrough` — `dist.tarball` points at
  `registry.npmjs.org/{name}/-/…`, globally resolvable, anonymous. Tarballs are
  in practice served via the Cloudflare-fronted CDN but the URL stays on the
  canonical host. This is the **only** registry whose lockfile tarball URLs are
  portable everywhere by default.
- **`.npmrc` selector:** the default; `registry=https://registry.npmjs.org/`.

## Authentication

Anonymous for all reads ([§2](./_common.md#2-authentication)). Auth is needed
only for publish, private packages, and `whoami`. The converter's steady-state
path needs **no** credentials here — the property that makes public npm the
universal enrich fallback.

## Endpoints

Implements the full canonical read surface ([§3](./_common.md#3-read-endpoints))
1:1 — it is the surface. Notable specifics:

- `GET /-/v1/search` is live; the legacy `GET /-/all` whole-index dump is
  **disabled** (returns an error) — do not rely on it.
- All four advisory/audit endpoints ([§8](./_common.md#8-advisories--audit-api))
  and `/-/npm/v1/keys` ([§9](./_common.md#9-registry-signing-keys)) are live and
  GHSA-backed.

## Metadata

Canonical. The pinned live probe of the `dist` object
([`_common §4`](./_common.md#4-the-packument-full-document)/[§6](./_common.md#6-single-version-manifest--the-dist-object)):

```
GET https://registry.npmjs.org/lodash/4.17.21
dist: [fileCount, integrity, npm-signature, shasum, signatures, tarball, unpackedSize]
```

- `dist.integrity` (sha512 SRI) — always present on modern entries.
- `dist.signatures` — present; verifiable against `/-/npm/v1/keys`.
- `attestations` — present on packages published with `npm publish --provenance`
  (npm 9+), linking SLSA provenance.
- `_npmOperationalInternal` — npmjs-internal CDN host + tmp tarball hints;
  carries no graph fact, safe to ignore.

## Advisories & audit

Full support — the reference for [§8](./_common.md#8-advisories--audit-api).
`POST /-/npm/v1/security/advisories/bulk` is the endpoint the audit-fix modifier
calls. Advisory data originates in the **GitHub Advisory Database**.

## Provenance, lifecycle & account surface

npm is the **reference implementation** for the write / account surface too — other
registries narrow from these (most: no provenance, a different token model):

- **Provenance** ([`_common §13`](./_common.md#13-provenance--attestations)) — the
  `/-/npm/v1/attestations/{name}@{version}` endpoint is **live** (Sigstore-backed);
  `dist.attestations` is populated for `--provenance` publishes. npm is the **only**
  registry serving it.
- **Lifecycle writes** ([`_common §14`](./_common.md#14-package-lifecycle-writes)) —
  deprecate / unpublish (72 h window) / dist-tag, all live here.
- **2FA + tokens** ([`_common §15`](./_common.md#15-two-factor-auth--token-taxonomy)) —
  `auth-only` vs `auth-and-writes`, the `npm-otp` challenge, legacy vs granular tokens.
- **Access** ([`_common §16`](./_common.md#16-access-control)) — scoped =
  restricted-by-default, `npm access` RBAC, paid-org private packages.

## Capabilities

Public npm is the maximal baseline — every **capability** column is supported.
(The `Scoped-only` column is `✗` by design: npm serves unscoped *and* scoped
packages from one host; `Tarball URL` is `passthrough`.) Every other registry is
a subset of this plus transport quirks.

## Quirks

- **Unpublished versions** linger in `time` with an `unpublished` marker but are
  absent from `versions`; a lockfile pinning such a version cannot be re-resolved
  from metadata (tarball may still be cached).
- **Scoped-name `%2f`** ([§1.2](./_common.md#12-package-name-routing)): the
  official client encodes `@scope%2fname` for packument GETs; the server also
  accepts the literal slash.
- **`_npmOperationalInternal.host`** occasionally points tarball fetches at a
  staging host; clients MUST still treat `dist.tarball` as authoritative.

## Adapter mapping

The default `live` adapter ([`src/main/ts/registry/live.ts`](../../src/main/ts/registry/live.ts))
needs no auth header, no tarball remap, and no degraded facts. It is the
**reference adapter** and the enrich-phase fallback every other registry's
lockfile can be verified against ([`10-sources.md`](../10-sources.md)).

## Probes & fixtures

- **Probe:** `curl https://registry.npmjs.org/lodash/4.17.21 | jq keys`
  (2026-04-27), pinned in [`_common §4`](./_common.md#4-the-packument-full-document).
- **Mock flags:** none — the bare [§12](./_common.md#12-conformance--minimum-mock-contract)
  contract *is* public npm.

## Open questions

*(Both resolved 2026-06-09: the corgi field set is pinned in
[`_common §5`](./_common.md#5-abbreviated-packument-corgi) — the abbreviated form
**retains `devDependencies`**; the signing-key object + a `dist.signatures` example are
pinned in [`_common §9`](./_common.md#9-registry-signing-keys).)* No open questions
remain for the reference instance.
