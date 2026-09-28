# `bun-text-v2` — bun `bun.lock` (lockfileVersion 2)

> Status: stable (adapter + round-trip tested against bun 1.4.0 producer output; frozen oracle pinned at 1.4.2).
> Updated: 2026-09-28
> Provenance: **Official** (bun 1.4.0).

The second bun lockfile generation. **The schema is identical to
[`bun-text`](./bun-text.md)** — measured against bun 1.3.14 and 1.4.0 on a project
exercising workspaces, an alias, `overrides`, optional and peer dependencies with
`peerDependenciesMeta`, `trustedDependencies` and the `workspace:` protocol, the two
emit byte-identical locks apart from the `lockfileVersion` integer.

## Why it is a separate format id

Because a caller has to be able to **ask** for a generation. Converting into bun from
another family has no bun source to inherit one from, so with a single id every
cross-family conversion would produce a `1` forever and a bun-1.4 user could never get
the lock their own bun writes. That is the same reason `npm-1..4`, `pnpm-v5/v6/v9` and
`deno-v2..v5` are each their own id.

The pair is asymmetric on purpose: `bun-text` keeps its published name and means
generation 1, rather than being renamed to `bun-text-v1` and breaking every consumer
that already targets it.

## Compatibility

### Writers

| PM | semver range | Default? | Notes |
|----|--------------|:--------:|-------|
| bun | `>=1.4` | ✓ | for a NEW lock; an existing `1` is left at `1` |

### Readers

| PM | semver range | Notes |
|----|--------------|-------|
| bun | `>=1.4` | `<1.4` **refuses** it — `error: Error loading lockfile: UnknownLockfileVersion` |

The generations coexist rather than supersede:

| | `--frozen-lockfile` | write-enabled |
|---|---|---|
| bun 1.3.14 reading a v2 lock | **refused** | rewrites it down to `1` |
| bun 1.4.0 reading a v1 lock | accepted | leaves it at `1` |

## Detection

`lockfileVersion: 2` is **also npm-2's** integer, and the `workspaces` key does not
separate them by text either: npm carries the same key nested inside `packages[""]` in
its object form (`{"packages": ["apps/*"]}`), which six real npm locks in the scraped
corpus do. Only the TOP-LEVEL position distinguishes the families, so `check` parses and
looks there; a document carrying all three bun markers that does not parse keeps the
claim, so a malformed bun lock still reaches bun's own error rather than going
undetected. Both bun generations precede the npm family in `DETECTION_ORDER`.

## Everything else

Grammar, key schedule, positional `packages` tuples, integrity model, quirks,
degradation rules and conversion inputs are [`bun-text`](./bun-text.md)'s, unchanged.
This document records only what differs.

## Pinned oracle

`pm-bun-v2` = `bun@1.4.0`, alongside `bun` = `1.3.14` which writes generation 1 and is
the binary that exercises the refusal of a `2`.
