// _pnpm-flat-core.ts — pnpm flat-family (pnpm-v6 / pnpm-v9) shared core.
//
// Scope: the two on-disk shapes that share the YAML codec + ADR-0006
// peer-virt encoding + importer synthesis loop. v5 (decimal version
// literal, dense snapshot tree) is OUT OF SCOPE and ships standalone
// per ADR-0022 phase order.
//
// Per-version thin entries (`pnpm-v6.ts`, `pnpm-v9.ts`) hand a
// `PnpmLayoutProfile` — a discriminated union with one variant per
// supported on-disk shape — through the shared parse / stringify /
// enrich / optimize implementations. The profile IS the single source
// of truth для each shape; no separate flag toggles are exposed.
//
// Supported profiles:
//
//   - `'v6-collapsed-root'`  → pnpm 6.x: quoted `'6.0'` handshake,
//     single-importer collapses к top-level `dependencies` blocks,
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
// `PNPM_V6_PATCH_DROPPED`). Family-shared diagnostics keep the bare
// `PNPM_` prefix (e.g. `PNPM_BAD_ENTRY`, `PNPM_UNRESOLVED_DEP`).
//
// YAML in/out is delegated к `_pnpm-yaml.ts`; this module owns only
// the higher-level pnpm family semantics.

// @ts-ignore -- local fixture installs do not provide semver typings.
import semver from 'semver'
import {
  GraphError,
  newBuilder,
  serializeNodeId,
  stripPeerContextFromNodeId,
  toTarballKey,
  type Diagnostic,
  type Edge,
  type EdgeKind,
  type Graph,
  type Node,
  type NodeId,
  type TarballKeyInputs,
  type TarballPayload,
} from '../graph.ts'
import { LockfileError } from '../errors.ts'
import { readYaml, emitYaml, flowMap, quoted, type YamlMap } from './_pnpm-yaml.ts'

// === Public option types ====================================================

export interface PnpmFamilyParseOptions {}

export interface PnpmFamilyStringifyOptions {
  lineEnding?: 'lf' | 'crlf'
  settings?: PnpmSettings
  onDiagnostic?: (diagnostic: Diagnostic) => void
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

export interface PnpmFamilyOptimizeOptions {}

export interface PnpmSettings {
  autoInstallPeers?: boolean
  excludeLinksFromLockfile?: boolean
}

// === Layout profiles (F1 resolution) =======================================
//
// Discriminated union — each supported on-disk shape is ONE coherent
// profile object. The shape constants for each variant are pinned in
// `PROFILE_TABLE` below; per-version adapter modules pass only the
// discriminant tag (`profile: 'v6-collapsed-root'`) и the core resolves
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
  /** Whether transitive resolved-tree dependencies live inline в packages entries. */
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
  'overrides',
  'importers',
  'packages',
  'snapshots',
]

const TOP_LEVEL_ORDER_V6: readonly string[] = [
  'lockfileVersion',
  'settings',
  'overrides',
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
  /** Static manifest extras. */
  engines?: Record<string, string>
  hasBin?: boolean
  os?: string[]
  cpu?: string[]
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
  overrides?: Record<string, string>
}

const sidecarByGraph = new WeakMap<Graph, PnpmSidecar>()

function rememberSidecar(graph: Graph, sidecar: PnpmSidecar): void {
  sidecarByGraph.set(graph, sidecar)
}

// === Public API: check / parse / stringify / enrich / optimize =============

export function checkFamily(input: string, profile: PnpmLayoutProfile): boolean {
  const shape = resolveProfile(profile)
  // Empirical probe — anchor on the version literal handshake. Both v6 и v9
  // use quoted strings (`'6.0'` / `'9.0'`), distinguishing them from v5
  // decimal (`5.4`).
  const escaped = shape.lockfileVersion.replace(/\./g, '\\.')
  const re = new RegExp(`^\\s*lockfileVersion\\s*:\\s*['"]${escaped}['"]`, 'm')
  return re.test(input)
}

