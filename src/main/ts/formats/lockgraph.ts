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
import { LockfileError } from '../api/errors.ts'

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
    if (ch !== '\\' || i + 1 >= s.length) { out += ch; continue }
    const decoded = decodedTsvEscape(s[i + 1]!)
    if (decoded === undefined) { out += ch; continue }
    out += decoded
    i++
  }
  return out
}

function decodedTsvEscape(next: string): string | undefined {
  if (next === '\\') return '\\'
  if (next === 'n') return '\n'
  if (next === 'r') return '\r'
  if (next === 't') return '\t'
  return undefined
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
  const body: string[] = []
  const model = collectStringifyModel(graph)
  writeRegistryAndNodeRegions(body, model)
  writeEdgeRegion(body, graph, model)
  writeLayoutRegion(body, graph)
  writeFidelityRegion(body, graph, model.nodes)
  return [...stringifyMetadata(options), ...body].join(eol) + eol
}

interface LockgraphStringifyModel {
  nodes: Node[]
  nodeIndex: Map<NodeId, number>
  payloads: Array<TarballPayload | undefined>
  registries: Array<{ type: string; url: string }>
  registryKeys: string[]
  registryIndex: Map<string, number>
}

function registryKey(registry: { type: string; url: string }): string {
  return `${escapeTsv(registry.type)}\t${escapeTsv(registry.url)}`
}

function collectStringifyModel(graph: Graph): LockgraphStringifyModel {
  const nodes = pinRootFirst([...graph.nodes()])
  const nodeIndex = new Map<NodeId, number>()
  for (let index = 0; index < nodes.length; index++) nodeIndex.set(nodes[index]!.id, index)
  const payloads = nodes.map(node => graph.tarball(tarballKeyInputsOf(node)))
  const registries = nodes.map((node, index) => registrySourceOf(node, payloads[index]))
  const registryKeys = [...new Set(registries.map(registryKey))].sort(cmpStr)
  const registryIndex = new Map<string, number>()
  for (let index = 0; index < registryKeys.length; index++) registryIndex.set(registryKeys[index]!, index)
  return { nodes, nodeIndex, payloads, registries, registryKeys, registryIndex }
}

function writeRegistryAndNodeRegions(body: string[], model: LockgraphStringifyModel): void {
  body.push(`R ${model.registryKeys.length}`, ...model.registryKeys)
  body.push(`N ${model.nodes.length}`)
  for (let index = 0; index < model.nodes.length; index++) {
    body.push(stringifyNodeRow(model, index))
  }
}

function stringifyNodeRow(model: LockgraphStringifyModel, index: number): string {
  const node = model.nodes[index]!
  const payload = model.payloads[index]
  const registry = model.registries[index]!
  const hostedBase = registry.type === 'npm' && registry.url !== NONE ? registry.url : undefined
  const fragment = nativeResolutionFragment(payload?.nativeResolution, hostedBase, node)
  const columns = [
    escapeTsv(node.name),
    escapeTsv(node.version),
    `r${model.registryIndex.get(registryKey(registry))!}`,
    encodeIntegrityColumn(payload?.integrity, fragment, payload?.berryChecksumCacheKey),
  ]
  if (node.workspacePath !== undefined) columns.push(`ws=${escapeTsv(node.workspacePath)}`)
  if (node.patch !== undefined) columns.push(`patch=${escapeTsv(node.patch)}`)
  if (node.source !== undefined) columns.push(`src=${escapeTsv(node.source)}`)
  if (node.peerContext.length > 0) columns.push(`peer=${escapeTsv(node.peerContext.map(peer => `(${peer})`).join(''))}`)
  return columns.join('\t')
}

function nativeResolutionFragment(
  native: string | undefined,
  hostedBase: string | undefined,
  node: Node,
): string | undefined {
  if (native === undefined || hostedBase === undefined) return undefined
  const candidate = recomposeNpmTarballUrl(hostedBase, node.name, node.version)
  if (!native.startsWith(candidate + '#')) return undefined
  const fragment = native.slice(candidate.length + 1)
  return SHA1_HEX_RE.test(fragment) ? fragment : undefined
}

function writeEdgeRegion(body: string[], graph: Graph, model: LockgraphStringifyModel): void {
  const edges = collectEdges(graph, model.nodes, model.nodeIndex)
  body.push(`E ${edges.length}`)
  for (const edge of edges) body.push(stringifyEdgeRow(edge))
}

