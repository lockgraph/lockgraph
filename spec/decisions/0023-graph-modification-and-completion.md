# ADR-0023 — Graph modification, tree completion, and find-up resolve semantics

> Status: accepted
> Date: 2026-05-24

> Phase A architectural design for Phase B (modifier primitives) and
> Phase D (live registry adapters). The Phase C foundation
> (`RegistryAdapter` / `CacheAdapter` / `frozenRegistry`) has landed on
> a parallel implementer branch and this ADR consumes that contract
> shape; it does NOT redefine it.

## §1 Context

### §1.1 Mission shift

The 13-adapter cross-format conversion phase (ADRs 0016 / 0018 /
0019 / 0020 / 0021 / 0022) closed at 2026-05-16 with ADR-0014's
canonical recipe layer ratifying the parse / stringify contract for
all five feature surfaces (F1 integrity, F2 patch, F3 resolution
URL, F4 workspace specifier, F5 patch byte normalisation). The
project's headline mission shifts from *conversion* to
**partial modification + tree completion** — the audit-fix family
that motivated [`yarn-audit-fix`](https://github.com/antongolub/yarn-audit-fix)
in 2019, now generalised across npm / yarn / pnpm / bun.

The README already promises this surface (`@antongolub/lockfile/modify`):

> *"Conversion is one use case; modification (audit-fix, override
> pinning, license filtering) is the headline."*

This ADR is the architectural commitment that pins the contract.

### §1.2 What the existing Mutator API does NOT cover

`src/main/ts/graph.ts:Mutator` provides **mechanical** mutation
primitives — `addNode`, `removeNode`, `addEdge`, `removeEdge`,
`replaceNode`, `replacePeerContext`, `setTarball`, `removeTarball` —
wrapped in a transactional `Graph.mutate(transaction)` that
re-validates and re-indexes on commit. The Mutator is the
**graph-mechanical floor**: it enforces invariants (no dangling
edges, no duplicate NodeIds, peer-edge ↔ peerContext coherence, the
ADR-0011 sentinel-keyed refusal, the ADR-0017 workspace seal) but it
has no opinion on:

