// ADR-0023 §3.2 — `replaceVersion`.
//
// Replace every node matching `{name, fromRange}` with one resolving to
// `toRange`. The audit-fix workhorse. `toRange` is forwarded VERBATIM to
// registry.resolve (semver range / dist-tag / exact version per Phase C).
// `fromRange === '*'` is a degenerate "match all" short-circuit.
//
// Critical normative items honoured:
//   B1: sentinel-keyed source detection BEFORE Mutator call (§3.3).
//   B3: toRange forwarded verbatim (no transformation).
//   B5: post-modifier graph may carry orphans (don't GC inside modifier).
//   F3: merge transaction retargets incoming edges FIRST, then removeNode.
//   F4: async; convergence checks between awaits.

import semver from 'semver'
import {
  serializeNodeId,
  type Diagnostic,
  type EdgeKind,
  type Graph,
  type MutateResult,
  type Node,
  type NodeId,
} from '../graph.ts'
import { isSentinelPatch } from '../recipe/patch.ts'
import { payloadOfPackumentVersion } from '../registry/payload.ts'
import type { ModifyContext } from './context.ts'
import {
  modifyEdgeRewired,
  modifyNodeReplaced,
  modifyResolveFailed,
  modifySentinelRefused,
  type ModifyDiagnostic,
} from './diagnostics.ts'

export interface ReplaceVersionSelector {
  name:       string
  /** Semver range; '*' = match all (degenerate short-circuit). Defaults to '*'. */
  fromRange?: string
}

export interface ReplaceVersionResult {
  graph:            Graph
  /** Net-new NodeIds (rebinds AND merges count when a target is fresh). */
  added:            NodeId[]
  /** NodeIds removed (merge branch only — simple rebind keeps the same node "slot"). */
  removed:          NodeId[]
  /** From/to pairs for every successful replacement. */
  replaced:         Array<{ from: NodeId; to: NodeId }>
  /** ADR-0023 §4.1 — NodeIds for the completion frontier seed. */
  recentlyAdded:    Set<NodeId>
  /** ADR-0023 §4.1 — NodeIds excluded from the completion frontier seed. */
  recentlyOrphaned: Set<NodeId>
  /** ADR-0023 §7.5 — all diagnostics emitted by this primitive call. */
  unresolved:       Diagnostic[]
}

export interface ReplaceVersionOptions {
  context?:      ModifyContext
  onDiagnostic?: (d: Diagnostic) => void
}

