// lockgraph — native graph-serialization format (#101).
//
// A portable, versioned serialization of the L2 Graph as a provenance META block
// followed by the GRAPH section (registries, nodes, edges + an optional layout-
// hints line — pure identity, JSON-free) and then the SEVERABLE FIDELITY section
// (the F region — per-tarball artifact metadata, fully-flat dot-path slots).
// Unlike the PM adapters (yarn-berry, npm, pnpm, bun) — which serialize a Graph
// into a *foreign* package-manager schema and therefore round-trip only up to
// that schema's expressivity — lockgraph serializes the canonical model itself.
// Its defining property is **graph-IDENTITY**:
//
//     parse(serialize(g)) ≡ g
//
// i.e. `g.diff(parse(serialize(g)))` is empty on EVERY axis (nodes, edges,
// changed-nodes) AND `tarballs()` iterates deep-equal, because the format stores
// the canonical model's inputs verbatim and lets `Builder.seal()` re-derive the
// secondary indices. A re-serialize of the reconstructed graph is byte-identical
// to the first (the GRAPH section AND the F section are canonical); only META's
// volatile `generatedAt` / `generator` lines vary.
//
// DOCUMENT LAYOUT (see spec/formats/lockgraph.md for the normative grammar):
//
//   META       — provenance, NOT hashed. `@lockgraph 1`, `schema 1.0`,
//                `generatedAt` (RFC-3339 UTC), the generator id. No checksum.
//   R <n>      — registries/sources, one `<type>\t<url>` per distinct node
//                source, content-sorted by (type, url), referenced as r0, r1, …
//                NORMATIVE: parse reads R back to recompose canonical npm
//                tarball URLs (hashes are DATA; the tarball path is a FUNCTION
//                of the registry type).
//   N <n>      — one row per node INSTANCE; line k IS node k. Root workspace
//                pinned at index 0, the rest ascending by fully-reconstructed
//                NodeId under cmpStr (= graph.nodes() order). Columns
//                `name\tversion\tr<idx>\t<integrity>` then trailing optional
//                slots ws=/patch=/src=/peer= (present only when set; NO
//                `payload=` — the residual artifact metadata moved to the F
//                section). `src=` stores `Node.source` verbatim (NOT re-derived).
//                The PM-native resolution sidecar is NO LONGER on the N row — a
//                verbatim native moved to the F section (`nativeResolution`),
//                while a canonical berry npm locator is recomposed by the berry
//                adapter (never stored). The ONLY native fragment that still
//                rides the N row is the `#<sha1>` of a yarn-classic
//                `<canonical-url>#<sha1>` native: it is split into a trailing
//                `u`-member of the integrity column so the URL itself recomposes
//                from the R row. The berry checksum-cache-key (ADR-0031) likewise
//                rides the integrity column, folded into its `berry-zip`
//                z-member as `z<cacheKey>/<algo>-<digest>`. A canonical
//                {type:'tarball'} payload resolution is omitted and recomposed
//                from R.
//   E <n>      — one edge per row, `src\tdst\t<kind>\t<descriptor>` then
//                optional omittable slots (a flag cluster `o`/`w`/`ow`, then
//                `alias=` / `rv=` / `sp=`), sorted (src, dst, kind, alias). The
//                `descriptor` is the declared `EdgeAttrs.range` verbatim (npm
//                protocol implicit, every other protocol inline); there is NO
//                positional `-` alias padding and NO `workspaceRange` JSON — a
//                w-edge's `workspaceRange.specifier` IS the descriptor (the `sp=`
//                slot is the rare fallback when an adapter canonicalised them
//                apart), and `resolvedVersion` rides `rv=`.
//   L <json>   — OPTIONAL single trailing line of the GRAPH section, the graph's
//                one LayoutHints as canonical JSON; absent when there are no hints.
//                The ONLY remaining canonical-JSON encoding in the document.
//   F <n>      — the SEVERABLE FIDELITY section: one row per distinct TarballKey
//                whose residual TarballPayload carries ≥1 artifact facet, keyed by
//                the FULL TarballKey (positional field 1) then fully-flat dot-path
//                `key=value` slots (license/deprecated/cpu/os/libc/bundled/engines/
//                bin/funding + any non-recomposable resolution union + a verbatim
//                nativeResolution). NO JSON. (`berryChecksumCacheKey` is NOT an F
//                slot — it folds into the N-row integrity column's z-member.) Cut
//                it → identity still round-trips (only fidelity degrades).
//
// There is NO checksum line and NO seal — integrity of the GRAPH is structural
// (parse reconstructs + seals the model; a mangled body fails the seal coherence
// invariants, not a byte hash). See the spec's "Integrity & authenticity".
//
// TSV ENCODING: region data rows are joined by a SINGLE `\t`, no padding/no
// alignment. Only the four framing bytes are escaped inside a value
// (`\`→`\\`, TAB→`\t`, LF→`\n`, CR→`\r`); `:` / `/` / `@` / `+` are ordinary
// value bytes. Region headers (`R <n>` …) and META lines are SPACE-separated
// framing.

