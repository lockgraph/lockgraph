import { describe, it } from 'vitest'
import { assertConversionContract } from '../_assert.ts'
import { parseFormat, stringifyFormat } from '../_dispatch.ts'
import { CLASSIC_SHARED_FIXTURES, fixtureLockfile } from '../_fixtures.ts'
import { CONTRACTS, type ConversionContract } from '../_matrix.ts'
import { normalizeGraphForBerry } from '../_normalize.ts'
import { activeContract, observeInteropDiagnostics } from '../_observe.ts'

const CONTRACTS_FROM_CLASSIC = CONTRACTS.filter(contract =>
  contract.from === 'yarn-classic' && contract.to.startsWith('yarn-berry-')
) as ConversionContract[]

describe('interop: yarn-classic -> yarn-berry (naive)', () => {
  for (const contract of CONTRACTS_FROM_CLASSIC) {
    describe(`${contract.from} -> ${contract.to}`, () => {
      it.each(CLASSIC_SHARED_FIXTURES)('%s fixture satisfies the naive contract', fixtureName => {
        const sourceLockfile = fixtureLockfile(fixtureName, 'yarn-classic')
        const sourceGraph = normalizeGraphForBerry(parseFormat('yarn-classic', sourceLockfile))
        const emitted = stringifyFormat(contract.to, sourceGraph)
        const destinationGraph = parseFormat(contract.to, emitted.lockfile)
        const interopDiagnostics = observeInteropDiagnostics(contract, {
          sourceGraph,
          destinationGraph,
          sourceLockfile,
          destinationLockfile: emitted.lockfile,
          mode: 'naive',
          manifestsProvided: false,
        })
        const observedContract = activeContract(contract, {
          sourceGraph,
          destinationGraph,
          sourceLockfile,
          destinationLockfile: emitted.lockfile,
          mode: 'naive',
          manifestsProvided: false,
        })

        assertConversionContract(observedContract, {
          graphSource: sourceGraph,
          graphDestination: destinationGraph,
          diagnostics: [
            ...sourceGraph.diagnostics(),
            ...emitted.diagnostics,
            ...destinationGraph.diagnostics(),
            ...interopDiagnostics,
          ],
          mode: 'naive',
          fixture: fixtureName,
        })
      })
    })
  }
})

describe('interop: yarn-classic -> yarn-berry (enrich-aware)', () => {
  it.todo(
    'classic -> berry should preserve manifest-derived dev/workspace edge classification once classic -> berry workspace concretisation is complete',
  )
})
