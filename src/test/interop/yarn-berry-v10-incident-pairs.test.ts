import { describe, expect, it } from 'vitest'
import { convert } from '../../main/ts/convert/orchestrator.ts'
import type { Diagnostic } from '../../main/ts/graph.ts'
import { fixtureLockfile } from './_fixtures.ts'
import { CONTRACTS } from './_matrix.ts'
import { minimalBerryLockfile } from './_synth.ts'
import type { FormatId } from './_types.ts'
import { runIntraFamily } from './intra-family/_runner.ts'

const OTHER_FORMATS: FormatId[] = [
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
  'npm-4',
  'pnpm-v5',
  'pnpm-v6',
  'pnpm-v9',
  'bun-text',
  'deno-v2',
  'deno-v3',
  'deno-v4',
  'deno-v5',
]

const incidentContracts = CONTRACTS.filter(contract =>
  (contract.from === 'yarn-berry-v10' || contract.to === 'yarn-berry-v10')
    && contract.from !== contract.to)

runIntraFamily('interop: yarn-berry-v10 incident pairs', incidentContracts)

const NON_BERRY_FORMATS: FormatId[] = [
  'yarn-classic',
  'npm-1',
  'npm-2',
  'npm-3',
  'npm-4',
  'pnpm-v5',
  'pnpm-v6',
  'pnpm-v9',
  'bun-text',
]

describe('interop: yarn-berry-v10 incident-pair coverage', () => {
  it('registers all 40 ordered incident pairs exactly once', () => {
    expect(incidentContracts).toHaveLength(40)
    expect(new Set(incidentContracts.map(contract =>
      `${contract.from} -> ${contract.to}`))).toHaveLength(40)
  })

  it('remains part of the complete 420/420 ordered-pair matrix without duplicates', () => {
    expect(CONTRACTS).toHaveLength(420)
    expect(new Set(CONTRACTS.map(contract =>
      `${contract.from} -> ${contract.to}`))).toHaveLength(420)
  })

  it('covers both directions for every other supported format', () => {
    const registered = new Set(incidentContracts.map(contract =>
      `${contract.from} -> ${contract.to}`))

    for (const other of OTHER_FORMATS) {
      expect(registered).toContain(`yarn-berry-v10 -> ${other}`)
      expect(registered).toContain(`${other} -> yarn-berry-v10`)
    }
  })

  it.each(NON_BERRY_FORMATS)(
    'yarn-berry-v10 -> %s reports the accepted cross-family projection loss',
    async to => {
      const diagnostics: Diagnostic[] = []
      await expect(convert(fixtureLockfile('simple', 'yarn-berry-v10'), {
        from: 'yarn-berry-v10',
        to,
        strict: false,
        ...(to === 'yarn-classic'
          ? { registry: 'https://registry.yarnpkg.com' }
          : {}),
        onDiagnostic: diagnostic => diagnostics.push(diagnostic),
      })).resolves.toEqual(expect.any(String))

      expect(diagnostics).toContainEqual(expect.objectContaining({
        code: 'PROJECTION_LOSS',
        data: expect.objectContaining({ target: to }),
      }))
    },
  )

  it.each(NON_BERRY_FORMATS)(
    '%s -> yarn-berry-v10 omits tarball SRI and reports the checksum gap',
    async from => {
      const diagnostics: Diagnostic[] = []
      const output = await convert(fixtureLockfile('simple', from), {
        from,
        to: 'yarn-berry-v10',
        strict: false,
        onDiagnostic: diagnostic => diagnostics.push(diagnostic),
      })

      expect(output).not.toMatch(/^\s+checksum:/m)
      expect(diagnostics).toContainEqual(expect.objectContaining({
        code: 'RECIPE_INTEGRITY_INCOMPLETE',
      }))
    },
  )

  it('yarn-berry-v10 -> yarn-berry-v4 reports conditions loss', async () => {
    const diagnostics: Diagnostic[] = []
    const output = await convert(
      minimalBerryLockfile('yarn-berry-v10', { conditions: true }),
      {
        from: 'yarn-berry-v10',
        to: 'yarn-berry-v4',
        strict: false,
        onDiagnostic: diagnostic => diagnostics.push(diagnostic),
      },
    )

    expect(output).not.toMatch(/^\s+conditions:/m)
    expect(diagnostics).toContainEqual(expect.objectContaining({
      code: 'YARN_BERRY_V4_CONDITIONS_DROPPED',
    }))
  })
})