function stringifyEdgeRow(edge: IndexedEdge): string {
  const columns = [String(edge.src), String(edge.dst), KIND_TO_WORD[edge.kind], encodeOpt(edge.attrs?.range)]
  const flags = `${edge.attrs?.optional === true ? FLAG_OPTIONAL : ''}${edge.attrs?.workspace === true ? FLAG_WORKSPACE : ''}`
  if (flags !== '') columns.push(flags)
  if (edge.attrs?.alias !== undefined) columns.push(`alias=${escapeTsv(edge.attrs.alias)}`)
  if (edge.attrs?.overrideRange !== undefined) columns.push(`or=${escapeTsv(edge.attrs.overrideRange)}`)
  const workspaceRange = edge.attrs?.workspaceRange
  if (workspaceRange?.resolvedVersion !== undefined) columns.push(`rv=${escapeTsv(workspaceRange.resolvedVersion)}`)
  if (workspaceRange !== undefined && workspaceRange.specifier !== (edge.attrs?.range ?? '')) {
    columns.push(`sp=${escapeTsv(workspaceRange.specifier)}`)
  }
  return columns.join('\t')
}

function writeLayoutRegion(body: string[], graph: Graph): void {
  const hints = graph.layoutHints()
  if (hints !== undefined) body.push(`L ${escapeTsv(canonicalJson(hints))}`)
}

function writeFidelityRegion(body: string[], graph: Graph, nodes: Node[]): void {
  const representatives = minimumNodeIndexByTarballKey(nodes)
  const rows: Array<{ repr: number; row: string }> = []
  for (const [tarballKey, payload] of graph.tarballs()) {
    const repr = representatives.get(tarballKey)
    if (repr === undefined) continue
    const node = nodes[repr]!
    const slots = flattenToSlots(payload, node.name, node.version)
    if (slots.length > 0) rows.push({ repr, row: [String(repr), ...slots].join('\t') })
  }
  rows.sort((left, right) => left.repr - right.repr)
  body.push(`F ${rows.length}`, ...rows.map(({ row }) => row))
}

function minimumNodeIndexByTarballKey(nodes: Node[]): Map<TarballKey, number> {
  const representatives = new Map<TarballKey, number>()
  for (let index = 0; index < nodes.length; index++) {
    const key = toTarballKey(tarballKeyInputsOf(nodes[index]!))
    if (!representatives.has(key)) representatives.set(key, index)
  }
  return representatives
}

function stringifyMetadata(options: LockgraphStringifyOptions): string[] {
  const generatedAt = options.generatedAt ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  return [
    `${MAGIC} ${GENERATION}`,
    `schema ${SCHEMA_MAJOR}.${SCHEMA_MINOR}`,
    `generatedAt ${generatedAt}`,
    `generator ${GENERATOR}`,
  ]
}

// =====================================================================================
// PARSE
// =====================================================================================

export interface LockgraphParseOptions {
  onDiagnostic?: (d: Diagnostic) => void
}

export function parse(input: string, options: LockgraphParseOptions = {}): Graph {
  const cursor = createParseCursor(input)
  parseMetadata(cursor)
  const registries = parseRegistryRegion(cursor)
  const nodes = parseNodeRegion(cursor, registries)
  const edges = parseEdgeRegion(cursor, nodes.length)
  const hints = parseLayoutRegion(cursor)
  const residuals = parseFidelityRegion(cursor, nodes)
  return assembleGraph(nodes, edges, residuals, hints, options.onDiagnostic)
}

interface LockgraphParseCursor {
  peek(): string | undefined
  next(): string
  expectHeader(letter: string): number
}

interface ParsedNode {
  node: Node
  inputs: TarballKeyInputs
  name: string
  version: string
  integrity?: Integrity
  fragment?: string
  cacheKey?: string
  hostedBase?: string
}

interface ParsedEdgeRow { src: number; dst: number; kind: EdgeKind; attrs?: EdgeAttrs }

function createParseCursor(input: string): LockgraphParseCursor {
  const head = input.charCodeAt(0) === 0xFEFF ? input.slice(1) : input
  const lines = head.replace(/\r\n/g, '\n').split('\n')
  let index = 0
  const peek = (): string | undefined => lines[index]
  const next = (): string => {
    const line = lines[index]
    if (line === undefined) {
      throw new LockfileError({ code: 'PARSE_FAILED', message: 'lockgraph: unexpected end of input' })
    }
    index++
    return line
  }
  return { peek, next, expectHeader: letter => parseRegionHeader(next(), letter) }
}

