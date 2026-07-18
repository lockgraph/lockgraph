// ADR-0034 — enrich phase, install-completeness entry (`refurbish`).
//
// Post-completion, pre-optimize, monotone-additive: fills the install-required
// fields a freshly-bumped node lacks so the round-tripped lockfile installs
// without `yarn install`. v1's net-new fill is the yarn-berry `checksum`: for a
// node with no `berry-zip` digest, recompute one from the npm tarball bytes
// (ADR-0035 — the pure-JS `pako` port for STORE + mixed cacheKey 7/8/9, the
// optional `@yarnpkg/libzip` for cacheKey 10, each vetted by `calibrate`), else
// defer with a diagnostic. Never overwrites a present field; never fabricates.

import type { Diagnostic, Edge, Graph, Node, NodeId, TarballPayload } from '../graph.ts'
import { emptyIntegrity, emitBerryChecksum, mergeIntegrity } from '../recipe/integrity.ts'
import { berryCacheKeyReproducible, computeBerryChecksum } from '../recipe/berry-checksum.ts'
import { computeBerryChecksumViaLibzip } from '../recipe/berry-pack-libzip.ts'
import {
  isBareYarnBerryNpmAliasNode,
  rawConditionsScalarOfNode,
  rawDependenciesMetaBlockOfNode,
} from '../formats/_yarn-berry-core.ts'
import {
  enrichChecksumDeferred,
  enrichFieldFilled,
  enrichNoop,
} from './diagnostics.ts'

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
  /** Cache-key inference policy. `format-default` preserves the direct primitive's
   *  historical v8+ `10c0` fallback. Target-aware enrichment uses
   *  `observed-only` so a project generation is never guessed. */
  cacheKeyInference?: 'format-default' | 'observed-only'
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

/** Whether Yarn propagates optional-build status across this dependency edge.
 * Berry folds optionalDependencies into `dependencies` and records the bit in
 * the parent's dependenciesMeta sidecar; completion/conversion may instead
 * retain an explicit canonical `optional` edge. */
function isOptionalBuildEdge(graph: Graph, edge: Edge): boolean {
  if (edge.kind === 'optional') return true
  const dst = graph.getNode(edge.dst)
  if (dst === undefined) return false
  const dependencyName = edge.attrs?.alias ?? dst.name
  const rawMeta = rawDependenciesMetaBlockOfNode(graph, edge.src)?.[dependencyName]
  return rawMeta !== null
    && typeof rawMeta === 'object'
    && rawMeta['optional'] === 'true'
}

/** Yarn's optionalBuilds set contains packages reachable only through a path
 * that has become optional. Its delete-on-any-required-path behaviour is
 * equivalent to finding every node reachable from a workspace through only
 * non-optional edges. */
function nonOptionalReachableNodes(graph: Graph): ReadonlySet<NodeId> {
  const nodes = [...graph.nodes()]
  const workspaceRoots = nodes.filter(node => node.workspacePath !== undefined).map(node => node.id)
  const queue = workspaceRoots.length > 0 ? workspaceRoots : [...graph.roots()]
  const reachable = new Set<NodeId>()
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const nodeId = queue[cursor]!
    if (reachable.has(nodeId)) continue
    reachable.add(nodeId)
    for (const edge of graph.out(nodeId)) {
      if (!isOptionalBuildEdge(graph, edge) && !reachable.has(edge.dst)) queue.push(edge.dst)
    }
  }
  return reachable
}

/** Yarn 2.x / 3.1.x checked `accessibleLocators` before deleting a locator from
 * `optionalBuilds`. Consequently the first path to a locator wins: a later
 * required path cannot promote a node first reached through an optional path.
 * Lockfile v4/v5 are the generations with that traversal. Later generations
 * delete before the accessibility guard, which is the any-required-path set
 * returned by {@link nonOptionalReachableNodes}. */
function firstVisitRequiredNodes(graph: Graph): ReadonlySet<NodeId> {
  const nodes = [...graph.nodes()]
  const workspaceRoots = nodes.filter(node => node.workspacePath !== undefined).map(node => node.id)
  const roots = workspaceRoots.length > 0 ? workspaceRoots : [...graph.roots()]
  const accessible = new Set<NodeId>()
  const required = new Set<NodeId>()

  for (const root of roots) {
    const stack: Array<{ id: NodeId; optional: boolean }> = [{ id: root, optional: false }]
    while (stack.length > 0) {
      const current = stack.pop()!
      if (accessible.has(current.id)) continue
      accessible.add(current.id)
      if (!current.optional) required.add(current.id)
      const edges = graph.out(current.id)
      for (let index = edges.length - 1; index >= 0; index--) {
        const edge = edges[index]!
        stack.push({
          id: edge.dst,
          optional: current.optional || isOptionalBuildEdge(graph, edge),
        })
      }
    }
  }
  return required
}

