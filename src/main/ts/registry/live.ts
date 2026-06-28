// Live HTTPS RegistryAdapter — Phase D-A.
//
// Implements the Phase C `RegistryAdapter` contract over the npm
// registry HTTP API (npmjs.org and bug-compatible mirrors). Pure read
// facade: `packument(name)` does ONE GET, `resolve(name, range)` reuses
// the packument it just fetched. No caching, no retries, no tarball
// reads — those layers stack on top via CacheAdapter (Phase D-B) and
// the modify/complete tree-walks (already landed on Phase B/Phase C).
//
// Normalisation: the npm registry returns each version under
// `versions[v]` with `dist.tarball` / `dist.integrity` nested under dist.
// Per Phase C contract `PackumentVersion.tarball` / `.integrity` are
// flat fields, so we lift them out of `dist` during normalisation.
// dist-tags ship under the hyphenated key `'dist-tags'`; we re-key it
// to `distTags` for the contract.
//
// Fetch impl: `opts.fetch` overrides (tests pass a spy); otherwise the
// default is node-fetch-native — `globalThis.fetch` on Node 18+ (zero-
// overhead passthrough), a polyfill on Node 14–17 (the lib's runtime
// floor). Real network calls happen ONLY when no `fetch` override is
// supplied AND the consumer triggers a method. Proxy / custom-CA
// environments should inject a pre-configured `opts.fetch`: the default
// reads no `HTTP_PROXY` env below Node 24.

import semver from 'semver'
import { fetch as nodeFetchNative } from 'node-fetch-native'
import { parseSri, isEmptyIntegrity } from '../recipe/integrity.ts'
import { resolveRegistry, type ResolveRegistryOptions } from './config.ts'
import type { Packument, PackumentVersion, RegistryAdapter } from './types.ts'

export interface LiveRegistryOptions {
  /** Registry URL. Default: 'https://registry.npmjs.org'. */
  url?:   string
  /** Bearer token for private registries (sent as `Authorization: Bearer <token>`). */
  auth?:  string
  /** Full `Authorization` header value (`Bearer …` / `Basic …`), used verbatim —
   *  takes precedence over `auth`. Supplied by `fromConfig` (`authHeaderFor`) so
   *  Basic-auth registries get the right scheme. */
  authHeader?: string
  /**
   * Fetch implementation. Default: node-fetch-native (native `fetch` on Node
   * 18+, polyfill on 14–17). Pass to mock in tests, or to supply a
   * proxy / custom-CA-configured client.
   */
  fetch?: typeof fetch
}

/** A raw npm advisory object, passed through UNnormalized — audit semantics
 *  (severity, vulnerable ranges, fix selection) are the consumer's, not the
 *  lib's. Shape per the npm bulk-advisory endpoint. */
export type RawAdvisory = Record<string, unknown>

export interface AuditOptions {
  /** Max packages per bulk request (the endpoint is size-limited). Default 250. */
  chunkSize?: number
}

/** `liveRegistry`'s adapter — the read facade (`packument`/`resolve`) plus a
 *  thin RAW bulk-advisory fetch. */
export interface LiveRegistryAdapter extends RegistryAdapter {
  /** POST the `{ name: versions[] }` map to
   *  `<registry>/-/npm/v1/security/advisories/bulk` (chunked by `chunkSize`),
   *  returning the RAW per-package advisories merged across chunks. No
   *  normalization — only packages WITH advisories appear in the result. */
  audit(pkgs: Record<string, string[]>, opts?: AuditOptions): Promise<Record<string, RawAdvisory[]>>
}

const DEFAULT_URL    = 'https://registry.npmjs.org'
const INSTALL_ACCEPT = 'application/vnd.npm.install-v1+json, application/json;q=0.8'

export function liveRegistry(opts: LiveRegistryOptions = {}): LiveRegistryAdapter {
  const baseUrl  = stripTrailingSlash(opts.url ?? DEFAULT_URL)
  const fetchImpl = opts.fetch ?? (nodeFetchNative as typeof fetch)
  if (typeof fetchImpl !== 'function') {
    throw new Error('liveRegistry: opts.fetch is not a function')
  }

  const authHeader = opts.authHeader ?? (opts.auth !== undefined ? `Bearer ${opts.auth}` : undefined)

  return {
    async packument(name) {
      const url = `${baseUrl}/${encodePackageName(name)}`
      const headers: Record<string, string> = {
        accept: INSTALL_ACCEPT,
      }
      if (authHeader !== undefined) headers.authorization = authHeader

      const response = await fetchImpl(url, { headers })
      if (response.status === 404) return undefined
      if (!response.ok) {
        throw new Error(`liveRegistry: ${response.status} ${url}`)
      }

      const body = await response.json()
      return normalisePackument(name, body)
    },

    async resolve(name, range) {
      const packument = await this.packument(name)
      if (packument === undefined) return undefined

      const exact = packument.versions[range]
      if (exact !== undefined) return exact

      const tagged = packument.distTags[range]
      if (tagged !== undefined) return packument.versions[tagged]

      try {
        const versions = Object.keys(packument.versions)
        const resolved = semver.maxSatisfying(versions, range)
        return resolved === null ? undefined : packument.versions[resolved]
      } catch {
        return undefined
      }
    },

    async audit(pkgs, opts = {}) {
      const chunkSize = opts.chunkSize ?? 250
      const url = `${baseUrl}/-/npm/v1/security/advisories/bulk`
      const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' }
      if (authHeader !== undefined) headers.authorization = authHeader

      const names = Object.keys(pkgs)
      const out: Record<string, RawAdvisory[]> = {}
      for (let i = 0; i < names.length; i += chunkSize) {
        const batch: Record<string, string[]> = {}
        for (const name of names.slice(i, i + chunkSize)) batch[name] = pkgs[name]!
        const response = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(batch) })
        if (!response.ok) throw new Error(`liveRegistry.audit: ${response.status} ${url}`)
        const body = (await response.json()) as Record<string, unknown>
        for (const [name, advisories] of Object.entries(body)) {
          (out[name] ??= []).push(...(Array.isArray(advisories) ? (advisories as RawAdvisory[]) : []))
        }
      }
      return out
    },
  }
}

function stripTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url
}

function encodePackageName(name: string): string {
  // Scoped packages encode their slash; unscoped names are URL-safe.
  // E.g. `@scope/pkg` -> `@scope%2Fpkg`.
  return name.startsWith('@') ? name.replace('/', '%2F') : name
}

function normalisePackument(name: string, body: any): Packument {
  const rawDistTags: Record<string, string> = body?.['dist-tags'] ?? body?.distTags ?? {}
  const rawVersions: Record<string, any>   = body?.versions ?? {}

  const versions: Record<string, PackumentVersion> = {}
  for (const [version, raw] of Object.entries(rawVersions)) {
    versions[version] = normaliseVersion(name, version, raw)
  }

  return {
    name:     typeof body?.name === 'string' ? body.name : name,
    distTags: { ...rawDistTags },
    versions,
  }
}

function normaliseVersion(name: string, version: string, raw: any): PackumentVersion {
  const dist: any = raw?.dist ?? {}
  const out: PackumentVersion = {
    name:    typeof raw?.name === 'string' ? raw.name : name,
    version: typeof raw?.version === 'string' ? raw.version : version,
  }
  if (typeof dist.integrity === 'string') {
    const integrity = parseSri(dist.integrity, 'registry')
    if (!isEmptyIntegrity(integrity)) out.integrity = integrity
  }
  if (typeof dist.tarball   === 'string') out.tarball   = dist.tarball
  if (isStringMap(raw?.dependencies))         out.dependencies         = { ...raw.dependencies }
  if (isStringMap(raw?.devDependencies))      out.devDependencies      = { ...raw.devDependencies }
  if (isStringMap(raw?.optionalDependencies)) out.optionalDependencies = { ...raw.optionalDependencies }
  if (isStringMap(raw?.peerDependencies))     out.peerDependencies     = { ...raw.peerDependencies }
  if (isObject(raw?.peerDependenciesMeta))    out.peerDependenciesMeta = { ...raw.peerDependenciesMeta }
  if (isStringMap(raw?.engines))              out.engines              = { ...raw.engines }
  if (Array.isArray(raw?.os))                 out.os                   = raw.os.filter((v: any) => typeof v === 'string')
  if (Array.isArray(raw?.cpu))                out.cpu                  = raw.cpu.filter((v: any) => typeof v === 'string')
  if (Array.isArray(raw?.libc))               out.libc                 = raw.libc.filter((v: any) => typeof v === 'string')
  if (typeof raw?.deprecated === 'string')    out.deprecated           = raw.deprecated
  if (typeof raw?.bin === 'string' || isStringMap(raw?.bin)) {
    out.bin = typeof raw.bin === 'string' ? raw.bin : { ...raw.bin }
  }
  if (Array.isArray(raw?.bundledDependencies)) {
    out.bundledDependencies = raw.bundledDependencies.filter((v: any) => typeof v === 'string')
  } else if (Array.isArray(raw?.bundleDependencies)) {
    // npm registry historically uses both spellings.
    out.bundledDependencies = raw.bundleDependencies.filter((v: any) => typeof v === 'string')
  }
  return out
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringMap(value: unknown): value is Record<string, string> {
  if (!isObject(value)) return false
  for (const v of Object.values(value)) {
    if (typeof v !== 'string') return false
  }
  return true
}

export interface FromConfigOptions extends ResolveRegistryOptions {
  /** Fetch override (proxy / custom-CA / test spy), forwarded to `liveRegistry`. */
  fetch?: typeof fetch
}

// `liveRegistry.fromConfig(cwd, name?)` — named-constructor sugar that resolves
// the registry URL (scope-aware for `name`) and its host-bound token from the PM
// config under `cwd` (§registry/config), then opens a `liveRegistry` against it.
// The token is https-only by construction (`tokenFor` never returns one for a
// plaintext URL), so it is never sent over an insecure channel.
// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace liveRegistry {
  export function fromConfig(cwd: string, name: string | undefined, opts: FromConfigOptions): LiveRegistryAdapter {
    const cfg = resolveRegistry(cwd, opts)
    const url = cfg.registryFor(name ?? '')
    return liveRegistry({ url, authHeader: cfg.authHeaderFor(url), fetch: opts.fetch })
  }
}
