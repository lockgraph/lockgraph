// _pnpm-yaml.ts — minimal YAML reader/emitter scoped to the pnpm-emitted
// subset of YAML 1.2.
//
// Split from `_pnpm-flat-core.ts` per ADR-0022 §5 — the codec is
// single-responsibility (YAML in/out) and lives independently from any pnpm
// semantics (lockfileVersion handshake, section ordering, override key shape).
// The codec accepts structural options only:
//
//   - `topLevelOrder` pins root-key emit order (caller-supplied table).
//   - `topLevelSectionKeys` declares which top-level keys behave as
//     "sections" (immediate children prefixed with a blank line, pnpm's
//     `packages:` / `snapshots:` style).
//
// Codec-supplied typed surface for format-affecting variants — these are public
// discriminated wrappers, not magic properties on YamlMap:
//
//   - `flowMap(entries)` — emit as `{k: v, …}` inline flow map.
//   - `quoted(value)`    — force single-quoted scalar (e.g. `'9.0'`).
//
// The codec dispatches on the tagged kind; no string keys are reserved.
//
// Scope of the supported YAML subset:
//
//   - block-style maps (`<key>:\n  <subkey>: <value>`)
//   - flow-style maps for compact records (`resolution: {integrity: sha512-...}`)
//   - scalars: bare strings, quoted strings (`'9.0'`, `'>=4'`), booleans
//   - keys may be bare (`react`), quoted (`'@types/node@20.11.30'`), or
//     contain `@`, `(`, `)`, `/` characters (packages keys)
//   - 2-space indent, LF newlines
//
// This module is not a general-purpose YAML 1.2 implementation. Upstream
// pnpm-emitted fixtures drive the corpus.

// === Public surface ========================================================

export interface YamlMap { [k: string]: unknown }

// --- Typed wrappers -------------------------------------------------------

const FLOW_MAP_TAG = Symbol.for('lockgraph/_pnpm-yaml/flow-map')
const QUOTED_TAG = Symbol.for('lockgraph/_pnpm-yaml/quoted')

export interface YamlFlowMap {
  readonly [FLOW_MAP_TAG]: true
  readonly entries: YamlMap
}

export interface YamlQuotedScalar {
  readonly [QUOTED_TAG]: true
  readonly value: string
}

/** Wrap an entries record as a flow-style inline map (`{k: v, ...}`). */
export function flowMap(entries: YamlMap): YamlFlowMap {
  return { [FLOW_MAP_TAG]: true, entries }
}

/** Wrap a string scalar to force single-quoted emit. */
export function quoted(value: string): YamlQuotedScalar {
  return { [QUOTED_TAG]: true, value }
}

function isFlowMap(value: unknown): value is YamlFlowMap {
  return value !== null && typeof value === 'object' && (value as YamlFlowMap)[FLOW_MAP_TAG] === true
}

function isQuotedScalar(value: unknown): value is YamlQuotedScalar {
  return value !== null && typeof value === 'object' && (value as YamlQuotedScalar)[QUOTED_TAG] === true
}

// --- Codec API ------------------------------------------------------------

export function readYaml(input: string): YamlMap {
  const reader: YamlReader = {
    source: input,
    lines: input.split('\n'),
    pos: 0,
  }
  return readBlockMap(reader, 0)
}

/**
 * Emit a `YamlMap` as YAML.
 *
 * `topLevelOrder` pins the order of top-level keys; unknown keys retain
 * insertion order at the tail. `topLevelSectionKeys` declares which keys
 * are "top-level sections" — their immediate children get a blank line
 * before each entry (pnpm's `packages:` / `snapshots:` style).
 *
 * NO pnpm-specific keys or behaviours are hardcoded here. Force-quoted
 * scalars are expressed via `quoted(value)`; inline flow maps via
 * `flowMap(entries)`.
 */
export function emitYaml(
  root: YamlMap,
  options: {
    topLevelOrder: readonly string[]
    topLevelSectionKeys?: ReadonlyArray<string>
  },
): string {
  const lines: string[] = []
  const sectionKeys = new Set(options.topLevelSectionKeys ?? [])
  const keys = orderTopLevelKeys(root, options.topLevelOrder)
  let firstSection = true
  for (const key of keys) {
    if (!(key in root)) continue
    const value = root[key]
    if (value === undefined) continue
    if (!firstSection) lines.push('')
    firstSection = false
    if (isFlowMap(value)) {
      lines.push(`${emitScalarKey(key)}: ${emitFlowMap(value.entries)}`)
      continue
    }
    if (isQuotedScalar(value)) {
      lines.push(`${emitScalarKey(key)}: ${emitQuoted(value.value)}`)
      continue
    }
    if (isPlainObject(value)) {
      lines.push(`${emitScalarKey(key)}:`)
      emitBlockMap(lines, value as YamlMap, 1, sectionKeys.has(key) ? key : undefined)
    } else if (Array.isArray(value)) {
      if (value.length === 0) {
        lines.push(`${emitScalarKey(key)}: []`)
      } else {
        lines.push(`${emitScalarKey(key)}:`)
        for (const item of value) {
          lines.push(`- ${emitScalar(String(item))}`)
        }
      }
    } else if (typeof value === 'boolean') {
      lines.push(`${emitScalarKey(key)}: ${value}`)
    } else {
      lines.push(`${emitScalarKey(key)}: ${emitScalar(String(value))}`)
    }
  }
  return lines.join('\n') + '\n'
}

