# `yarn-berry-v5` — yarn berry `yarn.lock` (`__metadata.version: 5`)

> Status: stub.
> Provenance: **Source-only**.

## Compatibility

### Writers — PM semvers that *emit* this format

| PM | semver range | Default? | How to opt in |
|----|--------------|:--------:|---------------|
| yarn | `=3.1.0` | ✓ | one-minor window only; yarn 3.0.x still wrote v4, yarn 3.2.0 jumped to v6 |

### Readers — PM semvers that *install* from this format

| PM | semver range | Notes |
|----|--------------|-------|
| yarn | `>=3.1` | |

## File

Same as [yarn-berry-v4](./yarn-berry-v4.md#file).

## Sources

- [`Project.ts` at yarn 3.1.0](https://github.com/yarnpkg/berry/blob/@yarnpkg/cli/3.1.0/packages/yarnpkg-core/sources/Project.ts)
  — `const LOCKFILE_VERSION = 5;` (the only stable yarn release with v5
  default).
- [`Project.ts` at yarn 3.0.2 (pre-bump)](https://github.com/yarnpkg/berry/blob/@yarnpkg/cli/3.0.2/packages/yarnpkg-core/sources/Project.ts)
  and [3.2.0 (post-bump)](https://github.com/yarnpkg/berry/blob/@yarnpkg/cli/3.2.0/packages/yarnpkg-core/sources/Project.ts)
  — bracket the one-minor v5 window.
- [`collab/research/lockfile-schema-history-yarn.md`](../../collab/research/lockfile-schema-history-yarn.md)
  — empirical walk that surfaced the narrow window.

## Schema sketch

Same shape as v4; differences are field-level (TBD).

## Capabilities

Inherits v4. No removed capabilities; expect added fields only.

## Conversion inputs

Same as [yarn-berry-v4](./yarn-berry-v4.md#conversion-inputs).

## Quirks

- v5 introduced **`conditions`** field per entry (used for OS/CPU
  optionalDependencies skip).
- `cacheKey` semantics tweaked.

> **TBD:** complete diff vs v4.

## Degradation rules

Inherits v4.

## Fixtures

- `legacy/test/fixtures/yarn-5-mr/`

## Open questions

> **Open:** does berry treat conditions as part of resolution identity, or
> is `foo@npm:1.0.0` the same node regardless of `conditions`? Likely yes
> (same package, different install gates) — verify experimentally.