function parseRegionHeader(line: string, letter: string): number {
  const space = line.indexOf(' ')
  const key = space === -1 ? line : line.slice(0, space)
  const count = space === -1 ? NaN : Number(line.slice(space + 1))
  if (key === letter && Number.isInteger(count) && count >= 0) return count
  throw new LockfileError({
    code: 'PARSE_FAILED',
    message: `lockgraph: expected '${letter} <count>' region header, got: ${line}`,
  })
}

function parseMetadata(cursor: LockgraphParseCursor): void {
  const magicParts = cursor.next().split(' ')
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
  while (cursor.peek() !== undefined && !isRegionHeader(cursor.peek()!, 'R')) {
    validateSchemaMetadata(cursor.next())
  }
}

function validateSchemaMetadata(line: string): void {
  const parts = line.split(' ')
  if (parts[0] !== 'schema') return
  const major = Number(parts[1]?.split('.')[0])
  if (!Number.isFinite(major) || major <= SCHEMA_MAJOR) return
  throw new LockfileError({
    code: 'CAPABILITY_LACK',
    message: `lockgraph: schema major ${parts[1]} newer than supported ${SCHEMA_MAJOR}`,
  })
}

function parseRegistryRegion(cursor: LockgraphParseCursor): Array<{ type: string; url: string }> {
  const registries: Array<{ type: string; url: string }> = []
  const count = cursor.expectHeader('R')
  for (let index = 0; index < count; index++) {
    const fields = cursor.next().split('\t')
    const [typeRaw, urlRaw] = fields
    if (typeRaw === undefined || urlRaw === undefined) {
      throw new LockfileError({ code: 'PARSE_FAILED', message: `lockgraph: malformed registry row: ${fields.join('\t')}` })
    }
    registries.push({ type: unescapeTsv(typeRaw), url: unescapeTsv(urlRaw) })
  }
  return registries
}

function parseNodeRegion(
  cursor: LockgraphParseCursor,
  registries: Array<{ type: string; url: string }>,
): ParsedNode[] {
  const nodes: ParsedNode[] = []
  const count = cursor.expectHeader('N')
  for (let index = 0; index < count; index++) nodes.push(parseNodeRow(cursor.next(), registries))
  return nodes
}

function parseNodeRow(line: string, registries: Array<{ type: string; url: string }>): ParsedNode {
  const fields = line.split('\t')
  const [nameRaw, versionRaw, registryRef, integrityRaw] = fields
  if (nameRaw === undefined || versionRaw === undefined || registryRef === undefined || integrityRaw === undefined) {
    throw new LockfileError({ code: 'PARSE_FAILED', message: `lockgraph: malformed node row: ${fields.join('\t')}` })
  }
  const name = unescapeTsv(nameRaw)
  const version = unescapeTsv(versionRaw)
  const integrityParts = decodeIntegrityColumn(integrityRaw)
  const registry = registryOfReference(registryRef, registries)
  const slots = parseNodeSlots(fields.slice(4))
  const id = serializeNodeId(name, version, slots.peerContext, slots.patch, slots.source)
  const node = assembleNode(id, name, version, slots.peerContext, slots.patch, slots.source, slots.workspacePath)
  const inputs: TarballKeyInputs = { name, version }
  if (slots.patch !== undefined) inputs.patch = slots.patch
  if (slots.source !== undefined) inputs.source = slots.source
  return {
    node,
    inputs,
    name,
    version,
    ...integrityParts,
    ...(registry.type === 'npm' && registry.url !== NONE ? { hostedBase: registry.url } : {}),
  }
}

function registryOfReference(
  reference: string,
  registries: Array<{ type: string; url: string }>,
): { type: string; url: string } {
  const match = /^r(\d+)$/.exec(reference)
  const registry = match === null ? undefined : registries[Number(match[1])]
  if (registry !== undefined) return registry
  throw new LockfileError({ code: 'PARSE_FAILED', message: `lockgraph: bad registry reference '${reference}'` })
}

interface ParsedNodeSlots {
  workspacePath?: string
  patch?: string
  source?: string
  peerContext: NodeId[]
}

function parseNodeSlots(slots: string[]): ParsedNodeSlots {
  const parsed: ParsedNodeSlots = { peerContext: [] }
  for (const slot of slots) {
    const equal = slot.indexOf('=')
    if (equal === -1) {
      throw new LockfileError({ code: 'PARSE_FAILED', message: `lockgraph: malformed node slot (no '='): ${slot}` })
    }
    assignNodeSlot(parsed, slot.slice(0, equal), unescapeTsv(slot.slice(equal + 1)))
  }
  return parsed
}

