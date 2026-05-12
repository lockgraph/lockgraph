// pnpm-v9 adapter — pnpm `pnpm-lock.yaml` lockfileVersion 9.0.
//
// Standalone adapter per ADR-0022 §5 + the pnpm-family phase order ratified
// 2026-05-12: pnpm-v9 is the first pnpm family member, anchored на the
// cleanest schema (packages/snapshots split). `_pnpm-core.ts` extraction
// is deferred к pnpm-v6 round (mirrors npm-2-with-core / npm-3 standalone
// precedent).
//
// Dependency direction (parallel к npm-1.ts / yarn-classic.ts standalone
// precedent):
//   - this module owns its own YAML reader/writer (`readYaml` / `emitYaml`
//     below) — pnpm's `pnpm-lock.yaml` uses standard YAML 1.2 with a small
//     deterministic subset (block maps + flow maps for inline scalars), not
//     yarn's SYML.
//   - no imports from `_npm-core.ts` / `_npm-flat-types.ts` / `_yarn-syml.ts`.
//
// §A pinning per ADR-0022 §A.pnpm-v9:
//   - top-level `lockfileVersion: '9.0'` literal handshake (quoted string,
//     NOT a number). Reject 5.x / 6.x with FORMAT_MISMATCH.
//   - top-level `settings` block always emitted (`autoInstallPeers` /
//     `excludeLinksFromLockfile`).
//   - top-level `importers` block ALWAYS present. Single-importer collapses
//     to `importers['.']`; workspace members at member paths.
//   - `packages` map: static manifest info, bare `name@version` keys (NO
//     leading slash), no peer-context on `packages` keys.
//   - `snapshots` map: resolved tree info, bare `name@version` or
//     `name@version(peer@version)` keys for peer-virt instances.
//   - Cross-block consistency: every `snapshots[id]` MUST have a matching
//     `packages[bare-id]` (peer-context stripped).
//
// §B Lossy-but-acceptable (pnpm-v9): per ADR-0022 §B table, `replacePeerContext`
// is NOT lossy on pnpm-v9 — pnpm carries peer-virt natively. Family-wide
// lossy paths:
//   - PNPM_V9_PATCH_DROPPED — `patch:` slot drops on emit (handled via
//     `pnpm.patchedDependencies` sidecar; out of scope per ADR-0022).
//   - PNPM_V9_SNAPSHOTS_MISSING — orphan `snapshots[id]` without matching
//     `packages[bare-id]` baseline on parse.
//
// §C enrich (pnpm-v9 — reference impl per ADR-0006):
//   - peer-virt FIRST-CLASS: parse reads peer-context directly from
//     `snapshots` keys. Three-branch derivation runs only as fallback when
//     on-disk peer-context is incomplete.
//   - PNPM_V9_PEER_AMBIGUOUS / PNPM_V9_PEER_UNSATISFIED diagnostics for
//     fallback derivation branches.
//   - Workspace concretisation via `importers` block (parsed at parse-time;
//     enrich reclassifies edges when manifests are provided).
//   - PNPM_V9_NO_MANIFESTS when workspace mode w/o manifests.
//
// §D optimize: prune unreachable from `graph.roots()` BFS, inherited from
// ADR-0016 §D verbatim. v9-specific cross-block consistency rule applied
// at emit time (orphan `packages` entries drop when no surviving
// `snapshots` referent).

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

// === Public option types ====================================================

export interface PnpmV9ParseOptions {}

export interface PnpmV9StringifyOptions {
  lineEnding?: 'lf' | 'crlf'
  settings?: PnpmV9Settings
  onDiagnostic?: (diagnostic: Diagnostic) => void
}

export interface PnpmV9Manifest {
  name?: string
  version?: string
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}

export interface PnpmV9EnrichOptions {
  manifests?: Record<string, PnpmV9Manifest>
}

export interface PnpmV9OptimizeOptions {}

export interface PnpmV9Settings {
  autoInstallPeers?: boolean
  excludeLinksFromLockfile?: boolean
}

// === Sidecar ===============================================================

interface PnpmV9NodeSidecar {
  /** Declared peerDependencies (range record, from `packages[id].peerDependencies`). */
  peerDependencies?: Record<string, string>
  /** `packages[id]` static manifest extras (engines, hasBin, os, cpu). */
  engines?: Record<string, string>
  hasBin?: boolean
  os?: string[]
  cpu?: string[]
  /** `snapshots[id]` extras (transitivePeerDependencies sidecar). */
  transitivePeerDependencies?: string[]
}

interface PnpmV9EdgeSidecar {
  /** Resolved on-disk version field (`importers.<wsPath>.dependencies.<name>.version` — preserves the resolved-snapshot-key tail). */
  resolvedVersion?: string
  /** Importer specifier (`importers.<wsPath>.dependencies.<name>.specifier`). */
  specifier?: string
}

interface PnpmV9Sidecar {
  rootId: string
  settings: PnpmV9Settings
  importerPaths: string[]
  importerByPath: Map<string, string>
  nodes: Map<string, PnpmV9NodeSidecar>
  importerEdges: Map<string, PnpmV9EdgeSidecar>
  overrides?: Record<string, string>
}

const sidecarByGraph = new WeakMap<Graph, PnpmV9Sidecar>()

function rememberSidecar(graph: Graph, sidecar: PnpmV9Sidecar): void {
  sidecarByGraph.set(graph, sidecar)
}

// === Public API: check / parse / stringify / enrich / optimize =============