export async function replaceVersion(
  graph: Graph,
  selector: ReplaceVersionSelector,
  toRange: string,
  context: ModifyContext,
  options: { onDiagnostic?: (d: Diagnostic) => void } = {},
): Promise<ReplaceVersionResult> {
  const onDiagnostic = options.onDiagnostic
  const unresolved: Diagnostic[] = []
  // Per ADR-0023 §7.5: ModifyResult.unresolved carries ALL diagnostics emitted
  // by this primitive call (info / warning / error). The `onDiagnostic` stream
  // mirrors the same events for live consumption.
  // ADR-0023 §8.6 Mutator API extension: MODIFY_* diagnostics ALSO land on
  // Graph.diagnostics() so the stringify-side read channel is consistent with
  // §3.2 pinOverride. Each emit-call routes the diagnostic via a pending list;
  // the caller emits inside a mutate transaction to honour the "lands on the
  // resulting Graph" contract.
  const emit = (d: ModifyDiagnostic): void => {
    unresolved.push(d)
    if (onDiagnostic !== undefined) onDiagnostic(d)
  }

  // 1. Resolve target.
  const target = await context.registry.resolve(selector.name, toRange)
  if (target === undefined) {
    const d = modifyResolveFailed(selector.name, toRange)
    emit(d)
    // Surface the resolve-failure on Graph.diagnostics() too (§8.6 default).
    const sealed = graph.mutate(m => { m.diagnostic(d) })
    return {
      ...emptyResult(sealed.graph),
      unresolved,
    }
  }

  // 2. Enumerate matched nodes.
  const fromRange = selector.fromRange ?? '*'
  const matched: Node[] = []
  for (const id of graph.byName(selector.name)) {
    const node = graph.getNode(id)
    if (node === undefined) continue
    if (matchesRange(node.version, fromRange)) matched.push(node)
  }

  const added:    NodeId[] = []
  const removed:  NodeId[] = []
  const replaced: Array<{ from: NodeId; to: NodeId }> = []
  const recentlyAdded:    Set<NodeId> = new Set()
  const recentlyOrphaned: Set<NodeId> = new Set()

  let currentGraph = graph

  for (const node of matched) {
    // B1: sentinel detection BEFORE Mutator dispatch.
    if (node.patch !== undefined && isSentinelPatch(node.patch)) {
      const d = modifySentinelRefused(node.id, 'replaceVersion')
      emit(d)
      // Land on Graph.diagnostics() too (§8.6 default).
      currentGraph = currentGraph.mutate(m => { m.diagnostic(d) }).graph
      continue
    }

    // 3. Compute target NodeId — preserve peerContext per §3.2 step 3.
    const targetId = serializeNodeId(target.name, target.version, node.peerContext, node.patch)

    if (targetId === node.id) {
      // No-op replacement (same version selected) — degenerate but legal.
      continue
    }

    const existing = currentGraph.getNode(targetId)
    if (existing === undefined) {
      // Simple rebind via replaceNode.
      const newNode: Node = {
        ...node,
        id:      targetId,
        version: target.version,
      }
      const replacedDiag = modifyNodeReplaced(node.id, targetId)
      const result = currentGraph.mutate(m => {
        m.replaceNode(node.id, newNode)
        // ADR-0023 §8.6: land the diagnostic on Graph.diagnostics() inside
        // the mutate transaction that performs the replace.
        m.diagnostic(replacedDiag)
      })
      currentGraph = result.graph
      // setTarball with the registry-supplied payload — preserves integrity / engines / etc.
      const payload = payloadOfPackumentVersion(target)
      currentGraph = currentGraph.mutate(m => {
        m.setTarball({ name: target.name, version: target.version, patch: node.patch }, payload)
      }).graph
      // The rebound node still carries the OLD version's outgoing deps. Clear
      // the dep/optional out-edges so completeTransitives rewires them from the
      // NEW manifest — else the stale deps linger and MERGE with the new set,
      // yielding an invalid node (yaf lockgraph-message, 2026-06-20). (peer edges
      // are left — peerContext coherence is out of scope here.)
      const staleOut = [...currentGraph.out(targetId)]
        .filter(e => e.kind === 'dep' || e.kind === 'optional')
      if (staleOut.length > 0) {
        currentGraph = currentGraph.mutate(m => {
          for (const e of staleOut) m.removeEdge(targetId, e.dst, e.kind)
        }).graph
        // A dropped edge may have been its target's LAST incoming edge (e.g.
        // handlebars 4.0.0's async/optimist after the bump). Record those as
        // recentlyOrphaned: a REBIND upgrade removes NO node, so this edge-refresh
        // is the only source of the stranded closure — and a seeded pruneOrphans
        // needs that delta to retire it (rebinds yield an empty `removed`).
        for (const e of staleOut) {
          const dst = currentGraph.getNode(e.dst)
          if (dst !== undefined && dst.workspacePath === undefined && currentGraph.in(e.dst).length === 0) {
            recentlyOrphaned.add(e.dst)
          }
        }
      }
      replaced.push({ from: node.id, to: targetId })
      recentlyAdded.add(targetId)
      added.push(targetId)
      emit(replacedDiag)
      continue
    }

    // 4. Merge branch — target NodeId already exists.
    // F3: retarget incoming edges FIRST, then removeNode(oldId).
    const incoming = currentGraph.in(node.id).slice()
    const mergeReplacedDiag = modifyNodeReplaced(node.id, targetId)
    const rewireDiags: ModifyDiagnostic[] = []
    const mergeResult: MutateResult = currentGraph.mutate(m => {
      for (const inc of incoming) {
        // Check existing-edge guard before retargeting; addEdge throws on duplicate.
        // Alias participates in edge identity — guard per-alias so aliased
        // siblings (e.g. `foo` + `foo-alias: npm:foo@…`) both retarget.
        if (!hasEdge(currentGraph, inc.src, targetId, inc.kind, inc.attrs?.alias)) {
          m.addEdge(inc.src, targetId, inc.kind, inc.attrs)
          const rewireDiag = modifyEdgeRewired({ src: inc.src, dst: targetId, kind: inc.kind })
          rewireDiags.push(rewireDiag)
          m.diagnostic(rewireDiag)
        }
        m.removeEdge(inc.src, node.id, inc.kind)
      }
      m.removeNode(node.id)
      m.diagnostic(mergeReplacedDiag)
    })
    currentGraph = mergeResult.graph
    replaced.push({ from: node.id, to: targetId })
    removed.push(node.id)
    recentlyOrphaned.add(node.id)
    for (const d of rewireDiags) emit(d)
    emit(mergeReplacedDiag)
  }

  return {
    graph: currentGraph,
    added,
    removed,
    replaced,
    recentlyAdded,
    recentlyOrphaned,
    unresolved,
  }
}

function matchesRange(version: string, range: string): boolean {
  if (range === '*') return true
  try {
    return semver.satisfies(version, range)
  } catch {
    return false
  }
}

function hasEdge(graph: Graph, src: NodeId, dst: NodeId, kind: EdgeKind, alias?: string): boolean {
  for (const e of graph.out(src, kind)) {
    if (e.dst === dst && e.attrs?.alias === alias) return true
  }
  return false
}

function emptyResult(graph: Graph): ReplaceVersionResult {
  return {
    graph,
    added:            [],
    removed:          [],
    replaced:         [],
    recentlyAdded:    new Set(),
    recentlyOrphaned: new Set(),
    unresolved:       [],
  }
}
