import type { Edge, EdgeAttrs, Graph, TarballPayload } from '../graph.ts'
import { pnpmCatalogFeatureOf } from '../formats/_pnpm-flat-core.ts'
import {
  rawConditionsScalarOfNode,
  yarnBerryConditionsFeatureOf,
} from '../formats/_yarn-berry-core.ts'

export const GRAPH_FEATURES = [
  'edge:dep',
  'edge:dev',
  'edge:optional',
  'edge:peer',
  'edge:bundled',
  'peer-context',
  'workspace',
  'edge-alias',
  'patch',
  'source-discriminator',
  'resolution:tarball',
  'resolution:git',
  'resolution:directory',
  'resolution:unknown',
  'integrity:tarball',
  'integrity:berry-zip',
  'conditions',
  'catalog',
  'metadata:engines',
  'metadata:funding',
  'metadata:license',
  'metadata:bin',
  'metadata:deprecated',
  'metadata:platform',
  'metadata:install-script',
  'metadata:bundled-dependencies',
  'metadata:peer-declarations',
] as const

export type GraphFeature = typeof GRAPH_FEATURES[number]

export type UnmodeledGraphFactReason =
  | 'unknown-key'
  | 'invalid-value'
  | 'invalid-shape'

export interface UnmodeledGraphFact {
  readonly subject: string
  readonly path: string
  readonly reason: UnmodeledGraphFactReason
}

export interface GraphFeatureDetection {
  readonly features: ReadonlySet<GraphFeature>
  readonly unmodeled: readonly UnmodeledGraphFact[]
  readonly attribution: Readonly<GraphFeatureAttribution>
}

export interface SidecarFeatureFact {
  readonly available: boolean
  readonly present: boolean
  readonly fingerprint?: string
}

export interface GraphFeatureAttribution {
  readonly berryConditions: Readonly<SidecarFeatureFact>
  readonly pnpmCatalogs: Readonly<SidecarFeatureFact>
  readonly catalogRanges: 'none' | 'yarn-berry' | 'pnpm' | 'unknown'
}

const NODE_KEYS = new Set([
  'id',
  'name',
  'version',
  'peerContext',
  'patch',
  'source',
  'workspacePath',
])

const EDGE_KEYS = new Set(['src', 'dst', 'kind', 'attrs'])

const EDGE_ATTR_KEYS = new Set([
  'range',
  'overrideRange',
  'optional',
  'workspace',
  'alias',
  'workspaceRange',
])

const WORKSPACE_RANGE_KEYS = new Set(['specifier', 'resolvedVersion'])

const TARBALL_PAYLOAD_KEYS = new Set([
  'integrity',
  'berryChecksumCacheKey',
  'engines',
  'funding',
  'license',
  'bin',
  'deprecated',
  'cpu',
  'os',
  'libc',
  'hasInstallScript',
  'bundledDependencies',
  'peerDependencies',
  'peerDependenciesMeta',
  'resolution',
  'nativeResolution',
])

const INTEGRITY_KEYS = new Set(['hashes'])
const HASH_KEYS = new Set(['algorithm', 'digest', 'origin'])
const PEER_META_KEYS = new Set(['optional'])
const SIDECAR_FEATURE_QUERY_KEYS = new Set(['available', 'present', 'fingerprint'])

const HASH_ORIGINS = new Set([
  'sri',
  'berry-zip',
  'url-fragment',
  'registry',
  'recomputed',
])

const HOSTING_PROVIDERS = new Set(['github', 'gitlab', 'bitbucket'])
const FEATURE_FINGERPRINT = /^[0-9a-f]{64}$/

type DetectionState = {
  readonly features: Set<GraphFeature>
  readonly unmodeled: UnmodeledGraphFact[]
  catalogRangePresent: boolean
}

function readonlySet<T>(source: ReadonlySet<T>): ReadonlySet<T> {
  let view: ReadonlySet<T>
  view = Object.freeze({
    get size() { return source.size },
    has: (value: T) => source.has(value),
    entries: () => source.entries(),
    keys: () => source.keys(),
    values: () => source.values(),
    forEach: (callback: (value: T, key: T, set: ReadonlySet<T>) => void, thisArg?: unknown) => {
      source.forEach(value => callback.call(thisArg, value, value, view))
    },
    [Symbol.iterator]: () => source[Symbol.iterator](),
  })
  return view
}