import {
  newBuilder,
  serializeNodeId,
  toTarballKey,
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
import type { Hash, HashOrigin, Integrity } from '../recipe/integrity.ts'
import type { ResolutionCanonical } from '../recipe/resolution.ts'
import { LockfileError } from '../errors.ts'

export const version = '0.0.0'

// === Format constants =======================================================

/** The format generation written in the magic line `@lockgraph <GENERATION>`.
 *  In preview it is a detection discriminant, NOT a stability contract. */
const GENERATION = 1

/** The model generation, informational in preview (`schema <major>.<minor>`). */
const SCHEMA_MAJOR = 1
const SCHEMA_MINOR = 0

const MAGIC = '@lockgraph'
const GENERATOR = `lockgraph@${version}`

// The `-` sentinel for an ABSENT (undefined) value in a column. A bare dash is
// the only one-char value a column never legitimately holds, so it discriminates
// `undefined` from every present value EXCEPT a literal one-char `-` — which is a
// real value in the edge `descriptor` field (EdgeAttrs.range: '-' is a legal npm
// package name, so a range may be '-'). For that field a present value is written
// through `encodeOpt` (below), which escapes a literal `-` to `\-` so it never
// aliases the sentinel; `''` stays `''` (a distinct present value). The integrity
// / R-url columns can never structurally hold a one-char `-`, so they keep the
// bare sentinel; the edge `alias` rides the `alias=` slot (value after `=`, no
// collision) and the flag cluster is simply absent when empty (no `-` placeholder).
const NONE = '-'

// The edge `descriptor` carries a *tri-state* (undefined / '' / any string incl.
// '-'), so it cannot use the bare NONE byte alone — a literal '-' value would
// alias the absent sentinel and round-trip as `undefined`, changing the edge.
// encodeOpt makes all three distinguishable: undefined → `-`; a present value →
// TSV-escaped, with the single colliding form `-` escaped to `\-`. decodeOpt
// inverts it.
function encodeOpt(v: string | undefined): string {
  if (v === undefined) return NONE
  const esc = escapeTsv(v)
  return esc === NONE ? '\\-' : esc // only the exact one-char '-' collides
}
function decodeOpt(raw: string): string | undefined {
  if (raw === NONE) return undefined      // the absent sentinel
  if (raw === '\\-') return NONE           // the escaped literal one-char '-'
  return unescapeTsv(raw)
}

// Edge-kind ⇄ full word. `optional` shortens to `opt` so the column never
// collides with the `o` *flag* letter; the rest are the enum names. A full word
// keeps the audit scope legible in the raw file and gzip collapses the repeats.
const KIND_TO_WORD: Record<EdgeKind, string> = {
  dep:      'dep',
  dev:      'dev',
  optional: 'opt',
  peer:     'peer',
  bundled:  'bundled',
}
// Null-prototype lookup map: a key that happens to name an Object.prototype
// member (`constructor` / `toString` / `__proto__` / `hasOwnProperty`) resolves
// to `undefined` and is REJECTED on parse, instead of inheriting a prototype
// function and silently passing the `=== undefined` guard.
const nullProtoMap = <V>(entries: Record<string, V>): Record<string, V> =>
  Object.assign(Object.create(null), entries)

const WORD_TO_KIND: Record<string, EdgeKind> = nullProtoMap<EdgeKind>({
  dep:     'dep',
  dev:     'dev',
  opt:     'optional',
  peer:    'peer',
  bundled: 'bundled',
})

// Per-edge boolean flags, packed into ONE optional flag-cluster slot of flag
// letters (`o`, `w`, or `ow`), present only when ≥1 holds. `optional` and
// `workspace` are the two booleans on EdgeAttrs. The remaining EdgeAttrs ride
// dedicated slots: `range` is the positional `descriptor` field; `alias` is the
// `alias=` slot; `workspaceRange` is reconstructed from the descriptor + the
// `rv=` (resolvedVersion) / `sp=` (specifier-fallback) slots — see the E emit/
// parse below.
const FLAG_OPTIONAL = 'o'
const FLAG_WORKSPACE = 'w'

// === Integrity origin ⇄ 1-char marker (the node `integrity` column) =========
// Each multiset member is `<originMarker><algo>-<digest>`, `;`-joined. The
// marker preserves the derive-vs-fetch boundary. `u` is TRANSPORT-ONLY: it
// carries the `#<sha1hex>` fragment of a canonical-URL Node.resolution (always
// the LAST member, at most one), and on parse it is put BACK into the
// recomposed URL as the fragment — it is NEVER added to the integrity multiset
// (per _common.md §3 the url-fragment sha1 lives on the resolution sidecar, not
// the multiset; a multiset hash with origin 'url-fragment' violates that model
// invariant and the emitter rejects it).
const ORIGIN_TO_MARKER: Record<HashOrigin, string> = {
  sri:            's',
  'berry-zip':    'z',
  'url-fragment': 'u', // transport-only; rejected as a multiset member (see above)
  registry:       'r',
  recomputed:     'c',
}
const MARKER_TO_ORIGIN: Record<string, HashOrigin> = nullProtoMap<HashOrigin>({
  s: 'sri',
  z: 'berry-zip',
  r: 'registry',
  c: 'recomputed',
  // 'u' deliberately absent: intercepted as the transport fragment, never an origin.
})

// === Determinism helpers ====================================================

const cmpStr = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

// Canonical JSON: object keys recursively sorted (ascending UTF-16 code-unit
// order, JavaScript's default `Array.prototype.sort` string order) so
// structurally-equal values serialize to byte-identical strings. Arrays keep
// order (order is meaningful for the integrity multiset, cpu/os lists, and
// peerContext). `undefined` object properties are dropped (exactly
// `JSON.stringify`'s behaviour); `null` is preserved. This is the single
// chokepoint that lets arbitrary TarballPayload shapes — including
// `funding: unknown`, the `bin: string | Record`, and the ResolutionCanonical
// union — round-trip identity-exact without a bespoke per-field encoder. Used
// ONLY by the `L` layout-hints line — the single remaining canonical-JSON
// encoding in the document. (The residual TarballPayload is no longer JSON: it
// flattens to dot-path slots in the F section; the edge `workspaceRange`
// decomposes onto the descriptor + rv=/sp= slots; see the F and E emit/parse.)
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

// === TSV value escaping =====================================================
//
// A value rides inside a tab-bounded, line-oriented region row, so the four
// framing bytes — backslash, TAB, LF, CR — are escaped; nothing else is (a
// value may legitimately contain spaces, `:`, `/`, `@`, `+`, `{`, `}`, `,`).
// For a JSON-bearing slot the JSON string escaping (§ canonical JSON step 6) has
// already run, so a `\t` *inside* a JSON string is already `\\t` here; only a
// literal TAB byte that reaches the value is escaped to `\t` by this layer. The
// two layers compose unambiguously because the JSON escape runs first.

export function escapeTsv(s: string): string {
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

export function unescapeTsv(s: string): string {
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

// === Hardened parse primitives ==============================================
//
// The one JSON-bearing line (the `L` layout-hints line) and every node-index
// field (`E` src/dst) is parsed through these so a
// malformed document fails with a `LockfileError` PARSE_FAILED carrying a clear
// locus — NOT a raw `SyntaxError` from `JSON.parse`, nor a silent `Number('')
// === 0` that grafts a corrupt edge onto the root node.

function parseJson(raw: string, where: string): unknown {
  try {
    return JSON.parse(raw)
  } catch (e) {
    throw new LockfileError({
      code: 'PARSE_FAILED',
      message: `lockgraph: malformed JSON in ${where}: ${(e as Error).message}`,
    })
  }
}

// A node index is a decimal non-negative integer in `[0, nodeCount)`. `Number`
// is too permissive (`Number('')` → 0, `Number('1.5')` → 1.5, `Number('0x1F')`
// → 31, `Number(' 2 ')` → 2), so validate the raw token explicitly first.
function parseNodeIndex(raw: string, nodeCount: number, where: string): number {
  if (!/^\d+$/.test(raw)) {
    throw new LockfileError({ code: 'PARSE_FAILED', message: `lockgraph: ${where} must be a non-negative integer, got '${raw}'` })
  }
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 0 || n >= nodeCount) {
    throw new LockfileError({ code: 'PARSE_FAILED', message: `lockgraph: ${where} index ${raw} out of range [0, ${nodeCount})` })
  }
  return n
}

// =====================================================================================
// SERIALIZE
// =====================================================================================

export interface LockgraphStringifyOptions {
  lineEnding?: 'lf' | 'crlf'
  /** Override the META `generatedAt` timestamp (RFC-3339 UTC, second precision).
   *  Defaults to `new Date()`. Pinning it makes the WHOLE output byte-stable (the
   *  three tables are already canonical); useful for golden tests. */
  generatedAt?: string
  onDiagnostic?: (d: Diagnostic) => void
}

export function stringify(graph: Graph, options: LockgraphStringifyOptions = {}): string {
  const eol = options.lineEnding === 'crlf' ? '\r\n' : '\n'

  // ---- Collect the canonical model in deterministic order ------------------
  // graph.nodes() iterates ascending by the fully-reconstructed NodeId under
  // cmpStr (spec § N — nodes); we then pin the root (the empty-path workspace)
  // at index 0 and keep the rest in that order. Edges address nodes by this
  // positional index.
  const rawNodes = Array.from(graph.nodes())
  const nodes = pinRootFirst(rawNodes)
  const nodeIndex = new Map<NodeId, number>()
  for (let i = 0; i < nodes.length; i++) nodeIndex.set(nodes[i]!.id, i)

  // ---- R table — registries/sources, content-sorted, indexed r0, r1, … -----
  // Each node maps to a {type, url} source descriptor derived from its workspace
  // status + canonical TarballPayload.resolution. The set is content-sorted by
  // (type, url); the index is a pure function of that set. R is NORMATIVE:
  // parse reads a node's R row back to recompose its canonical npm tarball URL
  // (Node.resolution fragment form + payload.resolution), so the descriptor is
  // part of round-trip identity, not just readability.
  const payloads = nodes.map(node => graph.tarball(tarballKeyInputsOf(node)))
  const regs = nodes.map((node, i) => registrySourceOf(node, payloads[i]))
  const regKeyOf = (r: { type: string; url: string }): string =>
    `${escapeTsv(r.type)}\t${escapeTsv(r.url)}`
  const regKeys = Array.from(new Set(regs.map(regKeyOf))).sort(cmpStr)
  const regIndexByKey = new Map<string, number>()
  for (let i = 0; i < regKeys.length; i++) regIndexByKey.set(regKeys[i]!, i)

  // ---- N table — one row per node instance ---------------------------------
  const body: string[] = []

  body.push(`R ${regKeys.length}`)
  for (const k of regKeys) body.push(k) // already `<type>\t<url>`, TSV-escaped at regKeyOf

  body.push(`N ${nodes.length}`)
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]!
    const payload = payloads[i]
    const reg = regs[i]!
    // The node's npm-registry base, when its R row is a HOSTED npm row. A hosted
    // row only ever arises from a canonical-shape tarball resolution, so its
    // presence is the parse-side signal that payload.resolution existed.
    const hostedBase = reg.type === 'npm' && reg.url !== NONE ? reg.url : undefined

    // --- nativeResolution u-member optimization ----------------------------
    // The PM-native verbatim resolution sidecar now lives per-tarball in the F
    // section (`nativeResolution`), NOT on the N row. The ONLY fragment of it
    // that still rides the N row is the `#<sha1hex>` of a canonical-URL native
    // (yarn-classic `resolved`): it is split into the integrity column's
    // trailing `u`-member so the URL itself recomposes from R, and the F-row
    // omits the verbatim string entirely (case decided in flattenToSlots). When
    // the native is the canonical URL + `#<sha1>` shape, peel the fragment here;
    // EVERYTHING ELSE (a verbatim native → F verbatim) is handled in the F
    // section. (Canonical berry npm locators are never stored — the berry adapter
    // recomposes them at emit.) A node with NO native emits no fragment.
    let fragment: string | undefined
    const native = payload?.nativeResolution
    if (native !== undefined && hostedBase !== undefined) {
      const candidate = recomposeNpmTarballUrl(hostedBase, node.name, node.version)
      if (native.startsWith(candidate + '#') && SHA1_HEX_RE.test(native.slice(candidate.length + 1))) {
        fragment = native.slice(candidate.length + 1) // → u-member; F row omits the verbatim
      }
    }

    const cols: string[] = [
      escapeTsv(node.name),
      escapeTsv(node.version),
      `r${regIndexByKey.get(regKeyOf(reg))!}`,
      encodeIntegrityColumn(payload?.integrity, fragment, payload?.berryChecksumCacheKey),
    ]
    // trailing optional slots, fixed order: ws= patch= src= peer=
    // (the residual TarballPayload artifact metadata — incl. a verbatim
    // nativeResolution — lives in the severable F section, keyed by TarballKey;
    // the N row carries only identity columns + the integrity column, whose
    // u-member is the sole per-node native fragment and whose berry-zip z-member
    // carries the folded berryChecksumCacheKey).
    if (node.workspacePath !== undefined) cols.push(`ws=${escapeTsv(node.workspacePath)}`)
    if (node.patch !== undefined) cols.push(`patch=${escapeTsv(node.patch)}`)
    if (node.source !== undefined) cols.push(`src=${escapeTsv(node.source)}`)
    if (node.peerContext.length > 0) cols.push(`peer=${escapeTsv(node.peerContext.map(p => `(${p})`).join(''))}`)
    body.push(cols.join('\t'))
  }

  // ---- E table — one edge per row, sorted (src, dst, kind, alias) ----------
  // 4 positional fields + omittable key=value/flag slots (mirroring the N-row
  // slot design — NO positional `-` padding):
  //
  //   <src>\t<dst>\t<kind>\t<descriptor>[\t<slot>…]
  //
  // descriptor = `EdgeAttrs.range` verbatim through encodeOpt — tri-state
  // (undefined / '' / any string incl. '-'), so a literal '-' never aliases the
  // absent sentinel (B2). The npm protocol is implicit (bare ^1.2.3) and every
  // other protocol stays inline (workspace:*, github:…, file:…, npm:…).
  //
  // slots, FIXED order for determinism (each omitted when absent/false):
  //   1. flag-cluster — `o` (optional) / `w` (workspace), packed as `o`/`w`/`ow`,
  //      present only when ≥1 holds (NO `-` placeholder);
  //   2. `alias=<EdgeAttrs.alias>` — present iff alias is set (alias is part of
  //      edge identity);
  //   2b. `or=<EdgeAttrs.overrideRange>` — the override/`resolutions` pin the yarn
  //      adapters key the entry by; present iff a completed edge is override-governed
  //      (NOT edge identity, but must round-trip or `--immutable` re-breaks);
  //   3. `rv=<workspaceRange.resolvedVersion>` — the concrete target version;
  //   4. `sp=<workspaceRange.specifier>` — ONLY when specifier ≠ descriptor (a
  //      fallback for adapters — e.g. bun-text — that canonicalise the specifier
  //      to `workspace:*` while keeping a verbatim descriptor like `workspace:`).
  //      The common case (specifier === descriptor) stores nothing: parse
  //      reconstructs the specifier FROM the descriptor.
  //
  // KILL the old `workspaceRange` JSON: its `specifier` was byte-identical to the
  // descriptor on every edge but the rare canonicalised one, and the whole JSON
  // existed for one extra value (resolvedVersion) now in `rv=`.
  const edges = collectEdges(graph, nodes, nodeIndex)
  body.push(`E ${edges.length}`)
  for (const e of edges) {
    const descriptor = encodeOpt(e.attrs?.range)
    const cols: string[] = [String(e.src), String(e.dst), KIND_TO_WORD[e.kind], descriptor]
    // 1 — flag cluster (omitted entirely when no flag is set)
    let flags = ''
    if (e.attrs?.optional === true) flags += FLAG_OPTIONAL
    if (e.attrs?.workspace === true) flags += FLAG_WORKSPACE
    if (flags !== '') cols.push(flags)
    // 2 — alias= (alias participates in edge identity)
    if (e.attrs?.alias !== undefined) cols.push(`alias=${escapeTsv(e.attrs.alias)}`)
    // 2b — or= (overrideRange; the override/`resolutions` pin the yarn adapters key
    // the entry by). NOT part of edge identity, but it MUST round-trip: a governed
    // edge that loses it re-emits its raw declared range as a second descriptor and
    // re-breaks yarn `--immutable` (YN0028) — the very loss the stamp prevents. See
    // `EdgeAttrs.overrideRange` in graph.ts.
    if (e.attrs?.overrideRange !== undefined) cols.push(`or=${escapeTsv(e.attrs.overrideRange)}`)
    // 3/4 — workspaceRange decomposed onto rv= / sp=. specifier IS the
    // descriptor (the round-trip oracle proves this on the corpus); store sp=
    // only when an adapter canonicalised them apart, so the common w-edge carries
    // just `w` (+ rv= when resolved).
    const wr = e.attrs?.workspaceRange
    if (wr !== undefined) {
      if (wr.resolvedVersion !== undefined) cols.push(`rv=${escapeTsv(wr.resolvedVersion)}`)
      if (wr.specifier !== (e.attrs?.range ?? '')) cols.push(`sp=${escapeTsv(wr.specifier)}`)
    }
    body.push(cols.join('\t'))
  }

  // ---- L line — optional graph-level layout hints --------------------------
  const hints = graph.layoutHints()
  if (hints !== undefined) body.push(`L ${escapeTsv(canonicalJson(hints))}`)

  // ---- F section — the SEVERABLE per-tarball fidelity region ----------------
  // One row per DISTINCT TarballKey that carries ≥1 residual artifact-metadata
  // facet. The residual is the TarballPayload MINUS the fields that live on the
  // N row (integrity, and berryChecksumCacheKey — folded into the integrity
  // column's z-member) and minus the canonical resolution when it is the bare
  // recomposable 2-key {type:'tarball', url} shape (omitted and recomposed from
  // R), and minus a canonical berry npm locator nativeResolution (recomposed by
  // the berry adapter). Everything else is flattened to dot-path key=value
  // slots — NO nested JSON. graph.tarballs() already yields keys cmpStr-sorted.
  //
  // The row is keyed by the REPRESENTATIVE NODE INDEX, not the TarballKey string
  // (mirrors how edges reference nodes by index): a numeric ref that the N row's
  // name/version/patch/src already pin, with no redundant key restatement. The
  // representative of a tarball = the MINIMUM node index among the nodes sharing
  // its TarballKey (node order is deterministic, so this is byte-stable). Rows are
  // sorted by that index ascending. NB: a tarball with NO node (a setTarball with
  // no addNode — only reachable in hand-built graphs, never adapter parsing) has
  // no representative index and is therefore dropped; the F section stores per-
  // node fidelity, so a node-less tarball is unrepresentable by design.
  const minNodeIndexByKey = new Map<TarballKey, number>()
  for (let i = 0; i < nodes.length; i++) {
    const key = toTarballKey(tarballKeyInputsOf(nodes[i]!))
    if (!minNodeIndexByKey.has(key)) minNodeIndexByKey.set(key, i) // nodes already ascending → first = min
  }
  const fRows: Array<{ repr: number; row: string }> = []
  for (const [tarballKey, payload] of graph.tarballs()) {
    const repr = minNodeIndexByKey.get(tarballKey)
    if (repr === undefined) continue // node-less tarball: no representative index → unrepresentable, dropped
    // name/version come from the representative node — its inputs DEFINE the key
    // (toTarballKey of its name/version/patch/src), so they match by construction.
    const reprNode = nodes[repr]!
    const slots = flattenToSlots(payload, reprNode.name, reprNode.version)
    if (slots.length === 0) continue // empty residual → no row, not counted
    fRows.push({ repr, row: [String(repr), ...slots].join('\t') })
  }
  fRows.sort((a, b) => a.repr - b.repr)
  body.push(`F ${fRows.length}`)
  for (const r of fRows) body.push(r.row)

  // ---- META (volatile provenance, NOT hashed) ------------------------------
  const generatedAt = options.generatedAt ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  const meta: string[] = [
    `${MAGIC} ${GENERATION}`,
    `schema ${SCHEMA_MAJOR}.${SCHEMA_MINOR}`,
    `generatedAt ${generatedAt}`,
    `generator ${GENERATOR}`,
  ]

  return [...meta, ...body].join(eol) + eol
}

