// lockgraph — native graph-serialization format (#101).
//
// A portable, versioned serialization of the L2 Graph as a COMPACT SPARSE
// adjacency matrix + interned tables. Unlike the PM adapters (yarn-berry, npm,
// pnpm, bun) — which serialize a Graph into a *foreign* package-manager schema
// and therefore round-trip only up to that schema's expressivity — lockgraph
// serializes the canonical model itself. Its defining property is
// **graph-IDENTITY**:
//
//     parse(serialize(g)) ≡ g
//
// i.e. `g.diff(parse(serialize(g)))` is empty on EVERY axis (nodes, edges,
// changed-nodes) AND `tarballs()` iterates byte-equal, because the format
// stores the canonical model's inputs verbatim and lets `Builder.seal()`
// re-derive the secondary indices. A re-serialize of the reconstructed graph is
// byte-identical to the first (the BODY is canonical).
//
// THREE REGIONS (see spec/formats/lockgraph.md for the normative grammar):
//
//   HEADER  — volatile provenance, NOT hashed. `@lockgraph` magic + envelope
//             major, `schema major.minor`, `generatedAt` (RFC-3339 UTC), the
//             generator id, and an optional `source {format,digest}` line. A
//             reserved `registrySnapshot` slot is documented but unpopulated.
//   BODY    — canonical, deterministic. Interned tables (strings, registries,
//             packages, nodes) + the sparse hex adjacency (edges) + optional
//             layout-hints / diagnostics. Byte-identical for structurally-equal
//             graphs: every collection is content-sorted, every order is a pure
//             function of the graph, never of input bytes or wall-clock.
//   SEAL    — `seal sha256 <hex>` = sha256 over the canonical BODY ⊕ the schema
//             major. The same graph serialized twice yields an identical BODY
//             and an identical seal; only the header `generatedAt` differs (it
//             lives OUTSIDE the seal, so it never perturbs the checksum).
//
// DELIMITER: `:` (the row field separator) is safe because every inline token
// in a row is `:`-free — a `name`, a `version`, a hex digest, a small integer,
// a registry index. ANY value that can contain `:` (git/file/patch locators,
// ranges, the per-node verbatim resolution sidecar, peerContext NodeIds, the
// JSON metadata blob) is stored in the `strings[]` pool and referenced by its
// decimal index, never written inline.
//
// SCOPE (v1): the **text profile** + **L2 graph only**. The binary profile and
// the optional L1-overrides / L3-layout body sections are RESERVED — the
// version slots are present so a future reader can refuse or skip them, but v1
// neither emits nor parses them. See the spec's "Reserved" section.

import {
  newBuilder,
  toTarballKey,
  stripPeerContextFromNodeId,
  type Diagnostic,
  type Edge,
  type EdgeAttrs,
  type EdgeKind,
  type Graph,
  type LayoutHints,
  type Node,
  type NodeId,
  type TarballKey,
  type TarballKeyInputs,
  type TarballPayload,
} from '../graph.ts'
import { LockfileError } from '../errors.ts'
import { createHash } from 'node:crypto'

export const version = '0.0.0'

// === Format constants =======================================================

/** Envelope/container major — the on-the-wire framing version (region layout,
 *  escaping, seal algorithm). Bumped only when the *container* shape changes,
 *  independently of the model `schema`. */
const ENVELOPE_MAJOR = 1

/** Model schema version. Additive model changes bump the MINOR (older readers
 *  warn + ignore unknown trailing fields); breaking changes bump the MAJOR
 *  (older readers refuse with CAPABILITY_LACK). */
const SCHEMA_MAJOR = 1
const SCHEMA_MINOR = 0

const MAGIC = '@lockgraph'
const HEADER_END = '---'
const BODY_END = '---'

const GENERATOR = `@antongolub/lockfile@${version}`

// Edge-kind ↔ single-char enum. A tiny fixed alphabet keeps the adjacency rows
// compact and `:`-free. `bundled` is in the model's EdgeKind union, so it gets
// a slot even though the bundled-deps fact is normally carried on the parent's
// TarballPayload.bundledDependencies (spec/02-graph.md#bundled-deps).
const KIND_TO_CHAR: Record<EdgeKind, string> = {
  dep:      'd',
  dev:      'v',
  optional: 'o',
  peer:     'p',
  bundled:  'b',
}
const CHAR_TO_KIND: Record<string, EdgeKind> = {
  d: 'dep',
  v: 'dev',
  o: 'optional',
  p: 'peer',
  b: 'bundled',
}

// Per-edge boolean flags, packed into one `:`-free token of flag letters (empty
// token = no flags). `optional` and `workspace` are the two booleans on
// EdgeAttrs; `range`, `alias`, `workspaceRange` are ref-encoded separately.
const FLAG_OPTIONAL = 'o'
const FLAG_WORKSPACE = 'w'

// === Determinism helpers ====================================================

const cmpStr = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

// Canonical JSON: object keys recursively sorted so structurally-equal values
// serialize to byte-identical strings. Arrays keep order (order is meaningful
// for the integrity multiset and peerContext). `undefined` object properties
// are dropped (they are absent on the model, never JSON-null). This is the
// single chokepoint that lets arbitrary TarballPayload shapes — including
// `funding: unknown`, the `bin: string | Record`, the cpu/os/libc arrays, and
// the ResolutionCanonical discriminated union — round-trip identity-exact
// without a bespoke per-field encoder.
function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value))
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(value as Record<string, unknown>).sort(cmpStr)) {
      const v = (value as Record<string, unknown>)[k]
      if (v !== undefined) out[k] = sortDeep(v)
    }
    return out
  }
  return value
}

// === Line escaping ==========================================================
//
// Interned strings are written one-per-line, so a literal newline inside a
// value (possible in a `funding` blob or an exotic resolution) would corrupt
// the line framing. Escape the four bytes that matter for line/field safety.
// `:` is NOT escaped — interned strings are addressed by index, never split on
// `:`, so a colon inside an interned value is harmless.

function escapeLine(s: string): string {
  let out = ''
  for (const ch of s) {
    if (ch === '\\') out += '\\\\'
    else if (ch === '\n') out += '\\n'
    else if (ch === '\r') out += '\\r'
    else if (ch === '\t') out += '\\t'
    else out += ch
  }
  return out
}

