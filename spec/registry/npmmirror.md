# `npmmirror` — npmmirror / cnpm (`registry.npmmirror.com`)

> Status: stable (live-probed 2026-06-08).
> Updated: 2026-06-16
> Provenance: **Official** (open-source [`cnpmcore`](https://github.com/cnpm/cnpmcore);
> public instance operated by Ant Group / Alipay).
> Family: **npm-shape** + cnpm sync-attribution fields.

`registry.npmmirror.com` (formerly `registry.npm.taobao.org`) is a public
**proxy / cache** of npm for the greater-China region, built on the open-source
`cnpmcore`. It speaks the [canonical npm read contract](./_common.md) for
resolve / enrich, but diverges on four load-bearing axes: **tarball URLs
rewritten to a CDN**, **`dist.signatures` / attestations stripped**, **extra cnpm
sync fields**, and **no advisory / audit API**.

## Identity & addressing

- **Default base URL:** `https://registry.npmmirror.com` (legacy
  `https://registry.npm.taobao.org` still resolves — see Quirks).
- **Scope requirement:** unscoped + scoped; both `/@scope/name` and
  `/@scope%2fname` accepted (probe 2026-06-08).
- **Tarball URL policy:** `rewrite` → CDN. `dist.tarball` is
  `https://registry.npmmirror.com/{name}/-/{file}.tgz`, which **302-redirects to
  `https://cdn.npmmirror.com/packages/…`** on GET. Probe (2026-06-08):
  `…/lodash/-/lodash-4.17.21.tgz → 302 →
  https://cdn.npmmirror.com/packages/lodash/4.17.21/lodash-4.17.21.tgz`. Bytes
  match upstream; the **URL recorded in a lockfile is npmmirror's**, resolvable
  only while npmmirror/CDN is reachable → **non-portable** off that network
  ([§6.2 hazard](./_common.md#62-the-tarball-url-rewrite-hazard)).
- **`.npmrc` selector:** `registry=https://registry.npmmirror.com/`.

## Authentication

All reads anonymous — packument, tarball, and the CDN. No token for public
packages.

## Endpoints

Canonical read surface present (packument / version / tarball / search /
dist-tags / ping). **Absent** (probed 2026-06-08):

| Path | Status |
|------|--------|
| `GET /-/npm/v1/keys` | **`[NOT_FOUND]`** |
| `POST /-/npm/v1/security/advisories/bulk` | **`[NOT_IMPLEMENTED]`** |
| `POST /-/npm/v1/security/audits[/quick]` | **`[NOT_IMPLEMENTED]`** |

`GET /-/ping` → `{"pong":true}` (cnpmcore envelope), not npmjs's `{}`.

## Metadata deltas

| Field | Canonical | npmmirror | Impact |
|-------|-----------|-----------|--------|
| `dist.tarball` | upstream npmjs URL | rewritten to `registry.npmmirror.com` (→ CDN 302) | non-portable URL |
| `dist.integrity` | sha512 SRI | **preserved** | enrich OK |
| `dist.signatures` | present (npm 7+) | **stripped** | no signature verification |
| `attestations` / `npm-signature` | present | **stripped / absent** | — |
| corgi (`Accept: …install-v1+json`) | honoured | **honoured** | install-fetch OK |
| `dist.size`, `dist.noattachment` | — | **added** (cnpm) | attribution |
| `_cnpm_publish_time` | — | **added** (UNIX ms) | sync attribution |
| `_cnpmcore_publish_time` | — | **added** (ISO-8601) | sync attribution |
| `publish_time` | — | **added** (UNIX ms; mirrors upstream) | attribution |
| `_source_registry_name` | — | **added** (currently `null`; intended as the upstream id) | sync attribution |

The cnpm `_cnpm*` / `publish_time` / `_source_registry_name` fields are
**attribution only** — never graph facts; the converter ignores them for identity
([attribution principle](../formats/_common.md#23-canonical-vs-pm-native-attribution-principle)).

## Advisories & audit

**None** — the [no-advisories class](./_common.md#83-the-no-advisories-class).
`/-/npm/v1/security/*` → `[NOT_IMPLEMENTED]`, `/keys` → `[NOT_FOUND]` (probed).
Audit-fix must decouple the advisory source (public npm / GHSA) from version
resolution (npmmirror), exactly as for [`nexus`](./nexus.md). Resolution and
`dist.integrity` work normally, so only the vulnerability-lookup half relocates.

## Capabilities

| Capability | Supported | Notes |
|------------|:---------:|-------|
| Unscoped / scoped packages | ✓ / ✓ | both `%2f` and literal-slash forms |
| Abbreviated packument (corgi) | ✓ | |
| `dist.integrity` | ✓ | preserved from upstream |
| `dist.signatures` | **✗** | stripped |
| Provenance / attestations | **✗** | absent |
| Bulk advisories | **✗** | `[NOT_IMPLEMENTED]` |
| Registry signing keys | **✗** | `[NOT_FOUND]` |
| Search | ✓ | |
| Proxy / cache of upstream npm | ✓ | the canonical proxy example |

## Quirks

- **Tarball CDN redirect** — the metadata URL is `registry.npmmirror.com`; bytes
  come from `cdn.npmmirror.com` via 302. Clients that follow redirects work
  transparently; strict offline / allowlist environments that pin the metadata
  host break.
- **Legacy `registry.npm.taobao.org`** — the original domain, deprecated in favour
  of npmmirror; still responds, but new configs should use npmmirror.
- **`ping` envelope** is `{"pong":true}` (cnpmcore), not npmjs `{}`.
- **Sync lag** — eventually consistent with npm; new versions sync within
  seconds–minutes.

## Adapter mapping

| Concern | Setting |
|---------|---------|
| `headers()` | none (anonymous) |
| tarball URL remap | follow the 302 to `cdn.npmmirror.com`, or pre-rewrite; required in redirect-hostile networks |
| degraded facts | advisories + signing keys → route to a separate advisory source; `dist.signatures` absent is a diagnostic, not an error |

## Probes & fixtures

- **Probes (2026-06-08, anonymous `curl`):** `/lodash/4.17.21` (dist: integrity
  preserved, tarball → npmmirror, signatures absent, `_cnpm_publish_time` /
  `_cnpmcore_publish_time` / `publish_time` present); `-I
  /lodash/-/lodash-4.17.21.tgz` (302 → `cdn.npmmirror.com`); `/@babel/core` + `%2f`
  form (scoped, `_source_registry_name: null`); corgi `Accept` on `/lodash`
  (abbreviated, integrity present); `/-/npm/v1/keys` (`[NOT_FOUND]`);
  `POST /-/npm/v1/security/advisories/bulk` (`[NOT_IMPLEMENTED]`); `/-/ping`
  (`{"pong":true}`).
- **Mock flags:** `{ audit: 'absent', strip: ['signatures'], rewriteTarball:
  'https://cdn.npmmirror.com/packages' }`.

## Open questions

*(Probed 2026-06-09: the CDN 302 indirection is **stable** —
`registry.npmmirror.com/lodash/-/…tgz` → `302 → cdn.npmmirror.com/packages/…` via
Tengine; corgi `modified` **is** present (`"2026-04-01T…Z"` for lodash);
`_source_registry_name` is currently **`null`**, not `"default"`.)*

> **Open:** does corgi `modified` track the upstream publish time or the local sync
> time (present, cadence unconfirmed)? And whether `_source_registry_name` is ever
> populated for a multi-upstream cnpmcore is likewise open.

## Sources

- Live probes (2026-06-08), as listed above, against `registry.npmmirror.com`.
- `cnpmcore` (open-source backend) — [github.com/cnpm/cnpmcore](https://github.com/cnpm/cnpmcore).