// === Reader ================================================================

interface YamlReader {
  source: string
  lines: string[]
  pos: number
}

function readBlockMap(reader: YamlReader, baseIndent: number): YamlMap {
  const out: YamlMap = {}
  while (reader.pos < reader.lines.length) {
    const line = reader.lines[reader.pos]
    if (line === undefined) { reader.pos++; continue }
    if (isBlankOrComment(line)) { reader.pos++; continue }
    const indent = leadingSpaces(line)
    if (indent < baseIndent) break
    if (indent > baseIndent) {
      reader.pos++
      continue
    }
    const content = line.slice(indent)
    const colonIdx = findKeyColon(content)
    if (colonIdx < 0) {
      reader.pos++
      continue
    }
    const rawKey = content.slice(0, colonIdx).trimEnd()
    const key = unquoteKey(rawKey)
    const rest = content.slice(colonIdx + 1)
    const restClean = stripInlineComment(rest).trimEnd()
    const restValue = restClean.replace(/^ +/, '')

    reader.pos++
    if (restValue === '') {
      // The child is either a nested block map or a block SEQUENCE (`- item`
      // lines). Peek the next non-blank line: a `- `-led item belongs to this
      // key whether indented DEEPER than the key (pnpm input style, e.g.
      // `transitivePeerDependencies:` with items at +2) or at the SAME indent
      // as the key (this codec's own emit style for `cpu`/`os`/`libc`). Both
      // are valid YAML; without recognising them a block sequence reads back as
      // `{}` and the list is silently dropped (breaking re-parse round-trip).
      out[key] = peekIsBlockSequence(reader, baseIndent)
        ? readBlockSequence(reader, baseIndent)
        : readBlockMap(reader, baseIndent + 2)
    } else if (restValue === '|' || restValue === '>') {
      while (reader.pos < reader.lines.length) {
        const next = reader.lines[reader.pos]
        if (next === undefined) break
        const ind = leadingSpaces(next)
        if (next.trim().length > 0 && ind <= baseIndent) break
        reader.pos++
      }
      out[key] = ''
    } else {
      out[key] = parseInlineValue(restValue)
    }
  }
  return out
}

/**
 * Peek (without advancing) whether the block following a just-consumed
 * `<key>:` line is a block SEQUENCE — its first non-blank line, at indent
 * `>= baseIndent`, has content starting with `- `. A `-` item at the SAME
 * indent as the key belongs to that key (valid YAML, and this codec's own
 * emit style for `cpu`/`os`/`libc`); a deeper one does too (pnpm input style,
 * e.g. `transitivePeerDependencies:`). Any non-`-` line ends the peek as a map
 * (or sibling). The reader must distinguish sequences from nested block maps
 * so the items are not lost.
 */
function peekIsBlockSequence(reader: YamlReader, baseIndent: number): boolean {
  for (let i = reader.pos; i < reader.lines.length; i++) {
    const line = reader.lines[i]
    if (line === undefined) continue
    if (isBlankOrComment(line)) continue
    const indent = leadingSpaces(line)
    if (indent < baseIndent) return false
    const content = line.slice(indent)
    return content === '-' || content.startsWith('- ')
  }
  return false
}

/**
 * Read a scalar block sequence (`- item` lines) whose items sit at indent
 * `>= baseIndent` (same-as-key or deeper — see `peekIsBlockSequence`). Items
 * are parsed with the same inline-scalar grammar as map values (quoted /
 * bare). Stops at the first line below `baseIndent`, or at any non-`-` line at
 * `baseIndent` (a sibling key). Scoped to the pnpm/codec subset: scalar items
 * only (no nested block maps under a `-`).
 */
function readBlockSequence(reader: YamlReader, baseIndent: number): unknown[] {
  const out: unknown[] = []
  while (reader.pos < reader.lines.length) {
    const line = reader.lines[reader.pos]
    if (line === undefined) { reader.pos++; continue }
    if (isBlankOrComment(line)) { reader.pos++; continue }
    const indent = leadingSpaces(line)
    if (indent < baseIndent) break
    const content = line.slice(indent)
    if (content !== '-' && !content.startsWith('- ')) break
    const itemRaw = content === '-' ? '' : content.slice(2)
    out.push(parseInlineValue(stripInlineComment(itemRaw).trim()))
    reader.pos++
  }
  return out
}

