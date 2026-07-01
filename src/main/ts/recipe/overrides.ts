// ADR-0025 §3 — manifest override capture (recipe feature F6, pure primitive).
//
// Each package manager ships a manifest-level dependency-override mechanism
// with its own grammar:
//
//   - npm   `overrides`        nested object; parent-path-scoped; `.` self-key;
//                              `$name` parent-version back-refs.
//   - yarn  `resolutions`      flat patterns: `pkg`, `parent/child`,
//                              `**/child` deep-glob, `pkg@range`.
//   - pnpm  `pnpm.overrides`   flat selectors: `foo`, `foo@2`, `a>b>c` chains,
//                              leading-`>foo` transitive-only.
//
// `captureOverrides` normalises a PM-native override block into BOTH the
// canonical PM-neutral `OverrideConstraint[]` (load-bearing per ADR-0013) and
// the verbatim `Manifest.native.*` block (attribution, for lossless same-PM
// round-trip). The canonical superset is modelled on npm's nested form — the
// only one that expresses parent-scoping — so pnpm `>`-chains and yarn flat
// patterns derive from it (ADR-0025 §2).
//
// This module is pure: no Graph traversal, no I/O. The single diagnostic it
// surfaces (`RECIPE_OVERRIDE_NORMALISED`, info) is built by the factory in
// `recipe/diagnostics.ts` and pushed through the optional `onDiagnostic`
// callback — matching the F1/F2/F4/F5 split convention (primitive stays math,
// diagnostics live next door). The projection-time loss codes
// (`OVERRIDE_PARENT_REF_DROPPED` / `OVERRIDE_GLOB_NARROWED` /
// `OVERRIDE_TRANSITIVE_HINT_DROPPED`) fire at stringify (Phase-1c), NOT here.

import type { Diagnostic, Manifest, OverrideConstraint, OverridePM } from '../graph.ts'
import {
  interopOverrideNotProjected,
  overrideParentRefDropped,
  recipeOverrideNormalised,
} from './diagnostics.ts'

export type { OverridePM } from '../graph.ts'

export interface CapturedOverrides {
  canonical: OverrideConstraint[]
  native:    NonNullable<Manifest['native']>
}

/**
 * Split a PM selector segment into its package name and an optional trailing
 * `@version` condition. The split uses the LAST `@` at depth 0 with index
 * `>= 1`, so a scoped name keeps its leading `@scope/` and only a genuine
 * `pkg@range` (or `@scope/pkg@range`) tail is peeled — the same idiom the
 * format adapters use for `<name>@<version>` keys (ADR-0006).
 *
 * Examples:
 *   `foo`               → { package: 'foo' }
 *   `foo@2`             → { package: 'foo', versionCondition: '2' }
 *   `@scope/pkg`        → { package: '@scope/pkg' }
 *   `@scope/pkg@^1`     → { package: '@scope/pkg', versionCondition: '^1' }
 *   `pkg@npm:^14.4.0`   → { package: 'pkg', versionCondition: 'npm:^14.4.0' }
 *
 * Override selectors carry no `(...)` peer suffix, but the depth guard is kept
 * for parity with the shared idiom and to stay robust to stray parentheses.
 */
export function splitNameVersion(selector: string): {
  package: string
  versionCondition?: string
} {
  let depth  = 0
  let lastAt = -1
  for (let i = 0; i < selector.length; i++) {
    const c = selector[i]
    if (c === '(') depth++
    else if (c === ')') depth--
    else if (c === '@' && depth === 0 && i >= 1) lastAt = i
  }
  if (lastAt <= 0) return { package: selector }
  const name    = selector.slice(0, lastAt)
  const version = selector.slice(lastAt + 1)
  if (name.length === 0 || version.length === 0) return { package: selector }
  return { package: name, versionCondition: version }
}

/**
 * Parse a PM-native override block into canonical + verbatim native form
 * (ADR-0025 §3). Pure function. Emits `RECIPE_OVERRIDE_NORMALISED` (info)
 * once per successful capture (ADR-0025 §6). A `block` that is null/undefined
 * or not an object yields no canonical entries and no native payload (nothing
 * to attribute); the diagnostic is still emitted once for an empty-but-present
 * object so callers can observe "an overrides key existed and was processed".
 */
