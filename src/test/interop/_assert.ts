import type { Diagnostic, Graph, GraphDiff } from '../../main/ts/graph.ts'
import { ALL_FEATURES, type ConversionContract } from './_matrix.ts'
import { featurePresence, graphSubset } from './_graph-features.ts'

export type AssertConversionContractInput = {
  graphSource: Graph
  graphDestination: Graph
  diagnostics: Diagnostic[]
  mode: 'naive' | 'enrich-aware'
  fixture?: string
  graphReentered?: Graph
}

export function assertConversionContract(
  contract: ConversionContract,
  input: AssertConversionContractInput,
): void {
  if (contract.reentrancy === 'asymmetric' && input.graphReentered !== undefined) {
    throw new Error('asymmetric pair must not pass graphReentered')
  }

  const interopDiagnostics = input.diagnostics.filter(d => d.code.startsWith('INTEROP_'))
  const declared = [
    ...contract.lost,
    ...contract.added.filter(
      (entry): entry is typeof entry & { diagnostic: string; severity: 'warning' | 'info' } =>
        entry.diagnostic !== undefined && entry.severity !== undefined,
    ),
    ...contract.passthrough,
  ]

  const spurious = interopDiagnostics.filter(actual =>
    !declared.some(expected =>
      expected.diagnostic === actual.code && expected.severity === actual.severity,
    ),
  )

  const missing = declared.filter(expected =>
    !interopDiagnostics.some(actual =>
      actual.code === expected.diagnostic && actual.severity === expected.severity,
    ),
  )

  const failures: string[] = []
  if (!graphSubset(input.graphSource, input.graphDestination, contract.preserved)) {
    failures.push('undeclared loss (regression bug)')
  }
  if (spurious.length > 0) {
    failures.push(`spurious diagnostics: ${spurious.map(formatDiagnostic).join(', ')}`)
  }
  if (missing.length > 0) {
    failures.push(`missing declared diagnostics: ${missing.map(formatDeclared).join(', ')}`)
  }

  if (input.graphReentered !== undefined) {
    const reentrancyFailure = reentrancyFailureOf(contract, input.graphSource, input.graphReentered)
    if (reentrancyFailure !== undefined) failures.push(reentrancyFailure)
  }

  if (failures.length === 0) return

  const fixture = input.fixture ?? 'unknown'
  const pair = `${contract.from} -> ${contract.to}`
  throw new Error(
    `ConversionContract violation: ${pair} (${input.mode}, fixture ${fixture})\n` +
      failures.map(failure => `  - ${failure}`).join('\n'),
  )
}

function reentrancyFailureOf(
  contract: ConversionContract,
  source: Graph,
  reentered: Graph,
): string | undefined {
  switch (contract.reentrancy) {
    case 'lossless-reentrant':
      return isEmptyGraphDiff(source.diff(reentered)) && isEmptyGraphDiff(reentered.diff(source))
        ? undefined
        : 'reentrancy class violation: A -> B -> A changed the source graph'
    case 'one-way-lossy': {
      for (const feature of ALL_FEATURES.filter(feature => !contract.preserved.includes(feature))) {
        if (featurePresence(reentered, feature) && graphSubset(reentered, source, [feature])) {
          return `reentrancy class violation: one-way-lossy pair preserved undeclared feature '${feature}'`
        }
      }
      return undefined
    }
    case 'asymmetric':
      return undefined
  }
}

function isEmptyGraphDiff(diff: GraphDiff): boolean {
  return diff.addedNodes.length === 0
    && diff.removedNodes.length === 0
    && diff.changedNodes.length === 0
    && diff.addedEdges.length === 0
    && diff.removedEdges.length === 0
}

function formatDiagnostic(diagnostic: Diagnostic): string {
  return `${diagnostic.code}:${diagnostic.severity}`
}

function formatDeclared(entry: { diagnostic: string; severity: 'warning' | 'info' }): string {
  return `${entry.diagnostic}:${entry.severity}`
}
