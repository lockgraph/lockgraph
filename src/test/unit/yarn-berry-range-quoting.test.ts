import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseV4, stringify as stringifyV4 } from '../../main/ts/formats/yarn-berry-v4.ts'
import { parse as parseV8, stringify as stringifyV8 } from '../../main/ts/formats/yarn-berry-v8.ts'
import { stringify as stringifySyml } from '../../main/ts/formats/_yarn-syml.ts'

const here = dirname(fileURLToPath(import.meta.url))
const fix = (rel: string): string =>
  readFileSync(resolve(here, '../resources/fixtures/lockfiles', rel), 'utf8')
const FIX_ROOT = resolve(here, '../resources/fixtures')

// Extract every `<name>: <value>` pair that appears inside a dependency /
// peerDependency block, returning the VERBATIM value token (with surrounding
// quotes if the emitter quoted it). This isolates the value-quoting decision
// from unrelated round-trip concerns (field ordering, entry-key merge).
const BLOCK_KEYS = new Set([
  'dependencies', 'optionalDependencies', 'peerDependencies',
])
function depValueTokens(lock: string): Map<string, string> {
  const out = new Map<string, string>()
  const lines = lock.replace(/\r\n/g, '\n').split('\n')
  let inBlock: string | null = null
  let blockIndent = -1
  for (const line of lines) {
    if (line === '') continue
    const indent = line.length - line.trimStart().length
    const trimmed = line.trim()
    const hm = /^([A-Za-z]+):$/.exec(trimmed)
    if (hm && BLOCK_KEYS.has(hm[1]!)) { inBlock = hm[1]!; blockIndent = indent; continue }
    if (inBlock !== null && indent <= blockIndent) inBlock = null
    if (inBlock === null || indent <= blockIndent) continue
    const sep = trimmed.indexOf(': ')
    if (sep < 0) continue
    const key = trimmed.slice(0, sep)
    const val = trimmed.slice(sep + 2)
    out.set(`${inBlock}/${key}`, val) // last-writer-wins is fine; same value repeats
  }
  return out
}

// F3c/#106 — yarn's SYML writer leaves a dependency/peerDependency range BARE
// when it contains only spaces / `||` (e.g. `^3.0.0 || ^4.0.0`); only a leading
// `>` / `:` / other YAML indicator forces quoting. The verbatim quoting of each
// range value in a parse→emit round-trip MUST match the REAL fixture. (Whole-
// file byte equality is out of scope here — field ordering / entry-key merge are
// independent concerns; this asserts the value-quoting contract specifically.)
describe('yarn-berry — complex range values are not over-quoted (#106)', () => {
  for (const [label, parse, stringify] of [
    ['peers-basic/yarn-berry-v4.lock', parseV4, stringifyV4],
    ['peers-multi/yarn-berry-v4.lock', parseV4, stringifyV4],
    ['peers-basic/yarn-berry-v8.lock', parseV8, stringifyV8],
    ['peers-multi/yarn-berry-v8.lock', parseV8, stringifyV8],
  ] as const) {
    it(`${label}: every dependency/peer range value keeps yarn's exact quoting`, () => {
      const src = fix(label)
      const emitted = stringify(parse(src) as never)
      const want = depValueTokens(src)
      const got = depValueTokens(emitted)
      for (const [k, v] of want) {
        expect(got.get(k), `value token for ${k}`).toBe(v)
      }
    })
  }

  it('the bare `^3.0.0 || ^4.0.0` dependency range is emitted UNQUOTED', () => {
    const src = fix('peers-basic/yarn-berry-v4.lock')
    const emitted = stringifyV4(parseV4(src))
    expect(emitted).toContain('js-tokens: ^3.0.0 || ^4.0.0')
    expect(emitted).not.toContain('js-tokens: "^3.0.0 || ^4.0.0"')
  })

  // Guard against UNDER-quoting: values yarn genuinely quotes must stay quoted.
  it('SYML stringify still quotes leading-`>` ranges and `:`-bearing values', () => {
    const out = stringifySyml({
      peerDependencies: {
        typescript: '>=4.8.4 <6.1.0', // leading '>' → quoted
        react: '^16 || ^17',          // bare
      },
      dependencies: {
        'js-tokens': 'npm:^3.0.0 || ^4.0.0', // ':' → quoted
        foo: '^1 || ^2',                      // bare
      },
    })
    expect(out).toContain('typescript: ">=4.8.4 <6.1.0"')
    expect(out).toContain('react: ^16 || ^17')
    expect(out).toContain('js-tokens: "npm:^3.0.0 || ^4.0.0"')
    expect(out).toContain('foo: ^1 || ^2')
  })
})