- *which* nodes a high-level intent (e.g. "replace every
  `lodash@<4.17.21` with `lodash@4.17.21`") should touch;
- *where* the new edges should land for a graph topology to remain
  installable (the find-up question);
- *what* transitive nodes a freshly-added dependency drags in (the
  completion question);
- *whether* the registry can confirm the new resolution exists
  (the adapter question).

Audit-fix authors today must write all of this by hand against the
mechanical Mutator, replaying the resolver every time. That is a
leaky abstraction, and it is what `yarn-audit-fix` v3 paid for in
maintenance debt for six years.

### §1.3 What the recipe layer (ADR-0014) does NOT cover

The recipe layer pins **per-feature** canonical translation across
adapters — F1..F5. It does NOT define:

- a modifier vocabulary above the Mutator (the recipe layer is
  consumed by adapters at parse / stringify; it does not run during
  modification);
- a tree-completion algorithm (the recipe layer presumes the graph is
  already shaped);
- a find-up resolve algorithm (the recipe layer presumes edges are
  already wired);
- a registry adapter contract (RegistryAdapter is in Phase C, owned
  by separate skeleton work).

The recipe layer is **parse-time / stringify-time**. This ADR pins
the **modification-time** equivalent.

### §1.4 What Phase C (RegistryAdapter foundation) provides

A parallel implementer round has landed `src/main/ts/registry/types.ts`
and `src/main/ts/registry/frozen.ts` — the **read-facade** the
modifier and completion layers will consume. The contract shape is:

```ts
interface RegistryAdapter {
  packument(name: string): Promise<Packument | undefined>
  resolve(name: string, range: string): Promise<PackumentVersion | undefined>
}

interface CacheAdapter {
  packument(name: string): Promise<Packument | undefined>
  tarball?(name: string, version: string): Promise<Uint8Array | undefined>
}
```

`frozenRegistry(graph)` synthesises a `RegistryAdapter` from facts
already present on a parsed graph — every `(name, version)` pair
known to the graph becomes a queryable `PackumentVersion`, with
dependencies / peers / engines / cpu / os / libc / deprecated /
bin / bundledDependencies / integrity / tarball-URL populated from
the graph's `Node` + `TarballPayload` facts. The frozenRegistry is
the **offline-first floor**: modifiers function against it without
network access; live network adapters (Phase D) refine the same
contract shape.

### §1.5 Audit-fix is a composition, not a primitive

The headline use case `audit-fix` decomposes into operational parts:

1. **Diagnose** — read an external advisory feed (npm audit, OSV,
   GHSA), match advisories against graph nodes by `(name, version)`
   to produce a list of "replace N₁ → N₂" intents.
2. **Modify** — execute each intent at the graph layer via a
   modifier primitive (`replaceVersion`).
3. **Complete** — walk the post-mutation graph to wire transitive
   dependencies of the freshly-introduced nodes (the tree-completion
   step; emits `COMPLETION_*` diagnostics).
4. **Optimize** — deduplicate hoisted siblings where the new
   resolution opens a sharing opportunity; GC orphans whose only
   in-edges came from the removed nodes.

Step 1 is advisory-feed integration (out of scope for this ADR;
likely a separate `@antongolub/lockfile/advise` subpath later).
Steps 2 / 3 / 4 are this ADR's territory: modifier primitives that
take an existing Graph + RegistryAdapter (+ optional CacheAdapter,
manifests) and return a new Graph + Diagnostic[] that downstream
adapter stringify can emit.

The ADR-0008 iterative pipeline (`parse → modify → enrich →
stringify`, until fixpoint) is the **outer loop** this ADR's
modifier primitives plug into. ADR-0008 owns the convergence
contract; this ADR owns one iteration's modifier + completion
semantics.

### §1.6 Why one ADR for modification + completion + find-up

The three concerns are not separable in practice:

- Every modifier that adds a node creates a tree-completion
  obligation (the new node has dependencies the graph does not yet
  know).
- Every completion step that adds a transitive dependency creates a
  find-up question (where in the topology does the new node sit so
  the consumer can resolve it).
- Every find-up answer that picks "reuse existing" vs. "install
  nested" depends on what the registry confirms is available and
  what the existing graph already carries.

Splitting them into three ADRs would force forward references and
re-statement of the same invariants. ADR-0023 pins all three at one
layer; if any half overflows during ratification (cold-reader r1
finds excess scope), it spins off into a follow-up ADR with the
specific carve-out and ADR-0023 amends inline to reference it.

## §2 Decision — modifier-completion contract

The modification-time contract consists of three composable layers:

| Layer | Purpose | Implementation |
|-------|---------|----------------|
| **Modifier primitives** (§3) | Express a single intent in terms the user understands (replace, pin, add, remove, patch, filter) | `src/main/ts/modify/` — one file per primitive |
| **Tree completion** (§4) | Walk the post-modifier graph, query registry for missing transitive deps, wire edges | `src/main/ts/complete/` |
| **Find-up resolve** (§5) | Decide *where* a new edge points (reuse existing satisfying sibling vs. install nested) | `src/main/ts/complete/find-up.ts` |

Each modifier primitive returns a `ModifyResult` (§7) carrying the
new Graph + diagnostics; the runtime (ADR-0008's iterative loop)
composes primitives, runs completion after each, and re-enters the
loop until fixpoint.

Public surface: `import { ... } from '@antongolub/lockfile/modify'`
per README §"Sub-imports".

The modifier-completion layer is **offline-first**: every primitive
MUST function with a `frozenRegistry(graph)` adapter alone. Live
network adapters (Phase D) are a refinement opt-in, not a
requirement. This matches the README's *"the default succeeds
offline"* contract for `ParseOptions` / `StringifyOptions`.

## §3 Modifier primitives (NORMATIVE)

The modifier vocabulary is **bounded and orthogonal**. Each
primitive expresses one intent class; richer flows (audit-fix,
license filtering, override application) compose primitives via
ADR-0008's iterative pipeline.

### §3.1 Primitive list

| Primitive | Intent | Signature |
|-----------|--------|-----------|
| `replaceVersion` | Replace every node satisfying a spec with one resolving to a target range; the audit-fix workhorse. `fromRange` accepts any semver range; `'*'` selects every node with the given `name`. `toRange` is forwarded verbatim to `registry.resolve()` and accepts semver range / dist-tag / exact version per Phase C `registry/types.ts:resolve` contract | `(graph, { name, fromRange, toRange }, ctx) → ModifyResult` |
| `pinOverride` | Force a dependency name to resolve to a specific range across the graph (pnpm `overrides:`, npm `overrides`, yarn `resolutions` semantics at the model layer; per-PM emit is the stringify-side concern). `range` is forwarded verbatim to `registry.resolve()` per Phase C contract (same admissible forms as `replaceVersion.toRange`) | `(graph, { name, range }, ctx) → ModifyResult` |
| `addDependency` | Declare a new outgoing edge from a consumer (workspace or non-workspace node) to a named dependency at a given range; trigger completion for the new node's transitive closure. `kind` admissible values for v1: `'dep' \| 'dev' \| 'optional'`. `'peer'` and `'bundled'` are out of scope for v1 (see §10) | `(graph, { consumer, name, range, kind }, ctx) → ModifyResult` |
| `removeDependency` | Drop an outgoing edge from a consumer; GC nodes that become orphaned | `(graph, { consumer, name, kind }, ctx) → ModifyResult` |
| `applyPatch` | Wire `Node.patch` (per ADR-0011 / ADR-0014 §4.F2) for every node matching a spec; canonical bytes via ADR-0014 §4.F5 normalisation. Sentinel-keyed source nodes are refused at the Mutator floor (§3.3, ADR-0011); modifier emits `MODIFY_SENTINEL_REFUSED` (warning) and skips that node without aborting the call | `(graph, { spec, patchBytes }, ctx) → ModifyResult` |
| `filterLicense` | Walk graph, emit diagnostics per `TarballPayload.license` evaluated against an allow / deny list; in `strict` mode, additionally remove the offending node (delegating to `removeDependency`) | `(graph, { allow?, deny?, mode? }, ctx) → ModifyResult` |

`ctx` carries the adapters and refinement opt-ins:

```ts
type ModifyContext = {
  registry:   RegistryAdapter
  cache?:     CacheAdapter
  manifests?: Record<string, Manifest>
}
```

`registry` is **required** at the type level — every modifier may
need to consult the adapter even for pure-graph-internal intents
(e.g. `replaceVersion` may resolve `toRange` to a concrete
`PackumentVersion`). The frozen-registry default at the public
sugar layer ensures callers do not have to construct one by hand:
`modify(graph, primitive, options?)` defaults
`registry = frozenRegistry(graph)` when omitted.

### §3.2 Primitive semantics

Each primitive is **mechanical above the Mutator**: it formulates
its intent as a Mutator transaction and dispatches via
`graph.mutate(transaction)`. The Mutator's existing invariants
(ADR-0017 workspace seal, ADR-0011 sentinel refusal, peer-edge
coherence) apply unchanged.

**`replaceVersion`** —

1. Resolve target via `registry.resolve(name, toRange)`. `toRange`
   is forwarded verbatim — Phase C `registry/types.ts:resolve`
   accepts semver range, dist-tag, or exact version; the modifier
   does no transformation. If `registry.resolve` returns undefined,
   emit `MODIFY_RESOLVE_FAILED` (warning) and abort.
2. Enumerate matched nodes: every node `n` with `n.name === name`
   and `semver.satisfies(n.version, fromRange)`. `fromRange === '*'`
   matches every node with `n.name === name` (degenerate-range
   short-circuit). Sentinel-keyed nodes (per ADR-0011 / §3.3) are
   skipped — they cannot be mutated; emit `MODIFY_SENTINEL_REFUSED`
   (warning) per skipped node and continue with the remaining
   matches.
3. For each matched node, compute the target NodeId via the
   recipe-layer F3 path (`{name, version: target.version}` with
   the original `peerContext` preserved when present; peerContext
   propagation through replace is §6.2 below).
4. Issue a single Mutator transaction. When the target NodeId is
   absent from graph, `replaceNode(oldId, newNode)` rebinds
   atomically. When the target NodeId collides with an existing
   node, follow the merge branch in this exact order to honour the
   Mutator's "no incoming edges before removeNode" invariant
   (`graph.ts:688`):
   ```
   for each incoming edge (src, oldId, kind, attrs):
     if not hasEdge(src, existingTargetId, kind):
       addEdge(src, existingTargetId, kind, attrs)  # retarget
     removeEdge(src, oldId, kind)                   # always drop old edge
   removeNode(oldId)                                # zero incoming
   ```
   If the same `(src, kind)` already binds to `existingTargetId`,
   retarget is a no-op (duplicate edges are forbidden per graph
   invariants) — the `removeEdge(src, oldId, kind)` still fires to
   collapse the redundant attachment.
5. Hand off to tree-completion (§4) — the new node may have
   different dependencies than the old.

**`pinOverride`** —

1. Equivalent to `replaceVersion(graph, {name, fromRange: '*', toRange: range}, ctx)`
   (with `range` forwarded verbatim to `registry.resolve` per Phase
   C contract — semver range, dist-tag, or exact version), PLUS
   emits a single `MODIFY_OVERRIDE_PINNED` diagnostic
   (`subject: 'graph'`, severity `info`) whose `message` includes
   `name` and the resolved version.
2. **Emission path (normative).** Inside the `graph.mutate(transaction)`
   that performs the replace, the modifier calls
   `m.diagnostic(MODIFY_OVERRIDE_PINNED({ name, version }))` so the
   pin record lands on `Graph.diagnostics()` once the transaction
   settles — the canonical read channel per the contract below. The
   `Mutator.diagnostic(d: Diagnostic): void` write-side method is
   defined normatively in §8.6 (Mutator API extension); the
   `Diagnostic` is also surfaced on `ModifyResult.unresolved` for the
   per-call streaming hook (§7.5), but `ModifyResult.unresolved` is
   NOT the channel stringify-side adapters consult for graph-level
   state.
3. **Read channel (normative).** Stringify-side adapters read pinning
   diagnostics from `Graph.diagnostics()` (`graph.ts` ~L137) to
   project back as a PM-native override / resolutions entry per the
   format's recipe; no new Graph field is introduced.

**`addDependency`** —

1. Resolve target via `registry.resolve(name, range)`.
2. If a satisfying node already exists in graph that the find-up
   algorithm (§5) accepts as visible from `consumer`, addEdge to
   it.
3. Else, addNode + setTarball (using the registry-supplied
   `PackumentVersion` facts), addEdge from `consumer`, hand off
   to completion for the new node's transitive closure.

**`removeDependency`** —

1. `removeEdge(consumer, target, kind)`.
2. GC: if `target` now has zero incoming edges, recursively
   `removeNode(target)` + repeat for its previous out-edges.
   Workspace nodes are NEVER removed by GC (workspaces are
   declared by the project, not the graph).

**`applyPatch`** —

1. F2 / F5 canonical bytes via `recipe.parse.patchBytes(bytes)`.
2. For each matched node `n`:
   - if `n.patch` is sentinel-keyed (matches the ADR-0011 sentinel
     predicate `startsWith('unresolved-')`), the Mutator would
     throw `LockfileError({ code: 'IRREDUCIBLE_LOSS' })` on
     `replaceNode` / `setTarball`. The modifier MUST detect this
     in advance, emit `MODIFY_SENTINEL_REFUSED` (warning,
     `subject = n.id`), and skip the node without aborting the
     call. Patches on sentinel-keyed nodes require source-bytes
     re-fetch and are out of scope for v1;
   - compute new NodeId with `+patch=<sha512-hex>` slot;
   - `replaceNode(oldId, {...n, id: newId, patch: <hex>})`;
   - `setTarball({...inputs, patch: <hex>}, {...payload})` —
     fresh TarballKey per ADR-0011.
3. No completion handoff — patch application does not change
   dependency edges.

**`filterLicense`** —

1. Walk every reachable node; read `tarballOf(node.id)?.license`.
2. Apply allow / deny predicates.
3. `mode: 'diagnostic-only'` (default) — emit
   `MODIFY_LICENSE_FLAGGED` (warning) per affected node.
4. `mode: 'strict'` — additionally `removeDependency` every
   incoming edge to the offending node (and GC); if the node is
   reachable only via workspace deps that the user has not
   explicitly excluded, emit `MODIFY_LICENSE_BLOCKED` (warning) —
   the modifier surfaces the conflict to the caller without
   silently failing. Severity is `warning` to match the
   modify/completion family convention; whether the warning is
   a hard block is a caller-policy concern (e.g. CI gate reading
   diagnostics), not the modifier's.

### §3.3 Identity preservation

`replaceVersion` and `applyPatch` change `Node.version` /
`Node.patch`, which changes the NodeId. The Mutator's
`replaceNode` handles the rebind atomically (`graph.ts:701`). Two
distinct error classes can arise; the modifier MUST treat them
differently:

| Error | Class | Origin | Modifier handling |
|-------|-------|--------|--------------------|
| `PATCH_REJECTED` | `GraphError` | Mutator invariant violation — target NodeId collides with an existing node (`graph.ts:713`), or `removeNode` called with incoming edges (`graph.ts:690`), or any other structural-coherence breach | Modifier MUST detect the collision in advance and route via remove+merge per the §3.2 transaction ordering for `replaceVersion` step 4 — this is the "merge-vs-replace" branch every modifier must implement |
| `IRREDUCIBLE_LOSS` | `LockfileError` | Sentinel-keyed source — `n.patch` matches the ADR-0011 sentinel predicate `startsWith('unresolved-')` (`graph.ts:252-258`); the Mutator refuses any byte-modifying op | Modifier MUST detect the sentinel BEFORE invoking the Mutator (read `n.patch` and apply the same predicate), emit `MODIFY_SENTINEL_REFUSED` (warning, see §7.1), and skip the node — DO NOT let the `LockfileError` escape to the caller. The remainder of the batch (other matched nodes) proceeds. |

This boundary is non-negotiable: `LockfileError` is the contract
violation channel and a sentinel-keyed `lodash` matched by
`replaceVersion` would otherwise crash uncaught. The pre-Mutator
detection step is part of every primitive that calls
`replaceNode` / `setTarball` / `replacePeerContext`.

### §3.4 Composition with ADR-0008

Modifiers are **eventually-idempotent** per ADR-0008's convergence
contract: replacing `lodash@4.17.20 → lodash@4.17.21` once produces
a graph where the rule no longer matches (no node satisfies
`<4.17.21`), so re-applying is a no-op. Modifiers that toggle
state are bugs, caught by ADR-0008's `PIPELINE_DIVERGED` runtime
guard.

## §4 Tree completion algorithm (NORMATIVE)

After every modifier transaction, the runtime invokes
`completeTransitives(graph, ctx) → CompletionResult`. The algorithm
walks the post-mutation graph to identify nodes that lack their
declared dependency edges, queries the registry for the missing
facts, and wires them in.

**Phase responsibility — normative.** Completion is **monotone-
additive ONLY**: it adds nodes and edges, never removes. The post-
modifier graph may carry orphans (nodes whose only in-edges were
just removed by `replaceVersion` merge or `removeDependency`); GC of
those orphans is the **optimize phase** (§8.4 step 4 / ADR-0008
fixpoint, owned by `removeDependency` semantics in §3.2), NOT
completion. Completion's BFS frontier excludes orphans (nodes with
zero in-edges that are not graph roots in the conventional sense)
because they will be collected before the next iteration; visiting
them only generates spurious `COMPLETION_NODE_UNKNOWN` noise.

**Workspace handling — normative.** Workspace nodes
(`node.workspacePath !== undefined`) are NOT queried as packument
targets — `frozenRegistry` already skips them at index time
(`registry/frozen.ts:17`), so a BFS visit would emit
`COMPLETION_NODE_UNKNOWN` on every workspace project (the dominant
audit-fix target, which would flood diagnostics with false signal).
Workspace nodes' **out-edges** are still walked normally — workspace
deps participate in the find-up ancestor chain (§5) and their
declared transitives must still be completed; only the workspace
node *itself* is skipped at the packument-query step.

### §4.1 Inputs

```ts
type CompletionResult = {
  graph:       Graph
  added:       NodeId[]
  wired:       EdgeTriple[]
  unresolved:  Diagnostic[]
}

type CompletionSeed = {
  /** NodeIds the modifier added in the just-completed mutate phase. */
  recentlyAdded:    Set<NodeId>
  /** NodeIds the mutate phase orphaned (zero in-edges as a side-effect
   *  of replaceNode merge or removeEdge). The completion frontier excludes
   *  these — optimize phase (§8.4 step 4) collects them. */
  recentlyOrphaned: Set<NodeId>
}

function completeTransitives(
  graph: Graph,
  ctx:   ModifyContext,
  seed?: CompletionSeed,   // optional (amendment, pending ratification): omitted
                           // ⇒ full completion from roots; supplied ⇒ bounded
                           // to the changed subtree. See §4.2.
): Promise<CompletionResult>
```

### §4.2 Algorithm

```
visited:    Set<NodeId> = {}
# The seed BOUNDS the frontier (amendment — optional-seed incremental path,
# PENDING OWNER RATIFICATION; supersedes the original unconditional union):
#   • seed supplied → recently-added-nodes \ recently-orphaned ONLY (no
#     roots). The modify→complete pipeline ALWAYS supplies a seed, so
#     completion walks only the changed subtree — cost O(changed-subtree),
#     not O(graph). An empty seed does ~zero work. This is the incremental
#     contract downstream tools (yarn-audit-fix) depend on; the original
#     `roots(graph) ∪ recently-added` made every seeded call O(graph) and
#     a no-change call ~10 s on a 3k-node graph.
#   • no seed → roots(graph) \ recently-orphaned (full completion from every
#     root — the "complete this whole graph from scratch" caller).
# Freshly-orphaned nodes are excluded on BOTH paths; the optimize phase
# (§8.4 step 4) GC's them. Visiting them only emits spurious
# COMPLETION_NODE_UNKNOWN noise.
frontier:   Queue<NodeId> =
  seed supplied
    ? (recently-added-nodes \ recently-orphaned)
    : (roots(graph) \ recently-orphaned)
added:      NodeId[] = []
wired:      EdgeTriple[] = []
unresolved: Diagnostic[] = []

while frontier non-empty:
  n = frontier.pop()
  if visited.has(n): continue
  visited.add(n)

  # Workspace nodes are not queried as packument targets — frozenRegistry
  # skips them and live registries cannot resolve them. Their out-edges
  # are still walked via the normal recursion through completion of the
  # transitive nodes they depend on.
  if n.workspacePath !== undefined: continue

  packument = registry.packument(n.name)   # frozenRegistry first
  if packument is undefined:
    unresolved.push(COMPLETION_NODE_UNKNOWN { n })
    continue
  version = packument.versions[n.version]
  if version is undefined:
    unresolved.push(COMPLETION_VERSION_UNKNOWN { n })
    continue

  # Walk each dep-kind bucket on PackumentVersion. Field names per
  # `src/main/ts/registry/types.ts`: dependencies / devDependencies /
  # optionalDependencies / peerDependencies.
  for each (depName, depRange, depKind) in
      version.dependencies         (kind='dep')      ∪
      version.devDependencies      (kind='dev')      ∪
      version.optionalDependencies (kind='optional') ∪
      version.peerDependencies     (kind='peer'):
    existing-out = graph.out(n, depKind).find(e =>
      graph.getNode(e.dst).name === depName
    )
    if existing-out is defined:
      # edge already wired by parse; no-op
      continue

    target = findUp(graph, n, depName, depRange, depKind)   # §5
    if target is defined:
      # reuse existing satisfying sibling
      mutate: addEdge(n, target.id, depKind, { range: depRange })
      wired.push({ n, target.id, depKind })
    else:
      # not satisfiable from existing graph; query registry
      resolved = registry.resolve(depName, depRange)
      if resolved is undefined:
        unresolved.push(COMPLETION_UNRESOLVED { n, depName, depRange })
        continue
      # synthesise new node — see field-mapping table below
      newNode = makeNode(resolved, peerContext=[])
      (inputs, payload) = projectPackumentVersion(resolved)
      mutate:
        addNode(newNode)
        setTarball(inputs, payload)
        addEdge(n, newNode.id, depKind, { range: depRange })
      added.push(newNode.id)
      wired.push({ n, newNode.id, depKind })
      frontier.push(newNode.id)

return { graph, added, wired, unresolved }
```

**`PackumentVersion → (TarballKeyInputs, TarballPayload)` field
mapping (NORMATIVE).** Completion synthesises new nodes from the
registry's `PackumentVersion`; the projection into the Mutator's
`setTarball(inputs, payload)` shape is fixed:

| Mutator field | PackumentVersion source |
|---------------|--------------------------|
| `inputs.name` | `pv.name` |
| `inputs.version` | `pv.version` |
| `inputs.patch` | `undefined` — completion does not synthesise patches; patch application is `applyPatch`'s domain |
| `payload.integrity` | `pv.integrity` |
| `payload.engines` | `pv.engines` |
| `payload.os` | `pv.os` |
| `payload.cpu` | `pv.cpu` |
| `payload.libc` | `pv.libc` |
| `payload.bin` | `pv.bin` |
| `payload.bundledDependencies` | `pv.bundledDependencies` |
| `payload.deprecated` | `pv.deprecated` |
| `payload.resolution` | `pv.tarball === undefined ? undefined : { type: 'tarball', url: pv.tarball }` — synthesised from the packument's tarball URL when present, else left undefined |
| `payload.license` | `undefined` — not carried in `PackumentVersion`; degrades gracefully (recipe-layer enrich may refine later) |

Fields not enumerated on `PackumentVersion` (e.g. `license` for
v1 — though present on legacy npm packuments and a candidate for a
follow-up extension) degrade gracefully: completion leaves them
`undefined` on the payload, and downstream stringify projects the
fact-absence per the adapter's recipe.

### §4.3 Peer dependencies

Peer dependencies are handled identically to regular dependencies
at completion time — they get an edge from the consumer to the
satisfying peer node (find-up first, register-fetch second). The
**peer-context propagation** (creating new peer-virtualised nodes
when a peer is bound to a different concrete version) is **out of
scope** for this ADR's first iteration — peer-virtualisation is
recipe-layer territory (ADR-0006 / ADR-0014 §F1 NodeId grammar) and
the existing parse-time peer-virt synthesis suffices for v1. Future
ADR carves out modifier-time peer-virt synthesis when audit-fix
fixture demands surface it.

For the v1 modifier surface, completion-time peer wiring follows
the find-up algorithm; if no satisfying peer exists in graph and
the consumer's peer context is non-empty, emit
`COMPLETION_PEER_CONTEXT_INCOMPLETE` (warning) and proceed without
the edge — the existing recipe-layer enrich pass at stringify-time
will surface the gap as a per-format diagnostic.

### §4.4 Bundled dependencies

Bundled deps are part of the source node's tarball payload
(`TarballPayload.bundledDependencies` → list of names per
ADR-0010); they don't get separate graph edges and the completion
algorithm doesn't process them. The recipe-layer F3 emit projects
bundled deps from the payload at stringify-time.

### §4.5 Convergence and termination

The algorithm is **deterministic** and **terminates**: each
iteration of the while-loop either consumes an existing node
(visited grows) or adds a new node (graph grows AND frontier
grows). The graph is finite and the registry's packument set is
finite; therefore the frontier eventually empties.

Cycle handling is automatic via `visited`: a node visited once
will not re-enter the frontier even if the same node arrives via
multiple paths.

### §4.6 Offline behaviour with frozenRegistry

When the runtime's `ctx.registry` is `frozenRegistry(graph)`, the
completion algorithm cannot fetch new packuments — every
`registry.packument(name)` call hits the in-graph index per
`registry/frozen.ts:packuments`. For the audit-fix v1 use case
(replace `lodash@4.17.20` → `lodash@4.17.21` where `4.17.21` is
ALREADY in graph as a sibling), the completion step is a no-op
(every transitive dep is already wired). This is the dominant
case empirically; the offline-first contract pays for itself.

When the modifier introduces a node whose `(name, version)` is
NOT in the frozen graph (e.g. audit-fix replacing with a version
that does not yet exist in the lockfile), `frozenRegistry.resolve`
returns undefined, `COMPLETION_UNRESOLVED` fires, and the caller
gets a graph with the modifier applied but the transitive closure
incomplete. The diagnostic surface is the explicit signal "supply
a live registry adapter to complete the operation" — no silent
failure.

## §5 Find-up resolve semantics (NORMATIVE)

The find-up algorithm answers: *given a consumer node N and a
dependency `(name, range)`, which existing node in the graph
should receive the new edge?* It is the central question every
hoisting-aware package manager asks (npm flat hoist,
yarn-classic flat, yarn-berry PnP map, pnpm isolated link, bun-text
hoist).

### §5.1 Canonical algorithm

The canonical find-up algorithm is **closest-ancestor-wins flat
hoist with nested fallback**:

```
findUp(graph, consumer, name, range, kind):
  # Walk consumer → root (no incoming edges).
  path = ancestorsOf(consumer)   # consumer first, root last
  for ancestor in path:
    candidates = graph.out(ancestor).filter(e =>
      getNode(e.dst).name === name
    ).map(e => getNode(e.dst))
    if candidates non-empty:
      satisfying = candidates
        .filter(c => semver.satisfies(c.version, range))
        # Tiebreaker — determinism vs. ADR-0007 content-sort:
        #   1. Highest semver-comparable version wins (rcompare).
        #   2. On version tie (e.g. distinct peerContext slots
        #      same version), lowest NodeId lex order wins
        #      (matches the canonical content sort).
        # Direction note: highest-satisfying version wins per find-up
        # semantics — diverges from ADR-0007's ascending iteration order
        # only in the resolve-time tiebreaker; the canonical NodeId-
        # iteration order remains ascending.
        .sort((a, b) => {
          const v = semver.rcompare(a.version, b.version)
          return v !== 0 ? v : cmpStr(a.id, b.id)
        })[0]
      if satisfying is defined:
        return satisfying
      # candidate exists but conflicts with range → block hoist; install nested
      return undefined
  return undefined
```

Two intents are encoded:

1. **Reuse** — if any ancestor (including the consumer itself for
   the workspace-root case) already depends on a satisfying
   `(name, version)`, the new edge points at that existing node.
   This is the npm / yarn-classic flat-hoist intent.
2. **Block hoist** — if an ancestor depends on a *conflicting*
   `name` (same name, range disagreement), find-up returns
   undefined and the caller (§4) installs a fresh nested node.
   This is the npm-3 nested-install fallback.

### §5.2 Ancestor enumeration

`ancestorsOf(consumer)`:

```
result = [consumer]
seen   = {consumer.id}
queue  = [consumer]
while queue non-empty:
  cur = queue.shift()
  for edge in graph.in(cur):
    if edge.src in seen: continue
    seen.add(edge.src)
    result.push(getNode(edge.src))
    queue.push(getNode(edge.src))
return result
```

This is BFS over incoming edges. Workspace→workspace edges per
ADR-0017 are traversed normally — a workspace node IS an ancestor
when it depends on the consumer. Cycles are tolerated via `seen`.

### §5.3 Per-PM-family projection

The canonical find-up algorithm runs **at the Graph layer** — it
does NOT change shape per format. Per-PM layout projection
(npm's `node_modules/<name>` path planning, pnpm's
`node_modules/.pnpm/<id>` shape, yarn-berry's `.pnp.cjs` map,
bun-text's flat-hoist + workspaces map) happens at **stringify
time**, projecting the canonical graph into PM-native bytes per
the existing format adapters.

The empirical projection map:

| PM family | Layout strategy | Find-up at layout-projection |
|-----------|-----------------|------------------------------|
| `npm-2` / `npm-3` | flat hoist via `packages` map (install-path keyed) | `_npm-core.ts` install-path planner already runs closest-ancestor flat hoist at stringify — the canonical find-up output maps 1:1 |
| `npm-1` | nested `dependencies` tree | tree shape recursive walk; closest-ancestor-wins encoded as parent-child traversal |
| `yarn-classic` | flat hoist (no `.pnp`) | same as npm-3 |
| `yarn-berry-v4+` | PnP via `.pnp.cjs` (NOT a hoist; explicit map) | every edge gets an entry in the resolution map regardless of hoist; find-up determines which node is the resolution target, not where it physically lives |
| `pnpm-v5+` | isolated `.pnpm/<id>/node_modules` | each node carries its own `node_modules`; find-up still applies to determine the resolved sibling at the consumer's link target |
| `bun-text` | flat hoist similar to npm | same as npm-3 |

**Recommendation (NORMATIVE).** Modifier and completion code run
the canonical find-up algorithm above; per-PM layout projection is
deferred to stringify-time (already implemented for npm in
`_npm-core.ts`; analogous projections for pnpm / yarn-berry / bun
follow the same pattern). This keeps the modification layer
**format-agnostic** — a modifier does not know whether the target
graph will eventually stringify to npm or pnpm.

### §5.4 Pin-exact semantics

When `range` is an exact version (`"1.2.3"`), find-up behaves
identically — `semver.satisfies('1.2.3', '1.2.3')` is true, so the
algorithm picks the exact-matching node when one exists in the
ancestor chain. The pin-exact case is therefore not a separate
algorithm; it is a degenerate range.

### §5.5 Workspace boundary

A workspace node's `workspacePath !== undefined` does NOT carry
find-up implications by itself — the ancestor-walk continues
through workspaces as it would through any node. However: when
the consumer is a regular dep of a workspace, and the workspace
ancestor declares the same `name` at a satisfying range, the hoist
target IS the workspace's declared dep (the standard hoist), not
the workspace itself.

The corner case of two sibling workspaces depending on different
versions of the same package is handled by the canonical
ancestor walk: each consumer's walk reaches its own workspace
parent first; if that workspace's deps satisfy, hoist there. Cross-
workspace `dep` edges (ADR-0017) participate in the ancestor walk
identically to non-workspace edges.

### §5.6 Failure mode: ambiguous root

When the consumer is itself a root (`graph.roots()` contains it
and there are no incoming edges), the ancestor chain is just
`[consumer]`. The find-up algorithm checks the consumer's own
out-edges; if no satisfying sibling exists there, find-up returns
undefined and the caller installs a new node directly under the
consumer (nested install at the root).

This degenerate case is the typical `audit-fix` against a
single-package non-workspace project: the project's `package.json`
declares the deps, the new dep gets installed alongside.

## §6 RegistryAdapter usage (NORMATIVE)

### §6.1 Capability contract

Every modifier primitive's interaction with the registry follows
the same pattern:

1. **First, consult the graph itself** via
   `frozenRegistry(graph)` — free, deterministic, offline.
2. **If the graph cannot answer**, call
   `ctx.registry.resolve(name, range)` or
   `ctx.registry.packument(name)`. The adapter MAY be the
   frozenRegistry (offline mode), MAY be a CacheAdapter-backed
   read facade (Phase D — `cache/` subpath), MAY be a live HTTP
   adapter (Phase D — `registry/live.ts`).
3. **Wrap with CacheAdapter** when the caller supplies one — a
   live HTTP registry can be persisted between modifier calls via
   a `cache: ...` opt-in passed through `ModifyContext`.

The adapter contract is **read-only**: modifiers never write back
to the registry. Cache writes are CacheAdapter's responsibility,
not the modifier's.

### §6.2 Offline-first guarantee

Modifiers MUST be **functional offline against `frozenRegistry`**.
Concretely:

- `replaceVersion` where `toRange` resolves to a version present
  in graph (audit-fix v1): completes offline.
- `pinOverride` where target version is in graph: completes offline.
- `addDependency` where target node is already in graph: completes
  offline.
- `removeDependency`: completes offline (no registry needed).
- `applyPatch`: completes offline (no registry needed).
- `filterLicense`: completes offline (license is in
  `TarballPayload`).

The cases that **require** a non-frozen registry:

- `replaceVersion` where `toRange` does not resolve to a node in
  graph (e.g. audit-fix to a version newer than anything in the
  lockfile).
- `addDependency` where the new dep is unknown to graph.
- Completion where a newly-added node drags in transitive deps
  not in graph.

In these cases, the frozen registry returns `undefined` and the
caller gets a `COMPLETION_UNRESOLVED` (or `MODIFY_RESOLVE_FAILED`)
diagnostic. The modifier did not silently fail — it surfaced the
need for live adapter access. Phase D adds the adapter; this ADR
fixes the gating contract.

### §6.3 Peer-context propagation reminder

`frozenRegistry` does NOT preserve peer-context — its
`PackumentVersion` carries `peerDependencies` (name → range) but
does not carry pre-virtualised peer-context. When the modifier
introduces a node that has peer-deps, the resulting node's
`peerContext` is `[]` at insertion; the existing parse-time
peer-virt enrichment pass (recipe-layer / per-adapter enrich)
will fix this on the next ADR-0008 iteration via
`replacePeerContext`.

For audit-fix v1 use cases (which dominate empirically), the
replaced node usually inherits the original's peer-context
verbatim because the same `(name, range)` pair satisfies — no
peer-virt rebind is needed.

## §7 Diagnostic taxonomy (NORMATIVE)

The modification layer introduces two new diagnostic families,
distinct from recipe-layer `RECIPE_*` (ADR-0014 §5),
per-format `<FORMAT>_*`, and interop `INTEROP_*` (ADR-0020 §3).

### §7.1 `MODIFY_*` family (one emit per modifier intent)

| Code | Severity | Modifier | When emitted |
|------|----------|----------|---------------|
| `MODIFY_NODE_REPLACED` | info | replaceVersion, pinOverride, applyPatch | once per replaced node — message names the from/to NodeIds |
| `MODIFY_NODE_ADDED` | info | addDependency | once per added node — message names the consumer + new NodeId |
| `MODIFY_NODE_REMOVED` | info | removeDependency, filterLicense (strict) | once per removed node |
| `MODIFY_EDGE_REWIRED` | info | replaceVersion (merge branch), addDependency (reuse branch) | once per edge retargeted |
| `MODIFY_PATCH_APPLIED` | info | applyPatch | once per patched node |
| `MODIFY_LICENSE_FLAGGED` | warning | filterLicense | once per node whose license is in the deny set OR not in the allow set (mode='diagnostic-only') |
| `MODIFY_LICENSE_BLOCKED` | warning | filterLicense (strict) | once per node that strict mode would remove but cannot (workspace-rooted); caller policy decides if it's a hard block |
| `MODIFY_RESOLVE_FAILED` | warning | any registry-dependent primitive | once per primitive call when `registry.resolve` returns undefined |
| `MODIFY_SENTINEL_REFUSED` | warning | replaceVersion, applyPatch, pinOverride, any primitive routed via `replaceNode` / `setTarball` / `replacePeerContext` | once per matched node whose `patch` is sentinel-keyed per ADR-0011 (`startsWith('unresolved-')`); the Mutator would throw `LockfileError({ code: 'IRREDUCIBLE_LOSS' })` on byte-modifying ops, so the modifier detects in advance, emits this diagnostic, and skips the node. `subject = nodeId` |
| `MODIFY_OVERRIDE_PINNED` | info | pinOverride | once per `pinOverride` call when `registry.resolve` succeeded; `subject = 'graph'`; `message` includes `name` and resolved version. Emitted via `Mutator.diagnostic(d)` inside the mutate transaction (§3.2 emission path / §8.6 Mutator API extension) so the record lands on `Graph.diagnostics()`. Stringify adapters read from `Graph.diagnostics()` to project the override into PM-native bytes (no new Graph field is introduced; `ModifyResult.unresolved` is NOT the read channel) |

### §7.2 `COMPLETION_*` family (one emit per tree-completion event)

| Code | Severity | When emitted |
|------|----------|---------------|
| `COMPLETION_NODE_ADDED` | info | once per node added during tree-completion (separate from `MODIFY_NODE_ADDED` to distinguish caller-intent additions from completion-cascade additions) |
| `COMPLETION_EDGE_RESOLVED` | info | once per edge wired via the find-up reuse branch |
| `COMPLETION_UNRESOLVED` | warning | once per dependency that cannot be resolved (registry returned undefined) |
| `COMPLETION_NODE_UNKNOWN` | warning | once per node visited whose packument the registry cannot supply |
| `COMPLETION_VERSION_UNKNOWN` | warning | once per node whose packument exists but lacks the node's exact version (likely stale registry vs. graph) |
| `COMPLETION_PEER_CONTEXT_INCOMPLETE` | warning | once per consumer node (`subject = nodeId`) whose peer dep completion find-up resolved BUT adding the edge would require a `peerContext` rebind on the consumer (ADR-0006 invariant) — peer-virt rebind at modify-time is out of scope for v1 (§4.3, §10), so completion emits the warning and proceeds without the edge. Stringify-side enrich (recipe-layer) surfaces the gap per format on the next ADR-0008 iteration. |

### §7.3 Diagnostic shape

Inherits the per-format `Diagnostic` shape (`graph.ts:Diagnostic`):

```ts
type ModifyDiagnostic = {
  code:     `MODIFY_${string}` | `COMPLETION_${string}`
  severity: 'info' | 'warning' | 'error'
  subject:  NodeId | EdgeTriple | 'graph'
  message:  string
}
```

The `subject: 'graph'` literal denotes a graph-wide event (no
specific node or edge is the locus) — examples: `MODIFY_OVERRIDE_PINNED`
(per §7.1) records a Graph-level intent, not a single-node mutation.
Per-node and per-edge codes use `NodeId` / `EdgeTriple` respectively.

### §7.4 Composition with existing families

- `RECIPE_*` codes (ADR-0014) fire at the adapter parse / stringify
  boundary — they do not fire during modification. A modification
  step that changes a node's patch (`applyPatch`) emits
  `MODIFY_PATCH_APPLIED`; the recipe-layer `RECIPE_PATCH_NORMALISED`
  fires only when the patch BYTES are re-parsed via
  `recipe.parse.patchBytes`, which `applyPatch` invokes once per
  call. Both codes may fire on the same modifier call —
  `RECIPE_PATCH_NORMALISED` is the byte-normalisation event,
  `MODIFY_PATCH_APPLIED` is the graph-mutation event. Cardinality:
  `RECIPE_PATCH_NORMALISED` fires once (the bytes are normalised
  once); `MODIFY_PATCH_APPLIED` fires per affected node.
- `INTEROP_*` codes (ADR-0020) fire at the cross-format test
  assertion gate; they do not fire during modification.
- `<FORMAT>_*` codes fire at adapter parse / stringify; the
  modification layer does not emit them.

### §7.5 Diagnostic streaming

The `ModifyResult` carries its diagnostics in
`unresolved: Diagnostic[]`; callers may additionally pass an
`onDiagnostic: (d: Diagnostic) => void` callback via
`ModifyOptions` to stream events as they happen. The streaming
semantics match the existing `ConvertOptions.onDiagnostic`
(ADR-0014 §3) — caller orchestrates routing to logs, UI, audit
report files.

## §8 Implementation strategy (NORMATIVE)

### §8.1 Directory shape

```
src/main/ts/
├── modify/
│   ├── index.ts              # public re-export
│   ├── replace-version.ts    # §3.1 replaceVersion
│   ├── pin-override.ts       # §3.1 pinOverride
│   ├── add-dependency.ts     # §3.1 addDependency
│   ├── remove-dependency.ts  # §3.1 removeDependency
│   ├── apply-patch.ts        # §3.1 applyPatch
│   ├── filter-license.ts     # §3.1 filterLicense
│   ├── context.ts            # ModifyContext type, default factory
│   └── diagnostics.ts        # MODIFY_* code constants + helpers
└── complete/
    ├── index.ts              # public re-export
    ├── tree-complete.ts      # §4 completion algorithm
    ├── find-up.ts            # §5 find-up resolve
    └── diagnostics.ts        # COMPLETION_* code constants + helpers
```

Recipe layer (`src/main/ts/recipe/`) and registry layer
(`src/main/ts/registry/`) stay untouched — they are consumed by
modify/complete, not amended.

### §8.2 Public surface

Per README §"Sub-imports":

```ts
// @antongolub/lockfile/modify
export {
  replaceVersion,
  pinOverride,
  addDependency,
  removeDependency,
  applyPatch,
  filterLicense,
  // composed
  modify,           // single primitive entry point
}

// types
export type {
  ModifyContext,
  ModifyOptions,
  ModifyResult,
  ModifyDiagnostic,
}
```

`modify(graph, primitive, options?)` is the thin orchestrator:

```ts
function modify(
  graph:    Graph,
  primitive: Primitive,            # discriminated union of intent payloads
  options?:  ModifyOptions,
): Promise<ModifyResult>
```

Internally `modify()` dispatches by primitive kind to the
appropriate file, then invokes `completeTransitives` on the result
graph.

Top-level `parse` / `stringify` remain unchanged — modification is
opt-in via the subpath import. The existing `convert()` sugar
(ADR-0014 §3) does NOT thread modification — `convert` is
pure parse → stringify with no modifier hook. Adding a
`modify: Primitive[]` option to `ConvertOptions` is a future
ergonomic ADR if demand surfaces; out of scope here.

### §8.3 Async signature

Modifier primitives are `async` because the registry adapter
contract is `Promise<...>` (per Phase C `registry/types.ts`). The
frozenRegistry happens to be synchronous internally but exposes
the same async contract; callers always await.

The graph's `Mutator` transaction is synchronous (per
`graph.ts:670`); modifiers compose by collecting intent before
invoking `graph.mutate()`.

**ADR-0008 fixpoint async amendment — normative.** ADR-0008's
iterative `modify → enrich → ...` loop pre-dates the registry
adapter contract and was originally stated in synchronous terms.
ADR-0023 modifies that contract: the loop runs **async** — each
modifier primitive is awaited, and the convergence check (graph
hash comparison) happens between awaits. Concretely: the loop
body awaits the current primitive's `Promise<ModifyResult>`,
folds the result graph + diagnostics, then either dispatches the
next primitive or exits on fixpoint. ADR-0008 itself is not
amended in this commit; the contract delta is captured here and a
follow-up amendment to ADR-0008 may inline this clause if Anton
ratifies (see commit body / `spec/QUEUE.md`).

### §8.4 Integration with ADR-0008 pipeline

The ADR-0008 iterative pipeline composes modify + enrich until
fixpoint. Each iteration (all steps awaited per §8.3 async
amendment):

1. **Mutate** — apply pending modifier primitive(s). May leave
   orphans in the graph (e.g. `replaceVersion` merge-branch
   removes the old NodeId; `removeDependency` drops an edge whose
   tail had only one in-edge).
2. **Complete** — run `completeTransitives` to wire new nodes.
   Monotone-additive ONLY: completion adds nodes and edges, never
   removes. Orphans from step 1 are NOT visited (per §4 frontier-
   exclusion clause) and do not generate `COMPLETION_NODE_UNKNOWN`
   noise.
3. **Enrich** — run the existing enrich pass (per-adapter;
   recipe-layer refines on parse-time).
4. **Optimize** — GC orphans (nodes with zero in-edges after the
   complete step, excluding workspace nodes per ADR-0017). This is
   `removeDependency`'s recursive-GC semantics (§3.2) applied
   graph-wide.
5. **Converge** — compare graph hash to previous iteration; if
   unchanged, exit.

The convergence guarantee (ADR-0008 §"Convergence requirements")
holds because:

- Modifiers are eventually-idempotent (§3.4).
- Completion is **monotone-additive** — it only adds nodes and
  edges, never removes. The GC of orphans is owned by the
  optimize phase (step 4), not by completion or the modifiers
  themselves (the modifiers leave orphans; optimize collects).
  Once a transitive closure is complete, re-running completion is
  a no-op.

### §8.5 Wiring to `Mutator`

Modifier files MUST NOT import from `graph.ts` other than the
public types and `Graph.mutate`. They MUST NOT depend on internal
`State`, `shallowClone`, `validate`, or `reindex` helpers. The
boundary between modify/ and graph/ is the published Mutator
interface.

This keeps the Mutator's invariants (ADR-0017 workspace seal,
ADR-0011 sentinel refusal, peer-edge coherence) inviolable across
modifier code.

