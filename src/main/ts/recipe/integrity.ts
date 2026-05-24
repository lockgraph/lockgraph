// ADR-0014 §4.F1 — integrity canonical recipe.
//
// Canonical form on Graph: `sha512-<base64>` SRI (RFC 6920 / RFC 4648 §4),
// exactly 64 bytes of digest. Per-PM encodings (yarn-berry hex / cacheKey-
// prefixed hex) are translated at the adapter parse/stringify boundary; the
// `cacheKey` prefix is yarn-berry sidecar attribution and never participates
// in the canonical SRI. The primitive is canonical-strict: non-sha512 SRIs,
// non-128-char hex, sentinel placeholders, and pad-bit-aliased base64 fail
// validation. `isCanonical` enforces byte-exact base64 round-trip — two
// shape-valid SRIs that decode to the same 64 bytes but disagree on pad-bit
// trailing chars cannot both be canonical, so only the re-encoded form is.
// Adapter call sites probe with `tryDetectEncoding` / `validateCanonical`
// and pass non-canonical inputs verbatim (stringify side: mutated graphs)
// or reject with adapter-specific diagnostic (parse side: external bytes).

import { LockfileError } from '../errors.ts'
import type { Diagnostic, NodeId } from '../graph.ts'

export type IntegrityEncoding =
  | 'sri'                  // sha512-<base64>, canonical
  | 'hex'                  // yarn-berry v4/v5/v6 raw 128-hex (sha512)
  | 'cachekey-prefixed'    // yarn-berry v8/v9 `<cacheKey>/<128-hex>` (sha512)

// 64-byte sha512 digest → base64 with `==` padding → 86 chars + 2 padding = 88.
const CANONICAL_RE        = /^sha512-[A-Za-z0-9+/]{86}==$/
const HEX_RE              = /^[0-9a-f]{128}$/
const CACHEKEY_RE         = /^[^/\s]+\/[0-9a-f]{128}$/

/**
 * True iff `s` is the canonical `sha512-<base64>` SRI form (ADR-0014 §4.F1).
 * Enforces byte-exact base64 round-trip: rejects pad-bit-aliased strings
 * (multiple shape-valid base64 encodings decode to the same 64 bytes;
 * only the strict re-encoding is canonical).
 */
export function isCanonical(s: string): boolean {
  if (!CANONICAL_RE.test(s)) return false
  const b64 = s.slice('sha512-'.length)
  const buf = Buffer.from(b64, 'base64')
  if (buf.length !== 64) return false
  return buf.toString('base64') === b64
}

/**
 * Adapter-side validator: returns `raw` iff it is already canonical (per
 * `isCanonical`), `undefined` otherwise. Avoids exception-as-control-flow
 * at SRI-source adapter parse sites (npm / pnpm / bun / yarn-classic) —
 * caller emits an adapter-specific `*_INVALID_INTEGRITY` diagnostic on
 * `undefined` and leaves `TarballPayload.integrity` unset.
 */
export function validateCanonical(raw: string): string | undefined {
  return isCanonical(raw) ? raw : undefined
}

/**
 * Strict shape probe. Returns the source encoding for canonical-translation-
 * eligible inputs; returns `undefined` for legacy sha1/sha256/sha384 SRIs,
 * non-128-char hex, sentinel placeholders, and any other shape the recipe
 * cannot canonicalise. Adapters bypass translation for `undefined` results.
 */
export function tryDetectEncoding(raw: string): IntegrityEncoding | undefined {
  if (isCanonical(raw))       return 'sri'
  if (HEX_RE.test(raw))       return 'hex'
  if (CACHEKEY_RE.test(raw))  return 'cachekey-prefixed'
  return undefined
}

/** Strict variant of `tryDetectEncoding` — throws `INVALID_INPUT` on unrecognised shapes. */
export function detectEncoding(raw: string): IntegrityEncoding {
  const enc = tryDetectEncoding(raw)
  if (enc !== undefined) return enc
  throw new LockfileError({
    code: 'INVALID_INPUT',
    message: `integrity: unrecognised encoding for ${JSON.stringify(raw)}`,
  })
}

/**
 * Translate a source-format encoding to the canonical `sha512-<base64>` SRI.
 * Throws `INVALID_INPUT` if `raw` does not strictly match the declared (or
 * auto-detected) `source` shape.
 */
export function toCanonical(raw: string, source?: IntegrityEncoding): string {
  const enc = source ?? detectEncoding(raw)
  switch (enc) {
    case 'sri':
      if (!isCanonical(raw)) {
        throw new LockfileError({
          code:    'INVALID_INPUT',
          message: `integrity: 'sri' source must be canonical sha512 SRI (got ${JSON.stringify(raw)})`,
        })
      }
      return raw
    case 'hex':
      if (!HEX_RE.test(raw)) {
        throw new LockfileError({
          code:    'INVALID_INPUT',
          message: `integrity: 'hex' source must be exactly 128 lowercase hex chars (got ${JSON.stringify(raw)})`,
        })
      }
      return `sha512-${hexToBase64(raw)}`
    case 'cachekey-prefixed':
      if (!CACHEKEY_RE.test(raw)) {
        throw new LockfileError({
          code:    'INVALID_INPUT',
          message: `integrity: 'cachekey-prefixed' source must match <cacheKey>/<128-hex> (got ${JSON.stringify(raw)})`,
        })
      }
      return `sha512-${hexToBase64(raw.slice(raw.indexOf('/') + 1))}`
  }
}

/**
 * Translate the canonical `sha512-<base64>` SRI to a target encoding.
 * `cacheKey` required for `target='cachekey-prefixed'`. Throws
 * `INVALID_INPUT` if `canonical` is not strict sha512 SRI.
 */
export function fromCanonical(
  canonical: string,
  target: IntegrityEncoding,
  options: { cacheKey?: string } = {},
): string {
  if (!isCanonical(canonical)) {
    throw new LockfileError({
      code:    'INVALID_INPUT',
      message: `integrity: canonical must be sha512 SRI (got ${JSON.stringify(canonical)})`,
    })
  }
  const b64 = canonical.slice('sha512-'.length)
  switch (target) {
    case 'sri':
      return canonical
    case 'hex':
      return base64ToHex(b64)
    case 'cachekey-prefixed':
      if (options.cacheKey === undefined || options.cacheKey === '') {
        throw new LockfileError({
          code:    'INVALID_INPUT',
          message: `integrity: target 'cachekey-prefixed' requires options.cacheKey`,
        })
      }
      return `${options.cacheKey}/${base64ToHex(b64)}`
  }
}

/** Emit RECIPE_INTEGRITY_TRANSLATED (info) per ADR-0014 §5 when `from !== to`. */
export function emitTranslation(
  nodeId: NodeId,
  from: IntegrityEncoding,
  to: IntegrityEncoding,
  onDiagnostic?: (d: Diagnostic) => void,
): void {
  if (onDiagnostic === undefined || from === to) return
  onDiagnostic({
    code:     'RECIPE_INTEGRITY_TRANSLATED',
    severity: 'info',
    subject:  nodeId,
    message:  `integrity translated ${from} → ${to}`,
  })
}

function hexToBase64(hex: string): string {
  return Buffer.from(hex, 'hex').toString('base64')
}

function base64ToHex(b64: string): string {
  return Buffer.from(b64, 'base64').toString('hex')
}
