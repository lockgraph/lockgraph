// pnpm-v5 adapter — pnpm `pnpm-lock.yaml` lockfileVersion 5.4.
//
// Standalone-fit per ADR-0022 §5 r2 amendment: v5 (decimal `5.4`
// handshake, `specifiers` + bare-version `dependencies`,
// `/<name>/<version>` slash-separator packages keys, underscore peer-
// context syntax) is fundamentally different from the flat-core v6/v9
// shared shape (quoted `'6.0'`/`'9.0'`, `{specifier, version}`
// importer values, `@`-separator packages keys, parens peer-context).
// Forcing a unified pipeline rots both sides; this module owns its
// own parse / stringify / enrich / optimize pipeline.
//
// Dependency direction (parallel to npm-1 / yarn-classic standalone
// precedents): this module imports YAML primitives from
// `_pnpm-yaml.ts`, graph types from `../graph.ts`, AND family-internal
// pnpm helpers from `_pnpm-flat-core.ts` (peer-candidate derivation,
// sidecar pruning, workspace path math, micro-utils). It does NOT
// call `parseFamily` / `stringifyFamily` — those are v6/v9-shape
// specific. `_pnpm-yaml.ts` and `_pnpm-flat-core.ts` do NOT import
// this module — dependency is one-way (v5 → family infra).
//
// §A pinning per ADR-0022 §A.pnpm-v5:
//   - top-level `lockfileVersion: 5.<digit>` decimal scalar
//     (NOT quoted). Parse rejects v6/v9 (quoted) and other PM
//     families via `FORMAT_MISMATCH`. Emit canonicalises to `5.4`.
//   - NO `settings` block (v5 predates the pnpm settings table).
//     Graphs carrying settings via cross-version composition trigger
//     a `PNPM_V5_SETTINGS_DROPPED` warning on emit.
//   - top-level layout — `specifiers` + `dependencies` blocks
//     (single-importer collapsed-root) OR `importers` block
//     (multi-importer workspaces). Mutually exclusive on emit;
//     `PNPM_V5_DUAL_TOP_LEVEL_DRIFT` warning on parse if both present.
//   - `dependencies.<name>` shape — bare version string, optionally
//     peer-context-suffixed: `<name>: <version>_<peer>@<peer-version>`.
//   - `packages` block — slash-separator keys `/<name>/<version>`
//     (vs v6/v9's `<name>@<version>`). Peer-context renders as
//     underscore suffix `/<name>/<version>_<peer>@<peer-version>`;
//     multi-peer concatenated alphabetically. Parse uses the
//     right-to-left peel grammar per ADR-0022 §A.pnpm-v5.
//   - Inline transitives via `dependencies:` block in packages
//     entries (same shape as v6).
//   - `dev: false|true` per-entry flag (same as v6).
//   - NO `snapshots` block (v9-only).
//
// §B Lossy-but-acceptable (pnpm-v5 specific):
//   - `RECIPE_FEATURE_DROPPED` (feature='patch') — patch slot drops on
//     emit (v5 has no on-disk `patch:` protocol slot in the working
//     corpus) per ADR-0014 §5 canonical loss code.
//   - `PNPM_V5_SETTINGS_DROPPED` — sidecar `settings` block dropped
//     when present (v5 schema has no settings).
//   - `PNPM_V5_DUAL_TOP_LEVEL_DRIFT` — both `specifiers`/`dependencies`
//     AND `importers` present on parse (hand-edit drift); `importers`
//     wins.
//
// §C enrich:
//   - peer-virt FIRST-CLASS per ADR-0006 — parse reads peer-context
//     from the underscore-suffixed packages key (dominant path).
//   - peer-virt three-branch derivation (1 / ≥2 / 0 candidates) as
//     fallback when on-disk peer-context is incomplete.
//   - workspace concretisation from `importers` + manifest input.
//
// §D optimize: prune unreachable from `graph.roots()` BFS — verbatim
// ADR-0016 §D.

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
  type TarballKeyInputs,
} from '../graph.ts'
import { emitSri } from '../recipe/integrity.ts'
import { LockfileError } from '../errors.ts'
import { nodeVersionOf } from './_node-id.ts'
import { emitDropped as patchEmitDropped } from '../recipe/diagnostics.ts'
import {
  DEFAULT_NPM_REGISTRY,
  stringifyForPnpm,
  type ResolutionCanonical,
} from '../recipe/resolution.ts'
import { readYaml, emitYaml, flowMap, type YamlMap } from './_pnpm-yaml.ts'

function tailOfName(name: string): string {
  return name.startsWith('@') ? name.split('/').slice(1).join('/') : name
}

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
import {
  cmpStr,
  derivePeerCandidates,
  isPlainObject,
  locatePnpmRootNode,
  normalizeLineEndings,
  prunePnpmSidecar,
  relativeImporterPath,
  resolveLinkPath,
  resolvePeerTargetById,
  sortRecord,
  tarballPayloadOf,
} from './_pnpm-flat-core.ts'

// === Public option types ====================================================

export interface PnpmV5ParseOptions {}

export interface PnpmV5StringifyOptions {
  lineEnding?: 'lf' | 'crlf'
  onDiagnostic?: (diagnostic: Diagnostic) => void
}

export interface PnpmV5Manifest {
  name?: string
  version?: string
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}

export interface PnpmV5EnrichOptions {
  manifests?: Record<string, PnpmV5Manifest>
}

export interface PnpmV5OptimizeOptions {}

// v5 has NO settings block in its own schema — this interface only exists for
// cross-version sidecar shape parity (e.g. a graph parsed via v6 then emitted
// via v5 carries the v6 settings on the sidecar; we surface them on
// `PNPM_V5_SETTINGS_DROPPED` then discard).
export interface PnpmV5SettingsCrossVersion {
  autoInstallPeers?: boolean
  excludeLinksFromLockfile?: boolean
}

