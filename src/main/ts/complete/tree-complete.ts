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
  type EdgeAttrs,
  type EdgeKind,
  type EdgeTriple,
  type Graph,
  type Node,
  type NodeId,
  type OverrideConstraint,
  type TarballKeyInputs,
  type TarballPayload,
} from '../graph.ts'
import type { Packument, PackumentVersion, RegistryAdapter } from '../registry/types.ts'
import { payloadOfPackumentVersion, setMintedTarball } from '../registry/payload.ts'
import { bestExistingSatisfying, resolveFindUp } from './find-up.ts'
import { overrideTargetFor } from '../recipe/descriptor-resolve.ts'
import {
  completionEdgeResolved,
  completionNoCandidate,
  completionNodeAdded,
  completionNodeUnknown,
  completionOverrideConstraintConflict,
  completionPeerContextIncomplete,
  completionUnresolved,
  completionVersionUnknown,
} from './diagnostics.ts'
import { selectConstrained, type Condition, type OnUnevaluable } from './constraints.ts'
import { probeAlternativeParent, type BudgetCounter, type CompletionBudget } from './backtrack.ts'

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
  /** Node-local acceptance constraints (ADR-0037). When set, a NEW transitive
   *  node is the HIGHEST range-satisfying version passing EVERY constraint
   *  (`engines`, `license`); none passes → a recoverable `COMPLETION_NO_CANDIDATE`
   *  (edge left unwired, completion continues, caller decides skip/stop). Empty
   *  (default) → the existing single-`resolve` path, unchanged. Peer edges are
   *  never constrained (they are not minted at completion). */
  constraints?:  readonly Condition[]
  /** What an `unevaluable` verdict means (e.g. a `license` constraint on an
   *  adapter with no `manifest()`): `'reject'` (default) folds it into
   *  `NO_CANDIDATE`; `'accept'` skips the check. */
  onUnevaluable?: OnUnevaluable
  /** OPT-IN combinatorial budget for the bounded-backtracking DISCOVERY probe
   *  (ADR-0037 v2). Absent (default) → v1 node-local behavior verbatim. When
   *  set AND a dep hits `NO_CANDIDATE`, the resolver searches (bounded by
   *  `maxCombinations`) for a LOWER version of the consumer whose closure is
   *  constraint-clean and attaches it to the diagnostic as a `suggestion` (the
   *  override to pin) — read-only, the emitted lock is unchanged. Requires
   *  non-empty `constraints`. */
  budget?: CompletionBudget
}

interface CompletionContext {
  readonly registry: RegistryAdapter
  readonly onDiagnostic: CompletionOptions['onDiagnostic']
  readonly resolution: ResolutionStrategy
  readonly overrides: readonly OverrideConstraint[]
  readonly constraints: readonly Condition[]
  readonly onUnevaluable: OnUnevaluable
  readonly budgetCounter: BudgetCounter | undefined
  readonly visited: Set<NodeId>
  readonly added: NodeId[]
  readonly wired: EdgeTriple[]
  readonly unresolved: Diagnostic[]
  readonly descriptorResolution: Map<string, NodeId>
  readonly packCache: Map<string, Promise<Packument | undefined>>
  readonly frontier: NodeId[]
  currentGraph: Graph
}

