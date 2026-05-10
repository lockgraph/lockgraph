import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'vitest'
import type { Diagnostic, Graph } from '../../../main/ts/graph.ts'
import { parse as parseV8, stringify as stringifyV8 } from '../../../main/ts/formats/yarn-berry-v8.ts'
import { parse as parseV9, stringify as stringifyV9 } from '../../../main/ts/formats/yarn-berry-v9.ts'
import { assertConversionContract } from '../_helpers.ts'
import { CONTRACTS } from '../_matrix.ts'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = (rel: string): string =>
  readFileSync(resolve(here, '../../resources/fixtures/lockfiles', rel), 'utf8')

const FIXTURES = [
  'deps-with-scopes',
  'git-github-tarball',
  'peers-basic',
  'peers-multi',
  'simple',
  'workspace-cross-refs',
  'workspaces-basic',
  'yarn-crlf',
] as const

const FIXTURE_SET = new Set<string>(FIXTURES)

function stringifyV8WithDiagnostics(graph: Graph): { lockfile: string; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = []
  const lockfile = stringifyV8(graph, {
    onDiagnostic(diagnostic) {
      diagnostics.push(diagnostic)
    },
  })
  return { lockfile, diagnostics }
}

function stringifyV9WithDiagnostics(graph: Graph): { lockfile: string; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = []
  const lockfile = stringifyV9(graph, {
    onDiagnostic(diagnostic) {
      diagnostics.push(diagnostic)
    },
  })
  return { lockfile, diagnostics }
}

function contractOf(from: 'yarn-berry-v8' | 'yarn-berry-v9', to: 'yarn-berry-v8' | 'yarn-berry-v9') {
  const contract = CONTRACTS.find(entry => entry.from === from && entry.to === to)
  if (contract === undefined) throw new Error(`missing interop contract for ${from} -> ${to}`)
  return contract
}

function fixturesFor(contract: ReturnType<typeof contractOf>): readonly string[] {
  if (contract.fixtureSubset === undefined) return FIXTURES
  for (const fixtureName of contract.fixtureSubset) {
    if (!FIXTURE_SET.has(fixtureName)) {
      throw new Error(`unknown fixture ${fixtureName} in contract ${contract.from} -> ${contract.to}`)
    }
  }
  return contract.fixtureSubset
}

describe('interop: yarn-berry-v9 -> yarn-berry-v8 (naive)', () => {
  const contract = contractOf('yarn-berry-v9', 'yarn-berry-v8')

  it.each(fixturesFor(contract))('%s fixture satisfies the v9 -> v8 contract', fixtureName => {
    const graphV9 = parseV9(fixture(`${fixtureName}/yarn-berry-v9.lock`))
    const emittedV8 = stringifyV8WithDiagnostics(graphV9)
    const graphV8 = parseV8(emittedV8.lockfile)
    const reenteredV9 = parseV9(stringifyV9(graphV8))

    assertConversionContract(contract, {
      graphSource: graphV9,
      graphDestination: graphV8,
      diagnostics: [
        ...graphV9.diagnostics(),
        ...emittedV8.diagnostics,
        ...graphV8.diagnostics(),
      ],
      mode: 'naive',
      fixture: fixtureName,
      graphReentered: reenteredV9,
    })
  })
})

describe('interop: yarn-berry-v8 -> yarn-berry-v9 (naive)', () => {
  const contract = contractOf('yarn-berry-v8', 'yarn-berry-v9')

  it.each(fixturesFor(contract))('%s fixture satisfies the v8 -> v9 contract', fixtureName => {
    const graphV8 = parseV8(fixture(`${fixtureName}/yarn-berry-v8.lock`))
    const emittedV9 = stringifyV9WithDiagnostics(graphV8)
    const graphV9 = parseV9(emittedV9.lockfile)
    const reenteredV8 = parseV8(stringifyV8(graphV9))

    assertConversionContract(contract, {
      graphSource: graphV8,
      graphDestination: graphV9,
      diagnostics: [
        ...graphV8.diagnostics(),
        ...emittedV9.diagnostics,
        ...graphV9.diagnostics(),
      ],
      mode: 'naive',
      fixture: fixtureName,
      graphReentered: reenteredV8,
    })
  })
})