export function parseFamily(
  input: string,
  _options: PnpmFamilyParseOptions,
  profile: PnpmLayoutProfile,
): Graph {
  const shape = resolveProfile(profile)
  const normalized = normalizeLineEndings(input)
  const yaml = readYaml(normalized)

  const version = yaml.lockfileVersion
  if (version !== shape.lockfileVersion) {
    throw new LockfileError({
      code: 'FORMAT_MISMATCH',
      message: `pnpm-v${shape.lockfileVersion.split('.')[0]} adapter: expected lockfileVersion ${JSON.stringify(shape.lockfileVersion)}, got ${JSON.stringify(version)}`,
    })
  }

  const builder = newBuilder()
  const diagnostics: Diagnostic[] = []
  const sidecar: PnpmSidecar = {
    rootId: '',
    settings: extractSettings(yaml.settings),
    importerPaths: [],
    importerByPath: new Map<string, string>(),
    nodes: new Map<string, PnpmNodeSidecar>(),
    importerEdges: new Map<string, PnpmEdgeSidecar>(),
  }

  if (yaml.overrides !== undefined && typeof yaml.overrides === 'object') {
    sidecar.overrides = { ...(yaml.overrides as Record<string, string>) }
  }

  const packagesMap = isPlainObject(yaml.packages) ? yaml.packages : {}

  // --- Pass 1: build node set from packages or snapshots. ---
  //
  // v9: `snapshots` keys are authoritative — peer-virt instances exist as
  // separate snapshot entries with matching bare `packages[bare-id]`.
  // v6: `packages` keys are authoritative — peer-virt is encoded directly
  // on the packages key (no separate snapshots block).

  const seenIds = new Set<string>()
  const idByPackagesKey = new Map<string, string>()

  if (shape.hasSnapshots) {
    // v9 mode: walk snapshots, cross-reference packages.
    const snapshotsMap = isPlainObject(yaml.snapshots) ? yaml.snapshots : {}
    const snapshotKeys = Object.keys(snapshotsMap)
    for (const snapshotKey of snapshotKeys) {
      const parsed = parsePackagesOrSnapshotKey(snapshotKey)
      if (parsed === undefined) {
        diagnostics.push({
          code: 'PNPM_BAD_ENTRY',
          severity: 'warning',
          message: `pnpm-v${shape.lockfileVersion.split('.')[0]} snapshot key ${JSON.stringify(snapshotKey)} not parseable`,
        })
        continue
      }
      const { name, version, peers } = parsed
      const peerContext = peers.map(p => `${p.name}@${p.version}`).sort()
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
      addPackageNode(builder, sidecar, name, version, peerContext, nodeId, pkgEntry)
      const snapEntry = snapshotsMap[snapshotKey]
      if (isPlainObject(snapEntry) && Array.isArray(snapEntry.transitivePeerDependencies)) {
        const sc = sidecar.nodes.get(nodeId)
        if (sc !== undefined) {
          sc.transitivePeerDependencies = (snapEntry.transitivePeerDependencies as string[]).slice()
        }
      }
    }
  } else {
    // v6 mode: walk packages — keys carry peer-context directly.
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
      const { name, version, peers } = parsed
      const peerContext = peers.map(p => `${p.name}@${p.version}`).sort()
      const nodeId = serializeNodeId(name, version, peerContext)
      if (seenIds.has(nodeId)) continue
      seenIds.add(nodeId)
      idByPackagesKey.set(pkgKey, nodeId)
      const pkgEntry = packagesMap[pkgKey]!
      addPackageNode(builder, sidecar, name, version, peerContext, nodeId, pkgEntry)
      // v6 carries `dev` per-entry — capture for round-trip.
      if (isPlainObject(pkgEntry) && typeof pkgEntry.dev === 'boolean') {
        const sc = sidecar.nodes.get(nodeId)
        if (sc !== undefined) sc.dev = pkgEntry.dev
      }
    }
  }

  // --- Pass 2: importers — workspace synthesis + importer edges. ---
  //
  // v9: `importers` is ALWAYS present. Single-importer collapses to `.`.
  // v6: `importers` is present ONLY for multi-importer projects;
  //     single-importer mode uses top-level `dependencies` instead.

  const importersMap = isPlainObject(yaml.importers) ? yaml.importers : undefined
  const collapsedRootDeps = isCollapsedRoot(yaml, shape)
    ? buildCollapsedRootImporter(yaml)
    : undefined

  // Build the effective importer map.
  const effectiveImporters: Record<string, unknown> = {}
  if (importersMap !== undefined) {
    for (const key of Object.keys(importersMap)) {
      effectiveImporters[key] = importersMap[key]
    }
  }
  if (collapsedRootDeps !== undefined) {
    // v6 collapsed-root: the implicit `.` importer pulled from top-level dep blocks.
    effectiveImporters['.'] = collapsedRootDeps
  }
  // If neither importers nor collapsed-root, synthesise an empty root importer.
  if (Object.keys(effectiveImporters).length === 0) {
    effectiveImporters['.'] = {}
  }

  const importerPaths = Object.keys(effectiveImporters).sort(cmpStr)
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

  // --- Pass 3: importer edges — root + member → snapshot nodes. ---
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
      const block = importerEntry[blockName]
      if (!isPlainObject(block)) continue
      const entries = Object.entries(block).sort((a, b) => cmpStr(a[0], b[0]))
      for (const [depName, depValue] of entries) {
        const spec = importerSpec(depValue)
        if (spec === undefined) continue
        const { specifier, version } = spec

        // workspace:* / link: resolution.
        if (version.startsWith('link:')) {
          const linkPath = resolveLinkPath(importerPath, version.slice(5))
          const targetId = sidecar.importerByPath.get(linkPath)
          if (targetId === undefined) {
            diagnostics.push({
              code: 'PNPM_UNRESOLVED_DEP',
              severity: 'warning',
              subject: srcId,
              message: `pnpm-v${shape.lockfileVersion.split('.')[0]}: importer ${JSON.stringify(importerPath)} dep ${depName} resolves to unknown workspace ${JSON.stringify(linkPath)}`,
            })
            continue
          }
          const attrs: { range: string; workspace: boolean } = { range: specifier ?? version, workspace: true }
          try {
            builder.addEdge(srcId, targetId, kind, attrs)
          } catch (error) {
            if (error instanceof GraphError && error.code === 'INVARIANT_VIOLATION') continue
            throw error
          }
          const edgeKey = `${srcId}\0${kind}\0${targetId}`
          sidecar.importerEdges.set(edgeKey, { resolvedVersion: version, specifier })
          continue
        }

        // Bare version — resolve to a node.
        const targetId = resolveSnapshotTarget(seenIds, depName, version)
        if (targetId === undefined) {
          diagnostics.push({
            code: 'PNPM_UNRESOLVED_DEP',
            severity: 'warning',
            subject: srcId,
            message: `pnpm-v${shape.lockfileVersion.split('.')[0]}: importer ${JSON.stringify(importerPath)} dep ${depName}@${version} resolves to no snapshot`,
          })
          continue
        }
        try {
          builder.addEdge(srcId, targetId, kind, { range: specifier ?? version })
        } catch (error) {
          if (error instanceof GraphError && error.code === 'INVARIANT_VIOLATION') continue
          throw error
        }
        const edgeKey = `${srcId}\0${kind}\0${targetId}`
        sidecar.importerEdges.set(edgeKey, { resolvedVersion: version, specifier })
      }
    }
  }

  // --- Pass 4: resolved-tree edges (snapshot → snapshot for v9, package → package for v6). ---
  if (shape.hasSnapshots) {
    const snapshotsMap = isPlainObject(yaml.snapshots) ? yaml.snapshots : {}
    for (const snapshotKey of Object.keys(snapshotsMap)) {
      const parsed = parsePackagesOrSnapshotKey(snapshotKey)
      if (parsed === undefined) continue
      const { name, version, peers } = parsed
      const peerContext = peers.map(p => `${p.name}@${p.version}`).sort()
      const srcId = serializeNodeId(name, version, peerContext)
      if (!seenIds.has(srcId)) continue
      const snapEntry = snapshotsMap[snapshotKey]
      if (!isPlainObject(snapEntry)) continue
      addResolvedTreeEdges(builder, diagnostics, srcId, snapEntry, peers, seenIds, sidecar, shape)
    }
  } else {
    // v6: walk packages entries themselves for inline dependencies + peerDependencies.
    for (const pkgKey of Object.keys(packagesMap)) {
      const srcId = idByPackagesKey.get(pkgKey)
      if (srcId === undefined) continue
      const stripped = stripPackagesKeyPrefix(pkgKey, shape.packagesKeyShape)
      const parsed = parsePackagesOrSnapshotKey(stripped)
      if (parsed === undefined) continue
      const pkgEntry = packagesMap[pkgKey]
      if (!isPlainObject(pkgEntry)) continue
      addResolvedTreeEdges(builder, diagnostics, srcId, pkgEntry, parsed.peers, seenIds, sidecar, shape)
    }
  }

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

