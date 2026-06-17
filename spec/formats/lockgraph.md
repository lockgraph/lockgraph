# `lockgraph` — native graph serialization

> Status: **preview** (native format; adapter + round-trip identity suite; no external readers/writers, no contract declared).
> Updated: 2026-06-16
> Provenance: **Native** — this project owns the format end-to-end (concept,
> grammar, encoding). It is **not** a package-manager lockfile; it is a
> portable, versioned serialization of this library's L2 [Graph](#vocabulary).

`lockgraph` is a sibling of the PM adapters (`yarn-berry-*`, `npm-*`,
`pnpm-*`, `bun-text`, `yarn-classic`) on the same `parse` / `stringify` /
`check` / `detect` plumbing, so `convert(x, { to: 'lockgraph' })` and back work
through the existing converter. Unlike those adapters — which serialize the
Graph into a *foreign* PM schema and therefore round-trip only up to that
schema's expressivity — `lockgraph` serializes the canonical model itself,
losslessly. It is the only format whose round-trip is graph-*identity* rather
than graph-*equivalence-up-to-target*.

> **Status — reworked format, JSON expelled everywhere.** This is a
> ground-up redesign of the `lockgraph` body: META provenance header + a
> **JSON-free GRAPH section** (registries, nodes, edges — pure identity) plus a
> separate, **severable FIDELITY section** (the `F` region — artifact
> fidelity). The previous body interleaved canonical JSON in a per-node
> `payload=` slot to carry residual artifact metadata; an interim redesign moved
> that JSON into a per-tarball `json=` escape-hatch slot. **Both are gone.** The
> residual artifact metadata is now **fully flattened** into the `F` region as
> dot-path `key=value` slots — **no nested JSON anywhere in the `F` section**,
> not even an escape hatch (only the optional `L` line still uses canonical
> JSON). The `F` region is **per-[TarballKey](#vocabulary)** — one row per distinct
> tarball, a property shared across peer-virtual siblings, not a property of the
> node — but each row is **identified by the representative (minimum) node index**
> that shares that key, not by the key string (which the node's `N` row already
> pins). The index ref mirrors how edges address nodes.
> The format is still
> **`@lockgraph 1`** and **preview**: it is published only as
> `0.0.0-snapshot.*`, has **no external readers or writers** (only this library
> produces or consumes it), and **declares no compatibility contract**. There is
> therefore no envelope/schema-major bump and no breaking-change ceremony — the
> body is reworked **in place**. The spec and the implementation
> (`src/main/ts/formats/lockgraph.ts`) are aligned; this document is normative
> for both.

## Defining property — graph identity

```
parse(serialize(g)) ≡ g
```

For every Graph `g`, the reconstruction `g2 = parse(serialize(g))` satisfies:

- `g.diff(g2)` is empty on **all** axes (`addedNodes`, `removedNodes`,
  `changedNodes`, `addedEdges`, `removedEdges`) — and so is `g2.diff(g)`;
- `g.tarballs()` and `g2.tarballs()` iterate over the **same keys in the same
  canonical order**, each carrying a **structurally-equal** (deep-equal)
  `TarballPayload`. The equality is on the payload's *values*, not its byte
  serialization: a reconstructed `TarballPayload` rebuilds its fields in the
  format's own insertion order (the `F`-row dot-path slots re-typed by the model
  schema, then the recomposed canonical `resolution`, then
  `berryChecksumCacheKey`, then `integrity` overlaid last), which need not match
  the *key insertion order* an arbitrary PM adapter chose — so the property is
  **deep-equality** (the oracle is a recursive value compare, e.g. vitest
  `toEqual`), **not** a byte-for-byte object dump. Every field — every
  `integrity` member with its origin, every `F`-section facet, the recomposed
  `resolution` — is present and value-equal.