function findKeyColon(content: string): number {
  let inQuote: '"' | "'" | null = null
  let depth = 0
  for (let i = 0; i < content.length; i++) {
    const c = content[i]
    if (inQuote) {
      if (c === '\\' && inQuote === '"') { i++; continue }
      if (c === inQuote) inQuote = null
      continue
    }
    if (c === '"' || c === "'") {
      inQuote = c as '"' | "'"
      continue
    }
    if (c === '(') depth++
    else if (c === ')') depth = Math.max(0, depth - 1)
    else if (c === ':' && depth === 0) {
      if (i === content.length - 1 || content[i + 1] === ' ') return i
    }
  }
  return -1
}

function leadingSpaces(line: string): number {
  let i = 0
  while (i < line.length && line[i] === ' ') i++
  return i
}

function isBlankOrComment(line: string): boolean {
  const trimmed = line.trim()
  return trimmed.length === 0 || trimmed.startsWith('#')
}

function unquoteKey(raw: string): string {
  if (raw.length >= 2 && raw[0] === "'" && raw[raw.length - 1] === "'") {
    return raw.slice(1, -1).replace(/''/g, "'")
  }
  if (raw.length >= 2 && raw[0] === '"' && raw[raw.length - 1] === '"') {
    return raw.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  }
  return raw
}

function stripInlineComment(s: string): string {
  let inQuote: '"' | "'" | null = null
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (inQuote) {
      if (c === '\\' && inQuote === '"') { i++; continue }
      if (c === inQuote) inQuote = null
      continue
    }
    if (c === '"' || c === "'") {
      inQuote = c as '"' | "'"
      continue
    }
    if (c === '#' && (i === 0 || s[i - 1] === ' ')) {
      return s.slice(0, i)
    }
  }
  return s
}

function parseInlineValue(raw: string): unknown {
  const trimmed = raw.trim()
  if (trimmed === '') return ''
  if (trimmed === 'true') return true
  if (trimmed === 'false') return false
  if (trimmed === 'null' || trimmed === '~') return null
  if (trimmed === '{}') return {}
  if (trimmed === '[]') return []
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    return parseFlowMap(trimmed)
  }
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return parseFlowList(trimmed)
  }
  if ((trimmed.startsWith("'") && trimmed.endsWith("'")) || (trimmed.startsWith('"') && trimmed.endsWith('"'))) {
    return unquoteKey(trimmed)
  }
  return trimmed
}

function parseFlowMap(input: string): YamlMap {
  const body = input.slice(1, -1).trim()
  if (body === '') return {}
  const out: YamlMap = {}
  const items = splitFlowItems(body)
  for (const item of items) {
    const colon = findFlowColon(item)
    if (colon < 0) continue
    const rawKey = item.slice(0, colon).trim()
    const rawValue = item.slice(colon + 1).trim()
    out[unquoteKey(rawKey)] = parseInlineValue(rawValue)
  }
  return out
}

function parseFlowList(input: string): unknown[] {
  const body = input.slice(1, -1).trim()
  if (body === '') return []
  const items = splitFlowItems(body)
  return items.map(item => parseInlineValue(item.trim()))
}

function splitFlowItems(body: string): string[] {
  const out: string[] = []
  let depth = 0
  let inQuote: '"' | "'" | null = null
  let start = 0
  for (let i = 0; i < body.length; i++) {
    const c = body[i]
    if (inQuote) {
      if (c === '\\' && inQuote === '"') { i++; continue }
      if (c === inQuote) inQuote = null
      continue
    }
    if (c === '"' || c === "'") {
      inQuote = c as '"' | "'"
      continue
    }
    if (c === '{' || c === '[') depth++
    else if (c === '}' || c === ']') depth--
    else if (c === ',' && depth === 0) {
      out.push(body.slice(start, i))
      start = i + 1
    }
  }
  out.push(body.slice(start))
  return out.map(s => s.trim()).filter(s => s.length > 0)
}

function findFlowColon(item: string): number {
  let inQuote: '"' | "'" | null = null
  let depth = 0
  for (let i = 0; i < item.length; i++) {
    const c = item[i]
    if (inQuote) {
      if (c === '\\' && inQuote === '"') { i++; continue }
      if (c === inQuote) inQuote = null
      continue
    }
    if (c === '"' || c === "'") {
      inQuote = c as '"' | "'"
      continue
    }
    if (c === '{' || c === '[') depth++
    else if (c === '}' || c === ']') depth--
    else if (c === ':' && depth === 0) return i
  }
  return -1
}

