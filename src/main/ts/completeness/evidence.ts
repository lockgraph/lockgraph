import {
  GraphError,
  newBuilder,
  toTarballKey,
  type Diagnostic,
  type EdgeTriple,
  type Graph,
  type Manifest,
  type NodeId,
  type OverrideConstraint,
  type TarballKey,
} from '../graph.ts'
import type { FormatId } from '../api/format-contract.ts'
import type { PackumentVersion } from '../registry/types.ts'
import type {
  CompletenessDimension,
  EvidenceContext,
  EvidenceInput,
  EvidenceLedger,
  EvidenceRef,
  PackageManifestEvidence,
  PmConfigEvidence,
  RepositoryManifestEvidence,
  TargetManager,
  TargetOracleEvidence,
} from './types.ts'

export interface EvidenceConflictRecord {
  readonly dimension: CompletenessDimension
  readonly subject?: string
  readonly sources: readonly string[]
}

export interface InternalEvidenceState {
  readonly anchor?: Graph
  readonly anchorSnapshot?: Graph
  readonly source?: Readonly<{
    format: FormatId
    manager: TargetManager
    version?: string
  }>
  readonly repositoryManifests?: Readonly<{
    coverage: 'partial' | 'complete'
    manifests: Readonly<Record<string, Manifest>>
  }>
  readonly observedPolicyCarrier?: Readonly<{
    present: boolean
    overrides: readonly OverrideConstraint[]
  }>
  readonly pmConfigs: readonly PmConfigEvidence[]
  readonly packageManifests: ReadonlyMap<TarballKey, Readonly<{
    authority: PackageManifestEvidence['authority']
    manifest: PackumentVersion
  }>>
  readonly targetOracles: readonly TargetOracleEvidence[]
  readonly conflicts: readonly EvidenceConflictRecord[]
}

export type EnrichmentDerivationPhase =
  | Readonly<{
      kind: 'source-adapter'
      before: Graph
      after: Graph
    }>
  | Readonly<{
      kind: 'completion'
      before: Graph
      after: Graph
      added: readonly NodeId[]
      wired: readonly EdgeTriple[]
    }>
  | Readonly<{
      kind: 'metadata'
      before: Graph
      after: Graph
      hydrated: readonly TarballKey[]
    }>
  | Readonly<{
      kind: 'artifact'
      before: Graph
      after: Graph
      enriched: readonly NodeId[]
    }>

interface CanonicalGraphFacts {
  readonly nodes: ReadonlyMap<string, string>
  readonly roots: ReadonlySet<string>
  readonly edges: ReadonlySet<string>
  readonly tarballs: ReadonlyMap<string, string>
  readonly layout: string
}

interface FactDelta {
  readonly addedNodes: readonly string[]
  readonly removedNodes: readonly string[]
  readonly changedNodes: readonly string[]
  readonly addedRoots: readonly string[]
  readonly removedRoots: readonly string[]
  readonly addedEdges: readonly string[]
  readonly removedEdges: readonly string[]
  readonly addedTarballs: readonly string[]
  readonly removedTarballs: readonly string[]
  readonly changedTarballs: readonly string[]
  readonly layout: boolean
}

const contextState = new WeakMap<EvidenceContext, InternalEvidenceState>()
const contextByGraph = new WeakMap<Graph, EvidenceContext>()

function targetManagerOf(format: FormatId): TargetManager {
  if (format.startsWith('npm-')) return 'npm'
  if (format.startsWith('yarn-')) return 'yarn'
  if (format.startsWith('pnpm-')) return 'pnpm'
  if (format === 'bun-text') return 'bun'
  return 'lockgraph'
}

function cloneAndFreeze<T>(value: T, stack = new WeakSet<object>()): T {
  if (Array.isArray(value)) {
    if (stack.has(value)) throw new TypeError('evidence payload must not contain cycles')
    stack.add(value)
    const out = Object.freeze(value.map(item => cloneAndFreeze(item, stack))) as T
    stack.delete(value)
    return out
  }
  if (value !== null && typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('evidence payload must contain plain objects')
    }
    if (stack.has(value)) throw new TypeError('evidence payload must not contain cycles')
    stack.add(value)
    const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>
    for (const [key, item] of Object.entries(value)) out[key] = cloneAndFreeze(item, stack)
    stack.delete(value)
    return Object.freeze(out) as T
  }
  if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
    throw new TypeError('evidence payload contains a non-data value')
  }
  return value
}

function immutableMap<K, V>(input: ReadonlyMap<K, V>): ReadonlyMap<K, V> {
  const map = new Map(input)
  let view: ReadonlyMap<K, V>
  view = Object.freeze({
    get size() { return map.size },
    get: (key: K) => map.get(key),
    has: (key: K) => map.has(key),
    entries: () => map.entries(),
    keys: () => map.keys(),
    values: () => map.values(),
    forEach: (callback: (value: V, key: K, source: ReadonlyMap<K, V>) => void, thisArg?: unknown) => {
      map.forEach((value, key) => callback.call(thisArg, value, key, view))
    },
    [Symbol.iterator]: () => map[Symbol.iterator](),
  })
  return view
}

