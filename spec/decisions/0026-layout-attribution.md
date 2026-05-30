# ADR-0026 — Layout attribution: a round-trip cache for npm install-path placement (not the L3 model)

> Status: `accepted`
> Date: `2026-05-30`
> Reframed 2026-05-30 (architect deliberation): this carrier is **format-attribution
> — a read-before-modify round-trip *cache*, NOT an L3 model instance**. The
> canonical representation is the L2 graph; this cache pins ONE valid L3 projection
> when one was observed at parse. The generative L3 model (`Layout`/`LayoutEntry`,
> `spec/04-layouts.md`) is ADR-0027. See §Crux.

## Context

ADR-0001 promised a third layer — **L3 Layout**, the physical projection of the
graph (isolated / hoisted / PnP / nm-linked), with `Conversion goes L3 → L2 →
L3'`. L3 is **unbuilt**. ADR-0025 twice deferred concerns "to ADR-0026 (L3
Layout)": (a) **Bug #10** — npm deep nested-hoist round-trip (per-context
resolution), and (b) **scoped-override application** (the *result* of a
`parentPath`-bearing override). This ADR addresses the first; it **re-routes the
second to ADR-0027** (see §Reconciliation).

**The concrete driver — Bug #10, measured.** npm `package-lock.json` keys
entries by install path (`node_modules/a`, `node_modules/a/node_modules/b`), so
a package can sit at multiple nested paths. Two empirical facts (verified
against the real-world fixture corpus) reshape the problem:

1. **It is NOT a node-collapse problem.** The flat L2 graph holds distinct
   `(name, version)` as distinct NodeIds, so multi-version multi-path entries
   already round-trip: create-react-app **244/244** multi-path names are
   *distinct versions*, vscode **168/168**, socket.io **112/116**. The genuine
   gap is the residual **same-`(name,version)`-at-multiple-paths** case
   (socket.io: **4**, e.g. `esprima@4.0.1` at two nested paths; CRA/vscode: 0) —
   a tiny surface.
2. **Placement is already captured at parse** (`NpmFlatSidecar.installPaths`,
   `_npm-core.ts:347-349`). The failure is on the **re-derive** side:
   `deriveInstallPathsForStringify` (`_npm-core.ts:934-1059`) seeds the captured
   paths but then runs a BFS (`drainBfsQueue`, ~1036) that *re-hoists by npm's
   algorithm* — it reconstructs *a* valid tree, deliberately **not** the
   *original* one (the planner's mirror-npm-hoist intent;
   `src/test/resources/fixtures/real-world/findings.md`). For the
   same-version-multipath case this collapses copies (byte-divergent), and for a
   deep-nested conflict it **throws `IRREDUCIBLE_LOSS`** (`addPlacement`,
   ~952-958): the real-world overrides canary pins `microsoft-vscode`
   re-stringifying to a collision — the *captured* lock places the two
   `brace-expansion` versions at **distinct, non-colliding** paths
   (`vite-plugin-istanbul/node_modules/brace-expansion@5.0.6` and
   `…/glob/node_modules/brace-expansion@2.1.0`), but the BFS re-derives a
   *synthetic* deeper path (`…/glob/node_modules/minimatch/node_modules/brace-expansion`)
   and routes two distinct versions onto it. A real published lock that **will
   not re-emit at all** — and provably a **re-derive artefact, not an
   original-structure problem** (the captured paths never collide; npm keys
   `packages` by path).

No existing test caught #10: the npm round-trip predicate is Graph-level
(`graphSnapshot` + `diff`), and the cross-family probe asserts only
parseability. #10 is a *fidelity* gap below those predicates' resolution.

**Reconciliation (the 0025 deferral split).** "L3 Layout" splits along a
**lift / generate** boundary. The LIFT half — *observe* the producing PM's
placement and *replay* it on same-PM emit — closes #10 and needs no new layer.
The GENERATE half — *synthesise* a physical tree from L2 for cross-PM emit, and
*apply* a `parentPath`-scoped override into a placement that does not yet exist —
is the hard, large work. **ADR-0026 ships the lift half; ADR-0027 ships the
generate half** (the `Layout := { kind, entries: LayoutEntry[] }` type of
`spec/04-layouts.md`, scoped-override application, and `applyOverrides` — which
ADR-0025 §Consequences/§Scope-boundaries already routed to 0027). So the "ADR-0026 (L3 Layout)" the 0025
deferral named is delivered across **two** ADRs along this seam — reconciled
here, not silently redirected.

