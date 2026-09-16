// Registry routing + host-bound auth, resolved from PM config DETERMINISTICALLY
// and per-ECOSYSTEM, so foreign directives can't be injected.
//
// The caller MUST name the ecosystem; that fixes EXACTLY which files + env
// namespace are read, and in what order — npm/yarn directives never mix:
//
//   ecosystem      files (project → user)        env namespace
//   ───────────────────────────────────────────────────────────
//   npm            .npmrc                          npm_config_*
//   pnpm           .npmrc                          npm_config_*
//   yarn-classic   .yarnrc, .npmrc                 npm_config_*
//   yarn-berry     .yarnrc.yml                     YARN_*        (NO .npmrc)
//   bun            bunfig.toml, .npmrc             npm_config_*
//
// So a planted `.yarnrc.yml` cannot affect an npm/pnpm/yarn-classic resolve, a
// planted `.npmrc` cannot affect a yarn-berry resolve, and an npm project never
// reads `YARN_*` env (nor a berry project `npm_config_*`). Matches the documented
// contract: spec/pm/npm.md "Axis 4" + spec/registry/_common.md §2 auth taxonomy.
//
// SECURITY. Auth stays **bound to the host (+ path prefix)** that declared it (no
// cross-registry leak); `authHeaderFor` is **https-only** (never a credential
// over plaintext). `always-auth` is deliberately NOT honoured — it would send a
// credential beyond its host prefix, against this host-scoped model. Config
// comes from files we don't fully trust: the registry maps use a null prototype
// and reject prototype-pollution keys, and `${VAR}` expansion reads only
// conservatively-named env vars (never eval). Pass `env: {}` to ignore env.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { DEFAULT_NPM_REGISTRY } from '../recipe/resolution.ts'

// The public npm registry — single source of truth in the F3 resolution
// primitive (core). Re-exported under the registry adapter's public name.
export const DEFAULT_REGISTRY = DEFAULT_NPM_REGISTRY

/** Which package-manager config to read — selects the deterministic source set. */
export type RegistryConfigDialect = 'npm' | 'pnpm' | 'yarn-classic' | 'yarn-berry' | 'bun'

/** @internal pre-0.6 name retained for implementation and test compatibility. */
export type Ecosystem = RegistryConfigDialect

/** Registry routing + host-scoped auth resolved from PM config (§registry/config). */
export interface RegistryConfig {
  /** The registry a package would be fetched from — scope-aware
   *  (`@scope:registry` / `npmScopes`), else the default registry. */
  registryFor(pkgName: string): string
  /** The full `Authorization` header value bound to `registryUrl`
   *  (`Bearer <token>` or `Basic <base64>`), longest host/path prefix wins, or
   *  `undefined` — including for any non-`https:` URL (never leak over http). */
  authHeaderFor(registryUrl: string): string | undefined
  /** The BEARER token bound to `registryUrl` (convenience for the modern case);
   *  `undefined` when the bound credential is Basic, absent, or the URL is http. */
  /** @internal pre-0.6 convenience accessor. */
  tokenFor(registryUrl: string): string | undefined
}

/** Registry configuration returned by filesystem discovery. Unlike
 * `registryFor`, this accessor does not replace missing declarations with the
 * public npm default. */
export interface ResolvedRegistryConfig extends RegistryConfig {
  declaredRegistryFor(pkgName: string): string | undefined
}

/** The package-selected registry endpoint plus the credential decisions bound
 *  to that endpoint. Metadata uses the credential selected at `registryUrl`;
 *  artifact redirects may re-evaluate longest-prefix auth, but only while the
 *  target remains inside this route. */
export interface RegistryRoute {
  readonly registryUrl: string
  readonly authHeader: string | undefined
  readonly authHeaderFor: (url: string) => string | undefined
}

/** @internal Bind package routing and credential lookup into one capability. */
export function registryRouteFor(config: RegistryConfig, pkgName: string): RegistryRoute {
  const registryUrl = config.registryFor(pkgName)
  return Object.freeze({
    registryUrl,
    authHeader: config.authHeaderFor(registryUrl),
    authHeaderFor(url: string) {
      return isWithinRegistryRoute(url, registryUrl)
        ? config.authHeaderFor(url)
        : undefined
    },
  })
}

