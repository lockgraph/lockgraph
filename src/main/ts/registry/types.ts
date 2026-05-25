// Registry/cache adapter contracts for graph modification + tree completion.
// Registry is a pure-read facade over packument facts; cache sits beneath it.

export interface PackumentVersion {
  name:                 string
  version:              string
  /** Canonical sha512 SRI per ADR-0014 §4.F1. Undefined for legacy entries. */
  integrity?:           string
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
}

export interface CacheAdapter {
  /** Lookup packument by package name. Undefined = cache miss. */
  packument(name: string): Promise<Packument | undefined>

  /** Optional tarball-bytes cache. Frozen Phase C implementations miss here. */
  tarball?(name: string, version: string): Promise<Uint8Array | undefined>
}