### §8.6 Mutator API extension — write-side diagnostic surface

The §3.2 `pinOverride` flow is normative: stringify-side adapters
read the override record from `Graph.diagnostics()`. That read
path requires a corresponding write path inside the
`graph.mutate(transaction)` boundary — the modifier must be able
to push a diagnostic onto the resulting Graph's diagnostic list
without bypassing the Mutator. The existing `Mutator` interface
(`graph.ts` ~L112) exposes structural mutations
(`addNode` / `removeNode` / `addEdge` / `replacePeerContext` /
`setTarball` / `removeTarball`) but no diagnostic-append method,
so v1 modifier work-arounds (e.g. landing the override record in
`ModifyResult.unresolved`) violate the §3.2 read-side contract:
the stringify adapter looking at `Graph.diagnostics()` would NOT
see the pin.

**Normative — Mutator surface widening.** The Mutator interface
MUST gain one additional method:

```ts
diagnostic(diagnostic: Diagnostic): void
```

Semantics: appends the supplied `Diagnostic` to the resulting
Graph's diagnostic list. Visible via `Graph.diagnostics()` once
the surrounding `graph.mutate(transaction)` call settles. The
existing `Builder.diagnostic(d)` (`graph.ts` ~L146) already
implements the append on the sealing path; the Mutator's
`.diagnostic(d)` delegates to that builder surface so the
parse-time and modify-time diagnostic emit paths share one
implementation.

