# `yarn-berry-v7` — yarn berry `yarn.lock` (`__metadata.version: 7`)

> Status: preview (adapter + round-trip tested; v6/v8 hybrid; frozen certification contract available).
> Updated: 2026-07-13
> Provenance: **Source-only**.
> Frozen certification: `prepareFrozen` / `certifyFrozen`; this schema has no bundled calibrated producer, so certification requires an external native-PM oracle receipt from the exact target manager version.

The version-invariant emit contract — the *Graph-level roundtrip*
property, canonical form, field schedule, SYML quoting, line endings,
and `__metadata.cacheKey` threading — is shared across the yarn-berry
family and lives in [`_common.md` §1](./_common.md#1-yarn-berry-emit-invariants-version-invariant);
this spec inherits it and records only the v7-specific deltas inline.
v7 is a hybrid: it carries v6's raw-hex checksum encoding overlaid with
v8's quoted-protocol inner ranges (see §Schema sketch below). The
completion phases (modify / enrich / optimize) are read-side-only in
this preview (Source-only provenance — no producer yet); their
normative rules reference published [ADR-0023](../decisions/0023-graph-modification-and-completion.md)
(modify / enrich) and [ADR-0024](../decisions/0024-optimize-phase.md)
(optimize).

## Compatibility

### Writers — PM semvers that *emit* this format

| PM | semver range | Default? | How to opt in |
|----|--------------|:--------:|---------------|
| yarn | `>=4.0.0-rc.27 <4.0.0` | ✓ | Yarn 4 RC transitional window: bumped 6 → 7 mid-RC cycle, then 7 → 8 at the 4.0 stable cut |

### Readers — PM semvers that *install* from this format

| PM | semver range | Notes |
|----|--------------|-------|
| yarn | `>=4.0.0-rc.27` | Stable 4.x readers still accept v7; the format was deprecated as a default but not rejected on parse |

## File

Same as [yarn-berry-v4](./yarn-berry-v4.md#file).

## Sources

- Yarn 4 RC release tags between `4.0.0-rc.27` and `4.0.0` mid-stream
  in 2023 — the period when `LOCKFILE_VERSION` constant was set to `7`
  before settling on `8` at the stable cut.
- Wild prevalence: production repos pinned during the Yarn 4 RC window
  retain v7 lockfiles unless force-regenerated. Two real-world fixtures
  observed (see §Fixtures): `qiwi/uniconfig` (commit `c5e7d5a3`),
  `qiwi/nestjs-enterprise` (commit `1a002336`).
- [`collab/research/lockfile-schema-history-yarn.md`](../../collab/research/lockfile-schema-history-yarn.md)
  — release-tag walk including the 6 → 7 → 8 RC bumps.

## Schema sketch

Hybrid of v6 (checksum encoding) and v8 (inner-range encoding):

- `__metadata.version: 7` discriminant.
- Inner `dependencies` / `optionalDependencies` emit the **quoted
  protocol-bearing form** (`lodash: "npm:4.17.21"`) — matches v8/v9,
  not v4/v5/v6's bare form.
- `checksum` values are **raw sha512 hex** with no `<cacheKey>/`
  prefix — matches v4/v5/v6, not v8/v9.
- `conditions` are supported (v5+ inheritance).
- `__metadata.cacheKey` empirically takes integer values (`9` in
  `qiwi/nestjs-enterprise`, `10` in `qiwi/uniconfig`) — pre-v8 bare
  numeric literal form, not v8/v9's quoted hex.

## Capabilities

Parse / stringify / graph-level mutate roundtrip / enrich / optimize
implemented against the fixture matrix at
`src/test/resources/fixtures/lockfiles/*/yarn-berry-v7.lock` (synthesised
by parsing each existing `yarn-berry-v8.lock` and re-emitting through
the v7 stringifier; the family pipeline guarantees this is a lossless
graph roundtrip).

Real-world parse coverage at
`src/test/resources/fixtures/real-world/{qiwi-uniconfig-master-c5e7d5a,qiwi-nestjs-enterprise-master-1a00233}/yarn.lock`.

## Conversion inputs

Same as [yarn-berry-v4](./yarn-berry-v4.md#conversion-inputs).

## Emit

Emit (`stringify(graph, options?)`) is governed by the shared,
version-invariant yarn-berry emit contract in
[`_common.md` §1](./_common.md#1-yarn-berry-emit-invariants-version-invariant)
(canonical form, block ordering, field schedule, the SYML quoting
predicate at [`_common.md` §1.5](./_common.md#15-quoting-the-syml-quoting-predicate),
line endings, and `__metadata.cacheKey` threading) — evaluated against
the v7 fixture set per the acceptance gate at
[`_common.md` §1.9](./_common.md#19-acceptance-gate). The v7-specific
config tuple is `{ lockfileVersion: 7, codePrefix: 'YARN_BERRY_V7',
rangeEmit: 'quoted-protocol', checksumPrefix: false, conditionsAllowed:
true }`, yielding these deltas on top of that shared contract:

- `__metadata.version` emits the literal `7`.
- `__metadata.cacheKey` defaults to absent; when present (caller-
  supplied via `options.cacheKey` or sidecar-preserved from parse) it
  emits as a bare numeric literal — pre-v8 form, no string quoting.
- Inner `dependencies` / `optionalDependencies` emit the quoted
  protocol-bearing form (`dep: "npm:2.0.0"`) — borrowed from v8/v9.
- `checksum` values round-trip whatever was parsed (the integrity model,
  [`_common.md` §3](./_common.md#3-integrity-model)): the current fixtures
  carry a bare sha512 hex (no `<cacheKey>/` prefix, shared with v4/v5/v6)
  and stay bare, but a parsed `<cacheKey>/<hex>` prefix is preserved
  per-node (`TarballPayload.berryChecksumCacheKey`) — same uniform rule
  as v4 (F1).
- `conditions` are supported and round-trip as a **scalar** token via
  sidecar preservation, emitted bare.
- `compressionLevel`, where present, is preserved as pass-through
  `__metadata` sidecar data via the same mechanism as v8.

## Quirks

- v7 was a transitional default only during the Yarn 4 RC window.
  Stable Yarn 4.0.0 jumped its default to v8; v7 lockfiles in the wild
  are typically RC-era artefacts that survived without regeneration.
- The hybrid encoding (v8-style ranges + v6-style checksum) is the
  defining marker — neither v6 nor v8 patterns match in isolation.
- `__metadata.cacheKey` empirically tracks the RC tag where the
  lockfile was last written (`9` mid-RC, `10` later RC); both forms
  parse equally.
- **Conditional-checksum policy — `conditions ∩ optionalBuilds`, version-independent.**
  A `conditions:`-bearing locator is bare iff it stays in `optionalBuilds`: reachable
  only through optional paths **and** not a resolver source. A conditioned locator on a
  required path, or a patch source (`fsevents` is always builtin-patched, so its base
  `npm:` locator is hashed even when every parent edge is optional), carries a checksum
  and enrich fills a fresh one; `@esbuild/*` (exclusively-optional, no patch) stays bare.
  See [`_common.md` §1.7.2](./_common.md#172-structural-checksum-gaps--entries-yarn-never-hashes).

## Degradation rules

Inherits v6 (raw-hex checksum side) and v8 (quoted-protocol inner
range side). No v7-specific degradation rules.

## Fixtures

- Synthetic: `src/test/resources/fixtures/lockfiles/*/yarn-berry-v7.lock`
  (8 fixtures generated via v8 → v7 lossless roundtrip).
- Real-world: `src/test/resources/fixtures/real-world/qiwi-uniconfig-master-c5e7d5a/yarn.lock`
  and `src/test/resources/fixtures/real-world/qiwi-nestjs-enterprise-master-1a00233/yarn.lock`.

## Open questions

> None at preview. The current fixture set matches the hybrid schema
> sketch above; cross-family conversion coverage gates the v7 contract
> through the same cross-format interop matrix as the other yarn-berry
> versions.