export interface ResolveRegistryOptions {
  /** REQUIRED — the PM config dialect. Fixes which config files + env namespace are
   *  read (and their order); npm and yarn directives never mix. */
  readonly config: RegistryConfigDialect
  /** Explicit default-registry override (highest precedence). */
  readonly registry?: string
  /** Env source for the ecosystem's namespace + `${VAR}` expansion. Default
   *  `process.env`; pass `{}` to ignore env entirely (max determinism). */
  readonly env?: Readonly<Record<string, string | undefined>>
  /** Home dir for the per-user global config. Default `os.homedir()`. */
  readonly home?: string
}

/** @internal pre-0.6 input spelling. */
interface LegacyResolveRegistryOptions extends Omit<ResolveRegistryOptions, 'config'> {
  ecosystem: RegistryConfigDialect
}

type FileKind = 'npmrc' | 'yarnrc-yml' | 'yarnrc' | 'bunfig'
interface SourceProfile {
  files: ReadonlyArray<readonly [FileKind, 'project' | 'user']> // in precedence order
  env: 'npm' | 'yarn' | 'bun'
}
const fileNameOf = (kind: FileKind, scope: 'project' | 'user'): string => {
  if (kind === 'bunfig') return scope === 'project' ? 'bunfig.toml' : '.bunfig.toml'
  return { npmrc: '.npmrc', 'yarnrc-yml': '.yarnrc.yml', yarnrc: '.yarnrc' }[kind]
}
const PROFILES: Record<RegistryConfigDialect, SourceProfile> = {
  npm:            { files: [['npmrc', 'project'], ['npmrc', 'user']], env: 'npm' },
  pnpm:           { files: [['npmrc', 'project'], ['npmrc', 'user']], env: 'npm' },
  'yarn-classic': { files: [['yarnrc', 'project'], ['npmrc', 'project'], ['npmrc', 'user']], env: 'npm' },
  'yarn-berry':   { files: [['yarnrc-yml', 'project'], ['yarnrc-yml', 'user']], env: 'yarn' },
  // Bun loads global/project npmrc, then global/project bunfig, then env/CLI;
  // first-writer order is therefore the reverse of that producer order.
  bun:            { files: [['bunfig', 'project'], ['bunfig', 'user'], ['npmrc', 'project'], ['npmrc', 'user']], env: 'bun' },
}

type AuthScheme = 'Bearer' | 'Basic'
interface AuthEntry { prefix: string; scheme: AuthScheme; value: string } // value = token (Bearer) | base64 (Basic)
interface RegMap { default?: string; scopes: Record<string, string> }
type BasicParts = Map<string, { username?: string; password?: string }> // split Basic, pre-assembly

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const safeSet = (o: Record<string, string>, k: string, v: string): void => {
  if (!UNSAFE_KEYS.has(k) && !(k in o)) o[k] = v // first writer wins (precedence)
}

const attempt = <T>(fn: () => T): T | undefined => { try { return fn() } catch { return undefined } }
const read = (p: string): string | undefined => attempt(() => fs.readFileSync(p, 'utf8'))
const stripQuotes = (v: string): string => v.replace(/^["']/, '').replace(/["']$/, '').trim()
const b64encode = (s: string): string => Buffer.from(s, 'utf8').toString('base64') // Node-14 safe
const b64decode = (s: string): string => Buffer.from(s, 'base64').toString('utf8')

const expandEnv = (v: string, env: Record<string, string | undefined>): string =>
  v.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name) => env[name] ?? '')

const expandBunEnv = (v: string, env: Record<string, string | undefined>): string =>
  expandEnv(v, env).replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, name) => env[name] ?? '')

const hostPathKey = (url: string): string => {
  const u = attempt(() => new URL(url))
  return u ? (u.host + u.pathname).replace(/\/+$/, '') : ''
}
const normalizeRegistry = (url: string): string => {
  const u = attempt(() => new URL(url))
  if (!u || (u.protocol !== 'https:' && u.protocol !== 'http:')) return ''
  return url.replace(/\/+$/, '')
}

/** @internal Protocol + host + path-prefix membership for a registry route. */
export function isWithinRegistryRoute(rawUrl: string, rawRegistryUrl: string): boolean {
  try {
    const url = new URL(rawUrl)
    const registry = new URL(rawRegistryUrl)
    if (url.protocol !== registry.protocol || url.host !== registry.host) return false
    const base = registry.pathname.replace(/\/+$/, '')
    return url.pathname === base || url.pathname.startsWith(`${base}/`)
  } catch {
    return false
  }
}

