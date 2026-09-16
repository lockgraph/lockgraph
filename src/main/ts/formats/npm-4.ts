// npm-4 adapter — npm 12 opt-in `package-lock.json` lockfileVersion 4.
//
// npm 12 still writes v3 by default. A native `npm patch` operation,
// `packageExtensions`, or `.npm-extension` activates v4. The base layout is the
// same packages-only install-path map as npm-3; v4 adds:
//
//   - `packages[<installed>].patched = { integrity, path }`
//   - `packages[""].packageExtensionsHash`
//   - `packages[""].npmExtensionHash`
//   - per-entry `packageExtensionsApplied` / `npmExtensionApplied`
//
// Patch identity on Graph follows F2/F5 (normalised patch bytes), while
// npm's native `patched.integrity` hashes the raw file bytes. The native carrier
// therefore remains in the npm sidecar for same-format replay and is never
// reconstructed from the canonical hash alone.

import { createHash } from 'node:crypto'
import type { Diagnostic, Graph } from '../graph.ts'
import { LockfileError } from '../api/errors.ts'
import { hashAndNormalizeBytes, sentinelHashOf } from '../recipe/patch.ts'
import { readWorkspaceFileBytes } from './_path.ts'
import {
  checkFamily,
  enrichFamily,
  getFlatSidecar,
  optimizeFamily,
  parseFamily,
  stringifyFamily,
  type NpmEntry,
  type NpmFamilyConfig,
  type NpmFamilyEnrichOptions,
  type NpmFamilyOptimizeOptions,
  type NpmFamilyParseOptions,
  type NpmFamilyStringifyOptions,
  type NpmFlatSidecar,
  type NpmRootMeta,
} from './_npm-core.ts'
import type { NpmFamilyHooks } from './_npm-flat-types.ts'

const SHA512_SRI = /^sha512-([A-Za-z0-9+/]+={0,2})$/

function nativeSha512Digest(raw: unknown, subject: string): string {
  if (typeof raw !== 'string') {
    throw parseFailed(`${subject} must be a sha512 SRI string`)
  }
  const match = SHA512_SRI.exec(raw)
  if (match === null) {
    throw parseFailed(`${subject} must contain exactly one sha512 SRI`)
  }
  const bytes = Buffer.from(match[1]!, 'base64')
  if (bytes.length !== 64 || bytes.toString('base64') !== match[1]) {
    throw parseFailed(`${subject} carries malformed sha512 base64`)
  }
  return bytes.toString('hex')
}

function parseFailed(message: string): LockfileError {
  return new LockfileError({
    code: 'PARSE_FAILED',
    message: `npm-4 adapter: ${message}`,
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function cloneJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneJson)
  if (!isRecord(value)) return value
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneJson(item)]))
}

function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJsonValue)
  if (!isRecord(value)) return value
  return Object.fromEntries(
    Object.keys(value).sort().map(key => [key, stableJsonValue(value[key])]),
  )
}

function jsonValuesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(stableJsonValue(left)) === JSON.stringify(stableJsonValue(right))
}

function captureApplied(
  value: unknown,
  field: 'packageExtensionsApplied' | 'npmExtensionApplied',
  sidecar: NpmFlatSidecar,
  path: string,
): void {
  if (value === undefined) return
  if (!isRecord(value)) {
    throw parseFailed(`packages[${JSON.stringify(path)}].${field} must be an object`)
  }
  if (sidecar[field] !== undefined && !jsonValuesEqual(sidecar[field], value)) {
    throw parseFailed(
      `multiple install paths for one node disagree on ${field} at ${JSON.stringify(path)}`,
    )
  }
  sidecar[field] = cloneJson(value)
}

function captureRootHash(
  value: unknown,
  field: 'packageExtensionsHash' | 'npmExtensionHash',
  rootMeta: NpmRootMeta,
): void {
  if (value === undefined) return
  nativeSha512Digest(value, `packages[""].${field}`)
  rootMeta[field] = value as string
}

