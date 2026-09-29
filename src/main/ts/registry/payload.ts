import type {
  EdgeKind,
  Mutator,
  PackageMetadataField,
  TarballKeyInputs,
  TarballPayload,
} from '../graph.ts'
import { parseSri, type Integrity } from '../recipe/integrity.ts'
import { LockfileError } from '../api/errors.ts'
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

export interface PackumentDependencyDeclaration {
  readonly name: string
  readonly range: string
  readonly kind: Extract<EdgeKind, 'dep' | 'optional' | 'peer'>
}

/** Install-time dependency declarations in deterministic order.
 *
 * npm packuments may repeat an optional dependency in `dependencies`. npm's
 * manifest rule is that `optionalDependencies` overrides the same-name
 * `dependencies` entry, including its range. Normalize that producer shape at
 * the registry boundary so every graph-edge consumer sees one optional
 * declaration rather than contradictory dep + optional edges. */
export function dependencyDeclarationsOfPackumentVersion(
  pv: PackumentVersion,
): readonly PackumentDependencyDeclaration[] {
  const optional = pv.optionalDependencies
  const buckets: readonly [
    Readonly<Record<string, string>> | undefined,
    PackumentDependencyDeclaration['kind'],
  ][] = [
    [pv.dependencies, 'dep'],
    [optional, 'optional'],
    [pv.peerDependencies, 'peer'],
  ]
  const declarations: PackumentDependencyDeclaration[] = []
  for (const [dependencies, kind] of buckets) {
    if (dependencies === undefined) continue
    for (const name of Object.keys(dependencies).sort()) {
      if (kind === 'dep' && optional !== undefined
        && Object.prototype.hasOwnProperty.call(optional, name)) continue
      declarations.push({ name, range: dependencies[name]!, kind })
    }
  }
  return Object.freeze(declarations)
}

function isRuntimeHash(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false
  const hash = value as {
    readonly algorithm?: unknown
    readonly digest?: unknown
    readonly origin?: unknown
  }
  return [hash.algorithm, hash.digest, hash.origin].every(field => typeof field === 'string')
}

/**
 * Reject a `url-fragment`-origin member arriving from a registry adapter.
 *
 * `_common.md` §3.2 calls this "the one rule in §3.2 that has been got wrong in
 * production code": `url-fragment` names the yarn 1.0-1.5 `resolved#<sha1>` SLOT,
 * never a provenance. A registry's `dist.shasum` is registry metadata and its origin
 * is `registry` (`registry/live.ts` stamps exactly that) — yarn 1 merely happens to
 * render it into a URL. Tagged as the slot instead, the digest falls outside
 * `isTarballOrigin`, so `emitSri` skips it AND `tarballSha1ForUrlFragment` refuses to
 * render the fragment: a checksum in hand that no format can write, which is a bug and
 * never an acceptable loss.
 *
 * Checked where a minted payload ENTERS THE GRAPH rather than in
 * `payloadOfPackumentVersion`: three callers (`completeness/profile.ts`,
 * `enrich/hydrate-metadata.ts`, `enrich/facade.ts`) run that projection purely to compare
 * METADATA and discard the integrity, so refusing there would fail a manifest comparison
 * over a field it never reads. Left to travel, it surfaces far downstream as an unattributed
 * `COMPLETENESS_OUTPUT_GRAPH_MISMATCH` on a strict emit — the same invalid input the
 * lockgraph emitter already rejects outright with `INVARIANT_VIOLATION`, but with no
 * subject and no rule to look up. A stale recorded fixture is the realistic source.
 */
function assertNoSlotTaggedHash(payload: TarballPayload, inputs: TarballKeyInputs): void {
  if (payload.integrity?.hashes.some(hash => hash.origin === 'url-fragment') !== true) return
  throw new LockfileError({
    code:    'INVARIANT_VIOLATION',
    message: `registry payload for ${inputs.name}@${inputs.version} carries a url-fragment-origin `
      + 'hash; that origin names the yarn-classic resolved#<sha1> slot, not a provenance — a '
      + 'registry shasum is origin `registry` (_common.md §3.2). Re-record the response.',
  })
}

function integrityOfPackumentVersion(value: unknown): Integrity | undefined {
  if (typeof value === 'string') {
    // A raw value is an SRI field, not a provenance-tagged registry carrier.
    // Format parsers reconstruct emitted SRI with this same neutral origin.
    const parsed = parseSri(value)
    return parsed.hashes.length === 0 ? undefined : parsed
  }
  if (value === null || typeof value !== 'object') return undefined
  const hashes = (value as { readonly hashes?: unknown }).hashes
  if (!Array.isArray(hashes) || hashes.length === 0) return undefined
  const valid = hashes.every(isRuntimeHash)
  return valid ? value as Integrity : undefined
}

