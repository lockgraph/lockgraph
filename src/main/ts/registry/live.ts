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
import { parseSri, isEmptyIntegrity, mergeIntegrity, emptyIntegrity } from '../recipe/integrity.ts'
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
  // Never send a credential over a plaintext channel — matches resolveRegistry's
  // https-only `authHeaderFor`, and defends the raw `liveRegistry({ url, authHeader })`
  // path too (yaf token-attach rule B: "https only").
  const authIsSafe = authHeader !== undefined && baseUrl.startsWith('https:')

  // Fetch the FULL single-version manifest (`<registry>/<pkg>/<version>`, ~1-2 KB) —
  // used to backfill fields the abbreviated (corgi) packument omits, notably `libc`.
  // Returns undefined on any failure so the caller falls back to the corgi version.
  const fetchVersionManifest = async (name: string, version: string): Promise<PackumentVersion | undefined> => {
    const url = `${baseUrl}/${encodePackageName(name)}/${version}`
    const headers: Record<string, string> = { accept: 'application/json' }
    if (authIsSafe) headers.authorization = authHeader
    try {
      const response = await fetchImpl(url, { headers })
      if (!response.ok) return undefined
      return normaliseVersion(name, version, await response.json())
    } catch {
      return undefined
    }
  }

  return {
    async packument(name) {
      const url = `${baseUrl}/${encodePackageName(name)}`
      const headers: Record<string, string> = {
        accept: INSTALL_ACCEPT,
      }
      if (authIsSafe) headers.authorization = authHeader

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

      let version: string | undefined
      if (packument.versions[range] !== undefined) {
        version = range
      } else if (packument.distTags[range] !== undefined) {
        version = packument.distTags[range]
      } else {
        try {
          version = semver.maxSatisfying(Object.keys(packument.versions), range) ?? undefined
        } catch {
          return undefined
        }
      }
      if (version === undefined) return undefined
      const base = packument.versions[version]
      if (base === undefined) return undefined

      // The abbreviated (corgi) packument DROPS `libc`, so a linux platform package
      // would emit `conditions: os=linux & cpu=x64` MISSING `& libc=<glibc|musl>` —
      // which yarn re-adds on `install --immutable` (YN0028; the pijma napi-rs break).
      // Backfill a linux version from the light single-version manifest (full
      // os/cpu/libc). Non-linux platform packages carry no libc, so corgi is already
      // complete for them (verified byte-identical vs pijma for os+cpu-only entries).
      if (base.os?.includes('linux') === true && base.libc === undefined) {
        const full = await fetchVersionManifest(name, version)
        if (full !== undefined) return full
      }
      return base
    },

    // Full single-version manifest — the fields corgi omits (notably `license`).
    // Surfaces the same fetch `resolve` uses for its `libc` backfill.
    manifest(name, version) {
      return fetchVersionManifest(name, version)
    },

    async audit(pkgs, opts = {}) {
      const chunkSize = opts.chunkSize ?? 250
      const url = `${baseUrl}/-/npm/v1/security/advisories/bulk`
      const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' }
      if (authIsSafe) headers.authorization = authHeader

      const names = Object.keys(pkgs)
      const out: Record<string, RawAdvisory[]> = {}
      for (let i = 0; i < names.length; i += chunkSize) {
        const batch: Record<string, string[]> = {}
        for (const name of names.slice(i, i + chunkSize)) batch[name] = pkgs[name]!
        // `redirect: 'manual'` → a 3xx surfaces as a non-ok response and throws below,
        // rather than re-POSTing the package list to a redirect target (yaf rule B:
        // "advisory POST rejects on >=300").
        const response = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(batch), redirect: 'manual' })
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
  // yarn-classic's `resolved#<sha1>` fragment is the TARBALL sha1; npm serves it as
  // `dist.shasum` (a raw 40-hex sha1, distinct from the sha512 SRI in `dist.integrity`).
  // Tag it `url-fragment` so a minted yarn-classic node re-emits the fragment WITHOUT the
  // sha1 leaking into any SRI field (`isTarballOrigin` excludes `url-fragment`).
  if (typeof dist.shasum === 'string' && /^[0-9a-f]{40}$/i.test(dist.shasum)) {
    out.integrity = mergeIntegrity(out.integrity ?? emptyIntegrity(),
      { hashes: [{ algorithm: 'sha1', digest: dist.shasum.toLowerCase(), origin: 'url-fragment' }] })
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
  const license = normaliseLicense(raw)
  if (license !== undefined)                  out.license              = license
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

// Normalise npm's several `license` shapes to a single SPDX-id string (or an
// expression, left verbatim for the constraint layer to treat as unevaluable):
//   - `license: "MIT"`                     → `"MIT"`
//   - `license: { type: "MIT", url }`      → `"MIT"` (deprecated object form)
//   - `licenses: [{ type: "MIT" }, …]`     → `"MIT OR …"` (deprecated array form)
// The abbreviated (corgi) packument omits `license` entirely, so this only
// yields a value on a full single-version manifest.
function normaliseLicense(raw: any): string | undefined {
  const l = raw?.license
  // Empty / whitespace-only license strings are "unknown", not the id "" —
  // return undefined so a constraint treats them as unknown, not a comparable id.
  if (typeof l === 'string') return l.trim() === '' ? undefined : l
  if (isObject(l) && typeof l.type === 'string') return l.type.trim() === '' ? undefined : l.type
  if (Array.isArray(raw?.licenses)) {
    const types = raw.licenses
      .map((e: any) => (typeof e === 'string' ? e : isObject(e) && typeof e.type === 'string' ? e.type : undefined))
      .filter((v: unknown): v is string => typeof v === 'string')
    if (types.length > 0) return types.join(' OR ')
  }
  return undefined
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
