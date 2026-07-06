// ADR-0031 — integrity as a multi-hash carrier with origin tags
// (amends ADR-0014 §4.F1).
//
// Graph-canonical integrity is `Integrity { hashes: Hash[] }`: every algorithm
// present on disk and every member of a space-joined SRI is preserved verbatim,
// each digest tagged with its ORIGIN. `origin` distinguishes an SRI-emittable
// TARBALL digest (`sri`/`registry`/`recomputed`) from the two field-specific
// digests: `berry-zip` (Yarn Berry's `checksum` — a digest of the post-processed
// zip-cache, NOT the tarball) and `url-fragment` (the yarn-classic `resolved#<sha1>`
// tarball sha1, which rides the resolved URL fragment). Both are excluded from the
// SRI field and from SRI equivalence.
//
// Emit is origin-aware: a tarball SRI digest is never written into a berry
// `checksum`, a `berry-zip` digest is never written into an SRI field, and the
// `url-fragment` sha1 is written only into the yarn-classic resolved URL. When no
// compatible-origin digest exists the field is OMITTED (the adapter emits a soft
// `RECIPE_INTEGRITY_INCOMPLETE`), never fabricated — a tarball sha512 re-encoded
// into a berry `checksum` is a value real yarn rejects on install.
//
// Digests are stored as lowercase hex of the raw digest bytes; SRI base64 ↔ hex
// translation happens only at the parse/emit boundary so every algorithm and
// origin compares uniformly. Integrity is NOT part of NodeId / TarballKey
// (ADR-0010/0011) — this carrier is `TarballPayload` data only.

export type HashOrigin =
  | 'sri'          // member of an SRI field (npm / pnpm / bun / yarn-classic integrity). Tarball digest.
  | 'berry-zip'    // Yarn Berry `checksum` — digest of the zip-cache, NOT the tarball.
  | 'url-fragment' // yarn-classic `resolved#<sha1>` tarball sha1 — rides the resolved URL fragment, NOT the SRI field.
  | 'registry'     // fetched from registry metadata (`dist.integrity` / `dist.shasum`). Tarball digest.
  | 'recomputed'   // recomputed from tarball bytes (Phase 2). Tarball digest.

export interface Hash {
  algorithm: string      // 'sha1' | 'sha256' | 'sha384' | 'sha512' | forward-compatible others
  digest:    string      // lowercase hex of the raw digest bytes
  origin:    HashOrigin
}

export interface Integrity {
  hashes: Hash[]         // verbatim multiset, source order preserved
}

// Known SRI algorithm → raw digest byte length. Unknown algorithms are accepted
// verbatim (forward-compatible) and skip the length check.
const SRI_ALGO_BYTES: Record<string, number> = { sha1: 20, sha256: 32, sha384: 48, sha512: 64 }
// Strongest-first ordering for `canonicalDigest`. Unknown algorithms rank 0.
const ALGO_STRENGTH:  Record<string, number> = { sha512: 4, sha384: 3, sha256: 2, sha1: 1 }
// One `<algorithm>-<base64>` SRI member, with an optional `?<options>` suffix
// (W3C SRI) stripped. Algorithm is lowercase-alnum; base64 is standard +/= .
const SRI_MEMBER_RE = /^([a-z][a-z0-9]*)-([A-Za-z0-9+/]+={0,2})(?:\?.*)?$/
const HEX128_RE     = /^[0-9a-f]{128}$/

function hexToBase64(hex: string): string {
  return Buffer.from(hex, 'hex').toString('base64')
}

/** An empty carrier — no hashes known. */
export function emptyIntegrity(): Integrity {
  return { hashes: [] }
}

/** True iff the carrier holds no hashes. */
export function isEmptyIntegrity(i: Integrity): boolean {
  return i.hashes.length === 0
}

/**
 * True iff `origin` denotes a TARBALL digest (re-encodable into an SRI). Every
 * origin except `berry-zip` is tarball-scoped; `berry-zip` is the zip-cache
 * digest and is re-encodable only within the yarn family.
 */
