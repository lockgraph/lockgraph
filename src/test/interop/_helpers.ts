import { isDeepStrictEqual } from 'node:util'
import type { Diagnostic, Graph, GraphDiff } from '../../main/ts/graph.ts'
import { rawConditionsBlockOfNode } from '../../main/ts/formats/_yarn-berry-core.ts'
import { ALL_FEATURES, type ConversionContract, type PreservedFeature } from './_matrix.ts'

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

export function graphSubset(
  needle: Graph,
  haystack: Graph,
  features: readonly PreservedFeature[],
): boolean {
  const haystackTarballs = new Map(Array.from(haystack.tarballs()))

  for (const feature of features) {
    switch (feature) {
      case 'nodes':
        for (const node of needle.nodes()) {
          if (haystack.getNode(node.id) === undefined) return false
        }
        break
      case 'edges':
        for (const node of needle.nodes()) {
          for (const edge of needle.out(node.id)) {
            const found = haystack.out(edge.src).some(candidate => candidate.dst === edge.dst)
            if (!found) return false
          }
        }
        break
      case 'edge-kinds':
        for (const node of needle.nodes()) {
          for (const edge of needle.out(node.id)) {
            const found = haystack.out(edge.src).some(candidate =>
              candidate.dst === edge.dst && candidate.kind === edge.kind,
            )
            if (!found) return false
          }
        }
        break
      case 'integrity':
        for (const node of needle.nodes()) {
          const actual = needle.tarballOf(node.id)?.integrity
          if (actual !== undefined && haystack.tarballOf(node.id)?.integrity !== actual) return false
        }
        break
      case 'resolved-url':
        for (const node of needle.nodes()) {
          if (node.resolution !== undefined && haystack.getNode(node.id)?.resolution !== node.resolution) {
            return false
          }
        }
        break
      case 'tarballs':
        for (const [key, payload] of needle.tarballs()) {
          if (!isDeepStrictEqual(haystackTarballs.get(key), payload)) return false
        }
        break
      case 'workspace-membership':
        for (const node of needle.nodes()) {
          if (node.workspacePath !== undefined && haystack.getNode(node.id)?.workspacePath !== node.workspacePath) {
            return false
          }
        }
        break
      case 'patch-slots':
        for (const node of needle.nodes()) {
          if (node.patch !== undefined && haystack.getNode(node.id)?.patch !== node.patch) return false
        }
        break
      case 'peer-virt':
        for (const node of needle.nodes()) {
          if (node.peerContext.length > 0 && !isDeepStrictEqual(haystack.getNode(node.id)?.peerContext ?? [], node.peerContext)) {
            return false
          }
        }
        break
      case 'conditions':
        for (const node of needle.nodes()) {
          const actual = rawConditionsBlockOfNode(needle, node.id)
          if (actual !== undefined && !isDeepStrictEqual(rawConditionsBlockOfNode(haystack, node.id), actual)) {
            return false
          }
        }
        break
      default:
        throw new Error(`Graph.subset: unknown PreservedFeature '${feature satisfies never}'`)
    }
  }

  return true
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
        if (hasFeature(reentered, feature) && graphSubset(reentered, source, [feature])) {
          return `reentrancy class violation: one-way-lossy pair preserved undeclared feature '${feature}'`
        }
      }
      return undefined
    }
    case 'asymmetric':
      return undefined
  }
}

function hasFeature(graph: Graph, feature: PreservedFeature): boolean {
  switch (feature) {
    case 'nodes':
      return Array.from(graph.nodes()).length > 0
    case 'edges':
    case 'edge-kinds':
      return Array.from(graph.nodes(), node => graph.out(node.id).length).some(count => count > 0)
    case 'integrity':
      return Array.from(graph.nodes()).some(node => graph.tarballOf(node.id)?.integrity !== undefined)
    case 'resolved-url':
      return Array.from(graph.nodes()).some(node => node.resolution !== undefined)
    case 'tarballs':
      return Array.from(graph.tarballs()).length > 0
    case 'workspace-membership':
      return Array.from(graph.nodes()).some(node => node.workspacePath !== undefined)
    case 'patch-slots':
      return Array.from(graph.nodes()).some(node => node.patch !== undefined)
    case 'peer-virt':
      return Array.from(graph.nodes()).some(node => node.peerContext.length > 0)
    case 'conditions':
      return Array.from(graph.nodes()).some(node => rawConditionsBlockOfNode(graph, node.id) !== undefined)
    default:
      throw new Error(`Unknown feature: ${feature satisfies never}`)
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