function assignNodeSlot(parsed: ParsedNodeSlots, key: string, value: string): void {
  if (key === 'ws') parsed.workspacePath = value
  else if (key === 'patch') parsed.patch = value
  else if (key === 'src') parsed.source = value
  else if (key === 'peer') parsed.peerContext = parsePeerContext(value)
}

function parseEdgeRegion(cursor: LockgraphParseCursor, nodeCount: number): ParsedEdgeRow[] {
  const edges: ParsedEdgeRow[] = []
  const count = cursor.expectHeader('E')
  for (let index = 0; index < count; index++) edges.push(parseEdgeRow(cursor.next(), nodeCount))
  return edges
}

function parseEdgeRow(line: string, nodeCount: number): ParsedEdgeRow {
  const fields = line.split('\t')
  const [srcRaw, dstRaw, kindRaw, descriptorRaw] = fields
  if (srcRaw === undefined || dstRaw === undefined || kindRaw === undefined || descriptorRaw === undefined) {
    throw new LockfileError({ code: 'PARSE_FAILED', message: `lockgraph: malformed edge row: ${fields.join('\t')}` })
  }
  const kind = WORD_TO_KIND[kindRaw]
  if (kind === undefined) {
    throw new LockfileError({ code: 'PARSE_FAILED', message: `lockgraph: unknown edge kind '${kindRaw}'` })
  }
  const attrs = parseEdgeAttrs(descriptorRaw, fields.slice(4))
  const row: ParsedEdgeRow = {
    src: parseNodeIndex(srcRaw, nodeCount, 'edge src'),
    dst: parseNodeIndex(dstRaw, nodeCount, 'edge dst'),
    kind,
  }
  if (Object.keys(attrs).length > 0) row.attrs = attrs
  return row
}

function parseEdgeAttrs(descriptorRaw: string, slots: string[]): EdgeAttrs {
  const attrs: EdgeAttrs = {}
  const range = decodeOpt(descriptorRaw)
  if (range !== undefined) attrs.range = range
  let resolvedVersion: string | undefined
  let specifier: string | undefined
  let workspace = false
  for (const slot of slots) {
    const parsed = parseEdgeSlot(slot, attrs)
    if (parsed.workspace) workspace = true
    if (parsed.resolvedVersion !== undefined) resolvedVersion = parsed.resolvedVersion
    if (parsed.specifier !== undefined) specifier = parsed.specifier
  }
  if (workspace || resolvedVersion !== undefined || specifier !== undefined) {
    const value = specifier ?? range ?? ''
    attrs.workspaceRange = resolvedVersion === undefined ? { specifier: value } : { specifier: value, resolvedVersion }
  }
  return attrs
}

function parseEdgeSlot(
  slot: string,
  attrs: EdgeAttrs,
): { workspace: boolean; resolvedVersion?: string; specifier?: string } {
  const equal = slot.indexOf('=')
  if (equal === -1) {
    if (slot.includes(FLAG_OPTIONAL)) attrs.optional = true
    const workspace = slot.includes(FLAG_WORKSPACE)
    if (workspace) attrs.workspace = true
    return { workspace }
  }
  const key = slot.slice(0, equal)
  const value = unescapeTsv(slot.slice(equal + 1))
  if (key === 'alias') attrs.alias = value
  else if (key === 'or') attrs.overrideRange = value
  return {
    workspace: false,
    ...(key === 'rv' ? { resolvedVersion: value } : {}),
    ...(key === 'sp' ? { specifier: value } : {}),
  }
}

function parseLayoutRegion(cursor: LockgraphParseCursor): LayoutHints | undefined {
  const line = cursor.peek()
  if (line === undefined || line === '' || !line.startsWith('L ')) return undefined
  return parseJson(unescapeTsv(cursor.next().slice(2)), 'L layout-hints line') as LayoutHints
}