function unescapeLine(s: string): string {
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (ch === '\\' && i + 1 < s.length) {
      const n = s[i + 1]
      if (n === '\\') { out += '\\'; i++ }
      else if (n === 'n') { out += '\n'; i++ }
      else if (n === 'r') { out += '\r'; i++ }
      else if (n === 't') { out += '\t'; i++ }
      else { out += ch }
    } else {
      out += ch
    }
  }
  return out
}

// === String interner ========================================================
//
// Two-phase: callers `intern()` every `:`-containing or repeated value during a
// pre-pass; `finalize()` then content-sorts the pool and assigns each string
// its final decimal index. Sorting is what makes the table byte-identical for
// structurally-equal graphs regardless of insertion order. A second resolve
// pass reads the final index for each value.

class Interner {
  private readonly set = new Set<string>()
  private index?: Map<string, number>
  private ordered?: string[]

  intern(value: string): void {
    this.set.add(value)
  }

  finalize(): void {
    const ordered = Array.from(this.set).sort(cmpStr)
    const index = new Map<string, number>()
    for (let i = 0; i < ordered.length; i++) index.set(ordered[i]!, i)
    this.ordered = ordered
    this.index = index
  }

  ref(value: string): number {
    const idx = this.index?.get(value)
    if (idx === undefined) {
      throw new LockfileError({
        code: 'INVARIANT_VIOLATION',
        message: `lockgraph: interned string not registered before finalize: ${JSON.stringify(value)}`,
      })
    }
    return idx
  }

  table(): string[] {
    return this.ordered ?? []
  }
}

// Registry/source hosts get their OWN interned table (the concept's
// `registries[]`): few distinct hosts, many references — interning them
// separately from the general `strings[]` pool keeps package rows pointing at a
// tiny dense index space and surfaces the host set as a first-class section.
// Same two-phase content-sort discipline as `Interner`.
class RegistryInterner {
  private readonly inner = new Interner()
  intern(value: string): void { this.inner.intern(value) }
  finalize(): void { this.inner.finalize() }
  ref(value: string): number { return this.inner.ref(value) }
  table(): string[] { return this.inner.table() }
}

// === Hex helpers (sparse adjacency node indices) ============================

const toHex = (n: number): string => n.toString(16)
const fromHex = (s: string): number => parseInt(s, 16)

// =====================================================================================
// SERIALIZE
// =====================================================================================

export interface LockgraphStringifyOptions {
  lineEnding?: 'lf' | 'crlf'
  /** Provenance of the source the graph was parsed from — written verbatim into
   *  the (un-hashed) header `source` line. Pure attribution. */
  source?: { format: string; digest?: string }
  /** Override the header `generatedAt` timestamp (RFC-3339 UTC, second
   *  precision). Defaults to `new Date()`. Pinning it makes the WHOLE output
   *  byte-stable (the BODY + seal already are); useful for golden tests. */
  generatedAt?: string
  onDiagnostic?: (d: Diagnostic) => void
}