export function captureOverrides(
  block: unknown,
  pm: OverridePM,
  onDiagnostic?: (d: Diagnostic) => void,
): CapturedOverrides {
  if (block === null || typeof block !== 'object') {
    return { canonical: [], native: {} }
  }

  let canonical: OverrideConstraint[]
  const native: NonNullable<Manifest['native']> = {}

  switch (pm) {
    case 'npm': {
      // npm carries the raw block verbatim (the type is `unknown`).
      native.npmOverrides = block
      canonical = captureNpm(block as Record<string, unknown>, [])
      break
    }
    case 'yarn': {
      const flat = asStringRecord(block)
      native.yarnResolutions = flat
      canonical = captureFlat(flat, splitYarnKey)
      break
    }
    case 'pnpm': {
      const flat = asStringRecord(block)
      native.pnpmOverrides = flat
      canonical = captureFlat(flat, splitPnpmKey)
      break
    }
  }

  // Stamp PM origin + declaration order for a PM-faithful tie-break (npm
  // first-match needs declaration order, which mergeOverrides' key-sort loses).
  // NON-ENUMERABLE: pure tie-break metadata, invisible to toEqual / JSON /
  // overrideKey, so constraints stay "compare-clean" (same intent as the
  // constraint() factory omitting empty optionals).
  canonical.forEach((c, i) => {
    Object.defineProperty(c, 'origin', { value: pm, enumerable: false, configurable: true, writable: true })
    Object.defineProperty(c, 'captureIndex', { value: i, enumerable: false, configurable: true, writable: true })
  })

  onDiagnostic?.(recipeOverrideNormalised(pm, canonical.length))
  return { canonical, native }
}

// === npm — nested object ====================================================
//
// `{ "foo": "1.0.0" }`                       → global override of foo
// `{ "parent": { "foo": "1.0.0" } }`         → foo under parentPath ['parent']
// `{ "foo": { ".": "1.0.0", "bar": "2" } }`  → foo (the `.` self-key) +
//                                              bar under parentPath ['foo']
// `{ "foo": "$baz" }`                        → to '$baz', selfRef: true
// A `pkg@version` parent key (`{ "kerberos@2.1.1": { … } }`) is a version-
// qualified scope: the path segment keeps the BARE package name (the `@version`
// qualifier survives verbatim in `native.npmOverrides`; the canonical
// `parentPath` is a chain of names per the type). Nested parents recurse,
// extending `parentPath`.
function captureNpm(
  block: Record<string, unknown>,
  parentPath: string[],
): OverrideConstraint[] {
  const out: OverrideConstraint[] = []
  for (const [key, value] of Object.entries(block)) {
    if (key === '.') {
      // Self-key: overrides the nearest enclosing parent (the tail of the
      // chain). Only meaningful inside a nested object; at the root it has no
      // parent and is skipped.
      if (parentPath.length === 0) continue
      const pkg = parentPath[parentPath.length - 1]!
      const ancestors = parentPath.slice(0, -1)
      if (typeof value === 'string') out.push(constraint(pkg, ancestors, value))
      continue
    }
    const { package: pkg } = splitNameVersion(key)
    if (typeof value === 'string') {
      out.push(constraint(pkg, parentPath, value))
    } else if (value !== null && typeof value === 'object') {
      // Nested scope: descend with `pkg` appended to the parent chain.
      out.push(...captureNpm(value as Record<string, unknown>, [...parentPath, pkg]))
    }
    // Other value shapes (number/boolean/null) are not valid npm override
    // targets — skipped (no canonical entry, but preserved in native verbatim).
  }
  return out
}

// === yarn / pnpm — flat selector records ====================================

function captureFlat(
  flat: Record<string, string>,
  splitKey: (key: string) => { package: string; parentPath: string[]; versionCondition?: string },
): OverrideConstraint[] {
  const out: OverrideConstraint[] = []
  for (const [key, to] of Object.entries(flat)) {
    const { package: pkg, parentPath, versionCondition } = splitKey(key)
    out.push(constraint(pkg, parentPath, to, versionCondition))
  }
  return out
}

