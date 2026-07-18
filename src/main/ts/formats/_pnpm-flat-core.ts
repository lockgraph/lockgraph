// _pnpm-flat-core.ts — pnpm flat-family (pnpm-v6 / pnpm-v9) shared core.
//
// Scope: the two on-disk shapes that share the YAML codec + ADR-0006
// peer-virt encoding + importer synthesis loop are owned wholly by this
// module. pnpm-v5 (decimal version literal, dense snapshot tree) ships
// standalone with its own profile and codec per ADR-0022 phase order,
// but reuses the format-neutral helpers exported here — `tarballPayloadOf`
// (F1/F3 shared parser), peer-target resolution, line-ending normalisation,
// importer-path math. v5 takes the parts that have no on-disk shape
// dependency; the v6/v9 YAML codec, profile semantics, and
// peer-virt encoding stay in scope.
//
// Per-version thin entries (`pnpm-v6.ts`, `pnpm-v9.ts`) hand a
// `PnpmLayoutProfile` — a discriminated union with one variant per
// supported on-disk shape — through the shared parse / stringify /
// enrich / optimize implementations. The profile IS the single source
// of truth for each shape; no separate flag toggles are exposed.
//
// Supported profiles:
//
//   - `'v6-collapsed-root'`  → pnpm 6.x: quoted `'6.0'` handshake,
//     single-importer collapses to top-level `dependencies` blocks,
//     slash-leading `packages` keys, peer-context directly on the
//     packages key, inline transitives, per-entry `dev: false|true`,
//     no `snapshots` block.
//   - `'v9-importers-snapshots'` → pnpm 9.x: quoted `'9.0'` handshake,
//     `importers` block ALWAYS emitted, bare `packages` keys, peer-context
//     on `snapshots` keys, separate `snapshots` block carries resolved
//     tree, no per-entry dev flag.
//
// Diagnostic codes carry the per-version prefix from
// `profile.diagnosticPrefix` (e.g. `PNPM_V9_PEER_AMBIGUOUS`,
// `PNPM_V6_INVALID_INTEGRITY`). Family-shared diagnostics keep the bare
// `PNPM_` prefix (e.g. `PNPM_BAD_ENTRY`, `PNPM_UNRESOLVED_DEP`). Patch
// loss surfaces through the canonical `RECIPE_FEATURE_DROPPED` code per
// ADR-0014 §5 (recipe diagnostics live in `recipe/diagnostics.ts`).
//
// YAML in/out is delegated to `_pnpm-yaml.ts`; this module owns only
// the higher-level pnpm family semantics.

import { createHash } from 'node:crypto'
import semver from 'semver'
import {
  GraphError,
  newBuilder,
  serializeNodeId,
  stripPeerContextFromNodeId,
  toTarballKey,
  type Diagnostic,
  type Edge,
  type EdgeAttrs,
  type EdgeKind,
  type Graph,
  type Manifest,
  type Node,
  type NodeId,
  type OverrideConstraint,
  type TarballKey,
  type TarballPayload,
} from '../graph.ts'
import { LockfileError } from '../api/errors.ts'
import { nodeVersionOf } from './_node-id.ts'
import { captureOverrides, projectOverrides } from '../recipe/overrides.ts'
import { governingOverrideFor } from '../recipe/descriptor-resolve.ts'
import { parseSri, emitSriForRegistry, isEmptyIntegrity } from '../recipe/integrity.ts'
import {
  DEFAULT_NPM_REGISTRY,
  parse as parseResolutionRecipe,
  stringifyForPnpm,
  stripRegistrySha1Fragment,
  type ResolutionCanonical,
} from '../recipe/resolution.ts'
import {
  hashAndNormaliseBytes as patchHashAndNormaliseBytes,
  isHashedPeerSetToken,
  sentinelHashOf as patchSentinelHashOf,
} from '../recipe/patch.ts'
import {
  invalidIntegrityDiagnostic,
  patchNormalisedDiagnostic,
  unknownResolutionDiagnostic,
} from '../recipe/diagnostics.ts'
import { readWorkspaceFileBytes } from './_path.ts'
import { optimizeUnreachable } from './_optimize.ts'
import { readYaml, emitYaml, flowMap, quoted, type YamlMap } from './_pnpm-yaml.ts'

// === Public option types ====================================================

export interface PnpmFamilyParseOptions {
  /**
   * Filesystem root used by F2 patch-slot extraction (ADR-0014 §4.F2).
   * When the `overrides:` block carries `patch:<spec>#<workspace-path>`
   * entries the resolver reads `<workspaceRoot>/<workspace-path>` bytes
   * and emits the canonical sha512-hex on `Node.patch`. Absent / unreadable
   * patch sources fall back to the ADR-0011 `unresolved-<sha256-hex>`
   * sentinel computed from the locator string.
   */
  workspaceRoot?: string
}

export interface PnpmFamilyStringifyOptions {
  lineEnding?: 'lf' | 'crlf'
  settings?: PnpmSettings
  onDiagnostic?: (diagnostic: Diagnostic) => void
  /** Caller-declared overrides (ADR-0025 §4) overlaid onto the pnpm
   *  `overrides:` block. Caller wins per key; pre-existing `patch:` directives
   *  (F2) survive on collision. */
  overrides?: OverrideConstraint[]
}

export interface PnpmWorkspacePeerProjectionEvidence {
  readonly repositoryManifests?: Readonly<{
    coverage: 'partial' | 'complete'
    manifests: Readonly<Record<string, Manifest>>
  }>
  readonly packageManifests?: ReadonlyMap<TarballKey, Readonly<{ manifest: Manifest }>>
  readonly conflictedSubjects?: ReadonlySet<string>
}

export interface PnpmWorkspacePeerAttribution {
  readonly name: string
  readonly locator: string
}

export interface PnpmWorkspacePeerGap {
  readonly owner: string
  readonly workspace: string
  readonly reason: 'owner-declaration-missing' | 'workspace-manifest-missing'
}

export interface PnpmWorkspacePeerConflict {
  readonly owner: string
  readonly workspace: string
  readonly reason: 'native-collision' | 'manifest-ambiguous' | 'evidence-conflict'
}

export interface PnpmWorkspacePeerProjection {
  readonly attribution: ReadonlyMap<string, Readonly<PnpmWorkspacePeerAttribution>>
  readonly ownerPeerDependencies: ReadonlyMap<string, Readonly<Record<string, string>>>
  readonly gaps: readonly Readonly<PnpmWorkspacePeerGap>[]
  readonly conflicts: readonly Readonly<PnpmWorkspacePeerConflict>[]
}

export interface PnpmFamilyStringifyInternalOptions {
  readonly workspacePeerProjection?: PnpmWorkspacePeerProjection
  readonly workspacePeerEvidence?: PnpmWorkspacePeerProjectionEvidence
  readonly workspaceNames?: ReadonlyMap<string, string>
}

export interface PnpmManifest {
  name?: string
  version?: string
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}

export interface PnpmFamilyEnrichOptions {
  manifests?: Record<string, PnpmManifest>
}

export type PnpmFamilyOptimizeOptions = {}

export interface PnpmSettings {
  autoInstallPeers?: boolean
  excludeLinksFromLockfile?: boolean
}

// === Layout profiles (F1 resolution) =======================================
//
// Discriminated union — each supported on-disk shape is ONE coherent
// profile object. The shape constants for each variant are pinned in
// `PROFILE_TABLE` below; per-version adapter modules pass only the
// discriminant tag (`profile: 'v6-collapsed-root'`) and the core resolves
// it to the full shape internally.

export type PnpmLayoutProfile =
  | { readonly profile: 'v6-collapsed-root' }
  | { readonly profile: 'v9-importers-snapshots' }

export type PnpmLayoutProfileTag = PnpmLayoutProfile['profile']

export type PnpmDiagnosticPrefix = 'PNPM_V9' | 'PNPM_V6'

/**
 * Resolved shape constants for a given profile. Internal-only — never
 * constructed by callers; obtained via `resolveProfile(profile)`. Pins
 * every layout-affecting toggle together as a single immutable object
 * so they cannot drift out of lockstep on the fast path.
 */
interface PnpmLayoutShape {
  /** Quoted-string scalar literal on the `lockfileVersion:` line. */
  readonly lockfileVersion: '9.0' | '6.0'
  /** Single-importer behaviour. */
  readonly topLevelShape: 'importers-always' | 'dependencies-collapsed'
  /** `packages` map key shape. */
  readonly packagesKeyShape: 'bare-at' | 'slash-leading-at'
  /** Where peer-context lives on disk. */
  readonly peerContextLocation: 'snapshots-keys' | 'packages-keys'
  /** Whether a `snapshots` block is emitted. */
  readonly hasSnapshots: boolean
  /** Whether transitive resolved-tree dependencies live inline in packages entries. */
  readonly inlineTransitives: boolean
  /** Whether per-packages-entry `dev: false|true` flag is emitted. */
  readonly devFlag: boolean
  /** Diagnostic code prefix per ADR-0022. */
  readonly diagnosticPrefix: PnpmDiagnosticPrefix
  /** Top-level YAML key order for emit. */
  readonly topLevelOrder: readonly string[]
  /** Top-level keys whose children get a blank line before each entry. */
  readonly topLevelSectionKeys: readonly string[]
}

const TOP_LEVEL_ORDER_V9: readonly string[] = [
  'lockfileVersion',
  'settings',
  'catalogs',
  'overrides',
  'packageExtensionsChecksum',
  'patchedDependencies',
  'pnpmfileChecksum',
  'importers',
  'packages',
  'snapshots',
]

const TOP_LEVEL_ORDER_V6: readonly string[] = [
  'lockfileVersion',
  'settings',
  'overrides',
  'packageExtensionsChecksum',
  'patchedDependencies',
  'pnpmfileChecksum',
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'importers',
  'packages',
]

const TOP_LEVEL_SECTION_KEYS: readonly string[] = ['importers', 'packages', 'snapshots']

const PROFILE_TABLE: { readonly [K in PnpmLayoutProfileTag]: PnpmLayoutShape } = {
  'v6-collapsed-root': {
    lockfileVersion: '6.0',
    topLevelShape: 'dependencies-collapsed',
    packagesKeyShape: 'slash-leading-at',
    peerContextLocation: 'packages-keys',
    hasSnapshots: false,
    inlineTransitives: true,
    devFlag: true,
    diagnosticPrefix: 'PNPM_V6',
    topLevelOrder: TOP_LEVEL_ORDER_V6,
    topLevelSectionKeys: TOP_LEVEL_SECTION_KEYS,
  },
  'v9-importers-snapshots': {
    lockfileVersion: '9.0',
    topLevelShape: 'importers-always',
    packagesKeyShape: 'bare-at',
    peerContextLocation: 'snapshots-keys',
    hasSnapshots: true,
    inlineTransitives: false,
    devFlag: false,
    diagnosticPrefix: 'PNPM_V9',
    topLevelOrder: TOP_LEVEL_ORDER_V9,
    topLevelSectionKeys: TOP_LEVEL_SECTION_KEYS,
  },
}

function resolveProfile(profile: PnpmLayoutProfile): PnpmLayoutShape {
  return PROFILE_TABLE[profile.profile]
}

// === Sidecar ===============================================================

export interface PnpmNodeSidecar {
  /** Declared peerDependencies (range record). */
  peerDependencies?: Record<string, string>
  /** Declared peerDependenciesMeta — the per-peer `{ optional: true }` markers
   *  from the package's own manifest. Captured VERBATIM (parallel to
   *  `peerDependencies`) so it round-trips fully, INCLUDING optional peers that
   *  pnpm never resolved (no peer-virt instance → no peer edge to carry the
   *  bit). `EdgeAttrs.optional` mirrors it on BOUND peer edges for the model
   *  graph, but only the bound subset is edge-representable, so this verbatim
   *  carrier is the round-trip source of truth. Names map 1:1 onto
   *  `peerDependencies` keys. */
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
  /** Static manifest extras. */
  engines?: Record<string, string>
  hasBin?: boolean
  os?: string[]
  cpu?: string[]
  libc?: string[]
  /** v9 snapshots extras — preserved across versions for round-trip stability. */
  transitivePeerDependencies?: string[]
  /** v6-only: per-entry dev flag. Treated as `false` if absent. */
  dev?: boolean
}

export interface PnpmEdgeSidecar {
  /** Resolved on-disk version field (preserves resolved-snapshot-key tail). */
  resolvedVersion?: string
  /** Importer specifier. */
  specifier?: string
}

export interface PnpmSidecar {
  rootId: string
  settings: PnpmSettings
  importerPaths: string[]
  importerByPath: Map<string, string>
  nodes: Map<string, PnpmNodeSidecar>
  importerEdges: Map<string, PnpmEdgeSidecar>
  /** Workspace-peer attribution keyed `${ownerNodeId}\0${workspaceNodeId}` →
   *  { published name, original `+`-encoded locator }, used to reconstruct the native
   *  locator at emit. Keyed by owner because `resolveWorkspacePeerId` collapses a
   *  sub-dir publish and its ancestor onto one node, so one target may carry different
   *  locators across consumers. */
  workspacePeerNames: Map<string, { name: string; locator: string }>
  /** Attribution keys with a within-owner collision (two published packages on one
   *  ancestor node); the locator is not reproducible, so they surface as gaps. */
  workspacePeerCollisions: Set<string>
  overrides?: Record<string, string>
  /** Verbatim top-level `catalogs:` block (pnpm v9+ catalog protocol). Captured
   *  at parse, replayed on emit. The importer `specifier: 'catalog:'` refs
   *  already round-trip on edges; WITHOUT re-emitting the `catalogs:` definitions
   *  those refs resolve to nothing → invalid pnpm lockfile (e.g. directus: 662
   *  catalog refs). Cross-PM `catalog:`→concrete-version resolution is a separate
   *  concern (#56 layer 2); this just stops the same-PM round-trip drop. */
  catalogs?: YamlMap
  /** Verbatim top-level `packageExtensionsChecksum:` scalar (pnpm v6+). pnpm
   *  recomputes this digest of the effective `packageExtensions` config on every
   *  install and frozen-compares it; dropping it on a same-PM round-trip makes
   *  pnpm see "no checksum" ≠ "recomputed checksum" → recompute → NOT frozen-clean
   *  (vite/angular real locks carry it). A derived digest of the manifest config,
   *  not of the lock graph, so it round-trips verbatim same-PM and drops naturally
   *  cross-PM (no sidecar there). */
  packageExtensionsChecksum?: string
  /** Verbatim top-level `patchedDependencies:` block (pnpm v6+): each patched dep
   *  `name@version → { hash, path }`, where `path` is the repo-relative patch file.
   *  pnpm frozen-compares it (same `getOutdatedLockfileSetting` path as overrides);
   *  dropping it on a same-PM round-trip breaks `--frozen-lockfile`. The `path` is
   *  NOT derivable from the modeled `patch_hash=` snapshot-key markers (which carry
   *  only the hash), so the block is preserved verbatim, sidecar-only → drops
   *  naturally cross-PM (patch files are pnpm-specific config, not graph state). */
  patchedDependencies?: YamlMap
  /** Verbatim top-level `pnpmfileChecksum:` scalar (pnpm v9+) — pnpm's digest of
   *  `.pnpmfile.cjs`. Frozen-compared like `packageExtensionsChecksum`; dropping it
   *  on a same-PM round-trip breaks `--frozen-lockfile` (real angular lock carries
   *  it). Manifest-config-derived → sidecar-only, drops naturally cross-PM. */
  pnpmfileChecksum?: string
  /** Verbatim top-level `settings:` block (pnpm v6+). `extractSettings` keeps only
   *  the two resolution-affecting booleans for the model, but pnpm frozen-compares
   *  the FULL block (e.g. `dedupePeers`), so a same-PM round-trip must replay it
   *  verbatim or dropping keys → frozen mismatch. Reconstructed from defaults
   *  cross-PM (no verbatim block). */
  settingsVerbatim?: YamlMap
}

const sidecarByGraph = new WeakMap<Graph, PnpmSidecar>()

export function hasAdapterState(graph: Graph): boolean {
  return sidecarByGraph.has(graph)
}

function rememberSidecar(graph: Graph, sidecar: PnpmSidecar): void {
  sidecarByGraph.set(graph, sidecar)
}

export function rebindAdapterState(
  source: Graph,
  target: Graph,
): Readonly<{ graph: Graph; invalidated: readonly string[] }> {
  const sidecar = sidecarByGraph.get(source)
  if (sidecar === undefined) return { graph: target, invalidated: [] }
  const pruned = prunePnpmSidecar(sidecar, target)
  rememberSidecar(target, pruned)
  const invalidated = [
    ...[...sidecar.nodes.keys()].filter(id => !pruned.nodes.has(id)),
    ...[...sidecar.importerEdges.keys()].filter(key => !pruned.importerEdges.has(key)),
  ].sort()
  return { graph: target, invalidated }
}

export interface PnpmCatalogFeatureQuery {
  readonly available: boolean
  readonly present: boolean
  readonly fingerprint?: string
}

/** Read-only catalog feature query for completeness assessment. */
export function pnpmCatalogFeatureOf(graph: Graph): PnpmCatalogFeatureQuery {
  const sidecar = sidecarByGraph.get(graph)
  const catalogs = sidecar?.catalogs
  const present = catalogs !== undefined && Object.keys(catalogs).length > 0
  return {
    available: sidecar !== undefined,
    present,
    ...(present ? { fingerprint: pnpmCatalogFingerprint(catalogs) } : {}),
  }
}

