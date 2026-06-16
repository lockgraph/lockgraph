// ADR-0014 §4.F3 — resolution URL canonical recipe (pure-math primitive).
//
// Canonical form on Graph: typed discriminated union (4 cases) held on
// `TarballPayload.resolution`. Each adapter parses its PM-native source
// shape (yarn-berry locator, yarn-classic URL, npm `resolved` URL, pnpm
// `resolution.tarball` URL, etc.) into one of the 4 canonical cases via
// `parse()`. Each adapter projects the canonical form back to its target
// emit shape via the per-target `stringifyFor*` helpers.
//
// Workspace identity is NOT part of F3 canonical: workspace members are
// stored on `Node.workspacePath` (per-format, per ADR-0017) and adapters
// MUST detect workspace shape ahead of time and skip the primitive. The
// full workspace specifier story lives in §4.F4.
//
// The `unknown` case is the escape hatch per ADR-0013: exotic PM-native
// shapes round-trip verbatim through `raw`. Identity comparisons against
// `unknown` MUST NOT collapse two entries by shape alone.
//
// This module is pure-math: no Diagnostic emission, no Graph traversal,
// no Graph-type imports. The `RECIPE_RESOLUTION_UNKNOWN` diagnostic
// emit helper lives in `recipe/diagnostics.ts`.

import { createHash } from 'node:crypto'

// === Canonical type =========================================================

export type HostingProvider = 'github' | 'gitlab' | 'bitbucket'

export type ResolutionCanonical =
  | { type: 'tarball';   url:  string; hostingProvider?: HostingProvider; bind?: string }
  | { type: 'git';       url:  string; sha: string; hostingProvider?: HostingProvider }
  | { type: 'directory'; path: string }
  | { type: 'unknown';   raw:  string }

// === Parse ==================================================================

export interface ParseOptions {
  /** Hint indicating the source PM-native context — disambiguates ambiguous shapes. */
  sourceKind?:
    | 'yarn-berry-locator'   // `<name>@<protocol>:<spec>` form
    | 'yarn-classic-resolved' // URL or codeload
    | 'npm-resolved'          // URL, git+, or file:
    | 'pnpm-tarball'          // `resolution.tarball` URL
  /** Node name — used by yarn-berry `npm:` alias spec to derive the registry URL. */
  name?:         string
}

const HEX40_RE  = /^[0-9a-f]{40}$/i
const SHA_FRAG_RE = /^[0-9a-f]{7,64}$/i

// Recognised registry / tarball hosts (suffix-match). The hostingProvider hint
// is attribution-only — identity drops it for the (name, version) tuple.
const GITHUB_HOST   = 'github.com'
const GITLAB_HOST   = 'gitlab.com'
const BITBUCKET_HOST = 'bitbucket.org'

/**
 * Parse a source-form resolution string → canonical 4-case union.
 * Returns `{ type: 'unknown', raw }` for any shape this primitive cannot
 * canonicalise. Adapters use `emitUnknownResolution` from
 * `recipe/diagnostics.ts` to surface the RECIPE_RESOLUTION_UNKNOWN
 * diagnostic per ADR-0014 §5.
 *
 * Workspace inputs (e.g. yarn-berry `<n>@workspace:<path>`, pnpm `link:`,
 * importer paths) are the caller's responsibility: detect at the adapter
 * boundary and route to `Node.workspacePath` before invoking this
 * primitive — workspace is not part of F3 canonical per ADR-0014 §4.F3.
 */
export function parse(raw: string, options: ParseOptions = {}): ResolutionCanonical {
  // yarn-berry locator: peel `<name>@<protocol>:<spec>` first so subsequent
  // rules see the inner spec. If peel fails (cross-format input where
  // `node.resolution` carries the source format's PM-native shape, not a
  // yarn-berry locator), fall through to URL / generic detection.
  if (options.sourceKind === 'yarn-berry-locator') {
    const peeled = peelYarnBerryLocator(raw)
    if (peeled !== undefined) {
      // Prefer the parsed name (the locator's own name) over `options.name`
      // (the entry-key spec[0] name) for URL derivation. yarn-berry collapses
      // npm-aliased entries onto the dominant target name, so `options.name`
      // may carry the alias name while `peeled.name` carries the target name
      // — the target name is what feeds the registry URL.
      return parseInner(peeled.protocol, peeled.spec, raw, { ...options, name: peeled.name })
    }
    // fall through to URL / file: detection below
  }

  // file: prefix → directory (npm / pnpm non-workspace).
  if (raw.startsWith('file:')) {
    return { type: 'directory', path: normaliseDirectoryPath(raw.slice('file:'.length)) }
  }

  return parseUrlOrFallback(raw)
}