export function stringify(graph: Graph, options: LockgraphStringifyOptions = {}): string {
  const eol = options.lineEnding === 'crlf' ? '\r\n' : '\n'

  // ---- Collect the canonical model in deterministic order ------------------
  // graph.nodes() / graph.tarballs() already iterate content-sorted
  // (spec/02-graph.md#iteration-order); we lean on that for determinism and
  // assign the dense node index from that order.
  const nodes = Array.from(graph.nodes())
  const nodeIndex = new Map<NodeId, number>()
  for (let i = 0; i < nodes.length; i++) nodeIndex.set(nodes[i]!.id, i)

  const tarballs = Array.from(graph.tarballs()) // [TarballKey, payload], key-sorted

  // ---- Build the package table (one row per TarballKey) --------------------
  // Each node maps to a package row via its TarballKey. A package row owns the
  // common-case integrity digest + cacheKey + resolution columns, with a JSON
  // residual blob for anything those columns do not capture.
  const pkgKeys = tarballs.map(([k]) => k)
  const pkgIndexByKey = new Map<TarballKey, number>()
  for (let i = 0; i < pkgKeys.length; i++) pkgIndexByKey.set(pkgKeys[i]!, i)

  // A node may reference a TarballKey that has no tarball payload (workspace
  // nodes carry none; pre-enrich graphs may lack one). Such keys still need a
  // package row so the node can point at name/version. Append them after the
  // payload-bearing keys, key-sorted, so the table stays a pure function of the
  // graph.
  const extraKeys: TarballKey[] = []
  for (const node of nodes) {
    const key = toTarballKey(tarballKeyInputsOf(node))
    if (!pkgIndexByKey.has(key)) {
      pkgIndexByKey.set(key, -1) // placeholder; real index assigned below
      extraKeys.push(key)
    }
  }
  extraKeys.sort(cmpStr)
  for (const key of extraKeys) {
    pkgIndexByKey.set(key, pkgKeys.length)
    pkgKeys.push(key)
  }
  const payloadByKey = new Map<TarballKey, TarballPayload>(tarballs)

  // ---- Phase 1: intern every `:`-containing / repeated value ---------------
  const strings = new Interner()
  const registries = new RegistryInterner()

  // Package-row derived fields, computed once and reused in phase 2.
  //
  // COMPACTION — the package row factors the *common* payload shape into typed
  // inline columns so the dominant case (a single integrity hash + a berry
  // cacheKey + a derivable npmjs registry URL) costs a bare hex digest and two
  // one-char codes, NOT a verbose JSON blob. Only the residual — fields not
  // captured by a dedicated column, OR a multi-hash integrity — falls back to
  // the interned `metaJson`. This is the "integrity/hash lives in the row ONCE"
  // rule taken to its compact conclusion.
  interface PkgFields {
    name: string
    version: string
    patchToken?: string  // the `+patch=…` slot value (canonical hex or sentinel)
    srcToken?: string    // the `+src=…` slot value (16-hex source discriminator,
                         // ADR-0032) — distinguishes non-registry nodes sharing
                         // name@version; `undefined` for the registry/ws majority
    digest?: string      // single integrity hash, inline hex (the "hash" column)
    originCode?: string  // 1-char origin of `digest` (see ORIGIN_TO_CODE)
    cacheKey?: string    // berryChecksumCacheKey (interned in `registries` — it
                         // is a tiny, hugely-repeated token like "10" / "10c0")
    resInline: string    // resolution-canonical code: '-' none | '=' derived
                         // npmjs tarball URL | the canonical-JSON (interned)
    metaJson?: string    // canonical JSON of the RESIDUAL payload, '-' when empty
  }
  const pkgFields: PkgFields[] = pkgKeys.map(key => {
    const { name, version, patch, src } = parseTarballKey(key)
    const payload = payloadByKey.get(key)
    const fields: PkgFields = { name, version, resInline: '-' }
    if (patch !== undefined) fields.patchToken = patch
    if (src !== undefined) fields.srcToken = src
    if (payload !== undefined) {
      // Residual = a shallow copy of the payload minus the fields the dedicated
      // columns capture. We mutate a copy, never the source payload.
      const residual: Record<string, unknown> = { ...payload }

      // --- integrity: single hash → inline columns; multi-hash → residual ---
      const integrity = payload.integrity
      if (integrity !== undefined && integrity.hashes.length === 1) {
        const h = integrity.hashes[0]!
        fields.digest = h.digest
        fields.originCode = ORIGIN_TO_CODE[h.origin] ?? CODE_ORIGIN_OTHER
        if (fields.originCode === CODE_ORIGIN_OTHER) {
          // Unknown/forward-compat origin — keep the full integrity in residual
          // so the exact origin string survives, and drop the inline columns.
          delete fields.digest
          delete fields.originCode
        } else if (h.algorithm === 'sha512') {
          delete residual.integrity // fully captured by digest+origin (algo implied sha512)
        } else {
          // A non-sha512 single hash: the inline column implies sha512, so it
          // cannot carry this algorithm. Drop the inline columns and keep the
          // whole hash in the residual blob so the algorithm round-trips exactly.
          residual.integrity = { hashes: [{ algorithm: h.algorithm, digest: h.digest, origin: h.origin }] }
          delete fields.digest
          delete fields.originCode
        }
      }

      // --- berryChecksumCacheKey: dedicated interned column ---
      if (payload.berryChecksumCacheKey !== undefined) {
        fields.cacheKey = payload.berryChecksumCacheKey
        delete residual.berryChecksumCacheKey
      }

      // --- resolution canonical: derived-URL sentinel or interned JSON ---
      const res = payload.resolution
      if (res !== undefined) {
        if (res.type === 'tarball' && res.hostingProvider === undefined &&
            res.url === derivedRegistryUrl(name, version)) {
          fields.resInline = RES_DERIVED // '=' — reconstruct from name+version
          delete residual.resolution
        } else {
          fields.resInline = canonicalJson(res)
          delete residual.resolution
        }
      }

      // --- residual meta blob (everything else) ---
      const meta = pruneUndefined(residual)
      if (Object.keys(meta).length > 0) fields.metaJson = canonicalJson(meta)
    }
    return fields
  })

  for (const f of pkgFields) {
    // `version` is interned (ref-encoded) because it is NOT a `:`-free simple
    // token in real locks — a `file:` / `github:` / `https:` locator lands in
    // the version position for non-registry resolutions and would otherwise
    // shatter the `:`-delimited row. `name` stays inline (npm/yarn/pnpm names
    // are `:`-free + `+`-free by the registry name grammar). Interning also
    // dedups versions shared across peer-virt siblings.
    strings.intern(f.version)
    if (f.metaJson !== undefined) strings.intern(f.metaJson)
    if (f.cacheKey !== undefined) registries.intern(f.cacheKey)
    if (f.resInline !== '-' && f.resInline !== RES_DERIVED) strings.intern(f.resInline)
  }

  // Node-row fields: peerContext (list of NodeId strings), the verbatim
  // resolution sidecar, the workspacePath. All can contain `:` / `@`.
  // The per-node verbatim `resolution` sidecar is the berry locator
  // `<name>@npm:<version>` for the registry common case — fully derivable from
  // (name, version), so it gets the `=` sentinel instead of an interned string
  // (reclaims ~125 KB on backstage). Any other shape (workspace/git/patch
  // locator) is interned verbatim.
  for (const node of nodes) {
    for (const p of node.peerContext) strings.intern(p)
    if (node.resolution !== undefined && node.resolution !== derivedNodeResolution(node.name, node.version)) {
      strings.intern(node.resolution)
    }
    if (node.workspacePath !== undefined) strings.intern(node.workspacePath)
    if (node.peerContext.length > 0) strings.intern(canonicalJson(node.peerContext))
  }

  // Edge attrs: range, alias, and the workspaceRange canonical pair.
  const edges = collectEdges(graph, nodes)
  for (const e of edges) {
    if (e.attrs?.range !== undefined) strings.intern(e.attrs.range)
    if (e.attrs?.alias !== undefined) strings.intern(e.attrs.alias)
    if (e.attrs?.workspaceRange !== undefined) strings.intern(canonicalJson(e.attrs.workspaceRange))
  }

  // Layout hints + diagnostics — interned as canonical JSON blobs.
  const hints = graph.layoutHints()
  const hintsJson = hints !== undefined ? canonicalJson(hints) : undefined
  if (hintsJson !== undefined) strings.intern(hintsJson)

  // Diagnostics are NOT part of graph identity (diff ignores them) but the
  // format preserves the ADAPTER-emitted ones for fidelity. We EXCLUDE the
  // seal-re-derived family (`SEAL_*`, emitted by the graph's own `validate()`
  // on every `seal()` — e.g. `SEAL_PUBLISHED_SELF_LINK`): persisting them would
  // double-count, because reconstruction re-seals and the seal regenerates them.
  // Filtering them out keeps the round-trip diagnostic set IDENTICAL (adapter
  // diags replayed pre-seal, then the seal re-appends the `SEAL_*` ones in the
  // same trailing position) and makes the body byte-stable. The `SEAL_` prefix
  // is the convention for seal-derived diagnostics (see graph.ts `validate`).
  const diagnostics = Array.from(graph.diagnostics()).filter(d => !isSealDerivedDiagnostic(d.code))
  const diagJsons = diagnostics.map(d => canonicalJson(d))
  for (const dj of diagJsons) strings.intern(dj)

  strings.finalize()
  registries.finalize()

  // ---- Phase 2: emit the BODY ----------------------------------------------
  const body: string[] = []

  // strings[] table
  const strTable = strings.table()
  body.push(`S ${strTable.length}`)
  for (const s of strTable) body.push(escapeLine(s))

  // registries[] table
  const regTable = registries.table()
  body.push(`R ${regTable.length}`)
  for (const r of regTable) body.push(escapeLine(r))

  // packages[] table — name:verref:patch:src:digest:origin:ckref:res:metaref
  // `name` is inline (`:`-free by the registry name grammar); `verref` is a
  // `strings` index (versions may be `file:`/`github:`/`https:` locators). Empty
  // slots are the literal `-` sentinel. digest is inline hex; origin is a 1-char
  // code; ckref is a `registries` index (the cacheKey pool); patch is the inline
  // `+patch=` slot token (canonical hex or `unresolved-…` sentinel — both
  // `:`-free); src is the inline `+src=` slot token (16-hex source discriminator,
  // ADR-0032 — `:`-free; `-` for the registry/workspace majority); res is `-` |
  // `=` (derived URL) | a `strings` index; metaref is a `strings` index. Every
  // inline token is `:`-free.
  body.push(`P ${pkgKeys.length}`)
  for (const f of pkgFields) {
    const verRef = String(strings.ref(f.version))
    const patchRef = f.patchToken ?? '-'
    const srcRef = f.srcToken ?? '-'
    const digest = f.digest ?? '-'
    const origin = f.originCode ?? '-'
    const ckRef = f.cacheKey !== undefined ? String(registries.ref(f.cacheKey)) : '-'
    const resTok = f.resInline === '-' || f.resInline === RES_DERIVED
      ? f.resInline
      : String(strings.ref(f.resInline))
    const metaRef = f.metaJson !== undefined ? String(strings.ref(f.metaJson)) : '-'
    body.push(`${f.name}:${verRef}:${patchRef}:${srcRef}:${digest}:${origin}:${ckRef}:${resTok}:${metaRef}`)
  }

  // nodes[] table — pkgref:peerctxref:wsref:res
  // pkgref is the package-row index (decimal). peerctxref points at the
  // canonical-JSON peerContext array (or `-`). wsref is a strings index (or `-`).
  // res is `-` (none) | `=` (equals the derived `<name>@npm:<version>` locator)
  // | a strings index. name/version/patch live on the package row (join via
  // pkgref) and are not repeated here.
  body.push(`N ${nodes.length}`)
  for (const node of nodes) {
    const key = toTarballKey(tarballKeyInputsOf(node))
    const pkgRef = pkgIndexByKey.get(key)!
    const peerRef = node.peerContext.length > 0
      ? String(strings.ref(canonicalJson(node.peerContext)))
      : '-'
    const wsRef = node.workspacePath !== undefined ? String(strings.ref(node.workspacePath)) : '-'
    let resTok = '-'
    if (node.resolution !== undefined) {
      resTok = node.resolution === derivedNodeResolution(node.name, node.version)
        ? RES_DERIVED
        : String(strings.ref(node.resolution))
    }
    body.push(`${pkgRef}:${peerRef}:${wsRef}:${resTok}`)
  }

  // edges — SPARSE hex adjacency. One line per source node that HAS outgoing
  // edges: `<srcHex>:<dstHex>/<kind>/<rangeref>/<aliasref>/<flags>/<wsrangeref>,…`
  // Sources with no out-edges emit no line (sparse). Neighbor groups are
  // comma-joined; each neighbor's fields are `/`-joined. Refs are `-` when
  // absent. This is the adjacency-matrix-as-sparse-rows the concept fixes.
  const adjacency = buildAdjacency(edges, nodeIndex, strings)
  body.push(`E ${adjacency.length}`)
  for (const line of adjacency) body.push(line)

  // layout-hints — single optional line `H <ref>` (`-` when absent).
  body.push(`H ${hintsJson !== undefined ? String(strings.ref(hintsJson)) : '-'}`)

  // diagnostics — `D <count>` then one strings-ref per diagnostic.
  body.push(`D ${diagJsons.length}`)
  for (const dj of diagJsons) body.push(String(strings.ref(dj)))

  const bodyText = body.join('\n')

  // ---- SEAL: sha256 over canonical BODY ⊕ schema-major ---------------------
  const seal = sealOf(bodyText)

  // ---- HEADER (volatile, NOT hashed) ---------------------------------------
  const generatedAt = options.generatedAt ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  const header: string[] = []
  header.push(`${MAGIC} ${ENVELOPE_MAJOR}`)
  header.push(`schema ${SCHEMA_MAJOR}.${SCHEMA_MINOR}`)
  header.push(`generatedAt ${generatedAt}`)
  header.push(`generator ${GENERATOR}`)
  if (options.source !== undefined) {
    const digest = options.source.digest ?? '-'
    header.push(`source ${options.source.format} ${digest}`)
  }
  // RESERVED (documented, unpopulated): `resolution registrySnapshot …`.

  const out = [...header, HEADER_END, bodyText, BODY_END, `seal sha256 ${seal}`].join(eol)
  return out + eol
}