// ── one `.npmrc` `key=value` (shared by file + `npm_config_*` env) ────────────
function applyNpmrcKey(key: string, value: string, reg: RegMap, tokens: AuthEntry[], basic: BasicParts): void {
  if (value === '') return
  const hostAuth = /^\/\/(.+?)\/?:(_authToken|_auth|username|_password)$/.exec(key)
  if (hostAuth) { pushAuthPart(hostAuth[1]!.replace(/\/+$/, ''), hostAuth[2]!, value, tokens, basic); return }
  if (key === '_authToken') { tokens.push({ prefix: '', scheme: 'Bearer', value }); return }
  if (key === '_auth')      { tokens.push({ prefix: '', scheme: 'Basic',  value }); return }
  if (key === 'registry') { const n = normalizeRegistry(value); if (n !== '' && reg.default === undefined) reg.default = n; return }
  const scoped = /^(@[^:]+):registry$/.exec(key)
  if (scoped) { const n = normalizeRegistry(value); if (n !== '') safeSet(reg.scopes, scoped[1]!, n) }
}
function pushAuthPart(prefix: string, kind: string, value: string, tokens: AuthEntry[], basic: BasicParts): void {
  if (kind === '_authToken') { tokens.push({ prefix, scheme: 'Bearer', value }); return }
  if (kind === '_auth')      { tokens.push({ prefix, scheme: 'Basic',  value }); return }
  const parts = basic.get(prefix) ?? {}
  if (kind === 'username')  parts.username = value
  if (kind === '_password') parts.password = value
  basic.set(prefix, parts)
}
// `username` + base64 `_password` → `Basic base64(user:pass)`.
function drainBasic(basic: BasicParts, tokens: AuthEntry[]): void {
  for (const [prefix, { username, password }] of basic) {
    if (username !== undefined && password !== undefined) {
      tokens.push({ prefix, scheme: 'Basic', value: b64encode(`${username}:${b64decode(password)}`) })
    }
  }
  basic.clear()
}

function parseNpmrc(text: string, reg: RegMap, tokens: AuthEntry[], basic: BasicParts, env: Record<string, string | undefined>): void {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue
    const eq = line.indexOf('=')
    if (eq < 0) continue
    applyNpmrcKey(line.slice(0, eq).trim(), expandEnv(stripQuotes(line.slice(eq + 1)), env), reg, tokens, basic)
  }
  drainBasic(basic, tokens)
}

// `npm_config_<key>=<value>` env vars — the npm env namespace (Axis-4 priority 2).
function parseNpmEnv(reg: RegMap, tokens: AuthEntry[], basic: BasicParts, env: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(env)) {
    if (!k.startsWith('npm_config_') || v === undefined) continue
    applyNpmrcKey(k.slice('npm_config_'.length), expandEnv(v, env), reg, tokens, basic)
  }
  drainBasic(basic, tokens)
}

// Bun's own env registry wins over its config files. Bun also consumes the
// npm_config namespace, so parse it second under the same first-writer rule.
function parseBunEnv(reg: RegMap, tokens: AuthEntry[], basic: BasicParts, env: Record<string, string | undefined>): void {
  const registry = normalizeRegistry(env.BUN_CONFIG_REGISTRY ?? env.NPM_CONFIG_REGISTRY ?? '')
  if (registry !== '' && reg.default === undefined) reg.default = registry
  const token = env.BUN_CONFIG_TOKEN ?? env.NPM_CONFIG_TOKEN
  if (token !== undefined && token !== '') tokens.push({ prefix: '', scheme: 'Bearer', value: token })
  parseNpmEnv(reg, tokens, basic, env)
}

// yarn's env namespace — the common globals.
function parseYarnEnv(reg: RegMap, tokens: AuthEntry[], env: Record<string, string | undefined>): void {
  const r = normalizeRegistry(env.YARN_NPM_REGISTRY_SERVER ?? '')
  if (r !== '' && reg.default === undefined) reg.default = r
  if (env.YARN_NPM_AUTH_TOKEN) tokens.push({ prefix: '', scheme: 'Bearer', value: env.YARN_NPM_AUTH_TOKEN })
  if (env.YARN_NPM_AUTH_IDENT) tokens.push({ prefix: '', scheme: 'Basic', value: b64encode(env.YARN_NPM_AUTH_IDENT) })
}

