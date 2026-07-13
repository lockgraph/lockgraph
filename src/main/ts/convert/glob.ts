import { LockfileError } from '../errors.ts'

const MAGIC_RE = /[*?[\]{}]/
const MAX_BRACE_EXPANSIONS = 256

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+*?.-]/g, '\\$&')
}

interface BraceSplit {
  readonly start: number
  readonly end: number
  readonly parts: readonly string[]
}

function firstBraceSplit(pattern: string): BraceSplit | undefined {
  let depth = 0
  let start = -1
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index]
    if (char === '{') {
      if (depth === 0) start = index
      depth++
      continue
    }
    if (char !== '}' || depth === 0) continue
    depth--
    if (depth !== 0 || start < 0) continue
    const body = pattern.slice(start + 1, index)
    const parts: string[] = []
    let partStart = 0
    let nested = 0
    for (let cursor = 0; cursor <= body.length; cursor++) {
      const current = body[cursor]
      if (current === '{') nested++
      else if (current === '}') nested--
      else if ((current === ',' || cursor === body.length) && nested === 0) {
        parts.push(body.slice(partStart, cursor))
        partStart = cursor + 1
      }
    }
    if (parts.length < 2) return undefined
    return { start, end: index, parts }
  }
  return undefined
}

export function expandBraces(pattern: string): readonly string[] {
  const pending = [pattern]
  const output: string[] = []
  while (pending.length > 0) {
    const current = pending.pop()!
    const split = firstBraceSplit(current)
    if (split === undefined) {
      output.push(current)
      continue
    }
    if (pending.length + output.length + split.parts.length > MAX_BRACE_EXPANSIONS) {
      throw new LockfileError({
        code: 'INVALID_INPUT',
        message: `glob brace expansion exceeds ${MAX_BRACE_EXPANSIONS} results: ${pattern}`,
      })
    }
    for (let index = split.parts.length - 1; index >= 0; index--) {
      pending.push(
        `${current.slice(0, split.start)}${split.parts[index]!}${current.slice(split.end + 1)}`,
      )
    }
  }
  return output
}

export function hasGlobMagic(segment: string): boolean {
  return MAGIC_RE.test(segment)
}

export function globSegmentRegExp(segment: string): RegExp {
  let source = '^'
  for (let index = 0; index < segment.length; index++) {
    const char = segment[index]!
    if (char === '*') {
      while (segment[index + 1] === '*') index++
      source += '[^/]*'
      continue
    }
    if (char === '?') {
      source += '[^/]'
      continue
    }
    if (char === '[') {
      const end = segment.indexOf(']', index + 1)
      if (end > index + 1) {
        const body = segment.slice(index + 1, end)
        source += `[${body.startsWith('!') ? `^${body.slice(1)}` : body}]`
        index = end
        continue
      }
    }
    source += escapeRegExp(char)
  }
  source += '$'
  return new RegExp(source)
}

function patternRegExp(pattern: string): RegExp {
  const segments = pattern.split('/').filter(Boolean)
  let source = '^'
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index]!
    if (segment === '**') {
      source += index === segments.length - 1 ? '(?:[^/]+/)*[^/]*' : '(?:[^/]+/)*'
      continue
    }
    source += globSegmentRegExp(segment).source.slice(1, -1)
    if (index < segments.length - 1) source += '/'
  }
  source += '$'
  return new RegExp(source)
}

function positiveMatch(path: string, pattern: string): boolean {
  return expandBraces(pattern).some(expanded => patternRegExp(expanded).test(path))
}

export function matchesGlobSet(path: string, patterns: readonly string[]): boolean {
  const positives = patterns.filter(pattern => !pattern.startsWith('!'))
  if (positives.length === 0 || !positives.some(pattern => positiveMatch(path, pattern))) return false
  return !patterns.some(pattern => pattern.startsWith('!') && positiveMatch(path, pattern.slice(1)))
}
