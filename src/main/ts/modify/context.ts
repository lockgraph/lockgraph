// ADR-0023 §3.1 — ModifyContext shape.
//
// `registry` is required at the type level — every modifier may need to
// consult the adapter even for pure-graph intents (e.g. replaceVersion
// resolves toRange via registry.resolve). Callers that want the offline
// default supply frozenRegistry(graph) at the call site.

import type { Diagnostic, Graph, Manifest } from '../graph.ts'
import { frozenRegistry } from '../registry/frozen.ts'
import type { CacheAdapter, RegistryAdapter } from '../registry/types.ts'

export interface ModifyContext {
  registry:   RegistryAdapter
  cache?:     CacheAdapter
  /** Declared manifests keyed by workspace path (ADR-0025). Carries override
   *  declarations + workspace context for enrich / re-resolution. */
  manifests?: Record<string, Manifest>
}

export interface ModifyOptions {
  context?:      ModifyContext
  onDiagnostic?: (d: Diagnostic) => void
}

/** Resolve a ModifyContext from options: caller-supplied wins, else frozenRegistry(graph). */
export function resolveContext(graph: Graph, options?: ModifyOptions): ModifyContext {
  if (options?.context !== undefined) return options.context
  return { registry: frozenRegistry(graph) }
}