interface CompletionDependency {
  readonly nodeId: NodeId
  readonly nodeName: string
  readonly depName: string
  readonly depRange: string
  readonly kind: EdgeKind
  readonly overrideTo: string | undefined
  readonly effectiveRange: string
  readonly edgeAttrs: EdgeAttrs
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

/** Identity key for a descriptor (`name@range`), protocol-normalized. A berry
 *  lock binds each such key to exactly ONE resolution project-wide. */
const descriptorKey = (name: string, range: string): string =>
  `${name} ${canonicalRange(range)}`

// === API ====================================================================

/**
 * Walk graph, query registry for missing transitive deps, wire edges.
 * Monotone-additive: returned graph ⊇ input graph (no removals).
 */
export async function completeTransitives(
  graph: Graph,
  registry: RegistryAdapter,
  options: CompletionOptions = {},
): Promise<CompletionResult> {
  const seed = options.seed ?? EMPTY_SEED
  const context = completionContext(graph, registry, options)

  // Descriptor-identity index (yarn invariant: a descriptor STRING resolves to
  // exactly ONE version project-wide). Pre-seeded from every EXISTING edge so a
  // newly-introduced edge whose range already exists reuses that binding instead
  // of minting a SECOND entry for the same descriptor — a double-bound range
  // that `yarn install --immutable` rejects (a berry semver regression).
  // Kept current as completion wires fresh edges.
  // The seed BOUNDS the work. With a seed supplied, ONLY `recentlyAdded` seeds
  // the frontier — BFS then walks their transitive closure, so cost is
  // O(changed-subtree) and an empty seed does ~zero work (the incremental
  // public completion contract). With NO seed, complete the WHOLE graph from every
  // root. `recentlyOrphaned` is excluded from the frontier either way (the
  // optimize phase collects orphans).
  seedFrontier(context, seed, options.seed === undefined)

  await completeFrontier(context)
  return completionResult(context)
}

// === INTERNALS ==============================================================

async function completeFrontier(context: CompletionContext): Promise<void> {
  while (context.frontier.length > 0) {
    const nodeId = context.frontier.shift()!
    if (context.visited.has(nodeId)) continue
    context.visited.add(nodeId)

    const node = context.currentGraph.getNode(nodeId)
    if (node === undefined) continue

    // Workspace nodes are not queried as packument targets per §4
    // workspace-handling. Their declared out-edges are still walked — but
    // we don't need a packument to walk them. We push existing out-edge
    // targets onto the frontier so completion continues through workspaces.
    if (node.workspacePath !== undefined) {
      pushExistingEdges(context, nodeId)
      continue
    }

    const packument = await getPack(context, node.name)
    if (packument === undefined) {
      // Walk existing out-edges so completion does not stall on unknown
      // packuments; the diagnostic surfaces the gap without aborting.
      pushExistingEdges(context, nodeId)
      emitAndLand(context, completionNodeUnknown(nodeId))
      continue
    }
    const pv = packument.versions[node.version]
    if (pv === undefined) {
      pushExistingEdges(context, nodeId)
      emitAndLand(context, completionVersionUnknown(nodeId))
      continue
    }

    await completeNodeDependencies(context, node, pv)

    // Walk existing out-edges so we surface their packument-derived
    // transitives too.
    pushExistingEdges(context, nodeId)
  }
}

async function completeNodeDependencies(
  context: CompletionContext,
  node: Node,
  packumentVersion: PackumentVersion,
): Promise<void> {
  // Install-tree kinds only. A transitive node's devDependencies are excluded.
  const buckets: Array<{ deps?: Record<string, string>; kind: EdgeKind }> = [
    { deps: packumentVersion.dependencies,         kind: 'dep' },
    { deps: packumentVersion.optionalDependencies, kind: 'optional' },
    { deps: packumentVersion.peerDependencies,     kind: 'peer' },
  ]
  for (const { deps, kind } of buckets) {
    if (deps === undefined) continue
    for (const depName of Object.keys(deps).sort(cmpStr)) {
      const depRange = deps[depName]!
      if (alreadyWired(context.currentGraph, node.id, depName, kind)) continue

      // An active scoped override creates the effective descriptor before any
      // dedup, reuse, or registry rung and cannot poison the plain descriptor.
      const dependency = completionDependency(context, {
        node,
        depName,
        depRange,
        kind,
      })
      // The ladder order is load-bearing for PM fidelity.
      if (reuseBoundDescriptor(context, dependency)) continue
      if (reuseFindUp(context, dependency)) continue
      if (reuseProjectWide(context, dependency)) continue
      const resolved = await resolveDependency(context, dependency)
      if (resolved !== undefined) mintDependency(context, dependency, resolved)
    }
  }
}

function completionResult(context: CompletionContext): CompletionResult {
  return {
    graph:      context.currentGraph,
    added:      context.added,
    wired:      context.wired,
    unresolved: context.unresolved,
  }
}

function completionContext(
  graph: Graph,
  registry: RegistryAdapter,
  options: CompletionOptions,
): CompletionContext {
  return {
    registry,
    onDiagnostic: options.onDiagnostic,
    resolution: options.resolution ?? 'highest',
    overrides: options.overrides ?? [],
    constraints: options.constraints ?? [],
    onUnevaluable: options.onUnevaluable ?? 'reject',
    budgetCounter: budgetCounterOf(options),
    visited: new Set(),
    added: [],
    wired: [],
    unresolved: [],
    currentGraph: graph,
    descriptorResolution: descriptorResolutionsOf(graph),
    packCache: new Map(),
    frontier: [],
  }
}

function completionDependency(
  context: CompletionContext,
  input: Readonly<{ node: Node; depName: string; depRange: string; kind: EdgeKind }>,
): CompletionDependency {
  const { node, depName, depRange, kind } = input
  const overrideTo = context.overrides.length > 0
    ? overrideTargetFor(depName, depRange, [node.name], context.overrides)
    : undefined
  return {
    nodeId: node.id,
    nodeName: node.name,
    depName,
    depRange,
    kind,
    overrideTo,
    effectiveRange: overrideTo ?? depRange,
    // The edge retains the declared range for npm/pnpm while the override pin
    // becomes the yarn descriptor key (EdgeAttrs.overrideRange).
    edgeAttrs: overrideTo === undefined
      ? { range: depRange }
      : { range: depRange, overrideRange: overrideTo },
  }
}

function reuseBoundDescriptor(
  context: CompletionContext,
  dependency: CompletionDependency,
): boolean {
  if (dependency.kind === 'peer') return false
  const boundId = context.descriptorResolution.get(descriptorKey(
    dependency.depName,
    dependency.effectiveRange,
  ))
  if (boundId === undefined || boundId === dependency.nodeId
    || context.currentGraph.getNode(boundId) === undefined) return false

  const triple: EdgeTriple = {
    src: dependency.nodeId,
    dst: boundId,
    kind: dependency.kind,
  }
  const resolved = completionEdgeResolved(triple)
  context.currentGraph = context.currentGraph.mutate(m => {
    m.addEdge(dependency.nodeId, boundId, dependency.kind, dependency.edgeAttrs)
    m.diagnostic(resolved)
  }).graph
  context.wired.push(triple)
  emit(context, resolved)
  if (!context.visited.has(boundId)) pushFrontier(context, boundId)
  return true
}

function reuseFindUp(
  context: CompletionContext,
  dependency: CompletionDependency,
): boolean {
  if (context.resolution !== 'prefer-existing' || dependency.overrideTo !== undefined) return false
  const targetId = resolveFindUp(
    context.currentGraph,
    dependency.nodeId,
    dependency.depName,
    dependency.depRange,
    dependency.kind,
  )
  if (targetId === undefined) return false

  // Peer wiring requires re-keying the consumer's peerContext, which remains a
  // recipe-layer operation rather than a completion-side synthesis.
  if (dependency.kind === 'peer') {
    emitAndLand(context, completionPeerContextIncomplete(
      dependency.nodeId,
      dependency.depName,
      dependency.depRange,
    ))
    return true
  }

  const triple: EdgeTriple = {
    src: dependency.nodeId,
    dst: targetId,
    kind: dependency.kind,
  }
  const resolved = completionEdgeResolved(triple)
  context.currentGraph = context.currentGraph.mutate(m => {
    m.addEdge(dependency.nodeId, targetId, dependency.kind, dependency.edgeAttrs)
    m.diagnostic(resolved)
  }).graph
  context.wired.push(triple)
  emit(context, resolved)
  if (!context.visited.has(targetId)) pushFrontier(context, targetId)
  context.descriptorResolution.set(descriptorKey(
    dependency.depName,
    dependency.depRange,
  ), targetId)
  return true
}

function reuseProjectWide(
  context: CompletionContext,
  dependency: CompletionDependency,
): boolean {
  if (context.resolution !== 'prefer-existing' || dependency.overrideTo !== undefined
    || dependency.kind === 'peer') return false
  const reuseId = bestExistingSatisfying(
    context.currentGraph,
    dependency.depName,
    dependency.depRange,
  )
  if (reuseId === undefined || reuseId === dependency.nodeId) return false

  const triple: EdgeTriple = {
    src: dependency.nodeId,
    dst: reuseId,
    kind: dependency.kind,
  }
  const resolved = completionEdgeResolved(triple)
  context.currentGraph = context.currentGraph.mutate(m => {
    m.addEdge(dependency.nodeId, reuseId, dependency.kind, dependency.edgeAttrs)
    m.diagnostic(resolved)
  }).graph
  context.wired.push(triple)
  emit(context, resolved)
  if (!context.visited.has(reuseId)) pushFrontier(context, reuseId)
  context.descriptorResolution.set(descriptorKey(
    dependency.depName,
    dependency.depRange,
  ), reuseId)
  return true
}

async function resolveDependency(
  context: CompletionContext,
  dependency: CompletionDependency,
): Promise<PackumentVersion | undefined> {
  let resolved: PackumentVersion | undefined
  if (context.constraints.length > 0 && dependency.kind !== 'peer') {
    const selection = await selectConstrained(
      context.registry,
      dependency.depName,
      dependency.effectiveRange,
      context.constraints,
      context.onUnevaluable,
    )
    resolved = selection.selected
    if (resolved === undefined && selection.rejected.length > 0) {
      // A satisfying version existed but every candidate failed a constraint.
      if (dependency.overrideTo !== undefined) {
        const first = selection.rejected[0]!
        emitAndLand(context, completionOverrideConstraintConflict(
          dependency.nodeId,
          dependency.depName,
          dependency.overrideTo,
          first.by,
          first.reason,
        ))
      } else {
        // The opt-in probe is read-only and shares one pass-wide scheduler
        // budget; it suggests a lower consumer without changing emitted state.
        let extra: {
          suggestion?: { consumer: string; version: string; range: string }
          budgetExhausted?: boolean
        } | undefined
        if (context.budgetCounter !== undefined) {
          const probe = await probeAlternativeParent(context.currentGraph, dependency.nodeId, {
            registry: context.registry,
            constraints: context.constraints,
            onUnevaluable: context.onUnevaluable,
            overrides: context.overrides,
            budget: context.budgetCounter,
          })
          if (probe.kind === 'found') extra = { suggestion: probe.suggestion }
          else if (probe.kind === 'exhausted') extra = { budgetExhausted: true }
        }
        emitAndLand(context, completionNoCandidate(
          dependency.nodeId,
          dependency.depName,
          dependency.effectiveRange,
          selection.rejected,
          extra,
        ))
      }
      return undefined
    }
  } else {
    resolved = await context.registry.resolve(dependency.depName, dependency.effectiveRange)
  }
  if (resolved !== undefined) return resolved

  // No version satisfies the range at all (or the package is unknown).
  emitAndLand(context, dependency.kind === 'peer'
    ? completionPeerContextIncomplete(
        dependency.nodeId,
        dependency.depName,
        dependency.depRange,
      )
    : completionUnresolved(
        dependency.nodeId,
        dependency.depName,
        dependency.depRange,
      ))
  return undefined
}

function mintDependency(
  context: CompletionContext,
  dependency: CompletionDependency,
  resolved: PackumentVersion,
): void {
  // A peer edge cannot be added without re-keying the consumer's peerContext;
  // completion therefore diagnoses it without minting the candidate node.
  if (dependency.kind === 'peer') {
    emitAndLand(context, completionPeerContextIncomplete(
      dependency.nodeId,
      dependency.depName,
      dependency.depRange,
    ))
    return
  }

  const newId = serializeNodeId(resolved.name, resolved.version, [])
  const newNode: Node = {
    id: newId,
    name: resolved.name,
    version: resolved.version,
    peerContext: [],
  }
  // This projection derives the full packument payload, including Berry
  // conditions, peer declarations, and libc/platform fidelity fields.
  const { inputs, payload } = projectPackumentVersion(resolved)
  let alreadyAdded = false
  const addedDiagnostic = completionNodeAdded(newId)
  context.currentGraph = context.currentGraph.mutate(m => {
    if (context.currentGraph.getNode(newId) === undefined) {
      m.addNode(newNode)
      setMintedTarball(m, inputs, payload)
      m.diagnostic(addedDiagnostic)
    } else {
      alreadyAdded = true
    }
    m.addEdge(dependency.nodeId, newId, dependency.kind, dependency.edgeAttrs)
  }).graph

  if (!alreadyAdded) {
    context.added.push(newId)
    emit(context, addedDiagnostic)
  }
  const triple: EdgeTriple = {
    src: dependency.nodeId,
    dst: newId,
    kind: dependency.kind,
  }
  context.wired.push(triple)
  if (!context.visited.has(newId)) pushFrontier(context, newId)
  context.descriptorResolution.set(descriptorKey(
    dependency.depName,
    dependency.effectiveRange,
  ), newId)
}

// ADR-0023 §7.5: `unresolved` carries every severity emitted by this call and
// the callback mirrors the same events.
function emit(context: CompletionContext, diagnostic: Diagnostic): void {
  context.unresolved.push(diagnostic)
  if (context.onDiagnostic !== undefined) context.onDiagnostic(diagnostic)
}

// ADR-0023 §8.6: completion diagnostics also land on Graph.diagnostics() so
// stringify-side adapters see them through the canonical read channel.
function emitAndLand(context: CompletionContext, diagnostic: Diagnostic): void {
  emit(context, diagnostic)
  context.currentGraph = context.currentGraph.mutate(m => { m.diagnostic(diagnostic) }).graph
}

// Packument reads are order-independent, while resolution remains sequential.
// The adapter's scheduler seam bounds concurrency; this cache only supplies
// deterministic look-ahead and one request per package name.
function getPack(context: CompletionContext, name: string): Promise<Packument | undefined> {
  let request = context.packCache.get(name)
  if (request === undefined) {
    request = context.registry.packument(name)
    context.packCache.set(name, request)
    void request.catch(() => {}) // awaiting site re-throws the real error
  }
  return request
}

function pushFrontier(context: CompletionContext, id: NodeId): void {
  context.frontier.push(id)
  const node = context.currentGraph.getNode(id)
  if (node !== undefined && node.workspacePath === undefined) void getPack(context, node.name)
}

function seedFrontier(
  context: CompletionContext,
  seed: CompletionSeed,
  fullCompletion: boolean,
): void {
  if (fullCompletion) {
    for (const root of context.currentGraph.roots()) {
      if (!seed.recentlyOrphaned.has(root)) pushFrontier(context, root)
    }
    return
  }
  for (const id of seed.recentlyAdded) {
    if (!seed.recentlyOrphaned.has(id)) pushFrontier(context, id)
  }
}

function pushExistingEdges(context: CompletionContext, nodeId: NodeId): void {
  for (const edge of context.currentGraph.out(nodeId)) {
    if (!context.visited.has(edge.dst)) pushFrontier(context, edge.dst)
  }
}

function budgetCounterOf(options: CompletionOptions): BudgetCounter | undefined {
  return options.budget === undefined
    ? undefined
    : { max: options.budget.maxCombinations, spent: 0 }
}

function descriptorResolutionsOf(graph: Graph): Map<string, NodeId> {
  const resolutions = new Map<string, NodeId>()
  for (const node of graph.nodes()) {
    for (const edge of graph.out(node.id)) {
      const range = edge.attrs?.range
      if (range === undefined) continue
      const dst = graph.getNode(edge.dst)
      if (dst !== undefined) resolutions.set(descriptorKey(dst.name, range), edge.dst)
    }
  }
  return resolutions
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
    payload: payloadOfPackumentVersion(pv),
  }
}

const cmpStr = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0
