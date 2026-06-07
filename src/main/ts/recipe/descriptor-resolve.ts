// Descriptor→node resolution ladder primitives (Bug #99) — PURE math.
//
// The yarn family (classic + berry) records dependency RANGES on the consumer
// side and joins them to entries by EXACT entry-key string match. Under a
// `resolutions` (yarn) / `overrides` (npm) / `pnpm.overrides` pin, yarn rewrites
// the entry key to the PINNED descriptor and drops the consumer's own range —
// so a range consumer can no longer find its entry by exact match, the edge is
// dropped, the node orphaned, and the dependency vanishes on round-trip.
//
// These two helpers are the source-safe fallback rungs the adapters layer on
// top of the exact-match path (see the ladder doc in spec/formats/_common.md
// §"Descriptor→node resolution"). They are PURE: no Graph import, no IO, no
// Diagnostic emit. The adapter owns candidate gathering, the override source,
// and every diagnostic — these functions only do the math.
//
//   - `semverResolve` — Rung 3: SOURCE-GATED max-satisfying semver. Only an
//     `npm:`/bare descriptor may match, and only a `tarball` (registry-class)
//     candidate is eligible. A git / directory / unknown-source node is INVISIBLE
//     to an `npm:` descriptor (the #91 source-safety invariant: a git-fork node
//     must never satisfy a registry range). Final ties are NOT guessed — the
//     caller is told via `{ kind: 'ambiguous' }` and emits a `*_AMBIGUOUS_
//     RESOLUTION` warning, mirroring the existing peer-ambiguity rule.
//   - `overrideTargetFor` — Rung 2: OVERRIDE-MAP forced link. Resolves the
//     human-declared pin (`OverrideConstraint`) for `(depName, declaredRange,
//     consumerPath)`. Authoritative: it precedes semver and handles a
//     NON-satisfying pin (csstype `^3.1.3` → `3.0.9`) and a non-version target
//     (`patch:` / `portal:`). Returns only the verbatim `to`; the caller feeds it
//     back through the exact-match + Rung-1 path.

import semver from 'semver'
import type { ResolutionCanonical } from './resolution.ts'
import type { OverrideConstraint } from '../graph.ts'

// Source class of a candidate node, projected from `TarballPayload.resolution`
// (recipe/resolution.ts F3 taxonomy). `undefined` (no canonical resolution at
// all — e.g. a workspace node, or a node whose resolution never canonicalised)
// is treated as NON-registry and is INELIGIBLE for an `npm:` match: we cannot
// prove it is a registry tarball, and risk (d) says an unprovable source must
// not bind a registry range.
export type CandidateSourceType = ResolutionCanonical['type'] | 'absent'

export interface SemverCandidate {
  /** The resolved node id to bind to. */
  id: string
  /** The node's locked `version` (the semver point to test against the range). */
  version: string
  /** Source class — only `tarball` is eligible for an `npm:`/bare match. */
  sourceType: CandidateSourceType
}

export type SemverResolveResult =
  | { kind: 'bound'; id: string }
  | { kind: 'ambiguous'; candidateIds: string[] }
  | { kind: 'none' }

// Strip a leading `npm:` protocol off a descriptor range so the inner semver
// range is testable. A bare range (`^1.2.3`, `1.0.0`, `*`, `~2`) passes through.
// Any OTHER protocol (`git:`, `patch:`, `file:`, `workspace:`, `link:`,
// `portal:`, a URL scheme) is NOT a registry range and yields `undefined` —
// `semverResolve` then declines (those resolve through Rung 0/1, never here).
function registryRangeOf(range: string): string | undefined {
  if (range.startsWith('npm:')) return range.slice('npm:'.length)
  const colonIdx = range.indexOf(':')
  if (colonIdx <= 0) return range // bare semver range (no protocol)
  // A protocol-prefixed non-`npm:` range is out of Rung-3 scope.
  const prefix = range.slice(0, colonIdx)
  return /^[a-z][a-z0-9+.-]*$/i.test(prefix) ? undefined : range
}

/**
 * Rung 3 — SOURCE-GATED max-satisfying semver. Given a consumer descriptor's
 * `range` and the registry-class candidates that share the dep's name, return
 * the MAX-satisfying tarball node, or signal ambiguity / no-match.
 *
 * Gates (all mandatory — the ladder must stay safe regardless of the #91 work):
 *   1. range must be `npm:`/bare — any other protocol → `{ kind: 'none' }`
 *      (those resolve through the exact-match + patch/link rungs, never here);
 *   2. only `sourceType === 'tarball'` candidates are eligible — a git /
 *      directory / unknown / absent-source node is invisible to this match;
 *   3. only candidates with a `semver.valid` version that `satisfies(range)`
 *      survive; the MAX-satisfying version wins.
 *
 * Short-circuit: exactly one ELIGIBLE candidate of that name (regardless of the
 * range) binds directly — yarn already pinned the single instance, so a `^x`
 * consumer that finds exactly one tarball sibling links to it even when its
 * locked version does not satisfy the bare range (the NON-satisfying pin case
 * the override map normally covers, here resolvable structurally because the
 * choice is unique). A genuine final tie among ≥2 max-satisfying versions is
 * `{ kind: 'ambiguous' }` — the caller diagnoses + drops (never guesses).
 *
 * `candidates` need not be pre-filtered or pre-sorted; this function does both
 * deterministically.
 */