// ── .yarnrc.yml (minimal YAML subset — only the keys we need) ─────────────────
function parseYarnrcYml(text: string, reg: RegMap, tokens: AuthEntry[], env: Record<string, string | undefined>): void {
  let block: '' | 'npmScopes' | 'npmRegistries' = ''
  let subKey = ''
  // Yarn keys registries as `//host` (or `https://host`); strip protocol + `//`
  // so the prefix matches `hostPathKey` — else the token is silently lost (the
  // real package metadata collision).
  const yarnPrefix = (k: string): string => k.replace(/^(https?:)?\/\//, '').replace(/\/+$/, '')
  for (const raw of text.split(/\r?\n/)) {
    if (raw.trim() === '' || raw.trim().startsWith('#')) continue
    const indent = raw.length - raw.trimStart().length
    const kv = /^("?[^":]+"?)\s*:\s*(.*)$/.exec(raw.trim())
    if (!kv) continue
    const key = stripQuotes(kv[1]!)
    const val = expandEnv(stripQuotes(kv[2]!), env)

    if (indent === 0) {
      block = key === 'npmScopes' || key === 'npmRegistries' ? key : ''
      subKey = ''
      if (key === 'npmRegistryServer' && val !== '') { const n = normalizeRegistry(val); if (n !== '' && reg.default === undefined) reg.default = n }
      if (key === 'npmAuthToken' && val !== '') tokens.push({ prefix: '', scheme: 'Bearer', value: val })
      if (key === 'npmAuthIdent' && val !== '') tokens.push({ prefix: '', scheme: 'Basic', value: b64encode(val) })
      continue
    }
    if (indent === 2 && val === '') { subKey = key; continue }
    if (indent >= 4 && subKey !== '') {
      if (block === 'npmScopes' && key === 'npmRegistryServer' && val !== '') {
        const n = normalizeRegistry(val); if (n !== '') safeSet(reg.scopes, subKey.startsWith('@') ? subKey : `@${subKey}`, n)
      }
      const prefix = block === 'npmRegistries' ? yarnPrefix(subKey) : ''
      if (block === 'npmRegistries' && key === 'npmAuthToken' && val !== '') tokens.push({ prefix, scheme: 'Bearer', value: val })
      if (block === 'npmRegistries' && key === 'npmAuthIdent' && val !== '') tokens.push({ prefix, scheme: 'Basic', value: b64encode(val) })
    }
  }
}

// ── .yarnrc (classic: `registry "url"`) ──────────────────────────────────────
function parseYarnrc(text: string, reg: RegMap): void {
  for (const raw of text.split(/\r?\n/)) {
    const m = /^registry\s+(.+)$/.exec(raw.trim())
    if (m && reg.default === undefined) { const n = normalizeRegistry(stripQuotes(m[1]!)); if (n !== '') reg.default = n }
  }
}

// ── bunfig.toml (minimal TOML subset — registry routing + bearer auth) ───────
function parseBunfig(text: string, reg: RegMap, tokens: AuthEntry[], env: Record<string, string | undefined>): void {
  let section = ''
  const parseValue = (raw: string): { url?: string; token?: string } => {
    const value = expandBunEnv(raw.trim(), env)
    if (!value.startsWith('{')) return { url: stripQuotes(value) }
    const url = /(?:^|[,\s])url\s*=\s*(["'][^"']*["'])/.exec(value)?.[1]
    const token = /(?:^|[,\s])token\s*=\s*(["'][^"']*["'])/.exec(value)?.[1]
    return {
      ...(url === undefined ? {} : { url: stripQuotes(url) }),
      ...(token === undefined ? {} : { token: stripQuotes(token) }),
    }
  }
  const logicalLines: string[] = []
  let pending = ''
  let objectDepth = 0
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '').trim()
    if (line === '' || line.startsWith('#')) continue
    if (pending !== '') {
      pending += ` ${line}`
      objectDepth += (line.match(/{/g) ?? []).length - (line.match(/}/g) ?? []).length
      if (objectDepth <= 0) {
        logicalLines.push(pending)
        pending = ''
      }
      continue
    }
    const rhs = line.slice(line.indexOf('=') + 1).trim()
    if (line.includes('=') && rhs.startsWith('{')) {
      objectDepth = (rhs.match(/{/g) ?? []).length - (rhs.match(/}/g) ?? []).length
      if (objectDepth > 0) {
        pending = line
        continue
      }
    }
    logicalLines.push(line)
  }
  if (pending !== '') logicalLines.push(pending)

  for (const line of logicalLines) {
    const heading = /^\[([^\]]+)]$/.exec(line)
    if (heading !== null) { section = heading[1] ?? ''; continue }
    const kv = /^((?:"[^"]+"|'[^']+'|[^=\s]+))\s*=\s*(.+)$/.exec(line)
    if (kv === null) continue
    let key = stripQuotes(kv[1]!)
    let effectiveSection = section
    if (section === '' && key === 'install.registry') {
      effectiveSection = 'install'
      key = 'registry'
    }
    const value = parseValue(kv[2]!)
    const url = normalizeRegistry(value.url ?? '')
    if (effectiveSection === 'install' && key === 'registry' && url !== '' && reg.default === undefined) {
      reg.default = url
      if (value.token !== undefined) tokens.push({ prefix: hostPathKey(url), scheme: 'Bearer', value: value.token })
    }
    if (effectiveSection === 'install.scopes' && url !== '') {
      const scope = key.startsWith('@') ? key : `@${key}`
      safeSet(reg.scopes, scope, url)
      if (value.token !== undefined) tokens.push({ prefix: hostPathKey(url), scheme: 'Bearer', value: value.token })
    }
  }
}

