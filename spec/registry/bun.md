# `bun` — Bun's registry client (npm-shape)

> Status: stub (source-derived; complete for scope — no registry-side divergence found).
> Updated: 2026-06-16
> Provenance: **Source-only** (Bun docs + source).
> Family: **npm-shape** — Bun is a *client*, not a server.

Bun ships no registry of its own. `bun install` consumes any **npm-shape** registry
([`_common.md`](./_common.md)) — public [`npm`](./npm.md) by default — configured
via `.npmrc` or `bunfig.toml` (`[install]` `registry`, `[install.scopes]`). There
is **no Bun-specific server protocol**: the divergences that matter for Bun are
**client-side** (lockfile encoding, resolution), covered by the
[`bun-text`](../formats/bun-text.md) / [`bun-binary`](../formats/bun-binary.md)
format specs, not here. This entry exists so the index is complete and to pin where
Bun's advisory behaviour comes from.

## Identity & addressing

- **Default registry:** public [`npm`](./npm.md) (`registry.npmjs.org`).
- **Config:** `bunfig.toml` `[install] registry = "…"` and per-scope
  `[install.scopes]`; also honours `.npmrc` `registry=` / `@scope:registry=` /
  `:_authToken=`.
- **Addressing / tarball / metadata:** whatever the configured registry serves —
  Bun adds nothing on the wire.

## Authentication

Per the configured registry ([§2](./_common.md#2-authentication)) — Bearer / Basic
from `.npmrc` / `bunfig.toml`. No Bun-specific scheme.

## Advisories & audit

`bun audit` (recent Bun) queries the **npm advisory API**
([§8](./_common.md#8-advisories--audit-api)) of the configured registry — so it
**inherits that registry's advisory support**: full on [`npm`](./npm.md) /
[`yarn-mirror`](./yarn-mirror.md), absent on [`nexus`](./nexus.md) /
[`npmmirror`](./npmmirror.md) / [`github-packages`](./github-packages.md). No
Bun-specific advisory surface.

## Capabilities & quirks

Determined entirely by the configured backend; Bun contributes no registry-side
capability or quirk. The Bun-specific behaviour lives in its lockfile formats and
resolver, not the wire protocol.

## Open questions

> **Open:** confirm which advisory endpoint `bun audit` calls (`advisories/bulk`
> vs `audits/quick`) and whether Bun's fetcher sends the corgi `Accept` header by
> default.

## Sources

- Bun install / registry docs (bun.sh/docs); cross-ref
  [`bun-text`](../formats/bun-text.md).