export function detectGraphFeatures(graph: Graph, pnpmCatalogQuery?: unknown): GraphFeatureDetection {
  const state: DetectionState = {
    features: new Set<GraphFeature>(),
    unmodeled: [],
    catalogRangePresent: false,
  }

  for (const candidate of graph.nodes() as IterableIterator<unknown>) {
    inspectNode(candidate, state)
    if (!isRecord(candidate) || typeof candidate.id !== 'string') continue
    inspectConditions(graph, candidate.id, state)
    for (const edge of graph.out(candidate.id)) inspectEdge(edge, state)
  }

  for (const [key, payload] of graph.tarballs()) inspectTarballPayload(key, payload, state)
  const berryConditions = inspectSidecarFeatureQuery(
    yarnBerryConditionsFeatureOf(graph),
    'sidecar.conditions',
    'sidecar:yarn-berry-conditions',
    state,
  )
  const pnpmCatalogs = inspectSidecarFeatureQuery(
    pnpmCatalogQuery === undefined ? pnpmCatalogFeatureOf(graph) : pnpmCatalogQuery,
    'sidecar.catalog',
    'sidecar:pnpm-catalog',
    state,
  )
  if (berryConditions.present) state.features.add('conditions')
  if (pnpmCatalogs.present) state.features.add('catalog')
  const catalogRanges = catalogRangeAttribution(berryConditions, pnpmCatalogs, state)

  return Object.freeze({
    features: readonlySet(state.features),
    unmodeled: Object.freeze(state.unmodeled.slice()),
    attribution: Object.freeze({ berryConditions, pnpmCatalogs, catalogRanges }),
  })
}

function inspectNode(node: unknown, state: DetectionState): void {
  if (!isRecord(node)) {
    const subject = '<node>'
    addUnmodeled(state, subject, 'node', 'invalid-shape')
    return
  }
  const subject = stringSubject(node.id, '<node>')
  inspectKeys(node, NODE_KEYS, subject, 'node', state)
  inspectString(node.id, subject, 'node.id', state)
  inspectString(node.name, subject, 'node.name', state)
  inspectString(node.version, subject, 'node.version', state)
  inspectStringArray(node.peerContext, subject, 'node.peerContext', state)
  inspectOptionalString(node.patch, subject, 'node.patch', state)
  inspectOptionalString(node.source, subject, 'node.source', state)
  inspectOptionalString(node.workspacePath, subject, 'node.workspacePath', state)

  if (Array.isArray(node.peerContext) && node.peerContext.length > 0) state.features.add('peer-context')
  if (node.patch !== undefined) state.features.add('patch')
  if (node.source !== undefined) state.features.add('source-discriminator')
  if (node.workspacePath !== undefined) state.features.add('workspace')
}

function inspectEdge(edge: Edge, state: DetectionState): void {
  const subject = edgeSubject(edge)
  if (!isRecord(edge)) {
    addUnmodeled(state, subject, 'edge', 'invalid-shape')
    return
  }
  inspectKeys(edge, EDGE_KEYS, subject, 'edge', state)
  inspectString(edge.src, subject, 'edge.src', state)
  inspectString(edge.dst, subject, 'edge.dst', state)

  switch (edge.kind) {
    case 'dep':
      state.features.add('edge:dep')
      break
    case 'dev':
      state.features.add('edge:dev')
      break
    case 'optional':
      state.features.add('edge:optional')
      break
    case 'peer':
      state.features.add('edge:peer')
      break
    case 'bundled':
      state.features.add('edge:bundled')
      break
    default:
      addUnmodeled(state, subject, 'edge.kind', 'invalid-value')
  }

  if (edge.attrs !== undefined) inspectEdgeAttrs(edge.attrs, subject, state)
}

function inspectEdgeAttrs(attrs: EdgeAttrs, subject: string, state: DetectionState): void {
  if (!isRecord(attrs)) {
    addUnmodeled(state, subject, 'edge.attrs', 'invalid-shape')
    return
  }
  inspectKeys(attrs, EDGE_ATTR_KEYS, subject, 'edge.attrs', state)
  inspectOptionalString(attrs.range, subject, 'edge.attrs.range', state)
  inspectOptionalString(attrs.overrideRange, subject, 'edge.attrs.overrideRange', state)
  inspectOptionalBoolean(attrs.optional, subject, 'edge.attrs.optional', state)
  inspectOptionalBoolean(attrs.workspace, subject, 'edge.attrs.workspace', state)
  inspectOptionalString(attrs.alias, subject, 'edge.attrs.alias', state)

  if (attrs.workspaceRange !== undefined) {
    inspectWorkspaceRange(attrs.workspaceRange, subject, state)
  }
  if (attrs.workspace === true || attrs.workspaceRange !== undefined) state.features.add('workspace')
  if (attrs.alias !== undefined) state.features.add('edge-alias')
  if (typeof attrs.range === 'string' && attrs.range.startsWith('catalog:')) {
    state.features.add('catalog')
    state.catalogRangePresent = true
  }
}

