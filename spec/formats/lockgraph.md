# `lockgraph` — native graph serialization

> Status: preview.
> Provenance: **Native** — this project owns the format end-to-end (concept,
> grammar, encoding). It is **not** a package-manager lockfile; it is a
> portable, versioned serialization of this library's L2 [Graph](#vocabulary).

`lockgraph` is a sibling of the PM adapters (`yarn-berry-*`, `npm-*`,
`pnpm-*`, `bun-text`) on the same `parse` / `stringify` / `check` / `detect`
plumbing, so `convert(x, { to: 'lockgraph' })` and back work through the
existing converter. Unlike those adapters — which serialize the Graph into a
*foreign* PM schema and therefore round-trip only up to that schema's
expressivity — `lockgraph` serializes the canonical model itself.

## Defining property — graph identity

```
parse(serialize(g)) ≡ g
```

For every Graph `g`, the reconstruction `g2 = parse(serialize(g))` satisfies:

- `g.diff(g2)` is empty on **all** axes (`addedNodes`, `removedNodes`,
  `changedNodes`, `addedEdges`, `removedEdges`) — and so is `g2.diff(g)`;
- `g.tarballs()` and `g2.tarballs()` iterate **byte-equal** (same keys in the
  same canonical order, same `TarballPayload` on each);