- a re-serialization `serialize(g2)` is **byte-identical** to `serialize(g)`
  except for META's volatile `generatedAt` / `generator` lines (the GRAPH
  section **and** the `F` section are canonical; see [§ Determinism](#determinism)).
  Note this *document* byte-stability is distinct from the per-payload
  comparison above: the document bytes are canonical because every field is
  re-encoded through this format's own deterministic codec, whereas the
  in-memory `TarballPayload` object's key order is not part of identity.

This is achieved by storing the canonical model's *inputs* verbatim — the
**store-everything** posture of [§ Design rationale](#design-rationale) — and
letting the graph [seal](#vocabulary) re-derive the secondary indices (by-name,
roots, incoming edges, NodeId↔peerContext coherence) and the seal-derived
diagnostics, rather than serializing those derived facts. The format never
trusts a stored NodeId blindly: it re-derives each NodeId from
`(name, version, peerContext, patch, src)` exactly as the model does, so a
tampered identity fails the seal at re-build. **Integrity is structural**, not a
stored hash — see [§ Integrity & authenticity](#integrity--authenticity).

`Lockfile = Graph` (the public alias).

### Identity vs fidelity — the two sections

The redesign draws a hard line through the document:

| section | regions | role | in `g.diff`? |
|---------|---------|------|:------------:|
| **GRAPH** | META · `R` · `N` · `E` · `L` | **identity** — who the nodes are, how they connect, where each came from | yes (R/N/E/L are canonical and load-bearing) |
| **FIDELITY** | `F` | **fidelity** — the artifact metadata of each distinct tarball (license, engines, bin, platform constraints, funding, …) | **no** — every facet here is diff-neutral |

**The whole document is JSON-free except the optional `L` line.** The GRAPH
section's rows are pure positional/slot TSV, and the `F` section is **fully
flat** — every residual `TarballPayload` field is flattened to **dot-path
`key=value` slots** (see [§ F-row slot grammar](#f-row-slot-grammar)), with **no
nested JSON anywhere**, not even an escape-hatch slot. The single nested-value
encoding ([§ Canonical JSON](#canonical-json)) now lives **only** on the optional
`L` line. The `F` section is **severable**: cut it and the graph still parses
identity-valid; only fidelity degrades (see
[§ Two-tier degradation](#two-tier-degradation)).

## Compatibility

This format has no package-manager writers or readers — it is produced and
consumed only by this library. There is no "install from a `lockgraph` file"
story; it is an interchange / snapshot / diff substrate, not an installable
lockfile. As a preview with no external consumers, it makes **no** forward- or
backward-compatibility promise yet; `@lockgraph 1` is a magic discriminant for
detection (see [§ Detection](#detection)), not a stability contract.

## File

- **Filename.** None mandated. By convention `*.lockgraph`. Detection is by
  content, not name (see [§ Detection](#detection)).
- **Encoding.** UTF-8, line-oriented. Default line ending `lf`; `crlf` is opt-in
  via `stringify(g, { lineEnding: 'crlf' })` and is a pure style choice — the
  regions are a function of the LF-normalized model, so a CRLF file round-trips
  to the same graph.
- **Trailing newline.** Always present.

## Document layout — META + GRAPH section + FIDELITY section

A `lockgraph` document is a provenance **META** block followed by the **GRAPH**
section (three tab-separated identity regions plus the optional `L` line) and
then the **FIDELITY** section (the `F` region), in this fixed order:

```
META          # provenance — magic, versions, generatedAt, generator
R   <n>       # registries — every external source, content-sorted
N   <n>       # nodes      — one row per node INSTANCE; root workspace pinned at index 0 when one exists, else node 0 is just the canonical-sort first node
E   <n>       # edges      — one row per edge
L   <json>    # OPTIONAL single line — graph-level LayoutHints; absent when none
F   <n>       # fidelity — one row per distinct TarballKey, keyed by representative node index; the SEVERABLE fidelity section, fully-flat dot-path slots
```

| Region | Section | Deterministic? | Role |
|--------|---------|:--------------:|------|
| META | — | no  | volatile provenance — magic, schema, `generatedAt`, generator. Nothing here is hashed. |
| R    | GRAPH | yes | the registry/source table — all external origins in one place, content-sorted, referenced by index `r0`, `r1`, … |
| N    | GRAPH | yes | one row per node instance; line `k` **is** node `k`. The root workspace is pinned at index 0 **when one exists**; a rootless graph leaves node 0 as the canonical-sort first node (see [§ N — nodes](#n--nodes)). |
| E    | GRAPH | yes | one edge per row, sorted by `(src, dst, kind, alias)`. |
| L    | GRAPH | yes | **optional single line** carrying the graph's one `LayoutHints` as canonical JSON; **absent entirely** when the graph has no layout hints (see [§ L — layout hints](#l--layout-hints)). Not a counted region. |
| F    | FIDELITY | yes | one row per distinct `TarballKey`, **keyed by the representative (minimum) node index** and sorted by it; carries the artifact metadata of that tarball as **fully-flat dot-path `key=value` slots** — no nested JSON. **Severable** — see [§ F — fidelity](#f--fidelity) and [§ Two-tier degradation](#two-tier-degradation). |

The `L` line, when present, appears **after** the `E` region and **before** the
`F` region — it is the last line of the GRAPH section, not the last line of the
document.

There is **no checksum line and no seal** — see
[§ Integrity & authenticity](#integrity--authenticity) for the rationale.

### TSV encoding

The data rows of **R / N / E / F** are **tab-separated values**: fields are
joined by a **single** `\t`, with **no** padding and **no** column alignment in
the bytes. Aligning columns would require a two-pass width scan, waste bytes on
padding, and force the whole column to be re-padded the first time a long value
appears — so the bytes stay single-tab and ragged.

The region **headers** (`R <n>`, `N <n>`, `E <n>`, `F <n>`) and every **META**
line are **space-separated**, not tab-separated — they are framing, not data.

**Only the four framing bytes are escaped inside a value**, since a value may
otherwise legitimately contain spaces, `:`, `/`, `@`, `+`, `;`, `,`, etc.:

| raw byte | escape |
|---|---|
| `\` | `\\` |
| TAB | `\t` |
| LF  | `\n` |
| CR  | `\r` |

Nothing else is escaped — `:` / `/` / `@` / `;` / `,` are ordinary value bytes,
never split on at the TSV layer. (Sub-field delimiters such as `;` and `:` are
interpreted **within** a single tab-bounded cell by the column that owns it; see
[§ Integrity multiset encoding](#integrity-multiset-encoding). The `F` section
adds **one** sub-field delimiter of its own — the dot-path `.` separator inside a
slot's key — which composes with, and runs inside, this four-byte TSV escape via
a small key-segment escape; see [§ F-row slot grammar](#f-row-slot-grammar). No
new framing escape byte is introduced by this redesign.)

#### The `-` absent-sentinel and its collision-free escape

A **bare one-char `-`** is the **absent (`undefined`) sentinel** in a few
positions: the node `integrity` column (no integrity), the R `url` (no external
URL), and the edge **`descriptor`** field (no declared range). For the first two a
present value can **never** structurally be a lone `-` — an integrity member is
`<marker><algo>-<digest>`, a url is `https?://…` or a path — so the bare sentinel
is unambiguous there. (The edge `flags` and `alias` are **not** positional
columns: flags ride an **omittable cluster slot** — `o`/`w` letters, simply
absent when none, so there is no `-` placeholder — and `alias` rides the
**`alias=` slot**, present only when set; neither uses the bare sentinel. See
[§ E — edges](#e--edges).)

The **edge `descriptor` field is the exception**: it is *tri-state*
(`undefined` / `''` / any string), and `-` is a **legal value** — `-` is a valid
npm package name, so a range may itself be `-`. So this one field distinguishes
all three states explicitly:

| state | bytes in the column |
|---|---|
| **`undefined`** (absent) | `-` (the bare sentinel) |
| **`''`** (empty string) | `` (the empty field — distinct from `-`) |
| **a literal one-char `-`** | `\-` (the colliding value, backslash-escaped) |
| any other value | TSV-escaped verbatim (a `-` anywhere but a *lone* `-`, e.g. `-foo` or `a-b`, never collides and is written as-is) |

Only the **exact one-char `-`** value is escaped (to `\-`); every other value —
including ones merely *containing* a dash — is written through the ordinary TSV
escape. The parser reverses it: `-` → `undefined`, `\-` → the literal `-`, `''` →
`''`, anything else → the un-escaped value.

#### Reading it as a table — the `column -t` view

Because the bytes are ragged single-tab TSV, a human who wants **aligned**
columns runs `column` on a **single region's data rows** — *not* the whole
file, because META and the region headers are not tab-delimited and would blow
up the inferred column widths:

```sh
# the nodes table, aligned for reading (data rows only)
awk '/^N /{n=1;next} /^E /{n=0} n' app.lockgraph | column -t -s$'\t'

# the fidelity table, aligned for reading (data rows only)
awk '/^F /{f=1;next} f' app.lockgraph | column -t -s$'\t'
```

The alignment is a **view**, computed on demand by the reader; the stored form
stays compact. This is the deliberate split of [§ TSV not a table](#design-rationale):
cheap single-pass emit on the wire, alignment as a per-region `column -t` lens.

### META

Pure provenance. Space-separated lines; **nothing in META is hashed or part of
graph identity**:

```
@lockgraph 1
schema 1.0
generatedAt <RFC-3339 UTC, second precision, 'Z'>
generator @antongolub/lockfile@<version>
```

- **`@lockgraph 1`** — the magic discriminant; MUST be the first token of the
  document (see [§ Detection](#detection)). The `1` is the **format
  generation** the rest of the document is written in; in preview it is a
  discriminant, **not** a contract promise.
- **`schema 1.0`** — the model generation. Informational in preview.
- **`generatedAt`** — provenance of *this* serialization, RFC-3339 UTC with
  second precision and a trailing `Z` (e.g. `2026-06-09T12:00:00Z`).
  `stringify` defaults it to "now"; pass `{ generatedAt }` to pin it (makes the
  whole document byte-stable, useful for golden tests).
- **`generator`** — the producing library id
  (`@antongolub/lockfile@<version>`). Provenance only.

META is **pure provenance** — magic, `schema`, `generatedAt`, `generator`, and
nothing else. Unknown or absent META lines are **ignored on parse** (they are
provenance, not graph facts), so a forward-compatible producer may add lines here
without breaking older readers. There is deliberately **no** `checksum` / `seal`
line, and **no fidelity-envelope line** — the fidelity a lockgraph holds is read
directly off the `F` section (which cleanly stores the artifact metadata), not
re-summarized in META.

### R — registries (NORMATIVE)

**Every external source the graph references is listed once, here, in one
place** — a `npm` host, a git remote, a github shorthand, a tarball host, the
`workspace` pseudo-source. Rows are referenced elsewhere by index: `r0`, `r1`, …

**R is NORMATIVE, not merely a readability index.** A node's R row is **read
back on parse to recompose** its canonical tarball URL — the omitted
`payload.resolution` union and the fragment-form `nativeResolution` are pure
functions of `(R base, name, version)` (see [§ Recomposition — store facts,
derive mechanics](#recomposition--store-facts-derive-mechanics) and
[§ N — nodes](#n--nodes)). It still also earns its place for **readability**
("all sources in one place"), but it is a load-bearing input to the codec.

```
<type>\t<url>
```

| Column | Meaning |
|--------|---------|
| `type` | source class — `npm` · `git` · `github` · `tarball` · `workspace` · … (**open set**; an unknown class falls through to a verbatim label) |
| `url`  | the source locator. For an `npm`-class row it is the **registry base** — the URL with the recomposable `/<name>/-/<basename>-<version>.tgz` suffix already stripped (e.g. `https://registry.npmjs.org`), so a node's tarball URL is `<url>` + that suffix. For `workspace` it is `-` (no external URL). For a node with an `npm`-class source whose host was never recorded (a `bun-text` registry node, a hand-built graph before enrichment) the url is **`-`** ("npm-class, host unrecorded") — deliberately **not** a fabricated default host. |

Rows are **content-sorted** by `(type, url)`, so the index assignment is a pure
function of the set of sources.

**Both columns are TSV-escaped.** `type` and `url` are emitted through the
[§ TSV encoding](#tsv-encoding) escape (backslash / TAB / LF / CR), so a url or
type containing a control byte cannot split the R row, and the parse side
un-escapes both.

**A bad `r<idx>` reference is rejected.** On parse a node's `r<idx>` column must
match `r<non-negative-integer>` **and** resolve to an existing R row; `r999`,
`r-1`, or a non-`r` token fails with `PARSE_FAILED`.

**No canonicalization.** Two textually-different sources are two rows, even when
a human would call them "the same project": `git+https://example.com/x.git` and
`github:owner/x` are **distinct literal sources** → two entries, never
collapsed. This is the [store-everything-explicit](#design-rationale) principle
applied to provenance: the reader sees exactly what the lock declared.

### N — nodes

One row per node **instance**. A node is a *package instance*, not a package
version: peer-virtual siblings (same `name@version`, different peer context) are
**separate** rows. **Line `k` is node `k`** — the index is positional, and the
edge table addresses nodes by it.

```
<name>\t<version>\tr<regIndex>\t<integrity>[\t<slot>…]
```

| Column | Meaning |
|--------|---------|
| `name`      | package name, verbatim |
| `version`   | resolved version, verbatim (may be a `file:` / `github:` / `https:` locator for a non-registry resolution) |
| `r<regIndex>` | the [R-table](#r--registries) index of this node's source, e.g. `r0` |
| `integrity` | the **full integrity multiset with origin tags**, sub-encoded per [§ Integrity multiset encoding](#integrity-multiset-encoding); `-` when the node has no integrity (a workspace member, an un-hashed link) |

The four columns above are the **whole row** for the common registry node.
Anything else rides **trailing optional slots**, each `key=value`, present
**only when non-empty**, in this fixed order — **`ws=`, `patch=`, `src=`,
`peer=`** (a slot is simply omitted when its source field is empty). `patch=` and
`src=` are adjacent because both are **NodeId-identity** slots — they are the two
TarballKey discriminators (`+patch=` / `+src=`) folded into the node's identity.

> **The `payload=` slot is gone, and so are `ck=`/`res=`.** The previous format
> carried the residual `TarballPayload` artifact metadata as canonical JSON in a
> per-node `payload=` slot, plus dedicated N-row `ck=`/`res=` slots. All of that
> metadata is a property of the **tarball**, not the node (it is shared across
> peer-virtual siblings), so it has moved to the
> [§ F — fidelity](#f--fidelity) section, keyed by `TarballKey` and **fully
> flattened** to dot-path slots — including the PM-native `nativeResolution`. The
> one exception is `berryChecksumCacheKey`: it is **not** an `F` slot at all but
> **folds into the N-row integrity column's `berry-zip` z-member** (`z<cacheKey>/…`),
> since the cache-key is literally that checksum's prefix. The N row keeps **only**
> the identity columns, the integrity column, and the identity slots below; it
> carries **no JSON**.

| Slot | When present | Meaning |
|------|--------------|---------|
| `ws=<path>` | the node is a workspace member | `Node.workspacePath`. A **root** workspace carries `ws=` with an **empty** path (and is pinned at node 0 — see below); a non-root member carries its path, e.g. `ws=packages/a`. |
| `patch=<token>` | the node is yarn-patched | the `+patch=` fingerprint ([§2 of `_common.md`](./_common.md#2-patch-slot--tarballkey-sentinel)). Stored **explicitly** — the format does **not** look through a patch to its base; it stores the base node **and** the patch node as two distinct rows. |
| `src=<16-hex>` | `Node.source` is set | the `+src=` source discriminator (ADR-0032 — the 16-hex digest that distinguishes non-registry siblings sharing `name@version`). Stored **verbatim**, **NOT re-derived**: present exactly when `Node.source` is set, absent otherwise. Like `patch=`, it is folded into the re-derived NodeId. See [§ The `+src=` slot is stored, not re-derived](#the-src-slot-is-stored-not-re-derived). |
| `peer=<ctx>` | the node is peer-virtualised | the `peerContext` (the NodeId-list block, [§4.2 of `_common.md`](./_common.md#4-reserved-vocabulary)), e.g. `peer=(react@17.0.2)`. Drives the re-derivation of this instance's NodeId. |

> **Why `integrity` stays on the node, not in `F`.** The N row is the identity
> row, and `integrity` is deliberately kept here rather than moved to the
> per-tarball `F` section:
>
> - **`integrity`** is **per-node**, origin-tagged, and **participates in
>   identity-adjacent reconstruction** (the `u`-member carries the recomposed-URL
>   `#<sha1>` fragment of the PM-native `nativeResolution`). Berry-zip and
>   url-fragment digests are **not** registry-derivable, and a tarball's hash is
>   observed per-resolution; it stays a dedicated N-row column, **never** in `F`.
>   (It is a `TarballPayload` field in the model, but the format pins it to the
>   node because its `u`-member is entangled with `nativeResolution`.)
>
> `berryChecksumCacheKey` rides the N-row integrity column's `berry-zip` z-member
> (`z<cacheKey>/…`, see [§ Integrity multiset encoding](#integrity-multiset-encoding)).
> The PM-native `nativeResolution` (the `F` `nativeResolution=` slot for a
> non-canonical native, or the integrity `u`-member for the canonical-URL shape;
> a canonical berry npm locator is recomposed by the adapter and never stored) is
> a **per-tarball** facet and lives in the severable `F` section. The canonical
> `TarballPayload.resolution` union: a
> bare 2-key `{type:'tarball', url}` union is omitted and recomposed from the R
> row, while **any** other union (a `hostingProvider`-bearing tarball, or any
> `git` / `directory` / `unknown`) flattens under the `F` row's `resolution.*`
> dot-path slots — there is no partial split. See
> [§ The resolution split](#the-resolution-split).

**Root pinned at index 0 — when a root exists.** When the graph **has** a root
workspace (a node with the empty `workspacePath`), node 0 is **that** root, and
indices `1 … N−1` are every other node, sorted ascending by the
fully-reconstructed NodeId.

**Rootless carve-out.** A graph need **not** have a root workspace: a flat
dependency set with no importer (e.g. a `yarn-classic` `yarn.lock`) is
**rootless**. In that case node 0 is simply the **first node in the canonical
sort**, with **no** special-casing. So the precise rule is: **if** an empty-path
workspace node is present it is pinned at 0; **otherwise** node 0 is just the
canonical-sort minimum — the order, and thus every edge index, stays a pure
function of the graph either way.

Indices `1 … N−1` (or `0 … N−1` when rootless) are sorted **ascending by the
fully-reconstructed NodeId string** under `cmpStr` — i.e. the exact order
`graph.ts nodes()` yields. The "fully-reconstructed NodeId" is the *complete*
identity string `name@version[+patch=…][+src=…]` with **all** slots present,
followed by the `peerContext` suffix (`(…)…`) when the node is peer-virtualised.

> **Why `react-dom@…` precedes `react@…` (worked example).** Under `cmpStr` (a
> plain code-unit `<` comparison) the NodeIds are compared character-by-character:
> `react-dom@17.0.2` vs `react@17.0.2` first differ at the 6th character — `-`
> (U+002D) vs `@` (U+0040) — and `0x2D < 0x40`, so every `react-dom…` NodeId
> sorts **before** every `react…` NodeId.

#### The `+src=` slot is stored, not re-derived

The `+src=` source discriminator (ADR-0032 — the 16-hex `Node.source` that
distinguishes non-registry siblings sharing `name@version`) is part of the
NodeId, and it is **stored verbatim** as the N-row **`src=` slot**, present
**exactly when `Node.source` is set** and absent otherwise. On parse it is read
**directly** off the slot and fed — together with `name`, `version`, the
`patch=` token, and the `peer=` peerContext — into `serializeNodeId` to rebuild
the NodeId. The slot mirrors `patch=`: both are NodeId-identity discriminators
the format stores rather than infers.

**Why it is stored, not re-derived.** An earlier design re-derived `+src=` on
parse from the node's *canonical resolution* via
`recipe/resolution.sourceDiscriminatorOf(resolution)`, on the theory that
`Node.source` is *always* a pure function of the resolution. That is a
**derive-don't-store heuristic, and it breaks round-trip identity**: an adapter
may legitimately leave `Node.source` **undefined** on a node whose canonical
resolution **would** discriminate. pnpm-v9 is the witness — its `jsr.io` packages
and its `codeload.github.com` tarball deps carry a discriminating resolution but
**no** `Node.source`. Re-deriving from the resolution then minted a **phantom**
`+src=` on the reconstructed node that the original did not have, so
`parse(serialize(g))` diverged from `g`. Storing `Node.source` **verbatim**
removes the inference entirely. This matches the format's
[store-everything](#design-rationale) posture and the way `patch=` is handled.

#### Recomposition — store facts, derive mechanics

The resolved tarball URL of a registry package is **not a fact, it is a
mechanism**: it is a deterministic function of the registry type, the package
name, and the version. The format therefore **stores the facts** (the R-table
registry base, the `name`, the `version`, and — where present — a `#<sha1hex>`
fragment) and **derives the mechanics** (the tarball path), instead of storing
the same URL **three times** (the R host **and** the `nativeResolution` sidecar
**and** the `payload.resolution.url`). The recomposition is pinned per registry type:

| registry type | recomposed value |
|---|---|
| **npm-class tarball URL** | `<r.url>/<name>/-/<basename>-<version>.tgz`, where `basename` is `name` with any leading `@scope/` stripped (`@vue/shared` → `shared`), optionally followed by `#<sha1hex>` |
| **berry npm locator** | `<name>@npm:<version>` |

Crucially this is **EXACT-MATCH-OR-VERBATIM**, so fidelity is never at risk: at
emit the candidate is recomposed from `(base, name, version[, fragment])` and
compared **BYTE-EXACT** to the stored value; **any** mismatch (a git URL, a
`codeload` tarball, a `jsr.io` host, a url-encoded or re-pathed URL, an aliased
locator) falls back to the **verbatim** encoding.

#### The resolution split

`lockgraph` carries **two distinct resolution facets**, **both per-tarball**: the
`TarballPayload.nativeResolution` PM-native sidecar string and the canonical
`TarballPayload.resolution` union. Both live in the **severable `F` section**
(except for the canonical-URL native's `#<sha1>` fragment, which rides the N-row
integrity `u`-member); each is governed by an **exhaustive rule** — there is **no
partial split**.

**`TarballPayload.nativeResolution` (the PM-native sidecar string)** — model type
`string`, a **per-tarball** field (invariant across peer-virtual siblings sharing
a TarballKey). A non-canonical native rides the `F` `nativeResolution=` slot; a
canonical-URL native's `#<sha1>` fragment rides the integrity `u`-member (the URL
recomposing from R); and a canonical **berry** npm locator is recomposed by the
**berry adapter** (never stored — see
[§ nativeResolution omission](#res-omission--exact-match-or-verbatim)). It is
**distinct** from the `TarballPayload.resolution` union below; both survive.
Workspace members carry **no** `nativeResolution` — their `<name>@workspace:<path>`
locator is recomposed from `Node.workspacePath` at stringify (a workspace member
is a local project, not a downloadable artifact, so it carries no TarballPayload).

**`TarballPayload.resolution` (the canonical 4-case union)** — model type
`ResolutionCanonical`. It is a **known-shape, schema-driven** union
(`recipe/resolution.ts:29-33` — four discriminated cases), so it flattens via
**dot-path** under a `resolution.` prefix, exactly like every other typed field;
it is **not** `unknown`-typed and carries **no JSON**. The rule, stated once and
exhaustively:

> The canonical-tarball resolution is **OMITTED** from the `F` row and
> **recomposed from the R row** ONLY when it is **exactly** the 2-key shape
> `{type:'tarball', url:<recomposable-from-the-R-registry-descriptor>}`. In
> **EVERY** other case — a `tarball` with extra keys (e.g. `hostingProvider`),
> or any `git` / `directory` / `unknown` union — the **WHOLE**
> `ResolutionCanonical` union is **flattened verbatim** under the `F` row's
> `resolution.*` dot-path slots (`resolution.type=…`, `resolution.url=…`,
> `resolution.sha=…`, …). There is **no partial split**: it is
> **whole-union-flattened** or **fully-omitted-and-recomposed**.

The 4 union cases (per `recipe/resolution.ts` `ResolutionCanonical`) and where
each lands:

| union case | fields | home |
|---|---|---|
| `{type:'tarball', url, hostingProvider?}` | `url` required; `hostingProvider?` optional | **omitted + recomposed from R** iff it is the bare 2-key `{type, url}` with a recomposable `url`; **otherwise** (extra `hostingProvider`, or non-recomposable `url`) the **whole union** flattens under `resolution.*` slots |
| `{type:'git', url, sha, hostingProvider?}` | `url` **and** `sha` both required; `hostingProvider?` optional | **whole union** flattens under `resolution.*` slots (note `sha` is required) |
| `{type:'directory', path}` | `path` required (**no `url`**) | **whole union** flattens under `resolution.*` slots |
| `{type:'unknown', raw}` | `raw` required (**no `url`**) | **whole union** flattens under `resolution.*` slots |

So a reimplementer sees: `git` carries a required `sha`, `directory` carries a
`path` and no `url`, `unknown` carries a `raw` and no `url`. Only the bare 2-key
`tarball` is ever recomposed; every other shape flattens verbatim under
`resolution.*` (see [§ payload.resolution omission](#payloadresolution-omission)
and [§ The resolution union under `resolution.*`](#the-resolution-union-under-resolution)).

#### `nativeResolution` omission — exact-match-or-verbatim {#res-omission--exact-match-or-verbatim}

`TarballPayload.nativeResolution` (the verbatim PM-native resolution **sidecar
string**) is encoded under the exact-match-or-verbatim guard, with **two**
mutually exclusive outcomes plus the "never existed" case:

1. **`u`-member, no `F` slot** — when `nativeResolution` byte-equals
   `<recomposed canonical npm tarball URL>#<sha1hex>`, the `F` `nativeResolution`
   slot is **omitted entirely** and the `#<sha1hex>` fragment rides the **N-row
   integrity column's `u`-member**. On parse (in the reattach phase, after both
   the N row and the `F` section are read) the URL is recomposed from the R row
   and the fragment is re-appended.
2. **`nativeResolution=<string>` verbatim** — any other `nativeResolution` (git
   locator, non-canonical URL, `file:`/`link:`/`portal:` locator, `@patch:`
   locator) is stored **verbatim** as the `F` slot `nativeResolution=<string>`
   (TSV-escaped).
3. **Absent — never existed** — a tarball whose `nativeResolution` was
   **undefined** emits **nothing**. On parse, the absence of *both* triggers
   is the signal that it had no native resolution, so the rebuilt payload's
   `nativeResolution` **stays undefined**. The parse **never invents** one.

> **The canonical berry npm locator is recomposed by the adapter, not stored.**
> A yarn-berry registry node's `resolution:` is always `<name>@npm:<version>` —
> fully derivable from the node's `(name, version)`. The **berry adapter** omits
> it at parse (it never lands on `TarballPayload.nativeResolution`) and
> **recomposes** it at emit, so the lockgraph layer never sees it: there is no
> `nativeResolution.berry=` marker (removed in the #101 two-section redesign).
> A `nativeResolution` that *does* reach the lockgraph model is a
> **non-canonical** native and is stored verbatim (outcome 2). The distinction
> between "omitted-because-canonical-url" (outcome 1) and "never-existed"
> (outcome 3) must still be **unambiguous**, because inventing a resolution on a
> tarball that never had one is the same failure class as the ADR-0032 phantom
> `+src=` bug — the `u`-member and a verbatim `nativeResolution=` are **mutually
> exclusive**.

#### `payload.resolution` omission {#payloadresolution-omission}

The **canonical** `TarballPayload.resolution` union (distinct from the
`nativeResolution` sidecar above) is **omitted** from the document **iff** it is
**exactly** `{ type: 'tarball', url: <recomposed canonical URL, no fragment> }` —
a two-key object whose `url` byte-equals the recomposition from the node's hosted
npm R row. On parse it is **reconstructed** from that R row. **Any other shape** —
a `git` / `directory` / `unknown` union, or a `tarball` union carrying extra keys
such as `hostingProvider`, or a `url` that does not recompose — is kept as the
**WHOLE union, flattened verbatim, under the `F` row's `resolution.*` dot-path
slots** (see [§ The resolution union under `resolution.*`](#the-resolution-union-under-resolution)).
There is **no partial split**: the union is either fully omitted-and-recomposed
(the bare 2-key tarball) or carried whole — never decomposed into a graph-section
core plus a residual tail. The hosted npm R row existentially certifies that the
node *had* a canonical tarball resolution, so the reconstruction can never mint a
`resolution` on a node that had none.

#### Integrity multiset encoding

`integrity` carries the **entire** [§3 integrity multiset with origin
tags](./_common.md#3-integrity-model) — never a single truncated hash. Each
member is `<originMarker><algo>-<digest>`; members are **joined with `;`** in
their canonical multiset (source) order:

```
integrity := <member> ( ';' <member> )*
member    := <hash> | <z-member> | <u-member>
hash      := <origin><algo> '-' <digest>      # a real integrity multiset member
z-member  := 'z' [ <cacheKey> '/' ] <algo> '-' <digest>   # berry-zip; OPTIONAL folded cacheKey prefix
origin    := s | z | r | c                    # 1-char origin marker
u-member  := 'u' 'sha1' '-' <40-hex>          # TRANSPORT-ONLY; at most one, always LAST
algo      := sha1 | sha256 | sha384 | sha512 | …
digest    := lowercase hex
cacheKey  := the yarn-berry checksum cache-key prefix (e.g. 10c0, 10, 8, 2)
```

The one-char **origin marker** is the [§3.2](./_common.md#3-integrity-model)
origin, prefixed onto the member so the derive-vs-fetch boundary survives:

| marker | `HashOrigin` |
|:--:|---|
| `s` | `sri` |
| `z` | `berry-zip` |
| `r` | `registry` |
| `c` | `recomputed` |
| `u` | `url-fragment` — **TRANSPORT-ONLY**; carries a recomposed-URL `#<sha1>` fragment, **not** a multiset member (see note) |

> **The `u`-member is a transport slot for a recomposed-URL fragment, not a
> multiset hash.** Per [§3 of `_common.md`](./_common.md#3-integrity-model), a
> `url-fragment` sha1 rides the **resolution sidecar**, **not** the integrity
> multiset. When a tarball's `nativeResolution` is a canonical
> `<recomposed npm tarball URL>#<sha1hex>`, the URL is recomposed from the R row
> and dropped, and **only its `#<sha1>` fragment** is parked here as a single
> `usha1-<40hex>` member — **always the LAST member, at most one**. On parse (in
> the reattach phase) it is intercepted and put **back** into the recomposed URL
> as the `#`-fragment of `nativeResolution`; it is **NEVER** folded into
> `Integrity.hashes`. Symmetrically, a *real* multiset `Hash` carrying
> `origin: 'url-fragment'` is **REJECTED at emit**. A `u`-member with a non-`sha1`
> algorithm or a duplicate `u`-member fails with `PARSE_FAILED`.

> **The `berry-zip` z-member folds the yarn-berry checksum cache-key.** A
> yarn-berry `checksum` is `<cacheKey>/<sha512-hex>` (v8+) or a bare
> `<sha512-hex>` (v4–v6); the `<cacheKey>/` prefix (`10c0` / `10` / `8` / `2`,
> ADR-0031) is **part of that hash's value**, so it rides the `z`-member itself
> as `z<cacheKey>/<algo>-<digest>` (e.g. `z10c0/sha512-…`) rather than a separate
> `F` slot. A cacheKey contains no `/` and an `<algo>-<digest>` contains no `/`,
> so on decode the **first `/`** unambiguously separates the cacheKey (before it)
> from the hash (after it); a bare `z<algo>-<digest>` (no `/`) means **no
> cacheKey** (the bare-era v4–v7 shape). On parse the cacheKey is lifted off and
> reattached as `TarballPayload.berryChecksumCacheKey`. A second `/`-bearing
> `z`-member in one column fails with `PARSE_FAILED`. A `berryChecksumCacheKey`
> with **no** `berry-zip` member is a model anomaly that does not occur (yarn only
> records a cache-key alongside a zip-cache digest) and has no encoding.

`;` separates members and `-` separates algo from digest; neither occurs inside
a hex digest or an algorithm token, so the sub-field is self-delimiting within
the tab-bounded column with no further escaping. A single registry `sha512` SRI
is the common case (`s` marker, one member); a `berry-zip` checksum and an SRI
coexisting on one entry serialize as two `;`-joined members
(`z<cacheKey>/sha512-…;ssha512-…`, or `zsha512-…;ssha512-…` when the berry
checksum is bare). `-` (a bare dash) in the column means *no integrity*.

### E — edges

One edge per row, sorted by `(src, dst, kind, alias)` — a pure function of the
graph. `src` / `dst` sort numerically; `kind` sorts by its full-word spelling
under `cmpStr` (`bundled` < `dep` < `dev` < `opt` < `peer`); `alias` is the
tertiary tiebreak for the alias-distinct sibling edges that share `(src, dst,
kind)`.

The row is **4 positional fields** followed by **omittable `key=value` / flag
slots** — the same slot design as the `N` row, with **no positional `-`
padding**:

```
<srcIndex>\t<dstIndex>\t<kind>\t<descriptor>[\t<slot>…]
```

| Field | Meaning |
|--------|---------|
| `srcIndex` | source node index (decimal) |
| `dstIndex` | target node index (decimal) |
| `kind` | edge scope, the **full word**: `dep` · `dev` · `opt` · `peer` · `bundled` |
| `descriptor` | `EdgeAttrs.range` — the declared descriptor, stored **explicitly and verbatim** with the npm protocol **implicit** and every other protocol **inline**; `-` when the edge declared no range |

Trailing **slots**, each **omitted when absent/false**, in this **fixed order**
(determinism) — but parse is keyed, so order is not load-bearing on the way in:

| slot | when present | carries |
|---|---|---|
| flag cluster `o` / `w` / `ow` | ≥1 boolean flag set | `EdgeAttrs.optional` (`o`) and/or `EdgeAttrs.workspace` (`w`) — the **only** valueless slot |
| `alias=<value>` | `EdgeAttrs.alias` is set | the local descriptor name (participates in edge identity) |
| `rv=<value>` | the edge's `workspaceRange.resolvedVersion` is set | the concrete target-member version |
| `sp=<value>` | `workspaceRange.specifier` **differs** from the `descriptor` | the canonical specifier when an adapter canonicalised it apart from the descriptor |

**`kind` is a full word, not a code.** `EdgeKind` is exactly
`{dep, dev, optional, peer, bundled}`, written out — `optional` shortens to
`opt` so it never collides with the `o` *flag* letter, the rest are the enum
names. A readable word costs ≈0 bytes compressed while keeping the **audit scope**
legible in the raw file.

**`descriptor` is explicit and verbatim, with the npm protocol implicit.** The
declared `EdgeAttrs.range` is stored as-is — **no** "derive when it equals the
resolved version" sentinel and **no** `=` shorthand. The npm protocol is
**implicit**: a bare semver / range (`^1.2.3`, `1.x`, `*`, `latest`) is stored
as-is. **Every other protocol stays inline, as the full word it appears with in
the lockfile** — `workspace:*`, `github:owner/repo#ref`, `git+https://…`,
`file:../x`, `link:…`, `portal:…`, `npm:…`. `-` when the edge declared no range
(the `\-` escape keeps a genuine `-` descriptor round-tripping). Because the
descriptor is **positional field 4 — before any slot** — a descriptor that itself
contains `=` (a URL query like `git+https://h/r.git?ref=main`) is unambiguous.

**`alias` participates in edge identity.** `EdgeAttrs.alias` is the **local**
descriptor name when it differs from the target node's actual name — npm-alias
deps like `"react-is-18": "npm:react-is@^18"`. It rides the **`alias=` slot**,
present **only** when set. Per [§4 of `_common.md`](./_common.md#4-reserved-vocabulary),
`alias` **participates in edge identity**: two `src → dst` edges of the **same**
kind are permitted **iff** their `alias` slots differ.

**flags are a packed cluster slot.** The two boolean `EdgeAttrs`:

| letter | attribute |
|:--:|---|
| `o` | `EdgeAttrs.optional` |
| `w` | `EdgeAttrs.workspace` |

Packed together (`ow`) when both hold; the whole slot is **omitted** when neither
does (no `-` placeholder). `w` is **stored**, not derived from the `workspace:`
protocol in the descriptor. `workspace` is a **flag, not a kind** — see below.

**`workspaceRange` is decomposed onto `rv=` / `sp=` — no JSON, no specifier
duplication.** The model type is
`WorkspaceRange = { specifier: string; resolvedVersion?: string }`. The format
stores **nothing redundant**:

- `specifier` **IS the `descriptor`** — never stored twice. On parse the
  `workspaceRange` is reconstructed as `{ specifier: <descriptor> }` for a
  `w`-edge (plus `resolvedVersion` from `rv=` when present). A `w`-edge with an
  absent descriptor (`-`) reconstructs `{ specifier: '' }`.
- `resolvedVersion`, when set, rides the **`rv=` slot**.
- `sp=` is a **fallback** used **only** when `specifier ≠ descriptor` — e.g.
  `bun-text` stores a descriptor `workspace:` (bare protocol) while its canonical
  specifier is `workspace:*`, so it emits `sp=workspace:*`.

So a `workspace:^` edge resolving to `1.0.0` is `…\tworkspace:^\tw\trv=1.0.0` (no
JSON, no `sp=`); a pending `workspace:*` edge is `…\tworkspace:*\tw`; and the
bun-text bare-protocol edge is `…\tworkspace:\tw\trv=0.0.0\tsp=workspace:*`.

#### `workspace` is a flag, not a kind

`EdgeKind` is exactly `{dep, dev, optional, peer, bundled}` — **scope only**.
There is no `workspace` kind. `workspace` is the **resolution protocol**, which
is *orthogonal* to scope: a `workspace:` link is still a `dep` **or** a `dev`. So
it rides the **flags** slot (`w`), not the kind. Two distinct "workspace" facets
must be kept apart:

| facet | where | meaning |
|---|---|---|
| node-level `workspacePath` | the `ws=` **node** slot | *this node **is** a workspace member* |
| edge-level `w` flag | the `w` **edge** flag | *this edge resolves via `workspace:`* |

#### Protocol placement

The format places each resolution / reference **protocol** where its identity
lives:

| protocol | placement | where |
|---|---|---|
| `git:` / `file:` / `link:` / `portal:` / `tarball` / registry | the **NODE** | its `r<regIndex>` source + `version` + the bare recomposable 2-key tarball `resolution` recomposed from R (any non-recomposable union flattens under the `F` row's `resolution.*` dot-path slots, **whole and verbatim**) |
| `npm:`-alias | the **EDGE** | the `alias=` slot (+ the `npm:…` descriptor) |
| `workspace:` | the **EDGE** | the `w` flag + the `workspace:…` descriptor (+ `rv=` / the rare `sp=`) |
| `patch:` | a **NODE** slot | `patch=` (the patch is a distinct node variant) |

### L — layout hints

A graph carries **at most one** `LayoutHints` value (graph-level, surfaced by
`Graph.layoutHints()`; the type is currently `{ strategy?: 'isolated' |
'hoisted' | 'pnp' | 'nm-linked' }`). It is carried by a single **optional**
trailing line:

```
L <canonical-JSON>
```

- The line appears **after** the entire `E` region and **before** the `F`
  region — it is the last line of the GRAPH section.
- It is **absent entirely** — no `L` token, no empty line — when the graph has
  **no** layout hints. Presence of the line is therefore itself the signal.
- `L` is **space-separated framing**, so the literal token is `L`, one space,
  then the JSON. It is **not** a counted region.
- `<canonical-JSON>` is the `LayoutHints` object encoded as
  [§ Canonical JSON](#canonical-json). E.g. a pnp graph emits `L {"strategy":"pnp"}`.

On parse, the `L` line (when present) is decoded and replayed via
`Builder.layoutHints(...)` before `seal()`. When absent the builder's
`layoutHints` is left unset.

### F — fidelity

**`F` is the severable fidelity section** — the artifact metadata of every
distinct tarball, gathered out of the graph rows into one counted region. It
carries **no graph identity**: every facet here is diff-neutral, and the region
can be cut wholesale while the graph still parses identity-valid (see
[§ Severability](#severability--cutting-the-f-section) and
[§ Two-tier degradation](#two-tier-degradation)).

#### Keyed by the representative node index

Each `F` row is **one entry of the model's `State.tarballs: Map<TarballKey,
TarballPayload>`** — the artifact metadata is a property of the **tarball**, not
the node, "shared across peer-virtual siblings". The region is therefore still
**per-distinct-`TarballKey`**, deduped across peer-virtual siblings. But the row
is **identified by a node index**, not by the `TarballKey` string:

The **`TarballKey`** itself is:

```
TarballKey := <name> '@' <version> [ '+patch=' <token> ] [ '+src=' <16-hex> ]
```

i.e. the NodeId **stripped of `peerContext`**, with the `+patch=` and `+src=`
discriminators in canonical (`cmpStr`-sorted) slot order — exactly
`toTarballKey(inputs)` (graph.ts). The **representative** of a tarball is the
**minimum node index** among the nodes that share its `TarballKey`. An `F` row
leads with that representative index; on parse, the index is resolved to a node
whose `(name, version, patch, src)` recompute the `TarballKey` under which the
row's residual attaches. Four consequences are **load-bearing**:

- **The row key is the representative node INDEX, not the `TarballKey` string.**
  The leading field is a non-negative integer, exactly like an `E`-row endpoint.
  The `N` row at that index already states the tarball's `name`/`version` (and any
  `+patch=`/`+src=`), so restating the full `TarballKey` on the `F` row would be
  redundant. Resolving the index recomputes the same `TarballKey` the model uses.
- **The dedup is still by full `TarballKey`, not bare `name@version`.** Bare
  `name@version` would **collide** on two distinct tarballs that share it: a
  patched copy vs its base (`+patch=` distinguishes them), and — per #91 — a
  registry copy vs a git fork at the same version (`+src=` distinguishes them).
  Each distinct `TarballKey` is **one** `F` row, keyed by **its own**
  representative index, so two such tarballs are **two distinct rows**.
- **`peerContext` is NOT in the key.** Peer-virtualisation is a *node* facet, not
  a *tarball* facet: two peer-virtual siblings (same `name@version`, different
  peer context) are two **nodes** but **one tarball**, so they share **one** `F`
  row (keyed by the minimum of their two indices). This is precisely why the
  metadata moved off the node — it would otherwise be duplicated across every
  peer-virtual sibling. A non-representative sibling still finds the residual by
  computing its **own** `TarballKey` (which equals the representative's) during
  the per-node reattach.
- **The join is symmetric to edges.** Just as an edge addresses its endpoints by
  node index, an `F` row addresses its tarball by a (representative) node index.
  The `N` row carries **no `f<idx>` column** in the other direction; a node finds
  its tarball metadata by computing its own `TarballKey` and looking it up in the
  reconstructed `F` map, exactly as `graph.tarball(node)` does.

```
<repr-idx>\t<slot>…
```

Each `F` row is the representative node index followed by **self-describing
dot-path `key=value` slots**, **no** positional grid (see
[§ F-row slot grammar](#f-row-slot-grammar)).

**Field 1 is the representative node index — parsed POSITIONALLY, as an integer.**
Field 1 of an `F` row is a **non-negative decimal integer** in `[0, nodeCount)` —
**everything up to the first tab**, parsed **positionally** (the leading field),
**not** as a `key=value` slot. It is validated exactly like an `E`-row endpoint
(reject empty / non-integer / out-of-range → `PARSE_FAILED`) and resolved against
the already-parsed `N` rows: `node = N[idx]`, whose `(name, version, patch, src)`
recompute the `TarballKey` under which this row's residual is stored. Only fields
**after** field 1 are dot-path slots (see
[§ F-row slot grammar](#f-row-slot-grammar)).

A `TarballKey` with an **empty** residual payload (e.g. a tarball whose only fact —
integrity — lives on the N row, with a recomposable canonical resolution and no
native sidecar) produces **no `F` row at all**: the region holds only tarballs
that carry ≥1 residual facet (see
[§ F-row count](#f-row-count--counted-region-rule)).

> **A node-less tarball cannot be represented.** Because the row key is a node
> index, a tarball with **no node** (a `setTarball` with no matching `addNode` —
> reachable only in hand-built graphs, never in real adapter parsing) has no
> representative index and is therefore **dropped** on emit. The `F` section stores
> per-node fidelity, so a node-less tarball is unrepresentable by design.

> **What is NOT in `F`.** `integrity` (the N-row column — including the folded
> `berryChecksumCacheKey` on its `berry-zip` z-member) and the **canonical**
> `TarballPayload.resolution` source descriptor *when it is the recomposable bare
> 2-key tarball* (the R row + recomposition) stay in the GRAPH section. The native
> sidecar's `#<sha1>` fragment (canonical-URL shape) rides the N-row integrity
> `u`-member, and a canonical berry npm locator is recomposed by the adapter (not
> stored). Everything else — the verbatim `nativeResolution=` sidecar and any
> non-recomposable canonical resolution union — is in the **`F` residual
> `TarballPayload`**, every artifact-metadata field *not* captured by a
> graph-section home.

#### F-row slot grammar

Each residual `TarballPayload` field flattens onto **one or more dot-path
slots** — there is **NO nested JSON anywhere in the `F` section**, not even an
escape hatch. Slots are emitted in a **fixed order** (determinism); parse is
keyed by dot-path, so order is not load-bearing on the way in. A slot is
**omitted when its field is unset**.

**One uniform slot rule.** Every field after field 1 (field 1 is the positional
representative node index, above) is a slot of the form:

```
<dotpath> '=' <value>
```

- **`<dotpath>`** is one or more **key segments** joined by a literal `.` (dot).
  A **purely-numeric** segment denotes an **array index**; a **non-numeric**
  segment denotes an **object/map key**. Depth is unbounded — segments nest as
  deep as the value does. Examples: `license=MIT` (one segment, depth 0, a
  scalar); `engines.node=>=10.2.2` (a map key); `bin.react=react` (a map key);
  `os.0=linux` + `os.1=darwin` (an array, two indices); `bundled.0=foo` (the
  `bundledDependencies` array — its slot root is the **short token `bundled`**,
  never `bundledDependencies`); `funding.0.type=github` + `funding.0.url=https://…`
  (an array-of-objects, nested two deep).
- **`<value>`** is the **leaf**, TSV-escaped. At the text layer the leaf is
  always a **string**; the model schema re-types it on parse (see
  [§ Schema-driven parse](#schema-driven-parse)).

**Split each slot on the FIRST `=` only** — the same first-delimiter discipline
by which the [§ integrity member](#integrity-multiset-encoding) splits algo from
digest, and by which the positional E-row `descriptor` stays `=`-immune as field
4. Everything **before** the first `=` is the dotpath (then key-segment-decoded,
see below); everything **after** is the value (then TSV-unescaped). The value may
therefore **freely contain `=`** — e.g. a funding URL `funding.0.url=https://h/s?sponsor=1`
or a free-text `deprecated=…=…` message — because only the **first** `=` is
structural. The **value** does **not** need any dot- or `=`-escaping; only
TSV escaping applies to it.

##### Key-segment escape — `\.` and `\=` {#key-segment-escape--and-}

Inside a **key segment** (anywhere in the dotpath, i.e. **before** the first
`=`), two bytes are escaped so a segment can itself contain them:

| raw byte in a key segment | escape |
|---|---|
| `.`  (a literal dot, not a segment separator) | `\.` |
| `=`  (a literal equals, not the slot separator) | `\=` |

**The key-segment escape alphabet is EXACTLY `{ '.' , '=' }` — and nothing
else.** It NEVER touches a literal backslash: a `\` byte in a key segment is left
untouched by the segment escape and is escaped **only** by the outer
[§ TSV escape](#tsv-encoding) (`\` → `\\`). This is the **only** new sub-field
delimiter the `F` section introduces, and it **composes with** (runs **inside**)
the TSV escape: a slot is first key-segment-escaped (touching only `.` and `=`),
then the whole field is TSV-escaped, so a backslash written by the key-segment
escape — or a literal backslash already in the key — is TSV-escaped to `\\` on
the wire and reversed in the same two-pass order on parse (TSV-unescape the field,
then split the dotpath on **unescaped** `.`, then per-segment unescape `\.`→`.`
and `\=`→`=`).

**Byte-trace — a literal backslash in a key.** A `bin` command-name key `a\b`
(no `.`, no `=`) round-trips without the segment escape ever firing:

- **emit:** segment-escape sees no `.`/`=`, so `a\b` is left as `a\b` → the field
  `bin.a\b=…` is TSV-escaped, turning the literal `\` into `\\` → wire bytes
  `bin.a\\b=…`.
- **parse:** TSV-unescape `bin.a\\b` → `bin.a\b` → split on **unescaped** `.`
  (the `.` after `bin`) → segments `bin` · `a\b` → per-segment reverse of
  `\.`/`\=` (none present) → key `a\b`. The literal backslash survives because the
  segment layer never claimed it.

The motivating case for the segment escape itself is a **map key that contains a
dot** — a `bin` command-name such as `foo.bar`. It round-trips as:

```
bin.foo\.bar=lib/foo.bar.js
```

The two real dots in the dotpath separate the segments (`bin` · `foo\.bar`); the
`\.` inside the second segment is the literal dot in the command name, and the
dots in the **value** `lib/foo.bar.js` need no escaping (the value is split on
nothing — only TSV-escaped). It rebuilds as `{ 'foo.bar': 'lib/foo.bar.js' }`. A
literal `=` in a key segment escapes to `\=`; only the first **unescaped** `=`
ends the dotpath.

##### Field order and contiguity

Slots for **one** field are emitted **contiguously** and in a **deterministic
order**: object keys in `cmpStr` order, array indices ascending. Across fields, a
**fixed field order**:
`license`, `deprecated`, `cpu`, `os`, `libc`, `bundled`, `engines`, `bin`,
`funding`, `resolution`, `nativeResolution`. Parse is keyed (by dotpath
root), so inbound order is **not** load-bearing; **emit** order is fixed for
byte-stability. The `nativeResolution` root is the PM-native sidecar — only the
verbatim `nativeResolution=<string>` form is an `F` slot; the canonical-URL shape
emits no slot (its `#<sha1>` rides the N-row integrity `u`-member) and a canonical
berry npm locator is recomposed by the adapter (never stored). There is **no `ck`
root**: `berryChecksumCacheKey` rides the N-row integrity column's `berry-zip`
z-member (`z<cacheKey>/…`), not the `F` section.

**Array indices MUST be contiguous from 0 (parse rule).** For any array-valued
field (`cpu` / `os` / `libc` / `bundled`, and the array form of `funding`), the
numeric index segments MUST be **contiguous, ascending from `0`**. **Emit** always
produces them so. On **parse** a gap is a hard error: a slot set with `cpu.0` and
`cpu.2` but **no** `cpu.1` is `PARSE_FAILED` (a parser must not silently
hole-fill or compact). Object (non-numeric) keys carry no such rule — only
array-index segments do.

##### Schema-driven parse

The parser reconstructs each `TarballPayload` field by its **MODEL TYPE**
(`graph.ts:50-80`), **not** by guessing the shape from the text. The re-typing the
schema drives is **purely STRUCTURAL** — scalar vs array vs map vs
nesting-depth — **never** a value cast. **Every typed leaf is a STRING**: no F
field has a boolean or numeric leaf, so **no boolean/numeric casting exists** at
all. Each residual `TarballPayload` field is `string` / `string[]` /
`Record<string,string>` / (`string | Record`) / `unknown` (`funding`), and the
`resolution` union's leaves are all strings too. The schema therefore round-trips
the **structure** (depth and container kind) **type-exact without any in-band type
tag**; the only carve-out is **empty containers** (see [§ Empty containers](#empty-containers--absent-vs-empty), below):

| field | model type | re-typing the schema applies (structural only) |
|---|---|---|
| `license` | `string` | scalar leaf → string |
| `deprecated` | `string` | scalar leaf → string (kept **point-in-time** — see below) |
| `cpu` / `os` / `libc` / `bundled` (`bundledDependencies`) | `string[]` | numeric segments → an array of string leaves, index-ordered |
| `engines` | `Record<string,string>` | one segment under the root → a map of string leaves |
| `bin` | `string \| Record<string,string>` | **zero** further segments (`bin=<v>`) → the string form; **one** further segment per entry (`bin.<k>=<v>`) → the map form — the depth **is** the discriminator (see below) |
| `funding` | `unknown` | structure-only (no schema): numeric segment → array index, non-numeric → object key, every leaf a string (see [§ `funding` — the one unschema'd field](#funding--the-one-unschemad-field)) |
| `resolution` | `ResolutionCanonical` (4-case union) | known-shape union, flattened under `resolution.*`; leaves are all **string** (see [§ The resolution union under `resolution.*`](#the-resolution-union-under-resolution)) |

So an `os.0`/`os.1` set rebuilds as `['linux','darwin']` because the schema knows
`os` is `string[]`, and a `bin.<k>=` slot rebuilds the **map** form while a bare
`bin=` rebuilds the **string** form — the *only* structural discrimination in the
table (see below). The container kind and nesting depth of every typed field are
known, so the parser never has to infer them from the text; and because every
leaf is a string, there is **no** `true`/`false`/number re-cast anywhere.

##### Empty containers — absent vs empty {#empty-containers--absent-vs-empty}

Re-typing is structural, but it cannot distinguish an **absent** field from an
**empty container**, because an empty container emits **zero slots** — there is no
slot to mark its presence or its kind. This applies **uniformly** to *every*
container field, not just `funding`:

- an empty `cpu` / `os` / `libc` / `bundled` (`[]`) emits no `cpu.*` / … slot;
- an empty `engines` / `bin`-map (`{}`) emits no `engines.*` / `bin.*` slot;
- an empty array/object `funding` (`[]` / `{}`) emits no `funding.*` slot.

On parse, an **absent slot-set is read as `undefined`** — so an empty container
round-trips as `undefined`, **indistinguishable from absent**. This is an
**accepted normalization**, the same trade [§ `funding`](#funding--the-one-unschemad-field)
makes for non-string leaves: empty containers do not occur in observed artifact
metadata, and v1 declines to spend an in-band presence marker on them. The "typed
fields round-trip type-exact … without any in-band type tag" claim therefore
carries this one carve-out: **present, non-empty** containers round-trip exactly;
**empty** ones collapse to `undefined`.

**`bin` — string vs map, discriminated by depth.** `TarballPayload.bin` is
`string | Record<string,string>`. The discriminator is the **dotpath depth under
the `bin` root**, read straight off the schema-known field:

- **string form** (`typeof === 'string'`) → a single slot `bin=<value>` with
  **no** further segment. E.g. `bin=cli.js`.
- **map form** (a `Record`) → one slot **per entry**, `bin.<name>=<path>`,
  entries in key-`cmpStr` order. E.g. `bin.eslint=bin/eslint.js` +
  `bin.eslint-config=bin/cfg.js`.

This is exact and never normalizes across the boundary: a **one-entry map** stays
the map form (`bin.cli=cli.js`, never collapsed to `bin=cli.js`), and a **string
`bin`** stays the string form (a string `"true"` stays `bin=true`, never a map),
because the emitter keys on `typeof payload.bin === 'string'` and the parser keys
on whether any `bin.<k>` slot is present. A parser that sees **both** a bare
`bin=` and a `bin.<k>=` slot fails with `PARSE_FAILED`.

##### `funding` — the one unschema'd field

`funding: unknown` is the **only** field with **no schema**. Its leaves are
reconstructed by **structure alone**: a **purely-numeric** key segment is an
array index, a **non-numeric** segment is an object key, and every leaf is a
**string**. This covers **100% of real funding data**, which is always
string-valued objects (`{type, url}`) or arrays of them — e.g.
`funding.0.type=opencollective` + `funding.0.url=https://opencollective.com/x`
rebuilds as `[{ type: 'opencollective', url: 'https://opencollective.com/x' }]`,
and a bare-string funding `funding=https://example.com/donate` rebuilds as the
string.

**Root array-vs-object discriminator (load-bearing for `funding`'s shapes).**
Because `funding` is unschema'd, the **root** container's kind is read off the
**first sub-segment after `funding.`**: if that sub-segment is **purely numeric**
the `funding` value is an **ARRAY** (the sub-segments are indices —
`funding.0.url=…` ⇒ `[{ url: … }]`); otherwise it is an **OBJECT** (the
sub-segment is a key — `funding.url=…` ⇒ `{ url: … }`). The same numeric-vs-name
test applies recursively at every deeper level. A bare `funding=<v>` (no
sub-segment) is the scalar string form. This root discriminator is what lets the
array-form funding shapes (`funding.0.*`) and the object-form (`funding.<key>.*`)
both round-trip from the flat slots alone.

> **Quirk — `funding`'s honest v1 limit (the zero-nesting trade).** Because
> `funding` carries **no value type-tags** and uses **best-effort string leaves**,
> three theoretical shapes cannot be distinguished or typed in v1:
> a funding value with a **non-string scalar leaf** (a `number` / `boolean` /
> `null`), an **empty container** (`{}` or `[]`, which leaves no slot to mark its
> presence or kind), or a key that is **itself a pure number used as an object
> key** (indistinguishable from an array index). **None of these occur in observed
> npm funding data** (funding is always string-valued objects/arrays), so v1
> accepts the limit deliberately. This is the conscious trade for **zero nesting**:
> the prior `json=` escape-hatch was *provably total* (any JSON value round-trips),
> whereas the dot-path encoding is **total-in-practice** — lossless for every
> shape that actually appears, at the cost of three never-observed theoretical
> shapes. See [§ Open questions](#open-questions-for-review) for whether v2 should
> carry value type-tags to restore totality.

##### The resolution union under `resolution.*` {#the-resolution-union-under-resolution}

The canonical `TarballPayload.resolution` union is a **known-shape, schema-driven**
4-case union (`recipe/resolution.ts:29-33`), so it flattens under the
`resolution.` dot-path prefix like any other typed field — **not** as `unknown`,
**no** JSON. It obeys the single exhaustive rule of
[§ The resolution split](#the-resolution-split) — **whole-union-flattened or
fully-omitted-and-recomposed**, never a partial split:

- A canonical `{type:'tarball', url:<recomposable>}` two-key union → **omitted
  entirely** (no `resolution.*` slot anywhere) and recomposed from the R row.
- **EVERY** other union — a `tarball` carrying **extra keys** (e.g.
  `hostingProvider`) or a **non-recomposable** url, or any `git` / `directory` /
  `unknown` union → the **WHOLE** union is **flattened verbatim** under
  `resolution.*`, with one slot per union field. On parse the case is read off the
  `resolution.type` leaf and the remaining leaves are re-cast per the schema.

Examples:

```
resolution.type=tarball   resolution.url=https://h/x.tgz   resolution.hostingProvider=github
resolution.type=git       resolution.url=https://github.com/o/r.git   resolution.sha=<40hex>
resolution.type=directory resolution.path=../local
resolution.type=unknown   resolution.raw=<verbatim PM-native shape>
```

When carried, a non-recomposable resolution (source-intrinsic, not
registry-derivable) lives in the severable fidelity tier; only the bare
recomposable 2-key tarball is reconstructed from the identity tier's R row.

#### Determinism

The `F` region is a **pure function of the graph**:

- **Rows are sorted by the representative node index, ascending.** The
  representative is the minimum node index sharing the tarball's `TarballKey`, and
  node order is itself deterministic (canonical NodeId sort, root pinned at 0), so
  the leading column is a stable, monotonically-ordered integer key.
- **Slots within a row are in the fixed order** of the
  [§ F-row slot grammar](#f-row-slot-grammar) (fields in the fixed list; within a
  field, object keys in `cmpStr` order and array indices ascending; a field's
  slots emitted contiguously).
- Two structurally-equal graphs therefore produce a **byte-identical** `F`
  region.

#### F-row count — counted-region rule

`F <n>`: **`<n>` is the number of `F` rows actually emitted** — i.e. the count of
distinct `TarballKey`s whose residual payload has **at least one facet**. A
tarball with an **empty residual** (every fact already on the N row — integrity,
the folded `berryChecksumCacheKey` z-member, recomposable resolution, or a
canonical berry native the adapter recomposes) emits **NO row** and is **NOT
counted**. The
emitted row count therefore **always equals `<n>`**; a parser MAY assert
`emitted-rows == <n>`. There is no key-only row for empty-residual tarballs, and
`<n>` is **not** the total tarball count (which may be larger).

#### No orphan rows; node-only tarballs are the common case

Because an `F` row is keyed by a **node index** ([§ Keyed by the representative
node index](#keyed-by-the-representative-node-index)), the row **always** points
at a real node, so an orphan `F` row (one referencing no node) **cannot exist** —
an out-of-range index is a `PARSE_FAILED`, not a tolerated entry. The
complementary asymmetry is the common, harmless one:

- **A node with no `F` row** simply has an **empty residual** payload — its only
  facts live on the N row. That is the common case and is **not** an error.

A node-less tarball (a hand-built `setTarball` with no `addNode`) has no
representative index and is therefore **dropped** on emit rather than stored — see
[§ Keyed by the representative node index](#keyed-by-the-representative-node-index).
This never arises in real adapter parsing (every tarball has ≥1 referencing node).

#### Severability — cutting the `F` section

**Dropping the `F` section keeps `g.diff` empty** (identity preserved); only
fidelity degrades. Concretely:

- A reader that ignores or strips every `F` row still reconstructs **every node,
  every edge, every registry, every integrity hash, and every recomposable
  canonical tarball resolution** — the entire GRAPH section is untouched. `g.diff`
  compares **nodes and edges only** (never tarball payloads), so
  `g.diff(parse(graph_section_only))` is **empty on all axes** even though the
  per-tarball `nativeResolution` rode `F`.
- What is lost is only the **residual `TarballPayload` facets** — `license`,
  `engines`, `bin`, `cpu`/`os`/`libc`, `bundled`, `deprecated`, `funding`, the
  per-tarball verbatim `nativeResolution` sidecar (the canonical-URL shape's
  `#<sha1>` rode the N-row `u`-member and so **survives**; a canonical berry
  native the adapter recomposes also survives), and any non-canonical
  `resolution` union (the whole union, when it was not the bare recomposable
  tarball) — i.e. the `tarballs()` payloads degrade to their
  graph-section-recoverable core (integrity, the folded `berryChecksumCacheKey`,
  and the recomposable canonical resolution all stay on the N row).
  `tarballs()` still iterates the **same keys**; only the **values** thin out.

This is the structural proof of the two sections: cut `F` → identity-valid
always.

## Two-tier degradation

When the `F` section is cut, the recoverability of its facets splits into **two
tiers**:

```
                          cut the F section
                                  │
            ┌─────────────────────┴─────────────────────┐
            ▼                                            ▼
   TIER 1: identity-valid                       TIER 2: rebuild-from-registry
   (ALWAYS)                                      (only the packument tier)
   everything in F is diff-neutral;             a re-fetch from the registry
   the graph parses, g.diff stays empty         can recover SOME facets, not all
```

**Tier 1 — cut → identity-valid: ALWAYS.** Everything in `F` is diff-neutral, so
dropping the whole region never changes graph identity. `parse` of the
GRAPH-section-only document yields a graph whose `g.diff` against the original is
empty on every axis. This tier is **unconditional**.

**Tier 2 — cut → rebuild-from-registry lossless: only the packument-derivable
facets.** Of the cut facets, **only the tier that a packument re-fetch can
reproduce** comes back losslessly:

| facet | tier-2 recoverable? | why |
|---|:--:|---|
| `engines` | ✅ | in the registry packument for `name@version` |
| `license` | ✅ | packument |
| `bin` | ✅ | packument |
| `cpu` | ✅ | packument |
| `os` | ✅ | packument |
| `libc` | ✅ | packument |
| `bundled` (`bundledDependencies`) | ✅ | packument |
| `funding` | ❌ | **source-intrinsic** — not reliably in the packument; lost on cut |
| `deprecated` | ❌ | **point-in-time** — see below |
| non-canonical `resolution` union (`hostingProvider`-bearing tarball, git/directory/unknown — carried whole) | ❌ | **source-intrinsic** — describes *where this lock fetched from*, not a packument fact |

So: cut → rebuild-from-registry recovers **only** the packument-derivable tier
(`engines` / `license` / `bin` / `cpu` / `os` / `libc` / `bundled`); the
source-intrinsic facets (`funding`, `deprecated`, the non-canonical `resolution`
union) are **lost on cut** because they are not a function of `name@version` in
any registry.

> **`deprecated` is kept point-in-time (source-intrinsic).** A lock is a
> **snapshot**. `deprecated` is stored **as it was when the lock was written**,
> not re-fetched — a package deprecated *after* the lock was written should not
> retroactively appear, and one un-deprecated later should not vanish. So
> `deprecated` is **source-intrinsic** for degradation purposes: it is not
> tier-2-recoverable, because a fresh packument reflects *now*, not the snapshot
> instant. Keeping it in `F` (and losing it on cut) is the honest behavior.

This two-tier model is purely about **recoverability**, not encoding: every `F`
facet — `engines` / `license` / `bin` / `cpu` / `os` / `libc` / `bundled` **and**
`funding` / `deprecated` / the non-canonical `resolution` union — is encoded the
**same** way (dot-path slots, no JSON). The tier-1/tier-2 split is only about which
facets a registry re-fetch can reproduce: the **packument-derivable** facets
(`engines` / `license` / `bin` / `cpu`/`os`/`libc`/`bundled`) come back on rebuild,
while the **source-intrinsic** facets (`funding` / `deprecated` / the
non-canonical `resolution` union) are lost on cut because they are not a function
of `name@version` in any registry.

## Worked example — an `F` row

A registry tarball `@scope/widget@2.1.0` that carries a license, an engines map,
a per-bin map, a platform-constraint array, *and* a nested array-of-objects
`funding` tail plus a `hostingProvider`-bearing `resolution` union. Its N row
(identity) and its `F` row (fidelity) are independent; the join is by **node
index** — the `F` row leads with the representative node's index, here node `0`.
Tab-expanded for reading; real bytes use a single `\t`. **No JSON appears
anywhere** — every value is a dot-path slot.

GRAPH section (the node — JSON-free; this is node index `0`):

```
@scope/widget   2.1.0   r0   ssha512-3a7f9c2e1b8d04f6
```

(`r0` = `npm https://registry.npmjs.org` — the node's R source. The tarball's
`nativeResolution` sidecar, if canonical, recomposes from `r0`; but this
tarball's `TarballPayload.resolution` union is **not** the bare 2-key shape — see
the `resolution.*` slots below, where the whole union is flattened verbatim.)

FIDELITY section (the tarball — fidelity; field 1 is the representative node
index `0`):

```
F 1
0   license=MIT   cpu.0=x64   cpu.1=arm64   engines.node=>=18   engines.npm=>=9   bin.widget=bin/widget.js   bin.widget-dev=bin/dev.js   funding.0.type=opencollective   funding.0.url=https://opencollective.com/widget   resolution.type=tarball   resolution.url=https://github.com/scope/widget/releases/download/v2.1.0/widget-2.1.0.tgz   resolution.hostingProvider=github
```

Decoding the `F` row, slot by slot — the schema drives every re-typing:

- **field 1** `0` — the **representative node index**. Resolving it gives node
  `@scope/widget@2.1.0`, whose `(name, version)` recompute the `TarballKey`
  `@scope/widget@2.1.0` (no `+patch=` / `+src=` here; bare). Peer-virtual siblings
  of this tarball, if any, would share this **one** row, keyed by the minimum of
  their indices.
- **`license=MIT`** — scalar (depth 0); schema type `string` → `'MIT'`.
- **`cpu.0=x64` · `cpu.1=arm64`** — two array-index slots; schema type `string[]`
  → `['x64','arm64']` (indices ascending → order preserved).
- **`engines.node=>=18` · `engines.npm=>=9`** — two map slots; schema type
  `Record<string,string>` → `{ node: '>=18', npm: '>=9' }` (keys `cmpStr`-sorted:
  `node` < `npm`; note the value `>=18` contains no `=` issue because only the
  **first** `=` is structural).
- **`bin.widget=bin/widget.js` · `bin.widget-dev=bin/dev.js`** — one segment
  under the `bin` root → the **map** form (depth is the discriminator), schema
  type `Record<string,string>` → `{ widget: 'bin/widget.js', 'widget-dev':
  'bin/dev.js' }`.
- **`funding.0.type=opencollective` · `funding.0.url=https://opencollective.com/widget`**
  — the nested array-of-objects case. `funding` is the **unschema'd** field, so
  structure alone drives it: a numeric segment (`0`) → array index, a non-numeric
  segment (`type`/`url`) → object key, leaves are strings →
  `[{ type: 'opencollective', url: 'https://opencollective.com/widget' }]`.
- **`resolution.type=tarball` · `resolution.url=…` · `resolution.hostingProvider=github`**
  — the **non-canonical `resolution` union** flattened (it carries the extra key
  `hostingProvider`, so it is **not** the recomposable bare 2-key shape; the whole
  union flattens, no partial split). `resolution` is the known-shape 4-case union,
  so the schema reads the case off `resolution.type` and re-casts the rest →
  `{ type: 'tarball', url: 'https://…/widget-2.1.0.tgz', hostingProvider:
  'github' }`.

On parse, the `F` row's field 1 (`0`) resolves to node `@scope/widget@2.1.0`,
whose computed `TarballKey` (`@scope/widget@2.1.0`) becomes the key under which
the residual is stored; each node then finds its residual by computing **its own**
`TarballKey` and looking it up. The slots are grouped by **root key segment**
(`license`, `cpu`, `engines`, `bin`, `funding`, `resolution`,
`nativeResolution`), each field reconstructed by its model type, then `integrity`
is overlaid from the N-row column (lifting the folded `berryChecksumCacheKey` off
its `berry-zip` z-member) and the `nativeResolution` resolved (a verbatim `F` slot
passes through; the N-row `u`-member fragment → recomposed URL). Note the canonical
resolution would have been recomposed from `r0` **had** the union been the bare
two-key shape; here it is **not** (the `hostingProvider` extra key), so the
flattened `resolution.*` slots win and **no** recomposition happens — exactly the
[§ payload.resolution omission](#payloadresolution-omission) rule.

A second, **flat-common** example for tarballs whose entire residual is a scalar
or a flat one-level field (field 1 is the representative node index — here `12`
is `loose-envify@1.4.0` and `7` is `react@16.0.0`):

```
7     engines.node=>=0.10.0
12    bin=cli.js
```

`loose-envify` carries the **string** form of `bin` (`bin=`, depth 0 — no further
segment, so it is the string form, not the map form); `react` carries one engines
map entry (`engines.node=…`). (Rows are sorted by index, so `react` at `7`
precedes `loose-envify` at `12`.) Both round-trip type-exact from the schema — the
`bin` string stays a string, the `engines` value rebuilds as a one-entry
`Record`.

A third example shows the **key-segment escape** for a map key that itself
contains a dot — a `bin` command-name `foo.bar`, whose literal dot must not be
read as a segment separator (field 1 `3` is the representative node of
`some-pkg@3.0.0`):

```
3    bin.foo\.bar=lib/foo.bar.js
```

The two real dots in the dotpath separate the segments `bin` · `foo\.bar`; the
`\.` inside the second segment is the literal dot in the command name, and the
dots in the **value** `lib/foo.bar.js` are not split (the value is only
TSV-escaped, never dot-split). The schema type `string | Record<string,string>`
sees the `bin.<k>` depth → the **map** form → `{ 'foo.bar': 'lib/foo.bar.js' }`.
Every leaf here is a string; no value cast happens.

A fourth example shows the **non-canonical `resolution` `unknown` case** on
corpus-shaped data — the value after the first `=` is **only TSV-escaped, never
dot-split** even when it contains `=`, `.`, `#`, `<`, `>`, `%`, `&` (field 1 `4`
is the representative node of `weird-dep@0.0.1`):

```
4    resolution.type=unknown    resolution.raw=git+ssh://g@h/o/r.git#v=1.2.3&path=a.b<c>%2Fd
```

The `resolution.raw` slot splits on its **first** `=` only: everything before is
the dotpath (`resolution` · `raw`), everything after — `git+ssh://g@h/o/r.git#v=1.2.3&path=a.b<c>%2Fd`,
which itself contains a later `=`, two `.`s, a `#`, `<`/`>`, a `%`, and an `&` —
is the **value**, TSV-unescaped verbatim with **no** dot-splitting and **no**
`=`-splitting. The schema reads the union case off `resolution.type=unknown` and
keeps `raw` as the string leaf → `{ type: 'unknown', raw: 'git+ssh://…%2Fd' }`.
This is the realistic shape a non-recomposable PM-native resolution flattens to.

## Determinism

The body — **R / N / E / F** — is a **pure function of the graph**:

- every region is content-sorted (R by `(type, url)`, N by the
  **fully-reconstructed NodeId** under `cmpStr` with the root pinned at 0 when one
  exists, E by `(src, dst, kind, alias)`, F by `TarballKey` under `cmpStr`);
- every index is derived from that canonical order, never from input bytes or
  the clock;
- two structurally-equal graphs therefore produce a **byte-identical** body
  regardless of how each was built (fresh parse, in-memory mutation,
  snapshot-restore).

The **only** thing that varies between two serializations of the same graph is
META's `generatedAt` (and `generator`, if the producing version changed). Pin
`generatedAt` to make the entire document byte-stable.

## Integrity & authenticity

`lockgraph` deliberately carries **no inline checksum and no "seal" line**. The
reasoning:

- **An inline hash is integrity, not a signature.** A hash stored in the same
  file it hashes catches *accidental* corruption, but it is **not** a signature:
  an adversary who edits the body simply recomputes the hash.
- **Its marginal value is small.** The corruption that *matters* is caught
  structurally on `parse`: the graph re-derives every NodeId from
  `(name, version, peerContext, patch, src)` and checks the
  [seal](#vocabulary) coherence invariants. And the bytes in transit are already
  guarded by the transport — TLS, git content-addressing, npm integrity.
- **Real authenticity is an external, detached signature.** Genuine authenticity
  means signing the canonical bytes with a **private** key and verifying with a
  **public** key that is **not in the file** — a sidecar `.sig`, sigstore, or npm
  provenance. That is an **outer layer**, kept entirely separate from the body.

**Reserved:** a future external detached-signature layer. It would wrap
`lockgraph`, not modify the body grammar.

Integrity of the *graph* is therefore **structural**: `parse` reconstructs and
seals the model, and a divergence surfaces as a parse/seal failure, not a hash
mismatch.

## Design rationale

The format optimizes, in order, for **fidelity** and **readability**, and lets
the compressor handle size. The principles, and their honest costs:

- **Identity and fidelity are two sections, not one.** The GRAPH section
  (R/N/E/L) is the model's **identity** and is JSON-free; the `F` section is the
  per-tarball **fidelity** and is **severable**. Splitting them lets a consumer
  who only needs the graph (a diff, a topology check, an audit-scope scan) skip
  the metadata wholesale, and keeps the identity rows eyeball-able without JSON
  noise. The format places no JSON **anywhere** in the body — not interleaved in the
  graph rows, and not even as a confined escape-hatch slot; the `F` section is
  **fully flattened** to dot-path slots, so the **only** remaining canonical-JSON
  encoding is the optional `L` line.
- **Store facts; derive only pure mechanics, under an exact-match guard.** The
  body stores the model's *facts* explicitly: the **full** `TarballPayload`
  residual (across the `F` dot-path slots, not a lossy subset),
  the **full** integrity multiset **with origin tags**, **verbatim** declared
  `range`s, **no** registry canonicalization, **no** patch look-through. The
  **one** thing it *derives* is the **tarball URL mechanics** — omitted and
  recomposed from the R row under **EXACT-MATCH-OR-VERBATIM**, so fidelity is
  never traded for the saving.
- **Fully flatten to dot-paths; the schema re-types on parse.** The `F`
  row flattens scalars / arrays / maps / nested objects to **dot-path `key=value`
  slots** (`.` separates key segments, a numeric segment is an array index), with
  one small **key-segment escape** (`\.` / `\=`) for keys that contain those
  bytes. There is **no nested JSON anywhere** in the section — not even an
  escape-hatch slot. The parser reconstructs each field by its **model type**
  (`graph.ts:50-80`), so the **structure** (scalar / array / map / nesting-depth)
  round-trips **type-exact without an in-band type tag** — the re-typing is purely
  structural, since every leaf is a string and no F field has a boolean or numeric
  leaf to cast. The honest cost is **`funding`**
  (the one unschema'd field): the dot-path encoding is **total-in-practice**
  rather than provably total — it is lossless for every funding shape that
  actually appears (string-valued objects/arrays), but cannot distinguish three
  never-observed theoretical shapes (a non-string scalar leaf, an empty container,
  a pure-number object key). This is the deliberate trade for zero nesting (see
  [§ `funding` — the one unschema'd field](#funding--the-one-unschemad-field) and
  [§ Open questions](#open-questions-for-review)).
- **gzip handles repetition.** We optimize the **raw** form for readability and
  correctness and let the compressor collapse the repeated tokens.
- **TSV, not an aligned table.** Single-tab rows emit in one cheap pass with no
  width pre-scan; **alignment is a per-region `column -t` view**, computed by
  whoever wants it.

## Detection

`check(input)` is true iff the document's first token is `@lockgraph` (a leading
UTF-8 BOM is tolerated). The discriminant is unambiguous and cheap (head-only),
so `lockgraph` sits at the **top** of the converter's detect order. No PM
lockfile begins with `@lockgraph`, and a `lockgraph` document is not recognized
by any PM adapter's `check`.

## What round-trips graph-identical

Every model element round-trips **identity-exact** (empty `diff` both ways,
`tarballs()` iterating the same keys in canonical order with **deep-equal**
payloads, and a byte-stable body re-serialize) — now **without any checksum**:

- **Integrity** — the full multi-hash multiset **with origin tags**, encoded in
  the node `integrity` column; a `berry-zip` checksum and an SRI coexist as
  `;`-joined members. A canonical-URL `nativeResolution`'s `#<sha1>` fragment rides
  a **transport-only `u`-member** here and is restored into the recomposed
  `nativeResolution` on parse (in the reattach phase).
- **`berryChecksumCacheKey`** — the per-tarball yarn-berry checksum-cache-key
  prefix, **folded into the N-row integrity column's `berry-zip` z-member** as
  `z<cacheKey>/<algo>-<digest>` (it is literally that checksum's prefix — no
  separate `F` slot).
- **`peerContext`** — peer-virtualisation (including nested/recursive contexts
  and pnpm-v9 hashed peer-set tokens), carried in the N-row `peer=` slot.
- **`patch` slot** — both the canonical 128-hex form and the
  `unresolved-<64hex>` sentinel; the base node and the patch node are stored as
  **two** distinct N rows.
- **`+src=` source discriminator** (ADR-0032) — **stored verbatim** as the N-row
  `src=` slot, **not re-derived**.
- **`EdgeAttrs`** — `range` (the verbatim `descriptor`), `optional` (`o`),
  `workspace` (`w`), `alias` (the `alias=` slot), and `workspaceRange`
  reconstructed from the descriptor + `rv=` / the rare `sp=`.
- **Workspaces** — `workspacePath` via the N-row `ws=`, **including the
  empty-path root pinned at node 0**.
- **Full `TarballPayload` residual** — `license`, `deprecated`, `engines`, `bin`,
  `cpu` / `os` / `libc`, `bundledDependencies` (the `bundled` slot root),
  `funding`, the verbatim `nativeResolution`, and any
  non-canonical `resolution` union — all flattened to **dot-path slots** in the
  **severable `F` section** (no JSON), keyed by `TarballKey`, shared across
  peer-virtual siblings. The typed fields round-trip **structure-exact** via the
  model schema (every leaf is a string — the schema re-types only the *structure*,
  scalar vs array vs map vs depth, never a value), with the one carve-out that an
  **empty container is read back as `undefined`** (see
  [§ Empty containers](#empty-containers--absent-vs-empty)); `funding` is
  reconstructed by structure (total-in-practice). A **canonical**
  `{type:'tarball', url}` two-key union is **omitted and recomposed** from the R
  row.
- **`nativeResolution`** — the per-tarball PM-native resolution **sidecar
  string**, encoded **exact-match-or-verbatim**: a non-canonical native in the `F`
  `nativeResolution=` slot, a canonical-URL native's `#<sha1>` on the integrity
  `u`-member, and a canonical **berry** npm locator recomposed by the adapter
  (never stored). Workspace members carry none — their `@workspace:` locator
  recomposes from `workspacePath`.
- **`LayoutHints`** — the graph's single `Graph.layoutHints()` value, carried in
  the optional `L` line.

**Not serialized — diagnostics.** Adapter / seal diagnostics
(`Graph.diagnostics()`) are **not** part of the format and are **not** persisted;
they are re-derived by the seal and adapters on the next parse/stringify.

The defining property stays `parse(serialize(g)) ≡ g` (empty `Graph.diff` both
ways, `tarballs()` deep-equal in canonical key order, byte-stable body
re-serialize) — established **structurally**, with no stored checksum.

## Vocabulary

This spec uses the model vocabulary defined normatively in
[`_common.md` §4](./_common.md#4-reserved-vocabulary) (NodeId, peerContext,
TarballKey, Graph, edge kinds, workspaces, iteration order) and the integrity
model in [`_common.md` §3](./_common.md#3-integrity-model). The patch slot /
sentinel grammar is
[`_common.md` §2](./_common.md#2-patch-slot--tarballkey-sentinel). The
**TarballKey** is `name@version[+patch=…][+src=…]` (the NodeId stripped of
peerContext — graph.ts `toTarballKey`), and **`State.tarballs`** is the model's
`Map<TarballKey, TarballPayload>` that the `F` region serializes one-row-per-entry.
"Seal" is the graph's `seal()` validation+finalization step that re-derives the
secondary indices and the `SEAL_*` diagnostics — the structural check that, in
this format, **replaces** an inline checksum.

## Design notes & open items

Most architectural decisions below are **RESOLVED**; a few remain as open items
still to confirm (the `funding` totality trade, the region letter, the
key-segment escape choice), plus a cosmetic slot-name call.

1. **The `F` region letter — OPEN.** The region is **`F`** ("fidelity") — the
   letter names *what the section is* (the severable fidelity tier) rather than
   *what the row keys on*. An earlier design used `T` ("tarball", what the row
   keys on); `F` foregrounds the identity-vs-fidelity split that is now the
   format's spine. Open question: whether to reconsider `T` / `M` (metadata) /
   `A` (artifact) against `F` now that the section is fully flat.

2. **`funding` value type-tags vs total-in-practice — OPEN (the real v1 trade).**
   The dot-path encoding is **total** for every schema-typed field (the schema
   re-types the structure, and every leaf is a string — there are no boolean or
   numeric leaves anywhere), but only **total-in-practice** for the one unschema'd
   field `funding`: three never-observed shapes (a non-string scalar leaf, an
   empty container, a pure-number object key) cannot be distinguished or typed in
   v1 (see [§ `funding` — the one unschema'd field](#funding--the-one-unschemad-field)).
   The **empty-container** ambiguity is in fact UNIFORM across every container
   field — an empty `cpu`/`os`/`libc`/`bundled`/`engines`/`bin` reads back as
   `undefined` too (see [§ Empty containers](#empty-containers--absent-vs-empty)) —
   but for the schema-typed fields that is the *only* gap, whereas `funding` also
   has the scalar-type and numeric-key gaps. The prior `json=` escape-hatch was
   *provably total*; dot-path traded that for **zero nesting**. **Open:** whether
   v2 should carry an optional value type-tag on `funding` leaves (e.g. a
   `~b`/`~n`/`~z` suffix marking boolean/number/null, and an empty-container
   marker) to restore provable totality — at the cost of a small in-band tag
   vocabulary, which v1 does not carry. v1 ships total-in-practice; this is
   the one place the design is not airtight.

3. **The key-segment escape (`\.` / `\=`) — OPEN.** A map key that contains a `.`
   (e.g. a `bin` command-name `foo.bar`) or a `=` needs the dotpath separator and
   the slot separator escaped inside the segment. The escape alphabet is **exactly
   `{ '.' , '=' }`** and nothing else — it never touches a literal backslash. The
   format uses `\.` and `\=`, composing with (running inside) the TSV escape (see
   [§ Key-segment escape](#key-segment-escape--and-)). **Open:** whether the
   backslash escape is the right choice vs an alternative (e.g. percent-encoding
   the two bytes, or a different sentinel) — the backslash reuses the byte the TSV
   layer already escapes on, which is consistent but means a key with a literal
   backslash is handled **only** by the TSV layer (`\\` on the wire), with the
   segment escape left strictly to `.`/`=`. Open question: confirming the
   layering order.

4. **Slot key names — cosmetic, still open.** Field roots are spelled out in full
   (`license` / `deprecated` / `cpu` / `os` / `libc` / `engines` / `bin` /
   `funding` / `resolution`); `bundled` is the short slot root for
   `bundledDependencies` (the slot root is `bundled`, e.g. `bundled.0=foo`,
   **not** `bundledDependencies`). Whether any
   should shorten (`lic=`, `eng=`; note `dep=` collides with the edge **kind**
   word) is a style call — the full words cost ≈0 after gzip and keep the row
   eyeball-able.

5. **Empty-residual `F` rows — RESOLVED: omit, and `<n>` counts emitted rows.**
   A tarball with an empty residual emits **no** `F` row and is **not** counted;
   `F <n>` is the number of rows **actually emitted** and always equals the emitted
   row count (see [§ F-row count](#f-row-count--counted-region-rule)). The
   key-per-tarball alternative (so `<n>` equals the total tarball count) is
   **rejected** — omitting empties keeps the region small and matches "slots present
   only when non-empty".

6. **`deprecated` storage — RESOLVED: point-in-time / source-intrinsic.**
   `deprecated` is stored **as it was when the lock was written**, never re-fetched,
   so it is **not** tier-2 packument-recoverable and is lost on an `F`-section cut
   (see [§ Two-tier degradation](#two-tier-degradation)). This is the honest
   snapshot behavior.
