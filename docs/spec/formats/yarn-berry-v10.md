# `yarn-berry-v10` — yarn berry `yarn.lock` (`__metadata.version: 10`)

> Status: stable schema target (adapter + round-trip tested; frozen certification contract available; emitted by stable Yarn 4.17.1 and later).
> Updated: 2026-09-28
> Provenance: **Source-only** (Yarn 4.17.1 producer source).
> Frozen certification: bundled pinned Yarn 4.18.1 producer plus
> `prepareFrozen` / `certifyFrozen` native-PM receipt contract.

The completeness contract — stringify, modify, enrich, optimize —
inherits from [yarn-berry-v9](./yarn-berry-v9.md): the shared,
version-invariant yarn-berry emit contract lives in
[`_common.md` §1](./_common.md#1-yarn-berry-emit-invariants-version-invariant),
and the completion phases (modify / enrich / optimize) are library
behaviour rather than properties of this file format, specified outside
this document. This spec records only the read-side capabilities and the
single on-disk delta from v9 (`__metadata.version: 10`). That inheritance
claim is measured against real v10 lockfiles from `prettier`,
`facebook/jest`, and `yarnpkg/berry` master, compared with the 1,760-entry
v9 `babel` lockfile: their field vocabulary is identical, v10 adds or drops
no field, and both generations use `cacheKey: 10`. `cacheKey` is independent
of the lockfile version; never derive it from `__metadata.version`.

## Compatibility

### Writers — PM semvers that *emit* this format

| PM | semver range | Default? | How to opt in |
|----|--------------|:--------:|---------------|
| yarn | `>=4.17.1` | ✓ | stable Yarn 4.17.1 bumped the marker to 10 |

Originally spotted in yarnpkg/berry's self-hosted lockfile and prettier;
stable Yarn 4.17.1 now pins the producer boundary.

### Readers — PM semvers that *install* from this format

| PM | semver range | Notes |
|----|--------------|-------|
| yarn | `>=4.17.1` | older berry refuses; the schema-version handshake is strict |

## File

Same as [yarn-berry-v4](./yarn-berry-v4.md#file).

## Sources

- [`Project.ts` at yarn 4.17.1](https://github.com/yarnpkg/berry/blob/@yarnpkg/cli/4.17.1/packages/yarnpkg-core/sources/Project.ts)
  — stable `LOCKFILE_VERSION = 10` constant.
- [`Project.ts` at yarn 4.14.1 (v9 baseline)](https://github.com/yarnpkg/berry/blob/@yarnpkg/cli/4.14.1/packages/yarnpkg-core/sources/Project.ts)
  for diff anchor.

## Conversion inputs

Same as [yarn-berry-v9](./yarn-berry-v9.md#conversion-inputs). The
patch-slot fingerprint recipe (file-backed and `~builtin<…>`),
sentinel input shape, and path-confinement rule carry over verbatim
— v10 inherits v9's rules without re-statement. The workspace
`link:` / `portal:` `::locator=…` locator-disambiguator (sister-session
canary bug #2; see `_yarn-berry-core.ts` `isLinkOrPortalResolution`)
also applies uniformly across v4–v10.

## Emit

Emit (`stringify(graph, options?)`) inherits v9's emit contract
verbatim — the shared, version-invariant yarn-berry emit contract in
[`_common.md` §1](./_common.md#1-yarn-berry-emit-invariants-version-invariant);
see [yarn-berry-v9](./yarn-berry-v9.md#emit). The only on-disk delta
from v9 is the `__metadata.version: 10` field.

## Schema sketch

Identical to v9 in the supported corpus. The bump is mechanical (a
`version: N` field). The family config remains separately owned so a future
v10 structural delta cannot alter v9 identity.

## Capabilities

Inherits v9.

## Quirks

- Brand-new in stable Yarn 4.17.1 — much of the ecosystem still writes v9.
- The bump itself is mechanical. Native measurement corrects an older corpus
  inference: `compressionLevel` is not a supported lock metadata field and is
  removed by Yarn. Keep the version-specific family config isolated.
- Real-world canary first observed at: yarnpkg/berry repo self-host,
  prettier upstream.
- **Conditional-checksum policy — `conditions ∩ optionalBuilds`, version-independent.**
  A `conditions:`-bearing locator is bare iff it stays in `optionalBuilds`: reachable
  only through optional paths **and** not a resolver source (patch source, or the
  npm-backed `@jsr/*` inner locator from `JsrResolver`). A conditioned locator on a
  required path, or a patch source (`fsevents` is always builtin-patched, so its base
  `npm:` locator is hashed even when every parent edge is optional), carries a checksum
  and enrich fills a fresh one; `@esbuild/*` (exclusively-optional, no patch) stays bare.
  Verify against each pinned native producer. See
  [`_common.md` §1.7.2](./_common.md#172-structural-checksum-gaps--entries-yarn-never-hashes).

## Degradation rules

Inherits v9. The interop matrix closes all 30 ordered pairs incident to v10
(v10 ↔ every other supported concrete format):

- v5–v9 ↔ v10 preserve the calibrated graph, conditions, and Berry zip checksum
  bytes while producer-faithfully removing `compressionLevel`; v10 → v4
  additionally drops `conditions` with
  `YARN_BERRY_V4_CONDITIONS_DROPPED`;
- every Berry ↔ non-Berry boundary omits the source-origin checksum rather
  than relabelling it (`berry-zip` is not tarball SRI), reporting
  `RECIPE_INTEGRITY_INCOMPLETE` / the corresponding structured projection
  loss and requiring artifact bytes to fill the target checksum;
- v10 → yarn-classic flattens peer virtualization, virtual identities and
  their incident edges, and cannot retain peer-declaration tarball metadata;
  patch slots, conditions, workspace metadata, and `cacheKey` are likewise
  unsupported by classic;
- npm, pnpm, and bun targets inherit their documented v9 cross-family graph
  losses (layout/rekeying, unsupported patch/condition/peer carriers), while
  conversion to v10 synthesizes only the v10 preamble and never fabricates
  missing Berry checksums.

The public best-effort path emits structured projection diagnostics for every
accepted cross-family loss. Strict conversion withholds output until all
blocking evidence/remedies are supplied.

## Fixtures

> Stable Yarn 4.17.1 is bundled as the calibrated `pm-yarn-berry-v10`
> producer. The 30-pair interop suite still synthesizes its shared fixture
> intersections from the calibrated v9 corpus by changing only the
> `version: 10` marker (per [yarn-berry-v7](./yarn-berry-v7.md) precedent).
> A separate native frozen-conversion oracle proves a Deno-projected v10
> candidate byte-stable under Yarn 4.17.1 `install --immutable`.

## Open questions

> **Open native-corpus audit.** Stable 4.17.1 confirms the v10 marker; retain a
> whole-lock corpus diff against 4.14.x to pin whether any field beyond
> `__metadata.version` changed. The shared canonical
> form in [`_common.md` §1](./_common.md#1-yarn-berry-emit-invariants-version-invariant)
> is *our* canonical form; byte-identity to stable Yarn output is a bonus, not
> a contract.

## Unknown `__metadata` keys

Pinned Yarn 4.17.1 removes an unrecognised `__metadata` subkey during a mutable
install. The same unstripped lock is rejected by `--immutable`, while the
repaired lock is accepted. `version` and `cacheKey` are the recognized metadata
fields; the pinned producer also removes the legacy-looking `compressionLevel`
subkey. Non-strict emit reports `YARN_BERRY_V10_UNKNOWN_METADATA_DROPPED` with
the full `__metadata.<key>` path; strict emit fails closed.
