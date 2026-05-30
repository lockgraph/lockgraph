// Recipe-owned, parse-time manifest-override carrier (ADR-0025 §6, A2).
//
// `overridesOf(graph)` (in `index.ts`) folds three override sources into one
// canonical list: lock-borne npm `rootMeta.overrides` / pnpm `sidecar.overrides`
// (read off the format sidecars) and manifest-F6 captures from
// `ParseOptions.manifests`. The manifest-F6 half has no format sidecar to live
// in — it is PM-neutral and captured in the public `parse()` wrapper — so it
// lands here, on a recipe-owned `WeakMap<Graph, …>`.
//
// Lifetime (per ADR-0025 §6 "Carrier lifecycle", Option-S): write-once at parse,
// keyed by the adapter-returned graph; read off that same handle. It is NOT
// propagated across `graph.mutate()` / enrich / optimize — matching the real
// modify-path lifetime of every format sidecar (a bare `mutate` drops them all;
// only yarn-berry's parse-time proxy re-attaches its own sidecar, unaware of this
// carrier). Consumer contract: read-before-modify. Seal-invisible (a
// `WeakMap<Graph,…>` is unreachable from `validate(State)`), so ADR-0017 + the
// ADR-0025 §1 "no overrides on the Graph" boundary stay intact.

import type { Graph, OverrideConstraint } from '../graph.ts'

const manifestOverridesByGraph = new WeakMap<Graph, OverrideConstraint[]>()

/** Stash manifest-F6 canonical overrides on the parsed graph handle. No-op for
 *  an empty list (nothing to attribute). */
export function rememberManifestOverrides(graph: Graph, overrides: OverrideConstraint[]): void {
  if (overrides.length === 0) return
  manifestOverridesByGraph.set(graph, overrides)
}

/** Read the manifest-F6 carrier for a graph (undefined if none / post-mutate). */
export function getManifestOverrides(graph: Graph): OverrideConstraint[] | undefined {
  return manifestOverridesByGraph.get(graph)
}

// Identity of an override for collision resolution: package + ordered parent
// chain + version condition. A JSON-array key is collision-free (JSON escapes
// every field) and pure-ASCII — no delimiter byte to clash with package names,
// ranges, or chain segments.
const overrideKey = (c: OverrideConstraint): string =>
  JSON.stringify([c.package, c.parentPath ?? [], c.versionCondition ?? ''])

/**
 * Merge two override lists by `(package, parentPath, versionCondition)` identity
 * (ADR-0025 §6 Precedence): insert `base`, then `winners` which overwrite on a
 * tuple collision. Within either list, last-wins on duplicate tuples. Pure —
 * never mutates the input arrays; returns a fresh, deterministically-ordered
 * array (which shares the input `OverrideConstraint` object references —
 * constraints are treated as immutable codebase-wide). Used to fold lock-borne
 * (base) under manifest-F6 (winners) so the authored declaration wins.
 */
export function mergeOverrides(
  base: readonly OverrideConstraint[],
  winners: readonly OverrideConstraint[],
): OverrideConstraint[] {
  const map = new Map<string, OverrideConstraint>()
  for (const c of base) map.set(overrideKey(c), c)
  for (const c of winners) map.set(overrideKey(c), c)
  return Array.from(map.entries())
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, c]) => c)
}