// Inner dispatch for yarn-berry locators (`<protocol>:<spec>` peeled).
function parseInner(protocol: string, spec: string, raw: string, options: ParseOptions): ResolutionCanonical {
  switch (protocol) {
    case 'npm': {
      // yarn-berry `<n>@npm:<ver>` — registry tarball; URL derived by
      // convention from the npmjs default registry per ADR-0014 §4.F3
      // (host is attribution; identity drops the host for the
      // (name, version) tuple). `npm:<n2>@<ver>` (alias) collapses to
      // `<n2>` as the underlying name.
      //
      // BIND MODIFIERS (ADR-0032 §"+src=" extension): a yarn-berry npm
      // locator may carry a `::<key>=<value>&…` bind suffix that pins the
      // exact fetch (private-registry mirror archives, integrity pins, etc.).
      // The bind MUST NOT sweep into the derived version (it would corrupt
      // the URL) and MUST fork identity — otherwise two entries differing
      // ONLY by the bind collapse onto one NodeId (#2b loss).
      const bindIdx     = spec.indexOf('::')
      const version     = bindIdx >= 0 ? spec.slice(0, bindIdx) : spec
      const bindSuffix = bindIdx >= 0 ? spec.slice(bindIdx + 2) : undefined
      if (bindSuffix !== undefined) {
        // `__archiveUrl=<enc>` — the bind names the ACTUAL fetch source (a
        // private-registry mirror archive). The decoded archive URL IS the
        // canonical tarball url: a non-registry host that naturally forks
        // `+src` with zero new machinery. Other binds (`version=`, `hash=`,
        // …) keep the registry url but ride the `bind` field, which the
        // source discriminator folds in so a registry-hosted tarball WITH a
        // bind is non-bare.
        const archiveUrl = archiveUrlOfBind(bindSuffix)
        if (archiveUrl !== undefined) {
          return { type: 'tarball', url: archiveUrl }
        }
        return { type: 'tarball', url: deriveRegistryUrl(options.name, version), bind: bindSuffix }
      }
      return { type: 'tarball', url: deriveRegistryUrl(options.name, version) }
    }
    case 'portal':
      return { type: 'directory', path: normaliseDirectoryPath(spec) }
    case 'file':
      return { type: 'directory', path: normaliseDirectoryPath(spec) }
    case 'patch':
      // patch: locators are F2's domain — the underlying base resolution is
      // recoverable from the URL fragment but is adapter-side scope. F3
      // preserves the raw locator verbatim.
      return { type: 'unknown', raw }
    case 'workspace':
    case 'link':
      // Workspace shapes are NOT part of F3 canonical per ADR-0014 §4.F3 —
      // adapters MUST detect and route to `Node.workspacePath` before
      // invoking this primitive. Returning `unknown` is a defensive
      // fall-through: adapters that respect the contract never reach here.
      return { type: 'unknown', raw }
    default:
      // protocol is a URL scheme (https, http, git+ssh, etc.) — reassemble +
      // delegate to URL parser.
      return parseUrlOrFallback(`${protocol}:${spec}`)
  }
}

// Derive the npmjs-default registry URL for a yarn-berry `npm:` locator.
// Aliased form (`<n>@npm:<n2>@<ver>`) projects onto `<n2>` as the underlying
// name; non-aliased (`<n>@npm:<ver>`) uses `name` directly.
function deriveRegistryUrl(name: string | undefined, spec: string): string {
  const aliasAt = spec.lastIndexOf('@')
  if (aliasAt > 0) {
    const aliasName    = spec.slice(0, aliasAt)
    const aliasVersion = spec.slice(aliasAt + 1)
    if (looksLikeNpmName(aliasName) && /^[\dvV]/.test(aliasVersion)) {
      return registryUrlOf(aliasName, aliasVersion)
    }
  }
  const ver = spec
  return registryUrlOf(name ?? '', ver)
}

