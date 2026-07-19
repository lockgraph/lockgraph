// pruneOrphans — reference-count orphan GC (the sibling of `optimize`).
//
// After a dependency-changing bump,
// `completeTransitives` (additive) leaves the OLD version's now-dereferenced
// closure (e.g. handlebars 4.0.0's async / optimist / uglify-js@2.x + their
// deps) behind as orphans. `yarn install --immutable` then fails because those
// removable nodes count as a pending change.
//
// `optimize` (ADR-0024) is the WRONG tool here: it is a REACHABILITY sweep
// (keep iff reachable from a workspace), so on a graph with incomplete edges it
// drops present-but-unreferenced dev / optional / peer nodes a valid lock must
// keep — a reachability sweep on an incomplete-edge graph removes valid
// dev/optional/peer nodes.
//
// pruneOrphans is REFERENCE-COUNTING instead: it removes only a node that has
// lost its LAST incoming edge of ANY kind (dep / dev / optional / peer) —
// in-degree 0 — and cascades (removing a node may strand its children). A node
// that anything still points at is never touched, even when that referrer is
// itself unreachable from a workspace. On a valid lock where every package is
// referenced it removes nothing; after a bump it retires exactly the stranded
// old closure. Workspaces are never collected (they anchor the tree at
// in-degree 0). Monotone-REDUCTIVE: only removals + diagnostics, never growth.

import { serializeNodeId, type Diagnostic, type Graph, type Node, type NodeId } from '../graph.ts'
import { pruneNodeRemoved, pruneNoop, pruneNoRoots } from './diagnostics.ts'

export interface PruneOrphansOptions {
  /** Stream diagnostics as they fire (mirrors the modify / optimize channel). */
  onDiagnostic?: (d: Diagnostic) => void
  /** NodeIds to keep even at in-degree 0 (intentional roots; rare). */
  preserve?:     ReadonlySet<NodeId>
  /**
   * Bound the sweep to a candidate set. When provided, ONLY these NodeIds (and
   * the closure they transitively strand) are removal candidates — any OTHER
   * pre-existing in-degree-0 node is left untouched.
   *
   * **Seeded is the SAFE / recommended mode for post-mutation GC.** Pass the
   * mutation's orphaned NodeIds (`replaceVersion`'s `recentlyOrphaned` — which
   * now includes the targets whose last incoming edge a rebind's edge-refresh
   * dropped). The sweep then retires exactly that delta and CANNOT touch a node
   * the mutation never affected — including ones that only LOOK orphaned because
   * an incoming edge is unresolved in the parse (e.g. berry `@patch:…!builtin`
   * fsevents). Omit only for a whole-graph sweep on a graph whose edges you trust
   * to be complete; the unseeded path over-prunes such unresolved-edge nodes and
   * is guarded against wiping a rootless lock (PRUNE_NO_ROOTS).
   */
  seed?:         ReadonlySet<NodeId>
}

export interface PruneOrphansResult {
  graph:      Graph
  /** NodeIds removed by this call, in removal order. */
  removed:    NodeId[]
  /** All diagnostics this call emitted, in emission order. */
  unresolved: Diagnostic[]
}

const EMPTY: ReadonlySet<NodeId> = new Set()

/**
 * Remove every non-workspace node that has lost its last incoming edge, plus
 * the closure such removals strand. See the module header for why this is
 * reference-counting, not reachability (and how it differs from `optimize`).
 *
 * Synchronous + deterministic (worklist seeded in `graph.nodes()` content-sort
 * order). Idempotent: a second call on the result removes nothing.
 */
