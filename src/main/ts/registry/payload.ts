import type { TarballPayload } from '../graph.ts'
import type { PackumentVersion } from './types.ts'

/**
 * Project a registry `PackumentVersion` onto a graph `TarballPayload` (ADR-0023 §4.2).
 *
 * SINGLE SOURCE OF TRUTH for every "mint a node from the registry" path — completion
 * (`completeTransitives`'s `projectPackumentVersion`), `replaceVersion`, and
 * `addDependency`. A payload field added here must NOT be re-copied into per-caller
 * projections: three drifting copies are exactly what dropped
 * `peerDependencies` / `peerDependenciesMeta` on a `replaceVersion`-bumped berry node
 * and re-broke `yarn install --immutable` (YN0028) after only the completion copy had
 * been fixed. Add the field ONCE, here.
 */
export function payloadOfPackumentVersion(pv: PackumentVersion): TarballPayload {
  return {
    integrity:            pv.integrity,
    engines:              pv.engines,
    os:                   pv.os,
    cpu:                  pv.cpu,
    libc:                 pv.libc,
    bin:                  pv.bin,
    bundledDependencies:  pv.bundledDependencies,
    deprecated:           pv.deprecated,
    peerDependencies:     pv.peerDependencies,
    peerDependenciesMeta: pv.peerDependenciesMeta,
    resolution:           pv.tarball === undefined ? undefined : { type: 'tarball', url: pv.tarball },
  }
}