function freezeLedger(ledger: EvidenceLedger): EvidenceLedger {
  return Object.freeze({
    source: ledger.source === undefined ? undefined : cloneAndFreeze(ledger.source),
    refs: Object.freeze(ledger.refs.map(ref => cloneAndFreeze(ref))),
    diagnostics: Object.freeze(ledger.diagnostics.map(diagnostic => cloneAndFreeze(diagnostic))),
  })
}

function createContext(ledger: EvidenceLedger, state: InternalEvidenceState): EvidenceContext {
  const context = Object.freeze({ ledger: freezeLedger(ledger) }) as EvidenceContext
  contextState.set(context, state)
  return context
}

function emptyState(): InternalEvidenceState {
  return Object.freeze({
    pmConfigs: Object.freeze([]),
    packageManifests: immutableMap(new Map()),
    targetOracles: Object.freeze([]),
    conflicts: Object.freeze([]),
  })
}

const emptyContext = createContext(
  { refs: Object.freeze([]), diagnostics: Object.freeze([]) },
  emptyState(),
)

function stateOf(context: EvidenceContext): InternalEvidenceState {
  const state = contextState.get(context)
  if (state === undefined) throw new TypeError('invalid evidence context')
  return state
}

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`)
  }
}

function assertKnownKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const ownKeys = enumerableStringKeys(value, label)
  const unknown = ownKeys.filter((key): key is string => typeof key === 'string' && !keys.includes(key))
  if (unknown.length > 0) throw new TypeError(`${label} contains unknown field ${JSON.stringify(unknown[0])}`)
}

function enumerableStringKeys(value: object, label: string): string[] {
  const keys = Reflect.ownKeys(value)
  if (keys.some(key => typeof key !== 'string'
    || !Object.prototype.propertyIsEnumerable.call(value, key))) {
    throw new TypeError(`${label} must contain enumerable string keys`)
  }
  return keys as string[]
}

function assertStringRecord(value: unknown, label: string): void {
  assertRecord(value, label)
  for (const key of enumerableStringKeys(value, label)) {
    const item = value[key]
    if (typeof item !== 'string') throw new TypeError(`${label}[${JSON.stringify(key)}] must be a string`)
  }
}

function assertNativeManifest(value: unknown, label: string): void {
  assertRecord(value, label)
  assertKnownKeys(value, ['npmOverrides', 'yarnResolutions', 'pnpmOverrides'], label)
  const carriers = ['npmOverrides', 'yarnResolutions', 'pnpmOverrides']
    .filter(key => value[key] !== undefined)
  if (carriers.length > 1) throw new TypeError(`${label} must contain at most one native override block`)
  if (value.npmOverrides !== undefined) {
    assertRecord(value.npmOverrides, `${label}.npmOverrides`)
    assertNpmOverrideRecord(value.npmOverrides, `${label}.npmOverrides`, new WeakSet())
  }
  if (value.yarnResolutions !== undefined) assertStringRecord(value.yarnResolutions, `${label}.yarnResolutions`)
  if (value.pnpmOverrides !== undefined) assertStringRecord(value.pnpmOverrides, `${label}.pnpmOverrides`)
}

function assertNpmOverrideRecord(
  value: Record<string, unknown>,
  label: string,
  stack: WeakSet<object>,
): void {
  if (stack.has(value)) throw new TypeError(`${label} must not contain cycles`)
  stack.add(value)
  for (const key of enumerableStringKeys(value, label)) {
    const item = value[key]
    if (key.length === 0) throw new TypeError(`${label} contains an empty key`)
    if (typeof item === 'string') continue
    assertRecord(item, `${label}[${JSON.stringify(key)}]`)
    assertNpmOverrideRecord(item, `${label}[${JSON.stringify(key)}]`, stack)
  }
  stack.delete(value)
}

function assertManifest(value: unknown, label: string): asserts value is Manifest {
  assertRecord(value, label)
  assertKnownKeys(value, [
    'name',
    'version',
    'dependencies',
    'devDependencies',
    'optionalDependencies',
    'peerDependencies',
    'workspaces',
    'overrides',
    'native',
  ], label)
  if (value.name !== undefined && typeof value.name !== 'string') throw new TypeError(`${label}.name must be a string`)
  if (value.version !== undefined && typeof value.version !== 'string') throw new TypeError(`${label}.version must be a string`)
  for (const key of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const) {
    if (value[key] !== undefined) assertStringRecord(value[key], `${label}.${key}`)
  }
  if (value.workspaces !== undefined && (!Array.isArray(value.workspaces)
    || value.workspaces.some(item => typeof item !== 'string'))) {
    throw new TypeError(`${label}.workspaces must be a string array`)
  }
  if (value.overrides !== undefined) {
    if (!Array.isArray(value.overrides)) throw new TypeError(`${label}.overrides must be an array`)
    value.overrides.forEach((override, index) => assertOverride(override, `${label}.overrides[${index}]`))
  }
  if (value.native !== undefined) {
    assertNativeManifest(value.native, `${label}.native`)
    if (value.overrides !== undefined) {
      throw new TypeError(`${label} must not contain both canonical and native overrides`)
    }
  }
}

function normalizeRepositoryEvidence(input: RepositoryManifestEvidence): RepositoryManifestEvidence {
  if (input.manifests[''] !== undefined && input.manifests['.'] !== undefined) {
    throw new TypeError('repository manifests contain duplicate root subjects')
  }
  if (input.manifests['.'] === undefined) return input
  const manifests: Record<string, Manifest> = { ...input.manifests, '': input.manifests['.'] }
  delete manifests['.']
  return { ...input, manifests }
}

function assertManifestRecord(value: unknown, label: string): asserts value is Record<string, Manifest> {
  assertRecord(value, label)
  for (const key of enumerableStringKeys(value, label)) {
    const manifest = value[key]
    assertManifest(manifest, `${label}[${JSON.stringify(key)}]`)
  }
}

function assertPeerMetaRecord(value: unknown, label: string): void {
  assertRecord(value, label)
  for (const key of enumerableStringKeys(value, label)) {
    const meta = value[key]
    assertRecord(meta, `${label}[${JSON.stringify(key)}]`)
    assertKnownKeys(meta, ['optional'], `${label}[${JSON.stringify(key)}]`)
    if (meta.optional !== undefined && typeof meta.optional !== 'boolean') {
      throw new TypeError(`${label}[${JSON.stringify(key)}].optional must be a boolean`)
    }
  }
}

function assertStringArray(value: unknown, label: string): void {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new TypeError(`${label} must be a string array`)
  }
}

function assertPackageManifest(value: unknown, label: string): asserts value is PackumentVersion {
  assertRecord(value, label)
  assertKnownKeys(value, [
    'name',
    'version',
    'integrity',
    'tarball',
    'dependencies',
    'devDependencies',
    'optionalDependencies',
    'peerDependencies',
    'peerDependenciesMeta',
    'engines',
    'funding',
    'os',
    'cpu',
    'libc',
    'deprecated',
    'bin',
    'bundledDependencies',
    'hasInstallScript',
    'license',
    'type',
    'main',
    'exports',
  ], label)
  if (typeof value.name !== 'string' || value.name.length === 0
    || typeof value.version !== 'string' || value.version.length === 0) {
    throw new TypeError(`${label} must contain string name and version fields`)
  }
  for (const key of [
    'dependencies',
    'devDependencies',
    'optionalDependencies',
    'peerDependencies',
    'engines',
  ] as const) {
    if (value[key] !== undefined) assertStringRecord(value[key], `${label}.${key}`)
  }
  if (value.peerDependenciesMeta !== undefined) {
    assertPeerMetaRecord(value.peerDependenciesMeta, `${label}.peerDependenciesMeta`)
  }
  for (const key of ['os', 'cpu', 'libc', 'bundledDependencies'] as const) {
    if (value[key] !== undefined) assertStringArray(value[key], `${label}.${key}`)
  }
  for (const key of ['tarball', 'deprecated', 'license', 'type', 'main'] as const) {
    if (value[key] !== undefined && typeof value[key] !== 'string') {
      throw new TypeError(`${label}.${key} must be a string`)
    }
  }
  if (value.bin !== undefined && typeof value.bin !== 'string') {
    assertStringRecord(value.bin, `${label}.bin`)
  }
  if (value.hasInstallScript !== undefined && typeof value.hasInstallScript !== 'boolean') {
    throw new TypeError(`${label}.hasInstallScript must be a boolean`)
  }
}

function assertPackageManifestRecord(
  value: unknown,
  label: string,
): asserts value is Record<string, PackumentVersion> {
  assertRecord(value, label)
  for (const key of enumerableStringKeys(value, label)) {
    assertPackageManifest(value[key], `${label}[${JSON.stringify(key)}]`)
  }
}

function assertOverride(value: unknown, label: string): asserts value is OverrideConstraint {
  assertRecord(value, label)
  assertKnownKeys(value, [
    'package',
    'parentPath',
    'versionCondition',
    'to',
    'selfRef',
    'origin',
    'captureIndex',
  ], label)
  if (typeof value.package !== 'string' || value.package.length === 0
    || typeof value.to !== 'string' || value.to.length === 0) {
    throw new TypeError(`${label} must contain string package and to fields`)
  }
  if (value.parentPath !== undefined && (!Array.isArray(value.parentPath)
    || value.parentPath.some(item => typeof item !== 'string'))) {
    throw new TypeError(`${label}.parentPath must be a string array`)
  }
  if (value.versionCondition !== undefined && typeof value.versionCondition !== 'string') {
    throw new TypeError(`${label}.versionCondition must be a string`)
  }
  if (value.selfRef !== undefined && typeof value.selfRef !== 'boolean') {
    throw new TypeError(`${label}.selfRef must be a boolean`)
  }
  if (value.origin !== undefined && !['npm', 'yarn', 'pnpm'].includes(value.origin as string)) {
    throw new TypeError(`${label}.origin is invalid`)
  }
  if (value.captureIndex !== undefined
    && (!Number.isInteger(value.captureIndex) || (value.captureIndex as number) < 0)) {
    throw new TypeError(`${label}.captureIndex must be a non-negative integer`)
  }
}

const formats = new Set<FormatId>([
  'yarn-berry-v4',
  'yarn-berry-v5',
  'yarn-berry-v6',
  'yarn-berry-v7',
  'yarn-berry-v8',
  'yarn-berry-v9',
  'yarn-berry-v10',
  'yarn-classic',
  'npm-1',
  'npm-2',
  'npm-3',
  'pnpm-v5',
  'pnpm-v6',
  'pnpm-v9',
  'bun-text',
  'lockgraph',
])

const exactVersion = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/
const sha256Digest = /^sha256:[0-9a-f]{64}$/

function isGraph(value: unknown): value is Graph {
  if (value === null || typeof value !== 'object') return false
  const candidate = value as Partial<Record<keyof Graph, unknown>>
  return ['getNode', 'nodes', 'roots', 'out', 'in', 'diff', 'tarballs', 'diagnostics', 'mutate']
    .every(key => typeof candidate[key as keyof Graph] === 'function')
}

function assertEvidenceInput(input: EvidenceInput): void {
  assertRecord(input, 'evidence input')
  switch (input.kind) {
    case 'repository-manifests':
      assertKnownKeys(input, ['kind', 'manifests', 'coverage'], 'repository manifest evidence')
      if (input.coverage !== 'partial' && input.coverage !== 'complete') {
        throw new TypeError('repository manifest coverage must be partial or complete')
      }
      assertManifestRecord(input.manifests, 'repository manifests')
      return
    case 'pm-config':
      assertKnownKeys(input, [
        'kind', 'manager', 'version', 'source', 'surface', 'coverage', 'overrides',
      ], 'package-manager config evidence')
      if (!['npm', 'yarn', 'pnpm', 'bun'].includes(input.manager)
        || typeof input.version !== 'string' || !exactVersion.test(input.version)
        || typeof input.source !== 'string' || input.source.length === 0
        || input.surface !== 'overrides' || input.coverage !== 'complete'
        || !Array.isArray(input.overrides)) {
        throw new TypeError('invalid package-manager config evidence')
      }
      input.overrides.forEach((override, index) => assertOverride(override, `pm-config overrides[${index}]`))
      return
    case 'package-manifests':
      assertKnownKeys(input, ['kind', 'authority', 'manifests'], 'package manifest evidence')
      if (!['full-packument', 'version-manifest', 'tarball-manifest'].includes(input.authority)) {
        throw new TypeError('invalid package manifest authority')
      }
      assertPackageManifestRecord(input.manifests, 'package manifests')
      return
    case 'target-oracle':
      assertKnownKeys(input, [
        'kind', 'graph', 'target', 'verification', 'platform', 'configDigest', 'inputDigest',
        'projectionDigest',
      ], 'target oracle evidence')
      assertRecord(input.target, 'target oracle target')
      assertKnownKeys(input.target, ['format', 'managerVersion'], 'target oracle target')
      if (!isGraph(input.graph)
        || !formats.has(input.target.format as FormatId)
        || typeof input.target.managerVersion !== 'string'
        || !exactVersion.test(input.target.managerVersion)
        || !['target-parse-accepted', 'mutable-stable', 'frozen-verified'].includes(input.verification)
        || typeof input.platform !== 'string' || input.platform.length === 0
        || typeof input.configDigest !== 'string' || input.configDigest.length === 0
        || typeof input.inputDigest !== 'string' || input.inputDigest.length === 0
        || (input.verification === 'frozen-verified'
          && (typeof input.projectionDigest !== 'string'
            || !sha256Digest.test(input.projectionDigest)))) {
        throw new TypeError('invalid target oracle evidence')
      }
      return
    default:
      throw new TypeError('invalid evidence input kind')
  }
}

export function normalizePackageManifestEvidence(
  input: PackageManifestEvidence,
): PackageManifestEvidence {
  assertEvidenceInput(input)
  return cloneAndFreeze(input)
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stableValue(item)]))
  }
  return value
}

function equalValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right))
}

function canonicalFacts(graph: Graph): CanonicalGraphFacts {
  const nodes = new Map<string, string>()
  const edges = new Set<string>()
  for (const node of graph.nodes()) {
    nodes.set(node.id, JSON.stringify(stableValue(node)))
    for (const edge of graph.out(node.id)) edges.add(JSON.stringify(stableValue(edge)))
  }
  const tarballs = new Map<string, string>()
  for (const [key, payload] of graph.tarballs()) {
    tarballs.set(key, JSON.stringify(stableValue(payload)))
  }
  return {
    nodes,
    roots: new Set(graph.roots()),
    edges,
    tarballs,
    layout: JSON.stringify(stableValue(graph.layoutHints())),
  }
}

function mapDelta(
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
): Readonly<{ added: string[]; removed: string[]; changed: string[] }> {
  const added: string[] = []
  const removed: string[] = []
  const changed: string[] = []
  for (const key of before.keys()) {
    const next = after.get(key)
    if (next === undefined) removed.push(key)
    else if (next !== before.get(key)) changed.push(key)
  }
  for (const key of after.keys()) {
    if (!before.has(key)) added.push(key)
  }
  return {
    added: added.sort(),
    removed: removed.sort(),
    changed: changed.sort(),
  }
}

function setDelta(
  before: ReadonlySet<string>,
  after: ReadonlySet<string>,
): Readonly<{ added: string[]; removed: string[] }> {
  return {
    added: [...after].filter(item => !before.has(item)).sort(),
    removed: [...before].filter(item => !after.has(item)).sort(),
  }
}

function factDelta(before: CanonicalGraphFacts, after: CanonicalGraphFacts): FactDelta {
  const nodes = mapDelta(before.nodes, after.nodes)
  const roots = setDelta(before.roots, after.roots)
  const edges = setDelta(before.edges, after.edges)
  const tarballs = mapDelta(before.tarballs, after.tarballs)
  return {
    addedNodes: nodes.added,
    removedNodes: nodes.removed,
    changedNodes: nodes.changed,
    addedRoots: roots.added,
    removedRoots: roots.removed,
    addedEdges: edges.added,
    removedEdges: edges.removed,
    addedTarballs: tarballs.added,
    removedTarballs: tarballs.removed,
    changedTarballs: tarballs.changed,
    layout: before.layout !== after.layout,
  }
}

function sameCanonicalGraph(left: Graph, right: Graph): boolean {
  const delta = factDelta(canonicalFacts(left), canonicalFacts(right))
  return delta.addedNodes.length === 0
    && delta.removedNodes.length === 0
    && delta.changedNodes.length === 0
    && delta.addedRoots.length === 0
    && delta.removedRoots.length === 0
    && delta.addedEdges.length === 0
    && delta.removedEdges.length === 0
    && delta.addedTarballs.length === 0
    && delta.removedTarballs.length === 0
    && delta.changedTarballs.length === 0
    && !delta.layout
}

function invariant(message: string): never {
  throw new GraphError('INVARIANT_VIOLATION', `enrichment derivation: ${message}`)
}

function assertOnlyTarballsChanged(delta: FactDelta, phase: string): void {
  if (delta.addedNodes.length > 0 || delta.removedNodes.length > 0 || delta.changedNodes.length > 0
    || delta.addedRoots.length > 0 || delta.removedRoots.length > 0
    || delta.addedEdges.length > 0 || delta.removedEdges.length > 0 || delta.layout) {
    invariant(`${phase} receipt does not cover a structural delta`)
  }
}

function tripleKey(value: EdgeTriple): string {
  return `${value.src}\0${value.kind}\0${value.dst}`
}

function edgeTripleOf(serialized: string): string {
  const edge = JSON.parse(serialized) as EdgeTriple
  return tripleKey(edge)
}

function assertPhaseReceipt(phase: EnrichmentDerivationPhase): void {
  const before = canonicalFacts(phase.before)
  const after = canonicalFacts(phase.after)
  const delta = factDelta(before, after)
  if (phase.kind === 'source-adapter') return
  if (phase.kind === 'completion') {
    if (delta.removedNodes.length > 0 || delta.changedNodes.length > 0
      || delta.removedRoots.length > 0 || delta.addedRoots.length > 0
      || delta.removedEdges.length > 0 || delta.removedTarballs.length > 0
      || delta.changedTarballs.length > 0 || delta.layout) {
      invariant('completion receipt contains a non-additive delta')
    }
    const expectedNodes = [...new Set(phase.added)].sort()
    if (!equalValue(delta.addedNodes, expectedNodes)) invariant('completion node receipt is incomplete')
    const expectedEdges = [...new Set(phase.wired.map(tripleKey))].sort()
    const actualEdges = [...new Set(delta.addedEdges.map(edgeTripleOf))].sort()
    if (!equalValue(actualEdges, expectedEdges)) invariant('completion edge receipt is incomplete')
    const addedNodeKeys = new Set(phase.added.map(id => {
      const node = phase.after.getNode(id)
      return node === undefined ? undefined : toTarballKey(node)
    }).filter((key): key is TarballKey => key !== undefined))
    for (const key of addedNodeKeys) {
      if (!before.tarballs.has(key) && !after.tarballs.has(key)) {
        invariant('completion added a package without a tarball payload')
      }
    }
    if (delta.addedTarballs.some(key => !addedNodeKeys.has(key))) {
      invariant('completion tarball receipt is incomplete')
    }
    return
  }
  assertOnlyTarballsChanged(delta, phase.kind)
  if (delta.removedTarballs.length > 0) {
    invariant(`${phase.kind} receipt removes a tarball payload`)
  }
  const covered = phase.kind === 'metadata'
    ? new Set(phase.hydrated)
    : new Set(phase.enriched.map(id => {
        const node = phase.after.getNode(id)
        return node === undefined ? undefined : toTarballKey(node)
      }).filter((key): key is TarballKey => key !== undefined))
  if ([...delta.addedTarballs, ...delta.changedTarballs].some(key => !covered.has(key))) {
    invariant(`${phase.kind} tarball receipt is incomplete`)
  }
}

function conflictDiagnostic(conflict: EvidenceConflictRecord): Diagnostic {
  return Object.freeze({
    code: 'COMPLETENESS_EVIDENCE_CONFLICT',
    severity: 'warning',
    message: `authoritative evidence conflicts for ${conflict.dimension}`,
    data: Object.freeze({
      dimension: conflict.dimension,
      sources: [...conflict.sources],
      ...(conflict.subject === undefined ? {} : { subject: conflict.subject }),
    }),
  })
}

function addConflict(
  conflicts: EvidenceConflictRecord[],
  diagnostics: Diagnostic[],
  conflict: EvidenceConflictRecord,
): void {
  const normalized = { ...conflict, sources: [...conflict.sources].sort() }
  if (conflicts.some(existing => equalValue(existing, normalized))) return
  const frozen = cloneAndFreeze(normalized)
  conflicts.push(frozen)
  diagnostics.push(conflictDiagnostic(frozen))
}

function repositoryProjection(manifest: Manifest | undefined, dimension: CompletenessDimension): unknown {
  if (manifest === undefined) return undefined
  switch (dimension) {
    case 'projectTopology':
      return {
        name: manifest.name,
        version: manifest.version,
        workspaces: manifest.workspaces,
        dependencies: manifest.dependencies,
        devDependencies: manifest.devDependencies,
        optionalDependencies: manifest.optionalDependencies,
        peerDependencies: manifest.peerDependencies,
      }
    case 'edgeKinds':
      return {
        dependencies: Object.keys(manifest.dependencies ?? {}).sort(),
        devDependencies: Object.keys(manifest.devDependencies ?? {}).sort(),
        optionalDependencies: Object.keys(manifest.optionalDependencies ?? {}).sort(),
        peerDependencies: Object.keys(manifest.peerDependencies ?? {}).sort(),
      }
    case 'resolutionPolicy':
      return {
        overrides: manifest.overrides,
        native: manifest.native,
      }
    default:
      return undefined
  }
}

const repositoryDimensions: readonly CompletenessDimension[] = [
  'projectTopology',
  'edgeKinds',
  'resolutionPolicy',
]

function compareRepositorySubjects(
  current: Readonly<Record<string, Manifest>>,
  incoming: Readonly<Record<string, Manifest>>,
  currentComplete: boolean,
  incomingComplete: boolean,
  conflicts: EvidenceConflictRecord[],
  diagnostics: Diagnostic[],
): void {
  const subjects = new Set([...Object.keys(current), ...Object.keys(incoming)])
  for (const subject of subjects) {
    const left = current[subject]
    const right = incoming[subject]
    if (left === undefined || right === undefined) {
      if ((left === undefined && !currentComplete) || (right === undefined && !incomingComplete)) continue
      addConflict(conflicts, diagnostics, {
        dimension: 'projectTopology',
        subject,
        sources: ['repository-manifests', 'repository-manifests'],
      })
      addConflict(conflicts, diagnostics, {
        dimension: 'edgeKinds',
        subject,
        sources: ['repository-manifests', 'repository-manifests'],
      })
      if (subject === '' || subject === '.') {
        addConflict(conflicts, diagnostics, {
          dimension: 'resolutionPolicy',
          subject,
          sources: ['repository-manifests', 'repository-manifests'],
        })
      }
      continue
    }
    for (const dimension of repositoryDimensions) {
      if (!equalValue(
        repositoryProjection(left, dimension),
        repositoryProjection(right, dimension),
      )) {
        addConflict(conflicts, diagnostics, {
          dimension,
          subject,
          sources: ['repository-manifests', 'repository-manifests'],
        })
      }
    }
  }
}

function refsFor(input: EvidenceInput): EvidenceRef[] {
  switch (input.kind) {
    case 'repository-manifests':
      return Object.keys(input.manifests).sort().map(subject => ({
        kind: 'repository-manifest',
        subject,
        coverage: input.coverage,
      }))
    case 'pm-config':
      return [{
        kind: 'pm-config',
        subject: input.surface,
        source: input.source,
        coverage: input.coverage,
        manager: { name: input.manager, version: input.version },
      }]
    case 'package-manifests':
      return Object.keys(input.manifests).sort().map(subject => ({
        kind: input.authority,
        subject,
      }))
    case 'target-oracle':
      return [{
        kind: 'target-oracle',
        subject: input.target.format,
        digest: input.inputDigest,
        target: input.target,
        platform: input.platform,
        configDigest: input.configDigest,
        inputDigest: input.inputDigest,
        ...(input.projectionDigest === undefined ? {} : {
          projectionDigest: input.projectionDigest,
        }),
        verification: input.verification,
        manager: {
          name: targetManagerOf(input.target.format),
          version: input.target.managerVersion,
        },
      }]
  }
}

function appendUniqueRefs(refs: EvidenceRef[], incoming: readonly EvidenceRef[]): void {
  for (const ref of incoming) {
    if (!refs.some(existing => equalValue(existing, ref))) refs.push(ref)
  }
}

function mergeRepositoryManifests(
  current: InternalEvidenceState['repositoryManifests'],
  input: RepositoryManifestEvidence,
  conflicts: EvidenceConflictRecord[],
  diagnostics: Diagnostic[],
): InternalEvidenceState['repositoryManifests'] {
  const next = cloneAndFreeze(input.manifests)
  if (current === undefined) return Object.freeze({ coverage: input.coverage, manifests: next })

  compareRepositorySubjects(
    current.manifests,
    next,
    current.coverage === 'complete',
    input.coverage === 'complete',
    conflicts,
    diagnostics,
  )
  if (current.coverage === 'complete') return current
  if (input.coverage === 'complete') return Object.freeze({ coverage: 'complete', manifests: next })

  return Object.freeze({
    coverage: 'partial',
    manifests: cloneAndFreeze({ ...current.manifests, ...next }),
  })
}

function mergePmConfig(
  current: readonly PmConfigEvidence[],
  input: PmConfigEvidence,
  conflicts: EvidenceConflictRecord[],
  diagnostics: Diagnostic[],
): readonly PmConfigEvidence[] {
  const frozen = cloneAndFreeze(input)
  const index = current.findIndex(candidate => candidate.manager === input.manager
    && candidate.version === input.version && candidate.surface === input.surface)
  if (index < 0) return Object.freeze([...current, frozen])
  const existing = current[index]!
  if (!equalValue(existing.overrides, frozen.overrides)) {
    addConflict(conflicts, diagnostics, {
      dimension: 'resolutionPolicy',
      subject: `${input.manager}@${input.version}:${input.surface}`,
      sources: [existing.source, input.source],
    })
  }
  return current
}

const manifestAuthorityRank: Record<PackageManifestEvidence['authority'], number> = {
  'full-packument': 1,
  'version-manifest': 2,
  'tarball-manifest': 3,
}

export function packageResolutionFactsEqual(
  left: PackumentVersion,
  right: PackumentVersion,
): boolean {
  const project = (manifest: PackumentVersion): unknown => ({
    name: manifest.name,
    version: manifest.version,
    dependencies: manifest.dependencies,
    optionalDependencies: manifest.optionalDependencies,
    peerDependencies: manifest.peerDependencies,
    peerDependenciesMeta: manifest.peerDependenciesMeta,
  })
  return equalValue(project(left), project(right))
}

function mergePackageManifests(
  current: InternalEvidenceState['packageManifests'],
  input: PackageManifestEvidence,
  conflicts: EvidenceConflictRecord[],
  diagnostics: Diagnostic[],
): InternalEvidenceState['packageManifests'] {
  const next = new Map(current)
  for (const [key, manifest] of Object.entries(input.manifests)) {
    const existing = next.get(key)
    const frozen = cloneAndFreeze(manifest)
    if (existing !== undefined && !equalValue(existing.manifest, frozen)) {
      const sources = [existing.authority, input.authority]
      if (!packageResolutionFactsEqual(existing.manifest, frozen)) {
        addConflict(conflicts, diagnostics, { dimension: 'edgeKinds', subject: key, sources })
        addConflict(conflicts, diagnostics, { dimension: 'peerModel', subject: key, sources })
      }
      if (existing.manifest.name !== frozen.name || existing.manifest.version !== frozen.version) {
        addConflict(conflicts, diagnostics, { dimension: 'resolvedGraph', subject: key, sources })
        addConflict(conflicts, diagnostics, { dimension: 'artifacts', subject: key, sources })
      }
      addConflict(conflicts, diagnostics, { dimension: 'packageMetadata', subject: key, sources })
    }
    if (existing === undefined || manifestAuthorityRank[input.authority] > manifestAuthorityRank[existing.authority]) {
      next.set(key, Object.freeze({ authority: input.authority, manifest: frozen }))
    }
  }
  return immutableMap(next)
}

function mergeTargetOracle(
  current: readonly TargetOracleEvidence[],
  input: TargetOracleEvidence,
): readonly TargetOracleEvidence[] {
  if (current.some(existing => existing.graph === input.graph
    && equalValue(existing.target, input.target)
    && existing.verification === input.verification
    && existing.platform === input.platform
    && existing.configDigest === input.configDigest
    && existing.inputDigest === input.inputDigest
    && existing.projectionDigest === input.projectionDigest)) return current
  return Object.freeze([...current, Object.freeze({ ...input, target: cloneAndFreeze(input.target) })])
}

export function evidenceOf(graph: Graph): EvidenceContext {
  return contextByGraph.get(graph) ?? emptyContext
}

export function withEvidence(base: EvidenceContext, input: EvidenceInput | readonly EvidenceInput[]): EvidenceContext {
  const baseState = stateOf(base)
  const inputs = Array.isArray(input) ? input : [input]
  let repositoryManifests = baseState.repositoryManifests
  let pmConfigs = baseState.pmConfigs
  let packageManifests = baseState.packageManifests
  let targetOracles = baseState.targetOracles
  const conflicts = [...baseState.conflicts]
  const refs = [...base.ledger.refs]
  const diagnostics = [...base.ledger.diagnostics]

  for (const candidate of inputs) {
    assertEvidenceInput(candidate)
    const item = candidate.kind === 'repository-manifests'
      ? normalizeRepositoryEvidence(candidate)
      : candidate
    appendUniqueRefs(refs, refsFor(item))
    switch (item.kind) {
      case 'repository-manifests':
        repositoryManifests = mergeRepositoryManifests(
          repositoryManifests, item, conflicts, diagnostics,
        )
        break
      case 'pm-config':
        pmConfigs = mergePmConfig(pmConfigs, item, conflicts, diagnostics)
        break
      case 'package-manifests':
        packageManifests = mergePackageManifests(
          packageManifests, item, conflicts, diagnostics,
        )
        break
      case 'target-oracle':
        targetOracles = mergeTargetOracle(targetOracles, item)
        break
    }
  }

  return createContext({
    source: base.ledger.source,
    refs,
    diagnostics,
  }, Object.freeze({
    anchor: baseState.anchor,
    anchorSnapshot: baseState.anchorSnapshot,
    source: baseState.source,
    observedPolicyCarrier: baseState.observedPolicyCarrier,
    repositoryManifests,
    pmConfigs,
    packageManifests,
    targetOracles,
    conflicts: Object.freeze(conflicts),
  }))
}

export function internalEvidenceOf(context: EvidenceContext): InternalEvidenceState {
  return stateOf(context)
}

export function withSourceVersion(context: EvidenceContext, version: string): EvidenceContext {
  const state = stateOf(context)
  if (!exactVersion.test(version)) throw new TypeError('source manager version must be exact')
  if (state.source === undefined) throw new TypeError('source manager version requires lock evidence')
  const major = Number(version.slice(0, version.indexOf('.')))
  const compatible = state.source.format === 'pnpm-v5'
    ? major >= 3 && major <= 7
    : state.source.format === 'pnpm-v6'
      ? major === 8
      : state.source.format === 'pnpm-v9'
        ? major >= 9
        : true
  if (!compatible) throw new TypeError(`source manager version is incompatible with ${state.source.format}`)
  const source = Object.freeze({ ...state.source, version })
  return createContext({
    ...context.ledger,
    source,
  }, Object.freeze({ ...state, source }))
}

export function attachEvidence(graph: Graph, context: EvidenceContext): void {
  stateOf(context)
  contextByGraph.set(graph, context)
}

function snapshotGraph(graph: Graph): Graph {
  const builder = newBuilder()
  const tarballs = new Set<TarballKey>()
  for (const node of graph.nodes()) {
    builder.addNode(cloneAndFreeze(node))
    const inputs = {
      name: node.name,
      version: node.version,
      ...(node.patch === undefined ? {} : { patch: node.patch }),
      ...(node.source === undefined ? {} : { source: node.source }),
    }
    const key = toTarballKey(inputs)
    const payload = graph.tarball(inputs)
    if (payload !== undefined && !tarballs.has(key)) {
      builder.setTarball(inputs, cloneAndFreeze(payload))
      tarballs.add(key)
    }
    for (const edge of graph.out(node.id)) {
      builder.addEdge(edge.src, edge.dst, edge.kind,
        edge.attrs === undefined ? undefined : cloneAndFreeze(edge.attrs))
    }
  }
  const layout = graph.layoutHints()
  if (layout !== undefined) builder.layoutHints(cloneAndFreeze(layout))
  return builder.seal()
}

export function deriveEnrichedEvidence(
  inputGraph: Graph,
  finalGraph: Graph,
  context: EvidenceContext,
  phases: readonly EnrichmentDerivationPhase[],
  refs: readonly EvidenceRef[] = [],
  diagnostics: readonly Diagnostic[] = [],
): EvidenceContext {
  const state = stateOf(context)
  const anchor = state.anchorSnapshot ?? state.anchor
  if (anchor !== undefined && !sameCanonicalGraph(anchor, inputGraph)) {
    invariant('input graph does not match the evidence anchor')
  }

  let cursor = inputGraph
  for (const phase of phases) {
    if (!sameCanonicalGraph(cursor, phase.before)) invariant('phase chain is discontinuous')
    assertPhaseReceipt(phase)
    cursor = phase.after
  }
  if (!sameCanonicalGraph(cursor, finalGraph)) invariant('final graph contains an uncovered delta')

  const nextRefs = [...context.ledger.refs]
  appendUniqueRefs(nextRefs, refs.map(ref => cloneAndFreeze(ref)))
  const nextDiagnostics = [...context.ledger.diagnostics]
  for (const diagnostic of diagnostics) {
    if (!nextDiagnostics.some(existing => equalValue(existing, diagnostic))) {
      nextDiagnostics.push(cloneAndFreeze(diagnostic))
    }
  }
  const derived = createContext({
    source: context.ledger.source,
    refs: nextRefs,
    diagnostics: nextDiagnostics,
  }, Object.freeze({
    ...state,
    anchor: finalGraph,
    anchorSnapshot: snapshotGraph(finalGraph),
  }))
  attachEvidence(finalGraph, derived)
  return derived
}

export function attachParsedEvidence(
  graph: Graph,
  format: FormatId,
  manifests?: Readonly<Record<string, Manifest>>,
  observedPolicyCarrier?: readonly OverrideConstraint[] | null,
): void {
  const source = Object.freeze({ format, manager: targetManagerOf(format) })
  let context = createContext({
    source,
    refs: [
      { kind: 'lockfile', subject: format },
      ...(observedPolicyCarrier === undefined ? [] : [{
        kind: 'lockfile' as const,
        subject: 'overrides',
        coverage: 'complete' as const,
        presence: observedPolicyCarrier === null ? 'absent' as const : 'present' as const,
      }]),
    ],
    diagnostics: [],
  }, Object.freeze({
    ...emptyState(),
    anchor: graph,
    anchorSnapshot: snapshotGraph(graph),
    source,
    observedPolicyCarrier: observedPolicyCarrier === undefined
      ? undefined
      : Object.freeze({
        present: observedPolicyCarrier !== null,
        overrides: cloneAndFreeze(observedPolicyCarrier ?? []),
      }),
  }))
  if (manifests !== undefined) {
    context = withEvidence(context, {
      kind: 'repository-manifests',
      manifests,
      coverage: 'partial',
    })
  }
  attachEvidence(graph, context)
}
