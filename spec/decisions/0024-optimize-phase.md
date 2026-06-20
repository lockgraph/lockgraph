# ADR-0024 — Optimize phase: orphan garbage collection (monotone-reductive)

> Status: accepted
> Date: 2026-05-25

> Closes the gap explicitly deferred by
> [ADR-0023 §8.4 step 4](./0023-graph-modification-and-completion.md#84-integration-with-adr-0008-pipeline):
> a post-completion, pre-stringify phase that removes orphaned
> nodes produced by `replaceVersion` (merge branch),
> external-source graphs, and future no-GC modifiers.

## §1 Context

### §1.1 The §8.4 step-4 deferral (the charter)

ADR-0023 ratified the modifier-completion contract but explicitly
deferred orphan garbage collection to a separate phase. The
normative deferral appears at §8.4 step 4 of ADR-0023:

> **4. Optimize** — GC orphans (nodes with zero in-edges after the
> complete step, excluding workspace nodes per ADR-0017). This is
> `removeDependency`'s recursive-GC semantics (§3.2) applied
> graph-wide.

and at §4 (tree completion algorithm), the **Phase responsibility
— normative** clause:

> Completion is **monotone-additive ONLY**: it adds nodes and
> edges, never removes. The post-modifier graph may carry orphans
> (nodes whose only in-edges were just removed by `replaceVersion`
> merge or `removeDependency`); GC of those orphans is the
> **optimize phase** (§8.4 step 4 / ADR-0008 fixpoint, owned by
> `removeDependency` semantics in §3.2), NOT completion.

That phase had no specification or implementation at ADR-0023
commit time. ADR-0024 supplies both contractually (this ADR) and
opens the implementer round for `src/main/ts/optimize/`.

### §1.2 Why orphan GC cannot fold into completion

The split is not stylistic — it is a **lattice invariant** for
ADR-0008's fixpoint loop. The loop converges because each
contributor moves the graph in at most one direction on the
information-content lattice: `enrich` and `complete` are
monotone-additive (ADR-0008 *Convergence requirements*; ADR-0023
§4); modifiers are eventually-idempotent (ADR-0023 §3.4). If
completion also removed nodes, a single pass would enlarge AND
shrink the node set, the convergence argument collapses, and the
per-pass "did anything change" hash trail becomes the only
signal.

Splitting **monotone-additive** (`complete`) from
**monotone-reductive** (`optimize`) keeps each phase on its own
side of the lattice. The chain becomes modify (eventually-
idempotent) → complete (additive) → optimize (reductive) →
enrich (additive); each pass moves in one direction; the
fixpoint is the join where none moves.

### §1.3 The visible symptom: "surprising" diffs

Concretely, the gap is user-visible. Sister-session feedback
against snapshot.45 audit-fix probes reported "visually surprising"
diffs from the stringify side: after `replaceVersion` follows the
merge branch (target NodeId already exists), the old NodeId's node
remains in the graph with zero incoming edges, and the next
stringify projects it back into the output lockfile as a stranded
entry alongside the new version. Composite-key adapters (npm-3
`packages` map, pnpm-v9 `packages:` section) render both versions
side-by-side, suggesting the modifier "added" a version it actually
replaced.

The same symptom recurs in three flows ADR-0023 supports:

| Flow | Orphan source |
|------|---------------|
| `replaceVersion` (merge branch) | The old NodeId is removed at the end of the merge transaction but only after incoming edges are retargeted to the surviving target. The transaction itself does not GC further along the dependency chain — if the merged-out node had transitive deps whose only consumers were just removed, those become orphans too. |
| `removeDependency` | Drops the consumer's outgoing edge. ADR-0023 §3.2 step 2 mandates **inline** recursive GC: if the target now has zero incoming edges and is non-workspace, `removeDependency` recursively removes it and repeats for its previous out-edges. The shipped implementation honours this (`src/main/ts/modify/remove-dependency.ts` `gcOrphans` at line 107). Under canonical use this flow's residual orphan trail is therefore **empty**; optimize's role for this row is a **safety net** for paths that bypass the modifier surface — external-source graphs (parse / load) that never ran a modifier, future modifiers that emit orphans without inline GC, and partial / interrupted transactions. ADR-0023 §8.4 step 4 frames optimize as "removeDependency's recursive-GC applied graph-wide" — i.e. generalisation of the same semantics, not replacement. |
| `filterLicense` (strict mode) | Routes through `removeDependency` per node; the `gcOrphans` function at `src/main/ts/modify/filter-license.ts:174` inline-GCs orphans same as `removeDependency` — **not a safety-net case** for optimize (no residual orphan trail under canonical use). |
| `filterLicense` (`diagnostic-only` mode) | Does not delete; the orphan trail is empty, but the strict-mode follow-up (when a CI gate escalates) will produce it. |

None of these flows can fix the orphan trail in-modifier without
violating the ADR-0023 §4 phase-responsibility clause (completion
is monotone-additive) or duplicating the GC logic per modifier
(violating ADR-0023 §3 orthogonality). The optimize phase is the
single canonical sweep that all flows defer to.

### §1.4 Where optimize sits

Per ADR-0008 fixpoint semantics and ADR-0023 §8.4:

```
parse → [modify → complete → enrich → optimize]* → stringify
        \________________ one iteration ________/
```

Optimize runs **between** completion and convergence-check. The
sequence inside one iteration is fixed by ADR-0023 §8.4: mutate →
complete → enrich → optimize → converge. This ADR adopts that
ordering verbatim — optimize is the last reductive pass before the
fixpoint check.

## §2 Decision

The optimize phase is a **monotone-reductive** sweep that removes
unreachable nodes from the graph. It is invoked once per ADR-0008
fixpoint iteration, after completion (and enrich) settles. The
phase emits diagnostics for every removal; subsequent iterations
of the loop may produce no orphans, in which case optimize emits a
single `OPTIMIZE_NOOP` and the convergence check signals the
loop's exit.

Normative pins:

- **Position**: post-completion, pre-stringify, between fixpoint
  iterations (ADR-0008 / ADR-0023 §8.4).
- **Direction**: monotone-reductive. Optimize never adds nodes,
  edges, tarball entries, peer-context entries, or diagnostics that
  represent additions. Diagnostic emission is itself additive (the
  result Graph carries new `OPTIMIZE_*` records via
  `Graph.diagnostics()` per ADR-0023 §8.6 surface), but no
  structural state of the graph grows.
- **Determinism**: optimize iterates the graph in content-sorted
  order per ADR-0007. The `removed` list (§3) is therefore
  deterministic on the input graph.
- **Idempotence**: `optimize(optimize(g))` returns a graph
  byte-identical to `optimize(g)` modulo a single additional
  `OPTIMIZE_NOOP` diagnostic on the second call. The `removed`
  list is empty on the second call.
- **Workspaces (ADR-0017)** are NEVER collected. A workspace node
  (`Node.workspacePath !== undefined`) is implicitly a root for
  reachability — even if no other workspace depends on it, it
  remains in the graph. When an entire workspace subgraph is
  unreachable from any other workspace, the phase emits
  `OPTIMIZE_WORKSPACE_UNREACHABLE` (warning) per such workspace
  node but does not remove it.
- **Sentinel-keyed nodes (ADR-0011)** ARE collected if unreachable
  — they have no special protection. Normatively: the
  `unresolved-…` sentinel marks "lossy origin", NOT "preserve
  forever". The Mutator's `removeNode` is permitted against
  sentinel-keyed nodes (ADR-0011:301-304 carve-out for pure
  deletion ops; `graph.ts:248-265` aligns with this), and the
  accompanying `removeTarball` of the sentinel-keyed `TarballKey`
  is likewise permitted. The optimize phase exercises that
  carve-out without prejudice.

## §3 Public API surface

```ts
// @antongolub/lockfile/optimize
export function optimize(
  graph:    Graph,
  options?: OptimizeOptions,
): OptimizeResult

export interface OptimizeOptions {
  /** ADR-0023 §7.5 — stream diagnostics as they fire. */
  onDiagnostic?: (d: Diagnostic) => void
  /** Additional NodeIds the caller marks as roots (orchestrator-level
   *  preservation; rare — workspaces are implicit roots and do not
   *  need this hook). Empty by default. */
  preserve?:     ReadonlySet<NodeId>
}

export interface OptimizeResult {
  graph:      Graph
  /** Content-sorted (ADR-0007) NodeIds removed by this call. Empty
   *  iff the input was already optimal. */
  removed:    NodeId[]
  /** All diagnostics this call emitted, in emission order. */
  unresolved: Diagnostic[]
}
```

### §3.1 Synchronous, not async

`optimize` is **synchronous**. Justification:

- The phase consults the graph alone — no `RegistryAdapter`,
  no `CacheAdapter`, no filesystem.
- ADR-0023 §8.3's async amendment applies to modifier primitives
  because they may await `registry.resolve` / `registry.packument`.
  Optimize has neither dependency.
- The Mutator's `graph.mutate(transaction)` is synchronous
  (`graph.ts:670`). The phase composes one or more `mutate` calls
  back-to-back; a Promise wrapper would add ceremony without
  affording any I/O hook.

Orchestrator code that runs `optimize` inside an async fixpoint
loop simply awaits the upstream modify / complete and then calls
`optimize` directly:

```ts
const completed = await completeTransitives(modifiedGraph, ctx, seed)
const optimized = optimize(completed.graph)
```

If a future opt-in (e.g. caller-supplied async predicate for
custom-root marking) demands async, that demand triggers a
follow-up ADR; the v1 surface is sync.

### §3.2 Package layout

```
src/main/ts/
└── optimize/
    ├── index.ts             # public re-export (`export { optimize }`)
    ├── optimize.ts          # §4 algorithm — mark-and-sweep BFS
    └── diagnostics.ts       # OPTIMIZE_* code constants + helpers
```

Public subpath: `@antongolub/lockfile/optimize`, in line with
existing `@antongolub/lockfile/modify` and
`@antongolub/lockfile/complete`.

The `optimize/` directory MUST NOT import from `modify/` or
`complete/` — the phase is intentionally agnostic of which
upstream flow created the orphans. It reads `Graph` and writes a
new `Graph` via `graph.mutate`.

## §4 Algorithm (NORMATIVE)

Mark-and-sweep BFS from roots:

```
function optimize(graph, options = {}):
  preserve = options.preserve ?? new Set()

  // Phase 1 — mark.
  // Live set seeds: every workspace node (the canonical
  // preservation set per ADR-0017) PLUS the caller's `preserve`
  // set. We do NOT seed from `graph.roots()`: in the post-modify
  // state (§1.3 row 1) the `replaceVersion` merge branch strands
  // the old NodeId as a zero-incoming root, so `graph.roots()`
  // conflates "topological roots" with "orphans the sweep must
  // collect" — seeding from it would defeat the very §1.3 / §9.2
  // gate 2 use case this phase exists for. Workspaces give us
  // the caller-intended root set; `preserve` adds caller pins.
  live: Set<NodeId> = new Set()
  for node in graph.nodes():
    if node.workspacePath !== undefined: live.add(node.id)
  for id in preserve:                    live.add(id)

  frontier: Queue<NodeId> = Queue(Array.from(live))

  while frontier non-empty:
    cur = frontier.dequeue()
    // Out-edge reachability — every kind contributes:
    // 'dep', 'dev', 'optional', 'peer'.
    for edge in graph.out(cur):
      if !live.has(edge.dst):
        live.add(edge.dst)
        frontier.enqueue(edge.dst)
    // Peer-context reachability — defensive complement to
    // out('peer') (the seal keeps them in lockstep per
    // graph.ts:418-425; see §4.2).
    node = graph.getNode(cur)
    if node !== undefined:
      for peerId in node.peerContext:
        if !live.has(peerId):
          live.add(peerId)
          frontier.enqueue(peerId)

  // Phase 2 — sweep.
  // Iterate graph.nodes() in content-sorted order per ADR-0007.
  // GraphImpl.nodes() already sorts by NodeId (graph.ts:453-459).
  removed: NodeId[] = []
  diags:   Diagnostic[] = []
  next:    Graph        = graph

  for node in graph.nodes():
    if live.has(node.id): continue

    if node.workspacePath !== undefined:
      // Defensive — §4.1 marks every workspace, so this branch
      // is unreachable under the v1 mark policy. Kept for
      // normative clarity: workspace preservation is invariant.
      diags.push(OPTIMIZE_WORKSPACE_UNREACHABLE({ id: node.id }))
      continue

    // Remove inside ONE mutate transaction — removeNode +
    // removeTarball + m.diagnostic, per §4.4 atomicity.
    next = next.mutate(m => {
      for inc in next.in(node.id):
        m.removeEdge(inc.src, node.id, inc.kind)
      m.removeNode(node.id)
      const inputs = { name: node.name, version: node.version, patch: node.patch }
      if next.tarball(inputs) !== undefined:
        m.removeTarball(inputs)
      const d = OPTIMIZE_NODE_REMOVED({ id: node.id, name: node.name, version: node.version })
      diags.push(d)
      m.diagnostic(d)
    }).graph

    removed.push(node.id)

  if removed.length === 0:
    const d = OPTIMIZE_NOOP()
    diags.push(d)
    next = next.mutate(m => { m.diagnostic(d) }).graph

  return { graph: next, removed, unresolved: diags }
```

### §4.1 Reachability — root set

The BFS root set is `workspaces ∪ preserve`:

- **All workspace nodes** — workspaces are always roots per
  ADR-0017. The mark phase adds every workspace node explicitly,
  so a cross-workspace edge that strips one workspace of
  `graph.roots()` membership (the ADR-0017 §Risks "roots()
  semantics drift — partially settled" case) still keeps it
  live. This is the canonical caller-intended root set.
- **`preserve`** — caller-supplied NodeIds. Rare; the orchestrator
  may use this to retain explicitly-pinned nodes during
  exploratory flows (e.g. a CLI `--keep <node>` flag). Empty by
  default.

Why not `graph.roots()`. The topological "zero-incoming-edges"
notion that `graph.roots()` exposes is the WRONG abstraction at
this layer: in the post-modify state this phase sweeps (§1.3
row 1), the `replaceVersion` merge branch strands the old NodeId
as a zero-incoming node, so it appears in `graph.roots()`
alongside the consumer's top-level package. Seeding from
`graph.roots()` would mark that orphan live and defeat the §1.3
/ §9.2 gate 2 acceptance test. Workspaces are the caller-
preserved root set; `preserve` extends it; `graph.roots()` is
not consulted by optimize.

**Rootless graphs (r3 amendment).** The root set
`workspaces ∪ preserve` is empty when a graph carries no
workspace nodes and the caller passes no `preserve` — the shape
of a non-workspace (classic) lockfile, where every top-level
dependency is a bare package with no `workspacePath`. A literal
sweep would then mark nothing live and remove every node,
destroying the graph. With no root anchor the phase cannot
distinguish a wanted top-level dependency from an orphan (both
are zero-incoming nodes), so it does NOT sweep: it keeps every
node, emits `OPTIMIZE_NO_ROOTS` (§6), and returns the graph
unchanged. A caller that wants orphan GC on a rootless graph
supplies the real roots via `preserve` — the guard then stands
down and the normal mark-and-sweep runs. An empty graph (zero
nodes) has nothing to protect and falls through to the §4
`OPTIMIZE_NOOP` epilogue.

### §4.2 Reachability — edge kinds and peerContext

Every out-edge kind (`'dep'`, `'dev'`, `'optional'`, `'peer'`)
contributes to reachability. The phase does NOT filter by kind —
a node reachable only via a `peer` edge is live, because
removing it would orphan the consumer's peer slot and violate
ADR-0006 peer-context coherence.

`node.peerContext` walking is the defensive complement: the
graph's seal invariant (`graph.ts:418-425`) keeps peerContext in
lockstep with `peer` out-edges, so walking `out('peer')` already
covers it. The explicit `peerContext` walk in the algorithm is
defence-in-depth — future Mutator extensions that decouple the
two would still keep optimize reachability correct without an
algorithm rewrite. Cost is `O(|peerContext|)` per node which is
bounded by the same invariant.

### §4.3 Sentinel-keyed nodes — explicit policy

The Mutator's sentinel-mutation refusal (the
`refuseSentinelMutation` helper documented at `graph.ts:248-265`,
ADR-0011 §Mutator coherence) blocks **byte-modifying** ops on
sentinel-keyed entries: `replaceNode` of the patched node,
`setTarball` against the sentinel key, `replacePeerContext`.
**Pure-deletion ops are explicitly carved out** per ADR-0011
§301-304: `removeTarball` against a sentinel key is permitted,
and the same logic extends to `removeNode`. The carve-out is
observable in the implementations themselves —
`removeNode` (`graph.ts:690-706`) and `removeTarball`
(`graph.ts:789-795`) contain no `refuseSentinelMutation` call,
which is the operational proof that pure deletion is unguarded
(rationale documented at `graph.ts:248-265`).

Therefore: when optimize encounters an unreachable sentinel-keyed
node, it MAY remove it. The phase does not emit a sentinel-
specific warning — the removal is a normal `OPTIMIZE_NODE_REMOVED`
event with the node's NodeId on the subject. Callers who need to
preserve sentinel-keyed nodes (e.g. a CI gate that requires the
operator to acknowledge each loss) use the `preserve` option.

### §4.4 Removal atomicity

For each removed node the phase invokes one
`graph.mutate(transaction)` carrying:

1. `removeEdge` for every remaining incoming edge (defensive —
   orphans have zero incoming by construction, but a caller-
   supplied `preserve` set may keep an intermediate node alive
   whose edges into a downstream unreachable node still need
   dropping before `removeNode`).
2. `removeNode(id)` — structural removal; the Mutator's
   "zero incoming" invariant (`graph.ts:690-696`) is satisfied
   by step 1.
3. `removeTarball(inputs)` — payload entry, if present. Lookup
   via `next.tarball(inputs)` honours `toTarballKey`
   canonicalisation per ADR-0011.
4. `m.diagnostic(d)` — `OPTIMIZE_NODE_REMOVED` lands on
   `Graph.diagnostics()` (ADR-0023 §8.6 read channel).

Per-node atomicity (one mutate call per node) is the v1
contract. Batching the entire sweep into one transaction is a
future performance ADR.

### §4.5 Iteration order

`graph.nodes()` returns NodeIds in content-sorted order
(`graph.ts:453-459`, ADR-0007). The sweep loop iterates over
this order. Because the live set is computed once before the
sweep, the order in which unreachable nodes are removed has no
semantic effect — it only fixes the `OPTIMIZE_NODE_REMOVED`
emission order. Pinning that order to content-sort makes
`OptimizeResult.removed` byte-stable across runs.

**Snapshot semantics — normative.** Iteration is over
`graph.nodes()`, i.e. the captured input snapshot, NOT over
`next`'s evolving state. The live-set computed at §4.1/§4.2
against the input `graph` remains the sole oracle of liveness
throughout the sweep; `next` is the cumulative result of
per-node `mutate` calls and is never re-examined for reachability
mid-sweep. This is the immutable-graph idiom: `graph` is the
read source, `next` is the write target, and the loop body's
`if live.has(node.id): continue` consults the pre-computed set
rather than `next`'s current edges. The coherence argument is
straightforward — removing a node can only shrink reachability,
so anything live against `graph` remains live against any
intermediate `next`; nothing the sweep does can promote a dead
node to live.

## §5 Composition with the ADR-0008 fixpoint loop

One fixpoint iteration runs (per ADR-0023 §8.4, now amended to
include optimize as its own step):

```
graph_0 = parse(input)

iteration:
  graph_a = await dispatchModifier(graph_n, primitive)     # ADR-0023 §3, §8.3
  graph_b = await completeTransitives(graph_a, ctx, seed)  # ADR-0023 §4 (monotone-additive)
  graph_c = enrich(graph_b)                                # ADR-0008 monotone-additive
  graph_d = optimize(graph_c)                              # THIS ADR — monotone-reductive

  if hash(graph_d) === hash(graph_n): exit                 # ADR-0008 convergence
  graph_n+1 = graph_d
```

### §5.1 Why optimize runs after enrich

Enrich is monotone-additive (only fills empty fields on existing
nodes; ADR-0008). Optimize's reachability question depends on
edge topology, not on field population. The ordering
`enrich → optimize` is not load-bearing; the reverse also works.
The chosen order matches ADR-0023 §8.4. The mild empirical
argument is "fill before sweep" — a removed node's enrich work
is wasted only when the modifier orphaned it in the same
iteration (rare).

### §5.2 Convergence guarantee

Fixpoint terminates because: modifiers are eventually-idempotent
(ADR-0023 §3.4); `complete` / `enrich` are monotone-additive
(stabilise after closure is wired / fields are filled);
`optimize` is monotone-reductive AND idempotent (once orphans
are removed, the live set is identical, the next call emits
`OPTIMIZE_NOOP`). Each pass moves the graph in at most one
direction on the lattice. ADR-0008's iteration cap (default 8)
and `PIPELINE_DIVERGED` guard remain in force.

### §5.3 Cross-iteration cascades

A modifier that orphans a node may trigger a cascade across
iterations:

- Iteration N: modifier removes edge `A → B`; B becomes an
  orphan; complete adds nothing for B (its frontier excludes
  recently-orphaned per ADR-0023 §4.1); optimize removes B.
- Iteration N+1: removing B made `B → C` disappear, so C now
  has zero in-edges (if C had no other consumers). Optimize
  on iteration N+1 detects this and removes C.
- ... and so on until the orphan trail terminates.

Each cascade step is one fixpoint iteration. The cascade is
bounded by `|nodes|` and well within the default iteration cap;
real audit-fix flows produce shallow cascades (1–3 levels).

## §6 Diagnostic taxonomy (`OPTIMIZE_*`)

Per ADR-0023 §7.3 Diagnostic shape; subjects per §7.3 conventions
(NodeId / `'graph'` literal). All `OPTIMIZE_*` codes are
graph-mutation events.

| Code | Severity | Subject | When emitted |
|------|----------|---------|---------------|
| `OPTIMIZE_NODE_REMOVED` | info | NodeId | once per removed node; message includes `name@version` for grep-ability per ADR-0006 readability rationale |
| `OPTIMIZE_WORKSPACE_UNREACHABLE` | warning | NodeId | **Reserved code; v1 never emits.** The §4.1 explicit-workspace-mark step unconditionally adds every workspace to the live set, so the §4 sweep branch that would emit this diagnostic is dead under the v1 algorithm. The code is declared in the taxonomy so future opt-in mark-policy tightenings — e.g. a hypothetical `policy: 'strict-workspaces'` option that drops the implicit workspace mark from §4.1 and forces explicit reachability — can emit it without enlarging the diagnostic surface. Under any such future policy, emitting this on a real audit-fix run is a topology smell — flag it but do not abort. v1 callers can safely ignore this code in switch statements over `OPTIMIZE_*`. |
| `OPTIMIZE_NOOP` | info | `'graph'` | once per `optimize(graph)` call when `removed.length === 0`. Useful for fixpoint convergence detection — an iteration with `OPTIMIZE_NOOP` confirms the reductive phase is stable; combined with the upstream additive phases also being stable, the loop exits |
| `OPTIMIZE_NO_ROOTS` | warning | `'graph'` | **r3 amendment.** Once per `optimize(graph)` call when the mark phase finds an empty live set on a non-empty graph — no workspace nodes and an empty `preserve`. The phase keeps every node and returns the graph unchanged rather than sweeping it to empty. See §4.1 (rootless-graph guard) and §6.4. |

### §6.1 Composition with existing families

- `MODIFY_NODE_REMOVED` (ADR-0023 §7.1) fires when a **modifier
  intent** removes a node (e.g. `removeDependency` drops an edge
  whose tail was the modifier's target). It is the modifier's
  per-intent diagnostic. `OPTIMIZE_NODE_REMOVED` fires when the
  **GC sweep** removes a node — a node that was orphaned as a
  side effect of some earlier intent. Both may fire across a
  single ADR-0008 iteration: the modifier emits
  `MODIFY_NODE_REMOVED` for the intentional target, optimize
  emits `OPTIMIZE_NODE_REMOVED` for the cascaded orphan trail.
  The two codes distinguish "operator removed this" from
  "garbage collector removed this".
- `COMPLETION_*` codes (ADR-0023 §7.2) fire during completion
  only. Optimize does not emit `COMPLETION_*`.
- `RECIPE_*` / `INTEROP_*` / `<FORMAT>_*` codes (ADR-0014 / 0020
  / per-format) do not fire during optimize.

### §6.2 Subject conventions

Per ADR-0023 §7.3, `subject` is `NodeId | EdgeTriple | 'graph'`.
Optimize uses NodeId for per-node events and the `'graph'`
literal for the per-call `OPTIMIZE_NOOP` event. No `EdgeTriple`
subjects are emitted — optimize operates on nodes, and edge
removal is a mechanical byproduct of `removeNode` (already
reported by the Mutator's `ChangeRecord` stream if a downstream
consumer wants edge granularity).

### §6.3 Read channel (ADR-0023 §8.6)

Diagnostics emitted via `m.diagnostic(d)` inside the optimize
phase's `graph.mutate(transaction)` land on `Graph.diagnostics()`
once the surrounding transaction settles. The same diagnostics
appear on `OptimizeResult.unresolved` for per-call streaming /
aggregation. Stringify-side adapters consult `Graph.diagnostics()`
for graph-level state per ADR-0023 §3.2 read-channel contract.

### §6.4 Rootless-graph guard (r3 amendment)

`OPTIMIZE_NO_ROOTS` closes a safety gap in the §4.1 root model.
That model seeds liveness from `workspaces ∪ preserve` and
deliberately does NOT consult `graph.roots()` (§4.1 "Why not
graph.roots()"). The design assumes a workspace root exists. On a
non-workspace (classic) graph with no `preserve`, the live set is
empty and the §4.3 sweep would remove every node.

The guard is the minimal closure: when the marked live set is
empty AND the graph is non-empty, optimize keeps all nodes, emits
one `OPTIMIZE_NO_ROOTS` (warning, `'graph'` subject), and returns
the graph unchanged. It does NOT reverse §4.1 — `graph.roots()` is
still not consulted, and orphans are still not self-seeded. It only
declines a destructive all-sweep that the caller cannot have
intended. Callers that want orphan GC on a rootless graph pass the
legitimate roots through `preserve`, restoring the normal mark-and-
sweep.

The §7 invariants stay intact: the phase remains monotone-reductive
(it removes zero nodes here), deterministic, and idempotent (a
second call on the unchanged graph re-emits `OPTIMIZE_NO_ROOTS`).

## §7 Invariants

All seven items below are normative and acceptance-gated (§9).

1. **Monotone-reductive.** No iteration of optimize adds nodes,
   edges, tarball entries, peer-context entries, or
   `workspacePath` markers. Diagnostics ARE appended (this is the
   `Graph.diagnostics()` channel's intended growth direction per
   ADR-0023 §8.6), but the structural state strictly shrinks or
   stays the same.

2. **Workspaces preserved (ADR-0017).** Every node with
   `Node.workspacePath !== undefined` is in the live set at the
   end of the mark phase. No workspace node is ever removed. The
   ADR-0017 settled contract (workspaces are roots by definition,
   even when they have incoming workspace→workspace edges) is
   honoured by the §4.1 explicit-mark step.

3. **Content-sort deterministic (ADR-0007).** `removed` and the
   emission order of `OPTIMIZE_NODE_REMOVED` follow
   `graph.nodes()` content-sort. Two structurally equivalent
   input graphs produce byte-equal `OptimizeResult.removed`
   arrays.

4. **Idempotent.** `optimize(optimize(g).graph)` returns
   `removed: []` and a single per-call diagnostic — `OPTIMIZE_NOOP`,
   or `OPTIMIZE_NO_ROOTS` when `g` is rootless (§6.4). The graph
   state is byte-identical modulo that second diagnostic record.
   (The diagnostic list grows monotonically; structural state
   stabilises after one call.)

5. **Peer-context coherence (ADR-0006).** A removed node MUST
   NOT be referenced from any surviving node's `peerContext`.
   The §4.2 reachability walk covers `peerContext` explicitly,
   so any node referenced from a live node's `peerContext` is
   live too. The Mutator's invariant
   (`graph.ts:418-425` — `peer edges of <id> disagree with
   peerContext`) re-validates this on the seal of every mutate
   call inside the sweep; a stale `peerContext` reference would
   abort the phase with `INVARIANT_VIOLATION` before the
   transaction settles.

6. **Sentinel-keyed collection (ADR-0011).** Unreachable
   sentinel-keyed nodes ARE collected (§2 normative pin, §4.3
   policy). The Mutator's `removeNode` and `removeTarball`
   accept sentinel-keyed entries per ADR-0011 §301-304 and
   `graph.ts:248-265` carve-outs.

7. **Pre-stringify position.** Optimize runs before stringify in
   every supported orchestrator path. Adapters' stringify code
   reads from a graph that has been swept; no orphan node ever
   reaches stringify projection.

## §8 Out of scope (for THIS ADR)

- **Hoist dedup.** Collapsing duplicate `(name, version)` pairs
  to a single canonical NodeId is a separate optimisation
  (different reachability question entirely). Non-trivial
  because peerContext disambiguation (ADR-0006) may require
  keeping multiple instances with the same `(name, version)`
  but different `peerContext`. Deferred to a future ADR (likely
  ADR-0025 or later) that defines the canonical-instance
  selection rule and the `peerContext` rewrite step.
- **Layout-phase compaction.** Optimising the file-system
  projection (de-duplicating `node_modules/<name>` paths,
  collapsing yarn-berry PnP map entries) is a different layer
  per ADR-0001 (L3 / Layout). The graph-level optimize phase
  does not touch layout.
- **Strict-mode-only execution.** Optimize runs unconditionally
  per the §8.4 deferral wording — there is no gate via a
  `mode: 'strict'` option (cf. `filterLicense`). The phase is
  always-on; opting out would re-introduce the "surprising
  diff" symptom (§1.3) into every audit-fix flow.
- **Cross-iteration cascade reporting.** Each optimize call
  reports its own removals; the orchestrator (ADR-0008 fixpoint
  loop) is responsible for aggregating across iterations if the
  caller wants a "total nodes removed in this audit-fix run"
  metric. The per-call API does not surface a cumulative
  counter.
- **Removal cause attribution.** Optimize does not record *why*
  a node became orphaned (which modifier intent created the
  trail). Causality lives in the modifier's
  `MODIFY_NODE_REPLACED` / `MODIFY_NODE_REMOVED` /
  `MODIFY_EDGE_REWIRED` diagnostics from the same iteration. A
  consumer that wants cause-effect threading correlates by
  iteration index. A future ADR may add a `because?: Diagnostic`
  back-reference on `OPTIMIZE_NODE_REMOVED`; out of scope here.
- **Batch removal in one mutate transaction.** Optimize calls
  `graph.mutate` once per removed node (§4.4). A future
  performance ADR may batch the entire sweep into one
  transaction; the per-node atomicity is the simpler contract
  for v1.
- **Custom unreachability predicates.** Callers cannot supply a
  custom "is this node reachable" function. The only caller hook
  is the `preserve` set (additive: marks specific NodeIds as
  live). A predicate-based opt-in is a future ADR if a use case
  surfaces.
- **Modifier-emit cycle detection.** A modifier that creates an
  orphan trail and a completion that re-introduces nodes on the
  next iteration could loop indefinitely; ADR-0008's
  `PIPELINE_DIVERGED` guard catches this at the orchestrator
  level. Optimize does not detect cycles in its own phase
  semantics.

## §9 Acceptance gates

### §9.1 Ratification gates (this ADR's commit)

1. **Cold-reader gate.** A subagent reading ADR-0024 end-to-end
   without prior context can answer: *what is the optimize
   phase, when does it run, what does it remove, how does it
   compose with completion / fixpoint, what are the four
   `OPTIMIZE_*` codes, why are workspaces preserved, why are
   sentinel-keyed nodes collected* — without re-reading. Per
   ADR-0023 §9.1 precedent.
2. **Vocabulary harmonisation.** The terms `optimize phase` /
   `monotone-reductive` / `live set` / `mark-and-sweep BFS` /
   `orphan` / `OPTIMIZE_NODE_REMOVED` / `OPTIMIZE_NOOP` /
   `preserve` are each used consistently across §§1–8. No
   synonym drift with ADR-0023's `recentlyOrphaned` /
   `completion frontier` / `monotone-additive`.
3. **No outsourcing.** Algorithm pseudocode in §4 is complete
   (mark phase + sweep phase + atomicity); diagnostic codes are
   enumerated at §6; composition with ADR-0008 is pinned at §5.
   No "see future ADR" deferrals for definitional content.

### §9.2 Implementation gates (per implementer round, NOT this ADR's commit)

Implementer round lands `src/main/ts/optimize/`. Per-test
assertion:

| Scenario | Assertion |
|----------|-----------|
| Roundtrip (noop graph) | `parse → optimize → stringify` byte-equal to `parse → stringify`. `OptimizeResult.removed === []`; one `OPTIMIZE_NOOP` diagnostic emitted. |
| `replaceVersion` merge branch | A graph where `replaceVersion(lodash, '4.17.20', '4.17.21')` merges into an existing `lodash@4.17.21` sibling; the post-modify graph carries `lodash@4.17.20` as orphan; `optimize` removes it; the surviving `lodash@4.17.21` and its transitives are intact. |
| `removeDependency` cascade | Remove `consumer → dep` where `dep` has zero other in-edges and `dep → grandchild` likewise; optimize removes both in iteration order content-sort (`dep` before `grandchild` per ADR-0007 content-sort). |
| `filterLicense` strict mode | A graph with a GPL-3.0 node; `filterLicense({ deny: ['GPL-3.0'], mode: 'strict' })` removes the GPL node via `removeDependency`; optimize sweeps any cascaded orphans. Final graph stringifies to npm-3 / pnpm-v9 / yarn-berry-v9 cleanly. |
| Workspace unreachable | A workspace fixture where workspace `app` has no incoming edges and no other workspace depends on it; `OptimizeResult.removed === []`; the workspace remains in the graph; no `OPTIMIZE_WORKSPACE_UNREACHABLE` diagnostic emitted under the v1 mark policy (the §4.1 explicit workspace mark covers it). |
| Sentinel-keyed unreachable | A graph with a `lodash@4.17.21+patch=unresolved-<sha256>` node that becomes unreachable; optimize removes it without emitting any sentinel-specific warning (the removal is a normal `OPTIMIZE_NODE_REMOVED`). |
| Idempotency | `optimize(optimize(g).graph)` returns `removed: []` and `unresolved: [OPTIMIZE_NOOP]` (or `[OPTIMIZE_NO_ROOTS]` when `g` is rootless, per §6.4). The graph state is byte-identical to the first call's output modulo that second diagnostic. |
| Rootless guard (r3) | A non-workspace graph (no `workspacePath` on any node) with empty `preserve` and ≥1 node; `OptimizeResult.removed === []`; every input node remains; one `OPTIMIZE_NO_ROOTS` (warning, `'graph'` subject) emitted. Supplying `preserve` with the real roots re-enables the sweep. An empty graph (0 nodes) still yields `OPTIMIZE_NOOP`, not `OPTIMIZE_NO_ROOTS`. |
| Peer-context coherence | A graph where node `A` has `peerContext: [B]` and `B` would be unreachable except for the peerContext reference; `B` is preserved (live via §4.2 peer-context walk); `A`'s seal invariant holds post-optimize. |
| Determinism | Run `optimize` on the same input graph twice (fresh seed); `OptimizeResult.removed` arrays compare byte-equal; emission order of `OPTIMIZE_NODE_REMOVED` matches content-sort iteration. |

Each assertion lands in `src/test/unit/optimize.test.ts` and
`src/test/integration/optimize-fixpoint.test.ts` (the latter
exercises optimize inside ADR-0008's fixpoint loop with a
real audit-fix flow).

### §9.3 Composition gates

For each modifier primitive (ADR-0023 §3), the
modify → complete → optimize sequence MUST:

- Produce a graph with zero orphans (`graph.roots()` membership
  + workspace-reachability covers every node).
- Emit `MODIFY_NODE_*` diagnostics for intentional changes
  AND `OPTIMIZE_NODE_REMOVED` diagnostics for cascaded orphans;
  the two channels are distinct (§6.1).
- Stringify to npm-3 / pnpm-v9 / yarn-berry-v9 without
  reproducing the §1.3 "side-by-side old + new version"
  symptom.

## §10 Cross-references

- [ADR-0001](./0001-three-layer-model.md) — three-layer model;
  optimize operates at L2 (Graph), pre-L3 (Layout) projection.
- [ADR-0006](./0006-pnpm-style-peer-context.md) — peer-context
  NodeId identity; §4.2 reachability walks peerContext to
  preserve the §7 coherence invariant.
- [ADR-0007](./0007-content-sorted-iteration-order.md) —
  content-sorted iteration; §4.5 sweep order determinism rests
  on this.
- [ADR-0008](./0008-iterative-modify-enrich-pipeline.md) —
  fixpoint loop; §5 composes optimize as the monotone-reductive
  pass.
- [ADR-0011](./0011-tarball-key-disambiguation.md) —
  sentinel-keyed tarball entries; §4.3 / §7 item 6 commit to
  collecting unreachable sentinel-keyed nodes per the §301-304
  carve-out.
- [ADR-0017](./0017-graph-seal-workspace-edges.md) — workspace
  seal; §4.1 / §7 item 2 commit to workspace preservation as
  invariant.
- [ADR-0023](./0023-graph-modification-and-completion.md) —
  modifier/completion contract; §8.4 step 4 is this ADR's
  charter (§1.1).
- [`src/main/ts/graph.ts`](../../src/main/ts/graph.ts) — Mutator
  surface; §4.4 atomicity relies on `removeNode` +
  `removeTarball` + `m.diagnostic` inside one `mutate`
  transaction.
- [`src/main/ts/modify/replace-version.ts`](../../src/main/ts/modify/replace-version.ts) —
  merge-branch orphan trail (lines 162–186) is the dominant
  source of orphans this phase sweeps.
- [`src/main/ts/complete/tree-complete.ts`](../../src/main/ts/complete/tree-complete.ts) —
  monotone-additive completion; §4 algorithm honours the
  phase-responsibility split that ADR-0023 §4 normatively
  introduced.
