import { describe, expect, it } from 'vitest'
import { convert, formatCode } from '../_dispatch.ts'
import { CONTRACTS, type ConversionContract } from '../_matrix.ts'
import { minimalBerryLockfile } from '../_synth.ts'
import { runIntraFamily } from './_runner.ts'

const BERRY_CONTRACTS = CONTRACTS.filter(contract =>
  contract.from.startsWith('yarn-berry-')
  && contract.to.startsWith('yarn-berry-')
  && contract.to !== 'yarn-classic'
) as ConversionContract[]

type BerryFormat = Extract<ConversionContract['from'], `yarn-berry-${string}`>

runIntraFamily('interop: yarn-berry intra-family fixtures', BERRY_CONTRACTS)

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
