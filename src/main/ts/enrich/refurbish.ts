// ADR-0034 — enrich phase, install-completeness entry (`refurbish`).
//
// Post-completion, pre-optimize, monotone-additive: fills the install-required
// fields a freshly-bumped node lacks so the round-tripped lockfile installs
// without `yarn install`. v1's net-new fill is the yarn-berry `checksum`: for a
// node with no `berry-zip` digest, recompute one from the npm tarball bytes
// (ADR-0035, `computeBerryChecksum`, STORE cacheKeys), else defer with a
// diagnostic. Never overwrites a present field; never fabricates.

import type { Diagnostic, Graph, Node, NodeId, TarballPayload } from '../graph.ts'
import { emptyIntegrity, emitBerryChecksum, mergeIntegrity } from '../recipe/integrity.ts'
import { berryCacheKeyReproducible, cacheKeyCompressionLevel, computeBerryChecksum } from '../recipe/berry-checksum.ts'
import { computeBerryChecksumViaLibzip } from '../recipe/berry-pack-libzip.ts'
import { enrichChecksumDeferred, enrichFieldFilled, enrichNoop } from './diagnostics.ts'

/** Supplies what refurbish needs to fill a berry `checksum` (ADR-0034 §3) — wired
 *  by the orchestrator (a CacheAdapter, a registry-backed fetch, or both). */
export interface TarballSource {
  /** npm tarball bytes to recompute the berry-zip digest from (the fallback). */
  tarball(name: string, version: string): Promise<Uint8Array | undefined>
  /**
   * OPTIONAL fast path — a ready `berry-zip` sha512 (lowercase hex, NO `cacheKey/`
   * prefix) for `(name, version)` under `cacheKey`, sourced however the caller
   * likes. The canonical win is the PM's OWN cache: yarn-berry stores the
   * repacked zip at `.yarn/cache/<pkg>-<hash>-<cacheKey>.zip` with the digest IN
   * THE FILENAME, so the caller returns it without a network fetch OR a recompute.
   * Return a digest → refurbish uses it directly (no `tarball` call, no
   * `computeBerryChecksum`); return undefined → refurbish falls back to
   * `tarball` + recompute. Keeps the byte source fully caller-parameterised; the
   * library never hardcodes a cache location.
   */
  berryChecksum?(name: string, version: string, cacheKey: string): Promise<string | undefined>
}

export interface RefurbishOptions {
  /** Stream diagnostics as they fire (ADR-0024 §3). */
  onDiagnostic?: (d: Diagnostic) => void
  /** Bound the fill to these NodeIds (the modifier's recently-changed set);
   *  absent ⇒ scan every non-workspace node. */
  seed?:         ReadonlySet<NodeId>
  /** Max concurrent tarball fetch + recompute — the slow, network-bound step.
   *  Default 16. The graph mutation that applies each result stays sequential and
   *  deterministic (node order), so this only parallelises the fetch/compute. */
  concurrency?:  number
  /** The berry cacheKey to recompute against (e.g. `'10c0'`, `'8'`). REQUIRED to
   *  fill a BARE-era lock (v4–v7) — its entries carry no per-node prefix to infer
   *  it from, so absent it every gap DEFERS. Optional for a prefix-era lock (read
   *  off a sibling's `<cacheKey>/`). */
  cacheKey?:     string
}

export interface RefurbishResult {
  graph:      Graph
  /** NodeIds that gained ≥1 field. */
  enriched:   NodeId[]
  /** All diagnostics this call emitted, in emission order. */
  unresolved: Diagnostic[]
}

const isBerryFormat = (format: string): boolean => format.startsWith('yarn-berry')

/** First lockfile format version of the prefix era (`<cacheKey>/<hex>` per-node
 *  checksums). Below it (v4–v7) checksums are bare — no inferable cacheKey. */
const PREFIX_ERA_MIN_LOCKFILE_VERSION = 8

const isPrefixEraFormat = (format: string): boolean => {
  const m = /^yarn-berry-v(\d+)$/.exec(format)
  return m !== null && Number(m[1]) >= PREFIX_ERA_MIN_LOCKFILE_VERSION
}

/** The cacheKey to recompute against, or `undefined` when it can't be inferred
 *  in-graph (so the caller DEFERS rather than guess). Precedence:
 *    1. a per-node `<cacheKey>/` prefix on an existing sibling — the only
 *       in-graph signal, present in a prefix-era (v8+) lock;
 *    2. for a prefix-era FORMAT with no such sibling (e.g. a fresh cross-family
 *       convert) the Yarn-4 STORE default `10c0` — this assumes the modern STORE
 *       convention; an orchestrator targeting a `mixed` project should pass
 *       `opts.cacheKey` so a STORE digest is not filled for a mixed lock;
 *    3. otherwise (bare-era v4–v7, no sibling prefix) `undefined` — the caller
 *       must pass `opts.cacheKey` (the lock's `__metadata.cacheKey`) to fill. */
