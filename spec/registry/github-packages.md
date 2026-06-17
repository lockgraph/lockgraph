# `github-packages` — GitHub Packages npm registry (`npm.pkg.github.com`)

> Status: draft (doc-derived; auth-gated, not probe-able — every read requires auth).
> Updated: 2026-06-16
> Provenance: **Official** (GitHub docs).
> Family: **npm-shape** — the most *restrictive* member.

GitHub's cloud npm registry for org/user-scoped packages. The most restrictive
npm-shape backend: **mandatory auth for every read**, **scoped-only**, **no
upstream-npm proxy**, **no advisory API**. Suited to private team packages, not as
a public or standalone npm.

## Identity & addressing

- **Base URL:** `https://npm.pkg.github.com` — packages routed by `@OWNER` (org/user).
- **Scope requirement:** **mandatory** — every package is `@OWNER/name`; unscoped
  cannot be served. Names + scope are **lowercase-only**.
- **Tarball URL policy:** `own` + **auth-gated** — tarballs on GitHub's host,
  refused anonymously (same credential as the packument).
- **`.npmrc` selector:** `@OWNER:registry=https://npm.pkg.github.com` +
  `//npm.pkg.github.com/:_authToken=TOKEN`.

## Authentication

**Mandatory for all reads.** Mechanism: a **classic** PAT with `read:packages`
(or `GITHUB_TOKEN` in Actions). Fine-grained PAT support is **not documented** for
the npm registry (Open). Anonymous read → 401. There are **no public packages** in
the npm sense; the auth requirement is transitive to consumers of the lockfile.

## Endpoints

Canonical read surface ([§3](./_common.md#3-read-endpoints)) minus advisories /
keys: `GET /{name}`, `/{name}/{version}`, `/{name}/-/…tgz` (all auth). **Absent:**
`/-/npm/v1/security/*`, `/-/npm/v1/keys`. `/-/v1/search` and
`/-/package/{name}/dist-tags` undocumented (Open).

## Metadata deltas

- `dist.tarball` → GitHub host, **auth-gated**.
- `dist.signatures` **stripped** — GitHub does not re-sign (falls back to `integrity`).
- `dist.integrity` present ⇒ enrich works.
- **No upstream proxy:** GH Packages serves only packages published to it; a
  missing / unscoped name → 404, never a fall-back to npmjs. A lockfile mixing
  `@OWNER/x` (GH) and `lodash` (npmjs) needs **two** scoped registry adapters
  ([community #33875](https://github.com/orgs/community/discussions/33875),
  [#57915](https://github.com/orgs/community/discussions/57915)).
- Corgi support undocumented (Open).

## Advisories & audit

**None** — the [no-advisories class](./_common.md#83-the-no-advisories-class).
`/-/npm/v1/security/*` and `/keys` absent; `npm audit` fails. GitHub's native path
is **Dependabot / the GitHub Advisory Database**, which operate at the GitHub level,
**not** via the npm audit API. Audit-fix must source advisories elsewhere
(GHSA / public npm) while resolving versions against GH Packages.

## Capabilities

| Capability | Supported | Notes |
|------------|:---------:|-------|
| Anonymous read | **✗** | 401 |
| Unscoped packages | **✗** | |
| Scoped packages | ✓ | mandatory |
| Abbreviated packument (corgi) | ? | Open |
| `dist.integrity` | ✓ | |
| `dist.signatures` | **✗** | stripped |
| Provenance / attestations | **✗** | |
| Bulk advisories | **✗** | |
| Registry signing keys | **✗** | |
| Proxy of upstream npm | **✗** | |

## Quirks

- **Scoped + auth + no-proxy triad** — the defining constraint set; mixed lockfiles
  need dual-registry `.npmrc`.
- **Lowercase-only** names / scopes; `@Org/Pkg` rejected.
- **Tarball size limit** 256 MB / version.
- **Auth-gated tarballs** — a `dist.tarball` URL is useless without the credential.

## Adapter mapping

| Concern | Setting |
|---------|---------|
| `headers()` | Bearer classic-PAT (`read:packages`) / `GITHUB_TOKEN`; preserve the `//npm.pkg.github.com/` auth scope on tarball fetch |
| tarball URL remap | `own`, auth-gated — keep host, attach credential |
| degraded facts | signatures + advisories + keys absent → route advisories elsewhere |

## Probes & fixtures

- **Live probe impossible** (auth-gated reads → 401); doc-derived.
- **Mock flags:** `{ auth: 'required', scope: 'mandatory', strip: ['signatures'],
  noUpstreamFallback: true, audit: 'absent' }`.

## Open questions

> **Open:** fine-grained PAT support for the npm registry (docs say classic-only —
> verify current state).
> **Open:** corgi `Accept` honoured?
> **Open:** `/-/v1/search` and `/-/package/{name}/dist-tags` presence.
> **Open:** confirm attestations stripped.

## Sources

- [GitHub Packages npm docs](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry) ·
  [permissions](https://docs.github.com/en/packages/learn-github-packages/about-permissions-for-github-packages) (accessed 2026-06-08).
- Community discussions [#33875](https://github.com/orgs/community/discussions/33875),
  [#57915](https://github.com/orgs/community/discussions/57915);
  [npm/cli#5479](https://github.com/npm/cli/issues/5479) (advisory-gap parallel).
