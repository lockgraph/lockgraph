import { LockfileError } from '../api/errors.ts'
import semver from 'semver'
import type { FormatId } from '../api/format-contract.ts'
import {
  serializeNodeId,
  type Diagnostic,
  type Edge,
  type Graph,
  type Node,
  type NodeId,
} from '../graph.ts'
import { payloadOfPackumentVersion, setMintedTarball } from '../registry/payload.ts'
import type { ModifyContext } from './context.ts'
import {
  modifyEdgeRewired,
  modifyNodeAdded,
  modifyRangePending,
  modifyResolveFailed,
} from './diagnostics.ts'

export type ReplaceRangeEdgeKind = 'dep' | 'dev' | 'optional'

export interface ReplaceRangeSpec {
  readonly parent: NodeId
  readonly name: string
  readonly to: string
  readonly from?: string
  readonly edge?: ReplaceRangeEdgeKind
}

export interface ReplaceRangeResult {
  readonly graph: Graph
  readonly added: NodeId[]
  readonly recentlyAdded: Set<NodeId>
  readonly recentlyOrphaned: Set<NodeId>
  readonly unresolved: Diagnostic[]
}

/** Replace one declared dependency range and rebind its resolved target. */
export async function replaceRange(
  graph: Graph,
  spec: ReplaceRangeSpec,
  format: FormatId,
  context: ModifyContext,
  options: { onDiagnostic?: (diagnostic: Diagnostic) => void } = {},
): Promise<ReplaceRangeResult> {
  if (format !== 'yarn-classic' && !format.startsWith('yarn-berry-')) {
    throw new LockfileError({
      code: 'CAPABILITY_LACK',
      message: `replaceRange is unsupported for ${format}; only yarn-classic and yarn-berry targets carry descriptor bindings`,
    })
  }
  if (graph.getNode(spec.parent) === undefined) {
    throw new LockfileError({
      code: 'INVALID_INPUT',
      message: `replaceRange: parent ${spec.parent} not in graph`,
    })
  }

  const matching = graph.out(spec.parent).filter(edge => matchesDeclaration(graph, edge, spec))
  if (matching.length !== 1) {
    throw new LockfileError({
      code: 'INVALID_INPUT',
      message: matching.length === 0
        ? `replaceRange: ${spec.parent} has no matching edge to ${spec.name}`
        : `replaceRange: ${spec.parent} has ${matching.length} edges to ${spec.name}; pass edge to disambiguate`,
    })
  }
  const previous = matching[0]!
  const currentRange = previous.attrs?.range
  if (currentRange === undefined) {
    throw new LockfileError({
      code: 'INVALID_INPUT',
      message: `replaceRange: ${spec.parent} → ${spec.name} has no declared range`,
    })
  }
  if (spec.from !== undefined && !sameYarnGuardRange(currentRange, spec.from)) {
    throw new LockfileError({
      code: 'INVALID_INPUT',
      message: `replaceRange: expected ${spec.name}@${spec.from} on ${spec.parent}, found ${currentRange}`,
    })
  }

  const unresolved: Diagnostic[] = []
  const emit = (diagnostic: Diagnostic): void => {
    unresolved.push(diagnostic)
    options.onDiagnostic?.(diagnostic)
  }
  const resolved = await context.registry.resolve(spec.name, spec.to)
  if (resolved === undefined) {
    const diagnostic = modifyResolveFailed(spec.name, spec.to)
    emit(diagnostic)
    // `replaceRange` may intentionally run before the version-changing apply
    // phase.  A frozen graph cannot resolve the future descriptor yet, but the
    // declaration still has to move now so the following replaceVersion +
    // complete sequence does not retain the stale lock key.  Keep the current
    // target as a temporary binding; completion (or the subsequent version
    // replacement) settles it once registry authority is available.
    const currentTarget = graph.getNode(previous.dst)!
    const pendingDiagnostic = yarnRangeSatisfies(currentTarget.version, spec.to)
      ? undefined
      : modifyRangePending(spec.parent, spec.name, spec.to, previous.dst, previous.kind)
    if (pendingDiagnostic !== undefined) emit(pendingDiagnostic)
    const result = graph.mutate(mutation => {
      mutation.removeEdge(previous.src, previous.dst, previous.kind)
      mutation.addEdge(previous.src, previous.dst, previous.kind, {
        ...previous.attrs,
        range: spec.to,
      })
      mutation.diagnostic(diagnostic)
      if (pendingDiagnostic !== undefined) mutation.diagnostic(pendingDiagnostic)
    })
    return emptyResult(result.graph, unresolved)
  }

  const targetId = serializeNodeId(resolved.name, resolved.version, [])
  const targetExists = graph.getNode(targetId) !== undefined
  const targetNode: Node = {
    id: targetId,
    name: resolved.name,
    version: resolved.version,
    peerContext: [],
  }
  const edgeDiagnostic = modifyEdgeRewired({
    src: spec.parent,
    dst: targetId,
    kind: previous.kind,
  })
  const nodeDiagnostic = targetExists ? undefined : modifyNodeAdded(spec.parent, targetId)
  const result = graph.mutate(mutation => {
    mutation.removeEdge(previous.src, previous.dst, previous.kind)
    if (!targetExists) {
      mutation.addNode(targetNode)
      setMintedTarball(
        mutation,
        { name: resolved.name, version: resolved.version },
        payloadOfPackumentVersion(resolved),
      )
    }
    mutation.addEdge(previous.src, targetId, previous.kind, {
      ...previous.attrs,
      range: spec.to,
    })
    if (nodeDiagnostic !== undefined) mutation.diagnostic(nodeDiagnostic)
    mutation.diagnostic(edgeDiagnostic)
  })
  if (nodeDiagnostic !== undefined) emit(nodeDiagnostic)
  emit(edgeDiagnostic)

  const recentlyOrphaned = new Set<NodeId>()
  if (previous.dst !== targetId) {
    const previousNode = result.graph.getNode(previous.dst)
    if (previousNode !== undefined
      && previousNode.workspacePath === undefined
      && result.graph.in(previous.dst).length === 0) {
      recentlyOrphaned.add(previous.dst)
    }
  }
  return {
    graph: result.graph,
    added: targetExists ? [] : [targetId],
    recentlyAdded: new Set([targetId]),
    recentlyOrphaned,
    unresolved,
  }
}