/** Store registry-minted payloads only when they carry a usable fact. */
export function setMintedTarball(
  mutator: Mutator,
  inputs: TarballKeyInputs,
  payload: TarballPayload,
): void {
  if (Object.values(payload).every(value => value === undefined)) return
  assertNoSlotTaggedHash(payload, inputs)
  mutator.setTarball(inputs, payload)
}

function canonicalMetadataValue(
  field: PackageMetadataField,
  value: TarballPayload[PackageMetadataField] | PackumentVersion[PackageMetadataField],
): TarballPayload[PackageMetadataField] | undefined {
  if (value === undefined) return undefined
  if (field === 'hasInstallScript') return value === true ? true : undefined
  if (field === 'peerDependenciesMeta') {
    const entries = Object.entries(value as NonNullable<TarballPayload['peerDependenciesMeta']>)
      .filter(([, meta]) => meta.optional === true)
      .map(([name]) => [name, { optional: true }])
    return entries.length === 0 ? undefined : Object.fromEntries(entries)
  }
  if (Array.isArray(value)) return value.length === 0 ? undefined : [...value]
  if (field !== 'funding' && typeof value === 'object' && value !== null) {
    return Object.keys(value).length === 0 ? undefined : value
  }
  return value
}

/**
 * Project a registry `PackumentVersion` onto a graph `TarballPayload`.
 *
 * SINGLE SOURCE OF TRUTH for every "mint a node from the registry" path — completion
 * (`completeTransitives`'s `projectPackumentVersion`), `replaceVersion`, and
 * `addDependency`. A payload field added here must NOT be re-copied into per-caller
 * projections: three drifting copies are exactly what dropped
 * `peerDependencies` / `peerDependenciesMeta` on a `replaceVersion`-bumped berry node
 * and re-broke `yarn install --immutable` (YN0028) after only the completion copy had
 * been fixed. Add the field ONCE, here.
 */
/**
 * A string `bin` is npm's shorthand for one command named after the package's
 * UNSCOPED name (`@babel/parser` → `parser`). Every lockfile that records commands
 * stores the map — Yarn Berry writes `parser: ./bin/babel-parser.js`, npm
 * `"parser": "bin/babel-parser.js"` — so the graph holds the map. Kept as a string it
 * disagrees with what a target's own parser reads back, and a strict emit refuses the
 * node as a projection loss.
 */
function binOfPackumentVersion(pv: PackumentVersion): TarballPayload['bin'] {
  if (typeof pv.bin !== 'string') return pv.bin
  const command = pv.name.startsWith('@') ? pv.name.slice(pv.name.indexOf('/') + 1) : pv.name
  return { [command]: pv.bin }
}

export function payloadOfPackumentVersion(pv: PackumentVersion): TarballPayload {
  const projected: TarballPayload = {
    integrity:            integrityOfPackumentVersion(pv.integrity),
    engines:              pv.engines,
    funding:              pv.funding,
    license:              pv.license,
    os:                   pv.os === undefined ? undefined : [...pv.os],
    cpu:                  pv.cpu === undefined ? undefined : [...pv.cpu],
    libc:                 pv.libc === undefined ? undefined : [...pv.libc],
    bin:                  binOfPackumentVersion(pv),
    bundledDependencies:  pv.bundledDependencies === undefined
      ? undefined
      : [...pv.bundledDependencies],
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
  payload: TarballPayload | PackumentVersion | undefined,
): Readonly<PackageMetadataPayload> {
  if (payload === undefined) return Object.freeze({})
  const metadata: Partial<PackageMetadataPayload> = {}
  for (const field of PACKAGE_METADATA_FIELDS) {
    const value = canonicalMetadataValue(field, payload[field])
    if (value !== undefined) Object.assign(metadata, { [field]: value })
  }
  return Object.freeze(metadata as PackageMetadataPayload)
}

function stableMetadataValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableMetadataValue)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => [key, stableMetadataValue(item)]))
  }
  return value
}

export function packageMetadataEqual(
  left: Readonly<PackageMetadataPayload>,
  right: Readonly<PackageMetadataPayload>,
): boolean {
  return JSON.stringify(stableMetadataValue(left)) === JSON.stringify(stableMetadataValue(right))
}
