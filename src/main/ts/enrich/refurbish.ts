// enrich phase, install-completeness entry (`refurbish`).
//
// Post-completion, pre-optimize, monotone-additive: fills the install-required
// fields a freshly-bumped node lacks so the round-tripped lockfile installs
// without `yarn install`. v1's net-new fill is the yarn-berry `checksum`: for a
// node with no `berry-zip` digest, recompute one from the npm tarball bytes
// (— the pure-JS `pako` port for STORE + mixed cacheKey 7/8/9, the
// optional `@yarnpkg/libzip` for cacheKey 10, each vetted by `calibrate`), else
// defer with a diagnostic. Never overwrites a present field; never fabricates.

import { toTarballKey } from '../graph.ts'
import type { Diagnostic, Edge, Graph, Node, NodeId, TarballPayload } from '../graph.ts'
import { emptyIntegrity, emitBerryChecksum, mergeIntegrity } from '../recipe/integrity.ts'
import { berryCacheKeyReproducible, computeBerryChecksum } from '../recipe/berry-checksum.ts'
import { computeBerryChecksumViaLibzip } from '../recipe/berry-pack-libzip.ts'
import {
  isBareYarnBerryNpmAliasNode,
  yarnBerryChecksumFreeNodes,
} from '../formats/_yarn-berry-core.ts'
import {
  enrichChecksumDeferred,
  enrichArtifactLimit,
  enrichFieldFilled,
  enrichNoop,
} from './diagnostics.ts'
import {
  ArtifactEnvelopeError,
  ArtifactLiveMeter,
  artifactResourceLimits,
  type ArtifactResourcePolicy,
  type EffectiveArtifactResourceLimits,
} from '../recipe/artifact-envelope.ts'
import type {
  NpmTarballSource,
  YarnBerryChecksumSource,
} from '../registry/types.ts'
import {
  ArtifactByteFailure,
  type ArtifactTarballRequest,
  type RequestNpmTarballSource,
} from './artifact-bytes.ts'

// === REFURBISHMENT CONTRACT =================================================

/** Keeps npm tarball bytes and Yarn cache checksum evidence in separate,
 *  non-interchangeable capabilities. */
export interface RefurbishSources {
  readonly npmTarballs: NpmTarballSource
  readonly yarnBerryChecksums?: YarnBerryChecksumSource
}

/** Supplies what refurbish needs to fill a berry `checksum`.
 *
 * @deprecated Pass {@link RefurbishSources} so npm tarballs and Yarn cache
 * checksum evidence cannot be conflated.
 */