function ordinaryRequiredNodes(graph: Graph, format: string): ReadonlySet<NodeId> {
  const match = /^yarn-berry-v(\d+)$/.exec(format)
  return match !== null && Number(match[1]) <= 5
    ? firstVisitRequiredNodes(graph)
    : nonOptionalReachableNodes(graph)
}

function defaultBerryNpmLocator(node: Node): string {
  return `${node.name}@npm:${node.version}`
}

function nativeOrDefaultBerryLocator(graph: Graph, node: Node): string {
  return graph.tarballOf(node.id)?.nativeResolution ?? defaultBerryNpmLocator(node)
}

/** Decode the source locator embedded in a Berry `patch:` resolution. Patch is
 * one of the two concrete resolvers that returns non-empty
 * `getResolutionDependencies`; its source package is retained even when no
 * ordinary dependency edge reaches it. */
function patchSourceLocator(node: Node, nativeResolution: string | undefined): string | undefined {
  if (node.patch === undefined || nativeResolution === undefined) return undefined
  const prefix = `${node.name}@patch:`
  if (!nativeResolution.startsWith(prefix)) return undefined
  const hash = nativeResolution.indexOf('#', prefix.length)
  if (hash < 0) return undefined
  try {
    return decodeURIComponent(nativeResolution.slice(prefix.length, hash))
  } catch {
    return undefined
  }
}

function jsrInnerName(name: string): string | undefined {
  if (!name.startsWith('@')) return `@jsr/${name}`
  const slash = name.indexOf('/')
  if (slash <= 1 || slash === name.length - 1) return undefined
  return `@jsr/${name.slice(1, slash)}__${name.slice(slash + 1)}`
}

/** Reconstruct Yarn's resolution-dependency locator set from lock-visible
 * resolver pairs. Across the bundled Berry generations every concrete
 * resolver returns an empty set except:
 *
 * - `PatchResolver` -> its embedded source descriptor;
 * - `JsrResolver` (Yarn 4.13+) -> the npm-backed `@jsr/*` inner descriptor.
 *
 * Alias/lockfile/multi resolvers only delegate to those concrete resolvers;
 * git, tarball, exec, file, portal, link, npm, workspace, and virtual do not
 * add resolution dependencies. A candidate is included only on an exact
 * lock-visible locator match, so an ambiguous same-name/version source fails
 * closed rather than minting a checksum Yarn would remove. */