`ModifyResult.unresolved` remains the per-call diagnostic stream
(streaming hook + per-result aggregation per §7.5) but it is NOT
the canonical read channel for stringify-side adapters consulting
Graph-level state. `Graph.diagnostics()` is.

**Impl follow-up (NOT this ADR's commit).** A 1-line
addition to the `Mutator` interface declaration in `graph.ts` +
a 1-line delegation through the mutate transaction's internal
Builder is required to fulfil this contract. Captured as
implementer follow-up on `implementer/modifier-primitives` —
graph.ts surface widening + pin-override.ts diagnostic-channel
correction. The follow-up is normative-mandatory: until it lands,
the §3.2 pinOverride stringify-read path is unimplemented and
adapters relying on it will see empty diagnostics.

## §9 Acceptance gates (NORMATIVE)

### §9.1 Ratification gates (this ADR's commit)

1. **Cold-reader gate.** A subagent reads ADR-0023 end-to-end
   without prior context and can answer: *what are the six
   modifier primitives, what does each return, what does the
   completion algorithm do, what does find-up do, what families
   of diagnostics fire, how does this compose with ADR-0008 /
   ADR-0014 / Phase C registry* — without re-reading. Per
   ADR-0014 §6.1 precedent.

2. **Vocabulary harmonisation.** The terms `modifier primitive` /
   `tree completion` / `find-up` / `frozenRegistry` / `live
   registry` / `MODIFY_*` / `COMPLETION_*` / `closest-ancestor
   wins` / `nested fallback` / `eventually-idempotent` /
   `ModifyContext` / `ModifyResult` are each used consistently
   across §§1–8; no synonym drift with ADR-0008 (which uses
   "modify" in the loop sense) or with recipe-layer terms.

3. **No outsourcing.** Every primitive at §3 has a defined
   intent, signature, semantics. The completion algorithm at §4
   has pseudocode. The find-up algorithm at §5 has pseudocode and
   per-PM-family projection table. Diagnostic codes are
   enumerated in full at §7. No "see future ADR" deferrals for
   definitional content.

### §9.2 Implementation gates (per implementer round, NOT this ADR's commit)

Implementer rounds land the `src/main/ts/modify/` and
`src/main/ts/complete/` directories. The per-primitive acceptance
gate is:

| Primitive | Implementer-round assertion |
|-----------|------------------------------|
| `replaceVersion` | Audit-fix v1 fixture: replace `lodash@4.17.20` → `lodash@4.17.21` in an npm-3 lockfile where both versions exist as siblings; the post-modify graph emits to npm-3 byte-equal to a hand-authored fix; `MODIFY_NODE_REPLACED` emits once per affected node; runs against `frozenRegistry(graph)` alone (no live adapter). |
| `pinOverride` | Pin `axios` to `1.6.0` graph-wide; resulting graph projects to pnpm-v9 with the override declared in the source-projected `overrides:` block; emits `MODIFY_NODE_REPLACED` per affected node. |
| `addDependency` | Add `dotenv@16` to a workspace consumer's deps; completion wires `dotenv`'s transitive closure (in a frozen-registry corpus, if all transitives exist; else `COMPLETION_UNRESOLVED` emits). |
| `removeDependency` | Remove a dep edge + GC orphans; resulting graph emits to npm-3 / pnpm-v9 / yarn-berry-v9 without dangling-edge errors. |
| `applyPatch` | Apply a patch to `lodash`; resulting NodeId carries `+patch=<sha512-hex>`; F5 byte normalisation runs (per ADR-0014); `RECIPE_PATCH_NORMALISED` AND `MODIFY_PATCH_APPLIED` emit. |
| `filterLicense` | Walk a graph carrying `MIT` + `GPL-3.0` licenses with `deny: ['GPL-3.0']`; in `diagnostic-only` mode, `MODIFY_LICENSE_FLAGGED` emits per GPL node; in `strict` mode, the GPL nodes are removed and downstream stringify produces a valid lockfile. |

Each assertion lands in `src/test/unit/modify-<primitive>.test.ts`
and `src/test/integration/modify-<primitive>.test.ts`.

Per-PM cross-conversion gate: for each primitive, the modified
Graph stringifies to npm-3 / pnpm-v9 / yarn-berry-v9 (the three
"reference" adapters) and the resulting bytes parse back to a
graph that satisfies a `diff(modified, reparsed) === {}` modulo
declared lossy partitions per ADR-0020 §3.

### §9.3 Offline-first gate

For every primitive whose Phase D adapter has NOT yet landed
(i.e. all of them at ADR-0023 commit time), the implementer-round
acceptance MUST run against `frozenRegistry(graph)` alone. A
primitive that requires a live HTTP adapter to pass v1 acceptance
is a contract violation — the modifier surface is designed to
degrade to `COMPLETION_UNRESOLVED` warnings when the frozen
registry cannot answer, NOT to fail.

## §10 Out of scope (for THIS ADR)

- **Live HTTP registry adapter** — Phase D. Lands as a separate
  implementer round; ADR-0023 fixes the contract Phase D consumes
  (`RegistryAdapter` interface per Phase C `registry/types.ts`).
  A future ADR may add live-registry behaviour beyond the
  `packument` / `resolve` shape — retries, throttling, mirrors,
  authentication — at which point it gets its own ADR.
- **File-system PM cache discovery** — Phase D. The
  `CacheAdapter.packument` / `CacheAdapter.tarball` contract is in
  Phase C; the implementations (npm cache, yarn-berry cache, pnpm
  cache, bun cache) are Phase D. ADR-0023 fixes the read
  surface; per-PM cache layout is the implementer's concern.
- **`installDir` refinement** — the `installDir` opt-in in
  `ParseOptions` (README) reads from an on-disk `node_modules` /
  `.pnp.cjs` to refine the parsed graph. Out of scope here; ADR-0023
  is the modification layer, not the parse refinement layer.
- **Patch authoring** — generating a new patch from a workspace
  edit is out of scope. ADR-0023 covers patch APPLICATION
  (`applyPatch` with caller-supplied bytes); patch authoring is a
  separate concern (and arguably not lockfile territory at all —
  more `patch-package` / `pnpm patch-commit` territory).
- **Advisory feed integration** (npm audit / OSV / GHSA → modifier
  intents) — separate concern; likely a separate
  `@antongolub/lockfile/advise` subpath. ADR-0023's modifier
  primitives consume already-formed intents.
- **Modifier-time peer-virt synthesis** — when a modifier
  introduces a node with peer-deps that bind to different
  versions than any existing peer-virt sibling, synthesising a
  new peer-virtualised node is recipe-layer territory (ADR-0006
  / ADR-0014). The v1 modifier surface defers to the
  parse-time enrich pass for peer-virt; future ADR carves out
  modifier-time peer-virt when fixture demand surfaces.
- **`overrides:` semantics beyond pin-and-patch** — the pnpm
  `overrides:` block carries version-override entries that this
  ADR's `pinOverride` covers, and patch entries that `applyPatch`
  covers. Other override shapes (URL substitutions, alias
  remappings) are adapter-internal until a follow-up ADR.
- **Modifier discovery** — auto-detecting which modifier to apply
  from a high-level intent ("fix all advisories") is a separate
  orchestration concern. ADR-0023 fixes the primitive vocabulary;
  the orchestrator that calls them is downstream.
- **`addDependency.kind ∈ { 'peer', 'bundled' }`** — for v1, the
  `addDependency` primitive (§3.1) admits only `'dep' | 'dev' |
  'optional'`. Adding a `'peer'` edge requires coexistence with
  the `peerContext` on the consumer (`graph.ts:replacePeerContext`
  rebind logic + ADR-0006 NodeId grammar), and adding a
  `'bundled'` edge requires new `bundledDependencies` handling at
  the recipe layer. Both are deferred to a follow-up ADR; the v1
  modifier vocabulary covers the audit-fix / pin / patch / license
  filtering surface that motivates the headline mission shift
  (§1.1).

## §11 Links

- [README.md](../../README.md) — aspirational
  `@antongolub/lockfile/modify` surface this ADR pins.
- [ADR-0001](./0001-three-layer-model.md) — three-layer model
  (Manifest / Graph / Layout); modification operates at the
  Graph layer.
- [ADR-0006](./0006-pnpm-style-peer-context.md) — NodeId grammar
  consumed by modifier identity preservation (§3.3).
- [ADR-0008](./0008-iterative-modify-enrich-pipeline.md) —
  iterative pipeline; modifier primitives plug into this loop;
  this ADR owns one iteration's modifier + completion semantics.
- [ADR-0010](./0010-tarball-payload-graph-level.md) — graph-level
  tarball payload; new nodes synthesised by completion carry
  payload via `setTarball`.
- [ADR-0011](./0011-tarball-key-disambiguation.md) — patch
  slot grammar; `applyPatch` consumes the F2 canonical form and
  the sentinel-keyed refusal rule.
- [ADR-0014](./0014-canonical-recipe-input-normalisation.md) —
  canonical recipe layer (F1–F5); modification layer does not
  redefine F1–F5, it consumes them at parse / stringify.
- [ADR-0017](./0017-graph-seal-workspace-edges.md) — workspace
  seal; modifier ancestor walk and completion traversal honour
  the workspace-only-from-workspace incoming-edge rule.
- [ADR-0020](./0020-cross-format-interop-test-architecture.md) —
  conversion test matrix; ADR-0023 acceptance gates §9.2 cross-
  conversion assertion runs through the ADR-0020 matrix.
- [`src/main/ts/graph.ts`](../../src/main/ts/graph.ts) —
  Mutator interface; modifier files dispatch via
  `graph.mutate(transaction)`.
- [`src/main/ts/registry/types.ts`](../../src/main/ts/registry/types.ts)
  (Phase C, parallel branch) — `RegistryAdapter` /
  `CacheAdapter` / `PackumentVersion` shapes consumed by
  modifiers (§6) and completion (§4).
- [`src/main/ts/registry/frozen.ts`](../../src/main/ts/registry/frozen.ts)
  (Phase C, parallel branch) — offline-first adapter reference;
  the audit-fix v1 dominant case runs against this adapter alone.