export interface TarballSource extends NpmTarballSource {
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

function normalizeRefurbishSources(
  source: RefurbishSources | TarballSource,
): RefurbishSources {
  if ('npmTarballs' in source) return source
  if (source.berryChecksum === undefined) return { npmTarballs: source }
  const berryChecksum = source.berryChecksum.bind(source)
  return {
    npmTarballs: source,
    yarnBerryChecksums: { berryChecksum },
  }
}

export interface RefurbishOptions {
  /** Stream diagnostics as they fire. */
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
  /** Cache-key inference policy. `format-default` preserves the direct primitive's
   *  historical v8+ `10c0` fallback. Target-aware enrichment uses
   *  `observed-only` so a project generation is never guessed. */
  cacheKeyInference?: 'format-default' | 'observed-only'
  /** Mandatory-on byte materialization safety envelope. */
  artifactResources?: ArtifactResourcePolicy
}

export interface RefurbishResult {
  graph:      Graph
  /** NodeIds that gained ≥1 field. */
  enriched:   NodeId[]
  /** All diagnostics this call emitted, in emission order. */
  unresolved: Diagnostic[]
}

// === REACHABILITY ===========================================================

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
 *    1. a unique per-node `<cacheKey>/` prefix on existing siblings — the only
 *       in-graph signal, present in a prefix-era (v8+) lock;
 *    2. for a prefix-era FORMAT with no such sibling (e.g. a fresh cross-family
 *       convert) the Yarn-4 STORE default `10c0` — this assumes the modern STORE
 *       convention; an orchestrator targeting a `mixed` project should pass
 *       `opts.cacheKey` so a STORE digest is not filled for a mixed lock;
 *    3. otherwise (bare-era v4–v7, no sibling prefix) `undefined` — the caller
 *       must pass `opts.cacheKey` (the lock's `__metadata.cacheKey`) to fill. */
export function berryCacheKeyFor(
  graph: Graph,
  format: string,
  inference: NonNullable<RefurbishOptions['cacheKeyInference']>,
): string | undefined {
  const observed = new Set<string>()
  for (const node of graph.nodes()) {
    const ck = graph.tarballOf(node.id)?.berryChecksumCacheKey
    if (ck !== undefined) observed.add(ck)
  }
  if (observed.size === 1) return observed.values().next().value
  if (observed.size > 1 && inference === 'observed-only') return undefined
  if (observed.size > 1) return observed.values().next().value
  return inference === 'format-default' && isPrefixEraFormat(format) ? '10c0' : undefined
}

// === CHECKSUM CALIBRATION ===================================================

/** A `Recompute` reproduces yarn's cache-zip digest for `(tgz, name, cacheKey)`,
 *  or `undefined` when its backend cannot (e.g. libzip not installed). Both the
 *  pure-JS `pako` port (via `selectPakoProfile`) and the optional `@yarnpkg/libzip`
 *  backend share this shape. */
type Recompute = (
  tgz: Uint8Array,
  name: string,
  cacheKey: string,
  limits?: EffectiveArtifactResourceLimits,
  liveMeter?: ArtifactLiveMeter,
) => Promise<string | undefined>

function hasRequestLoader(
  source: NpmTarballSource,
): source is RequestNpmTarballSource {
  return typeof (source as Partial<RequestNpmTarballSource>).tarballFor === 'function'
}

function loadTarball(
  source: NpmTarballSource,
  node: Node,
  payload: TarballPayload,
): Promise<Uint8Array | undefined> {
  return hasRequestLoader(source)
    ? source.tarballFor({ node, payload } satisfies ArtifactTarballRequest)
    : source.tarball(node.name, node.version)
}

function releaseTarball(
  source: NpmTarballSource,
  bytes: Uint8Array,
): void {
  if (hasRequestLoader(source)) source.releaseTarball(bytes)
}

/** Whether the OPTIONAL `@yarnpkg/libzip` backend reproduces THIS lock's cache
 *  generation, proven by recomputing ONE existing sibling checksum byte-for-byte
 *  (the `pako` port has its own order-aware selector, `selectPakoProfile`):
 *    • `'match'`     — a fetchable anchor reproduced exactly → trust the backend.
 *    • `'mismatch'`  — an anchor did NOT reproduce → the installed libzip's zlib-ng
 *                      differs from the generation that wrote this lock (libzip 3.x
 *                      reproduces cacheKey 10, not 8/9) → do NOT trust it.
 *    • `'no-anchor'` — no checksummed + fetchable + reproducible sibling to vet
 *                      against (a bare-era / fresh-convert lock, all gaps).
 *  A wrong digest hard-fails `yarn install --immutable` (YN0018), so the caller
 *  trusts the generation-specific libzip ONLY on a positive `match`. */
async function calibrate(
  graph: Graph,
  cacheKey: string,
  source: NpmTarballSource,
  recompute: Recompute,
  policy: ArtifactResourcePolicy | undefined,
  liveMeter: ArtifactLiveMeter,
): Promise<'match' | 'mismatch' | 'no-anchor'> {
  for (const node of graph.nodes()) {
    if (node.workspacePath !== undefined || node.patch !== undefined) continue
    const payload = graph.tarballOf(node.id)
    if (payload?.berryChecksumCacheKey !== undefined
      && payload.berryChecksumCacheKey !== cacheKey) continue
    const integrity = payload?.integrity
    const existing = integrity !== undefined ? emitBerryChecksum(integrity) : undefined
    if (existing === undefined) continue                 // not an anchor (no berry-zip checksum)
    let tgz: Uint8Array | undefined
    try { tgz = await loadTarball(source, node, graph.tarballOf(node.id) ?? {}) } catch { continue }
    if (tgz === undefined) continue                      // unfetchable anchor — try another
    let repro: string | undefined
    try {
      const release = hasRequestLoader(source)
        ? undefined
        : liveMeter.acquire(tgz.byteLength)
      try {
        repro = await recompute(
          tgz,
          node.name,
          cacheKey,
          artifactResourceLimits(policy, toTarballKey(node)),
          liveMeter,
        )
      } finally {
        release?.()
      }
    } catch {
      releaseTarball(source, tgz)
      continue
    }
    releaseTarball(source, tgz)
    if (repro === undefined) continue                    // backend can't reproduce (libzip absent) — try another
    return repro === existing ? 'match' : 'mismatch'
  }
  return 'no-anchor'                                      // nothing to calibrate against
}

/** Pick the pure-JS `pako` recompute whose container ENTRY ORDER reproduces THIS
 *  lock's cache generation, or `undefined` when none does (→ the caller tries the
 *  optional libzip backend, or the oracle supplies, else defer).
 *
 *  yarn builds vary in entry order — some emit each directory lazily before its
 *  first file (tar order), others emit ALL directories first then all files — and
 *  the order is NOT encoded in the cacheKey. So we CALIBRATE: recompute an existing
 *  sibling checksum under BOTH orders and see which matches. Correctness hinges on a
 *  DISCRIMINATING anchor — a package with nested directories, whose two orders yield
 *  DIFFERENT digests; a single-directory package can't tell the orders apart:
 *    • a discriminating anchor matches one order → that order (definitive).
 *    • a discriminating (or any) anchor matches NEITHER → the lock's zlib/order is
 *      outside our port (a foreign yarn build) → `undefined` (defer / try libzip).
 *    • only non-discriminating anchors matched (all single-dir), or no fetchable
 *      checksummed anchor exists (bare-era / fresh convert) → default to lazy/tar
 *      order (the yarn 3.6+/4 convention, and this module's prior sole behavior).
 *  A wrong digest hard-fails `--immutable`, so an unresolvable order defers rather
 *  than guess — never a wrong value. */
async function selectPakoProfile(
  graph: Graph,
  cacheKey: string,
  source: NpmTarballSource,
  policy: ArtifactResourcePolicy | undefined,
  liveMeter: ArtifactLiveMeter,
): Promise<Recompute | undefined> {
  const mk = (dirsFirst: boolean): Recompute => (tgz, name, ck, limits, meter) =>
    Promise.resolve(computeBerryChecksum(tgz, name, ck, dirsFirst, limits, meter))
  for (const node of graph.nodes()) {
    if (node.workspacePath !== undefined || node.patch !== undefined) continue
    const payload = graph.tarballOf(node.id)
    if (payload?.berryChecksumCacheKey !== undefined
      && payload.berryChecksumCacheKey !== cacheKey) continue
    const integrity = payload?.integrity
    const existing = integrity !== undefined ? emitBerryChecksum(integrity) : undefined
    if (existing === undefined) continue                 // not an anchor (no berry-zip checksum)
    let tgz: Uint8Array | undefined
    try { tgz = await loadTarball(source, node, graph.tarballOf(node.id) ?? {}) } catch { continue }
    if (tgz === undefined) continue                      // unfetchable anchor — try another
    let lazy: string, dirsFirst: string
    try {
      const release = hasRequestLoader(source)
        ? undefined
        : liveMeter.acquire(tgz.byteLength)
      const limits = artifactResourceLimits(policy, toTarballKey(node))
      try {
        lazy = computeBerryChecksum(
          tgz,
          node.name,
          cacheKey,
          false,
          limits,
          liveMeter,
        )
        dirsFirst = computeBerryChecksum(
          tgz,
          node.name,
          cacheKey,
          true,
          limits,
          liveMeter,
        )
      } finally {
        release?.()
      }
    } catch {
      releaseTarball(source, tgz)
      continue
    }                                 // unsupported entry (symlink) — try another anchor
    releaseTarball(source, tgz)
    if (lazy === dirsFirst) {                            // NON-discriminating (single-directory package)
      if (lazy !== existing) return undefined            // neither order reproduces it → foreign build → defer
      continue                                           // basics confirmed, order ambiguous — keep looking
    }
    if (existing === lazy)      return mk(false)         // discriminating → the lock's order is settled
    if (existing === dirsFirst) return mk(true)
    return undefined                                     // discriminating, matches neither → foreign build → defer
  }
  return mk(false)                                       // no discriminating anchor resolved it → lazy default
}

/** Bounded-concurrency map that preserves INPUT order in the result. The slow
 *  refurbish step is the per-tarball fetch; a pool turns N serial network
 *  round-trips into ≈⌈N/limit⌉. Output is indexed by input position, so a
 *  caller's sequential apply stays deterministic regardless of which fetch
 *  finished first. */
async function mapPool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let cursor = 0
  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      const i = cursor++
      out[i] = await fn(items[i]!)
    }
  }
  const n = Number.isFinite(limit)
    ? Math.max(1, Math.min(Math.floor(limit), items.length || 1))
    : 1
  await Promise.all(Array.from({ length: n }, () => worker()))
  return out
}