function pnpmCatalogFingerprint(catalogs: YamlMap): string {
  const canonical = canonicalFeatureValue(catalogs)
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
}

function canonicalFeatureValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalFeatureValue)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalFeatureValue(item)]))
  }
  return value
}

/**
 * Lock-borne pnpm overrides as canonical `OverrideConstraint[]` (ADR-0025 §6,
 * A2). Reads the verbatim `sidecar.overrides` block captured at parse and
 * canonicalises it via the F6 `captureOverrides('pnpm')` grammar. F2 `patch:`
 * directives are dropped — those are patch slots, not version overrides.
 * Returns undefined when the graph carries no pnpm overrides block (or the
 * sidecar was lost to a `mutate`). Consumed by `index.ts` `overridesOf`.
 */
export function getPnpmOverridesCanonical(graph: Graph): OverrideConstraint[] | undefined {
  const sidecar = sidecarByGraph.get(graph)
  if (sidecar?.overrides === undefined) return undefined
  const versionOnly: Record<string, string> = {}
  for (const [key, value] of Object.entries(sidecar.overrides)) {
    if (!value.startsWith('patch:')) versionOnly[key] = value
  }
  return captureOverrides(versionOnly, 'pnpm').canonical
}

// === Public API: check / parse / stringify / enrich / optimize =============

export function checkFamily(input: string, profile: PnpmLayoutProfile): boolean {
  const shape = resolveProfile(profile)
  // Empirical probe — anchor on the version literal handshake. Both v6 and v9
  // use quoted strings (`'6.0'` / `'9.0'`), distinguishing them from v5
  // decimal (`5.4`).
  const escaped = shape.lockfileVersion.replace(/\./g, '\\.')
  const re = new RegExp(`^\\s*lockfileVersion\\s*:\\s*['"]${escaped}['"]`, 'm')
  return re.test(input)
}

type PnpmGraphBuilder = ReturnType<typeof newBuilder>

interface PnpmParseContext {
  readonly shape: PnpmLayoutShape
  readonly yaml: YamlMap
  readonly builder: PnpmGraphBuilder
  readonly diagnostics: Diagnostic[]
  readonly sidecar: PnpmSidecar
  readonly patchDirectives: PatchDirective[]
  readonly packagesMap: Record<string, any>
  readonly effectiveImporters: Record<string, unknown>
  readonly importerPaths: string[]
  readonly seenIds: Set<string>
  readonly idByPackagesKey: Map<string, string>
}

function createPnpmParseContext(
  input: string,
  options: PnpmFamilyParseOptions,
  profile: PnpmLayoutProfile,
): PnpmParseContext {
  const shape = resolveProfile(profile)
  const yaml = readYaml(normalizeLineEndings(input))
  if (yaml.lockfileVersion !== shape.lockfileVersion) {
    throw new LockfileError({
      code: 'FORMAT_MISMATCH',
      message: `pnpm-v${shape.lockfileVersion.split('.')[0]} adapter: expected lockfileVersion ${JSON.stringify(shape.lockfileVersion)}, got ${JSON.stringify(yaml.lockfileVersion)}`,
    })
  }

  const sidecar = capturePnpmParseSidecar(yaml)
  return {
    shape,
    yaml,
    builder: newBuilder(),
    diagnostics: [],
    sidecar,
    patchDirectives: parseOverridePatches(sidecar.overrides, options.workspaceRoot),
    packagesMap: isPlainObject(yaml.packages) ? yaml.packages : {},
    effectiveImporters: {},
    importerPaths: [],
    seenIds: new Set<string>(),
    idByPackagesKey: new Map<string, string>(),
  }
}

/** Capture pnpm's frozen-compared top-level metadata before graph projection. */
function capturePnpmParseSidecar(yaml: YamlMap): PnpmSidecar {
  const sidecar: PnpmSidecar = {
    rootId: '',
    settings: extractSettings(yaml.settings),
    importerPaths: [],
    importerByPath: new Map<string, string>(),
    nodes: new Map<string, PnpmNodeSidecar>(),
    importerEdges: new Map<string, PnpmEdgeSidecar>(),
    workspacePeerNames: new Map<string, { name: string; locator: string }>(),
    workspacePeerCollisions: new Set<string>(),
  }

  if (yaml.settings !== undefined && typeof yaml.settings === 'object') {
    sidecar.settingsVerbatim = yaml.settings as YamlMap
  }
  if (yaml.overrides !== undefined && typeof yaml.overrides === 'object') {
    sidecar.overrides = { ...(yaml.overrides as Record<string, string>) }
  }
  if (yaml.catalogs !== undefined && typeof yaml.catalogs === 'object') {
    sidecar.catalogs = yaml.catalogs as YamlMap
  }
  if (typeof yaml.packageExtensionsChecksum === 'string') {
    sidecar.packageExtensionsChecksum = yaml.packageExtensionsChecksum
  }
  if (yaml.patchedDependencies !== undefined && typeof yaml.patchedDependencies === 'object') {
    sidecar.patchedDependencies = yaml.patchedDependencies as YamlMap
  }
  if (typeof yaml.pnpmfileChecksum === 'string') {
    sidecar.pnpmfileChecksum = yaml.pnpmfileChecksum
  }
  return sidecar
}

/**
 * Materialise the implicit root importer and explicit workspace importers.
 * This must precede package parsing: workspace peers encode importer paths in
 * peer locators, and those paths participate in the package NodeId.
 */
function synthesisePnpmImporterNodes(context: PnpmParseContext): void {
  const { yaml, shape, builder, sidecar, effectiveImporters, importerPaths } = context
  const importersMap = isPlainObject(yaml.importers) ? yaml.importers : undefined
  const collapsedRootDeps = isCollapsedRoot(yaml, shape)
    ? buildCollapsedRootImporter(yaml)
    : undefined

  if (importersMap !== undefined) {
    for (const key of Object.keys(importersMap)) {
      effectiveImporters[key] = importersMap[key]
    }
  }
  if (collapsedRootDeps !== undefined) {
    effectiveImporters['.'] = collapsedRootDeps
  }
  if (Object.keys(effectiveImporters).length === 0) {
    effectiveImporters['.'] = {}
  }

  importerPaths.push(...Object.keys(effectiveImporters).sort(cmpStr))
  const rootImporterPath = importerPaths.includes('.') ? '.' : importerPaths[0] ?? '.'
  const rootName = '.'
  const rootVersion = '0.0.0'
  const rootId = `${rootName}@${rootVersion}`
  builder.addNode({
    id: rootId,
    name: rootName,
    version: rootVersion,
    peerContext: [],
    workspacePath: '',
  })
  sidecar.rootId = rootId
  sidecar.importerByPath.set(rootImporterPath, rootId)

  for (const importerPath of importerPaths) {
    if (importerPath === rootImporterPath) continue
    const memberName = importerPath
    const memberVersion = '0.0.0'
    const memberId = `${memberName}@${memberVersion}`
    sidecar.importerByPath.set(importerPath, memberId)
    builder.addNode({
      id: memberId,
      name: memberName,
      version: memberVersion,
      peerContext: [],
      workspacePath: importerPath,
    })
  }
  sidecar.importerPaths = importerPaths.slice()
}

/** Add every resolved package instance using the profile's authoritative key space. */
function addPnpmPackageNodes(context: PnpmParseContext): void {
  if (context.shape.hasSnapshots) {
    addPnpmSnapshotPackageNodes(context)
  } else {
    addPnpmInlinePackageNodes(context)
  }
}

function addPnpmSnapshotPackageNodes(context: PnpmParseContext): void {
  const { yaml, shape, builder, diagnostics, sidecar, patchDirectives, packagesMap, seenIds } = context
  const snapshotsMap = isPlainObject(yaml.snapshots) ? yaml.snapshots : {}
  for (const snapshotKey of Object.keys(snapshotsMap)) {
    const parsed = parsePackagesOrSnapshotKey(snapshotKey)
    if (parsed === undefined) {
      diagnostics.push({
        code: 'PNPM_BAD_ENTRY',
        severity: 'warning',
        message: `pnpm-v${shape.lockfileVersion.split('.')[0]} snapshot key ${JSON.stringify(snapshotKey)} not parseable`,
      })
      continue
    }
    const { name, version, peers, opaquePeers } = parsed
    const peerContext = buildPeerContext(peers, sidecar.importerByPath, opaquePeers)
    const nodeId = serializeNodeId(name, version, peerContext)
    if (seenIds.has(nodeId)) continue
    seenIds.add(nodeId)

    const bareKey = `${name}@${version}`
    const pkgEntry = packagesMap[bareKey]
    if (pkgEntry === undefined) {
      diagnostics.push({
        code: `${shape.diagnosticPrefix}_SNAPSHOTS_MISSING`,
        severity: 'warning',
        subject: nodeId,
        message: `pnpm-v${shape.lockfileVersion.split('.')[0]} snapshot ${JSON.stringify(snapshotKey)} has no matching packages[${JSON.stringify(bareKey)}] baseline`,
      })
      continue
    }
    addPackageNode(builder, sidecar, name, version, peerContext, nodeId, pkgEntry, diagnostics, resolvePatchForNode(patchDirectives, name, version, nodeId, diagnostics))
    const snapEntry = snapshotsMap[snapshotKey]
    if (isPlainObject(snapEntry) && Array.isArray(snapEntry.transitivePeerDependencies)) {
      const nodeSidecar = sidecar.nodes.get(nodeId)
      if (nodeSidecar !== undefined) {
        nodeSidecar.transitivePeerDependencies = (snapEntry.transitivePeerDependencies as string[]).slice()
      }
    }
  }
}

function addPnpmInlinePackageNodes(context: PnpmParseContext): void {
  const { shape, builder, diagnostics, sidecar, patchDirectives, packagesMap, seenIds, idByPackagesKey } = context
  for (const pkgKey of Object.keys(packagesMap)) {
    const stripped = stripPackagesKeyPrefix(pkgKey, shape.packagesKeyShape)
    const parsed = parsePackagesOrSnapshotKey(stripped)
    if (parsed === undefined) {
      diagnostics.push({
        code: 'PNPM_BAD_ENTRY',
        severity: 'warning',
        message: `pnpm-v${shape.lockfileVersion.split('.')[0]} packages key ${JSON.stringify(pkgKey)} not parseable`,
      })
      continue
    }
    const { name, version, peers, opaquePeers } = parsed
    const peerContext = buildPeerContext(peers, sidecar.importerByPath, opaquePeers)
    const nodeId = serializeNodeId(name, version, peerContext)
    if (seenIds.has(nodeId)) continue
    seenIds.add(nodeId)
    idByPackagesKey.set(pkgKey, nodeId)
    const pkgEntry = packagesMap[pkgKey]!
    addPackageNode(builder, sidecar, name, version, peerContext, nodeId, pkgEntry, diagnostics, resolvePatchForNode(patchDirectives, name, version, nodeId, diagnostics))
    if (isPlainObject(pkgEntry) && typeof pkgEntry.dev === 'boolean') {
      const nodeSidecar = sidecar.nodes.get(nodeId)
      if (nodeSidecar !== undefined) nodeSidecar.dev = pkgEntry.dev
    }
  }
}

type PnpmImporterEdgeKind = 'dep' | 'dev' | 'optional'

interface PnpmImporterDependency {
  readonly importerPath: string
  readonly srcId: string
  readonly kind: PnpmImporterEdgeKind
  readonly depName: string
  readonly specifier: string | undefined
  readonly version: string
}

interface PnpmImporterDependencyBlock {
  readonly importerPath: string
  readonly srcId: string
  readonly importerEntry: Record<string, any>
  readonly kind: PnpmImporterEdgeKind
  readonly blockName: 'dependencies' | 'devDependencies' | 'optionalDependencies'
}

interface PnpmImporterEdgeInput {
  readonly srcId: string
  readonly targetId: string
  readonly kind: PnpmImporterEdgeKind
  readonly attrs: EdgeAttrs
}

/** Wire every importer dependency after the package node set is complete. */
function addPnpmImporterEdges(context: PnpmParseContext): void {
  const { importerPaths, effectiveImporters, sidecar } = context
  for (const importerPath of importerPaths) {
    const srcId = sidecar.importerByPath.get(importerPath)
    if (srcId === undefined) continue
    const importerEntry = effectiveImporters[importerPath]
    if (!isPlainObject(importerEntry)) continue

    for (const [kind, blockName] of [
      ['dep', 'dependencies'],
      ['dev', 'devDependencies'],
      ['optional', 'optionalDependencies'],
    ] as const) {
      addPnpmImporterDependencyBlock(context, {
        importerPath,
        srcId,
        importerEntry,
        kind,
        blockName,
      })
    }
  }
}

function addPnpmImporterDependencyBlock(
  context: PnpmParseContext,
  input: PnpmImporterDependencyBlock,
): void {
  const { importerPath, srcId, importerEntry, kind, blockName } = input
  const block = importerEntry[blockName]
  if (!isPlainObject(block)) return
  const entries = Object.entries(block).sort((a, b) => cmpStr(a[0], b[0]))
  for (const [depName, depValue] of entries) {
    const spec = importerSpec(depValue)
    if (spec === undefined) continue
    const dependency: PnpmImporterDependency = {
      importerPath,
      srcId,
      kind,
      depName,
      specifier: spec.specifier,
      version: spec.version,
    }
    if (dependency.version.startsWith('link:')) {
      addPnpmWorkspaceImporterDependency(context, dependency)
    } else {
      addPnpmResolvedImporterDependency(context, dependency)
    }
  }
}

/** Resolve a link locator through the importer path map and preserve its workspace range. */
function addPnpmWorkspaceImporterDependency(
  context: PnpmParseContext,
  dependency: PnpmImporterDependency,
): void {
  const { shape, builder, diagnostics, sidecar } = context
  const { importerPath, srcId, kind, depName, specifier, version } = dependency
  const linkPath = resolveLinkPath(importerPath, version.slice(5))
  const targetId = sidecar.importerByPath.get(linkPath)
  if (targetId === undefined) {
    diagnostics.push({
      code: 'PNPM_UNRESOLVED_DEP',
      severity: 'warning',
      subject: srcId,
      message: `pnpm-v${shape.lockfileVersion.split('.')[0]}: importer ${JSON.stringify(importerPath)} dep ${depName} resolves to unknown workspace ${JSON.stringify(linkPath)}`,
    })
    return
  }

  const rawSpecifier = specifier ?? ''
  const targetVersion = nodeVersionOf(targetId)
  const workspaceRange = targetVersion !== undefined && targetVersion !== ''
    ? { specifier: rawSpecifier, resolvedVersion: targetVersion }
    : { specifier: rawSpecifier }
  const attrs = {
    range: specifier ?? version,
    workspace: true,
    workspaceRange,
  }
  if (!addPnpmImporterEdge(builder, { srcId, targetId, kind, attrs })) return
  sidecar.importerEdges.set(`${srcId}\0${kind}\0${targetId}\0`, { resolvedVersion: version, specifier })
}

/** Resolve a registry or alias locator through the parsed snapshot node set. */
function addPnpmResolvedImporterDependency(
  context: PnpmParseContext,
  dependency: PnpmImporterDependency,
): void {
  const { shape, builder, diagnostics, sidecar, seenIds } = context
  const { importerPath, srcId, kind, depName, specifier, version } = dependency
  let targetId = resolveSnapshotTarget(seenIds, depName, version, sidecar.importerByPath)
  let aliasSlot: string | undefined
  if (targetId === undefined) {
    const aliasTarget = resolveAliasedSnapshotTarget(seenIds, version, sidecar.importerByPath)
    if (aliasTarget !== undefined) {
      targetId = aliasTarget
      aliasSlot = depName
    }
  }
  if (targetId === undefined) {
    diagnostics.push({
      code: 'PNPM_UNRESOLVED_DEP',
      severity: 'warning',
      subject: srcId,
      message: `pnpm-v${shape.lockfileVersion.split('.')[0]}: importer ${JSON.stringify(importerPath)} dep ${depName}@${version} resolves to no snapshot`,
    })
    return
  }

  const attrs: { range: string; alias?: string } = { range: specifier ?? version }
  if (aliasSlot !== undefined) attrs.alias = aliasSlot
  if (!addPnpmImporterEdge(builder, { srcId, targetId, kind, attrs })) return
  const edgeKey = `${srcId}\0${kind}\0${targetId}\0${aliasSlot ?? ''}`
  sidecar.importerEdges.set(edgeKey, { resolvedVersion: version, specifier })
}

/** Add an importer edge while treating the graph builder's duplicate invariant as idempotence. */
function addPnpmImporterEdge(
  builder: PnpmGraphBuilder,
  input: PnpmImporterEdgeInput,
): boolean {
  const { srcId, targetId, kind, attrs } = input
  try {
    builder.addEdge(srcId, targetId, kind, attrs)
    return true
  } catch (error) {
    if (error instanceof GraphError && error.code === 'INVARIANT_VIOLATION') return false
    throw error
  }
}

/**
 * Wire package-to-package adjacency from snapshots (v9) or inline entries (v6).
 * `emittedEdges` deduplicates snapshot keys that collapse to one depth-0
 * peer-context NodeId while retaining edges to genuinely distinct targets.
 */
function addPnpmResolvedTreeEdges(context: PnpmParseContext): void {
  const emittedEdges = new Map<string, Set<string>>()
  if (context.shape.hasSnapshots) {
    addPnpmSnapshotTreeEdges(context, emittedEdges)
  } else {
    addPnpmInlineTreeEdges(context, emittedEdges)
  }
}