function inspectWorkspaceRange(value: unknown, subject: string, state: DetectionState): void {
  if (!isRecord(value)) {
    addUnmodeled(state, subject, 'edge.attrs.workspaceRange', 'invalid-shape')
    return
  }
  inspectKeys(value, WORKSPACE_RANGE_KEYS, subject, 'edge.attrs.workspaceRange', state)
  inspectString(value.specifier, subject, 'edge.attrs.workspaceRange.specifier', state)
  inspectOptionalString(value.resolvedVersion, subject, 'edge.attrs.workspaceRange.resolvedVersion', state)
}

function inspectTarballPayload(key: string, payload: TarballPayload, state: DetectionState): void {
  const subject = `tarball:${key}`
  if (!isRecord(payload)) {
    addUnmodeled(state, subject, 'tarball', 'invalid-shape')
    return
  }
  inspectKeys(payload, TARBALL_PAYLOAD_KEYS, subject, 'tarball', state)

  inspectOptionalString(payload.berryChecksumCacheKey, subject, 'tarball.berryChecksumCacheKey', state)
  inspectOptionalString(payload.license, subject, 'tarball.license', state)
  inspectOptionalString(payload.deprecated, subject, 'tarball.deprecated', state)
  inspectOptionalBoolean(payload.hasInstallScript, subject, 'tarball.hasInstallScript', state)
  inspectOptionalString(payload.nativeResolution, subject, 'tarball.nativeResolution', state)

  inspectOptionalStringRecord(payload.engines, subject, 'tarball.engines', state)
  inspectBin(payload.bin, subject, state)
  inspectOptionalStringArray(payload.cpu, subject, 'tarball.cpu', state)
  inspectOptionalStringArray(payload.os, subject, 'tarball.os', state)
  inspectOptionalStringArray(payload.libc, subject, 'tarball.libc', state)
  inspectOptionalStringArray(payload.bundledDependencies, subject, 'tarball.bundledDependencies', state)
  inspectOptionalStringRecord(payload.peerDependencies, subject, 'tarball.peerDependencies', state)
  inspectPeerDependenciesMeta(payload.peerDependenciesMeta, subject, state)

  if (payload.integrity !== undefined) inspectIntegrity(payload.integrity, subject, state)
  if (payload.resolution !== undefined) inspectResolution(payload.resolution, subject, state)

  if (payload.engines !== undefined) state.features.add('metadata:engines')
  if (payload.funding !== undefined) state.features.add('metadata:funding')
  if (payload.license !== undefined) state.features.add('metadata:license')
  if (payload.bin !== undefined) state.features.add('metadata:bin')
  if (payload.deprecated !== undefined) state.features.add('metadata:deprecated')
  if (payload.cpu !== undefined || payload.os !== undefined || payload.libc !== undefined) {
    state.features.add('metadata:platform')
  }
  if (payload.hasInstallScript !== undefined) state.features.add('metadata:install-script')
  if (payload.bundledDependencies !== undefined) state.features.add('metadata:bundled-dependencies')
  if (payload.peerDependencies !== undefined || payload.peerDependenciesMeta !== undefined) {
    state.features.add('metadata:peer-declarations')
  }
}

function inspectIntegrity(value: unknown, subject: string, state: DetectionState): void {
  if (!isRecord(value)) {
    addUnmodeled(state, subject, 'tarball.integrity', 'invalid-shape')
    return
  }
  inspectKeys(value, INTEGRITY_KEYS, subject, 'tarball.integrity', state)
  if (!Array.isArray(value.hashes)) {
    addUnmodeled(state, subject, 'tarball.integrity.hashes', 'invalid-shape')
    return
  }

  for (let index = 0; index < value.hashes.length; index += 1) {
    inspectHash(value.hashes[index], subject, `tarball.integrity.hashes[${index}]`, state)
  }
}

