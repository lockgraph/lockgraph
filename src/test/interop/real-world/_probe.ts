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