function resolutionDependencyNodes(graph: Graph): ReadonlySet<NodeId> {
  const dependencies = new Set<NodeId>()
  for (const owner of graph.nodes()) {
    const native = graph.tarballOf(owner.id)?.nativeResolution
    const patchSource = patchSourceLocator(owner, native)
    if (patchSource !== undefined) {
      for (const id of graph.byName(owner.name)) {
        const candidate = graph.getNode(id)
        if (candidate === undefined || candidate.patch !== undefined) continue
        if (candidate.version !== owner.version) continue
        if (nativeOrDefaultBerryLocator(graph, candidate) === patchSource) dependencies.add(id)
      }
    }

    if (native !== `${owner.name}@jsr:${owner.version}`) continue
    const innerName = jsrInnerName(owner.name)
    if (innerName === undefined) continue
    for (const id of graph.byName(innerName)) {
      const candidate = graph.getNode(id)
      if (candidate === undefined || candidate.patch !== undefined) continue
      if (candidate.version !== owner.version) continue
      if (nativeOrDefaultBerryLocator(graph, candidate) === `${innerName}@npm:${owner.version}`) {
        dependencies.add(id)
      }
    }
  }
  return dependencies
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

/** A `Recompute` reproduces yarn's cache-zip digest for `(tgz, name, cacheKey)`,
 *  or `undefined` when its backend cannot (e.g. libzip not installed). Both the
 *  pure-JS `pako` port (via `selectPakoProfile`) and the optional `@yarnpkg/libzip`
 *  backend share this shape. */
type Recompute = (tgz: Uint8Array, name: string, cacheKey: string) => Promise<string | undefined>

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
async function calibrate(graph: Graph, cacheKey: string, source: TarballSource, recompute: Recompute): Promise<'match' | 'mismatch' | 'no-anchor'> {
  for (const node of graph.nodes()) {
    if (node.workspacePath !== undefined || node.patch !== undefined) continue
    const integrity = graph.tarballOf(node.id)?.integrity
    const existing = integrity !== undefined ? emitBerryChecksum(integrity) : undefined
    if (existing === undefined) continue                 // not an anchor (no berry-zip checksum)
    const tgz = await source.tarball(node.name, node.version)
    if (tgz === undefined) continue                      // unfetchable anchor — try another
    let repro: string | undefined
    try { repro = await recompute(tgz, node.name, cacheKey) } catch { continue }  // e.g. symlink entry — try another anchor
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
 *      order (the yarn 3.6+/4 convention, and this module's prior sole behaviour).
 *  A wrong digest hard-fails `--immutable`, so an unresolvable order defers rather
 *  than guess — never a wrong value. */
async function selectPakoProfile(graph: Graph, cacheKey: string, source: TarballSource): Promise<Recompute | undefined> {
  const mk = (dirsFirst: boolean): Recompute => (tgz, name, ck) => Promise.resolve(computeBerryChecksum(tgz, name, ck, dirsFirst))
  for (const node of graph.nodes()) {
    if (node.workspacePath !== undefined || node.patch !== undefined) continue
    const integrity = graph.tarballOf(node.id)?.integrity
    const existing = integrity !== undefined ? emitBerryChecksum(integrity) : undefined
    if (existing === undefined) continue                 // not an anchor (no berry-zip checksum)
    const tgz = await source.tarball(node.name, node.version)
    if (tgz === undefined) continue                      // unfetchable anchor — try another
    let lazy: string, dirsFirst: string
    try {
      lazy      = computeBerryChecksum(tgz, node.name, cacheKey, false)
      dirsFirst = computeBerryChecksum(tgz, node.name, cacheKey, true)
    } catch { continue }                                 // unsupported entry (symlink) — try another anchor
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

  const cacheKey = opts.cacheKey ?? berryCacheKeyFor(
    graph,
    format,
    opts.cacheKeyInference ?? 'format-default',
  )
  // ADR-0035 byte-reproduces the `checksum` with the pinned pure-JS `pako` port for
  // STORE (`cN0`, any era) and `mixed` at cacheKey VERSION 7/8/9 (yarn 2.4 / 3.1–3.8
  // legacy match-hash; yarn-4 RC window / lockfile v7 nodejs-compatible hash —
  // `berryCacheKeyReproducible`).
  // The gate keys off the PER-LOCK cacheKey, NOT the lockfile format version: a bare-
  // era v6 lock pinned at cacheKey 8 (yarn 3.8, qiwi/mware) IS fillable once
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
  //     optional peer the consumer (e.g. yaf) installs; absent → this branch no-ops.
  // On neither the gap defers — or the caller's oracle (`source.berryChecksum`) supplies
  // yarn's own digest below. A wrong digest hard-fails `--immutable`, strictly worse than
  // a clean omit yarn self-heals.
  let recompute: Recompute | undefined
  if (cacheKey !== undefined && berryCacheKeyReproducible(cacheKey)) {
    // pako OWNS STORE + mixed 7/8/9 (order-calibrated). Its verdict is FINAL: an
    // `undefined` here is an ACTIVE "this lock is foreign to pako" defer (a
    // discriminating anchor matched neither order) — NOT a cue to try a
    // different-generation backend. libzip 3.x is zlib-ng / cacheKey-10; letting it
    // fill a 7/8/9 lock (which it can license off a generation-independent STORE
    // sibling) writes cacheKey-10 bytes yarn rejects (YN0018). So NO libzip fallback
    // for a pako-reproducible cacheKey — pako refuses ⇒ defer.
    recompute = await selectPakoProfile(graph, cacheKey, source)
  } else if (cacheKey !== undefined) {
    // ONLY a cacheKey pako can't reproduce (mixed 10 = zlib-ng, explicit `cN`) may
    // fall to the OPTIONAL `@yarnpkg/libzip` — trusted solely on a positive `match`.
    if ((await calibrate(graph, cacheKey, source, computeBerryChecksumViaLibzip)) === 'match') recompute = computeBerryChecksumViaLibzip
  }
  const reproducible = recompute !== undefined

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
  // A caller-supplied oracle (`source.berryChecksum`) can hand us yarn's OWN digest
  // for a cacheKey we CAN'T byte-reproduce — the security-preserving path for a
  // `mixed` bump when yarn is installed: PIN the real integrity instead of omitting
  // it. So a non-reproducible node is still a `fetch` candidate when an oracle exists
  // (the resolved step asks it first, and DEFERS only if it can't supply).
  const canSupply = source.berryChecksum !== undefined
  const ordinaryRequired = ordinaryRequiredNodes(graph, format)
  const resolutionDependencies = resolutionDependencyNodes(graph)
  const cands: Cand[] = []
  for (const node of graph.nodes()) {
    if (seed !== undefined && !seed.has(node.id)) continue
    if (node.workspacePath !== undefined) continue
    const payload: TarballPayload = graph.tarballOf(node.id) ?? {}
    if (emitBerryChecksum(payload.integrity ?? emptyIntegrity()) !== undefined) continue
    // Source rule, invariant across Berry generations: a conditioned package
    // stays checksum-null iff it remains in `optionalBuilds` after ordinary
    // traversal. Resolution-dependency packages are removed from that set
    // before traversal (notably the bare npm source beneath fsevents' builtin
    // patch, and Yarn 4.13+'s npm-backed JSR inner package), so either signal
    // makes the gap fillable. The patched/wrapper locator itself remains bare.
    const conditioned = rawConditionsScalarOfNode(graph, node.id) !== undefined
    if (conditioned
      && !ordinaryRequired.has(node.id)
      && !resolutionDependencies.has(node.id)) continue
    // Alias-only npm entries are bare by design; their resolved target locator
    // carries the checksum in every Berry generation.
    if (isBareYarnBerryNpmAliasNode(graph, node.id)) continue
    // Fetch iff there is SOME way to a CORRECT digest — byte-reproduce it OR ask the
    // oracle for yarn's own. A patch, an indeterminable cacheKey, or neither → defer
    // (never a wrong value).
    if (node.patch !== undefined || cacheKey === undefined || (!reproducible && !canSupply)) {
      cands.push({ kind: 'defer', id: node.id }); continue
    }
    cands.push({ kind: 'fetch', node, payload, cacheKey })
  }

  // 2) Recompute CONCURRENTLY — the bottleneck is the per-tarball fetch (network),
  // not the CPU repack. Order-preserving bounded pool.
  type Resolved =
    | { kind: 'defer'; id: NodeId }
    | { kind: 'fill';  node: Node; merged: TarballPayload }
  const resolved = await mapPool(cands, concurrency, async (c): Promise<Resolved> => {
    if (c.kind !== 'fetch') return c
    // Fast path: a caller-supplied cached digest (e.g. from `.yarn/cache`, where
    // the hash is in the filename) skips the fetch + recompute entirely.
    let hex = source.berryChecksum !== undefined
      ? await source.berryChecksum(c.node.name, c.node.version, c.cacheKey)
      : undefined
    if (hex === undefined) {
      // The oracle couldn't supply. RECOMPUTE only with a calibrated backend; a
      // non-reproducible `mixed`/`cN` cacheKey DEFERS rather than write a wrong value
      // (yarn recomputes on install). The candidate existed because the oracle MIGHT
      // have supplied — it didn't, so fall back to reproduce-or-defer.
      if (recompute === undefined) return { kind: 'defer', id: c.node.id }
      const tgz = await source.tarball(c.node.name, c.node.version)
      if (tgz === undefined) return { kind: 'defer', id: c.node.id }   // no fetchable tarball
      try {
        hex = await recompute(tgz, c.node.name, c.cacheKey)           // calibrated pako (STORE / mixed 7/8/9) or libzip (10)
      } catch {
        return { kind: 'defer', id: c.node.id }   // e.g. parseTar rejected an unsupported entry (symlink) → defer
      }
      if (hex === undefined) return { kind: 'defer', id: c.node.id }   // backend couldn't pack — defer
    }
    const integrity = mergeIntegrity(
      c.payload.integrity ?? emptyIntegrity(),
      { hashes: [{ algorithm: 'sha512', digest: hex, origin: 'berry-zip' }] },
    )
    // Prefix-era emit always writes `<cacheKey>/<hex>`, and reparse records that
    // prefix on the payload. Stamp the same canonical carrier at fill time so a
    // strict emit→parse probe compares equal. Bare-era v4–v7 stays undefined and
    // therefore never gains a foreign `8/`/`9/` prefix.
    const berryChecksumCacheKey = isPrefixEraFormat(format) ? c.cacheKey : undefined
    return {
      kind: 'fill',
      node: c.node,
      merged: { ...c.payload, integrity, berryChecksumCacheKey },
    }
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
