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
 * F1 integrity parse-side diagnostic factory — emitted when present integrity
 * input yields NO parseable hash (ADR-0031). Every recognised algorithm is now
 * preserved verbatim (sha1, sha256, sha384, sha512, and each member of a
 * multi-hash SRI), so this fires only for genuinely malformed input: a body
 * that is not an SRI member of a known shape, nor a valid yarn-berry checksum.
 * The `prefix` becomes `<prefix>_INVALID_INTEGRITY` (per-adapter code retained
 * for debugging; `subject` is the bare nodeId string). Shape fixed across
 * npm-2/3, pnpm-v5/v6/v9, bun-text, yarn-classic; yarn-berry keeps its bespoke
 * emit at parse time.
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
    message:  `integrity ${JSON.stringify(rawIntegrity)} has no parseable hash; dropping`,
  }
}

/**
 * Emit `RECIPE_INTEGRITY_INCOMPLETE` (warning, ADR-0031 §Decision.3) — fired on
 * emit when the source carries integrity but the target format cannot represent
 * any of its origin classes, so the field is OMITTED rather than fabricated.
 * The canonical case crosses the tarball/zip boundary: npm/pnpm/bun/yarn-classic
 * → yarn-berry (a tarball sha512 is not a berry zip-cache checksum) or
 * yarn-berry → an SRI field (a `berry-zip` digest is not an SRI). The target PM
 * re-computes the digest on install; the deferred Phase-2 fetch fills it offline.
 */
export function recipeIntegrityIncomplete(
  nodeId: NodeId,
  target: string,
  reason: string,
): Diagnostic {
  return {
    code:     'RECIPE_INTEGRITY_INCOMPLETE',
    severity: 'warning',
    subject:  nodeId,
    message:  `integrity omitted on ${target} emit: ${reason}`,
  }
}

export function emitIntegrityIncomplete(
  nodeId:        NodeId,
  target:        string,
  reason:        string,
  onDiagnostic?: (d: Diagnostic) => void,
): void {
  if (onDiagnostic === undefined) return
  onDiagnostic(recipeIntegrityIncomplete(nodeId, target, reason))
}

/**
 * Emit `RECIPE_PEER_META_INCOMPLETE` (warning, task #86) — fired during the
 * yarn-berry enrich pass when a `peer` edge carries no `optional` signal and
 * the fill ladder (graph → local node_modules manifest → opt-in cache/registry)
 * cannot determine whether the parent declared that peer as optional. The
 * `peerDependenciesMeta.<peer>.optional` marker is therefore OMITTED rather than
 * fabricated. This shares `RECIPE_INTEGRITY_INCOMPLETE`'s omit-not-guess
 * posture but differs in firing condition: integrity warns whenever a held
 * fact cannot be represented, whereas this fires ONLY when an external rung
 * was requested yet could not answer (pure rung-1 mode stays silent — the
 * graph is the sole authority).
 * yarn re-derives `peerDependenciesMeta` from each package's own manifest at
 * install, so omission is a safe degrade. `subject` is the bare consumer
 * (parent) node id whose peer-optional status could not be reconstructed.
 */
export function recipePeerMetaIncomplete(
  nodeId: NodeId,
  peerName: string,
  reason: string,
): Diagnostic {
  return {
    code:     'RECIPE_PEER_META_INCOMPLETE',
    severity: 'warning',
    subject:  nodeId,
    message:  `peerDependenciesMeta.optional for peer ${JSON.stringify(peerName)} unreconstructable: ${reason}`,
  }
}

export function emitPeerMetaIncomplete(
  nodeId:        NodeId,
  peerName:      string,
  reason:        string,
  onDiagnostic?: (d: Diagnostic) => void,
): void {
  if (onDiagnostic === undefined) return
  onDiagnostic(recipePeerMetaIncomplete(nodeId, peerName, reason))
}

// === Descriptor→node resolution diagnostics (Bug #99) =======================
//
// The yarn-family descriptor→node ladder (spec/formats/_common.md
// §"Descriptor→node resolution") layers source-safe fallback rungs over the
// exact entry-key match. Two diagnostics surface its limits, both per-adapter-
// prefixed (e.g. `YARN_BERRY`, `YARN_CLASSIC`) like the peer-ambiguity family.

/**
 * `<prefix>_AMBIGUOUS_RESOLUTION` (warning) — Rung 3 (max-satisfying semver)
 * found ≥2 candidates tied at the maximum satisfying version with NO way to
 * choose. Mirrors the `<prefix>_PEER_AMBIGUOUS` posture: do NOT guess — drop the
 * edge and report the tied candidate ids. `subject` is the consumer node id.
 */
