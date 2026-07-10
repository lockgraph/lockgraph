// Phase C / Phase D-A / Phase D-B — registry/ public re-exports.
//
// Contract types (RegistryAdapter / CacheAdapter / Packument / PackumentVersion)
// land via Phase C alongside frozenRegistry (graph-derived offline adapter).
// Phase D-A adds the live HTTPS adapter; Phase D-B adds the filesystem
// CacheAdapter family — `yarnBerryCache` (yarn-berry `.yarn/cache/`), `npmCache`
// (cacache CAS under `~/.npm/_cacache/`), and `pnpmCache` (content-
// addressable store under `~/.pnpm-store/v3/`). All four coexist and
// share the same registry/cache shapes so consumers can swap one for
// the other without touching modifier / completion call sites.

// The library's DEFAULT transport (node-fetch-native — native `fetch` on Node
// 18+, polyfill on 14–17). Re-exported so a caller can WRAP the same floor-safe
// fetch (retry / HTTP-cache) and pass it back as `liveRegistry({ fetch })`,
// instead of adding node-fetch-native as their own dependency.
export { fetch as defaultFetch } from 'node-fetch-native'

export { frozenRegistry } from './frozen.ts'
export {
  liveRegistry,
  type LiveRegistryOptions,
  type FromConfigOptions,
  type LiveRegistryAdapter,
  type AuditOptions,
  type RawAdvisory,
} from './live.ts'
export {
  resolveRegistry,
  DEFAULT_REGISTRY,
  type Ecosystem,
  type RegistryConfig,
  type ResolveRegistryOptions,
} from './config.ts'
export { yarnBerryCache, type YarnBerryCacheOptions } from './cache-yarn-berry.ts'
export { npmCache, type NpmCacheOptions } from './cache-npm.ts'
export { pnpmCache, type PnpmCacheOptions } from './cache-pnpm.ts'
export type {
  CacheAdapter,
  Limiter,
  Packument,
  PackumentVersion,
  RegistryAdapter,
} from './types.ts'