// yarn `resolutions` key grammar (slash-separated path; last segment is the
// overridden package and may carry an `@range` version condition):
//
//   `foo`            → { foo }
//   `parent/foo`     → { foo, parentPath: ['parent'] }
//   `**/foo`         → { foo }                       (deep-glob — see below)
//   `foo@^1`         → { foo, versionCondition: '^1' }
//   `parent/foo@^1`  → { foo, parentPath: ['parent'], versionCondition: '^1' }
//
// `**` is yarn's unbounded-depth glob — an irreducible tail (ADR-0025 §2). We
// capture the overridden package and record NO parentPath for any-depth `**`
// segments (a `**` ancestor is "any depth", which `parentPath` — an exact
// chain — cannot express). The loss is reported at PROJECTION time, not here.
// Scoped names keep their leading `@`: a `/` inside `@scope/pkg` is the scope
// separator, not a path separator, so we re-group `@scope` with its following
// `pkg[@range]` piece before taking the package/parent boundary.
function splitYarnKey(key: string): {
  package: string
  parentPath: string[]
  versionCondition?: string
} {
  const segments = splitYarnPathSegments(key)
  const leaf = segments[segments.length - 1]!
  const { package: pkg, versionCondition } = splitNameVersion(leaf)
  // Ancestor segments: drop any-depth `**` globs (irreducible — recorded as a
  // loss at projection, not encodable as an exact parentPath segment).
  const parentPath = segments.slice(0, -1).filter(s => s !== '**')
  return versionCondition !== undefined
    ? { package: pkg, parentPath, versionCondition }
    : { package: pkg, parentPath }
}

// Split a yarn resolutions key on `/`, keeping scoped `@scope/pkg` segments
// intact. A `@`-led piece consumes its very next `/`-delimited piece as the
// scope tail (`@scope` + `pkg` → `@scope/pkg`).
function splitYarnPathSegments(key: string): string[] {
  const raw = key.split('/')
  const segments: string[] = []
  for (let i = 0; i < raw.length; i++) {
    const piece = raw[i]!
    if (piece.startsWith('@') && i + 1 < raw.length) {
      segments.push(`${piece}/${raw[i + 1]}`)
      i++
    } else {
      segments.push(piece)
    }
  }
  return segments
}

// pnpm `pnpm.overrides` key grammar (`>`-separated ancestor chain; last
// segment is the overridden package; any segment may carry an `@version`):
//
//   `foo`         → { foo }
//   `foo@2`       → { foo, versionCondition: '2' }
//   `a>b`         → { b, parentPath: ['a'] }
//   `a>b>c`       → { c, parentPath: ['a', 'b'] }
//   `>foo`        → { foo }                  (leading-`>` transitive-only)
//   `express@4>path-to-regexp`
//                 → { path-to-regexp, parentPath: ['express'] }
//
// Leading-`>` ("transitive-only") is an irreducible tail (ADR-0025 §2): the
// empty leading segment is dropped here; the lost transitive-only intent is
// reported at projection. Ancestor segments keep only their BARE package name
// (a `parent@version` qualifier survives in `native.pnpmOverrides`; the
// canonical `parentPath` is a chain of names per the type). The leaf's own
// `@version` becomes the canonical `versionCondition`.
function splitPnpmKey(key: string): {
  package: string
  parentPath: string[]
  versionCondition?: string
} {
  const segments = key.split('>').filter(s => s.length > 0)
  const leaf = segments[segments.length - 1]!
  const { package: pkg, versionCondition } = splitNameVersion(leaf)
  const parentPath = segments.slice(0, -1).map(s => splitNameVersion(s).package)
  return versionCondition !== undefined
    ? { package: pkg, parentPath, versionCondition }
    : { package: pkg, parentPath }
}

// === shared constructors ====================================================

// Build one OverrideConstraint, omitting empty optional slots so the canonical
// objects compare cleanly (no `parentPath: []` noise) and an npm `$name`
// target is flagged `selfRef: true` (ADR-0025 §2 — the npm-only tail).
function constraint(
  pkg: string,
  parentPath: string[],
  to: string,
  versionCondition?: string,
): OverrideConstraint {
  const c: OverrideConstraint = { package: pkg, to }
  if (parentPath.length > 0) c.parentPath = parentPath
  if (versionCondition !== undefined && versionCondition !== '') {
    c.versionCondition = versionCondition
  }
  if (to.startsWith('$')) c.selfRef = true
  return c
}