export function ambiguousResolutionDiagnostic(
  prefix:       string,
  subject:      NodeId,
  depName:      string,
  range:        string,
  candidateIds: readonly NodeId[],
): Diagnostic {
  return {
    code:     `${prefix}_AMBIGUOUS_RESOLUTION`,
    severity: 'warning',
    subject,
    message:  `dependency ${depName}=${range} from ${subject} matches multiple max-satisfying entries: [${candidateIds.join(', ')}]; dropping (no way to choose)`,
  }
}

/**
 * `<prefix>_RESOLUTION_PIN_UNRESOLVED` (info) — a yarn descriptor missed the
 * exact entry-key AND no semver candidate satisfied its range, which is the
 * SIGNATURE of a `resolutions` pin that rewrote the entry key to a NON-satisfying
 * descriptor (csstype `^3.1.3` → `3.0.9`). yarn writes no lock-borne
 * resolutions, so the override map needed to bridge this exists only when the
 * caller passed `ParseOptions.manifests`. This fires only in the manifest-LESS
 * path to point at the missing input; with manifests the override rung resolves
 * it silently. `subject` is the consumer node id.
 */
export function resolutionPinUnresolvedDiagnostic(
  prefix:  string,
  subject: NodeId,
  depName: string,
  range:   string,
): Diagnostic {
  return {
    code:     `${prefix}_RESOLUTION_PIN_UNRESOLVED`,
    severity: 'info',
    subject,
    message:  `dependency ${depName}=${range} from ${subject} has no exact or semver-satisfying entry — likely a resolutions pin to a non-satisfying descriptor; pass ParseOptions.manifests so the override map can bridge it`,
  }
}

/**
 * `<prefix>_PATCH_PREFERRED` (info, Bug #104, yarn-berry only) — a consumer's
 * REGISTRY range bound a base node, but the lock carries a sibling `patch:` copy
 * of that same `name@version`, so the edge was REDIRECTED to the patched node
 * (yarn's lock-borne `patchedDependencies` behaviour: a patch applies to every
 * consumer of the base). Fired only when the redirect happened WITHOUT an
 * override having forced it — so the purely lock-derived heuristic is
 * observable. With `manifests`, the override rung performs the redirect itself
 * and this does NOT fire (no double-redirect). `subject` is the consumer node id;
 * `patchId` is the patch node the edge now points at. The base node is left
 * GC-able (the patch re-emits from its own locator; `optimize()` prunes the
 * orphaned base) — this is intentional, matching yarn.
 */
export function patchPreferredDiagnostic(
  prefix:  string,
  subject: NodeId,
  depName: string,
  range:   string,
  patchId: NodeId,
): Diagnostic {
  return {
    code:     `${prefix}_PATCH_PREFERRED`,
    severity: 'info',
    subject,
    message:  `dependency ${depName}=${range} from ${subject} redirected to sibling patch node ${patchId} (lock-borne patchedDependencies preference); base left GC-able`,
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
 * Pure factory for the canonical `RECIPE_RESOLUTION_UNKNOWN` (warning,
 * ADR-0014 §5) diagnostic object — one per distinct `{ type: 'unknown', raw }`
 * value. Use this directly when pushing to an adapter-side `Diagnostic[]`
 * buffer; use `emitUnknownResolution()` for the callback-style consumer surface.
 * Callers own de-duplication across nodes (the helper keeps no state). Lives in
 * `recipe/diagnostics.ts` (not `recipe/resolution.ts`) per the F1/F2 split
 * convention — recipe primitives stay pure-math, diagnostics live here.
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

// `INTEROP_OVERRIDE_NOT_PROJECTED` (warning) — caller-supplied (or captured)
// overrides were passed to a stringify target whose lockfile carries no
// AUTHORITATIVE overrides declaration. npm and yarn read the policy from the
// root manifest, never the lock (yarn-berry forced resolutions and npm
// `overrides` live only in package.json). The declaration must ride a companion
// manifest patch (the project-level conversion API), not the lock — so we
// surface the drop rather than synthesize a field the manager ignores.
export function interopOverrideNotProjected(pm: 'yarn' | 'npm', count: number): Diagnostic {
  const manifestKey = pm === 'npm' ? 'overrides' : 'resolutions'
  return {
    code:     'INTEROP_OVERRIDE_NOT_PROJECTED',
    severity: 'warning',
    message:  `${count} override${count === 1 ? '' : 's'} not projected: ${pm} lockfiles carry no overrides block (declare in package.json ${manifestKey})`,
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
