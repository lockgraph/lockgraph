import type { PackageMetadataField, TarballPayload } from '../graph.ts'
import type { PackumentVersion } from './types.ts'

export const PACKAGE_METADATA_FIELDS = Object.freeze([
  'engines',
  'funding',
  'license',
  'bin',
  'deprecated',
  'cpu',
  'os',
  'libc',
  'hasInstallScript',
  'bundledDependencies',
  'peerDependencies',
  'peerDependenciesMeta',
] as const)

export type PackageMetadataPayload = Pick<TarballPayload, PackageMetadataField>

function canonicalMetadataValue(
  field: PackageMetadataField,
  value: TarballPayload[PackageMetadataField],
): TarballPayload[PackageMetadataField] | undefined {
  if (value === undefined) return undefined
  if (field === 'hasInstallScript') return value === true ? true : undefined
  if (field === 'peerDependenciesMeta') {
    const entries = Object.entries(value as NonNullable<TarballPayload['peerDependenciesMeta']>)
      .filter(([, meta]) => meta.optional === true)
      .map(([name]) => [name, { optional: true }])
    return entries.length === 0 ? undefined : Object.fromEntries(entries)
  }
  if (Array.isArray(value)) return value.length === 0 ? undefined : value
  if (field !== 'funding' && typeof value === 'object' && value !== null) {
    return Object.keys(value).length === 0 ? undefined : value
  }
  return value
}

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
  const projected: TarballPayload = {
    integrity:            pv.integrity,
    engines:              pv.engines,
    funding:              pv.funding,
    license:              pv.license,
    os:                   pv.os,
    cpu:                  pv.cpu,
    libc:                 pv.libc,
    bin:                  pv.bin,
    bundledDependencies:  pv.bundledDependencies,
    deprecated:           pv.deprecated,
    hasInstallScript:     pv.hasInstallScript,
    peerDependencies:     pv.peerDependencies,
    peerDependenciesMeta: pv.peerDependenciesMeta,
    resolution:           pv.tarball === undefined ? undefined : { type: 'tarball', url: pv.tarball },
  }
  return {
    integrity: projected.integrity,
    ...packageMetadataOfPayload(projected),
    resolution: projected.resolution,
  }
}

export function packageMetadataOfPayload(
  payload: TarballPayload | undefined,
): Readonly<PackageMetadataPayload> {
  if (payload === undefined) return Object.freeze({})
  const metadata: Partial<PackageMetadataPayload> = {}
  for (const field of PACKAGE_METADATA_FIELDS) {
    const value = canonicalMetadataValue(field, payload[field])
    if (value !== undefined) Object.assign(metadata, { [field]: value })
  }
  return Object.freeze(metadata as PackageMetadataPayload)
}
