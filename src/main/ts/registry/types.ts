// Registry/cache adapter contracts for graph modification + tree completion.
// Registry is a pure-read facade over packument facts; cache sits beneath it.

import type { Integrity } from '../recipe/integrity.ts'

export interface PackumentVersion {
  name:                 string
  version:              string
  /** Multi-hash integrity carrier (ADR-0031). Undefined when no hash is known. */
  integrity?:           Integrity
  /** Tarball URL at the registry origin when the source graph carried it. */
  tarball?:             string
  dependencies?:        Record<string, string>
  devDependencies?:     Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?:    Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
  engines?:             Record<string, string>
  os?:                  string[]
  cpu?:                 string[]
  libc?:                string[]
  deprecated?:          string
  bin?:                 string | Record<string, string>
  bundledDependencies?: string[]
  /** SPDX license id (or expression). The abbreviated (corgi) packument OMITS
   *  this — it is present only on a FULL single-version manifest (see
   *  `RegistryAdapter.manifest`). Normalised from `license` string / legacy
   *  `{ type }` / `licenses[]` forms. Consumed by the completion `license`
   *  constraint. */
  license?:             string
}

export interface Packument {
  name:     string
  /** dist-tag → version, e.g. `{ latest: '4.17.21' }`. */
  distTags: Record<string, string>
  /** Map of version → PackumentVersion. */
  versions: Record<string, PackumentVersion>
}

export interface RegistryAdapter {
  /** Fetch full packument for a package name. Undefined = package unknown. */
  packument(name: string): Promise<Packument | undefined>

  /**
   * Resolve `<name>@<range>` to a concrete version.
   * `range` may be a semver range, dist-tag, or exact version.
   */
  resolve(name: string, range: string): Promise<PackumentVersion | undefined>

  /**
   * OPTIONAL — the FULL single-version manifest for `<name>@<version>`, carrying
   * the fields the abbreviated (corgi) packument omits, notably `license`.
   * `liveRegistry` implements it (it already fetches this doc to backfill
   * `libc`). A corgi-only adapter (frozen / *Cache) may omit it — a
   * full-manifest-tier constraint (e.g. `license`) then reports `unevaluable`.
   * Undefined = version unknown / fetch failed.
   */
  manifest?(name: string, version: string): Promise<PackumentVersion | undefined>
}

export interface CacheAdapter {
  /** Lookup packument by package name. Undefined = cache miss. */
  packument(name: string): Promise<Packument | undefined>

  /** Optional tarball-bytes cache. Frozen Phase C implementations miss here. */
  tarball?(name: string, version: string): Promise<Uint8Array | undefined>
}