// =====================================================================================
// PARSE
// =====================================================================================

export interface LockgraphParseOptions {
  onDiagnostic?: (d: Diagnostic) => void
}

export function parse(input: string, options: LockgraphParseOptions = {}): Graph {
  const onDiagnostic = options.onDiagnostic
  // Normalise CRLF → LF so a CRLF-round-tripped file parses identically; the
  // seal was computed over the LF-joined BODY regardless of the emitted EOL.
  const lines = input.replace(/\r\n/g, '\n').split('\n')

  let i = 0
  const peek = (): string | undefined => lines[i]
  const next = (): string => {
    const l = lines[i]
    if (l === undefined) {
      throw new LockfileError({ code: 'PARSE_FAILED', message: 'lockgraph: unexpected end of input' })
    }
    i++
    return l
  }

  // ---- HEADER --------------------------------------------------------------
  const magicLine = next()
  const magicParts = magicLine.split(' ')
  if (magicParts[0] !== MAGIC) {
    throw new LockfileError({ code: 'PARSE_FAILED', message: `lockgraph: missing ${MAGIC} magic` })
  }
  const envelopeMajor = Number(magicParts[1])
  if (!Number.isFinite(envelopeMajor) || envelopeMajor > ENVELOPE_MAJOR) {
    throw new LockfileError({
      code: 'CAPABILITY_LACK',
      message: `lockgraph: envelope major ${magicParts[1]} newer than supported ${ENVELOPE_MAJOR}`,
    })
  }

  let schemaMajor = SCHEMA_MAJOR
  // Walk the rest of the header until the HEADER_END marker.
  while (peek() !== undefined && peek() !== HEADER_END) {
    const line = next()
    const sp = line.indexOf(' ')
    const key = sp === -1 ? line : line.slice(0, sp)
    const rest = sp === -1 ? '' : line.slice(sp + 1)
    if (key === 'schema') {
      const major = Number(rest.split('.')[0])
      if (Number.isFinite(major)) schemaMajor = major
      if (Number.isFinite(major) && major > SCHEMA_MAJOR) {
        throw new LockfileError({
          code: 'CAPABILITY_LACK',
          message: `lockgraph: schema major ${rest} newer than supported ${SCHEMA_MAJOR}`,
        })
      }
    }
    // generatedAt / generator / source / reserved slots: provenance only,
    // ignored on parse (they are not graph facts).
  }
  if (next() !== HEADER_END) {
    throw new LockfileError({ code: 'PARSE_FAILED', message: 'lockgraph: missing header terminator' })
  }

  // ---- BODY ----------------------------------------------------------------
  const bodyStart = i
  const expectSection = (letter: string): number => {
    const line = next()
    const sp = line.indexOf(' ')
    const key = sp === -1 ? line : line.slice(0, sp)
    const count = sp === -1 ? NaN : Number(line.slice(sp + 1))
    if (key !== letter || !Number.isFinite(count)) {
      throw new LockfileError({
        code: 'PARSE_FAILED',
        message: `lockgraph: expected '${letter} <count>' section, got: ${line}`,
      })
    }
    return count
  }

  // strings[]
  const sCount = expectSection('S')
  const strTable: string[] = []
  for (let k = 0; k < sCount; k++) strTable.push(unescapeLine(next()))
  const str = (ref: string): string => {
    const idx = Number(ref)
    const v = strTable[idx]
    if (v === undefined) {
      throw new LockfileError({ code: 'PARSE_FAILED', message: `lockgraph: string ref ${ref} out of range` })
    }
    return v
  }
  const strOpt = (ref: string): string | undefined => (ref === '-' ? undefined : str(ref))

  // registries[]
  const rCount = expectSection('R')
  const regTable: string[] = []
  for (let k = 0; k < rCount; k++) regTable.push(unescapeLine(next()))
  const regOpt = (ref: string): string | undefined => {
    if (ref === '-') return undefined
    const v = regTable[Number(ref)]
    if (v === undefined) {
      throw new LockfileError({ code: 'PARSE_FAILED', message: `lockgraph: registry ref ${ref} out of range` })
    }
    return v
  }

  // packages[]
  const pCount = expectSection('P')
  interface PkgRow {
    name: string
    version: string
    patchToken?: string
    srcToken?: string
    digest?: string
    originCode?: string
    cacheKey?: string
    resInline?: string // '-' | '=' | canonical JSON
    metaJson?: string
  }
  const pkgRows: PkgRow[] = []
  for (let k = 0; k < pCount; k++) {
    // name:verref:patch:src:digest:origin:ckref:res:metaref — `name` is the only
    // inline `:`-free field, so split into exactly 9 fields (the name cannot
    // contain `:`; every other column is a ref/code/hex/sentinel, all `:`-free).
    const parts = next().split(':')
    const [name, verRef, patchRef, srcRef, digest, origin, ckRef, resTok, metaRef] = parts
    if (name === undefined || verRef === undefined || patchRef === undefined || srcRef === undefined ||
        digest === undefined || origin === undefined || ckRef === undefined || resTok === undefined ||
        metaRef === undefined) {
      throw new LockfileError({ code: 'PARSE_FAILED', message: `lockgraph: malformed package row: ${parts.join(':')}` })
    }
    const row: PkgRow = { name, version: str(verRef) }
    if (patchRef !== '-') row.patchToken = patchRef
    if (srcRef !== '-') row.srcToken = srcRef
    if (digest !== '-') row.digest = digest
    if (origin !== '-') row.originCode = origin
    const ck = regOpt(ckRef)
    if (ck !== undefined) row.cacheKey = ck
    // res token: '-' none | '=' derived | strings-ref → canonical JSON
    if (resTok === RES_DERIVED) row.resInline = RES_DERIVED
    else if (resTok !== '-') row.resInline = str(resTok)
    const meta = strOpt(metaRef)
    if (meta !== undefined) row.metaJson = meta
    pkgRows.push(row)
  }

  // nodes[]
  const nCount = expectSection('N')
  interface NodeRow {
    pkgRef: number
    peerContext: NodeId[]
    workspacePath?: string
    resolution?: string
    resDerived?: boolean // res token was '=' → expand from (name, version)
  }
  const nodeRows: NodeRow[] = []
  for (let k = 0; k < nCount; k++) {
    const parts = next().split(':')
    const [pkgRef, peerRef, wsRef, resTok] = parts
    if (pkgRef === undefined || peerRef === undefined || wsRef === undefined || resTok === undefined) {
      throw new LockfileError({ code: 'PARSE_FAILED', message: `lockgraph: malformed node row: ${parts.join(':')}` })
    }
    const row: NodeRow = {
      pkgRef: Number(pkgRef),
      peerContext: peerRef === '-' ? [] : (JSON.parse(str(peerRef)) as NodeId[]),
    }
    const ws = strOpt(wsRef)
    if (ws !== undefined) row.workspacePath = ws
    if (resTok === RES_DERIVED) row.resDerived = true
    else if (resTok !== '-') row.resolution = str(resTok)
    nodeRows.push(row)
  }

  // edges — sparse hex adjacency
  const eCount = expectSection('E')
  interface EdgeRow { src: number; dst: number; kind: EdgeKind; attrs?: EdgeAttrs }
  const edgeRows: EdgeRow[] = []
  for (let k = 0; k < eCount; k++) {
    const line = next()
    const colon = line.indexOf(':')
    if (colon === -1) {
      throw new LockfileError({ code: 'PARSE_FAILED', message: `lockgraph: malformed edge line: ${line}` })
    }
    const srcHex = line.slice(0, colon)
    const src = fromHex(srcHex)
    const neighbors = line.slice(colon + 1).split(',')
    for (const nb of neighbors) {
      // dstHex/kind/rangeref/aliasref/flags/wsrangeref
      const f = nb.split('/')
      const [dstHex, kindChar, rangeRef, aliasRef, flags, wsRangeRef] = f
      if (dstHex === undefined || kindChar === undefined) {
        throw new LockfileError({ code: 'PARSE_FAILED', message: `lockgraph: malformed neighbor: ${nb}` })
      }
      const kind = CHAR_TO_KIND[kindChar]
      if (kind === undefined) {
        throw new LockfileError({ code: 'PARSE_FAILED', message: `lockgraph: unknown edge-kind char '${kindChar}'` })
      }
      const attrs: EdgeAttrs = {}
      const range = rangeRef !== undefined ? strOpt(rangeRef) : undefined
      if (range !== undefined) attrs.range = range
      const alias = aliasRef !== undefined ? strOpt(aliasRef) : undefined
      if (alias !== undefined) attrs.alias = alias
      if (flags !== undefined) {
        if (flags.includes(FLAG_OPTIONAL)) attrs.optional = true
        if (flags.includes(FLAG_WORKSPACE)) attrs.workspace = true
      }
      const wsRange = wsRangeRef !== undefined ? strOpt(wsRangeRef) : undefined
      if (wsRange !== undefined) {
        attrs.workspaceRange = JSON.parse(wsRange) as EdgeAttrs['workspaceRange']
      }
      const row: EdgeRow = { src, dst: fromHex(dstHex), kind }
      if (Object.keys(attrs).length > 0) row.attrs = attrs
      edgeRows.push(row)
    }
  }

  // layout hints
  const hLine = next()
  if (!hLine.startsWith('H ')) {
    throw new LockfileError({ code: 'PARSE_FAILED', message: `lockgraph: expected 'H <ref>', got: ${hLine}` })
  }
  const hRef = hLine.slice(2)
  const hints: LayoutHints | undefined =
    hRef === '-' ? undefined : (JSON.parse(str(hRef)) as LayoutHints)

  // diagnostics
  const dCount = expectSection('D')
  const parsedDiagnostics: Diagnostic[] = []
  for (let k = 0; k < dCount; k++) {
    parsedDiagnostics.push(JSON.parse(str(next())) as Diagnostic)
  }

  const bodyEndIdx = i
  if (next() !== BODY_END) {
    throw new LockfileError({ code: 'PARSE_FAILED', message: 'lockgraph: missing body terminator' })
  }

  // ---- SEAL verification ---------------------------------------------------
  const sealLine = next()
  const sealParts = sealLine.split(' ')
  if (sealParts[0] !== 'seal' || sealParts[1] !== 'sha256' || sealParts[2] === undefined) {
    throw new LockfileError({ code: 'PARSE_FAILED', message: `lockgraph: malformed seal line: ${sealLine}` })
  }
  const bodyText = lines.slice(bodyStart, bodyEndIdx).join('\n')
  const expectedSeal = sealOf(bodyText, schemaMajor)
  if (sealParts[2] !== expectedSeal) {
    throw new LockfileError({
      code: 'PARSE_FAILED',
      message: `lockgraph: seal mismatch — body checksum ${expectedSeal} ≠ recorded ${sealParts[2]} (corrupt or tampered body)`,
    })
  }

  // ---- Rebuild the Graph via the Builder -----------------------------------
  const builder = newBuilder()

  // Reconstruct each TarballPayload from its package row, keyed by TarballKey.
  // setTarball is fed only for rows that carry a payload (a digest, a meta
  // blob) — workspace / payload-less rows produce no tarball entry, matching
  // the source graph where `graph.tarball(...)` was undefined.
  for (const row of pkgRows) {
    const payload = rebuildPayload(row)
    if (payload === undefined) continue
    const inputs: TarballKeyInputs = { name: row.name, version: row.version }
    if (row.patchToken !== undefined) inputs.patch = row.patchToken
    if (row.srcToken !== undefined) inputs.source = row.srcToken
    builder.setTarball(inputs, payload)
  }

  // Reconstruct nodes. The NodeId is re-derived from (name, version,
  // peerContext, patch) exactly as the model does — so seal() re-validates the
  // id↔peerContext coherence and we never trust a stored id blindly.
  //
  // KEY-ORDER NOTE — graph-identity requires the reconstructed Node to be
  // byte-equal under `Graph.diff`, whose `nodeEqual` is `JSON.stringify`-based
  // and therefore KEY-ORDER-SENSITIVE. We assemble the optional fields in the
  // canonical order the library's adapters emit — `resolution`, then `patch`,
  // then `source`, then `workspacePath` — via `assembleNode`. _yarn-berry-core
  // is the adapter that co-occurs the most optional Node fields and fixes this
  // order: a non-registry node carries `resolution` then `source` (ADR-0032), a
  // patched node `resolution` then `patch`, a workspace node `resolution` then
  // `workspacePath`. Matching it makes `g.diff(parse(serialize(g)))` empty for
  // graphs produced by ANY of this library's parsers. (pnpm / npm / bun never
  // co-occur these fields, so their order is order-insensitive.)
  const nodeIdByDense: NodeId[] = []
  for (const nr of nodeRows) {
    const pkg = pkgRows[nr.pkgRef]
    if (pkg === undefined) {
      throw new LockfileError({ code: 'PARSE_FAILED', message: `lockgraph: node pkgRef ${nr.pkgRef} out of range` })
    }
    const resolution = nr.resDerived === true
      ? derivedNodeResolution(pkg.name, pkg.version)
      : nr.resolution
    const node = assembleNode(
      deriveNodeId(pkg.name, pkg.version, nr.peerContext, pkg.patchToken, pkg.srcToken),
      pkg.name,
      pkg.version,
      nr.peerContext,
      resolution,
      pkg.patchToken,
      pkg.srcToken,
      nr.workspacePath,
    )
    builder.addNode(node)
    nodeIdByDense.push(node.id)
  }

  // Reconstruct edges from the dense indices.
  for (const er of edgeRows) {
    const srcId = nodeIdByDense[er.src]
    const dstId = nodeIdByDense[er.dst]
    if (srcId === undefined || dstId === undefined) {
      throw new LockfileError({ code: 'PARSE_FAILED', message: `lockgraph: edge index out of range (${er.src}→${er.dst})` })
    }
    builder.addEdge(srcId, dstId, er.kind, er.attrs)
  }

  if (hints !== undefined) builder.layoutHints(hints)
  for (const d of parsedDiagnostics) builder.diagnostic(d)

  const graph = builder.seal()
  if (onDiagnostic !== undefined) {
    for (const d of graph.diagnostics()) onDiagnostic(d)
  }
  return graph
}

