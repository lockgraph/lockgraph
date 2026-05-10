# `yarn-berry-v5` — yarn berry `yarn.lock` (`__metadata.version: 5`)

> Status: preview.
> Provenance: **Source-only**.

The completeness contract — stringify, modify, enrich, optimize —
is owned by [ADR-0018](../decisions/0018-yarn-berry-pre-v9-family-completeness.md).
This spec records compatibility and fixture provenance; the normative
emit / mutate / enrich / prune rules live in ADR-0018 §A.v5 and the
version-invariant sections it inherits from ADR-0016.

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

Same shape as v4 with `conditions` support added, while retaining bare
inner-block dependency ranges and raw sha512-hex `checksum` values (no
`<cacheKey>/` prefix).

## Capabilities

Parse / stringify / graph-level mutate roundtrip / enrich / optimize
implemented against the fixture matrix at
`src/test/resources/fixtures/lockfiles/*/yarn-berry-v5.lock`.

## Conversion inputs

Same as [yarn-berry-v4](./yarn-berry-v4.md#conversion-inputs).

## Emit

Emit (`stringify(graph, options?)`) is governed by
[ADR-0018 §A.v5 *yarn-berry-v5 stringify deltas*](../decisions/0018-yarn-berry-pre-v9-family-completeness.md#av5--yarn-berry-v5-stringify-deltas)
plus the version-invariant sections ADR-0018 inherits from ADR-0016:

- `__metadata.version` emits the literal `5`.
- `__metadata.cacheKey` defaults to absent; when present (caller-supplied
  via `options.cacheKey` or sidecar-preserved from parse) it emits as
  a bare numeric literal (`cacheKey: 8` empirically) — pre-v8 form, no
  string quoting.
- Inner `dependencies` / `optionalDependencies` emit the bare form
  (for example `lodash: 4.17.21`), not v8/v9's quoted protocol.
- `checksum` values are raw sha512 hex (no `<cacheKey>/` prefix).
- `conditions` are supported and roundtrip via sidecar preservation —
  v5 is the FIRST version with this field (v4 lacks it).
- `compressionLevel` is not present in the v5 corpus.

## Quirks

- `__metadata.cacheKey` is empirically `8` across the current v5 fixtures.
- Inner `dependencies` / `optionalDependencies` emit bare ranges
  (`lodash: 4.17.21`), unlike v8/v9's quoted protocol form.
- `checksum` values are raw sha512 hex, not `cacheKey/hash`.
- `conditions` first appears in v5; the current shipped fixture set does
  not exercise it, but parse/stringify coverage preserves the nested
  block shape in the adapter contract.

## Degradation rules

Inherits v4.

## Fixtures

- `legacy/test/fixtures/yarn-5-mr/`

## Open questions

> None at preview. Fixture verification matched ADR-0018 §A.v5 on all
> observed deltas: handshake `5`, cacheKey `8`, bare inner dep ranges,
> raw checksum form, and no `compressionLevel` in the current fixture
> corpus.
