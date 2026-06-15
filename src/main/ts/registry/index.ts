// Phase C / Phase D-A / Phase D-B — registry/ public re-exports.
//
// Contract types (RegistryAdapter / CacheAdapter / Packument / PackumentVersion)
// land via Phase C alongside frozenRegistry (graph-derived offline adapter).
// Phase D-A adds the live HTTPS adapter; Phase D-B adds the filesystem
// CacheAdapter family — `yarnBerryCache` (yarn-berry `.yarn/cache/`), `npmCache`
// (cacache CAS under `~/.npm/_cacache/`), and `pnpmCache` (content-
// addressable store under `~/.pnpm-store/v3/`). All four coexist and
// share the same registry/cache shapes so consumers can swap one for
// the other без touching modifier / completion call sites.

export { frozenRegistry } from './frozen.ts'
export { liveRegistry, type LiveRegistryOptions } from './live.ts'
export { yarnBerryCache, type YarnBerryCacheOptions } from './cache-yarn-berry.ts'
export { npmCache, type NpmCacheOptions } from './cache-npm.ts'
export { pnpmCache, type PnpmCacheOptions } from './cache-pnpm.ts'
export type {
  CacheAdapter,
  Packument,
  PackumentVersion,
  RegistryAdapter,
} from './types.ts'