// =====================================================================================
// CHECK / detect discriminant
// =====================================================================================

/** True iff `input` is a lockgraph document — the `@lockgraph` magic is the
 *  first token of the first line. Cheap, allocation-light: only the head is
 *  inspected, so this sits at the top of the format detect order. */
export function check(input: string): boolean {
  // Skip a leading BOM if present, then test the first token.
  const head = input.charCodeAt(0) === 0xFEFF ? input.slice(1) : input
  return head.startsWith(MAGIC + ' ') || head.startsWith(MAGIC + '\n') || head.startsWith(MAGIC + '\r')
}

// =====================================================================================
// Internal helpers
// =====================================================================================

// Mirrors graph.ts `tarballKeyInputsOfNode` — capture EVERY slot carrier on the
// node so the re-derived TarballKey is byte-exact. ADR-0032 added `source` (the
// `+src=` slot) beside `patch`; both must be threaded or non-registry nodes
// sharing `name@version` collapse to one key.
function tarballKeyInputsOf(node: Node): TarballKeyInputs {
  const inputs: TarballKeyInputs = { name: node.name, version: node.version }
  if (node.patch !== undefined) inputs.patch = node.patch
  if (node.source !== undefined) inputs.source = node.source
  return inputs
}

// A diagnostic the graph's own `seal()` re-derives (the `SEAL_*` family emitted
// by `validate()`). These are NOT persisted in the lockgraph body — the seal
// regenerates them on reconstruction, so persisting them would double-count.
function isSealDerivedDiagnostic(code: string): boolean {
  return code.startsWith('SEAL_')
}

