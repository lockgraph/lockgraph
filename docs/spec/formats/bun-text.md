# `bun-text` — bun `bun.lock`

> Status: stable (adapter + round-trip tested; two lockfile generations, both pinned).
> Updated: 2026-09-03
> Provenance: Official (since Bun 1.2).

**Primary bun target** — audit-friendly, human-readable; all bun-related
work in v1 starts and stays here.

## Compatibility

### Writers — PM semvers that *emit* this format

| PM | semver range | Default? | How to opt in |
|----|--------------|:--------:|---------------|
| bun | `>=1.2 <1.4` | ✓ | text default since 1.2 |
| bun | `>=1.4` | – | only onto an EXISTING v1 lock, which it leaves at `1`; a NEW lock is [`bun-text-v2`](./bun-text-v2.md) |
| bun | `>=1.1 <1.2` | – | `bun install --save-text-lockfile` (verify exact minor of intro) |

### Readers — PM semvers that *install* from this format

| PM | semver range | Notes |
|----|--------------|-------|
| bun | `>=1.1` | every released text reader accepts generation 1, 1.4 included |

## File

- **Filename:** `bun.lock`
- **Encoding:** UTF-8, JSONC-flavoured (allows trailing commas + comments).
  Indented two spaces.
- **Sibling files:** none required. Legacy binary `bun.lockb` is not a
  registered format, parser, writer, or detector in lockgraph; migrate it with
  bun's own tooling before using this adapter. See
  [`bun-binary.md`](./bun-binary.md).

## Sources

