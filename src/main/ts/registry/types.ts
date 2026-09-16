// Registry/cache adapter contracts for graph modification + tree completion.
// Registry is a pure-read facade over packument facts; cache sits beneath it.

import type { Integrity } from '../recipe/integrity.ts'

/** Injectable WHATWG transport used by public registry and artifact seams. */
export type Fetch = typeof globalThis.fetch

/**
 * Caller-defined scheduling policy for registry API calls — a concurrency pool
 * / rate limiter / debouncer. Runs ONE async task under the caller's scheduler
 * and resolves to its result. The library ships NO policy: inject one via the
 * registry factory (`liveRegistry({ limit })`). It is surfaced on the adapter so
 * completion can forward it to a custom constraint (`ConditionContext.limit`),
 * letting a checker's own fetches share the SAME quota. Unset ⇒ run immediately.
 */
export type Limiter = <T>(task: () => Promise<T>) => Promise<T>

export interface PackumentVersion {
  readonly name:                 string
  readonly version:              string
  /** Multi-hash integrity carrier. Undefined when no hash is known. */
  readonly integrity?:           Integrity
  /** Tarball URL at the registry origin when the source graph carried it. */
  readonly tarball?:             string
  readonly dependencies?:        Readonly<Record<string, string>>
  readonly devDependencies?:     Readonly<Record<string, string>>
  readonly optionalDependencies?: Readonly<Record<string, string>>
  readonly peerDependencies?:    Readonly<Record<string, string>>
  readonly peerDependenciesMeta?: Readonly<Record<string, Readonly<{ optional?: boolean }>>>
  readonly engines?:             Readonly<Record<string, string>>
  readonly funding?:             unknown
  readonly os?:                  readonly string[]
  readonly cpu?:                 readonly string[]
  readonly libc?:                readonly string[]
  readonly deprecated?:          string
  readonly bin?:                 string | Readonly<Record<string, string>>
  readonly bundledDependencies?: readonly string[]
  readonly hasInstallScript?:    boolean
  /** SPDX license id (or expression). The abbreviated (corgi) packument OMITS
   *  this — it is present only on a FULL single-version manifest (see
   *  `RegistryAdapter.manifest`). Normalized from `license` string / legacy
   *  `{ type }` / `licenses[]` forms. Consumed by the completion `license`
   *  constraint. */
  readonly license?:             string
  /** Module system — `'module'` (ESM) / `'commonjs'` (or absent = CJS). Full-
   *  manifest only (corgi omits it). For custom module-format constraints. */
  readonly type?:                string
  /** CJS entry point. Full-manifest only. */
  readonly main?:                string
  /** The `exports` map (string | conditions object). Full-manifest only; shape
   *  left open — a constraint inspects it. */
  readonly exports?:             unknown
}

export interface Packument {
  readonly name:     string
  /** dist-tag → version, e.g. `{ latest: '4.17.21' }`. */
  readonly distTags: Readonly<Record<string, string>>
  /** Map of version → PackumentVersion. */
  readonly versions: Readonly<Record<string, PackumentVersion>>
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

  /** The scheduling policy this adapter runs its API calls under, if one was
   *  injected. Surfaced so completion can forward it to custom constraints via
   *  `ConditionContext.limit` — one quota across the registry AND user checkers. */
  readonly limit?: Limiter
}

type MutableField<Value> =
  Value extends readonly (infer Item)[] ? Item[]
    : Value extends Readonly<Record<string, infer Item>> ? Record<string, Item>
      : Value

/** @internal Mutable assembly form; never crosses a public adapter boundary. */
export type MutablePackumentVersion = {
  -readonly [Key in keyof PackumentVersion]: MutableField<PackumentVersion[Key]>
}

/** @internal Mutable assembly form; never crosses a public adapter boundary. */
export interface MutablePackument {
  name: string
  distTags: Record<string, string>
  versions: Record<string, PackumentVersion>
}

/** An explicitly configured registry route that is allowed to transport npm
 * tarball bytes for one package name. Route authorization is deliberately
 * separate from credential lookup: an anonymous route is still authorized,
 * while credentials are attached only after each URL (including redirects)
 * has been accepted by the route boundary. */
export interface ArtifactRoute {
  readonly registryUrl: string
  readonly fetch: typeof fetch
  readonly authHeaderFor: (url: string) => string | undefined
  readonly limit: Limiter
}

/** Registry metadata plus an opt-in remote byte route. Plain RegistryAdapter
 * implementations remain metadata-only and cannot accidentally gain network
 * authority merely by being listed as an artifact source. */
export interface RemoteArtifactRegistry extends RegistryAdapter {
  artifactRoute(name: string): ArtifactRoute | undefined
}

/**
 * A cache keyed by package IDENTITY (name / name@version) — for OFFLINE / FROZEN
 * resolution and reuse of a PM's on-disk store, NOT an HTTP response cache (that
 * belongs in `LiveRegistryOptions.fetch`, keyed by URL). Read *instead of* the
 * network. Byte capabilities are separate because npm tarballs, Yarn cache zips,
 * and pnpm's decomposed store are not interchangeable. Not wired into
 * `completeTransitives` today; consume it where reads happen (e.g. a future
 * `cachedRegistry(cache, live)`).
 */
export interface CacheAdapter {
  /** Lookup packument by package name. Undefined = cache miss. */
  packument(name: string): Promise<Packument | undefined>
}

/** Supplies original npm registry tarball (`.tgz`) bytes. A PM-specific cache
 *  must implement this only when it retains the registry artifact byte-for-byte. */
export interface NpmTarballSource {
  tarball(name: string, version: string): Promise<Uint8Array | undefined>
}

/** Supplies the digest of Yarn's own repacked cache zip for one cache profile.
 *  The zip bytes are deliberately not exposed as an npm tarball. */
export interface YarnBerryChecksumSource {
  berryChecksum(name: string, version: string, cacheKey: string): Promise<string | undefined>
}

/** npm cacache metadata plus byte-identical registry tarballs. */
export interface NpmCacheAdapter extends CacheAdapter, NpmTarballSource {}

/** Yarn cache metadata plus checksum evidence over Yarn's repacked zip. */
export interface YarnBerryCacheAdapter extends CacheAdapter, YarnBerryChecksumSource {}