// =====================================================================================
// PARSE
// =====================================================================================

export interface LockgraphParseOptions {
  onDiagnostic?: (d: Diagnostic) => void
}

export function parse(input: string, options: LockgraphParseOptions = {}): Graph {
  const onDiagnostic = options.onDiagnostic
  // Normalise CRLF → LF so a CRLF-round-tripped file parses identically — the
  // three tables are a function of the LF-normalized model.
  const head = input.charCodeAt(0) === 0xFEFF ? input.slice(1) : input
  const lines = head.replace(/\r\n/g, '\n').split('\n')

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

  // ---- META ----------------------------------------------------------------
  const magicLine = next()
  const magicParts = magicLine.split(' ')
  if (magicParts[0] !== MAGIC) {
    throw new LockfileError({ code: 'PARSE_FAILED', message: `lockgraph: missing ${MAGIC} magic` })
  }
  const generation = Number(magicParts[1])
  if (!Number.isFinite(generation) || generation > GENERATION) {
    throw new LockfileError({
      code: 'CAPABILITY_LACK',
      message: `lockgraph: format generation ${magicParts[1]} newer than supported ${GENERATION}`,
    })
  }
  // Walk the remaining META lines until the first region header (`R <n>`).
  // META lines are pure provenance — `schema` / `generatedAt` / `generator` and
  // any unknown line — and are ignored (they are not graph facts). The META
  // block ends at the first line whose first token is a region letter.
  while (peek() !== undefined && !isRegionHeader(peek()!, 'R')) {
    const line = next()
    const key = line.split(' ')[0]
    if (key === 'schema') {
      const major = Number(line.split(' ')[1]?.split('.')[0])
      if (Number.isFinite(major) && major > SCHEMA_MAJOR) {
        throw new LockfileError({
          code: 'CAPABILITY_LACK',
          message: `lockgraph: schema major ${line.split(' ')[1]} newer than supported ${SCHEMA_MAJOR}`,
        })
      }
    }
    // generatedAt / generator / unknown: provenance only, ignored. Any unknown or
    // absent META line is tolerated — META holds no graph facts, so parse never
    // reads it to drive parsing.
  }

  const expectHeader = (letter: string): number => {
    const line = next()
    const sp = line.indexOf(' ')
    const key = sp === -1 ? line : line.slice(0, sp)
    const count = sp === -1 ? NaN : Number(line.slice(sp + 1))
    if (key !== letter || !Number.isInteger(count) || count < 0) {
      throw new LockfileError({
        code: 'PARSE_FAILED',
        message: `lockgraph: expected '${letter} <count>' region header, got: ${line}`,
      })
    }
    return count
  }

  // ---- R — registries (NORMATIVE — retained for recomposition) -------------
  // A node's R row is read back to recompose its canonical npm tarball URL:
  // the omitted payload.resolution union and the fragment-form Node.resolution
  // are pure functions of (R base, name, version). Node IDENTITY is still
  // re-derived from name/version/peer/patch/src, never from the R index.
  const rCount = expectHeader('R')
  const regs: Array<{ type: string; url: string }> = []
  for (let k = 0; k < rCount; k++) {
    const fields = next().split('\t')
    const [typeRaw, urlRaw] = fields
    if (typeRaw === undefined || urlRaw === undefined) {
      throw new LockfileError({ code: 'PARSE_FAILED', message: `lockgraph: malformed registry row: ${fields.join('\t')}` })
    }
    regs.push({ type: unescapeTsv(typeRaw), url: unescapeTsv(urlRaw) })
  }

  // ---- N — nodes -----------------------------------------------------------
  const nCount = expectHeader('N')
  // The N-row-derived part of a node's TarballPayload. The F-section residual is
  // merged onto this during reattach (after F is parsed), keyed by TarballKey.
  interface ParsedNode {
    node: Node
    inputs: TarballKeyInputs
    name: string
    version: string
    integrity?: Integrity
    // the `#<sha1hex>` integrity u-member — the per-node native-resolution
    // fragment (canonical-URL native), recomposed into nativeResolution at reattach.
    fragment?: string
    // the berry checksum-cache-key folded into the integrity column's z-member
    // (`z<cacheKey>/…`, ADR-0031), reattached as `berryChecksumCacheKey`.
    cacheKey?: string
    hostedBase?: string
  }
  const parsedNodes: ParsedNode[] = []
  const nodeIdByIndex: NodeId[] = []
  for (let k = 0; k < nCount; k++) {
    const fields = next().split('\t')
    const [nameRaw, versionRaw, regRef, integrityRaw] = fields
    if (nameRaw === undefined || versionRaw === undefined || regRef === undefined || integrityRaw === undefined) {
      throw new LockfileError({ code: 'PARSE_FAILED', message: `lockgraph: malformed node row: ${fields.join('\t')}` })
    }
    const name = unescapeTsv(nameRaw)
    const nodeVersion = unescapeTsv(versionRaw)
    const { integrity, fragment, cacheKey } = decodeIntegrityColumn(integrityRaw)

    // the node's R row — normative input to the recomposition below
    const regMatch = /^r(\d+)$/.exec(regRef)
    const reg = regMatch === null ? undefined : regs[Number(regMatch[1])]
    if (reg === undefined) {
      throw new LockfileError({ code: 'PARSE_FAILED', message: `lockgraph: bad registry reference '${regRef}'` })
    }
    const hostedBase = reg.type === 'npm' && reg.url !== NONE ? reg.url : undefined

    // trailing optional slots (self-describing `key=value`). The residual
    // artifact metadata — including `ck` and `nativeResolution` — is NO LONGER on
    // the N row; it lives in the F section and is merged in by TarballKey during
    // reattach below. The integrity column's `u`-member (`fragment`, decoded
    // above) is the SOLE per-node native fragment that still rides the N row.
    let workspacePath: string | undefined
    let patch: string | undefined
    let source: string | undefined
    let peerContext: NodeId[] = []
    for (let f = 4; f < fields.length; f++) {
      const slot = fields[f]!
      const eq = slot.indexOf('=')
      if (eq === -1) {
        throw new LockfileError({ code: 'PARSE_FAILED', message: `lockgraph: malformed node slot (no '='): ${slot}` })
      }
      const skey = slot.slice(0, eq)
      const sval = unescapeTsv(slot.slice(eq + 1))
      if (skey === 'ws') workspacePath = sval
      else if (skey === 'patch') patch = sval
      else if (skey === 'src') source = sval
      else if (skey === 'peer') peerContext = parsePeerContext(sval)
      // unknown slots are ignored (forward-compat)
    }

    // The TarballPayload is assembled in the REATTACH phase (after the F section
    // is parsed): the F-residual (artifact metadata + verbatim nativeResolution,
    // keyed by TarballKey) is merged with this node's N-row-derived part —
    // integrity, the integrity u-member `fragment`, and the integrity z-member
    // `cacheKey` (→ berryChecksumCacheKey). The canonical {type:'tarball'}
    // resolution is recomposed iff the node references a HOSTED npm row AND the
    // merged residual carries no verbatim `resolution`; the PM-native
    // `nativeResolution` is recomposed from the N-row `fragment` / the F verbatim
    // slot (see assemblePayload).

    // Re-derive the NodeId from the STORED (name, version, peerContext, patch,
    // src) slots exactly as the model does — so seal() re-validates the
    // id↔peerContext coherence and we never trust a stored id blindly. `src` is
    // read VERBATIM from the `src=` slot (not re-derived from the canonical
    // resolution): an adapter may leave `node.source` undefined even when the
    // resolution would discriminate (pnpm-v9 jsr / codeload-github), so deriving
    // it would mint a phantom `+src=` and break round-trip identity. Stored
    // verbatim, `undefined` stays absent.
    const id = serializeNodeId(name, nodeVersion, peerContext, patch, source)
    const node = assembleNode(id, name, nodeVersion, peerContext, patch, source, workspacePath)

    const inputs: TarballKeyInputs = { name, version: nodeVersion }
    if (patch !== undefined) inputs.patch = patch
    if (source !== undefined) inputs.source = source

    parsedNodes.push({ node, inputs, name, version: nodeVersion, integrity, fragment, cacheKey, hostedBase })
    nodeIdByIndex.push(id)
  }

  // ---- E — edges -----------------------------------------------------------
  const eCount = expectHeader('E')
  interface EdgeRow { src: number; dst: number; kind: EdgeKind; attrs?: EdgeAttrs }
  const edgeRows: EdgeRow[] = []
  for (let k = 0; k < eCount; k++) {
    const fields = next().split('\t')
    const [srcRaw, dstRaw, kindRaw, descriptorRaw] = fields
    if (srcRaw === undefined || dstRaw === undefined || kindRaw === undefined ||
        descriptorRaw === undefined) {
      throw new LockfileError({ code: 'PARSE_FAILED', message: `lockgraph: malformed edge row: ${fields.join('\t')}` })
    }
    const kind = WORD_TO_KIND[kindRaw]
    if (kind === undefined) {
      throw new LockfileError({ code: 'PARSE_FAILED', message: `lockgraph: unknown edge kind '${kindRaw}'` })
    }
    const attrs: EdgeAttrs = {}
    // Field 4 is the positional descriptor (EdgeAttrs.range). decodeOpt inverts
    // encodeOpt: `-` → undefined (absent), `\-` → the literal one-char '-',
    // anything else → the value verbatim (B2). A descriptor containing '=' (a URL
    // query) is unambiguous: it is positional field 4, BEFORE any slot.
    const range = decodeOpt(descriptorRaw)
    if (range !== undefined) attrs.range = range
    // Trailing slots (fields ≥ 5), each self-describing: a field containing '='
    // is a key=value slot (alias= / rv= / sp=); a field of only flag letters is
    // the flag cluster (o / w / ow). FIXED emit order, but parse is
    // order-independent (keyed), so a forward-compatible reorder still reads.
    let rv: string | undefined
    let sp: string | undefined
    let isWorkspaceEdge = false
    for (let f = 4; f < fields.length; f++) {
      const slot = fields[f]!
      const eq = slot.indexOf('=')
      if (eq === -1) {
        // flag cluster — only `o` / `w` letters are defined; unknown letters are
        // ignored (forward-compat) but a present cluster is the only valueless slot.
        if (slot.includes(FLAG_OPTIONAL)) attrs.optional = true
        if (slot.includes(FLAG_WORKSPACE)) { attrs.workspace = true; isWorkspaceEdge = true }
        continue
      }
      const skey = slot.slice(0, eq)
      const sval = unescapeTsv(slot.slice(eq + 1))
      if (skey === 'alias') attrs.alias = sval
      else if (skey === 'or') attrs.overrideRange = sval
      else if (skey === 'rv') rv = sval
      else if (skey === 'sp') sp = sval
      // unknown slots are ignored (forward-compat)
    }
    // Reconstruct workspaceRange for a w-edge (or any edge carrying rv=/sp=):
    // specifier IS the descriptor unless sp= overrode it; resolvedVersion rides
    // rv=. A bare w-edge with no rv=/sp= reconstructs { specifier: <descriptor> }.
    if (isWorkspaceEdge || rv !== undefined || sp !== undefined) {
      const specifier = sp !== undefined ? sp : (range ?? '')
      attrs.workspaceRange = rv !== undefined ? { specifier, resolvedVersion: rv } : { specifier }
    }
    // src / dst index a node row each; a bare `Number('')` is 0 and would
    // silently graft a corrupt empty-field edge onto the root node (B8). Require
    // a non-negative integer in range; reject empty / non-integer / out-of-range.
    const src = parseNodeIndex(srcRaw, nCount, 'edge src')
    const dst = parseNodeIndex(dstRaw, nCount, 'edge dst')
    const row: EdgeRow = { src, dst, kind }
    if (Object.keys(attrs).length > 0) row.attrs = attrs
    edgeRows.push(row)
  }

  // ---- L — optional layout-hints line --------------------------------------
  let hints: LayoutHints | undefined
  if (peek() !== undefined && peek() !== '' && peek()!.startsWith('L ')) {
    hints = parseJson(unescapeTsv(next().slice(2)), 'L layout-hints line') as LayoutHints
  }

  // ---- F — the SEVERABLE per-tarball fidelity section ----------------------
  // `F <n>` then n rows; each row's field 1 is the REPRESENTATIVE NODE INDEX (a
  // non-negative integer, parsed POSITIONALLY — not `=`-split), the rest are
  // dot-path slots reconstructed SCHEMA-DRIVEN. The index resolves to a real node
  // whose computed TarballKey (name/version/patch/source) is the key under which
  // this row's residual attaches; non-representative peer-virtual siblings find it
  // via their OWN computed key in the reattach loop below. No F section at all →
  // every residual is empty (severability: identity still round-trips). With an
  // index ref the row ALWAYS points to a real node, so orphan F rows cannot exist.
  const fResiduals = new Map<TarballKey, TarballPayload>()
  if (peek() !== undefined && isRegionHeader(peek()!, 'F')) {
    const fCount = expectHeader('F')
    for (let k = 0; k < fCount; k++) {
      const fields = next().split('\t')
      const idxRaw = fields[0]
      if (idxRaw === undefined) {
        throw new LockfileError({ code: 'PARSE_FAILED', message: `lockgraph: malformed F row: ${fields.join('\t')}` })
      }
      const reprIdx = parseNodeIndex(idxRaw, nCount, 'F row representative')
      // Resolve the index → that node's COMPUTED TarballKey (the reattach loop
      // keys residuals by each node's own computed key, so this is the join key).
      const tarballKey = toTarballKey(parsedNodes[reprIdx]!.inputs)
      const residual = parseSlots(fields.slice(1), tarballKey)
      fResiduals.set(tarballKey, residual)
    }
  }

  // ---- Rebuild the Graph via the Builder -----------------------------------
  const builder = newBuilder()

  // For each node, merge its F-residual (artifact metadata) with the N-row part
  // (integrity, berryChecksumCacheKey, recomposed canonical resolution). The
  // canonical {type:'tarball'} resolution is recomposed iff the node references a
  // HOSTED npm row AND the merged residual carries no verbatim `resolution`. Each
  // F residual is keyed by the COMPUTED TarballKey of a real node (the F row
  // carries a node INDEX, resolved above), so every residual is consumed here —
  // there are no orphan F rows to load independently.
  for (const pn of parsedNodes) {
    const tarballKey = toTarballKey(pn.inputs)
    const residual = fResiduals.get(tarballKey)
    const payload = assemblePayload(residual, pn)
    if (payload !== undefined) builder.setTarball(pn.inputs, payload)
  }

  for (const { node } of parsedNodes) builder.addNode(node)

  for (const er of edgeRows) {
    const srcId = nodeIdByIndex[er.src]
    const dstId = nodeIdByIndex[er.dst]
    if (srcId === undefined || dstId === undefined) {
      throw new LockfileError({ code: 'PARSE_FAILED', message: `lockgraph: edge index out of range (${er.src}→${er.dst})` })
    }
    builder.addEdge(srcId, dstId, er.kind, er.attrs)
  }

  if (hints !== undefined) builder.layoutHints(hints)

  // Diagnostics are NOT read — they are re-derived by the seal and adapters.
  const graph = builder.seal()
  if (onDiagnostic !== undefined) {
    for (const d of graph.diagnostics()) onDiagnostic(d)
  }
  return graph
}

