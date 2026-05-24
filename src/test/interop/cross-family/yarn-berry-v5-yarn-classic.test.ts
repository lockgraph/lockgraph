import { describe, it } from 'vitest'
import { assertConversionContract } from '../_assert.ts'
import { convert } from '../_dispatch.ts'
import { CLASSIC_SHARED_FIXTURES } from '../_fixtures.ts'
import { CONTRACTS, type ConversionContract } from '../_matrix.ts'
import { activeContract } from '../_observe.ts'
import { classicFixtureAsBerrySource } from '../_synth.ts'

const YB5_CLASSIC_CONTRACTS = CONTRACTS.filter(contract =>
  contract.from === 'yarn-berry-v5' && contract.to === 'yarn-classic',
) as ConversionContract[]

describe('interop: yarn-berry-v5 -> yarn-classic (cross-family)', () => {
  for (const contract of YB5_CLASSIC_CONTRACTS) {
    describe(`${contract.from} -> ${contract.to}`, () => {
      it.each(CLASSIC_SHARED_FIXTURES)('%s fixture satisfies the declared contract', fixtureName => {
        const source = classicFixtureAsBerrySource(fixtureName, 'yarn-berry-v5')
        const result = convert({
          from: contract.from,
          to:   'yarn-classic',
          source: source.lockfile,
          mode: 'naive',
        })
        const observedContract = activeContract(contract, {
          sourceGraph: result.sourceGraph,
          destinationGraph: result.destinationGraph,
          sourceLockfile: source.lockfile,
          destinationLockfile: result.lockfile,
          mode: 'naive',
        })

        assertConversionContract(observedContract, {
          graphSource: result.sourceGraph,
          graphDestination: result.destinationGraph,
          diagnostics: result.diagnostics,
          mode: 'naive',
          fixture: `classic-compatible:${fixtureName}`,
        })
      })
    })
  }
})