export function isTarballOrigin(origin: HashOrigin): boolean {
  // Two origins are NOT SRI-field-scoped: `berry-zip` is the yarn-berry checksum
  // (its own field), and `url-fragment` is the yarn-classic `resolved#<sha1>` tarball
  // sha1 — it rides the RESOLVED URL fragment, never an SRI field, and stays out of
  // SRI equivalence (a display artifact, not the cross-family compare digest).
  return origin !== 'berry-zip' && origin !== 'url-fragment'
}

/** The subset of hashes whose origin is tarball-scoped (SRI-emittable). */
export function tarballHashes(i: Integrity): Hash[] {
  return i.hashes.filter(h => isTarballOrigin(h.origin))
}

/** The yarn-classic `resolved#<sha1>` fragment digest — a tarball sha1 tagged
 *  `url-fragment` (from `dist.shasum` on mint, or a parsed `#<sha1>` on round-trip).
 *  Lowercase hex, or `undefined`. Emitted into the resolved URL, never the SRI. */
export function urlFragmentSha1(i: Integrity): string | undefined {
  return i.hashes.find(h => h.algorithm === 'sha1' && h.origin === 'url-fragment')?.digest
}

/** First hash for `algorithm` (any origin), or `undefined`. */
export function pickAlgorithm(i: Integrity, algorithm: string): Hash | undefined {
  return i.hashes.find(h => h.algorithm === algorithm)
}

/** First tarball-origin sha512, or `undefined` — the preferred cross-family digest. */
export function pickTarballSha512(i: Integrity): Hash | undefined {
  return i.hashes.find(h => h.algorithm === 'sha512' && isTarballOrigin(h.origin))
}

/**
 * Parse an SRI field — a single `<algo>-<base64>` or a space-joined multi-hash
 * SRI — into an `Integrity`, preserving member order. `origin` defaults to
 * `'sri'`; registry ingestion passes `'registry'`. Members whose base64 decodes
 * to the wrong byte length for a KNOWN algorithm are skipped (malformed); an
 * unknown algorithm is kept forward-compatibly only above a 16-byte plausibility
 * floor, so a typo'd token (`foo-AAAA` → 3 bytes) does not survive as a bogus
 * hash. An unparseable input yields an empty carrier — the caller decides
 * whether to diagnose.
 */
export function parseSri(raw: string, origin: HashOrigin = 'sri'): Integrity {
  const hashes: Hash[] = []
  for (const member of raw.trim().split(/\s+/)) {
    if (member === '') continue
    const m = SRI_MEMBER_RE.exec(member)
    if (!m) continue
    const algorithm = m[1]!
    const bytes     = Buffer.from(m[2]!, 'base64')
    const expected  = SRI_ALGO_BYTES[algorithm]
    if (expected !== undefined) {
      if (bytes.length !== expected) continue   // known algorithm, wrong length → malformed
    } else if (bytes.length < 16) {
      continue                                  // unknown algorithm, implausibly short → typo'd garbage
    }
    hashes.push({ algorithm, digest: bytes.toString('hex'), origin })
  }
  return { hashes }
}

/**
 * Emit an SRI field from the TARBALL-origin hashes, space-joined in source
 * order. `berry-zip` hashes are excluded — a zip-cache digest is not a valid
 * SRI. Returns `undefined` when no tarball-origin hash exists, signalling the
 * adapter to OMIT the integrity field (never fabricate).
 */
export function emitSri(i: Integrity): string | undefined {
  const members = tarballHashes(i).map(h => `${h.algorithm}-${hexToBase64(h.digest)}`)
  return members.length > 0 ? members.join(' ') : undefined
}

/**
 * Parse a Yarn Berry `checksum` value — `<cacheKey>/<128-hex>` (v8+) or a bare
 * `<128-hex>` (v4–v6) — into `{ integrity, cacheKey }`. The digest is tagged
 * `origin:'berry-zip'`. The `cacheKey` prefix is sidecar attribution returned
 * separately (the adapter records it; it never enters an SRI). A non-128-hex
 * body yields an empty carrier.
 */
export function parseBerryChecksum(raw: string): { integrity: Integrity; cacheKey?: string } {
  const slash    = raw.indexOf('/')
  const cacheKey = slash === -1 ? undefined : raw.slice(0, slash)
  const hex      = slash === -1 ? raw       : raw.slice(slash + 1)
  if (!HEX128_RE.test(hex)) return { integrity: { hashes: [] }, cacheKey }
  return { integrity: { hashes: [{ algorithm: 'sha512', digest: hex, origin: 'berry-zip' }] }, cacheKey }
}

