// Test-only Integrity constructors (ADR-0031). Production code builds Integrity
// via the recipe/integrity.ts codecs; these helpers keep fixtures terse.

import { parseSri, type Integrity } from '../main/ts/recipe/integrity.ts'

/**
 * Build an `Integrity` from a REAL SRI string (validated + hex-normalised).
 * Use this for fixtures that round-trip through an adapter, where the digest is
 * emitted and reparsed and must survive byte-exact.
 */
export function sri(s: string): Integrity {
  return parseSri(s)
}

/**
 * Build a single-hash `Integrity` from an OPAQUE marker string for fixtures that
 * use integrity as a presence / identity token and never round-trip it through
 * an adapter (`graph.diff` ignores integrity, so the marker need not be a real
 * digest). The marker is stored verbatim as the `digest` — NOT real hex — so do
 * not use this where the value is emitted and reparsed; use `sri(<real SRI>)`
 * there instead.
 */
export function mkIntegrity(marker: string, algorithm = 'sha512'): Integrity {
  return { hashes: [{ algorithm, digest: marker, origin: 'sri' }] }
}