// Merge a node's F-residual (artifact metadata, including a verbatim
// nativeResolution) with its N-row-derived part (integrity, the integrity
// u-member `fragment`, the integrity z-member `cacheKey`) into the final
// TarballPayload. Insertion order follows the spec: the F-residual fields first
// (already typed by parseSlots), then the recomposed canonical resolution, then
// the resolved nativeResolution, then integrity overlaid LAST, then the folded
// berryChecksumCacheKey. Returns `undefined` when nothing was carried (no
// residual, no integrity, no cacheKey, no recomposable resolution, no native).
// The canonical {type:'tarball'} resolution is recomposed iff the node
// references a HOSTED npm row AND the residual carries no verbatim `resolution`
// — a hosted row only ever arises from a canonical tarball resolution, so this
// can never mint a resolution on a node that had none. The nativeResolution is
// resolved from the F verbatim slot OR the N-row `fragment` (canonical-URL
// native).
function assemblePayload(
  residual: TarballPayload | undefined,
  pn: { name: string; version: string; integrity?: Integrity; fragment?: string; cacheKey?: string; hostedBase?: string },
): TarballPayload | undefined {
  const hasResidualResolution = residual !== undefined && residual.resolution !== undefined
  const recomposePR = pn.hostedBase !== undefined && !hasResidualResolution
  const native = resolveNativeResolution(residual?.nativeResolution, pn.name, pn.version, pn.fragment, pn.hostedBase)
  if (residual === undefined && pn.integrity === undefined && pn.cacheKey === undefined && !recomposePR && native === undefined) {
    return undefined
  }
  const p: Record<string, unknown> = residual !== undefined ? { ...residual } : {}
  if (recomposePR) p.resolution = { type: 'tarball', url: recomposeNpmTarballUrl(pn.hostedBase!, pn.name, pn.version) }
  // `native` is the resolved string (F verbatim slot passed through, or N-row
  // fragment → recomposed URL); when set it overwrites the residual's raw
  // verbatim with the final value. (Canonical berry npm locators are no longer
  // stored — the berry adapter recomposes `<name>@npm:<version>` at emit.)
  if (native !== undefined) p.nativeResolution = native
  if (pn.integrity !== undefined) p.integrity = pn.integrity
  // The berry checksum-cache-key folded into the integrity column's z-member
  // (ADR-0031) reattaches here as `berryChecksumCacheKey` (no separate F slot).
  if (pn.cacheKey !== undefined) p.berryChecksumCacheKey = pn.cacheKey
  return p as TarballPayload
}