// Corpus guard: our SYML quoting predicate (transcribed from yarn's upstream
// `simpleStringPattern`) MUST reproduce yarn's own bare-vs-quoted decision for
// EVERY dependency / peerDependency / bin value in the real fixtures. We mine
// each value AND its on-disk quoting, re-emit the value alone through our SYML
// writer, and assert the emitted quoting matches the fixture byte-for-byte.
const CORPUS_BLOCK_KEYS = new Set(['dependencies', 'optionalDependencies', 'peerDependencies', 'bin'])

function walkLocks(dir: string): string[] {
  let out: string[] = []
  for (const e of readdirSync(dir)) {
    const p = resolve(dir, e)
    if (statSync(p).isDirectory()) out = out.concat(walkLocks(p))
    else if (/\.lock$|yarn\.lock$/.test(e)) out.push(p)
  }
  return out
}

function mineBlockValues(lock: string): Array<{ value: string; quotedOnDisk: boolean }> {
  const out: Array<{ value: string; quotedOnDisk: boolean }> = []
  const lines = lock.replace(/\r\n/g, '\n').split('\n')
  let inBlock: string | null = null
  let blockIndent = -1
  for (const line of lines) {
    if (line === '') continue
    const indent = line.length - line.trimStart().length
    const trimmed = line.trim()
    const hm = /^([A-Za-z]+):$/.exec(trimmed)
    if (hm && CORPUS_BLOCK_KEYS.has(hm[1]!)) { inBlock = hm[1]!; blockIndent = indent; continue }
    if (inBlock !== null && indent <= blockIndent) inBlock = null
    if (inBlock === null || indent <= blockIndent) continue
    const sep = trimmed.indexOf(': ')
    if (sep < 0) continue
    const raw = trimmed.slice(sep + 2)
    const quotedOnDisk = raw.startsWith('"')
    const value = quotedOnDisk
      ? raw.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\')
      : raw
    out.push({ value, quotedOnDisk })
  }
  return out
}

describe('yarn-berry SYML quoting matches yarn on the full fixture corpus (#106)', () => {
  it('every mined dependency/peer/bin value re-emits with yarn\'s exact quoting', () => {
    const lockFiles = walkLocks(FIX_ROOT).filter(f =>
      /__metadata:/.test(readFileSync(f, 'utf8').slice(0, 200)),
    )
    expect(lockFiles.length).toBeGreaterThan(20)

    const mismatches: string[] = []
    let checked = 0
    for (const f of lockFiles) {
      for (const { value, quotedOnDisk } of mineBlockValues(readFileSync(f, 'utf8'))) {
        checked++
        const emitted = stringifySyml({ k: value }).trimEnd() // "k: <token>"
        const quotedEmitted = emitted.slice('k: '.length).startsWith('"')
        if (quotedEmitted !== quotedOnDisk) {
          mismatches.push(`${quotedOnDisk ? 'QUOTED' : 'BARE'} on disk, emitted ${quotedEmitted ? 'QUOTED' : 'BARE'}: ${JSON.stringify(value)} (${f.replace(FIX_ROOT, '')})`)
        }
      }
    }
    expect(checked).toBeGreaterThan(1000)
    expect(mismatches, mismatches.slice(0, 25).join('\n')).toEqual([])
  })
})