// === Sidecar ================================================================

interface PnpmV5NodeSidecar {
  peerDependencies?: Record<string, string>
  engines?: Record<string, string>
  hasBin?: boolean
  os?: string[]
  cpu?: string[]
  dev?: boolean
  optional?: boolean
}

interface PnpmV5EdgeSidecar {
  /** Resolved on-disk version field (preserves peer-context underscore tail). */
  resolvedVersion?: string
  /** Importer-declared specifier (the `specifiers` block value). */
  specifier?: string
}

interface PnpmV5Sidecar {
  rootId: string
  importerPaths: string[]
  importerByPath: Map<string, string>
  /** Importer specifiers, keyed by importer path. */
  importerSpecifiers: Map<string, Record<string, string>>
  nodes: Map<string, PnpmV5NodeSidecar>
  importerEdges: Map<string, PnpmV5EdgeSidecar>
  /** Cross-version settings stash (for PNPM_V5_SETTINGS_DROPPED). */
  inboundSettings?: PnpmV5SettingsCrossVersion
}

const sidecarByGraph = new WeakMap<Graph, PnpmV5Sidecar>()

function rememberSidecar(graph: Graph, sidecar: PnpmV5Sidecar): void {
  sidecarByGraph.set(graph, sidecar)
}

// === Constants ==============================================================

const V5_LOCKFILE_VERSION_CANONICAL = 5.4
// Accepted on-disk literals (parsed back as bare strings by `_pnpm-yaml.ts`'s
// reader, which never coerces scalars to numbers). The 5.0 → 5.4 minor-bump
// range is collapsed to canonical `5.4` on emit per ADR-0022 §A.pnpm-v5.
const V5_LOCKFILE_VERSION_ACCEPTED = new Set(['5.0', '5.1', '5.2', '5.3', '5.4'])

const TOP_LEVEL_ORDER: readonly string[] = [
  'lockfileVersion',
  'specifiers',
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'importers',
  'packages',
]

const TOP_LEVEL_SECTION_KEYS: readonly string[] = ['importers', 'packages']

// Per ADR-0022 §A.pnpm-v5 r2 amendment: right-to-left peel grammar.
// Anchored at end-of-string; peer-name captures optional leading `@`
// for scoped peers, optional `/sub` segment for scoped names, then
// `@<version>` up to the next `_` boundary.
const PEER_TAIL_RE = /_(@?[^_@]+(?:\/[^_@]+)?)@([^_]+)$/

// === Public API: check / parse / stringify / enrich / optimize =============

