// ADR-0023 §5 — find-up resolve semantics.
//
// Closest-ancestor-wins flat hoist with nested fallback. Tiebreaker
// (per §5.1 / F1): highest semver version wins; on tie, lowest NodeId
// in lexicographic order wins (matches ADR-0007 content-sorted
// iteration order at resolve time).

import semver from 'semver'
import type { EdgeKind, Graph, Node, NodeId } from '../graph.ts'

const cmpStr = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0

/**
 * Walk consumer → root via incoming-edge BFS.
 * Returns nodes in BFS order: consumer first, deeper ancestors last.
 * Cycles tolerated via `seen`.
 */
export function ancestorsOf(graph: Graph, consumer: NodeId): Node[] {
  const consumerNode = graph.getNode(consumer)
  if (consumerNode === undefined) return []

  const result: Node[] = [consumerNode]
  const seen   = new Set<NodeId>([consumer])
  const queue: NodeId[] = [consumer]

  while (queue.length > 0) {
    const cur = queue.shift()!
    for (const edge of graph.in(cur)) {
      if (seen.has(edge.src)) continue
      const srcNode = graph.getNode(edge.src)
      if (srcNode === undefined) continue
      seen.add(edge.src)
      result.push(srcNode)
      queue.push(edge.src)
    }
  }

  return result
}

/**
 * Find-up resolve per ADR-0023 §5.1.
 *
 * Returns the closest-ancestor satisfying node, or undefined if either
 * (a) no ancestor declares `name` at all → caller may install nested at the
 *     consumer's level, or
 * (b) the closest ancestor that declares `name` does so with a conflicting
 *     range → "block hoist", caller installs nested fallback (npm-3 style).
 *
 * Tiebreaker:
 *   1. Highest semver-comparable version wins (`semver.rcompare`).
 *   2. On version tie, lowest NodeId lex order wins.
 *
 * `depKind` is part of the §5.1 normative signature but does NOT affect the
 * algorithm body in v1: every dep-kind (dep / dev / optional / peer) follows
 * the same closest-ancestor reuse + block-hoist contract. The parameter is
 * carried verbatim so future kind-filtered hoist policies (e.g. peer-deps
 * needing a stricter find-up, or optional-deps allowed to silently fail
 * differently from regular deps) can branch on it without a signature
 * migration. Per the ADR §5.1 pseudocode body and the v1 normative scope, no
 * kind-specific branch is taken yet.
 */
export function resolveFindUp(
  graph: Graph,
  consumerId: NodeId,
  name: string,
  range: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  depKind: EdgeKind,
): NodeId | undefined {
  // depKind reserved per the §5.1 ADR signature; v1 algorithm is kind-agnostic.
  // Reference the parameter so noUnusedParameters / strict modes do not flag it.
  void depKind
  const path = ancestorsOf(graph, consumerId)

  for (const ancestor of path) {
    const candidates: Node[] = []
    for (const edge of graph.out(ancestor.id)) {
      const dst = graph.getNode(edge.dst)
      if (dst === undefined) continue
      if (dst.name === name) candidates.push(dst)
    }
    if (candidates.length === 0) continue

    const satisfying = candidates.filter(c => safeSatisfies(c.version, range))
    if (satisfying.length === 0) {
      // Block-hoist: a sibling under this ancestor binds `name` to a
      // conflicting range. Caller installs nested per npm-3 semantics.
      return undefined
    }

    // Tiebreaker: highest version, then lowest NodeId lex.
    satisfying.sort((a, b) => {
      const v = semverRcompareSafe(a.version, b.version)
      if (v !== 0) return v
      return cmpStr(a.id, b.id)
    })
    return satisfying[0]!.id
  }

  return undefined
}

function safeSatisfies(version: string, range: string): boolean {
  // `*` is admissible in our find-up callers as the degenerate "match all" range;
  // semver.satisfies('1.2.3', '*') is true so no special case needed, but we guard
  // against unparseable ranges to fail closed (no spurious match).
  try {
    return semver.satisfies(version, range)
  } catch {
    return false
  }
}

function semverRcompareSafe(a: string, b: string): number {
  const va = semver.valid(a)
  const vb = semver.valid(b)
  if (va !== null && vb !== null) return semver.rcompare(a, b)
  // Fallback: lex desc to keep tiebreaker total-order stable on invalid versions.
  return cmpStr(b, a)
}