function parseFidelityRegion(
  cursor: LockgraphParseCursor,
  nodes: ParsedNode[],
): Map<TarballKey, TarballPayload> {
  const residuals = new Map<TarballKey, TarballPayload>()
  const line = cursor.peek()
  if (line === undefined || !isRegionHeader(line, 'F')) return residuals
  const count = cursor.expectHeader('F')
  for (let index = 0; index < count; index++) {
    const fields = cursor.next().split('\t')
    const representative = fields[0]
    if (representative === undefined) {
      throw new LockfileError({ code: 'PARSE_FAILED', message: `lockgraph: malformed F row: ${fields.join('\t')}` })
    }
    const nodeIndex = parseNodeIndex(representative, nodes.length, 'F row representative')
    const tarballKey = toTarballKey(nodes[nodeIndex]!.inputs)
    residuals.set(tarballKey, parseSlots(fields.slice(1), tarballKey))
  }
  return residuals
}

function assembleGraph(
  nodes: ParsedNode[],
  edges: ParsedEdgeRow[],
  residuals: Map<TarballKey, TarballPayload>,
  hints: LayoutHints | undefined,
  onDiagnostic: ((diagnostic: Diagnostic) => void) | undefined,
): Graph {
  const builder = newBuilder()
  for (const parsed of nodes) attachParsedTarball(builder, parsed, residuals)
  for (const { node } of nodes) builder.addNode(node)
  for (const edge of edges) addParsedEdge(builder, edge, nodes)
  if (hints !== undefined) builder.layoutHints(hints)
  const graph = builder.seal()
  if (onDiagnostic !== undefined) {
    for (const diagnostic of graph.diagnostics()) onDiagnostic(diagnostic)
  }
  return graph
}

function attachParsedTarball(
  builder: ReturnType<typeof newBuilder>,
  parsed: ParsedNode,
  residuals: Map<TarballKey, TarballPayload>,
): void {
  const payload = assemblePayload(residuals.get(toTarballKey(parsed.inputs)), parsed)
  if (payload !== undefined) builder.setTarball(parsed.inputs, payload)
}