export function check(input: string): boolean {
  // Probe top-level `lockfileVersion: 5.<digit>` as a decimal scalar.
  // Reject quoted strings (v6/v9 use `'6.0'`/`'9.0'`).
  return /^\s*lockfileVersion\s*:\s*5\.\d+\s*(?:#.*)?$/m.test(input)
}

export function parse(input: string, _options: PnpmV5ParseOptions = {}): Graph {
  const normalized = normalizeLineEndings(input)
  const yaml = readYaml(normalized)

  // The YAML reader is shape-agnostic for scalars — both `5.4` (decimal)
  // and `'6.0'` (quoted) come back as the same JS string. The reader
  // never coerces. The byte-level regex below is therefore the
  // authoritative discriminator between v5 (unquoted) and v6/v9 (quoted);
  // the accepted-literal set check is a secondary sanity gate. Both run
  // so that hand-edited inputs whose literal lies outside `{5.0..5.4}`
  // surface a clear FORMAT_MISMATCH with the parsed-but-rejected value
  // in the message.
  if (!/^\s*lockfileVersion\s*:\s*5\.\d+\s*(?:#.*)?$/m.test(normalized)) {
    throw new LockfileError({
      code: 'FORMAT_MISMATCH',
      message: `pnpm-v5 adapter: lockfileVersion must be an unquoted decimal scalar (5.0…5.4); got ${JSON.stringify(yaml.lockfileVersion)}`,
    })
  }
  const versionStr = String(yaml.lockfileVersion)
  if (!V5_LOCKFILE_VERSION_ACCEPTED.has(versionStr)) {
    throw new LockfileError({
      code: 'FORMAT_MISMATCH',
      message: `pnpm-v5 adapter: expected lockfileVersion in {5.0…5.4}, got ${JSON.stringify(yaml.lockfileVersion)}`,
    })
  }

  const builder = newBuilder()
  const diagnostics: Diagnostic[] = []
  const sidecar: PnpmV5Sidecar = {
    rootId: '',
    importerPaths: [],
    importerByPath: new Map<string, string>(),
    importerSpecifiers: new Map<string, Record<string, string>>(),
    nodes: new Map<string, PnpmV5NodeSidecar>(),
    importerEdges: new Map<string, PnpmV5EdgeSidecar>(),
  }

  const packagesMap = isPlainObject(yaml.packages) ? yaml.packages : {}

  // --- Pass 1: build node set from packages keys (peer-context lives
  //             directly on key per right-to-left peel grammar). ---
  const seenIds = new Set<string>()
  const idByPackagesKey = new Map<string, string>()
  for (const pkgKey of Object.keys(packagesMap)) {
    const parsed = parsePackagesKey(pkgKey)
    if (parsed === undefined) {
      diagnostics.push({
        code: 'PNPM_BAD_ENTRY',
        severity: 'warning',
        message: `pnpm-v5 packages key ${JSON.stringify(pkgKey)} not parseable`,
      })
      continue
    }
    const { name, version: ver, peers } = parsed
    const peerContext = peers.map(p => `${p.name}@${p.version}`).sort(cmpStr)
    const nodeId = serializeNodeId(name, ver, peerContext)
    if (seenIds.has(nodeId)) continue
    seenIds.add(nodeId)
    idByPackagesKey.set(pkgKey, nodeId)
    addPackageNode(builder, sidecar, name, ver, peerContext, nodeId, packagesMap[pkgKey], diagnostics)
  }

  // --- Pass 2: importers — single-importer collapsed-root vs multi. ---
  //
  // Layout discriminant: `importers` block present ⇒ multi-importer
  // mode (each importer carries its own `specifiers` + `dependencies`
  // sub-blocks). Otherwise single-importer mode (top-level
  // `specifiers` + `dependencies` collapse to the root importer).
  //
  // PNPM_V5_DUAL_TOP_LEVEL_DRIFT — hand-edited input may carry both
  // shapes; `importers` wins on parse.
  const importersMap = isPlainObject(yaml.importers) ? yaml.importers : undefined
  const hasTopLevelDeps = yaml.specifiers !== undefined
    || yaml.dependencies !== undefined
    || yaml.devDependencies !== undefined
    || yaml.optionalDependencies !== undefined
  if (importersMap !== undefined && hasTopLevelDeps) {
    diagnostics.push({
      code: 'PNPM_V5_DUAL_TOP_LEVEL_DRIFT',
      severity: 'warning',
      message: 'pnpm-v5: input carries both top-level `specifiers`/`dependencies` and `importers`; `importers` wins',
    })
  }

  const effectiveImporters: Record<string, unknown> = {}
  if (importersMap !== undefined) {
    for (const key of Object.keys(importersMap)) {
      effectiveImporters[key] = importersMap[key]
    }
  } else if (hasTopLevelDeps) {
    effectiveImporters['.'] = buildCollapsedRootImporter(yaml)
  }
  if (Object.keys(effectiveImporters).length === 0) {
    effectiveImporters['.'] = {}
  }

  const importerPaths = Object.keys(effectiveImporters).sort(cmpStr)
  const rootImporterPath = importerPaths.includes('.') ? '.' : (importerPaths[0] ?? '.')

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

  // --- Pass 3: importer edges + specifiers sidecar. ---
  for (const importerPath of importerPaths) {
    const srcId = sidecar.importerByPath.get(importerPath)
    if (srcId === undefined) continue
    const importerEntry = effectiveImporters[importerPath]
    if (!isPlainObject(importerEntry)) continue

    // Capture specifiers sidecar verbatim.
    const specMap = importerEntry.specifiers
    if (isPlainObject(specMap)) {
      const localSpecs: Record<string, string> = {}
      for (const [k, v] of Object.entries(specMap)) {
        if (typeof v === 'string') localSpecs[k] = v
      }
      if (Object.keys(localSpecs).length > 0) {
        sidecar.importerSpecifiers.set(importerPath, localSpecs)
      }
    }

    for (const [kind, blockName] of [
      ['dep', 'dependencies'],
      ['dev', 'devDependencies'],
      ['optional', 'optionalDependencies'],
    ] as const) {
      const block = importerEntry[blockName]
      if (!isPlainObject(block)) continue
      const entries = Object.entries(block).sort((a, b) => cmpStr(a[0], b[0]))
      for (const [depName, depValue] of entries) {
        if (typeof depValue !== 'string') continue
        const specifier = isPlainObject(specMap) && typeof specMap[depName] === 'string'
          ? (specMap[depName] as string)
          : undefined

        // `link:` resolution (workspace cross-refs).
        if (depValue.startsWith('link:')) {
          const linkPath = resolveLinkPath(importerPath, depValue.slice(5))
          const targetId = sidecar.importerByPath.get(linkPath)
          if (targetId === undefined) {
            diagnostics.push({
              code: 'PNPM_UNRESOLVED_DEP',
              severity: 'warning',
              subject: srcId,
              message: `pnpm-v5: importer ${JSON.stringify(importerPath)} dep ${depName} resolves to unknown workspace ${JSON.stringify(linkPath)}`,
            })
            continue
          }
          // ADR-0014 §4.F4 — populate canonical workspaceRange sidecar.
          // pnpm-v5 carries `workspace:<spec>` via the specifiers map;
          // the dep value (`link:<path>`) is resolution, not range.
          // resolvedVersion is the synthesised member node version
          // parsed from the targetId (`<importerPath>@<version>`).
          const rawSpecifier = specifier ?? ''
          const targetVersion = nodeVersionOf(targetId)
          const workspaceRange = targetVersion !== undefined && targetVersion !== ''
            ? { specifier: rawSpecifier, resolvedVersion: targetVersion }
            : { specifier: rawSpecifier }
          const attrs: { range: string; workspace: boolean; workspaceRange?: { specifier: string; resolvedVersion?: string } } = {
            range: specifier ?? depValue,
            workspace: true,
            workspaceRange,
          }
          try {
            builder.addEdge(srcId, targetId, kind, attrs)
          } catch (error) {
            if (error instanceof GraphError && error.code === 'INVARIANT_VIOLATION') continue
            throw error
          }
          const edgeKey = `${srcId}\0${kind}\0${targetId}`
          sidecar.importerEdges.set(edgeKey, { resolvedVersion: depValue, specifier })
          continue
        }

        // Bare version (with optional `_peer@version` suffix per v5 syntax).
        let targetId = resolveDependencyTarget(seenIds, depName, depValue)
        let aliasSlot: string | undefined
        if (targetId === undefined) {
          const aliased = resolveAliasedDependencyTarget(seenIds, depValue)
          if (aliased !== undefined) {
            targetId = aliased
            aliasSlot = depName
          }
        }
        if (targetId === undefined) {
          diagnostics.push({
            code: 'PNPM_UNRESOLVED_DEP',
            severity: 'warning',
            subject: srcId,
            message: `pnpm-v5: importer ${JSON.stringify(importerPath)} dep ${depName}@${depValue} resolves to no packages entry`,
          })
          continue
        }
        try {
          const attrs: { range: string; alias?: string } = { range: specifier ?? depValue }
          if (aliasSlot !== undefined) attrs.alias = aliasSlot
          builder.addEdge(srcId, targetId, kind, attrs)
        } catch (error) {
          if (error instanceof GraphError && error.code === 'INVARIANT_VIOLATION') continue
          throw error
        }
        const edgeKey = `${srcId}\0${kind}\0${targetId}`
        sidecar.importerEdges.set(edgeKey, { resolvedVersion: depValue, specifier })
      }
    }
  }

  // --- Pass 4: resolved-tree edges from packages entries (inline transitives). ---
  for (const pkgKey of Object.keys(packagesMap)) {
    const srcId = idByPackagesKey.get(pkgKey)
    if (srcId === undefined) continue
    const parsed = parsePackagesKey(pkgKey)
    if (parsed === undefined) continue
    const pkgEntry = packagesMap[pkgKey]
    if (!isPlainObject(pkgEntry)) continue
    addResolvedTreeEdges(builder, diagnostics, srcId, pkgEntry, parsed.peers, seenIds, sidecar)
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
        message: `pnpm-v5 seal failed: ${error.message}`,
      })
    }
    throw error
  }
}

