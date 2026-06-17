# `verdaccio` — self-hosted private/proxy npm registry

> Status: draft (doc/source-derived; live-probe pending for corgi + cached-signature behaviour).
> Updated: 2026-06-16
> Provenance: **Official** (verdaccio.org docs + verdaccio/verdaccio source).
> Family: **npm-shape** — proxy + cache + publish, with **audit forwarding** and **tarball rewrite**.

Verdaccio is the dominant open-source self-hosted npm registry: it proxies uplinks
(default npmjs), caches packuments + tarballs, hosts private packages, and ships a
default-enabled **`verdaccio-audit`** middleware. Two load-bearing divergences: it
**rewrites `dist.tarball` to its own host** (non-portable lockfiles, the opposite
of [`nexus`](./nexus.md)), and — unlike Nexus — it **answers audits by forwarding**
them to the uplink.

## Identity & addressing

- **Base URL:** self-hosted, any host/port/path (dev default `http://localhost:4873`).
- **Scope requirement:** unscoped + scoped from one host; `%2f` + literal-slash per
  [§1.2](./_common.md#12-package-name-routing).
- **Tarball URL policy:** `rewrite` → own host, via `convertDistRemoteToLocalTarballUrls`
  ([#1620](https://github.com/verdaccio/verdaccio/issues/1620),
  [#2675](https://github.com/verdaccio/verdaccio/issues/2675)). Bytes match upstream,
  the URL is local → non-portable ([§6.2](./_common.md#62-the-tarball-url-rewrite-hazard)).
  `VERDACCIO_PUBLIC_URL` (v5+) fixes the host behind a reverse proxy (else URLs point
  at `localhost`).
- **`.npmrc` selector:** `registry=http://<host>/` + `//<host>/:_authToken=…`.

## Authentication

Configurable per the `packages:` access rules (`$all` / `$authenticated` /
`$anonymous`); default `htpasswd` plugin. Read may be public or gated; publish
requires auth. JWT/bearer or legacy token. `always-auth` may be needed so tokens
ride tarball GETs.

## Endpoints

Canonical read surface present. The advisory surface is **proxied, not native**:

| Path | Status |
|------|--------|
| `POST /-/npm/v1/security/advisories/bulk` | **proxy** → uplink (via `verdaccio-audit`) |
| `POST /-/npm/v1/security/audits/quick` | **proxy** → uplink |
| `GET /-/npm/v1/keys` | **absent** (verdaccio serves no keys of its own) |

## Metadata deltas

| Field | Canonical | Verdaccio | Impact |
|-------|-----------|-----------|--------|
| `dist.tarball` | upstream URL | **rewritten to own host** | non-portable |
| `dist.integrity` | sha512 SRI | **preserved** from uplink (transparent cache) | enrich OK |
| `dist.signatures` | present | **passthrough** for proxied entries (npmjs's sig retained); **absent** for local/private packages (verdaccio doesn't sign) | verify against the *uplink's* keys |
| corgi | honoured | ? (modern v5+ likely) | Open |

Verdaccio is a **transparent cache** — it does not re-hash or re-sign; integrity /
signatures on proxied entries are upstream's verbatim. (The earlier "verdaccio
strips signatures" claim is **retracted** — it preserves them.)

## Advisories & audit

**Supported by forwarding.** The default-bundled `verdaccio-audit` middleware
proxies `/-/npm/v1/security/*` to the configured uplink (npmjs), so `npm audit`
works out-of-the-box — **provided an uplink is configured and reachable**. This is
the key contrast to [`nexus`](./nexus.md) / [`npmmirror`](./npmmirror.md) (no
advisory surface at all). Caveats: if the middleware is disabled or the uplink is
offline, audits fail (degrades to the [no-advisories class](./_common.md#83-the-no-advisories-class)).
Behaviour on uplink error is unverified (Open).

## Capabilities

| Capability | Supported | Notes |
|------------|:---------:|-------|
| Anonymous read | ~ | per `packages:` config |
| Unscoped / scoped packages | ✓ / ✓ | |
| Abbreviated packument (corgi) | ? | |
| `dist.integrity` | ✓ | preserved |
| `dist.signatures` | ~ | proxied entries: passthrough; local: none |
| Provenance / attestations | ✗ | |
| Bulk advisories | ~ | plugin proxy to uplink |
| Registry signing keys | ✗ | none of its own |
| Search | ✓ | |
| Proxy / cache of upstream npm | ✓ | default uplink npmjs |

## Quirks

- **Tarball rewrite** → non-portable lockfile URLs; `VERDACCIO_PUBLIC_URL` needed
  behind a proxy.
- **Audit is middleware** — default-enabled but can be turned off; if off, behaves
  like Nexus.
- **Local vs proxied split** — a `packages:` pattern with no `proxy:` is host-only
  (no uplink, no signatures); proxied patterns inherit upstream metadata.
- **Auth on tarballs** — set `always-auth` so tokens survive the tarball GET / 302.

## Adapter mapping

| Concern | Setting |
|---------|---------|
| `headers()` | Bearer/Basic from `//host/:_authToken` (packument + tarball) |
| tarball URL remap | required — map local `dist.tarball` back to the uplink for portability, or to `VERDACCIO_PUBLIC_URL` |
| degraded facts | keys absent; signatures only on proxied entries; advisories work only while the uplink is reachable |

## Probes & fixtures

- **Live probe pending** (self-hosted): confirm corgi `Accept` and whether cached
  `dist.signatures` survive on v6.
- **Mock flags:** `{ rewriteTarball: '<base>', audit: 'proxy', strip: [] }`
  (signatures are **not** stripped for proxied entries).

## Open questions

> **Open:** does v6 honour the corgi `Accept` header?
> **Open:** do cached `dist.signatures` survive verdaccio's caching layer (docs say
> passthrough — verify on a live v6 instance)?
> **Open:** `verdaccio-audit` behaviour when the uplink is offline / returns 5xx —
> fail or degrade?

## Sources

- [configuration](https://verdaccio.org/docs/configuration),
  [uplinks](https://verdaccio.org/docs/uplinks),
  [packages](https://verdaccio.org/docs/packages) (2026-06-08).
- Tarball rewrite — [verdaccio#1620](https://github.com/verdaccio/verdaccio/issues/1620),
  [#2675](https://github.com/verdaccio/verdaccio/issues/2675); the `verdaccio-audit`
  middleware.
