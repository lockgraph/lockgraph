import { isDeepStrictEqual } from 'node:util'
import type { Graph, TarballPayload } from '../../main/ts/graph.ts'
import { rawConditionsBlockOfNode } from '../../main/ts/formats/_yarn-berry-core.ts'
import type { PreservedFeature } from './_matrix.ts'

function stripResolution(payload: TarballPayload | undefined): TarballPayload | undefined {
  if (payload === undefined) return undefined
  if (payload.resolution === undefined) return payload
  const { resolution: _resolution, ...rest } = payload
  return rest
}

// Features observed on a graph for contract diagnostics. Includes PreservedFeature
// (returnable by graphSubset) plus the runtime-only flags the observation lens uses
// (`patch`, `virtual`, `workspace-metadata`, `sentinel`, `sentinel-collapsed`,
// `multi-spec-collapsed`).
export type GraphFeature =
  | PreservedFeature
  | 'patch'
  | 'virtual'
  | 'workspace-metadata'
  | 'sentinel'
  | 'sentinel-collapsed'
  | 'multi-spec-collapsed'

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
    case 'sentinel-collapsed':
      return Array.from(graph.nodes()).some(node => node.patch?.startsWith('unresolved-') === true)
    case 'multi-spec-collapsed':
      // Graph-side signal: a node with multiple incoming edges carrying
      // distinct ranges. Classic multi-spec entry keys ("foo@^1, foo@^2") with
      // no parent references are not observable on the graph; lockfile-text
      // detection in `_observe.ts` covers the source-text route.
      return Array.from(graph.nodes()).some(node => {
        const ranges = new Set<string>()
        for (const edge of graph.in(node.id)) {
          if (edge.kind !== 'dep' && edge.kind !== 'optional') continue
          const range = edge.attrs?.range
          if (typeof range === 'string') ranges.add(range)
        }
        return ranges.size > 1
      })
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
        // ADR-0014 §4.F3 — PM-native `node.resolution` is sidecar attribution
        // (yarn-berry locator vs yarn-classic URL vs pnpm tarball URL, all
        // shape-different by design). Preservation across formats is at the
        // canonical level: both source and destination must carry resolution
        // information of the SAME canonical type (the URL host is attribution
        // and may diverge per stringify-table convention).
        for (const node of needle.nodes()) {
          const needleHasNative = node.resolution !== undefined
          const needleCanonical = needle.tarballOf(node.id)?.resolution
          if (!needleHasNative && needleCanonical === undefined) continue
          const haystackNode = haystack.getNode(node.id)
          const haystackHasNative = haystackNode?.resolution !== undefined
          const haystackCanonical = haystack.tarballOf(node.id)?.resolution
          if (!haystackHasNative && haystackCanonical === undefined) return false
          if (needleCanonical !== undefined && haystackCanonical !== undefined
            && needleCanonical.type !== haystackCanonical.type) {
            return false
          }
        }
        break
      case 'tarballs':
        for (const [key, payload] of needle.tarballs()) {
          // ADR-0014 §4.F3 — canonical resolution URL is attribution per
          // hosting host (identity drops host for `(name, version)` tuple).
          // Different source/target adapters produce different canonical
          // URLs by convention (e.g. yarn-berry uses npmjs default, yarn-
          // classic emits yarnpkg.com); excluding `resolution` from the
          // tarball-preservation comparator avoids that attribution divergence.
          if (!isDeepStrictEqual(stripResolution(haystackTarballs.get(key)), stripResolution(payload))) return false
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
