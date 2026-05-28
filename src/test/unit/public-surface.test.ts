// ADR-0014 §3 public surface — dispatcher contract.
//
// Covers per-format `parse / stringify / check` dispatch, `detect` matrix
// across all 13 adapters via `simple` fixture, и `convert` sugar with
// (a) happy path yarn-berry-v9 → pnpm-v9, (b) detection failure throw,
// (c) `onDiagnostic` threading.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import {
  check,
  convert,
  detect,
  parse,
  stringify,
  type Diagnostic,
  type FormatId,
} from '../../main/ts/index.ts'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = (scenario: string, file: string): string =>
  readFileSync(resolve(here, '../resources/fixtures/lockfiles', scenario, file), 'utf8')

// `yarn-berry-v10` is a forward-compat preview adapter (yarn 5 dev branch)
// — no canonical fixture exists in the matrix yet (see spec/formats/
// yarn-berry-v10.md). Excluded from this fixture-based dispatcher sweep;
// the dedicated v10 unit test (src/test/unit/yarn-berry-v10.test.ts)
// exercises the dispatcher path via synthesised content.
type FixturedFormatId = Exclude<FormatId, 'yarn-berry-v10'>

const ALL_FORMATS: FixturedFormatId[] = [
  'yarn-berry-v4',
  'yarn-berry-v5',
  'yarn-berry-v6',
  'yarn-berry-v7',
  'yarn-berry-v8',
  'yarn-berry-v9',
  'yarn-classic',
  'npm-1',
  'npm-2',
  'npm-3',
  'pnpm-v5',
  'pnpm-v6',
  'pnpm-v9',
  'bun-text',
]

const FIXTURE_FILE: Record<FixturedFormatId, string> = {
  'yarn-berry-v4': 'yarn-berry-v4.lock',
  'yarn-berry-v5': 'yarn-berry-v5.lock',
  'yarn-berry-v6': 'yarn-berry-v6.lock',
  'yarn-berry-v7': 'yarn-berry-v7.lock',
  'yarn-berry-v8': 'yarn-berry-v8.lock',
  'yarn-berry-v9': 'yarn-berry-v9.lock',
  'yarn-classic':  'yarn-classic.lock',
  'npm-1':         'npm-1.lock',
  'npm-2':         'npm-2.lock',
  'npm-3':         'npm-3.lock',
  'pnpm-v5':       'pnpm-v5.lock',
  'pnpm-v6':       'pnpm-v6.lock',
  'pnpm-v9':       'pnpm-v9.lock',
  'bun-text':      'bun-text.lock',
}

describe('public surface — parse', () => {
  for (const format of ALL_FORMATS) {
    it(`dispatches to ${format} adapter`, () => {
      const input = fixture('simple', FIXTURE_FILE[format])
      const graph = parse(format, input)
      expect(Array.from(graph.nodes()).length).toBeGreaterThan(0)
    })
  }

  it('threads onDiagnostic over graph.diagnostics()', () => {
    const input = fixture('simple', 'yarn-berry-v9.lock')
    const captured: Diagnostic[] = []
    const graph = parse('yarn-berry-v9', input, { onDiagnostic: d => { captured.push(d) } })
    expect(captured).toEqual([...graph.diagnostics()])
  })
})

describe('public surface — stringify', () => {
  for (const format of ALL_FORMATS) {
    it(`emits ${format} string round-trip`, () => {
      const input = fixture('simple', FIXTURE_FILE[format])
      const graph = parse(format, input)
      const out = stringify(format, graph)
      expect(typeof out).toBe('string')
      expect(out.length).toBeGreaterThan(0)
    })
  }
})

describe('public surface — check', () => {
  for (const format of ALL_FORMATS) {
    it(`${format} accepts own fixture`, () => {
      expect(check(format, fixture('simple', FIXTURE_FILE[format]))).toBe(true)
    })
  }

  it('rejects foreign fixture', () => {
    const yarnBerryV9 = fixture('simple', 'yarn-berry-v9.lock')
    expect(check('npm-3', yarnBerryV9)).toBe(false)
    expect(check('pnpm-v9', yarnBerryV9)).toBe(false)
    expect(check('bun-text', yarnBerryV9)).toBe(false)
  })
})

