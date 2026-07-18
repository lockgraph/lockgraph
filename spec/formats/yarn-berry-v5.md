# `yarn-berry-v5` — yarn berry `yarn.lock` (`__metadata.version: 5`)

> Status: preview (adapter + round-trip tested; read-side completion only; frozen certification contract available).
> Updated: 2026-07-13
> Provenance: **Source-only**.
> Frozen certification: `prepareFrozen` / `certifyFrozen`; this schema has no bundled calibrated producer, so certification requires an external native-PM oracle receipt from the exact target manager version.

The version-invariant emit contract — the *Graph-level roundtrip*
property, canonical form, field schedule, SYML quoting, line endings,
and `__metadata.cacheKey` threading — is shared across the yarn-berry
family and lives in [`_common.md` §1](./_common.md#1-yarn-berry-emit-invariants-version-invariant);
this spec inherits it and records only the v5-specific deltas inline.
The completion phases (modify / enrich / optimize) are read-side-only
in this preview (Source-only provenance — no producer yet); their
normative rules reference published [ADR-0023](../decisions/0023-graph-modification-and-completion.md)
(modify / enrich) and [ADR-0024](../decisions/0024-optimize-phase.md)
(optimize).

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

Emit (`stringify(graph, options?)`) is governed by the shared,
version-invariant yarn-berry emit contract in
[`_common.md` §1](./_common.md#1-yarn-berry-emit-invariants-version-invariant)
(canonical form, block ordering, field schedule, the SYML quoting
predicate at [`_common.md` §1.5](./_common.md#15-quoting-the-syml-quoting-predicate),
line endings, and `__metadata.cacheKey` threading) — evaluated against
the v5 fixture set per the acceptance gate at
[`_common.md` §1.9](./_common.md#19-acceptance-gate). The v5-specific
deltas on top of that shared contract are:

- `__metadata.version` emits the literal `5`.
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
  sidecar preservation (emitted bare) — v5 is the FIRST version with
  this field (v4 lacks it).
- `compressionLevel` is not present in the v5 corpus.

## Quirks

- `__metadata.cacheKey` is empirically `8` across the current v5 fixtures.
- Inner `dependencies` / `optionalDependencies` emit bare ranges
  (`lodash: 4.17.21`), unlike v8/v9's quoted protocol form.
- `checksum` values are raw sha512 hex, not `cacheKey/hash`.
- `conditions` first appears in v5; it is a **scalar** token (e.g.
  `os=linux`), NOT a nested block. The current shipped fixture set does
  not exercise it, but parse/stringify coverage preserves the scalar
  verbatim (emitted bare) in the adapter contract. (An earlier draft of
  this spec wrongly claimed a nested-block shape; the scalar form is the
  corrected contract.)
- **Conditional-checksum policy — `conditions ∩ optionalBuilds`, version-independent.**
  A `conditions:`-bearing locator is bare iff it stays in `optionalBuilds`: reachable
  only through optional paths **and** not a resolver source. A conditioned locator on a
  required path, or a patch source (`fsevents` is always builtin-patched, so its base
  `npm:` locator is hashed even when every parent edge is optional), carries a checksum
  and enrich fills a fresh one; `@esbuild/*` (exclusively-optional, no patch) stays bare.
  Lock v5 applies yarn's 3.1.x **first-visit** `optionalBuilds` tie-break when a locator
  is reached through both an optional and a required path. See
  [`_common.md` §1.7.2](./_common.md#172-structural-checksum-gaps--entries-yarn-never-hashes).

## Degradation rules

Inherits v4.

## Fixtures

See the test-bench fixtures under [`src/test/resources/fixtures/`](../../src/test/resources/fixtures) — `lockfiles/<case>/<format>.lock` for canonical per-case locks (`npm run build:fixtures`), `real-world/` for whole-project samples.

## Open questions

> None at preview. Fixture verification matched the documented deltas on
> all observed points: handshake `5`, cacheKey `8`, bare inner dep
> ranges, raw checksum form, and no `compressionLevel` in the current
> fixture corpus.