export function stringifyFamily(
  graph: Graph,
  profile: PnpmLayoutProfile,
  options: PnpmFamilyStringifyOptions = {},
): string {
  const shape = resolveProfile(profile)
  const sidecar = sidecarByGraph.get(graph)
  const emitDiagnostic = (diagnostic: Diagnostic): void => {
    options.onDiagnostic?.(diagnostic)
  }

  const warnedPatches = new Set<string>()
  for (const node of graph.nodes()) {
    warnPatchDrop(shape, node, warnedPatches, emitDiagnostic)
  }

  // --- Step 1: classify nodes — root + workspace members + resolved nodes. ---
  const rootNode = locateRootNode(graph, sidecar)
  const workspaceNodes: Node[] = []
  const resolvedNodes: Node[] = []
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

  // --- Step 2: build the YAML structure. ---
  const out: YamlMap = {}
  // Quoted scalar: codec emits `lockfileVersion: '9.0'` (vs bare `9.0` which
  // YAML would parse as a number on some implementations).
  out.lockfileVersion = quoted(shape.lockfileVersion)

  // settings — overlay caller's option over sidecar over defaults.
  const settings: PnpmSettings = {
    autoInstallPeers: true,
    excludeLinksFromLockfile: false,
    ...sidecar?.settings,
    ...options.settings,
  }
  out.settings = {
    autoInstallPeers: settings.autoInstallPeers ?? true,
    excludeLinksFromLockfile: settings.excludeLinksFromLockfile ?? false,
  } as YamlMap

  if (sidecar?.overrides !== undefined && Object.keys(sidecar.overrides).length > 0) {
    out.overrides = sortRecord(sidecar.overrides) as YamlMap
  }

  // importers vs collapsed dependencies — v9 always emits importers; v6
  // collapses single-importer to top-level `dependencies` (plus any
  // workspace-member importers separately).
  const rootImporterEntry = buildImporterEntry(graph, sidecar, rootNode, '.')

  if (shape.topLevelShape === 'dependencies-collapsed') {
    const hasMultiImporters = workspaceNodes.length > 0
    if (hasMultiImporters) {
      // Multi-importer mode — emit importers block (with `.: {}` for root if
      // the root carries no direct dep blocks; otherwise emit root deps under
      // `.` too).
      const importers: YamlMap = {}
      if (Object.keys(rootImporterEntry).length === 0) {
        importers['.'] = flowMap({}) // emit as `.: {}` flow-empty
      } else {
        importers['.'] = rootImporterEntry
      }
      for (const wsNode of workspaceNodes) {
        const wsPath = wsNode.workspacePath ?? wsNode.name
        importers[wsPath] = buildImporterEntry(graph, sidecar, wsNode, wsPath)
      }
      out.importers = sortRecord(importers) as YamlMap
    } else {
      // Single-importer mode — top-level dep blocks (collapsed). Pull dep
      // blocks out of the importer entry and elevate them.
      for (const block of ['dependencies', 'devDependencies', 'optionalDependencies'] as const) {
        const value = rootImporterEntry[block]
        if (value !== undefined) out[block] = value
      }
    }
  } else {
    // v9 importers-always mode.
    const importers: YamlMap = {}
    if (Object.keys(rootImporterEntry).length === 0) {
      importers['.'] = flowMap({})
    } else {
      importers['.'] = rootImporterEntry
    }
    for (const wsNode of workspaceNodes) {
      const wsPath = wsNode.workspacePath ?? wsNode.name
      importers[wsPath] = buildImporterEntry(graph, sidecar, wsNode, wsPath)
    }
    out.importers = sortRecord(importers) as YamlMap
  }

  // packages — keyed by bare or slash-leading `<id>` per shape.packagesKeyShape.
  const packagesUsed = new Set<string>()
  for (const node of resolvedNodes) {
    packagesUsed.add(packagesKeyForNode(node, shape))
  }

  const packages: YamlMap = {}
  if (shape.peerContextLocation === 'snapshots-keys') {
    // v9: collapse peer-virt siblings onto bare key.
    const bareToNodes = new Map<string, Node[]>()
    for (const node of resolvedNodes) {
      const bareKey = `${node.name}@${node.version}`
      const arr = bareToNodes.get(bareKey) ?? []
      arr.push(node)
      bareToNodes.set(bareKey, arr)
    }
    for (const bareKey of Array.from(bareToNodes.keys()).sort(cmpStr)) {
      const siblings = bareToNodes.get(bareKey)!
      if (!packagesUsed.has(bareKey)) continue
      const first = siblings[0]!
      packages[bareKey] = buildPackageEntry(graph, sidecar, first, shape)
    }
  } else {
    // v6: one packages entry per peer-virt instance, key includes peer-context.
    const sortedNodes = resolvedNodes.slice().sort((a, b) => cmpStr(packagesKeyForNode(a, shape), packagesKeyForNode(b, shape)))
    for (const node of sortedNodes) {
      const key = packagesKeyForNode(node, shape)
      packages[key] = buildPackageEntry(graph, sidecar, node, shape)
    }
  }
  out.packages = packages

  // snapshots — emitted only on v9.
  if (shape.hasSnapshots) {
    const snapshots: YamlMap = {}
    for (const node of resolvedNodes) {
      const snapshotKey = nodeIdToSnapshotKey(node)
      snapshots[snapshotKey] = buildSnapshotEntry(graph, sidecar, node)
    }
    out.snapshots = sortRecord(snapshots) as YamlMap
  }

  const text = emitYaml(out, {
    topLevelOrder: shape.topLevelOrder,
    topLevelSectionKeys: shape.topLevelSectionKeys,
  })
  return options.lineEnding === 'crlf' ? text.replace(/\n/g, '\r\n') : text
}