/**
 * Resolve registry routing + host-bound auth for `opts.ecosystem` under `cwd`
 * (project) + `home` (user) + the ecosystem's env namespace + an explicit
 * override. DETERMINISTIC + per-ecosystem (see the file header): only that
 * ecosystem's sources are read, in a fixed order, first writer wins —
 * `opts.registry` → env → project files → user files.
 */
export function resolveRegistry(cwd: string, opts: ResolveRegistryOptions): ResolvedRegistryConfig
/** @internal pre-0.6 overload. */
export function resolveRegistry(cwd: string, opts: LegacyResolveRegistryOptions): ResolvedRegistryConfig
export function resolveRegistry(
  cwd: string,
  opts: ResolveRegistryOptions | LegacyResolveRegistryOptions,
): ResolvedRegistryConfig {
  const env = opts.env ?? process.env
  const home = opts.home ?? os.homedir()
  const profile = PROFILES['config' in opts ? opts.config : opts.ecosystem]
  const reg: RegMap = { scopes: Object.create(null) as Record<string, string> }
  const tokens: AuthEntry[] = []
  const basic: BasicParts = new Map()

  const flagReg = normalizeRegistry(opts.registry ?? '')
  if (flagReg !== '') reg.default = flagReg

  if (profile.env === 'npm') parseNpmEnv(reg, tokens, basic, env)   // env layer, scoped — no mixing
  else if (profile.env === 'yarn') parseYarnEnv(reg, tokens, env)
  else parseBunEnv(reg, tokens, basic, env)

  for (const [kind, scope] of profile.files) {                      // file layers, fixed order
    const base = scope === 'project'
      ? cwd
      : kind === 'bunfig' && env.XDG_CONFIG_HOME
        ? env.XDG_CONFIG_HOME
        : home
    const text = read(path.join(base, fileNameOf(kind, scope)))
    if (text === undefined) continue
    if (kind === 'npmrc') parseNpmrc(text, reg, tokens, basic, env)
    else if (kind === 'yarnrc-yml') parseYarnrcYml(text, reg, tokens, env)
    else if (kind === 'yarnrc') parseYarnrc(text, reg)
    else parseBunfig(text, reg, tokens, env)
  }

  const defaultRegistry = reg.default ?? DEFAULT_REGISTRY
  const defKey = hostPathKey(defaultRegistry)

  const bestAuthFor = (registryUrl: string): AuthEntry | undefined => {
    const u = attempt(() => new URL(registryUrl))
    if (!u || u.protocol !== 'https:') return undefined            // never leak over http
    const target = hostPathKey(registryUrl)
    if (target === '') return undefined
    let best: AuthEntry | undefined
    for (const t of tokens) {
      const prefix = t.prefix === '' ? defKey : t.prefix           // bare credential → default registry host
      if ((target === prefix || target.startsWith(`${prefix}/`)) &&
          (best === undefined || prefix.length > (best.prefix === '' ? defKey : best.prefix).length)) {
        best = t
      }
    }
    return best
  }

  return {
    declaredRegistryFor(pkgName) {
      if (pkgName.startsWith('@')) {
        const scope = pkgName.slice(0, pkgName.indexOf('/'))
        const scoped = reg.scopes[scope]
        if (scoped !== undefined) return scoped
      }
      return reg.default
    },
    registryFor(pkgName) {
      if (pkgName.startsWith('@')) {
        const scope = pkgName.slice(0, pkgName.indexOf('/'))
        const scoped = reg.scopes[scope]
        if (scoped !== undefined) return scoped
      }
      return defaultRegistry
    },
    authHeaderFor(registryUrl) {
      const a = bestAuthFor(registryUrl)
      return a === undefined ? undefined : `${a.scheme} ${a.value}`
    },
    tokenFor(registryUrl) {
      const a = bestAuthFor(registryUrl)
      return a?.scheme === 'Bearer' ? a.value : undefined
    },
  }
}
