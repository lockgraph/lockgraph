// ADR-0023 §4 — tree completion algorithm.
//
// The seed BOUNDS the frontier: with a seed supplied BFS starts from
// `seed.recentlyAdded` only (cost O(changed-subtree) — the incremental
// contract); with no seed it starts from every `roots(graph)` (full
// completion). Both paths exclude `seed.recentlyOrphaned`. Workspace nodes
// are skipped as packument targets — but their out-edges are walked normally
// (per §4 workspace handling clause). Monotone-additive: never removes nodes.

import {
  serializeNodeId,
  type Diagnostic,
  type EdgeKind,
  type EdgeTriple,
  type Graph,
  type Node,
  type NodeId,
  type OverrideConstraint,
  type TarballKeyInputs,
  type TarballPayload,
} from '../graph.ts'
import type { PackumentVersion, RegistryAdapter } from '../registry/types.ts'
import { bestExistingSatisfying, resolveFindUp } from './find-up.ts'
import { overrideTargetFor } from '../recipe/descriptor-resolve.ts'
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

/**
 * How a freshly-introduced transitive descriptor picks its version:
 * - `'highest'` (DEFAULT) — resolve to the highest version satisfying the range
 *   from the registry, matching `yarn install`. This is the only strategy that
 *   upholds the fundamental frozen/CI-acceptance invariant (`_common.md
 *   §1.1.1`): reusing an older-but-satisfying version diverges from the package
 *   manager's resolution, so the manager REWRITES the lock and
 *   `yarn install --immutable` / `npm ci` / `--frozen-lockfile` fails (e.g. a
 *   bumped `qs` requesting `side-channel@^1.0.6` resolves to `1.1.1`, not a
 *   reused `1.1.0`).
 * - `'prefer-existing'` (opt-in) — reuse a satisfying version already in the
 *   graph (hoist-aware find-up, then project-wide `bestExistingSatisfying`)
 *   before a registry round-trip; minimises lock churn but produces a lock the
 *   manager may correct, so it is NOT frozen-clean. Use only for non-CI flows
 *   that tolerate a follow-up `install`.
 * Either way, ALREADY-WIRED descriptors keep their resolution — only NEW edges
 * introduced by this completion pass are affected (the manager keeps existing
 * resolutions pinned too, so this preserves minimal-diff for the common case).
 */
export type ResolutionStrategy = 'highest' | 'prefer-existing'

export interface CompletionOptions {
  seed?:         CompletionSeed
  onDiagnostic?: (d: Diagnostic) => void
  /** New-descriptor version-selection policy (default `'highest'` — the
   *  frozen/CI-clean path). Pass `'prefer-existing'` only for non-CI flows. */
  resolution?:   ResolutionStrategy
  /** Project-declared overrides (canonical — e.g. from `overridesOf(graph)`).
   *  When set, a NEW descriptor governed by an override binds the override's
   *  forced target VERBATIM (and outranks reuse), so the completed closure
   *  honours the project's pins (frozen-acceptance). */
  overrides?:    readonly OverrideConstraint[]
}

const EMPTY_SEED: CompletionSeed = {
  recentlyAdded:    new Set(),
  recentlyOrphaned: new Set(),
}

/** Strip the default `npm:` protocol so a parsed `npm:^1.2.3` and a manifest's
 *  bare `^1.2.3` compare as the SAME descriptor (npm: is yarn's default
 *  protocol). Other protocols (`patch:`, `workspace:`, `file:`, `git:`) stay
 *  distinct — they ARE different descriptors. */
function canonicalRange(range: string): string {
  return range.startsWith('npm:') ? range.slice(4) : range
}

/** Identity key for a descriptor (`name@range`), protocol-normalised. A berry
 *  lock binds each such key to exactly ONE resolution project-wide. */