function looksLikeNpmName(s: string): boolean {
  return /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i.test(s)
}

// Extract `__archiveUrl=<percent-encoded-url>` from a yarn-berry `::` bind
// suffix and decode it to the literal fetch URL. The suffix is an
// `&`-joined list of `key=value` pairs (yarn's qualifier grammar); we pick
// the `__archiveUrl` pair. Returns undefined when the bind carries no
// archive URL or the value fails to decode.
function archiveUrlOfBind(bindSuffix: string): string | undefined {
  for (const pair of bindSuffix.split('&')) {
    const eq = pair.indexOf('=')
    if (eq < 0) continue
    if (pair.slice(0, eq) !== '__archiveUrl') continue
    const enc = pair.slice(eq + 1)
    try {
      return decodeURIComponent(enc)
    } catch {
      return undefined
    }
  }
  return undefined
}

function registryUrlOf(name: string, version: string): string {
  // npmjs URL convention: for `@scope/pkg`, the basename in the tail is `pkg`
  // (not `@scope/pkg`); the scope appears only in the path segment.
  const tail = name.startsWith('@') ? name.split('/').slice(1).join('/') : name
  return `https://registry.npmjs.org/${name}/-/${tail}-${version}.tgz`
}

function parseUrlOrFallback(raw: string): ResolutionCanonical {
  // git+<scheme>://...#<sha>
  if (raw.startsWith('git+')) {
    const stripped = raw.slice('git+'.length)
    const fragIdx = stripped.indexOf('#')
    if (fragIdx >= 0) {
      const url = stripped.slice(0, fragIdx)
      const fragment = stripped.slice(fragIdx + 1)
      const sha = extractShaFromFragment(fragment)
      if (sha !== undefined) {
        const hp = hostingProviderOf(url)
        const can: ResolutionCanonical = { type: 'git', url, sha }
        if (hp !== undefined) can.hostingProvider = hp
        return can
      }
    }
    return { type: 'unknown', raw }
  }

  // bare git@host:owner/repo.git#sha, git://host/..., or ssh://git@host/...
  // — surface as git canonical when the fragment is a recognisable sha.
  if (raw.startsWith('git://') || raw.startsWith('git@') || raw.startsWith('ssh://')) {
    const fragIdx = raw.indexOf('#')
    if (fragIdx >= 0) {
      const url = raw.slice(0, fragIdx)
      const sha = extractShaFromFragment(raw.slice(fragIdx + 1))
      if (sha !== undefined) {
        const hp = hostingProviderOf(url)
        const can: ResolutionCanonical = { type: 'git', url, sha }
        if (hp !== undefined) can.hostingProvider = hp
        return can
      }
    }
    return { type: 'unknown', raw }
  }

  if (raw.startsWith('http://') || raw.startsWith('https://')) {
    // codeload-tarball form — canonicalise to upstream git url + sha.
    // Handles both bare `<codeload-url>` AND fragmented `<codeload-url>#commit=<sha>`
    // (yarn-berry-style fragment) by stripping the fragment before the codeload
    // pattern match. The URL-path sha is the canonical identity for the codeload
    // form; an explicit `#commit=<sha2>` fragment overrides only when present
    // (matches yarn-berry's `commit=` semantic).
    const codeload = parseCodeloadTarball(raw)
    if (codeload !== undefined) return codeload

    // generic URL — registry tarball or other direct download.
    const fragIdx = raw.indexOf('#')
    if (fragIdx >= 0) {
      // sha1-fragment yarn-classic style: strip the fragment from canonical
      // url (the sha1 is forensic attribution on the yarn-classic sidecar).
      const url = raw.slice(0, fragIdx)
      const frag = raw.slice(fragIdx + 1)
      if (HEX40_RE.test(frag) && /\.tgz$|\.tar\.gz$/i.test(url)) {
        return { type: 'tarball', url }
      }
      // commit-ish fragment on https://<host>/<owner>/<repo>... → git case.
      // Accepts both bare hex (`#abcdef…`) and yarn-berry-style `commit=<sha>`.
      if (/^https:\/\/[^/]+\/[^/]+\/[^/]+/.test(url)) {
        const sha = extractShaFromFragment(frag)
        if (sha !== undefined) {
          const hp = hostingProviderOf(url)
          const can: ResolutionCanonical = { type: 'git', url, sha }
          if (hp !== undefined) can.hostingProvider = hp
          return can
        }
      }
    }
    const hp = hostingProviderOf(raw)
    const can: ResolutionCanonical = { type: 'tarball', url: raw }
    if (hp !== undefined) can.hostingProvider = hp
    return can
  }

  return { type: 'unknown', raw }
}

