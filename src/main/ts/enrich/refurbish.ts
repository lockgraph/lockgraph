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
import { cacheKeyCompressionLevel, computeBerryChecksum } from '../recipe/berry-checksum.ts'
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
}

export interface RefurbishResult {
  graph:      Graph
  /** NodeIds that gained ≥1 field. */
  enriched:   NodeId[]
  /** All diagnostics this call emitted, in emission order. */
  unresolved: Diagnostic[]
}

const isBerryFormat = (format: string): boolean => format.startsWith('yarn-berry')

/** The cacheKey to target: the prevailing one carried by the graph's own berry
 *  nodes (the unchanged siblings), else the Yarn-4 STORE default. */
function berryCacheKeyFor(graph: Graph): string {
  for (const node of graph.nodes()) {
    const ck = graph.tarballOf(node.id)?.berryChecksumCacheKey
    if (ck !== undefined) return ck
  }
  return '10c0'
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

  const cacheKey = berryCacheKeyFor(graph)
  const isStore  = cacheKeyCompressionLevel(cacheKey) === 0

  // 1) Gather fill candidates in content-sorted node order (deterministic).
  // A `defer` candidate carries no async work; a `fetch` candidate needs its
  // tarball. Filters (in order): seed/workspace skip; no gap → skip; a PATCHED
  // node defers (its checksum hashes the PATCHED zip — computeBerryChecksum
  // reproduces only the bare repack → wrong digest — and a SENTINEL
  // `@patch:…!builtin` (fsevents) refuses setTarball outright); a non-STORE
  // cacheKey defers (not byte-reproducible in v1, ADR-0035 §6). yarn recomputes a
  // patch's / DEFLATE checksum on install.
  type Cand =
    | { kind: 'defer'; id: NodeId }
    | { kind: 'fetch'; node: Node; payload: TarballPayload }
  const cands: Cand[] = []
  for (const node of graph.nodes()) {
    if (seed !== undefined && !seed.has(node.id)) continue
    if (node.workspacePath !== undefined) continue
    const payload: TarballPayload = graph.tarballOf(node.id) ?? {}
    if (emitBerryChecksum(payload.integrity ?? emptyIntegrity()) !== undefined) continue
    if (node.patch !== undefined || !isStore) { cands.push({ kind: 'defer', id: node.id }); continue }
    cands.push({ kind: 'fetch', node, payload })
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
      ? await source.berryChecksum(c.node.name, c.node.version, cacheKey)
      : undefined
    if (hex === undefined) {
      const tgz = await source.tarball(c.node.name, c.node.version)
      if (tgz === undefined) return { kind: 'defer', id: c.node.id }   // no fetchable tarball
      hex = computeBerryChecksum(tgz, c.node.name, cacheKey)
    }
    const integrity = mergeIntegrity(
      c.payload.integrity ?? emptyIntegrity(),
      { hashes: [{ algorithm: 'sha512', digest: hex, origin: 'berry-zip' }] },
    )
    return { kind: 'fill', node: c.node, merged: { ...c.payload, integrity, berryChecksumCacheKey: cacheKey } }
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