const descriptorKey = (name: string, range: string): string =>
  `${name} ${canonicalRange(range)}`

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
  const resolution   = options.resolution ?? 'highest'
  const overrides    = options.overrides ?? []

  const visited:    Set<NodeId>  = new Set()
  const added:      NodeId[]      = []
  const wired:      EdgeTriple[]  = []
  const unresolved: Diagnostic[]  = []

  let currentGraph = graph

  // Descriptor-identity index (yarn invariant: a descriptor STRING resolves to
  // exactly ONE version project-wide). Pre-seeded from every EXISTING edge so a
  // newly-introduced edge whose range already exists reuses that binding instead
  // of minting a SECOND entry for the same descriptor — a double-bound range
  // that `yarn install --immutable` rejects (yaf .77 berry semver regression).
  // Kept current as completion wires fresh edges.
  const descriptorResolution = new Map<string, NodeId>()
  for (const node of graph.nodes()) {
    for (const edge of graph.out(node.id)) {
      const r = edge.attrs?.range
      if (r === undefined) continue
      const dst = graph.getNode(edge.dst)
      if (dst !== undefined) descriptorResolution.set(descriptorKey(dst.name, r), edge.dst)
    }
  }

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

  // The seed BOUNDS the work. With a seed supplied, ONLY `recentlyAdded` seeds
  // the frontier — BFS then walks their transitive closure, so cost is
  // O(changed-subtree) and an empty seed does ~zero work (the incremental
  // contract yaf relies on). With NO seed, complete the WHOLE graph from every
  // root. `recentlyOrphaned` is excluded from the frontier either way (the
  // optimize phase collects orphans).
  const frontier: NodeId[] = []
  if (options.seed === undefined) {
    for (const root of currentGraph.roots()) {
      if (!seed.recentlyOrphaned.has(root)) frontier.push(root)
    }
  } else {
    for (const id of seed.recentlyAdded) {
      if (!seed.recentlyOrphaned.has(id)) frontier.push(id)
    }
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

    // Install-tree kinds only — `devDependencies` are EXCLUDED: only transitive
    // (non-workspace) nodes reach here, and a transitive's devDeps are never
    // installed; traversing them pulls the whole dev universe and never ends.
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

        // Override gate (Rung-2 parity): an active project override redirects
        // this NEW descriptor to its forced target BEFORE anything else — dedup,
        // reuse, AND registry — so the completed closure honours the pin
        // (frozen-acceptance). The `to` binds VERBATIM (a non-satisfying pin is
        // intentional) and OUTRANKS the prefer-existing reuse rungs. Everything
        // downstream keys on the EFFECTIVE descriptor `depName@(to|range)`, so an
        // override-redirected resolution NEVER poisons the plain-range descriptor
        // cache: a consumer OUTSIDE a scoped override still resolves normally
        // (two versions under a scoped override, exactly as the PM emits).
        // consumerPath = [node.name] (immediate parent; deeper-scoped overrides
        // under-match, matching the yarn rungs' scoping).
        const overrideTo = overrides.length > 0
          ? overrideTargetFor(depName, depRange, [node.name], overrides)
          : undefined
        const effectiveRange = overrideTo ?? depRange
        // Stamp the override-forced range on the edge so the yarn adapters key the
        // entry by the pin (collapsing like `yarn install`), while `range` stays
        // the DECLARED range for npm/pnpm's parent-deps block (EdgeAttrs.overrideRange).
        const edgeAttrs = overrideTo === undefined
          ? { range: depRange }
          : { range: depRange, overrideRange: overrideTo }

        // STEP 0 — descriptor-identity dedup (BOTH strategies, before any
        // version selection). The EFFECTIVE descriptor resolves to ONE version
        // project-wide: if `name@effective` is already bound (an existing edge OR
        // an earlier-wired completion edge), reuse that resolution. Without this,
        // `highest` re-resolves an already-present range to a newer version and
        // emits a SECOND entry for it → a double-bound descriptor `yarn install
        // --immutable` rejects (yaf .77 semver). Peers keep their dedicated
        // incomplete-handling on the paths below.
        if (kind !== 'peer') {
          const boundId = descriptorResolution.get(descriptorKey(depName, effectiveRange))
          if (boundId !== undefined && boundId !== nodeId && currentGraph.getNode(boundId) !== undefined) {
            const triple: EdgeTriple = { src: nodeId, dst: boundId, kind }
            const resolvedDiag = completionEdgeResolved(triple)
            currentGraph = currentGraph.mutate(m => {
              m.addEdge(nodeId, boundId, kind, edgeAttrs)
              m.diagnostic(resolvedDiag)
            }).graph
            wired.push(triple)
            emit(resolvedDiag)
            if (!visited.has(boundId)) frontier.push(boundId)
            continue
          }
        }

        // Hoist-aware ancestor reuse — `prefer-existing` only, and not when an
        // override governs. `highest` skips it: yarn binds a new descriptor to
        // the registry's highest match, not to a hoistable older sibling.
        const targetId = resolution === 'prefer-existing' && overrideTo === undefined
          ? resolveFindUp(currentGraph, nodeId, depName, depRange, kind)
          : undefined
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
            m.addEdge(nodeId, targetId, kind, edgeAttrs)
            m.diagnostic(resolvedDiag)
          })
          currentGraph = result.graph
          wired.push(triple)
          emit(resolvedDiag)
          if (!visited.has(targetId)) frontier.push(targetId)
          descriptorResolution.set(descriptorKey(depName, depRange), targetId)
          continue
        }

        // Find-up did not satisfy (no hoistable ancestor binding, or a
        // block-hoist conflict). Before paying a registry round-trip that may
        // pull a version NOT already in the lockfile, prefer ANY existing node
        // whose version already satisfies the range — project-wide reuse /
        // dedup (Anton's wish 2026-06-21: reuse known-good versions over
        // fetching latest-satisfying). Peer edges are excluded: they need
        // peerContext coherence, handled on the registry path below. A self-loop
        // (the consumer itself satisfying its own range) is never reused.
        // `highest` skips this reuse entirely (registry's highest match wins,
        // matching yarn — the `--immutable`-fidelity path).
        if (resolution === 'prefer-existing' && overrideTo === undefined && kind !== 'peer') {
          const reuseId = bestExistingSatisfying(currentGraph, depName, depRange)
          if (reuseId !== undefined && reuseId !== nodeId) {
            const triple: EdgeTriple = { src: nodeId, dst: reuseId, kind }
            const resolvedDiag = completionEdgeResolved(triple)
            const result = currentGraph.mutate(m => {
              m.addEdge(nodeId, reuseId, kind, edgeAttrs)
              m.diagnostic(resolvedDiag)
            })
            currentGraph = result.graph
            wired.push(triple)
            emit(resolvedDiag)
            if (!visited.has(reuseId)) frontier.push(reuseId)
            descriptorResolution.set(descriptorKey(depName, depRange), reuseId)
            continue
          }
        }

        // Nothing already present fits: query registry for the EFFECTIVE range
        // (the override target when one governs, else the declared range) — the
        // EDGE keeps `depRange`; only the resolved version changes.
        const resolved = await registry.resolve(depName, effectiveRange)
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
        // territory per §4.3). Emit the diagnostic without adding the node.
        if (kind === 'peer') {
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
          m.addEdge(nodeId, newId, kind, edgeAttrs)
        })
        currentGraph = result.graph

        if (!alreadyAdded) {
          added.push(newId)
          emit(nodeAddedDiag)
        }

        const triple: EdgeTriple = { src: nodeId, dst: newId, kind }
        wired.push(triple)
        if (!visited.has(newId)) frontier.push(newId)
        descriptorResolution.set(descriptorKey(depName, effectiveRange), newId)
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
