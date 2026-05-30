# ADR-0017 — Graph seal allows workspace→workspace incoming edges

> Status: proposed
> Date: 2026-05-06
> Amended: 2026-05-29 — §Published-self-linked workspaces (Bug #4 carve-out)

> **Status note (2026-05-29).** The header previously read `accepted`,
> contradicting the [decisions index](./README.md) which has always
> listed this ADR as `proposed`. The index is canonical; the header is
> corrected to `proposed` here. The 2026-05-29 amendment
> ([§Published-self-linked workspaces](#published-self-linked-workspaces))
> adds a narrow seal carve-out and does **not** ratify the ADR — it
> remains `proposed`.

## Context

> **Branch state.** This ADR documents the seal change implemented on
> `implementer/yarn-berry-v9-stringify-r2` (commit `1a7fdc8`); master
> integration of the §A stringify chain (which carries this seal
> relaxation) is gated on this ADR's acceptance per codex-orch
> sequencing (`orch-yarn9-stringify-r2` #1). A reader running against
> master will still see the pre-ADR strict rule at `graph.ts:360-364`;
> the relaxation is *proposed* against master and *implemented* on
> the r2 branch — accepting this ADR is the trigger to integrate.

[`spec/02-graph.md` §Sealing](../02-graph.md#sealing) currently lists
"every workspace node has no incoming edges" as a seal invariant —
absolute, regardless of edge source. The implementing rule lived in
`src/main/ts/graph.ts:360`: any incoming edge to a node with
`workspacePath !== undefined` failed seal with `INVARIANT_VIOLATION`.

That rule encodes a true property of *single-package* and *flat
workspace* projects (one root workspace, regular packages below; root
has no parents) but rejects a real and common monorepo shape:
**cross-workspace `dep`/`dev`/`optional` edges**, where one workspace
package depends on a sibling workspace package via `workspace:^`,
`workspace:~`, `workspace:*`, or an exact `workspace:<version>`
specifier (yarn-berry, pnpm, npm-2 with workspaces, bun-text). The
edge is a regular `dep` from one workspace node to another workspace
node; the spec promises round-trip parse/stringify; the seal then
rejected the only legitimate graph shape that lockfile encodes.

This surfaced concretely in the §A stringify adversary panel for
[ADR-0016](./0016-yarn-berry-v9-completeness-contract.md) (yarn-berry-v9):
the `workspace-cross-refs` fixture parses to a graph with an edge
between two workspace nodes; pre-r2 seal rejected it before the
emitter ever ran. The §A r2 commit (`graph.ts`, +9/−2) relaxed the
rule to permit incoming edges to workspace nodes when the source is
itself a workspace node. Test suite stays green at 175/175.

The relaxation is **cross-cutting**: it is not a yarn-berry-v9 emit
detail. Every adapter (npm, yarn-classic, yarn-berry-v6/v8/v9, pnpm,
bun-text) faces the same fixture class once stringify lands. The rule
belongs at the platform-invariant layer, not under §A of ADR-0016.

ADR-0010 (tarball graph-level) and ADR-0006 (peer-context) are
orthogonal. Cross-workspace edges carry no peerContext (workspaces
are never peer-virtualised, per [02-graph.md §Workspaces](../02-graph.md#workspaces))
and workspace nodes carry no tarball entry (workspaces have no
artefact bytes, per
[02-graph.md `Graph.tarball(...)`](../02-graph.md#mutator-coherence)).

## Decision

**Workspace nodes MAY have incoming edges from other workspace nodes.
Workspace nodes MUST NOT have incoming edges from non-workspace
nodes.**

A node is a *workspace node* iff `Node.workspacePath !== undefined`
(the empty string is a valid value — the root workspace's
project-relative path). This is the single, canonical predicate; the
ADR pins it. Alternative markers (resolution-string prefix
`workspace:`, builder-side flag) are **rejected** as the identifying
signal:

- `resolution: 'workspace:…'` is format-specific (yarn-berry, pnpm,
  npm-2-with-workspaces); npm-1 and yarn-classic have no such prefix.
  A graph-level invariant cannot key on a format-side artefact.
- A separate builder-side flag would duplicate state already carried
  by `Node.workspacePath`.

`Node.workspacePath` is the existing, spec-blessed marker
([02-graph.md §Workspaces](../02-graph.md#workspaces): "a known
**layout position** (path on disk relative to the project root)") and
matches the current implementation site (`graph.ts:360`).

### Seal-rule shape

For each node `n` with `n.workspacePath !== undefined`:

- For each incoming edge `e ∈ s.incoming.get(n.id)`:
  - if `s.nodes.get(e.src).workspacePath === undefined` → seal
    failure, `LockfileError({ code: 'INVARIANT_VIOLATION' })` with
    message `workspace node has incoming edges: <dst-id>` (the
    pre-ADR message text is preserved verbatim — see [#diagnostic-carrier-and-message](#diagnostic-carrier-and-message)
    below for the rationale).
- If every incoming edge's source is itself a workspace node → pass.
- If `n` has no incoming edges → pass (the common single-root case).

Edge `kind` is **not** part of the rule: a workspace→workspace edge
of any kind (`dep`, `dev`, `optional`, `peer`) is permitted by this
ADR. (`peer` between workspaces is degenerate but not illegal at the
graph layer; format adapters may reject it under their own
[Capability degradation](../02-graph.md#capability-degradation)
rules.) Edge `attrs.workspace = true` is informational
([02-graph.md §Workspaces](../02-graph.md#workspaces) "Open"
question), not a gate for the seal rule — the predicate runs on
node-side `workspacePath`, not edge-side `attrs`.

#### Diagnostic carrier and message

The diagnostic carrier is the existing `INVARIANT_VIOLATION` umbrella
code (consistent with every other seal failure in `graph.ts`); the
message text `workspace node has incoming edges: <dst-id>` is
**preserved verbatim** from the pre-ADR rule. The relaxation changes
*which* incoming edges trigger rejection (workspace→workspace now
permitted, non-workspace→workspace still fails); the message text
identifies the rejected workspace target only and does not enumerate
the offending source edge.

The path-of-least-churn rationale: the substantive contract change
is the relaxation itself, not the diagnostic taxonomy. The message
is observational; tests at `src/test/unit/graph.test.ts:175` already
match the single-id form via `/workspace node has incoming edges/`
and continue to do so without modification. Renaming the message in
lockstep would force a third implementer round (graph.ts edit + test
update) and would add no information that the error code does not
already carry. Enriching the message to include the offending source
NodeId (e.g. `<dst-id> ← <src-id>`) is a future-ADR consideration if
a consumer needs richer diagnostics; out of scope here. No new
error-code constant is added.

### Published-self-linked workspaces

> **Amendment — 2026-05-29 (Bug #4).** Added after the jest real-world
> lockfile canary. ADR-0017 stays `proposed`; this carve-out narrows
> the §Decision prohibition, it does not ratify the ADR.

#### Context — the jest canary

`facebook-jest`'s `yarn.lock` fails parse with:

```
PARSE_FAILED: seal failed: workspace node has incoming edges:
@jest/environment-jsdom-abstract@0.0.0-use.local
```

Root cause is a lockfile shape the original §Decision did not
anticipate. A **published, non-workspace** package depends on a
package *name* via a registry range, and yarn — finding a co-located
workspace under that name whose version it deems to satisfy the range
— resolves the published dependency **onto the local workspace node**
rather than fetching a registry artefact. The published→workspace
edge that results is precisely what the [§Seal-rule
shape](#seal-rule-shape) rejects.

Lockfile evidence (`src/test/resources/fixtures/real-world/facebook-jest-main-4c3091b/yarn.lock`):

- **`yarn.lock:4322`** — a single compound entry-key **fuses** three
  descriptor strings onto **one** node:
  `"@jest/environment-jsdom-abstract@npm:^30.0.0, @jest/environment-jsdom-abstract@workspace:*, @jest/environment-jsdom-abstract@workspace:packages/jest-environment-jsdom-abstract"`.
  The node's `version` is `0.0.0-use.local` and its
  `resolution` is `@jest/environment-jsdom-abstract@workspace:packages/jest-environment-jsdom-abstract`
  — i.e. a workspace node (`workspacePath !== undefined`).
- **`yarn.lock:14815-14819`** — `jest-preset-angular@npm:16.0.0`
  (`resolution: jest-preset-angular@npm:16.0.0` — a published,
  non-workspace package) declares
  `"@jest/environment-jsdom-abstract": "npm:^30.0.0"`.

The parser maps the descriptor `@jest/environment-jsdom-abstract@npm:^30.0.0`
to the fused workspace node (it appears in that node's entry-key set),
so `jest-preset-angular`'s `dep` edge resolves to the workspace
NodeId. **There is no separate published
`@jest/environment-jsdom-abstract@30.x` node, version, or checksum
anywhere in the lockfile** — the workspace node is the only resolution
yarn recorded. This is therefore an **ADR gap**, not an implementation
bug: `graph.ts` faithfully enforces the prohibition; the input is a
genuinely novel pattern.

#### Normative rule (the carve-out)

The §Decision prohibition is narrowed as follows. For a workspace
node `n` (`n.workspacePath !== undefined`) and an incoming edge `e`
whose source `s.nodes.get(e.src)` is a **non-workspace** node
(`workspacePath === undefined`):

> **A workspace node MAY have an incoming edge from a non-workspace
> node iff the edge is a _published self-link_: its source descriptor
> uses a registry protocol AND the workspace is the resolution yarn
> recorded for that descriptor. Every other non-workspace→workspace
> incoming edge remains a seal failure.**

An incoming edge `e` qualifies as a **published self-link** iff BOTH:

1. **Registry-protocol descriptor.** `e.attrs.range` carries an
   explicit *registry* protocol prefix. The qualifying protocols are
   exactly the registry-resolving ones:
   - `npm:` (yarn-berry registry range, incl. bare-semver ranges that
     adapters normalise to `npm:` — see
     [`_yarn-berry-core.ts` `normalizedEdgeRange`](../../src/main/ts/formats/_yarn-berry-core.ts)),
   - a bare semver range with **no** protocol prefix (npm / pnpm /
     bun manifests, where an unprefixed range is implicitly the
     registry). For the predicate, a bare range is treated as
     `npm:`-equivalent.

   Explicitly **non-qualifying** (these stay prohibited — see
   [#negative-cases](#negative-cases)): `file:`, `link:`, `portal:`,
   `workspace:`, `patch:`, `git`/`git+*`, `http(s):`, and any other
   non-registry scheme. A `workspace:` source descriptor is **not** a
   published self-link — a workspace-protocol edge from a
   non-workspace node is malformed and must still fail.

2. **Resolution-of-record.** The workspace node `n` is the resolution
   yarn actually recorded for `e`'s descriptor. The authoritative,
   format-faithful signal is **structural**: yarn fused the published
   descriptor (`<name>@<registry-range>`) into `n`'s compound
   entry-key (`yarn.lock:4322`), so the edge resolved to `n.id` at
   parse time. The graph already encodes this — the edge **exists**
   with `e.dst === n.id` because the parser resolved the descriptor to
   `n`. No additional re-derivation is required at seal time beyond
   confirming the edge targets a workspace node and carries a
   registry-protocol range (condition 1).

   > **Why NOT a `semver.satisfies(n.version, e.attrs.range)` check.**
   > It is tempting to phrase condition 2 as "the workspace version
   > satisfies the descriptor range". **Do not.** The workspace
   > version is yarn's local sentinel `0.0.0-use.local` (ADR-0011),
   > which does **not** semver-satisfy `^30.0.0`. The satisfaction was
   > performed *by yarn at install time* and recorded **structurally**
   > (entry-key fusion), not as a property re-derivable by a
   > parser-side semver comparison. A `semver.satisfies` gate would
   > reject the exact case this carve-out exists to admit. The
   > structural signal (the edge resolved to a workspace node) is the
   > faithful one. See [#interaction-with-adr-0011](#interaction-with-adr-0011).

#### What the resulting graph MEANS

A permitted published self-link means: **the workspace node satisfies
the published dependency.** Yarn resolved a published package's
registry-range dependency to a co-located workspace, and the graph
records that resolution verbatim. **No separate published node is
materialized** — the lockfile carries no published artefact (version,
checksum, tarball) for the depended-upon name, so there is nothing to
materialize (see [§Alternatives considered — published-self-link, B2](#alternatives-considered--published-self-link)).
The published parent and the workspace siblings now share a single
workspace target; the workspace node retains its workspace nature
(`workspacePath` is unchanged) and its own outgoing `workspace:` edges.

#### Seal-rule shape (amended)

[§Seal-rule shape](#seal-rule-shape) is refined. For each node `n`
with `n.workspacePath !== undefined`, for each incoming edge
`e ∈ s.incoming.get(n.id)` whose source is a non-workspace node:

- if `e` qualifies as a **published self-link** (registry-protocol
  range per condition 1, targeting the workspace `n` per condition 2)
  → **permit**; emit the [`SEAL_PUBLISHED_SELF_LINK`](#diagnostic)
  info diagnostic;
- otherwise → seal failure,
  `LockfileError({ code: 'INVARIANT_VIOLATION' })`, message
  `workspace node has incoming edges: <dst-id>` (unchanged — see
  [#diagnostic-carrier-and-message](#diagnostic-carrier-and-message)).

Workspace→workspace incoming edges are permitted as before (unchanged
by this amendment).

#### Implementation consequence (for the follow-up dispatch)

The seal check at **`src/main/ts/graph.ts:438-447`** (the
`hasNonWorkspaceIncoming` test at **`graph.ts:~443`**) must, **before**
throwing for a non-workspace→workspace edge, short-circuit edges that
qualify as published self-links. Sketch:

```
for each incoming edge e of workspace node n with
    s.nodes.get(e.src)?.workspacePath === undefined:
  if isPublishedSelfLink(e):           // registry-protocol range (cond. 1)
    diagnostics.push(SEAL_PUBLISHED_SELF_LINK, info, subject = n.id)
    continue                            // permit
  → INVARIANT_VIOLATION "workspace node has incoming edges: n.id"
```

**Edge metadata the seal needs — and what the Edge carries today.**

- The decision rests on the **source descriptor's protocol**. Today
  `Edge` (`graph.ts:75-80`) carries `attrs?: EdgeAttrs`, and
  **`EdgeAttrs.range` (`graph.ts:53`) already holds the descriptor
  range** — *with* its protocol prefix. The yarn-berry adapter
  normalises this at parse: `normalizedEdgeRange`
  ([`_yarn-berry-core.ts:1541-1543`](../../src/main/ts/formats/_yarn-berry-core.ts))
  keeps an explicit protocol when present and prepends `npm:` to bare
  ranges; `hasExplicitProtocol`
  ([`_yarn-berry-core.ts:1546-1551`](../../src/main/ts/formats/_yarn-berry-core.ts))
  is the exact protocol-prefix detector the seal can reuse. So for the
  jest case the edge already carries `range: 'npm:^30.0.0'`.
- **No new edge metadata MUST be threaded through for the jest case** —
  `EdgeAttrs.range` is sufficient: parse the protocol prefix off
  `e.attrs.range`, accept iff it is `npm:` (or a bare/unprefixed
  semver range, treated as registry). Condition 2 needs no extra data:
  the edge's mere existence with `e.dst` being a workspace node is the
  structural signal.
- **Caveat — verify `range` is populated on every adapter's
  non-workspace→workspace edge.** The yarn-berry path is confirmed.
  Other adapters (npm-2, pnpm, bun-text) that can fuse a registry
  descriptor onto a workspace MUST set `EdgeAttrs.range` with the
  protocol-bearing (or bare-registry) range on that edge for the seal
  to classify it. If an adapter drops the range, the seal would
  (correctly, conservatively) reject — the impl follow-up MUST audit
  range-population on each workspace-capable adapter and add a fixture
  per adapter that exercises the path. Absent a populated `range`, the
  edge is **not** a published self-link and the prohibition holds.
- **Relation to `EdgeAttrs.alias` (Bug #3).** The classifier reads
  `EdgeAttrs.range`, a sibling slot to `EdgeAttrs.alias`. They are
  independent: `alias` participates in edge **identity**
  (`graph.ts:62-67`); `range` is opaque per-instance metadata the seal
  now also reads. A published self-link **may** also be aliased (a
  published pkg could declare `"foo-alias": "npm:foo@^30"` resolving to
  a workspace `foo`); in that case the edge carries **both**
  `attrs.alias` and a registry `attrs.range`, and both the Bug #3
  identity rule and this carve-out apply independently. No new attr is
  required for the jest case; if a future fixture needs the *exact
  source descriptor protocol* preserved beyond what `range` encodes
  (e.g. to distinguish `npm:` from a bare range for round-trip), that
  is a `range`-fidelity question for the adapter, not a new seal attr.
  Cross-reference: [ADR-0017 §Diagnostic carrier](#diagnostic-carrier-and-message)
  and the Bug #3 `EdgeAttrs.alias` work.

#### Diagnostic

A new **informational** diagnostic makes the permitted carve-out
visible (the seal silently permitting a normally-prohibited edge
should be observable):

- **`SEAL_PUBLISHED_SELF_LINK`** — `severity: 'info'`,
  `subject: <workspace-node-id>`, message e.g.
  `published self-link: <src-id> →<kind> <dst-id> (range <range>) — published dependency resolved to co-located workspace`.

This is a `Diagnostic` (`graph.ts:84-89`, free-form `code: string`),
**not** a new `LockfileErrorCode` (`errors.ts:4-16` stays unchanged —
that enum is reserved for hard failures). It is emitted at seal time,
one per permitted published-self-link edge. Severity is `info`, not
`warning`: the shape is legitimate (it is what yarn recorded), so it
should not raise alarm; it is surfaced for traceability only.

> **Impl note on emission plumbing.** `validate()` (`graph.ts:413`)
> today only *reads* `s.diagnostics` (line 414) and otherwise throws;
> it does not push. The follow-up MUST confirm that a diagnostic
> pushed onto `s.diagnostics` at seal time survives to the caller
> (i.e. is observable on the returned graph / parse result) — if the
> seal path discards post-construction diagnostics, the emission point
> moves to where the edge is *constructed* (adapter parse) rather than
> where it is *validated*. Either site is acceptable; the gate is that
> the info is observable. This is an impl-routing detail, not an ADR
> decision.

#### Negative cases

The prohibition is **unchanged** for every non-registry source
descriptor. The following MUST still throw
`INVARIANT_VIOLATION "workspace node has incoming edges: <id>"`:

- a **non-workspace** node with a `link:` descriptor pointing at a
  workspace node,
- ditto `file:`, `portal:`, `patch:`, `git`/`git+*`, `http(s):`, or
  any non-registry scheme,
- a `workspace:`-descriptor edge whose **source** is a non-workspace
  node (malformed: only workspaces source `workspace:` edges).

Rationale for drawing the line at *registry* protocols: a registry
range is the only descriptor form where "resolve to a co-located
workspace under the same name" is yarn's documented, faithful
behaviour (the workspace transparently substitutes for the registry
artefact). `link:`/`file:`/`portal:` descriptors name a **specific
on-disk location**, not a name-to-resolve; a non-workspace package
link-ing a workspace is a different (and unattested) shape that should
continue to fail until a real fixture motivates it.

#### Interaction with ADR-0011

*Flagged; no conflict.* The workspace node here carries yarn's sentinel version
`0.0.0-use.local`. The carve-out deliberately does **not** semver-test
that version against the descriptor range (see the boxed note under
[#normative-rule-the-carve-out](#normative-rule-the-carve-out)); it
keys on protocol + structural resolution instead, so the sentinel
version is never on the satisfaction path. ADR-0011's
`TarballKey`/sentinel disambiguation is orthogonal: the workspace node
has no `@patch:` fingerprint and its `link:`/`portal:` sentinel
discriminator (`_yarn-berry-core.ts:209-213`) does not fire (its
`resolution` is `workspace:…`). **No conflict.**

#### Interaction with ADR-0024

*Flagged; no conflict.* [ADR-0024](./0024-optimize-phase.md)'s mark-and-sweep seeds **every**
workspace node into the live set unconditionally
([`optimize.ts:~82`](../../src/main/ts/optimize/optimize.ts):
`if (node.workspacePath !== undefined) live.add(node.id)`). A
published-self-linked workspace is therefore always live regardless of
its incoming edges; the new published→workspace edge merely makes the
published parent reachable *to* the workspace (additive). Optimize
neither sweeps the workspace nor mis-classifies it. **No conflict.**

### Multi-level peer projection (pnpm v9 transitive peers)

#### Context — the pnpm real-world canary

Parsing the pnpm-v9 lockfiles of `vuejs/core`, `vitejs/vite`, and
`nrwl/nx` all failed `seal failed: peer edges of <pkg>(<peerA>)(<peerB>)
disagree with peerContext`. The seal enforced a full-NodeId string
bijection between a node's `peerContext` and its outgoing `peer`-edge
**targets** (`graph.ts` peer-coherence block). That holds only for
**leaf** peers.

pnpm v9's NodeId-suffix grammar (ADR-0006) is **one level**: a node's
`peerContext` records **bare** `name@version` base keys taken verbatim
from the `(...)` suffix. But a peer **edge** must target a real node,
and when the peer is itself a peer-variant (a *transitive* peer-of-a-
peer, e.g. `@csstools/css-parser-algorithms@4.0.0(@csstools/css-tokenizer@4.0.0)`
— which exists in `snapshots:` only in its parenthesised form), the
edge target is that fully-qualified variant NodeId. So
`peerContext` entry `css-parser-algorithms@4.0.0` (bare) ≠ peer-edge
target `css-parser-algorithms@4.0.0(css-tokenizer@4.0.0)` (variant) →
the string bijection fails although the graph is correct.

Synthetic pnpm-v9 fixtures passed because they carry only leaf peers
(peer target is a bare node, so bare == target). The transitive-peer
structure is the real-world shape that splits the two derivations.

#### Normative rule (the refinement)

> The seal's `peer`-edge ↔ `peerContext` coherence is checked by
> **base-key projection** — each NodeId stripped of its `(...)` peer-
> context suffix (`stripPeerContextFromNodeId`) — **not** by full-NodeId
> string equality. The multiset of `stripPeerContextFromNodeId(target)`
> over a node's `peer` edges MUST equal, as a sorted set, the multiset
> of `stripPeerContextFromNodeId(entry)` over its `peerContext`. A
> `peer` edge MAY target a fully-qualified peer-variant NodeId whose
> **base key** (`name@version[+patch=…]`) appears in the node's
> `peerContext`.

The no-orphan / no-missing intent is preserved — only the matching
*granularity* changes (base key, not full id). The parser is unchanged:
`peerContext` stays bare per ADR-0006 byte-identity, and
`resolvePeerTargetById` keeps resolving edge targets to real variant
nodes. Storing resolved variant ids in `peerContext` was rejected — it
would break NodeId round-trip / pnpm byte-identity (ADR-0006).

#### Implementation consequence

`graph.ts` peer-coherence block: wrap both `e.dst` and each
`peerContext` entry in the existing exported
`stripPeerContextFromNodeId` before the length + element comparison.
`INVARIANT_VIOLATION` carrier and message text unchanged.

#### Interaction with the published-self-link carve-out

*Orthogonal, no conflict.* The Bug #4 carve-out concerns non-workspace
→ workspace **incoming** edges (`workspacePath` block, reads
`e.attrs.range`); this concerns **outgoing** `peer`-edge ↔ `peerContext`
coherence (reads `peerContext` + peer `dst`). Disjoint code paths and
fields. Workspace nodes carry `peerContext === []`, so the projection is
a no-op on them.

#### Known residue (not closed by this amendment)

Base-key projection unblocks the *transitive variant-target* class. A
distinct **workspace-peer** class remains: pnpm encodes a peer that
resolves to a local workspace as `vue@packages+vue`, whose base key does
not equal the resolved workspace NodeId `vue@<version>`. That is a
**parser-side** NodeId-resolution gap (the pnpm adapter must map the
`@<dir>+<name>` workspace-peer token to the workspace node's base key),
tracked separately — the seal projection is necessary but not sufficient
for those graphs.

#### Acceptance gates — Multi-level peer projection

1. The transitive-peer pnpm fixtures seal past the variant-target class.
2. A synthetic leaf-peer case still seals (projection == full-id for
   leaf peers — no regression).
3. A synthetic transitive peer-of-a-peer seals.
4. NEGATIVE: a node whose `peer` edge base-key is absent from
   `peerContext` still fails the seal — the coherence rule is not gutted.

## Consequences

### Positive

- **Roundtrip lands** for cross-workspace dep edges across every
  adapter that supports workspaces: yarn-berry-v9 §A stringify
  (immediate); npm-2/3, yarn-classic, pnpm, bun-text on their
  respective stringify milestones.
- **Modify-then-emit across workspaces** becomes legal at the graph
  layer (a modifier may rewrite an `app→core` workspace edge without
  the seal failing on the resulting graph).
- **Single canonical predicate** (`Node.workspacePath !== undefined`)
  closes the marker-ambiguity question for every future graph
  invariant that wants to ask "is this a workspace?".

### What does **not** change

- **Other seal invariants** stand: NodeId-vs-derived-id consistency,
  peer-edge-vs-peerContext consistency, no-duplicate-edges, no
  missing-target / missing-source, no unresolved error diagnostics
  ([02-graph.md §Sealing](../02-graph.md#sealing)).
- **Tarball semantics** (ADR-0010, ADR-0011): workspace nodes still
  carry no tarball entry; `Graph.tarball({…})` on a workspace returns
  `undefined`; `Mutator.setTarball` against a workspace's
  `(name, version)` is unaffected by this ADR (orthogonal).
- **Peer-virt semantics** (ADR-0006, ADR-0016 §C): workspace nodes
  remain non-peer-virtualised; `peerContext` of a workspace is `[]`;
  workspace NodeId is bare `name@version`. Cross-workspace edges
  carry no peerContext implications.
- **Existing parse paths**: the relaxed seal does not affect how any
  current adapter constructs its graph — none previously emitted
  workspace→workspace edges *and* expected the seal to accept them
  (those tests would have been red). Audit confirms: the change only
  unblocks shapes that were previously rejected; it does not silently
  accept shapes that were previously rejected for a *different*
  reason.

### Test-suite status

175/175 unit tests passing on the post-r2 relaxed seal
(`src/test/unit/graph.test.ts` lines 170–184 cover both the
non-workspace→workspace **rejection** and the
workspace→workspace **acceptance**). No fixture regressed.

### Acceptance gates — Published-self-linked workspaces (2026-05-29)

The follow-up impl dispatch MUST satisfy all of:

1. **Real-world canary.** `facebook-jest`'s `yarn.lock`
   (`src/test/resources/fixtures/real-world/facebook-jest-main-4c3091b/yarn.lock`)
   **parses** (no `PARSE_FAILED: workspace node has incoming edges`),
   and a `SEAL_PUBLISHED_SELF_LINK` info diagnostic is emitted for the
   `jest-preset-angular → @jest/environment-jsdom-abstract` edge.
2. **Synthetic positive.** A minimal hand-written fixture — a
   published package `p@npm:1.0.0` declaring `"w": "npm:^2.0.0"`, plus
   a co-located workspace `w` whose entry-key fuses `w@npm:^2.0.0` +
   `w@workspace:packages/w` — **parses**, with the published→workspace
   edge permitted.
3. **Negative — `link:`/`file:` still rejected.** A fixture where a
   **non-workspace** node carries a `link:` (and a second variant:
   `file:`) descriptor resolving to a workspace node **still throws**
   `INVARIANT_VIOLATION` with the verbatim
   `workspace node has incoming edges: <id>` message. The carve-out
   MUST NOT widen to non-registry protocols.
4. **Regression-neutrality.** The existing storybook / babel /
   backstage real-world fixtures and `graph.test.ts:170-184` stay
   green. By construction this carve-out only **adds** permitted cases
   (it relaxes a rejection), so it cannot turn a currently-passing
   fixture red — but the suite MUST be re-run to confirm.

## Risks

### Workspace marker ambiguity — *mitigated*

The ADR pins `Node.workspacePath !== undefined` as the sole
predicate. Adapters that build graphs MUST set `workspacePath` on
every workspace node they create; failing to do so is an adapter
bug, not a graph-layer ambiguity. The empty string (root workspace
path) is a valid value distinct from `undefined`.

### `roots()` semantics drift — *partially settled*

**Settled by this ADR.** The basic `roots()` contract is fixed by
this ADR's [§Spec amendments](#spec-amendments): `spec/02-graph.md`
§Queries now reads "NodeIds with no incoming edges (the
workspace-tree topmost node in the typical case; see ADR-0017
*roots() semantics drift* for the cross-workspace edge case)".
Under that contract, a workspace node that has an incoming
workspace→workspace edge is **not** a root — the cross-workspace
dependency strips it of root-ness for `roots()` purposes without
stripping its workspace-ness (the two predicates are orthogonal:
root-ness is "no incoming edges", workspace-ness is
`workspacePath !== undefined` per [§Decision](#decision)). The
implementation (`graph.ts` `reindex`, `s.roots`) already computes
the no-incoming-edges set; spec and code now agree.

**Open.** What `roots()` returns when **every** workspace node has
at least one incoming workspace→workspace edge — i.e. a
cross-workspace dependency closure with no source. Read literally,
the settled contract returns the empty set even though the project
has well-defined entry points (every workspace is depended on by
another). Two candidate refinements exist:

- return `[]` (literal reading; consumer responsible for falling
  back to "all workspace nodes" if it needs entry points);
- relax to "nodes whose only incoming edges are from other
  workspace nodes" (preserves entry-point semantics across
  workspace cycles).

This ADR does not pick. Both readings are coherent with the settled
contract; the literal reading is the current behaviour and stands
as the default.

**Trigger for revisiting.** When a real consumer (linker, modifier,
audit-fix flow) hits the zero-roots case on a real project fixture
and needs entry points to traverse from, this section is reopened
with the consumer's requirements as input. No follow-up ADR is
queued in advance — the open question is concrete enough to address
inline at trigger time, and pre-allocating ADR-0018 to it before a
consumer surfaces would be speculative.

### Cross-adapter regression — *audited, none found*

The pre-r2 rule was a *rejection*. Relaxing a rejection cannot turn
a previously-passing graph into a failing one; the directionality
guarantees this. Concretely:

- **npm-1, yarn-classic**: flatten workspaces under the root
  workspace; no other workspace nodes exist; rule has no incoming
  edges to a non-root workspace ever, so the check is vacuous.
- **npm-2, yarn-berry-v6/v8/v9, pnpm, bun-text**: support multiple
  workspace nodes. Cross-workspace edges exist in real lockfiles;
  pre-r2 seal *would* have rejected them — the only reason no test
  was red is no fixture exercised the path until ADR-0016 §A added
  `workspace-cross-refs`. This ADR closes the gap.

### Future tightening — *flagged*

If a future ADR finds a cross-workspace shape that *should* be
rejected at seal (a candidate: workspace cycles where one of the
edges is a `dev` edge that, on a topological install order, would
deadlock), tightening the rule is harder than relaxing it: existing
fixtures may rely on the relaxed rule. Proposed mitigation: the
ADR-0017 seal rule is the *baseline* (workspace→workspace OK,
non-workspace→workspace bad); future tightenings layer narrower
rejections on top, citing specific adapter or topology constraints,
and provide an opt-out path for the legitimate cases.

`peer` edges between workspaces deserve a specific call-out:
syntactically permitted by this ADR, semantically degenerate
(workspaces are not peer-virtualised, so the target's peerContext
will not include the source). A follow-up ADR may reject
workspace→workspace `peer` edges outright if no adapter ever emits
one. Out of scope here.

## Spec amendments

ADR-0017 text is normative; the consumer-facing surface lives in
[`spec/02-graph.md`](../02-graph.md) and MUST be amended in lockstep
with this ADR's flip from `proposed` → `accepted`:

- **§Sealing** — change the bullet
  > every workspace node has no incoming edges,

  to

  > every workspace node has no incoming edges from non-workspace
  > nodes (workspace→workspace edges are permitted; see
  > [ADR-0017](./decisions/0017-graph-seal-workspace-edges.md)),

- **§Workspaces** — amend the second bullet
  > they are *roots* of the dependency graph (no parent node)

  to

  > they are roots of the non-workspace subgraph; cross-workspace
  > `dep` / `dev` / `optional` / `peer` edges between workspace
  > nodes are permitted (see
  > [ADR-0017](./decisions/0017-graph-seal-workspace-edges.md))
  > and do not strip the target of its workspace nature.

- **§Queries** — clarify `roots()` semantics inline:
  > `roots()` returns NodeIds with no incoming edges (the
  > workspace-tree topmost node in the typical case; see
  > [ADR-0017 *roots() semantics drift*](./decisions/0017-graph-seal-workspace-edges.md#rootssemantics-drift--partially-settled)
  > for the cross-workspace edge case).

The spec amendment is a **gating item** for ADR-0017 acceptance.
Without it, the spec contradicts the implementation and the
roundtrip-emit path is undocumented.

> **Published-self-link spec touch (2026-05-29).** When the §Sealing
> bullet above is amended at acceptance, extend it to read: "every
> workspace node has no incoming edges from non-workspace nodes,
> **except a published self-link** (a registry-protocol descriptor
> resolved onto a co-located workspace; see
> [ADR-0017 §Published-self-linked workspaces](./decisions/0017-graph-seal-workspace-edges.md#published-self-linked-workspaces))".
> The carve-out rides the same gating flip; it does not require a
> separate spec pass.

## Alternatives considered — published-self-link

Three options were surfaced for Bug #4. The amendment adopts **B1**.

- **B1 — permit the edge (ADOPTED).** Relax the seal to permit a
  non-workspace→workspace incoming edge iff its source descriptor
  uses a registry protocol (`npm:`/bare) and the workspace is the
  recorded resolution. This is the most faithful representation of
  what yarn did — it resolved a published dependency to the local
  workspace; the workspace node **is** the legitimate resolution
  target. Narrowest carve-out, regression-proof (it only *adds*
  permitted cases), zero parser change. See
  [§Published-self-linked workspaces](#published-self-linked-workspaces).

- **B2 — materialize a synthetic published node (DEFERRED).** The
  parser would split the fused entry into a distinct synthetic
  published node `@jest/environment-jsdom-abstract@30.x` **plus** the
  workspace node, routing registry-range edges to the published one
  and preserving the original seal invariant verbatim. **Deferred,
  not chosen for v1**, because:
  - it is a **heavy parser change** touching every workspace-capable
    adapter's parse *and* round-trip (the synthetic node must
    serialise back to the same fused entry-key, or round-trip
    breaks);
  - the source lockfile carries **no published version, checksum, or
    tarball** for the depended-upon name — yarn never fetched one — so
    the materialized node would be **synthetic**, contradicting what
    yarn actually resolved (a workspace). B1 records the truth; B2
    records a fiction that happens to satisfy the old invariant.

  **Take B2 only if** a future fixture genuinely needs a *materialized
  published node* distinct from the workspace (e.g. a project that
  both link-resolves a published dep to a workspace *and* installs a
  separate registry copy of the same name@version elsewhere in the
  tree). No such fixture exists today; revisit on trigger.

- **B3 — permit + reclassify via informational attr.** Permit the
  edge (as B1) but additionally stamp a reclassifying `EdgeAttrs` flag
  to mark it. **Rejected**: more machinery than B1 for the same
  observable outcome — the [`SEAL_PUBLISHED_SELF_LINK`](#diagnostic)
  info diagnostic already provides traceability without a new
  identity-bearing attr.

## Out of scope

- **Implementation changes** to `src/main/ts/graph.ts` (already
  landed in r2 at line 360; ADR documents what shipped).
- **`roots()` zero-roots edge case** (open; trigger-on-demand — see
  [#rootssemantics-drift--partially-settled](#rootssemantics-drift--partially-settled)).
- **ADR-0016 amendments** — ADR-0016 stays `accepted`; this ADR is
  parallel, not a supersede.
- **Other graph invariants** — peer-virt, tarball, sentinel,
  bundled-deps remain unchanged.
- **Edge-kind-specific rejections** for cross-workspace edges (e.g.
  `peer` between workspaces) — future ADRs if a concrete case lands.
- **B2 (synthetic published node)** — deferred; see
  [#alternatives-considered--published-self-link](#alternatives-considered--published-self-link).
- **The published-self-link _implementation_** (`graph.ts:~443`
  short-circuit + `SEAL_PUBLISHED_SELF_LINK` diagnostic + fixtures) —
  separate follow-up dispatch; this amendment is spec-only.

## Links

- [02-graph.md](../02-graph.md) — graph contract (consumer-facing
  surface; amended per [#spec-amendments](#spec-amendments))
- [ADR-0010](./0010-tarball-payload-graph-level.md) — tarball
  graph-level (orthogonal; workspace nodes carry no tarball entry)
- [ADR-0016](./0016-yarn-berry-v9-completeness-contract.md) —
  yarn-berry-v9 completeness contract (the surfacing context;
  §A stringify adversary panel is the source of the relaxation)
- `src/main/ts/graph.ts:360` — current seal-rule implementation
  (post-r2)
- `src/test/unit/graph.test.ts:170–184` — positive and negative
  seal-rule cases

Published-self-link amendment (2026-05-29):

- `src/main/ts/graph.ts:438-447` — seal check (`hasNonWorkspaceIncoming`
  at ~443) the impl follow-up short-circuits for published self-links
- `src/main/ts/graph.ts:52-80` — `EdgeAttrs.range` (line 53, already
  carries the protocol-bearing descriptor range) and `Edge` shape
- `src/main/ts/formats/_yarn-berry-core.ts:1541-1551` —
  `normalizedEdgeRange` / `hasExplicitProtocol`: range normalisation
  (bare → `npm:`) and the protocol-prefix detector the seal reuses
- `src/main/ts/errors.ts:4-16` — `LockfileErrorCode` enum (unchanged;
  `SEAL_PUBLISHED_SELF_LINK` is a `Diagnostic` code, not added here)
- `src/main/ts/optimize/optimize.ts:~82` — workspace nodes seeded live
  unconditionally (ADR-0024 interaction; no conflict)
- `src/test/resources/fixtures/real-world/facebook-jest-main-4c3091b/yarn.lock:4322,14815-14819`
  — Bug #4 canary evidence
- [ADR-0011](./0011-tarball-key-disambiguation.md) — sentinel /
  `TarballKey` disambiguation (`0.0.0-use.local`; why the carve-out
  keys on structure, not `semver.satisfies`)
- [ADR-0024](./0024-optimize-phase.md) — optimize phase (workspace
  nodes always live; no GC hazard from the new edge)
- Bug #3 `EdgeAttrs.alias` work — sibling edge metadata; `range` and
  `alias` are independent slots, both may apply to one edge
