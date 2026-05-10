import { describe, expect, it } from 'vitest'
import { assertConversionContract } from '../_helpers.ts'
import { CONTRACTS, type ConversionContract } from '../_matrix.ts'
import {
  activeContract,
  fixtureLockfile,
  minimalBerryLockfile,
  observeInteropDiagnostics,
  parseFormat,
  stringifyFormat,
} from '../_runtime.ts'

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
        const sourceGraph = parseFormat(contract.from, sourceLockfile)
        const emitted = stringifyFormat(contract.to, sourceGraph)
        const destinationGraph = parseFormat(contract.to, emitted.lockfile)
        const reentered = reenter(contract, emitted.lockfile)
        const interopDiagnostics = observeInteropDiagnostics(contract, {
          sourceGraph,
          destinationGraph,
          sourceLockfile,
          destinationLockfile: emitted.lockfile,
          mode: 'naive',
        })
        const observedContract = activeContract(contract, {
          sourceGraph,
          destinationGraph,
          sourceLockfile,
          destinationLockfile: emitted.lockfile,
          mode: 'naive',
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
      const sourceGraph = parseFormat(contract.from, sourceLockfile)
      const emitted = stringifyFormat(contract.to, sourceGraph)
      const destinationGraph = parseFormat(contract.to, emitted.lockfile)
      const interopDiagnostics = observeInteropDiagnostics(contract, {
        sourceGraph,
        destinationGraph,
        sourceLockfile,
        destinationLockfile: emitted.lockfile,
        mode: 'naive',
      })

      const codes = interopDiagnostics.map(diagnostic => `${diagnostic.code}:${diagnostic.severity}`)
      const declared = [
        ...contract.lost,
        ...contract.passthrough,
      ].map(entry => `${entry.diagnostic}:${entry.severity}`)

      for (const code of codes) {
        expect(declared).toContain(code)
      }

      if (sourceHasConditions && contract.to === 'yarn-berry-v4') {
        expect(codes).toContain(
          `INTEROP_${formatCode(contract.from)}_TO_BERRY_V4_CONDITIONS_DROPPED:warning`,
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

function formatCode(format: ConversionContract['from']): string {
  switch (format) {
    case 'yarn-berry-v4':
      return 'BERRY_V4'
    case 'yarn-berry-v5':
      return 'BERRY_V5'
    case 'yarn-berry-v6':
      return 'BERRY_V6'
    case 'yarn-berry-v8':
      return 'BERRY_V8'
    case 'yarn-berry-v9':
      return 'BERRY_V9'
    case 'yarn-classic':
      return 'CLASSIC'
    default:
      throw new Error(`formatCode: unsupported format ${format}`)
  }
}
