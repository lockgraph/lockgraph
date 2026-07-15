import {
  toTarballKey,
  type Graph,
  type Node,
  type TarballKey,
  type TarballKeyInputs,
} from '../graph.ts'

function inputsOf(node: Pick<Node, 'name' | 'version' | 'patch' | 'source'>): TarballKeyInputs {
  return {
    name: node.name,
    version: node.version,
    ...(node.patch === undefined ? {} : { patch: node.patch }),
    ...(node.source === undefined ? {} : { source: node.source }),
  }
}

/**
 * Remove candidate payload keys that no longer have any live Node. Payloads
 * are shared by peer-virtual siblings, so node removal/rekeying must never
 * delete a key while another sibling still projects to it.
 */
export function pruneOrphanTarballs(
  graph: Graph,
  candidates: Iterable<Pick<Node, 'name' | 'version' | 'patch' | 'source'>>,
): Graph {
  const liveKeys = new Set<TarballKey>()
  for (const node of graph.nodes()) liveKeys.add(toTarballKey(inputsOf(node)))

  const removable = new Map<TarballKey, TarballKeyInputs>()
  for (const candidate of candidates) {
    const inputs = inputsOf(candidate)
    const key = toTarballKey(inputs)
    if (!liveKeys.has(key) && graph.tarball(inputs) !== undefined) removable.set(key, inputs)
  }
  if (removable.size === 0) return graph

  return graph.mutate(mutator => {
    for (const [, inputs] of [...removable].sort(([left], [right]) => left.localeCompare(right))) {
      mutator.removeTarball(inputs)
    }
  }).graph
}
