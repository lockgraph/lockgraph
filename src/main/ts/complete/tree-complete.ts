// ADR-0023 §4 — tree completion algorithm.
//
// BFS from `roots(graph) ∪ seed.recentlyAdded`, excluding
// `seed.recentlyOrphaned`. Workspace nodes are skipped as packument
// targets — but their out-edges are walked normally (per §4 workspace
// handling clause). Monotone-additive: never removes nodes.

import {
  serializeNodeId,
  type Diagnostic,
  type EdgeKind,
  type EdgeTriple,
  type Graph,
  type Node,
  type NodeId,
  type TarballKeyInputs,
  type TarballPayload,
} from '../graph.ts'
import type { PackumentVersion, RegistryAdapter } from '../registry/types.ts'
import { resolveFindUp } from './find-up.ts'
import {
  completionEdgeResolved,
  completionNodeAdded,
  completionNodeUnknown,
  completionPeerContextIncomplete,
  completionUnresolved,
  completionVersionUnknown,
} from './diagnostics.ts'

export interface CompletionSeed {
  /** NodeIds the modifier added in the just-completed mutate phase. */
  recentlyAdded:    Set<NodeId>
  /** NodeIds the mutate phase orphaned. The completion frontier excludes
   *  these — optimize phase collects. */
  recentlyOrphaned: Set<NodeId>
}

export interface CompletionResult {
  graph:       Graph
  added:       NodeId[]
  wired:       EdgeTriple[]
  unresolved:  Diagnostic[]
}

export interface CompletionOptions {
  seed?:         CompletionSeed
  onDiagnostic?: (d: Diagnostic) => void
}

const EMPTY_SEED: CompletionSeed = {
  recentlyAdded:    new Set(),
  recentlyOrphaned: new Set(),
}

/**
 * Walk graph, query registry for missing transitive deps, wire edges.
 * Monotone-additive: returned graph ⊇ input graph (no removals).
 */
