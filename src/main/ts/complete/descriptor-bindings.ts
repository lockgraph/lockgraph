import type { FormatId } from '../api/format-contract.ts'
import { serializeNodeId, type Graph } from '../graph.ts'
import {
  entryKeyDescriptorsOfNode as yarnBerryEntryKeyDescriptorsOfNode,
} from '../formats/_yarn-berry-core.ts'
import {
  entryKeyDescriptorsOfNode as yarnClassicEntryKeyDescriptorsOfNode,
} from '../formats/yarn-classic.ts'
import { yarnBerryBuiltinCompatIdentityOfResolution } from '../recipe/yarn-berry-builtin-compat.ts'
import type { DescriptorBinding, PackageVariantBinding } from './tree-complete.ts'

/** Parsed entry-key bindings matter only to descriptor-keyed Yarn targets.
 * npm/pnpm/bun identity is path/snapshot keyed and must not inherit Yarn's
 * verbatim orphan descriptors during cross-format completion. */
export function descriptorBindingsForTarget(
  graph: Graph,
  target: FormatId,
): readonly DescriptorBinding[] {
  const descriptorsOfNode = target === 'yarn-classic'
    ? yarnClassicEntryKeyDescriptorsOfNode
    : target.startsWith('yarn-berry-')
      ? yarnBerryEntryKeyDescriptorsOfNode
      : undefined
  if (descriptorsOfNode === undefined) return []

  const bindings: DescriptorBinding[] = []
  for (const node of graph.nodes()) {
    for (const descriptor of descriptorsOfNode(graph, node.id)) {
      const separator = descriptor.indexOf('@', descriptor.startsWith('@') ? 1 : 0)
      if (separator <= 0 || separator === descriptor.length - 1) continue
      bindings.push({
        name: descriptor.slice(0, separator),
        range: descriptor.slice(separator + 1),
        nodeId: node.id,
      })
    }
  }
  return bindings
}

/** Existing Yarn Berry builtin-compat patches are the install target for their
 * plain base package. Route both descriptor reuse and fresh resolution through
 * that producer-authored variant; non-Berry targets have no such overlay. */
export function packageVariantBindingsForTarget(
  graph: Graph,
  target: FormatId,
): readonly PackageVariantBinding[] {
  if (!target.startsWith('yarn-berry-')) return []

  const variants = new Map<string, string[]>()
  for (const node of graph.nodes()) {
    if (node.patch === undefined) continue
    const resolution = graph.tarballOf(node.id)?.nativeResolution
    if (resolution === undefined
      || yarnBerryBuiltinCompatIdentityOfResolution(resolution) === undefined) continue
    const baseNodeId = serializeNodeId(node.name, node.version, node.peerContext)
    if (graph.getNode(baseNodeId) === undefined) continue
    const siblings = variants.get(baseNodeId) ?? []
    siblings.push(node.id)
    variants.set(baseNodeId, siblings)
  }

  return [...variants]
    .filter(([, siblings]) => siblings.length === 1)
    .map(([baseNodeId, [variantNodeId]]) => ({ baseNodeId, variantNodeId: variantNodeId! }))
}