export function enrichFamily(
  graph: Graph,
  profile: PnpmLayoutProfile,
  options: PnpmFamilyEnrichOptions = {},
): { graph: Graph; diagnostics: Diagnostic[] } {
  const shape = resolveProfile(profile)
  const sidecar = sidecarByGraph.get(graph)
  const diagnostics: Diagnostic[] = []

  // §C — peer-virt three-branch derivation per ADR-0006 reference impl.
  // Dominant path: peer-context already on disk (read at parse). Fallback
  // runs when on-disk peer-context is incomplete.
  for (const node of graph.nodes()) {
    const nodeSc = sidecar?.nodes.get(node.id)
    const rawPeers = nodeSc?.peerDependencies
    if (rawPeers === undefined) continue
    const declaredPeers = Object.keys(rawPeers).sort(cmpStr)
    for (const peerName of declaredPeers) {
      const peerRange = rawPeers[peerName]
      if (peerRange === undefined) continue
      const alreadyBound = node.peerContext.some(p => stripPeerContextFromNodeId(p).startsWith(`${peerName}@`))
      if (alreadyBound) continue

      const candidates = collectPeerCandidates(graph, peerName, peerRange)
      if (candidates.length === 1) {
        diagnostics.push({
          code: `${shape.diagnosticPrefix}_PEER_BOUND`,
          severity: 'info',
          subject: node.id,
          message: `peer ${JSON.stringify(peerName)} range ${JSON.stringify(peerRange)} → ${candidates[0]} (1-candidate fallback; on-disk peer-context absent)`,
        })
      } else if (candidates.length === 0) {
        diagnostics.push({
          code: `${shape.diagnosticPrefix}_PEER_UNSATISFIED`,
          severity: 'warning',
          subject: node.id,
          message: `peer ${JSON.stringify(peerName)} range ${JSON.stringify(peerRange)} matches no installed version`,
        })
      } else {
        diagnostics.push({
          code: `${shape.diagnosticPrefix}_PEER_AMBIGUOUS`,
          severity: 'warning',
          subject: node.id,
          message: `peer ${JSON.stringify(peerName)} range ${JSON.stringify(peerRange)} matches multiple candidates: ${candidates.join(', ')}`,
        })
      }
    }
  }

  // Workspace concretisation.
  if (options.manifests === undefined) {
    const hasWorkspaceHint = Array.from(graph.nodes())
      .some(n => n.workspacePath !== undefined && n.workspacePath !== '')
    if (hasWorkspaceHint) {
      diagnostics.push({
        code: `${shape.diagnosticPrefix}_NO_MANIFESTS`,
        severity: 'warning',
        message: `pnpm-v${shape.lockfileVersion.split('.')[0]} workspace concretisation requires manifests; leaving graph unclassified`,
      })
    }
    return { graph, diagnostics }
  }

  const plan = planManifestEnrich(graph, sidecar, options.manifests)
  if (plan.addRootEdges.length === 0 && plan.markWorkspaceEdges.length === 0 && plan.removeRootEdges.length === 0) {
    return { graph, diagnostics }
  }

  const result = graph.mutate(m => {
    for (const edge of plan.removeRootEdges) {
      m.removeEdge(edge.src, edge.dst, edge.kind)
    }
    for (const edge of plan.addRootEdges) {
      m.addEdge(edge.src, edge.dst, edge.kind, edge.attrs)
    }
    for (const edge of plan.markWorkspaceEdges) {
      m.removeEdge(edge.src, edge.dst, edge.kind)
      m.addEdge(edge.src, edge.dst, edge.kind, edge.attrs)
    }
  })

  if (sidecar !== undefined) rememberSidecar(result.graph, sidecar)
  return { graph: result.graph, diagnostics }
}