function addPnpmSnapshotTreeEdges(
  context: PnpmParseContext,
  emittedEdges: Map<string, Set<string>>,
): void {
  const { yaml, shape, builder, diagnostics, sidecar, seenIds } = context
  const snapshotsMap = isPlainObject(yaml.snapshots) ? yaml.snapshots : {}
  for (const snapshotKey of Object.keys(snapshotsMap)) {
    const parsed = parsePackagesOrSnapshotKey(snapshotKey)
    if (parsed === undefined) continue
    const { name, version, peers, opaquePeers } = parsed
    const peerContext = buildPeerContext(peers, sidecar.importerByPath, opaquePeers)
    const srcId = serializeNodeId(name, version, peerContext)
    if (!seenIds.has(srcId)) continue
    const snapEntry = snapshotsMap[snapshotKey]
    if (!isPlainObject(snapEntry)) continue
    addResolvedTreeEdges(context, emittedEdges, { srcId, entry: snapEntry, peers })
  }
}

function addPnpmInlineTreeEdges(
  context: PnpmParseContext,
  emittedEdges: Map<string, Set<string>>,
): void {
  const { shape, builder, diagnostics, sidecar, packagesMap, seenIds, idByPackagesKey } = context
  for (const pkgKey of Object.keys(packagesMap)) {
    const srcId = idByPackagesKey.get(pkgKey)
    if (srcId === undefined) continue
    const stripped = stripPackagesKeyPrefix(pkgKey, shape.packagesKeyShape)
    const parsed = parsePackagesOrSnapshotKey(stripped)
    if (parsed === undefined) continue
    const pkgEntry = packagesMap[pkgKey]
    if (!isPlainObject(pkgEntry)) continue
    addResolvedTreeEdges(context, emittedEdges, { srcId, entry: pkgEntry, peers: parsed.peers })
  }
}

/** Attach parse diagnostics, seal graph invariants, and retain adapter state. */
function sealPnpmParseContext(context: PnpmParseContext): Graph {
  const { shape, builder, diagnostics, sidecar } = context
  for (const diagnostic of diagnostics) {
    builder.diagnostic(diagnostic)
  }
  try {
    const graph = builder.seal()
    rememberSidecar(graph, sidecar)
    return graph
  } catch (error) {
    if (error instanceof GraphError) {
      throw new LockfileError({
        code: 'PARSE_FAILED',
        message: `pnpm-v${shape.lockfileVersion.split('.')[0]} seal failed: ${error.message}`,
      })
    }
    throw error
  }
}

export function parseFamily(
  input: string,
  options: PnpmFamilyParseOptions,
  profile: PnpmLayoutProfile,
): Graph {
  const context = createPnpmParseContext(input, options, profile)
  synthesisePnpmImporterNodes(context)
  addPnpmPackageNodes(context)
  addPnpmImporterEdges(context)
  addPnpmResolvedTreeEdges(context)
  return sealPnpmParseContext(context)
}

function readonlyAttributionMap(
  source: ReadonlyMap<string, Readonly<PnpmWorkspacePeerAttribution>>,
): ReadonlyMap<string, Readonly<PnpmWorkspacePeerAttribution>> {
  const map = new Map(source)
  let view: ReadonlyMap<string, Readonly<PnpmWorkspacePeerAttribution>>
  view = Object.freeze({
    get size() { return map.size },
    get: (key: string) => map.get(key),
    has: (key: string) => map.has(key),
    entries: () => map.entries(),
    keys: () => map.keys(),
    values: () => map.values(),
    forEach: (callback: (
      value: Readonly<PnpmWorkspacePeerAttribution>,
      key: string,
      source: ReadonlyMap<string, Readonly<PnpmWorkspacePeerAttribution>>,
    ) => void, thisArg?: unknown) => {
      map.forEach((value, key) => callback.call(thisArg, value, key, view))
    },
    [Symbol.iterator]: () => map[Symbol.iterator](),
  })
  return view
}

function readonlyPeerDependenciesMap(
  source: ReadonlyMap<string, Readonly<Record<string, string>>>,
): ReadonlyMap<string, Readonly<Record<string, string>>> {
  const map = new Map(source)
  let view: ReadonlyMap<string, Readonly<Record<string, string>>>
  view = Object.freeze({
    get size() { return map.size },
    get: (key: string) => map.get(key),
    has: (key: string) => map.has(key),
    entries: () => map.entries(),
    keys: () => map.keys(),
    values: () => map.values(),
    forEach: (callback: (
      value: Readonly<Record<string, string>>,
      key: string,
      source: ReadonlyMap<string, Readonly<Record<string, string>>>,
    ) => void, thisArg?: unknown) => {
      map.forEach((value, key) => callback.call(thisArg, value, key, view))
    },
    [Symbol.iterator]: () => map[Symbol.iterator](),
  })
  return view
}

function peerDeclarationsForOwner(
  graph: Graph,
  owner: Node,
  evidence: PnpmWorkspacePeerProjectionEvidence | undefined,
): Readonly<Record<string, string>> | undefined {
  const payload = graph.tarballOf(owner.id)
  if (payload?.peerDependencies !== undefined) return payload.peerDependencies
  const repository = evidence?.repositoryManifests
  if (repository?.coverage === 'complete' && owner.workspacePath !== undefined) {
    const manifest = repository.manifests[owner.workspacePath]
    if (manifest?.peerDependencies !== undefined) return manifest.peerDependencies
  }
  const key = toTarballKey({
    name: owner.name,
    version: owner.version,
    ...(owner.patch === undefined ? {} : { patch: owner.patch }),
    ...(owner.source === undefined ? {} : { source: owner.source }),
  })
  return evidence?.packageManifests?.get(key)?.manifest.peerDependencies
}

