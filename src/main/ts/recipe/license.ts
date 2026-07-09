// Shared SPDX license-policy predicate.
//
// One definition of "does this license violate an allow/deny policy", used by
// BOTH the `filterLicense` modifier (modify/) and the completion `license`
// constraint (complete/), so the two surfaces never drift (ADR-0037).
//
// v1 semantics — SINGLE SPDX ids only. `allow`/`deny` are exact-id sets:
//   - deny: a license present in `deny` is flagged.
//   - allow: a license ABSENT from `allow` (or unknown) is flagged.
// An SPDX EXPRESSION (`(MIT OR Apache-2.0)`, `MIT AND GPL-3.0`) is NOT parsed —
// a token/substring scan is semantically WRONG (AND vs OR invert the verdict).
// `isLicenseExpression` lets a caller detect one and treat it as unevaluable
// rather than mis-decide.

/** True when `license` violates the allow/deny policy (i.e. should be flagged
 *  / rejected). Mirrors npm-audit-style gating. `undefined` license under an
 *  `allow` policy is flagged (can't prove it's permitted). */
export function isLicenseFlagged(
  license: string | undefined,
  allow: readonly string[] | undefined,
  deny:  readonly string[] | undefined,
): boolean {
  if (deny !== undefined && license !== undefined && deny.includes(license)) return true
  if (allow !== undefined) {
    if (license === undefined) return true
    if (!allow.includes(license)) return true
  }
  return false
}

/** True when `license` looks like a compound SPDX EXPRESSION rather than a
 *  single id — i.e. it contains an ` AND `/` OR `/` WITH ` operator or a
 *  parenthesised group. Such values are not id-comparable (v1 treats them as
 *  unevaluable). */
export function isLicenseExpression(license: string): boolean {
  return /\s(?:AND|OR|WITH)\s/i.test(license) || /[()]/.test(license)
}