export function stringify(graph: Graph, options: PnpmV5StringifyOptions = {}): string {
  const sidecar = sidecarByGraph.get(graph)
  const emitDiagnostic = (diagnostic: Diagnostic): void => {
    options.onDiagnostic?.(diagnostic)
  }

  // Patch slot is not part of v5 schema in the working corpus — warn and drop.
  const warnedPatches = new Set<string>()
  for (const node of graph.nodes()) {
    if (node.patch !== undefined && !warnedPatches.has(node.id)) {
      warnedPatches.add(node.id)
      patchEmitDropped(
        node.id,
        'patch',
        `pnpm-v5 has no patch slot in the working corpus; ${JSON.stringify(node.patch)} dropped`,
        emitDiagnostic,
      )
    }
  }

  // Settings carried via cross-version composition (v6/v9 sidecar) — drop on emit.
  if (sidecar?.inboundSettings !== undefined && Object.keys(sidecar.inboundSettings).length > 0) {
    emitDiagnostic({
      code: 'PNPM_V5_SETTINGS_DROPPED',
      severity: 'warning',
      message: 'pnpm-v5 has no `settings` block; dropping cross-version settings on emit',
    })
  }

  const rootNode = locatePnpmRootNode(graph, sidecar)
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
  resolvedNodes.sort((a, b) => cmpStr(packagesKeyForNode(a), packagesKeyForNode(b)))

  const out: YamlMap = {}
  // Decimal scalar — NO quoted wrapper (numeric scalar emit path).
  out.lockfileVersion = V5_LOCKFILE_VERSION_CANONICAL

  // Layout discriminant: single-importer collapsed-root vs multi-importer.
  const hasMulti = workspaceNodes.length > 0
  if (hasMulti) {
    const importers: YamlMap = {}
    importers['.'] = buildImporterEntry(graph, sidecar, rootNode, '.')
    for (const wsNode of workspaceNodes) {
      const wsPath = wsNode.workspacePath ?? wsNode.name
      importers[wsPath] = buildImporterEntry(graph, sidecar, wsNode, wsPath)
    }
    out.importers = sortRecord(importers) as YamlMap
  } else {
    // Single-importer collapsed-root: top-level specifiers + deps blocks.
    const rootEntry = buildImporterEntry(graph, sidecar, rootNode, '.')
    if (rootEntry.specifiers !== undefined) out.specifiers = rootEntry.specifiers
    else out.specifiers = {}
    if (rootEntry.dependencies !== undefined) out.dependencies = rootEntry.dependencies
    if (rootEntry.devDependencies !== undefined) out.devDependencies = rootEntry.devDependencies
    if (rootEntry.optionalDependencies !== undefined) out.optionalDependencies = rootEntry.optionalDependencies
  }

  // packages — keyed `/<name>/<version>[<peer-tail>]` per node.
  const packages: YamlMap = {}
  for (const node of resolvedNodes) {
    const key = packagesKeyForNode(node)
    packages[key] = buildPackageEntry(graph, sidecar, node)
  }
  out.packages = packages

  // ADR-0028 INV-RESOLVE — verify the v5 encoding before serialising. v5 ships
  // a STANDALONE pipeline (it does not call `stringifyFamily`), so the verifier
  // is wired here separately or it ships uncovered.
  assertResolveValid(graph, out, rootNode, resolvedNodes, emitDiagnostic)

  const text = emitYaml(out, {
    topLevelOrder: TOP_LEVEL_ORDER,
    topLevelSectionKeys: TOP_LEVEL_SECTION_KEYS,
  })
  return options.lineEnding === 'crlf' ? text.replace(/\n/g, '\r\n') : text
}

