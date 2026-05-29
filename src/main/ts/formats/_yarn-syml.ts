// Hand-rolled minimal SYML parser — yarn's YAML dialect for `yarn.lock`.
//
// Reference (not imported):
//   https://github.com/yarnpkg/berry/blob/master/packages/yarnpkg-parsers/sources/syml.ts
//
// Scope: the subset emitted by yarn ≥ 2 in `yarn.lock`. Two-space indent;
// quoted/unquoted keys; scalar string values; nested maps; `#` comments.
// No anchors, flow style, or block scalars — yarn's writer doesn't emit
// them. Output is a JSON-like AST; caller (yarn-berry-vN adapter)
// interprets entry keys (incl. multi-spec `"foo@npm:^1, foo@npm:^2"`).

export type SymlValue = string | SymlMap
export interface SymlMap { [key: string]: SymlValue }

const YAML_NUMBER_RE = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$/
const YAML_BOOLEAN_RE = /^(true|false|yes|no|on|off)$/i
const YAML_NULL_RE = /^(null|~)$/
const YAML_SPECIAL_RE = /[ \t:,[\]{}#&*!|>'"%@`]/

export class SymlParseError extends Error {
  readonly line: number
  constructor(message: string, line: number) {
    super(`${message} (line ${line + 1})`)
    this.name = 'SymlParseError'
    this.line = line
  }
}

interface Token {
  indent: number    // depth in 2-space units
  key:    string
  value?: string    // undefined = block expected
  line:   number    // 0-based, for diagnostics
}

function findClosingQuote(s: string, start: number): number {
  // s[start] is `"`. Returns index of the matching closing quote.
  for (let i = start + 1; i < s.length; i++) {
    if (s[i] === '\\') { i++; continue }
    if (s[i] === '"') return i
  }
  throw new Error(`unterminated quoted string starting at column ${start + 1}`)
}

function unquote(s: string): string {
  return s.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\')
}

// Strip a `#` comment that is not inside a quoted string, then right-trim.
// Scans tracking quote state; any unquoted `#` ends the line.
function stripComment(line: string): string {
  let inQuote = false
  let cutAt = line.length
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === '\\' && inQuote) { i++; continue }
    if (c === '"') inQuote = !inQuote
    else if (c === '#' && !inQuote) { cutAt = i; break }
  }
  return line.slice(0, cutAt).replace(/\s+$/, '')
}

// Leading-space count (even-multiple-of-2 enforced by callers).
function leadingSpaces(s: string): number {
  let p = 0
  while (p < s.length && s[p] === ' ') p++
  return p
}

// Parse the key half of an explicit `? <key>` line (the text after `? `).
// yarn only emits this form for long (quoted) keys, but accept bare too.
function parseExplicitKey(keyPart: string): string {
  const trimmed = keyPart.replace(/\s+$/, '')
  if (trimmed[0] === '"') {
    const end = findClosingQuote(trimmed, 0)
    return unquote(trimmed.slice(0, end + 1))
  }
  return trimmed
}

