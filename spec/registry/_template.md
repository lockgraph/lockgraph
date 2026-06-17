# `<id>` — `<human-readable name>`

> Status: stub (template — copy and fill).
> Updated: 2026-06-16
> Provenance: **Official** | **Source-only** | **Reverse-engineered**.
> Family: **npm-shape** | **non-npm**.

One-paragraph orientation: what this is (public service / open-source server /
commercial product / cloud offering), who runs it, and the single most
load-bearing way it diverges from the [canonical npm contract](./_common.md).

## Identity & addressing

- **Default base URL:** `https://…`
- **Scope requirement:** unscoped + scoped | **scoped-only** (`@owner/*`) | n/a
- **Package-name routing:** how a name maps to a path (esp. scoped-name
  `%2f` encoding — see [`_common §1`](./_common.md#1-addressing--name-encoding)).
- **Tarball URL policy:** `passthrough` (upstream `dist.tarball` verbatim) |
  `rewrite` (points at this server) | `own` (native packages only). This is
  load-bearing for lockfile portability — see Quirks.
- **`.npmrc` selector:** the config key(s) that route a client here
  (`registry=`, `@scope:registry=`, `//host/:_authToken=`).

## Authentication

| Operation | Required? | Mechanism | Notes |
|-----------|:---------:|-----------|-------|
| read packument | | none / Basic / Bearer / PAT | |
| read tarball   | | | |
| audit          | | | |

Reference: [`_common §2`](./_common.md#2-authentication).

## Endpoints

Only deltas from [`_common §3`](./_common.md#3-read-endpoints) — which endpoints
are **absent**, **added**, or **behave differently**. A registry that implements
the canonical read surface 1:1 says so and lists nothing.

| Method | Path | Status vs canonical | Notes |
|--------|------|---------------------|-------|
| | | present / **absent** / divergent | |

## Metadata deltas

How the documents this server returns differ from the canonical packument
([`_common §4`](./_common.md#4-the-packument-full-document)) and abbreviated
form ([`_common §5`](./_common.md#5-abbreviated-packument-corgi)).

| Field | Canonical | Here | Impact on converter |
|-------|-----------|------|---------------------|
| `dist.tarball` | absolute upstream URL | | |
| `dist.signatures` | present (npm 7+) | | signature verification |
| `dist.integrity` | sha512 SRI | | **irreducible** — enrich needs it |
| abbreviated (`corgi`) honoured? | yes | | extra bytes / parse cost |

## Advisories & audit

The audit-fix-relevant dimension. Reference:
[`_common §8`](./_common.md#8-advisories--audit-api).

| Endpoint | Supported | Behaviour when absent |
|----------|:---------:|-----------------------|
| `POST /-/npm/v1/security/advisories/bulk` | | |
| `POST /-/npm/v1/security/audits/quick`    | | |
| `POST /-/npm/v1/security/audits`          | | |
| `GET /-/npm/v1/keys` (signing keys)       | | |

## Capabilities

| Capability | Supported | Notes |
|------------|:---------:|-------|
| Unscoped packages              | | |
| Scoped packages                | | |
| Abbreviated packument (corgi)  | | |
| `dist.integrity` (sha512)      | | |
| `dist.signatures` (registry sig) | | |
| Provenance / attestations      | | |
| Bulk advisories                | | |
| Registry signing keys          | | |
| Search (`/-/v1/search`)        | | |
| Proxy / cache of upstream npm  | | |

## Quirks

Behaviours not obvious from "it speaks npm" — URL rewrites, field stripping,
non-standard status codes, header sensitivities, sync lag.

-

## Adapter mapping

How this project's `RegistryAdapter`
([`_common §11`](./_common.md#11-mapping-to-registryadapter)) is configured to
talk to this server — auth header hook, tarball-URL remap, which optional facts
are unavailable and therefore degrade.

| Concern | Setting |
|---------|---------|
| `headers()` | |
| tarball URL remap | |
| degraded facts | |

## Probes & fixtures

Reproducible evidence. A `curl` (or recorded cassette) that captured the shape
documented above, plus any mock-server flags
([`_common §12`](./_common.md#12-conformance--minimum-mock-contract)) that
reproduce this registry's quirks for tests.

- **Probe:** `curl …` (date)
- **Mock flags:** `{ … }`

## Open questions

> **Open:** seed unknowns here.
