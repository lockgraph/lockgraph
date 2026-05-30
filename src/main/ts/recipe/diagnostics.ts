// Adapter-facing recipe diagnostic helpers — RECIPE_* loss emission.
//
// Recipe primitives (`recipe/integrity.ts`, `recipe/patch.ts`) stay pure
// math; adapters carry the diagnostic invocation. This module hosts the
// shared adapter-side helpers so the per-feature drop semantics surface
// through ONE code-shape (`RECIPE_FEATURE_DROPPED`) across patch-incapable
// adapters — replacing the per-adapter `<PREFIX>_PATCH_DROPPED` codes per
// ADR-0014 §5 :454 canonical-mapping rule.

import type { Diagnostic, EdgeTriple, Graph, NodeId } from '../graph.ts'

/**
 * F1 SRI parse-side diagnostic factory — emitted when external integrity
 * input fails canonical sha512 SRI validation per ADR-0014 §4.F1. The
 * `prefix` becomes `<prefix>_INVALID_INTEGRITY` (per-adapter code retained
 * for debugging; subjects vary по nodeId shape across adapters так
 * `subject` is the bare string). Shape fixed: single canonical message
 * across npm-2/3, pnpm-v5/v6/v9 (v5 via _pnpm-flat-core.tarballPayloadOf
 * shared helper), bun-text, yarn-classic. yarn-berry threads
 * the source encoding token (`sri` / `legacy-base64-sha1` / …) in its
 * message instead and keeps its bespoke emit at parse time.
 */
export function invalidIntegrityDiagnostic(
  prefix:        string,
  subject:       NodeId,
  rawIntegrity:  string,
): Diagnostic {
  return {
    code:     `${prefix}_INVALID_INTEGRITY`,
    severity: 'warning',
    subject,
    message:  `integrity ${JSON.stringify(rawIntegrity)} is not a canonical sha512 SRI; dropping`,
  }
}

/**
 * Emit `RECIPE_FEATURE_DROPPED` (warning) per ADR-0014 §5 — the canonical
 * loss diagnostic when a target adapter cannot represent a recipe-owned
 * feature on emit. Feature tag follows ADR-0014 §4 table: `patch` (F2);
 * `git` / `directory` / `workspace` / `unknown` (F3 — bun-text drops git
 * + directory + unknown; npm-1 drops workspace). Subject is the affected
 * node id.
 */
export function emitDropped(
  nodeId: NodeId,
  feature: 'patch' | 'git' | 'directory' | 'workspace' | 'unknown',
  reason: string,
  onDiagnostic?: (d: Diagnostic) => void,
): void {
  if (onDiagnostic === undefined) return
  onDiagnostic({
    code:     'RECIPE_FEATURE_DROPPED',
    severity: 'warning',
    subject:  nodeId,
    message:  `${feature} dropped on emit: ${reason}`,
  })
}

/**
 * Emit `RECIPE_RESOLUTION_UNKNOWN` (warning) per ADR-0014 §5 once per
 * distinct `{ type: 'unknown', raw }` value. Adapter call sites pass
 * `nodeId` for the subject; callers are responsible for de-duplication
 * across nodes (the helper does not maintain state). Lives in
 * `recipe/diagnostics.ts` (not `recipe/resolution.ts`) per the F1/F2
 * split convention — recipe primitives stay pure-math, diagnostics live
 * here.
 */
/**
 * Pure factory for the canonical `RECIPE_RESOLUTION_UNKNOWN` diagnostic
 * object. Use this directly when pushing к an adapter-side
 * `Diagnostic[]` buffer; use `emitUnknownResolution()` для the
 * callback-style consumer surface.
 */
export function unknownResolutionDiagnostic(
  nodeId: NodeId,
  raw: string,
): Diagnostic {
  return {
    code:     'RECIPE_RESOLUTION_UNKNOWN',
    severity: 'warning',
    subject:  nodeId,
    message:  `resolution shape not canonicalisable: ${JSON.stringify(raw)}`,
  }
}

