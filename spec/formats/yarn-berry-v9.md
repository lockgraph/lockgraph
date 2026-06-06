# `yarn-berry-v9` — yarn berry `yarn.lock` (`__metadata.version: 9`)

> Status: preview.
> Provenance: **Source-only**.

The completeness contract — stringify, modify, enrich, optimize —
is owned by [ADR-0016](../decisions/0016-yarn-berry-v9-completeness-contract.md).
This spec records read-side capabilities and points to ADR-0016 for
the normative emit / mutate / enrich / prune rules; nothing in this
file overrides ADR-0016.

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
sentinel input shape, and path-confinement rule carry over verbatim
— v9 inherits v4's `## Patch slot` and `## Path confinement`
sub-sections without re-statement.
[ADR-0016](../decisions/0016-yarn-berry-v9-completeness-contract.md)
§A is the normative source for the **emit-side** companion (canonical
form rules, field schedule, quoting, line endings, `__metadata.cacheKey`
threading) — see [#emit](#emit) below.

## Emit

Emit (`stringify(graph, options?)`) is governed by
[ADR-0016 §A *Stringify*](../decisions/0016-yarn-berry-v9-completeness-contract.md#a-stringify)
— normative source for:

- the *Graph-level roundtrip* property
  (`parse(stringify(parse(x))) ≡ parse(x)`),
- canonical preamble, block ordering, entry-internal field schedule,
  SYML quoting predicate (the five-condition rule), indent, line
  endings (`lf` default, `crlf` opt-in), trailing newline,
  `__metadata.cacheKey` threading,
- non-goals (no byte-lossless roundtrip, no CST-grade fidelity, no
  unmodelled `__metadata` resurrection),
- acceptance gate against the
  `src/test/resources/fixtures/lockfiles/*/yarn-berry-v9.lock`
  fixture set.

Subsequent phases — modify (§B), enrich (§C), optimize (§D) — are
similarly normative-in-ADR-0016. Any conflict between this spec and
ADR-0016 is resolved in ADR-0016's favour until the ADR flips
`accepted` and this section is updated to reflect the final shape.

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
  yarn-berry without an `optional` attribute. The enrich pass (ADR-0016 §C)
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
  sha512.** Modelled internally as a `berry-zip`-origin hash, it is
  interchangeable only within the yarn family (raw hex pre-v8, `<cacheKey>/<hex>`
  v8+). A tarball SRI is never re-encoded into it, nor it into an SRI — they are
  digests of different byte streams.
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
  `+patch=unresolved-<sha256 of its verbatim locator>` (per ADR-0011), so the
  two stay **distinct nodes** with **distinct TarballKeys** (their differing
  checksums / deps no longer collide) instead of throwing `IRREDUCIBLE_LOSS`.
  The sentinel is gated on the consumer qualifier: a `link:`/`portal:` protocol
  reference always qualifies; a `file:` reference qualifies only when it bears
  a `locator=` qualifier — a plain `file:../dir` directory link (already a
  unique node) is left unpatched. `Node.resolution` carries the verbatim
  locator for byte-faithful round-trip.

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

> **TBD:** unproducible from current matrix; gated on
> [ADR-0005](../decisions/0005-pm-delivery-off-npm.md). When unblocked,
> canonical writer is yarn 4.14+.

## Open questions

> **Deferred to producer wiring (out of ADR-0016 scope).** What
> fields beyond `__metadata.version` actually changed in the v8 → v9
> transition? Read yarn 4.14.0 changelog and diff its `Project.ts`
> against 4.13.0 once a producer is wired up. The §A canonical form
> in ADR-0016 is *our* canonical form — byte-identity to yarn 4.14+
> output is a bonus, not a contract (see ADR-0016 *Risks: yarn 4 → 9
> emit divergence*), so this question gates fixture provenance and
> capability-table refinement, not the §A acceptance gate.