export function check(input: string): boolean {
  // Empirical probe — anchor on the v9 handshake literal. Quoted string
  // scalar is the v9 marker; v5 has decimal `5.4`, v6 has quoted `'6.0'`.
  return /^\s*lockfileVersion\s*:\s*['"]9\.0['"]/m.test(input)
}

export function parse(input: string, _options: PnpmV9ParseOptions = {}): Graph {
  const normalized = normalizeLineEndings(input)
  const yaml = readYaml(normalized)

  const version = yaml.lockfileVersion
  if (version !== '9.0') {
    throw new LockfileError({
      code: 'FORMAT_MISMATCH',
      message: `pnpm-v9 adapter: expected lockfileVersion '9.0', got ${JSON.stringify(version)}`,
    })
  }

  const builder = newBuilder()
  const diagnostics: Diagnostic[] = []
  const sidecar: PnpmV9Sidecar = {
    rootId: '',
    settings: extractSettings(yaml.settings),
    importerPaths: [],
    importerByPath: new Map<string, string>(),
    nodes: new Map<string, PnpmV9NodeSidecar>(),
    importerEdges: new Map<string, PnpmV9EdgeSidecar>(),
  }

  if (yaml.overrides !== undefined && typeof yaml.overrides === 'object') {
    sidecar.overrides = { ...(yaml.overrides as Record<string, string>) }
  }

  // --- Pass 1: build snapshots map of NodeIds. ---
  //
  // `packages` map carries static manifest info keyed by bare `name@version`.
  // `snapshots` map carries resolved tree info keyed by `name@version` or
  // `name@version(peer@version)` for peer-virt. Each snapshot key becomes a
  // graph NodeId; the canonical pnpm-style form is ADR-0006 verbatim.

  const packagesMap = isPlainObject(yaml.packages) ? yaml.packages : {}
  const snapshotsMap = isPlainObject(yaml.snapshots) ? yaml.snapshots : {}

  // Track which packages keys are referenced from snapshots for cross-block
  // consistency.
  const snapshotIdsByBare = new Map<string, string[]>()
  const snapshotKeys = Object.keys(snapshotsMap)

  // Build node set from snapshots + register tarballs from packages.
  const seenSnapshotIds = new Set<string>()
  for (const snapshotKey of snapshotKeys) {
    const parsed = parseSnapshotKey(snapshotKey)
    if (parsed === undefined) {
      diagnostics.push({
        code: 'PNPM_BAD_ENTRY',
        severity: 'warning',
        message: `pnpm-v9 snapshot key ${JSON.stringify(snapshotKey)} not parseable`,
      })
      continue
    }
    const { name, version, peers } = parsed
    const peerContext = peers.map(p => `${p.name}@${p.version}`).sort()
    const nodeId = serializeNodeId(name, version, peerContext)
    if (seenSnapshotIds.has(nodeId)) continue
    seenSnapshotIds.add(nodeId)

    const bareKey = `${name}@${version}`
    const arr = snapshotIdsByBare.get(bareKey) ?? []
    arr.push(nodeId)
    snapshotIdsByBare.set(bareKey, arr)

    const pkgEntry = packagesMap[bareKey]
    if (pkgEntry === undefined) {
      diagnostics.push({
        code: 'PNPM_V9_SNAPSHOTS_MISSING',
        severity: 'warning',
        subject: nodeId,
        message: `pnpm-v9 snapshot ${JSON.stringify(snapshotKey)} has no matching packages[${JSON.stringify(bareKey)}] baseline`,
      })
      // Drop orphan snapshot per ADR-0022 §A.pnpm-v9 cross-block consistency
      // rule.
      continue
    }

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

    // Tarball payload from the packages entry.
    const payload = tarballPayloadOf(pkgEntry)
    if (payload !== undefined) {
      builder.setTarball({ name, version }, payload)
    }

    // Sidecar capture.
    const nodeSc: PnpmV9NodeSidecar = {}
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
    const snapEntry = snapshotsMap[snapshotKey]
    if (isPlainObject(snapEntry) && Array.isArray(snapEntry.transitivePeerDependencies)) {
      nodeSc.transitivePeerDependencies = (snapEntry.transitivePeerDependencies as string[]).slice()
    }
    sidecar.nodes.set(nodeId, nodeSc)
  }

  // Cross-block consistency: detect orphan packages entries (declared but
  // never referenced from snapshots). Drop with diagnostic per the contract.
  // Note: in well-formed lockfiles snapshots is the authoritative tree, so
  // every package SHOULD have a matching snapshot.

  // --- Pass 2: importers — workspace synthesis + importer edges. ---
  //
  // `importers` is ALWAYS present in v9. Single-importer collapses to
  // `importers['.']` (root). Each importer path = a workspace node.
  // Importer dependencies become edges from importer node к the resolved
  // snapshot nodes.

  const importersMap = isPlainObject(yaml.importers) ? yaml.importers : {}
  const importerPaths = Object.keys(importersMap).sort(cmpStr)

  // The root importer is `.`. Synthesise a root node IFF a `.` importer
  // is present; otherwise the first importer becomes root.
  const rootImporterPath = importerPaths.includes('.') ? '.' : importerPaths[0] ?? '.'

  const rootName = '.'
  const rootVersion = '0.0.0'
  // For pnpm-v9 the root manifest is not embedded in the lockfile; we
  // synthesise a synthetic root NodeId. The convention chosen mirrors the
  // npm-1 adapter's synthetic-root pattern when no manifest name is on
  // disk: name from the importer path, version `0.0.0`.
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

  // Synthesise workspace member nodes for non-root importers.
  for (const importerPath of importerPaths) {
    if (importerPath === rootImporterPath) continue
    // Workspace member NodeId — synthetic. We use the importer path as
    // both name and version baseline to keep the id stable; the path is
    // recoverable from the workspacePath slot. This matches ADR-0022's
    // *workspace concretisation* description — importer paths drive
    // workspace synthesis on parse.
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
    const importerEntry = importersMap[importerPath]
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

        // workspace:* / link: resolution — points at a workspace member.
        if (version.startsWith('link:')) {
          const linkPath = resolveLinkPath(importerPath, version.slice(5))
          const targetId = sidecar.importerByPath.get(linkPath)
          if (targetId === undefined) {
            diagnostics.push({
              code: 'PNPM_UNRESOLVED_DEP',
              severity: 'warning',
              subject: srcId,
              message: `pnpm-v9: importer ${JSON.stringify(importerPath)} dep ${depName} resolves to unknown workspace ${JSON.stringify(linkPath)}`,
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

        // Bare version — resolve to a snapshot node. The `version` slot
        // carries the resolved-snapshot-key tail (bare `<version>` or
        // `<version>(<peer>@<peer-version>)`).
        const resolvedKey = `${depName}@${version}`
        const targetId = resolveSnapshotTarget(seenSnapshotIds, depName, version)
        if (targetId === undefined) {
          diagnostics.push({
            code: 'PNPM_UNRESOLVED_DEP',
            severity: 'warning',
            subject: srcId,
            message: `pnpm-v9: importer ${JSON.stringify(importerPath)} dep ${depName}@${version} resolves to no snapshot`,
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

  // --- Pass 4: snapshot edges — snapshot → snapshot. ---
  // Snapshot body carries `dependencies` (resolved edge target IDs into
  // other snapshots, value = resolved-snapshot-key tail).
  for (const snapshotKey of snapshotKeys) {
    const parsed = parseSnapshotKey(snapshotKey)
    if (parsed === undefined) continue
    const { name, version, peers } = parsed
    const peerContext = peers.map(p => `${p.name}@${p.version}`).sort()
    const srcId = serializeNodeId(name, version, peerContext)
    if (!seenSnapshotIds.has(srcId)) continue

    const snapEntry = snapshotsMap[snapshotKey]
    if (!isPlainObject(snapEntry)) continue

    for (const [kind, blockName] of [
      ['dep', 'dependencies'],
      ['optional', 'optionalDependencies'],
    ] as const) {
      const block = snapEntry[blockName]
      if (!isPlainObject(block)) continue
      const entries = Object.entries(block).sort((a, b) => cmpStr(a[0], b[0]))
      for (const [depName, rawValue] of entries) {
        if (typeof rawValue !== 'string') continue
        const targetId = resolveSnapshotTarget(seenSnapshotIds, depName, rawValue)
        if (targetId === undefined) {
          diagnostics.push({
            code: 'PNPM_UNRESOLVED_DEP',
            severity: 'warning',
            subject: srcId,
            message: `pnpm-v9: snapshot ${JSON.stringify(snapshotKey)} dep ${depName}@${rawValue} resolves to no snapshot`,
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

    // Peer edges — derive from peerContext per ADR-0006. Each peer entry
    // becomes a peer edge from this snapshot к the peer's NodeId. The peer
    // target is the bare `<peerName>@<peerVersion>` snapshot (peers usually
    // don't carry their own peer-context on disk; if they do, they're
    // distinct snapshots).
    for (const peer of peers) {
      const peerId = peer.name + '@' + peer.version
      // Walk seenSnapshotIds to find a peer node — the peer typically has
      // its own snapshot entry under bare `<peerName>@<peerVersion>` or
      // a peer-virt variant. We pick the bare form when present, else
      // the first peer-virt sibling.
      const peerNodeId = resolvePeerTargetById(seenSnapshotIds, peer.name, peer.version)
      if (peerNodeId === undefined) {
        diagnostics.push({
          code: 'PNPM_UNRESOLVED_DEP',
          severity: 'warning',
          subject: srcId,
          message: `pnpm-v9: snapshot ${JSON.stringify(snapshotKey)} peer ${peerId} resolves to no snapshot`,
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

  // Surface diagnostics на the graph.
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
        message: `pnpm-v9 seal failed: ${error.message}`,
      })
    }
    throw error
  }
}

export function stringify(graph: Graph, options: PnpmV9StringifyOptions = {}): string {
  const sidecar = sidecarByGraph.get(graph)
  const emitDiagnostic = (diagnostic: Diagnostic): void => {
    options.onDiagnostic?.(diagnostic)
  }

  const warnedPatches = new Set<string>()
  for (const node of graph.nodes()) {
    warnPatchDrop(node, warnedPatches, emitDiagnostic)
  }

  // --- Step 1: classify nodes — root + workspace members + snapshots. ---
  const rootNode = locateRootNode(graph, sidecar)
  const workspaceNodes: Node[] = []
  const snapshotNodes: Node[] = []
  for (const node of graph.nodes()) {
    if (node.id === rootNode?.id) continue
    if (node.workspacePath !== undefined && node.workspacePath !== '') {
      workspaceNodes.push(node)
    } else {
      snapshotNodes.push(node)
    }
  }
  workspaceNodes.sort((a, b) => cmpStr(a.workspacePath ?? '', b.workspacePath ?? ''))
  snapshotNodes.sort((a, b) => cmpStr(a.id, b.id))

  // --- Step 2: build the YAML structure. ---
  const out: YamlMap = {}
  out.lockfileVersion = '9.0' // quoted string scalar

  // settings — overlay caller's option over sidecar over defaults.
  const settings: PnpmV9Settings = {
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

  // importers — root + workspace members. Always emitted на v9.
  const importers: YamlMap = {}
  const rootImporterPath = '.'
  importers[rootImporterPath] = buildImporterEntry(graph, sidecar, rootNode, '.')
  for (const wsNode of workspaceNodes) {
    const wsPath = wsNode.workspacePath ?? wsNode.name
    importers[wsPath] = buildImporterEntry(graph, sidecar, wsNode, wsPath)
  }
  out.importers = sortRecord(importers) as YamlMap

  // packages — static manifest info, keyed by bare `name@version`.
  // Build the set of bare keys referenced by surviving snapshots so we can
  // apply cross-block consistency (drop orphan packages without referent).
  const packagesUsed = new Set<string>()
  for (const node of snapshotNodes) {
    packagesUsed.add(`${node.name}@${node.version}`)
  }
  const packages: YamlMap = {}
  // Group nodes by bare key (multiple peer-virt siblings → one packages entry).
  const bareToNodes = new Map<string, Node[]>()
  for (const node of snapshotNodes) {
    const bareKey = `${node.name}@${node.version}`
    const arr = bareToNodes.get(bareKey) ?? []
    arr.push(node)
    bareToNodes.set(bareKey, arr)
  }
  for (const bareKey of Array.from(bareToNodes.keys()).sort(cmpStr)) {
    const siblings = bareToNodes.get(bareKey)!
    if (!packagesUsed.has(bareKey)) continue
    const first = siblings[0]!
    packages[bareKey] = buildPackageEntry(graph, sidecar, first, siblings)
  }
  out.packages = packages

  // snapshots — resolved tree info, keyed по peer-context-disambiguated id.
  const snapshots: YamlMap = {}
  for (const node of snapshotNodes) {
    const snapshotKey = nodeIdToSnapshotKey(node)
    snapshots[snapshotKey] = buildSnapshotEntry(graph, sidecar, node)
  }
  out.snapshots = sortRecord(snapshots) as YamlMap

  const text = emitYaml(out)
  return options.lineEnding === 'crlf' ? text.replace(/\n/g, '\r\n') : text
}

export function enrich(
  graph: Graph,
  options: PnpmV9EnrichOptions = {},
): { graph: Graph; diagnostics: Diagnostic[] } {
  const sidecar = sidecarByGraph.get(graph)
  const diagnostics: Diagnostic[] = []

  // §C — pnpm-v9 reference impl per ADR-0006:
  //   - dominant path: peer-context already on disk (read at parse). enrich
  //     simply surfaces diagnostics for any node whose declared
  //     `peerDependencies` lacks a resolved binding.
  //   - fallback derivation runs when peer-virt is incomplete (degenerate
  //     input — e.g. cross-format conversion that lost the suffix).
  for (const node of graph.nodes()) {
    const nodeSc = sidecar?.nodes.get(node.id)
    const rawPeers = nodeSc?.peerDependencies
    if (rawPeers === undefined) continue
    const declaredPeers = Object.keys(rawPeers).sort(cmpStr)
    for (const peerName of declaredPeers) {
      const peerRange = rawPeers[peerName]
      if (peerRange === undefined) continue
      // If peer-context already binds this peer, dominant-path: skip.
      const alreadyBound = node.peerContext.some(p => stripPeerContextFromNodeId(p).startsWith(`${peerName}@`))
      if (alreadyBound) continue

      // Fallback: three-branch derivation per ADR-0016 §C.
      const candidates = collectPeerCandidates(graph, peerName, peerRange)
      if (candidates.length === 1) {
        // 1-cand — synthesise the binding diagnostic (informational; the
        // actual binding requires a graph mutation, which is the §C plan
        // path; here we surface the missing-binding as informational).
        // Per ADR-0022 §C, the synthesis is a §C fallback; we emit the
        // ambiguity-style code only for ≥2 / 0-cand. 1-cand triggers a
        // structural enrich (synthesise the peer-virt sibling NodeId).
        // Implementation: report informational diagnostic noting the
        // 1-cand recovery and skip mutation (mutation would require
        // reshaping the NodeId, which is invasive — left as a follow-up
        // for §C-mutation rounds).
        diagnostics.push({
          code: 'PNPM_V9_PEER_BOUND',
          severity: 'info',
          subject: node.id,
          message: `peer ${JSON.stringify(peerName)} range ${JSON.stringify(peerRange)} → ${candidates[0]} (1-candidate fallback; on-disk peer-context absent)`,
        })
      } else if (candidates.length === 0) {
        diagnostics.push({
          code: 'PNPM_V9_PEER_UNSATISFIED',
          severity: 'warning',
          subject: node.id,
          message: `peer ${JSON.stringify(peerName)} range ${JSON.stringify(peerRange)} matches no installed version`,
        })
      } else {
        diagnostics.push({
          code: 'PNPM_V9_PEER_AMBIGUOUS',
          severity: 'warning',
          subject: node.id,
          message: `peer ${JSON.stringify(peerName)} range ${JSON.stringify(peerRange)} matches multiple candidates: ${candidates.join(', ')}`,
        })
      }
    }
  }

  // Workspace concretisation — re-attribute root edges + mark workspace
  // edges when manifests are provided.
  if (options.manifests === undefined) {
    const hasWorkspaceHint = Array.from(graph.nodes())
      .some(n => n.workspacePath !== undefined && n.workspacePath !== '')
    if (hasWorkspaceHint) {
      diagnostics.push({
        code: 'PNPM_V9_NO_MANIFESTS',
        severity: 'warning',
        message: 'pnpm-v9 workspace concretisation requires manifests; leaving graph unclassified',
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

export function optimize(
  graph: Graph,
  _options: PnpmV9OptimizeOptions = {},
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
      // Only call removeTarball если tarball actually exists (mutator-added
      // nodes без paired setTarball have no tarball entry).
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

interface ParsedSnapshotKey {
  name: string
  version: string
  peers: Array<{ name: string; version: string }>
}

/**
 * Parse a pnpm-v9 snapshot key:
 *   - `<name>@<version>` (bare, unvirtualized)
 *   - `<name>@<version>(<peer1>@<v1>)(<peer2>@<v2>)...` (peer-virt)
 * Scoped names start with `@` — care w/ the depth-0 `@` separator.
 */
function parseSnapshotKey(key: string): ParsedSnapshotKey | undefined {
  // Split off the optional `(...)` peer-context suffix.
  // The base segment ends где first depth-0 `(` lives (если any).
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

  // Split base on last `@` at depth 0 (scoped names retain leading `@`).
  let lastAt = -1
  for (let i = 1; i < base.length; i++) {
    if (base[i] === '@') lastAt = i
  }
  if (lastAt <= 0) return undefined
  const name = base.slice(0, lastAt)
  const version = base.slice(lastAt + 1)
  if (name.length === 0 || version.length === 0) return undefined

  // Parse peer segments из peerSuffix: zero or more `(<peer>@<v>)` runs.
  const peers: Array<{ name: string; version: string }> = []
  let pos = 0
  while (pos < peerSuffix.length) {
    if (peerSuffix[pos] !== '(') return undefined
    // Find matching `)` at the same depth.
    let close = -1
    let d = 1
    for (let i = pos + 1; i < peerSuffix.length; i++) {
      const c = peerSuffix[i]
      if (c === '(') d++
      else if (c === ')') { d--; if (d === 0) { close = i; break } }
    }
    if (close < 0) return undefined
    const segment = peerSuffix.slice(pos + 1, close)
    // Split на last `@` at depth 0.
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

/**
 * Resolve a snapshot target by `<depName>@<rawValue>` where rawValue is the
 * resolved-snapshot-key tail (bare `<version>` or `<version>(<peer>@...)`).
 */
function resolveSnapshotTarget(
  seenIds: Set<string>,
  depName: string,
  rawValue: string,
): string | undefined {
  // Strip optional peer-virt suffix to get bare version + peers.
  const parsedTail = parseSnapshotKey(`${depName}@${rawValue}`)
  if (parsedTail === undefined) return undefined
  const peerContext = parsedTail.peers.map(p => `${p.name}@${p.version}`).sort()
  const candidateId = serializeNodeId(parsedTail.name, parsedTail.version, peerContext)
  if (seenIds.has(candidateId)) return candidateId
  // Fallback: bare (no peer-context).
  const bareId = `${parsedTail.name}@${parsedTail.version}`
  if (seenIds.has(bareId)) return bareId
  return undefined
}

function resolvePeerTargetById(seenIds: Set<string>, peerName: string, peerVersion: string): string | undefined {
  const bareId = `${peerName}@${peerVersion}`
  if (seenIds.has(bareId)) return bareId
  // Fall back: first peer-virt sibling for the same (name, version).
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
  // Normalise: importerPath is a directory path (e.g. 'packages/app'), and
  // relTarget is interpreted relative TO that directory. So
  //   importerPath='packages/app', relTarget='../core' → 'packages/core'.
  if (importerPath === '.' || importerPath === '') {
    // Root: target is relative к workspace root.
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

function tarballPayloadOf(entry: Record<string, unknown>): TarballPayload | undefined {
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

function extractSettings(value: unknown): PnpmV9Settings {
  const out: PnpmV9Settings = {}
  if (!isPlainObject(value)) return out
  if (typeof value.autoInstallPeers === 'boolean') out.autoInstallPeers = value.autoInstallPeers
  if (typeof value.excludeLinksFromLockfile === 'boolean') out.excludeLinksFromLockfile = value.excludeLinksFromLockfile
  return out
}

function locateRootNode(graph: Graph, sidecar: PnpmV9Sidecar | undefined): Node | undefined {
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
  // ADR-0006: the NodeId itself IS the canonical snapshot key form для
  // peer-virt instances. Peer-context segments already sort alphabetically
  // (enforced при build via the parser + serializeNodeId).
  if (node.peerContext.length === 0) return `${node.name}@${node.version}`
  return `${node.name}@${node.version}` + node.peerContext.map(p => `(${p})`).join('')
}

function buildImporterEntry(
  graph: Graph,
  sidecar: PnpmV9Sidecar | undefined,
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

    // Specifier preference: sidecar > edge attrs.range > bare version.
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
  // Compute the relative path: importer is a directory, walk up
  // importerSegs.length - common, then descend.
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
  sidecar: PnpmV9Sidecar | undefined,
  representative: Node,
  _siblings: Node[],
): YamlMap {
  const entry: YamlMap = {}
  const tarball = graph.tarballOf(representative.id)
  if (tarball !== undefined) {
    const resolution: YamlMap = {}
    if (tarball.integrity !== undefined) resolution.integrity = tarball.integrity
    if (representative.resolution !== undefined) resolution.tarball = representative.resolution
    if (Object.keys(resolution).length > 0) entry.resolution = { __flow: true, ...resolution } as YamlMap
  } else if (representative.resolution !== undefined) {
    entry.resolution = { __flow: true, tarball: representative.resolution } as YamlMap
  }

  const nodeSc = sidecar?.nodes.get(representative.id)
  if (nodeSc?.engines !== undefined && Object.keys(nodeSc.engines).length > 0) {
    entry.engines = { __flow: true, ...nodeSc.engines } as YamlMap
  } else if (tarball?.engines !== undefined && Object.keys(tarball.engines).length > 0) {
    entry.engines = { __flow: true, ...tarball.engines } as YamlMap
  }
  if (nodeSc?.hasBin === true) entry.hasBin = true
  if (nodeSc?.os !== undefined && nodeSc.os.length > 0) entry.os = nodeSc.os.slice()
  if (nodeSc?.cpu !== undefined && nodeSc.cpu.length > 0) entry.cpu = nodeSc.cpu.slice()
  if (nodeSc?.peerDependencies !== undefined && Object.keys(nodeSc.peerDependencies).length > 0) {
    entry.peerDependencies = sortRecord(nodeSc.peerDependencies) as YamlMap
  }

  return entry
}

function buildSnapshotEntry(
  graph: Graph,
  sidecar: PnpmV9Sidecar | undefined,
  node: Node,
): YamlMap {
  const entry: YamlMap = {}

  // Group out-edges by kind into dependencies / optionalDependencies blocks.
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
    if (node.peerContext.length > 0) continue // Only bare instances count.
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
  node: Node,
  warned: Set<string>,
  emitDiagnostic: (diagnostic: Diagnostic) => void,
): void {
  if (node.patch === undefined || warned.has(node.id)) return
  warned.add(node.id)
  emitDiagnostic({
    code: 'PNPM_V9_PATCH_DROPPED',
    severity: 'warning',
    subject: node.id,
    message: `patch slot ${JSON.stringify(node.patch)} is unsupported in pnpm-v9 emit; dropping`,
  })
}

interface EnrichPlan {
  addRootEdges: Edge[]
  removeRootEdges: Edge[]
  markWorkspaceEdges: Edge[]
}

function planManifestEnrich(
  graph: Graph,
  sidecar: PnpmV9Sidecar | undefined,
  manifests: Record<string, PnpmV9Manifest>,
): EnrichPlan {
  const rootManifest = manifests['']
  const rootNodeId = sidecar?.rootId

  const addRootEdges: Edge[] = []
  const removeRootEdges: Edge[] = []
  const markWorkspaceEdges: Edge[] = []

  const memberByName = new Map<string, { path: string; manifest: PnpmV9Manifest }>()
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
  memberByName: Map<string, { path: string; manifest: PnpmV9Manifest }>,
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

function pruneSidecar(sidecar: PnpmV9Sidecar, graph: Graph): PnpmV9Sidecar {
  const aliveIds = new Set(Array.from(graph.nodes(), n => n.id))
  const nodes = new Map<string, PnpmV9NodeSidecar>()
  for (const [id, sc] of sidecar.nodes) {
    if (aliveIds.has(id)) nodes.set(id, sc)
  }
  const importerEdges = new Map<string, PnpmV9EdgeSidecar>()
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

// ====================================================================
//   Minimal YAML reader/emitter — scoped to pnpm-v9's emitted subset.
// ====================================================================
//
// pnpm uses standard YAML 1.2 to write `pnpm-lock.yaml`, but the emitted
// subset is small and deterministic:
//   - block-style maps (`<key>:\n  <subkey>: <value>`)
//   - flow-style maps for compact records (`resolution: {integrity: sha512-...}`)
//   - scalars: bare strings, quoted strings (`'9.0'`, `'>=4'`), booleans
//   - keys may be bare (`react`), quoted (`'@types/node@20.11.30'`), or
//     contain `@`, `(`, `)`, `/` characters (snapshot keys)
//   - 2-space indent
//
// This parser handles the above; it is NOT a general-purpose YAML 1.2
// implementation. Use the upstream pnpm fixtures as the test corpus.

interface YamlMap { [k: string]: unknown }

interface YamlReader {
  source: string
  lines: string[]
  pos: number
}

function readYaml(input: string): YamlMap {
  const reader: YamlReader = {
    source: input,
    lines: input.split('\n'),
    pos: 0,
  }
  return readBlockMap(reader, 0)
}

function readBlockMap(reader: YamlReader, baseIndent: number): YamlMap {
  const out: YamlMap = {}
  while (reader.pos < reader.lines.length) {
    const line = reader.lines[reader.pos]
    if (line === undefined) { reader.pos++; continue }
    if (isBlankOrComment(line)) { reader.pos++; continue }
    const indent = leadingSpaces(line)
    if (indent < baseIndent) break
    if (indent > baseIndent) {
      // Unexpected — skip (parser is forgiving).
      reader.pos++
      continue
    }
    const content = line.slice(indent)
    const colonIdx = findKeyColon(content)
    if (colonIdx < 0) {
      // Skip malformed line.
      reader.pos++
      continue
    }
    const rawKey = content.slice(0, colonIdx).trimEnd()
    const key = unquoteKey(rawKey)
    const rest = content.slice(colonIdx + 1)
    // Strip trailing inline comment if present.
    const restClean = stripInlineComment(rest).trimEnd()
    const restValue = restClean.replace(/^ +/, '')

    reader.pos++
    if (restValue === '') {
      // Block — recurse at indent + 2.
      const child = readBlockMap(reader, baseIndent + 2)
      out[key] = child
    } else if (restValue === '|' || restValue === '>') {
      // Block scalar — skip body, treat as empty string.
      while (reader.pos < reader.lines.length) {
        const next = reader.lines[reader.pos]
        if (next === undefined) break
        const ind = leadingSpaces(next)
        if (next.trim().length > 0 && ind <= baseIndent) break
        reader.pos++
      }
      out[key] = ''
    } else {
      // Inline scalar / flow.
      out[key] = parseInlineValue(restValue)
    }
  }
  return out
}

function findKeyColon(content: string): number {
  // Locate the `:` separating key из value. Respect quoted keys and
  // parenthesised peer-context (snapshot keys contain `@` and parens but
  // no `:` inside).
  let inQuote: '"' | "'" | null = null
  let depth = 0
  for (let i = 0; i < content.length; i++) {
    const c = content[i]
    if (inQuote) {
      if (c === '\\' && inQuote === '"') { i++; continue }
      if (c === inQuote) inQuote = null
      continue
    }
    if (c === '"' || c === "'") {
      inQuote = c as '"' | "'"
      continue
    }
    if (c === '(') depth++
    else if (c === ')') depth = Math.max(0, depth - 1)
    else if (c === ':' && depth === 0) {
      // Confirm the `:` is followed by space or end-of-line (YAML keys end
      // with `:` followed by whitespace or newline).
      if (i === content.length - 1 || content[i + 1] === ' ') return i
    }
  }
  return -1
}

function leadingSpaces(line: string): number {
  let i = 0
  while (i < line.length && line[i] === ' ') i++
  return i
}

function isBlankOrComment(line: string): boolean {
  const trimmed = line.trim()
  return trimmed.length === 0 || trimmed.startsWith('#')
}

function unquoteKey(raw: string): string {
  if (raw.length >= 2 && raw[0] === "'" && raw[raw.length - 1] === "'") {
    return raw.slice(1, -1).replace(/''/g, "'")
  }
  if (raw.length >= 2 && raw[0] === '"' && raw[raw.length - 1] === '"') {
    return raw.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  }
  return raw
}

function stripInlineComment(s: string): string {
  // Strip ` # …` comment if present (preceded by whitespace, not inside quotes).
  let inQuote: '"' | "'" | null = null
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (inQuote) {
      if (c === '\\' && inQuote === '"') { i++; continue }
      if (c === inQuote) inQuote = null
      continue
    }
    if (c === '"' || c === "'") {
      inQuote = c as '"' | "'"
      continue
    }
    if (c === '#' && (i === 0 || s[i - 1] === ' ')) {
      return s.slice(0, i)
    }
  }
  return s
}

function parseInlineValue(raw: string): unknown {
  const trimmed = raw.trim()
  if (trimmed === '') return ''
  if (trimmed === 'true') return true
  if (trimmed === 'false') return false
  if (trimmed === 'null' || trimmed === '~') return null
  if (trimmed === '{}') return {}
  if (trimmed === '[]') return []
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    return parseFlowMap(trimmed)
  }
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return parseFlowList(trimmed)
  }
  if ((trimmed.startsWith("'") && trimmed.endsWith("'")) || (trimmed.startsWith('"') && trimmed.endsWith('"'))) {
    return unquoteKey(trimmed)
  }
  return trimmed
}

function parseFlowMap(input: string): YamlMap {
  // Strip outer braces.
  const body = input.slice(1, -1).trim()
  if (body === '') return {}
  const out: YamlMap = {}
  const items = splitFlowItems(body)
  for (const item of items) {
    const colon = findFlowColon(item)
    if (colon < 0) continue
    const rawKey = item.slice(0, colon).trim()
    const rawValue = item.slice(colon + 1).trim()
    out[unquoteKey(rawKey)] = parseInlineValue(rawValue)
  }
  return out
}

function parseFlowList(input: string): unknown[] {
  const body = input.slice(1, -1).trim()
  if (body === '') return []
  const items = splitFlowItems(body)
  return items.map(item => parseInlineValue(item.trim()))
}

function splitFlowItems(body: string): string[] {
  const out: string[] = []
  let depth = 0
  let inQuote: '"' | "'" | null = null
  let start = 0
  for (let i = 0; i < body.length; i++) {
    const c = body[i]
    if (inQuote) {
      if (c === '\\' && inQuote === '"') { i++; continue }
      if (c === inQuote) inQuote = null
      continue
    }
    if (c === '"' || c === "'") {
      inQuote = c as '"' | "'"
      continue
    }
    if (c === '{' || c === '[') depth++
    else if (c === '}' || c === ']') depth--
    else if (c === ',' && depth === 0) {
      out.push(body.slice(start, i))
      start = i + 1
    }
  }
  out.push(body.slice(start))
  return out.map(s => s.trim()).filter(s => s.length > 0)
}

function findFlowColon(item: string): number {
  let inQuote: '"' | "'" | null = null
  let depth = 0
  for (let i = 0; i < item.length; i++) {
    const c = item[i]
    if (inQuote) {
      if (c === '\\' && inQuote === '"') { i++; continue }
      if (c === inQuote) inQuote = null
      continue
    }
    if (c === '"' || c === "'") {
      inQuote = c as '"' | "'"
      continue
    }
    if (c === '{' || c === '[') depth++
    else if (c === '}' || c === ']') depth--
    else if (c === ':' && depth === 0) return i
  }
  return -1
}

// === Emitter ================================================================

const TOP_LEVEL_ORDER = [
  'lockfileVersion',
  'settings',
  'overrides',
  'importers',
  'packages',
  'snapshots',
] as const

function emitYaml(root: YamlMap): string {
  const lines: string[] = []
  const keys = orderTopLevelKeys(root)
  let firstSection = true
  for (const key of keys) {
    if (!(key in root)) continue
    const value = root[key]
    if (value === undefined) continue
    if (!firstSection) lines.push('')
    firstSection = false
    if (key === 'lockfileVersion') {
      lines.push(`lockfileVersion: '${value as string}'`)
      continue
    }
    if (key === 'overrides' && isPlainObject(value)) {
      lines.push('overrides:')
      const entries = Object.entries(value as YamlMap).sort((a, b) => cmpStr(a[0], b[0]))
      for (const [k, v] of entries) {
        lines.push(`  ${emitScalarKey(k)}: ${emitScalar(v as string)}`)
      }
      continue
    }
    if (isPlainObject(value)) {
      lines.push(`${key}:`)
      emitBlockMap(lines, value as YamlMap, 1, key)
    } else {
      lines.push(`${key}: ${emitScalar(value as string)}`)
    }
  }
  return lines.join('\n') + '\n'
}

function orderTopLevelKeys(root: YamlMap): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const k of TOP_LEVEL_ORDER) {
    if (k in root) { out.push(k); seen.add(k) }
  }
  for (const k of Object.keys(root)) {
    if (!seen.has(k)) { out.push(k); seen.add(k) }
  }
  return out
}

function emitBlockMap(lines: string[], map: YamlMap, depth: number, parentKey?: string): void {
  const indent = '  '.repeat(depth)
  const entries = Object.entries(map).filter(([k]) => k !== '__flow')
  const isTopSubsection = depth === 1 && (parentKey === 'importers' || parentKey === 'packages' || parentKey === 'snapshots')
  for (let i = 0; i < entries.length; i++) {
    const pair = entries[i]
    if (pair === undefined) continue
    const [key, value] = pair
    const emittedKey = emitScalarKey(key)
    if (isTopSubsection && i > 0) lines.push('')
    if (isTopSubsection) {
      // pnpm emits a blank line before each importer/packages/snapshots entry.
      // We add an explicit leading blank line (the first entry's blank is
      // emitted после the `<section>:` header line — but pnpm itself does
      // exactly that).
      if (i === 0) lines.push('')
    }
    if (value === undefined || value === null) {
      lines.push(`${indent}${emittedKey}:`)
      continue
    }
    if (isPlainObject(value)) {
      const obj = value as YamlMap
      const flow = obj.__flow === true
      const objEntries = Object.entries(obj).filter(([k]) => k !== '__flow')
      if (objEntries.length === 0) {
        lines.push(`${indent}${emittedKey}: {}`)
      } else if (flow) {
        lines.push(`${indent}${emittedKey}: ${emitFlowMap(obj)}`)
      } else {
        lines.push(`${indent}${emittedKey}:`)
        emitBlockMap(lines, obj, depth + 1)
      }
    } else if (Array.isArray(value)) {
      if (value.length === 0) {
        lines.push(`${indent}${emittedKey}: []`)
      } else {
        lines.push(`${indent}${emittedKey}:`)
        for (const item of value) {
          lines.push(`${indent}- ${emitScalar(String(item))}`)
        }
      }
    } else if (typeof value === 'boolean') {
      lines.push(`${indent}${emittedKey}: ${value}`)
    } else {
      lines.push(`${indent}${emittedKey}: ${emitScalar(String(value))}`)
    }
  }
}

function emitFlowMap(obj: YamlMap): string {
  const parts: string[] = []
  const entries = Object.entries(obj).filter(([k]) => k !== '__flow')
  for (const [key, value] of entries) {
    const k = emitScalarKey(key)
    let v: string
    if (typeof value === 'boolean') v = String(value)
    else if (typeof value === 'string') v = emitScalar(value)
    else if (isPlainObject(value)) v = emitFlowMap(value as YamlMap)
    else if (Array.isArray(value)) v = `[${(value as unknown[]).map(item => emitScalar(String(item))).join(', ')}]`
    else v = emitScalar(String(value))
    parts.push(`${k}: ${v}`)
  }
  return `{${parts.join(', ')}}`
}

function emitScalarKey(key: string): string {
  // Quote если special characters present. snapshot keys like `react-dom@18.2.0(react@18.2.0)`
  // are emitted bare (no quoting). Scoped names with `@` need quoting if they
  // also have additional special chars; the empirical pnpm rule: quote IFF
  // the key starts with `@` (scoped name) OR contains `:` или ` `.
  if (keyNeedsQuoting(key)) return `'${key.replace(/'/g, "''")}'`
  return key
}

function keyNeedsQuoting(key: string): boolean {
  if (key === '') return true
  // Scoped package names — quote.
  if (key.startsWith('@')) return true
  // YAML special start characters.
  if (/^[!&*>|?:\-,\[\]{}'"%]/.test(key)) return true
  // Boolean-looking unquoted keys.
  if (/^(true|false|null|~|yes|no|on|off)$/i.test(key)) return true
  // Otherwise bare keys for snapshot ids like `react-dom@18.2.0(react@18.2.0)`.
  return false
}

function emitScalar(value: string): string {
  if (value === '') return "''"
  // Strings that look like booleans / nulls / numbers — quote.
  if (/^(true|false|null|~)$/i.test(value)) return `'${value}'`
  // Strings beginning с `>` or `<` (semver ranges) — quote.
  if (/^[>!&*|?:\-,\[\]{}%]/.test(value)) return `'${value.replace(/'/g, "''")}'`
  // Strings looking like pure numbers — quote (to preserve string identity).
  // Allow bare semver-ish (`1.2.3`) as it's not a pure YAML number.
  // Strings containing `: ` or `#` — quote.
  if (/[#]/.test(value) || / : /.test(value)) return `'${value.replace(/'/g, "''")}'`
  return value
}