/**
 * Emit a Yarn Berry `checksum` body (bare lowercase hex; the adapter prefixes
 * any `cacheKey`) from the `berry-zip` sha512. Returns `undefined` when no
 * `berry-zip` digest exists — e.g. converting from npm/pnpm, whose tarball
 * sha512 is NOT a berry checksum — signalling the adapter to OMIT the checksum
 * line (yarn re-computes it on install) rather than fabricate one yarn rejects.
 */
export function emitBerryChecksum(i: Integrity): string | undefined {
  return i.hashes.find(h => h.algorithm === 'sha512' && h.origin === 'berry-zip')?.digest
}

/**
 * Union of two carriers, de-duplicated by `(algorithm, origin, digest)`,
 * preserving `a`-then-`b` source order. Used to fold registry-fetched hashes
 * into a lock-parsed carrier without inventing or reordering digests.
 */
export function mergeIntegrity(a: Integrity, b: Integrity): Integrity {
  const seen   = new Set<string>()
  const hashes: Hash[] = []
  for (const h of [...a.hashes, ...b.hashes]) {
    const key = `${h.algorithm} ${h.origin} ${h.digest}`
    if (seen.has(key)) continue
    seen.add(key)
    hashes.push(h)
  }
  return { hashes }
}

/**
 * The single best TARBALL digest as a canonical SRI string, for call sites that
 * still want one integrity string (back-compat bridge and graph-level
 * comparison). Prefers the strongest algorithm. Returns `undefined` when no
 * tarball-origin digest exists (e.g. a yarn-berry node carrying only a
 * `berry-zip` checksum) — that absence is the "needs fetch for a tarball
 * digest" signal, not an error.
 */
export function canonicalDigest(i: Integrity): string | undefined {
  const tb = tarballHashes(i)
  if (tb.length === 0) return undefined
  const best = tb.reduce((x, y) =>
    (ALGO_STRENGTH[y.algorithm] ?? 0) > (ALGO_STRENGTH[x.algorithm] ?? 0) ? y : x)
  return `${best.algorithm}-${hexToBase64(best.digest)}`
}

/**
 * Strict integrity equivalence for the interop matrix. Two carriers are
 * equivalent iff, within EACH origin class (tarball-scoped vs `berry-zip`),
 * the per-algorithm digest multisets are IDENTICAL — same algorithms present,
 * same digests. Strictness is deliberate: a lenient "agree on shared
 * algorithms" check would read "B dropped every hash" as equivalent, masking
 * exactly the loss this model exists to catch. Origin *provenance* within a
 * class is ignored (a `sri` and a `registry` sha512 of the same tarball are
 * equivalent); only the tarball-vs-zip split is load-bearing, so a fabricated
 * berry checksum (a tarball sha512 mislabelled `berry-zip`) is NOT equivalent
 * to the genuine tarball digest. Cross-family cells where the target cannot
 * carry the source's origin class (e.g. npm→berry) are expected to be
 * non-equivalent and are asserted via `RECIPE_INTEGRITY_INCOMPLETE`, not here.
 */
export function integrityEquivalent(a: Integrity, b: Integrity): boolean {
  const project = (i: Integrity, keep: (h: Hash) => boolean): Map<string, Set<string>> => {
    const m = new Map<string, Set<string>>()
    for (const h of i.hashes) {
      if (!keep(h)) continue
      let set = m.get(h.algorithm)
      if (set === undefined) { set = new Set(); m.set(h.algorithm, set) }
      set.add(h.digest)
    }
    return m
  }
  const equalMaps = (x: Map<string, Set<string>>, y: Map<string, Set<string>>): boolean => {
    if (x.size !== y.size) return false
    for (const [algo, xs] of x) {
      const ys = y.get(algo)
      if (ys === undefined || xs.size !== ys.size) return false
      for (const d of xs) if (!ys.has(d)) return false
    }
    return true
  }
  return (
    equalMaps(project(a, h => isTarballOrigin(h.origin)), project(b, h => isTarballOrigin(h.origin))) &&
    equalMaps(project(a, h => h.origin === 'berry-zip'),  project(b, h => h.origin === 'berry-zip'))
  )
}