function patchedCarrierOf(entry: NpmEntry, path: string): Readonly<{
  integrity: string
  path: string
  digest: string
}> | undefined {
  const patched = entry.patched
  if (patched === undefined) return undefined
  if (!isRecord(patched)) {
    throw parseFailed(`packages[${JSON.stringify(path)}].patched must be an object`)
  }
  const keys = Object.keys(patched).sort()
  if (keys.length !== 2 || keys[0] !== 'integrity' || keys[1] !== 'path') {
    throw parseFailed(
      `packages[${JSON.stringify(path)}].patched must contain exactly integrity and path`,
    )
  }
  if (typeof patched.path !== 'string' || patched.path.length === 0) {
    throw parseFailed(`packages[${JSON.stringify(path)}].patched.path must be a non-empty string`)
  }
  const digest = nativeSha512Digest(
    patched.integrity,
    `packages[${JSON.stringify(path)}].patched.integrity`,
  )
  return {
    integrity: patched.integrity as string,
    path: patched.path,
    digest,
  }
}

const NPM4_HOOKS: NpmFamilyHooks = {
  resolvePatch({ path, name, version, entry, options }) {
    const carrier = patchedCarrierOf(entry, path)
    if (carrier === undefined) return undefined

    const bytes = options.workspaceRoot === undefined
      ? undefined
      : readWorkspaceFileBytes(
          options.workspaceRoot,
          carrier.path,
          `npm-4:${name}@${version}:${carrier.path}`,
        )
    if (bytes === undefined) {
      return {
        patch: sentinelHashOf(
          `npm-4:${name}@${version}:${carrier.path}:${carrier.integrity}`,
        ),
        diagnostic: {
          code: 'NPM_V4_PATCH_UNRESOLVED',
          subject: `${name}@${version}`,
          severity: 'warning',
          message: options.workspaceRoot === undefined
            ? 'workspaceRoot is unavailable; preserving native patch carrier with an unresolved canonical identity'
            : `patch file ${JSON.stringify(carrier.path)} is unavailable; preserving native carrier with an unresolved canonical identity`,
        },
      }
    }

    const rawDigest = createHash('sha512').update(bytes).digest('hex')
    const canonical = hashAndNormalizeBytes(bytes)
    return {
      patch: canonical.hash,
      ...(canonical.normalised ? { normalised: true } : {}),
      ...(rawDigest === carrier.digest ? {} : {
        diagnostic: {
          code: 'NPM_V4_PATCH_INTEGRITY_MISMATCH',
          subject: `${name}@${version}`,
          severity: 'warning',
          message:
            `patch bytes for ${name}@${version} do not match ${carrier.integrity}; `
            + 'computed canonical identity from the available bytes and preserved the native SRI verbatim',
        },
      }),
    }
  },

  captureNodeSidecar({ path, patch, entry, nodeSidecar }) {
    const carrier = patchedCarrierOf(entry, path)
    if (carrier !== undefined) {
      if (patch === undefined) {
        throw parseFailed(`packages[${JSON.stringify(path)}].patched lost canonical identity`)
      }
      const previous = nodeSidecar.patched
      if (previous !== undefined
        && (previous.integrity !== carrier.integrity || previous.path !== carrier.path)) {
        throw parseFailed(`multiple install paths for one node disagree on patched metadata`)
      }
      nodeSidecar.patched = {
        integrity: carrier.integrity,
        path: carrier.path,
      }
      nodeSidecar.patchIdentity = patch
    }
    captureApplied(entry.packageExtensionsApplied, 'packageExtensionsApplied', nodeSidecar, path)
    captureApplied(entry.npmExtensionApplied, 'npmExtensionApplied', nodeSidecar, path)
  },

  captureRootMeta({ lf, rootEntry, rootMeta }) {
    rootMeta.topLevelNamePresent = Object.prototype.hasOwnProperty.call(lf, 'name')
    rootMeta.topLevelVersionPresent = Object.prototype.hasOwnProperty.call(lf, 'version')
    captureRootHash(rootEntry.packageExtensionsHash, 'packageExtensionsHash', rootMeta)
    captureRootHash(rootEntry.npmExtensionHash, 'npmExtensionHash', rootMeta)
  },

  enrichPackageEntry({ graph, node, nodeSidecar, body, kind }) {
    if (kind === 'root') {
      const rootMeta = getFlatSidecar(graph)?.rootMeta
      if (rootMeta?.packageExtensionsHash !== undefined) {
        body.packageExtensionsHash = rootMeta.packageExtensionsHash
      }
      if (rootMeta?.npmExtensionHash !== undefined) {
        body.npmExtensionHash = rootMeta.npmExtensionHash
      }
    }
    if (nodeSidecar?.packageExtensionsApplied !== undefined) {
      body.packageExtensionsApplied = cloneJson(nodeSidecar.packageExtensionsApplied)
    }
    if (nodeSidecar?.npmExtensionApplied !== undefined) {
      body.npmExtensionApplied = cloneJson(nodeSidecar.npmExtensionApplied)
    }
    if (node.patch !== undefined
      && nodeSidecar?.patchIdentity === node.patch
      && nodeSidecar.patched !== undefined) {
      body.patched = { ...nodeSidecar.patched }
    }
  },

  canEmitPatch(_graph, node, sidecar) {
    const nodeSidecar = sidecar?.nodes.get(node.id)
    return node.patch !== undefined
      && nodeSidecar?.patchIdentity === node.patch
      && nodeSidecar.patched !== undefined
  },

  enrichStringifyOut({ sidecar, out }) {
    if (sidecar?.rootMeta?.topLevelNamePresent === false) delete out.name
    if (sidecar?.rootMeta?.topLevelVersionPresent === false) delete out.version
  },
}