// =====================================================================================
// CHECK / detect discriminant
// =====================================================================================

/** True iff `input` is a lockgraph document — the `@lockgraph` magic is the
 *  first token of the document (a leading UTF-8 BOM is tolerated). Cheap,
 *  allocation-light: only the head is inspected, so this sits at the top of the
 *  format detect order. */
export function check(input: string): boolean {
  const text = input.charCodeAt(0) === 0xFEFF ? input.slice(1) : input
  return text.startsWith(MAGIC + ' ') || text.startsWith(MAGIC + '\n') || text.startsWith(MAGIC + '\r')
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

// Pin the root workspace (the empty-`workspacePath` member) at index 0, keeping
// every other node in the incoming order (already ascending by fully-
// reconstructed NodeId under cmpStr). The root is uniquely identifiable, so this
// stays a pure function of the graph. A graph with no empty-path workspace (a
// bare dependency set with no importer) leaves the order untouched.
function pinRootFirst(nodes: Node[]): Node[] {
  const rootIdx = nodes.findIndex(n => n.workspacePath === '')
  if (rootIdx <= 0) return nodes // already first, or no root present
  const root = nodes[rootIdx]!
  return [root, ...nodes.slice(0, rootIdx), ...nodes.slice(rootIdx + 1)]
}

// True iff `line`'s first space-separated token is the region letter `letter`
// AND it is followed by a non-negative integer count — the shape of a region
// header (`R 2`, `N 12`, `E 20`). Used to find the META → region boundary
// without consuming META lines that merely start with a letter (e.g. `generator
// …` does not match `R`/`N`/`E`).
function isRegionHeader(line: string, letter: string): boolean {
  const sp = line.indexOf(' ')
  if (sp === -1) return false
  if (line.slice(0, sp) !== letter) return false
  const count = Number(line.slice(sp + 1))
  return Number.isInteger(count) && count >= 0
}

// Assemble a Node with the canonical key insertion order the library's adapters
// emit (`…, patch, source, workspacePath`). `Graph.diff`'s `nodeEqual` is
// `JSON.stringify`-based and therefore KEY-ORDER-SENSITIVE, so matching the
// adapters' order makes `g.diff(parse(serialize(g)))` empty for graphs produced
// by ANY of this library's parsers. ADR-0032 places `source` AFTER `patch` and
// BEFORE `workspacePath`. (The PM-native `resolution` sidecar no longer lives on
// the Node — it moved to TarballPayload.nativeResolution, assembled in the
// reattach phase.)
function assembleNode(
  id: NodeId,
  name: string,
  nodeVersion: string,
  peerContext: NodeId[],
  patch: string | undefined,
  source: string | undefined,
  workspacePath: string | undefined,
): Node {
  const node: Node = { id, name, version: nodeVersion, peerContext }
  if (patch !== undefined) node.patch = patch
  if (source !== undefined) node.source = source
  if (workspacePath !== undefined) node.workspacePath = workspacePath
  return node
}

// Parse a `peer=` slot value — a `(<nodeId>)(<nodeId>)…` concatenation of
// parenthesised NodeIds — back into the peerContext array. The NodeIds may
// themselves contain balanced parens (nested peer contexts), so we split on
// DEPTH-0 `(`/`)` boundaries, not the first `)`.
export function parsePeerContext(s: string): NodeId[] {
  const out: NodeId[] = []
  let depth = 0
  let start = -1
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '(') {
      if (depth === 0) start = i + 1
      depth++
    } else if (c === ')') {
      depth--
      if (depth === 0 && start !== -1) {
        out.push(s.slice(start, i))
        start = -1
      }
    }
  }
  return out
}

// === npm-registry recomposition — store FACTS, derive MECHANICS ==============
//
// Hashes/names/versions are DATA; the tarball path is a FUNCTION of the
// registry type. For an npm-class registry the tarball URL is
//
//     <base>/<name>/-/<basename>-<version>.tgz
//
// (basename = name with any @scope/ prefix stripped: @vue/shared → shared), and
// the yarn-berry npm locator is `<name>@npm:<version>`. The format derives both
// from the R table + the node's (name, version) facts instead of storing the
// same URL three times (R host + res= + payload.resolution.url), under an
// EXACT-MATCH-OR-VERBATIM guard: at emit a candidate is recomposed and compared
// BYTE-EXACT to the stored value; any mismatch (git, codeload, jsr, aliased,
// url-encoded, re-pathed, …) keeps the verbatim encoding, so fidelity is never
// at risk.

const SHA1_HEX_RE = /^[0-9a-f]{40}$/

// Resolve the `nativeResolution` carrier of an assembled payload: recompose the
// canonical-URL native from the N-row integrity `fragment` when present. A plain
// verbatim string (and `undefined`) passes through untouched. Applied on BOTH the
// node-reattach path (fragment available) and the orphan-F-row path (no node → no
// fragment, so only a verbatim slot can occur). NOTE: the canonical berry npm
// locator `<name>@npm:<version>` is NOT a lockgraph concern — the berry adapter
// recomposes it at emit, so it never appears here as a stored native.
export function resolveNativeResolution(
  current: string | undefined,
  name: string,
  version: string,
  fragment: string | undefined,
  hostedBase: string | undefined,
): string | undefined {
  if (current !== undefined) return current
  // No F slot for the native, but the N row carried a `#<sha1>` integrity
  // u-member → the canonical-URL native. Recompose `<url>#<fragment>`.
  if (fragment !== undefined) {
    if (hostedBase === undefined) {
      throw new LockfileError({ code: 'PARSE_FAILED', message: `lockgraph: u-member requires a hosted npm registry row (${name}@${version})` })
    }
    return `${recomposeNpmTarballUrl(hostedBase, name, version)}#${fragment}`
  }
  return undefined
}

function tarballBasename(name: string): string {
  return name.startsWith('@') ? name.slice(name.indexOf('/') + 1) : name
}

function npmTarballSuffix(name: string, version: string): string {
  return `/${name}/-/${tarballBasename(name)}-${version}.tgz`
}

// The npm-class registry base of a canonical tarball URL for (name, version) —
// the prefix left after stripping the canonical suffix — or `undefined` when
// the URL is not the canonical registry shape. By construction
// `base + npmTarballSuffix(name, version) === url`, so a successful derivation
// guarantees the recomposition is byte-exact.
function npmRegistryBaseOf(url: string, name: string, version: string): string | undefined {
  const suffix = npmTarballSuffix(name, version)
  if (!url.endsWith(suffix)) return undefined
  const base = url.slice(0, url.length - suffix.length)
  return /^https?:\/\/./.test(base) ? base : undefined
}

function recomposeNpmTarballUrl(base: string, name: string, version: string): string {
  return base + npmTarballSuffix(name, version)
}

// Derive the {type, url} R-table source descriptor for a node. Workspace members
// are the `workspace` pseudo-source (no external URL → `-`); otherwise the class
// is read off the node's canonical TarballPayload.resolution union. The R table
// is NORMATIVE: parse reads the node's R row back to recompose the canonical
// npm tarball URL, so the descriptor must be exact:
//
//   - a canonical-shape registry tarball URL → `npm` + the derived base (the
//     URL minus the recomposable `/<name>/-/<basename>-<version>.tgz` suffix);
//   - NO canonical resolution at all (bun-text registry nodes, hand-built
//     graphs before enrichment) → `npm` + `-` ("npm-class source, host
//     unrecorded") — deliberately NOT a fabricated default host, because a
//     hosted row existentially implies the node HAD a canonical tarball
//     resolution (that is what the parse-side payload.resolution recomposition
//     keys on);
//   - everything else verbatim, exactly as before (git/tarball/directory/
//     unknown).
export function registrySourceOf(node: Node, payload: TarballPayload | undefined): { type: string; url: string } {
  if (node.workspacePath !== undefined) return { type: 'workspace', url: NONE }
  const res = payload?.resolution as ResolutionCanonical | undefined
  if (res === undefined) return { type: 'npm', url: NONE }
  switch (res.type) {
    case 'tarball': {
      const base = npmRegistryBaseOf(res.url, node.name, node.version)
      if (base !== undefined) return { type: 'npm', url: base }
      return { type: 'tarball', url: res.url }
    }
    case 'git':
      return { type: res.hostingProvider ?? 'git', url: res.url }
    case 'directory':
      return { type: 'directory', url: res.path }
    case 'unknown':
      return { type: 'unknown', url: res.raw }
  }
}

