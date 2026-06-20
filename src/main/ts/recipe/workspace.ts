// ADR-0014 §4.F4 — workspace specifier canonical recipe (pure-math primitive).
//
// Canonical form: a `{ specifier, resolvedVersion? }` pair held on
// `Edge.attrs.workspaceRange` alongside the existing
// `Edge.attrs.workspace: boolean` marker (ADR-0017). The pair captures
// **both** halves needed for cross-format conversion:
//
//   - `specifier`        — verbatim PM-side range string (`workspace:^`,
//                          `workspace:~`, `workspace:*`,
//                          `workspace:<exact>`, or the empty string `''`
//                          for parse-time pending state on adapters
//                          lacking a workspace protocol).
//   - `resolvedVersion`  — concrete version of the target workspace
//                          member, populated at enrich-time when
//                          manifests are available; may be `undefined`
//                          in naïve / no-manifest mode.
//
// Empty `specifier` is the **pending sentinel** distinct from
// `undefined`: it signals that the source adapter never carried a
// specifier on disk (npm-2/3 reconstruct workspace edges from
// `node_modules/<name>: {link:true, resolved:<wsPath>}` link entries,
// which never carry a range expression).
//
// Stringify-time is the closure point:
//   - target adapters WITH a workspace protocol re-emit `specifier`
//     verbatim (synthesise `workspace:*` default when `specifier === ''`).
//   - target adapters WITHOUT a workspace protocol drop the specifier
//     and substitute `resolvedVersion` into the dep range, firing
//     `RECIPE_WORKSPACE_RESOLVED` (info); when `resolvedVersion` is
//     `undefined` they fire `RECIPE_WORKSPACE_UNRESOLVED` (warning).
//   - target adapters supporting only the coarser `workspace:*` shape
//     (bun-text) collapse richer specifiers to `workspace:*` and fire
//     `RECIPE_WORKSPACE_COLLAPSED` (info).
//
// This module is pure-math: no Diagnostic imports, no Graph traversal.
// The diagnostic factories live in `recipe/diagnostics.ts` per the
// F1/F2/F3 split convention.

// === Canonical type =========================================================

export type WorkspaceRange = {
  specifier:        string
  resolvedVersion?: string
}

// === Predicates =============================================================

/** Range string carries the `workspace:` protocol prefix. */
export function isWorkspaceSpecifier(s: string): boolean {
  return s.startsWith('workspace:')
}

/** Pending sentinel — adapter has no workspace protocol and no specifier on disk. */
export function isPendingSpecifier(s: string): boolean {
  return s === ''
}

/**
 * Wildcard / range-operator workspace specifier (`workspace:*`,
 * `workspace:^`, `workspace:~`) — no concrete version bound, just a
 * version-bumping policy hint. Adapters supporting only the coarser
 * `workspace:*` collapse all of these without information loss.
 */
export function isWorkspaceWildcard(s: string): boolean {
  if (!isWorkspaceSpecifier(s)) return false
  const inner = s.slice('workspace:'.length)
  return inner === '*' || inner === '^' || inner === '~'
}

/**
 * The specifier carries a concrete version constraint
 * (`workspace:1.2.3`, `workspace:^1.2.3`, `workspace:~1.2.3`,
 * `workspace:>=1`, etc.) beyond the bare wildcard set. Distinguishes
 * collapse-lossy (richer than `workspace:*`) from collapse-safe
 * (already `workspace:*`).
 */
export function isWorkspaceConcrete(s: string): boolean {
  if (!isWorkspaceSpecifier(s)) return false
  if (isWorkspaceWildcard(s)) return false
  return s.length > 'workspace:'.length
}

// === Parse ==================================================================

/**
 * Construct a canonical `WorkspaceRange` from a per-adapter raw range
 * string + optional resolved version. The primitive does NOT validate
 * the protocol shape — any string is accepted as `specifier`. Callers
 * pass the empty string `''` for adapters lacking a workspace protocol
 * (npm-2/3 link-form parse).
 */
export function parse(rawSpecifier: string, resolvedVersion?: string): WorkspaceRange {
  if (resolvedVersion === undefined) return { specifier: rawSpecifier }
  return { specifier: rawSpecifier, resolvedVersion }
}

/** Predicate guard for runtime type-narrowing. */
export function isCanonical(value: unknown): value is WorkspaceRange {
  if (value === null || typeof value !== 'object') return false
  const v = value as { specifier?: unknown; resolvedVersion?: unknown }
  if (typeof v.specifier !== 'string') return false
  if (v.resolvedVersion !== undefined && typeof v.resolvedVersion !== 'string') return false
  return true
}

// === Stringify ==============================================================

