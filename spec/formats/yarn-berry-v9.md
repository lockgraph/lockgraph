# `yarn-berry-v9` — yarn berry `yarn.lock` (`__metadata.version: 9`)

> Status: stub.
> Provenance: **Source-only**.

## Compatibility

### Writers — PM semvers that *emit* this format

| PM | semver range | Default? | How to opt in |
|----|--------------|:--------:|---------------|
| yarn | `>=4.14` | ✓ | bumped from v8 in yarn 4.14.0 (2026-04-16) |

### Readers — PM semvers that *install* from this format

| PM | semver range | Notes |
|----|--------------|-------|
| yarn | `>=4.14` | older berry refuses; the schema-version handshake is strict |

## File

Same as [yarn-berry-v4](./yarn-berry-v4.md#file).

## Sources

- [`Project.ts` at yarn 4.14.1](https://github.com/yarnpkg/berry/blob/@yarnpkg/cli/4.14.1/packages/yarnpkg-core/sources/Project.ts)
  — `parseInt(env ?? 9)` — current default writer.
- [`Project.ts` at yarn 4.13.0 (pre-bump)](https://github.com/yarnpkg/berry/blob/@yarnpkg/cli/4.13.0/packages/yarnpkg-core/sources/Project.ts)
  vs [4.14.0](https://github.com/yarnpkg/berry/blob/@yarnpkg/cli/4.14.0/packages/yarnpkg-core/sources/Project.ts)
  — diff the constants to bracket the bump.
- [yarn 4.14.0 release tag](https://github.com/yarnpkg/berry/releases/tag/%40yarnpkg%2Fcli%2F4.14.0)
  (published 2026-04-16) — narrative for the v8 → v9 bump.
- [`collab/research/lockfile-schema-history-yarn.md`](../../collab/research/lockfile-schema-history-yarn.md).

## Conversion inputs

Same as [yarn-berry-v4](./yarn-berry-v4.md#conversion-inputs).

## Schema sketch

Same shape as v8 with — TBD — field-level diffs once we have a producer.

## Capabilities

Inherits v8.

## Quirks

- Brand-new (released 2026-04-16) — most of the ecosystem still writes
  v8. Treat as forward-compat target rather than canonical input.
- The bump itself is mechanical (a `version: N` field), but historical
  evidence (yarn 4 → 6 introduced cacheKey, yarn 4 → 8 added
  `compressionLevel`) suggests v9 is likely paired with at least one
  structural change that needs probing.

## Degradation rules

Inherits v8.

## Fixtures

> **TBD:** unproducible from current matrix; gated on
> [ADR-0005](../decisions/0005-pm-delivery-off-npm.md). When unblocked,
> canonical writer is yarn 4.14+.

## Open questions

> **Open:** what fields beyond `__metadata.version` actually changed in
> the v8 → v9 transition? Read yarn 4.14.0 changelog and diff its
> `Project.ts` against 4.13.0 once a producer is wired up.