function tokenizeLine(line: string, lineNum: number): Token | null {
  const stripped = stripComment(line)
  if (stripped === '') return null

  // Indent — must be even.
  let pos = 0
  while (pos < stripped.length && stripped[pos] === ' ') pos++
  if (pos % 2 !== 0) {
    throw new SymlParseError(`indent must be a multiple of 2`, lineNum)
  }
  const indent = pos / 2

  // Key.
  let key: string
  if (stripped[pos] === '"') {
    const end = findClosingQuote(stripped, pos)
    key = unquote(stripped.slice(pos, end + 1))
    pos = end + 1
  } else {
    // Unquoted key — read up to (but not including) `:`.
    const colonIdx = stripped.indexOf(':', pos)
    if (colonIdx < 0) {
      throw new SymlParseError(`expected ':' after key`, lineNum)
    }
    key = stripped.slice(pos, colonIdx).replace(/\s+$/, '')
    pos = colonIdx
  }

  if (stripped[pos] !== ':') {
    throw new SymlParseError(`expected ':' after key`, lineNum)
  }
  pos++
  while (pos < stripped.length && stripped[pos] === ' ') pos++

  if (pos >= stripped.length) {
    return { indent, key, line: lineNum }
  }

  // Value.
  let value: string
  if (stripped[pos] === '"') {
    const end = findClosingQuote(stripped, pos)
    value = unquote(stripped.slice(pos, end + 1))
    // Anything trailing is junk (or another comment, already stripped).
    const trailing = stripped.slice(end + 1).replace(/\s+/g, '')
    if (trailing !== '') {
      throw new SymlParseError(`unexpected trailing characters after quoted value: ${trailing}`, lineNum)
    }
  } else {
    value = stripped.slice(pos)
  }
  return { indent, key, value, line: lineNum }
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = []
  const lines = input.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line === undefined) continue

    // YAML 1.2 §8.1.3 explicit block-mapping key. yarn's writer falls back
    // to the `? <key>` / `:` form when a (composite) descriptor key exceeds
    // an internal line-width threshold — e.g. ~15 patched-`typescript`
    // descriptors concatenated into one ~2 KB key (highlight/highlight).
    // Normalise it here into the same block-key token the canonical
    // `"<key>":` form produces, so the parse loop is unchanged:
    //
    //   ? "<key>"          <- explicit-key marker + key (this line)
    //   :                  <- value indicator (next non-blank line)
    //     <block at +1>    <- the value map, parsed normally
    //
    // Stringify always emits the canonical inline form; yarn re-reads it.
    const stripped = stripComment(line)
    const pos = leadingSpaces(stripped)
    if (stripped !== '' && stripped[pos] === '?' && stripped[pos + 1] === ' ') {
      if (pos % 2 !== 0) throw new SymlParseError('indent must be a multiple of 2', i)
      const indent = pos / 2
      const key = parseExplicitKey(stripped.slice(pos + 2))

      // Consume the `:` value-indicator line (the next non-blank line).
      let j = i + 1
      let found = false
      for (; j < lines.length; j++) {
        const peek = stripComment(lines[j] ?? '')
        if (peek === '') continue
        if (peek.slice(leadingSpaces(peek)) !== ':') {
          throw new SymlParseError(`expected ':' value indicator after explicit '?' key`, j)
        }
        found = true
        break
      }
      if (!found) throw new SymlParseError(`explicit '?' key missing ':' value indicator`, i)

      tokens.push({ indent, key, line: i })
      i = j // skip through the `:` line; the loop's i++ advances to the block
      continue
    }

    let t: Token | null
    try {
      t = tokenizeLine(line, i)
    } catch (e) {
      if (e instanceof SymlParseError) throw e
      throw new SymlParseError((e as Error).message, i)
    }
    if (t) tokens.push(t)
  }
  return tokens
}

export function parse(input: string): SymlMap {
  const tokens = tokenize(input)
  const root: SymlMap = {}
  const stack: Array<{ map: SymlMap; indent: number }> = [{ map: root, indent: -1 }]

  for (const t of tokens) {
    while (stack.length > 1) {
      const top = stack[stack.length - 1]
      if (!top || top.indent < t.indent) break
      stack.pop()
    }
    const top = stack[stack.length - 1]
    if (!top) {
      throw new SymlParseError(`internal: empty parser stack`, t.line)
    }
    if (t.indent !== top.indent + 1) {
      throw new SymlParseError(`unexpected indent ${t.indent}, parent at ${top.indent}`, t.line)
    }
    if (t.key in top.map) {
      throw new SymlParseError(`duplicate key: ${t.key}`, t.line)
    }
    if (t.value === undefined) {
      const child: SymlMap = {}
      top.map[t.key] = child
      stack.push({ map: child, indent: t.indent })
    } else {
      top.map[t.key] = t.value
    }
  }

  return root
}

function needsQuotes(raw: string): boolean {
  if (raw === '') return true
  if (YAML_SPECIAL_RE.test(raw)) return true
  if (raw[0] === '-' || raw[0] === '?') return true
  if (YAML_NUMBER_RE.test(raw)) return true
  if (YAML_BOOLEAN_RE.test(raw)) return true
  if (YAML_NULL_RE.test(raw)) return true
  for (let i = 0; i < raw.length; i++) {
    if (raw.charCodeAt(i) > 0x7f) return true
  }
  return false
}

function escapeQuoted(raw: string): string {
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    const c = raw[i]
    if (c === '\\') out += '\\\\'
    else if (c === '"') out += '\\"'
    else if (c === '\n') out += '\\n'
    else if (c === '\t') out += '\\t'
    else if (c === '\r') out += '\\r'
    else if (code > 0x7f) out += `\\u${code.toString(16).padStart(4, '0')}`
    else out += c
  }
  return out
}

function formatScalar(raw: string): string {
  return needsQuotes(raw) ? `"${escapeQuoted(raw)}"` : raw
}

function renderMap(map: SymlMap, indent: number, topLevel: boolean): string[] {
  const lines: string[] = []
  const entries = Object.entries(map)
  const pad = '  '.repeat(indent)

  for (let i = 0; i < entries.length; i++) {
    const [key, value] = entries[i] ?? []
    if (key === undefined || value === undefined) continue
    if (typeof value === 'string') {
      lines.push(`${pad}${formatScalar(key)}: ${formatScalar(value)}`)
    } else {
      lines.push(`${pad}${formatScalar(key)}:`)
      lines.push(...renderMap(value, indent + 1, false))
    }
    if (topLevel && i < entries.length - 1) lines.push('')
  }

  return lines
}

export function stringify(value: SymlMap): string {
  return renderMap(value, 0, true).join('\n') + '\n'
}