/**
 * Project canonical → target-format range string for adapters that
 * support the `workspace:` protocol verbatim (yarn-berry v4-v9, pnpm
 * v5/v6/v9).
 *
 * - When `specifier` is non-empty AND already `workspace:`-prefixed,
 *   re-emit verbatim.
 * - When `specifier === ''` (pending state from an npm-2/3 source),
 *   synthesise `workspace:*` as the default. No diagnostic — the empty
 *   specifier carried no preference to preserve.
 * - When `specifier` is non-empty but lacks the `workspace:` prefix
 *   (defensive — shouldn't happen on well-formed input), pass through
 *   verbatim.
 */
export function stringifyForWorkspaceProtocol(range: WorkspaceRange): string {
  if (range.specifier === '') return 'workspace:*'
  return range.specifier
}

/**
 * Project canonical → target-format range string for adapters that lack
 * a workspace protocol (yarn-classic, npm-1/2/3). Returns the concrete
 * `resolvedVersion` when defined; `undefined` when manifests have not
 * supplied it (caller fires `RECIPE_WORKSPACE_UNRESOLVED`).
 */
export function stringifyForVersionOnly(range: WorkspaceRange): string | undefined {
  return range.resolvedVersion
}

/**
 * Project canonical → target-format range string for bun-text, which
 * supports only the coarser `workspace:*` shape. Returns the verbatim
 * specifier when already `workspace:*` (or pending empty form mapped
 * to default), `workspace:*` otherwise (caller fires
 * `RECIPE_WORKSPACE_COLLAPSED` when the source carried a richer shape).
 */
export function stringifyForBunText(range: WorkspaceRange): string {
  if (range.specifier === '' || range.specifier === 'workspace:*') return 'workspace:*'
  return 'workspace:*'
}

/**
 * Predicate: would bun-text emit collapse the given specifier? True iff
 * the source specifier carries shape information beyond the coarse
 * `workspace:*` default. Used by the bun-text adapter at stringify time
 * to decide whether to fire `RECIPE_WORKSPACE_COLLAPSED`.
 */
export function bunTextWouldCollapse(specifier: string): boolean {
  if (specifier === '' || specifier === 'workspace:*') return false
  return isWorkspaceSpecifier(specifier)
}

/**
 * Centralised workspace-edge predicate per ADR-0014 §4.F4 — gate F4
 * helpers on the explicit edge marker, not destination shape. Adapter
 * parse / enrich is responsible for setting `attrs.workspace = true`
 * on every edge whose target is a workspace member; F4 stringify and
 * `workspaceRangeOfEdge` derive translation from that single source.
 */
export function isWorkspaceEdge(edge: {
  attrs?: { workspace?: boolean; range?: string; workspaceRange?: WorkspaceRange }
}): boolean {
  return edge.attrs?.workspace === true
}

/**
 * Gate predicate for `RECIPE_WORKSPACE_RESOLVED` emit per ADR-0014 §5:412
 * — "once per edge when source `specifier` is dropped on emit". An edge
 * whose source-side `specifier` was empty (pending sentinel from npm-2/3
 * link-form parse, or cross-format conversion landing pending state)
 * carried nothing to drop; emitting `RESOLVED` for it produces spurious
 * `(empty) → <version>` diagnostics. Adapters call this before invoking
 * `emitWorkspaceResolved`.
 */
export function shouldEmitWorkspaceResolved(range: WorkspaceRange | undefined): boolean {
  return range !== undefined && range.specifier !== ''
}

/**
 * Synthesise a canonical `WorkspaceRange` from an edge + destination
 * pair. Returns `undefined` when the edge is not a workspace edge
 * (`attrs.workspace !== true`). Adapters use this at stringify time
 * to derive the F4 canonical; the dedicated sidecar slot
 * `edge.attrs.workspaceRange` (populated by adapters at parse / enrich)
 * is the primary carrier.
 *
 * Resolution order:
 *   1. Honour explicit `edge.attrs.workspaceRange` if present (the
 *      canonical carrier).
 *   2. Synthesise from `edge.attrs.range` (verbatim source-side
 *      specifier) + `dst.version` (best-effort resolvedVersion). The
 *      empty string `''` is the pending sentinel when no source-side
 *      specifier exists. This fallback exists for compatibility with
 *      legacy / partially-wired call paths; new adapter wiring should
 *      populate the sidecar explicitly.
 */
export function workspaceRangeOfEdge(
  edge: { attrs?: { range?: string; workspace?: boolean; workspaceRange?: WorkspaceRange } },
  dst:  { workspacePath?: string; version?: string },
): WorkspaceRange | undefined {
  if (!isWorkspaceEdge(edge)) return undefined
  if (edge.attrs?.workspaceRange !== undefined) return edge.attrs.workspaceRange
  const specifier = edge.attrs?.range ?? ''
  const sourceLooksProtocol = isWorkspaceSpecifier(specifier)
  const canonicalSpecifier = sourceLooksProtocol ? specifier : ''
  if (dst.version === undefined || dst.version === '') return { specifier: canonicalSpecifier }
  return { specifier: canonicalSpecifier, resolvedVersion: dst.version }
}