function addParsedEdge(
  builder: ReturnType<typeof newBuilder>,
  edge: ParsedEdgeRow,
  nodes: ParsedNode[],
): void {
  const src = nodes[edge.src]?.node.id
  const dst = nodes[edge.dst]?.node.id
  if (src === undefined || dst === undefined) {
    throw new LockfileError({ code: 'PARSE_FAILED', message: `lockgraph: edge index out of range (${edge.src}→${edge.dst})` })
  }
  builder.addEdge(src, dst, edge.kind, edge.attrs)
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

interface DecodedIntegrityState {
  hashes: Hash[]
  fragment?: string
  cacheKey?: string
}

export function decodeIntegrityColumn(raw: string): { integrity?: Integrity; fragment?: string; cacheKey?: string } {
  if (raw === NONE) return {}
  const state: DecodedIntegrityState = { hashes: [] }
  for (const member of raw.split(';')) decodeIntegrityMember(member, state)
  return {
    integrity: state.hashes.length > 0 ? { hashes: state.hashes } : undefined,
    fragment: state.fragment,
    cacheKey: state.cacheKey,
  }
}

function decodeIntegrityMember(member: string, state: DecodedIntegrityState): void {
  const marker = member[0]!
  const rest = decodeBerryCacheKey(marker, member.slice(1), state)
  const { algorithm, digest } = splitIntegrityMember(member, rest)
  if (decodeUrlFragment(marker, algorithm, digest, state)) return
  const origin = MARKER_TO_ORIGIN[marker]
  if (origin === undefined) {
    throw new LockfileError({ code: 'PARSE_FAILED', message: `lockgraph: unknown integrity origin marker '${marker}'` })
  }
  state.hashes.push({ algorithm, digest, origin })
}

function decodeBerryCacheKey(marker: string, rest: string, state: DecodedIntegrityState): string {
  if (marker !== 'z') return rest
  const slash = rest.indexOf('/')
  if (slash === -1) return rest
  if (state.cacheKey !== undefined) {
    throw new LockfileError({ code: 'PARSE_FAILED', message: 'lockgraph: duplicate berry checksum-cache-key in integrity column' })
  }
  state.cacheKey = rest.slice(0, slash)
  return rest.slice(slash + 1)
}

function splitIntegrityMember(member: string, rest: string): { algorithm: string; digest: string } {
  const dash = rest.indexOf('-')
  if (dash === -1) {
    throw new LockfileError({ code: 'PARSE_FAILED', message: `lockgraph: malformed integrity member: ${member}` })
  }
  return { algorithm: rest.slice(0, dash), digest: rest.slice(dash + 1) }
}

function decodeUrlFragment(
  marker: string,
  algorithm: string,
  digest: string,
  state: DecodedIntegrityState,
): boolean {
  if (marker !== 'u') return false
  if (state.fragment !== undefined) {
    throw new LockfileError({ code: 'PARSE_FAILED', message: 'lockgraph: duplicate u (url-fragment) integrity member' })
  }
  if (algorithm !== 'sha1') {
    throw new LockfileError({ code: 'PARSE_FAILED', message: `lockgraph: u (url-fragment) member must be sha1, got '${algorithm}'` })
  }
  state.fragment = digest
  return true
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
interface FundingRoot { container?: FundingNode }
const FUNDING_INDEX_RE = /^\d+$/

function rebuildFunding(slots: DecodedSlot[], tarballKey: TarballKey): unknown {
  // bare scalar: a single slot whose path is exactly ['funding'].
  if (slots.length === 1 && slots[0]!.path.length === 1) return slots[0]!.value

  const root: FundingRoot = {}
  for (const slot of slots) insertFundingSlot(root, slot.path.slice(1), slot.value, tarballKey)
  if (root.container !== undefined) assertContiguousFundingArrays(root.container, tarballKey)
  return root.container
}

function insertFundingSlot(root: FundingRoot, path: string[], value: string, tarballKey: TarballKey): void {
  if (path.length === 0) { root.container = value; return }
  root.container ??= fundingContainerFor(path[0]!)
  let current: FundingNode = root.container
  for (let depth = 0; depth < path.length; depth++) {
    const next = setFundingChild(current, path, depth, value, tarballKey)
    if (next === undefined) return
    current = next
  }
}

function setFundingChild(
  current: FundingNode,
  path: string[],
  depth: number,
  value: string,
  tarballKey: TarballKey,
): FundingNode | undefined {
  const segment = path[depth]!
  const last = depth === path.length - 1
  if (Array.isArray(current)) return setFundingArrayChild(current, segment, path[depth + 1], value, last, tarballKey)
  if (current !== null && typeof current === 'object') {
    return setFundingObjectChild(current as { [k: string]: FundingNode }, segment, path[depth + 1], value, last)
  }
  throw new LockfileError({ code: 'PARSE_FAILED', message: `lockgraph: funding scalar/container conflict at '${segment}' (${tarballKey})` })
}

function setFundingArrayChild(
  current: FundingNode[],
  segment: string,
  nextSegment: string | undefined,
  value: string,
  last: boolean,
  tarballKey: TarballKey,
): FundingNode | undefined {
  if (!FUNDING_INDEX_RE.test(segment)) {
    throw new LockfileError({ code: 'PARSE_FAILED', message: `lockgraph: funding array/object shape conflict at '${segment}' (${tarballKey})` })
  }
  const index = Number(segment)
  if (last) { current[index] = value; return undefined }
  current[index] ??= fundingContainerFor(nextSegment!)
  return current[index]
}

function setFundingObjectChild(
  current: { [k: string]: FundingNode },
  segment: string,
  nextSegment: string | undefined,
  value: string,
  last: boolean,
): FundingNode | undefined {
  if (last) { current[segment] = value; return undefined }
  current[segment] ??= fundingContainerFor(nextSegment!)
  return current[segment]
}

function fundingContainerFor(nextSegment: string): FundingNode[] | { [k: string]: FundingNode } {
  return FUNDING_INDEX_RE.test(nextSegment) ? [] : {}
}

function assertContiguousFundingArrays(node: FundingNode, tarballKey: TarballKey): void {
  if (Array.isArray(node)) {
    for (let index = 0; index < node.length; index++) {
      if (node[index] === undefined) {
        throw new LockfileError({ code: 'PARSE_FAILED', message: `lockgraph: funding array indices must be contiguous from 0 (${tarballKey})` })
      }
      assertContiguousFundingArrays(node[index]!, tarballKey)
    }
    return
  }
  if (node !== null && typeof node === 'object') {
    for (const value of Object.values(node)) assertContiguousFundingArrays(value, tarballKey)
  }
}

// Reconstruct the residual TarballPayload from an F row's dot-path slots
// (fields AFTER the positional TarballKey). Schema-driven: each field is rebuilt
// by its MODEL TYPE (graph.ts:50-80). An unknown slot root, an array-index gap,
// or both bin forms present are all PARSE_FAILED.
export function parseSlots(fields: string[], tarballKey: TarballKey): TarballPayload {
  const groups = groupDecodedSlots(fields, tarballKey)
  const out: Record<string, unknown> = {}
  for (const [root, slots] of groups) applyDecodedSlotGroup(out, root, slots, tarballKey)
  return out as TarballPayload
}

function groupDecodedSlots(fields: string[], tarballKey: TarballKey): Map<string, DecodedSlot[]> {
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
  return groups
}

const ARRAY_SLOT_ROOTS: Record<string, keyof TarballPayload> = {
  cpu: 'cpu', os: 'os', libc: 'libc', bundled: 'bundledDependencies',
}

function applyDecodedSlotGroup(
  out: Record<string, unknown>,
  root: string,
  slots: DecodedSlot[],
  tarballKey: TarballKey,
): void {
  const arrayField = ARRAY_SLOT_ROOTS[root]
  if (arrayField !== undefined) {
    out[arrayField] = parseStringArraySlots(root, slots, tarballKey)
    return
  }
  switch (root) {
    case 'license':
    case 'deprecated': out[root] = parseScalarSlot(root, slots, tarballKey); return
    case 'engines': out.engines = parseStringRecordSlots('engines', slots, tarballKey); return
    case 'bin': out.bin = parseBinSlots(slots, tarballKey); return
    case 'hasInstallScript': out.hasInstallScript = parseBooleanSlot(root, slots, tarballKey); return
    case 'peerDependencies': out.peerDependencies = parseStringRecordSlots(root, slots, tarballKey); return
    case 'peerDependenciesMeta': out.peerDependenciesMeta = parsePeerDependencyMetaSlots(slots, tarballKey); return
    case 'funding': out.funding = rebuildFunding(slots, tarballKey); return
    case 'resolution': out.resolution = rebuildResolution(slots, tarballKey); return
    case 'nativeResolution': out.nativeResolution = parseNativeResolutionSlot(slots, tarballKey); return
    default: throw new LockfileError({ code: 'PARSE_FAILED', message: `lockgraph: unknown F slot root '${root}' (${tarballKey})` })
  }
}

function parseScalarSlot(root: string, slots: DecodedSlot[], tarballKey: TarballKey): string {
  const slot = slots[0]!
  if (slots.length !== 1 || slot.path.length !== 1) {
    throw new LockfileError({ code: 'PARSE_FAILED', message: `lockgraph: malformed scalar '${root}' slot(s) (${tarballKey})` })
  }
  return slot.value
}

function parseStringArraySlots(root: string, slots: DecodedSlot[], tarballKey: TarballKey): string[] {
  const entries = slots.map(slot => {
    if (slot.path.length !== 2 || !FUNDING_INDEX_RE.test(slot.path[1]!)) {
      throw new LockfileError({ code: 'PARSE_FAILED', message: `lockgraph: malformed array '${root}' slot (${tarballKey})` })
    }
    return { index: Number(slot.path[1]), value: slot.value }
  })
  return rebuildStringArray(entries, root, tarballKey)
}

function parseStringRecordSlots(root: string, slots: DecodedSlot[], tarballKey: TarballKey): Record<string, string> {
  const record: Record<string, string> = {}
  for (const slot of slots) {
    if (slot.path.length !== 2) {
      throw new LockfileError({ code: 'PARSE_FAILED', message: `lockgraph: malformed ${root} slot (${tarballKey})` })
    }
    record[slot.path[1]!] = slot.value
  }
  return record
}

function parseBinSlots(slots: DecodedSlot[], tarballKey: TarballKey): string | Record<string, string> {
  const bareForm = slots.some(slot => slot.path.length === 1)
  const mapForm = slots.some(slot => slot.path.length > 1)
  if (bareForm && mapForm) {
    throw new LockfileError({ code: 'PARSE_FAILED', message: `lockgraph: bin carries both string and map forms (${tarballKey})` })
  }
  if (!bareForm) return parseStringRecordSlots('bin map', slots, tarballKey)
  if (slots.length !== 1) {
    throw new LockfileError({ code: 'PARSE_FAILED', message: `lockgraph: duplicate bare bin slot (${tarballKey})` })
  }
  return slots[0]!.value
}

function parseBooleanSlot(root: string, slots: DecodedSlot[], tarballKey: TarballKey): boolean {
  const slot = slots[0]!
  if (slots.length !== 1 || slot.path.length !== 1) {
    throw new LockfileError({ code: 'PARSE_FAILED', message: `lockgraph: malformed ${root} slot (${tarballKey})` })
  }
  return slot.value === 'true'
}

function parsePeerDependencyMetaSlots(
  slots: DecodedSlot[],
  tarballKey: TarballKey,
): Record<string, { optional?: boolean }> {
  const record: Record<string, { optional?: boolean }> = {}
  for (const slot of slots) {
    if (slot.path.length !== 3 || slot.path[2] !== 'optional') {
      throw new LockfileError({ code: 'PARSE_FAILED', message: `lockgraph: malformed peerDependenciesMeta slot (${tarballKey})` })
    }
    ;(record[slot.path[1]!] ??= {}).optional = slot.value === 'true'
  }
  return record
}

function parseNativeResolutionSlot(slots: DecodedSlot[], tarballKey: TarballKey): string {
  if (slots.length !== 1) {
    throw new LockfileError({ code: 'PARSE_FAILED', message: `lockgraph: duplicate nativeResolution slot(s) (${tarballKey})` })
  }
  const slot = slots[0]!
  if (slot.path.length !== 1) {
    throw new LockfileError({ code: 'PARSE_FAILED', message: `lockgraph: malformed nativeResolution slot (${tarballKey})` })
  }
  return slot.value
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
  appendScalarSlots(payload, out)
  appendStringArraySlots(payload, out)
  appendStringRecordSlots('engines', payload.engines, out)
  appendInstallScriptSlot(payload.hasInstallScript, out)
  appendStringRecordSlots('peerDependencies', payload.peerDependencies, out)
  appendPeerDependencyMetaSlots(payload.peerDependenciesMeta, out)
  appendBinSlots(payload.bin, out)
  if (payload.funding !== undefined) flattenFunding(payload.funding, ['funding'], out)
  appendResolutionSlots(payload.resolution, name, version, out)
  appendNativeResolutionSlot(payload.nativeResolution, payload.resolution, name, version, out)
  return out
}

function appendScalarSlots(payload: TarballPayload, out: string[]): void {
  if (payload.license !== undefined) out.push(emitSlot(['license'], payload.license))
  if (payload.deprecated !== undefined) out.push(emitSlot(['deprecated'], payload.deprecated))
}

const STRING_ARRAY_SLOT_FIELDS: Array<[keyof TarballPayload, string]> = [
  ['cpu', 'cpu'],
  ['os', 'os'],
  ['libc', 'libc'],
  ['bundledDependencies', 'bundled'],
]

function appendStringArraySlots(payload: TarballPayload, out: string[]): void {
  for (const [field, root] of STRING_ARRAY_SLOT_FIELDS) {
    const values = payload[field] as string[] | undefined
    if (values === undefined) continue
    for (let index = 0; index < values.length; index++) out.push(emitSlot([root, String(index)], values[index]!))
  }
}

function appendStringRecordSlots(root: string, record: Record<string, string> | undefined, out: string[]): void {
  if (record === undefined) return
  for (const key of Object.keys(record).sort(cmpStr)) out.push(emitSlot([root, key], record[key]!))
}

function appendInstallScriptSlot(value: boolean | undefined, out: string[]): void {
  if (value !== undefined) out.push(emitSlot(['hasInstallScript'], String(value)))
}

function appendPeerDependencyMetaSlots(
  metadata: Record<string, { optional?: boolean }> | undefined,
  out: string[],
): void {
  if (metadata === undefined) return
  for (const peer of Object.keys(metadata).sort(cmpStr)) {
    const optional = metadata[peer]!.optional
    if (optional !== undefined) out.push(emitSlot(['peerDependenciesMeta', peer, 'optional'], String(optional)))
  }
}

function appendBinSlots(bin: TarballPayload['bin'], out: string[]): void {
  if (bin === undefined) return
  if (typeof bin === 'string') { out.push(emitSlot(['bin'], bin)); return }
  for (const key of Object.keys(bin).sort(cmpStr)) out.push(emitSlot(['bin', key], bin[key]!))
}

function appendResolutionSlots(
  resolution: ResolutionCanonical | undefined,
  name: string,
  version: string,
  out: string[],
): void {
  if (resolution === undefined || isRecomposableTarballResolution(resolution, name, version)) return
  for (const key of Object.keys(resolution).sort(cmpStr)) {
    out.push(emitSlot(['resolution', key], String((resolution as Record<string, unknown>)[key])))
  }
}

function appendNativeResolutionSlot(
  native: string | undefined,
  resolution: ResolutionCanonical | undefined,
  name: string,
  version: string,
  out: string[],
): void {
  if (native === undefined || nativeRidesIntegrityUMember(native, resolution, name, version)) return
  out.push(emitSlot(['nativeResolution'], native))
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