export function semverResolve(range: string, candidates: readonly SemverCandidate[]): SemverResolveResult {
  const semverRange = registryRangeOf(range)
  if (semverRange === undefined) return { kind: 'none' }

  const eligible = candidates.filter(c => c.sourceType === 'tarball')
  if (eligible.length === 0) return { kind: 'none' }

  // Structural short-circuit: a single registry sibling is unambiguous — bind it
  // even on a non-satisfying locked version (the pin yarn already chose).
  if (eligible.length === 1) return { kind: 'bound', id: eligible[0]!.id }

  const satisfying = eligible.filter(
    c => semver.valid(c.version) !== null && semver.satisfies(c.version, semverRange),
  )
  if (satisfying.length === 0) return { kind: 'none' }
  if (satisfying.length === 1) return { kind: 'bound', id: satisfying[0]!.id }

  // ≥2 satisfying → pick the MAX version. A unique maximum binds; a tie at the
  // maximum (two candidates of the same max version but distinct ids — e.g.
  // peer-virt siblings) is a genuine ambiguity → caller diagnoses + drops.
  let maxVersion: string | undefined
  for (const c of satisfying) {
    if (maxVersion === undefined || semver.gt(c.version, maxVersion)) maxVersion = c.version
  }
  const top = satisfying
    .filter(c => maxVersion !== undefined && semver.eq(c.version, maxVersion))
    .map(c => c.id)
    .sort(cmpStr)
  if (top.length === 1) return { kind: 'bound', id: top[0]! }
  return { kind: 'ambiguous', candidateIds: top }
}

/**
 * Rung 2 — OVERRIDE-MAP forced link. Find the human-declared override pin for a
 * dependency `(depName, declaredRange, consumerPath)` and return its verbatim
 * `to` target, or `undefined` when no constraint matches.
 *
 * Matching (authoritative — precedes semver):
 *   - `package` must equal `depName`;
 *   - `versionCondition`, when present, must match `declaredRange` (protocol-
 *     insensitive: a captured `npm:^3.0.2` matches a declared `^3.0.2` and vice
 *     versa). Absent condition = unconditional;
 *   - `parentPath`, when present, must be a SUFFIX of `consumerPath` (the
 *     override applies under that ancestor chain). Absent = global (any
 *     consumer). `consumerPath` is the resolved consumer chain the adapter
 *     knows; passing only the immediate parent name is a safe under-match (a
 *     deeper-than-1 parentPath simply won't bind, matching yarn's stricter
 *     scoping rather than over-binding).
 *
 * An npm `$name` self-ref (`selfRef`) is NOT resolvable here (it needs the
 * parent's resolved version, which only npm expresses) — such a constraint is
 * skipped so the caller falls through to semver / drop, never binding a literal
 * `$name` descriptor.
 *
 * On a tie (≥2 constraints matching the same descriptor) the MOST SPECIFIC wins:
 * a version-conditioned constraint beats an unconditional one, and a longer
 * `parentPath` beats a shorter one. This mirrors yarn's "more specific
 * resolutions key wins" precedence.
 */
export function overrideTargetFor(
  depName: string,
  declaredRange: string,
  consumerPath: readonly string[],
  overrides: readonly OverrideConstraint[],
): string | undefined {
  let best: OverrideConstraint | undefined
  let bestScore = -1
  for (const c of overrides) {
    if (c.package !== depName) continue
    if (c.selfRef === true) continue // $name back-ref — needs npm parent version
    if (c.versionCondition !== undefined && !conditionMatches(c.versionCondition, declaredRange)) continue
    const parentPath = c.parentPath ?? []
    if (!parentPathMatches(parentPath, consumerPath)) continue
    // Specificity: version condition (2) outranks parent depth so a
    // `csstype@npm:^3.1.3` pin beats a bare `csstype` global; among equal
    // condition-presence, a deeper parentPath wins.
    const score = (c.versionCondition !== undefined ? 1000 : 0) + parentPath.length
    if (score > bestScore) {
      best = c
      bestScore = score
    }
  }
  return best?.to
}

// Compare a captured override `versionCondition` against a consumer's declared
// range, protocol-insensitively. yarn `resolutions` keys carry the descriptor
// protocol verbatim (`csstype@npm:^3.0.2` → condition `npm:^3.0.2`), while the
// consumer deps-block range may be bare or `npm:`-prefixed depending on the
// adapter's normalisation. Strip a leading `npm:` from BOTH sides before the
// exact compare so the two surfaces meet. Non-`npm:` protocols (`patch:`, etc.)
// are compared verbatim (they are descriptor-identifying, not registry ranges).
function conditionMatches(versionCondition: string, declaredRange: string): boolean {
  return bareRange(versionCondition) === bareRange(declaredRange)
}

function bareRange(range: string): string {
  return range.startsWith('npm:') ? range.slice('npm:'.length) : range
}

// A constraint's `parentPath` matches when it is a SUFFIX of the consumer's
// resolved chain (the override applies wherever the dep is reached *under* that
// ancestor tail). Empty parentPath = global match. The consumer chain is what
// the adapter can attest; a longer parentPath than the chain simply fails to
// match (conservative — never over-binds).
function parentPathMatches(parentPath: readonly string[], consumerPath: readonly string[]): boolean {
  if (parentPath.length === 0) return true
  if (parentPath.length > consumerPath.length) return false
  const offset = consumerPath.length - parentPath.length
  for (let i = 0; i < parentPath.length; i++) {
    if (parentPath[i] !== consumerPath[offset + i]) return false
  }
  return true
}

const cmpStr = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0