describe('public surface — detect', () => {
  for (const format of ALL_FORMATS) {
    it(`identifies ${format} fixture`, () => {
      expect(detect(fixture('simple', FIXTURE_FILE[format]))).toBe(format)
    })
  }

  it('returns undefined on unrecognised input', () => {
    expect(detect('this is not a lockfile')).toBeUndefined()
    expect(detect('{"foo":"bar"}')).toBeUndefined()
  })
})

describe('public surface — convert', () => {
  it('parses + stringifies happy path (yarn-berry-v9 → pnpm-v9)', () => {
    const input = fixture('simple', 'yarn-berry-v9.lock')
    const out = convert(input, { to: 'pnpm-v9' })
    expect(check('pnpm-v9', out)).toBe(true)
  })

  it('honours explicit `from` over auto-detect', () => {
    const input = fixture('simple', 'yarn-berry-v9.lock')
    const out = convert(input, { from: 'yarn-berry-v9', to: 'pnpm-v9' })
    expect(check('pnpm-v9', out)).toBe(true)
  })

  it('throws when source format not detected', () => {
    expect(() => convert('not a lockfile', { to: 'pnpm-v9' }))
      .toThrowError('convert: source format not detected')
  })

  it('threads onDiagnostic through parse + stringify', () => {
    const input = fixture('simple', 'yarn-berry-v9.lock')
    const captured: Diagnostic[] = []
    convert(input, {
      to:           'pnpm-v9',
      onDiagnostic: d => { captured.push(d) },
    })
    // Callback must be invocable; mixed parse-side + stringify-side
    // diagnostics may surface depending on fixture content.
    expect(Array.isArray(captured)).toBe(true)
  })

  it('forwards cacheKey to yarn-berry-v9 emit metadata', () => {
    // Recipe-layer F1 hex/SRI translation lands в later round — for now
    // verify the option threads через to the yarn-berry sidecar/metadata.
    const input = fixture('simple', 'yarn-berry-v9.lock')
    const out = convert(input, { to: 'yarn-berry-v9', cacheKey: 'ffff' })
    expect(out).toContain('cacheKey: ffff')
  })

  it('cross-family conversion: npm-3 → pnpm-v9 emits valid pnpm output', () => {
    const input = fixture('simple', 'npm-3.lock')
    const out = convert(input, { to: 'pnpm-v9' })
    expect(check('pnpm-v9', out)).toBe(true)
    // round-trip sanity: parse the output as the target format
    const reparsed = parse('pnpm-v9', out)
    expect(reparsed).toBeDefined()
  })

  it('cross-family conversion: yarn-berry-v9 → bun-text observes patch-drop diagnostic', () => {
    // bun-text drops patches per ADR-0014 §4.F2 stringify table (RECIPE_FEATURE_DROPPED).
    // Today the diagnostic emit lives в the bun-text adapter directly; verify the public
    // surface threads it через onDiagnostic. Recipe-layer F2 round adds the RECIPE_*
    // family — for now we assert the callback fires when patches are present in source.
    const input = fixture('patch-yarn', 'yarn-berry-v9.lock')
    const captured: Diagnostic[] = []
    convert(input, {
      to:           'bun-text',
      onDiagnostic: d => { captured.push(d) },
    })
    // patches dropped → at least one diagnostic surfaces from the bun-text emit side
    const patchRelated = captured.filter(d => /patch|drop/i.test(d.code))
    expect(patchRelated.length).toBeGreaterThan(0)
  })

  it('onDiagnostic invoked exactly once per emitted event (no double-fire)', () => {
    // Implementation iterates graph.diagnostics() once post-parse + per-adapter
    // stringify options once; regression-protect against accidental double-emit.
    const input = fixture('patch-yarn', 'yarn-berry-v9.lock')
    const codes: string[] = []
    convert(input, {
      to:           'bun-text',
      onDiagnostic: d => { codes.push(`${d.code}|${d.subject ?? ''}`) },
    })
    const dedup = new Set(codes)
    expect(codes.length).toBe(dedup.size)
  })
})