- a re-serialization `serialize(g2)` is **byte-identical** to `serialize(g)`
  (the BODY is canonical; see [§ Determinism](#determinism-vs-generatedat)).

This is achieved by storing the canonical model's *inputs* verbatim and letting
the graph [seal](#vocabulary) re-derive the secondary indices (by-name, roots,
incoming edges, NodeId↔peerContext coherence) and the seal-derived diagnostics —
rather than serializing those derived facts. The format never trusts a stored
NodeId blindly: it re-derives each NodeId from `(name, version, peerContext,
patch)` exactly as the model does, so a tampered identity fails the seal at
re-build.

`Lockfile = Graph` (the public alias); `lockgraph` is the only format whose
round-trip is graph-*identity* rather than graph-*equivalence-up-to-target*.

## Compatibility

This format has no package-manager writers or readers — it is produced and
consumed only by this library (`>= the version that introduced #101`). There is
no “install from a `lockgraph` file” story; it is an interchange / snapshot /
diff substrate, not an installable lockfile.

## File

- **Filename.** None mandated. By convention `*.lockgraph`. Detection is by
  content, not name (see [§ Detection](#detection)).
- **Encoding.** UTF-8, line-oriented. Default line ending `lf`; `crlf` is opt-in
  via `stringify(g, { lineEnding: 'crlf' })` and is a pure style choice — the
  seal is computed over the LF-normalized BODY, so a CRLF file round-trips
  identically.
- **Trailing newline.** Always present.

## Three regions

A `lockgraph` document is exactly three regions, in order:

```
<HEADER>
---
<BODY>
---
seal sha256 <hex>
```

| Region | Hashed? | Deterministic? | Role |
|--------|:-------:|:--------------:|------|
| HEADER | no  | no  | volatile provenance — magic, versions, `generatedAt`, generator, optional source |
| BODY   | —   | yes | the canonical, byte-stable serialization of the graph |
| SEAL   | —   | yes | `sha256` over the canonical BODY ⊕ the schema major |

The two `---` lines are the region terminators. The HEADER's `generatedAt` is
the only part that varies between two serializations of the same graph; it lives
**outside** the seal, so the BODY and the seal are byte-identical for
structurally-equal graphs.

### HEADER

```
@lockgraph <envelope-major>
schema <major>.<minor>
generatedAt <RFC-3339 UTC, second precision, 'Z'>
generator <id>
source <format> <digest>            # optional
```

- **`@lockgraph <envelope-major>`** — the magic discriminant; MUST be the first
  token of the document (see [§ Detection](#detection)). `envelope-major` is the
  **container** version (region layout, escaping, seal algorithm), bumped only
  when the on-the-wire framing changes. v1 today.
- **`schema <major>.<minor>`** — the **model** version (see
  [§ Two-version scheme](#two-version-scheme)). v1.0 today.
- **`generatedAt`** — provenance of *this* serialization, RFC-3339 UTC with
  second precision and a trailing `Z` (e.g. `2026-06-07T12:00:00Z`). **Outside**
  the seal. `stringify` defaults it to “now”; pass `{ generatedAt }` to pin it
  (makes the whole document byte-stable, useful for golden tests).
- **`generator`** — the producing library id (`@antongolub/lockfile@<version>`).
  Provenance only.
- **`source <format> <digest>`** — *optional*; the format the graph was parsed
  from and an optional digest of that source. Pure attribution, ignored on
  parse. `digest` is `-` when absent.
- **Reserved (documented, unpopulated): `resolution registrySnapshot …`** — a
  slot for a future registry-snapshot provenance line. v1 neither emits nor reads
  it.

Unknown HEADER lines are ignored on parse (they are provenance, not graph
facts), which is what lets the schema MINOR grow additively.

### BODY

The BODY is **interned tables + a sparse adjacency**, every collection
content-sorted so two structurally-equal graphs produce byte-identical BODYs
regardless of how they were built (parse, modify, snapshot-restore). Sections
appear in this fixed order, each introduced by a one-letter tag and a count:

```
S <count>     # strings[]      interned string pool (content-sorted)
…
R <count>     # registries[]   interned registry/cacheKey pool (content-sorted)
…
P <count>     # packages[]     one row per TarballKey
…
N <count>     # nodes[]        one row per node INSTANCE
…
E <count>     # edges          sparse hex adjacency (one line per source w/ out-edges)
…
H <ref>       # layoutHints    '-' or a strings[] ref to canonical-JSON hints
D <count>     # diagnostics    adapter-emitted diagnostics (strings[] refs)
…
```

#### `strings[]` and `registries[]` — the interned tables

`strings[]` is the interned pool for **every value that can contain the `:`
delimiter** (git/file/patch locators, ranges, the per-node verbatim resolution
sidecar, peerContext NodeIds, package versions, the canonical-JSON metadata
blobs) **and** any repeated token. Entries are content-sorted; everything else
references a string by its **decimal index**. The sort is what makes the table
byte-identical across structurally-equal graphs irrespective of insertion order.

`registries[]` is a separate interned pool for **registry/source hosts and the
yarn-berry `cacheKey`** — few distinct values, many references (a proprietary
host, `npmjs.org`, `10c0`), so factoring them into their own tiny index space is
a large win. Same content-sort discipline.

Both tables escape only the four bytes that affect line/field framing inside a
one-per-line value: `\\` → `\\\\`, newline → `\n`, CR → `\r`, tab → `\t`. The
`:` is **never** escaped — interned values are addressed by index, never split
on `:`.

#### `packages[]` — one row per TarballKey

`TarballKey` is the NodeId stripped of peer-context, plus the ordered
disambiguator slots ([§4 of `_common.md`](./_common.md#4-reserved-vocabulary)).
Two slots exist today, emitted in the canonical `cmpStr`-sorted order
`…+patch=…+src=…`: `+patch=` (the patch fingerprint) and `+src=` (the ADR-0032
16-hex **source discriminator** for non-registry sources — git / non-registry
tarball host / unknown — that share a `name@version` with a registry copy).
Cross-format artefact metadata (`TarballPayload`) is keyed here **once** —
peer-virtual siblings that share `name@version` (+ slot inputs) share one package
row.

```
<name> : <verref> : <patch> : <src> : <digest> : <origin> : <ckref> : <res> : <metaref>
```

| Column | Meaning |
|--------|---------|
| `name`     | package name, **inline** (npm/yarn/pnpm names are `:`- and `+`-free by the registry name grammar) |
| `verref`   | `strings[]` index of the version — interned because a version is **not** `:`-free in real locks (a `file:` / `github:` / `https:` locator lands in the version position for non-registry resolutions) |
| `patch`    | the `+patch=` slot value (canonical 128-hex or the `unresolved-<64hex>` sentinel — both `:`- and `+`-free), **inline**; `-` when none |
| `src`      | the `+src=` slot value — the ADR-0032 16-lowercase-hex **source discriminator** ([§4 of `_common.md`](./_common.md#4-reserved-vocabulary); `:`- and `+`-free), **inline**; `-` for the registry / workspace majority (no discriminator) |
| `digest`   | a **single** integrity hash, **inline hex** — the “hash lives here once”; `-` when absent or when the integrity is multi-hash (then it moves to `metaref`) |
| `origin`   | one-char origin of `digest`: `s` sri · `z` berry-zip · `u` url-fragment · `r` registry · `c` recomputed; `-` when no `digest` |
| `ckref`    | `registries[]` index of `berryChecksumCacheKey` (interned — `"10"`/`"10c0"` repeat thousands of times); `-` when none |
| `res`      | resolution-canonical: `-` none · `=` the *derived* npmjs tarball URL (reconstructed from `name`+`version`) · a `strings[]` index of the canonical-JSON resolution for any other shape |
| `metaref`  | `strings[]` index of the canonical-JSON **residual** payload — every `TarballPayload` field NOT captured by the dedicated columns above (e.g. `bin`, `engines`, `license`, `funding`, `cpu`/`os`/`libc`, a multi-hash or non-sha512 integrity); `-` when empty |

The `digest`/`origin` columns capture the dominant case — a single `sha512`
integrity hash — as a bare hex token; the algorithm is `sha512` by convention,
so a non-`sha512` or multi-hash integrity routes to `metaref` verbatim
(preserving the full multiset with origin tags per
[§3 of `_common.md`](./_common.md#3-integrity-model)). The `=` sentinels (and the
per-node one below) reclaim the most repetitive derivable strings — the npmjs
registry URL and the `<name>@npm:<version>` locator — at zero storage, guarded by
an **exact** string compare so any divergence simply falls back to verbatim
storage with no fidelity risk.

#### `nodes[]` — one row per instance

A node is a **package instance**, not a package version: peer-virtual siblings
(same `name@version`, different peer context) are **separate** node rows pointing
at the **same** package row.

```
<pkgref> : <peerref> : <wsref> : <res>
```

| Column | Meaning |
|--------|---------|
| `pkgref`   | the `packages[]` row index this instance resolves to (the join carrying name/version/patch/src) |
| `peerref`  | `-` when no peers, else a `strings[]` index of the canonical-JSON peerContext (a list of NodeId strings) |
| `wsref`    | `-` for a non-workspace node, else a `strings[]` index of `workspacePath` (the empty string `''` is the root workspace — a valid, distinct value) |
| `res`      | the verbatim per-instance `Node.resolution` sidecar: `-` none · `=` equals the derived `<name>@npm:<version>` · a `strings[]` index otherwise |

#### `edges` — sparse hex adjacency

The adjacency matrix, stored **sparsely**: one line per source node that has
outgoing edges (sources with none emit nothing), the source addressed by its
**hexadecimal** node index. Neighbors are comma-joined; each neighbor's fields
are `/`-joined:

```
<srcHex> : <dstHex>/<kind>/<rangeref>/<aliasref>/<flags>/<wsrangeref> , …
```

| Field | Meaning |
|-------|---------|
| `dstHex`     | target node index, hex |
| `kind`       | edge-kind enum char: `d` dep · `v` dev · `o` optional · `p` peer · `b` bundled |
| `rangeref`   | `-` or a `strings[]` index of `EdgeAttrs.range` |
| `aliasref`   | `-` or a `strings[]` index of `EdgeAttrs.alias` (npm-alias descriptors; **participates in edge identity** per [§4 of `_common.md`](./_common.md#4-reserved-vocabulary)) |
| `flags`      | packed boolean letters — `o` `EdgeAttrs.optional`, `w` `EdgeAttrs.workspace`; `-` when none |
| `wsrangeref` | `-` or a `strings[]` index of the canonical-JSON `EdgeAttrs.workspaceRange` pair |

Edge attrs **must** round-trip in full — losing one breaks graph identity. The
node order (and thus the dense decimal index used by `nodes[]` and the hex index
used here) is the graph's canonical content-sorted node iteration, so the whole
adjacency block is a pure function of the graph.

### SEAL

```
seal sha256 <hex>
```

The seal is `sha256` over `"<schema-major>\n" + <canonical BODY>` — the schema
major is folded in (the “⊕ schema-major”) so a BODY re-interpreted under a
different model major fails verification. Lowercase hex. On parse the seal is
recomputed over the received BODY and compared; a mismatch raises
`PARSE_FAILED` (corrupt or tampered body). Because the seal covers only the
canonical BODY, the same graph serialized twice yields the **same** seal — only
`generatedAt` differs.

## Two-version scheme

Two independent version axes, each with its own forward-compat contract:

- **Envelope major** (`@lockgraph <n>`) — the container framing. A reader refuses
  an envelope major **newer** than it supports with `CAPABILITY_LACK` (the
  framing may have changed incompatibly).
- **Schema major.minor** (`schema <m>.<n>`) — the model.
  - **Additive change → MINOR bump.** Older readers ignore unknown trailing
    fields / HEADER lines and proceed (the section grammar is forward-tolerant).
  - **Breaking change → MAJOR bump.** Older readers refuse with
    `CAPABILITY_LACK`.

v1 ships envelope major `1`, schema `1.0`.

## Determinism vs `generatedAt`

The BODY is required to be byte-identical for structurally-equal graphs, yet the
HEADER records a wall-clock `generatedAt`. These are reconciled by **partitioning
volatility into the HEADER and excluding the HEADER from the seal**:

- the BODY is a pure function of the graph (every table content-sorted, every
  order derived from the model, never from input bytes or the clock);
- the seal is over the BODY only;
- `generatedAt` (and the rest of the HEADER) sits outside the seal.

So two serializations of the same graph differ **only** in the `generatedAt`
line; their BODY and seal are identical. Pin `generatedAt` to make the entire
document byte-stable.

## Canonical-JSON sub-encoding

Values too irregular for a dedicated column — `EdgeAttrs.workspaceRange`,
`LayoutHints`, each `Diagnostic`, the `ResolutionCanonical` union, and the
residual `TarballPayload` — are stored as **canonical JSON** (object keys
recursively sorted; arrays keep order, which is meaningful for the integrity
multiset and peerContext; `undefined` properties dropped) in `strings[]`. This
one chokepoint is what lets arbitrary nested shapes (including
`TarballPayload.funding: unknown`) round-trip identity-exact without a bespoke
per-field codec, while staying deterministic.

## Detection

`check(input)` is true iff the document's first token is `@lockgraph` (a leading
UTF-8 BOM is tolerated). The discriminant is unambiguous and cheap (head-only),
so `lockgraph` sits at the **top** of the converter's detect order. No PM
lockfile begins with `@lockgraph`, and a `lockgraph` document is not recognized
by any PM adapter's `check`.

## Worked example — 3 packages

A workspace root `my-app@1.0.0` with a `dep` on `lodash@4.17.21` and a `dev` dep
on `ms@2.1.3`, both registry tarballs with a yarn-berry zip-cache checksum
(`cacheKey: 10c0`). Serialized with `generatedAt` pinned (digests truncated here
for readability — the real output carries full 128-hex):

```
@lockgraph 1
schema 1.0
generatedAt 2026-06-07T12:00:00Z
generator @antongolub/lockfile@0.0.0
---
S 6

1.0.0
2.1.3
4.17.21
npm:^2.1.0
npm:^4.17.0
R 1
10c0
P 3
lodash:3:-:-:aaaa…aaaa:z:0:=:-
ms:2:-:-:bbbb…bbbb:z:0:=:-
my-app:1:-:-:-:-:-:-:-
N 3
0:-:-:=
1:-:-:=
2:-:0:-
E 1
2:0/d/5/-/-/-,1/v/4/-/-/-
H -
D 0
---
seal sha256 8850ed3a5a4343fd9bf63ad60ce16da894bf81391388dadcee2ffbfc54c20b30
```

The `seal` above is `sha256("1\n" + <BODY>)` over the BODY **exactly as printed**
(the truncated `aaaa…aaaa` / `bbbb…bbbb` digests included, LF-joined, no trailing
newline) — so the example is reproducible: hash the body bytes shown and you get
the recorded seal. A real serialization carries full 128-hex digests and so its
seal differs.

Reading it back:

- **`strings[]`** (indices 0–5): `""`, `1.0.0`, `2.1.3`, `4.17.21`,
  `npm:^2.1.0`, `npm:^4.17.0`. Index `0` is the root workspace's empty
  `workspacePath`.
- **`registries[]`** (index 0): `10c0` — the shared berry cacheKey.
- **`packages[]`**:
  - `lodash:3:…` → name `lodash`, version `strings[3]` = `4.17.21`, no patch,
    no `+src=` discriminator (a registry tarball — `src = -`), a `z` (berry-zip)
    `sha512` digest, cacheKey `registries[0]` = `10c0`, `res = =` (the npmjs URL
    `https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz`, reconstructed from
    name+version), no residual.
  - `ms:2:…` → likewise for `ms@2.1.3`.
  - `my-app:1:…` → version `strings[1]` = `1.0.0`, everything else `-` (a
    workspace node has no `+src=` discriminator and no tarball payload).
- **`nodes[]`** (dense indices 0,1,2):
  - `0:-:-:=` → package row 0 (`lodash`), no peers, not a workspace, `res = =`
    (`Node.resolution` = `lodash@npm:4.17.21`).
  - `1:-:-:=` → package row 1 (`ms`), `Node.resolution` = `ms@npm:2.1.3`.
  - `2:-:0:-` → package row 2 (`my-app`), `workspacePath` = `strings[0]` =
    `""` (root workspace), no `Node.resolution`.
- **`edges`**: `2:…` → source node 2 (`my-app`) has two out-edges:
  `0/d/5/-/-/-` = `→dep lodash` with range `strings[5]` = `npm:^4.17.0`, and
  `1/v/4/-/-/-` = `→dev ms` with range `strings[4]` = `npm:^2.1.0`.
- **`H -`** no layout hints; **`D 0`** no adapter diagnostics.
- The **seal** verifies the BODY; re-serializing yields the identical BODY +
  seal.

## Compaction

Because the interned tables collapse the repeated locator / checksum / range /
version strings and the sparse hex adjacency drops the verbose per-edge framing,
the text profile is materially smaller than the source PM lock. Measured on the
**backstage** monorepo (`yarn-berry-v8`, 4249 nodes / 4042 tarball entries):

| | raw | gzip |
|---|---:|---:|
| source `yarn.lock` | ~1747 KiB | ~464 KiB |
| `lockgraph` (text) | ~966 KiB | ~384 KiB |
| ratio (lockgraph / source) | **0.55** (≈45% smaller) | **0.83** (≈17% smaller) |

The raw win is the larger of the two — `lockgraph`'s structure is already a form
of compression (interning + ref-encoding + URL/locator derivation), so gzip has
less residual redundancy to exploit than on the verbose source. The binary
profile (reserved, below) would tighten this further.

## What round-trips graph-identical

Every model element verified to round-trip identity-exact (empty `diff`, equal
`tarballs()`, byte-stable re-serialize) on hand-built graphs **and** a diverse
real-world corpus (backstage, babel, prettier, parcel, jest, webpack, lodash,
nx, vue, supabase, angular, vscode, TypeScript, socket.io, bun, hono):

- **Integrity** — the full multi-hash multiset **with origin tags**
  (`sri` / `berry-zip` / `registry` / `recomputed` / `url-fragment`), including
  a space-joined SRI and a `berry-zip` checksum coexisting on one entry. Single
  `sha512` hashes ride the inline column; multi-hash / non-`sha512` ride the
  residual blob verbatim. (Per [§3 of `_common.md`](./_common.md#3-integrity-model);
  integrity is identity-neutral but fully preserved.)
- **`berryChecksumCacheKey`** — the per-node yarn-berry checksum prefix.
- **`peerContext`** — peer-virtualization, including nested/recursive contexts
  and pnpm-v9 hashed peer-set tokens; the NodeId is re-derived and the
  seal re-validates the peerContext↔peer-edge coherence.
- **`patch` slot** — both the canonical 128-hex form and the
  `unresolved-<64hex>` **sentinel**.
- **`+src=` source discriminator** (ADR-0032) — the 16-hex slot that keeps a
  **non-registry** node (a git fork, a non-registry-host tarball, or an unknown
  source) distinct from a registry copy that shares its `name@version`. Stored as
  its own `src` package-row column so two such siblings never collapse to one
  row, and threaded back into the re-derived NodeId/TarballKey on parse (canonical
  slot order `…+patch=…+src=…`). Verified on the yarn-berry git/github/tarball
  corpus (e.g. `is-git@6.3.1+src=…`, `is-github@6.3.1+src=…`).
- **`EdgeAttrs`** — `range`, `optional`, `workspace`, `alias` (including
  alias-distinct sibling edges to the same target), and the `workspaceRange`
  canonical pair.
- **Workspaces** — `workspacePath` (the empty-string root included). The
  canonical Node optional-field key order the yarn adapters emit — `resolution`,
  then `patch`, then `source`, then `workspacePath` — is reproduced so the
  order-sensitive (`JSON.stringify`-based) node equality in `Graph.diff` sees
  byte-identical nodes.
- **`Node.resolution`** verbatim sidecar and the canonical `ResolutionCanonical`
  union (`tarball` / `git` / `directory` / `unknown`), including `:`-containing
  locator versions (`github:…`, `file:…`, `https://codeload…`).
- **`LayoutHints`** and **adapter-emitted diagnostics**.

### Two findings worth stating

- **Seal-derived diagnostics are not persisted.** The graph seal re-derives the
  `SEAL_*` diagnostic family (e.g. `SEAL_PUBLISHED_SELF_LINK`) on every build.
  Persisting them would double-count across round-trips and break byte-stability,
  so `serialize` excludes the `SEAL_*` prefix; reconstruction replays only the
  adapter diagnostics and the seal re-appends the `SEAL_*` ones in the same
  trailing position. The final diagnostic set is identical and idempotent across
  any number of round-trips. (Diagnostics are not part of `Graph.diff` identity
  regardless — this is a fidelity nicety, made stable.)
- **Node key-order is reconstructed deliberately.** `Graph.diff` compares nodes
  by `JSON.stringify`, which is key-order-sensitive. lockgraph rebuilds each
  node's optional fields in the order the library's adapters emit (`resolution`,
  `patch`, `workspacePath`) — the only order in which any current adapter
  co-occurs more than one optional field — so the round-trip is identity-exact
  for graphs produced by **any** of this library's parsers.

Nothing in the v1 model scope was found that does **not** round-trip
graph-identical.

## Reserved (not built in v1)

Documented so v1 does not preclude them; the version slots exist for each:

- **Binary profile.** A length-prefixed binary encoding of the same BODY model
  (varint indices instead of decimal/hex text, raw digest bytes instead of hex).
  Gated by a future **envelope-major** bump.
- **L1 manifest-override section.** An optional BODY section carrying the
  declared `OverrideConstraint` set (the canonical form of npm `overrides` /
  yarn `resolutions` / pnpm `pnpm.overrides`, published
  [ADR-0025](../decisions/0025-manifest-overrides.md)). Gated by a **schema-minor**
  bump (additive).
- **L3 layout section.** An optional BODY section carrying concrete on-disk
  placement beyond today's `LayoutHints` sidecar. Gated by a **schema-minor**
  bump.
- **`resolution.registrySnapshot` HEADER slot.** Provenance of the registry
  state the graph was resolved against. HEADER-only, additive.

## Vocabulary

This spec uses the model vocabulary defined normatively in
[`_common.md` §4](./_common.md#4-reserved-vocabulary) (NodeId, peerContext,
TarballKey, Graph, edge kinds, workspaces, iteration order) and the integrity
model in [`_common.md` §3](./_common.md#3-integrity-model). The patch slot /
sentinel grammar is [`_common.md` §2](./_common.md#2-patch-slot--tarballkey-sentinel).
“Seal” is the graph's `seal()` validation+finalization step that re-derives the
secondary indices and the `SEAL_*` diagnostics.
```
