import semver from 'semver'
import type { Graph } from '../graph.ts'

/**
 * Group the graph's REGISTRY packages as `{ name: versions[] }` — the
 * locator-aware "which nodes are real npm-registry packages" classification,
 * owned here so consumers (e.g. an audit layer) don't re-derive it and drift as
 * the lib adds locator support.
 *
 * A node is a registry package iff it is NOT a workspace, NOT a discriminated
 * non-registry source (`Node.source` is set for `git` + non-registry `tarball`),
 * NOT a `directory` (`file:`/`link:`/`portal:`) or `unknown` resolution, and its
 * version is valid semver. Plain registry versions (no `resolution`) and
 * default-registry tarballs (bare `tarball`, `source` undefined) are included.
 * Versions are de-duplicated and semver-sorted per name. The returned object has
 * a null prototype.
 */
export function registryPackages(graph: Graph): Record<string, string[]> {
  const sets: Record<string, Set<string>> = Object.create(null)
  for (const node of graph.nodes()) {
    if (node.workspacePath !== undefined) continue            // workspace, not published
    if (node.source !== undefined) continue                   // git / non-registry tarball (Node.source)
    const r = graph.tarballOf(node.id)?.resolution            // resolution lives on the TarballPayload
    if (r !== undefined && (r.type === 'directory' || r.type === 'unknown')) continue // file:/link:/portal: / unparseable
    if (semver.valid(node.version) === null) continue         // non-release locator
    ;(sets[node.name] ??= new Set<string>()).add(node.version)
  }
  const out: Record<string, string[]> = Object.create(null)
  for (const name of Object.keys(sets)) out[name] = [...sets[name]!].sort(semver.compare)
  return out
}