// Coerce an arbitrary object to a `Record<string, string>`, keeping only
// string-valued entries (yarn/pnpm override targets are always strings). The
// verbatim `native.*` slot stores this coerced view; non-string values are
// dropped (they are not valid flat override targets).
function asStringRecord(block: object): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(block)) {
    if (typeof v === 'string') out[k] = v
  }
  return out
}

// === projection (canonical → PM-native) =====================================

/**
 * Project canonical override constraints into a target PM's native override
 * block (ADR-0025 §4) — the inverse of `captureOverrides`. npm returns a nested
 * object; pnpm a flat `Record` keyed by `>`-separated ancestor selectors. The
 * adapter writes the block into its lockfile (npm `packages[""].overrides` /
 * pnpm top-level `overrides:`). yarn has no lockfile overrides target — callers
 * use `noteYarnOverridesNotProjected` instead.
 *
 * Loss: an npm `$name` self-ref lowered to pnpm emits OVERRIDE_PARENT_REF_DROPPED.
 * The yarn deep-glob and pnpm leading-`>` transitive-only tails lose their
 * distinguishing info at *capture* (the canonical carries no origin marker), so
 * they project as plain global/scoped constraints; faithfully surfacing
 * OVERRIDE_GLOB_NARROWED / OVERRIDE_TRANSITIVE_HINT_DROPPED needs an `origin?`
 * field on OverrideConstraint — a tracked follow-up, not this slice.
 */
export function projectOverrides(
  canonical: readonly OverrideConstraint[],
  pm: 'npm' | 'pnpm',
  onDiagnostic?: (d: Diagnostic) => void,
): Record<string, unknown> {
  return pm === 'npm' ? projectNpm(canonical) : projectPnpm(canonical, onDiagnostic)
}

/** yarn-berry carries no lockfile overrides block; signal the non-projection. */
export function noteYarnOverridesNotProjected(
  count: number,
  onDiagnostic?: (d: Diagnostic) => void,
): void {
  if (count > 0 && onDiagnostic !== undefined) {
    onDiagnostic(interopOverrideNotProjected('yarn', count))
  }
}

function projectNpm(canonical: readonly OverrideConstraint[]): Record<string, unknown> {
  const root: Record<string, unknown> = {}
  for (const c of canonical) {
    const leafKey = c.versionCondition ? `${c.package}@${c.versionCondition}` : c.package
    let node = root
    for (const seg of c.parentPath ?? []) {
      const existing = node[seg]
      if (typeof existing === 'object' && existing !== null) {
        node = existing as Record<string, unknown>
      } else {
        // A scalar override already at `seg` becomes `{'.': scalar}` so we can
        // nest a child under it (npm's self-key convention).
        const nested: Record<string, unknown> = typeof existing === 'string' ? { '.': existing } : {}
        node[seg] = nested
        node = nested
      }
    }
    const existingLeaf = node[leafKey]
    if (existingLeaf !== null && typeof existingLeaf === 'object') {
      // A nested scope already lives at this leaf (a deeper override was
      // projected first — order-dependent). The scalar is the leaf's OWN forced
      // version → npm's `.` self-key, NOT an overwrite that would silently drop
      // the nested children. Symmetric to the scalar-then-object rescue above;
      // together they make projection order-independent.
      ;(existingLeaf as Record<string, unknown>)['.'] = c.to
    } else {
      node[leafKey] = c.to // npm understands `$name` self-refs verbatim
    }
  }
  return root
}

function projectPnpm(
  canonical: readonly OverrideConstraint[],
  onDiagnostic?: (d: Diagnostic) => void,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const c of canonical) {
    const leaf = c.versionCondition ? `${c.package}@${c.versionCondition}` : c.package
    const key = c.parentPath && c.parentPath.length > 0
      ? `${c.parentPath.join('>')}>${leaf}`
      : leaf
    if (c.selfRef && onDiagnostic !== undefined) {
      onDiagnostic(overrideParentRefDropped(c.package, c.to))
    }
    out[key] = c.to
  }
  return out
}
