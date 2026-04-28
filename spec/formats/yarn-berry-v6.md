# `yarn-berry-v6` — yarn berry `yarn.lock` (`__metadata.version: 6`)

> Status: stub.
> Provenance: **Source-only**.

## Compatibility

### Writers — PM semvers that *emit* this format

| PM | semver range | Default? | How to opt in |
|----|--------------|:--------:|---------------|
| yarn | `>=3.2 <4` | ✓ | jumped 4 → 6 in 3.2.0 (no v5 default in this range; v5 was 3.1.0 only) |

### Readers — PM semvers that *install* from this format

| PM | semver range | Notes |
|----|--------------|-------|
| yarn | `>=3.2` | |

## File

Same as [yarn-berry-v4](./yarn-berry-v4.md#file).

## Sources

- [`Project.ts` at yarn 3.2.0](https://github.com/yarnpkg/berry/blob/@yarnpkg/cli/3.2.0/packages/yarnpkg-core/sources/Project.ts)
  — `const LOCKFILE_VERSION = 6;` (first 3.x release at v6).
- [`Project.ts` at yarn 3.6.4](https://github.com/yarnpkg/berry/blob/@yarnpkg/cli/3.6.4/packages/yarnpkg-core/sources/Project.ts)
  — last 3.x with v6 default.
- [`collab/research/lockfile-schema-history-yarn.md`](../../collab/research/lockfile-schema-history-yarn.md)
  — bump-by-bump verification across release tags.

## Schema sketch

Same shape; v6 mostly tightens v5 — to be enumerated.

## Capabilities

Inherits v5.

## Conversion inputs

Same as [yarn-berry-v4](./yarn-berry-v4.md#conversion-inputs).

## Quirks

> **TBD:** v6 stabilised PnP layout details; whether they leak into lockfile
> needs verification.

## Degradation rules

Inherits v5.

## Fixtures

- `legacy/test/fixtures/yarn-6-mr/`

## Open questions

> **Open:** is the v5→v6 bump driven by a *parser-incompatible* change or
> just a marker for `yarn install` to re-validate? If the latter, parser can
> be shared with v5.
