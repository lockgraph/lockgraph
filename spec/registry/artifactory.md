# `artifactory` — JFrog Artifactory npm repositories

> Status: draft (source/issue-derived; live-probe pending).
> Updated: 2026-06-16
> Provenance: **Reverse-engineered** (JFrog docs + npm/pnpm/dependabot issues; no
> published npm-API spec).
> Family: **npm-shape**, with tarball-rewrite + signature-strip + audit gaps.

JFrog Artifactory is a commercial, self-hosted artifact manager; its **npm-format**
repos come as `local` (private), `remote` (proxy / cache of an upstream), and
`virtual` (merge). All speak the [canonical read contract](./_common.md). The
load-bearing divergences vs [`nexus`](./nexus.md): Artifactory **rewrites
`dist.tarball` to its own host** (Nexus passes upstream through) and **strips
`dist.signatures`**.

## Identity & addressing

- **Base URL:** `https://<host>/artifactory/api/npm/<repo>/` (per-repo).
- **Scope requirement:** unscoped + scoped (npm-shape baseline; `%2f` form inferred
  — Open).
- **Tarball URL policy:** `rewrite` → own host. Evidence
  ([pnpm#6725](https://github.com/pnpm/pnpm/issues/6725), JFrog RTFACT-23931):
  metadata returns `https://<host>/artifactory/api/npm/<repo>/…/-/…tgz`. Bytes match
  upstream (for `remote`), the URL does not → **non-portable**
  ([§6.2](./_common.md#62-the-tarball-url-rewrite-hazard)).
- **`.npmrc` selector:** `registry=https://<host>/artifactory/api/npm/<repo>/` +
  `//<host>/artifactory/api/npm/<repo>/:_authToken=…`.

## Authentication

| Operation | Required? | Mechanism |
|-----------|:---------:|-----------|
| read | configurable (often required) | Bearer access-token (or legacy `X-JFrog-Art-Api`) / Basic |
| tarball | same (`always-auth`) | |
| publish | yes | |

## Endpoints

Canonical read surface for packument / version / tarball / search. **Absent**
(analogous to Nexus; exact codes need a probe — Open):
`/-/npm/v1/security/advisories/bulk`, `/-/npm/v1/security/audits[/quick]`,
`/-/npm/v1/keys`.

## Metadata deltas

| Field | Canonical | Artifactory | Impact |
|-------|-----------|-------------|--------|
| `dist.tarball` | upstream URL | **rewritten to own host** | non-portable |
| `dist.integrity` | sha512 SRI | preserved | enrich OK |
| `dist.signatures` | present | **stripped from version endpoint** ([dependabot-core#14612](https://github.com/dependabot/dependabot-core/issues/14612)) | `npm audit signatures` / Corepack verify fail |
| `_npmOperationalInternal` | npmjs-internal | likely stripped (?) | — |
| corgi | honoured | ? (older versions ignored it) | — |

## Advisories & audit

**None** — the [no-advisories class](./_common.md#83-the-no-advisories-class);
`npm audit` fails. **JFrog Xray** is a separate commercial SCA scanner — it does
**not** expose the npm `/-/npm/v1/security/*` API, so it is not a drop-in from the
npm CLI's perspective. Audit-fix decouples the advisory source, as for Nexus.

## Capabilities

| Capability | Supported | Notes |
|------------|:---------:|-------|
| Unscoped / scoped packages | ✓ / ✓ | |
| Abbreviated packument (corgi) | ? | older versions ignored `Accept` |
| `dist.integrity` | ✓ | local/remote preserve |
| `dist.signatures` | **✗** | stripped (version endpoint) |
| Provenance / attestations | ? | unverified |
| Bulk advisories | **✗** | |
| Registry signing keys | **✗** | |
| Search | ✓ | |
| Proxy / cache of upstream | ✓ | `remote` repo |

## Quirks

- **`virtual` repo identity split** — like Nexus `group`, a name may resolve to a
  private or upstream package per merge order; the same name ≠ same bytes as public
  npm ⇒ **non-portable identity**.
- **Tarball rewrite not trivially disable-able** — all lockfiles built here carry
  local URLs.
- **Version-endpoint signature strip** — `GET /{name}/{version}` omits
  `dist.signatures`; package-root behaviour unverified (Open).
- **Extended URL path** (`/artifactory/api/npm/<repo>/`) has tripped some npm
  tooling ([npm/cli#8216](https://github.com/npm/cli/issues/8216),
  [#8319](https://github.com/npm/cli/issues/8319)).

## Adapter mapping

| Concern | Setting |
|---------|---------|
| `headers()` | Bearer access-token / Basic from the per-repo auth prefix |
| tarball URL remap | required — rewrite to local Artifactory URL (or to upstream when a `remote` repo + upstream bytes suffice) |
| degraded facts | signatures + advisories + keys → route advisories elsewhere; absent signatures = diagnostic |

## Probes & fixtures

- **Live probe pending** (commercial / self-hosted).
- **Mock flags:** `{ audit: 'absent', strip: ['signatures'], rewriteTarball:
  'https://<host>/artifactory/api/npm/<repo>' }`.

## Open questions

> **Open:** probe a real instance (local / remote / virtual): exact `/keys` +
> `/security/*` status codes; whether `dist.signatures` is stripped only from the
> version endpoint or also the package root; corgi `Accept` support; whether the
> tarball rewrite is configurable; `_npmOperationalInternal` strip.
> **Open:** confirm `virtual` merge-order identity semantics with a two-repo example.

## Sources

- [pnpm#6725](https://github.com/pnpm/pnpm/issues/6725) (tarball rewrite),
  [dependabot-core#14612](https://github.com/dependabot/dependabot-core/issues/14612)
  (signature strip), [npm/cli#8216](https://github.com/npm/cli/issues/8216) /
  [#8319](https://github.com/npm/cli/issues/8319) (URL path),
  [npm/cli#5479](https://github.com/npm/cli/issues/5479) (audit-gap parallel).
- [JFrog Artifactory](https://jfrog.com/artifactory/),
  [JFrog Xray](https://jfrog.com/xray/) (accessed 2026-06-08).
