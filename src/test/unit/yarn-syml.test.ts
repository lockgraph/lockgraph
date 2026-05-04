import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { parse, SymlParseError, type SymlMap } from '../../main/ts/formats/_yarn-syml.ts'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = (rel: string): string =>
  readFileSync(resolve(here, '../resources/fixtures/lockfiles', rel), 'utf8')

describe('SYML — synthetic', () => {
  it('empty input → empty map', () => {
    expect(parse('')).toEqual({})
  })

  it('blank lines and comments ignored', () => {
    expect(parse('\n# comment\n   # indented comment\n\n')).toEqual({})
  })

  it('top-level scalar', () => {
    expect(parse('key: value\n')).toEqual({ key: 'value' })
  })

  it('quoted key and quoted value', () => {
    expect(parse('"a key": "a value"\n')).toEqual({ 'a key': 'a value' })
  })

  it('quoted key may contain @ ( ) , : whitespace', () => {
    expect(parse('"foo@npm:^1, foo@npm:^2": x\n')).toEqual({ 'foo@npm:^1, foo@npm:^2': 'x' })
  })

  it('unquoted value preserves ^ ~ : / digits', () => {
    expect(parse('checksum: 10c0/abcdef\n')).toEqual({ checksum: '10c0/abcdef' })
    expect(parse('range: ^18.2.0\n')).toEqual({ range: '^18.2.0' })
  })

  it('escape sequences in quoted strings', () => {
    expect(parse('key: "a \\"quote\\" and \\\\slash"\n'))
      .toEqual({ key: 'a "quote" and \\slash' })
  })

  it('nested map via empty value + indent', () => {
    expect(parse('a:\n  b: 1\n  c: 2\n')).toEqual({ a: { b: '1', c: '2' } })
  })

  it('two-level nesting', () => {
    expect(parse('a:\n  b:\n    c: x\n')).toEqual({ a: { b: { c: 'x' } } })
  })

  it('siblings after dedent', () => {
    expect(parse('a:\n  b: 1\nc: 2\n')).toEqual({ a: { b: '1' }, c: '2' })
  })

  it('odd indent rejected', () => {
    expect(() => parse('a:\n c: x\n')).toThrow(SymlParseError)
  })

  it('inconsistent indent jump rejected', () => {
    expect(() => parse('a:\n    b: x\n')).toThrow(/unexpected indent/)
  })

  it('duplicate key rejected', () => {
    expect(() => parse('a: 1\na: 2\n')).toThrow(/duplicate key/)
  })

  it('unterminated quote rejected', () => {
    expect(() => parse('"unterminated: x\n')).toThrow(SymlParseError)
  })

  it('inline `#` inside quoted value is preserved', () => {
    expect(parse('k: "a # b"\n')).toEqual({ k: 'a # b' })
  })

  it('trailing `#` comment after value stripped', () => {
    expect(parse('k: v   # trailing\n')).toEqual({ k: 'v' })
  })

  it('keys without value followed by no children → empty map', () => {
    expect(parse('a:\n')).toEqual({ a: {} })
  })
})

describe('SYML — yarn-berry-v9 fixtures', () => {
  const cases = ['simple', 'patch-yarn', 'peers-basic', 'peers-multi', 'workspaces-basic', 'yarn-crlf']

  for (const c of cases) {
    it(`parses ${c}/yarn-berry-v9.lock`, () => {
      const tree = parse(fixture(`${c}/yarn-berry-v9.lock`))
      // __metadata block is always present.
      const meta = tree['__metadata']
      expect(typeof meta).toBe('object')
      expect((meta as SymlMap)['version']).toBe('9')
      expect((meta as SymlMap)['cacheKey']).toBe('10c0')
      // Every other top-level key is an entry.
      const entries = Object.keys(tree).filter(k => k !== '__metadata')
      expect(entries.length).toBeGreaterThan(0)
      for (const k of entries) {
        const e = tree[k]
        expect(typeof e).toBe('object')
        const entry = e as SymlMap
        expect(entry['version']).toBeDefined()
        expect(entry['resolution']).toBeDefined()
      }
    })
  }

  it('peers-basic preserves `react: ^18.2.0` peerDependencies range', () => {
    const tree = parse(fixture('peers-basic/yarn-berry-v9.lock'))
    const rd = tree['react-dom@npm:18.2.0'] as SymlMap
    const peers = rd['peerDependencies'] as SymlMap
    expect(peers['react']).toBe('^18.2.0')
  })

  it('peers-basic captures multi-spec key verbatim', () => {
    const tree = parse(fixture('peers-basic/yarn-berry-v9.lock'))
    expect(tree['js-tokens@npm:^3.0.0 || ^4.0.0']).toBeDefined()
  })

  it('workspaces-basic captures both workspace nodes', () => {
    const tree = parse(fixture('workspaces-basic/yarn-berry-v9.lock'))
    expect(tree['@case-ws/a@workspace:packages/a']).toBeDefined()
    expect(tree['@case-ws/b@workspace:packages/b']).toBeDefined()
    expect(tree['case-workspaces-basic@workspace:.']).toBeDefined()
  })

  const yarnCrlfAdapters = [
    'npm-1', 'npm-2', 'npm-3',
    'yarn-classic',
    'yarn-berry-v4', 'yarn-berry-v5', 'yarn-berry-v6', 'yarn-berry-v8', 'yarn-berry-v9',
    'pnpm-v5', 'pnpm-v6', 'pnpm-v9',
    'bun-text',
  ]
  for (const adapter of yarnCrlfAdapters) {
    it(`yarn-crlf/${adapter}.lock is CRLF-only (no bare LF or CR)`, () => {
      const raw = fixture(`yarn-crlf/${adapter}.lock`)
      expect(raw).toContain('\r\n')
      // Strip CRLF pairs; any remaining \r or \n is a bare/mixed line ending.
      const stripped = raw.replace(/\r\n/g, '')
      expect(stripped).not.toContain('\n')
      expect(stripped).not.toContain('\r')
    })
  }
})