function restoredWorkspacePeerAttribution(
  graph: Graph,
  owner: Node,
  workspace: Node,
  evidence: PnpmWorkspacePeerProjectionEvidence | undefined,
): { attribution?: PnpmWorkspacePeerAttribution; gap?: PnpmWorkspacePeerGap; conflict?: PnpmWorkspacePeerConflict } {
  const currentKey = toTarballKey({
    name: owner.name,
    version: owner.version,
    ...(owner.patch === undefined ? {} : { patch: owner.patch }),
    ...(owner.source === undefined ? {} : { source: owner.source }),
  })
  const declarationSubject = owner.workspacePath ?? currentKey
  if (graph.tarballOf(owner.id)?.peerDependencies === undefined
    && evidence?.conflictedSubjects?.has(declarationSubject) === true) {
    return { conflict: Object.freeze({
      owner: owner.id,
      workspace: workspace.id,
      reason: 'evidence-conflict',
    }) }
  }
  const declarations = peerDeclarationsForOwner(graph, owner, evidence)
  if (declarations === undefined || Object.keys(declarations).length === 0) {
    return { gap: Object.freeze({
      owner: owner.id,
      workspace: workspace.id,
      reason: 'owner-declaration-missing',
    }) }
  }
  const repository = evidence?.repositoryManifests
  if (repository?.coverage !== 'complete' || workspace.workspacePath === undefined) {
    return { gap: Object.freeze({
      owner: owner.id,
      workspace: workspace.id,
      reason: 'workspace-manifest-missing',
    }) }
  }
  const candidates: Array<{ name: string; path: string }> = []
  for (const [path, manifest] of Object.entries(repository.manifests)) {
    if (manifest.name === undefined || declarations[manifest.name] === undefined) continue
    if (path !== workspace.workspacePath && !path.startsWith(`${workspace.workspacePath}/`)) continue
    candidates.push({ name: manifest.name, path })
  }
  if (candidates.some(candidate => evidence?.conflictedSubjects?.has(candidate.path) === true)) {
    return { conflict: Object.freeze({
      owner: owner.id,
      workspace: workspace.id,
      reason: 'evidence-conflict',
    }) }
  }
  if (candidates.length === 0) {
    return { gap: Object.freeze({
      owner: owner.id,
      workspace: workspace.id,
      reason: 'workspace-manifest-missing',
    }) }
  }
  if (candidates.length > 1) {
    return { conflict: Object.freeze({
      owner: owner.id,
      workspace: workspace.id,
      reason: 'manifest-ambiguous',
    }) }
  }
  const candidate = candidates[0]!
  return { attribution: Object.freeze({
    name: candidate.name,
    locator: candidate.path.replace(/\//g, '+'),
  }) }
}

export function resolvePnpmWorkspacePeerProjection(
  graph: Graph,
  evidence?: PnpmWorkspacePeerProjectionEvidence,
): PnpmWorkspacePeerProjection {
  const sidecar = sidecarByGraph.get(graph)
  const state = emptyWorkspacePeerProjectionState()
  for (const node of graph.nodes()) {
    for (const edge of graph.out(node.id)) {
      projectPnpmWorkspacePeerEdge(graph, sidecar, evidence, state, node, edge)
    }
  }
  return freezeWorkspacePeerProjection(state)
}

interface WorkspacePeerProjectionState {
  attribution: Map<string, Readonly<PnpmWorkspacePeerAttribution>>
  ownerPeerDependencies: Map<string, Readonly<Record<string, string>>>
  gaps: Readonly<PnpmWorkspacePeerGap>[]
  conflicts: Readonly<PnpmWorkspacePeerConflict>[]
}

function emptyWorkspacePeerProjectionState(): WorkspacePeerProjectionState {
  return {
    attribution: new Map(),
    ownerPeerDependencies: new Map(),
    gaps: [],
    conflicts: [],
  }
}

function projectPnpmWorkspacePeerEdge(
  graph: Graph,
  sidecar: PnpmSidecar | undefined,
  evidence: PnpmWorkspacePeerProjectionEvidence | undefined,
  state: WorkspacePeerProjectionState,
  owner: Node,
  edge: Edge,
): void {
  if (edge.kind !== 'peer') return
  const workspace = graph.getNode(edge.dst)
  if (workspace?.workspacePath === undefined) return
  const declarations = peerDeclarationsForOwner(graph, owner, evidence)
  if (declarations !== undefined) {
    state.ownerPeerDependencies.set(owner.id, Object.freeze({ ...declarations }))
  }
  const key = `${owner.id}\0${edge.dst}`
  if (sidecar?.workspacePeerCollisions.has(key) === true) {
    state.conflicts.push(Object.freeze({
      owner: owner.id,
      workspace: edge.dst,
      reason: 'native-collision',
    }))
    return
  }
  const native = sidecar?.workspacePeerNames.get(key)
  if (native !== undefined) {
    state.attribution.set(key, Object.freeze({ ...native }))
    return
  }
  const restored = restoredWorkspacePeerAttribution(graph, owner, workspace, evidence)
  if (restored.attribution !== undefined) state.attribution.set(key, restored.attribution)
  if (restored.gap !== undefined) state.gaps.push(restored.gap)
  if (restored.conflict !== undefined) state.conflicts.push(restored.conflict)
}

function freezeWorkspacePeerProjection(state: WorkspacePeerProjectionState): PnpmWorkspacePeerProjection {
  return Object.freeze({
    attribution: readonlyAttributionMap(state.attribution),
    ownerPeerDependencies: readonlyPeerDependenciesMap(state.ownerPeerDependencies),
    gaps: Object.freeze(state.gaps),
    conflicts: Object.freeze(state.conflicts),
  })
}

interface PnpmStringifyContext {
  readonly graph: Graph
  readonly shape: PnpmLayoutShape
  readonly sidecar: PnpmSidecar | undefined
  readonly workspacePeerProjection: PnpmWorkspacePeerProjection
  readonly options: PnpmFamilyStringifyOptions
  readonly internal: PnpmFamilyStringifyInternalOptions
  readonly emitDiagnostic: (diagnostic: Diagnostic) => void
  readonly effectiveOverrides: Record<string, string>
  readonly rootNode: Node | undefined
  readonly workspaceNodes: Node[]
  readonly resolvedNodes: Node[]
  readonly out: YamlMap
}

function createPnpmStringifyContext(
  graph: Graph,
  profile: PnpmLayoutProfile,
  options: PnpmFamilyStringifyOptions,
  internal: PnpmFamilyStringifyInternalOptions,
): PnpmStringifyContext {
  const sidecar = sidecarByGraph.get(graph)
  const workspacePeerProjection = internal.workspacePeerProjection
    ?? resolvePnpmWorkspacePeerProjection(graph, internal.workspacePeerEvidence)
  return {
    graph,
    shape: resolveProfile(profile),
    sidecar,
    workspacePeerProjection,
    options,
    internal,
    emitDiagnostic: diagnostic => options.onDiagnostic?.(diagnostic),
    effectiveOverrides: synthesiseOverridePatches(graph, sidecar),
    rootNode: locatePnpmRootNode(graph, sidecar),
    workspaceNodes: [],
    resolvedNodes: [],
    out: {},
  }
}

/** Surface native workspace-peer locators that cannot be reproduced safely. */
function emitPnpmWorkspacePeerDiagnostics(context: PnpmStringifyContext): void {
  const { shape, workspacePeerProjection, emitDiagnostic } = context
  for (const gap of workspacePeerProjection.gaps) {
    emitDiagnostic({
      code: 'PNPM_WORKSPACE_PEER_ATTR_MISSING',
      severity: 'warning',
      subject: gap.owner,
      message: `pnpm-v${shape.lockfileVersion.split('.')[0]}: workspace-peer ${gap.owner} →peer ${gap.workspace} has no native-locator attribution; the relation is retained but the pnpm locator is not reproduced.`,
    })
  }
  for (const conflict of workspacePeerProjection.conflicts) {
    emitDiagnostic({
      code: 'PNPM_WORKSPACE_PEER_ATTR_COLLISION',
      severity: 'warning',
      subject: conflict.owner,
      message: `pnpm-v${shape.lockfileVersion.split('.')[0]}: workspace-peer ${conflict.owner} →peer ${conflict.workspace} has conflicting native-locator attribution.`,
    })
  }
}

/** Merge caller overrides without displacing an existing patch carrier. */
function overlayPnpmStringifyOverrides(context: PnpmStringifyContext): void {
  const { options, effectiveOverrides, emitDiagnostic } = context
  if (options.overrides === undefined || options.overrides.length === 0) return
  const projected = projectOverrides(options.overrides, 'pnpm', emitDiagnostic)
  for (const [key, value] of Object.entries(projected)) {
    const existing = effectiveOverrides[key]
    if (typeof existing === 'string' && existing.startsWith('patch:')) continue
    effectiveOverrides[key] = value as string
  }
}

/** Partition graph nodes into workspace importers and resolved package instances. */
function classifyPnpmStringifyNodes(context: PnpmStringifyContext): void {
  const { graph, rootNode, workspaceNodes, resolvedNodes } = context
  for (const node of graph.nodes()) {
    if (node.id === rootNode?.id) continue
    if (node.workspacePath !== undefined && node.workspacePath !== '') {
      workspaceNodes.push(node)
    } else {
      resolvedNodes.push(node)
    }
  }
  workspaceNodes.sort((a, b) => cmpStr(a.workspacePath ?? '', b.workspacePath ?? ''))
  resolvedNodes.sort((a, b) => cmpStr(a.id, b.id))
}

/** Emit the version handshake, settings, overrides, and frozen-compared metadata. */
function writePnpmStringifyMetadata(context: PnpmStringifyContext): void {
  const { shape, sidecar, options, effectiveOverrides, out } = context
  out.lockfileVersion = quoted(shape.lockfileVersion)
  const settings: PnpmSettings = {
    autoInstallPeers: true,
    excludeLinksFromLockfile: false,
    ...sidecar?.settings,
    ...options.settings,
  }
  out.settings = (
    sidecar?.settingsVerbatim !== undefined
      ? { ...sidecar.settingsVerbatim, ...options.settings }
      : {
          autoInstallPeers: settings.autoInstallPeers ?? true,
          excludeLinksFromLockfile: settings.excludeLinksFromLockfile ?? false,
        }
  ) as YamlMap

  if (Object.keys(effectiveOverrides).length > 0) {
    out.overrides = sortRecord(effectiveOverrides) as YamlMap
  }
  if (sidecar?.catalogs !== undefined && Object.keys(sidecar.catalogs).length > 0) {
    out.catalogs = sidecar.catalogs
  }
  if (sidecar?.packageExtensionsChecksum !== undefined) {
    out.packageExtensionsChecksum = sidecar.packageExtensionsChecksum
  }
  if (sidecar?.patchedDependencies !== undefined && Object.keys(sidecar.patchedDependencies).length > 0) {
    out.patchedDependencies = sidecar.patchedDependencies
  }
  if (sidecar?.pnpmfileChecksum !== undefined) {
    out.pnpmfileChecksum = sidecar.pnpmfileChecksum
  }
}

/** Emit importer dependency blocks, including pnpm v6's single-root collapse. */
function writePnpmStringifyImporters(context: PnpmStringifyContext): void {
  const {
    graph,
    shape,
    sidecar,
    workspacePeerProjection,
    options,
    internal,
    rootNode,
    workspaceNodes,
    out,
  } = context
  const rootImporterEntry = buildImporterEntry(
    graph,
    sidecar,
    workspacePeerProjection,
    rootNode,
    '.',
    options.overrides,
    internal.workspaceNames,
  )

  if (shape.topLevelShape === 'dependencies-collapsed' && workspaceNodes.length === 0) {
    for (const block of ['dependencies', 'devDependencies', 'optionalDependencies'] as const) {
      const value = rootImporterEntry[block]
      if (value !== undefined) out[block] = value
    }
    return
  }

  const importers: YamlMap = {
    '.': Object.keys(rootImporterEntry).length === 0 ? flowMap({}) : rootImporterEntry,
  }
  for (const workspaceNode of workspaceNodes) {
    const workspacePath = workspaceNode.workspacePath ?? workspaceNode.name
    importers[workspacePath] = buildImporterEntry(
      graph,
      sidecar,
      workspacePeerProjection,
      workspaceNode,
      workspacePath,
      options.overrides,
      internal.workspaceNames,
    )
  }
  out.importers = sortRecord(importers) as YamlMap
}

/** Emit package metadata under bare snapshot keys (v9) or peer-qualified keys (v6). */
function writePnpmStringifyPackages(context: PnpmStringifyContext): void {
  const { graph, shape, sidecar, workspacePeerProjection, resolvedNodes, out } = context
  const packagesUsed = new Set<string>()
  for (const node of resolvedNodes) {
    packagesUsed.add(packagesKeyForNode(node, shape, workspacePeerProjection))
  }

  const packages: YamlMap = {}
  if (shape.peerContextLocation === 'snapshots-keys') {
    const bareToNodes = new Map<string, Node[]>()
    for (const node of resolvedNodes) {
      const bareKey = `${node.name}@${node.version}`
      const siblings = bareToNodes.get(bareKey) ?? []
      siblings.push(node)
      bareToNodes.set(bareKey, siblings)
    }
    for (const bareKey of Array.from(bareToNodes.keys()).sort(cmpStr)) {
      const siblings = bareToNodes.get(bareKey)!
      if (!packagesUsed.has(bareKey)) continue
      packages[bareKey] = buildPackageEntry(
        graph,
        sidecar,
        workspacePeerProjection,
        siblings[0]!,
        shape,
      )
    }
  } else {
    const sortedNodes = resolvedNodes.slice().sort((left, right) => cmpStr(
      packagesKeyForNode(left, shape, workspacePeerProjection),
      packagesKeyForNode(right, shape, workspacePeerProjection),
    ))
    for (const node of sortedNodes) {
      const key = packagesKeyForNode(node, shape, workspacePeerProjection)
      packages[key] = buildPackageEntry(graph, sidecar, workspacePeerProjection, node, shape)
    }
  }
  out.packages = packages
}

/** Emit resolved dependency adjacency in the separate pnpm v9 snapshots section. */
function writePnpmStringifySnapshots(context: PnpmStringifyContext): void {
  const { graph, shape, sidecar, workspacePeerProjection, resolvedNodes, out } = context
  if (!shape.hasSnapshots) return
  const snapshots: YamlMap = {}
  for (const node of resolvedNodes) {
    const snapshotKey = nodeIdToSnapshotKey(node, workspacePeerProjection)
    snapshots[snapshotKey] = buildSnapshotEntry(graph, sidecar, workspacePeerProjection, node)
  }
  out.snapshots = sortRecord(snapshots) as YamlMap
}

/** Verify emitted adjacency, serialise deterministic YAML, and apply line endings. */
function emitPnpmStringifyResult(context: PnpmStringifyContext): string {
  const {
    graph,
    shape,
    workspacePeerProjection,
    options,
    emitDiagnostic,
    rootNode,
    resolvedNodes,
    out,
  } = context
  assertResolveValid({
    graph,
    shape,
    out,
    rootNode,
    resolvedNodes,
    onDiagnostic: emitDiagnostic,
    workspacePeerProjection,
  })
  const text = emitYaml(out, {
    topLevelOrder: shape.topLevelOrder,
    topLevelSectionKeys: shape.topLevelSectionKeys,
  })
  return options.lineEnding === 'crlf' ? text.replace(/\n/g, '\r\n') : text
}

export function stringifyFamily(
  graph: Graph,
  profile: PnpmLayoutProfile,
  options: PnpmFamilyStringifyOptions = {},
  internal: PnpmFamilyStringifyInternalOptions = {},
): string {
  const context = createPnpmStringifyContext(graph, profile, options, internal)
  emitPnpmWorkspacePeerDiagnostics(context)
  overlayPnpmStringifyOverrides(context)
  classifyPnpmStringifyNodes(context)
  writePnpmStringifyMetadata(context)
  writePnpmStringifyImporters(context)
  writePnpmStringifyPackages(context)
  writePnpmStringifySnapshots(context)
  return emitPnpmStringifyResult(context)
}

// ADR-0028 INV-RESOLVE (pnpm v9/v6) — the resolution-graph verifier.
//
// For every DECLARED edge `(c → d)` of kind dep/dev/optional (NOT peer), assert
// that the emitted adjacency resolves the descriptor segment
// `seg = edge.attrs.alias ?? d.name` back to `d.id`, using the SAME oracle the
// parser uses (`resolveSnapshotTarget` / `resolveAliasedSnapshotTarget` over the
// emitted NodeId set). Two hops, parameterised by the layout shape:
//
//   - consumer hop (`c` is the root or a workspace importer): the
//     `importers[path(c)]` block, or — when v6 collapses a single importer —
//     the top-level `dependencies`/`devDependencies`/`optionalDependencies`
//     blocks. The slot value is the importer entry's `version` field.
//   - package hop (`c` is a resolved package): v9 reads
//     `snapshots[snapshotKey(c)].dependencies`/`optionalDependencies`; v6 reads
//     the INLINE `packages[key(c)].dependencies`/`optionalDependencies` (no
//     `snapshots:` block). The slot value is the raw dep string.
//
// Workspace-TARGET edges (`d` is a workspace member) are skipped: pnpm emits
// them as `link:` references, resolved by directory, not through the snapshot
// oracle. This reads the EMITTED `out` structure (the ground truth), so a
// wrong slot key — e.g. an npm-aliased dep keyed by `d.name` instead of its
// alias — surfaces as a violation.
interface ResolveValidationInput {
  readonly graph: Graph
  readonly shape: PnpmLayoutShape
  readonly out: YamlMap
  readonly rootNode: Node | undefined
  readonly resolvedNodes: readonly Node[]
  readonly onDiagnostic: (d: Diagnostic) => void
  readonly workspacePeerProjection: PnpmWorkspacePeerProjection
}

interface ResolveValidationContext extends ResolveValidationInput {
  readonly seenIds: Set<string>
  readonly importerByPath: Map<string, string>
  readonly importersMap: Record<string, unknown> | undefined
  readonly snapshotsMap: Record<string, unknown> | undefined
  readonly packagesMap: Record<string, unknown> | undefined
}

interface ResolveConsumerView {
  readonly consumer: Node
  readonly importer: boolean
  readonly block: Record<string, unknown>
  readonly blockNames: readonly string[]
}

function assertResolveValid(input: ResolveValidationInput): void {
  const context = createResolveValidationContext(input)
  for (const consumer of context.graph.nodes()) {
    assertConsumerResolveValid(context, consumer)
  }
}

function createResolveValidationContext(input: ResolveValidationInput): ResolveValidationContext {
  const importerByPath = new Map<string, string>()
  if (input.rootNode !== undefined) importerByPath.set('.', input.rootNode.id)
  for (const node of input.graph.nodes()) {
    if (node.workspacePath !== undefined && node.workspacePath !== '') {
      importerByPath.set(node.workspacePath, node.id)
    }
  }
  return {
    ...input,
    seenIds: new Set<string>(input.resolvedNodes.map(node => node.id)),
    importerByPath,
    importersMap: objectMap(input.out.importers),
    snapshotsMap: objectMap(input.out.snapshots),
    packagesMap: objectMap(input.out.packages),
  }
}

function objectMap(value: unknown): Record<string, unknown> | undefined {
  return isPlainObject(value) ? (value as Record<string, unknown>) : undefined
}

function assertConsumerResolveValid(context: ResolveValidationContext, consumer: Node): void {
  const importer = isResolveImporter(context, consumer)
  if (!importer && !context.seenIds.has(consumer.id)) return
  const block = importer
    ? resolveConsumerBlock(context, consumer)
    : resolvePackageBlock(context, consumer)
  if (block === undefined) return
  const blockNames = importer
    ? ['dependencies', 'devDependencies', 'optionalDependencies'] as const
    : ['dependencies', 'optionalDependencies'] as const
  for (const edge of context.graph.out(consumer.id)) {
    assertEmittedEdgeResolveValid(context, { consumer, importer, block, blockNames }, edge)
  }
}

function isResolveImporter(context: ResolveValidationContext, node: Node): boolean {
  return node.id === context.rootNode?.id
    || (node.workspacePath !== undefined && node.workspacePath !== '')
}

function resolveConsumerBlock(
  context: ResolveValidationContext,
  consumer: Node,
): Record<string, unknown> | undefined {
  const path = consumer.id === context.rootNode?.id
    ? '.'
    : (consumer.workspacePath ?? consumer.name)
  if (context.importersMap !== undefined) return objectMap(context.importersMap[path])
  return consumer.id === context.rootNode?.id
    ? (context.out as Record<string, unknown>)
    : undefined
}

function resolvePackageBlock(
  context: ResolveValidationContext,
  pkg: Node,
): Record<string, unknown> | undefined {
  const key = context.shape.hasSnapshots
    ? nodeIdToSnapshotKey(pkg, context.workspacePeerProjection)
    : packagesKeyForNode(pkg, context.shape, context.workspacePeerProjection)
  const entry = context.shape.hasSnapshots
    ? context.snapshotsMap?.[key]
    : context.packagesMap?.[key]
  return objectMap(entry)
}

function assertEmittedEdgeResolveValid(
  context: ResolveValidationContext,
  view: ResolveConsumerView,
  edge: Edge,
): void {
  if (edge.kind !== 'dep' && edge.kind !== 'dev' && edge.kind !== 'optional') return
  const dst = context.graph.getNode(edge.dst)
  if (dst === undefined || (dst.workspacePath !== undefined && dst.workspacePath !== '')) return
  if (!view.importer && (dst.id === view.consumer.id || dst.id === context.rootNode?.id)) return
  const seg = edge.attrs?.alias ?? dst.name
  const value = resolveEmittedSlotValue(view.block, view.blockNames, seg)
  const resolved = resolveEmittedTarget(context, seg, value)
  if (resolved === dst.id) return
  context.onDiagnostic({
    code: 'LAYOUT_RESOLVE_VIOLATION',
    severity: 'error',
    subject: { src: edge.src, dst: edge.dst, kind: edge.kind },
    message:
      `INV-RESOLVE violated: ${view.consumer.id} resolves ${JSON.stringify(seg)} to ` +
      `${value === undefined ? '(no slot)' : (resolved === undefined ? `${JSON.stringify(value)} → (nothing)` : resolved)}, ` +
      `expected ${dst.id} (pnpm encoding defect — ADR-0028 INV-RESOLVE)`,
  })
}

function resolveEmittedSlotValue(
  block: Record<string, unknown>,
  blockNames: readonly string[],
  seg: string,
): string | undefined {
  for (const blockName of blockNames) {
    const sub = objectMap(block[blockName])
    if (sub === undefined) continue
    const raw = sub[seg]
    if (typeof raw === 'string') return raw
    const entry = objectMap(raw)
    if (typeof entry?.version === 'string') return entry.version
  }
  return undefined
}

function resolveEmittedTarget(
  context: ResolveValidationContext,
  seg: string,
  value: string | undefined,
): string | undefined {
  if (value === undefined) return undefined
  return resolveSnapshotTarget(context.seenIds, seg, value, context.importerByPath)
    ?? resolveAliasedSnapshotTarget(context.seenIds, value, context.importerByPath)
}

interface PnpmEnrichContext {
  readonly graph: Graph
  readonly shape: PnpmLayoutShape
  readonly sidecar: PnpmSidecar | undefined
  readonly diagnostics: Diagnostic[]
}

interface PnpmPeerDeclaration {
  readonly node: Node
  readonly name: string
  readonly range: string
}

/** Diagnose declared peers that are absent from the on-disk peer context. */
function collectPnpmPeerFallbackDiagnostics(context: PnpmEnrichContext): void {
  const { graph, sidecar } = context
  for (const node of graph.nodes()) {
    const rawPeers = sidecar?.nodes.get(node.id)?.peerDependencies
    if (rawPeers === undefined) continue
    for (const peerName of Object.keys(rawPeers).sort(cmpStr)) {
      const peerRange = rawPeers[peerName]
      if (peerRange === undefined) continue
      const alreadyBound = node.peerContext
        .some(peer => stripPeerContextFromNodeId(peer).startsWith(`${peerName}@`))
      if (alreadyBound) continue
      diagnosePnpmPeerFallback(context, { node, name: peerName, range: peerRange })
    }
  }
}

function diagnosePnpmPeerFallback(
  context: PnpmEnrichContext,
  declaration: PnpmPeerDeclaration,
): void {
  const { graph, shape, diagnostics } = context
  const { node, name, range } = declaration
  const candidates = derivePeerCandidates(graph, name, range)
  if (candidates.length === 1) {
    diagnostics.push({
      code: `${shape.diagnosticPrefix}_PEER_BOUND`,
      severity: 'info',
      subject: node.id,
      message: `peer ${JSON.stringify(name)} range ${JSON.stringify(range)} → ${candidates[0]} (1-candidate fallback; on-disk peer-context absent)`,
    })
  } else if (candidates.length === 0) {
    diagnostics.push({
      code: `${shape.diagnosticPrefix}_PEER_UNSATISFIED`,
      severity: 'warning',
      subject: node.id,
      message: `peer ${JSON.stringify(name)} range ${JSON.stringify(range)} matches no installed version`,
    })
  } else {
    diagnostics.push({
      code: `${shape.diagnosticPrefix}_PEER_AMBIGUOUS`,
      severity: 'warning',
      subject: node.id,
      message: `peer ${JSON.stringify(name)} range ${JSON.stringify(range)} matches multiple candidates: ${candidates.join(', ')}`,
    })
  }
}

/** Report when workspace hints cannot be concretised without manifest evidence. */
function diagnoseMissingPnpmManifests(context: PnpmEnrichContext): void {
  const { graph, shape, diagnostics } = context
  const hasWorkspaceHint = Array.from(graph.nodes())
    .some(node => node.workspacePath !== undefined && node.workspacePath !== '')
  if (!hasWorkspaceHint) return
  diagnostics.push({
    code: `${shape.diagnosticPrefix}_NO_MANIFESTS`,
    severity: 'warning',
    message: `pnpm-v${shape.lockfileVersion.split('.')[0]} workspace concretisation requires manifests; leaving graph unclassified`,
  })
}

/** Apply the manifest-derived root and workspace edge plan as one graph mutation. */
function applyPnpmManifestEnrich(
  context: PnpmEnrichContext,
  manifests: Record<string, PnpmManifest>,
): Graph {
  const { graph, sidecar } = context
  const plan = planManifestEnrich(graph, sidecar, manifests)
  if (plan.addRootEdges.length === 0 && plan.markWorkspaceEdges.length === 0 && plan.removeRootEdges.length === 0) {
    return graph
  }

  const result = graph.mutate(mutation => {
    for (const edge of plan.removeRootEdges) {
      mutation.removeEdge(edge.src, edge.dst, edge.kind)
    }
    for (const edge of plan.addRootEdges) {
      mutation.addEdge(edge.src, edge.dst, edge.kind, edge.attrs)
    }
    for (const edge of plan.markWorkspaceEdges) {
      mutation.removeEdge(edge.src, edge.dst, edge.kind)
      mutation.addEdge(edge.src, edge.dst, edge.kind, edge.attrs)
    }
  })
  if (sidecar !== undefined) rememberSidecar(result.graph, sidecar)
  return result.graph
}

export function enrichFamily(
  graph: Graph,
  profile: PnpmLayoutProfile,
  options: PnpmFamilyEnrichOptions = {},
): { graph: Graph; diagnostics: Diagnostic[] } {
  const context: PnpmEnrichContext = {
    graph,
    shape: resolveProfile(profile),
    sidecar: sidecarByGraph.get(graph),
    diagnostics: [],
  }
  collectPnpmPeerFallbackDiagnostics(context)
  if (options.manifests === undefined) {
    diagnoseMissingPnpmManifests(context)
    return { graph, diagnostics: context.diagnostics }
  }
  const enrichedGraph = applyPnpmManifestEnrich(context, options.manifests)
  return { graph: enrichedGraph, diagnostics: context.diagnostics }
}

export function optimizeFamily(
  graph: Graph,
  _profile: PnpmLayoutProfile,
  _options: PnpmFamilyOptimizeOptions = {},
): { graph: Graph; diagnostics: Diagnostic[] } {
  const sidecar = sidecarByGraph.get(graph)
  // Seed every workspace node, not just in-degree-0 `roots()`: an incoming `peer` edge
  // raises a workspace's in-degree, so `roots()` alone no longer anchors it.
  const seeds = new Set(graph.roots())
  for (const node of graph.nodes()) {
    if (node.workspacePath !== undefined) seeds.add(node.id)
  }
  const result = optimizeUnreachable(graph, {
    seeds: Array.from(seeds),
    compare: cmpStr,
    edgeSeparator: ' ',
    tarballInputs: node => ({ name: node.name, version: node.version, patch: node.patch }),
    skipMissingTarballs: true,
  })

  if (result.graph !== graph && sidecar !== undefined) {
    rememberSidecar(result.graph, prunePnpmSidecar(sidecar, result.graph))
  }
  return result
}

// === Helpers ===============================================================
//
// Micro-utilities below are exported for consumption by pnpm-family
// adapters that own their own pipelines but share family-internal infra
// (e.g. pnpm-v5 standalone-fit per ADR-0022). They are NOT part of the
// interop surface — they remain prefixed-private (`_pnpm-flat-core`) by
// module-naming convention.

export function normalizeLineEndings(input: string): string {
  return input.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

export const cmpStr = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0

export function sortRecord<T>(record: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {}
  for (const key of Object.keys(record).sort(cmpStr)) {
    const v = record[key]
    if (v !== undefined) out[key] = v
  }
  return out
}

export function isPlainObject(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

interface ParsedPackagesOrSnapshotKey {
  name: string
  version: string
  peers: Array<{ name: string; version: string; nested: string }>
  /**
   * ADR-0030 — bare-hex HASHED PEER-SET tokens from the key's `(...)` suffix.
   * pnpm-v9 abbreviates a long resolved peer-set into a single bare-hex digest
   * segment (e.g. `(53b8fd9b7f33abb48dff18614cf85bde)`); the real peers are
   * hidden inside the hash, so the token is OPAQUE and NON-EDGE-BEARING — it
   * generates no peer edge but MUST ride through the NodeId as an identity
   * discriminator, otherwise two virtual-store instances of the same
   * `name@version` (forking on a transitive peer like `@types/node`) collapse
   * to one NodeId and their divergent dep edges collide. Kept distinct from
   * `peers` precisely because it produces no edge.
   */
  opaquePeers: string[]
}

/**
 * True when a depth-0 suffix segment is a pnpm LABELLED PATCH-HASH marker —
 * exactly the `patch_hash=<sha256-hex>` spelling pnpm v9 injects when a
 * `patchedDependencies:` patch applies (e.g.
 * `@astrojs/starlight@…(patch_hash=…)`). A real peer always carries a
 * `name@version` (a depth-0 `@`); a labelled patch never does.
 *
 * ADR-0030 — this is now the LABELLED half ONLY. The bare-hex spelling
 * (`(53b8fd9b…)`) is NO LONGER read as a patch: it is the pnpm-v9 hashed
 * PEER-SET token, classified by the inverse predicate `isHashedPeerSetToken`
 * (single-sourced in `recipe/patch.ts` so the patch ∣ peer-set boundary cannot
 * drift). The two predicates partition the bare-hex space disjointly: this one
 * matches `patch_hash=`-prefixed, that one matches the bare-hex body — the
 * caller dispatches on the labelled-vs-bare distinction. The labelled-vs-bare
 * split is sufficient for the corpus (every real patch is `patch_hash=<64hex>`;
 * bare-hex is always a peer-set). FUTURE GUARD: were pnpm ever to emit a BARE
 * patch digest, a `patchedDependencies:`-block membership tie-breaker would
 * disambiguate — not implemented here (no corpus need, and it is non-trivial
 * block-parsing).
 */
function isPatchHashSegment(segBase: string): boolean {
  return segBase.startsWith('patch_hash=')
}

/**
 * Parse a `<name>@<version>` or `<name>@<version>(peer@v)(peer2@v2)…` key.
 * Scoped names (leading `@`) retained verbatim; the split uses the LAST
 * `@` at depth 0.
 *
 * Caller is expected to have stripped any leading `/` for v6 keys before
 * passing.
 */
function parsePackagesOrSnapshotKey(key: string): ParsedPackagesOrSnapshotKey | undefined {
  // Split off optional `(...)` peer suffix.
  let baseEnd = key.length
  let depth = 0
  for (let i = 0; i < key.length; i++) {
    const c = key[i]
    if (c === '(' && depth === 0) {
      baseEnd = i
      break
    }
    if (c === '(') depth++
    else if (c === ')') depth--
  }
  const base = key.slice(0, baseEnd)
  const peerSuffix = key.slice(baseEnd)

  let lastAt = -1
  for (let i = 1; i < base.length; i++) {
    if (base[i] === '@') lastAt = i
  }
  if (lastAt <= 0) return undefined
  const name = base.slice(0, lastAt)
  const version = base.slice(lastAt + 1)
  if (name.length === 0 || version.length === 0) return undefined

  const parsed = parsePeerSuffix(peerSuffix)
  if (parsed === undefined) return undefined

  return { name, version, peers: parsed.peers, opaquePeers: parsed.opaquePeers }
}

/**
 * Parse a `(peer@v)(peer2@v2(sub@v))…` suffix into its depth-0 peer records
 * plus the bare-hex HASHED PEER-SET tokens (`opaquePeers`, ADR-0030). Each peer
 * record carries the peer's BASE `name@version` plus its OWN nested suffix
 * (`nested`, e.g. `(esbuild@0.26.0)` or '' for a leaf). Returns `undefined` on
 * a malformed suffix (caller treats as unparseable key).
 *
 * `nested` is CARRIED (not dropped) so it can flow into BOTH the consumer's
 * peerContext token (buildPeerContext) and the peer edge's full target NodeId
 * (#70): two virtual-store instances of one consumer that differ ONLY in a
 * transitive peer's resolution thus stay DISTINCT NodeIds — without it they
 * collapse to one NodeId carrying two edges to the same dep name
 * (unrepresentable → LAYOUT_RESOLVE_VIOLATION). `opaquePeers` (#69) is carried
 * for the same reason but is NON-EDGE-BEARING (the hash hides its peers). The
 * seal (graph.ts) reconciles peerContext token vs edge target by BASE-KEY
 * projection (ADR-0017), so a carried nested suffix is invisible to it, and an
 * opaque hash token is exempted (isHashedPeerSetToken).
 */
interface ParsedPeerSuffix {
  readonly peers: Array<{ name: string; version: string; nested: string }>
  readonly opaquePeers: string[]
}

interface PeerSuffixSegment {
  readonly value: string
  readonly nextPos: number
}

type ClassifiedPeerSuffixSegment =
  | { readonly kind: 'patch' }
  | { readonly kind: 'opaque'; readonly value: string }
  | { readonly kind: 'peer'; readonly value: { name: string; version: string; nested: string } }
  | { readonly kind: 'invalid' }

function parsePeerSuffix(peerSuffix: string): ParsedPeerSuffix | undefined {
  const peers: ParsedPeerSuffix['peers'] = []
  const opaquePeers: string[] = []
  let pos = 0
  while (pos < peerSuffix.length) {
    const segment = readPeerSuffixSegment(peerSuffix, pos)
    if (segment === undefined) return undefined
    pos = segment.nextPos
    const classified = classifyPeerSuffixSegment(segment.value)
    if (classified.kind === 'invalid') return undefined
    if (classified.kind === 'opaque') opaquePeers.push(classified.value)
    if (classified.kind === 'peer') peers.push(classified.value)
  }
  return { peers, opaquePeers }
}

function readPeerSuffixSegment(peerSuffix: string, pos: number): PeerSuffixSegment | undefined {
  if (peerSuffix[pos] !== '(') return undefined
  let depth = 1
  for (let i = pos + 1; i < peerSuffix.length; i++) {
    if (peerSuffix[i] === '(') depth++
    if (peerSuffix[i] !== ')') continue
    depth--
    if (depth === 0) return { value: peerSuffix.slice(pos + 1, i), nextPos: i + 1 }
  }
  return undefined
}

function classifyPeerSuffixSegment(segment: string): ClassifiedPeerSuffixSegment {
  const baseEnd = firstNestedPeerIndex(segment)
  const base = segment.slice(0, baseEnd)
  if (isPatchHashSegment(base)) return { kind: 'patch' }
  if (isHashedPeerSetToken(base)) return { kind: 'opaque', value: base }
  const separator = lastPeerSeparator(base)
  if (separator <= 0) return { kind: 'invalid' }
  const name = base.slice(0, separator)
  const version = base.slice(separator + 1)
  if (name.length === 0 || version.length === 0) return { kind: 'invalid' }
  return { kind: 'peer', value: { name, version, nested: segment.slice(baseEnd) } }
}

function firstNestedPeerIndex(segment: string): number {
  let depth = 0
  for (let i = 0; i < segment.length; i++) {
    if (segment[i] === '(' && depth === 0) return i
    if (segment[i] === '(') depth++
    else if (segment[i] === ')') depth--
  }
  return segment.length
}

function lastPeerSeparator(base: string): number {
  let separator = -1
  for (let i = 1; i < base.length; i++) {
    if (base[i] === '@') separator = i
  }
  return separator
}

function stripPackagesKeyPrefix(key: string, packagesKeyShape: PnpmLayoutShape['packagesKeyShape']): string {
  if (packagesKeyShape === 'slash-leading-at' && key.startsWith('/')) return key.slice(1)
  return key
}

function applyPackagesKeyPrefix(stripped: string, packagesKeyShape: PnpmLayoutShape['packagesKeyShape']): string {
  if (packagesKeyShape === 'slash-leading-at') return `/${stripped}`
  return stripped
}

function packagesKeyForNode(
  node: Node,
  shape: PnpmLayoutShape,
  projection: PnpmWorkspacePeerProjection,
): string {
  // v9 collapses peer-virt onto bare key. v6 carries peer-context on the key.
  const bare = `${node.name}@${node.version}`
  if (shape.peerContextLocation === 'snapshots-keys') return bare
  // v6 — append peer-context if present (workspace tokens map to their native locator).
  const suffix = node.peerContext.length === 0
    ? ''
    : nativePeerSuffix(node.peerContext, node.id, projection)
  return applyPackagesKeyPrefix(bare + suffix, shape.packagesKeyShape)
}

function pnpmPackageNode(
  name: string,
  version: string,
  peerContext: string[],
  nodeId: string,
  patch: string | undefined,
): Node {
  const node: Node = { id: nodeId, name, version, peerContext }
  if (patch !== undefined) node.patch = patch
  return node
}

function pnpmPeerDependenciesMeta(value: unknown): Record<string, { optional?: boolean }> | undefined {
  if (!isPlainObject(value)) return undefined
  const meta: Record<string, { optional?: boolean }> = {}
  for (const [peerName, entry] of Object.entries(value)) {
    if (isPlainObject(entry) && typeof entry.optional === 'boolean') {
      meta[peerName] = { optional: entry.optional }
    }
  }
  return Object.keys(meta).length > 0 ? meta : undefined
}

function pnpmNodeSidecar(pkgEntry: unknown): PnpmNodeSidecar {
  const nodeSc: PnpmNodeSidecar = {}
  if (!isPlainObject(pkgEntry)) return nodeSc
  if (isPlainObject(pkgEntry.peerDependencies)) {
    nodeSc.peerDependencies = { ...(pkgEntry.peerDependencies as Record<string, string>) }
  }
  const peerDependenciesMeta = pnpmPeerDependenciesMeta(pkgEntry.peerDependenciesMeta)
  if (peerDependenciesMeta !== undefined) nodeSc.peerDependenciesMeta = peerDependenciesMeta
  if (isPlainObject(pkgEntry.engines)) {
    nodeSc.engines = { ...(pkgEntry.engines as Record<string, string>) }
  }
  if (pkgEntry.hasBin === true) nodeSc.hasBin = true
  if (Array.isArray(pkgEntry.os)) nodeSc.os = (pkgEntry.os as string[]).slice()
  if (Array.isArray(pkgEntry.cpu)) nodeSc.cpu = (pkgEntry.cpu as string[]).slice()
  if (Array.isArray(pkgEntry.libc)) nodeSc.libc = (pkgEntry.libc as string[]).slice()
  return nodeSc
}

function pnpmPackagePayload(
  pkgEntry: unknown,
  nodeId: string,
  diagnostics: Diagnostic[],
  nodeSc: PnpmNodeSidecar,
): TarballPayload {
  const payload = tarballPayloadOf(pkgEntry, nodeId, diagnostics) ?? {}
  if (nodeSc.peerDependencies !== undefined) {
    payload.peerDependencies = { ...nodeSc.peerDependencies }
  }
  if (nodeSc.peerDependenciesMeta !== undefined) {
    payload.peerDependenciesMeta = Object.fromEntries(Object.entries(nodeSc.peerDependenciesMeta)
      .map(([peerName, meta]) => [peerName, { ...meta }]))
  }
  return payload
}

function addPackageNode(
  builder: ReturnType<typeof newBuilder>,
  sidecar: PnpmSidecar,
  name: string,
  version: string,
  peerContext: string[],
  nodeId: string,
  pkgEntry: unknown,
  diagnostics: Diagnostic[],
  patch?: string,
): void {
  builder.addNode(pnpmPackageNode(name, version, peerContext, nodeId, patch))
  const nodeSc = pnpmNodeSidecar(pkgEntry)
  sidecar.nodes.set(nodeId, nodeSc)
  const payload = pnpmPackagePayload(pkgEntry, nodeId, diagnostics, nodeSc)
  if (Object.keys(payload).length > 0) {
    builder.setTarball({ name, version, patch }, payload)
  }
}

interface ResolvedTreeEdgeInput {
  readonly srcId: string
  readonly entry: Record<string, unknown>
  readonly peers: Array<{ name: string; version: string; nested: string }>
}

interface ResolvedDependencyTarget {
  readonly targetId: string
  readonly aliasSlot: string | undefined
}

interface ParsedDependencyEdgeInput {
  readonly srcId: string
  readonly kind: EdgeKind
  readonly depName: string
  readonly rawValue: string
}

function addResolvedTreeEdges(
  context: PnpmParseContext,
  emittedEdges: Map<string, Set<string>>,
  input: ResolvedTreeEdgeInput,
): void {
  const wired = wiredEdgesFor(emittedEdges, input.srcId)
  addResolvedDependencyEdges(context, wired, input)
  addResolvedPeerEdges(context, wired, input)
}

function wiredEdgesFor(emittedEdges: Map<string, Set<string>>, srcId: string): Set<string> {
  let wired = emittedEdges.get(srcId)
  if (wired === undefined) {
    wired = new Set<string>()
    emittedEdges.set(srcId, wired)
  }
  return wired
}

function addResolvedDependencyEdges(
  context: PnpmParseContext,
  wired: Set<string>,
  input: ResolvedTreeEdgeInput,
): void {
  for (const [kind, blockName] of [
    ['dep', 'dependencies'],
    ['optional', 'optionalDependencies'],
  ] as const) {
    const block = input.entry[blockName]
    if (!isPlainObject(block)) continue
    for (const [depName, rawValue] of Object.entries(block).sort((a, b) => cmpStr(a[0], b[0]))) {
      if (typeof rawValue === 'string') {
        addResolvedDependencyEdge(context, wired, { srcId: input.srcId, kind, depName, rawValue })
      }
    }
  }
}

function addResolvedDependencyEdge(
  context: PnpmParseContext,
  wired: Set<string>,
  input: ParsedDependencyEdgeInput,
): void {
  const target = resolveParsedDependencyTarget(context, input.depName, input.rawValue)
  if (target === undefined) {
    context.diagnostics.push({
      code: 'PNPM_UNRESOLVED_DEP',
      severity: 'warning',
      subject: input.srcId,
      message: `pnpm-v${context.shape.lockfileVersion.split('.')[0]}: ${input.srcId} dep ${input.depName}@${input.rawValue} resolves to no snapshot`,
    })
    return
  }
  if (!reserveResolvedEdge(wired, input.kind, target.targetId, target.aliasSlot)) return
  const attrs: { range: string; alias?: string } = { range: input.rawValue }
  if (target.aliasSlot !== undefined) attrs.alias = target.aliasSlot
  addParsedResolvedEdge(context.builder, input.srcId, target.targetId, input.kind, attrs)
}

function resolveParsedDependencyTarget(
  context: PnpmParseContext,
  depName: string,
  rawValue: string,
): ResolvedDependencyTarget | undefined {
  const direct = resolveSnapshotTarget(
    context.seenIds,
    depName,
    rawValue,
    context.sidecar.importerByPath,
  )
  if (direct !== undefined) return { targetId: direct, aliasSlot: undefined }
  const alias = resolveAliasedSnapshotTarget(
    context.seenIds,
    rawValue,
    context.sidecar.importerByPath,
  )
  return alias === undefined ? undefined : { targetId: alias, aliasSlot: depName }
}

function reserveResolvedEdge(
  wired: Set<string>,
  kind: EdgeKind,
  dst: string,
  alias: string | undefined,
): boolean {
  const key = `${kind}\0${dst}\0${alias ?? ''}`
  if (wired.has(key)) return false
  wired.add(key)
  return true
}

function addParsedResolvedEdge(
  builder: ReturnType<typeof newBuilder>,
  src: string,
  dst: string,
  kind: EdgeKind,
  attrs: EdgeAttrs,
): void {
  try {
    builder.addEdge(src, dst, kind, attrs)
  } catch (error) {
    if (!(error instanceof GraphError && error.code === 'INVARIANT_VIOLATION')) throw error
  }
}

function addResolvedPeerEdges(
  context: PnpmParseContext,
  wired: Set<string>,
  input: ResolvedTreeEdgeInput,
): void {
  for (const peer of input.peers) addResolvedPeerEdge(context, wired, input.srcId, peer)
}

function addResolvedPeerEdge(
  context: PnpmParseContext,
  wired: Set<string>,
  srcId: string,
  peer: { name: string; version: string; nested: string },
): void {
  const workspaceId = resolveWorkspacePeerId(peer.version, context.sidecar.importerByPath)
  if (workspaceId !== undefined) {
    addResolvedWorkspacePeerEdge(context, wired, srcId, workspaceId, peer)
    return
  }
  const fullVersion = peer.version + normalizeNestedSuffix(peer.nested, context.sidecar.importerByPath)
  const peerNodeId = resolvePeerTargetById(context.seenIds, peer.name, fullVersion)
  if (peerNodeId === undefined) {
    context.diagnostics.push({
      code: 'PNPM_UNRESOLVED_DEP',
      severity: 'warning',
      subject: srcId,
      message: `pnpm-v${context.shape.lockfileVersion.split('.')[0]}: ${srcId} peer ${peer.name}@${fullVersion} resolves to no snapshot`,
    })
    return
  }
  if (!reserveResolvedEdge(wired, 'peer', peerNodeId, undefined)) return
  addParsedResolvedEdge(
    context.builder,
    srcId,
    peerNodeId,
    'peer',
    parsedPeerAttrs(context.sidecar, srcId, peer),
  )
}

function addResolvedWorkspacePeerEdge(
  context: PnpmParseContext,
  wired: Set<string>,
  srcId: string,
  workspaceId: string,
  peer: { name: string; version: string; nested: string },
): void {
  recordWorkspacePeerAttribution(context, srcId, workspaceId, peer)
  if (!reserveResolvedEdge(wired, 'peer', workspaceId, undefined)) return
  addParsedResolvedEdge(
    context.builder,
    srcId,
    workspaceId,
    'peer',
    parsedPeerAttrs(context.sidecar, srcId, peer),
  )
}

function recordWorkspacePeerAttribution(
  context: PnpmParseContext,
  srcId: string,
  workspaceId: string,
  peer: { name: string; version: string },
): void {
  const key = `${srcId}\0${workspaceId}`
  const prior = [...context.sidecar.workspacePeerNames]
    .find(([candidate]) => candidate === key)?.[1]
  if (prior === undefined) {
    context.sidecar.workspacePeerNames.set(key, { name: peer.name, locator: peer.version })
    return
  }
  if (prior.name === peer.name && prior.locator === peer.version) return
  context.sidecar.workspacePeerCollisions.add(key)
  context.diagnostics.push({
    code: 'PNPM_WORKSPACE_PEER_ATTR_COLLISION',
    severity: 'warning',
    subject: srcId,
    message: `pnpm-v${context.shape.lockfileVersion.split('.')[0]}: workspace-peer attribution collision on ${srcId} → ${workspaceId}: ${prior.name}@${prior.locator} vs ${peer.name}@${peer.version} (emit keeps the first — distinct sub-dir publishes projected onto one ancestor node)`,
  })
}

function parsedPeerAttrs(
  sidecar: PnpmSidecar,
  srcId: string,
  peer: { name: string; version: string },
): EdgeAttrs {
  const sc = sidecar.nodes.get(srcId)
  const attrs: EdgeAttrs = { range: sc?.peerDependencies?.[peer.name] ?? peer.version }
  if (sc?.peerDependenciesMeta?.[peer.name]?.optional === true) attrs.optional = true
  return attrs
}

function isCollapsedRoot(yaml: Record<string, unknown>, shape: PnpmLayoutShape): boolean {
  if (shape.topLevelShape !== 'dependencies-collapsed') return false
  // Collapsed root iff there is no `importers` block AND there is at least
  // one top-level dep block (or empty stylé — treat as collapsed root).
  if (yaml.importers !== undefined) return false
  return yaml.dependencies !== undefined || yaml.devDependencies !== undefined || yaml.optionalDependencies !== undefined
}

function buildCollapsedRootImporter(yaml: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (yaml.dependencies !== undefined) out.dependencies = yaml.dependencies
  if (yaml.devDependencies !== undefined) out.devDependencies = yaml.devDependencies
  if (yaml.optionalDependencies !== undefined) out.optionalDependencies = yaml.optionalDependencies
  return out
}

/**
 * Resolve a snapshot target by `<depName>@<rawValue>` where rawValue is the
 * resolved-snapshot-key tail (bare `<version>` or `<version>(<peer>@...)`).
 */
function resolveSnapshotTarget(
  seenIds: Set<string>,
  depName: string,
  rawValue: string,
  importerByPath: Map<string, string>,
): string | undefined {
  const parsedTail = parsePackagesOrSnapshotKey(`${depName}@${rawValue}`)
  if (parsedTail === undefined) return undefined
  // buildPeerContext drops workspace peers, embeds each surviving peer's
  // recursively-normalised nested suffix (#70), and appends the bare-hex
  // HASHED PEER-SET token(s) (#69/ADR-0030) — the exact form the target node id
  // carries, so a dep value whose target is hash- or transitive-peer-
  // discriminated resolves to the now-distinct node rather than collapsing onto
  // the bare key.
  const peerContext = buildPeerContext(parsedTail.peers, importerByPath, parsedTail.opaquePeers)
  const candidateId = serializeNodeId(parsedTail.name, parsedTail.version, peerContext)
  if (seenIds.has(candidateId)) return candidateId
  const bareId = `${parsedTail.name}@${parsedTail.version}`
  if (seenIds.has(bareId)) return bareId
  return undefined
}

/**
 * Try to resolve a snapshot target when the dep value embeds the canonical
 * `<name>@<version>` (npm-alias case). Returns undefined when the raw value
 * is a bare semver.
 */
function resolveAliasedSnapshotTarget(
  seenIds: Set<string>,
  rawValue: string,
  importerByPath: Map<string, string>,
): string | undefined {
  // `rawValue` must contain an `@` past position 0 (scoped names) to be
  // a `<name>@<version>` shape. parsePackagesOrSnapshotKey requires at
  // least one non-leading `@`.
  if (rawValue.length < 2) return undefined
  const hasInteriorAt = rawValue.indexOf('@', 1) > 0
  if (!hasInteriorAt) return undefined
  const parsed = parsePackagesOrSnapshotKey(rawValue)
  if (parsed === undefined) return undefined
  // buildPeerContext — drop workspace peers, embed normalised nested (#70),
  // append hashed peer-set token(s) (#69/ADR-0030). See resolveSnapshotTarget.
  const peerContext = buildPeerContext(parsed.peers, importerByPath, parsed.opaquePeers)
  const candidateId = serializeNodeId(parsed.name, parsed.version, peerContext)
  if (seenIds.has(candidateId)) return candidateId
  const bareId = `${parsed.name}@${parsed.version}`
  if (seenIds.has(bareId)) return bareId
  return undefined
}

/**
 * Resolve a `<peerName>@<peerVersion>` reference to a known node id —
 * either the bare id or a parenthesised peer-virt instance. Used by both
 * v9 snapshot edges and v5 peer edges from `packages` entries.
 *
 * `peerVersion` may be a BARE version (`8.0.8`, v5 / leaf peers) or a FULL
 * peer-virt form carrying the consumer's recorded nested suffix
 * (`8.0.8(@types/node@…)(esbuild@0.26.0)…`, v9 #70). Resolution order:
 *   1. EXACT match on the full form — selects the precise virtual-store
 *      instance when the consumer's suffix equals the target node's id (the
 *      directus `vite` #70 case: two `vite@8.0.8(…)` siblings differing only
 *      in `esbuild`, each spelled in full on the consumer).
 *   2. EXACT match on the bare base.
 *   3. PREFIX scan on the bare base (`base@ver(`) — first match. pnpm records
 *      only a SUBSET of a peer's transitive peers on a consumer's reference
 *      (e.g. supabase's `next@16.2.6(…)` ref omits the target's
 *      `babel-plugin-macros@3.1.0`), so the full form may match no node id.
 *      The bare prefix scan still wires the edge to a real instance, keeping
 *      the peer-edge ↔ peerContext base-key bijection (the seal, ADR-0017)
 *      intact — the seal compares BASE keys, so any same-base instance
 *      satisfies it. A consumer carries at most one peer per name, so this
 *      cannot collapse two distinct same-name peers (that #70 hazard lives in
 *      the `dependencies` block, fixed by the peerContext token carrying the
 *      suffix — not here).
 */
export function resolvePeerTargetById(seenIds: Set<string>, peerName: string, peerVersion: string): string | undefined {
  const fullId = `${peerName}@${peerVersion}`
  if (seenIds.has(fullId)) return fullId
  // Strip any nested suffix to recover the bare base key for the fallbacks.
  const suffixStart = peerVersion.indexOf('(')
  const bareVersion = suffixStart === -1 ? peerVersion : peerVersion.slice(0, suffixStart)
  const bareId = `${peerName}@${bareVersion}`
  if (bareId !== fullId && seenIds.has(bareId)) return bareId
  // Last resort — a same-base peer-virt instance (partial peer-set references,
  // e.g. a dep reference omitting a peer the target carries). Any same-base
  // instance satisfies the seal's base-key projection, but the pick MUST be
  // deterministic (ADR-0007): take the lexicographically smallest match, not
  // the first in `seenIds` insertion order (which flips on benign lock
  // re-orderings). Single pass — no full-set sort.
  const prefix = bareId + '('
  let best: string | undefined
  for (const id of seenIds) {
    if (id.startsWith(prefix) && (best === undefined || id < best)) best = id
  }
  return best
}

/**
 * #8b-A — workspace-peer detection. pnpm encodes a peer that is satisfied by a
 * workspace importer by stuffing the importer directory into the peer's
 * version slot with `/` → `+` (e.g. `vue@packages+vue` → importer dir
 * `packages/vue`, materialised in the snapshot's `dependencies` as
 * `vue: link:packages/vue`). Such a peer's true target is the synthesised
 * importer member node (`packages/vue@0.0.0`).
 *
 * Returns the canonical importer member NodeId when `peerVersion` decodes to a
 * known workspace path, otherwise `undefined`.
 */
export function resolveWorkspacePeerId(
  peerVersion: string,
  importerByPath: Map<string, string>,
): string | undefined {
  let path = peerVersion.replace(/\+/g, '/')
  const exact = importerByPath.get(path)
  if (exact !== undefined) return exact
  // A workspace package may be published from a SUB-DIRECTORY of its importer —
  // e.g. a package published from a sub-dir encodes `packages+<name>+build`
  // (`packages/<name>/build`) while the importer is `packages/<name>`.
  // Walk up to the nearest ANCESTOR importer. Never match the root `.` (it
  // prefixes every path); a real semver `+build` tail simply finds no importer.
  while (path.includes('/')) {
    path = path.slice(0, path.lastIndexOf('/'))
    if (path.length === 0 || path === '.') break
    const ancestor = importerByPath.get(path)
    if (ancestor !== undefined) return ancestor
  }
  return undefined
}

/**
 * Recursively normalise a peer's `(...)` nested suffix into the form the
 * peer's own node id carries. Workspace locators are replaced recursively with
 * canonical workspace node ids so each token matches the referenced identity.
 */
function normalizeNestedSuffix(nested: string, importerByPath: Map<string, string>): string {
  if (nested.length === 0) return ''
  const sub = parsePeerSuffix(nested)
  if (sub === undefined) return nested // unparseable — leave verbatim
  const tokens = buildPeerContext(sub.peers, importerByPath, sub.opaquePeers)
  return tokens.map(t => `(${t})`).join('')
}

/**
 * Build the ADR-0006 peerContext for a node from its parsed suffix peers.
 * Workspace peers become canonical workspace node ids. A registry peer keeps
 * `name@version` plus its recursively-normalised nested suffix so two
 * consumer instances that differ only in a transitive peer's resolution stay
 * distinct NodeIds. The seal (graph.ts) reconciles this token against the peer
 * edge target by BASE-KEY projection (ADR-0017), which strips the nested
 * suffix on both sides — so carrying it here does not break peer-edge ↔
 * peerContext coherence.
 *
 * ADR-0030 — bare-hex HASHED PEER-SET tokens (`opaquePeers`) are APPENDED to
 * the context, then the whole list is sorted (caller contract). They are
 * NON-EDGE-BEARING: the peer-edge loop iterates `peers` only, never these, so a
 * hashed token contributes an identity discriminator without a peer edge. The
 * seal exempts them from its peerContext↔edge coherence check via
 * `isHashedPeerSetToken`. They ride through `serializeNodeId` verbatim, so emit
 * reproduces the original bare-hex key.
 *
 * NB the workspace mapping checks the base `version` only: `resolveWorkspacePeerId`
 * decodes a `+`-encoded importer dir, and a nested `(...)` suffix would break
 * that detection.
 */
function buildPeerContext(
  peers: Array<{ name: string; version: string; nested: string }>,
  importerByPath: Map<string, string>,
  opaquePeers: readonly string[] = [],
): string[] {
  // A workspace peer becomes the canonical workspace node id, backed by a real `peer`
  // edge (every token stays edge-bearing); a registry peer keeps `name@version` plus its
  // normalised nested suffix. The native locator is reconstructed at emit, not here.
  const contextPeers = peers.map(p => {
    const wsId = resolveWorkspacePeerId(p.version, importerByPath)
    return wsId ?? `${p.name}@${p.version}${normalizeNestedSuffix(p.nested, importerByPath)}`
  })
  return [...contextPeers, ...opaquePeers].sort()
}

function importerSpec(value: unknown): { specifier?: string; version: string } | undefined {
  if (typeof value === 'string') return { version: value }
  if (!isPlainObject(value)) return undefined
  const version = value.version
  if (typeof version !== 'string') return undefined
  const specifier = typeof value.specifier === 'string' ? value.specifier : undefined
  return { specifier, version }
}

export function resolveLinkPath(importerPath: string, relTarget: string): string {
  if (importerPath === '.' || importerPath === '') {
    return relTarget.replace(/^\.\//, '').replace(/^\.\.\//, '')
  }
  const stack = importerPath.split('/').filter(s => s.length > 0)
  const targetSegs = relTarget.split('/').filter(s => s.length > 0)
  for (const seg of targetSegs) {
    if (seg === '.') continue
    if (seg === '..') stack.pop()
    else stack.push(seg)
  }
  return stack.join('/')
}

/**
 * Build a `TarballPayload` from a pnpm `packages[<id>]` entry. Returns
 * `undefined` when no derivable payload fields are present (verbatim
 * `setTarball` skip semantics). Shared across pnpm-family adapters.
 */
export function tarballPayloadOf(
  entry: unknown,
  subject: string,
  diagnostics: Diagnostic[],
): TarballPayload | undefined {
  if (!isPlainObject(entry)) return undefined
  const payload: TarballPayload = {}
  const resolution = entry.resolution
  if (isPlainObject(resolution) && typeof resolution.integrity === 'string') {
    const integrity = parseSri(resolution.integrity, 'sri')
    if (isEmptyIntegrity(integrity)) {
      diagnostics.push(invalidIntegrityDiagnostic('PNPM', subject, resolution.integrity))
    } else {
      payload.integrity = integrity
    }
  }
  // ADR-0014 §4.F3 — canonical resolution from pnpm `resolution:` block.
  // Workspace canonical lives on Node.workspacePath; not on TarballPayload.
  if (isPlainObject(resolution)) {
    if (typeof resolution.tarball === 'string') {
      // ADR-0013 — PM-native verbatim sidecar, per-tarball. Replayed at
      // same-format stringify + patch-path retrieval.
      payload.nativeResolution = resolution.tarball
      const canonical = parseResolutionRecipe(resolution.tarball, { sourceKind: 'pnpm-tarball' })
      if (canonical.type === 'unknown') {
        diagnostics.push(unknownResolutionDiagnostic(subject, resolution.tarball))
      }
      payload.resolution = canonical
    } else if (typeof resolution.directory === 'string') {
      payload.resolution = { type: 'directory', path: resolution.directory }
    } else if (typeof resolution.integrity === 'string') {
      // Per ADR-0014 §4.F3 pnpm row: `{integrity: …}` shape implies a registry
      // tarball; URL is derived by convention from name@version (the subject
      // is `<name>@<version>` per the pnpm packages-block key form).
      const derived = deriveRegistryTarballFromSubject(subject)
      if (derived !== undefined) payload.resolution = { type: 'tarball', url: derived }
    }
  }
  if (isPlainObject(entry.engines)) {
    payload.engines = { ...(entry.engines as Record<string, string>) }
  }
  if (Array.isArray(entry.cpu)) payload.cpu = (entry.cpu as string[]).slice()
  if (Array.isArray(entry.os)) payload.os = (entry.os as string[]).slice()
  if (Array.isArray(entry.libc)) payload.libc = (entry.libc as string[]).slice()
  if (entry.hasBin === true) payload.bin = 'true'
  if (typeof entry.deprecated === 'string') payload.deprecated = entry.deprecated
  return Object.keys(payload).length === 0 ? undefined : payload
}

// Recognise the pnpm-default registry URL convention for a (name, version).
// pnpm treats `https://registry.npmjs.org/<n>/-/<tail>-<v>.tgz` as the
// implicit canonical for a `resolution: {integrity: …}`-only entry; emitting
// it back would diverge from pnpm-native output, so the stringify side
// suppresses the URL field when it matches the convention.
function isNpmRegistryDefault(url: string, name: string, version: string): boolean {
  return url === deriveRegistryTarballFromSubject(`${name}@${version}`)
}

// Derive a registry tarball URL from a `<name>@<version>` subject (pnpm
// packages-block key form). Strips peer-virt parens before parsing the
// `<name>@<version>` head so peer-virt sibling NodeIds project onto the
// shared base TarballKey URL.
function deriveRegistryTarballFromSubject(subject: string): string | undefined {
  const base = stripPeerContextFromNodeId(subject)
  const atIdx = base.lastIndexOf('@')
  if (atIdx <= 0) return undefined
  const name    = base.slice(0, atIdx)
  const version = base.slice(atIdx + 1)
  if (name === '' || version === '') return undefined
  const tail = name.startsWith('@') ? name.split('/').slice(1).join('/') : name
  if (tail === '') return undefined
  return `${DEFAULT_NPM_REGISTRY}/${name}/-/${tail}-${version}.tgz`
}

// ADR-0014 §4.F3 — project canonical resolution to pnpm `resolution:` block
// shape for cross-format fallback. Workspace canonical is encoded elsewhere
// (importers/ block); returns undefined here.
function derivePnpmResolutionFromCanonical(
  canonical: ResolutionCanonical | undefined,
): { tarball?: string; directory?: string } | undefined {
  if (canonical === undefined) return undefined
  const out = stringifyForPnpm(canonical)
  if (out === undefined) return undefined
  const result: { tarball?: string; directory?: string } = {}
  if (out.tarball !== undefined) result.tarball = out.tarball
  if (out.directory !== undefined) result.directory = out.directory
  if (out.tarball === undefined && out.directory === undefined && out.extra?.tarball !== undefined) {
    result.tarball = out.extra.tarball
  }
  return result.tarball === undefined && result.directory === undefined ? undefined : result
}

function extractSettings(value: unknown): PnpmSettings {
  const out: PnpmSettings = {}
  if (!isPlainObject(value)) return out
  if (typeof value.autoInstallPeers === 'boolean') out.autoInstallPeers = value.autoInstallPeers
  if (typeof value.excludeLinksFromLockfile === 'boolean') out.excludeLinksFromLockfile = value.excludeLinksFromLockfile
  return out
}

/**
 * Locate the synthetic root importer node for emit. Prefers the sidecar's
 * recorded `rootId`, falls back to `workspacePath === ''`, finally to a
 * sole root. Generic across sidecar shapes — only the `rootId` field is
 * required.
 */
export function locatePnpmRootNode(
  graph: Graph,
  sidecar: { rootId?: string } | undefined,
): Node | undefined {
  if (sidecar?.rootId !== undefined) {
    const node = graph.getNode(sidecar.rootId)
    if (node !== undefined) return node
  }
  for (const node of graph.nodes()) {
    if (node.workspacePath === '') return node
  }
  const roots = Array.from(graph.roots())
  if (roots.length === 1) {
    const id = roots[0]
    if (id !== undefined) return graph.getNode(id)
  }
  return undefined
}

// Emit-time inverse of the workspace mapping: a peerContext token that is a canonical
// workspace node id is rewritten to its recorded native locator. Attribution is keyed by
// (owner, workspace target); a nested token's owner is the enclosing instance `token`
// (its canonical id per #70). A matched workspace token is a leaf.
function unresolvedWorkspacePeer(
  owner: string,
  workspace: string,
  projection: PnpmWorkspacePeerProjection,
): boolean {
  return projection.gaps.some(gap => gap.owner === owner && gap.workspace === workspace)
    || projection.conflicts.some(conflict =>
      conflict.owner === owner && conflict.workspace === workspace)
}

function denormalizeWorkspaceToken(
  token: string,
  ownerId: string,
  projection: PnpmWorkspacePeerProjection,
): string | undefined {
  const base = stripPeerContextFromNodeId(token)
  const attr = projection.attribution.get(`${ownerId}\0${base}`)
  if (attr !== undefined) return `${attr.name}@${attr.locator}`
  if (unresolvedWorkspacePeer(ownerId, base, projection)) return undefined
  const suffix = token.slice(base.length)
  if (suffix.length === 0) return token
  return base + splitTopLevelPeerGroups(suffix).flatMap(group => {
    const restored = denormalizeWorkspaceToken(group, token, projection)
    return restored === undefined ? [] : [`(${restored})`]
  }).join('')
}

function nativePeerSuffix(
  peers: readonly string[],
  ownerId: string,
  projection: PnpmWorkspacePeerProjection,
): string {
  return peers.flatMap(peer => {
    const restored = denormalizeWorkspaceToken(peer, ownerId, projection)
    return restored === undefined ? [] : [`(${restored})`]
  }).join('')
}

// Split a `(g1)(g2)…` peer suffix into its DEPTH-0 groups (nested parens intact).
function splitTopLevelPeerGroups(suffix: string): string[] {
  const groups: string[] = []
  let depth = 0
  let start = -1
  for (let i = 0; i < suffix.length; i++) {
    const c = suffix[i]
    if (c === '(') {
      if (depth === 0) start = i + 1
      depth++
    } else if (c === ')') {
      depth--
      if (depth === 0 && start >= 0) groups.push(suffix.slice(start, i))
    }
  }
  return groups
}

function nodeIdToSnapshotKey(node: Node, projection: PnpmWorkspacePeerProjection): string {
  if (node.peerContext.length === 0) return `${node.name}@${node.version}`
  return `${node.name}@${node.version}${nativePeerSuffix(node.peerContext, node.id, projection)}`
}

// ADR-0028 INV-RESOLVE — the (slot-key, slot-value) pair for one resolved-tree
// dependency edge, in a `snapshots[*].dependencies` / inline `packages[*]`
// block. For a plain dep the slot is `<dst.name>: <version>(<peers>)` — pnpm's
// bare encoding. For an npm-aliased dep (`edge.attrs.alias` set) the slot is
// keyed by the alias descriptor and VALUED with the canonical
// `<dst.name>@<version>(<peers>)`, the form parse's resolveAliasedSnapshotTarget
// reconstructs (`_pnpm-flat-core.ts:1183-1190`). Mirrors the importer-side
// `{ specifier, version }` alias shape (`react-is-cjs: react-is@17.0.2`).
function aliasedSnapshotSlotValue(
  edge: Edge,
  dst: Node,
  projection: PnpmWorkspacePeerProjection,
): { key: string; value: string } {
  const bareValue = nodeIdToImporterVersion(dst, projection)
  const alias = edge.attrs?.alias
  if (alias === undefined) return { key: dst.name, value: bareValue }
  return { key: alias, value: `${dst.name}@${bareValue}` }
}

function buildImporterEntry(
  graph: Graph,
  sidecar: PnpmSidecar | undefined,
  projection: PnpmWorkspacePeerProjection,
  node: Node | undefined,
  importerPath: string,
  overrides: readonly OverrideConstraint[] | undefined,
  workspaceNames: ReadonlyMap<string, string> | undefined,
): YamlMap {
  const entry: YamlMap = {}
  if (node === undefined) return entry

  const blocks: Record<EdgeKind, Record<string, YamlMap>> = {
    dep: {},
    dev: {},
    optional: {},
    peer: {},
    bundled: {},
  }

  for (const edge of graph.out(node.id)) {
    if (edge.kind === 'peer' || edge.kind === 'bundled') continue
    const dst = graph.getNode(edge.dst)
    if (dst === undefined) continue
    const isWorkspaceTarget = dst.workspacePath !== undefined && dst.workspacePath !== ''
    const edgeKey = `${edge.src}\0${edge.kind}\0${edge.dst}\0${edge.attrs?.alias ?? ''}`
    const edgeSc = sidecar?.importerEdges.get(edgeKey)

    // ADR-0028 INV-RESOLVE — key the dep block by the DESCRIPTOR segment
    // (`edge.attrs.alias` when set, else the package name), NOT the resolved
    // package name. An npm-aliased dep (`react-is-cjs: npm:react-is@^17`)
    // emits under its alias slot `react-is-cjs` with the CANONICAL
    // `react-is@17.0.2` version value (the only form parse's
    // resolveAliasedSnapshotTarget resolves). `alias` is set by parse only on
    // the npm-alias path; a bare dep has no alias and falls back to `dst.name`
    // + bare version — byte-unchanged for the non-alias case.
    const slot = aliasedSnapshotSlotValue(edge, dst, projection)
    const isAliased = edge.attrs?.alias !== undefined
    const range = edge.attrs?.range
    // The `importerEdges` sidecar is keyed by the (src,kind,dst) triple, which
    // an aliased and a direct edge to the SAME node SHARE (an npm-aliased
    // `@scope/x-alias` slot alongside the direct dep). The
    // captured `resolvedVersion`/`specifier` can therefore belong to the
    // colliding sibling, so an aliased edge prefers its own per-edge
    // descriptor (`range`) and the computed canonical `slot.value` unless the
    // capture is already alias-consistent (`<dst.name>@…`). Non-aliased edges
    // keep the round-trip-faithful capture verbatim.
    const captureIsAliasConsistent = edgeSc?.resolvedVersion?.startsWith(`${dst.name}@`) === true
    const declaredSpecifier = isAliased
      ? (range ?? edgeSc?.specifier ?? dst.version)
      : (edgeSc?.specifier ?? range ?? dst.version)
    const override = overrides === undefined
      ? undefined
      : governingOverrideFor(
          slot.key,
          [workspaceNames?.get(node.id) ?? node.name],
          overrides,
          declaredSpecifier,
        )
    const specifier = override?.to ?? declaredSpecifier
    const version = isWorkspaceTarget
      ? `link:${relativeImporterPath(importerPath, dst.workspacePath ?? dst.name)}`
      : isAliased
        ? (captureIsAliasConsistent ? edgeSc!.resolvedVersion! : slot.value)
        : (edgeSc?.resolvedVersion ?? slot.value)

    const depBlock = blocks[edge.kind]!
    depBlock[slot.key] = {
      specifier,
      version,
    } as YamlMap
  }

  for (const [kind, blockName] of [
    ['dep', 'dependencies'],
    ['dev', 'devDependencies'],
    ['optional', 'optionalDependencies'],
  ] as const) {
    const block = blocks[kind]
    if (Object.keys(block).length > 0) {
      entry[blockName] = sortRecord(block) as YamlMap
    }
  }

  return entry
}

function nodeIdToImporterVersion(node: Node, projection: PnpmWorkspacePeerProjection): string {
  if (node.peerContext.length === 0) return node.version
  return node.version + nativePeerSuffix(node.peerContext, node.id, projection)
}

export function relativeImporterPath(importerPath: string, targetPath: string): string {
  if (importerPath === '.' || importerPath === '') return targetPath
  const importerSegs = importerPath.split('/').filter(s => s.length > 0)
  const targetSegs = targetPath.split('/').filter(s => s.length > 0)
  let common = 0
  while (common < importerSegs.length && common < targetSegs.length && importerSegs[common] === targetSegs[common]) {
    common++
  }
  const ups = importerSegs.length - common
  const downs = targetSegs.slice(common)
  const parts = Array(ups).fill('..').concat(downs)
  return parts.length === 0 ? '.' : parts.join('/')
}

function buildPackageEntry(
  graph: Graph,
  sidecar: PnpmSidecar | undefined,
  projection: PnpmWorkspacePeerProjection,
  representative: Node,
  shape: PnpmLayoutShape,
): YamlMap {
  const context = createPackageEntryContext(graph, sidecar, projection, representative, shape)
  writePackageResolution(context)
  writePackageMetadata(context)
  writePackagePeerMetadata(context)
  writePackageInlineDependencies(context)
  writePackageDevFlag(context)
  return context.entry
}

interface PackageEntryContext {
  readonly graph: Graph
  readonly sidecar: PnpmSidecar | undefined
  readonly projection: PnpmWorkspacePeerProjection
  readonly representative: Node
  readonly shape: PnpmLayoutShape
  readonly entry: YamlMap
  readonly tarball: TarballPayload | undefined
  readonly nodeSc: PnpmNodeSidecar | undefined
}

function createPackageEntryContext(
  graph: Graph,
  sidecar: PnpmSidecar | undefined,
  projection: PnpmWorkspacePeerProjection,
  representative: Node,
  shape: PnpmLayoutShape,
): PackageEntryContext {
  return {
    graph,
    sidecar,
    projection,
    representative,
    shape,
    entry: {},
    tarball: graph.tarballOf(representative.id),
    nodeSc: sidecar?.nodes.get(representative.id),
  }
}

function writePackageResolution(context: PackageEntryContext): void {
  const { entry, representative, tarball } = context
  const nativeResolution = tarball?.nativeResolution
  const nativeIsPnpmUrl = nativeResolution !== undefined
    && (nativeResolution.startsWith('http://') || nativeResolution.startsWith('https://'))
  const derivedPnpm = derivePnpmResolutionFromCanonical(tarball?.resolution)
  const derivedTarballIsRegistryDefault = tarball?.resolution?.type === 'tarball'
    && isNpmRegistryDefault(tarball.resolution.url, representative.name, representative.version)
  if (tarball !== undefined) {
    const resolution: YamlMap = {}
    const sri = emitSriForRegistry(tarball.integrity, nativeResolution)
    if (sri !== undefined) resolution.integrity = sri
    if (nativeIsPnpmUrl) resolution.tarball = stripRegistrySha1Fragment(nativeResolution!)
    else if (derivedPnpm?.tarball !== undefined && !derivedTarballIsRegistryDefault) {
      resolution.tarball = derivedPnpm.tarball
    } else if (derivedPnpm?.directory !== undefined) {
      resolution.directory = derivedPnpm.directory
    }
    if (Object.keys(resolution).length > 0) entry.resolution = flowMap(resolution)
    return
  }
  if (nativeIsPnpmUrl) entry.resolution = flowMap({ tarball: nativeResolution! })
  else if (derivedPnpm?.tarball !== undefined && !derivedTarballIsRegistryDefault) {
    entry.resolution = flowMap({ tarball: derivedPnpm.tarball })
  } else if (derivedPnpm?.directory !== undefined) {
    entry.resolution = flowMap({ directory: derivedPnpm.directory })
  }
}

function writePackageMetadata(context: PackageEntryContext): void {
  const { entry, nodeSc, tarball } = context
  if (nodeSc?.engines !== undefined && Object.keys(nodeSc.engines).length > 0) {
    entry.engines = flowMap({ ...nodeSc.engines })
  } else if (tarball?.engines !== undefined && Object.keys(tarball.engines).length > 0) {
    entry.engines = flowMap({ ...tarball.engines })
  }
  if (tarball?.deprecated !== undefined && tarball.deprecated !== '') entry.deprecated = tarball.deprecated
  if (nodeSc?.hasBin === true) entry.hasBin = true
  const os = nodeSc?.os ?? tarball?.os
  const cpu = nodeSc?.cpu ?? tarball?.cpu
  const libc = nodeSc?.libc ?? tarball?.libc
  if (os !== undefined && os.length > 0) entry.os = os.slice()
  if (cpu !== undefined && cpu.length > 0) entry.cpu = cpu.slice()
  if (libc !== undefined && libc.length > 0) entry.libc = libc.slice()
  const peerDependencies = nodeSc?.peerDependencies
    ?? context.projection.ownerPeerDependencies.get(context.representative.id)
    ?? tarball?.peerDependencies
  if (peerDependencies !== undefined && Object.keys(peerDependencies).length > 0) {
    entry.peerDependencies = sortRecord(peerDependencies) as YamlMap
  }
}

function writePackagePeerMetadata(context: PackageEntryContext): void {
  const optionalPeers = new Set<string>()
  collectBoundOptionalPeers(context, optionalPeers)
  collectDeclaredOptionalPeers(context.nodeSc?.peerDependenciesMeta, optionalPeers)
  collectDeclaredOptionalPeers(context.tarball?.peerDependenciesMeta, optionalPeers)
  if (optionalPeers.size === 0) return
  const meta: YamlMap = {}
  for (const peerName of Array.from(optionalPeers).sort(cmpStr)) {
    meta[peerName] = { optional: true } as YamlMap
  }
  context.entry.peerDependenciesMeta = meta
}

function collectBoundOptionalPeers(context: PackageEntryContext, optionalPeers: Set<string>): void {
  for (const edge of context.graph.out(context.representative.id)) {
    if (edge.kind !== 'peer' || edge.attrs?.optional !== true) continue
    const dst = context.graph.getNode(edge.dst)
    if (dst !== undefined) optionalPeers.add(dst.name)
  }
}

function collectDeclaredOptionalPeers(
  declared: Record<string, { optional?: boolean }> | undefined,
  optionalPeers: Set<string>,
): void {
  if (declared === undefined) return
  for (const [peerName, meta] of Object.entries(declared)) {
    if (meta.optional === true) optionalPeers.add(peerName)
  }
}

function writePackageInlineDependencies(context: PackageEntryContext): void {
  if (!context.shape.inlineTransitives) return
  const blocks: Record<'dep' | 'optional', Record<string, string>> = { dep: {}, optional: {} }
  for (const edge of context.graph.out(context.representative.id)) {
    addPackageInlineDependency(context, blocks, edge)
  }
  writePackageDependencyBlocks(context.entry, blocks)
}

function addPackageInlineDependency(
  context: PackageEntryContext,
  blocks: Record<'dep' | 'optional', Record<string, string>>,
  edge: Edge,
): void {
  if (edge.kind !== 'dep' && edge.kind !== 'optional') return
  const dst = context.graph.getNode(edge.dst)
  if (dst === undefined || (dst.workspacePath !== undefined && dst.workspacePath !== '')) return
  if (dst.id === context.sidecar?.rootId) return
  const seg = aliasedSnapshotSlotValue(edge, dst, context.projection)
  blocks[edge.kind]![seg.key] = seg.value
}

function writePackageDependencyBlocks(
  entry: YamlMap,
  blocks: Record<'dep' | 'optional', Record<string, string>>,
): void {
  for (const [kind, blockName] of [
    ['dep', 'dependencies'],
    ['optional', 'optionalDependencies'],
  ] as const) {
    const block = blocks[kind]
    if (Object.keys(block).length > 0) entry[blockName] = sortRecord(block) as YamlMap
  }
}

function writePackageDevFlag(context: PackageEntryContext): void {
  if (context.shape.devFlag) context.entry.dev = context.nodeSc?.dev ?? false
}

function buildSnapshotEntry(
  graph: Graph,
  sidecar: PnpmSidecar | undefined,
  projection: PnpmWorkspacePeerProjection,
  node: Node,
): YamlMap {
  const entry: YamlMap = {}

  const blocks: Record<'dep' | 'optional', Record<string, string>> = {
    dep: {},
    optional: {},
  }

  for (const edge of graph.out(node.id)) {
    if (edge.kind !== 'dep' && edge.kind !== 'optional') continue
    const dst = graph.getNode(edge.dst)
    if (dst === undefined) continue
    if (dst.workspacePath !== undefined && dst.workspacePath !== '') continue
    if (dst.id === sidecar?.rootId) continue
    const block = blocks[edge.kind]!
    // ADR-0028 INV-RESOLVE — alias slot keying + canonical value. An aliased
    // dep emits under the alias slot (`react-is-cjs:`) with the CANONICAL
    // `<name>@<version>` value (`react-is@17.0.2`), the only form parse's
    // resolveAliasedSnapshotTarget oracle resolves; a bare dep keeps its bare
    // version under `dst.name` (byte-unchanged).
    const seg = aliasedSnapshotSlotValue(edge, dst, projection)
    block[seg.key] = seg.value
  }

  for (const [kind, blockName] of [['dep', 'dependencies'], ['optional', 'optionalDependencies']] as const) {
    const block = blocks[kind]
    if (Object.keys(block).length > 0) {
      entry[blockName] = sortRecord(block) as YamlMap
    }
  }

  const nodeSc = sidecar?.nodes.get(node.id)
  if (nodeSc?.transitivePeerDependencies !== undefined && nodeSc.transitivePeerDependencies.length > 0) {
    entry.transitivePeerDependencies = nodeSc.transitivePeerDependencies.slice()
  }

  return entry
}

/**
 * Three-branch peer-virt fallback per ADR-0006. Given a peer `peerName`
 * declaration with semver `peerRange`, return all bare (non-peer-virt)
 * nodes whose version satisfies the range. Sorted lexically for stable
 * downstream diagnostics. Exported for pnpm-family adapters that own
 * their own pipelines (e.g. pnpm-v5 standalone-fit).
 */
export function derivePeerCandidates(graph: Graph, peerName: string, peerRange: string): NodeId[] {
  const candidates: NodeId[] = []
  for (const id of graph.byName(peerName)) {
    const node = graph.getNode(id)
    if (node === undefined) continue
    if (node.peerContext.length > 0) continue
    try {
      if (semver.satisfies(node.version, peerRange, { loose: true, includePrerelease: true })) {
        candidates.push(id)
      }
    } catch {
      // Range parsing failed — skip.
    }
  }
  return candidates.sort(cmpStr)
}

// ADR-0014 §4.F2 — parse-side overrides patch extraction.
//
// Scans the pnpm `overrides:` block for entries whose value is a `patch:`
// locator and returns a directive list. Each directive carries the
// verbatim `overrides:` key (preserved per ADR-0011 sentinel-input rule),
// the raw patch value, a parsed `PatchMatcher` per pnpm key grammar
// (bare / range / exact), and a pre-computed canonical sha512-hex when
// source bytes are readable. Per-node resolution walks the directive list,
// returning the canonical hash on match or the ADR-0011 sentinel
// `unresolved-<sha256(<name>@<version>:<literal-key>)>` when bytes are
// unavailable.

/**
 * pnpm override key grammar per ADR-0011 / pnpm docs:
 *   - bare `<name>` — matches every node of that name
 *   - `<name>@<range>` — semver range; matches versions satisfying range
 *   - `<name>@<version>` — exact version; literal match
 * The leading `npm:` protocol prefix on the version-half is accepted and
 * stripped (pnpm permits both `lodash@4.17.21` and `lodash@npm:4.17.21`).
 */
export type PatchMatcher =
  | { readonly kind: 'bare';  readonly name: string }
  | { readonly kind: 'range'; readonly name: string; readonly range: string }
  | { readonly kind: 'exact'; readonly name: string; readonly version: string }

interface PatchDirective {
  /** Verbatim `overrides:` key as written in the lockfile. */
  readonly literalKey: string
  /** Raw value (always starts with `patch:`). */
  readonly rawValue:   string
  /** Matcher derived from `literalKey` per pnpm key grammar. */
  readonly match:      PatchMatcher
  /** Canonical sha512-hex iff patch source bytes were readable at parse. */
  readonly canonical?: string
  /** True iff ADR-0014 §4.F5 byte normalisation altered ≥ 1 source byte
   * (drives per-node `RECIPE_PATCH_NORMALISED` emission). */
  readonly normalised?: boolean
}

function parseOverridePatches(
  overrides: Record<string, string> | undefined,
  workspaceRoot: string | undefined,
): PatchDirective[] {
  const out: PatchDirective[] = []
  if (overrides === undefined) return out
  for (const [literalKey, rawValue] of Object.entries(overrides)) {
    if (typeof rawValue !== 'string' || !rawValue.startsWith('patch:')) continue
    const match = parseOverrideKey(literalKey)
    if (match === undefined) continue
    let canonical: string | undefined
    let normalised: boolean | undefined
    const hashIdx = rawValue.indexOf('#')
    if (hashIdx >= 0 && workspaceRoot !== undefined) {
      const workspacePath = rawValue.slice(hashIdx + 1)
      try {
        const bytes = readWorkspaceFileBytes(workspaceRoot, workspacePath, rawValue)
        if (bytes !== undefined) {
          // ADR-0014 §4.F5 — normalise CRLF / strip leading BOM BEFORE the
          // F2 sha512 fingerprint; track whether ≥ 1 byte changed so per-
          // node `RECIPE_PATCH_NORMALISED` emits at directive-match time.
          // Combined helper avoids double-scan via canonicalHashOfBytes.
          const { hash, normalised: didNormalise } = patchHashAndNormaliseBytes(bytes)
          canonical  = hash
          normalised = didNormalise
        }
      } catch {
        // path-escape / non-regular / etc. — leave canonical undefined →
        // sentinel fallback per ADR-0011.
      }
    }
    out.push({ literalKey, rawValue, match, canonical, normalised })
  }
  return out
}

export function parseOverrideKey(key: string): PatchMatcher | undefined {
  if (key === '') return undefined
  // Scoped names start with `@scope/` — skip the leading `@` when locating
  // the name/spec separator.
  const scoped  = key.startsWith('@')
  const sepIdx  = scoped ? key.indexOf('@', 1) : key.indexOf('@')
  if (sepIdx < 0) {
    return { kind: 'bare', name: key }
  }
  const name = key.slice(0, sepIdx)
  let spec   = key.slice(sepIdx + 1)
  if (name === '' || spec === '') return undefined
  if (spec.startsWith('npm:')) spec = spec.slice('npm:'.length)
  if (spec === '') return undefined
  // semver.valid() normalises the version (strips build metadata), so a
  // literal exact key like `foo@1.2.3+build.1` would lose `+build.1` and
  // fail to match the actual `1.2.3+build.1` node. Use semver.parse() —
  // non-mutating validity check — and keep the verbatim spec.
  if (semver.parse(spec, { loose: true }) !== null) {
    return { kind: 'exact', name, version: spec }
  }
  return { kind: 'range', name, range: spec }
}

export function matcherMatches(m: PatchMatcher, name: string, version: string): boolean {
  if (m.name !== name) return false
  switch (m.kind) {
    case 'bare':  return true
    case 'exact': return m.version === version
    case 'range':
      try {
        // Default semver semantics for override-key range matching: a bare
        // `^1.2.3` MUST NOT pick up `1.3.0-beta.1`. Ranges that explicitly
        // name a prerelease (`^1.2.3-beta`) still match per semver spec.
        return semver.satisfies(version, m.range, { loose: true, includePrerelease: false })
      } catch {
        return false
      }
  }
}

function resolvePatchForNode(
  directives: PatchDirective[],
  name: string,
  version: string,
  nodeId: string,
  diagnostics: Diagnostic[],
): string | undefined {
  for (const dir of directives) {
    if (!matcherMatches(dir.match, name, version)) continue
    if (dir.canonical !== undefined) {
      if (dir.normalised === true) {
        diagnostics.push(patchNormalisedDiagnostic(nodeId))
      }
      return dir.canonical
    }
    // ADR-0011 sentinel input for pnpm: `<name>@<version>:<literal-key>`
    // (verbatim `overrides:` key). Distinct keys collapsing to the same
    // (name, version) yield distinct sentinels per spec.
    return patchSentinelHashOf(`${name}@${version}:${dir.literalKey}`)
  }
  return undefined
}

// ADR-0014 §4.F2 stringify-side: pnpm v6/v9 SUPPORT patch slots via the
// `overrides:` block carrier. When `Node.patch` is set on the graph, the
// adapter ensures the overrides block carries an entry; sidecar.overrides
// attribution wins when present, else a default entry is synthesised from
// `Node.resolution` (preserves cross-format conversion's source-side
// path) or from a generic per-hash convention.
function synthesiseOverridePatches(
  graph: Graph,
  sidecar: PnpmSidecar | undefined,
): Record<string, string> {
  const out: Record<string, string> = { ...(sidecar?.overrides ?? {}) }
  const seenForNode = new Set<string>()
  for (const node of graph.nodes()) {
    if (node.patch === undefined || seenForNode.has(node.id)) continue
    seenForNode.add(node.id)
    // Sidecar entry already covers this node via ANY admissible pnpm key
    // shape (bare / range / exact, with or without `npm:` protocol) — skip
    // synthesis. Reuse the parse-side matcher so the membership test
    // mirrors the grammar accepted at parse.
    if (Object.entries(out).some(([k, v]) => {
      if (typeof v !== 'string' || !v.startsWith('patch:')) return false
      const m = parseOverrideKey(k)
      return m !== undefined && matcherMatches(m, node.name, node.version)
    })) continue
    const overrideKey = `${node.name}@npm:${node.version}`
    const sourcePath = patchPathOfResolution(graph.tarballOf(node.id)?.nativeResolution) ?? `./.lockfile-patches/${node.patch}.patch`
    const encodedSpec = `${encodeURIComponent(node.name)}@npm%3A${encodeURIComponent(node.version)}`
    out[overrideKey] = `patch:${encodedSpec}#${sourcePath}`
  }
  return out
}

// Extract the workspace-relative patch path from a yarn-berry-style
// `@patch:<spec>#<path>::version=…` resolution string. Cross-format
// conversion path: yarn-berry parse populates the per-tarball
// `nativeResolution` with the patch locator; pnpm stringify reuses the same
// workspace path so the emitted lockfile round-trips to the source patch bytes.
export function patchPathOfResolution(resolution: string | undefined): string | undefined {
  if (resolution === undefined) return undefined
  const patchIdx = resolution.indexOf('@patch:')
  const locator = patchIdx >= 0
    ? resolution.slice(patchIdx + 1)
    : resolution.startsWith('patch:') ? resolution : undefined
  if (locator === undefined) return undefined
  const hashIdx = locator.indexOf('#')
  if (hashIdx < 0) return undefined
  const paramsIdx = locator.indexOf('::', hashIdx + 1)
  return paramsIdx < 0
    ? locator.slice(hashIdx + 1)
    : locator.slice(hashIdx + 1, paramsIdx)
}

interface EnrichPlan {
  addRootEdges: Edge[]
  removeRootEdges: Edge[]
  markWorkspaceEdges: Edge[]
}

interface ManifestEnrichContext {
  readonly graph: Graph
  readonly sidecar: PnpmSidecar | undefined
  readonly manifests: Record<string, PnpmManifest>
  readonly memberByName: Map<string, { path: string; manifest: PnpmManifest }>
  readonly plan: EnrichPlan
}

function planManifestEnrich(
  graph: Graph,
  sidecar: PnpmSidecar | undefined,
  manifests: Record<string, PnpmManifest>,
): EnrichPlan {
  const context = createManifestEnrichContext(graph, sidecar, manifests)
  planRootManifestEdges(context)
  planResolvedWorkspaceEdges(context)
  return context.plan
}

function createManifestEnrichContext(
  graph: Graph,
  sidecar: PnpmSidecar | undefined,
  manifests: Record<string, PnpmManifest>,
): ManifestEnrichContext {
  const memberByName = new Map<string, { path: string; manifest: PnpmManifest }>()
  for (const [path, manifest] of Object.entries(manifests)) {
    if (path !== '' && manifest.name !== undefined) {
      memberByName.set(manifest.name, { path, manifest })
    }
  }
  return {
    graph,
    sidecar,
    manifests,
    memberByName,
    plan: { addRootEdges: [], removeRootEdges: [], markWorkspaceEdges: [] },
  }
}

function planRootManifestEdges(context: ManifestEnrichContext): void {
  const rootManifest = context.manifests['']
  const rootNodeId = context.sidecar?.rootId
  if (rootManifest === undefined || rootNodeId === undefined) return
  const desired = desiredRootManifestEdges(context, rootNodeId, rootManifest)
  const existing = context.graph.out(rootNodeId)
  for (const want of desired) reconcileRootManifestEdge(context.plan, existing, want)
}

function desiredRootManifestEdges(
  context: ManifestEnrichContext,
  rootNodeId: string,
  rootManifest: PnpmManifest,
): Edge[] {
  const desired: Edge[] = []
  for (const [kind, deps] of [
    ['dep', rootManifest.dependencies],
    ['dev', rootManifest.devDependencies],
    ['optional', rootManifest.optionalDependencies],
    ['peer', rootManifest.peerDependencies],
  ] as const) {
    if (deps === undefined) continue
    for (const [name, range] of Object.entries(deps).sort((a, b) => cmpStr(a[0], b[0]))) {
      const edge = desiredRootManifestEdge(context, rootNodeId, kind, name, range)
      if (edge !== undefined) desired.push(edge)
    }
  }
  return desired
}

function desiredRootManifestEdge(
  context: ManifestEnrichContext,
  rootNodeId: string,
  kind: EdgeKind,
  name: string,
  range: string,
): Edge | undefined {
  const dstId = resolveManifestTarget(context.graph, name, range, context.memberByName)
  if (dstId === undefined) return undefined
  const attrs: { range: string; workspace?: boolean } = { range }
  if (isWorkspaceProtocolRange(range) || context.memberByName.has(name)) attrs.workspace = true
  return { src: rootNodeId, dst: dstId, kind, attrs }
}

function reconcileRootManifestEdge(plan: EnrichPlan, existing: readonly Edge[], want: Edge): void {
  const match = existing.find(edge => edge.kind === want.kind && edge.dst === want.dst)
  if (match === undefined) {
    plan.addRootEdges.push(want)
    return
  }
  const rangeChanged = want.attrs?.range !== match.attrs?.range
  const workspaceChanged = (want.attrs?.workspace ?? false) !== (match.attrs?.workspace ?? false)
  if (rangeChanged || workspaceChanged) plan.markWorkspaceEdges.push(want)
}

function planResolvedWorkspaceEdges(context: ManifestEnrichContext): void {
  for (const node of context.graph.nodes()) {
    for (const edge of context.graph.out(node.id)) planResolvedWorkspaceEdge(context, edge)
  }
}

function planResolvedWorkspaceEdge(context: ManifestEnrichContext, edge: Edge): void {
  if (edge.kind === 'peer' || edge.attrs?.workspace === true) return
  const dst = context.graph.getNode(edge.dst)
  if (dst?.workspacePath === undefined || dst.workspacePath === '') return
  context.plan.markWorkspaceEdges.push({
    src: edge.src,
    dst: edge.dst,
    kind: edge.kind,
    attrs: { ...edge.attrs, workspace: true },
  })
}

function resolveManifestTarget(
  graph: Graph,
  name: string,
  range: string,
  memberByName: Map<string, { path: string; manifest: PnpmManifest }>,
): string | undefined {
  if (isWorkspaceProtocolRange(range) || memberByName.has(name)) {
    const member = memberByName.get(name)
    if (member !== undefined) {
      for (const node of graph.nodes()) {
        if (node.workspacePath === member.path) return node.id
      }
    }
  }
  const candidates = graph.byName(name)
  if (candidates.length === 1) return candidates[0]
  for (const id of candidates) {
    const node = graph.getNode(id)
    if (node?.version === range) return id
  }
  return undefined
}

function isWorkspaceProtocolRange(range: string): boolean {
  return range.startsWith('workspace:')
}

/**
 * Generic sidecar pruner for any pnpm-family sidecar carrying
 * `nodes: Map<string, NodeSc>` + `importerEdges: Map<string, EdgeSc>`
 * keyed by `<src>\0<kind>\0<dst>` edge tokens. Drops entries that
 * reference node ids no longer present in `graph`. The spread preserves
 * any other fields on the sidecar shape verbatim (e.g. `settings`,
 * `rootId`, `importerSpecifiers`, `inboundSettings`).
 *
 * Exported for pnpm-family adapters that own their own pipelines (e.g.
 * pnpm-v5 standalone-fit) while reusing the prune contract verbatim.
 */
export function prunePnpmSidecar<
  NodeSc,
  EdgeSc,
  Sidecar extends {
    nodes: Map<string, NodeSc>
    importerEdges: Map<string, EdgeSc>
  },
>(sidecar: Sidecar, graph: Graph): Sidecar {
  const aliveIds = new Set(Array.from(graph.nodes(), n => n.id))
  const nodes = new Map<string, NodeSc>()
  for (const [id, sc] of sidecar.nodes) {
    if (aliveIds.has(id)) nodes.set(id, sc)
  }
  const importerEdges = new Map<string, EdgeSc>()
  for (const [key, sc] of sidecar.importerEdges) {
    const [src, _kind, dst] = key.split('\0')
    if (src !== undefined && dst !== undefined && aliveIds.has(src) && aliveIds.has(dst)) {
      importerEdges.set(key, sc)
    }
  }
  return {
    ...sidecar,
    nodes,
    importerEdges,
  }
}
