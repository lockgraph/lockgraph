// ADR-0014 §4.F2 / §4.F5 — patch slot canonical recipe (pure-math primitive).
//
// Canonical form on Graph: `+patch=<sha512-hex>` slot on TarballKey per
// ADR-0011 — the slot value is the lowercase 128-char sha512 hex of the
// patch source bytes after the F5 byte normalisation (CRLF → LF; leading
// UTF-8 BOM stripped; trailing newline preserved verbatim) has been
// applied. Sentinel form `unresolved-<sha256-hex>` (per ADR-0011 §Decision)
// is admitted on the `Node.patch` carrier when patch source bytes are
// unavailable at parse time (workspaceRoot unsupplied, file unreadable,
// builtin patches whose source the adapter cannot resolve).
//
// The sentinel-hash *input* is per-format and adapter-defined per
// ADR-0011: yarn-berry hashes the locator string verbatim; pnpm hashes
// `<name>@<version>:<literal-key>` where `<literal-key>` is the original
// `overrides:` (or `patched_dependencies:`) key as written. Callers
// compute the input string themselves and pass it to `sentinelHashOf`.
//
// This module is pure-math: no Diagnostic emission, no Graph traversal.
// Adapter-facing helpers live в `recipe/diagnostics.ts`.

import { createHash } from 'node:crypto'
import { Buffer } from 'node:buffer'

const CANONICAL_HASH_RE = /^[0-9a-f]{128}$/
const SENTINEL_RE       = /^unresolved-[0-9a-f]{64}$/

/**
 * True iff `s` is the canonical `<sha512-hex>` patch slot value (ADR-0014
 * §4.F2 / ADR-0011 §Decision) — exactly 128 lowercase hex chars.
 */
export function isCanonicalHash(s: string): boolean {
  return CANONICAL_HASH_RE.test(s)
}

/**
 * True iff `s` is the ADR-0011 sentinel form `unresolved-<sha256-hex>`
 * (64 lowercase hex chars after the prefix). Sentinels are admitted on
 * the carrier when source bytes are unavailable but MUST NOT participate
 * in cross-PM dedup (ADR-0011 §Decision sentinel semantics).
 */
export function isSentinelPatch(s: string): boolean {
  return SENTINEL_RE.test(s)
}

/**
 * Adapter-side validator: returns `raw` iff it is the canonical
 * `<sha512-hex>` patch slot form, `undefined` otherwise. Sentinel inputs
 * return `undefined` — sentinels carry a different shape on the same
 * carrier and callers MUST handle them distinctly per ADR-0011.
 */
export function validateCanonicalHash(raw: string): string | undefined {
  return isCanonicalHash(raw) ? raw : undefined
}

/**
 * F5 byte normalisation per ADR-0014 §4.F5 — applied left-to-right BEFORE
 * the F2 sha512 fingerprint runs:
 *
 *   1. Strip a leading UTF-8 BOM (`EF BB BF`) when present.
 *   2. Replace every `\r\n` (0x0D 0x0A) byte pair with a single `\n`
 *      (0x0A). Standalone `\r` is preserved (empirically `core.autocrlf`
 *      never produces a bare CR; if one surfaces it is patch-author
 *      intent).
 *   3. Trailing newline presence is preserved verbatim — F5 is a
 *      line-ending equaliser, not a trailing-byte homogeniser.
 *
 * Returns `{ bytes, normalised }`. `normalised === true` iff at least one
 * byte was altered (used to drive `RECIPE_PATCH_NORMALISED` emission).
 * The function never mutates `input`; on the unchanged path the same
 * reference is returned for zero-copy semantics.
 */
export function normalisePatchBytes(input: Uint8Array): {
  bytes: Uint8Array
  normalised: boolean
} {
  const bomPresent =
    input.length >= 3 && input[0] === 0xEF && input[1] === 0xBB && input[2] === 0xBF

  let crlfPresent = false
  for (let i = bomPresent ? 3 : 0; i + 1 < input.length; i++) {
    if (input[i] === 0x0D && input[i + 1] === 0x0A) {
      crlfPresent = true
      break
    }
  }

  if (!bomPresent && !crlfPresent) {
    return { bytes: input, normalised: false }
  }

  const out = new Uint8Array(input.length)
  let w = 0
  for (let i = bomPresent ? 3 : 0; i < input.length; i++) {
    const byte = input[i]!
    if (byte === 0x0D && i + 1 < input.length && input[i + 1] === 0x0A) {
      out[w++] = 0x0A
      i++
    } else {
      out[w++] = byte
    }
  }
  return { bytes: out.subarray(0, w), normalised: true }
}

/**
 * Compute the canonical patch hash from source bytes — `sha512(bytes)` as
 * lowercase hex per ADR-0014 §4.F2, with F5 byte normalisation applied
 * first per ADR-0014 §4.F5. Existing callers stay transparent: passing
 * already-LF-normalised input is a no-op fast-path и produces the same
 * hex as raw `sha512(bytes)`.
 *
 * String inputs are encoded as UTF-8 before normalisation (note: the
 * literal characters `\r\n` в a JS string encode to bytes `0x0D 0x0A`,
 * so the rule applies uniformly through both call shapes).
 */
export function canonicalHashOfBytes(bytes: Uint8Array | string): string {
  return hashAndNormaliseBytes(bytes).hash
}

/**
 * Combined F5 normalisation + F2 sha512 fingerprint в a single linear
 * pass — returns `{ hash, normalised }`. Adapter call sites that need
 * BOTH the canonical hash AND the normalised-flag (для
 * `RECIPE_PATCH_NORMALISED` emission) MUST use this helper к avoid
 * re-scanning the buffer; `canonicalHashOfBytes` delegates here для
 * hash-only callers.
 */
export function hashAndNormaliseBytes(bytes: Uint8Array | string): {
  hash:       string
  normalised: boolean
} {
  const raw = typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes
  const { bytes: normalised, normalised: didNormalise } = normalisePatchBytes(raw)
  const hash = createHash('sha512').update(normalised).digest('hex')
  return { hash, normalised: didNormalise }
}

/**
 * Compute the sentinel hash from a PM-format-specific input string —
 * `unresolved-` + `sha256(input)` as lowercase hex per ADR-0011 §Decision.
 * The *input* is per-format: yarn-berry passes the locator string verbatim;
 * pnpm passes `<name>@<version>:<literal-key>`. The function does not
 * inspect the input — callers compute the right shape per ADR-0011 Table.
 */
export function sentinelHashOf(input: string): string {
  return `unresolved-${createHash('sha256').update(input, 'utf8').digest('hex')}`
}

/** Alias preserved for yarn-berry call sites where the input IS the locator. */
export const sentinelHashOfLocator = sentinelHashOf
