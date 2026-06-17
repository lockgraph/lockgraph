# `yarn-berry-v3` — yarn berry `yarn.lock` (`__metadata.version: 3`)

> Status: deferred (frontier — RC-only schema, no adapter; recorded for recognition only).
> Updated: 2026-06-16
> Provenance: **Source-only**.

Pre-release-only schema. Defaulted in yarn `2.0.0-rc.4` … `2.0.0-rc.17`
(roughly 13 RC iterations); never shipped in a stable release.
Documented as a knowledge-base artefact: yarn 2.0 alphas in the wild
may carry it, and any tool reading "every yarn lockfile ever" needs to
recognise it.

Out of scope for v1 of this library. Inclusion in the spec is purely
to record the schema's existence and frame the eventual `__metadata.
version` reader.

## Compatibility

### Writers — PM semvers that *emit* this format

| PM | semver range | Default? | How to opt in |
|----|--------------|:--------:|---------------|
| yarn | `>=2.0.0-rc.4 <2.0.0-rc.20` | ✓ | pre-release only; never reached a stable yarn release |

### Readers — PM semvers that *install* from this format

| PM | semver range | Notes |
|----|--------------|-------|
| yarn | `>=2` | berry's reader auto-migrates older `__metadata.version` values |

## File

Same as [yarn-berry-v4](./yarn-berry-v4.md#file).

## Sources

- [`Project.ts` at yarn 2.0.0-rc.10](https://github.com/yarnpkg/berry/blob/@yarnpkg/cli/2.0.0-rc.10/packages/yarnpkg-core/sources/Project.ts)
  — `const LOCKFILE_VERSION = 3;` mid-RC tag.
- [`Project.ts` at yarn 2.0.0-rc.4 (first appearance)](https://github.com/yarnpkg/berry/blob/@yarnpkg/cli/2.0.0-rc.4/packages/yarnpkg-core/sources/Project.ts)
  vs [2.0.0-rc.20 (post-bump to v4)](https://github.com/yarnpkg/berry/blob/@yarnpkg/cli/2.0.0-rc.20/packages/yarnpkg-core/sources/Project.ts)
  — bracket the v3 window.
- [`collab/research/lockfile-schema-history-yarn.md`](../../collab/research/lockfile-schema-history-yarn.md).

## Schema sketch

> **TBD.** Likely close to [yarn-berry-v4](./yarn-berry-v4.md), since
> the `3 → 4` bump came late in the same RC cycle. The `__metadata`
> object carries a `version: 3` field. cacheKey may be absent or
> earlier than the values seen in stable releases.

## Capabilities

> **TBD.** Treat as a subset of v4 until probing confirms otherwise.

## Conversion inputs

Same as [yarn-berry-v4](./yarn-berry-v4.md#conversion-inputs).

## Quirks

- **No stable release defaulted to v3.** Anything written to disk with
  this schema is a pre-2.0 RC artefact; expect very few such lockfiles
  in the wild.
- The `__metadata.version` constant first *appeared* with value `3`
  somewhere between RC.3 and RC.4; earlier RC tags either lack the
  constant entirely or live in a different file path.

## Degradation rules

Inherits v4. When (if ever) we read a v3 lockfile and emit a modern
target, expect the same loss profile as v4 emission, plus any v3-only
fields that prove not to round-trip.

## Fixtures

> **TBD.** Acquire by checking out `@yarnpkg/cli/2.0.0-rc.10` (or any
> rc.4–rc.17), running it against a small case template, and capturing
> the produced `yarn.lock`. Out of scope for v1.

## Open questions

> **Open:** is v3's grammar materially different from v4, or is the
> only diff the version-field number? If the latter, parser / formatter
> can share with v4 with a small switch.
