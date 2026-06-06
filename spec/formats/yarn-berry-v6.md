# `yarn-berry-v6` — yarn berry `yarn.lock` (`__metadata.version: 6`)

> Status: preview.
> Provenance: **Source-only**.

The completeness contract — stringify, modify, enrich, optimize —
is owned by [ADR-0018](../decisions/0018-yarn-berry-pre-v9-family-completeness.md).
This spec records compatibility and fixture provenance; the normative
emit / mutate / enrich / prune rules live in ADR-0018 §A.v6 and the
version-invariant sections it inherits from ADR-0016.

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

Same shape as v5 with the same `conditions` support, bare inner-block
dependency ranges, and raw sha512-hex `checksum` values (no
`<cacheKey>/` prefix).

## Capabilities

Parse / stringify / graph-level mutate roundtrip / enrich / optimize
implemented against the fixture matrix at
`src/test/resources/fixtures/lockfiles/*/yarn-berry-v6.lock`.

## Conversion inputs

Same as [yarn-berry-v4](./yarn-berry-v4.md#conversion-inputs).

## Emit

Emit (`stringify(graph, options?)`) is governed by
[ADR-0018 §A.v6 *yarn-berry-v6 stringify deltas*](../decisions/0018-yarn-berry-pre-v9-family-completeness.md#av6--yarn-berry-v6-stringify-deltas)
plus the version-invariant sections ADR-0018 inherits from ADR-0016:

- `__metadata.version` emits the literal `6`.
- `__metadata.cacheKey` defaults to absent; when present (caller-supplied
  via `options.cacheKey` or sidecar-preserved from parse) it emits as
  a bare numeric literal (`cacheKey: 8` empirically) — pre-v8 form, no
  string quoting.
- Inner `dependencies` / `optionalDependencies` emit the bare form
  (for example `lodash: 4.17.21`), not v8/v9's quoted protocol.
- `checksum` values round-trip whatever was parsed (ADR-0031): the
  current fixtures carry a bare sha512 hex (no `<cacheKey>/` prefix) and
  stay bare, but a parsed `<cacheKey>/<hex>` prefix is preserved per-node
  (`TarballPayload.berryChecksumCacheKey`) — same uniform rule as v4 (F1).
- `conditions` are supported and round-trip as a **scalar** token via
  sidecar preservation, emitted bare (introduced at v5).
- `compressionLevel` is not present in the v6 corpus.

## Quirks

- `__metadata.cacheKey` is empirically `8` across the current v6 fixtures.
- Inner `dependencies` / `optionalDependencies` emit bare ranges
  (`lodash: 4.17.21`), unlike v8/v9's quoted protocol form.
- `checksum` values are raw sha512 hex, not `cacheKey/hash`.

## Degradation rules

Inherits v5.

## Fixtures

- `legacy/test/fixtures/yarn-6-mr/`

## Open questions

> None at preview. The current fixture set matches ADR-0018 §A.v6:
> same shape as v5, version handshake `6`, cacheKey `8`, bare inner
> dep ranges, raw checksum form.
