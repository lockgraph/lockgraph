// ADR-0024 — optimize/ public re-exports.
//
// Mark-and-sweep orphan GC + OPTIMIZE_* diagnostic taxonomy. Per ADR §3.2
// directory layout; subpath `@antongolub/lockfile/optimize` mirrors
// `./modify` and `./complete`.

export { optimize, type OptimizeOptions, type OptimizeResult } from './optimize.ts'

// pruneOrphans — reference-count orphan GC (sibling of optimize's reachability
// GC). Retires only nodes that lost their last incoming edge of ANY kind after
// a dependency-changing modify+complete; never the present-but-unreferenced
// dev/optional/peer nodes optimize's reachability sweep over-collects.
export { pruneOrphans, type PruneOrphansOptions, type PruneOrphansResult } from './prune.ts'

// registryPackages — locator-aware `{ name: versions[] }` of the graph's real
// npm-registry packages (skips workspaces + non-registry sources). Owned here so
// an audit/registry consumer doesn't re-derive the classification.
export { registryPackages } from './registry-packages.ts'

export {
  optimizeNodeRemoved,
  optimizeNoop,
  optimizeWorkspaceUnreachable,
  pruneNodeRemoved,
  pruneNoop,
  pruneNoRoots,
  type OptimizeDiagnostic,
  type OptimizeDiagnosticCode,
  type PruneDiagnostic,
  type PruneDiagnosticCode,
} from './diagnostics.ts'