// === Integrity multiset column ⇄ Integrity (+ the transport `u`-member) =====
//
// The `integrity` column carries the ENTIRE integrity multiset with origin tags
// (never a truncated single hash). Each member is `<originMarker><algo>-<digest>`
// (digest = lowercase hex), members `;`-joined in their canonical (source)
// order. `;` separates members and `-` separates algo from digest; neither
// occurs inside a hex digest or an algorithm token, so the sub-field is
// self-delimiting within the tab-bounded column. A bare `-` means NO integrity.
//
// The `berry-zip` member (marker `z`) optionally carries the yarn-berry checksum
// CACHE-KEY prefix (ADR-0031) folded into the member itself:
// `z<cacheKey>/<algo>-<digest>` (e.g. `z10c0/sha512-<hex>`). The cacheKey is
// literally that checksum's `<cacheKey>/` prefix, so it belongs on the z-member
// rather than a separate F slot. A cacheKey (`10c0`/`8`/`2`) contains no `/` and
// `<algo>-<digest>` contains no `/`, so on decode the FIRST `/` unambiguously
// separates the cacheKey from the hash; a bare `z<algo>-<digest>` (no `/`) means
// no cacheKey. On decode it is returned as `cacheKey` and reattached as
// TarballPayload.berryChecksumCacheKey.
//
// The `u`-member (`usha1-<40hex>`) is TRANSPORT-ONLY, always LAST, at most one:
// it is the `#<sha1hex>` fragment of a canonical-URL native resolution
// (yarn-classic `resolved`, now on TarballPayload.nativeResolution), moved here
// so the URL itself can be recomposed from the R row. On decode it is returned
// as `fragment`, NOT folded into the multiset — the model keeps the url-fragment
// sha1 on the resolution sidecar (_common.md §3). The native string itself is
// recomposed (`<url>#<fragment>`) in the reattach phase, where the F-section
// nativeResolution slot is also available. Symmetrically, a multiset hash carrying origin
// 'url-fragment' violates that invariant and is REJECTED at emit (it would be
// indistinguishable from the transport member and could not round-trip).

export function encodeIntegrityColumn(integrity: Integrity | undefined, fragment: string | undefined, cacheKey: string | undefined): string {
  const members: string[] = []
  // The cacheKey folds onto the FIRST berry-zip member only — decode lifts a
  // single cacheKey (and rejects a second `/`-bearing z-member), so emitting it
  // on at most one member keeps encode⇄decode provably symmetric even in the
  // (non-occurring) case of >1 berry-zip hash sharing one cacheKey scalar.
  let cacheKeyEmitted = false
  for (const h of integrity?.hashes ?? []) {
    if (h.origin === 'url-fragment') {
      throw new LockfileError({
        code: 'INVARIANT_VIOLATION',
        message: 'lockgraph: a url-fragment-origin hash must ride the resolution sidecar, not the integrity multiset (_common.md §3)',
      })
    }
    // An origin outside the documented alphabet {s,z,r,c,u} has no marker; emit
    // ↔ parse must stay symmetric, so reject it rather than coercing to
    // `"undefined"` (or any out-of-alphabet letter) that the decoder would
    // never accept back.
    const marker = ORIGIN_TO_MARKER[h.origin]
    if (marker === undefined) {
      throw new LockfileError({
        code: 'INVARIANT_VIOLATION',
        message: `lockgraph: unknown integrity hash origin '${h.origin}' (no marker in {s,z,r,c,u})`,
      })
    }
    // The berry checksum's `<cacheKey>/` prefix (ADR-0031) folds INTO its own
    // z-member: the cacheKey is literally that hash's prefix, so it belongs on
    // the `berry-zip` member rather than a separate F slot. Emit
    // `z<cacheKey>/<algo>-<digest>` when a cacheKey is present; bare `z<algo>-<digest>`
    // otherwise. cacheKey values (`10c0`/`8`/`2`) carry no `/` and `<algo>-<digest>`
    // carries no `/`, so the `/` is an unambiguous separator on decode.
    if (h.origin === 'berry-zip' && cacheKey !== undefined && !cacheKeyEmitted) {
      members.push(`${marker}${cacheKey}/${h.algorithm}-${h.digest}`)
      cacheKeyEmitted = true
    } else {
      members.push(`${marker}${h.algorithm}-${h.digest}`)
    }
  }
  if (fragment !== undefined) members.push(`usha1-${fragment}`)
  // NOTE: a cacheKey with NO berry-zip member to carry it (cacheKeyEmitted ===
  // false) is a model anomaly that cannot occur in practice — an adapter only
  // sets berryChecksumCacheKey alongside a parsed berry-zip digest (the cacheKey
  // IS that digest's prefix). It has no home in the integrity column and is not
  // re-emitted; were such a payload hand-built, the cacheKey would not round-trip.
  return members.length > 0 ? members.join(';') : NONE
}

export function decodeIntegrityColumn(raw: string): { integrity?: Integrity; fragment?: string; cacheKey?: string } {
  if (raw === NONE) return {}
  const hashes: Hash[] = []
  let fragment: string | undefined
  let cacheKey: string | undefined
  for (const member of raw.split(';')) {
    const marker = member[0]!
    let rest = member.slice(1)
    // berry-zip member may carry the folded checksum-cache-key prefix
    // `z<cacheKey>/<algo>-<digest>` (ADR-0031). The cacheKey precedes the FIRST
    // `/`, and neither a cacheKey nor an `<algo>-<digest>` contains a `/`, so
    // splitting on the first `/` recovers it unambiguously. A bare
    // `z<algo>-<digest>` (no `/`) leaves cacheKey undefined.
    if (marker === 'z') {
      const slash = rest.indexOf('/')
      if (slash !== -1) {
        if (cacheKey !== undefined) {
          throw new LockfileError({ code: 'PARSE_FAILED', message: 'lockgraph: duplicate berry checksum-cache-key in integrity column' })
        }
        cacheKey = rest.slice(0, slash)
        rest = rest.slice(slash + 1)
      }
    }
    const dash = rest.indexOf('-')
    if (dash === -1) {
      throw new LockfileError({ code: 'PARSE_FAILED', message: `lockgraph: malformed integrity member: ${member}` })
    }
    const algorithm = rest.slice(0, dash)
    const digest = rest.slice(dash + 1)
    if (marker === 'u') {
      // transport member — restored into the recomposed URL, never the multiset
      if (fragment !== undefined) {
        throw new LockfileError({ code: 'PARSE_FAILED', message: 'lockgraph: duplicate u (url-fragment) integrity member' })
      }
      if (algorithm !== 'sha1') {
        throw new LockfileError({ code: 'PARSE_FAILED', message: `lockgraph: u (url-fragment) member must be sha1, got '${algorithm}'` })
      }
      fragment = digest
      continue
    }
    const origin = MARKER_TO_ORIGIN[marker]
    if (origin === undefined) {
      throw new LockfileError({ code: 'PARSE_FAILED', message: `lockgraph: unknown integrity origin marker '${marker}'` })
    }
    hashes.push({ algorithm, digest, origin })
  }
  return { integrity: hashes.length > 0 ? { hashes } : undefined, fragment, cacheKey }
}


// === F section parse — reconstruct the residual TarballPayload (schema-driven) =
//
// A decoded slot: its dotpath (list of key segments, segment-unescaped) and its
// value (a string leaf). The two-pass discipline (spec § Schema-driven parse):
//   1. TSV-unescape the WHOLE field;
//   2. split on the FIRST UNESCAPED `=` → dotpath | value;
//   3. split the dotpath on UNESCAPED `.` → segments;
//   4. per-segment reverse `\.`→`.` and `\=`→`=`.
// The value (everything after the first unescaped `=`) is the already-TSV-
// unescaped remainder — NO dot/= un-escaping on the value.
interface DecodedSlot { path: string[]; value: string }

// Split `s` on the first UNESCAPED occurrence of `sep`. A `sep` preceded by an
// odd run of backslashes is escaped. Returns [before, afterOrUndefined].
export function splitFirstUnescaped(s: string, sep: string): [string, string | undefined] {
  for (let i = 0; i < s.length; i++) {
    if (s[i] === sep) {
      // count preceding backslashes
      let bs = 0
      for (let j = i - 1; j >= 0 && s[j] === '\\'; j--) bs++
      if (bs % 2 === 0) return [s.slice(0, i), s.slice(i + 1)]
    }
  }
  return [s, undefined]
}

// Split a dotpath on every UNESCAPED `.` into raw (still segment-escaped) segments.
function splitDotpath(dotpath: string): string[] {
  const segs: string[] = []
  let cur = ''
  for (let i = 0; i < dotpath.length; i++) {
    const ch = dotpath[i]!
    if (ch === '\\' && i + 1 < dotpath.length) {
      // an escape pair — keep BOTH bytes intact for the per-segment unescape pass
      cur += ch + dotpath[i + 1]!
      i++
    } else if (ch === '.') {
      segs.push(cur)
      cur = ''
    } else {
      cur += ch
    }
  }
  segs.push(cur)
  return segs
}

// Reverse the key-segment escape on ONE segment: `\.`→`.`, `\=`→`=`. The
// alphabet is exactly {`.`,`=`}; a `\` followed by anything else is left as-is
// (a literal backslash in a key was carried by the TSV layer, already reversed).
function unescapeKeySegment(seg: string): string {
  let out = ''
  for (let i = 0; i < seg.length; i++) {
    const ch = seg[i]!
    if (ch === '\\' && i + 1 < seg.length && (seg[i + 1] === '.' || seg[i + 1] === '=')) {
      out += seg[i + 1]!
      i++
    } else {
      out += ch
    }
  }
  return out
}