export function pruneOrphans(graph: Graph, options: PruneOrphansOptions = {}): PruneOrphansResult {
  const preserve     = options.preserve ?? EMPTY
  const onDiagnostic = options.onDiagnostic

  const removed:    NodeId[]     = []
  const unresolved: Diagnostic[] = []
  const emit = (d: Diagnostic): void => {
    unresolved.push(d)
    if (onDiagnostic !== undefined) onDiagnostic(d)
  }

  let current: Graph = graph

  // No-roots guard (UNSEEDED only). A whole-graph sweep with no workspace anchor
  // would treat every top-level dependency (in-degree 0) as an orphan and
  // cascade-wipe a rootless yarn-classic lock. No-op + warn instead; a seeded
  // sweep is always bounded to its delta, so the guard never applies to it.
  if (options.seed === undefined) {
    let hasNodes = false
    let hasWorkspace = false
    for (const node of current.nodes()) {
      hasNodes = true
      if (node.workspacePath !== undefined) { hasWorkspace = true; break }
    }
    if (hasNodes && !hasWorkspace) {
      const diag = pruneNoRoots()
      const guarded = current.mutate(m => { m.diagnostic(diag) }).graph
      emit(diag)
      return { graph: guarded, removed, unresolved }
    }
  }

  // A node is collectable iff it is non-workspace, not preserved, and has zero
  // incoming edges. With a `seed`, only seeded candidates bootstrap the sweep
  // (a transitively-stranded child still gets enqueued once its parent goes).
  const collectable = (id: NodeId): boolean => {
    const node = current.getNode(id)
    if (node === undefined) return false                 // already removed
    if (node.workspacePath !== undefined) return false   // workspaces anchor the tree
    if (preserve.has(id)) return false
    if (current.in(id).length > 0) return false
    // Patch-base preservation. A `@patch:…!builtin` (or any patched/source-tagged)
    // node is a SEPARATE lock entry installed ON TOP of its bare base
    // (`fsevents@npm:2.3.3` under `fsevents@patch:…#optional!builtin`), and
    // consumers' edges route to the patched variant — so the base sits at
    // in-degree 0 yet yarn KEEPS it (both entries are in a valid lock). Keep a
    // bare node while any patched/sourced variant of it is still present.
    if (hasLivePatchedVariant(current, node)) return false
    return true
  }

  const queue: NodeId[] = []
  if (options.seed !== undefined) {
    for (const id of options.seed) if (collectable(id)) queue.push(id)
  } else {
    for (const node of current.nodes()) if (collectable(node.id)) queue.push(node.id)
  }

  while (queue.length > 0) {
    const id = queue.shift()!
    if (!collectable(id)) continue   // re-validate: may have been removed, or never qualified

    const node = current.getNode(id)!
    // Children lose this edge when `id` goes (removeNode cascades out-edges off
    // each target's incoming list), so re-test them afterwards.
    const children = current.out(id).map(e => e.dst)
    const tarballInputs = { name: node.name, version: node.version, patch: node.patch }
    const diag = pruneNodeRemoved(id)

    current = current.mutate(m => {
      m.removeNode(id)   // zero incoming by construction → no "remove edges first" throw
      if (current.tarball(tarballInputs) !== undefined && !tarballSharedByOther(current, id, tarballInputs)) {
        m.removeTarball(tarballInputs)
      }
      m.diagnostic(diag)
    }).graph

    removed.push(id)
    emit(diag)

    for (const child of children) if (collectable(child)) queue.push(child)
  }

  if (removed.length === 0) {
    const noop = pruneNoop()
    current = current.mutate(m => { m.diagnostic(noop) }).graph
    emit(noop)
  }

  return { graph: current, removed, unresolved }
}

/**
 * True iff `node` is a BARE base (no patch / source slot) for which a
 * patched / source-tagged variant is still present — i.e. some other node with
 * the same `(name, version, peerContext)` carries a `+patch=` / `+src=` slot.
 * Such a base is the install source of its variant and must outlive a GC even
 * at in-degree 0 (yarn keeps both the `@npm:` and the `@patch:…!builtin` entry).
 */
function hasLivePatchedVariant(graph: Graph, node: Node): boolean {
  if (node.patch !== undefined || node.source !== undefined) return false
  for (const id of graph.byName(node.name)) {
    if (id === node.id) continue
    const other = graph.getNode(id)
    if (other === undefined) continue
    if (other.patch === undefined && other.source === undefined) continue
    if (other.version !== node.version) continue
    if (serializeNodeId(other.name, other.version, other.peerContext, undefined, undefined) === node.id) return true
  }
  return false
}

/**
 * A tarball is keyed by `(name, version, patch)` and SHARED across peer-virt
 * siblings (which differ only by peerContext). Removing it while a sibling
 * survives would strip that sibling's integrity/resolution — so only drop the
 * tarball when no OTHER node still carries the same key.
 */
function tarballSharedByOther(
  graph: Graph,
  removingId: NodeId,
  key: { name: string; version: string; patch?: string },
): boolean {
  for (const id of graph.byName(key.name)) {
    if (id === removingId) continue
    const n = graph.getNode(id)
    if (n !== undefined && n.version === key.version && n.patch === key.patch) return true
  }
  return false
}
