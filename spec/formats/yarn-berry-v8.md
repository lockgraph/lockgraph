# `yarn-berry-v8` — yarn berry `yarn.lock` (`__metadata.version: 8`)

> Status: stub.
> Provenance: **Source-only**.

## Compatibility

### Writers — PM semvers that *emit* this format

| PM | semver range | Default? | How to opt in |
|----|--------------|:--------:|---------------|
| yarn | `>=4.0 <4.14` | ✓ | v7 was skipped — bumped 6 → 8 in 4.0.0; bumped 8 → 9 in 4.14.0 (2026-04-16) |

### Readers — PM semvers that *install* from this format

| PM | semver range | Notes |
|----|--------------|-------|
| yarn | `>=4` | older berry cannot read v8 |

## File

Same as [yarn-berry-v4](./yarn-berry-v4.md#file). yarn 4 also writes a
`packageExtensions` block in `.yarnrc.yml` more aggressively.

## Sources

- [`Project.ts` at yarn 4.0.0](https://github.com/yarnpkg/berry/blob/@yarnpkg/cli/4.0.0/packages/yarnpkg-core/sources/Project.ts)
  — first stable release at v8; `parseInt(env ?? 8)` introduced (the
  `YARN_LOCKFILE_VERSION_OVERRIDE` env var dates to here too).
- [`Project.ts` at yarn 4.13.0](https://github.com/yarnpkg/berry/blob/@yarnpkg/cli/4.13.0/packages/yarnpkg-core/sources/Project.ts)
  — last v8-default tag before the v9 bump.
- [Yarn 4.0 release blog](https://yarnpkg.com/blog/release/4.0) — wider
  release notes (no explicit lockfile-bump mention, useful for context).
- [`collab/research/lockfile-schema-history-yarn.md`](../../collab/research/lockfile-schema-history-yarn.md)
  — release-tag walk including the 6 → 8 jump.

## Schema sketch

Same shape; v8 changes (TBD) are field-level.

## Capabilities

Inherits v6. Yarn 4 expanded conditions support and tightened workspace
constraints.

## Conversion inputs

Same as [yarn-berry-v4](./yarn-berry-v4.md#conversion-inputs).

## Quirks

- yarn 4 emits `cacheKey: 10c0` (vs `10` in v6). The cacheKey moves with each
  cache-format change.
- `__metadata.cacheKey` and per-entry `checksum` prefix must agree on parse.

> **TBD:** v6 → v8 field diff.

## Degradation rules

Inherits v6.

## Fixtures

- `legacy/test/fixtures/yarn-7-mr/` (the existing `yarn-7-mr` fixture is
  actually a v8 lockfile — yarn 4 era — confirm and rename if needed)

## Open questions

> **Open:** confirm fixture naming. The `yarn-{5,6,7}-mr` legacy directories
> use a different numbering scheme than the lockfile schema versions; we
> should normalise.