export function emitUnknownResolution(
  nodeId: NodeId,
  raw: string,
  onDiagnostic?: (d: Diagnostic) => void,
): void {
  if (onDiagnostic === undefined) return
  onDiagnostic(unknownResolutionDiagnostic(nodeId, raw))
}

// === F4 workspace specifier diagnostics =====================================
//
// `RECIPE_WORKSPACE_RESOLVED` (info, per ADR-0014 §5) — once per edge
// when the target lacks a workspace protocol entirely. The source-side
// `specifier` is dropped on emit; `resolvedVersion` is written into the
// dep range. Lossy version substitution (yarn-classic / npm-2 / npm-3
// emit).
export function workspaceResolvedDiagnostic(
  edge:           EdgeTriple,
  fromSpecifier:  string,
  toVersion:      string,
): Diagnostic {
  const from = fromSpecifier === '' ? '(empty)' : JSON.stringify(fromSpecifier)
  return {
    code:     'RECIPE_WORKSPACE_RESOLVED',
    severity: 'info',
    subject:  edge,
    message:  `workspace specifier ${from} dropped on emit; resolved to ${JSON.stringify(toVersion)}`,
  }
}

export function emitWorkspaceResolved(
  edge:           EdgeTriple,
  fromSpecifier:  string,
  toVersion:      string,
  onDiagnostic?:  (d: Diagnostic) => void,
): void {
  if (onDiagnostic === undefined) return
  onDiagnostic(workspaceResolvedDiagnostic(edge, fromSpecifier, toVersion))
}

// `RECIPE_WORKSPACE_COLLAPSED` (info) — once per edge when the target
// supports only the coarser `workspace:*` shape. Source-side specifier
// is collapsed to the default protocol form; no version substitution
// (lossy shape collapse; bun-text emit).
export function workspaceCollapsedDiagnostic(
  edge:           EdgeTriple,
  fromSpecifier:  string,
): Diagnostic {
  return {
    code:     'RECIPE_WORKSPACE_COLLAPSED',
    severity: 'info',
    subject:  edge,
    message:  `workspace specifier ${JSON.stringify(fromSpecifier)} collapsed to "workspace:*" on emit`,
  }
}

export function emitWorkspaceCollapsed(
  edge:           EdgeTriple,
  fromSpecifier:  string,
  onDiagnostic?:  (d: Diagnostic) => void,
): void {
  if (onDiagnostic === undefined) return
  onDiagnostic(workspaceCollapsedDiagnostic(edge, fromSpecifier))
}

// `RECIPE_WORKSPACE_UNRESOLVED` (warning) — once per edge when the
// F4 `resolvedVersion` half is `undefined` (manifests not supplied)
// but the target format requires a concrete version.
export function workspaceUnresolvedDiagnostic(
  edge:           EdgeTriple,
): Diagnostic {
  return {
    code:     'RECIPE_WORKSPACE_UNRESOLVED',
    severity: 'warning',
    subject:  edge,
    message:  `workspace edge has no resolvedVersion; target format requires a concrete version`,
  }
}

export function emitWorkspaceUnresolved(
  edge:           EdgeTriple,
  onDiagnostic?:  (d: Diagnostic) => void,
): void {
  if (onDiagnostic === undefined) return
  onDiagnostic(workspaceUnresolvedDiagnostic(edge))
}

// === F5 patch byte normalisation diagnostics ================================
//
// `RECIPE_PATCH_NORMALISED` (info, per ADR-0014 §5) — once per affected
// node when the F5 byte normalisation altered at least one byte of the
// patch input (CRLF → LF rewrite or leading BOM stripped). When source
// bytes pass through unchanged the diagnostic does not fire; this is
// observability for editor / `core.autocrlf` rewrites, not a noise floor.
export function patchNormalisedDiagnostic(nodeId: NodeId): Diagnostic {
  return {
    code:     'RECIPE_PATCH_NORMALISED',
    severity: 'info',
    subject:  nodeId,
    message:  `patch bytes normalised before fingerprint (CRLF → LF / BOM stripped)`,
  }
}

