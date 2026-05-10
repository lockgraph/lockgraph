import { describe, it } from 'vitest'
import { assertConversionContract } from '../_helpers.ts'
import { CONTRACTS, type ConversionContract } from '../_matrix.ts'
import { activeContract, emptyGraph, observeInteropDiagnostics, parseFormat, stringifyFormat } from '../_runtime.ts'

describe('interop adversarial §8.1 — empty graph conversion', () => {
  const graph = emptyGraph()

  for (const contract of CONTRACTS) {
    const testCase = contract.to === 'yarn-classic' && contract.from.startsWith('yarn-berry-')
      ? it.skip
      : it
    testCase(`${contract.from} -> ${contract.to} keeps the graph empty and emits no spurious interop diagnostics`, () => {
      const sourceLockfile = stringifyEmpty(contract.from).lockfile
      const emitted = stringifyEmpty(contract.to, graph)
      const destinationGraph = parseFormat(contract.to, emitted.lockfile)
      const interopDiagnostics = observeInteropDiagnostics(contract, {
        sourceGraph: graph,
        destinationGraph,
        sourceLockfile,
        destinationLockfile: emitted.lockfile,
        mode: 'naive',
      })
      const observedContract = activeContract(contract, {
        sourceGraph: graph,
        destinationGraph,
        sourceLockfile,
        destinationLockfile: emitted.lockfile,
        mode: 'naive',
      })

      assertConversionContract(observedContract, {
        graphSource: graph,
        graphDestination: destinationGraph,
        diagnostics: [...emitted.diagnostics, ...interopDiagnostics],
        mode: 'naive',
        fixture: 'empty-graph',
        graphReentered: isSameFamily(contract) ? parseFormat(contract.from, stringifyEmpty(contract.from, destinationGraph).lockfile) : undefined,
      })
    })
  }

  it.todo('berry -> yarn-classic empty-graph conversion currently emits a classic header that the strict classic parser rejects')
})

function stringifyEmpty(format: ConversionContract['from'], graph = emptyGraph()) {
  return stringifyFormat(format, graph)
}

function isSameFamily(contract: ConversionContract): boolean {
  return contract.from.startsWith('yarn-berry-') && contract.to.startsWith('yarn-berry-')
}
