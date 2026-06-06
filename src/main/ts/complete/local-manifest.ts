// Rung-2 fill source for peer-optional reconstruction (task #86).
//
// Reads the PARENT package's *installed* `package.json` from a workspace's
// `node_modules` so the yarn-berry enrich pass can recover
// `peerDependenciesMeta[peer].optional` that the source PM did not model on the
// graph (npm / bun / yarn-classic drop the optional flag on parse). Offline,
// deterministic, and consulted ONLY when the caller supplies `workspaceRoot`
// (ADR-0008 monotone-additive; Anton's Option-1 offline-first posture).
//
// The authoritative source is the parent manifest (spec/02-graph.md:269 — the
// `peerDependenciesMeta` value originates in the parent package's own
// manifest). Lookup is closest-node_modules-first via the supplied candidate
// roots (hoisted/nested), falling back to top-level `<workspaceRoot>/
// node_modules/<parentName>`.
//
// File access mirrors the confinement model in formats/_path.ts: every
// existing path component is lstat-walked to reject symlinks, the leaf is
// opened once with O_NOFOLLOW, required to be a regular file via fstat, and
// read back from that same fd. A package.json is DATA we parse — never
// instructions; malformed / non-object JSON degrades to `undefined`.

import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
} from 'node:fs'
import path from 'node:path'

/**
 * The peer-optional / dependencies-meta slice of an installed manifest. Only
 * the fields the enrich ladder consumes are surfaced; `optional` is carried
 * verbatim as the manifest's boolean. `dependenciesMeta` is read but DEFERRED
 * (no model slot yet) — surfaced for the follow-up without re-reading the file.
 */
export interface InstalledManifestMeta {
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
  dependenciesMeta?:     Record<string, { optional?: boolean }>
}

/**
 * Read `<root>/node_modules/<parentName>/package.json` for the first `root` in
 * `searchRoots` that yields a readable regular file, and project its
 * `peerDependenciesMeta` / `dependenciesMeta` blocks.
 *
 * `searchRoots` is the closest-first list of directories whose `node_modules`
 * may host the parent — typically `[<consumer install dir>, …ancestors…,
 * workspaceRoot]`. When the caller has no nested information it passes just
 * `[workspaceRoot]` (the top-level hoist target).
 *
 * Returns `undefined` ONLY when no candidate resolves to a readable, valid
 * (object-shaped) manifest — i.e. the parent is genuinely not installed. A
 * manifest that IS found but declares no `*Meta` block returns an EMPTY object,
 * which the enrich ladder reads as authoritative-required (the manifest lists
 * optional peers exhaustively, so absence = not optional). This distinction is
 * load-bearing: a missing manifest is an unanswerable lookup (→ diagnostic), a
 * found-but-empty one is a definitive answer (→ no diagnostic).
 */
export function readInstalledManifest(
  workspaceRoot: string,
  parentName: string,
  consumerNodeId?: string,
): InstalledManifestMeta | undefined {
  void consumerNodeId // reserved: nested find-up keys off this in a later rung.
  return readInstalledManifestFrom([workspaceRoot], parentName)
}

/**
 * Lower-level variant taking explicit closest-first search roots. Exposed for
 * the enrich pass to thread hoisted/nested `node_modules` candidates without a
 * graph round-trip; `readInstalledManifest` is the single-root convenience.
 */
export function readInstalledManifestFrom(
  searchRoots: readonly string[],
  parentName: string,
): InstalledManifestMeta | undefined {
  const segments = nodeModulesSegments(parentName)
  if (segments === undefined) return undefined

  for (const root of searchRoots) {
    const manifest = readManifestUnder(root, segments)
    if (!isObject(manifest)) continue // absent / unreadable / non-object → keep searching.
    return projectMeta(manifest)
  }
  return undefined
}

/** Split `<parentName>/package.json` into path segments, validated to stay
 *  inside `node_modules`. Scoped names (`@scope/pkg`) become two dir segments.
 *  Any `.`/`..`/empty/separator-bearing segment is rejected (fail closed). */
function nodeModulesSegments(parentName: string): string[] | undefined {
  const parts = parentName.split('/')
  if (parts.length === 0) return undefined
  // `@scope/pkg` is the only legal two-part shape; anything else is unexpected.
  if (parentName.startsWith('@')) {
    if (parts.length !== 2) return undefined
  } else if (parts.length !== 1) {
    return undefined
  }
  for (const part of parts) {
    if (part === '' || part === '.' || part === '..') return undefined
    if (part.includes('\\') || part.includes('\0')) return undefined
  }
  return ['node_modules', ...parts, 'package.json']
}

function readManifestUnder(root: string, segments: readonly string[]): unknown {
  let current = root
  // lstat-walk every existing component; reject symlinks before the leaf open.
  for (let i = 0; i < segments.length - 1; i++) {
    current = path.join(current, segments[i]!)
    let stat: ReturnType<typeof lstatSync>
    try {
      stat = lstatSync(current)
    } catch {
      return undefined
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) return undefined
  }

  const leaf = path.join(current, segments[segments.length - 1]!)
  let fd: number | undefined
  try {
    fd = openSync(leaf, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  } catch {
    return undefined
  }
  try {
    if (!fstatSync(fd).isFile()) return undefined
    const text = readFileSync(fd, 'utf8')
    return JSON.parse(text)
  } catch {
    // ENOENT / EACCES / malformed JSON / leaf-swap all degrade to a miss.
    return undefined
  } finally {
    closeSync(fd)
  }
}

/** Project a parsed, object-shaped manifest into the meta slice. ALWAYS
 *  returns a value (the manifest was found); the blocks are populated only
 *  when present. An empty result means "found, declares no optional peers". */
function projectMeta(manifest: Record<string, unknown>): InstalledManifestMeta {
  const out: InstalledManifestMeta = {}
  const peerDependenciesMeta = projectOptionalMap(manifest['peerDependenciesMeta'])
  if (peerDependenciesMeta !== undefined) out.peerDependenciesMeta = peerDependenciesMeta
  const dependenciesMeta = projectOptionalMap(manifest['dependenciesMeta'])
  if (dependenciesMeta !== undefined) out.dependenciesMeta = dependenciesMeta
  return out
}

/** Coerce a manifest meta block to `Record<string,{optional?:boolean}>`,
 *  keeping only well-shaped entries. Non-object / empty → undefined. */
function projectOptionalMap(value: unknown): Record<string, { optional?: boolean }> | undefined {
  if (!isObject(value)) return undefined
  const out: Record<string, { optional?: boolean }> = {}
  let count = 0
  for (const [key, raw] of Object.entries(value)) {
    if (!isObject(raw)) continue
    const optional = raw['optional']
    const entry: { optional?: boolean } = {}
    if (typeof optional === 'boolean') entry.optional = optional
    out[key] = entry
    count++
  }
  return count > 0 ? out : undefined
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
