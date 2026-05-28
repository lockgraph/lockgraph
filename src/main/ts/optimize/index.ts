// ADR-0024 — optimize/ public re-exports.
//
// Mark-and-sweep orphan GC + OPTIMIZE_* diagnostic taxonomy. Per ADR §3.2
// directory layout; subpath `@antongolub/lockfile/optimize` mirrors
// `./modify` and `./complete`.

export { optimize, type OptimizeOptions, type OptimizeResult } from './optimize.ts'

export {
  optimizeNodeRemoved,
  optimizeNoop,
  optimizeWorkspaceUnreachable,
  type OptimizeDiagnostic,
  type OptimizeDiagnosticCode,
} from './diagnostics.ts'