// === REFURBISHMENT PIPELINE =================================================

type RefurbishCandidate =
  | { kind: 'defer'; id: NodeId }
  | { kind: 'fetch'; node: Node; payload: TarballPayload; cacheKey: string }

type ResolvedRefurbishment =
  | { kind: 'defer'; id: NodeId; diagnostic?: Diagnostic }
  | { kind: 'fill'; node: Node; merged: TarballPayload }

interface RefurbishResolutionContext {
  readonly format: string
  readonly npmTarballs: NpmTarballSource
  readonly berryChecksums: YarnBerryChecksumSource | undefined
  readonly recompute: Recompute | undefined
  readonly artifactResources: ArtifactResourcePolicy | undefined
  readonly liveMeter: ArtifactLiveMeter
}

async function selectChecksumStrategy(
  graph: Graph,
  cacheKey: string | undefined,
  npmTarballs: NpmTarballSource,
  artifactResources: ArtifactResourcePolicy | undefined,
  liveMeter: ArtifactLiveMeter,
): Promise<Recompute | undefined> {
  if (cacheKey !== undefined && berryCacheKeyReproducible(cacheKey)) {
    // pako OWNS STORE + mixed 7/8/9 (order-calibrated). Its verdict is FINAL: an
    // `undefined` here is an ACTIVE "this lock is foreign to pako" defer (a
    // discriminating anchor matched neither order) — NOT a cue to try a
    // different-generation backend. libzip 3.x is zlib-ng / cacheKey-10; letting it
    // fill a 7/8/9 lock (which it can license off a generation-independent STORE
    // sibling) writes cacheKey-10 bytes yarn rejects (YN0018). So NO libzip fallback
    // for a pako-reproducible cacheKey — pako refuses ⇒ defer.
    return selectPakoProfile(
      graph,
      cacheKey,
      npmTarballs,
      artifactResources,
      liveMeter,
    )
  }
  if (cacheKey === undefined) return undefined
  // ONLY a cacheKey pako can't reproduce (mixed 10 = zlib-ng, explicit `cN`) may
  // fall to the OPTIONAL `@yarnpkg/libzip` — trusted solely on a positive `match`.
  return (await calibrate(
    graph,
    cacheKey,
    npmTarballs,
    computeBerryChecksumViaLibzip,
    artifactResources,
    liveMeter,
  )) === 'match'
    ? computeBerryChecksumViaLibzip
    : undefined
}

