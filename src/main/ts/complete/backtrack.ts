// ADR-0037 v2 — bounded-backtracking DISCOVERY escalation.
//
// When v1's node-local filter hits a cliff (a dependency of consumer P has NO
// constraint-passing version in range) AND a `budget` is supplied, this searches
// — bounded by `maxCombinations` — for a LOWER version of P whose OWN immediate
// dependency closure is constraint-clean, and REPORTS it: the compatible version
// plus the override that pins it. This is the exact ADR-0037 §5 cliff case
// (`foo@1.9→bar@^2` fails, `foo@1.4→bar@^1` clean).
//
// It is READ-ONLY — it never mutates the graph, so the emitted lock stays
// byte-identical to v1 (frozen-clean by construction). The caller applies the
// suggested override to make the fix durable (a lower in-range pin survives even
// a non-frozen `npm install` — verified against npm/pnpm/yarn source; an override
// is only needed to defend against an explicit `npm update`). Auto-APPLYING the
// discovery (graph surgery: detach / prune / re-mint) is a deliberate follow-up.

import semver from 'semver'
import type { Graph, NodeId, OverrideConstraint } from '../graph.ts'
import type { PackumentVersion, RegistryAdapter } from '../registry/types.ts'
import { overrideTargetFor } from '../recipe/descriptor-resolve.ts'
import {
  constrainedCandidates,
  selectConstrained,
  type Condition,
  type OnUnevaluable,
} from './constraints.ts'

/** Combinatorial search budget (ADR-0037 v2). Count-based ⇒ DETERMINISTIC
 *  (unlike a wall-clock budget): same inputs + same cap → same result. */
export interface CompletionBudget {
  /** Hard cap on alternative consumer-versions probed across the WHOLE pass (a
   *  single global pool). One unit = one lower-version candidate examined. */
  maxCombinations: number
}

/** Internal mutable counter threaded through a completion pass. */
export interface BudgetCounter {
  readonly max: number
  spent: number
}

export interface ParentSuggestion {
  /** The consumer package whose lower version clears the cliff. */
  consumer: string
  /** The version to pin it to (the highest passing version below the current). */
  version: string
  /** The declared range that lower version still satisfies (the override key). */
  range: string
}

export type ProbeResult =
  | { kind: 'found'; suggestion: ParentSuggestion }
  | { kind: 'exhausted' } // budget ran out before a solution was found
  | { kind: 'none' } //      fully searched within budget; no lower parent works

/**
 * Bounded search for a LOWER version of consumer `consumerId` whose immediate
 * dependency closure is constraint-clean. Read-only. Walks the consumer's
 * constraint-passing candidates (from its parent edges' ranges) strictly BELOW
 * its current version, HIGHEST-first, spending one budget unit per candidate
 * probed. Deterministic: parent edges sorted by src NodeId, versions descending.
 */
export async function probeAlternativeParent(
  graph: Graph,
  consumerId: NodeId,
  opts: {
    registry: RegistryAdapter
    constraints: readonly Condition[]
    onUnevaluable: OnUnevaluable
    overrides: readonly OverrideConstraint[]
    budget: BudgetCounter
  },
): Promise<ProbeResult> {
  const consumer = graph.getNode(consumerId)
  if (consumer === undefined) return { kind: 'none' }
  const { registry, constraints, onUnevaluable, overrides, budget } = opts

  // Parent edges that BOUND the consumer and are re-selectable: a registry range,
  // NOT an override pin (an override is a fixed point — never backtracked).
  // Sorted by src NodeId for determinism.
  const parentEdges = graph
    .in(consumerId)
    .filter(
      e =>
        (e.kind === 'dep' || e.kind === 'optional') &&
        e.attrs?.range !== undefined &&
        e.attrs.overrideRange === undefined,
    )
    .sort((a, b) => (a.src < b.src ? -1 : a.src > b.src ? 1 : 0))
  if (parentEdges.length === 0) return { kind: 'none' }

  for (const parentEdge of parentEdges) {
    const parentRange = parentEdge.attrs!.range!
    for await (const cand of constrainedCandidates(registry, consumer.name, parentRange, constraints, onUnevaluable)) {
      if (!semverLt(cand.version, consumer.version)) continue // only strictly LOWER than current
      if (budget.spent >= budget.max) return { kind: 'exhausted' }
      budget.spent += 1
      if (await immediateDepsClean(cand.node, opts)) {
        return { kind: 'found', suggestion: { consumer: consumer.name, version: cand.version, range: parentRange } }
      }
    }
  }
  return { kind: 'none' }
}

/** True when EVERY immediate dependency of `pv` resolves to a constraint-passing
 *  version (node-local). If any cliffs (`NO_CANDIDATE`), `pv` is not viable. An
 *  unresolvable dep (unknown package) does NOT block — it is not a constraint
 *  cliff and would fail identically under any version choice. */
async function immediateDepsClean(
  pv: PackumentVersion,
  opts: {
    registry: RegistryAdapter
    constraints: readonly Condition[]
    onUnevaluable: OnUnevaluable
    overrides: readonly OverrideConstraint[]
  },
): Promise<boolean> {
  const { registry, constraints, onUnevaluable, overrides } = opts
  for (const deps of [pv.dependencies, pv.optionalDependencies]) {
    if (deps === undefined) continue
    for (const depName of Object.keys(deps).sort()) {
      const declared = deps[depName]!
      const to = overrides.length > 0 ? overrideTargetFor(depName, declared, [pv.name], overrides) : undefined
      const sel = await selectConstrained(registry, depName, to ?? declared, constraints, onUnevaluable)
      if (sel.selected === undefined && sel.rejected.length > 0) return false // this dep cliffs → pv not viable
    }
  }
  return true
}

function semverLt(a: string, b: string): boolean {
  try {
    return semver.lt(a, b)
  } catch {
    return a < b
  }
}
