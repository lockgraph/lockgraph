// Registry/cache adapter contracts for graph modification + tree completion.
// Registry is a pure-read facade over packument facts; cache sits beneath it.

import type { Integrity } from '../recipe/integrity.ts'

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
  funding?:             unknown
  os?:                  string[]
  cpu?:                 string[]
  libc?:                string[]
  deprecated?:          string
  bin?:                 string | Record<string, string>
  bundledDependencies?: string[]
  hasInstallScript?:    boolean
  /** SPDX license id (or expression). The abbreviated (corgi) packument OMITS
   *  this — it is present only on a FULL single-version manifest (see
   *  `RegistryAdapter.manifest`). Normalised from `license` string / legacy
   *  `{ type }` / `licenses[]` forms. Consumed by the completion `license`
   *  constraint. */
  license?:             string
  /** Module system — `'module'` (ESM) / `'commonjs'` (or absent = CJS). Full-
   *  manifest only (corgi omits it). For custom module-format constraints. */
  type?:                string
  /** CJS entry point. Full-manifest only. */
  main?:                string
  /** The `exports` map (string | conditions object). Full-manifest only; shape
   *  left open — a constraint inspects it. */
  exports?:             unknown
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

  /** The scheduling policy this adapter runs its API calls under, if one was
   *  injected. Surfaced so completion can forward it to custom constraints via
   *  `ConditionContext.limit` — one quota across the registry AND user checkers. */
  limit?: Limiter
}

/**
 * A cache keyed by package IDENTITY (name / name@version) — for OFFLINE / FROZEN
 * resolution and reuse of a PM's on-disk store, NOT an HTTP response cache (that
 * belongs in `LiveRegistryOptions.fetch`, keyed by URL). Read *instead of* the
 * network. Returned bytes MUST match what the registry would serve for that
 * identity — a cache that returns different bytes across runs breaks the
 * frozen-clean invariant (a different lock). Not wired into `completeTransitives`
 * today; consume it where reads happen (e.g. a future `cachedRegistry(cache, live)`).
 */
export interface CacheAdapter {
  /** Lookup packument by package name. Undefined = cache miss. */
  packument(name: string): Promise<Packument | undefined>

  /** Optional tarball-bytes cache. Frozen Phase C implementations miss here. */
  tarball?(name: string, version: string): Promise<Uint8Array | undefined>
}