function inspectHash(value: unknown, subject: string, path: string, state: DetectionState): void {
  if (!isRecord(value)) {
    addUnmodeled(state, subject, path, 'invalid-shape')
    return
  }
  inspectKeys(value, HASH_KEYS, subject, path, state)
  inspectString(value.algorithm, subject, `${path}.algorithm`, state)
  inspectString(value.digest, subject, `${path}.digest`, state)

  if (typeof value.origin !== 'string' || !HASH_ORIGINS.has(value.origin)) {
    addUnmodeled(state, subject, `${path}.origin`, 'invalid-value')
    return
  }
  if (value.origin === 'berry-zip') {
    state.features.add('integrity:berry-zip')
  } else {
    state.features.add('integrity:tarball')
  }
}

function inspectResolution(value: unknown, subject: string, state: DetectionState): void {
  if (!isRecord(value)) {
    addUnmodeled(state, subject, 'tarball.resolution', 'invalid-shape')
    return
  }
  if (typeof value.type !== 'string') {
    addUnmodeled(state, subject, 'tarball.resolution.type', 'invalid-value')
    return
  }

  switch (value.type) {
    case 'tarball':
      inspectKeys(value, new Set(['type', 'url', 'hostingProvider', 'bind']), subject, 'tarball.resolution', state)
      inspectString(value.url, subject, 'tarball.resolution.url', state)
      inspectHostingProvider(value.hostingProvider, subject, state)
      inspectOptionalString(value.bind, subject, 'tarball.resolution.bind', state)
      state.features.add('resolution:tarball')
      break
    case 'git':
      inspectKeys(value, new Set(['type', 'url', 'sha', 'hostingProvider']), subject, 'tarball.resolution', state)
      inspectString(value.url, subject, 'tarball.resolution.url', state)
      inspectString(value.sha, subject, 'tarball.resolution.sha', state)
      inspectHostingProvider(value.hostingProvider, subject, state)
      state.features.add('resolution:git')
      break
    case 'directory':
      inspectKeys(value, new Set(['type', 'path']), subject, 'tarball.resolution', state)
      inspectString(value.path, subject, 'tarball.resolution.path', state)
      state.features.add('resolution:directory')
      break
    case 'unknown':
      inspectKeys(value, new Set(['type', 'raw']), subject, 'tarball.resolution', state)
      inspectString(value.raw, subject, 'tarball.resolution.raw', state)
      state.features.add('resolution:unknown')
      break
    default:
      addUnmodeled(state, subject, 'tarball.resolution.type', 'invalid-value')
  }
}

function inspectConditions(graph: Graph, nodeId: string, state: DetectionState): void {
  const value: unknown = rawConditionsScalarOfNode(graph, nodeId)
  if (value === undefined) return
  if (typeof value !== 'string') {
    addUnmodeled(state, nodeId, 'sidecar.conditions', 'invalid-value')
    return
  }
  state.features.add('conditions')
}

function inspectSidecarFeatureQuery(
  query: unknown,
  path: string,
  subject: string,
  state: DetectionState,
): Readonly<SidecarFeatureFact> {
  if (!isRecord(query)) {
    addUnmodeled(state, subject, path, 'invalid-shape')
    return Object.freeze({ available: false, present: false })
  }
  inspectKeys(query, SIDECAR_FEATURE_QUERY_KEYS, subject, path, state)
  inspectBoolean(query.available, subject, `${path}.available`, state)
  inspectBoolean(query.present, subject, `${path}.present`, state)
  if (query.fingerprint !== undefined
    && (typeof query.fingerprint !== 'string' || !FEATURE_FINGERPRINT.test(query.fingerprint))) {
    addUnmodeled(state, subject, `${path}.fingerprint`, 'invalid-value')
  }

  const available = query.available === true
  const present = query.present === true
  const fingerprint = typeof query.fingerprint === 'string' && FEATURE_FINGERPRINT.test(query.fingerprint)
    ? query.fingerprint
    : undefined
  if (!available && (present || fingerprint !== undefined)) {
    addUnmodeled(state, subject, path, 'invalid-value')
  }
  if (present && fingerprint === undefined) {
    addUnmodeled(state, subject, `${path}.fingerprint`, 'invalid-shape')
  }
  if (!present && fingerprint !== undefined) {
    addUnmodeled(state, subject, `${path}.fingerprint`, 'invalid-value')
  }
  return Object.freeze({
    available,
    present,
    ...(fingerprint === undefined ? {} : { fingerprint }),
  })
}

