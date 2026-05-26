// Phase C / Phase D-A / Phase D-B — registry/ public re-exports.
//
// Contract types (RegistryAdapter / CacheAdapter / Packument / PackumentVersion)
// land via Phase C alongside frozenRegistry (graph-derived offline adapter).
// Phase D-A adds the live HTTPS adapter; Phase D-B adds the filesystem
// CacheAdapter (`fsCache`) over yarn-berry `.yarn/cache/`. All three
// coexist and share the same registry/cache shapes so consumers can
// swap one for the other без touching modifier / completion call sites.

export { frozenRegistry } from './frozen.ts'
export { liveRegistry, type LiveRegistryOptions } from './live.ts'
export { fsCache, type FsCacheOptions } from './cache.ts'
export type {
  CacheAdapter,
  Packument,
  PackumentVersion,
  RegistryAdapter,
} from './types.ts'
