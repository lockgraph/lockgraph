import type {
  Diagnostic,
  EdgeKind,
  EdgeTriple,
  Graph,
  NodeId,
  TarballKey,
} from '../graph.ts'
import type { OperationOptions } from '../api/operation.ts'
import type { FormatId } from '../api/format-contract.ts'
import { frozenRegistry } from '../registry/frozen.ts'
import { targetRequestOf } from '../completeness/targets.ts'
import type { RegistryAdapter } from '../registry/types.ts'
import { addDependency, type AddableEdgeKind } from './add-dependency.ts'
import { applyPatch, type ApplyPatchSpec } from './apply-patch.ts'
import { filterLicense } from './filter-license.ts'
import { pinOverride } from './pin-override.ts'
import { removeDependency } from './remove-dependency.ts'
import {
  replaceVersion,
  type ReplaceVersionSelector,
} from './replace-version.ts'
import { replaceRange, type ReplaceRangeEdgeKind } from './replace-range.ts'

export type { ApplyPatchSpec } from './apply-patch.ts'
export type { ReplaceVersionSelector } from './replace-version.ts'
export type { ReplaceRangeEdgeKind } from './replace-range.ts'

export type Modification =
  | Readonly<{
      kind: 'replaceVersion'
      selector: ReplaceVersionSelector
      to: string
    }>
  | Readonly<{
      kind: 'pinOverride'
      name: string
      to: string
    }>
  | Readonly<{
      kind: 'replaceRange'
      parent: NodeId
      name: string
      to: string
      from?: string
      edge?: ReplaceRangeEdgeKind
    }>
  | Readonly<{
      kind: 'addDependency'
      parent: NodeId
      name: string
      range: string
      edge: AddableEdgeKind
    }>
  | Readonly<{
      kind: 'removeDependency'
      parent: NodeId
      name: string
      edge?: EdgeKind
    }>
  | Readonly<{
      kind: 'applyPatch'
      patch: ApplyPatchSpec
      bytes: Uint8Array | string
    }>
  | Readonly<{
      kind: 'filterLicense'
      allow?: readonly string[]
      deny?: readonly string[]
      mode?: 'diagnostic-only' | 'strict'
    }>

export interface ModifyOptions extends OperationOptions {}

export type GraphChange =
  | Readonly<{ kind: 'node-added'; subject: NodeId }>
  | Readonly<{ kind: 'node-removed'; subject: NodeId }>
  | Readonly<{ kind: 'node-replaced'; subject: NodeId; previous?: NodeId }>
  | Readonly<{ kind: 'edge-added'; subject: EdgeTriple }>
  | Readonly<{ kind: 'edge-removed'; subject: EdgeTriple }>
  | Readonly<{ kind: 'peer-context-replaced'; subject: NodeId; previous?: NodeId }>
  | Readonly<{ kind: 'tarball-set'; subject: TarballKey }>
  | Readonly<{ kind: 'tarball-removed'; subject: TarballKey }>

export interface GraphFrontier {
  readonly added: ReadonlySet<NodeId>
  readonly orphaned: ReadonlySet<NodeId>
}

export interface ModifyResult {
  readonly graph: Graph
  readonly diagnostics: readonly Diagnostic[]
  readonly applied: readonly GraphChange[]
  readonly frontier: GraphFrontier
}

function operationRegistry(graph: Graph, options: ModifyOptions): RegistryAdapter {
  const registries = options.sources?.packuments ?? []
  if (registries.length === 0) return frozenRegistry(graph)
  if (registries.length === 1) return registries[0]!

  const first = async <Value>(
    read: (registry: RegistryAdapter) => Promise<Value | undefined>,
  ): Promise<Value | undefined> => {
    for (const registry of registries) {
      const value = await read(registry)
      if (value !== undefined) return value
    }
    return undefined
  }

  return Object.freeze({
    packument: (name: string) => first(registry => registry.packument(name)),
    resolve: (name: string, range: string) => first(registry => registry.resolve(name, range)),
    manifest: (name: string, version: string) => first(registry =>
      registry.manifest?.(name, version) ?? Promise.resolve(undefined)),
  })
}

function samePayload(left: unknown, right: unknown): boolean {
  if (left === right) return true
  return JSON.stringify(left) === JSON.stringify(right)
}