export async function completeTransitives(
  graph: Graph,
  registry: RegistryAdapter,
  options: CompletionOptions = {},
): Promise<CompletionResult> {
  const seed         = options.seed ?? EMPTY_SEED
  const onDiagnostic = options.onDiagnostic

  const visited:    Set<NodeId>  = new Set()
  const added:      NodeId[]      = []
  const wired:      EdgeTriple[]  = []
  const unresolved: Diagnostic[]  = []

  let currentGraph = graph

  // ADR-0023 §8.6: COMPLETION_* diagnostics also land on Graph.diagnostics()
  // so stringify-side adapters see them via the canonical read channel. Where
  // no mutation is in flight (e.g. node-unknown / peer-incomplete), we emit
  // via a one-line mutate transaction.
  //
  // ADR-0023 §7.5 — `unresolved` carries ALL diagnostic severities emitted
  // by this call (info / warning / error) to match per-primitive modify
  // semantics. The `onDiagnostic` callback mirrors the same events.
  const emit = (d: Diagnostic): void => {
    unresolved.push(d)
    if (onDiagnostic !== undefined) onDiagnostic(d)
  }
  const emitAndLand = (d: Diagnostic): void => {
    emit(d)
    currentGraph = currentGraph.mutate(m => { m.diagnostic(d) }).graph
  }

  // Seed frontier: roots(graph) \ recentlyOrphaned ∪ recentlyAdded.
  const frontier: NodeId[] = []
  for (const root of currentGraph.roots()) {
    if (!seed.recentlyOrphaned.has(root)) frontier.push(root)
  }
  for (const id of seed.recentlyAdded) {
    if (!seed.recentlyOrphaned.has(id)) frontier.push(id)
  }

  while (frontier.length > 0) {
    const nodeId = frontier.shift()!
    if (visited.has(nodeId)) continue
    visited.add(nodeId)

    const node = currentGraph.getNode(nodeId)
    if (node === undefined) continue

    // Workspace nodes are not queried as packument targets per §4
    // workspace-handling. Their declared out-edges are still walked — but
    // we don't need a packument to walk them. We push existing out-edge
    // targets onto the frontier so completion continues through workspaces.
    if (node.workspacePath !== undefined) {
      for (const edge of currentGraph.out(nodeId)) {
        if (!visited.has(edge.dst)) frontier.push(edge.dst)
      }
      continue
    }

    const packument = await registry.packument(node.name)
    if (packument === undefined) {
      // Walk existing out-edges so completion does not stall on unknown
      // packuments; the diagnostic surfaces the gap without aborting.
      for (const edge of currentGraph.out(nodeId)) {
        if (!visited.has(edge.dst)) frontier.push(edge.dst)
      }
      emitAndLand(completionNodeUnknown(nodeId))
      continue
    }
    const pv = packument.versions[node.version]
    if (pv === undefined) {
      for (const edge of currentGraph.out(nodeId)) {
        if (!visited.has(edge.dst)) frontier.push(edge.dst)
      }
      emitAndLand(completionVersionUnknown(nodeId))
      continue
    }

    // Walk the INSTALL-TREE dep-kind buckets only. `devDependencies` are
    // deliberately EXCLUDED: only a transitive, non-workspace node reaches here
    // (workspace/root nodes take the branch above and never fetch a packument),
    // and a transitive dependency's devDependencies are NEVER installed —
    // traversing them pulls the entire dev universe and never terminates. The
    // root/workspace node's own devDeps come from parse, already on the graph.
    const depBuckets: Array<{ deps?: Record<string, string>; kind: EdgeKind }> = [
      { deps: pv.dependencies,         kind: 'dep' },
      { deps: pv.optionalDependencies, kind: 'optional' },
      { deps: pv.peerDependencies,     kind: 'peer' },
    ]

    for (const { deps, kind } of depBuckets) {
      if (deps === undefined) continue
      // Sort dep names for content-sorted iteration (ADR-0007).
      const depNames = Object.keys(deps).sort(cmpStr)
      for (const depName of depNames) {
        const depRange = deps[depName]!
        if (alreadyWired(currentGraph, nodeId, depName, kind)) continue

        const targetId = resolveFindUp(currentGraph, nodeId, depName, depRange, kind)
        if (targetId !== undefined) {
          // For peer deps, adding the edge requires updating the consumer's
          // peerContext (peer-edge ↔ peerContext coherence invariant). Peer-
          // virt rebind at completion time is out of scope per §4.3 — emit the
          // peer-incomplete diagnostic and proceed without the edge.
          if (kind === 'peer') {
            emitAndLand(completionPeerContextIncomplete(nodeId, depName, depRange))
            continue
          }
          // Reuse existing satisfying sibling.
          const triple: EdgeTriple = { src: nodeId, dst: targetId, kind }
          const resolvedDiag = completionEdgeResolved(triple)
          const result = currentGraph.mutate(m => {
            m.addEdge(nodeId, targetId, kind, { range: depRange })
            m.diagnostic(resolvedDiag)
          })
          currentGraph = result.graph
          wired.push(triple)
          emit(resolvedDiag)
          if (!visited.has(targetId)) frontier.push(targetId)
          continue
        }

        // Find-up did not satisfy: query registry for a fresh resolution.
        const resolved = await registry.resolve(depName, depRange)
        if (resolved === undefined) {
          if (kind === 'peer') {
            emitAndLand(completionPeerContextIncomplete(nodeId, depName, depRange))
          } else {
            emitAndLand(completionUnresolved(nodeId, depName, depRange))
          }
          continue
        }

        const newId = serializeNodeId(resolved.name, resolved.version, [])
        const newNode: Node = {
          id:          newId,
          name:        resolved.name,
          version:     resolved.version,
          peerContext: [],
        }
        const { inputs, payload } = projectPackumentVersion(resolved)

        // Peer edges require the dst to be in peerContext per the
        // peer-edge ↔ peerContext coherence invariant. We cannot synthesise
        // a peer edge to a freshly-added node without first re-peer-keying
        // the consumer — out of scope for v1 (peer-virt is recipe-layer
        // territory per §4.3). Emit the diagnostic instead.
        if (kind === 'peer') {
          // Still add the node and mark unresolved-as-peer so caller knows
          // the consumer's peer slot needs enrich.
          emitAndLand(completionPeerContextIncomplete(nodeId, depName, depRange))
          continue
        }

        let alreadyAdded = false
        const nodeAddedDiag = completionNodeAdded(newId)
        const result = currentGraph.mutate(m => {
          if (currentGraph.getNode(newId) === undefined) {
            m.addNode(newNode)
            m.setTarball(inputs, payload)
            m.diagnostic(nodeAddedDiag)
          } else {
            alreadyAdded = true
          }
          m.addEdge(nodeId, newId, kind, { range: depRange })
        })
        currentGraph = result.graph

        if (!alreadyAdded) {
          added.push(newId)
          emit(nodeAddedDiag)
        }

        const triple: EdgeTriple = { src: nodeId, dst: newId, kind }
        wired.push(triple)
        if (!visited.has(newId)) frontier.push(newId)
      }
    }

    // Walk existing out-edges so we surface their packument-derived
    // transitives too.
    for (const edge of currentGraph.out(nodeId)) {
      if (!visited.has(edge.dst)) frontier.push(edge.dst)
    }
  }

  return {
    graph:      currentGraph,
    added,
    wired,
    unresolved,
  }
}

function alreadyWired(
  graph: Graph,
  src: NodeId,
  depName: string,
  kind: EdgeKind,
): boolean {
  for (const edge of graph.out(src, kind)) {
    const dst = graph.getNode(edge.dst)
    if (dst !== undefined && dst.name === depName) return true
  }
  return false
}

/** Map PackumentVersion → (TarballKeyInputs, TarballPayload) per ADR-0023 §4.2 table. */
function projectPackumentVersion(pv: PackumentVersion): {
  inputs:  TarballKeyInputs
  payload: TarballPayload
} {
  return {
    inputs: {
      name:    pv.name,
      version: pv.version,
      // patch is always undefined per §4.2 — completion does not synthesise patches.
    },
    payload: {
      integrity:           pv.integrity,
      engines:             pv.engines,
      os:                  pv.os,
      cpu:                 pv.cpu,
      libc:                pv.libc,
      bin:                 pv.bin,
      bundledDependencies: pv.bundledDependencies,
      deprecated:          pv.deprecated,
      resolution:          pv.tarball === undefined ? undefined : { type: 'tarball', url: pv.tarball },
      // license intentionally undefined — not carried on PackumentVersion;
      // recipe-layer enrich may refine later per §4.2 footnote.
    },
  }
}

const cmpStr = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0
