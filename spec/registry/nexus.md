# `nexus` — Sonatype Nexus Repository (npm format)

> Status: draft (source-derived: Sonatype docs + cited issues; live-probe pending).
> Updated: 2026-06-16
> Provenance: **Source-only** (Sonatype docs + npm/cli issues; not a published
> API spec).
> Family: **npm-shape** (read surface), with a documented **advisory gap**.

Sonatype Nexus Repository is a self-hosted artifact manager. Its **npm-format**
repositories come in three roles — `hosted` (private packages), `proxy` (caches
an upstream like npmjs), and `group` (merges several repos behind one URL). To a
client all three speak the [canonical npm read contract](./_common.md); the
load-bearing divergence is that **Nexus implements none of the npm advisory /
signing-keys API** — the single most-cited Nexus npm limitation and the reason
audit-fix must decouple its advisory source here.

## Identity & addressing

- **Default base URL:** `https://<host>/repository/<repo-name>/`
  (e.g. `https://nexus.corp/repository/npm-group/`). Per-repo, not per-host —
  one Nexus serves many npm registries at distinct paths.
- **Scope requirement:** unscoped + scoped both served. Scoped publish to a
  hosted repo is supported; the `@scope%2f` packument form is accepted.
- **Tarball URL policy:** `passthrough` — a Nexus **proxy** repo serves
  `dist.tarball` **pointing at the upstream** (`registry.npmjs.org`), per the
  [Sonatype support article][sonatype-tarball]; it does **not** rewrite to a
  local URL the way Verdaccio/Artifactory do. *(Earlier internal drafts claimed
  rewriting — wrong direction; corrected here.)* Consequence: a lockfile built
  against a Nexus proxy carries **upstream** tarball URLs that resolve outside
  the Nexus network — the *opposite* portability profile to Artifactory.
- **`.npmrc` selector:** `registry=https://<host>/repository/<repo>/` plus a
  per-path `//<host>/repository/<repo>/:_authToken=…`.

[sonatype-tarball]: https://support.sonatype.com/hc/en-us/articles/223134868

## Authentication

| Operation | Required? | Mechanism |
|-----------|:---------:|-----------|
| read (hosted/proxy/group) | configurable (often required for hosted) | Bearer token or Basic |
| read tarball | same as packument (set `always-auth`) | |
| publish | yes | |

NPM Bearer tokens and HTTP Basic both work; the repo's security realm decides.
`always-auth` is commonly required because the tarball path is under the same
authenticated prefix.

## Endpoints

Canonical read surface ([§3](./_common.md#3-read-endpoints)) for packument /
version / tarball / search. **Absent** (the divergence):

| Method | Path | Status | Evidence |
|--------|------|--------|----------|
| `POST` | `/-/npm/v1/security/advisories/bulk` | **absent** | npm audit unsupported |
| `POST` | `/-/npm/v1/security/audits[/quick]` | **absent** | — |
| `GET` | `/-/npm/v1/keys` | **absent** — returns `400` | Nexus 3.33, [npm/cli#5479][cli5479] |

[cli5479]: https://github.com/npm/cli/issues/5479

## Metadata deltas

| Field | Canonical | Nexus | Impact |
|-------|-----------|-------|--------|
| `dist.tarball` | upstream URL | **upstream URL** (passthrough) | portable; unlike Artifactory |
| `dist.integrity` | sha512 SRI | preserved on proxy | enrich OK |
| `dist.signatures` | present | **strip claim unverified** | see Open |
| corgi (`Accept: …install-v1+json`) | honoured | **unverified** — older Nexus ignored it | extra bytes if full-doc only |

## Advisories & audit

**None.** This is the canonical "no advisories" registry
([`_common §8.3`](./_common.md#83-the-no-advisories-class)) — Anton's recalled
constraint, confirmed by [npm/cli#5479][cli5479]: `npm audit` and
`npm audit signatures` both fail against a Nexus npm repo (`E400` / endpoint
missing). Implications for audit-fix:

- The modifier MUST NOT treat the missing endpoint as "no vulnerabilities" — it
  is **no answer**. It either re-points advisory queries at public npm / GHSA
  (resolving *versions* still against Nexus) or emits a diagnostic and skips.
- This is purely the **advisory** surface; version resolution, `dist.integrity`,
  and tarball fetch work normally, so enrich and audit-fix's *resolution* half
  function — only the *vulnerability lookup* half must be sourced elsewhere.

## Capabilities

| Capability | Supported | Notes |
|------------|:---------:|-------|
| Unscoped / scoped packages | ✓ / ✓ | |
| Abbreviated packument (corgi) | ? | older versions ignored `Accept` |
| `dist.integrity` | ✓ (proxy preserves) | |
| `dist.signatures` | ? | strip claim unverified |
| Provenance / attestations | ✗ | not re-emitted (proxy) |
| Bulk advisories | **✗** | the headline gap |
| Registry signing keys | **✗** | `400` |
| Search | ✓ | |
| Proxy/cache of upstream | ✓ | proxy role |

## Quirks

- **`group` repos** merge hosted + proxy; a name may resolve to a private
  package **or** an upstream one depending on merge order — the same name can
  mean different bytes than public npm. Treat a Nexus-group lockfile as
  **non-portable** for identity even though tarball URLs are upstream.
- **Tarball URL is upstream, packument is local** — an unusual split: metadata
  comes from Nexus, bytes from npmjs. If the proxy is offline the lockfile's
  tarball URLs may still resolve directly against npmjs.
- **404 body** differs from npmjs (Nexus error envelope) — pin in a probe.

## Adapter mapping

| Concern | Setting |
|---------|---------|
| `headers()` | Bearer/Basic from `//host/repository/<repo>/:_authToken` |
| tarball URL remap | none (passthrough) |
| degraded facts | advisories ([§8](./_common.md#8-advisories--audit-api)) and signing keys ([§9](./_common.md#9-registry-signing-keys)) — route to a separate advisory source |

## Probes & fixtures

- **Mock flags:** `{ audit: 'absent', corgi: 'ignored' }`
  ([`_common §12`](./_common.md#12-conformance--minimum-mock-contract)) reproduces
  the Nexus profile for tests **without** a live Nexus.

## Open questions

> **Open:** probe a real Nexus npm proxy to verify (a) whether per-version
> `dist.signatures` are stripped or passed through, and (b) whether the current
> Nexus honours the corgi `Accept` header. Both are general-knowledge-level now.
> **Open:** capture the Nexus `404` / `400` error envelopes for fixture fidelity.
> **Open:** confirm `group`-repo merge-order semantics affect tarball identity as
> described, with a two-repo example.