const CONFIG: NpmFamilyConfig = {
  lockfileVersion: 4,
  topLevelShape: 'packages-only',
  diagnosticPrefix: 'NPM_V4',
  hooks: NPM4_HOOKS,
}

export type Npm4ParseOptions = NpmFamilyParseOptions
export type Npm4StringifyOptions = NpmFamilyStringifyOptions
export type Npm4EnrichOptions = NpmFamilyEnrichOptions
export type Npm4OptimizeOptions = NpmFamilyOptimizeOptions

export function check(input: string): boolean {
  return checkFamily(input, CONFIG)
}

export function parse(input: string, options: Npm4ParseOptions = {}): Graph {
  return parseFamily(input, options, CONFIG)
}

export function stringify(graph: Graph, options: Npm4StringifyOptions = {}): string {
  return stringifyFamily(graph, CONFIG, options)
}

export function enrich(
  graph: Graph,
  options: Npm4EnrichOptions = {},
): { graph: Graph; diagnostics: Diagnostic[] } {
  return enrichFamily(graph, CONFIG, options)
}

export function optimize(
  graph: Graph,
  options: Npm4OptimizeOptions = {},
): { graph: Graph; diagnostics: Diagnostic[] } {
  return optimizeFamily(graph, CONFIG, options)
}

export interface Npm4ManifestExtensionFeature {
  readonly available: boolean
  readonly fingerprints: readonly Readonly<{
    source: 'packageExtensionsHash' | 'npmExtensionHash'
    value: string
  }>[]
}

export function npm4ManifestExtensionFeatureOf(
  graph: Graph,
): Npm4ManifestExtensionFeature {
  const rootMeta = getFlatSidecar(graph)?.rootMeta
  if (rootMeta === undefined) return { available: false, fingerprints: [] }
  const fingerprints: Npm4ManifestExtensionFeature['fingerprints'][number][] = []
  if (rootMeta.packageExtensionsHash !== undefined) {
    fingerprints.push({
      source: 'packageExtensionsHash',
      value: rootMeta.packageExtensionsHash,
    })
  }
  if (rootMeta.npmExtensionHash !== undefined) {
    fingerprints.push({
      source: 'npmExtensionHash',
      value: rootMeta.npmExtensionHash,
    })
  }
  return { available: true, fingerprints }
}