// === Emitter ===============================================================

function orderTopLevelKeys(root: YamlMap, order: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const k of order) {
    if (k in root) { out.push(k); seen.add(k) }
  }
  for (const k of Object.keys(root)) {
    if (!seen.has(k)) { out.push(k); seen.add(k) }
  }
  return out
}

function emitBlockMap(lines: string[], map: YamlMap, depth: number, sectionKey?: string): void {
  const indent = '  '.repeat(depth)
  const entries = Object.entries(map)
  const isTopSubsection = depth === 1 && sectionKey !== undefined
  for (let i = 0; i < entries.length; i++) {
    const pair = entries[i]
    if (pair === undefined) continue
    const [key, value] = pair
    const emittedKey = emitScalarKey(key)
    if (isTopSubsection) lines.push('')
    if (value === undefined || value === null) {
      lines.push(`${indent}${emittedKey}:`)
      continue
    }
    if (isFlowMap(value)) {
      if (Object.keys(value.entries).length === 0) {
        lines.push(`${indent}${emittedKey}: {}`)
      } else {
        lines.push(`${indent}${emittedKey}: ${emitFlowMap(value.entries)}`)
      }
      continue
    }
    if (isQuotedScalar(value)) {
      lines.push(`${indent}${emittedKey}: ${emitQuoted(value.value)}`)
      continue
    }
    if (isPlainObject(value)) {
      const obj = value as YamlMap
      const objEntries = Object.entries(obj)
      if (objEntries.length === 0) {
        lines.push(`${indent}${emittedKey}: {}`)
      } else {
        lines.push(`${indent}${emittedKey}:`)
        emitBlockMap(lines, obj, depth + 1)
      }
    } else if (Array.isArray(value)) {
      if (value.length === 0) {
        lines.push(`${indent}${emittedKey}: []`)
      } else {
        lines.push(`${indent}${emittedKey}:`)
        for (const item of value) {
          lines.push(`${indent}- ${emitScalar(String(item))}`)
        }
      }
    } else if (typeof value === 'boolean') {
      lines.push(`${indent}${emittedKey}: ${value}`)
    } else {
      lines.push(`${indent}${emittedKey}: ${emitScalar(String(value))}`)
    }
  }
}

function emitFlowMap(obj: YamlMap): string {
  const parts: string[] = []
  const entries = Object.entries(obj)
  for (const [key, value] of entries) {
    const k = emitScalarKey(key)
    let v: string
    if (isFlowMap(value)) v = emitFlowMap(value.entries)
    else if (isQuotedScalar(value)) v = emitQuoted(value.value)
    else if (typeof value === 'boolean') v = String(value)
    else if (typeof value === 'string') v = emitScalar(value)
    else if (isPlainObject(value)) v = emitFlowMap(value as YamlMap)
    else if (Array.isArray(value)) v = `[${(value as unknown[]).map(item => emitScalar(String(item))).join(', ')}]`
    else v = emitScalar(String(value))
    parts.push(`${k}: ${v}`)
  }
  return `{${parts.join(', ')}}`
}

function emitScalarKey(key: string): string {
  if (keyNeedsQuoting(key)) return `'${key.replace(/'/g, "''")}'`
  return key
}

function keyNeedsQuoting(key: string): boolean {
  if (key === '') return true
  if (key.startsWith('@')) return true
  if (/^[!&*>|?:\-,\[\]{}'"%]/.test(key)) return true
  if (/^(true|false|null|~|yes|no|on|off)$/i.test(key)) return true
  return false
}

function emitScalar(value: string): string {
  if (value === '') return "''"
  if (/^(true|false|null|~)$/i.test(value)) return `'${value}'`
  // `@` and `` ` `` are YAML reserved indicators — a plain scalar may not start
  // with them, so pnpm quotes e.g. `'@vitejs/x@file:…'`. Match that (leaving them
  // unquoted risks a strict-parser rejection and always breaks byte-identity).
  if (/^[>!&*|?:\-,\[\]{}%@`]/.test(value)) return `'${value.replace(/'/g, "''")}'`
  // `#` only starts a comment at position 0 or after whitespace; pnpm leaves an
  // in-word `#` (git-ref URLs like `…git#sha`) unquoted, so quote only those two.
  // `\s` (not a literal space) so a TAB before `#` also quotes — a strict YAML
  // reader (js-yaml, pnpm's actual parser) treats `\t#` as a comment start.
  if (/(^#|\s#)/.test(value) || / : /.test(value)) return `'${value.replace(/'/g, "''")}'`
  return value
}

function emitQuoted(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

// === Internal helpers ======================================================

function isPlainObject(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