// Assemble a Node with the canonical key insertion order the library's adapters
// emit (`…, resolution, patch, source, workspacePath`). See the KEY-ORDER NOTE
// at the reconstruction call site for why this exact order matters for
// graph-identity. ADR-0032 places `source` AFTER `patch` and BEFORE
// `workspacePath` — matching _yarn-berry-core's node construction (the only
// adapter where `resolution` + `source` co-occur on the same node).
function assembleNode(
  id: NodeId,
  name: string,
  version: string,
  peerContext: NodeId[],
  resolution: string | undefined,
  patch: string | undefined,
  source: string | undefined,
  workspacePath: string | undefined,
): Node {
  const node: Node = { id, name, version, peerContext }
  if (resolution !== undefined) node.resolution = resolution
  if (patch !== undefined) node.patch = patch
  if (source !== undefined) node.source = source
  if (workspacePath !== undefined) node.workspacePath = workspacePath
  return node
}

// Decompose a TarballKey `<name>@<version>[+patch=<token>][+src=<token>]` back
// into parts. There are two slots today — `patch` and `src` (ADR-0032) — and
// `toTarballKey` emits them `cmpStr`-sorted; since `'patch' < 'src'` the
// canonical order is `…+patch=…+src=…` (patch-then-src). Either, both, or
// neither may be present.
//
// Split on the literal `+patch=` / `+src=` MARKERS, not the first `+`: a version
// is NOT `+`-free (semver build-metadata, e.g. `1.0.0+build.1`), but it can never
// contain `+patch=` / `+src=` (`=` is illegal in semver build metadata), so each
// marker is an unambiguous slot boundary. The version is ALSO not `:`-free (a
// `file:` / `github:` / `https:` git-or-url locator lands in the version position
// for non-registry resolutions), but `:` does not affect THIS decomposition —
// only the row encoding, where the version is ref-interned rather than written
// inline.
//
// Because of the canonical patch-then-src order, `+src=` (when present) is always
// the trailing slot; we peel it off FIRST, then `+patch=` from what remains, so
// both tokens are recovered cleanly even when both slots are present.
function parseTarballKey(key: TarballKey): { name: string; version: string; patch?: string; src?: string } {
  let core = key
  let patch: string | undefined
  let src: string | undefined
  // `+src=` is the trailing slot (sorts after `+patch=`) — peel it first.
  const srcMarker = core.indexOf('+src=')
  if (srcMarker !== -1) {
    src = core.slice(srcMarker + '+src='.length)
    core = core.slice(0, srcMarker)
  }
  // `+patch=` is now the trailing slot of what remains.
  const patchMarker = core.indexOf('+patch=')
  if (patchMarker !== -1) {
    patch = core.slice(patchMarker + '+patch='.length)
    core = core.slice(0, patchMarker)
  }
  // version is what follows the last `@` (depth-0; scoped names keep leading @).
  const at = core.lastIndexOf('@')
  const out: { name: string; version: string; patch?: string; src?: string } =
    at <= 0
      ? { name: core, version: '' }
      : { name: core.slice(0, at), version: core.slice(at + 1) }
  if (patch !== undefined) out.patch = patch
  if (src !== undefined) out.src = src
  return out
}