function berryCacheKeyFor(graph: Graph, format: string): string | undefined {
  for (const node of graph.nodes()) {
    const ck = graph.tarballOf(node.id)?.berryChecksumCacheKey
    if (ck !== undefined) return ck
  }
  return isPrefixEraFormat(format) ? '10c0' : undefined
}

/** Whether the INSTALLED `@yarnpkg/libzip` reproduces THIS lock's cache
 *  generation — verified by recomputing ONE existing sibling checksum and
 *  comparing. The optional libzip backend matches only its own generation
 *  (libzip 3.x → cacheKey 10, NOT 9) and a wrong digest hard-fails `yarn install
 *  --immutable`, so a libzip fill is trusted ONLY after this passes. Returns
 *  false when libzip is absent (`computeBerryChecksumViaLibzip` → undefined),
 *  no checksummed + fetchable anchor exists, or the reproduction mismatches. */
async function calibrateLibzip(graph: Graph, cacheKey: string, source: TarballSource): Promise<boolean> {
  for (const node of graph.nodes()) {
    if (node.workspacePath !== undefined || node.patch !== undefined) continue
    const integrity = graph.tarballOf(node.id)?.integrity
    const existing = integrity !== undefined ? emitBerryChecksum(integrity) : undefined
    if (existing === undefined) continue                 // not an anchor (no berry-zip checksum)
    const tgz = await source.tarball(node.name, node.version)
    if (tgz === undefined) continue                      // unfetchable anchor — try another
    return (await computeBerryChecksumViaLibzip(tgz, node.name, cacheKey)) === existing
  }
  return false                                           // no fetchable anchor → can't trust libzip
}

/** Bounded-concurrency map that preserves INPUT order in the result. The slow
 *  refurbish step is the per-tarball fetch; a pool turns N serial network
 *  round-trips into ≈⌈N/limit⌉. Output is indexed by input position, so a
 *  caller's sequential apply stays deterministic regardless of which fetch
 *  finished first. */
async function mapPool<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let cursor = 0
  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      const i = cursor++
      out[i] = await fn(items[i]!)
    }
  }
  const n = Math.max(1, Math.min(limit, items.length || 1))
  await Promise.all(Array.from({ length: n }, () => worker()))
  return out
}

/**
 * Fill install-required fields the graph's own format needs (v1: the yarn-berry
 * `checksum`). `format` is the lock's own format (caller-supplied, from
 * `detect()`); `source` supplies tarball bytes for recompute.
 */
