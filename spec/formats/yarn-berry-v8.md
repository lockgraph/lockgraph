# `yarn-berry-v8` — yarn berry `yarn.lock` (`__metadata.version: 8`)

> Status: preview.
> Provenance: **Source-only**.

The version-invariant emit contract — the *Graph-level roundtrip*
property, canonical form, field schedule, SYML quoting, line endings,
and `__metadata.cacheKey` threading — is shared across the yarn-berry
family and lives in [`_common.md` §1](./_common.md#1-yarn-berry-emit-invariants-version-invariant);
this spec inherits it and records only the v8-specific deltas
(cacheKey `10c0`, quoted protocol-bearing inner-block ranges, the
`<cacheKey>/<hex>` checksum form, `compressionLevel`, the three
structured-fields round-trip, and the `::locator=` descriptor nuance)
inline. Modify, enrich, and optimize reference published
[ADR-0023](../decisions/0023-graph-modification-and-completion.md)
(modify / enrich) and [ADR-0024](../decisions/0024-optimize-phase.md)
(optimize) for their normative rules.

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

Same shape as v6 with the same scalar `conditions` support, but
with `__metadata.version: 8`, quoted protocol-bearing inner-block
dependency ranges (`lodash: "npm:4.17.21"`), cacheKey-prefixed
checksums (`<cacheKey>/<hex>`), and `compressionLevel` carried in
`__metadata`.

A real v8 entry may carry three structured fields beyond the basic
descriptor — all three round-trip:

```
"some-pkg@npm:1.0.0":
  version: 1.0.0
  resolution: "some-pkg@npm:1.0.0"
  dependencies:
    fsevents: "npm:2.3.3"
  dependenciesMeta:           # { pkg: { optional | built | … } }
    fsevents:
      optional: true
  peerDependencies:
    react: "*"
  peerDependenciesMeta:       # { peer: { optional: true } }
    react:
      optional: true
  checksum: 10c0/…
  conditions: os=darwin & cpu=arm64   # SCALAR platform gate
  languageName: node
  linkType: hard
```

- `conditions` — a **scalar** platform-condition token (NOT a nested
  map): `os=darwin & cpu=arm64`, `os=linux`, or a grouped form like
  `(os=darwin | os=linux | os=win32 | os=freebsd)`. Gates
  platform-specific optional binaries (`@esbuild/*`, `@swc/*`,
  `@cloudflare/workerd-*`, `sharp`, `fsevents`). Carried verbatim.
- `dependenciesMeta` — `{ <pkg>: { optional|built|… } }` install hints.
- `peerDependenciesMeta` — `{ <peer>: { optional: true } }`.

## Capabilities

Parse / stringify / graph-level mutate roundtrip / enrich / optimize
implemented against the fixture matrix at
`src/test/resources/fixtures/lockfiles/*/yarn-berry-v8.lock`.

## Conversion inputs

Same as [yarn-berry-v4](./yarn-berry-v4.md#conversion-inputs).

## Emit

Emit (`stringify(graph, options?)`) is governed by the shared,
version-invariant yarn-berry emit contract in
[`_common.md` §1](./_common.md#1-yarn-berry-emit-invariants-version-invariant)
— normative source for the *Graph-level roundtrip* property
(`parse(stringify(parse(x))) ≡ parse(x)`), the canonical preamble,
block ordering, entry-internal field schedule, the SYML quoting
predicate (the single upstream "simple string" rule;
[`_common.md` §1.5](./_common.md#15-quoting-the-syml-quoting-predicate)),
indent, line endings (`lf` default, `crlf` opt-in), trailing newline,
`__metadata.cacheKey` threading, and the non-goals (no byte-lossless
roundtrip, no CST-grade fidelity, no unmodelled `__metadata`
resurrection). The acceptance gate
([`_common.md` §1.9](./_common.md#19-acceptance-gate)) is evaluated
against the v8 fixture set
`src/test/resources/fixtures/lockfiles/*/yarn-berry-v8.lock`. The
v8-specific deltas inherited on top of the shared contract are:

- `__metadata.version` emits the literal `8`.
- `__metadata.cacheKey` defaults to absent, but when present it is
  threaded through into the `checksum` prefix form `<cacheKey>/<hex>`.
- Inner `dependencies` / `optionalDependencies` emit the quoted
  protocol-bearing form (for example `dep: "npm:2.0.0"`).
- `conditions` are supported and round-trip as a **scalar** token via
  sidecar preservation. The value is emitted **bare** (unquoted), even
  when it contains spaces / `&` / `( | )`, to match yarn's output
  byte-for-byte.
- `dependenciesMeta` round-trips verbatim per node (a raw sidecar
  block; install-hint fidelity only — no cross-format EdgeAttrs
  modelling). Its boolean values (`optional` / `built` / `unplugged`)
  are emitted **bare** (`built: false`, not `built: "false"`), matching
  yarn — the quoting predicate leaves a bare `true`/`false` token unquoted
  directly; bare is correctness, not just fidelity — a quoted `"false"` is a
  truthy string that flips yarn's `if (meta.built)` to true (see
  [`_common.md` §1.5](./_common.md#15-quoting-the-syml-quoting-predicate)).
- `peerDependenciesMeta` round-trips through the **same emitter** as
  the pnpm→berry `peerDependenciesMeta` reconstruction (task #86): the
  captured block is the rung-0 hint, unioned with any `optional` peer
  edge, deduped by peer name (no double-emit). Its `optional: true`
  boolean is likewise emitted **bare**.
- **Unresolvable dependency references** (F8/#103) — a `dependencies:`
  or `optionalDependencies:` entry whose target package is **absent**
  from the lock (no `resolution:` entry block; the
  [descriptor→node ladder](./_common.md#52-the-resolution-ladder-normative)
  Rung 4 cannot bind it — e.g. a `catalog:` ref, or a `resolutions`-pinned
  descriptor whose pin has no entry) is **not** a graph edge, so it cannot
  be reconstructed from the edge set on emit. It is preserved **verbatim**
  (its block, dep-name, and exact on-disk range string) in a per-node
  PM-native sidecar — the same role
  [`Node.resolution`](./_common.md#23-canonical-vs-pm-native-attribution-principle)
  plays — and re-emitted into the matching inner-block (re-sorted with the
  live edges to keep yarn's alphabetical block order), so a
  **same-format** round-trip is byte-faithful. The Rung-4
  `YARN_BERRY_UNRESOLVED_DEP` diagnostic **still fires** — preservation
  keeps **both** the bytes and the signal. This is **same-format only**:
  the sidecar lives solely in the yarn-berry adapter, so a cross-PM
  convert (yarn-berry → npm/pnpm/bun) does **not** carry these
  berry-native unresolved refs (they are not edges, and no foreign adapter
  reads the carrier). No phantom/placeholder node is minted — NodeId and
  edge identity stay clean.
- `compressionLevel` is preserved as pass-through `__metadata`
  sidecar data; the current fixture corpus carries `0`.

## Quirks

- `__metadata.cacheKey` is empirically `10c0` across the current v8 fixtures.
- Inner `dependencies` / `optionalDependencies` emit quoted
  protocol-bearing ranges, unlike v4/v5/v6's bare form.
- `checksum` values are `cacheKey/hash`, not raw sha512 hex.
- `conditions` is a **scalar** token (e.g. `os=darwin & cpu=arm64`),
  NOT a structured map — it is emitted bare and round-trips verbatim,
  matching the v5/v6 scalar sidecar shape. (A field-level round-trip
  sweep — task #89 — caught that the old SymlMap coercion silently
  dropped it on 100% of real locks; a value-only sweep had missed it.)
- `dependenciesMeta` and `peerDependenciesMeta` are present on most
  real-world v8 locks and round-trip; `dependenciesMeta` is emitted
  immediately before `peerDependenciesMeta`, matching yarn. Their boolean
  values (`optional` / `built` / `unplugged`) emit **bare** (`optional:
  true`, `built: false`) — like `conditions`, the single SYML quoting
  predicate leaves a bare `true`/`false` token unquoted, matching yarn;
  quoting `built: "false"` would be a truthy-string correctness bug, not a
  style nit (#89 regression).
- `compressionLevel` first appears in the current family corpus at v8
  and is preserved through `sidecar.metadata`.
- A dependency reference to a package **absent** from the lock (no
  `resolution:` entry) round-trips **verbatim** via a per-node sidecar
  rather than being dropped (F8/#103). It is observed on real v8/v9 locks
  (e.g. babel drops 38 such refs, highlight 15) — frequently a `catalog:`
  ref or a `resolutions` pin with no entry. The
  `YARN_BERRY_UNRESOLVED_DEP` warning still fires for each. Preservation is
  **same-format only**: a cross-PM convert does not carry these (the
  carrier is a berry-adapter sidecar, and these are not graph edges).
- A `link:`/`portal:` (or locator-qualified `file:`) entry keyed with a
  `::locator=<encoded-consumer>` qualifier round-trips as the **single
  qualified** entry-key descriptor. A consumer records the dependency BARE
  in its `dependencies:` block (`<dep>: "link:packages/x"`); on emit the
  entry key is NOT padded with a spurious locator-less
  `<name>@link:packages/x` sibling (the bare form is the prefix of the
  qualified primary, which already represents that consumer, and reparse
  re-derives the qualifier). The descriptor set is byte-stable across
  parse → stringify → parse. See the
  [v9 locator-disambiguation note](./yarn-berry-v9.md) for the full
  sentinel-slot rationale (shared across v8+).

## Degradation rules

Inherits v6.

## Fixtures

- `legacy/test/fixtures/yarn-7-mr/` (the existing `yarn-7-mr` fixture is
  actually a v8 lockfile — yarn 4 era — confirm and rename if needed)

## Open questions

> None at preview. Fixture verification matched the documented v8
> deltas on every observed field: handshake `8`, cacheKey `10c0`,
> quoted inner dep ranges, `cacheKey/hash` checksum form, `conditions`,
> and `compressionLevel`.