// Decode one wire field into a DecodedSlot.
function decodeSlot(field: string, tarballKey: TarballKey): DecodedSlot {
  const whole = unescapeTsv(field) // pass 1: TSV-unescape the whole field
  const [dotpathRaw, value] = splitFirstUnescaped(whole, '=') // pass 2: first unescaped `=`
  if (value === undefined) {
    throw new LockfileError({ code: 'PARSE_FAILED', message: `lockgraph: malformed F slot (no '='): ${field} (${tarballKey})` })
  }
  const path = splitDotpath(dotpathRaw).map(unescapeKeySegment) // pass 3+4
  return { path, value }
}

// Rebuild a `string[]` field from its index→value entries: indices MUST be
// contiguous ascending from 0 (a gap is PARSE_FAILED — the parser never
// hole-fills or compacts).
function rebuildStringArray(entries: Array<{ index: number; value: string }>, root: string, tarballKey: TarballKey): string[] {
  const arr: string[] = new Array(entries.length)
  const seen = new Set<number>()
  for (const { index, value } of entries) {
    if (index < 0 || index >= entries.length || seen.has(index)) {
      throw new LockfileError({ code: 'PARSE_FAILED', message: `lockgraph: ${root} array indices must be contiguous from 0 (${tarballKey})` })
    }
    seen.add(index)
    arr[index] = value
  }
  return arr
}

// Reconstruct the unschema'd `funding` value from its decoded slots by STRUCTURE:
// a purely-numeric segment is an array index, a non-numeric segment is an object
// key, leaves are strings. The root container's kind (array vs object) is read
// off the FIRST sub-segment after `funding`; the same test applies recursively.
// A bare `funding=<v>` (no sub-segment) is the scalar string form.
type FundingNode = string | FundingNode[] | { [k: string]: FundingNode }
function rebuildFunding(slots: DecodedSlot[], tarballKey: TarballKey): unknown {
  // bare scalar: a single slot whose path is exactly ['funding'].
  if (slots.length === 1 && slots[0]!.path.length === 1) return slots[0]!.value

  const NUMERIC = /^\d+$/
  // Determine container kind at a given sub-path depth by the segment that
  // follows. We build by inserting each leaf along its sub-path (after stripping
  // the `funding` root segment).
  const root: { container?: FundingNode } = {}
  const isIndex = (seg: string): boolean => NUMERIC.test(seg)

  const insert = (sub: string[], value: string): void => {
    if (sub.length === 0) {
      // a bare funding with extra structure is contradictory; treat as scalar
      root.container = value
      return
    }
    // ensure root container kind
    if (root.container === undefined) root.container = isIndex(sub[0]!) ? [] : {}
    let cur: FundingNode = root.container
    for (let d = 0; d < sub.length; d++) {
      const seg = sub[d]!
      const last = d === sub.length - 1
      if (Array.isArray(cur)) {
        const idx = Number(seg)
        if (!isIndex(seg)) {
          throw new LockfileError({ code: 'PARSE_FAILED', message: `lockgraph: funding array/object shape conflict at '${seg}' (${tarballKey})` })
        }
        if (last) { cur[idx] = value; return }
        if (cur[idx] === undefined) cur[idx] = isIndex(sub[d + 1]!) ? [] : {}
        cur = cur[idx]!
      } else if (cur !== null && typeof cur === 'object') {
        const obj = cur as { [k: string]: FundingNode }
        if (last) { obj[seg] = value; return }
        if (obj[seg] === undefined) obj[seg] = isIndex(sub[d + 1]!) ? [] : {}
        cur = obj[seg]!
      } else {
        throw new LockfileError({ code: 'PARSE_FAILED', message: `lockgraph: funding scalar/container conflict at '${seg}' (${tarballKey})` })
      }
    }
  }

  for (const slot of slots) insert(slot.path.slice(1), slot.value)
  // A funding ARRAY with gaps would leave holes; reject (parser never hole-fills).
  const checkContiguous = (node: FundingNode): void => {
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        if (node[i] === undefined) {
          throw new LockfileError({ code: 'PARSE_FAILED', message: `lockgraph: funding array indices must be contiguous from 0 (${tarballKey})` })
        }
        checkContiguous(node[i]!)
      }
    } else if (node !== null && typeof node === 'object') {
      for (const v of Object.values(node)) checkContiguous(v)
    }
  }
  if (root.container !== undefined) checkContiguous(root.container)
  return root.container
}

// Reconstruct the residual TarballPayload from an F row's dot-path slots
// (fields AFTER the positional TarballKey). Schema-driven: each field is rebuilt
// by its MODEL TYPE (graph.ts:50-80). An unknown slot root, an array-index gap,
// or both bin forms present are all PARSE_FAILED.
export function parseSlots(fields: string[], tarballKey: TarballKey): TarballPayload {
  // group decoded slots by root segment (= field name)
  const groups = new Map<string, DecodedSlot[]>()
  for (const field of fields) {
    const slot = decodeSlot(field, tarballKey)
    const root = slot.path[0]
    if (root === undefined) {
      throw new LockfileError({ code: 'PARSE_FAILED', message: `lockgraph: malformed F slot (empty key): ${field} (${tarballKey})` })
    }
    const g = groups.get(root)
    if (g === undefined) groups.set(root, [slot])
    else g.push(slot)
  }

  const out: Record<string, unknown> = {}
  const NUMERIC = /^\d+$/

  // string[] roots (the `bundled` token maps back to `bundledDependencies`).
  const arrayRoots: Record<string, keyof TarballPayload> = {
    cpu: 'cpu', os: 'os', libc: 'libc', bundled: 'bundledDependencies',
  }

  for (const [root, slots] of groups) {
    if (root === 'license' || root === 'deprecated') {
      // scalar — exactly one slot, path = [root]
      const s = slots[0]!
      if (slots.length !== 1 || s.path.length !== 1) {
        throw new LockfileError({ code: 'PARSE_FAILED', message: `lockgraph: malformed scalar '${root}' slot(s) (${tarballKey})` })
      }
      out[root] = s.value
    } else if (root in arrayRoots) {
      const entries = slots.map(s => {
        if (s.path.length !== 2 || !NUMERIC.test(s.path[1]!)) {
          throw new LockfileError({ code: 'PARSE_FAILED', message: `lockgraph: malformed array '${root}' slot (${tarballKey})` })
        }
        return { index: Number(s.path[1]), value: s.value }
      })
      out[arrayRoots[root]!] = rebuildStringArray(entries, root, tarballKey)
    } else if (root === 'engines') {
      const rec: Record<string, string> = {}
      for (const s of slots) {
        if (s.path.length !== 2) {
          throw new LockfileError({ code: 'PARSE_FAILED', message: `lockgraph: malformed engines slot (${tarballKey})` })
        }
        rec[s.path[1]!] = s.value
      }
      out.engines = rec
    } else if (root === 'bin') {
      // string form: a single bare `bin` slot (path = ['bin']). map form: one
      // slot per entry (path = ['bin', <key>]). Both present → PARSE_FAILED.
      const bareForm = slots.some(s => s.path.length === 1)
      const mapForm = slots.some(s => s.path.length > 1)
      if (bareForm && mapForm) {
        throw new LockfileError({ code: 'PARSE_FAILED', message: `lockgraph: bin carries both string and map forms (${tarballKey})` })
      }
      if (bareForm) {
        if (slots.length !== 1) {
          throw new LockfileError({ code: 'PARSE_FAILED', message: `lockgraph: duplicate bare bin slot (${tarballKey})` })
        }
        out.bin = slots[0]!.value
      } else {
        const rec: Record<string, string> = {}
        for (const s of slots) {
          if (s.path.length !== 2) {
            throw new LockfileError({ code: 'PARSE_FAILED', message: `lockgraph: malformed bin map slot (${tarballKey})` })
          }
          rec[s.path[1]!] = s.value
        }
        out.bin = rec
      }
    } else if (root === 'hasInstallScript') {
      const s = slots[0]!
      if (slots.length !== 1 || s.path.length !== 1) {
        throw new LockfileError({ code: 'PARSE_FAILED', message: `lockgraph: malformed hasInstallScript slot (${tarballKey})` })
      }
      out.hasInstallScript = s.value === 'true'
    } else if (root === 'peerDependenciesMeta') {
      const rec: Record<string, { optional?: boolean }> = {}
      for (const s of slots) {
        if (s.path.length !== 3 || s.path[2] !== 'optional') {
          throw new LockfileError({ code: 'PARSE_FAILED', message: `lockgraph: malformed peerDependenciesMeta slot (${tarballKey})` })
        }
        ;(rec[s.path[1]!] ??= {}).optional = s.value === 'true'
      }
      out.peerDependenciesMeta = rec
    } else if (root === 'funding') {
      out.funding = rebuildFunding(slots, tarballKey)
    } else if (root === 'resolution') {
      out.resolution = rebuildResolution(slots, tarballKey)
    } else if (root === 'nativeResolution') {
      // EXACT-MATCH-OR-VERBATIM, mirror of flattenToSlots:
      //   `nativeResolution=<v>` → verbatim string, stored as-is.
      // (The canonical-URL + `#<sha1>` shape has NO F slot — the fragment rides
      // the N-row integrity u-member, recomposed at reattach. The canonical berry
      // npm locator `<name>@npm:<version>` is NOT stored at all — the berry
      // adapter recomposes it at emit.)
      if (slots.length !== 1) {
        throw new LockfileError({ code: 'PARSE_FAILED', message: `lockgraph: duplicate nativeResolution slot(s) (${tarballKey})` })
      }
      const s = slots[0]!
      if (s.path.length === 1) {
        out.nativeResolution = s.value
      } else {
        throw new LockfileError({ code: 'PARSE_FAILED', message: `lockgraph: malformed nativeResolution slot (${tarballKey})` })
      }
    } else {
      throw new LockfileError({ code: 'PARSE_FAILED', message: `lockgraph: unknown F slot root '${root}' (${tarballKey})` })
    }
  }

  return out as TarballPayload
}

// Reconstruct the canonical resolution union (4-case) from its `resolution.*`
// slots. The case is read off `resolution.type`; remaining leaves are strings.
function rebuildResolution(slots: DecodedSlot[], tarballKey: TarballKey): ResolutionCanonical {
  const rec: Record<string, string> = {}
  for (const s of slots) {
    if (s.path.length !== 2) {
      throw new LockfileError({ code: 'PARSE_FAILED', message: `lockgraph: malformed resolution slot (${tarballKey})` })
    }
    rec[s.path[1]!] = s.value
  }
  return rec as unknown as ResolutionCanonical
}

