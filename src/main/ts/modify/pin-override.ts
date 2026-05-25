// ADR-0023 §3.2 — `pinOverride`.
//
// Equivalent to `replaceVersion(graph, {name, fromRange: '*'}, range, ctx)`,
// PLUS emits a single `MODIFY_OVERRIDE_PINNED` diagnostic per §7.1 / F6 /
// §8.6 Mutator API extension. Stringify-side adapters read the pin record
// from `Graph.diagnostics()` (canonical channel); the diagnostic is also
// surfaced on `ModifyResult.unresolved` as the per-call streaming hook.

import type { Diagnostic, Graph } from '../graph.ts'
import type { ModifyContext } from './context.ts'
import { modifyOverridePinned } from './diagnostics.ts'
import { replaceVersion, type ReplaceVersionResult } from './replace-version.ts'

export interface PinOverrideResult extends ReplaceVersionResult {}

export async function pinOverride(
  graph: Graph,
  name: string,
  range: string,
  context: ModifyContext,
  options: { onDiagnostic?: (d: Diagnostic) => void } = {},
): Promise<PinOverrideResult> {
  const onDiagnostic = options.onDiagnostic

  // Resolve once to populate the diagnostic with the concrete version.
  // The inner replaceVersion resolves again; Phase C registry.resolve is
  // referentially transparent over (name, range) so the second call is a
  // free repeat on the frozen default. F2 / live adapters may add caching.
  const resolved = await context.registry.resolve(name, range)

  const result = await replaceVersion(
    graph,
    { name, fromRange: '*' },
    range,
    context,
    { onDiagnostic },
  )

  if (resolved !== undefined) {
    const diag = modifyOverridePinned(name, resolved.version)
    // ADR-0023 §3.2 emission path / §8.6 Mutator API extension:
    // land the pin record on Graph.diagnostics() via m.diagnostic so
    // stringify-side adapters can project it back to a PM-native
    // override entry. The diagnostic is ALSO surfaced on
    // ModifyResult.unresolved (per §7.5 streaming hook).
    const pinResult = result.graph.mutate(m => {
      m.diagnostic(diag)
    })
    result.graph = pinResult.graph
    if (onDiagnostic !== undefined) onDiagnostic(diag)
    result.unresolved.push(diag)
  }

  return result
}
