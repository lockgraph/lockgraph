# Registry specifications

> Updated: 2026-06-16.

API contracts for the package **registries** this project resolves and enriches
against — the supply side of the dependency graph. Where [`formats/`](../formats/)
specs the **lockfiles** (what a PM writes to disk), this directory specs the
**registries** (what a PM reads over the wire to produce them).

Each per-registry doc follows [`_template.md`](./_template.md) and records:
identity & addressing, auth, endpoint deltas, metadata deltas, **advisory/audit
support**, capabilities, quirks, and how this project's `RegistryAdapter` is
wired to it. The shared npm-shape contract lives once in
[`_common.md`](./_common.md); per-registry docs state only their **divergence**
from it.

This sits beneath the resolver: [`03-resolver.md`](../03-resolver.md) defines the
`RegistryAdapter` abstraction, [`10-sources.md`](../10-sources.md) places
registries as **rung 6** of the data-source ladder, and the docs here pin the
concrete on-the-wire behaviour of each backend.

## Provenance

- **Official** — published, maintained API doc or reference server.
- **Source-only** — no published API spec; truth lives in the server's source.
- **Reverse-engineered** — neither; built by probing a live instance.

## Family

- **npm-shape** — speaks the [canonical npm HTTP contract](./_common.md);
  documents only deltas.
- **non-npm** — a different protocol (e.g. JSR); documents its own surface.

## Index

| Id | Default base URL | Provenance | Family | Doc |
|----|------------------|------------|--------|-----|
| `npm`              | `registry.npmjs.org`     | Official | npm-shape | [npm.md](./npm.md) |
| `yarn-mirror`      | `registry.yarnpkg.com`   | Official | npm-shape | [yarn-mirror.md](./yarn-mirror.md) |
| `npmmirror` (cnpm) | `registry.npmmirror.com` | Official | npm-shape | [npmmirror.md](./npmmirror.md) |
| `verdaccio`        | self-hosted              | Official | npm-shape | [verdaccio.md](./verdaccio.md) |
| `nexus`            | self-hosted (`/repository/<repo>/`) | Source-only | npm-shape | [nexus.md](./nexus.md) |
| `artifactory`      | self-hosted (`/artifactory/api/npm/<repo>/`) | Reverse-engineered | npm-shape | [artifactory.md](./artifactory.md) |
| `github-packages`  | `npm.pkg.github.com`     | Official | npm-shape | [github-packages.md](./github-packages.md) |
| `gitlab`           | `<host>/api/v4/.../packages/npm/` | Official | npm-shape | [gitlab.md](./gitlab.md) |
| `cloud-registries` | AWS CodeArtifact · GCP Artifact Registry · Azure Artifacts (+ Cloudsmith, Gitea/Forgejo) | Official | npm-shape | [cloud-registries.md](./cloud-registries.md) |
| `bun`              | npm-shape (bun client)   | Source-only | npm-shape | [bun.md](./bun.md) |
| `jsr`              | `npm.jsr.io` / `jsr.io`  | Official | **non-npm** + npm-compat | [jsr.md](./jsr.md) |

All profiles drafted. Public backends are **live-probed** (`npm` 2026-04-27;
`yarn-mirror` / `npmmirror` / `jsr` 2026-06-08); auth-gated / self-hosted backends
are **doc/source-derived** where live probing is impossible — each carries `Open`
items flagging what still needs a real-instance probe.

## Cross-cutting capability matrix

The dimensions that actually diverge. `✓` supported, `✗` absent, `~` partial /
configurable, `?` unverified. Every cell is design intent until validated by a
live probe or the [test bench](../08-test-bench.md).

| Registry | Anon read | Scoped-only | Tarball URL | Corgi | `dist.signatures` | Attestations | Bulk advisories | Signing keys |
|----------|:---------:|:-----------:|:-----------:|:-----:|:-----------------:|:------------:|:---------------:|:------------:|
| `npm`               | ✓ | ✗ | passthrough | ✓ | ✓ | ✓ | ✓ | ✓ |
| `yarn-mirror`       | ✓ | ✗ | passthrough | ✓ | ✓ | ✗ | ✓ | ✓ |
| `npmmirror`         | ✓ | ✗ | rewrite→CDN | ✓ | ✗ | ✗ | ✗ | ✗ |
| `jsr` (npm-compat)  | ✓ | ✓ | own | ✓ | ✗ | ✗ | ✗ | ✗ |
| `verdaccio`         | ~ | ✗ | **rewrite** | ? | ~ | ✗ | ~ | ✗ |
| `nexus`             | ~ | ✗ | passthrough | ? | ? | ✗ | **✗** | **✗** |
| `artifactory`       | ~ | ✗ | **rewrite** | ? | ✗ | ? | ✗ | ✗ |
| `github-packages`   | ✗ | ✓ | own | ? | ✗ | ✗ | ✗ | ✗ |
| `gitlab`            | ◐ | ◐ | own | ? | ✗ | ✗ | ✗ | ✗ |
| `codeartifact`      | ✗ | ✗ | own | ? | ✗ | ? | ✗ | ✗ |
| `artifact-registry` | ✗ | ✗ | own | ? | ✗ | ? | ✗ | ✗ |
| `azure-artifacts`   | ✗ | ✗ | own | ? | ✗ | ? | ✗ | ✗ |

Legend: `✓` yes · `✗` no · `~` partial/configurable · `◐` conditional
(public-only / endpoint-level-dependent) · `?` unverified. `verdaccio` advisories
`~` = forwarded to the uplink by the `verdaccio-audit` plugin; its
`dist.signatures` `~` = passthrough on proxied entries, none on local. The three
`cloud-*` rows are detailed in [cloud-registries.md](./cloud-registries.md). `bun`
is omitted — a pure npm-shape *client* with no server-side divergence.

**Reading the matrix for audit-fix.** The "Bulk advisories" column gates the
[audit-fix driver feature](../00-overview.md): only `npm` / `yarn-mirror` answer
**natively**, and `verdaccio` answers by **forwarding** to its uplink. Every other
backend (`npmmirror`, `jsr`, `nexus`, `artifactory`, `github-packages`, `gitlab`,
cloud) needs the advisory source **decoupled** from version resolution — resolve
versions against the private/corporate registry, query advisories against public
npm or GHSA. See [`_common §8.3`](./_common.md#83-the-no-advisories-class).

## Conventions

- **MUST / SHOULD / MAY** per [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119),
  as elsewhere in [the spec](../README.md).
- Per-registry docs never re-derive the canonical contract — they link
  [`_common.md`](./_common.md) and state deltas only.
- Open questions live inline as `> **Open:** …`; resolved ones are deleted.
- Every empirical claim cites a probe (date) or a source permalink; unverified
  general-knowledge claims are marked `?` / `> **Open:**`, never asserted flat.

## Status

All profiles drafted: [`_common.md`](./_common.md) (canonical contract, **§1–§20** —
read / resolve / audit, provenance, lifecycle writes, 2FA + tokens, access, search,
replication, account endpoints, security-holds) + [`_template.md`](./_template.md) +
11 backend docs covering 13 registries. Public backends are live-probed (`npm`
2026-04-27; `yarn-mirror` / `npmmirror` / `jsr` / search / replication / provenance
2026-06-08–09). **All load-bearing public-probeable Opens are closed** (a few
low-value ones — advisory-bulk fixture, search `size` cap, `whoami` anon body — stay
hedged inline); the rest are **instance-gated** (need a running `verdaccio` / `nexus` /
`artifactory` / cloud / private GitLab) — acceptable to publish as documented unknowns.