// Re-derive a NodeId from its inputs, mirroring graph.serializeNodeId. We do not
// import serializeNodeId because it re-runs toTarballKey (which re-validates the
// patch token) — that is exactly what we want, so reuse it via toTarballKey here
// to stay single-source on the base-key shape. ADR-0032 — the `+src=` source
// discriminator (`src`) is threaded alongside `patch`; toTarballKey orders the
// slots (`…+patch=…+src=…`).
function deriveNodeId(name: string, version: string, peerContext: NodeId[], patch?: string, src?: string): NodeId {
  const inputs: TarballKeyInputs = { name, version }
  if (patch !== undefined) inputs.patch = patch
  if (src !== undefined) inputs.source = src
  const base = toTarballKey(inputs)
  if (peerContext.length === 0) return base
  return base + peerContext.map(p => `(${p})`).join('')
}

// --- Integrity origin ⇄ 1-char code (the package-row `origin` column) ---
// A single-hash integrity is stored as `digest` (inline hex) + this code. The
// code's algorithm is sha512 by convention (the overwhelmingly common case); a
// non-sha512 single hash falls back to the residual meta blob (see Phase 1), so
// the code space need only cover the five HashOrigin values. An unknown /
// forward-compat origin also routes to the residual blob (CODE_ORIGIN_OTHER is
// never emitted — it is an internal sentinel meaning "use the blob instead").
const ORIGIN_TO_CODE: Record<string, string> = {
  sri:            's',
  'berry-zip':    'z',
  'url-fragment': 'u',
  registry:       'r',
  recomputed:     'c',
}
const CODE_TO_ORIGIN: Record<string, string> = {
  s: 'sri',
  z: 'berry-zip',
  u: 'url-fragment',
  r: 'registry',
  c: 'recomputed',
}
const CODE_ORIGIN_OTHER = '?' // internal sentinel — never written to the wire

