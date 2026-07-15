import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { check } from '../../../main/ts/index.ts'
import type { Diagnostic } from '../../../main/ts/graph.ts'
import { convert, parseFormat } from '../_dispatch.ts'
import type { FormatId } from '../_types.ts'

const here = dirname(fileURLToPath(import.meta.url))

export const REAL_WORLD_FIXTURES_ROOT = resolve(here, '../../resources/fixtures/real-world')

export const ALL_FORMATS: FormatId[] = [
  'yarn-berry-v4',
  'yarn-berry-v5',
  'yarn-berry-v6',
  'yarn-berry-v7',
  'yarn-berry-v8',
  'yarn-berry-v9',
  'yarn-berry-v10',
  'yarn-classic',
  'npm-1',
  'npm-2',
  'npm-3',
  'pnpm-v5',
  'pnpm-v6',
  'pnpm-v9',
  'bun-text',
]

export type RealWorldFixture = {
  repoHandle: string
  fileName: string
  source: string
  sourceFormat: FormatId
}

export type DiagnosticSummary = {
  total: number
  recipe: number
  interop: number
  adapter: number
  byCode: Record<string, number>
}

export type ClassifiedError = {
  name: string
  code?: string
  message: string
}

export type ProbeSuccess = {
  outcome: 'success'
  fixture: RealWorldFixture
  target: FormatId
  diagnostics: Diagnostic[]
  summary: DiagnosticSummary
}

export type ProbeError = {
  outcome: 'error'
  fixture: RealWorldFixture
  target: FormatId
  phase: 'convert' | 'target-check' | 'target-parse'
  error: ClassifiedError
}

export type ProbeResult = ProbeSuccess | ProbeError