function classifyRefurbishCandidates(
  graph: Graph,
  format: string,
  seed: ReadonlySet<NodeId> | undefined,
  cacheKey: string | undefined,
  reproducible: boolean,
  canSupply: boolean,
): RefurbishCandidate[] {
  const checksumFree = yarnBerryChecksumFreeNodes(graph, format)
  const candidates: RefurbishCandidate[] = []
  for (const node of graph.nodes()) {
    if (seed !== undefined && !seed.has(node.id)) continue
    if (node.workspacePath !== undefined) continue
    const payload: TarballPayload = graph.tarballOf(node.id) ?? {}
    const existingBerry = emitBerryChecksum(payload.integrity ?? emptyIntegrity())
    // A Berry digest is usable only in the byte domain named by its cacheKey.
    // When the requested target cacheKey differs, the node is a target-checksum
    // gap even though its source-domain digest remains valuable verification
    // evidence for the fetched npm tarball.
    if (existingBerry !== undefined
      && (payload.berryChecksumCacheKey === undefined
        || payload.berryChecksumCacheKey === cacheKey)) continue
    // Yarn's own writer leaves this entry checksum-null (the conditioned ∩
    // optionalBuilds − resolutionDependencies source rule); filling the gap
    // would only be deleted again on the next install.
    if (checksumFree.has(node.id)) continue
    // Alias-only npm entries are bare by design; their resolved target locator
    // carries the checksum in every Berry generation.
    if (isBareYarnBerryNpmAliasNode(graph, node.id)) continue
    // Fetch iff there is SOME way to a CORRECT digest — byte-reproduce it OR ask the
    // oracle for yarn's own. A patch, an indeterminable cacheKey, or neither → defer
    // (never a wrong value).
    if (node.patch !== undefined || cacheKey === undefined || (!reproducible && !canSupply)) {
      candidates.push({ kind: 'defer', id: node.id }); continue
    }
    candidates.push({ kind: 'fetch', node, payload, cacheKey })
  }
  return candidates
}

