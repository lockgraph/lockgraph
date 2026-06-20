// ADR-0034 — enrich phase, install-completeness entry (`refurbish`).
//
// Post-completion, pre-optimize, monotone-additive: fills the install-required
// fields a freshly-bumped node lacks so the round-tripped lockfile installs
// without `yarn install`. v1's net-new fill is the yarn-berry `checksum`: for a
// node with no `berry-zip` digest, recompute one from the npm tarball bytes
// (ADR-0035, `computeBerryChecksum`, STORE cacheKeys), else defer with a
// diagnostic. Never overwrites a present field; never fabricates.

import type { Diagnostic, Graph, NodeId, TarballPayload } from '../graph.ts'
import { emptyIntegrity, emitBerryChecksum, mergeIntegrity } from '../recipe/integrity.ts'
import { cacheKeyCompressionLevel, computeBerryChecksum } from '../recipe/berry-checksum.ts'
import { enrichChecksumDeferred, enrichFieldFilled, enrichNoop } from './diagnostics.ts'

/** Supplies the npm tarball bytes for recompute (ADR-0034 §3) — a CacheAdapter
 *  or a registry-backed fetch wired by the orchestrator. */
export interface TarballSource {
  tarball(name: string, version: string): Promise<Uint8Array | undefined>
}

export interface RefurbishOptions {
  /** Stream diagnostics as they fire (ADR-0024 §3). */
  onDiagnostic?: (d: Diagnostic) => void
  /** Bound the fill to these NodeIds (the modifier's recently-changed set);
   *  absent ⇒ scan every non-workspace node. */
  seed?:         ReadonlySet<NodeId>
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
  const unresolved: Diagnostic[] = []
  const enriched:   NodeId[]     = []
  let   next:       Graph        = graph
  const record = (d: Diagnostic): void => {
    next = next.mutate(m => { m.diagnostic(d) }).graph
    unresolved.push(d)
    if (opts.onDiagnostic !== undefined) opts.onDiagnostic(d)
  }

  // Only yarn-berry targets have a recomputable berry `checksum`; for npm/pnpm/
  // bun the install-required integrity is already completion-filled.
  if (!isBerryFormat(format)) {
    record(enrichNoop())
    return { graph: next, enriched, unresolved }
  }

  const cacheKey = berryCacheKeyFor(graph)
  const isStore  = cacheKeyCompressionLevel(cacheKey) === 0

  for (const node of graph.nodes()) {
    if (opts.seed !== undefined && !opts.seed.has(node.id)) continue
    if (node.workspacePath !== undefined) continue            // no artefact to fill

    const payload: TarballPayload = graph.tarballOf(node.id) ?? {}
    // Gap iff no `berry-zip` digest present (emit returns undefined then).
    if (emitBerryChecksum(payload.integrity ?? emptyIntegrity()) !== undefined) continue

    // Recompute is STORE-only (ADR-0035 §6); a DEFLATE cacheKey or missing
    // tarball bytes ⇒ defer (omit + diagnostic).
    if (!isStore) { record(enrichChecksumDeferred(node.id)); continue }
    const tgz = await source.tarball(node.name, node.version)
    if (tgz === undefined) { record(enrichChecksumDeferred(node.id)); continue }

    const hex = computeBerryChecksum(tgz, node.name, cacheKey)
    const integrity = mergeIntegrity(
      payload.integrity ?? emptyIntegrity(),
      { hashes: [{ algorithm: 'sha512', digest: hex, origin: 'berry-zip' }] },
    )
    const merged: TarballPayload = { ...payload, integrity, berryChecksumCacheKey: cacheKey }
    const diag = enrichFieldFilled(node.id, 'berryChecksum', 'recompute')
    next = next.mutate(m => {
      m.setTarball({ name: node.name, version: node.version, patch: node.patch }, merged)
      m.diagnostic(diag)
    }).graph
    enriched.push(node.id)
    unresolved.push(diag)
    if (opts.onDiagnostic !== undefined) opts.onDiagnostic(diag)
  }

  if (unresolved.length === 0) record(enrichNoop())
  return { graph: next, enriched, unresolved }
}