// ADR-0028 INV-RESOLVE (pnpm v5) — the resolution-graph verifier, mirroring the
// v6/v9 `assertResolveValid` (`_pnpm-flat-core.ts`) over v5's standalone layout:
//
//   - consumer hop (`c` is the root or a workspace importer): `importers[path]`
//     `dependencies`/`devDependencies`/`optionalDependencies` (bare-string
//     values), or — single-importer collapsed-root — the top-level `out`
//     blocks. (The parallel `specifiers` map is the DESCRIPTOR, not a resolved
//     ref, so it is not resolved here.)
//   - package hop (`c` is a resolved package): the INLINE
//     `packages[key(c)].dependencies`/`optionalDependencies` (v5 has no
//     `snapshots:` block) — bare-string values.
//
// Resolution uses v5's own oracle (`resolveDependencyTarget` /
// `resolveAliasedDependencyTarget`) over the emitted packages-key NodeId set.
// Workspace-target (`link:`) edges are skipped. A miss is a soft
// `LAYOUT_RESOLVE_VIOLATION` (error) — no throw.
function assertResolveValid(
  graph: Graph,
  out: YamlMap,
  rootNode: Node | undefined,
  resolvedNodes: readonly Node[],
  onDiagnostic: (d: Diagnostic) => void,
): void {
  const seenIds = new Set<string>(resolvedNodes.map(n => n.id))

  const importersMap = isPlainObject(out.importers) ? (out.importers as Record<string, unknown>) : undefined
  const consumerBlockOf = (consumer: Node): Record<string, unknown> | undefined => {
    const path = consumer.id === rootNode?.id ? '.' : (consumer.workspacePath ?? consumer.name)
    if (importersMap !== undefined) {
      const block = importersMap[path]
      return isPlainObject(block) ? (block as Record<string, unknown>) : undefined
    }
    return consumer.id === rootNode?.id ? (out as Record<string, unknown>) : undefined
  }

  const packagesMap = isPlainObject(out.packages) ? (out.packages as Record<string, unknown>) : undefined
  const packageBlockOf = (pkg: Node): Record<string, unknown> | undefined => {
    const entry = packagesMap?.[packagesKeyForNode(pkg)]
    return isPlainObject(entry) ? (entry as Record<string, unknown>) : undefined
  }

  const slotValue = (block: Record<string, unknown>, blockNames: readonly string[], seg: string): string | undefined => {
    for (const blockName of blockNames) {
      const sub = block[blockName]
      if (!isPlainObject(sub)) continue
      const raw = (sub as Record<string, unknown>)[seg]
      if (typeof raw === 'string') return raw
    }
    return undefined
  }

  const isImporter = (node: Node): boolean =>
    node.id === rootNode?.id || (node.workspacePath !== undefined && node.workspacePath !== '')
  const consumerBlockNames = ['dependencies', 'devDependencies', 'optionalDependencies'] as const
  const packageBlockNames = ['dependencies', 'optionalDependencies'] as const

  for (const consumer of graph.nodes()) {
    const consumerIsImporter = isImporter(consumer)
    if (!consumerIsImporter && !seenIds.has(consumer.id)) continue
    const block = consumerIsImporter ? consumerBlockOf(consumer) : packageBlockOf(consumer)
    if (block === undefined) continue
    const blockNames = consumerIsImporter ? consumerBlockNames : packageBlockNames

    for (const edge of graph.out(consumer.id)) {
      if (edge.kind !== 'dep' && edge.kind !== 'dev' && edge.kind !== 'optional') continue
      const dst = graph.getNode(edge.dst)
      if (dst === undefined) continue
      if (dst.workspacePath !== undefined && dst.workspacePath !== '') continue
      if (!consumerIsImporter && (dst.id === consumer.id || dst.id === rootNode?.id)) continue

      const seg = edge.attrs?.alias ?? dst.name
      const value = slotValue(block, blockNames, seg)
      const resolved = value === undefined
        ? undefined
        : (resolveDependencyTarget(seenIds, seg, value) ?? resolveAliasedDependencyTarget(seenIds, value))
      if (resolved !== dst.id) {
        onDiagnostic({
          code: 'LAYOUT_RESOLVE_VIOLATION',
          severity: 'error',
          subject: { src: edge.src, dst: edge.dst, kind: edge.kind },
          message:
            `INV-RESOLVE violated: ${consumer.id} resolves ${JSON.stringify(seg)} to ` +
            `${value === undefined ? '(no slot)' : (resolved === undefined ? `${JSON.stringify(value)} → (nothing)` : resolved)}, ` +
            `expected ${dst.id} (pnpm-v5 encoding defect — ADR-0028 INV-RESOLVE)`,
        })
      }
    }
  }
}