export function optimizeFamily(
  graph: Graph,
  _profile: PnpmLayoutProfile,
  _options: PnpmFamilyOptimizeOptions = {},
): { graph: Graph; diagnostics: Diagnostic[] } {
  const sidecar = sidecarByGraph.get(graph)
  const reachable = new Set(graph.walk(Array.from(graph.roots())))
  const unreachableNodes = Array.from(graph.nodes(), node => node.id)
    .filter(nodeId => !reachable.has(nodeId))
    .sort(cmpStr)

  if (unreachableNodes.length === 0) {
    return {
      graph,
      diagnostics: graph.diagnostics().filter(diagnostic => diagnostic.severity === 'warning'),
    }
  }

  const unreachable = new Set(unreachableNodes)
  const referencedTarballs = new Set<string>()
  const tarballsToRemove = new Map<string, TarballKeyInputs>()
  const internalEdges = unreachableNodes
    .flatMap(src =>
      graph.out(src)
        .filter(edge => unreachable.has(edge.dst))
        .map(edge => ({ src: edge.src, dst: edge.dst, kind: edge.kind })),
    )
    .sort((a, b) =>
      cmpStr(`${a.src} ${a.kind} ${a.dst}`, `${b.src} ${b.kind} ${b.dst}`),
    )

  for (const node of graph.nodes()) {
    const inputs = { name: node.name, version: node.version, patch: node.patch }
    const key = toTarballKey(inputs)
    if (unreachable.has(node.id)) {
      tarballsToRemove.set(key, inputs)
      continue
    }
    referencedTarballs.add(key)
  }

  const result = graph.mutate(m => {
    for (const edge of internalEdges) {
      m.removeEdge(edge.src, edge.dst, edge.kind)
    }
    for (const nodeId of unreachableNodes) {
      m.removeNode(nodeId)
    }
    for (const [key, inputs] of Array.from(tarballsToRemove.entries()).sort((a, b) => cmpStr(a[0], b[0]))) {
      if (referencedTarballs.has(key)) continue
      if (graph.tarball(inputs) === undefined) continue
      m.removeTarball(inputs)
    }
  })

  if (sidecar !== undefined) rememberSidecar(result.graph, pruneSidecar(sidecar, result.graph))
  return { graph: result.graph, diagnostics: result.unresolved }
}

// === Helpers ===============================================================

