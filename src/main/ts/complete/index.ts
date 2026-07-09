// ADR-0023 — complete/ public re-exports.
//
// Tree completion BFS + find-up resolve + COMPLETION_* diagnostics.
// Per ADR §8.1 directory layout.

export {
  completeTransitives,
  type CompletionOptions,
  type CompletionResult,
  type CompletionSeed,
} from './tree-complete.ts'

export {
  ancestorsOf,
  resolveFindUp,
} from './find-up.ts'

export {
  completionEdgeResolved,
  completionNoCandidate,
  completionNodeAdded,
  completionNodeUnknown,
  completionOverrideConstraintConflict,
  completionPeerContextIncomplete,
  completionUnresolved,
  completionVersionUnknown,
  type CompletionDiagnostic,
  type CompletionDiagnosticCode,
  type RejectedCandidate,
} from './diagnostics.ts'

// ADR-0037 — node-local acceptance constraints.
export {
  constrainedCandidates,
  engines,
  license,
  selectConstrained,
  type Awaitable,
  type Condition,
  type ConditionContext,
  type OnUnevaluable,
  type SelectResult,
  type Verdict,
} from './constraints.ts'

// ADR-0037 v2 — opt-in bounded-backtracking discovery.
export {
  probeAlternativeParent,
  type BudgetCounter,
  type CompletionBudget,
  type ParentSuggestion,
  type ProbeResult,
} from './backtrack.ts'