async function resolveRefurbishCandidate(
  candidate: RefurbishCandidate,
  context: RefurbishResolutionContext,
): Promise<ResolvedRefurbishment> {
  if (candidate.kind !== 'fetch') return candidate
  // Fast path: a caller-supplied digest (e.g. sha512 of yarn's own `.yarn/cache`
  // archive) skips the fetch + repack entirely. The cache FILENAME carries the
  // locator hash, not the digest — see spec/pm/yarn.md §2.3.
  let hex = context.berryChecksums !== undefined
    ? await context.berryChecksums.berryChecksum(
        candidate.node.name,
        candidate.node.version,
        candidate.cacheKey,
      )
    : undefined
  if (hex === undefined) {
    // The oracle couldn't supply. RECOMPUTE only with a calibrated backend; a
    // non-reproducible `mixed`/`cN` cacheKey DEFERS rather than write a wrong value
    // (yarn recomputes on install). The candidate existed because the oracle MIGHT
    // have supplied — it didn't, so fall back to reproduce-or-defer.
    if (context.recompute === undefined) {
      return { kind: 'defer', id: candidate.node.id }
    }
    let tgz: Uint8Array | undefined
    try {
      tgz = await loadTarball(
        context.npmTarballs,
        candidate.node,
        candidate.payload,
      )
    } catch (error) {
      if (error instanceof ArtifactByteFailure) {
        return {
          kind: 'defer',
          id: candidate.node.id,
          diagnostic: error.diagnostic,
        }
      }
      return { kind: 'defer', id: candidate.node.id }
    }
    if (tgz === undefined) return { kind: 'defer', id: candidate.node.id }
    let releaseDirect: (() => void) | undefined
    try {
      if (!hasRequestLoader(context.npmTarballs)) {
        releaseDirect = context.liveMeter.acquire(tgz.byteLength)
      }
      const limits = artifactResourceLimits(
        context.artifactResources,
        toTarballKey(candidate.node),
      )
      hex = await context.recompute(
        tgz,
        candidate.node.name,
        candidate.cacheKey,
        limits,
        context.liveMeter,
      )
    } catch (error) {
      if (error instanceof ArtifactEnvelopeError) {
        return {
          kind: 'defer',
          id: candidate.node.id,
          diagnostic: enrichArtifactLimit(
            toTarballKey(candidate.node),
            error.representation,
            error.limitBytes,
            error.origin,
          ),
        }
      }
      // e.g. parseTar rejected an unsupported entry (symlink) → defer
      return { kind: 'defer', id: candidate.node.id }
    } finally {
      releaseDirect?.()
      releaseTarball(context.npmTarballs, tgz)
    }
    // backend couldn't pack — defer
    if (hex === undefined) return { kind: 'defer', id: candidate.node.id }
  }

  // Yarn emits exactly one checksum per entry. A verified source-domain
  // berry-zip member is therefore superseded by the target-domain member;
  // retaining both would be unemittable and selecting the old first member
  // would produce bytes Yarn rejects. Unrelated tarball hashes are preserved.
  const retainedIntegrity = {
    hashes: (candidate.payload.integrity?.hashes ?? [])
      .filter(hash => hash.origin !== 'berry-zip'),
  }
  const integrity = mergeIntegrity(
    retainedIntegrity,
    { hashes: [{ algorithm: 'sha512', digest: hex, origin: 'berry-zip' }] },
  )
  // Prefix-era emit always writes `<cacheKey>/<hex>`, and reparse records that
  // prefix on the payload. Stamp the same canonical carrier at fill time so a
  // strict emit→parse probe compares equal. Bare-era v4–v7 stays undefined and
  // therefore never gains a foreign `8/`/`9/` prefix.
  const berryChecksumCacheKey = isPrefixEraFormat(context.format)
    ? candidate.cacheKey
    : undefined
  return {
    kind: 'fill',
    node: candidate.node,
    merged: { ...candidate.payload, integrity, berryChecksumCacheKey },
  }
}

