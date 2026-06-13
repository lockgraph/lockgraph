// lockgraph — native graph-serialization format (#101).
//
// A portable, versioned serialization of the L2 Graph as a provenance META block
// followed by THREE tab-separated tables (registries, nodes, edges) plus an
// optional trailing layout-hints line. Unlike the PM adapters (yarn-berry, npm,
// pnpm, bun) — which serialize a Graph into a *foreign* package-manager schema
// and therefore round-trip only up to that schema's expressivity — lockgraph
// serializes the canonical model itself. Its defining property is
// **graph-IDENTITY**:
//
//     parse(serialize(g)) ≡ g
//
// i.e. `g.diff(parse(serialize(g)))` is empty on EVERY axis (nodes, edges,
// changed-nodes) AND `tarballs()` iterates byte-equal, because the format stores
// the canonical model's inputs verbatim and lets `Builder.seal()` re-derive the
// secondary indices. A re-serialize of the reconstructed graph is byte-identical
// to the first (the three tables are canonical); only META's volatile
// `generatedAt` / `generator` lines vary.
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
//                slots ws=/patch=/src=/peer=/ck=/res=/payload= (present only
//                when set). `src=` stores `Node.source` verbatim (NOT
//                re-derived). A CANONICAL resolution is NOT stored: a
//                yarn-classic `<canonical-url>#<sha1>` Node.resolution rides a
//                trailing `u`-member in the integrity column (res= omitted), a
//                berry `<name>@npm:<version>` locator collapses to the bare
//                `res` marker, and a canonical {type:'tarball'} payload
//                resolution is omitted and recomposed from the R row —
//                EXACT-MATCH-OR-VERBATIM: anything else stays verbatim.
//   E <n>      — one edge per row, `src\tdst\t<kind>\t<descriptor>` then
//                optional omittable slots (a flag cluster `o`/`w`/`ow`, then
//                `alias=` / `rv=` / `sp=`), sorted (src, dst, kind, alias). The
//                `descriptor` is the declared `EdgeAttrs.range` verbatim (npm
//                protocol implicit, every other protocol inline); there is NO
//                positional `-` alias padding and NO `workspaceRange` JSON — a
//                w-edge's `workspaceRange.specifier` IS the descriptor (the `sp=`
//                slot is the rare fallback when an adapter canonicalised them
//                apart), and `resolvedVersion` rides `rv=`.
//   L <json>   — OPTIONAL single trailing line, the graph's one LayoutHints as
//                canonical JSON; absent entirely when there are no hints.
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
const GENERATOR = `@antongolub/lockfile@${version}`

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
// Null-prototype so a kind word that happens to name an Object.prototype member
// (`constructor` / `toString` / `__proto__` / `hasOwnProperty`) resolves to
// `undefined` and is REJECTED on parse, instead of inheriting a prototype
// function and silently passing the `=== undefined` guard.
const WORD_TO_KIND: Record<string, EdgeKind> = Object.assign(Object.create(null), {
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
// Null-prototype so a marker that names an Object.prototype member can never
// inherit a function and slip past the `=== undefined` reject on parse.
const MARKER_TO_ORIGIN: Record<string, HashOrigin> = Object.assign(Object.create(null), {
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
// union — round-trip identity-exact without a bespoke per-field encoder. Used by
// the node `payload=` slot and the `L` layout-hints line. (The edge
// `workspaceRange` is NOT JSON any more — it decomposes onto the descriptor +
// rv=/sp= slots; see the E emit/parse.)
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

function escapeTsv(s: string): string {
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

function unescapeTsv(s: string): string {
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
// Every JSON-bearing slot (the node `payload=` slot, the `L` line) and every
// node-index field (`E` src/dst) is parsed through these so a
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

    // --- Node.resolution: exact-match-or-verbatim ---------------------------
    // Recompose the canonical candidate(s) and compare BYTE-EXACT:
    //   berry npm locator  → the bare `res` marker (recomposed on parse);
    //   canonical URL + #<sha1hex> fragment → res= omitted, the fragment rides
    //     the trailing `u`-member of the integrity column;
    //   anything else → res= verbatim, exactly as before.
    // A node with NO Node.resolution emits nothing — and parse keeps it
    // undefined (undefined stays undefined; the markers are the only recompose
    // triggers).
    let resToken: string | undefined
    let fragment: string | undefined
    if (node.resolution !== undefined) {
      const nr = node.resolution
      const candidate = hostedBase !== undefined
        ? recomposeNpmTarballUrl(hostedBase, node.name, node.version)
        : undefined
      if (nr === recomposeBerryLocator(node.name, node.version)) {
        resToken = 'res' // bare marker — canonical berry npm locator
      } else if (candidate !== undefined && nr.startsWith(candidate + '#')
          && SHA1_HEX_RE.test(nr.slice(candidate.length + 1))) {
        fragment = nr.slice(candidate.length + 1) // → u-member; res= omitted
      } else {
        resToken = `res=${escapeTsv(nr)}` // verbatim fallback
      }
    }

    // --- payload.resolution omission -----------------------------------------
    // Omitted iff the canonical union is EXACTLY {type:'tarball', url} with the
    // recomposable canonical URL — which a hosted R row already certifies (the
    // base was derived from that very url), so only the exact-shape check
    // remains. Extra keys (hostingProvider, …) keep it verbatim in payload=.
    const pr = payload?.resolution as ResolutionCanonical | undefined
    const omitResolution = hostedBase !== undefined && pr !== undefined
      && pr.type === 'tarball' && Object.keys(pr).length === 2

    const cols: string[] = [
      escapeTsv(node.name),
      escapeTsv(node.version),
      `r${regIndexByKey.get(regKeyOf(reg))!}`,
      encodeIntegrityColumn(payload?.integrity, fragment),
    ]
    // trailing optional slots, fixed order: ws= patch= src= peer= ck= res payload=
    if (node.workspacePath !== undefined) cols.push(`ws=${escapeTsv(node.workspacePath)}`)
    if (node.patch !== undefined) cols.push(`patch=${escapeTsv(node.patch)}`)
    if (node.source !== undefined) cols.push(`src=${escapeTsv(node.source)}`)
    if (node.peerContext.length > 0) cols.push(`peer=${escapeTsv(node.peerContext.map(p => `(${p})`).join(''))}`)
    if (payload?.berryChecksumCacheKey !== undefined) cols.push(`ck=${escapeTsv(payload.berryChecksumCacheKey)}`)
    if (resToken !== undefined) cols.push(resToken)
    const residual = residualPayload(payload, omitResolution)
    if (residual !== undefined) cols.push(`payload=${escapeTsv(canonicalJson(residual))}`)
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
    // generatedAt / generator / unknown: provenance only, ignored.
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
  interface ParsedNode {
    node: Node
    inputs: TarballKeyInputs
    payload?: TarballPayload
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
    const { integrity, fragment } = decodeIntegrityColumn(integrityRaw)

    // the node's R row — normative input to the recomposition below
    const regMatch = /^r(\d+)$/.exec(regRef)
    const reg = regMatch === null ? undefined : regs[Number(regMatch[1])]
    if (reg === undefined) {
      throw new LockfileError({ code: 'PARSE_FAILED', message: `lockgraph: bad registry reference '${regRef}'` })
    }
    const hostedBase = reg.type === 'npm' && reg.url !== NONE ? reg.url : undefined

    // trailing optional slots (self-describing `key=value`; the single bare
    // `res` marker is the one valueless form)
    let workspacePath: string | undefined
    let patch: string | undefined
    let source: string | undefined
    let peerContext: NodeId[] = []
    let resVerbatim: string | undefined
    let resMarker = false
    let cacheKey: string | undefined
    let residual: Record<string, unknown> | undefined
    for (let f = 4; f < fields.length; f++) {
      const slot = fields[f]!
      const eq = slot.indexOf('=')
      if (eq === -1) {
        if (slot === 'res') { resMarker = true; continue } // bare marker — canonical locator
        throw new LockfileError({ code: 'PARSE_FAILED', message: `lockgraph: malformed node slot (no '='): ${slot}` })
      }
      const skey = slot.slice(0, eq)
      const sval = unescapeTsv(slot.slice(eq + 1))
      if (skey === 'ws') workspacePath = sval
      else if (skey === 'patch') patch = sval
      else if (skey === 'src') source = sval
      else if (skey === 'peer') peerContext = parsePeerContext(sval)
      else if (skey === 'ck') cacheKey = sval
      else if (skey === 'res') resVerbatim = sval
      else if (skey === 'payload') residual = parseJson(sval, `node payload= (${name}@${nodeVersion})`) as Record<string, unknown>
      // unknown slots are ignored (forward-compat)
    }

    // Reconstruct Node.resolution — verbatim wins; the bare marker recomposes
    // the berry npm locator; a u-member recomposes the canonical URL + fragment.
    // NO marker and NO u-member means the node never had one: undefined stays
    // undefined (the parse never invents a resolution).
    if ((resVerbatim !== undefined || resMarker) && fragment !== undefined) {
      throw new LockfileError({ code: 'PARSE_FAILED', message: `lockgraph: u-member and res slot are mutually exclusive (${name}@${nodeVersion})` })
    }
    if (resVerbatim !== undefined && resMarker) {
      throw new LockfileError({ code: 'PARSE_FAILED', message: `lockgraph: duplicate res slot (${name}@${nodeVersion})` })
    }
    let resolution: string | undefined
    if (resVerbatim !== undefined) {
      resolution = resVerbatim
    } else if (resMarker) {
      resolution = recomposeBerryLocator(name, nodeVersion)
    } else if (fragment !== undefined) {
      if (hostedBase === undefined) {
        throw new LockfileError({ code: 'PARSE_FAILED', message: `lockgraph: u-member requires a hosted npm registry row (${name}@${nodeVersion})` })
      }
      resolution = `${recomposeNpmTarballUrl(hostedBase, name, nodeVersion)}#${fragment}`
    }

    // Reconstruct the TarballPayload: residual + the recomposed canonical
    // resolution + the ck= cache key + the integrity column. The canonical
    // {type:'tarball'} resolution is recomposed iff the node references a
    // HOSTED npm row and the payload= JSON carries no verbatim `resolution` —
    // a hosted row only ever arises from a canonical tarball resolution, so
    // this can never mint a resolution on a node that had none.
    const recomposePR = hostedBase !== undefined
      && (residual === undefined || !('resolution' in residual))
    let payload: TarballPayload | undefined
    if (residual !== undefined || integrity !== undefined || cacheKey !== undefined || recomposePR) {
      const p: Record<string, unknown> = residual !== undefined ? { ...residual } : {}
      if (recomposePR) p.resolution = { type: 'tarball', url: recomposeNpmTarballUrl(hostedBase!, name, nodeVersion) }
      if (cacheKey !== undefined) p.berryChecksumCacheKey = cacheKey
      if (integrity !== undefined) p.integrity = integrity
      payload = p as TarballPayload
    }

    // Re-derive the NodeId from the STORED (name, version, peerContext, patch,
    // src) slots exactly as the model does — so seal() re-validates the
    // id↔peerContext coherence and we never trust a stored id blindly. `src` is
    // read VERBATIM from the `src=` slot (not re-derived from the canonical
    // resolution): an adapter may leave `node.source` undefined even when the
    // resolution would discriminate (pnpm-v9 jsr / codeload-github), so deriving
    // it would mint a phantom `+src=` and break round-trip identity. Stored
    // verbatim, `undefined` stays absent.
    const id = serializeNodeId(name, nodeVersion, peerContext, patch, source)
    const node = assembleNode(id, name, nodeVersion, peerContext, resolution, patch, source, workspacePath)

    const inputs: TarballKeyInputs = { name, version: nodeVersion }
    if (patch !== undefined) inputs.patch = patch
    if (source !== undefined) inputs.source = source

    parsedNodes.push({ node, inputs, payload })
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

  // ---- Rebuild the Graph via the Builder -----------------------------------
  const builder = newBuilder()

  for (const { inputs, payload } of parsedNodes) {
    if (payload !== undefined) builder.setTarball(inputs, payload)
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
// emit (`…, resolution, patch, source, workspacePath`). `Graph.diff`'s
// `nodeEqual` is `JSON.stringify`-based and therefore KEY-ORDER-SENSITIVE, so
// matching the adapters' order makes `g.diff(parse(serialize(g)))` empty for
// graphs produced by ANY of this library's parsers. ADR-0032 places `source`
// AFTER `patch` and BEFORE `workspacePath`, matching _yarn-berry-core (the only
// adapter where `resolution` + `source` co-occur on the same node).
function assembleNode(
  id: NodeId,
  name: string,
  nodeVersion: string,
  peerContext: NodeId[],
  resolution: string | undefined,
  patch: string | undefined,
  source: string | undefined,
  workspacePath: string | undefined,
): Node {
  const node: Node = { id, name, version: nodeVersion, peerContext }
  if (resolution !== undefined) node.resolution = resolution
  if (patch !== undefined) node.patch = patch
  if (source !== undefined) node.source = source
  if (workspacePath !== undefined) node.workspacePath = workspacePath
  return node
}

// Parse a `peer=` slot value — a `(<nodeId>)(<nodeId>)…` concatenation of
// parenthesised NodeIds — back into the peerContext array. The NodeIds may
// themselves contain balanced parens (nested peer contexts), so we split on
// DEPTH-0 `(`/`)` boundaries, not the first `)`.
function parsePeerContext(s: string): NodeId[] {
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

function recomposeBerryLocator(name: string, version: string): string {
  return `${name}@npm:${version}`
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
function registrySourceOf(node: Node, payload: TarballPayload | undefined): { type: string; url: string } {
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
// The `u`-member (`usha1-<40hex>`) is TRANSPORT-ONLY, always LAST, at most one:
// it is the `#<sha1hex>` fragment of a canonical-URL Node.resolution
// (yarn-classic `resolved`), moved here so the URL itself can be recomposed
// from the R row. On decode it is returned as `fragment`, NOT folded into the
// multiset — the model keeps the url-fragment sha1 on the resolution sidecar
// (_common.md §3). Symmetrically, a multiset hash carrying origin
// 'url-fragment' violates that invariant and is REJECTED at emit (it would be
// indistinguishable from the transport member and could not round-trip).

function encodeIntegrityColumn(integrity: Integrity | undefined, fragment: string | undefined): string {
  const members: string[] = []
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
    members.push(`${marker}${h.algorithm}-${h.digest}`)
  }
  if (fragment !== undefined) members.push(`usha1-${fragment}`)
  return members.length > 0 ? members.join(';') : NONE
}

function decodeIntegrityColumn(raw: string): { integrity?: Integrity; fragment?: string } {
  if (raw === NONE) return {}
  const hashes: Hash[] = []
  let fragment: string | undefined
  for (const member of raw.split(';')) {
    const marker = member[0]!
    const rest = member.slice(1)
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
  return { integrity: hashes.length > 0 ? { hashes } : undefined, fragment }
}

// The residual TarballPayload to carry in `payload=` — every field NOT captured
// by a dedicated column or slot. `integrity` rides the dedicated integrity
// column; `berryChecksumCacheKey` rides the `ck=` slot; `Node.resolution` (the
// verbatim sidecar) has its own `res` slot and is a Node field, not a
// TarballPayload field, so it is not here. The canonical resolution union is
// OMITTED when `omitResolution` holds (it is exactly {type:'tarball', url:
// <recomposable canonical URL>} — parse rebuilds it from the node's R row);
// any other shape stays in verbatim. Everything else in the payload that is
// set — bin/engines/license/cpu/os/libc/funding/deprecated/
// bundledDependencies/peerDependenciesMeta/conditions — goes in. Returns
// `undefined` when the residual is empty (the common registry node, whose only
// artefact facts are its hashes and its recomposable resolution).
function residualPayload(payload: TarballPayload | undefined, omitResolution: boolean): Record<string, unknown> | undefined {
  if (payload === undefined) return undefined
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(payload)) {
    if (k === 'integrity') continue              // dedicated column
    if (k === 'berryChecksumCacheKey') continue  // dedicated ck= slot
    if (k === 'resolution' && omitResolution) continue // recomposed from the R row
    const v = (payload as Record<string, unknown>)[k]
    if (v !== undefined) out[k] = v
  }
  return Object.keys(out).length > 0 ? out : undefined
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
