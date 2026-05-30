# Architecture Decision Records

Each ADR is one non-trivial architectural decision: context, choice,
consequences. ADRs are **append-only**. To revise a decision, write a new
ADR and mark the old one `superseded by ADR-NNNN`.

The set of `accepted` ADRs is the project's architectural contract. New
contributors (human or agent) read this directory to understand *why* the
spec is shaped the way it is.

## File format

See [`_template.md`](./_template.md). Each file is `NNNN-<short-slug>.md`,
zero-padded to 4 digits.

## Status

| Status | Meaning |
|--------|---------|
| `proposed`  | drafted; awaiting alignment |
| `accepted`  | locked; load-bearing for the spec |
| `superseded by ADR-NNNN` | replaced; kept for history |

## Index

| # | Title | Status | Date |
|---|-------|--------|------|
| [0001](./0001-three-layer-model.md) | Three-layer model: Manifest → Graph → Layout | accepted | 2026-04-26 |
| [0002](./0002-public-api-surface.md) | Public API surface: `parse` / `stringify` only | accepted | 2026-04-26 |
| [0003](./0003-spec-driven-development.md) | Spec-driven development with ADRs | accepted | 2026-04-26 |
| [0004](./0004-language-agnostic-spec.md) | Language-agnostic spec; TS as reference binding | accepted | 2026-04-26 |
| [0005](./0005-pm-delivery-off-npm.md) | Delivery of PM versions not published to npm | accepted | 2026-04-27 |
| [0006](./0006-pnpm-style-peer-context.md) | Node identity uses pnpm-style peer-context serialization | accepted | 2026-04-26 |
| [0007](./0007-content-sorted-iteration-order.md) | Canonical iteration order is content-sorted | accepted | 2026-04-27 |
| [0008](./0008-iterative-modify-enrich-pipeline.md) | Modify / enrich pipeline is iterative until fixpoint | accepted | 2026-04-27 |
| [0009](./0009-node-shape-tiered.md) | Node shape: structural / payload / extras | superseded by ADR-0010 | 2026-04-27 |
| [0010](./0010-tarball-payload-graph-level.md) | Tarball payload is graph-level, keyed by `name@version` | accepted | 2026-04-27 |
| [0011](./0011-tarball-key-disambiguation.md) | `TarballKey` disambiguation for `patch:` resolutions | proposed | 2026-04-28 |
| [0012](./0012-tarball-entry-lifecycle.md) | Tarball entry lifecycle and virt-set propagation | proposed | 2026-04-28 |
| [0013](./0013-multi-pm-scalability-invariant.md) | Multi-PM scalability — PM-native primitives are attribution, not load-bearing | proposed | 2026-04-28 |
| [0014](./0014-canonical-recipe-input-normalisation.md) | Canonical-recipe input normalisation across PMs | accepted | 2026-05-16 |
| [0015](./0015-ambient-state-inputs-to-canonical-recipes.md) | Ambient-state inputs to canonical recipes | proposed | 2026-04-28 |
| [0016](./0016-yarn-berry-v9-completeness-contract.md) | `yarn-berry-v9` completeness contract | proposed | 2026-05-04 |
| [0017](./0017-graph-seal-workspace-edges.md) | Graph seal allows workspace→workspace incoming edges | proposed | 2026-05-05 |
| [0018](./0018-yarn-berry-pre-v9-family-completeness.md) | `yarn-berry` pre-v9 family completeness contract | proposed | 2026-05-08 |
| [0019](./0019-yarn-classic-completeness-contract.md) | `yarn-classic` completeness contract | proposed | 2026-05-10 |
| [0020](./0020-cross-format-interop-test-architecture.md) | Cross-format interop test architecture & lossiness contract | proposed | 2026-05-10 |
| [0021](./0021-npm-family-completeness-contract.md) | `npm` package-lock family completeness contract | proposed | 2026-05-12 |
| [0022](./0022-pnpm-family-completeness-contract.md) | `pnpm` lockfile family completeness contract | proposed | 2026-05-12 |
| [0023](./0023-graph-modification-and-completion.md) | Graph modification, tree completion, and find-up resolve semantics | accepted | 2026-05-24 |
| [0024](./0024-optimize-phase.md) | Optimize phase: orphan garbage collection (monotone-reductive) | accepted | 2026-05-25 |
| [0025](./0025-manifest-overrides.md) | Manifest layer materialisation & dependency-override capture | proposed | 2026-05-30 |
| [0026](./0026-layout-attribution.md) | Layout attribution: install-path placement carrier (L3 round-trip slice) | proposed | 2026-05-30 |

Next free number: **0027**.