function commitRefurbishments(
  graph: Graph,
  resolved: readonly ResolvedRefurbishment[],
  onDiagnostic: ((diagnostic: Diagnostic) => void) | undefined,
): RefurbishResult {
  const unresolved: Diagnostic[] = []
  const enriched: NodeId[] = []
  let next = graph
  const record = (diagnostic: Diagnostic): void => {
    next = next.mutate(mutation => { mutation.diagnostic(diagnostic) }).graph
    unresolved.push(diagnostic)
    onDiagnostic?.(diagnostic)
  }

  // Apply sequentially in node order — graph mutation is in-memory + fast, and
  // ordering keeps `enriched` / diagnostics deterministic regardless of fetch race.
  for (const result of resolved) {
    if (result.kind === 'defer') {
      if (result.diagnostic !== undefined) record(result.diagnostic)
      record(enrichChecksumDeferred(result.id))
      continue
    }
    const diagnostic = enrichFieldFilled(result.node.id, 'berryChecksum', 'recompute')
    next = next.mutate(mutation => {
      mutation.setTarball({
        name: result.node.name,
        version: result.node.version,
        patch: result.node.patch,
        source: result.node.source,
      }, result.merged)
      mutation.diagnostic(diagnostic)
    }).graph
    enriched.push(result.node.id)
    unresolved.push(diagnostic)
    onDiagnostic?.(diagnostic)
  }

  if (unresolved.length === 0) record(enrichNoop())
  return { graph: next, enriched, unresolved }
}

/**
 * Fill install-required fields the graph's own format needs (v1: the yarn-berry
 * `checksum`). `format` is the lock's own format (caller-supplied, from
 * `detect()`); `source` supplies tarball bytes for recompute.
 */