// === F section — flatten the residual TarballPayload to dot-path slots ======
//
// The residual TarballPayload is every artifact-metadata field NOT captured by
// the GRAPH section: `integrity` (the N-row integrity column, whose `berry-zip`
// z-member also carries the folded `berryChecksumCacheKey` prefix), and the
// canonical resolution when it is the bare recomposable 2-key {type:'tarball',
// url} shape (omitted, recomposed from R) all stay out. Everything else —
// license / deprecated / cpu / os / libc /
// bundledDependencies / engines / bin / funding, and ANY non-recomposable
// resolution union — is flattened to dot-path `key=value` slots, NO JSON.
//
// KEY-SEGMENT ESCAPE: inside each key segment (before the first `=`) `.` → `\.`
// and `=` → `\=` (alphabet EXACTLY {`.`,`=`}, never backslash); the whole field
// is THEN TSV-escaped, so a literal backslash in a key is escaped only by the
// outer TSV layer. The value gets ONLY TSV-escape (it is split on nothing).

// A canonical resolution is OMITTED (recomposed from the R row) iff it is
// EXACTLY the 2-key {type:'tarball', url:<recomposable>} shape. The recomposable
// check derives the npm-registry base from (url, name, version) and confirms it
// is a hosted-npm canonical tarball URL — the same EXACT-MATCH predicate the
// N-row uses, decided here per-tarball off the tarball's own (name, version).
export function isRecomposableTarballResolution(res: ResolutionCanonical, name: string, version: string): boolean {
  return res.type === 'tarball'
    && Object.keys(res).length === 2
    && npmRegistryBaseOf(res.url, name, version) !== undefined
}

// Escape the two structural bytes inside ONE key segment. Alphabet is exactly
// {`.`,`=`}; a literal backslash is left UNTOUCHED here (the outer TSV escape
// turns it into `\\`).
function escapeKeySegment(seg: string): string {
  let out = ''
  for (const ch of seg) {
    if (ch === '.') out += '\\.'
    else if (ch === '=') out += '\\='
    else out += ch
  }
  return out
}

// Build one slot `<dotpath>=<value>`: each path segment is key-segment-escaped,
// joined by literal `.`, then `=`, then the value; the WHOLE field is finally
// TSV-escaped (the value carries only TSV escaping, never key-segment escaping).
function emitSlot(path: string[], value: string): string {
  const dotpath = path.map(escapeKeySegment).join('.')
  return escapeTsv(`${dotpath}=${value}`)
}

// Flatten an arbitrary `funding`-shaped value (unschema'd) recursively: object →
// `<key>` sub-segments (keys cmpStr-sorted), array → `<index>` sub-segments
// (ascending), scalar string → a leaf slot. Empty containers emit nothing.
// Non-string scalar leaves are coerced to string (v1 best-effort — never
// observed in real funding data; see spec § funding's honest v1 limit).
function flattenFunding(value: unknown, path: string[], out: string[]): void {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) flattenFunding(value[i], [...path, String(i)], out)
    return
  }
  if (value !== null && typeof value === 'object') {
    for (const k of Object.keys(value as Record<string, unknown>).sort(cmpStr)) {
      flattenFunding((value as Record<string, unknown>)[k], [...path, k], out)
    }
    return
  }
  // scalar leaf — string (or coerced) under the current path
  out.push(emitSlot(path, String(value)))
}

// Flatten the WHOLE residual TarballPayload to ordered dot-path slots. Returns
// `[]` when the residual is empty (no F row for that tarball). Field order is
// FIXED for byte-stability: license, deprecated, cpu, os, libc, bundled,
// engines, bin, funding, resolution. An empty container ([] / {}) emits no slot.
export function flattenToSlots(payload: TarballPayload, name: string, version: string): string[] {
  const out: string[] = []

  if (payload.license !== undefined) out.push(emitSlot(['license'], payload.license))
  if (payload.deprecated !== undefined) out.push(emitSlot(['deprecated'], payload.deprecated))

  // string[] fields → `<root>.<i>=` contiguous ascending. `bundledDependencies`
  // uses the SHORT root token `bundled`.
  const stringArrayFields: Array<[keyof TarballPayload, string]> = [
    ['cpu', 'cpu'],
    ['os', 'os'],
    ['libc', 'libc'],
    ['bundledDependencies', 'bundled'],
  ]
  for (const [field, root] of stringArrayFields) {
    const arr = payload[field] as string[] | undefined
    if (arr !== undefined) {
      for (let i = 0; i < arr.length; i++) out.push(emitSlot([root, String(i)], arr[i]!))
    }
  }

  // engines: Record<string,string> → `engines.<key>=`, keys cmpStr.
  if (payload.engines !== undefined) {
    for (const k of Object.keys(payload.engines).sort(cmpStr)) {
      out.push(emitSlot(['engines', k], payload.engines[k]!))
    }
  }

  // hasInstallScript: boolean → bare `hasInstallScript=<bool>` (npm only ever
  // emits `true`, but the round-trip is value-faithful either way).
  if (payload.hasInstallScript !== undefined) {
    out.push(emitSlot(['hasInstallScript'], String(payload.hasInstallScript)))
  }

  // peerDependenciesMeta: Record<peer, {optional?}> → `peerDependenciesMeta.<peer>.optional=<bool>`,
  // peers cmpStr-sorted. npm's only sub-key is `optional`; a peer without it emits nothing.
  if (payload.peerDependenciesMeta !== undefined) {
    for (const peer of Object.keys(payload.peerDependenciesMeta).sort(cmpStr)) {
      const optional = payload.peerDependenciesMeta[peer]!.optional
      if (optional !== undefined) {
        out.push(emitSlot(['peerDependenciesMeta', peer, 'optional'], String(optional)))
      }
    }
  }

  // bin: string → `bin=<v>`; Record → `bin.<key>=<v>` per entry, keys cmpStr.
  // NEVER normalize a 1-entry map to the string form (the emitter keys on
  // `typeof bin === 'string'`).
  if (payload.bin !== undefined) {
    if (typeof payload.bin === 'string') {
      out.push(emitSlot(['bin'], payload.bin))
    } else {
      for (const k of Object.keys(payload.bin).sort(cmpStr)) {
        out.push(emitSlot(['bin', k], payload.bin[k]!))
      }
    }
  }

  // funding: unknown → recurse (object/array/scalar), every leaf a string.
  if (payload.funding !== undefined) flattenFunding(payload.funding, ['funding'], out)

  // resolution: omitted iff the bare recomposable 2-key tarball; else the WHOLE
  // union flattens under `resolution.*` (one slot per union field, all leaves
  // string). The TarballKey's name@version drive the recomposable check.
  const res = payload.resolution
  if (res !== undefined && !isRecomposableTarballResolution(res, name, version)) {
    for (const k of Object.keys(res).sort(cmpStr)) {
      out.push(emitSlot(['resolution', k], String((res as Record<string, unknown>)[k])))
    }
  }

  // nativeResolution: the PM-native verbatim resolution sidecar (ADR-0013),
  // EXACT-MATCH-OR-VERBATIM, exactly as the N row used to encode it:
  //   - the canonical-URL + `#<sha1hex>` shape → OMITTED here, the `#<sha1>`
  //     fragment rides the N-row integrity column's `u`-member and the URL
  //     recomposes from R (same EXACT-MATCH the N row decided);
  //   - anything else → `nativeResolution=<verbatim>`.
  // The canonical berry npm locator `<name>@npm:<version>` is NEVER stored here:
  // the berry ADAPTER omits it at parse (it is fully derivable from the node's
  // (name, version) at emit), so the lockgraph layer stores `nativeResolution`
  // verbatim when present and nothing when absent.
  if (payload.nativeResolution !== undefined) {
    const native = payload.nativeResolution
    if (!nativeRidesIntegrityUMember(native, res, name, version)) {
      out.push(emitSlot(['nativeResolution'], native))
    }
    // else: the `#<sha1>` fragment is on the N row's integrity u-member; omit.
  }

  // berryChecksumCacheKey (ADR-0031): NOT a separate F slot — it is folded into
  // the N-row integrity column's `berry-zip` z-member (`z<cacheKey>/<algo>-<digest>`),
  // since the cacheKey is literally that checksum's prefix.

  return out
}

// Decide whether a PM-native resolution string is the canonical-URL + `#<sha1>`
// shape that is split into the N-row integrity column's `u`-member (so the F row
// omits the verbatim string, recomposing it at reattach). True iff the canonical
// resolution is a recomposable hosted-npm tarball AND `native === <url>#<40hex>`.
function nativeRidesIntegrityUMember(
  native: string,
  res: ResolutionCanonical | undefined,
  name: string,
  version: string,
): boolean {
  if (res === undefined || !isRecomposableTarballResolution(res, name, version)) return false
  const prefix = (res as { url: string }).url + '#'
  return native.startsWith(prefix) && SHA1_HEX_RE.test(native.slice(prefix.length))
}

// Collect every edge in the graph, sorted by (src, dst, kind, alias) with src
// and dst as their positional NODE INDICES. The graph's own out() order is
// already (dst, kind, alias)-sorted within a source, and we iterate sources in
// node-index order, so an explicit re-sort by the full numeric key restores the
// exact (src, dst, kind, alias) total order the spec mandates (src/dst sort
// NUMERICALLY, not lexically, after pinning the root at 0 reshuffles indices).
interface IndexedEdge { src: number; dst: number; kind: EdgeKind; attrs?: EdgeAttrs }
function collectEdges(graph: Graph, nodes: Node[], nodeIndex: Map<NodeId, number>): IndexedEdge[] {
  const out: IndexedEdge[] = []
  for (const node of nodes) {
    for (const e of graph.out(node.id)) {
      const src = nodeIndex.get(e.src)
      const dst = nodeIndex.get(e.dst)
      if (src === undefined || dst === undefined) continue
      out.push({ src, dst, kind: e.kind, attrs: e.attrs })
    }
  }
  out.sort((a, b) =>
    a.src - b.src ||
    a.dst - b.dst ||
    cmpStr(KIND_TO_WORD[a.kind], KIND_TO_WORD[b.kind]) ||
    cmpStr(a.attrs?.alias ?? '', b.attrs?.alias ?? ''),
  )
  return out
}