export function emitPatchNormalised(
  nodeId: NodeId,
  onDiagnostic?: (d: Diagnostic) => void,
): void {
  if (onDiagnostic === undefined) return
  onDiagnostic(patchNormalisedDiagnostic(nodeId))
}

// === F6 manifest override capture diagnostics ==============================
//
// `RECIPE_OVERRIDE_NORMALISED` (info, per ADR-0025 §6) — emitted once per
// successful `captureOverrides` call when a manifest's PM-native override
// block is normalised into the canonical `OverrideConstraint[]` form. Carries
// the source PM and the canonical entry count for observability. This is the
// CAPTURE-side info diagnostic; the projection-side loss codes
// (`OVERRIDE_PARENT_REF_DROPPED` / `OVERRIDE_GLOB_NARROWED` /
// `OVERRIDE_TRANSITIVE_HINT_DROPPED`) fire at stringify, not here. Subjectless
// — a manifest override block is not a NodeId or an edge.
export function recipeOverrideNormalised(
  pm: 'npm' | 'yarn' | 'pnpm',
  count: number,
): Diagnostic {
  return {
    code:     'RECIPE_OVERRIDE_NORMALISED',
    severity: 'info',
    message:  `captured ${count} ${pm} override${count === 1 ? '' : 's'} into canonical form`,
  }
}

export function emitOverrideNormalised(
  pm: 'npm' | 'yarn' | 'pnpm',
  count: number,
  onDiagnostic?: (d: Diagnostic) => void,
): void {
  if (onDiagnostic === undefined) return
  onDiagnostic(recipeOverrideNormalised(pm, count))
}

// Projection-side override loss diagnostics (ADR-0025 §6). Fire when
// `projectOverrides` lowers a canonical constraint to a target PM whose grammar
// cannot express it faithfully.

// `OVERRIDE_PARENT_REF_DROPPED` (warning) — an npm `$name` self-ref is projected
// to yarn/pnpm, which have no parent-version back-reference; the `$`-target is
// emitted verbatim and will not resolve in the target PM.
export function overrideParentRefDropped(pkg: string, to: string): Diagnostic {
  return {
    code:     'OVERRIDE_PARENT_REF_DROPPED',
    severity: 'warning',
    message:  `override ${pkg}=${to}: npm $name self-ref has no yarn/pnpm equivalent; emitted verbatim`,
  }
}

// `INTEROP_OVERRIDE_NOT_PROJECTED` (warning) — caller-supplied overrides were
// passed to a stringify target whose lockfile carries no overrides block
// (yarn-berry: forced resolutions live only in the manifest, never the lock).
export function interopOverrideNotProjected(pm: 'yarn', count: number): Diagnostic {
  return {
    code:     'INTEROP_OVERRIDE_NOT_PROJECTED',
    severity: 'warning',
    message:  `${count} override${count === 1 ? '' : 's'} not projected: ${pm} lockfiles carry no overrides block (declare in package.json resolutions)`,
  }
}

/**
 * Iterate every `Node.patch !== undefined` on `graph` and fire
 * `RECIPE_FEATURE_DROPPED (feature='patch')` once per affected node.
 * The universal patch-incapable-adapter helper — replaces per-adapter
 * `warnPatchDrop` family across yarn-classic / npm / pnpm-v5 / bun-text.
 */
export function dropAllPatchSlots(
  graph: Graph,
  onDiagnostic?: (d: Diagnostic) => void,
  reason = 'target adapter cannot represent patch slot',
): void {
  if (onDiagnostic === undefined) return
  const seen = new Set<NodeId>()
  for (const node of graph.nodes()) {
    if (node.patch === undefined || seen.has(node.id)) continue
    seen.add(node.id)
    emitDropped(node.id, 'patch', reason, onDiagnostic)
  }
}
