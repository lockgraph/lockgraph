// ADR-0023 §3.2 — `addDependency`.
//
// Declare a new outgoing edge from a consumer (workspace or non-workspace
// node) to a named dependency at a given range; the post-modifier graph
// hands off to completion for the new node's transitive closure.
//
// B2: `kind` admissible values: 'dep' | 'dev' | 'optional'. 'peer' / 'bundled'
// throw INVALID_INPUT with cross-ref to ADR-0023 §10.

import {
  serializeNodeId,
  type Diagnostic,
  type EdgeKind,
  type Graph,
  type Node,
  type NodeId,
  type TarballPayload,
} from '../graph.ts'
import type { Integrity } from '../recipe/integrity.ts'
import { LockfileError } from '../errors.ts'
import { resolveFindUp } from '../complete/find-up.ts'
import type { ModifyContext } from './context.ts'
import {
  modifyEdgeRewired,
  modifyNodeAdded,
  modifyResolveFailed,
} from './diagnostics.ts'

export type AddableEdgeKind = 'dep' | 'dev' | 'optional'

const VALID_KINDS: ReadonlySet<EdgeKind> = new Set<EdgeKind>(['dep', 'dev', 'optional'])

export interface AddDependencyResult {
  graph:            Graph
  added:            NodeId[]
  recentlyAdded:    Set<NodeId>
  recentlyOrphaned: Set<NodeId>
  unresolved:       Diagnostic[]
}

export async function addDependency(
  graph: Graph,
  parentId: NodeId,
  name: string,
  range: string,
  kind: AddableEdgeKind,
  context: ModifyContext,
  options: { onDiagnostic?: (d: Diagnostic) => void } = {},
): Promise<AddDependencyResult> {
  if (!VALID_KINDS.has(kind)) {
    throw new LockfileError({
      code:    'INVALID_INPUT',
      message: `addDependency: kind ${kind} unsupported; ADR-0023 v1 admits 'dep' | 'dev' | 'optional' (see §10)`,
    })
  }

  const onDiagnostic = options.onDiagnostic
  const unresolved: Diagnostic[] = []
  const emit = (d: Diagnostic): void => {
    unresolved.push(d)
    if (onDiagnostic !== undefined) onDiagnostic(d)
  }

  const parent = graph.getNode(parentId)
  if (parent === undefined) {
    throw new LockfileError({
      code:    'INVALID_INPUT',
      message: `addDependency: parent ${parentId} not in graph`,
    })
  }

  // §3.2 step 2 — find-up first. `kind` threaded for ADR-0023 §5.1 signature
  // parity; v1 find-up body is kind-agnostic but the parameter is reserved.
  const existingId = resolveFindUp(graph, parentId, name, range, kind)
  if (existingId !== undefined) {
    // Reuse branch — addEdge to the existing sibling (if it's not already wired).
    if (hasEdge(graph, parentId, existingId, kind)) {
      // Idempotent no-op: edge already exists.
      return {
        graph,
        added: [],
        recentlyAdded: new Set(),
        recentlyOrphaned: new Set(),
        unresolved,
      }
    }
    const rewireDiag = modifyEdgeRewired({ src: parentId, dst: existingId, kind })
    const result = graph.mutate(m => {
      m.addEdge(parentId, existingId, kind, { range })
      // ADR-0023 §8.6: emit on Graph.diagnostics() via Mutator.diagnostic.
      m.diagnostic(rewireDiag)
    })
    emit(rewireDiag)
    return {
      graph:            result.graph,
      added:            [],
      recentlyAdded:    new Set([existingId]),
      recentlyOrphaned: new Set(),
      unresolved,
    }
  }

  // §3.2 step 3 — registry.resolve + addNode + addEdge.
  const resolved = await context.registry.resolve(name, range)
  if (resolved === undefined) {
    const d = modifyResolveFailed(name, range)
    emit(d)
    graph = graph.mutate(m => { m.diagnostic(d) }).graph
    return {
      graph,
      added: [],
      recentlyAdded: new Set(),
      recentlyOrphaned: new Set(),
      unresolved,
    }
  }

  const newId = serializeNodeId(resolved.name, resolved.version, [])
  const recentlyAdded = new Set<NodeId>()
  const added: NodeId[] = []

  // Idempotent guard: if `newId` already in graph (e.g. a sibling not in the
  // find-up chain but globally present), reuse it without re-adding.
  if (graph.getNode(newId) === undefined) {
    const newNode: Node = {
      id:          newId,
      name:        resolved.name,
      version:     resolved.version,
      peerContext: [],
    }
    const payload = makeTarballPayload(resolved)
    const addedDiag = modifyNodeAdded(parentId, newId)
    const result = graph.mutate(m => {
      m.addNode(newNode)
      m.setTarball({ name: resolved.name, version: resolved.version }, payload)
      m.addEdge(parentId, newId, kind, { range })
      m.diagnostic(addedDiag)
    })
    graph = result.graph
    added.push(newId)
    recentlyAdded.add(newId)
    emit(addedDiag)
  } else if (!hasEdge(graph, parentId, newId, kind)) {
    const rewireDiag = modifyEdgeRewired({ src: parentId, dst: newId, kind })
    const result = graph.mutate(m => {
      m.addEdge(parentId, newId, kind, { range })
      m.diagnostic(rewireDiag)
    })
    graph = result.graph
    recentlyAdded.add(newId)
    emit(rewireDiag)
  }

  return {
    graph,
    added,
    recentlyAdded,
    recentlyOrphaned: new Set(),
    unresolved,
  }
}

// `addDependency` always wires the canonical descriptor (no alias) — guard
// only the canonical slot so an existing aliased sibling (e.g. via parser
// or another modifier) does not block adding the unaliased edge, and vice
// versa.
function hasEdge(graph: Graph, src: NodeId, dst: NodeId, kind: EdgeKind): boolean {
  for (const e of graph.out(src, kind)) {
    if (e.dst === dst && e.attrs?.alias === undefined) return true
  }
  return false
}

function makeTarballPayload(pv: {
  integrity?:           Integrity
  engines?:             Record<string, string>
  os?:                  string[]
  cpu?:                 string[]
  libc?:                string[]
  bin?:                 string | Record<string, string>
  bundledDependencies?: string[]
  deprecated?:          string
  tarball?:             string
}): TarballPayload {
  return {
    integrity:           pv.integrity,
    engines:             pv.engines,
    os:                  pv.os,
    cpu:                 pv.cpu,
    libc:                pv.libc,
    bin:                 pv.bin,
    bundledDependencies: pv.bundledDependencies,
    deprecated:          pv.deprecated,
    resolution:          pv.tarball === undefined ? undefined : { type: 'tarball', url: pv.tarball },
  }
}
