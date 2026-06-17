# `yarn-berry-v10` — yarn berry `yarn.lock` (`__metadata.version: 10`)

> Status: preview (adapter + round-trip tested; format from yarn 5 dev branch, unreleased upstream — contract may still shift before GA).
> Updated: 2026-06-16
> Provenance: **Source-only** (reverse-engineered from yarnpkg/berry dev branch).

The completeness contract — stringify, modify, enrich, optimize —
inherits from [yarn-berry-v9](./yarn-berry-v9.md): the shared,
version-invariant yarn-berry emit contract lives in
[`_common.md` §1](./_common.md#1-yarn-berry-emit-invariants-version-invariant),
and the completion phases (modify / enrich / optimize) reference
published [ADR-0023](../decisions/0023-graph-modification-and-completion.md)
(modify / enrich) and [ADR-0024](../decisions/0024-optimize-phase.md)
(optimize). This spec records only the read-side capabilities and the
single on-disk delta from v9 (`__metadata.version: 10`).

## Compatibility

### Writers — PM semvers that *emit* this format

| PM | semver range | Default? | How to opt in |
|----|--------------|:--------:|---------------|
| yarn | yarn 5 (dev branch / unreleased) | ✓ | bumped in yarnpkg/berry master ahead of yarn 5 GA |

Spotted in real-world canary against yarnpkg/berry's own self-hosted
lockfile and prettier (both consume yarn from upstream dev tags).

### Readers — PM semvers that *install* from this format

| PM | semver range | Notes |
|----|--------------|-------|
| yarn | yarn 5+ | older berry refuses; the schema-version handshake is strict |

## File

Same as [yarn-berry-v4](./yarn-berry-v4.md#file).

## Sources

- yarn 5 dev-branch `Project.ts` — `LOCKFILE_VERSION = 10` constant.
  Pin a permalink against the yarnpkg/berry master commit that bumps
  the constant once the yarn 5 release tag exists.
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

Identical to v9. The bump is mechanical (a `version: N` field) ahead
of yarn 5 GA. If yarn 5 ships a structural change, the family config
forks here without re-pointing v10 to share v9's identity.

## Capabilities

Inherits v9.

## Quirks

- Brand-new (yarn 5 dev-branch, not yet GA) — most of the ecosystem
  still writes v9. Treat as forward-compat target rather than canonical
  input.
- The bump itself is mechanical; historical evidence (yarn 4 → 6
  introduced cacheKey, yarn 4 → 8 added `compressionLevel`) suggests
  v10 may also pair with at least one structural change as yarn 5
  matures. Verify against yarn 5 release-tag `Project.ts` when GA
  ships.
- Real-world canary first observed at: yarnpkg/berry repo self-host,
  prettier upstream.

## Degradation rules

Inherits v9.

## Fixtures

> **TBD:** unproducible from the current matrix; gated on off-npm
> delivery of a yarn 5+ producer into the fixture toolchain. When
> unblocked, the canonical writer is yarn 5+. Synthetic fixtures derived
> from v9 by bumping the `version: 10` marker (per
> [yarn-berry-v7](./yarn-berry-v7.md) precedent) are admissible for
> round-trip regression coverage until a producer is wired up.

## Open questions

> **Deferred to yarn 5 GA.** What fields beyond `__metadata.version`
> actually change in the v9 → v10 transition? Diff yarn 5 release
> `Project.ts` against 4.14.x once a GA tag exists. The shared canonical
> form in [`_common.md` §1](./_common.md#1-yarn-berry-emit-invariants-version-invariant)
> is *our* canonical form; byte-identity to yarn 5 output is a bonus, not
> a contract.