function yarnRangeSatisfies(version: string, range: string): boolean {
  let candidate = range
  if (candidate.startsWith('npm:')) {
    candidate = candidate.slice('npm:'.length)
    const aliasSeparator = candidate.lastIndexOf('@')
    if (aliasSeparator > 0) candidate = candidate.slice(aliasSeparator + 1)
  } else {
    const colon = candidate.indexOf(':')
    if (colon > 0 && /^[a-z][a-z0-9+.-]*$/i.test(candidate.slice(0, colon))) return false
  }
  const normalized = semver.validRange(candidate)
  return normalized !== null && semver.satisfies(version, normalized)
}

function sameYarnGuardRange(current: string, expected: string): boolean {
  const withoutOptionalRegistryProtocol = (range: string): string =>
    range.startsWith('npm:') ? range.slice('npm:'.length) : range
  return withoutOptionalRegistryProtocol(current) === withoutOptionalRegistryProtocol(expected)
}

function matchesDeclaration(graph: Graph, edge: Edge, spec: ReplaceRangeSpec): boolean {
  if (edge.kind !== 'dep' && edge.kind !== 'dev' && edge.kind !== 'optional') return false
  if (spec.edge !== undefined && edge.kind !== spec.edge) return false
  const target = graph.getNode(edge.dst)
  return target !== undefined && (edge.attrs?.alias ?? target.name) === spec.name
}

function emptyResult(graph: Graph, unresolved: Diagnostic[]): ReplaceRangeResult {
  return {
    graph,
    added: [],
    recentlyAdded: new Set(),
    recentlyOrphaned: new Set(),
    unresolved,
  }
}
