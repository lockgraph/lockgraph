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
  completionNodeAdded,
  completionNodeUnknown,
  completionPeerContextIncomplete,
  completionUnresolved,
  completionVersionUnknown,
  type CompletionDiagnostic,
  type CompletionDiagnosticCode,
} from './diagnostics.ts'