## Decision

**Introduce the minimum L3 needed to make same-PM round-trips placement-faithful:
a graph-keyed layout-attribution carrier that captures observed physical
placement at parse and replays it verbatim on same-PM stringify — the
verbatim-carrier pattern (npm `nativeOverrides`, pnpm `sidecar.overrides`)
applied to placement. No generative `Layout` type; no cross-PM synthesis; no
scoped-override application.**

### 1. Layout-attribution carrier

A recipe-owned `WeakMap<Graph, LayoutAttribution>` in `recipe/layout.ts`,
populated at parse, read by `layoutOf(graph)`. Exactly the posture of the
ADR-0025 §6 `overridesOf` carrier: PM-neutral, recipe-owned (the source-unifying
`layoutOf` lives in `index.ts`, the one module importing every format), **not a
`Graph` field**, **seal-invisible** (`validate(State)` reads no WeakMap —
ADR-0017 unaffected).

### 2. `LayoutAttribution` data model

```ts
// recipe/layout.ts — recipe-owned carrier
export type LayoutStrategy = 'isolated' | 'hoisted' | 'pnp' | 'nm-linked'

export interface LayoutAttribution {
  strategy: LayoutStrategy            // subsumes today's LayoutHints.strategy
  /** Observed physical placement of each graph node, keyed by NodeId.
   *  hoisted (npm): node_modules install paths (the existing
   *  NpmFlatSidecar.installPaths, lifted to this neutral carrier).
   *  isolated (pnpm): virtual-store directory coordinate(s).
   *  Absent NodeId ⇒ no observed placement ⇒ emit re-synthesises (info diag). */
  placement: Map<NodeId, string[]>
}

export function layoutOf(graph: Graph): LayoutAttribution | undefined
export function rememberLayout(graph: Graph, layout: LayoutAttribution): void  // write-API (see §Risks)
```

Placement is a **path/coordinate list** (PM-neutral shape, per-PM
interpretation) — not raw npm strings leaking the matrix (ADR-0013 §attribution).
Relationship to L2: *co-observed at parse, independent thereafter*. The
attribution does not reconstruct the graph (the graph is already complete) — it
**disambiguates which of several valid trees the producing PM chose**. Projection
direction stays `Graph (+ attribution) → physical tree`; when attribution is
present it *pins* that projection.

### 3. Authoritative replay on same-PM stringify

When `layoutOf(graph)` exists, the per-PM stringifier **replays the captured
placement verbatim**. For npm: emit the captured `installPaths` directly and
**run no `drainBfsQueue`** at all. This is the load-bearing precision: today's
planner seeds the captured paths *and then* drains the BFS (`_npm-core.ts:1036`),
and the drain is exactly the throwing/collapsing path — so replay must **skip the
BFS entirely**, not seed-then-drain. The synthesising planner
(`deriveInstallPathsForStringify`'s BFS) **degrades to a generator** invoked only
when no attribution is present (cross-PM input, or a post-`mutate` graph). This
closes #10: the captured paths are valid by construction (npm keys `packages` by
path, so no two are equal), so there is no re-derive collision (`IRREDUCIBLE_LOSS`)
and no same-version-multipath collapse.

### 4. `layoutOf` accessor + carrier lifetime (read-before-modify)

