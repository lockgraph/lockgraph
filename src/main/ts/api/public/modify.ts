import type {
  Diagnostic as InternalDiagnostic,
  Graph as InternalGraph,
} from '../../graph.ts'
import {
  modify as modifyInternal,
  type Modification as InternalModification,
  type ModifyOptions as InternalModifyOptions,
  type ModifyResult as InternalModifyResult,
} from '../../modify/operation.ts'
import type { ApplyPatchSpec } from '../../modify/apply-patch.ts'
import type { ReplaceVersionSelector } from '../../modify/replace-version.ts'
import type { ReplaceRangeEdgeKind } from '../../modify/replace-range.ts'
import {
  internalGraph,
  isPublicGraph,
  publicDiagnostics,
  publicGraph,
  publicGraphChange,
  type EdgeKind,
  type Graph,
  type GraphChange,
  type NodeId,
} from './graph.ts'
import type {
  GraphOperationResult,
  OperationOptions,
} from './operation.ts'
import { internalProjectionOptions } from './options.ts'
import { publicPromise } from './errors.ts'

export type { ApplyPatchSpec, ReplaceVersionSelector }
export type { ReplaceRangeEdgeKind }

export type Modification =
  | Readonly<{
      kind: 'replaceVersion'
      selector: ReplaceVersionSelector
      to: string
    }>
  | Readonly<{ kind: 'pinOverride'; name: string; to: string }>
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
      edge: Exclude<EdgeKind, 'bundled'>
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

export interface GraphFrontier {
  readonly added: ReadonlySet<NodeId>
  readonly orphaned: ReadonlySet<NodeId>
}

export interface ModifyResult extends GraphOperationResult {
  readonly applied: readonly GraphChange[]
  readonly frontier: GraphFrontier
}

export function modify(
  graph: Graph,
  change: Modification | readonly Modification[],
  options: ModifyOptions,
): Promise<ModifyResult>
/** @internal Core-graph compatibility; stripped from the declaration. */
export function modify(
  graph: InternalGraph,
  change: InternalModification | readonly InternalModification[],
  options: InternalModifyOptions,
): Promise<InternalModifyResult>
export async function modify(
  graph: Graph | InternalGraph,
  change: Modification | readonly Modification[] | InternalModification | readonly InternalModification[],
  options: ModifyOptions | InternalModifyOptions,
): Promise<ModifyResult | InternalModifyResult> {
  if (!isPublicGraph(graph)) {
    return modifyInternal(
      graph as InternalGraph,
      change as InternalModification | readonly InternalModification[],
      options as InternalModifyOptions,
    )
  }
  const result = await publicPromise(modifyInternal(
    internalGraph(graph),
    change as InternalModification | readonly InternalModification[],
    internalProjectionOptions(options as ModifyOptions) as InternalModifyOptions,
  ))
  return Object.freeze({
    graph: publicGraph(result.graph),
    diagnostics: publicDiagnostics(result.diagnostics),
    applied: Object.freeze(result.applied.map(publicGraphChange)),
    frontier: Object.freeze({
      added: Object.freeze(new Set(result.frontier.added)),
      orphaned: Object.freeze(new Set(result.frontier.orphaned)),
    }),
  })
}

/** @internal Keeps the imported legacy diagnostic authority reachable for d.ts pruning. */
type _InternalDiagnostic = InternalDiagnostic