// `https://codeload.<host>/<o>/<r>/tar.gz/<sha>[#commit=<sha2>]` →
// `{ type: 'git', url: 'https://<host>/<o>/<r>.git', sha, hostingProvider }`.
// Single code path for bare + `#commit=` forms: strip any fragment, match the
// codeload path pattern, lift to upstream URL. When a `#commit=<sha2>` fragment
// is present the fragment sha takes precedence (yarn-berry locator intent);
// otherwise the URL-path sha is the canonical.
function parseCodeloadTarball(url: string): ResolutionCanonical | undefined {
  const fragIdx = url.indexOf('#')
  const bareUrl = fragIdx >= 0 ? url.slice(0, fragIdx) : url
  const match = bareUrl.match(/^https:\/\/codeload\.([^/]+)\/([^/]+)\/([^/]+)\/tar\.gz\/([0-9a-fA-F]+)$/)
  if (match === null) return undefined
  const [, host, owner, repo, pathSha] = match
  if (host === undefined || owner === undefined || repo === undefined || pathSha === undefined) return undefined
  let sha = pathSha
  if (fragIdx >= 0) {
    const fragSha = extractShaFromFragment(url.slice(fragIdx + 1))
    if (fragSha !== undefined) sha = fragSha
  }
  const upstreamHost = codeloadUpstreamHost(host)
  const upstreamUrl = `https://${upstreamHost}/${owner}/${repo}.git`
  const hp = hostingProviderOfHost(upstreamHost)
  const can: ResolutionCanonical = { type: 'git', url: upstreamUrl, sha }
  if (hp !== undefined) can.hostingProvider = hp
  return can
}

function codeloadUpstreamHost(codeloadHost: string): string {
  // codeload.github.com → github.com. Pattern is generic for hosting providers
  // that mirror codeload subdomains.
  if (codeloadHost.startsWith('codeload.')) return codeloadHost.slice('codeload.'.length)
  return codeloadHost
}

function extractShaFromFragment(fragment: string): string | undefined {
  // yarn-berry `#commit=<sha>` form
  if (fragment.startsWith('commit=')) {
    const sha = fragment.slice('commit='.length)
    return SHA_FRAG_RE.test(sha) ? sha : undefined
  }
  return SHA_FRAG_RE.test(fragment) ? fragment : undefined
}

function hostingProviderOf(url: string): HostingProvider | undefined {
  // URL may be https://host/..., git@host:..., git://host/...
  let host: string | undefined
  if (url.startsWith('https://') || url.startsWith('http://') || url.startsWith('git://')) {
    const noScheme = url.replace(/^[a-z+]+:\/\//, '')
    host = noScheme.split('/')[0]
  } else if (url.startsWith('git@')) {
    host = url.slice('git@'.length).split(':')[0]
  } else if (url.startsWith('ssh://')) {
    const noScheme = url.slice('ssh://'.length)
    const afterUser = noScheme.includes('@') ? noScheme.split('@').slice(1).join('@') : noScheme
    host = afterUser.split('/')[0]?.split(':')[0]
  }
  return host === undefined ? undefined : hostingProviderOfHost(host)
}

function hostingProviderOfHost(host: string): HostingProvider | undefined {
  if (host === GITHUB_HOST    || host.endsWith(`.${GITHUB_HOST}`))    return 'github'
  if (host === GITLAB_HOST    || host.endsWith(`.${GITLAB_HOST}`))    return 'gitlab'
  if (host === BITBUCKET_HOST || host.endsWith(`.${BITBUCKET_HOST}`)) return 'bitbucket'
  return undefined
}

// `<name>@<protocol>:<spec>` → { name, protocol, spec }. Scoped names retain
// leading `@`. Returns undefined when the locator does not match.
//
// `expectedName` is a SOFT match: when it disagrees with the parsed name we
// still peel (yarn-berry collapses npm-aliased entries onto the dominant
// target name, so the entry-key spec[0] can carry a different name than the
// `resolution:` field — e.g. spec[0]=`string-width-cjs@npm:string-width@…`
// but resolution=`string-width@npm:4.2.3`). The caller can use the parsed
// name for URL derivation in that case.
function peelYarnBerryLocator(raw: string): { name: string; protocol: string; spec: string } | undefined {
  // Find the FIRST `@` at depth 0 (and position > 0 to skip leading scope
  // marker) separating name from `<protocol>:<spec>`. Yarn-berry alias
  // locators like `<n>@npm:<other>@<ver>` carry additional `@` inside the
  // spec — those must NOT be confused with the name/protocol separator.
  let depth   = 0
  let firstAt = -1
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]
    if (c === '(') depth++
    else if (c === ')') depth--
    else if (c === '@' && depth === 0 && i > 0) {
      firstAt = i
      break
    }
  }
  if (firstAt < 0) return undefined
  const name      = raw.slice(0, firstAt)
  const after     = raw.slice(firstAt + 1)
  const colonIdx = after.indexOf(':')
  if (colonIdx <= 0) return undefined
  return { name, protocol: after.slice(0, colonIdx), spec: after.slice(colonIdx + 1) }
}