export function loadRealWorldFixtures(): RealWorldFixture[] {
  const fixtures: RealWorldFixture[] = []
  const repos = readdirSync(REAL_WORLD_FIXTURES_ROOT, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort()

  for (const repoHandle of repos) {
    const repoRoot = resolve(REAL_WORLD_FIXTURES_ROOT, repoHandle)
    const files = readdirSync(repoRoot, { withFileTypes: true })
      .filter(entry => entry.isFile())
      .map(entry => entry.name)
      // `package.json` / `pnpm-workspace.yaml` are manifest/workspace-config
      // inputs, not lockfiles — fixtures now ship them alongside the lock for
      // manifest-aware work (ADR-0025). The cross-family probe detects +
      // converts LOCKFILES only; skip these non-lockfile top-level files.
      // (Nested workspace-member manifests live in subdirs, which this
      // top-level-only walk never visits.)
      .filter(name => name !== 'package.json' && name !== 'pnpm-workspace.yaml')
      .sort()

    for (const fileName of files) {
      const source = readFileSync(resolve(repoRoot, fileName), 'utf8')
      fixtures.push({
        repoHandle,
        fileName,
        source,
        sourceFormat: detectFormat(source),
      })
    }
  }

  return fixtures
}

export function probeConversion(fixture: RealWorldFixture, target: FormatId): ProbeResult {
  try {
    const result = convert({
      from: fixture.sourceFormat,
      to: target,
      source: fixture.source,
    })

    if (!check(target, result.lockfile)) {
      return {
        outcome: 'error',
        fixture,
        target,
        phase: 'target-check',
        error: {
          name: 'FormatCheckError',
          code: 'FORMAT_CHECK_FAILED',
          message: `target adapter rejected emitted ${target} lockfile`,
        },
      }
    }

    try {
      parseFormat(target, result.lockfile)
    } catch (error) {
      return {
        outcome: 'error',
        fixture,
        target,
        phase: 'target-parse',
        error: classifyError(error),
      }
    }

    return {
      outcome: 'success',
      fixture,
      target,
      diagnostics: result.diagnostics,
      summary: summarizeDiagnostics(result.diagnostics),
    }
  } catch (error) {
    return {
      outcome: 'error',
      fixture,
      target,
      phase: 'convert',
      error: classifyError(error),
    }
  }
}

function detectFormat(input: string): FormatId {
  const matches = ALL_FORMATS.filter(format => check(format, input))
  const match = matches[0]
  if (matches.length === 1 && match !== undefined) return match
  if (matches.length === 0) throw new Error('real-world fixture format not detected')
  throw new Error(`real-world fixture format ambiguous: ${matches.join(', ')}`)
}

function classifyError(error: unknown): ClassifiedError {
  if (error instanceof Error) {
    const candidate = error as Error & { code?: unknown }
    const code = typeof candidate.code === 'string'
      ? candidate.code
      : undefined
    return {
      name: error.name,
      code,
      message: error.message,
    }
  }

  return {
    name: 'NonErrorThrown',
    message: String(error),
  }
}

function summarizeDiagnostics(diagnostics: readonly Diagnostic[]): DiagnosticSummary {
  const byCode: Record<string, number> = {}

  for (const diagnostic of diagnostics) {
    byCode[diagnostic.code] = (byCode[diagnostic.code] ?? 0) + 1
  }

  const codes = Object.keys(byCode)
  const recipe = codes
    .filter(code => code.startsWith('RECIPE_'))
    .reduce((sum, code) => sum + (byCode[code] ?? 0), 0)
  const interop = codes
    .filter(code => code.startsWith('INTEROP_'))
    .reduce((sum, code) => sum + (byCode[code] ?? 0), 0)

  return {
    total: diagnostics.length,
    recipe,
    interop,
    adapter: diagnostics.length - recipe - interop,
    byCode,
  }
}

// The cross-family probe converts every real-world fixture to every other
// adapter format — a pure, ~600-case CPU matrix. vitest parallelizes by FILE
// (one file = one worker = one core), so the matrix is sharded across sibling
// `.test.ts` files by fixture index; the union of shards is the whole corpus,
// exactly once. Keep PROBE_SHARD_COUNT equal to the number of shard files.
export const PROBE_SHARD_COUNT = 4

export function defineProbeShard(shardIndex: number): void {
  const all = loadRealWorldFixtures()
  const fixtures = all.filter((_, index) => index % PROBE_SHARD_COUNT === shardIndex)

  describe(`interop: real-world cross-family probe (shard ${shardIndex + 1}/${PROBE_SHARD_COUNT})`, () => {
    // The corpus-discovery guard is orthogonal to sharding; assert it once.
    if (shardIndex === 0) {
      it('discovers committed real-world fixtures', () => {
        expect(all.length).toBeGreaterThan(0)
      })
    }

    for (const fixture of fixtures) {
      describe(`${fixture.repoHandle}/${fixture.fileName} (${fixture.sourceFormat})`, () => {
        const targets = ALL_FORMATS.filter(format => format !== fixture.sourceFormat)

        it('covers every other adapter format id', () => {
          expect(targets).toHaveLength(ALL_FORMATS.length - 1)
        })

        for (const target of targets) {
          it(`probes ${fixture.sourceFormat} -> ${target}`, () => {
            const result = probeConversion(fixture, target)

            if (result.outcome === 'success') {
              assertDiagnosticArray(result.diagnostics)
              expect(result.summary.total).toBe(result.diagnostics.length)
              expect(result.summary.recipe).toBeGreaterThanOrEqual(0)
              expect(result.summary.interop).toBeGreaterThanOrEqual(0)
              expect(result.summary.adapter).toBeGreaterThanOrEqual(0)
            } else {
              expect(result.phase).toMatch(/convert|target-check|target-parse/)
              expect(result.error.name.length).toBeGreaterThan(0)
              expect(result.error.message.length).toBeGreaterThan(0)
              if (result.error.code !== undefined) {
                expect(result.error.code.length).toBeGreaterThan(0)
              }
            }
          }, 30_000)
        }
      })
    }
  })
}

function assertDiagnosticArray(diagnostics: readonly Diagnostic[]): void {
  expect(Array.isArray(diagnostics)).toBe(true)

  for (const diagnostic of diagnostics) {
    expect(typeof diagnostic.code).toBe('string')
    expect(diagnostic.code.length).toBeGreaterThan(0)
    expect(['info', 'warning', 'error']).toContain(diagnostic.severity)
    expect(typeof diagnostic.message).toBe('string')
    expect(diagnostic.message.length).toBeGreaterThan(0)
    if (diagnostic.subject !== undefined) {
      expect(typeof diagnostic.subject === 'string' || typeof diagnostic.subject === 'object').toBe(true)
    }
  }
}