- [Bun docs — Lockfile](https://bun.com/docs/pm/lockfile)
  — current schema reference for `bun.lock`.
- [Bun blog — Bun's new text-based lockfile](https://bun.com/blog/bun-lock-text-lockfile)
  — narrative for the introduction: text format added in Bun 1.1.39
  via `--save-text-lockfile`, became default in 1.2.
- [`src/install/lockfile.zig` on main](https://github.com/oven-sh/bun/blob/main/src/install/lockfile.zig)
  — `text_lockfile_version: TextLockfile.Version = TextLockfile.Version.current;` defines the writer pin.

## Schema sketch

```jsonc
{
  "lockfileVersion": 1,
  "workspaces": {
    "": { "name": "<root>", "dependencies": {...} },
    "packages/app": { "name": "@scope/app", "dependencies": {...} }
  },
  "overrides": { "lodash": "4.17.21", "@types/node": "20.0.0" },
  "packages": {
    "foo": ["foo@1.0.3", "", { /* inner deps */ }, "<integrity>"],
    "react": ["react@18.0.0", "", { ... }, "sha512-…"],
    "@scope/app": ["@scope/app@workspace:packages/app"]
  },
  "patchedDependencies": { "foo@1.0.3": "patches/foo.patch" },
  "trustedDependencies": ["esbuild"]
}
```

Each `packages[name]` entry is a positional array — bun-specific encoding.
The regular-package tuple is **4 slots, `[id, "", inner, integrity]`**:
`id` (`<name>@<version>`), an **always-empty registry-marker slot** (`""`
for the default npm registry), the `inner` deps object
(`dependencies` / `optionalDependencies` / `peerDependencies` / `bin` / `os`
/ `cpu`), then the SRI `integrity` string. A workspace member is the
degenerate **1-slot** tuple `["<name>@workspace:<path>"]`. Trailing slots are
NOT freely omissible the way an early `[id, integrity, deps, extras]` reading
implied — `integrity` lives in slot **3** (0-based), not slot 1. Top-level
block order through `packages` (`lockfileVersion`, `workspaces`,
`overrides`, `packages`) is corroborated by the real-world corpus fixtures;
the trailing pair (`patchedDependencies`, `trustedDependencies`) and their
position after `packages` are adapter-chosen and not yet corroborated against
a real bun emit that carries them — confirm against bun's `lockfile.zig`
writer before relying on byte-exact same-PM round-trip of those two blocks.

## Capabilities

| Feature | Supported | Notes |
|---------|:---------:|-------|
| Workspaces                                | ✓ | top-level `workspaces` map keyed by path |
| Workspace protocol (`workspace:*`)        | ✓ | first-class |
| Peer-dep virtualization                   | ✗ | peers are **declarative** in each package's inner `peerDependencies` — no peer-virt nodes on disk; inbound `peerContext` flattens on emit (`BUN_TEXT_PEER_VIRT_FLATTENED`) |
| `npm:` alias                              | ✓ | |
| `git` / `github` protocols                | ✓ | |
| `file` / `link` / `portal`                | ~ | `file:`, `link:` supported; `portal:` is yarn-only |
| `patch:` protocol                         | ~ | top-level `patchedDependencies` map round-trips verbatim; the per-node `Node.patch` recipe form is NOT projected to it (drops with `RECIPE_FEATURE_DROPPED`) |
| Integrity hashes                          | ✓ | sha-family in positional slot **3** (`[id, "", inner, integrity]`), read/emitted as the SRI multiset (`_common.md` §3) |
| `dev` / `optional` / `peer` separation    | ✓ | manifest mirror in `workspaces`; peer-deps are declarative (no peer-virt nodes) |
| Bundled deps                              | ✗ | |
| Overrides / resolutions                   | ✓ | top-level `overrides` block (npm-shaped, flat `{name: target}` or nested); round-trips verbatim, accepts caller `StringifyOptions.overrides` (audit-fix write path), and surfaces canonically via `overridesOf(graph)` |
| `trustedDependencies`                     | ✓ | top-level allowlist; round-trips verbatim (load-bearing for reproducibility) |

## Integrity

The model is the shared [`_common.md` §3 integrity model](./_common.md#3-integrity-model);
this is only how bun-text *carries* it.

- Integrity is the **4th slot (index 3)** of a regular-package positional
  tuple: `["<name>@<version>", "", <inner>, "<integrity>"]`. The slot is a
  Subresource-Integrity string (normally `sha512-<base64>`), parsed with
  `parseSri(…, 'sri')` and emitted with `emitSri` (`bun-text.ts`). The hash
  is of the **tarball** bytes (`origin: 'sri'`).
- The slot is **read only when present and non-empty** (`raw[3]` is a
  string of length > 0); a workspace member is the degenerate 1-slot tuple
  and carries no integrity. On emit, a node with no tarball-origin hash
  writes `""` in slot 3 (the slot is positional and not freely omissible).
- A space-joined multi-algorithm SRI is preserved in full as a multiset
  ([`_common.md` §3.5](./_common.md#35-the-multi-hash-case-and-the-equivalence-rule)).

## Conversion inputs

| Operation | Option       | Required?      | Effect when omitted |
|-----------|--------------|:--------------:|---------------------|
| Parse     | —            | none           | top-level `workspaces` block enumerates members |
| Stringify | `overrides`  | optional       | caller-supplied canonical `OverrideConstraint[]` projected into the top-level `overrides` block (npm grammar). Omit ⇒ the verbatim parse-time block is re-emitted; explicit `[]` ⇒ suppress it. The audit-fix write path. |

## Quirks

- Positional array encoding for regular `packages` entries — **4 slots,
  `[id, "", inner, integrity]`**: `id` = `<name>@<version>`; slot 1 is an
  always-empty registry-marker (`""` = default npm registry); `inner` is the
  deps/`bin`/`os`/`cpu` object; `integrity` is the SRI string. Workspace
  members are the 1-slot tuple `["<name>@workspace:<path>"]`. The `integrity`
  hash is in slot **3**, NOT slot 1 — an earlier `[id, integrity, deps, extras]`
  reading was wrong.
- A single `<name>@<version>` may appear under multiple `packages` keys — via
  npm-alias siblings (e.g. `string-width` + `string-width-cjs`) and via
  de-hoist keys (`<consumer-path>/<dep-name>`). Parse dedups on NodeId and emits
  one tuple per `<name>@<version>`; the de-hoist scope is replayed at parse but
  collapses to the flat key on emit (lossless — the dep set is key-invariant).
- An `npm:` alias is carried by the **declared name**, never by the target. bun
  keys the dependency map, and the `packages` entry itself, under the declared
  name (`"pm-x": "npm:@yarnpkg/cli-dist@4.17.1"` alongside
  `"pm-x": ["@yarnpkg/cli-dist@4.17.1", …]`) while the tuple id slot holds the
  canonical `<name>@<version>`. That declared name is not recoverable from the
  target node, so parse retains it in `attrs.alias` whenever it differs from
  the resolved package name, and both emit paths (`workspaces` manifests and
  `packages` inner blocks) key by `attrs.alias` before falling back to the
  package name. Dropping it produces a lock whose `workspaces` key and
  `packages` key disagree, which bun rejects with
  `Failed to resolve root prod dependency` under `--frozen-lockfile`.
  Because `attrs.alias` is the 4th component of edge identity, it is also what
  lets one consumer declare the same target twice — canonically and under an
  alias, as `metro-source-map` does with
  `@babel/traverse--for-generate-function-map` — without the two declarations
  colliding as a duplicate edge at seal.
- A `packages` key is the directory bun hoists the package to, so an aliased
  dependency is keyed by its alias. When no parse-time key survives
  (cross-format projection, mutator-minted node) the emitter takes that key
  from the edges, and only when **every** incoming declaration agrees on the
  same alias — a node also reached under its canonical name needs the two
  `packages` entries bun would write, which the one-entry-per-node emit shape
  cannot express.
- A `workspaces` entry mirrors the project manifest and **omits what that
  manifest omits**. `name` is absent for a project whose package.json has no
  name, and `version` is absent for a member with no version — bun does not
  substitute a placeholder. Parse fills the canonical defaults (`''` and
  `'0.0.0'`) so the node has an identity, so emit must suppress exactly those
  two synthesized values: writing them back would ADD lines the producer never
  wrote. Suppression is identity-safe only because a reparse re-derives the
  same defaults, and it applies only when a parse-time manifest is on hand to
  prove the omission — a cross-format projection knows of no omission and emits
  both keys. Entry key order is `name`, `version`, `bin`, `dependencies`,
  `devDependencies`, `optionalDependencies`, `peerDependencies`,
  `optionalPeers`; `name` leads in every corpus entry that has one, at every
  `lockfileVersion` and `configVersion`.
- A `workspaces` entry key this adapter does not model (`bin`, `optionalPeers`,
  and whatever bun ships next) rides the same **verbatim carrier** as an unknown
  project-level key — captured at parse, merged behind the modelled output at
  emit, and restored to the position the producer wrote it in. It is
  deliberately NOT given a modelled field: a modelled field would assert the
  concept projects to other lockfiles, and `bin` has nothing to project — it
  means nothing in a `deno.lock`. Like every verbatim carrier it is same-format
  only, and each captured key is named as an adapter-state subject
  (`workspace[<path>]:<key>`) so a cross-format projection declares it as a
  loss rather than dropping it silently.
- Top-level key schedule: `lockfileVersion`, `configVersion`, `workspaces`,
  `patchedDependencies`, `trustedDependencies`, `overrides`, `packages`.
  **`packages` is last in all 173 corpus locks**; the reproducibility blocks sit
  between `workspaces` and it, never after. Both of those blocks replay in the
  order the project authored them — they are verbatim carriers, and
  `trustedDependencies` is an allowlist rather than a set to normalise, so
  sorting them would rewrite the producer's schedule rather than replay it.
- Arrays take their style from their container. A `packages` entry value is a
  positional tuple and stays inline; an array valued by any other multi-line
  object (top-level `trustedDependencies`, a workspace entry's `optionalPeers`)
  is written one element per line with the same trailing comma the surrounding
  object uses. A third form exists and is **not** reproduced: an array inside an
  INLINE object — a package's `os` / `cpu` — which bun pads on one line as
  `[ "linux", "darwin", ]`.
- A `workspaces` entry's `peerDependencies` is DATA, not graph edges — parse
  routes it to the same sidecar stash as a package inner block's peer block
  (bun models no peer-virt nodes), so no `peer` edge is left behind. The
  workspaces emit path therefore recovers it from that stash, exactly as the
  inner-block path does; a graph `peer` edge from a cross-format source takes
  precedence and the stash fills only what the graph cannot carry.
- Entries of the top-level `packages` block are separated by **one blank
  line**; no other block is. There is no blank line before the first entry or
  after the last, never two in a row, and a single-entry block is dense. The
  rule is unconditional — it is **not** a `configVersion` era. Across the
  real-world corpus every lock with two or more `packages` entries separates
  all of them, at `configVersion` absent, `0`, and `1` alike; the committed
  `lockfiles/*/bun-text.lock` fixtures, produced by an older
  `configVersion`-less bun, separate them too. The only corpus counter-example
  is a hand-authored turborepo integration fixture, not producer output —
  identifiable by its 3-slot multi-line `packages` tuples and its complete
  absence of trailing commas, neither of which bun emits.
- `lockfileVersion` for bun-text refers to bun's own text-format generation,
  unrelated to the npm integer of the same name — which is why bun's `2` and
  npm-2's `2` collide on detection (see below). Real-world `bun.lock` files also
  carry a sibling `configVersion` integer the adapter preserves but does not read.
- **This id is generation 1 only.** Generation 2 is its own format,
  [`bun-text-v2`](./bun-text-v2.md) — the id is what selects the integer, so each
  parses only its own and emits only its own, and a graph moves between them by naming
  the target. Early text locks with `lockfileVersion: 0` exist in released Bun builds
  but are not supported and fail closed.
- `lockfileVersion: 2` shipped in **bun 1.4.0**. Measured against 1.3.14 and 1.4.0
  on a project exercising workspaces, an alias, `overrides`, optional and peer
  dependencies with `peerDependenciesMeta`, `trustedDependencies` and the
  `workspace:` protocol, **the two generations are byte-identical apart from that
  integer** — the schema did not change. The generations coexist rather than
  supersede:

  | | `--frozen-lockfile` | write-enabled |
  |---|---|---|
  | bun 1.3.14 reading a v2 lock | **refused** | rewrites it down to `1` |
  | bun 1.4.0 reading a v1 lock | accepted | leaves it at `1` |

  So a v1 lock stays v1 under bun 1.4 and only a newly created lock is a 2.
  Emitting `1` for a v2 source would be a rewrite the producer never performs,
  which is why the version rides the sidecar. A graph with no bun provenance
  still defaults to `1`.
- **Detection collides with npm-2 from bun 1.4 on**, because npm has used the
  integer 2 since npm 7. The `workspaces` key does not separate them by text
  either: npm carries the same key NESTED inside `packages[""]` in its object
  form (`{"packages": ["apps/*"]}`), which six real npm locks in the scraped
  corpus do. Only the TOP-LEVEL position distinguishes the families, so `check`
  parses and looks there. A document that carries all three bun markers but does
  not parse keeps the claim, so a malformed bun lock still reaches bun's own
  error rather than going undetected.
- JSONC parser must tolerate trailing commas and line comments.
- The empty-string workspace key (`""`) is the root project.
- Project-root authority comes only from a parse-captured native root or an
  explicit node with `workspacePath: ""`. A sole DAG root remains a regular
  package tuple; rootless input receives an empty neutral workspace manifest.
- A workspace manifest or regular-package inner `dependencies`,
  `devDependencies`, or `optionalDependencies` member that cannot bind to a
  package tuple is retained as a structured `BUN_TEXT_UNRESOLVED_DEP` fact
  (owner, kind, name, range, and `workspace` / `package` channel). Stringify
  merges it back into the same native block; graph-derived bound edges win on
  collision. This carrier remains authoritative after a mutation disables
  exact tuple replay. If target output reparse loses the fact, strict output
  rejects `COMPLETENESS_OUTPUT_UNRESOLVED_DECLARATION_DROPPED` as irreducible;
  registry evidence is not a preservation remedy.
- `overrides` is bun's forced-resolution mechanism — the npm/bun analog of yarn
  `resolutions`, and the channel an audit-fix uses to pin a transitive
  vulnerable dependency onto a safe version. The block is **npm-shaped** (flat
  `{name: target}` in the common case, nested for parent-scoped overrides) and
  round-trips **verbatim** (preferred carrier; the canonical name-chain drops
  npm `pkg@version`-key qualifiers). It is captured canonically
  at parse for cross-PM reads (`getBunOverridesCanonical` → `overridesOf`).
- `trustedDependencies` controls postinstall execution — load-bearing for
  reproducibility, even though it's not strictly resolution data. Round-trips
  verbatim; emitted sorted.
- `patchedDependencies` (a `<name>@<version>` → patch-path map) round-trips
  verbatim. It is distinct from the per-node `Node.patch` recipe form, which
  bun-text cannot encode and drops with `RECIPE_FEATURE_DROPPED`.
- Integrity (positional slot **3**) is preserved as a multi-hash multiset —
  `sha1`, `sha256`, `sha384`, `sha512`, and every member of a space-joined SRI —
  not collapsed to sha512-only. The shared integrity model (verbatim multiset,
  per-hash origin tags, omit-never-fabricate emit) is in
  [`_common.md` §3](./_common.md#3-integrity-model); bun-text reads and
  emits SRI-origin hashes from this single positional slot.

## Degradation rules

| Feature | Action |
|---------|--------|
| `trustedDependencies` → npm-*, yarn-*, pnpm-* | **strip** (it is bun-only; survives only a bun→bun round-trip via the sidecar) |
| `overrides` → yarn-* | **strip** with `INTEROP_OVERRIDE_NOT_PROJECTED` (yarn carries no lockfile overrides block) — same as every other source |
| `overrides` → npm-2/3/4, pnpm | **project** through the canonical `OverrideConstraint[]` (npm-shaped block ⇒ npm/pnpm projection) |
| `patchedDependencies` → non-bun | **strip** (bun-only patch-map shape) |
| Per-node `Node.patch` (recipe form) → bun-text | **drop** with `RECIPE_FEATURE_DROPPED` (no per-node patch protocol; only the top-level `patchedDependencies` map) |
| Positional encoding | not user-visible — internal only |

For an npm-4 source, the native raw-SRI / path patch carrier and manifest
extension fingerprints / applied provenance have no bun-text carrier.
Additionally, bun-text does not encode the npm root workspace version. Its flat
dependency index cannot preserve edges to both root `is-number@7` and nested
`is-number@6` without source-native de-hoist keys, so the root edge would
otherwise resolve to v6. Non-strict conversion reports every carrier,
root-identity, and edge-target loss; strict projection rejects.

For a yarn-berry-v10 source, bun-text cannot retain Berry peer virtualization,
conditions, patch identity, workspace node identity, native resolution, or
Berry zip checksum payload. Inbound bun → v10 preserves the representable graph
but synthesizes only the v10 preamble and omits tarball SRI rather than
fabricating a Berry checksum. The best-effort path reports the projection loss;
strict projection requires the advertised remedies.

The yarn-berry-v7 pair is also contract-backed. v7 → bun-text rekeys the root
workspace id and loses canonical resolution URLs plus cross-sidecar tarball
metadata. bun-text → v7 preserves the representable graph, synthesizes only the
v7 preamble, and omits tarball SRI rather than fabricating a Berry checksum.

## Fixtures

The per-case `bun-text` locks
(`simple`, `deps-with-scopes`, `peers-basic`, `peers-multi`,
`workspaces-basic`, `workspace-cross-refs`, `yarn-crlf`). Real-world corpus:
`oven-sh/bun@main` (carries a
live `overrides` + `configVersion`) and `honojs-hono-main-*/bun.lock`. The
`overrides` / `trustedDependencies` / `patchedDependencies` round-trip is
covered by the adapter's unit suite.

## Open questions

> **Resolved (partial):** bun encodes peer-deps **declaratively** in each
> package's inner block (`peerDependencies`), NOT as virtualized peer-context
> nodes the way pnpm/yarn-berry do. The adapter therefore parses no peer-virt
> nodes and flattens any inbound `peerContext` on emit with
> `BUN_TEXT_PEER_VIRT_FLATTENED`. Whether bun's installer materializes a
> peer-specific dedup that a richer reader could recover is still open, but the
> on-disk `bun.lock` carries no peer-virtualization marker to recover from.
> **Open:** the always-empty slot-1 registry marker (`""`) — does bun ever
> populate it for a non-default registry? No sample observed yet; the adapter
> emits `""` unconditionally.
>
> **Queued schema work:** add a compatibility reader for released v0 text
> locks, and add a distinct v2 adapter only after the Rust rewrite ships and a
> released native oracle can pin its bytes. Do not widen the v1 detector.

## Unknown top-level extension keys

Pinned Bun 1.3.14 accepts and byte-preserves producer-extension values at the
project root. The adapter deep-clones such values, replays them only for
`bun-text`, and preserves their source key placement; modeled fields always win
on collision. Detached-state and cross-format losses name every
`top-level:<key>` and strict conversion fails closed.