// The `=` sentinel for the "derived" common case — a resolution-canonical
// tarball at the conventional npmjs URL (package row), or a `Node.resolution`
// equal to the `<name>@npm:<version>` berry locator (node row). Both are pure
// functions of (name, version), so the `=` reclaims them at zero storage.
const RES_DERIVED = '='

// The conventional npmjs registry tarball URL for (name, version) — the exact
// shape `recipe/resolution.deriveRegistryUrl` produces for a berry `npm:`
// locator. Replicated here (not imported — it is a private helper there) and
// guarded by an EXACT string compare at emit, so any future divergence simply
// falls back to verbatim storage with zero fidelity risk.
function derivedRegistryUrl(name: string, version: string): string {
  const tail = name.startsWith('@') ? name.split('/').slice(1).join('/') : name
  return `https://registry.npmjs.org/${name}/-/${tail}-${version}.tgz`
}

// The conventional berry `npm:` locator for (name, version) — the `=` sentinel's
// expansion for the per-node verbatim `resolution` sidecar.
function derivedNodeResolution(name: string, version: string): string {
  return `${name}@npm:${version}`
}

// Drop keys whose value is `undefined`, returning a fresh shallow object. (The
// TarballPayload model carries `undefined` for absent fields; canonicalJson also
// strips them, but we need the pruned key-set to decide whether a residual blob
// is needed at all.)
function pruneUndefined(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(obj)) if (obj[k] !== undefined) out[k] = obj[k]
  return out
}

// Reconstruct a TarballPayload from a parsed package row. The residual meta blob
// is folded FIRST (it carries any field the dedicated columns did not capture,
// including a multi-hash or non-sha512 integrity), then the dedicated columns
// overlay the common-case integrity / cacheKey / resolution. Order matters:
// the columns are only ever populated when the residual did NOT carry the same
// field, so there is no conflict — but overlaying last keeps the intent explicit.
function rebuildPayload(row: {
  metaJson?: string
  digest?: string
  originCode?: string
  cacheKey?: string
  resInline?: string // '-' | '=' | canonical JSON
  name: string
  version: string
}): TarballPayload | undefined {
  const payload: Record<string, unknown> = row.metaJson !== undefined
    ? (JSON.parse(row.metaJson) as Record<string, unknown>)
    : {}

  // integrity from the inline columns (single sha512 hash of a known origin)
  if (row.digest !== undefined && row.originCode !== undefined) {
    const origin = CODE_TO_ORIGIN[row.originCode]
    if (origin === undefined) {
      throw new LockfileError({ code: 'PARSE_FAILED', message: `lockgraph: unknown integrity origin code '${row.originCode}'` })
    }
    payload.integrity = { hashes: [{ algorithm: 'sha512', digest: row.digest, origin }] }
  }

  if (row.cacheKey !== undefined) payload.berryChecksumCacheKey = row.cacheKey

  if (row.resInline !== undefined && row.resInline !== '-') {
    payload.resolution = row.resInline === RES_DERIVED
      ? { type: 'tarball', url: derivedRegistryUrl(row.name, row.version) }
      : (JSON.parse(row.resInline) as unknown)
  }

  return Object.keys(payload).length > 0 ? (payload as TarballPayload) : undefined
}

// Collect every edge in the graph, content-sorted by (srcDenseIndex, then the
// graph's own out-edge order which is already (dst, kind, alias)-sorted).
function collectEdges(graph: Graph, nodes: Node[]): Edge[] {
  const out: Edge[] = []
  for (const node of nodes) {
    for (const e of graph.out(node.id)) out.push(e)
  }
  return out
}

// Build the sparse hex-adjacency lines. Groups edges by source dense index;
// within a source, neighbors keep the graph's out() order (already canonical).
// Sources are emitted in ascending dense index (= the node table order), so the
// adjacency block is a pure function of the graph.
function buildAdjacency(
  edges: Edge[],
  nodeIndex: Map<NodeId, number>,
  strings: Interner,
): string[] {
  const bySrc = new Map<number, Edge[]>()
  for (const e of edges) {
    const src = nodeIndex.get(e.src)
    if (src === undefined) continue
    const arr = bySrc.get(src)
    if (arr) arr.push(e); else bySrc.set(src, [e])
  }
  const lines: string[] = []
  for (const src of Array.from(bySrc.keys()).sort((a, b) => a - b)) {
    const group = bySrc.get(src)!
    const neighbors = group.map(e => {
      const dst = nodeIndex.get(e.dst)!
      const kindChar = KIND_TO_CHAR[e.kind]
      const rangeRef = e.attrs?.range !== undefined ? String(strings.ref(e.attrs.range)) : '-'
      const aliasRef = e.attrs?.alias !== undefined ? String(strings.ref(e.attrs.alias)) : '-'
      let flags = ''
      if (e.attrs?.optional === true) flags += FLAG_OPTIONAL
      if (e.attrs?.workspace === true) flags += FLAG_WORKSPACE
      const flagsTok = flags === '' ? '-' : flags
      const wsRangeRef = e.attrs?.workspaceRange !== undefined
        ? String(strings.ref(canonicalJson(e.attrs.workspaceRange)))
        : '-'
      return `${toHex(dst)}/${kindChar}/${rangeRef}/${aliasRef}/${flagsTok}/${wsRangeRef}`
    })
    lines.push(`${toHex(src)}:${neighbors.join(',')}`)
  }
  return lines
}

// sha256 over `<schemaMajor>\n<bodyText>` — the schema-major is folded into the
// seal so a body re-interpreted under a different model major fails the check
// (the "⊕ schema-major" the concept fixes). Lowercase hex.
function sealOf(bodyText: string, schemaMajor: number = SCHEMA_MAJOR): string {
  return createHash('sha256').update(`${schemaMajor}\n${bodyText}`, 'utf8').digest('hex')
}