`layoutOf(graph): LayoutAttribution | undefined` is a free function (mirrors
`overridesOf` / `getFlatSidecar` / `frozenRegistry`). Lifetime per ADR-0025 §6
**read-before-modify**: written once at parse, read off that handle; **not**
propagated across `graph.mutate()` / enrich / optimize (matching every format
sidecar's modify-path lifetime — a bare `mutate` drops them all). No recipe-level
mutate-rebind hub is introduced. Stringify on a post-mutate graph re-synthesises
(see §3 + the diagnostic).

### 5. `LayoutHints` reconciliation

`LayoutHints.strategy` (`graph.ts`, on `State`) is **subsumed** into
`LayoutAttribution.strategy` — one home for layout-shaped state. The
`Graph.layoutHints()` / `Builder.layoutHints()` accessors are redirected to read
`layoutOf().strategy` (housekeeping; no behavioural change). Do **not** ship two
silent homes for strategy.

## Consequences

- **Positive:** #10 closed — same-PM npm round-trip is placement-faithful, and
  real published locks (vscode, socket.io) re-emit without `IRREDUCIBLE_LOSS`.
  The L3 lift-half lands; the generate-half is cleanly named and deferred.
- **Positive:** ADR-0006 intact — same-`(name,version)`-multipath stays **one**
  NodeId with a multi-path placement entry (`Map<NodeId, string[]>`); **no
  node-fork**. ADR-0013 textbook — placement is PM-native physical attribution in
  a format-layer carrier; the canonical L2 graph stays layout-free + load-bearing.
- **Negative / risk:** the byte-faithfulness gate is scoped to the **placement
  key-set** (not full-file `===`), to avoid failing on pre-existing
  out-of-scope drift (field ordering, synthesised root version). Scoped-override
  application waits on ADR-0027.
- **Open:** the generative `Layout` type, scoped-override application, and pnpm
  virtual-store synthesis → ADR-0027.

## Round-trip guarantee & crux (architect deliberation, 2026-05-30)

**The snapshot is format-attribution, NOT the canonical model** — three independent
reasons, each sufficient:

1. **It fails the canonical test: it does not survive the canonical operation.**
   `graph.mutate()` shallow-clones into a fresh `Graph` handle (`graph.ts:823-824`);
   every carrier is a `WeakMap<Graph,…>`, so the snapshot is dropped on the first
   mutation — *by construction, not policy*. A thing the flagship consumer
   (audit-fix) discards on its central operation cannot be the source of truth.
2. **It is disambiguation, not information.** The L2 graph is already complete; the
   snapshot adds zero resolution facts — it only selects WHICH of several
   find-up-equivalent trees npm chose. Textbook PM-native attribution (ADR-0013),
   same kind as npm `nativeOverrides` / pnpm `sidecar.overrides`.
3. **It is co-observed-then-independent:** observed at parse, never reconciled
   after — a cache, not a maintained model.

The canonical representation is **the L2 graph**. This snapshot pins ONE valid L3
projection when one was observed; the generative L3 *model* (`Layout`/`LayoutEntry`)
is ADR-0027.

**Per-flow round-trip guarantee (what we honestly promise):**

| Flow | Snapshot | Guarantee |
|------|----------|-----------|
| no-op same-PM (npm→npm, unchanged) | present (parse handle) | **structure-identical** — emitted `packages` key-set **and per-key path-strings** == original |
| cross-PM (npm→pnpm, …) | absent (doesn't map across PMs) | **semantic-equivalent** — valid find-up-correct tree + `LAYOUT_PLACEMENT_RESYNTHESISED` |
| audit-fix (parse→mutate→stringify) | dropped at `mutate` | **semantic-equivalent**; min-churn target → ADR-0027 |
| read-only inspection | n/a | none (no stringify) |

**No full byte-identity is promised to anyone.** Byte / key-**order** fidelity is
unattainable in principle: even plain `JSON.parse → JSON.stringify` does not
preserve key order (V8 reorders integer-like keys; the object round-trip discards
source ordering). **Structure-identity** (key-set + path-strings) is the honest,
achievable bar. Consequently the no-op gate (§Acceptance 2) asserts the **path
string per key**, not merely the set of NodeIds — otherwise #10's sibling class
(right nodes, wrong nesting) slips below the predicate exactly as #10 slipped below
the Graph-level round-trip check.

## Scope boundaries (explicit non-goals → ADR-0027)

- **The generative `Layout` type** (`spec/04-layouts.md`
  `{ kind: Strategy, entries: LayoutEntry[] }`) — synthesising a physical tree
  from L2 + strategy for cross-PM emit.
- **Scoped-override application** — resolving a `parentPath`-bearing override
  into a placement (`bar/node_modules/foo` ≠ top-level `foo`). Needs the
  generative layout to act on; co-located with `applyOverrides` in 0027.
- **pnpm virtual-store synthesis** + cross-PM placement generation beyond what
  today's per-PM planners already do.
- **Mutate-surviving layout attribution** — read-before-modify v1; a
  mutate-rebind hub is out of scope (consistency with ADR-0025 §6, not new debt).
- **`pnp` / `nm-linked` strategy generators** — `pnp` placement is
  `.pnp.cjs`-shaped, not a node_modules tree; a generation concern.

## Diagnostics

| Code | Severity | Fires when |
|------|----------|------------|
| `LAYOUT_PLACEMENT_RESYNTHESISED` | info | stringify falls back to the synthesising planner (no attribution: cross-PM input or post-`mutate`), so the resulting placement is generated, not replayed — byte-divergence from any original lock is attributed, not silent (ADR-0013 posture) |

## Acceptance gates

1. `layoutOf(graph)` returns the observed placement after parse; `undefined`
   post-`mutate` (read-before-modify).
2. Same-PM npm round-trip is **placement-faithful** — the emitted `packages`
   key-set matches the original — on the real-world fixtures; specifically
   `microsoft-vscode` and `socketio-socket.io` re-stringify **without**
   `IRREDUCIBLE_LOSS` (the #10 red-test the overrides canary surfaced). This gate
   tests the **un-mutated** `parse → stringify` path (the canary's path); a
   post-`mutate` graph drops attribution → re-synthesises (§3) and may re-throw —
   that path is read-before-modify v1 scope, surfaced via the resynth diagnostic.
3. **No node-fork:** a same-`(name,version)`-multipath node stays one NodeId
   with a multi-path `placement` entry (ADR-0006).
4. `LAYOUT_PLACEMENT_RESYNTHESISED` fires on cross-PM / no-attribution emit.
5. The carrier exposes a **write-API** (`rememberLayout`) shaped so ADR-0027's
   generator can write synthetic placements into the same structure it reads
   (avoids a 0027 carrier-shape amendment).
6. `LayoutHints.strategy` is unified into the carrier (`layoutOf().strategy` the
   single read) — no two silent homes.

## Alternatives considered

- *Full L3 `Layout` type now.* Rejected — over-engineering for #10's
  4-fixture, same-version-multipath surface; the generative `LayoutEntry` tree
  is throwaway risk before its cross-PM requirements are pinned, duplicates the
  existing per-PM planners, and couples a large new core type to a small bug.
  Split: attribution (0026) vs generation (0027).
- *Node-fork (path-keyed NodeId variants).* Rejected — breaks ADR-0006 NodeId
  byte-identity; ADR-0025 already rejected node-fork. Placement lives *outside*
  identity, in the carrier.
- *Full-file byte-equality round-trip gate.* Rejected — fails on pre-existing,
  out-of-scope divergences (field ordering, synthesised root `0.0.0`, dropped
  legacy `dependencies` mirror). The gate asserts the placement key-set, not
  raw bytes.
- *Mutate-surviving carrier (recipe-level rebind hub).* Rejected for v1 — would
  exceed every format sidecar's own modify-path lifetime (ADR-0025 §6 set the
  read-before-modify precedent); purely-additive future work.

## Links

- `spec/01-model.md` (three-layer), `spec/04-layouts.md` (generative `Layout` /
  `LayoutEntry` shape → ADR-0027)
- ADR-0001 (three-layer model — L3 Layout promise; `L3 → L2 → L3'`)
- ADR-0006 (NodeId byte-identity — no node-fork; the linchpin)
- ADR-0013 (PM-native = attribution carrier; canonical = load-bearing)
- ADR-0017 (graph seal — carrier is seal-invisible)
- ADR-0025 (the deferral contract: #10 + scoped-override application → "L3"; §6
  read-before-modify carrier precedent)
- ADR-0027 (generative Layout + scoped-override application + `applyOverrides`;
  gated on 0026) — to be drafted