function normalizeLineEndings(input: string): string {
  return input.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

const cmpStr = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0

function sortRecord<T>(record: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {}
  for (const key of Object.keys(record).sort(cmpStr)) {
    const v = record[key]
    if (v !== undefined) out[key] = v
  }
  return out
}

function isPlainObject(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

interface ParsedPackagesOrSnapshotKey {
  name: string
  version: string
  peers: Array<{ name: string; version: string }>
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

  const peers: Array<{ name: string; version: string }> = []
  let pos = 0
  while (pos < peerSuffix.length) {
    if (peerSuffix[pos] !== '(') return undefined
    let close = -1
    let d = 1
    for (let i = pos + 1; i < peerSuffix.length; i++) {
      const c = peerSuffix[i]
      if (c === '(') d++
      else if (c === ')') { d--; if (d === 0) { close = i; break } }
    }
    if (close < 0) return undefined
    const segment = peerSuffix.slice(pos + 1, close)
    let segAt = -1
    for (let i = 1; i < segment.length; i++) {
      if (segment[i] === '@') segAt = i
    }
    if (segAt <= 0) return undefined
    const pName = segment.slice(0, segAt)
    const pVer = segment.slice(segAt + 1)
    if (pName.length === 0 || pVer.length === 0) return undefined
    peers.push({ name: pName, version: pVer })
    pos = close + 1
  }

  return { name, version, peers }
}

function stripPackagesKeyPrefix(key: string, packagesKeyShape: PnpmLayoutShape['packagesKeyShape']): string {
  if (packagesKeyShape === 'slash-leading-at' && key.startsWith('/')) return key.slice(1)
  return key
}

function applyPackagesKeyPrefix(stripped: string, packagesKeyShape: PnpmLayoutShape['packagesKeyShape']): string {
  if (packagesKeyShape === 'slash-leading-at') return `/${stripped}`
  return stripped
}

function packagesKeyForNode(node: Node, shape: PnpmLayoutShape): string {
  // v9 collapses peer-virt onto bare key. v6 carries peer-context on the key.
  const bare = `${node.name}@${node.version}`
  if (shape.peerContextLocation === 'snapshots-keys') return bare
  // v6 — append peer-context if present.
  const suffix = node.peerContext.length === 0
    ? ''
    : node.peerContext.map(p => `(${p})`).join('')
  return applyPackagesKeyPrefix(bare + suffix, shape.packagesKeyShape)
}

function addPackageNode(
  builder: ReturnType<typeof newBuilder>,
  sidecar: PnpmSidecar,
  name: string,
  version: string,
  peerContext: string[],
  nodeId: string,
  pkgEntry: unknown,
): void {
  const node: Node = {
    id: nodeId,
    name,
    version,
    peerContext,
  }
  if (isPlainObject(pkgEntry)) {
    const resolution = pkgEntry.resolution
    if (isPlainObject(resolution) && typeof resolution.tarball === 'string') {
      node.resolution = resolution.tarball
    }
  }
  builder.addNode(node)

  const payload = tarballPayloadOf(pkgEntry)
  if (payload !== undefined) {
    builder.setTarball({ name, version }, payload)
  }

  const nodeSc: PnpmNodeSidecar = {}
  if (isPlainObject(pkgEntry)) {
    if (isPlainObject(pkgEntry.peerDependencies)) {
      nodeSc.peerDependencies = { ...(pkgEntry.peerDependencies as Record<string, string>) }
    }
    if (isPlainObject(pkgEntry.engines)) {
      nodeSc.engines = { ...(pkgEntry.engines as Record<string, string>) }
    }
    if (pkgEntry.hasBin === true) nodeSc.hasBin = true
    if (Array.isArray(pkgEntry.os)) nodeSc.os = (pkgEntry.os as string[]).slice()
    if (Array.isArray(pkgEntry.cpu)) nodeSc.cpu = (pkgEntry.cpu as string[]).slice()
  }
  sidecar.nodes.set(nodeId, nodeSc)
}

function addResolvedTreeEdges(
  builder: ReturnType<typeof newBuilder>,
  diagnostics: Diagnostic[],
  srcId: string,
  entry: Record<string, unknown>,
  peers: Array<{ name: string; version: string }>,
  seenIds: Set<string>,
  sidecar: PnpmSidecar,
  shape: PnpmLayoutShape,
): void {
  for (const [kind, blockName] of [
    ['dep', 'dependencies'],
    ['optional', 'optionalDependencies'],
  ] as const) {
    const block = entry[blockName]
    if (!isPlainObject(block)) continue
    const entries = Object.entries(block).sort((a, b) => cmpStr(a[0], b[0]))
    for (const [depName, rawValue] of entries) {
      if (typeof rawValue !== 'string') continue
      const targetId = resolveSnapshotTarget(seenIds, depName, rawValue)
      if (targetId === undefined) {
        diagnostics.push({
          code: 'PNPM_UNRESOLVED_DEP',
          severity: 'warning',
          subject: srcId,
          message: `pnpm-v${shape.lockfileVersion.split('.')[0]}: ${srcId} dep ${depName}@${rawValue} resolves to no snapshot`,
        })
        continue
      }
      try {
        builder.addEdge(srcId, targetId, kind, { range: rawValue })
      } catch (error) {
        if (error instanceof GraphError && error.code === 'INVARIANT_VIOLATION') continue
        throw error
      }
    }
  }

  // Peer edges — derive from peerContext per ADR-0006.
  for (const peer of peers) {
    const peerId = peer.name + '@' + peer.version
    const peerNodeId = resolvePeerTargetById(seenIds, peer.name, peer.version)
    if (peerNodeId === undefined) {
      diagnostics.push({
        code: 'PNPM_UNRESOLVED_DEP',
        severity: 'warning',
        subject: srcId,
        message: `pnpm-v${shape.lockfileVersion.split('.')[0]}: ${srcId} peer ${peerId} resolves to no snapshot`,
      })
      continue
    }
    try {
      const sc = sidecar.nodes.get(srcId)
      const peerRange = sc?.peerDependencies?.[peer.name] ?? peer.version
      builder.addEdge(srcId, peerNodeId, 'peer', { range: peerRange })
    } catch (error) {
      if (error instanceof GraphError && error.code === 'INVARIANT_VIOLATION') continue
      throw error
    }
  }
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
): string | undefined {
  const parsedTail = parsePackagesOrSnapshotKey(`${depName}@${rawValue}`)
  if (parsedTail === undefined) return undefined
  const peerContext = parsedTail.peers.map(p => `${p.name}@${p.version}`).sort()
  const candidateId = serializeNodeId(parsedTail.name, parsedTail.version, peerContext)
  if (seenIds.has(candidateId)) return candidateId
  const bareId = `${parsedTail.name}@${parsedTail.version}`
  if (seenIds.has(bareId)) return bareId
  return undefined
}

function resolvePeerTargetById(seenIds: Set<string>, peerName: string, peerVersion: string): string | undefined {
  const bareId = `${peerName}@${peerVersion}`
  if (seenIds.has(bareId)) return bareId
  for (const id of seenIds) {
    if (id.startsWith(bareId + '(')) return id
  }
  return undefined
}

function importerSpec(value: unknown): { specifier?: string; version: string } | undefined {
  if (typeof value === 'string') return { version: value }
  if (!isPlainObject(value)) return undefined
  const version = value.version
  if (typeof version !== 'string') return undefined
  const specifier = typeof value.specifier === 'string' ? value.specifier : undefined
  return { specifier, version }
}

function resolveLinkPath(importerPath: string, relTarget: string): string {
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

function tarballPayloadOf(entry: unknown): TarballPayload | undefined {
  if (!isPlainObject(entry)) return undefined
  const payload: TarballPayload = {}
  const resolution = entry.resolution
  if (isPlainObject(resolution) && typeof resolution.integrity === 'string') {
    payload.integrity = resolution.integrity
  }
  if (isPlainObject(entry.engines)) {
    payload.engines = { ...(entry.engines as Record<string, string>) }
  }
  if (Array.isArray(entry.cpu)) payload.cpu = (entry.cpu as string[]).slice()
  if (Array.isArray(entry.os)) payload.os = (entry.os as string[]).slice()
  if (entry.hasBin === true) payload.bin = 'true'
  if (typeof entry.deprecated === 'string') payload.deprecated = entry.deprecated
  return Object.keys(payload).length === 0 ? undefined : payload
}

function extractSettings(value: unknown): PnpmSettings {
  const out: PnpmSettings = {}
  if (!isPlainObject(value)) return out
  if (typeof value.autoInstallPeers === 'boolean') out.autoInstallPeers = value.autoInstallPeers
  if (typeof value.excludeLinksFromLockfile === 'boolean') out.excludeLinksFromLockfile = value.excludeLinksFromLockfile
  return out
}

function locateRootNode(graph: Graph, sidecar: PnpmSidecar | undefined): Node | undefined {
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

function nodeIdToSnapshotKey(node: Node): string {
  if (node.peerContext.length === 0) return `${node.name}@${node.version}`
  return `${node.name}@${node.version}` + node.peerContext.map(p => `(${p})`).join('')
}

function buildImporterEntry(
  graph: Graph,
  sidecar: PnpmSidecar | undefined,
  node: Node | undefined,
  importerPath: string,
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
    const edgeKey = `${edge.src}\0${edge.kind}\0${edge.dst}`
    const edgeSc = sidecar?.importerEdges.get(edgeKey)

    const range = edge.attrs?.range
    const specifier = edgeSc?.specifier ?? range ?? dst.version
    const version = isWorkspaceTarget
      ? `link:${relativeImporterPath(importerPath, dst.workspacePath ?? dst.name)}`
      : (edgeSc?.resolvedVersion ?? nodeIdToImporterVersion(dst))

    const depBlock = blocks[edge.kind]!
    const depName = dst.name
    depBlock[depName] = {
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

function nodeIdToImporterVersion(node: Node): string {
  if (node.peerContext.length === 0) return node.version
  return node.version + node.peerContext.map(p => `(${p})`).join('')
}

function relativeImporterPath(importerPath: string, targetPath: string): string {
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
  representative: Node,
  shape: PnpmLayoutShape,
): YamlMap {
  const entry: YamlMap = {}
  const tarball = graph.tarballOf(representative.id)
  if (tarball !== undefined) {
    const resolution: YamlMap = {}
    if (tarball.integrity !== undefined) resolution.integrity = tarball.integrity
    if (representative.resolution !== undefined) resolution.tarball = representative.resolution
    if (Object.keys(resolution).length > 0) entry.resolution = flowMap(resolution)
  } else if (representative.resolution !== undefined) {
    entry.resolution = flowMap({ tarball: representative.resolution })
  }

  const nodeSc = sidecar?.nodes.get(representative.id)
  if (nodeSc?.engines !== undefined && Object.keys(nodeSc.engines).length > 0) {
    entry.engines = flowMap({ ...nodeSc.engines })
  } else if (tarball?.engines !== undefined && Object.keys(tarball.engines).length > 0) {
    entry.engines = flowMap({ ...tarball.engines })
  }
  if (nodeSc?.hasBin === true) entry.hasBin = true
  if (nodeSc?.os !== undefined && nodeSc.os.length > 0) entry.os = nodeSc.os.slice()
  if (nodeSc?.cpu !== undefined && nodeSc.cpu.length > 0) entry.cpu = nodeSc.cpu.slice()
  if (nodeSc?.peerDependencies !== undefined && Object.keys(nodeSc.peerDependencies).length > 0) {
    entry.peerDependencies = sortRecord(nodeSc.peerDependencies) as YamlMap
  }

  // v6: inline transitive dependencies under each packages entry (since
  // there's no separate snapshots block).
  if (shape.inlineTransitives) {
    const blocks: Record<'dep' | 'optional', Record<string, string>> = { dep: {}, optional: {} }
    for (const edge of graph.out(representative.id)) {
      if (edge.kind !== 'dep' && edge.kind !== 'optional') continue
      const dst = graph.getNode(edge.dst)
      if (dst === undefined) continue
      if (dst.workspacePath !== undefined && dst.workspacePath !== '') continue
      if (dst.id === sidecar?.rootId) continue
      const block = blocks[edge.kind]!
      block[dst.name] = nodeIdToImporterVersion(dst)
    }
    for (const [kind, blockName] of [['dep', 'dependencies'], ['optional', 'optionalDependencies']] as const) {
      const block = blocks[kind]
      if (Object.keys(block).length > 0) {
        entry[blockName] = sortRecord(block) as YamlMap
      }
    }
  }

  // v6 dev flag — emit per-entry.
  if (shape.devFlag) {
    const dev = nodeSc?.dev ?? false
    entry.dev = dev
  }

  return entry
}

function buildSnapshotEntry(
  graph: Graph,
  sidecar: PnpmSidecar | undefined,
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
    block[dst.name] = nodeIdToImporterVersion(dst)
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

function collectPeerCandidates(graph: Graph, peerName: string, peerRange: string): NodeId[] {
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

function warnPatchDrop(
  shape: PnpmLayoutShape,
  node: Node,
  warned: Set<string>,
  emitDiagnostic: (diagnostic: Diagnostic) => void,
): void {
  if (node.patch === undefined || warned.has(node.id)) return
  warned.add(node.id)
  emitDiagnostic({
    code: `${shape.diagnosticPrefix}_PATCH_DROPPED`,
    severity: 'warning',
    subject: node.id,
    message: `patch slot ${JSON.stringify(node.patch)} is unsupported in pnpm-v${shape.lockfileVersion.split('.')[0]} emit; dropping`,
  })
}

interface EnrichPlan {
  addRootEdges: Edge[]
  removeRootEdges: Edge[]
  markWorkspaceEdges: Edge[]
}

function planManifestEnrich(
  graph: Graph,
  sidecar: PnpmSidecar | undefined,
  manifests: Record<string, PnpmManifest>,
): EnrichPlan {
  const rootManifest = manifests['']
  const rootNodeId = sidecar?.rootId

  const addRootEdges: Edge[] = []
  const removeRootEdges: Edge[] = []
  const markWorkspaceEdges: Edge[] = []

  const memberByName = new Map<string, { path: string; manifest: PnpmManifest }>()
  for (const [path, manifest] of Object.entries(manifests)) {
    if (path === '' || manifest.name === undefined) continue
    memberByName.set(manifest.name, { path, manifest })
  }

  if (rootManifest !== undefined && rootNodeId !== undefined) {
    const desired: Edge[] = []
    for (const [kind, deps] of [
      ['dep', rootManifest.dependencies],
      ['dev', rootManifest.devDependencies],
      ['optional', rootManifest.optionalDependencies],
      ['peer', rootManifest.peerDependencies],
    ] as const) {
      if (deps === undefined) continue
      for (const [name, range] of Object.entries(deps).sort((a, b) => cmpStr(a[0], b[0]))) {
        const dstId = resolveManifestTarget(graph, name, range, memberByName)
        if (dstId === undefined) continue
        const attrs: { range: string; workspace?: boolean } = { range }
        if (isWorkspaceProtocolRange(range) || memberByName.has(name)) {
          attrs.workspace = true
        }
        desired.push({ src: rootNodeId, dst: dstId, kind, attrs })
      }
    }
    const existing = graph.out(rootNodeId)
    for (const want of desired) {
      const match = existing.find(c => c.kind === want.kind && c.dst === want.dst)
      if (match === undefined) {
        addRootEdges.push(want)
        continue
      }
      const wantRange = want.attrs?.range
      const curRange = match.attrs?.range
      const wantWs = want.attrs?.workspace ?? false
      const curWs = match.attrs?.workspace ?? false
      if (wantRange !== curRange || wantWs !== curWs) {
        markWorkspaceEdges.push(want)
      }
    }
  }

  for (const node of graph.nodes()) {
    for (const edge of graph.out(node.id)) {
      if (edge.kind === 'peer') continue
      if (edge.attrs?.workspace === true) continue
      const dst = graph.getNode(edge.dst)
      if (dst === undefined) continue
      if (dst.workspacePath === undefined || dst.workspacePath === '') continue
      markWorkspaceEdges.push({
        src: edge.src,
        dst: edge.dst,
        kind: edge.kind,
        attrs: { ...edge.attrs, workspace: true },
      })
    }
  }

  return { addRootEdges, removeRootEdges, markWorkspaceEdges }
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

function pruneSidecar(sidecar: PnpmSidecar, graph: Graph): PnpmSidecar {
  const aliveIds = new Set(Array.from(graph.nodes(), n => n.id))
  const nodes = new Map<string, PnpmNodeSidecar>()
  for (const [id, sc] of sidecar.nodes) {
    if (aliveIds.has(id)) nodes.set(id, sc)
  }
  const importerEdges = new Map<string, PnpmEdgeSidecar>()
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