export function enrich(
  graph: Graph,
  options: PnpmV5EnrichOptions = {},
): { graph: Graph; diagnostics: Diagnostic[] } {
  const sidecar = sidecarByGraph.get(graph)
  const diagnostics: Diagnostic[] = []

  // §C peer-virt three-branch fallback (dominant path: peer-context
  // already read at parse from underscore-suffixed packages keys).
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

      const candidates = derivePeerCandidates(graph, peerName, peerRange)
      if (candidates.length === 1) {
        diagnostics.push({
          code: 'PNPM_V5_PEER_BOUND',
          severity: 'info',
          subject: node.id,
          message: `peer ${JSON.stringify(peerName)} range ${JSON.stringify(peerRange)} → ${candidates[0]} (1-candidate fallback; on-disk peer-context absent)`,
        })
      } else if (candidates.length === 0) {
        diagnostics.push({
          code: 'PNPM_V5_PEER_UNSATISFIED',
          severity: 'warning',
          subject: node.id,
          message: `peer ${JSON.stringify(peerName)} range ${JSON.stringify(peerRange)} matches no installed version`,
        })
      } else {
        diagnostics.push({
          code: 'PNPM_V5_PEER_AMBIGUOUS',
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
        code: 'PNPM_V5_NO_MANIFESTS',
        severity: 'warning',
        message: 'pnpm-v5 workspace concretisation requires manifests; leaving graph unclassified',
      })
    }
    return { graph, diagnostics }
  }

  const plan = planManifestEnrich(graph, sidecar, options.manifests)
  if (plan.addRootEdges.length === 0 && plan.markWorkspaceEdges.length === 0) {
    return { graph, diagnostics }
  }

  const result = graph.mutate(m => {
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

export function optimize(
  graph: Graph,
  _options: PnpmV5OptimizeOptions = {},
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

  if (sidecar !== undefined) rememberSidecar(result.graph, prunePnpmSidecar(sidecar, result.graph))
  return { graph: result.graph, diagnostics: result.unresolved }
}

// === Parse helpers ==========================================================

export interface PeerEntry { name: string; version: string }
export interface ParsedPackagesKey { name: string; version: string; peers: PeerEntry[] }

/**
 * Right-to-left peel grammar per ADR-0022 §A.pnpm-v5 r2. Given
 * `<version>[_<peer>@<v>…]`, peel `_<peerName>@<peerVersion>` segments
 * from the tail while PEER_TAIL_RE matches; returns the bare version
 * (unconsumed remainder) and peers in canonical order. Returns undefined
 * for an empty input or fully-consumed remainder (no base version
 * left).
 *
 * v5-scoped-peer-grammar edge per ADR-0022 stub: scoped peers containing
 * underscores in path segments are theoretically ambiguous; absent from
 * the working corpus. PEER_TAIL_RE handles the common scoped-peer shape
 * `@scope/name@version` correctly.
 */
export function peelPeerTail(input: string): { version: string; peers: PeerEntry[] } | undefined {
  if (input.length === 0) return undefined
  let rest = input
  const peers: PeerEntry[] = []
  while (rest.length > 0) {
    const m = rest.match(PEER_TAIL_RE)
    if (m === null) break
    peers.unshift({ name: m[1]!, version: m[2]! })
    rest = rest.slice(0, rest.length - m[0]!.length)
  }
  if (rest.length === 0) return undefined
  return { version: rest, peers }
}

/**
 * Parse a v5 `/<name>/<version>[<peer-tail>]` packages key. Strip the
 * leading `/`, split on the LAST `/` for name vs `<version><peer-tail>`
 * (the version segment contains no `/`, so the rule applies uniformly
 * to scoped and unscoped names), then peel the peer tail right-to-left.
 */
export function parsePackagesKey(key: string): ParsedPackagesKey | undefined {
  if (!key.startsWith('/')) return undefined
  const body = key.slice(1)
  const lastSlash = body.lastIndexOf('/')
  if (lastSlash <= 0) return undefined
  const name = body.slice(0, lastSlash)
  const tail = body.slice(lastSlash + 1)
  if (name.length === 0) return undefined
  const peeled = peelPeerTail(tail)
  if (peeled === undefined) return undefined
  return { name, version: peeled.version, peers: peeled.peers }
}

export function resolveDependencyTarget(
  seenIds: Set<string>,
  depName: string,
  rawValue: string,
): string | undefined {
  const peeled = peelPeerTail(rawValue)
  if (peeled === undefined) return undefined
  const peerContext = peeled.peers.map(p => `${p.name}@${p.version}`).sort(cmpStr)
  const candidate = serializeNodeId(depName, peeled.version, peerContext)
  if (seenIds.has(candidate)) return candidate
  const bare = `${depName}@${peeled.version}`
  if (seenIds.has(bare)) return bare
  return undefined
}

/** pnpm v5 npm-alias variant: rawValue carries `<target>@<version>` rather than a bare version. */
export function resolveAliasedDependencyTarget(
  seenIds: Set<string>,
  rawValue: string,
): string | undefined {
  if (rawValue.indexOf('@', 1) <= 0) return undefined
  // Split at last `@` to peel target name + version (peer-tail handled
  // independently via peelPeerTail).
  let lastAt = -1
  for (let i = 1; i < rawValue.length; i++) {
    if (rawValue[i] === '@' && (rawValue[i + 1] !== undefined && rawValue[i + 1] !== '(')) lastAt = i
  }
  if (lastAt <= 0) return undefined
  const targetName = rawValue.slice(0, lastAt)
  const rest = rawValue.slice(lastAt + 1)
  const peeled = peelPeerTail(rest)
  if (peeled === undefined) return undefined
  const peerContext = peeled.peers.map(p => `${p.name}@${p.version}`).sort(cmpStr)
  const candidate = serializeNodeId(targetName, peeled.version, peerContext)
  if (seenIds.has(candidate)) return candidate
  const bare = `${targetName}@${peeled.version}`
  if (seenIds.has(bare)) return bare
  return undefined
}

function addPackageNode(
  builder: ReturnType<typeof newBuilder>,
  sidecar: PnpmV5Sidecar,
  name: string,
  version: string,
  peerContext: string[],
  nodeId: string,
  pkgEntry: unknown,
  diagnostics: Diagnostic[],
): void {
  const node: Node = {
    id: nodeId,
    name,
    version,
    peerContext,
  }
  builder.addNode(node)

  const payload = tarballPayloadOf(pkgEntry, nodeId, diagnostics)
  if (payload !== undefined) {
    builder.setTarball({ name, version }, payload)
  }

  const nodeSc: PnpmV5NodeSidecar = {}
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
    if (typeof pkgEntry.dev === 'boolean') nodeSc.dev = pkgEntry.dev
    if (typeof pkgEntry.optional === 'boolean') nodeSc.optional = pkgEntry.optional
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
  sidecar: PnpmV5Sidecar,
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
      let targetId = resolveDependencyTarget(seenIds, depName, rawValue)
      let aliasSlot: string | undefined
      if (targetId === undefined) {
        const aliased = resolveAliasedDependencyTarget(seenIds, rawValue)
        if (aliased !== undefined) {
          targetId = aliased
          aliasSlot = depName
        }
      }
      if (targetId === undefined) {
        diagnostics.push({
          code: 'PNPM_UNRESOLVED_DEP',
          severity: 'warning',
          subject: srcId,
          message: `pnpm-v5: ${srcId} dep ${depName}@${rawValue} resolves to no packages entry`,
        })
        continue
      }
      try {
        const attrs: { range: string; alias?: string } = { range: rawValue }
        if (aliasSlot !== undefined) attrs.alias = aliasSlot
        builder.addEdge(srcId, targetId, kind, attrs)
      } catch (error) {
        if (error instanceof GraphError && error.code === 'INVARIANT_VIOLATION') continue
        throw error
      }
    }
  }

  // Peer edges — derive from the parsed peers chain.
  for (const peer of peers) {
    const peerNodeId = resolvePeerTargetById(seenIds, peer.name, peer.version)
    if (peerNodeId === undefined) {
      diagnostics.push({
        code: 'PNPM_UNRESOLVED_DEP',
        severity: 'warning',
        subject: srcId,
        message: `pnpm-v5: ${srcId} peer ${peer.name}@${peer.version} resolves to no packages entry`,
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

function buildCollapsedRootImporter(yaml: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (yaml.specifiers !== undefined) out.specifiers = yaml.specifiers
  if (yaml.dependencies !== undefined) out.dependencies = yaml.dependencies
  if (yaml.devDependencies !== undefined) out.devDependencies = yaml.devDependencies
  if (yaml.optionalDependencies !== undefined) out.optionalDependencies = yaml.optionalDependencies
  return out
}

// === Stringify helpers ======================================================

function packagesKeyForNode(node: Node): string {
  // v5: `/<name>/<version>[_<peer>@<v>…]` — slash separator, underscore peers.
  const tail = node.peerContext.length === 0
    ? ''
    : node.peerContext.map(p => `_${p}`).join('')
  return `/${node.name}/${node.version}${tail}`
}

function nodeIdToDependencyValue(node: Node): string {
  // Importer-side `dependencies.<name>: <value>` rendering: bare version with
  // underscore peer-context tail. Mirrors the packages-key tail rule.
  const tail = node.peerContext.length === 0
    ? ''
    : node.peerContext.map(p => `_${p}`).join('')
  return `${node.version}${tail}`
}

// ADR-0028 INV-RESOLVE — the (slot-key, slot-value) pair for one dependency
// edge in a v5 `dependencies` / `specifiers` / inline-transitive block. A
// plain dep is `<dst.name>: <version>[_<peer>@v]` (pnpm-v5's bare encoding);
// an npm-aliased dep (`edge.attrs.alias` set) keys by the alias descriptor and
// values the CANONICAL `<dst.name>@<version>[_<peer>@v]`, the form parse's
// resolveAliasedDependencyTarget reconstructs (`pnpm-v5.ts:771-792`).
function aliasedDependencySlot(edge: Edge, dst: Node): { key: string; value: string } {
  const bareValue = nodeIdToDependencyValue(dst)
  const alias = edge.attrs?.alias
  if (alias === undefined) return { key: dst.name, value: bareValue }
  return { key: alias, value: `${dst.name}@${bareValue}` }
}

function buildImporterEntry(
  graph: Graph,
  sidecar: PnpmV5Sidecar | undefined,
  node: Node | undefined,
  importerPath: string,
): YamlMap {
  const entry: YamlMap = {}
  if (node === undefined) return entry

  const specifiers: Record<string, string> = {}
  const blocks: Record<EdgeKind, Record<string, string>> = {
    dep: {},
    dev: {},
    optional: {},
    peer: {},
    bundled: {},
  }

  const importerSpecs = sidecar?.importerSpecifiers.get(importerPath)

  for (const edge of graph.out(node.id)) {
    if (edge.kind === 'peer' || edge.kind === 'bundled') continue
    const dst = graph.getNode(edge.dst)
    if (dst === undefined) continue
    const isWorkspaceTarget = dst.workspacePath !== undefined && dst.workspacePath !== ''
    const edgeKey = `${edge.src}\0${edge.kind}\0${edge.dst}`
    const edgeSc = sidecar?.importerEdges.get(edgeKey)

    // ADR-0028 INV-RESOLVE — key both `specifiers` and the dep block by the
    // DESCRIPTOR segment (alias when set, else the package name) and emit the
    // CANONICAL `<name>@<version>` dep value for an alias. pnpm-v5 keys both
    // maps by the descriptor (`react-is-cjs:` in both), so an npm-aliased dep
    // must emit under the alias slot, not `dst.name`. The `importerEdges`
    // sidecar is keyed by the (src,kind,dst) triple, which an aliased and a
    // direct edge to the SAME node share, so an aliased edge prefers its own
    // per-edge descriptor + computed canonical value unless the capture is
    // already alias-consistent (`<dst.name>@…`); non-aliased edges keep the
    // round-trip-faithful capture verbatim.
    const slot = aliasedDependencySlot(edge, dst)
    const isAliased = edge.attrs?.alias !== undefined
    const range = edge.attrs?.range
    const specifierFromSidecar = importerSpecs?.[slot.key]
    const captureIsAliasConsistent = edgeSc?.resolvedVersion?.startsWith(`${dst.name}@`) === true
    const specifier = isAliased
      ? (range ?? specifierFromSidecar ?? edgeSc?.specifier ?? dst.version)
      : (edgeSc?.specifier ?? specifierFromSidecar ?? range ?? dst.version)
    const version = isWorkspaceTarget
      ? `link:${relativeImporterPath(importerPath, dst.workspacePath ?? dst.name)}`
      : isAliased
        ? (captureIsAliasConsistent ? edgeSc!.resolvedVersion! : slot.value)
        : (edgeSc?.resolvedVersion ?? slot.value)

    blocks[edge.kind][slot.key] = version
    specifiers[slot.key] = specifier
  }

  if (Object.keys(specifiers).length > 0) {
    entry.specifiers = sortRecord(specifiers) as YamlMap
  } else if (importerSpecs !== undefined && Object.keys(importerSpecs).length > 0) {
    // Empty edge set but importer had declared specifiers — preserve them.
    entry.specifiers = sortRecord(importerSpecs) as YamlMap
  } else {
    // Always emit `specifiers: {}` for non-root importers when empty
    // (root single-importer collapsed-root handles its own emit).
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

function buildPackageEntry(
  graph: Graph,
  sidecar: PnpmV5Sidecar | undefined,
  representative: Node,
): YamlMap {
  const entry: YamlMap = {}
  const tarball = graph.tarballOf(representative.id)
  // ADR-0014 §4.F3 — see pnpm-flat-core for the field semantics. Suppress
  // registry-default URLs (pnpm's implicit convention) and emit verbatim
  // URL only for non-registry shapes.
  const nativeResolution = tarball?.nativeResolution
  const nativeIsPnpmUrl = nativeResolution !== undefined
    && (nativeResolution.startsWith('http://')
      || nativeResolution.startsWith('https://'))
  const derivedPnpm = derivePnpmResolutionFromCanonical(tarball?.resolution)
  const derivedTarballIsRegistryDefault = tarball?.resolution?.type === 'tarball'
    && tarball.resolution.url === `${DEFAULT_NPM_REGISTRY}/${representative.name}/-/${tailOfName(representative.name)}-${representative.version}.tgz`
  if (tarball !== undefined) {
    const resolution: YamlMap = {}
    if (tarball.integrity !== undefined) {
      const integ = emitSri(tarball.integrity)
      if (integ !== undefined) resolution.integrity = integ
    }
    if (nativeIsPnpmUrl) resolution.tarball = nativeResolution!
    else if (derivedPnpm?.tarball !== undefined && !derivedTarballIsRegistryDefault) resolution.tarball = derivedPnpm.tarball
    else if (derivedPnpm?.directory !== undefined) resolution.directory = derivedPnpm.directory
    if (Object.keys(resolution).length > 0) entry.resolution = flowMap(resolution)
  } else if (nativeIsPnpmUrl) {
    entry.resolution = flowMap({ tarball: nativeResolution! })
  } else if (derivedPnpm?.tarball !== undefined && !derivedTarballIsRegistryDefault) {
    entry.resolution = flowMap({ tarball: derivedPnpm.tarball })
  } else if (derivedPnpm?.directory !== undefined) {
    entry.resolution = flowMap({ directory: derivedPnpm.directory })
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

  // Inline transitive dependencies.
  const blocks: Record<'dep' | 'optional', Record<string, string>> = { dep: {}, optional: {} }
  for (const edge of graph.out(representative.id)) {
    if (edge.kind !== 'dep' && edge.kind !== 'optional') continue
    const dst = graph.getNode(edge.dst)
    if (dst === undefined) continue
    if (dst.workspacePath !== undefined && dst.workspacePath !== '') continue
    if (dst.id === sidecar?.rootId) continue
    const block = blocks[edge.kind]!
    // ADR-0028 INV-RESOLVE — alias slot keying + canonical value (see
    // buildImporterEntry / aliasedDependencySlot).
    const slot = aliasedDependencySlot(edge, dst)
    block[slot.key] = slot.value
  }
  for (const [kind, blockName] of [['dep', 'dependencies'], ['optional', 'optionalDependencies']] as const) {
    const block = blocks[kind]
    if (Object.keys(block).length > 0) {
      entry[blockName] = sortRecord(block) as YamlMap
    }
  }

  // dev / optional per-entry flags.
  const dev = nodeSc?.dev ?? false
  entry.dev = dev
  if (nodeSc?.optional === true) entry.optional = true

  return entry
}

// === §C peer-virt fallback / enrich plan ====================================

interface EnrichPlan {
  addRootEdges: Edge[]
  markWorkspaceEdges: Edge[]
}

function planManifestEnrich(
  graph: Graph,
  sidecar: PnpmV5Sidecar | undefined,
  manifests: Record<string, PnpmV5Manifest>,
): EnrichPlan {
  const rootManifest = manifests['']
  const rootNodeId = sidecar?.rootId

  const addRootEdges: Edge[] = []
  const markWorkspaceEdges: Edge[] = []

  const memberByName = new Map<string, { path: string; manifest: PnpmV5Manifest }>()
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
        const attrs: { range: string; workspace?: boolean; workspaceRange?: { specifier: string; resolvedVersion?: string } } = { range }
        if (isWorkspaceProtocolRange(range) || memberByName.has(name)) {
          attrs.workspace = true
          // ADR-0014 §4.F4 — populate canonical workspaceRange sidecar.
          const rawSpecifier = isWorkspaceProtocolRange(range) ? range : ''
          const dst = graph.getNode(dstId)
          attrs.workspaceRange = dst?.version !== undefined && dst.version !== ''
            ? { specifier: rawSpecifier, resolvedVersion: dst.version }
            : { specifier: rawSpecifier }
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
      // ADR-0014 §4.F4 — populate canonical workspaceRange sidecar.
      const rawSpecifier = edge.attrs?.range !== undefined && edge.attrs.range.startsWith('workspace:')
        ? edge.attrs.range
        : ''
      const workspaceRange = dst.version !== undefined && dst.version !== ''
        ? { specifier: rawSpecifier, resolvedVersion: dst.version }
        : { specifier: rawSpecifier }
      markWorkspaceEdges.push({
        src: edge.src,
        dst: edge.dst,
        kind: edge.kind,
        attrs: { ...edge.attrs, workspace: true, workspaceRange },
      })
    }
  }

  return { addRootEdges, markWorkspaceEdges }
}

function resolveManifestTarget(
  graph: Graph,
  name: string,
  range: string,
  memberByName: Map<string, { path: string; manifest: PnpmV5Manifest }>,
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
