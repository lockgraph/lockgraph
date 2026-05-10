import { isDeepStrictEqual } from 'node:util'
import type { Graph } from '../../main/ts/graph.ts'
import { rawConditionsBlockOfNode } from '../../main/ts/formats/_yarn-berry-core.ts'
import type { PreservedFeature } from './_matrix.ts'

// Features observed on a graph for contract diagnostics. Includes PreservedFeature
// (returnable by graphSubset) plus the runtime-only flags the observation lens uses
// (`patch`, `virtual`, `workspace-metadata`, `sentinel`).
export type GraphFeature =
  | PreservedFeature
  | 'patch'
  | 'virtual'
  | 'workspace-metadata'
  | 'sentinel'

export function featurePresence(graph: Graph, feature: GraphFeature): boolean {
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
    case 'patch':
      return Array.from(graph.nodes()).some(node => node.patch !== undefined)
    case 'peer-virt':
      return Array.from(graph.nodes()).some(node => node.peerContext.length > 0)
    case 'conditions':
      return Array.from(graph.nodes()).some(node => rawConditionsBlockOfNode(graph, node.id) !== undefined)
    case 'virtual':
      return Array.from(graph.nodes()).some(node => node.id.includes('('))
    case 'workspace-metadata':
      return Array.from(graph.nodes()).some(node => node.workspacePath !== undefined)
        || Array.from(graph.nodes()).some(node =>
          graph.out(node.id).some(edge => edge.attrs?.workspace === true),
        )
    case 'sentinel':
      return Array.from(graph.nodes()).some(node => node.patch?.startsWith('unresolved-') === true)
    default:
      throw new Error(`featurePresence: unknown feature '${feature satisfies never}'`)
  }
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
            const found = haystack.out(edge.src).some(candidate =>
              candidate.dst === edge.dst && candidate.kind === edge.kind,
            )
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
        throw new Error(`graphSubset: unknown PreservedFeature '${feature satisfies never}'`)
    }
  }

  return true
}
