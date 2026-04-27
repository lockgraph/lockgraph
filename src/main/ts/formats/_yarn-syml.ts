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

function tokenizeLine(line: string, lineNum: number): Token | null {
  // Strip a `#` comment that is not inside a quoted string. We scan the
  // line tracking quote state; any unquoted `#` ends the line.
  let inQuote = false
  let cutAt = line.length
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === '\\' && inQuote) { i++; continue }
    if (c === '"') inQuote = !inQuote
    else if (c === '#' && !inQuote) { cutAt = i; break }
  }
  const stripped = line.slice(0, cutAt).replace(/\s+$/, '')
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