function graphChanges(before: Graph, after: Graph): GraphChange[] {
  const diff = before.diff(after)
  const changes: GraphChange[] = [
    ...diff.addedNodes.map(subject => ({ kind: 'node-added' as const, subject })),
    ...diff.removedNodes.map(subject => ({ kind: 'node-removed' as const, subject })),
    ...diff.changedNodes.map(subject => ({ kind: 'node-replaced' as const, subject })),
    ...diff.addedEdges.map(subject => ({ kind: 'edge-added' as const, subject })),
    ...diff.removedEdges.map(subject => ({ kind: 'edge-removed' as const, subject })),
  ]
  const previous = new Map(before.tarballs())
  const current = new Map(after.tarballs())
  for (const [subject, payload] of current) {
    if (!previous.has(subject) || !samePayload(previous.get(subject), payload)) {
      changes.push({ kind: 'tarball-set', subject })
    }
  }
  for (const subject of previous.keys()) {
    if (!current.has(subject)) changes.push({ kind: 'tarball-removed', subject })
  }
  return changes
}

/** Applies one or more graph edits in order and reports one operation result. */
export async function modify(
  graph: Graph,
  change: Modification | readonly Modification[],
  options: ModifyOptions,
): Promise<ModifyResult> {
  const changes = Array.isArray(change) ? change : [change]
  const diagnostics: Diagnostic[] = []
  const applied: GraphChange[] = []
  const added = new Set<NodeId>()
  const orphaned = new Set<NodeId>()
  const context = { registry: operationRegistry(graph, options) }
  let current = graph

  for (const modification of changes) {
    const before = current
    const result = await applyModification(
      current,
      modification,
      targetRequestOf(options.target).format,
      context,
      options.onDiagnostic,
    )
    current = result.graph
    diagnostics.push(...result.diagnostics)
    for (const id of result.added) added.add(id)
    for (const id of result.orphaned) orphaned.add(id)
    applied.push(...graphChanges(before, current))
  }

  return Object.freeze({
    graph: current,
    diagnostics: Object.freeze(diagnostics),
    applied: Object.freeze(applied),
    frontier: Object.freeze({ added, orphaned }),
  })
}

interface ModificationStepResult {
  readonly graph: Graph
  readonly diagnostics: readonly Diagnostic[]
  readonly added: ReadonlySet<NodeId>
  readonly orphaned: ReadonlySet<NodeId>
}

async function applyModification(
  graph: Graph,
  modification: Modification,
  format: FormatId,
  context: Readonly<{ registry: RegistryAdapter }>,
  onDiagnostic: ModifyOptions['onDiagnostic'],
): Promise<ModificationStepResult> {
  switch (modification.kind) {
    case 'replaceVersion': {
      const result = await replaceVersion(
        graph,
        modification.selector,
        modification.to,
        context,
        { onDiagnostic },
      )
      return step(result)
    }
    case 'pinOverride': {
      const result = await pinOverride(
        graph,
        modification.name,
        modification.to,
        context,
        { onDiagnostic },
      )
      return step(result)
    }
    case 'replaceRange': {
      const result = await replaceRange(
        graph,
        modification,
        format,
        context,
        { onDiagnostic },
      )
      return step(result)
    }
    case 'addDependency': {
      const result = await addDependency(
        graph,
        modification.parent,
        modification.name,
        modification.range,
        modification.edge,
        context,
        { onDiagnostic },
      )
      return step(result)
    }
    case 'removeDependency': {
      const result = await removeDependency(graph, modification.parent, modification.name, {
        kind: modification.edge,
        onDiagnostic,
      })
      return step(result)
    }
    case 'applyPatch': {
      const result = await applyPatch(
        graph,
        modification.patch,
        modification.bytes,
        context,
        { onDiagnostic },
      )
      return step(result)
    }
    case 'filterLicense': {
      const result = await filterLicense(graph, {
        allow: modification.allow,
        deny: modification.deny,
        mode: modification.mode,
        onDiagnostic,
      })
      return step(result)
    }
  }
}

function step(result: Readonly<{
  graph: Graph
  unresolved: readonly Diagnostic[]
  recentlyAdded: ReadonlySet<NodeId>
  recentlyOrphaned: ReadonlySet<NodeId>
}>): ModificationStepResult {
  return {
    graph: result.graph,
    diagnostics: result.unresolved,
    added: result.recentlyAdded,
    orphaned: result.recentlyOrphaned,
  }
}