export async function refurbish(
  graph:  Graph,
  format: string,
  source: RefurbishSources | TarballSource,
  opts:   RefurbishOptions = {},
): Promise<RefurbishResult> {
  const sources      = normalizeRefurbishSources(source)
  const npmTarballs  = sources.npmTarballs
  const berryChecksums = sources.yarnBerryChecksums
  const onDiagnostic = opts.onDiagnostic
  const seed         = opts.seed
  const concurrency  = opts.concurrency ?? 16
  const liveMeter = hasRequestLoader(npmTarballs)
    ? npmTarballs.liveMeter
    : new ArtifactLiveMeter(opts.artifactResources)

  // Only yarn-berry targets have a recomputable berry `checksum`; for npm/pnpm/
  // bun the install-required integrity is already completion-filled.
  if (!isBerryFormat(format)) {
    return commitRefurbishments(graph, [], onDiagnostic)
  }

  const cacheKey = opts.cacheKey ?? berryCacheKeyFor(
    graph,
    format,
    opts.cacheKeyInference ?? 'format-default',
  )
  // byte-reproduces the `checksum` with the pinned pure-JS `pako` port for
  // STORE (`cN0`, any era) and `mixed` at cacheKey VERSION 7/8/9 (yarn 2.4 / 3.1–3.8
  // legacy match-hash; yarn-4 RC window / lockfile v7 nodejs-compatible hash —
  // `berryCacheKeyReproducible`).
  // The gate keys off the PER-LOCK cacheKey, NOT the lockfile format version: a bare-
  // era v6 lock pinned at cacheKey 8 (yarn 3.8) IS fillable once
  // `opts.cacheKey` supplies its `__metadata.cacheKey` — the bare-vs-`<cacheKey>/` emit
  // is the format's job (`checksumPrefix`), so a fill never forces a foreign prefix into
  // a bare lock. An indeterminable cacheKey (`undefined`) defers everything.
  //
  // Pick the backend that reproduces THIS lock's cache generation, PROVEN against an
  // existing sibling checksum:
  //   • the pure-JS `pako` port (STORE + mixed 7/8/9) FIRST, via `selectPakoProfile` —
  //     it also calibrates the container ENTRY ORDER (yarn builds vary: lazy tar order
  //     vs all-directories-first; not encoded in the cacheKey). Returns the matching
  //     order's recompute; `undefined` when a discriminating sibling matches neither
  //     order (a foreign build) so the gap defers rather than mis-hash.
  //   • the OPTIONAL `@yarnpkg/libzip` backend covers what pako can't (cacheKey 10 mixed,
  //     explicit `cN`) by driving yarn's OWN ZipFS byte-exact — but only for the
  //     generation its INSTALLED version was built for (libzip 3.x → cacheKey 10, its
  //     zlib-ng), so it is trusted ONLY on a positive `match`. `@yarnpkg/libzip` is an
  //     optional peer the consumer installs; absent → this branch no-ops.
  // On neither the gap defers — or the caller's `yarnBerryChecksums` oracle supplies
  // yarn's own digest below. A wrong digest hard-fails `--immutable`, strictly worse than
  // a clean omit yarn self-heals.
  const recompute = await selectChecksumStrategy(
    graph,
    cacheKey,
    npmTarballs,
    opts.artifactResources,
    liveMeter,
  )
  const reproducible = recompute !== undefined

  // 1) Gather fill candidates in content-sorted node order (deterministic).
  // A `defer` candidate carries no async work; a `fetch` candidate needs its
  // tarball. Filters (in order): seed/workspace skip; no gap → skip; a PATCHED
  // node defers (its checksum hashes the PATCHED zip — computeBerryChecksum
  // reproduces only the bare repack → wrong digest — and a SENTINEL
  // `@patch:…!builtin` (fsevents) refuses setTarball outright); a
  // non-`reproducible` era/compression defers (bare-era v4–v7 or a non-STORE
  // cacheKey — not byte-reproducible in v1,). yarn recomputes a
  // patch's / bare-era / DEFLATE checksum on install.
  // A caller-supplied `yarnBerryChecksums` oracle can hand us yarn's OWN digest
  // for a cacheKey we CAN'T byte-reproduce — the security-preserving path for a
  // `mixed` bump when yarn is installed: PIN the real integrity instead of omitting
  // it. So a non-reproducible node is still a `fetch` candidate when an oracle exists
  // (the resolved step asks it first, and DEFERS only if it can't supply).
  const candidates = classifyRefurbishCandidates(
    graph,
    format,
    seed,
    cacheKey,
    reproducible,
    berryChecksums !== undefined,
  )

  // 2) Recompute CONCURRENTLY — the bottleneck is the per-tarball fetch (network),
  // not the CPU repack. Order-preserving bounded pool.
  const context: RefurbishResolutionContext = {
    format,
    npmTarballs,
    berryChecksums,
    recompute,
    artifactResources: opts.artifactResources,
    liveMeter,
  }
  const resolved = await mapPool(
    candidates,
    concurrency,
    candidate => resolveRefurbishCandidate(candidate, context),
  )

  // 3) Commit in deterministic candidate order.
  return commitRefurbishments(graph, resolved, onDiagnostic)
}
