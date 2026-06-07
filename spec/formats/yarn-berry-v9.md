# `yarn-berry-v9` — yarn berry `yarn.lock` (`__metadata.version: 9`)

> Status: preview.
> Provenance: **Source-only**.

The version-invariant emit contract — the *Graph-level roundtrip*
property, canonical form, field schedule, SYML quoting, line endings,
and `__metadata.cacheKey` threading — is shared across the yarn-berry
family and lives in [`_common.md` §1](./_common.md#1-yarn-berry-emit-invariants-version-invariant);
this spec inherits it and records only the v9-specific deltas
(cacheKey `10c0`, the three structured-fields round-trip, the
`::locator=` descriptor nuance, the v9 schema-version handshake)
inline. Modify, enrich, and optimize are read-side-only in this
preview (Source-only provenance — no producer yet); the completion
phases reference published [ADR-0023](../decisions/0023-graph-modification-and-completion.md)
(modify / enrich) and [ADR-0024](../decisions/0024-optimize-phase.md)
(optimize) for their normative rules.

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

Same as [yarn-berry-v4](./yarn-berry-v4.md#conversion-inputs). The
patch-slot fingerprint recipe (file-backed and `~builtin<…>`),
sentinel input shape, path-confinement rule, and
[`patch:`-descriptor edge resolution](./yarn-berry-v4.md#patch-descriptor-edges)
(form a / form b, multi-consumer `&locator=` disambiguation) carry over
verbatim — v9 inherits v4's `## Patch slot`, `## Path confinement`, and
`## Patch-descriptor edges` sub-sections without re-statement. The
underlying `+patch=` slot grammar and `unresolved-<sha256>` sentinel
that those sub-sections build on are the shared
[`_common.md` §2](./_common.md#2-patch-slot--tarballkey-sentinel) model.
The **emit-side** companion (canonical form rules, field schedule,
quoting, line endings, `__metadata.cacheKey` threading) is the shared
[`_common.md` §1](./_common.md#1-yarn-berry-emit-invariants-version-invariant)
contract — see [#emit](#emit) below.

## Emit

Emit (`stringify(graph, options?)`) is governed by the shared,
version-invariant yarn-berry emit contract in
[`_common.md` §1](./_common.md#1-yarn-berry-emit-invariants-version-invariant)
— normative source for:

- the *Graph-level roundtrip* property
  (`parse(stringify(parse(x))) ≡ parse(x)`),
- canonical preamble, block ordering, entry-internal field schedule,
  SYML quoting predicate (the single upstream "simple string" rule;
  [`_common.md` §1.5](./_common.md#15-quoting-the-syml-quoting-predicate)),
  indent, line endings (`lf` default, `crlf` opt-in), trailing newline,
  `__metadata.cacheKey` threading,
- non-goals (no byte-lossless roundtrip, no CST-grade fidelity, no
  unmodelled `__metadata` resurrection).

The acceptance gate ([`_common.md` §1.9](./_common.md#19-acceptance-gate))
is evaluated against the v9 fixture set
`src/test/resources/fixtures/lockfiles/*/yarn-berry-v9.lock`. The
v9-specific emit deltas inherited on top of the shared contract are the
cacheKey `10c0` form (`<cacheKey>/<hex>` checksums, see [Quirks](#quirks)),
the three structured-fields round-trip, and the `::locator=` descriptor
nuance — all detailed under [Quirks](#quirks) below.

Subsequent phases — modify, enrich, optimize — are read-side-only in
this preview. Their normative rules live in published
[ADR-0023](../decisions/0023-graph-modification-and-completion.md)
(modification / tree completion / enrich) and
[ADR-0024](../decisions/0024-optimize-phase.md) (optimize: orphan GC).

## Schema sketch

Same shape as v8 with — TBD — field-level diffs once we have a producer.

## Capabilities

Inherits v8. Additionally:

### `peerDependenciesMeta` reconstruction (cross-format)

When converting **into** yarn-berry from any source, the per-peer
`peerDependenciesMeta: { <peer>: { optional: true } }` block is reconstructed
from the canonical model rather than a yarn-native sidecar, so the optional-peer
flag survives conversions that the source format modelled it on:

- **Emit from the edge (offline, no configuration).** Every out-`peer` edge
  carrying the canonical `optional` attribute (`EdgeAttrs.optional`, the model's
  home for peer-optionality — set by the pnpm reader, among others) emits a
  `<peer>: { optional: true }` entry, UNIONED with any verbatim same-format
  hint. The block key follows the emitted `peerDependencies` key (the edge
  alias when aliased, else the target's name). This alone round-trips a
  pnpm → yarn-berry optional peer with no enrich step and no workspace context.
- **Enrich fills the gap for formats that drop the flag.** npm, bun, and
  yarn-classic discard `peerDependenciesMeta` on parse, so their edges reach
  yarn-berry without an `optional` attribute. The enrich pass (published
  [ADR-0023](../decisions/0023-graph-modification-and-completion.md))
  walks each such peer edge and consults a **fill ladder**, setting
  `EdgeAttrs.optional = true` only when an authoritative source proves the peer
  optional. The pass is **monotone-additive** (it unions the flag, never clears
  one) and **idempotent** (a second pass finds the flag already on the edge and
  changes nothing).

The fill ladder, first authoritative *answer* wins (a found manifest answers
definitively, even when that answer is 'required'):

1. **Graph (rung 1).** The flag already on the edge — free, always consulted.
2. **Local installed manifest (rung 2).** `<workspaceRoot>/node_modules/
   <parent>/package.json` → the parent's own `peerDependenciesMeta`. The parent
   manifest is the authoritative origin of the value, so a manifest that is
   present but does NOT list the peer is a definitive *required* answer (no
   diagnostic), distinct from a manifest that is absent (an unanswerable
   lookup). Consulted only when the caller supplies `workspaceRoot`. Offline,
   synchronous, deterministic.
3. **Cache / registry (rungs 3–4).** Strictly opt-in — see the posture note
   under [Degradation rules](#degradation-rules).

## Quirks

- Brand-new (released 2026-04-16) — most of the ecosystem still writes
  v8. Treat as forward-compat target rather than canonical input.
- The bump itself is mechanical (a `version: N` field), but historical
  evidence (yarn 4 → 6 introduced cacheKey, yarn 4 → 8 added
  `compressionLevel`) suggests v9 is likely paired with at least one
  structural change that needs probing.
- **`checksum` is a digest of yarn's post-processed zip-cache, NOT the tarball
  sha512.** Modelled internally as a `berry-zip`-origin hash under the shared
  integrity model ([`_common.md` §3](./_common.md#3-integrity-model)), it is
  interchangeable only within the yarn family (raw hex pre-v8, `<cacheKey>/<hex>`
  v8+, with v9 carrying the `10c0/<hex>` form). A tarball SRI is never re-encoded
  into it, nor it into an SRI — they are digests of different byte streams (the
  berry-zip ≠ tarball-SRI boundary,
  [`_common.md` §3.3](./_common.md#33-the-berry-zip--tarball-sri-boundary)).
- A LOCAL node (`portal:` / `link:`, canonical resolution `type: 'directory'`)
  may depend on a workspace — e.g. a `portal:` package declaring
  `"<root>": "workspace:^"` in its own monorepo. The graph seal permits incoming
  edges to a workspace from workspace and local-directory sources; only a
  *published* (registry / tarball / git) source depending on a workspace is
  rejected (ADR-0017).
- **Local-artefact locator at the same `name@version` as a registry entry —
  disambiguated via the `+patch=unresolved-…` sentinel slot.** A `file:`
  local-tarball alias, a `link:`, or a `portal:` reference can resolve to the
  same `name@version` as a sibling `npm:` entry yet be a *genuinely different
  artefact* (own checksum, own dependency ranges, distinct canonical resolution
  — e.g. `tarball`/`directory` vs registry). Yarn keeps them apart in the
  lockfile via a consumer-ownership qualifier (`::locator=<encoded-consumer>` on
  the entry key; the same `locator=` rides the resolution's `::`-param block,
  e.g. `…tgz#…::hash=17d4d9&locator=…`). Because the NodeId only carries
  name + version + peer-context + patch, the patch slot is the sole free
  discriminator: such an entry takes a sentinel patch
  `+patch=unresolved-<sha256 of its verbatim locator>` (the shared
  `unresolved-<sha256>` sentinel,
  [`_common.md` §2.2](./_common.md#22-the-unresolved-sha256-sentinel)), so the
  two stay **distinct nodes** with **distinct TarballKeys** (their differing
  checksums / deps no longer collide) instead of throwing `IRREDUCIBLE_LOSS`.
  The sentinel is gated on the consumer qualifier: a `link:`/`portal:` protocol
  reference always qualifies; a `file:` reference qualifies only when it bears
  a `locator=` qualifier — a plain `file:../dir` directory link (already a
  unique node) is left unpatched. `Node.resolution` carries the verbatim
  locator for byte-faithful round-trip.
- **The `::locator=` entry-key descriptor round-trips with its qualifier; no
  bare duplicate is appended.** A consumer records a `link:`/`portal:` dependency
  **bare** in its `dependencies:` block (`<dep>: "link:packages/x"`), while yarn
  keys the resolved entry with the single `::locator=`-qualified descriptor
  (`"<name>@link:packages/x::locator=<encoded-consumer>":`). On parse the bare
  consumer edge is re-qualified from the consumer's own resolution, so the bare
  range is what survives on the edge. On emit, the entry key is the **single
  qualified** descriptor — the bare incoming-edge range is **not** re-added as a
  second descriptor (it is the exact locator-less prefix of the qualified
  primary, which already represents that consumer). The consumer's `dependencies:`
  value stays bare. Net: the entry-key descriptor set is byte-stable across
  parse → stringify → parse (it does **not** grow a spurious
  `<name>@link:packages/x` sibling). The same holds for a `file:` alias whose
  resolution carries `…&locator=…`. Multiple workspaces linking the same on-disk
  path produce one sentinel node **per** `::locator=`, each emitting its own
  single qualified key. Conversely, a consumer that records the bare
  `link:`/`portal:` dependency but whose own `::locator=` entry is **absent**
  (a malformed or hand-edited lock) does not borrow a sibling's sentinel via the
  entry-key descriptor — it reports `YARN_BERRY_UNRESOLVED_DEP` rather than
  silently collapsing onto another consumer's node.
- **A dependency reference whose target is absent from the lock round-trips
  verbatim (F8/#103).** The most common v9 trigger is a **`catalog:`** range
  (`"@jridgewell/trace-mapping": "catalog:"`) — yarn 4 catalogs resolve the
  version from `.yarnrc.yml`, which is **not** in the lockfile, so the
  descriptor binds no entry and hits the ladder's
  [Rung 4](./_common.md#52-the-resolution-ladder-normative). A `resolutions`
  pin to a descriptor with no entry behaves the same. Such a ref is **not** a
  graph edge; rather than dropping it, the verbatim descriptor (block,
  dep-name, exact range) is preserved in a per-node sidecar and re-emitted, so
  a same-format round-trip is byte-faithful (observed: babel 38 such refs,
  highlight 15). `YARN_BERRY_UNRESOLVED_DEP` still fires for each. Inherited
  from the v8 [Emit notes](./yarn-berry-v8.md#emit); **same-format only** — a
  cross-PM convert does not carry these.
- **Three structured fields round-trip (`conditions`, `dependenciesMeta`,
  `peerDependenciesMeta`).** Inherited from v8 (see the
  [v8 schema sketch](./yarn-berry-v8.md#schema-sketch) for the entry shape):
  - `conditions` is a **scalar** platform-gate token (`os=darwin & cpu=arm64`,
    or a grouped `(os=darwin | os=linux | …)`) — NOT a structured map. It is
    captured verbatim and emitted **bare**: the single SYML quoting predicate
    ([`_common.md` §1.5](./_common.md#15-quoting-the-syml-quoting-predicate))
    leaves it unquoted because spaces / `&` / `|` / `(` are permitted body
    characters. It never participates in NodeId / TarballKey identity.
  - `dependenciesMeta` (`{ <pkg>: { optional|built|… } }`) round-trips as a
    verbatim per-node sidecar block (install-hint fidelity only). Its boolean
    values (`optional` / `built` / `unplugged`) emit **bare** (`built: false`,
    not `built: "false"`) — the quoting predicate leaves a bare `true`/`false`
    token unquoted, exactly as yarn does. This is correctness, not cosmetics: a
    quoted `built: "false"` is a truthy non-empty string, so yarn's
    `if (meta.built)` reads it as true and may run a postinstall the lock meant
    to suppress (see [`_common.md` §1.5](./_common.md#15-quoting-the-syml-quoting-predicate)).
  - `peerDependenciesMeta` (`{ <peer>: { optional: true } }`) round-trips through
    the **same** emitter as the cross-format reconstruction above — the captured
    block is the rung-0 hint, unioned with any `optional` peer edge and deduped
    by peer name, so berry → berry and pnpm → berry share one emit path with no
    double-emit. Its `optional: true` boolean emits **bare**, as above. On enrich,
    the on-lock `peerDependenciesMeta.optional` is the authoritative rung-0 signal
    that stamps `EdgeAttrs.optional` on the derived peer edge (no `node_modules`
    lookup required for a berry source).
  - Emit order matches yarn for `dependenciesMeta` (immediately before
    `peerDependenciesMeta`); `conditions`/`checksum`/`languageName`/`linkType`
    sit in this adapter's intra-emitter schedule, which differs from yarn's
    native order but is lossless and idempotent.

## Degradation rules

Inherits v8. Additionally: **converting from a non-yarn source** (npm / pnpm /
bun / yarn-classic) cannot fill `checksum` offline — a tarball sha512 is not a
zip-cache digest — so the line is **omitted** (never fabricated) and
`RECIPE_INTEGRITY_INCOMPLETE` is emitted; yarn recomputes the digest on install.

**`peerDependenciesMeta.optional` that cannot be reconstructed is omitted, not
guessed.** When the enrich fill ladder (see
[Capabilities](#peerdependenciesmeta-reconstruction-cross-format)) is asked to
recover an optional flag — i.e. an external rung was configured — but no rung
can answer (e.g. `workspaceRoot` was supplied yet the parent is not installed in
`node_modules`, and no opt-in resolver answered), the marker is **omitted** and
`RECIPE_PEER_META_INCOMPLETE` (warning, `subject` = the consumer node) is
emitted. yarn re-derives `peerDependenciesMeta` from each package's own manifest
at install, so omission is a safe degrade. This shares the omit-not-fabricate
posture of `RECIPE_INTEGRITY_INCOMPLETE`, but differs in *when* it fires: unlike
integrity (which warns whenever a held fact cannot be represented), this fires
only when an external rung was requested — in pure rung-1 mode the graph is the
authority and the pass is silent.

**Offline-by-default posture (network is strictly opt-in).** A bare conversion
into yarn-berry is **synchronous, offline, and deterministic**: it never opens a
socket. Peer-optional reconstruction consults rung 1 (the graph) always, and
rung 2 (local `node_modules`) only when the caller passes `workspaceRoot`. With
neither an installed-manifest path nor a resolver configured — *pure rung-1
mode* — the graph is the sole authority: a peer edge without an `optional`
attribute is treated as required and produces **no** `RECIPE_PEER_META_INCOMPLETE`
noise (the diagnostic fires only when an external lookup was requested and
failed). Rungs 3–4 (cache / registry) are reached only through a
caller-supplied resolver; the default pipeline never fabricates one. This keeps
the converter pure and CI-stable rather than introducing non-determinism or a
supply-chain surface into a format conversion.

## Fixtures

> **TBD:** no v9 fixtures yet — they are unproducible from the current
> producer matrix and are blocked pending off-npm delivery of a yarn
> 4.14+ producer into the fixture toolchain. Once that producer is
> available, the canonical writer is yarn 4.14+.

## Open questions

> **Deferred to producer wiring.** What fields beyond
> `__metadata.version` actually changed in the v8 → v9 transition? Read
> the yarn 4.14.0 changelog and diff its `Project.ts` against 4.13.0
> once a producer is wired up. The shared canonical form in
> [`_common.md` §1](./_common.md#1-yarn-berry-emit-invariants-version-invariant)
> is *our* canonical form — byte-identity to yarn 4.14+ output is a
> bonus, not a contract (an emit divergence between our canonical form
> and a future yarn 4 → 9 writer is absorbed by the yarn-berry adapter,
> not by moving the contract), so this question gates fixture
> provenance and capability-table refinement, not the
> [`_common.md` §1.9](./_common.md#19-acceptance-gate) acceptance gate.
