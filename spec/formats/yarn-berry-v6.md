# `yarn-berry-v6` — yarn berry `yarn.lock` (`__metadata.version: 6`)

> Status: preview (adapter + round-trip tested; read-side completion only; frozen certification contract available).
> Updated: 2026-07-13
> Provenance: **Source-only**.
> Frozen certification: `prepareFrozen` / `certifyFrozen`; this schema has no bundled calibrated producer, so certification requires an external native-PM oracle receipt from the exact target manager version.

The version-invariant emit contract — the *Graph-level roundtrip*
property, canonical form, field schedule, SYML quoting, line endings,
and `__metadata.cacheKey` threading — is shared across the yarn-berry
family and lives in [`_common.md` §1](./_common.md#1-yarn-berry-emit-invariants-version-invariant);
this spec inherits it and records only the v6-specific deltas inline.
The completion phases (modify / enrich / optimize) are read-side-only
in this preview (Source-only provenance — no producer yet); their
normative rules reference published [ADR-0023](../decisions/0023-graph-modification-and-completion.md)
(modify / enrich) and [ADR-0024](../decisions/0024-optimize-phase.md)
(optimize).

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

Emit (`stringify(graph, options?)`) is governed by the shared,
version-invariant yarn-berry emit contract in
[`_common.md` §1](./_common.md#1-yarn-berry-emit-invariants-version-invariant)
(canonical form, block ordering, field schedule, the SYML quoting
predicate at [`_common.md` §1.5](./_common.md#15-quoting-the-syml-quoting-predicate),
line endings, and `__metadata.cacheKey` threading) — evaluated against
the v6 fixture set per the acceptance gate at
[`_common.md` §1.9](./_common.md#19-acceptance-gate). The v6-specific
deltas on top of that shared contract are:

- `__metadata.version` emits the literal `6`.
- `__metadata.cacheKey` defaults to absent; when present (caller-supplied
  via `options.cacheKey` or sidecar-preserved from parse) it emits as
  a bare numeric literal (`cacheKey: 8` empirically) — pre-v8 form, no
  string quoting.
- Inner `dependencies` / `optionalDependencies` emit the bare form
  (for example `lodash: 4.17.21`), not v8/v9's quoted protocol.
- `checksum` values round-trip whatever was parsed (the integrity model,
  [`_common.md` §3](./_common.md#3-integrity-model)): the current fixtures
  carry a bare sha512 hex (no `<cacheKey>/` prefix) and stay bare, but a
  parsed `<cacheKey>/<hex>` prefix is preserved per-node
  (`TarballPayload.berryChecksumCacheKey`) — same uniform rule as v4 (F1).
- `conditions` are supported and round-trip as a **scalar** token via
  sidecar preservation, emitted bare (introduced at v5).
- `compressionLevel` is not present in the v6 corpus.

## Quirks

- `__metadata.cacheKey` is empirically `8` across the current v6 fixtures.
- Inner `dependencies` / `optionalDependencies` emit bare ranges
  (`lodash: 4.17.21`), unlike v8/v9's quoted protocol form.
- `checksum` values are raw sha512 hex, not `cacheKey/hash`.
- **Conditional-checksum policy — pure conditions (pre-4.4).** yarn through
  this lock version writes `hash: null` for **every** `conditions:`-bearing
  locator, regardless of optionality; the `optionalBuilds` gate governs only
  mocked/disabled packages here. A conditioned entry is therefore structurally
  bare, and enrich never mints a checksum into one. See
  [`_common.md` §1.7.2](./_common.md#172-structural-checksum-gaps--entries-yarn-never-hashes).

## Degradation rules

Inherits v5.

## Fixtures

See the test-bench fixtures under [`src/test/resources/fixtures/`](../../src/test/resources/fixtures) — `lockfiles/<case>/<format>.lock` for canonical per-case locks (`npm run build:fixtures`), `real-world/` for whole-project samples.

## Open questions

> None at preview. The current fixture set matches the documented
> deltas: same shape as v5, version handshake `6`, cacheKey `8`, bare
> inner dep ranges, raw checksum form.