// Normalise a directory path for `file:` / `portal:` dirs.
function normaliseDirectoryPath(raw: string): string {
  const p = raw.trim()
  // strip a leading `./` only when followed by more path; bare `./` becomes `.`
  if (p === './') return '.'
  return p
}

// === Predicates =============================================================

export function isCanonical(value: unknown): value is ResolutionCanonical {
  if (value === null || typeof value !== 'object') return false
  const v = value as { type?: unknown }
  switch (v.type) {
    case 'tarball':
      return typeof (value as { url?: unknown }).url === 'string'
    case 'git':
      return typeof (value as { url?: unknown }).url === 'string'
        && typeof (value as { sha?: unknown }).sha === 'string'
    case 'directory':
      return typeof (value as { path?: unknown }).path === 'string'
    case 'unknown':
      return typeof (value as { raw?: unknown }).raw === 'string'
    default:
      return false
  }
}

export function isUnknown(can: ResolutionCanonical): can is { type: 'unknown'; raw: string } {
  return can.type === 'unknown'
}

// === Source discriminator (ADR-0032 §"+src= slot") ==========================

// The default public npm-registry hosts. A `tarball` canonical pointing at one
// of these is the content-addressed registry artefact for `(name, version)` —
// the same bytes for everyone — so it is the BARE majority that carries NO
// `+src=` slot (ZERO registry blast radius). Both are the SAME default registry:
// `registry.npmjs.org` is npm's; `registry.yarnpkg.com` is yarn's CDN mirror of
// it (yarn-classic's default `resolved` host) — neither is a distinct source.
// Any OTHER tarball host (private registry, GitHub release `.tgz`, a CDN, a
// codeload that did not canonicalise to git) can legitimately serve different
// code under the same `name@version`, so it IS discriminated.
const REGISTRY_HOSTS: ReadonlySet<string> = new Set([
  'registry.npmjs.org',
  'registry.yarnpkg.com',
])

