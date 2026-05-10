import { describe, expect, it } from 'vitest'
import { assertConversionContract } from '../_assert.ts'
import { convert, formatCode, parseFormat, stringifyFormat } from '../_dispatch.ts'
import { fixtureLockfile } from '../_fixtures.ts'
import { CONTRACTS, type ConversionContract } from '../_matrix.ts'
import { minimalBerryLockfile } from '../_synth.ts'
import { activeContract } from '../_observe.ts'

const BERRY_CONTRACTS = CONTRACTS.filter(contract =>
  contract.from.startsWith('yarn-berry-')
  && contract.to.startsWith('yarn-berry-')
  && contract.to !== 'yarn-classic'
) as ConversionContract[]

type BerryFormat = Extract<ConversionContract['from'], `yarn-berry-${string}`>

function reenter(contract: ConversionContract, destinationLockfile: string) {
  const destinationGraph = parseFormat(contract.to, destinationLockfile)
  const reentered = stringifyFormat(contract.from, destinationGraph)
  return parseFormat(contract.from, reentered.lockfile)
}

describe('interop: yarn-berry intra-family fixtures', () => {
  for (const contract of BERRY_CONTRACTS) {
    const fixtures = contract.fixtureSubset ?? []

    describe(`${contract.from} -> ${contract.to}`, () => {
      it.each(fixtures)('%s fixture satisfies the declared contract', fixtureName => {
        const sourceLockfile = fixtureLockfile(fixtureName, contract.from)
        const result = convert({
          from: contract.from,
          to: contract.to,
          source: sourceLockfile,
          mode: 'naive',
        })
        const reentered = reenter(contract, result.lockfile)
        const observedContract = activeContract(contract, {
          sourceGraph: result.sourceGraph,
          destinationGraph: result.destinationGraph,
          sourceLockfile,
          destinationLockfile: result.lockfile,
          mode: 'naive',
        })

        assertConversionContract(observedContract, {
          graphSource: result.sourceGraph,
          graphDestination: result.destinationGraph,
          diagnostics: result.diagnostics,
          mode: 'naive',
          fixture: fixtureName,
          graphReentered: reentered,
        })
      })
    })
  }
})

describe('interop: yarn-berry intra-family metadata edges', () => {
  for (const contract of BERRY_CONTRACTS) {
    const sourceHasConditions = contract.from !== 'yarn-berry-v4'
    const sourceLockfile = minimalBerryLockfile(contract.from as BerryFormat, {
      conditions: sourceHasConditions,
      compressionLevel: true,
    })

    it(`${contract.from} -> ${contract.to} surfaces the declared metadata observations`, () => {
      const result = convert({
        from: contract.from,
        to: contract.to,
        source: sourceLockfile,
        mode: 'naive',
      })

      const codes = result.diagnostics
        .filter(d => d.code.startsWith('INTEROP_'))
        .map(diagnostic => `${diagnostic.code}:${diagnostic.severity}`)
      const declared = [
        ...contract.lost,
        ...contract.passthrough,
      ].map(entry => `${entry.diagnostic}:${entry.severity}`)

      for (const code of codes) {
        expect(declared).toContain(code)
      }

      if (sourceHasConditions && contract.to === 'yarn-berry-v4') {
        expect(codes).toContain(
          `INTEROP_${formatCode(contract.from)}_TO_YARN_BERRY_V4_CONDITIONS_DROPPED:warning`,
        )
      }

      if (contract.passthrough.some(entry => entry.feature === 'compressionLevel')) {
        expect(codes).toContain(
          `INTEROP_${formatCode(contract.from)}_TO_${formatCode(contract.to)}_COMPRESSIONLEVEL_PASSTHROUGH:info`,
        )
      }
    })
  }
})
