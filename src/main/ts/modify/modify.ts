// ADR-0023 §8.2 — `modify()` orchestrator + `ModifyResult` discriminated union.
//
// Per ADR §8.2, `modify(graph, primitive, options?)` is the single dispatch
// entry point for the modifier vocabulary. It accepts a discriminated
// `Primitive` payload (kind-tagged intent), routes to the corresponding
// per-primitive implementation, and returns a `ModifyResult` carrying the
// kind tag for downstream type narrowing.
//
// The per-primitive functions (`replaceVersion`, `pinOverride`, ...) remain
// individually callable; the orchestrator wraps them, it does not replace
// them. This preserves call-site ergonomics for callers who know which
// primitive they want, while exposing the §8.2 single entry point for
// composers (audit-fix runner, ADR-0008 iterative loop) that dispatch over
// kind without per-primitive branching.

import type { Diagnostic, EdgeKind, Graph, NodeId } from '../graph.ts'
import { addDependency, type AddDependencyResult, type AddableEdgeKind } from './add-dependency.ts'
import { applyPatch, type ApplyPatchResult, type ApplyPatchSpec } from './apply-patch.ts'
import { filterLicense, type FilterLicenseResult } from './filter-license.ts'
import { pinOverride, type PinOverrideResult } from './pin-override.ts'
import { removeDependency, type RemoveDependencyResult } from './remove-dependency.ts'
import {
  replaceVersion,
  type ReplaceVersionResult,
  type ReplaceVersionSelector,
} from './replace-version.ts'
import { resolveContext, type ModifyOptions } from './context.ts'

/**
 * Common shape every per-primitive result conforms to.
 *
 * Per ADR-0023 §7.5 — `unresolved` is the per-call streaming hook carrying
 * all diagnostics emitted by the primitive (info / warning / error).
 *
 * Per ADR-0023 §4.1 — `recentlyAdded` / `recentlyOrphaned` seed the
 * completion frontier.
 */
export interface ModifyResultBase {
  graph:            Graph
  unresolved:       Diagnostic[]
  recentlyAdded:    Set<NodeId>
  recentlyOrphaned: Set<NodeId>
}

/**
 * Discriminated union of the modifier vocabulary's intent payloads.
 *
 * Each variant carries the per-primitive parameter list verbatim from §3.1.
 * `kind` is the discriminator the orchestrator switches on.
 */
export type Primitive =
  | {
      kind:       'replaceVersion'
      selector:   ReplaceVersionSelector
      toRange:    string
    }
  | {
      kind:  'pinOverride'
      name:  string
      range: string
    }
  | {
      kind:     'addDependency'
      parentId: NodeId
      name:     string
      range:    string
      depKind:  AddableEdgeKind
    }
  | {
      kind:     'removeDependency'
      parentId: NodeId
      name:     string
      /** Restrict removal to a specific edge kind. Defaults to all matching `name`. */
      edgeKind?: EdgeKind
    }
  | {
      kind:       'applyPatch'
      spec:       ApplyPatchSpec
      patchBytes: Uint8Array | string
    }
  | {
      kind:    'filterLicense'
      allow?:  readonly string[]
      deny?:   readonly string[]
      mode?:   'diagnostic-only' | 'strict'
    }

/**
 * Discriminated union of per-primitive results.
 *
 * Each variant carries the per-primitive `Xxx` result shape verbatim
 * (sharing the §7.5 `unresolved` + §4.1 `recentlyAdded` / `recentlyOrphaned`
 * fields) plus a `kind` discriminator matching the input primitive's kind.
 *
 * Narrow via `result.kind === 'replaceVersion'` to access primitive-specific
 * fields (e.g. `replaced`, `flagged`, `patched`).
 */
export type ModifyResult =
  | ({ kind: 'replaceVersion' }   & ReplaceVersionResult)
  | ({ kind: 'pinOverride' }      & PinOverrideResult)
  | ({ kind: 'addDependency' }    & AddDependencyResult)
  | ({ kind: 'removeDependency' } & RemoveDependencyResult)
  | ({ kind: 'applyPatch' }       & ApplyPatchResult)
  | ({ kind: 'filterLicense' }    & FilterLicenseResult)

/**
 * ADR-0023 §8.2 — single dispatch entry point for the modifier vocabulary.
 *
 * Dispatches on `primitive.kind` to the corresponding per-primitive
 * implementation. The returned `ModifyResult` carries the same kind tag for
 * downstream type narrowing.
 *
 * `options.context` defaults to `frozenRegistry(graph)` per §6.1 / §6.2
 * offline-first guarantee — callers may omit the context entirely for the
 * audit-fix v1 use case where the target version is already in-graph.
 *
 * Per ADR-0023 §8.3 — every primitive is `async`; the orchestrator awaits
 * the inner call and returns the result with the kind discriminator
 * attached.
 */
export async function modify(
  graph:     Graph,
  primitive: Primitive,
  options?:  ModifyOptions,
): Promise<ModifyResult> {
  const context      = resolveContext(graph, options)
  const onDiagnostic = options?.onDiagnostic

  switch (primitive.kind) {
    case 'replaceVersion': {
      const inner = await replaceVersion(
        graph,
        primitive.selector,
        primitive.toRange,
        context,
        { onDiagnostic },
      )
      return { kind: 'replaceVersion', ...inner }
    }
    case 'pinOverride': {
      const inner = await pinOverride(
        graph,
        primitive.name,
        primitive.range,
        context,
        { onDiagnostic },
      )
      return { kind: 'pinOverride', ...inner }
    }
    case 'addDependency': {
      const inner = await addDependency(
        graph,
        primitive.parentId,
        primitive.name,
        primitive.range,
        primitive.depKind,
        context,
        { onDiagnostic },
      )
      return { kind: 'addDependency', ...inner }
    }
    case 'removeDependency': {
      const inner = await removeDependency(graph, primitive.parentId, primitive.name, {
        kind: primitive.edgeKind,
        onDiagnostic,
      })
      return { kind: 'removeDependency', ...inner }
    }
    case 'applyPatch': {
      const inner = await applyPatch(
        graph,
        primitive.spec,
        primitive.patchBytes,
        context,
        { onDiagnostic },
      )
      return { kind: 'applyPatch', ...inner }
    }
    case 'filterLicense': {
      const inner = await filterLicense(graph, {
        allow:        primitive.allow,
        deny:         primitive.deny,
        mode:         primitive.mode,
        onDiagnostic,
      })
      return { kind: 'filterLicense', ...inner }
    }
  }
}