function catalogRangeAttribution(
  berryConditions: Readonly<SidecarFeatureFact>,
  pnpmCatalogs: Readonly<SidecarFeatureFact>,
  state: DetectionState,
): GraphFeatureAttribution['catalogRanges'] {
  if (!state.catalogRangePresent) return 'none'
  if (berryConditions.available === pnpmCatalogs.available) {
    addUnmodeled(
      state,
      'sidecar:catalog-range',
      'sidecar.catalog.attribution',
      berryConditions.available ? 'invalid-value' : 'invalid-shape',
    )
    return 'unknown'
  }
  if (berryConditions.available) return 'yarn-berry'
  if (!pnpmCatalogs.present) {
    addUnmodeled(
      state,
      'sidecar:pnpm-catalog',
      'sidecar.catalog.definitions',
      'invalid-shape',
    )
  }
  return 'pnpm'
}

function inspectPeerDependenciesMeta(value: unknown, subject: string, state: DetectionState): void {
  if (value === undefined) return
  if (!isRecord(value)) {
    addUnmodeled(state, subject, 'tarball.peerDependenciesMeta', 'invalid-shape')
    return
  }
  for (const [name, meta] of Object.entries(value)) {
    const path = `tarball.peerDependenciesMeta.${name}`
    if (!isRecord(meta)) {
      addUnmodeled(state, subject, path, 'invalid-shape')
      continue
    }
    inspectKeys(meta, PEER_META_KEYS, subject, path, state)
    inspectOptionalBoolean(meta.optional, subject, `${path}.optional`, state)
  }
}

function inspectBin(value: unknown, subject: string, state: DetectionState): void {
  if (value === undefined || typeof value === 'string') return
  if (!isRecord(value)) {
    addUnmodeled(state, subject, 'tarball.bin', 'invalid-shape')
    return
  }
  inspectStringRecord(value, subject, 'tarball.bin', state)
}

function inspectHostingProvider(value: unknown, subject: string, state: DetectionState): void {
  if (value === undefined) return
  if (typeof value !== 'string' || !HOSTING_PROVIDERS.has(value)) {
    addUnmodeled(state, subject, 'tarball.resolution.hostingProvider', 'invalid-value')
  }
}

function inspectOptionalStringRecord(
  value: unknown,
  subject: string,
  path: string,
  state: DetectionState,
): void {
  if (value === undefined) return
  if (!isRecord(value)) {
    addUnmodeled(state, subject, path, 'invalid-shape')
    return
  }
  inspectStringRecord(value, subject, path, state)
}

function inspectStringRecord(
  value: Record<string, unknown>,
  subject: string,
  path: string,
  state: DetectionState,
): void {
  for (const [key, item] of Object.entries(value)) inspectString(item, subject, `${path}.${key}`, state)
}

function inspectOptionalStringArray(
  value: unknown,
  subject: string,
  path: string,
  state: DetectionState,
): void {
  if (value !== undefined) inspectStringArray(value, subject, path, state)
}

function inspectStringArray(value: unknown, subject: string, path: string, state: DetectionState): void {
  if (!Array.isArray(value)) {
    addUnmodeled(state, subject, path, 'invalid-shape')
    return
  }
  for (let index = 0; index < value.length; index += 1) {
    inspectString(value[index], subject, `${path}[${index}]`, state)
  }
}

function inspectOptionalString(value: unknown, subject: string, path: string, state: DetectionState): void {
  if (value !== undefined) inspectString(value, subject, path, state)
}

function inspectString(value: unknown, subject: string, path: string, state: DetectionState): void {
  if (typeof value !== 'string') addUnmodeled(state, subject, path, 'invalid-value')
}

function inspectOptionalBoolean(value: unknown, subject: string, path: string, state: DetectionState): void {
  if (value !== undefined) inspectBoolean(value, subject, path, state)
}

function inspectBoolean(value: unknown, subject: string, path: string, state: DetectionState): void {
  if (typeof value !== 'boolean') addUnmodeled(state, subject, path, 'invalid-value')
}

function inspectKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  subject: string,
  path: string,
  state: DetectionState,
): void {
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      addUnmodeled(state, subject, `${path}.${String(key)}`, 'unknown-key')
    }
  }
}

function addUnmodeled(
  state: DetectionState,
  subject: string,
  path: string,
  reason: UnmodeledGraphFactReason,
): void {
  state.unmodeled.push(Object.freeze({ subject, path, reason }))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function stringSubject(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

function edgeSubject(edge: Edge): string {
  if (!isRecord(edge)) return '<edge>'
  const src = stringSubject(edge.src, '?')
  const dst = stringSubject(edge.dst, '?')
  const kind = stringSubject(edge.kind, '?')
  return `${src} -> ${dst} (${kind})`
}
