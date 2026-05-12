import { describe, it } from 'vitest'
import { assertConversionContract } from '../_assert.ts'
import { parseFormat, stringifyFormat } from '../_dispatch.ts'
import { CONTRACTS, type ConversionContract } from '../_matrix.ts'
import { activeContract, observeInteropDiagnostics } from '../_observe.ts'
import { emptyGraph } from '../_snapshot.ts'

// Synthetic-graph adversarial: starts from an in-memory empty graph rather than
// a parseable source string, so it bypasses `convert` (which requires a valid
// source lockfile — yarn-classic empty-graph emit produces a header the classic
// parser rejects, tracked under the empty-classic-emit stub). Surface coverage
// is still real-graph comparison via `observeInteropDiagnostics`.
describe('interop adversarial §8.1 — empty graph conversion', () => {
  const graph = emptyGraph()

  for (const contract of CONTRACTS) {
    it(`${contract.from} -> ${contract.to} keeps the graph empty and emits no spurious interop diagnostics`, () => {
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
})

function stringifyEmpty(format: ConversionContract['from'], graph = emptyGraph()) {
  return stringifyFormat(format, graph)
}

function isSameFamily(contract: ConversionContract): boolean {
  return contract.from.startsWith('yarn-berry-') && contract.to.startsWith('yarn-berry-')
}