export async function refurbish(
  graph:  Graph,
  format: string,
  source: TarballSource,
  opts:   RefurbishOptions = {},
): Promise<RefurbishResult> {
  const onDiagnostic = opts.onDiagnostic
  const seed         = opts.seed
  const concurrency  = opts.concurrency ?? 16

  const unresolved: Diagnostic[] = []
  const enriched:   NodeId[]     = []
  let   next:       Graph        = graph
  const record = (d: Diagnostic): void => {
    next = next.mutate(m => { m.diagnostic(d) }).graph
    unresolved.push(d)
    if (onDiagnostic !== undefined) onDiagnostic(d)
  }

  // Only yarn-berry targets have a recomputable berry `checksum`; for npm/pnpm/
  // bun the install-required integrity is already completion-filled.
  if (!isBerryFormat(format)) {
    record(enrichNoop())
    return { graph: next, enriched, unresolved }
  }

  const cacheKey = opts.cacheKey ?? berryCacheKeyFor(graph, format)
  // ADR-0035 byte-reproduces the `checksum` with the pinned `pako` path for
  // STORE (`cN0`, any era) and `mixed` at cacheKey VERSION 7/8 (yarn 2.4 / yarn
  // 3.0–3.x). The gate keys off the PER-LOCK cacheKey, NOT the lockfile format
  // version: a bare-era v6 lock pinned at cacheKey 8 (yarn 3.8, qiwi/mware) IS
  // fillable once `opts.cacheKey` supplies its `__metadata.cacheKey` — the bare-
  // vs-`<cacheKey>/` emit is the format's job (`checksumPrefix`), so a fill never
  // forces a foreign prefix into a bare lock. An indeterminable cacheKey
  // (`undefined`) defers everything rather than guess.
  const pakoOk = cacheKey !== undefined && berryCacheKeyReproducible(cacheKey)
  // cacheKey 9/10 `mixed` (+ explicit `cN`) vendor a non-portable zlib pako can't
  // match. The OPTIONAL `@yarnpkg/libzip` backend (§berry-pack-libzip) reproduces a
  // FIXED level (cN) — every file compresses identically, so calibrating ONE anchor
  // validates all — but it CANNOT reliably reproduce yarn's `mixed` heuristic
  // (per-FILE: deflate iff smaller). One-anchor calibration is UNSOUND for `mixed`:
  // a small / STORE-able anchor calibrates PASS while a larger DEFLATE'd target
  // mis-hashes → `yarn install --immutable` YN0018 (yaf pijma `selfsigned` under
  // `compressionLevel: mixed`). So libzip ONLY a NON-mixed (fixed-level) cacheKey,
  // and only after CALIBRATION (reproduce a sibling checksum, compare). A `mixed`
  // cacheKey pako can't do (v9/10) DEFERS — a clean omit yarn recomputes on install,
  // never a wrong value `--immutable` rejects. Absent libzip / no anchor / mismatch → defer.
  const useLibzip = cacheKey !== undefined && !pakoOk && cacheKeyCompressionLevel(cacheKey) !== -1
    ? await calibrateLibzip(graph, cacheKey, source)
    : false
  const reproducible = pakoOk || useLibzip

  // 1) Gather fill candidates in content-sorted node order (deterministic).
  // A `defer` candidate carries no async work; a `fetch` candidate needs its
  // tarball. Filters (in order): seed/workspace skip; no gap → skip; a PATCHED
  // node defers (its checksum hashes the PATCHED zip — computeBerryChecksum
  // reproduces only the bare repack → wrong digest — and a SENTINEL
  // `@patch:…!builtin` (fsevents) refuses setTarball outright); a
  // non-`reproducible` era/compression defers (bare-era v4–v7 or a non-STORE
  // cacheKey — not byte-reproducible in v1, ADR-0035 §6). yarn recomputes a
  // patch's / bare-era / DEFLATE checksum on install.
  type Cand =
    | { kind: 'defer'; id: NodeId }
    | { kind: 'fetch'; node: Node; payload: TarballPayload; cacheKey: string }
  const cands: Cand[] = []
  for (const node of graph.nodes()) {
    if (seed !== undefined && !seed.has(node.id)) continue
    if (node.workspacePath !== undefined) continue
    const payload: TarballPayload = graph.tarballOf(node.id) ?? {}
    if (emitBerryChecksum(payload.integrity ?? emptyIntegrity()) !== undefined) continue
    // `reproducible` ⟹ `cacheKey` is defined; a patch or a non-reproducible
    // (or indeterminable) cacheKey defers.
    if (node.patch !== undefined || !reproducible) { cands.push({ kind: 'defer', id: node.id }); continue }
    cands.push({ kind: 'fetch', node, payload, cacheKey: cacheKey as string })
  }

  // 2) Recompute CONCURRENTLY — the bottleneck is the per-tarball fetch (network),
  // not the CPU repack. Order-preserving bounded pool.
  type Resolved =
    | { kind: 'defer'; id: NodeId }
    | { kind: 'fill';  node: Node; merged: TarballPayload }
  const resolved = await mapPool(cands, concurrency, async (c): Promise<Resolved> => {
    if (c.kind === 'defer') return c
    // Fast path: a caller-supplied cached digest (e.g. from `.yarn/cache`, where
    // the hash is in the filename) skips the fetch + recompute entirely.
    let hex = source.berryChecksum !== undefined
      ? await source.berryChecksum(c.node.name, c.node.version, c.cacheKey)
      : undefined
    if (hex === undefined) {
      const tgz = await source.tarball(c.node.name, c.node.version)
      if (tgz === undefined) return { kind: 'defer', id: c.node.id }   // no fetchable tarball
      hex = pakoOk
        ? computeBerryChecksum(tgz, c.node.name, c.cacheKey)           // pinned pako (STORE / mixed 7,8)
        : await computeBerryChecksumViaLibzip(tgz, c.node.name, c.cacheKey)  // calibrated libzip (9/10)
      if (hex === undefined) return { kind: 'defer', id: c.node.id }   // libzip couldn't pack — defer
    }
    const integrity = mergeIntegrity(
      c.payload.integrity ?? emptyIntegrity(),
      { hashes: [{ algorithm: 'sha512', digest: hex, origin: 'berry-zip' }] },
    )
    // No `berryChecksumCacheKey`: a FILL is not a parsed prefix to round-trip,
    // so the bare-vs-`<cacheKey>/` rendering is left to the format's
    // `checksumPrefix` (else a bare-era v6 lock would get a foreign `8/` prefix).
    return { kind: 'fill', node: c.node, merged: { ...c.payload, integrity } }
  })

  // 3) Apply sequentially in node order — graph mutation is in-memory + fast, and
  // ordering keeps `enriched` / diagnostics deterministic regardless of fetch race.
  for (const r of resolved) {
    if (r.kind === 'defer') { record(enrichChecksumDeferred(r.id)); continue }
    const diag = enrichFieldFilled(r.node.id, 'berryChecksum', 'recompute')
    next = next.mutate(m => {
      m.setTarball({ name: r.node.name, version: r.node.version, patch: r.node.patch }, r.merged)
      m.diagnostic(diag)
    }).graph
    enriched.push(r.node.id)
    unresolved.push(diag)
    if (onDiagnostic !== undefined) onDiagnostic(diag)
  }

  if (unresolved.length === 0) record(enrichNoop())
  return { graph: next, enriched, unresolved }
}
