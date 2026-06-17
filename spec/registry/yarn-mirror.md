# `yarn-mirror` — Yarn's default registry (`registry.yarnpkg.com`)

> Status: stable (live-probed 2026-06-08).
> Updated: 2026-06-16
> Provenance: **Official** (Yarn's maintained default registry).
> Family: **npm-shape** — a transparent mirror of public npm; **field-identical**.

`registry.yarnpkg.com` is Yarn's default `npmRegistryServer` (Classic and Berry) —
a monitored, geo-replicated mirror of public npm operated by the Yarn team. It
implements the [canonical npm read contract](./_common.md) with **no observed
divergence**: identical packument / `dist` shape, live advisory API, live signing
keys. For the converter it is **interchangeable with [`npm`](./npm.md)**; this doc
records that equivalence and the single portability nuance (tarball URLs point at
npmjs, not yarnpkg).

## Identity & addressing

- **Default base URL:** `https://registry.yarnpkg.com` — Yarn's built-in default
  when no `registry=` / `npmRegistryServer` is configured.
- **Scope requirement:** unscoped + scoped from one host; both `/@scope/name` and
  `/@scope%2fname` accepted ([§1.2](./_common.md#12-package-name-routing)). Probe:
  `GET /@babel%2fcore/7.0.0` → 200.
- **Tarball URL policy:** `passthrough` — `dist.tarball` is
  `https://registry.npmjs.org/{name}/-/…`, **not** a yarnpkg host. Probe
  (2026-06-08): `lodash@4.17.21 → dist.tarball =
  https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz`. A lockfile built here
  therefore carries **npmjs** URLs — the same globally-portable profile as public
  npm.
- **`.npmrc` selector:** Yarn default; explicit `registry=https://registry.yarnpkg.com/`.

## Authentication

Anonymous reads ([§2](./_common.md#2-authentication)); auth only for publish /
identity. Probe: `GET /lodash` → 200 anonymous; `GET /-/whoami` (no creds) → 401.

## Endpoints

Full canonical read surface ([§3](./_common.md#3-read-endpoints)) present 1:1,
**including** the advisory + keys endpoints public npm serves. Probes (2026-06-08):

- `GET /-/npm/v1/keys` → 200 (ECDSA `nistp256` key set).
- `POST /-/npm/v1/security/advisories/bulk {"lodash":["4.17.21"]}` → 200 (GHSA advisories).
- `GET /-/ping` → 200.

## Metadata deltas

**No material delta from [`npm`](./npm.md).** Probed `dist` for `lodash@4.17.21`
(2026-06-08) matches npmjs: `{ shasum, tarball (→npmjs), fileCount, integrity
(sha512 SRI), signatures ([ecdsa]), unpackedSize, npm-signature }`.
`dist.signatures` is present and verifiable against `/-/npm/v1/keys`. Corgi is
honoured (`Accept: application/vnd.npm.install-v1+json`).

## Advisories & audit

**Full support**, proxied live and GHSA-backed — identical to
[`_common §8`](./_common.md#8-advisories--audit-api). `advisories/bulk` and
`/-/npm/v1/keys` both return 200. The audit-fix modifier treats yarn-mirror as a
full-capability registry, exactly as [`npm`](./npm.md).

## Capabilities

Matches [`npm`](./npm.md): tarball passthrough; scoped + unscoped; corgi; integrity;
signatures; advisories; keys. **Exception:** provenance `dist.attestations` are **not
replicated** to yarn-mirror (probed `null` even for a provenanced package — see Open).

## Quirks

- **Tarball URLs are npmjs URLs**, not yarnpkg — both bytes and URL resolve at
  `registry.npmjs.org`, so yarn-mirror lockfiles are portable everywhere, unlike
  rewrite registries ([`npmmirror`](./npmmirror.md), [`artifactory`](./artifactory.md)).
- **Geo-replication** — a client may hit a regional copy; all sync from canonical
  npm. No client-visible staleness expected (lag bound unverified — see Open).

## Adapter mapping

The default `live` adapter
([`src/main/ts/registry/live.ts`](../../src/main/ts/registry/live.ts)) needs **no**
changes: no auth header, no tarball remap, no degraded facts.

## Probes & fixtures

- **Probes (2026-06-08, anonymous `curl`):** `/lodash/4.17.21` (dist → npmjs
  tarball, signatures present); `/@babel/core/7.0.0` + `/@babel%2fcore/7.0.0` (both
  200, tarball → npmjs); corgi `Accept` on `/express`; `/-/npm/v1/keys` (200 ECDSA);
  `POST /-/npm/v1/security/advisories/bulk` (200 GHSA); `/-/whoami` (401);
  `/-/ping` (200).
- **Mock flags:** none — yarn-mirror IS the bare
  [§12](./_common.md#12-conformance--minimum-mock-contract) contract (= `npm`).

## Open questions

*(Probed 2026-06-09: yarn-mirror does **not** carry `dist.attestations` even for a
provenanced package — `chalk@5.3.0` → `null` — so provenance attestations are not
replicated to the mirror; fetch them from `registry.npmjs.org`.)*
> **Open:** bound the npm → mirror sync lag for freshly-published versions.

## Sources

- Live probes (2026-06-08): `curl https://registry.yarnpkg.com/{lodash, lodash/4.17.21,
  @babel/core/7.0.0}`, corgi `Accept` on `/express`, `/-/npm/v1/keys`,
  `POST /-/npm/v1/security/advisories/bulk`, `/-/whoami`, `/-/ping`.
- Yarn config default — [`npmRegistryServer`](https://yarnpkg.com/configuration/yarnrc#npmRegistryServer).