function hostOfTarballUrl(url: string): string | undefined {
  // Tarball canonicals are always `http(s)://<host>/…` (deriveRegistryUrl and
  // parseUrlOrFallback only mint http(s) tarball URLs). Peel the host; a shape
  // we cannot peel is treated as host-less (the caller slots it as a non-
  // registry tarball so two unpeelable URLs never silently collapse).
  if (!url.startsWith('http://') && !url.startsWith('https://')) return undefined
  const noScheme = url.replace(/^https?:\/\//, '')
  const host = noScheme.split('/')[0]
  return host === undefined || host.length === 0 ? undefined : host
}

/**
 * ADR-0032 — the `+src=` NodeId/TarballKey slot value for a node's
 * `ResolutionCanonical`, or `undefined` when the node is a default-registry
 * tarball (the ~99% majority, which stays BARE so registry NodeIds never
 * change). The slot disambiguates the #2b collapse: the same `name@version`
 * from DIFFERENT non-registry sources (a registry copy AND a git fork; two
 * private-registry hosts) would otherwise share ONE NodeId and lose data.
 *
 * The value is the 16-hex prefix of `sha256` over the F3-canonical source
 * string (NUL-separated), populated ONLY for the WELL-DEFINED non-registry
 * source classes:
 *
 *   - `git`                       → `git\0<url>\0<sha>`        (slot)
 *   - `tarball` (non-registry)    → `tarball\0<host>`         (slot)
 *   - `tarball` (with `::` bind)  → `tarball\0<host>\0bind=…` (slot)
 *   - `tarball` (default registry)→ undefined                 (bare)
 *   - `directory`                 → undefined                 (bare)
 *   - `unknown`                   → undefined                 (bare)
 *
 * The `tarball` BIND slot (ADR-0032 §"+src=" extension) forks two entries that
 * share the same `(name, version, host)` but differ by a yarn-berry `::` bind
 * modifier (`version=`, `hash=`, …). The `__archiveUrl=` bind is NOT carried
 * here — it canonicalises to its non-registry archive host directly, which the
 * non-registry tarball slot already forks.
 *
 * `directory` and `unknown` stay BARE deliberately (ADR-0032 §"bare classes"):
 *
 *   - `directory` — its `path` is a consumer-relative filesystem string with no
 *     well-defined cross-PM canonical source identity; the adapters that CAN
 *     collide on a directory locator already disambiguate via the sentinel-patch
 *     `::locator=` slot (`_yarn-berry-core.isLocalLocatorDisambiguatedResolution`).
 *   - `unknown` — the F3 escape hatch (ADR-0013): its `raw` is a PM-native shape
 *     the primitive could NOT canonicalise, so it has NO well-defined source
 *     string. Folding it into identity is also UNSAFE for round-trips: a lossy
 *     cross-PM emit can turn a registry package's clean `tarball` canonical into
 *     an `unknown` raw on re-parse (e.g. a yarn-berry `name@npm:ver` locator
 *     written verbatim into npm's `resolved:` field, which `npm-resolved` parse
 *     cannot peel), so an `unknown`-derived slot would appear on ONE side of a
 *     convert but not the other and spuriously fork the node. A `patch:` locator
 *     also canonicalises to `unknown` — its identity is already F2's `+patch=`.
 *
 * The `hostingProvider` attribution hint is NEVER folded into the source string
 * — identity drops it, exactly as the canonical URL/sha already do (two git refs
 * to the same url+sha are one node regardless of which provider mirror recorded
 * it).
 */
export function sourceDiscriminatorOf(resolution: ResolutionCanonical): string | undefined {
  const sourceString = canonicalSourceStringOf(resolution)
  return sourceString === undefined ? undefined : sha256Prefix16(sourceString)
}

// The NUL-separated F3-canonical source string for the discriminated classes
// (git, non-registry tarball), or `undefined` for the bare classes (default-
// registry tarball, directory, unknown). Split out from the hash so the mapping
// is independently testable and the ADR can cite it.
function canonicalSourceStringOf(resolution: ResolutionCanonical): string | undefined {
  switch (resolution.type) {
    case 'git':
      return `git\0${resolution.url}\0${resolution.sha}`
    case 'tarball': {
      const host = hostOfTarballUrl(resolution.url)
      // A `::` bind (e.g. `version=`, `hash=`) pins a distinct fetch under the
      // SAME (name, version, host), so it MUST fork identity even for a default
      // registry host — append it to the source string so the tarball is
      // NON-bare. Without a bind, a default-registry tarball stays bare
      // (undefined) exactly as before: the 99% path is untouched.
      if (resolution.bind !== undefined) {
        return `tarball\0${host ?? resolution.url}\0bind=${resolution.bind}`
      }
      return host !== undefined && REGISTRY_HOSTS.has(host) ? undefined : `tarball\0${host ?? resolution.url}`
    }
    case 'directory':
    case 'unknown':
      return undefined
  }
}

function sha256Prefix16(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex').slice(0, 16)
}

// === Per-target stringify ===================================================

export interface YarnBerryStringifyHints {
  name:      string
  version:   string
  /** Prefer the codeload-tarball form for github git refs. */
  preferGithubCodeload?: boolean
}

/**
 * Project canonical → yarn-berry locator string `<n>@<protocol>:<spec>` per
 * ADR-0014 §4.F3 stringify table. The result is suitable for the entry's
 * `resolution:` field. Workspace members are emitted via the adapter's own
 * `Node.workspacePath` projection, not through this primitive.
 */
export function stringifyForYarnBerry(can: ResolutionCanonical, hints: YarnBerryStringifyHints): string {
  switch (can.type) {
    case 'tarball':
      return `${hints.name}@npm:${hints.version}`
    case 'git':
      if (hints.preferGithubCodeload === true && can.hostingProvider === 'github') {
        const codeload = codeloadOfGitUrl(can.url, can.sha)
        if (codeload !== undefined) return `${hints.name}@${codeload}`
      }
      return `${hints.name}@${can.url}#commit=${can.sha}`
    case 'directory':
      return `${hints.name}@portal:${can.path}`
    case 'unknown':
      // Re-emit raw verbatim. If raw looks already-locator-shaped, pass
      // through; otherwise prefix with `<name>@` (defensive — shouldn't
      // happen on round-trip since yarn-berry parse keeps the full locator).
      return can.raw
  }
}

export interface YarnClassicStringifyHints {
  /** Forensic sha1 fragment from yarn-classic sidecar attribution. */
  sha1Fragment?: string
}

/**
 * Project canonical → yarn-classic `resolved` URL per ADR-0014 §4.F3.
 * Workspace members emit via sentinel-version entries; not this path.
 */
export function stringifyForYarnClassic(can: ResolutionCanonical, hints: YarnClassicStringifyHints = {}): string | undefined {
  switch (can.type) {
    case 'tarball':
      return hints.sha1Fragment !== undefined ? `${can.url}#${hints.sha1Fragment}` : can.url
    case 'git':
      // yarn-classic prefers codeload-tarball for github; otherwise bare
      // `<url>#<sha>` (no `git+` prefix).
      if (can.hostingProvider === 'github') {
        const codeload = codeloadOfGitUrl(can.url, can.sha)
        if (codeload !== undefined) return codeload
      }
      return `${can.url}#${can.sha}`
    case 'directory':
      return `file:./${stripLeadingDotSlash(can.path)}`
    case 'unknown':
      return can.raw
  }
}

/**
 * Project canonical → npm `resolved` URL per ADR-0014 §4.F3.
 * Workspace members emit via link entries through packages/<p>; not this path.
 */
export function stringifyForNpm(can: ResolutionCanonical): string | undefined {
  switch (can.type) {
    case 'tarball':
      return can.url
    case 'git':
      // npm re-prefixes `git+` on emit.
      return `git+${can.url}#${can.sha}`
    case 'directory':
      return `file:${can.path}`
    case 'unknown':
      return can.raw
  }
}

export interface PnpmStringifyOutput {
  /** `resolution.tarball` field value (URL form). */
  tarball?:   string
  /** `resolution.directory` field value (pnpm `file:` shape). */
  directory?: string
  /** Verbatim attribution key/value pairs for unknown shapes. */
  extra?:     Record<string, string>
}

/**
 * Project canonical → pnpm `resolution:` block fields per ADR-0014 §4.F3.
 * Workspace members emit via `importers/<p>:` blocks; not this path.
 */
export function stringifyForPnpm(can: ResolutionCanonical): PnpmStringifyOutput | undefined {
  switch (can.type) {
    case 'tarball':
      return { tarball: can.url }
    case 'git':
      // pnpm uses codeload-tarball form for github when materialised; otherwise
      // emit bare URL with sha fragment.
      if (can.hostingProvider === 'github') {
        const codeload = codeloadOfGitUrl(can.url, can.sha)
        if (codeload !== undefined) return { tarball: codeload }
      }
      return { tarball: `${can.url}#${can.sha}` }
    case 'directory':
      return { directory: can.path }
    case 'unknown':
      return { extra: { tarball: can.raw } }
  }
}

function codeloadOfGitUrl(gitUrl: string, sha: string): string | undefined {
  // `https://github.com/<o>/<r>.git` → `https://codeload.github.com/<o>/<r>/tar.gz/<sha>`
  const m = gitUrl.match(/^https:\/\/([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?$/)
  if (m === null) return undefined
  const [, host, owner, repo] = m
  if (host === undefined || owner === undefined || repo === undefined) return undefined
  return `https://codeload.${host}/${owner}/${repo}/tar.gz/${sha}`
}

function stripLeadingDotSlash(path: string): string {
  return path.startsWith('./') ? path.slice(2) : path
}
