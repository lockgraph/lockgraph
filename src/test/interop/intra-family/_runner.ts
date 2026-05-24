// Shared intra-family contract runner per ADR-0020 §2 — iterates pinned
// `fixtureSubset` для each contract, invokes the dispatcher's `convert()`,
// derives the observed contract through `_observe.activeContract()`, и
// asserts declared = observed. Reentrancy semantics:
//
//   - `lossless-reentrant`: round-trip the destination lockfile back через
//     the source format via `reenter()`; pass the reentered graph к
//     `assertConversionContract` для the reentry-equality check.
//   - `one-way-lossy`: same reenter path; assertion checks the contract's
//     declared lossy-reentry shape (e.g. integrity-only on yarn-berry
//     downgrades).
//   - `asymmetric`: skip reenter — the contract claims no round-trip.
//
// Family files (`npm-cross-version`, `pnpm-cross-version`, etc.) stay
// declarative: filter `CONTRACTS` by FormatId prefix, hand the array к
// `runIntraFamily(name, contracts)`.

import { describe, it } from 'vitest'
import { assertConversionContract } from '../_assert.ts'
import { convert, parseFormat, stringifyFormat } from '../_dispatch.ts'
import { fixtureLockfile } from '../_fixtures.ts'
import { type ConversionContract } from '../_matrix.ts'
import { activeContract } from '../_observe.ts'

function reenter(contract: ConversionContract, destinationLockfile: string) {
  const destinationGraph = parseFormat(contract.to, destinationLockfile)
  const reentered = stringifyFormat(contract.from, destinationGraph)
  return parseFormat(contract.from, reentered.lockfile)
}

export function runIntraFamily(
  suiteName: string,
  contracts: readonly ConversionContract[],
): void {
  describe(suiteName, () => {
    for (const contract of contracts) {
      const fixtures = contract.fixtureSubset ?? []

      describe(`${contract.from} -> ${contract.to}`, () => {
        it.each(fixtures)('%s fixture satisfies the declared contract', fixtureName => {
          const sourceLockfile = fixtureLockfile(fixtureName, contract.from)
          const result = convert({
            from:   contract.from,
            to:     contract.to,
            source: sourceLockfile,
            mode:   'naive',
          })
          const observedContract = activeContract(contract, {
            sourceGraph:         result.sourceGraph,
            destinationGraph:    result.destinationGraph,
            sourceLockfile,
            destinationLockfile: result.lockfile,
            mode:                'naive',
          })

          const reenteredGraph = contract.reentrancy === 'asymmetric'
            ? undefined
            : reenter(contract, result.lockfile)

          assertConversionContract(observedContract, {
            graphSource:      result.sourceGraph,
            graphDestination: result.destinationGraph,
            diagnostics:      result.diagnostics,
            mode:             'naive',
            fixture:          fixtureName,
            graphReentered:   reenteredGraph,
          })
        })
      })
    }
  })
}
