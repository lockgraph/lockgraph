# `gitlab` — GitLab npm Package Registry

> Status: draft (doc-derived; live-probe pending — public-project reads probe-able, private the default).
> Updated: 2026-06-16
> Provenance: **Official** (GitLab docs).
> Family: **npm-shape** — three-level addressing + scope↔namespace binding.

GitLab's built-in npm registry. Distinctive on three axes: **three endpoint
levels** (instance / group / project), a **scope↔namespace binding** (the npm
scope must match the GitLab group), and an **opt-in package-forwarding** fallback
to npmjs. Auth-required except for public projects; no native npm-audit API.

## Identity & addressing

- **Base URLs (three levels):**
  - instance: `https://<host>/api/v4/packages/npm/`
  - group: `https://<host>/api/v4/groups/<id>/-/packages/npm/`
  - project: `https://<host>/api/v4/projects/<id>/packages/npm/`
- **Scope requirement:** **instance-level is scoped-only**, and the scope must equal
  the **root group / namespace**; group / project levels allow unscoped too.
  (Case-sensitive; lowercase recommended.)
- **Tarball URL policy:** `own`, auth-gated. A group-endpoint packument may carry
  tarball URLs on the **project** endpoint — both may then need credentials in
  `.npmrc` ([§6.2 hazard](./_common.md#62-the-tarball-url-rewrite-hazard)).
- **`.npmrc` selector:** `@scope:registry=https://<host>/api/v4/.../packages/npm/`
  + `//<host>/...:_authToken=`.

## Authentication

Required for internal / private projects (anonymous only for public). Tokens (all
via `Authorization: Bearer` / `:_authToken`): personal / group / project access
tokens (`api` scope), deploy tokens (`read_package_registry`), CI `CI_JOB_TOKEN`.

## Endpoints

Canonical packument / version / tarball present. **Absent:** `/-/npm/v1/security/*`,
`/-/npm/v1/keys`; `/-/v1/search` and `/-/package/{name}/dist-tags` undocumented
(Open). **Package forwarding:** a not-found package is forwarded to npmjs.com
(default **ON**; disable per-instance by an admin or per-group by an owner) — an
opt-in pull-through, not a full mirror.

## Metadata deltas

- `dist.tarball` → GitLab host, auth-gated (may point at the project endpoint).
- `dist.signatures` / attestations **absent** — GitLab does not re-sign.
- `dist.integrity` present ⇒ enrich works.
- corgi support undocumented (Open).

## Advisories & audit

The [no-advisories class](./_common.md#83-the-no-advisories-class) natively. With
**package forwarding** enabled, an `npm audit` for a not-found package forwards to
npmjs.com (GHSA-backed) — a client redirect, not a GitLab endpoint. GitLab's own
**Dependency Scanning / GitLab Advisory Database** is CI-based, separate from the
npm audit API. With forwarding off, audit-fix must source advisories elsewhere.

## Capabilities

| Capability | Supported | Notes |
|------------|:---------:|-------|
| Anonymous read | ◐ | public projects only |
| Unscoped packages | ◐ | group / project yes; instance no |
| Scoped packages | ✓ | scope = root group at instance level |
| Abbreviated packument (corgi) | ? | |
| `dist.integrity` | ✓ | |
| `dist.signatures` | **✗** | |
| Provenance / attestations | **✗** | |
| Bulk advisories | **✗** | unless forwarded |
| Registry signing keys | **✗** | |
| Proxy of upstream npm | ◐ | opt-in package forwarding |

## Quirks

- **Three-level addressing** + **scope = root group** binding — the GitLab-specific
  addressing twist.
- **Tarball URL may be on a different endpoint** than queried (group → project) →
  dual-credential `.npmrc`; especially bites Yarn Classic.
- **Package forwarding** is opt-in pull-through to npmjs (default ON,
  admin/owner-disable).
- **Scope case-sensitivity** — must match the group name exactly; `@Org/Pkg` rejected
  if `Org` has uppercase.

## Adapter mapping

| Concern | Setting |
|---------|---------|
| `headers()` | Bearer (PAT / deploy / `CI_JOB_TOKEN`); preserve auth across all three endpoints (packument + tarball may differ) |
| tarball URL remap | `own`, auth-gated — keep host, carry the credential |
| degraded facts | signatures / attestations absent; advisories only via forwarding → else route to GHSA / npm |

## Probes & fixtures

- **Probe (doc-derived; public project only):** `curl -H "Authorization: Bearer
  <t>" https://<host>/api/v4/projects/<id>/packages/npm/@scope/name`.
- **Mock flags:** `{ auth: 'required', scope: 'mandatory-instance', strip:
  ['signatures','attestations'], audit: 'absent' }`.

## Open questions

> **Open:** corgi `Accept` honoured?
> **Open:** `/-/v1/search` + `/-/package/{name}/dist-tags` presence.
> **Open:** does `dist.tarball` point at project / group / instance consistently, and
> is `always-auth` needed for tarballs?
> **Open:** fine-grained PAT (GitLab 16.3+) scopes for the registry.

## Sources

- [GitLab npm registry](https://docs.gitlab.com/ee/user/packages/npm_registry/),
  [npm API](https://docs.gitlab.com/ee/api/packages/npm.html) (2026-06-08).
