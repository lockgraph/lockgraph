# `lockgraph` — native graph serialization

> Status: **preview**. No contract declared.
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

> **Status — reworked format, implementation realigned.** This is a
> ground-up redesign of the `lockgraph` body: META provenance header + three
> tab-separated tables (registries, nodes, edges), no inline checksum, plus the
> **res=/payload recomposition** layer (store the registry FACTS, derive the
> tarball-URL MECHANICS — see [§ R — registries](#r--registries) and
> [§ N — nodes](#n--nodes)). The format is still **`@lockgraph 1`** and
> **preview**: it is published only as `0.0.0-snapshot.*`, has **no external
> readers or writers** (only this library produces or consumes it), and
> **declares no compatibility contract**. There is therefore no envelope/schema-
> major bump and no breaking-change ceremony — the body is reworked **in place**.
> `src/main/ts/formats/lockgraph.ts` **already emits this form**: the spec and the
> implementation are aligned (this document is normative for both).

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
  format's own insertion order (residual keys, then the recomposed canonical
  `resolution`, then `berryChecksumCacheKey`, then `integrity` overlaid last),
  which need not match the *key insertion order* an arbitrary PM adapter chose —
  so the property is **deep-equality** (the oracle is a recursive value compare,
  e.g. vitest `toEqual`), **not** a byte-for-byte object dump. Every field —
  every `integrity` member with its origin, every residual payload key, the
  recomposed `resolution` — is present and value-equal.
- a re-serialization `serialize(g2)` is **byte-identical** to `serialize(g)`
  except for META's volatile `generatedAt` / `generator` lines (the three
  tables are canonical; see [§ Determinism](#determinism)). Note this *document*
  byte-stability is distinct from the per-payload comparison above: the document
  bytes are canonical because every field is re-encoded through this format's own
  deterministic codec, whereas the in-memory `TarballPayload` object's key order
  is not part of identity.

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
  three tables are a function of the LF-normalized model, so a CRLF file
  round-trips to the same graph.
- **Trailing newline.** Always present.

## Document layout — META + three TSV tables

A `lockgraph` document is a provenance **META** block followed by three
tab-separated **regions**, in this fixed order:

```
META          # provenance — magic, versions, generatedAt, generator
R   <n>       # registries — every external source, content-sorted
N   <n>       # nodes      — one row per node INSTANCE; root workspace pinned at index 0 when one exists, else node 0 is just the canonical-sort first node
E   <n>       # edges      — one row per edge
L   <json>    # OPTIONAL single line — graph-level LayoutHints; absent when none
```

| Region | Deterministic? | Role |
|--------|:--------------:|------|
| META | no  | volatile provenance — magic, schema, `generatedAt`, generator. Nothing here is hashed. |
| R    | yes | the registry/source table — all external origins in one place, content-sorted, referenced by index `r0`, `r1`, … |
| N    | yes | one row per node instance; line `k` **is** node `k`. The root workspace is pinned at index 0 **when one exists**; a rootless graph leaves node 0 as the canonical-sort first node (see [§ N — nodes](#n--nodes)). |
| E    | yes | one edge per row, sorted by `(src, dst, kind, alias)`. |
| L    | yes | **optional single trailing line** carrying the graph's one `LayoutHints` as canonical JSON; **absent entirely** when the graph has no layout hints (see [§ L — layout hints](#l--layout-hints)). Not a region — no `<n>` count, at most one line. |

There is **no checksum line and no seal** — see
[§ Integrity & authenticity](#integrity--authenticity) for the rationale.

### TSV encoding

The data rows of **R / N / E** are **tab-separated values**: fields are joined
by a **single** `\t`, with **no** padding and **no** column alignment in the
bytes. Aligning columns would require a two-pass width scan, waste bytes on
padding, and force the whole column to be re-padded the first time a long value
appears — so the bytes stay single-tab and ragged.

The region **headers** (`R <n>`, `N <n>`, `E <n>`) and every **META** line are
**space-separated**, not tab-separated — they are framing, not data.

**Only the four framing bytes are escaped inside a value**, since a value may
otherwise legitimately contain spaces, `:`, `/`, `@`, `+`, etc.:

| raw byte | escape |
|---|---|
| `\` | `\\` |
| TAB | `\t` |
| LF  | `\n` |
| CR  | `\r` |

Nothing else is escaped — `:` / `/` / `@` are ordinary value bytes, never split
on.

#### The `-` absent-sentinel and its collision-free escape

A **bare one-char `-`** is the **absent (`undefined`) sentinel** in a few
positions: the node `integrity` column (no integrity), the R `url` (no external
URL), and the edge **`descriptor`** field (no declared range). For the first two a
present value can **never** structurally be a lone `-` — an integrity member is
`<marker><algo>-<digest>`, a url is `https?://…` or a path — so the bare sentinel
is unambiguous there. (The edge `flags` and `alias` are **no longer positional
columns**: flags ride an **omittable cluster slot** — `o`/`w` letters, simply
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

Unknown META lines are ignored on parse (they are provenance, not graph facts).
There is deliberately **no** `checksum` / `seal` line.

### R — registries (NORMATIVE)

**Every external source the graph references is listed once, here, in one
place** — a `npm` host, a git remote, a github shorthand, a tarball host, the
`workspace` pseudo-source. Rows are referenced elsewhere by index: `r0`, `r1`, …

**R is NORMATIVE, not merely a readability index.** A node's R row is **read
back on parse to recompose** its canonical tarball URL — the omitted
`payload.resolution` union and the fragment-form `Node.resolution` are pure
functions of `(R base, name, version)` (see [§ Recomposition — store facts,
derive mechanics](#recomposition--store-facts-derive-mechanics) and
[§ N — nodes](#n--nodes)). It still also earns its place for **readability**
("all sources in one place"), but it is now a load-bearing input to the codec.

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
un-escapes both. (Earlier drafts emitted them raw on the false premise that they
were "already escaped at source" — a url with an embedded LF/CR would then have
split the row into an unparseable fragment.)

**A bad `r<idx>` reference is rejected.** On parse a node's `r<idx>` column must
match `r<non-negative-integer>` **and** resolve to an existing R row; `r999`,
`r-1`, or a non-`r` token fails with `PARSE_FAILED` (it is never silently
accepted, since the R row is a normative recomposition input).

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
Anything else rides **trailing optional slots**, each `key=value` (or the one
valueless `res` marker), present **only when non-empty**, in this fixed order —
**`ws=`, `patch=`, `src=`, `peer=`, `ck=`, `res`/`res=`, `payload=`** (a slot is
simply omitted when its source field is empty, so the present slots always
appear in this relative order). `patch=` and `src=` are adjacent because both are
**NodeId-identity** slots — they are the two TarballKey discriminators (`+patch=`
/ `+src=`) folded into the node's identity:

| Slot | When present | Meaning |
|------|--------------|---------|
| `ws=<path>` | the node is a workspace member | `Node.workspacePath`. A **root** workspace carries `ws=` with an **empty** path (and is pinned at node 0 — see below); a non-root member carries its path, e.g. `ws=packages/a`. |
| `patch=<token>` | the node is yarn-patched | the `+patch=` fingerprint ([§2 of `_common.md`](./_common.md#2-patch-slot--tarballkey-sentinel)). Stored **explicitly** — the format does **not** look through a patch to its base; it stores the base node **and** the patch node as two distinct rows. |
| `src=<16-hex>` | `Node.source` is set | the `+src=` source discriminator (ADR-0032 — the 16-hex digest that distinguishes non-registry siblings sharing `name@version`). Stored **verbatim**, **NOT re-derived**: present exactly when `Node.source` is set, absent otherwise. Like `patch=`, it is folded into the re-derived NodeId. See [§ The `+src=` slot is stored, not re-derived](#the-src-slot-is-stored-not-re-derived). |
| `peer=<ctx>` | the node is peer-virtualised | the `peerContext` (the NodeId-list block, [§4.2 of `_common.md`](./_common.md#4-reserved-vocabulary)), e.g. `peer=(react@17.0.2)`. Drives the re-derivation of this instance's NodeId. |
| `ck=<key>` | the payload carries `berryChecksumCacheKey` | the per-node yarn-berry checksum-cache-key prefix (`TarballPayload.berryChecksumCacheKey`), hoisted **out** of the `payload=` JSON into a compact dedicated slot. Stored verbatim (TSV-escaped). Reconstructed onto the payload on parse. |
| `res` / `res=<string>` | the node has a `Node.resolution` sidecar | **`Node.resolution`** — the verbatim PM-native resolution string (graph.ts `Node.resolution`, e.g. a yarn `resolved:` URL or a `git+ssh://…#<sha>` locator). This slot is **EXACT-MATCH-OR-VERBATIM** (see [§ res= omission](#res-omission--exact-match-or-verbatim)): a **bare `res`** marker (no `=`) means "the canonical **berry npm locator** `<name>@npm:<version>`, recomposed on parse"; a `res=<string>` carries any **non-canonical** resolution **verbatim**; and a canonical **URL + `#<sha1hex>`** resolution emits **no** `res` slot at all — its `#<sha1>` fragment rides the integrity column's `u`-member and the URL is recomposed from the R row. A node with **no** `Node.resolution` emits nothing here and **stays undefined** on parse (the parse never invents one). `Node.resolution` is **distinct** from the canonical `TarballPayload.resolution` union (which lives in `payload=`); both survive. |
| `payload=<json>` | the node carries residual artefact metadata | the **residual `TarballPayload`** as canonical JSON (see [§ The payload slot](#the-payload-slot)): every field not captured by a dedicated column or slot — `bin`, `engines`, `license`, `cpu`, `os`, `libc`, `funding`, `deprecated`, `bundledDependencies`, `peerDependenciesMeta`, `conditions`, and the **canonical `TarballPayload.resolution` union** *unless* that union is exactly the recomposable `{type:'tarball', url}` (then it is **omitted** and rebuilt from the R row — see [§ payload.resolution omission](#payloadresolution-omission)). `integrity` rides the dedicated column, `berryChecksumCacheKey` the `ck=` slot, and `Node.resolution` the `res` slot — none of those are in `payload=`. |

**Root pinned at index 0 — when a root exists.** When the graph **has** a root
workspace (a node with the empty `workspacePath` — the `.` importer / the
project root), node 0 is **that** root, and indices `1 … N−1` are every other
node, sorted ascending by the fully-reconstructed NodeId.

**Rootless carve-out.** A graph need **not** have a root workspace: a flat
dependency set with no importer (e.g. a `yarn-classic` `yarn.lock`, which lists
packages but declares no project node) is **rootless**. In that case there is
**nothing to pin** — node 0 is simply the **first node in the canonical sort**,
exactly like every other index, with **no** special-casing. The pin is a pure
*reordering* that moves an existing empty-path node to the front; when no such
node exists the canonical NodeId sort stands unaltered. (The `lodash`
`yarn-classic` live fixture is the witness: its node 0 is an ordinary package,
`JSV@4.0.2`, not a workspace root.) So the precise rule is: **if** an empty-path
workspace node is present it is pinned at 0; **otherwise** node 0 is just the
canonical-sort minimum — the order, and thus every edge index, stays a pure
function of the graph either way.

Indices `1 … N−1` (or `0 … N−1` when rootless) are sorted **ascending by the
fully-reconstructed NodeId string** under `cmpStr` — i.e. the exact order
`graph.ts nodes()` yields (it sorts the node-id keys with `cmpStr`). The
"fully-reconstructed NodeId" is the *complete* identity string
`name@version[+patch=…][+src=…]` with **all** slots present, followed by the
`peerContext` suffix (`(…)…`) when the node is peer-virtualised — **not**
`(name, version, peerContext)` alone. The earlier-stated `(name, version,
peerContext)` rule was wrong: it ignores the `+patch=` / `+src=` slots, so two
slot-distinguished siblings sharing `name@version@peerContext` would **tie**
(no total order) and the order would contradict this section's worked example.
Sorting on the full NodeId restores a total order and matches the model exactly.

Pinning the root at 0 (when one exists) keeps the entry point obvious
(`0` = "the project") and is still a *pure function of the graph*, because the
root is uniquely identifiable (the empty-path workspace) — so the node order, and
therefore every index used by the edge table, is byte-stable across
structurally-equal graphs. A **rootless** graph (no empty-path workspace) simply
skips the pin: node 0 is the canonical-sort first node, still a pure function of
the graph.

> **Why `react-dom@…` precedes `react@…` (worked example, nodes 6–9).** Under
> `cmpStr` (a plain code-unit `<` comparison) the NodeIds are compared
> character-by-character: `react-dom@17.0.2` vs `react@17.0.2` first differ at
> the 6th character — `-` (U+002D) vs `@` (U+0040) — and `0x2D < 0x40`, so every
> `react-dom…` NodeId sorts **before** every `react…` NodeId. This is why the
> example lists both `react-dom` instances ahead of both `react` instances; it
> is correct under the full-NodeId rule.

#### The `+src=` slot is stored, not re-derived

The `+src=` source discriminator (ADR-0032 — the 16-hex `Node.source` that
distinguishes non-registry siblings sharing `name@version`) is part of the
NodeId, and it is **stored verbatim** as the N-row **`src=` slot**, present
**exactly when `Node.source` is set** and absent otherwise. On parse it is read
**directly** off the slot and fed — together with `name`, `version`, the
`patch=` token, and the `peer=` peerContext — into `serializeNodeId` to rebuild
the NodeId. The slot mirrors `patch=`: both are NodeId-identity discriminators
the format stores rather than infers.

**Why it is stored, not re-derived.** An earlier draft re-derived `+src=` on
parse from the node's *canonical resolution* (the `TarballPayload.resolution`
union in `payload=`) via `recipe/resolution.sourceDiscriminatorOf(resolution)`,
on the theory that `Node.source` is *always* a pure function of the resolution.
That is a **derive-don't-store heuristic, and it breaks round-trip identity**:
an adapter may legitimately leave `Node.source` **undefined** on a node whose
canonical resolution **would** discriminate. pnpm-v9 is the witness — its
`jsr.io` packages (`@jsr/std__toml@1.0.11`, …) and its `codeload.github.com`
tarball deps (`@angular/domino@…`, `@angular/ng-dev@…`) carry a discriminating
resolution but **no** `Node.source`. Re-deriving from the resolution then minted
a **phantom** `+src=` (e.g. `@jsr/std__toml@1.0.11+src=90cce56103bc650b`) on the
reconstructed node that the original did not have, so `parse(serialize(g))`
diverged from `g` (the reconstructed node was an *added* node and the original a
*removed* one in the diff). Storing `Node.source` **verbatim** removes the
inference entirely: `undefined` stays absent (bare key, byte-identical to the
pre-ADR-0032 form), a set value is stored and read back exactly, and the format
re-derives only the *NodeId* — from the **stored** `(name, version, patch, src,
peerContext)` via `serializeNodeId` — never the `src` discriminator itself. This
matches the format's [store-everything](#design-rationale) posture and the way
`patch=` is already handled.

#### Recomposition — store facts, derive mechanics

The resolved tarball URL of a registry package is **not a fact, it is a
mechanism**: it is a deterministic function of the registry type, the package
name, and the version. The format therefore **stores the facts** (the R-table
registry base, the `name`, the `version`, and — where present — a `#<sha1hex>`
fragment) and **derives the mechanics** (the tarball path), instead of storing
the same URL **three times** (the R host **and** the `res=` sidecar **and** the
`payload.resolution.url`). The recomposition is pinned per registry type:

| registry type | recomposed value |
|---|---|
| **npm-class tarball URL** | `<r.url>/<name>/-/<basename>-<version>.tgz`, where `basename` is `name` with any leading `@scope/` stripped (`@vue/shared` → `shared`), optionally followed by `#<sha1hex>` |
| **berry npm locator** | `<name>@npm:<version>` |

Crucially this is **EXACT-MATCH-OR-VERBATIM**, so fidelity is never at risk: at
emit the candidate is recomposed from `(base, name, version[, fragment])` and
compared **BYTE-EXACT** to the stored value; **any** mismatch (a git URL, a
`codeload` tarball, a `jsr.io` host, a url-encoded or re-pathed URL, an aliased
locator) falls back to the **verbatim** encoding. The byte-exact comparison is
what licenses the omission: a value that recomposes to itself need not be stored.

#### `res=` omission — exact-match-or-verbatim {#res-omission--exact-match-or-verbatim}

`Node.resolution` (the verbatim PM-native resolution **sidecar string**) is
encoded under the exact-match-or-verbatim guard, with **three** mutually
exclusive outcomes plus the "never existed" case:

1. **Bare `res` marker** — when `Node.resolution` **byte-equals** the recomposed
   berry npm locator `<name>@npm:<version>`, the slot is the **valueless token
   `res`** (no `=`). On parse the locator is recomposed from `(name, version)`.
2. **`u`-member, no `res` slot** — when `Node.resolution` byte-equals
   `<recomposed canonical npm tarball URL>#<sha1hex>` (the node's R row is a
   hosted npm row and the URL recomposes exactly), the `res` slot is **omitted
   entirely** and the `#<sha1hex>` fragment rides the **integrity column's
   `u`-member** (see [§ Integrity multiset encoding](#integrity-multiset-encoding)).
   On parse the URL is recomposed from the R row and the fragment is re-appended.
3. **`res=<string>` verbatim** — any other `Node.resolution` (git locator,
   non-canonical URL, anything that does not byte-match a recomposed candidate)
   is stored **verbatim** as `res=<value>` (TSV-escaped), exactly as before.
4. **Absent — never existed** — a node whose `Node.resolution` was **undefined**
   emits **nothing**: no `res` marker, no `res=`, no `u`-member. On parse, the
   absence of *all three* triggers is the signal that the node had no resolution,
   so the rebuilt node's `Node.resolution` **stays undefined**. The parse
   **never invents** a resolution.

> **Why an explicit marker here, but not for ranges.** The owner mandated
> *derivation* for this column (unlike the `range` column, which stays verbatim),
> so a compact **explicit marker** is allowed: the distinction between
> "omitted-because-canonical" (outcomes 1 & 2 — a marker or a `u`-member is
> present) and "never-existed" (outcome 4 — *nothing* is present) must be
> **unambiguous**, because inventing a resolution on a node that never had one is
> the same failure class as the ADR-0032 phantom `+src=` bug. The marker *is*
> that disambiguator: a recompose is triggered **only** by a present marker or a
> present `u`-member, never inferred from the node's other facts. The bare `res`
> marker and a verbatim `res=` are **mutually exclusive**, and so are the `res`
> marker / `res=` slot and the `u`-member (a node cannot both carry a verbatim
> resolution *and* a recomposed-URL fragment) — the parser rejects either
> collision with `PARSE_FAILED`.

#### `payload.resolution` omission {#payloadresolution-omission}

The **canonical** `TarballPayload.resolution` union (distinct from the
`Node.resolution` sidecar above) is **omitted** from the `payload=` JSON **iff**
it is **exactly** `{ type: 'tarball', url: <recomposed canonical URL, no
fragment> }` — i.e. a two-key object whose `url` byte-equals the recomposition
from the node's hosted npm R row. On parse it is **reconstructed** from that R
row. **Any other shape** — a `git` / `directory` / `unknown` union, or a
`tarball` union carrying extra keys such as `hostingProvider`, or a `url` that
does not recompose — is kept **verbatim** in `payload=`. The hosted npm R row
existentially certifies that the node *had* a canonical tarball resolution (the R
base was derived from that very url), so the reconstruction can never mint a
`resolution` on a node that had none; a node with no hosted R row, or whose
`payload=` already carries a verbatim `resolution`, is never recomposed.

#### Integrity multiset encoding

`integrity` carries the **entire** [§3 integrity multiset with origin
tags](./_common.md#3-integrity-model) — never a single truncated hash. Each
member is `<originMarker><algo>-<digest>`; members are **joined with `;`** in
their canonical multiset (source) order:

```
integrity := <member> ( ';' <member> )*
member    := <hash> | <u-member>
hash      := <origin><algo> '-' <digest>      # a real integrity multiset member
origin    := s | z | r | c                    # 1-char origin marker
u-member  := 'u' 'sha1' '-' <40-hex>          # TRANSPORT-ONLY; at most one, always LAST
algo      := sha1 | sha256 | sha384 | sha512 | …
digest    := lowercase hex
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
> `url-fragment` sha1 (a tarball `…#<sha1hex>` locator hash) rides the
> **resolution sidecar**, **not** the integrity multiset. When a node's
> `Node.resolution` is a canonical `<recomposed npm tarball URL>#<sha1hex>` (see
> [§ res= omission](#res-omission--exact-match-or-verbatim) outcome 2), the URL is
> recomposed from the R row and dropped, and **only its `#<sha1>` fragment** is
> parked here as a single `usha1-<40hex>` member — **always the LAST member, at
> most one**. On parse it is intercepted and put **back** into the recomposed URL
> as the `#`-fragment; it is **NEVER** folded into `Integrity.hashes`, so the
> model's invariant ("a url-fragment sha1 lives on the resolution sidecar, not
> the multiset" — `_common.md` §3, `recipe/integrity.ts`) holds and `tarballs()`
> stays equal. Symmetrically, a *real* multiset `Hash` carrying
> `origin: 'url-fragment'` violates that invariant and is **REJECTED at emit**
> (it would be indistinguishable from the transport member and could not
> round-trip). The `u`-member and a verbatim `res=` / bare `res` marker are
> **mutually exclusive**; the parser rejects the collision with `PARSE_FAILED`,
> as it does a duplicate `u`-member or a `u`-member with a non-`sha1` algorithm.

`;` separates members and `-` separates algo from digest; neither occurs inside
a hex digest or an algorithm token, so the sub-field is self-delimiting within
the tab-bounded column with no further escaping. A single registry `sha512`
SRI is the common case (`s` marker, one member); a `berry-zip` checksum and an
SRI coexisting on one entry serialize as two `;`-joined members
(`zsha512-…;ssha512-…`), preserving the full multiset and the
berry-zip ≠ tarball-SRI distinction
([§3.3](./_common.md#3-integrity-model)). `-` (a bare dash) in the column means
*no integrity*.

#### The payload slot

`payload=` carries the **residual** `TarballPayload` — every field **not**
already represented by a dedicated node column or slot — as **canonical JSON**
(defined precisely below). Specifically it **excludes**: `integrity` (the
dedicated column), `berryChecksumCacheKey` (the `ck=` slot), `Node.resolution`
(a `Node` field on the `res` slot, never a `TarballPayload` field), and the
canonical `TarballPayload.resolution` union **when** it is the recomposable
`{type:'tarball', url}` shape (omitted and rebuilt from the R row — see
[§ payload.resolution omission](#payloadresolution-omission)). Everything else
that is set — `bin`, `engines`, `license`, `cpu`/`os`/`libc`, `funding`,
`deprecated`, `bundledDependencies`, `peerDependenciesMeta`, `conditions`, and a
**non-canonical** `resolution` union — goes here. This single chokepoint lets
arbitrary nested shapes — including `funding: unknown` and a verbatim `resolution`
union — round-trip identity-exact without a bespoke per-field codec, while staying
deterministic.

##### Canonical JSON {#canonical-json}

"Canonical JSON" is the byte-exact serialization used by **every** JSON-bearing
field in this format — the node `payload=` slot and the `L`
[layout-hints line](#l--layout-hints). (The edge `workspaceRange` is **no longer**
JSON-bearing: it decomposes onto the `descriptor` + `rv=` / `sp=` slots — see
[§ E — edges](#e--edges).) It is `JSON.stringify` with a fixed,
recursive key order and the same number/string conventions, so re-serializing a
round-tripped graph is byte-identical:

1. **Object keys** are sorted **recursively** in ascending **UTF-16 code-unit**
   order — JavaScript's default string ordering (`a < b` per `cmpStr`), applied
   at every nesting level. (`Array.prototype.sort` default order; same
   comparator the tables use.)
2. **Arrays** keep their element order (order is meaningful — the integrity
   multiset and any list payload such as `cpu` / `os` are positional); only
   *object* keys are reordered, never array elements.
3. **`undefined`-valued properties are dropped** (exactly `JSON.stringify`'s
   own behaviour — an `undefined` property is omitted, not emitted as `null`).
4. **`null` is preserved** verbatim as `null` (it is a value, not an absence).
5. **Numbers** use `JSON.stringify`'s default form — the shortest
   round-trippable decimal (`Number.prototype.toString`); no padding, no
   forced exponent.
6. **Strings** use standard JSON string escaping (`\"`, `\\`, `\n`, `\t`, `\uXXXX`
   for control characters, …) — i.e. the bytes `JSON.stringify` produces.
7. **Then** the [§ TSV encoding](#tsv-encoding) tab/newline/CR/backslash
   escaping is applied **on top** of the finished JSON string, since the JSON
   rides inside a tab-bounded value. (A `\t` *inside* a JSON string is already
   `\\t` after step 6; a literal TAB byte that somehow reaches the value is
   escaped to `\t` by the TSV layer. The two layers compose unambiguously
   because step 6 runs first.)

A reimplementer can produce identical bytes with
`JSON.stringify(value, recursivelySortedKeyReplacer)` (or an equivalent
sort-keys pass) followed by the TSV escape; no other normalization (whitespace
stripping, key casing, number reformatting) is applied or permitted.

A literal TAB / LF / CR inside the JSON is escaped by the
[§ TSV encoding](#tsv-encoding) rules like any other value byte; `:` / `/` / `{`
/ `}` / `,` are ordinary JSON bytes and are **not** escaped. The slot is absent
when the residual payload is empty (the common registry node, whose only
artefact fact is its single `sha512`, is just the four core columns).

> **Slot self-description.** Every optional slot is `key=value` (or the one
> valueless `res` marker), so a reader never has to count columns: the four
> positional columns then zero-or-more `ws=` / `patch=` / `src=` / `peer=` /
> `ck=` / `res`(or `res=`) / `payload=` slots, in that order.

### E — edges

One edge per row, sorted by `(src, dst, kind, alias)` — a pure function of the
graph. `src` / `dst` sort numerically; `kind` sorts by its full-word spelling
under `cmpStr` (`bundled` < `dep` < `dev` < `opt` < `peer`); `alias` is the
tertiary tiebreak for the alias-distinct sibling edges that share `(src, dst,
kind)`.

The row is **4 positional fields** followed by **omittable `key=value` / flag
slots** — the same slot design as the `N` row, with **no positional `-` padding**:

```
<srcIndex>\t<dstIndex>\t<kind>\t<descriptor>[\t<slot>…]
```

| Field | Meaning |
|--------|---------|
| `srcIndex` | source node index (decimal) |
| `dstIndex` | target node index (decimal) |
| `kind` | edge scope, the **full word**: `dep` · `dev` · `opt` · `peer` · `bundled` (see below) |
| `descriptor` | `EdgeAttrs.range` — the declared descriptor, stored **explicitly and verbatim** with the npm protocol **implicit** and every other protocol **inline** (see below); `-` when the edge declared no range |

Trailing **slots**, each **omitted when absent/false**, in this **fixed order**
(determinism) — but parse is keyed, so order is not load-bearing on the way in:

| slot | when present | carries |
|---|---|---|
| flag cluster `o` / `w` / `ow` | ≥1 boolean flag set | `EdgeAttrs.optional` (`o`) and/or `EdgeAttrs.workspace` (`w`) — the **only** valueless slot |
| `alias=<value>` | `EdgeAttrs.alias` is set | the local descriptor name (participates in edge identity — see below) |
| `rv=<value>` | the edge's `workspaceRange.resolvedVersion` is set | the concrete target-member version |
| `sp=<value>` | `workspaceRange.specifier` **differs** from the `descriptor` (the rare fallback — see below) | the canonical specifier when an adapter canonicalised it apart from the descriptor |

**`kind` is a full word, not a code.** `EdgeKind` is exactly
`{dep, dev, optional, peer, bundled}`, written out — `optional` shortens to
`opt` so it never collides with the `o` *flag* letter, the rest are the
enum names. A one-letter code is rejected deliberately: a single `p` mis-reads
as "prod" vs "peer", and gzip collapses the repeated full words to nothing on
the wire anyway, so the readable word costs ≈0 bytes compressed while keeping
the **audit scope** legible in the raw file
([§ gzip handles repetition](#design-rationale)).

**`descriptor` is explicit and verbatim, with the npm protocol implicit.** The
declared `EdgeAttrs.range` is stored as-is — **no** "derive when it equals the
resolved version" sentinel and **no** `=` shorthand, even when the range equals
the target's version. The npm protocol is **implicit**: a bare semver / range
(`^1.2.3`, `1.x`, `*`, `latest`) is stored as-is. **Every other protocol stays
inline, as the full word it appears with in the lockfile** — `workspace:*`,
`github:owner/repo#ref`, `git+https://…`, `file:../x`, `link:…`, `portal:…`,
`npm:…` — never a cryptic code. (This is the
[no-`=`-sentinel / less-heuristics](#design-rationale) posture: a verbatim,
human-legible descriptor is unambiguous and costs nothing after gzip.) `-` when
the edge declared no range (the `\-` escape from
[§ the absent-sentinel](#the---absent-sentinel-and-its-collision-free-escape)
keeps a genuine `-` descriptor round-tripping). Because the descriptor is
**positional field 4 — before any slot** — a descriptor that itself contains `=`
(a URL query like `git+https://h/r.git?ref=main`) is unambiguous and is never
mistaken for a `key=value` slot.

**`alias` participates in edge identity.** `EdgeAttrs.alias` is the **local**
descriptor name when it differs from the target node's actual name — npm-alias
deps like `"react-is-18": "npm:react-is@^18"`. It rides the **`alias=` slot**,
present **only** when set (absent for the canonical descriptor, where the
parent's dependency key already matches the target's real name). Per
[§4 of `_common.md`](./_common.md#4-reserved-vocabulary), `alias`
**participates in edge identity**: two `src → dst` edges of the **same** kind
are permitted **iff** their `alias` slots differ — so two alias-distinct
siblings to the same target are two distinct E rows.

**flags are a packed cluster slot.** The two boolean `EdgeAttrs`:

| letter | attribute |
|:--:|---|
| `o` | `EdgeAttrs.optional` |
| `w` | `EdgeAttrs.workspace` |

Packed together (`ow`) when both hold; the whole slot is **omitted** when neither
does (no `-` placeholder). `w` is **stored**, not derived from the `workspace:`
protocol in the descriptor: `EdgeAttrs.workspace` is a model field, and deriving
it would risk a phantom mismatch class. `workspace` is a **flag, not a kind** —
see below.

**`workspaceRange` is decomposed onto `rv=` / `sp=` — no JSON, no specifier
duplication.** The model type is
`WorkspaceRange = { specifier: string; resolvedVersion?: string }`. The old format
stored the **whole pair as canonical JSON** on every `w`-edge — but its
`specifier` was **byte-identical to the `descriptor`** on every edge but the rare
canonicalised one, and the JSON existed only to carry one extra value
(`resolvedVersion`). So the format now stores **nothing redundant**:

- `specifier` **IS the `descriptor`** — never stored twice. On parse the
  `workspaceRange` is reconstructed as `{ specifier: <descriptor> }` for a
  `w`-edge (plus `resolvedVersion` from `rv=` when present). The empty-string
  pending sentinel falls out naturally: a `w`-edge with an absent descriptor (`-`)
  reconstructs `{ specifier: '' }`.
- `resolvedVersion`, when set, rides the **`rv=` slot**.
- `sp=` is a **fallback** used **only** when `specifier ≠ descriptor`. That
  happens when an adapter keeps a **verbatim** descriptor but a **canonicalised**
  specifier — e.g. `bun-text` stores a descriptor `workspace:` (bare protocol)
  while its canonical specifier is `workspace:*`. The corpus round-trip is the
  oracle: across every workspace edge in the live fixtures the specifier equals
  the descriptor **except** that one bun-text shape, which emits `sp=workspace:*`.

So a `workspace:^` edge resolving to `1.0.0` is `…\tworkspace:^\tw\trv=1.0.0` (no
JSON, no `sp=`); a pending `workspace:*` edge is `…\tworkspace:*\tw`; and the
bun-text bare-protocol edge is `…\tworkspace:\tw\trv=0.0.0\tsp=workspace:*`.

#### `workspace` is a flag, not a kind

`EdgeKind` is exactly `{dep, dev, optional, peer, bundled}` — **scope only**.
There is no `workspace` kind. `workspace` is the **resolution protocol** (the
`workspace:` descriptor), which is *orthogonal* to scope: a `workspace:` link is
still a `dep` **or** a `dev`. So it rides the **flags** slot (`w`), not the
kind. Two distinct "workspace" facets must be kept apart:

| facet | where | meaning |
|---|---|---|
| node-level `workspacePath` | the `ws=` **node** slot | *this node **is** a workspace member* |
| edge-level `w` flag | the `w` **edge** flag | *this edge resolves via `workspace:`* |

A member node is the **target** of `w`-flagged edges; the `w` flag and the
`ws=` slot are independent observations of the same workspace.

#### Protocol placement

The format places each resolution / reference **protocol** where its identity
lives:

| protocol | placement | where |
|---|---|---|
| `git:` / `file:` / `link:` / `portal:` / `tarball` / registry | the **NODE** | its `r<regIndex>` source + `version` + canonical `resolution` in the payload (the same protocol, when it appears in a *declared range*, also rides the edge `descriptor` verbatim) |
| `npm:`-alias | the **EDGE** | the `alias=` slot (+ the `npm:…` descriptor) |
| `workspace:` | the **EDGE** | the `w` flag + the `workspace:…` descriptor (+ `rv=` / the rare `sp=`) |
| `patch:` | a **NODE** slot | `patch=` (the patch is a distinct node variant) |

In one line: **resolution protocols** (how the *bytes* are obtained) live on the
node; **reference protocols** (how a *consumer names* a target) live on the
edge. `workspace:` is to the edge exactly what `git:` / `file:` are to the
node, and `patch:` mints a distinct node rather than annotating an edge.

### L — layout hints

A graph carries **at most one** `LayoutHints` value (graph-level, surfaced by
`Graph.layoutHints()`; the type is currently `{ strategy?: 'isolated' |
'hoisted' | 'pnp' | 'nm-linked' }`). It is a property of the *whole* graph, not
of any node or edge, so it has no home in the per-node `N` rows. It is carried
by a single **optional** trailing line:

```
L <canonical-JSON>
```

- The line appears **after** the entire `E` region, as the **last** content
  line of the document (before the trailing newline).
- It is **absent entirely** — no `L` token, no empty line — when the graph has
  **no** layout hints (`Graph.layoutHints()` is `undefined`). Presence of the
  line is therefore itself the signal that hints exist.
- `L` is **space-separated framing** (like the region headers and META), so the
  literal token is `L`, one space, then the JSON. It is **not** a counted
  region: there is no `<n>`, and there is never more than one `L` line.
- `<canonical-JSON>` is the `LayoutHints` object encoded as
  [§ Canonical JSON](#canonical-json) (recursively key-sorted, `undefined`
  dropped, then TSV-escaped — though a well-formed `LayoutHints` contains no tab
  / newline). E.g. a pnp graph emits `L {"strategy":"pnp"}`.

On parse, the `L` line (when present) is decoded and replayed via
`Builder.layoutHints(...)` before `seal()`, so the rebuilt graph's
`layoutHints()` is identity-equal to the original's. When the line is absent the
builder's `layoutHints` is left unset (`undefined`), matching the source.

## Determinism

The body — **R / N / E** — is a **pure function of the graph**:

- every table is content-sorted (R by `(type, url)`, N by the
  **fully-reconstructed NodeId** under `cmpStr` with the root pinned at 0 when one
  exists — see [§ N — nodes](#n--nodes), E by `(src, dst, kind, alias)`);
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
reasoning, stated plainly because the previous format had one:

- **An inline hash is integrity, not a signature.** A hash stored in the same
  file it hashes catches *accidental* corruption, but it is **not** a signature:
  an adversary who edits the body simply recomputes the hash. Calling such a
  line a "seal" overclaims — it provides no authenticity against a motivated
  tamperer.
- **Its marginal value is small.** The corruption that *matters* is caught
  structurally on `parse`: the graph re-derives every NodeId from
  `(name, version, peerContext, patch, src)` and checks the
  [seal](#vocabulary) coherence invariants (peerContext ↔ peer-edge agreement,
  workspace-edge legality, the by-name/roots/incoming indices). A body that has
  been mangled fails *that*, not a byte-checksum. And the bytes in transit are
  already guarded by the transport — TLS, git content-addressing, npm
  integrity.
- **Real authenticity is an external, detached signature.** Genuine
  authenticity means signing the canonical bytes with a **private** key and
  verifying with a **public** key that is **not in the file** — a sidecar
  `.sig`, sigstore, or npm provenance. That is an **outer layer**, kept
  entirely separate from the body and never entangled in it.

**Reserved:** a future external detached-signature layer (sign the canonical
document bytes; verify against a public key kept outside the file). It would
wrap `lockgraph`, not modify the body grammar — so this preview neither emits
nor reserves any in-body slot for it.

Integrity of the *graph* is therefore **structural**: `parse` reconstructs and
seals the model, and a divergence surfaces as a parse/seal failure, not a hash
mismatch.

## Design rationale

The format optimizes, in order, for **fidelity** and **readability**, and lets
the compressor handle size. The principles, and their honest costs:

- **Store facts; derive only pure mechanics, under an exact-match guard.** The
  body stores the model's *facts* explicitly: the **full** `TarballPayload`
  residual (not a lossy subset), the **full** integrity multiset **with origin
  tags** (not one truncated hash), **verbatim** declared `range`s, **no** `=`
  "derive-when-equal" range sentinel, **no** registry canonicalization
  (`git+https` and `github:` stay distinct rows), and **no** patch look-through
  (the base node *and* the patch node are both stored). The **one** thing it
  *derives* rather than stores is the **tarball URL mechanics** — the resolved
  npm tarball path is a deterministic function of `(registry base, name,
  version)`, not an independent fact — so a canonical `Node.resolution` /
  `payload.resolution.url` is **omitted and recomposed** from the R row instead
  of stored three times (see [§ Recomposition](#recomposition--store-facts-derive-mechanics)).
  This derivation is **EXACT-MATCH-OR-VERBATIM**: the candidate is recomposed and
  compared byte-exact, and **any** mismatch keeps the verbatim form, so fidelity
  is never traded for the saving. An explicit marker keeps "omitted-because-
  canonical" distinct from "never-existed". This is a deliberate, bounded
  exception to store-everything — applied to the one column the owner mandated
  for derivation (the resolved URL), *not* to declared ranges.
- **gzip handles repetition.** We optimize the **raw** form for readability and
  correctness and let the compressor collapse the repeated tokens — `dep`,
  `r0`, recurring hosts, recurring ranges. This is why the
  [R table](#r--registries) earns its place for **readability** ("all sources in
  one place"), not for byte-savings: the repetition it removes is repetition
  gzip would have removed anyway.
- **TSV, not an aligned table.** Single-tab rows emit in one cheap pass with no
  width pre-scan; **alignment is a per-region `column -t` view**
  ([§ Reading it as a table](#reading-it-as-a-table--the-column--t-view)),
  computed by whoever wants it, not baked into the bytes.

**The honest size consequence.** Store-the-facts keeps the body faithful and
eyeball-able; the **URL recomposition** then claws back the largest single source
of duplication (the resolved tarball URL, previously stored up to 3× per node — R
host + `res=` + `payload.resolution.url`), so the **raw** file is now *smaller*
than the source lock on real corpora (e.g. backstage ≈ 0.67× raw / 0.83× gzip;
the lodash `yarn-classic` fixture dropped from ~152 KiB to ~56 KiB once every
canonical `resolved` URL collapsed to a recomposed base + a `usha1-` fragment).
Where a source is terse or non-canonical (lots of git / codeload / aliased URLs
kept verbatim) the ratio moves back toward 1.0×. Either way the priority is
unchanged — **fidelity + readability > raw size** — and the saving is a *free*
consequence of deriving a mechanism instead of storing it, never a fidelity
trade. `lockgraph` is an interchange / snapshot / diff substrate where a faithful,
eyeball-able, deterministic body is the point.

## Detection

`check(input)` is true iff the document's first token is `@lockgraph` (a leading
UTF-8 BOM is tolerated). The discriminant is unambiguous and cheap (head-only),
so `lockgraph` sits at the **top** of the converter's detect order. No PM
lockfile begins with `@lockgraph`, and a `lockgraph` document is not recognized
by any PM adapter's `check`.

## Worked example — the `peers-multi` graph

The `peers-multi` pnpm workspace: a root `.` with two members `packages/a` and
`packages/b`, depending on React 17 and React 18 respectively, which pull in
peer-virtualised `react-dom` and the shared `loose-envify` / `js-tokens` /
`object-assign` / `scheduler` chains. Serialized below **tab-expanded for
reading** — the real bytes use a single `\t` between fields, no alignment.
Digests are truncated to 16 hex for legibility; **real output carries the full
integrity multiset** (`s`-marked `sha512-…` etc.). `generatedAt` is pinned.

```
@lockgraph 1
schema 1.0
generatedAt 2026-06-09T12:00:00Z
generator @antongolub/lockfile@0.0.0
R 2
npm        https://registry.npmjs.org
workspace  -
N 12
.              0.0.0   r1   -                  ws=
js-tokens      4.0.0   r0   ssha512-RdJUflcE3cUzKiMq
loose-envify   1.4.0   r0   ssha512-lyuxPGrWfhrlem2C
object-assign  4.1.1   r0   ssha512-rJgTQnkUnH1sFw8y
packages/a     0.0.0   r1   -                  ws=packages/a
packages/b     0.0.0   r1   -                  ws=packages/b
react-dom      17.0.2  r0   ssha512-s4h96KtLDUQlsENh   peer=(react@17.0.2)
react-dom      18.2.0  r0   ssha512-6IMTriUmvsjHUjNt   peer=(react@18.2.0)
react          17.0.2  r0   ssha512-gnhPt75idqz36q0a
react          18.2.0  r0   ssha512-3IjMdb2L9QbBdWiW
scheduler      0.20.2  r0   ssha512-2eWfGgAqqWFGqtdM
scheduler      0.23.2  r0   ssha512-UOShsPwz7NrMUqhR
E 20
2   1   dep   4.0.0    -
4   6   dep   17.0.2   -
4   8   dep   17.0.2   -
5   7   dep   18.2.0   -
5   9   dep   18.2.0   -
6   2   dep   1.4.0    -
6   3   dep   4.1.1    -
6   8   dep   17.0.2   -
6   8   peer  17.0.2   -
6   10  dep   0.20.2   -
7   2   dep   1.4.0    -
7   9   dep   18.2.0   -
7   9   peer  ^18.2.0  -
7   11  dep   0.23.2   -
8   2   dep   1.4.0    -
8   3   dep   4.1.1    -
9   2   dep   1.4.0    -
10  2   dep   1.4.0    -
10  3   dep   4.1.1    -
11  2   dep   1.4.0    -
```

Decoding it:

- **META** — generation `@lockgraph 1`, model `schema 1.0`, the pinned
  `generatedAt`, and the `generator`. Nothing here is hashed.
- **R** (`r0`, `r1`): `r0` is the npm registry **base**
  `https://registry.npmjs.org` (the URL with the recomposable
  `/<name>/-/<basename>-<version>.tgz` suffix stripped); `r1` is the `workspace`
  pseudo-source with no URL (`-`). Content-sorted by `(type, url)`, so `npm`
  precedes `workspace`. R is **normative**: each registry node's canonical
  `payload.resolution` `{type:'tarball', url}` is **omitted** from its row and
  **recomposed** from `r0` + the node's `name`/`version` on parse (these pnpm
  nodes have no separate `Node.resolution` sidecar, so no `res` slot appears).
- **N** (12 nodes, line `k` = node `k`):
  - **node 0** is the root: `.` `0.0.0` `r1` (workspace source), no integrity
    (`-`), and the `ws=` slot with an **empty** path — the project root,
    unambiguous because it is index 0.
  - nodes `1 … 11` are the rest, sorted ascending by their
    **fully-reconstructed NodeId** under `cmpStr` (the `graph.ts nodes()` order;
    see [§ N — nodes](#n--nodes)). The two `react-dom` instances (nodes 6, 7)
    precede the two `react` instances (nodes 8, 9) because `react-dom@…`
    sorts before `react@…` (`-` 0x2D < `@` 0x40). The registry packages carry
    `r0` and a single `s`-marked (SRI) `sha512`; e.g. node 1
    `js-tokens 4.0.0 r0 ssha512-RdJUflcE3cUzKiMq`. A node with extra residual
    metadata trails a `payload=` slot — e.g. `react`/`object-assign` carry
    `payload={"engines":{"node":">=0.10.0"}}` and `loose-envify` carries
    `payload={"bin":"true"}` — while their canonical tarball `resolution` is
    omitted (recomposed from `r0`).
  - **nodes 4 and 5** are the workspace members `packages/a` / `packages/b`
    (`r1`, no integrity, `ws=packages/a` / `ws=packages/b`).
  - **nodes 6 and 7** are the two peer-virtualised `react-dom` instances: same
    name, *different* peer context — node 6 carries `peer=(react@17.0.2)`, node
    7 carries `peer=(react@18.2.0)`. They are distinct node rows; their NodeIds
    are re-derived from the full identity `(name, version, patch, src,
    peerContext)` on parse — here `name@version` + the `peer=` suffix, with no
    `patch=` / `src=` slots (`src` is read verbatim from the `src=` slot, absent
    here because `Node.source` is unset; see [§ N — nodes](#n--nodes) and below).
- **E** (one edge per row, sorted by `(src, dst, kind, alias)`; `kind` is a
  full word, `descriptor` verbatim, and **no `alias=` slot anywhere here** as
  every descriptor is canonical — the row stops after the descriptor):
  - `4 6 dep 17.0.2` and `4 8 dep 17.0.2` — `packages/a` (node 4) depends on
    `react-dom@17` (node 6) and `react@17` (node 8).
  - `6 8 dep 17.0.2` **and** `6 8 peer 17.0.2` — `react-dom@17` has **both** a
    `dep` and a `peer` edge to `react@17`: two rows, same `(src, dst)`,
    different `kind`. The `peer` edge is the other view of node 6's
    `peer=(react@17.0.2)` context (the two stay in sync per
    [§4.2 of `_common.md`](./_common.md#4-reserved-vocabulary)).
  - `7 9 peer ^18.2.0` — `react-dom@18`'s peer edge to `react@18` keeps its
    declared range `^18.2.0` **verbatim**, even though node 9's version is
    `18.2.0`: no `=`-derivation.
  - `2 1 dep 4.0.0` — `loose-envify` → `js-tokens`; and `8 2` / `9 2` / `10 2`
    / `11 2` are the shared `→ loose-envify` fan-in.

No edge here is optional, aliased, or `workspace:`-resolved, so **every row
stops after the `descriptor`** — there is no positional `-` padding and no
trailing slot. A `w`-flagged workspace edge would read e.g.
`0   4   dep   workspace:^   w` — the `descriptor` carries the `workspace:^`
specifier and the `w` flag follows; the `workspaceRange` is reconstructed on
parse as `{ specifier: 'workspace:^' }` **from the descriptor** (no JSON, no
duplication). With a resolved version it gains an `rv=` slot:
`0   4   dep   workspace:^   w   rv=0.0.0` → `{ specifier: 'workspace:^',
resolvedVersion: '0.0.0' }`. Only when an adapter canonicalised the specifier
apart from the descriptor (the `bun-text` bare-protocol case) does a `sp=` slot
appear: `…   workspace:   w   rv=0.0.0   sp=workspace:*`.

## What round-trips graph-identical

Every model element round-trips **identity-exact** (empty `diff` both ways,
`tarballs()` iterating the same keys in canonical order with **deep-equal**
payloads — see the [§ Defining property](#defining-property--graph-identity) for
why this is value-equality, not a byte object-dump — and a byte-stable body
re-serialize) — now **without any checksum**; integrity is structural
([§ Integrity & authenticity](#integrity--authenticity)):

- **Integrity** — the full multi-hash multiset **with origin tags** (`sri` /
  `berry-zip` / `registry` / `recomputed`), encoded in the node `integrity`
  column ([§ Integrity multiset encoding](#integrity-multiset-encoding)); a
  `berry-zip` checksum and an SRI coexist as `;`-joined members. A canonical-URL
  `Node.resolution`'s `#<sha1>` fragment rides a **transport-only `u`-member**
  here (last, at most one) and is restored into the recomposed URL on parse — it
  is **not** folded into `Integrity.hashes`, so `tarballs()` stays equal. (Per
  [§3 of `_common.md`](./_common.md#3-integrity-model); integrity is
  identity-neutral but fully preserved.)
- **`berryChecksumCacheKey`** — the per-node yarn-berry checksum-cache-key prefix,
  carried in the dedicated **`ck=` slot** (hoisted out of the `payload=` JSON) and
  reconstructed onto the payload on parse.
- **`peerContext`** — peer-virtualisation, including nested/recursive contexts
  and pnpm-v9 hashed peer-set tokens, carried in the `peer=` slot; the NodeId is
  re-derived and the seal re-validates peerContext ↔ peer-edge coherence.
- **`patch` slot** — both the canonical 128-hex form and the
  `unresolved-<64hex>` sentinel, carried in the `patch=` slot; the base node and
  the patch node are stored as **two** distinct N rows (no look-through).
- **`+src=` source discriminator** (ADR-0032) — **stored verbatim** as the
  `src=` node slot (present exactly when `Node.source` is set), **not
  re-derived**; on parse it is read directly off the slot and folded into the
  re-derived NodeId/TarballKey (see
  [§ The `+src=` slot is stored](#the-src-slot-is-stored-not-re-derived)).
  Storing it verbatim is what makes the pnpm-v9 jsr / codeload-github nodes —
  which carry a discriminating resolution but **no** `Node.source` — round-trip
  identity-exact; re-deriving would mint a phantom `+src=` on them.
- **`EdgeAttrs`** — `range` (the verbatim `descriptor` field), `optional`
  (`o` flag), `workspace` (`w` flag), `alias` (the `alias=` slot, including
  alias-distinct sibling edges to the same target), and `workspaceRange`
  reconstructed from the descriptor + `rv=` / the rare `sp=` slot (its
  `specifier` is the descriptor, never stored twice — see
  [§ E — edges](#e--edges)).
- **Workspaces** — `workspacePath` via `ws=`, **including the empty-path root
  pinned at node 0** when the graph has one (a rootless graph leaves node 0 as
  the canonical-sort first node — see [§ N — nodes](#n--nodes)).
- **Full `TarballPayload` residual** — `bin`, `engines`, `license`, `cpu` / `os`
  / `libc`, `funding`, `deprecated`, `bundledDependencies`,
  `peerDependenciesMeta`, `conditions`, and a **non-canonical**
  `TarballPayload.resolution` union (`git` / `directory` / `unknown`, or a
  `tarball` union with extra keys / a non-recomposable url) — as
  [canonical JSON](#canonical-json) in the `payload=` slot. A **canonical**
  `{type:'tarball', url}` union is **omitted and recomposed** from the R row (see
  [§ payload.resolution omission](#payloadresolution-omission)).
- **`Node.resolution`** — the PM-native resolution **sidecar string** (a `Node`
  field, distinct from the canonical `TarballPayload.resolution` union above),
  encoded **exact-match-or-verbatim** (see
  [§ res= omission](#res-omission--exact-match-or-verbatim)): a canonical berry
  npm locator collapses to the **bare `res` marker**, a canonical
  `<npm tarball URL>#<sha1>` is dropped and its fragment rides the integrity
  `u`-member, anything else is the **verbatim `res=` slot** (including
  `:`-containing locator versions), and a node with **no** sidecar emits nothing
  and **stays undefined** on parse. (Both resolution fields survive independently.)
- **`LayoutHints`** — the graph's single `Graph.layoutHints()` value, carried in
  the optional trailing **`L` line** ([§ L — layout hints](#l--layout-hints));
  the line is absent when the graph has no hints, and on parse it is replayed via
  `Builder.layoutHints(...)` so `layoutHints()` is identity-equal.

**Not serialized — diagnostics.** Adapter / seal diagnostics
(`Graph.diagnostics()`) are **not** part of the format and are **not** persisted.
They are **not** part of `Graph.diff` identity — `diff` and `seal` ignore them —
and they are **re-emitted** by the seal (`SEAL_*`) and by adapters on the next
parse/stringify, so persisting them would double-count without changing graph
identity. The defining property `parse(serialize(g)) ≡ g` is judged on
`Graph.diff` (nodes / edges / tarballs), which excludes diagnostics; a
round-tripped graph re-derives its own diagnostics on parse. There is no slot,
column, or line for them.

The defining property stays `parse(serialize(g)) ≡ g` (empty `Graph.diff` both
ways, `tarballs()` deep-equal in canonical key order, byte-stable body
re-serialize) — established **structurally**, with no stored checksum.

## Vocabulary

This spec uses the model vocabulary defined normatively in
[`_common.md` §4](./_common.md#4-reserved-vocabulary) (NodeId, peerContext,
TarballKey, Graph, edge kinds, workspaces, iteration order) and the integrity
model in [`_common.md` §3](./_common.md#3-integrity-model). The patch slot /
sentinel grammar is
[`_common.md` §2](./_common.md#2-patch-slot--tarballkey-sentinel). "Seal" is the
graph's `seal()` validation+finalization step that re-derives the secondary
indices and the `SEAL_*` diagnostics — the structural check that, in this
format, **replaces** an inline checksum.
