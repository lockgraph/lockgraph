// Shared Deno native `deno.lock` adapter core (v2-v5).
//
// This adapter deliberately projects only the npm resolution subgraph. JSR,
// remote modules, redirects and workspace configuration remain native sidecar
// state and are replayed only by the same-format emitter. Deno has no
// dev/prod distinction in the lockfile.

import { createHash } from 'node:crypto'
import semver from 'semver'
import {
  accessGraphGoverningOverride,
  accessGraphOverrides,
  accessGraphRegistryPackages,
  GraphError,
  newBuilder,
  serializeNodeId,
  stripPeerContextFromNodeId,
  toTarballKey,
  type Diagnostic,
  type EdgeAttrs,
  type EdgeKind,
  type Graph,
  type Manifest,
  type MutateResult,
  type Mutator,
  type Node,
  type TarballPayload,
} from '../graph.ts'
import { LockfileError } from '../api/errors.ts'
import {
  type Integrity,
  emitSri,
  isEmptyIntegrity,
  parseSri,
  pickTarballSha512,
  tarballHashes,
} from '../recipe/integrity.ts'
import { registryTarballUrl } from '../recipe/resolution.ts'

export interface DenoParseOptions {
  manifests?: Readonly<Record<string, Manifest>>
  registryFor?: (packageName: string) => string | undefined
}

export interface DenoStringifyOptions {
  lineEnding?: 'lf' | 'crlf'
  onDiagnostic?: (diagnostic: Diagnostic) => void
}

// === TYPES AND NATIVE SHAPES ================================================

export type DenoVersion = '2' | '3' | '4' | '5'
type JsonObject = Record<string, unknown>

interface DenoNpmPackageId {
  readonly name: string
  readonly version: string
  readonly peers: readonly DenoNpmPackageId[]
  readonly raw: string
  readonly rawSuffix: string
}

interface DenoNpmPackageEntry extends JsonObject {
  integrity?: string
  dependencies?: Record<string, string> | string[]
  optionalDependencies?: Record<string, string> | string[]
  optionalPeers?: Record<string, string> | string[]
  os?: string[]
  cpu?: string[]
  tarball?: string
  deprecated?: boolean
  scripts?: boolean
  bin?: boolean
}

/** Where a document actually nests its package sections. Three nestings exist across
 * the four generations — v4 and v5 share one — and a document's nesting is a fact
 * about its body, independent of the `version` string it declares. */
type DenoNesting = 'v2' | 'v3' | 'v45'

/** A populated section that the winning nesting does not reach. */
interface DenoOrphanedSection {
  readonly nesting: DenoNesting
  readonly path: string
  readonly count: number
}

interface DenoLayout {
  /** The nesting the body uses, which drives WHERE sections live and WHICH value
   * shapes they carry. Not necessarily the declared version. */
  readonly version: DenoVersion
  /** The `version` string in the file, which drives format identity and replay. */
  readonly declaredVersion: DenoVersion
  readonly orphanedSections: readonly DenoOrphanedSection[]
  readonly document: JsonObject
  readonly specifiers: Record<string, string>
  readonly npm: Record<string, DenoNpmPackageEntry>
  readonly jsr: Record<string, unknown>
  readonly remote: Record<string, unknown>
}

interface DenoSidecar {
  readonly version: DenoVersion
  readonly layoutVersion: DenoVersion
  readonly orphanedSections: readonly DenoOrphanedSection[]
  readonly originalInput: string
  readonly document: JsonObject
  readonly nativeByNode: Map<string, string>
  readonly nodeByNative: Map<string, string>
  readonly parsedByNative: Map<string, DenoNpmPackageId>
  readonly bumpedFromNative: Map<string, string>
  readonly dirtyNative: ReadonlySet<string>
  readonly exactReplay: boolean
  readonly unrepresentable: readonly string[]
  readonly jsrCount: number
  readonly remoteCount: number
}

interface DenoParseContext {
  readonly registryFor?: (packageName: string) => string | undefined
  readonly builder: ReturnType<typeof newBuilder>
  readonly layout: DenoLayout
  readonly diagnostics: Diagnostic[]
  readonly edgeKeys: Set<string>
  readonly parsedByNative: Map<string, DenoNpmPackageId>
  readonly nativeByNode: Map<string, string>
  readonly nodeByNative: Map<string, string>
  readonly nativeByName: Map<string, string[]>
  readonly unrepresentable: string[]
  readonly rootManifest?: Manifest
}

interface DenoOptionalPeerDeclaration {
  readonly alias: string
  readonly range: string
  readonly nativeId?: string
}

// === ADAPTER STATE / SIDECAR ================================================

const sidecarByGraph = new WeakMap<Graph, DenoSidecar>()

export function hasAdapterState(graph: Graph): boolean {
  return sidecarByGraph.has(graph)
}

export function sourceVersionOf(graph: Graph): DenoVersion | undefined {
  return sidecarByGraph.get(graph)?.version
}

export function adapterStateSubjects(graph: Graph): readonly string[] {
  const sidecar = sidecarByGraph.get(graph)
  if (sidecar === undefined) return []
  return unknownTopLevelKeys(sidecar.document, sidecar.version)
    .map(key => `top-level:${key}`)
}

export function nonNpmSectionCounts(
  graph: Graph,
): Readonly<{ jsr: number; remote: number }> | undefined {
  const sidecar = sidecarByGraph.get(graph)
  return sidecar === undefined
    ? undefined
    : Object.freeze({ jsr: sidecar.jsrCount, remote: sidecar.remoteCount })
}

export type DenoDeclarationRangeCarrier =
  | 'dependencies'
  | 'optionalDependencies'
  | 'peerDependencies'

export interface DenoDeclarationRangeProjection {
  readonly carrier: DenoDeclarationRangeCarrier
  readonly key: string
  readonly subject: string
  readonly destination: string
  readonly kind: 'dep' | 'optional' | 'peer'
  readonly name: string
  readonly alias?: string
  readonly from: string
  readonly to: string
}

/** Declaration ranges that the current Deno v5 emit will carry as exact
 * identities. The sidecar checks are load-bearing: an edge alone does not prove
 * that the target carrier will contain the exact version, and must therefore
 * not authorize a comparison-only normalization. Optional peer ranges are
 * deliberately absent because Deno can carry those ranges verbatim. */
export function denoDeclarationRangeProjections(
  graph: Graph,
  target: string,
): readonly DenoDeclarationRangeProjection[] {
  if (target !== 'deno-v5') return []
  const sidecar = sidecarByGraph.get(graph)
  if (sidecar === undefined) return []

  const projections: DenoDeclarationRangeProjection[] = []
  for (const node of graph.nodes()) {
    if (node.workspacePath !== undefined) continue
    const nativeId = sidecar.nativeByNode.get(node.id)
    const native = nativeId === undefined ? undefined : sidecar.parsedByNative.get(nativeId)
    const payload = graph.tarballOf(node.id)
    if (native === undefined) continue
    if (payload?.peerDependencies !== undefined) {
      for (const edge of graph.out(node.id, 'peer')) {
        if (edge.attrs?.optional === true || edge.attrs?.alias !== undefined) continue
        const peer = graph.getNode(edge.dst)
        if (peer === undefined) continue
        const carried = native.peers.some(candidate =>
          candidate.name === peer.name && candidate.version === peer.version)
        if (!carried) continue
        const declared = payload.peerDependencies[peer.name]
        if (declared === undefined || declared === peer.version) continue
        projections.push(Object.freeze({
          carrier: 'peerDependencies',
          key: toTarballKey(node),
          subject: node.id,
          destination: peer.id,
          kind: 'peer',
          name: peer.name,
          from: declared,
          to: peer.version,
        }))
      }
    }

    for (const kind of ['dep', 'optional'] as const) {
      for (const edge of graph.out(node.id, kind)) {
        const dependency = graph.getNode(edge.dst)
        const dependencyNativeId = sidecar.nativeByNode.get(edge.dst)
        const dependencyNative = dependencyNativeId === undefined
          ? undefined
          : sidecar.parsedByNative.get(dependencyNativeId)
        const declared = edge.attrs?.range
        if (
          dependency === undefined
          || dependencyNative === undefined
          || dependencyNative.name !== dependency.name
          || dependencyNative.version !== dependency.version
          || declared === undefined
        ) continue
        const exact = edge.attrs?.alias === undefined
          ? dependency.version
          : `npm:${dependency.name}@${dependency.version}`
        if (declared === exact) continue
        projections.push(Object.freeze({
          carrier: kind === 'dep' ? 'dependencies' : 'optionalDependencies',
          key: toTarballKey(node),
          subject: node.id,
          destination: dependency.id,
          kind,
          name: edge.attrs?.alias ?? dependency.name,
          ...(edge.attrs?.alias === undefined ? {} : { alias: edge.attrs.alias }),
          from: declared,
          to: exact,
        }))
      }
    }
  }
  return Object.freeze(projections.sort((left, right) =>
    compareStrings(left.subject, right.subject)
      || compareStrings(left.carrier, right.carrier)
      || compareStrings(left.name, right.name)))
}

function rememberSidecar(graph: Graph, sidecar: DenoSidecar): void {
  sidecarByGraph.set(graph, sidecar)
}

export function rebindAdapterState(
  source: Graph,
  target: Graph,
): Readonly<{ graph: Graph; invalidated: readonly string[] }> {
  const sidecar = sidecarByGraph.get(source)
  if (sidecar === undefined) return { graph: target, invalidated: [] }
  const nativeByNode = new Map<string, string>()
  const nodeByNative = new Map<string, string>()
  const invalidated: string[] = []
  for (const [nodeId, nativeId] of sidecar.nativeByNode) {
    if (target.getNode(nodeId) === undefined) {
      invalidated.push(nodeId)
      continue
    }
    nativeByNode.set(nodeId, nativeId)
    nodeByNative.set(nativeId, nodeId)
  }
  const next: DenoSidecar = {
    ...sidecar,
    nativeByNode,
    nodeByNative,
    exactReplay: false,
    unrepresentable: [...sidecar.unrepresentable],
  }
  rememberSidecar(target, next)
  return { graph: target, invalidated: invalidated.sort() }
}

// === PUBLIC API ==============================================================

export function checkVersion(input: string, expectedVersion: DenoVersion): boolean {
  if (hasConflictMarkers(input)) {
    return new RegExp(`"version"\\s*:\\s*"${expectedVersion}"`).test(input)
      && /"(?:npm|packages|remote|specifiers)"\s*:/.test(input)
  }
  let value: unknown
  try {
    value = JSON.parse(input)
  } catch {
    return false
  }
  if (!isObject(value)) return false
  const version = value.version
  if (version !== expectedVersion) return false
  // The corroborating section may be nested the way a LATER generation nests it —
  // deno reads those, so detection must not turn such a document away for carrying
  // no section where the declared version would have put one.
  const nestedLater = isObject(value.specifiers) || isObject(value.jsr)
  if (version === '2') return isObject(value.npm) || isObject(value.remote) || nestedLater || isObject(value.packages)
  if (version === '3') {
    return isObject(value.packages)
      || isObject(value.remote)
      || isObject(value.workspace)
      || isObject(value.npm)
      || nestedLater
  }
  return true
}

export function parseVersion(
  input: string,
  expectedVersion: DenoVersion,
  options: DenoParseOptions = {},
): Graph {
  if (hasConflictMarkers(input)) {
    throw failure(
      'DENO_MERGE_CONFLICT: deno.lock contains unresolved git conflict markers; resolve the merge before mutation',
    )
  }
  const layout = parseLayout(input, expectedVersion)
  validateNonNpmIntegrity(layout)
  validateSpecifierValueShape(layout)
  const context = createParseContext(layout, options.manifests?.[''], options.registryFor)
  registerNpmNodes(context)
  addNpmEdges(context)
  addRootSpecifierEdges(context)
  return sealDenoGraph(context, input)
}

export function stringifyVersion(
  graph: Graph,
  targetVersion: DenoVersion,
  options: DenoStringifyOptions = {},
): string {
  const sidecar = sidecarByGraph.get(graph)
  if (sidecar === undefined) {
    throw new LockfileError({
      code: 'CAPABILITY_LACK',
      message: 'deno emitter requires same-format native state',
    })
  }
  if (sidecar.version === targetVersion && sidecar.exactReplay) {
    return sidecar.originalInput
  }
  if (sidecar.unrepresentable.length > 0) {
    throw new LockfileError({
      code: 'IRREDUCIBLE_LOSS',
      message: `deno emitter cannot safely represent mutation: ${sidecar.unrepresentable.join('; ')}`,
    })
  }
  return sidecar.version === targetVersion
    ? emitMutatedDocument(graph, sidecar, options)
    : emitConvertedDocument(graph, sidecar, targetVersion, options)
}

// === EMIT ===================================================================

function emitMutatedDocument(
  graph: Graph,
  sidecar: DenoSidecar,
  options: DenoStringifyOptions,
): string {
  const document = JSON.parse(JSON.stringify(sidecar.document)) as JsonObject
  // Sections are rewritten where the body actually keeps them, not where the declared
  // version says they belong, so a mutation of a mis-declared lock edits the entries
  // it parsed instead of growing a second, empty container beside them.
  const npm = mutableNpmRecord(document, sidecar.layoutVersion)
  const specifiers = mutableSpecifierRecord(document, sidecar.layoutVersion)
  const renameByOld = new Map<string, string>()
  for (const [nextNativeId, sourceNativeId] of sidecar.bumpedFromNative) {
    renameByOld.set(sourceNativeId, nextNativeId)
  }

  const currentNativeIds = new Set(sidecar.nodeByNative.keys())
  const nextNpm: Record<string, DenoNpmPackageEntry> = {}
  for (const [sourceNativeId, sourceEntry] of Object.entries(npm)) {
    const nativeId = renameByOld.get(sourceNativeId) ?? sourceNativeId
    if (!currentNativeIds.has(nativeId)) continue
    if (nextNpm[nativeId] !== undefined) {
      throw emitFailure(`native npm identity collision at ${nativeId}`)
    }
    nextNpm[nativeId] = sidecar.dirtyNative.has(nativeId)
      ? buildNpmEntry(graph, sidecar, nativeId, sourceEntry)
      : rewriteNpmEntryReferences(sourceEntry, renameByOld)
  }
  for (const nativeId of [...currentNativeIds].sort(compareStrings)) {
    if (nextNpm[nativeId] !== undefined) continue
    nextNpm[nativeId] = buildNpmEntry(graph, sidecar, nativeId)
  }
  replaceNpmRecord(document, sidecar.layoutVersion, nextNpm)

  for (const [request, resolved] of Object.entries(specifiers)) {
    const rewritten = rewriteSpecifierResolution(sidecar.layoutVersion, request, resolved, renameByOld)
    if (rewritten !== resolved) specifiers[request] = rewritten
  }

  const newline = options.lineEnding === 'crlf' ? '\r\n' : '\n'
  return JSON.stringify(document, null, 2).replaceAll('\n', newline) + newline
}

const V5_ENTRY_FIELDS = [
  'bin',
  'cpu',
  'deprecated',
  'optionalDependencies',
  'optionalPeers',
  'os',
  'scripts',
  'tarball',
] as const

function emitConvertedDocument(
  graph: Graph,
  sidecar: DenoSidecar,
  targetVersion: DenoVersion,
  options: DenoStringifyOptions,
): string {
  if (targetVersion === '5') {
    throw new LockfileError({
      code: 'CAPABILITY_LACK',
      message: `deno-v${sidecar.version} -> deno-v5 is unsupported: a v${sidecar.version} lock has neither complete v5 package metadata nor evidence that existing dependency, optional-dependency, and peer edges were correctly reclassified; a registry fetch alone is insufficient`,
    })
  }

  reportCrossVersionLosses(sidecar, targetVersion, options)
  // A section the source nesting cannot reach is carried by NEITHER the graph nor the
  // native sidecar, and the target document has no key to park it under. It is a real
  // loss, so it is declared here; emitting the conversion without a word would be the
  // silent drop this guard exists to prevent.
  for (const diagnostic of orphanedSectionDiagnostics(
    sidecar.orphanedSections,
    sidecar.version,
    'error',
    `a deno-v${sidecar.version} -> deno-v${targetVersion} conversion therefore drops it`,
  )) options.onDiagnostic?.(diagnostic)
  const npm = buildConvertedNpmRecord(graph, sidecar, targetVersion)
  const specifiers = convertSpecifierRecord(sidecar, targetVersion)
  const jsr = convertJsrRecord(sidecar, targetVersion, specifiers)
  const remote = cloneJsonObject(nativeSection(sidecar, 'remote'))
  const workspace = cloneJsonObject(nativeSection(sidecar, 'workspace'))
  if (
    sidecar.layoutVersion === '2'
    && targetVersion !== '2'
    && Object.keys(specifiers).length > 0
  ) {
    workspace.dependencies = Object.keys(specifiers).sort(compareStrings)
  }
  const redirects = cloneJsonObject(nativeSection(sidecar, 'redirects'))
  const document: JsonObject = { version: targetVersion }

  if (targetVersion === '2') {
    if (Object.keys(remote).length > 0) document.remote = remote
    const npmSection: JsonObject = {}
    const npmSpecifiers = npmOnlySpecifiers(specifiers)
    if (Object.keys(npmSpecifiers).length > 0) npmSection.specifiers = npmSpecifiers
    if (Object.keys(npm).length > 0) npmSection.packages = npm
    if (Object.keys(npmSection).length > 0) document.npm = npmSection
  } else if (targetVersion === '3') {
    const packages: JsonObject = {}
    if (Object.keys(specifiers).length > 0) packages.specifiers = specifiers
    if (Object.keys(jsr).length > 0) packages.jsr = jsr
    if (Object.keys(npm).length > 0) packages.npm = npm
    if (Object.keys(packages).length > 0) document.packages = packages
    if (Object.keys(remote).length > 0) document.remote = remote
    if (Object.keys(workspace).length > 0) document.workspace = workspace
  } else {
    if (Object.keys(specifiers).length > 0) document.specifiers = specifiers
    if (Object.keys(jsr).length > 0) document.jsr = jsr
    if (Object.keys(npm).length > 0) document.npm = npm
    if (Object.keys(remote).length > 0) document.remote = remote
    if (Object.keys(redirects).length > 0) document.redirects = redirects
    if (Object.keys(workspace).length > 0) document.workspace = workspace
  }

  for (const key of unknownTopLevelKeys(sidecar.document, sidecar.version)) {
    document[key] = cloneJson(sidecar.document[key])
  }
  const newline = options.lineEnding === 'crlf' ? '\r\n' : '\n'
  return JSON.stringify(document, null, 2).replaceAll('\n', newline) + newline
}

function buildConvertedNpmRecord(
  graph: Graph,
  sidecar: DenoSidecar,
  targetVersion: DenoVersion,
): Record<string, DenoNpmPackageEntry> {
  const sourceNpm = npmRecordFromDocument(sidecar.document, sidecar.layoutVersion)
  const output: Record<string, DenoNpmPackageEntry> = {}
  for (const nativeId of [...sidecar.nodeByNative.keys()].sort(compareStrings)) {
    output[nativeId] = buildNpmEntry(
      graph,
      sidecar,
      nativeId,
      sourceNpm[nativeId],
      targetVersion,
    )
  }
  return output
}

function convertSpecifierRecord(
  sidecar: DenoSidecar,
  targetVersion: DenoVersion,
): Record<string, string> {
  const source = specifierRecordFromDocument(sidecar.document, sidecar.layoutVersion)
  const output: Record<string, string> = {}
  for (const [request, resolved] of Object.entries(source).sort(compareEntries)) {
    // Value shapes travel with the nesting, not with the declared version: the
    // specifier values of a body nested the v4/v5 way are bare versions even when
    // the document calls itself v3.
    const npmRef = nativeIdFromSpecifier(sidecar.layoutVersion, request, resolved)
    if (npmRef !== undefined) {
      const requestBody = sidecar.layoutVersion === '2'
        ? request
        : request.startsWith('npm:')
          ? request.slice('npm:'.length)
          : request
      const targetRequest = targetVersion === '2' ? requestBody : `npm:${requestBody}`
      output[targetRequest] = targetVersion === '2'
        ? npmRef.nativeId
        : targetVersion === '3'
          ? `npm:${npmRef.nativeId}`
          : splitNameAndTail(npmRef.nativeId)?.tail ?? npmRef.nativeId
      continue
    }
    if (!request.startsWith('jsr:') || targetVersion === '2') {
      if (targetVersion !== '2') output[request] = resolved
      continue
    }
    output[request] = targetVersion === '3'
      ? jsrV3Resolution(request, resolved, sidecar.layoutVersion)
      : jsrV4Resolution(request, resolved, sidecar.layoutVersion)
  }
  return output
}

function jsrV3Resolution(
  request: string,
  resolved: string,
  sourceVersion: DenoVersion,
): string {
  if (sourceVersion === '3') return resolved
  const parsed = splitJsrSpecifier(request)
  return parsed === undefined ? resolved : `jsr:${parsed.name}@${resolved}`
}

function jsrV4Resolution(
  request: string,
  resolved: string,
  sourceVersion: DenoVersion,
): string {
  if (sourceVersion === '4' || sourceVersion === '5') return resolved
  const parsed = splitJsrSpecifier(resolved)
  return parsed?.range ?? resolved
}

function convertJsrRecord(
  sidecar: DenoSidecar,
  targetVersion: DenoVersion,
  targetSpecifiers: Readonly<Record<string, string>>,
): JsonObject {
  if (targetVersion === '2') return {}
  const source = cloneJsonObject(nativeSection(sidecar, 'jsr'))
  if (sidecar.layoutVersion === targetVersion
    || (sidecar.layoutVersion === '4' && targetVersion === '5')
    || (sidecar.layoutVersion === '5' && targetVersion === '4')) return source
  for (const entry of Object.values(source)) {
    if (!isObject(entry) || !Array.isArray(entry.dependencies)) continue
    entry.dependencies = entry.dependencies.map(dependency => {
      if (typeof dependency !== 'string' || !dependency.startsWith('jsr:')) return dependency
      if (targetVersion === '3') {
        const parsed = splitJsrSpecifier(dependency)
        if (parsed?.range !== undefined) return dependency
        const candidate = Object.keys(targetSpecifiers)
          .filter(request => splitJsrSpecifier(request)?.name === parsed?.name)
          .sort(compareStrings)[0]
        return candidate ?? dependency
      }
      const parsed = splitJsrSpecifier(dependency)
      return parsed === undefined ? dependency : `jsr:${parsed.name}`
    })
  }
  return source
}

function splitJsrSpecifier(
  value: string,
): Readonly<{ name: string; range?: string }> | undefined {
  if (!value.startsWith('jsr:')) return undefined
  const body = value.slice('jsr:'.length)
  const separator = body.lastIndexOf('@')
  if (separator <= 0) return { name: body }
  return { name: body.slice(0, separator), range: body.slice(separator + 1) }
}

function npmOnlySpecifiers(
  specifiers: Readonly<Record<string, string>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(specifiers).filter(([request]) => !request.startsWith('jsr:')),
  )
}

function reportCrossVersionLosses(
  sidecar: DenoSidecar,
  targetVersion: Exclude<DenoVersion, '5'>,
  options: DenoStringifyOptions,
): void {
  const sectionNames = targetVersion === '2'
    ? ['jsr', 'workspace', 'redirects'] as const
    : targetVersion === '3'
      ? ['redirects'] as const
      : []
  for (const section of sectionNames) {
    const value = nativeSection(sidecar, section)
    const count = Object.keys(value).length
    if (count === 0) continue
    options.onDiagnostic?.({
      code: `DENO_V${targetVersion}_NATIVE_SECTION_DROPPED`,
      severity: 'error',
      subject: `top-level:${section}`,
      message: `deno-v${sidecar.version} -> deno-v${targetVersion} drops non-empty native ${section} state because deno.lock v${targetVersion} has no carrier for it`,
      data: {
        feature: `top-level:${section}`,
        sourceFormat: `deno-v${sidecar.version}`,
        target: `deno-v${targetVersion}`,
        count,
      },
    })
  }
  if (sidecar.version !== '5') return
  const sourceNpm = npmRecordFromDocument(sidecar.document, sidecar.layoutVersion)
  for (const [nativeId, entry] of Object.entries(sourceNpm).sort(compareEntries)) {
    const fields = V5_ENTRY_FIELDS.filter(field => entry[field] !== undefined)
    if (fields.length === 0) continue
    options.onDiagnostic?.({
      code: `DENO_V${targetVersion}_V5_ENTRY_FIELDS_DROPPED`,
      severity: 'error',
      subject: nativeId,
      message: `deno-v5 -> deno-v${targetVersion} drops v5-only npm entry fields ${fields.join(', ')} from ${nativeId}`,
      data: {
        feature: 'deno:v5-entry-fields',
        sourceFormat: 'deno-v5',
        target: `deno-v${targetVersion}`,
        fields,
      },
    })
  }
}

function nativeSection(
  sidecar: Pick<DenoSidecar, 'document' | 'layoutVersion'>,
  section: 'jsr' | 'remote' | 'redirects' | 'workspace',
): JsonObject {
  if (section === 'jsr' && sidecar.layoutVersion === '3') {
    return optionalObject(optionalObject(sidecar.document.packages, 'packages').jsr, 'packages.jsr')
  }
  if (section === 'jsr' && sidecar.layoutVersion === '2') return {}
  if (section === 'redirects' && (sidecar.layoutVersion === '2' || sidecar.layoutVersion === '3')) return {}
  if (section === 'workspace' && sidecar.layoutVersion === '2') return {}
  return optionalObject(sidecar.document[section], section)
}

function npmRecordFromDocument(
  document: JsonObject,
  version: DenoVersion,
): Record<string, DenoNpmPackageEntry> {
  if (version === '2') {
    return npmRecord(optionalObject(document.npm, 'npm').packages)
  }
  if (version === '3') {
    return npmRecord(optionalObject(document.packages, 'packages').npm)
  }
  return npmRecord(document.npm)
}

function specifierRecordFromDocument(
  document: JsonObject,
  version: DenoVersion,
): Record<string, string> {
  if (version === '2') {
    return stringRecord(optionalObject(document.npm, 'npm').specifiers, 'npm.specifiers')
  }
  if (version === '3') {
    return stringRecord(optionalObject(document.packages, 'packages').specifiers, 'packages.specifiers')
  }
  return stringRecord(document.specifiers, 'specifiers')
}

const ALL_DENO_KNOWN_TOP_LEVEL_KEYS = new Set([
  'version',
  'npm',
  'packages',
  'specifiers',
  'jsr',
  'remote',
  'redirects',
  'workspace',
])

function unknownTopLevelKeys(
  document: JsonObject,
  _version: DenoVersion,
): string[] {
  return Object.keys(document)
    .filter(key => !ALL_DENO_KNOWN_TOP_LEVEL_KEYS.has(key))
    .sort(compareStrings)
}

function cloneJsonObject(value: JsonObject): JsonObject {
  return cloneJson(value) as JsonObject
}

function cloneJson(value: unknown): unknown {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

function mutableNpmRecord(
  document: JsonObject,
  version: DenoVersion,
): Record<string, DenoNpmPackageEntry> {
  if (version === '2') {
    const section = ensureObjectProperty(document, 'npm')
    return ensureObjectProperty(section, 'packages') as Record<string, DenoNpmPackageEntry>
  }
  if (version === '3') {
    const section = ensureObjectProperty(document, 'packages')
    return ensureObjectProperty(section, 'npm') as Record<string, DenoNpmPackageEntry>
  }
  return ensureObjectProperty(document, 'npm') as Record<string, DenoNpmPackageEntry>
}

function replaceNpmRecord(
  document: JsonObject,
  version: DenoVersion,
  npm: Record<string, DenoNpmPackageEntry>,
): void {
  if (version === '2') {
    ensureObjectProperty(document, 'npm').packages = npm
  } else if (version === '3') {
    ensureObjectProperty(document, 'packages').npm = npm
  } else {
    document.npm = npm
  }
}

function mutableSpecifierRecord(
  document: JsonObject,
  version: DenoVersion,
): Record<string, string> {
  if (version === '2') {
    return ensureObjectProperty(ensureObjectProperty(document, 'npm'), 'specifiers') as Record<string, string>
  }
  if (version === '3') {
    return ensureObjectProperty(ensureObjectProperty(document, 'packages'), 'specifiers') as Record<string, string>
  }
  return ensureObjectProperty(document, 'specifiers') as Record<string, string>
}

function ensureObjectProperty(object: JsonObject, key: string): JsonObject {
  const value = object[key]
  if (value === undefined) {
    const created: JsonObject = {}
    object[key] = created
    return created
  }
  return requiredObject(value, key)
}

function buildNpmEntry(
  graph: Graph,
  sidecar: DenoSidecar,
  nativeId: string,
  previous?: DenoNpmPackageEntry,
  targetVersion: DenoVersion = sidecar.layoutVersion,
): DenoNpmPackageEntry {
  const nodeId = sidecar.nodeByNative.get(nativeId)
  const node = nodeId === undefined ? undefined : graph.getNode(nodeId)
  if (nodeId === undefined || node === undefined) {
    throw emitFailure(`native npm identity ${nativeId} has no graph node`)
  }
  const payload = graph.tarballOf(nodeId)
  if (payload === undefined || payload.integrity === undefined || isEmptyIntegrity(payload.integrity)) {
    throw emitFailure(`npm ${nativeId} lacks registry integrity evidence`)
  }
  const integrity = emitDenoNpmIntegrity(payload.integrity)
  if (integrity === undefined) {
    throw emitFailure(
      `npm ${nativeId} has no SHA-512 or legacy SHA-1 tarball integrity; `
        + `deno.lock cannot carry any other algorithm`,
    )
  }
  if (payload.resolution?.type !== 'tarball' && payload.resolution?.type !== 'registry') {
    throw emitFailure(`npm ${nativeId} lacks tarball resolution evidence`)
  }

  const entry: DenoNpmPackageEntry = { integrity }
  if (targetVersion === '5') {
    if (payload.resolution.type === 'tarball') {
      const defaultUrl = defaultNpmTarballUrl(node.name, node.version)
      if (previous?.tarball !== undefined || payload.resolution.url !== defaultUrl) {
        entry.tarball = payload.resolution.url
      }
    }
    if (payload.os !== undefined) entry.os = [...payload.os]
    if (payload.cpu !== undefined) entry.cpu = [...payload.cpu]
    if (payload.deprecated !== undefined) entry.deprecated = true
    if (payload.hasInstallScript === true) entry.scripts = true
    if (payload.bin !== undefined) entry.bin = true
  }

  const dependencies = dependencyBlockForEmit(
    graph,
    sidecar,
    nodeId,
    targetVersion === '5' ? ['dep', 'peer'] : ['dep', 'optional', 'peer'],
    targetVersion,
    edge => edge.kind !== 'peer' || edge.attrs?.optional !== true,
  )
  const optionalDependencies = targetVersion === '5'
    ? dependencyBlockForEmit(graph, sidecar, nodeId, ['optional'], targetVersion)
    : undefined
  if (dependencies !== undefined) {
    entry.dependencies = dependencies
  } else if (targetVersion === '2' || targetVersion === '3') {
    entry.dependencies = {}
  }
  if (optionalDependencies !== undefined) entry.optionalDependencies = optionalDependencies
  if (targetVersion === '5') {
    const optionalPeerEdges = graph.out(nodeId, 'peer')
      .filter(edge => edge.attrs?.optional === true)
    const resolved = dependencyBlockForEmit(
      graph,
      sidecar,
      nodeId,
      ['peer'],
      targetVersion,
      edge => edge.attrs?.optional === true,
    ) as string[] | undefined
    const resolvedNames = new Set(optionalPeerEdges.map(edge => {
      const target = graph.getNode(edge.dst)
      return edge.attrs?.alias ?? target?.name ?? edge.dst
    }))
    const unresolved = Object.entries(payload.peerDependenciesMeta ?? {})
      .filter(([name, meta]) => meta.optional === true && !resolvedNames.has(name))
      .map(([name]) => {
        const range = payload.peerDependencies?.[name]
        if (range === undefined) {
          throw emitFailure(`npm ${nativeId} unresolved optional peer ${name} lacks its declared range`)
        }
        return `${name}@${range}`
      })
    const optionalPeers = [...(resolved ?? []), ...unresolved]
      .sort(compareStrings)
    if (optionalPeers.length > 0) entry.optionalPeers = optionalPeers
  }
  return entry
}

function dependencyBlockForEmit(
  graph: Graph,
  sidecar: DenoSidecar,
  srcId: string,
  kinds: readonly ('dep' | 'optional' | 'peer')[],
  targetVersion: DenoVersion,
  include: (edge: ReturnType<Graph['out']>[number]) => boolean = () => true,
): Record<string, string> | string[] | undefined {
  const nameOf = (edge: ReturnType<Graph['out']>[number]): string =>
    edge.attrs?.alias ?? graph.getNode(edge.dst)?.name ?? edge.dst
  const edges = kinds.flatMap(kind => graph.out(srcId, kind)).filter(include).sort((a, b) => {
    const byName = compareStrings(nameOf(a), nameOf(b))
    return byName !== 0 ? byName : compareStrings(a.dst, b.dst)
  })
  if (edges.length === 0) return undefined
  if (targetVersion === '2' || targetVersion === '3') {
    const output: Record<string, string> = {}
    for (const edge of edges) {
      const target = graph.getNode(edge.dst)
      const nativeId = sidecar.nativeByNode.get(edge.dst)
      if (target === undefined || nativeId === undefined) {
        throw emitFailure(`${srcId} dependency ${edge.dst} lacks native Deno identity`)
      }
      const alias = edge.attrs?.alias ?? target.name
      const previous = output[alias]
      if (previous !== undefined && previous !== nativeId) {
        throw emitFailure(`${srcId} dependency alias ${alias} resolves to both ${previous} and ${nativeId}`)
      }
      output[alias] = nativeId
    }
    return output
  }

  const nativeIdsByName = new Map<string, string[]>()
  for (const [nodeId, nativeId] of sidecar.nativeByNode) {
    const node = graph.getNode(nodeId)
    if (node === undefined) continue
    const values = nativeIdsByName.get(node.name)
    if (values === undefined) nativeIdsByName.set(node.name, [nativeId])
    else values.push(nativeId)
  }
  const output = edges.map(edge => {
    const target = graph.getNode(edge.dst)
    const nativeId = sidecar.nativeByNode.get(edge.dst)
    if (target === undefined || nativeId === undefined) {
      throw emitFailure(`${srcId} dependency ${edge.dst} lacks native Deno identity`)
    }
    const alias = edge.attrs?.alias
    if (alias !== undefined) return `${alias}@npm:${nativeId}`
    return (nativeIdsByName.get(target.name)?.length ?? 0) === 1
      ? target.name
      : nativeId
  })
  return [...new Set(output)]
}

function rewriteSpecifierResolution(
  version: DenoVersion,
  request: string,
  resolved: string,
  renameByOld: ReadonlyMap<string, string>,
): string {
  if (version === '2') return renameByOld.get(resolved) ?? resolved
  if (version === '3') {
    const prefix = resolved.startsWith('npm:') ? 'npm:' : ''
    const body = prefix === '' ? resolved : resolved.slice(prefix.length)
    const next = renameByOld.get(body)
    return next === undefined ? resolved : `${prefix}${next}`
  }
  const name = npmTargetNameFromSpecifier(request)
  if (name === undefined) return resolved
  const oldNativeId = `${name}@${resolved}`
  const next = renameByOld.get(oldNativeId)
  if (next === undefined) return resolved
  return splitNameAndTail(next)?.tail ?? resolved
}

function rewriteNpmEntryReferences(
  entry: DenoNpmPackageEntry,
  renameByOld: ReadonlyMap<string, string>,
): DenoNpmPackageEntry {
  const rewritten = { ...entry }
  for (const key of ['dependencies', 'optionalDependencies'] as const) {
    const block = entry[key]
    if (Array.isArray(block)) {
      rewritten[key] = block.map(reference =>
        rewriteNativeReference(reference, renameByOld))
    } else if (isObject(block)) {
      rewritten[key] = Object.fromEntries(Object.entries(block).map(([name, reference]) => [
        name,
        typeof reference === 'string'
          ? rewriteNativeReference(reference, renameByOld)
          : reference,
      ]))
    }
  }
  return rewritten
}

function rewriteNativeReference(
  reference: string,
  renameByOld: ReadonlyMap<string, string>,
): string {
  const direct = renameByOld.get(reference)
  if (direct !== undefined) return direct
  const npmMarker = reference.indexOf('@npm:')
  if (npmMarker >= 0) {
    const prefix = reference.slice(0, npmMarker + '@npm:'.length)
    const next = renameByOld.get(reference.slice(npmMarker + '@npm:'.length))
    if (next !== undefined) return `${prefix}${next}`
  }
  if (reference.startsWith('npm:')) {
    const next = renameByOld.get(reference.slice('npm:'.length))
    if (next !== undefined) return `npm:${next}`
  }
  return reference
}

function npmTargetNameFromSpecifier(request: string): string | undefined {
  if (!request.startsWith('npm:')) return undefined
  const body = request.slice('npm:'.length)
  const split = splitNameAndTail(body)
  if (split === undefined) return body
  if (!split.tail.startsWith('npm:')) return split.name
  return splitNameAndTail(split.tail.slice('npm:'.length))?.name
}

function emitFailure(message: string): LockfileError {
  return new LockfileError({ code: 'IRREDUCIBLE_LOSS', message: `deno emitter: ${message}` })
}

// === PARSE ==================================================================

function parseLayout(input: string, expectedVersion: DenoVersion): DenoLayout {
  let value: unknown
  try {
    value = JSON.parse(input)
  } catch (error) {
    throw new LockfileError({
      code: 'PARSE_FAILED',
      message: `deno adapter: invalid JSON: ${(error as Error).message}`,
      cause: error,
    })
  }
  if (!isObject(value)) throw failure('deno adapter: top-level value must be an object')
  const version = value.version
  if (version !== expectedVersion) {
    throw new LockfileError({
      code: 'FORMAT_MISMATCH',
      message: `deno-v${expectedVersion} adapter: expected top-level version ${expectedVersion}, got ${JSON.stringify(version)}`,
    })
  }

  const probed = probeNesting(value, expectedVersion)
  const nestingVersion = probed.version

  let npmValue: unknown
  let specifiersValue: unknown
  if (nestingVersion === '2') {
    const npmSection = optionalObject(value.npm, 'npm')
    npmValue = npmSection.packages
    specifiersValue = npmSection.specifiers
  } else if (nestingVersion === '3') {
    const packages = optionalObject(value.packages, 'packages')
    npmValue = packages.npm
    specifiersValue = packages.specifiers
  } else {
    npmValue = value.npm
    specifiersValue = value.specifiers
  }

  return {
    version: nestingVersion,
    declaredVersion: expectedVersion,
    orphanedSections: probed.orphaned,
    document: value,
    specifiers: stringRecord(specifiersValue, 'specifiers'),
    npm: npmRecord(npmValue),
    jsr: optionalObject(
      nestingVersion === '3' ? optionalObject(value.packages, 'packages').jsr : value.jsr,
      'jsr',
    ),
    remote: optionalObject(value.remote, 'remote'),
  }
}

// === NESTING PROBE ==========================================================
//
// A lock's `version` string names the generation that WROTE it; it does not
// determine where that generation's body nests its package sections. Two scraped
// corpus files disagree with their own declaration — an ordinary Fresh application
// lock declaring "3" over the v4/v5 top-level nesting, and a hand-authored
// `deno.lock.future` fixture declaring "4" over the v3 `packages` nesting.
//
// Deno resolves the disagreement by running its UPGRADE transforms from the declared
// version up to the current one, and each transform is a no-op when its own source
// section is absent. Two consequences follow, both measured against the vendored
// deno 2.9.4 binary with a dangling specifier — a parse-time corruption check, so it
// reports whether a section was READ rather than whether it happened to agree:
//
//   * A nesting at or ABOVE the declared version is read in full. deno accepts a
//     "3" document whose sections sit at the top level and names the planted
//     dangling id, so those 170 packages are live state, not decoration. Refusing
//     the file would refuse a lock `deno install` works with.
//   * A nesting BELOW the declared version is invisible. No downgrade transform
//     exists, so a `packages` key under a "4" or "5" declaration is unknown to the
//     reader, is dropped on the next write, and the lock regenerates from scratch.
//     deno plants no corruption error there. Reading it would mint a graph deno
//     never builds, so this adapter does not read it either — but it must not
//     vanish without a word, so it is reported as an orphan.
//   * When two nestings are populated at once, the transform MOVES the lower one
//     onto the higher one's keys, so the lowest populated nesting at or above the
//     declared version wins and the rest are overwritten.
//
// Emptiness matters: moving an absent or empty section is a no-op, so only a section
// with at least one entry can claim the nesting.
const NESTING_ORDER: readonly DenoNesting[] = ['v2', 'v3', 'v45']

function nestingOfVersion(version: DenoVersion): DenoNesting {
  return version === '2' ? 'v2' : version === '3' ? 'v3' : 'v45'
}

function lowestVersionOfNesting(nesting: DenoNesting): DenoVersion {
  return nesting === 'v2' ? '2' : nesting === 'v3' ? '3' : '4'
}

function populatedSections(document: JsonObject): DenoOrphanedSection[] {
  const sections: DenoOrphanedSection[] = []
  const add = (nesting: DenoNesting, path: string, value: unknown): void => {
    if (!isObject(value)) return
    const count = Object.keys(value).length
    if (count > 0) sections.push({ nesting, path, count })
  }
  // A top-level `npm` holding `specifiers`/`packages` is v2's own container, not a
  // v4/v5 entry map, so it must not be counted as evidence of both nestings.
  const npm = document.npm
  const isV2Container = isObject(npm) && (isObject(npm.packages) || isObject(npm.specifiers))
  if (isV2Container) {
    add('v2', 'npm.specifiers', (npm as JsonObject).specifiers)
    add('v2', 'npm.packages', (npm as JsonObject).packages)
  }
  const packages = document.packages
  if (isObject(packages)) {
    add('v3', 'packages.specifiers', packages.specifiers)
    add('v3', 'packages.jsr', packages.jsr)
    add('v3', 'packages.npm', packages.npm)
  }
  add('v45', 'specifiers', document.specifiers)
  add('v45', 'jsr', document.jsr)
  if (!isV2Container) add('v45', 'npm', npm)
  return sections
}

function probeNesting(
  document: JsonObject,
  declaredVersion: DenoVersion,
): Readonly<{ version: DenoVersion; orphaned: readonly DenoOrphanedSection[] }> {
  const declaredNesting = nestingOfVersion(declaredVersion)
  const sections = populatedSections(document)
  const readable = NESTING_ORDER.slice(NESTING_ORDER.indexOf(declaredNesting))
  const winner = readable.find(nesting => sections.some(section => section.nesting === nesting))
    ?? declaredNesting
  return {
    version: winner === declaredNesting ? declaredVersion : lowestVersionOfNesting(winner),
    orphaned: sections.filter(section => section.nesting !== winner),
  }
}

/** The document says one of these sections exists; the declared version cannot reach
 * it. Absence of a diagnostic here would be the silent loss. */
function orphanedSectionDiagnostics(
  orphaned: readonly DenoOrphanedSection[],
  declaredVersion: DenoVersion,
  severity: 'warning' | 'error',
  outcome: string,
): Diagnostic[] {
  return orphaned.map(section => ({
    code: severity === 'error' ? 'DENO_ORPHANED_SECTION_DROPPED' : 'DENO_ORPHANED_SECTION_IGNORED',
    subject: `top-level:${section.path}`,
    severity,
    message: `deno adapter: ${section.path} holds ${section.count} `
      + `entr${section.count === 1 ? 'y' : 'ies'} nested the deno-lockfile-`
      + `${section.nesting === 'v45' ? 'v4/v5' : section.nesting} way, which a `
      + `deno-v${declaredVersion} document does not reach, so deno itself never `
      + `reads it; ${outcome}`,
    data: {
      feature: `top-level:${section.path}`,
      sourceFormat: `deno-v${declaredVersion}`,
      nesting: section.nesting,
      count: section.count,
    },
  }))
}

function createParseContext(
  layout: DenoLayout,
  rootManifest: Manifest | undefined,
  registryFor?: (packageName: string) => string | undefined,
): DenoParseContext {
  return {
    registryFor,
    builder: newBuilder(),
    layout,
    diagnostics: orphanedSectionDiagnostics(
      layout.orphanedSections,
      layout.declaredVersion,
      'warning',
      'it is left out of the graph rather than read as if it were reachable',
    ),
    edgeKeys: new Set(),
    parsedByNative: new Map(),
    nativeByNode: new Map(),
    nodeByNative: new Map(),
    nativeByName: new Map(),
    unrepresentable: [],
    rootManifest,
  }
}

function registerNpmNodes(context: DenoParseContext): void {
  const canonicalCounts = new Map<string, number>()
  for (const nativeId of Object.keys(context.layout.npm).sort(compareStrings)) {
    const parsed = parseNpmPackageId(nativeId)
    context.parsedByNative.set(nativeId, parsed)
    const ids = context.nativeByName.get(parsed.name)
    if (ids === undefined) context.nativeByName.set(parsed.name, [nativeId])
    else ids.push(nativeId)
    const canonical = canonicalNodeId(parsed)
    canonicalCounts.set(canonical, (canonicalCounts.get(canonical) ?? 0) + 1)
  }

  for (const [nativeId, entry] of Object.entries(context.layout.npm).sort(compareEntries)) {
    const parsed = context.parsedByNative.get(nativeId)!
    const canonical = canonicalNodeId(parsed)
    const peerContextByBase = new Map(canonicalPeerContext(
      parsed,
      (canonicalCounts.get(canonical) ?? 0) > 1,
      peer => resolvePeerNativeId(context, peer, entry) !== undefined,
    ).map(value => [stripPeerContextFromNodeId(value), value]))
    for (const peer of parsed.peers) {
      const resolved = resolvePeerNativeId(context, peer, entry)
      const target = resolved === undefined ? undefined : context.parsedByNative.get(resolved)
      if (target !== undefined) {
        peerContextByBase.set(serializeNodeId(peer.name, peer.version, []), canonicalNodeId(target))
      }
    }
    for (const peer of optionalPeerDeclarations(context, entry)) {
      const target = peer.nativeId === undefined
        ? undefined
        : context.parsedByNative.get(peer.nativeId)
      if (target !== undefined) {
        peerContextByBase.set(serializeNodeId(target.name, target.version, []), canonicalNodeId(target))
      }
    }
    const peerContext = [...peerContextByBase.values()].sort(compareStrings)
    const nodeId = serializeNodeId(parsed.name, parsed.version, peerContext)
    const retainedNativeId = context.nativeByNode.get(nodeId)
    if (retainedNativeId !== undefined) {
      collapseUnrolledNative(context, nodeId, retainedNativeId, nativeId, entry)
      continue
    }
    const node: Node = {
      id: nodeId,
      name: parsed.name,
      version: parsed.version,
      peerContext,
    }
    context.builder.addNode(node)
    context.nativeByNode.set(nodeId, nativeId)
    context.nodeByNative.set(nativeId, nodeId)
    recordTarball(context, node, parsed, nativeId, entry)
  }
}

/**
 * Deno unrolls a mutual peer-dependency cycle to arbitrary depth, writing one
 * native npm id per unrolling of the same pair (one scraped lock carries 357
 * ids for a single `client-sts`/`client-sso-oidc` pair). The canonical NodeId
 * keys the peer context by resolved base `name@version`, so every unrolling of
 * one base projects onto one node. Across the whole scraped corpus every
 * unrolling of a base was measured to carry the SAME integrity — 513 of 513
 * groups, zero exceptions — so the unrollings are one artifact and binding them
 * to one node loses nothing. The native ids all stay in `nodeByNative`, so
 * same-format replay still reproduces every one of them verbatim.
 *
 * Identical integrity is the CONDITION, not a corollary: two native ids that
 * project onto one node while carrying different integrity — or while one of
 * them proves no integrity at all — are different artifacts, and collapsing
 * them would silently discard one. Those still refuse, naming both ids.
 *
 * Only the parse-side identity is collapsed. A single node cannot rebuild the
 * distinct dependency blocks of the unrollings it stands for, so any emit that
 * is not the byte-exact replay is refused through `unrepresentable`.
 */
function collapseUnrolledNative(
  context: DenoParseContext,
  nodeId: string,
  retainedNativeId: string,
  nativeId: string,
  entry: DenoNpmPackageEntry,
): void {
  const retained = context.layout.npm[retainedNativeId]?.integrity
  if (retained === undefined || entry.integrity === undefined || retained !== entry.integrity) {
    throw failure(
      `deno adapter: native npm ids ${retainedNativeId} and ${nativeId} collapse onto canonical `
        + `NodeId ${nodeId} but are not the same artifact: integrity `
        + `${retained ?? '<none>'} vs ${entry.integrity ?? '<none>'}`,
    )
  }
  context.nodeByNative.set(nativeId, nodeId)
  context.diagnostics.push({
    code: 'DENO_PEER_CYCLE_UNROLLING_COLLAPSED',
    subject: nodeId,
    severity: 'warning',
    message: `deno adapter: native npm id ${nativeId} unrolls the same peer cycle as `
      + `${retainedNativeId} and carries the same integrity, so both project onto ${nodeId}`,
  })
  context.unrepresentable.push(
    `peer-cycle unrolling ${nativeId} shares node ${nodeId} with ${retainedNativeId}`,
  )
}

// Deno stores exactly ONE integrity value per npm entry, and it stores whatever
// `dist.integrity()` yields for the resolved packument: the registry's own
// `integrity` string when the packument has one, else the legacy `dist.shasum` as
// bare lowercase hex. registry.npmjs.org always supplies `integrity`, so 310 287 of
// the 310 303 v3/v4/v5 npm entries that carry the field are canonical singular
// `sha512-…` SRI. The other 16 are one lock resolved through a cnpm mirror
// (`registry.m.jd.com`, and every entry in it carries an explicit `tarball` on that
// host); cnpm packuments serve only `shasum`, so all 16 are 40-hex sha1. Deno 2.9.4
// reads that lock without complaint, so refusing it was ours, not the file's.
//
// The hex digest is tagged `registry` because it IS `dist.shasum` verbatim, and that
// origin is tarball-scoped — the value sits in deno's integrity FIELD, so it must
// stay SRI-emittable, unlike the yarn-classic `url-fragment` sha1 which rides a URL
// and is excluded from this field by `tarballHashes`.
const DENO_LEGACY_SHASUM_RE = /^[0-9a-f]{40}$/

function parseDenoNpmIntegrity(raw: string): Integrity | undefined {
  if (DENO_LEGACY_SHASUM_RE.test(raw)) {
    return { hashes: [{ algorithm: 'sha1', digest: raw, origin: 'registry' }] }
  }
  const integrity = parseSri(raw, 'sri')
  // Canonicality is the round-trip condition, not taste: re-emit must reproduce the
  // input byte for byte, so a non-canonical encoding is refused, never rewritten.
  if (
    isEmptyIntegrity(integrity)
    || integrity.hashes.length !== 1
    || integrity.hashes[0]?.algorithm !== 'sha512'
    || emitSri(integrity) !== raw
  ) return undefined
  return integrity
}

/** The single value `npm.<id>.integrity` can carry, or `undefined` when the node
 *  proves no digest deno.lock can express. Prefers sha512; falls back to the bare
 *  shasum hex, which is what deno writes when that is all the registry proved. The
 *  fallback re-checks the digest shape because `setTarball` is public API: emitting
 *  a hash this adapter's own parser would refuse is never the better failure. */
function emitDenoNpmIntegrity(integrity: Integrity): string | undefined {
  const sha512 = pickTarballSha512(integrity)
  if (sha512 !== undefined) return emitSri({ hashes: [sha512] })
  const sha1 = tarballHashes(integrity).find(hash => hash.algorithm === 'sha1')?.digest
  return sha1 !== undefined && DENO_LEGACY_SHASUM_RE.test(sha1) ? sha1 : undefined
}

function recordTarball(
  context: DenoParseContext,
  node: Node,
  parsed: DenoNpmPackageId,
  nativeId: string,
  entry: DenoNpmPackageEntry,
): void {
  const registry = context.registryFor?.(node.name)
  const payload: TarballPayload = {
    resolution: entry.tarball !== undefined
      ? { type: 'tarball', url: entry.tarball }
      : registry === undefined
        ? { type: 'registry' }
        : { type: 'tarball', url: registryTarballUrl(node.name, node.version, registry) },
  }
  if (entry.tarball !== undefined) payload.nativeResolution = entry.tarball
  if (entry.integrity !== undefined) {
    const integrity = parseDenoNpmIntegrity(entry.integrity)
    if (integrity === undefined) {
      throw failure(
        `deno adapter: npm ${nativeId} integrity must be canonical SHA-512 SRI `
          + `or a legacy 40-character lowercase SHA-1 hex shasum`,
      )
    }
    payload.integrity = integrity
  } else if (
    entry.tarball === undefined
    && !hasSourceAuthoritativeV5PatchAbsence(context.layout, parsed)
  ) {
    throw failure(`deno adapter: npm ${nativeId} is missing both integrity and explicit tarball`)
  }
  if (entry.os !== undefined) payload.os = validateStringArray(entry.os, `npm.${nativeId}.os`)
  if (entry.cpu !== undefined) payload.cpu = validateStringArray(entry.cpu, `npm.${nativeId}.cpu`)
  if (entry.deprecated === true) payload.deprecated = 'deprecated'
  if (entry.scripts === true) payload.hasInstallScript = true
  if (entry.bin === true) payload.bin = ''
  const optionalPeers = optionalPeerDeclarations(context, entry)
  const optionalPeerBases = resolvedOptionalPeerBases(context, optionalPeers)
  const requiredPeers = parsed.peers.filter(peer =>
    !optionalPeerBases.has(serializeNodeId(peer.name, peer.version, [])))
  if (requiredPeers.length > 0) {
    payload.peerDependencies = Object.fromEntries(
      requiredPeers.map(peer => [peer.name, peer.version]),
    )
  }
  if (optionalPeers.length > 0) {
    payload.peerDependencies = {
      ...payload.peerDependencies,
      ...Object.fromEntries(optionalPeers.map(peer => [peer.alias, peer.range])),
    }
    payload.peerDependenciesMeta = Object.fromEntries(
      optionalPeers.map(peer => [peer.alias, { optional: true }]),
    )
  }
  context.builder.setTarball({ name: node.name, version: node.version }, payload)
}

function hasSourceAuthoritativeV5PatchAbsence(
  layout: DenoLayout,
  parsed: DenoNpmPackageId,
): boolean {
  if (layout.version !== '5') return false
  const workspace = layout.document.workspace
  if (!isObject(workspace) || !isObject(workspace.links)) return false
  // Workspace links identify the base package; peer suffixes identify only one
  // resolution of it and therefore must not participate in this match.
  return isObject(workspace.links[`npm:${parsed.name}@${parsed.version}`])
}

function addNpmEdges(context: DenoParseContext): void {
  for (const [nativeId, entry] of Object.entries(context.layout.npm).sort(compareEntries)) {
    const srcId = context.nodeByNative.get(nativeId)!
    const parsed = context.parsedByNative.get(nativeId)!
    const peerNativeIds = new Set(parsed.peers.flatMap(peer => {
      const resolved = resolvePeerNativeId(context, peer, entry)
      return resolved === undefined ? [] : [resolved]
    }))
    addDependencyBlock(context, srcId, entry.dependencies, 'dep', false, peerNativeIds)
    addDependencyBlock(context, srcId, entry.optionalDependencies, 'optional', true)
    const optionalPeers = optionalPeerDeclarations(context, entry)
    for (const declaration of optionalPeers) {
      if (declaration.nativeId === undefined) continue
      const dstId = context.nodeByNative.get(declaration.nativeId)
      const target = context.parsedByNative.get(declaration.nativeId)
      if (dstId === undefined || target === undefined) {
        throw failure(`deno adapter: optional peer ${declaration.nativeId} is missing`)
      }
      const attrs: EdgeAttrs = { optional: true, range: declaration.range }
      if (declaration.alias !== target.name) attrs.alias = declaration.alias
      addEdgeOnce(context, srcId, dstId, 'peer', attrs)
    }

    const seenPeerBases = resolvedOptionalPeerBases(context, optionalPeers)
    for (const peer of parsed.peers) {
      const peerBase = serializeNodeId(peer.name, peer.version, [])
      if (seenPeerBases.has(peerBase)) continue
      seenPeerBases.add(peerBase)
      const peerNativeId = resolvePeerNativeId(context, peer, entry)
      if (peerNativeId === undefined) {
        context.diagnostics.push({
          code: 'DENO_PEER_PROJECTION_UNRESOLVED',
          subject: srcId,
          severity: 'warning',
          message: `deno adapter: native peer ${peer.name}@${peer.version} remains authoritative in the preserved suffix because no unique npm package can be projected`,
        })
        continue
      }
      const dstId = context.nodeByNative.get(peerNativeId)
      if (dstId === undefined) {
        throw failure(`deno adapter: npm ${nativeId} peer ${peerNativeId} is missing`)
      }
      addEdgeOnce(context, srcId, dstId, 'peer', { range: peer.version })
    }
  }
}

function resolvedOptionalPeerBases(
  context: DenoParseContext,
  declarations: readonly DenoOptionalPeerDeclaration[],
): Set<string> {
  const bases = new Set<string>()
  for (const declaration of declarations) {
    const target = declaration.nativeId === undefined
      ? undefined
      : context.parsedByNative.get(declaration.nativeId)
    if (target !== undefined) {
      bases.add(serializeNodeId(target.name, target.version, []))
    }
  }
  return bases
}

function optionalPeerDeclarations(
  context: DenoParseContext,
  entry: DenoNpmPackageEntry,
): DenoOptionalPeerDeclaration[] {
  const raw = entry.optionalPeers
  if (raw === undefined) return []
  if (!Array.isArray(raw)) {
    return Object.entries(raw).sort(compareEntries).map(([alias, nativeId]) => {
      const target = context.parsedByNative.get(nativeId)
      if (target === undefined) {
        const split = splitNameAndTail(nativeId)
        return {
          alias,
          range: split?.tail ?? nativeId,
        }
      }
      return {
        alias,
        range: alias === target.name
          ? target.version
          : `npm:${target.name}@${target.version}`,
        nativeId,
      }
    })
  }
  return raw.map(value => optionalPeerDeclarationFromCompact(context, value))
}

function optionalPeerDeclarationFromCompact(
  context: DenoParseContext,
  value: string,
): DenoOptionalPeerDeclaration {
  const split = splitNameAndTail(value)
  if (split === undefined) {
    const candidates = context.nativeByName.get(value) ?? []
    if (candidates.length !== 1) {
      throw failure(`deno adapter: compact npm optional peer ${value} is not uniquely resolvable`)
    }
    const target = context.parsedByNative.get(candidates[0]!)!
    return { alias: value, range: target.version, nativeId: candidates[0]! }
  }

  if (split.tail.startsWith('npm:')) {
    const nativeId = split.tail.slice('npm:'.length)
    const target = context.parsedByNative.get(nativeId)
    if (target === undefined) {
      throw failure(`deno adapter: optional peer alias ${value} has no npm package`)
    }
    return {
      alias: split.name,
      range: `npm:${target.name}@${target.version}`,
      nativeId,
    }
  }

  if (context.parsedByNative.has(value)) {
    const target = context.parsedByNative.get(value)!
    return { alias: split.name, range: target.version, nativeId: value }
  }

  const candidates = (context.nativeByName.get(split.name) ?? []).filter(nativeId => {
    const target = context.parsedByNative.get(nativeId)
    if (target === undefined || semver.valid(target.version) === null) return false
    try {
      return semver.satisfies(target.version, split.tail)
    } catch {
      return false
    }
  })
  return {
    alias: split.name,
    range: split.tail,
    nativeId: candidates.length === 1 ? candidates[0] : undefined,
  }
}

function resolvePeerNativeId(
  context: DenoParseContext,
  peer: DenoNpmPackageId,
  entry: DenoNpmPackageEntry,
): string | undefined {
  const exact = serializeNativePackageId(peer)
  if (context.parsedByNative.has(exact)) return exact
  const candidates = (context.nativeByName.get(peer.name) ?? [])
    .filter(nativeId => context.parsedByNative.get(nativeId)?.version === peer.version)
  if (candidates.length === 1) return candidates[0]!

  const referenced = dependencyRefs(context, entry)
    .filter(ref => ref.alias === peer.name)
    .map(ref => ref.nativeId)
    .filter(nativeId => context.parsedByNative.get(nativeId)?.version === peer.version)
  const unique = [...new Set(referenced)]
  if (unique.length === 1) return unique[0]!
  return undefined
}

function dependencyRefs(
  context: DenoParseContext,
  entry: DenoNpmPackageEntry,
): Array<{ alias: string; nativeId: string }> {
  const refs: Array<{ alias: string; nativeId: string }> = []
  for (const block of [entry.dependencies, entry.optionalDependencies, entry.optionalPeers]) {
    if (block === undefined) continue
    if (Array.isArray(block)) {
      for (const value of block) refs.push(dependencyRefFromCompact(context, value))
    } else {
      for (const [alias, nativeId] of Object.entries(block)) refs.push({ alias, nativeId })
    }
  }
  return refs
}

function addDependencyBlock(
  context: DenoParseContext,
  srcId: string,
  raw: Record<string, string> | string[] | undefined,
  kind: 'dep' | 'optional' | 'peer',
  allowMissing = false,
  excludedNativeIds: ReadonlySet<string> = new Set(),
): void {
  if (raw === undefined) return
  const refs = Array.isArray(raw)
    ? raw.map(value => dependencyRefFromCompact(context, value))
    : Object.entries(raw).sort(compareEntries).map(([alias, nativeId]) => ({ alias, nativeId }))
  for (const ref of refs) {
    if (excludedNativeIds.has(ref.nativeId)) continue
    const dstId = context.nodeByNative.get(ref.nativeId)
    if (dstId === undefined) {
      const qualifier = allowMissing ? 'optional ' : ''
      context.diagnostics.push({
        code: allowMissing
          ? 'DENO_OPTIONAL_DEP_PROJECTION_UNRESOLVED'
          : 'DENO_DEP_PROJECTION_UNRESOLVED',
        subject: srcId,
        severity: 'warning',
        message: `deno adapter: ${qualifier}native reference ${ref.nativeId} has no npm package to project`,
      })
      context.unrepresentable.push(`${srcId} references missing native npm package ${ref.nativeId}`)
      continue
    }
    const target = context.parsedByNative.get(ref.nativeId)!
    const attrs: EdgeAttrs = {
      range: ref.alias === target.name
        ? target.version
        : `npm:${target.name}@${target.version}`,
    }
    if (ref.alias !== target.name) attrs.alias = ref.alias
    if (kind === 'optional') attrs.optional = true
    addEdgeOnce(context, srcId, dstId, kind, attrs)
  }
}

function dependencyRefFromCompact(
  context: DenoParseContext,
  value: string,
): { alias: string; nativeId: string } {
  const split = splitNameAndTail(value)
  if (split === undefined) {
    const candidates = context.nativeByName.get(value) ?? []
    if (candidates.length !== 1) {
      throw failure(`deno adapter: compact npm dependency ${value} is not uniquely resolvable`)
    }
    return { alias: value, nativeId: candidates[0]! }
  }
  if (split.tail.startsWith('npm:')) {
    const target = split.tail.slice('npm:'.length)
    const targetSplit = splitNameAndTail(target)
    if (targetSplit === undefined) {
      throw failure(`deno adapter: invalid npm alias dependency ${value}`)
    }
    return { alias: split.name, nativeId: target }
  }
  return { alias: split.name, nativeId: value }
}

function addRootSpecifierEdges(context: DenoParseContext): void {
  if (Object.keys(context.layout.specifiers).length === 0) return
  if (context.rootManifest !== undefined) {
    addManifestRootEdges(context, context.rootManifest)
    return
  }
  const root: Node = {
    id: '@0.0.0',
    name: '',
    version: '0.0.0',
    peerContext: [],
    workspacePath: '',
  }
  context.builder.addNode(root)
  const seen = new Set<string>()
  for (const [request, resolved] of Object.entries(context.layout.specifiers).sort(compareEntries)) {
    const ref = nativeIdFromSpecifier(context.layout.version, request, resolved)
    if (ref === undefined) continue
    const dstId = context.nodeByNative.get(ref.nativeId)
    if (dstId === undefined) {
      throw failure(`deno adapter: specifier ${request} references missing npm package ${ref.nativeId}`)
    }
    const identity = `${dstId}\0${ref.alias ?? ''}`
    if (seen.has(identity)) continue
    seen.add(identity)
    const attrs: EdgeAttrs = { range: request }
    if (ref.alias !== undefined) attrs.alias = ref.alias
    context.builder.addEdge(root.id, dstId, 'dep', attrs)
  }
}

// === MANIFEST EVIDENCE ======================================================
// Manifest scope is mandatory evidence: absence fails closed rather than
// defaulting dependencies to production.

interface DenoManifestDependency {
  readonly alias: string
  readonly targetName: string
  readonly requestRange: string
  readonly targetRange: string
  readonly kind: Extract<EdgeKind, 'dep' | 'dev' | 'optional' | 'peer'>
}

interface DenoRootSpecifier {
  readonly request: string
  readonly ref: { readonly nativeId: string; readonly alias?: string }
  readonly alias: string
  readonly targetName: string
  readonly requestRange: string
}

function addManifestRootEdges(context: DenoParseContext, manifest: Manifest): void {
  const version = manifest.version ?? '0.0.0'
  const name = manifest.name ?? ''
  const root: Node = {
    id: name === '' ? `@${version}` : serializeNodeId(name, version, []),
    name,
    version,
    peerContext: [],
    workspacePath: '',
  }
  context.builder.addNode(root)
  const specifiers = npmRootSpecifiers(context)
  const usedRequests = new Set<string>()
  for (const declaration of manifestNpmDependencies(manifest)) {
    const matches = specifiers.filter(specifier =>
      specifier.alias === declaration.alias
      && specifier.targetName === declaration.targetName
      && specifier.requestRange === declaration.requestRange)
    if (matches.length !== 1) {
      throw failure(
        `DENO_MANIFEST_DEP_UNRESOLVED: manifest ${declaration.kind} `
          + `${declaration.alias}@${declaration.targetRange} matched ${matches.length} deno.lock npm specifiers`,
      )
    }
    const match = matches[0]!
    usedRequests.add(match.request)
    const dstId = context.nodeByNative.get(match.ref.nativeId)
    if (dstId === undefined) {
      throw failure(
        `DENO_MANIFEST_DEP_UNRESOLVED: manifest ${declaration.alias} references `
          + `missing npm package ${match.ref.nativeId}`,
      )
    }
    const attrs: EdgeAttrs = { range: declaration.targetRange }
    if (declaration.alias !== declaration.targetName) attrs.alias = declaration.alias
    if (declaration.kind === 'optional') attrs.optional = true
    addEdgeOnce(context, root.id, dstId, declaration.kind, attrs)
  }
  const unmatched = specifiers
    .filter(specifier => !usedRequests.has(specifier.request))
    .map(specifier => specifier.request)
  if (unmatched.length > 0) {
    throw failure(
      `DENO_MANIFEST_SCOPE_UNRESOLVED: sibling deno.json/package.json does not classify `
        + `deno.lock npm specifier${unmatched.length === 1 ? '' : 's'} ${unmatched.join(', ')}`,
    )
  }
}

function npmRootSpecifiers(context: DenoParseContext): DenoRootSpecifier[] {
  const output: DenoRootSpecifier[] = []
  for (const [request, resolved] of Object.entries(context.layout.specifiers).sort(compareEntries)) {
    const ref = nativeIdFromSpecifier(context.layout.version, request, resolved)
    if (ref === undefined) continue
    const target = context.parsedByNative.get(ref.nativeId)
    if (target === undefined) {
      throw failure(`deno adapter: specifier ${request} references missing npm package ${ref.nativeId}`)
    }
    const descriptor = npmRequestDescriptor(context.layout.version, request, target.name, ref.alias)
    if (descriptor === undefined) {
      throw failure(`deno adapter: npm specifier ${request} has no classifiable manifest descriptor`)
    }
    output.push({ request, ref, ...descriptor })
  }
  return output
}

function npmRequestDescriptor(
  version: DenoVersion,
  request: string,
  targetName: string,
  projectedAlias: string | undefined,
): { alias: string; targetName: string; requestRange: string } | undefined {
  const body = version === '2'
    ? request
    : request.startsWith('npm:')
      ? request.slice('npm:'.length)
      : undefined
  if (body === undefined) return undefined
  const outer = splitNameAndTail(body)
  if (outer === undefined) {
    return {
      alias: projectedAlias ?? targetName,
      targetName,
      requestRange: '*',
    }
  }
  if (outer.tail.startsWith('npm:')) {
    const inner = splitNameAndTail(outer.tail.slice('npm:'.length))
    if (inner === undefined) return undefined
    return { alias: outer.name, targetName: inner.name, requestRange: inner.tail }
  }
  return {
    alias: projectedAlias ?? outer.name,
    targetName,
    requestRange: outer.tail,
  }
}

function manifestNpmDependencies(manifest: Manifest): DenoManifestDependency[] {
  const primary = new Map<string, DenoManifestDependency>()
  const addPrimary = (
    block: Readonly<Record<string, string>> | undefined,
    kind: Extract<EdgeKind, 'dep' | 'dev' | 'optional'>,
    replace: boolean,
  ): void => {
    for (const [alias, value] of Object.entries(block ?? {}).sort(compareEntries)) {
      const declaration = npmManifestDependency(alias, value, kind)
      if (declaration === undefined) continue
      if (replace || !primary.has(alias)) primary.set(alias, declaration)
    }
  }
  addPrimary(manifest.dependencies, 'dep', false)
  addPrimary(manifest.devDependencies, 'dev', false)
  addPrimary(manifest.optionalDependencies, 'optional', true)
  const peer = Object.entries(manifest.peerDependencies ?? {})
    .sort(compareEntries)
    .flatMap(([alias, value]) => {
      const declaration = npmManifestDependency(alias, value, 'peer')
      return declaration === undefined ? [] : [declaration]
    })
  return [...primary.values(), ...peer].sort((left, right) =>
    compareStrings(left.alias, right.alias) || compareStrings(left.kind, right.kind))
}

function npmManifestDependency(
  alias: string,
  value: string,
  kind: DenoManifestDependency['kind'],
): DenoManifestDependency | undefined {
  if (
    value.startsWith('jsr:')
    || value.startsWith('http:')
    || value.startsWith('https:')
    || value.startsWith('file:')
    || value.startsWith('workspace:')
  ) return undefined
  if (!value.startsWith('npm:')) {
    return {
      alias,
      targetName: alias,
      requestRange: value,
      targetRange: value,
      kind,
    }
  }
  const target = splitNameAndTail(value.slice('npm:'.length))
  if (target === undefined) {
    return {
      alias,
      targetName: value.slice('npm:'.length),
      requestRange: '*',
      targetRange: '*',
      kind,
    }
  }
  return {
    alias,
    targetName: target.name,
    requestRange: target.tail,
    targetRange: alias === target.name ? target.tail : value,
    kind,
  }
}

function nativeIdFromSpecifier(
  version: DenoVersion,
  request: string,
  resolved: string,
): { nativeId: string; alias?: string } | undefined {
  if (version === '2') {
    const requestParts = splitNameAndTail(request)
    const resolvedParts = splitNameAndTail(resolved)
    if (resolvedParts === undefined) return undefined
    const alias = requestParts?.name ?? request
    return alias === resolvedParts.name ? { nativeId: resolved } : { nativeId: resolved, alias }
  }
  if (!request.startsWith('npm:')) return undefined
  const requestBody = request.slice('npm:'.length)
  const requestParts = splitNameAndTail(requestBody)
  const alias = requestParts?.name ?? requestBody
  const name = requestParts?.tail.startsWith('npm:')
    ? splitNameAndTail(requestParts.tail.slice('npm:'.length))?.name
    : alias
  if (name === undefined) return undefined
  if (version === '3') {
    const nativeId = resolved.startsWith('npm:') ? resolved.slice('npm:'.length) : resolved
    const target = splitNameAndTail(nativeId)
    if (target === undefined) return undefined
    return target.name === alias ? { nativeId } : { nativeId, alias }
  }
  // A v3 locator reaching here is refused by `validateSpecifierValueShape` before any
  // caller runs, so `resolved` is a bare version and this rebuild is well formed.
  const nativeId = `${name}@${resolved}`
  return name === alias ? { nativeId } : { nativeId, alias }
}

function addEdgeOnce(
  context: DenoParseContext,
  src: string,
  dst: string,
  kind: Extract<EdgeKind, 'dep' | 'dev' | 'optional' | 'peer'>,
  attrs?: EdgeAttrs,
): void {
  const key = `${src}\0${dst}\0${kind}\0${attrs?.alias ?? ''}`
  if (context.edgeKeys.has(key)) return
  context.edgeKeys.add(key)
  context.builder.addEdge(src, dst, kind, Object.keys(attrs ?? {}).length === 0 ? undefined : attrs)
}

// === SEAL AND SIDECAR REMAP =================================================

function sealDenoGraph(context: DenoParseContext, input: string): Graph {
  for (const diagnostic of context.diagnostics) context.builder.diagnostic(diagnostic)
  try {
    const graph = context.builder.seal()
    const sidecar: DenoSidecar = {
      version: context.layout.declaredVersion,
      layoutVersion: context.layout.version,
      orphanedSections: context.layout.orphanedSections,
      originalInput: input,
      document: context.layout.document,
      nativeByNode: context.nativeByNode,
      nodeByNative: context.nodeByNative,
      parsedByNative: context.parsedByNative,
      bumpedFromNative: new Map(),
      dirtyNative: new Set(),
      exactReplay: true,
      unrepresentable: [...new Set(context.unrepresentable)].sort(),
      jsrCount: Object.keys(context.layout.jsr).length,
      remoteCount: Object.keys(context.layout.remote).length,
    }
    return withSidecarPropagation(graph, sidecar)
  } catch (error) {
    if (error instanceof GraphError) {
      throw failure(`deno adapter seal failed: ${error.message}`)
    }
    throw error
  }
}

function withSidecarPropagation(graph: Graph, sidecar: DenoSidecar): Graph {
  let proxy: Graph
  proxy = {
    getNode: (...args) => graph.getNode(...args),
    nodes: () => graph.nodes(),
    byName: (...args) => graph.byName(...args),
    roots: () => graph.roots(),
    out: (...args) => graph.out(...args),
    in: (...args) => graph.in(...args),
    walk: (...args) => graph.walk(...args),
    topoSort: () => graph.topoSort(),
    subgraph: (...args) => graph.subgraph(...args),
    diff: (...args) => graph.diff(...args),
    tarball: (...args) => graph.tarball(...args),
    tarballOf: (...args) => graph.tarballOf(...args),
    tarballs: () => graph.tarballs(),
    overrides: () => accessGraphOverrides(proxy),
    governingOverride: (...args) => accessGraphGoverningOverride(proxy, ...args),
    registryPackages: () => accessGraphRegistryPackages(proxy),
    diagnostics: () => graph.diagnostics(),
    layoutHints: () => graph.layoutHints(),
    mutate(transaction: (mutator: Mutator) => void): MutateResult {
      const result = graph.mutate(transaction)
      const next = remapSidecarAfterMutation(sidecar, result)
      return { ...result, graph: withSidecarPropagation(result.graph, next) }
    },
  }
  rememberSidecar(graph, sidecar)
  rememberSidecar(proxy, sidecar)
  return proxy
}

function remapSidecarAfterMutation(sidecar: DenoSidecar, result: MutateResult): DenoSidecar {
  const replacementByOld = new Map<string, string>()
  for (const record of result.applied) {
    if ((record.kind === 'node-replaced' || record.kind === 'peer-context-replaced') && record.previous !== undefined) {
      replacementByOld.set(record.previous, record.subject)
    }
  }

  const directBumps: Array<{ from: DenoNpmPackageId; toVersion: string }> = []
  for (const [oldNodeId, nativeId] of sidecar.nativeByNode) {
    const nextNodeId = replacementByOld.get(oldNodeId)
    if (nextNodeId === undefined) continue
    const nextNode = result.graph.getNode(nextNodeId)
    const parsed = sidecar.parsedByNative.get(nativeId)
    if (
      nextNode !== undefined
      && parsed !== undefined
      && nextNode.name === parsed.name
      && nextNode.version !== parsed.version
    ) {
      directBumps.push({ from: parsed, toVersion: nextNode.version })
    }
  }

  const nativeByNode = new Map<string, string>()
  const nodeByNative = new Map<string, string>()
  const parsedByNative = new Map<string, DenoNpmPackageId>()
  const bumpedFromNative = new Map(sidecar.bumpedFromNative)
  const dirtyNative = new Set<string>()
  const unrepresentable = [...sidecar.unrepresentable]
  for (const [oldNodeId, nativeId] of sidecar.nativeByNode) {
    const nextNodeId = replacementByOld.get(oldNodeId) ?? oldNodeId
    const nextNode = result.graph.getNode(nextNodeId)
    if (nextNode === undefined) continue
    const oldParsed = sidecar.parsedByNative.get(nativeId)
    if (oldParsed === undefined) continue
    if (nextNode.name !== oldParsed.name) {
      unrepresentable.push(`renamed native npm identity ${nativeId} to ${nextNodeId}`)
      continue
    }
    const rewritten = rewriteNativePackageId(oldParsed, directBumps)
    const nextNativeId = serializeNativePackageId(rewritten)
    if (nextNode.version !== rewritten.version) {
      unrepresentable.push(`native npm identity ${nativeId} cannot prove version ${nextNode.version}`)
      continue
    }
    const sourceNativeId = sidecar.bumpedFromNative.get(nativeId) ?? nativeId
    if (nextNativeId !== nativeId) {
      bumpedFromNative.delete(nativeId)
      bumpedFromNative.set(nextNativeId, sourceNativeId)
      dirtyNative.add(nextNativeId)
    } else if (sidecar.dirtyNative.has(nativeId)) {
      dirtyNative.add(nextNativeId)
    }
    if (nodeByNative.has(nextNativeId)) {
      unrepresentable.push(`native npm identity collision at ${nextNativeId}`)
      continue
    }
    nativeByNode.set(nextNodeId, nextNativeId)
    nodeByNative.set(nextNativeId, nextNodeId)
    parsedByNative.set(nextNativeId, rewritten)
  }

  for (const node of result.graph.nodes()) {
    if (node.workspacePath !== undefined || nativeByNode.has(node.id)) continue
    if (node.peerContext.length > 0 || node.patch !== undefined || node.source !== undefined) {
      unrepresentable.push(`added npm node ${node.id} without proved native Deno identity`)
      continue
    }
    const nativeId = `${node.name}@${node.version}`
    if (nodeByNative.has(nativeId)) {
      unrepresentable.push(`added npm node ${node.id} collides at native identity ${nativeId}`)
      continue
    }
    nativeByNode.set(node.id, nativeId)
    nodeByNative.set(nativeId, node.id)
    parsedByNative.set(nativeId, parseNpmPackageId(nativeId))
    dirtyNative.add(nativeId)
  }

  for (const record of result.applied) {
    if (record.kind === 'edge-added' || record.kind === 'edge-removed') {
      const nativeId = nativeByNode.get(record.subject.src)
      if (nativeId !== undefined) dirtyNative.add(nativeId)
    } else if (record.kind === 'tarball-set' || record.kind === 'tarball-removed') {
      for (const [nodeId, nativeId] of nativeByNode) {
        const node = result.graph.getNode(nodeId)
        if (node !== undefined && `${node.name}@${node.version}` === record.subject) {
          dirtyNative.add(nativeId)
        }
      }
    }
  }

  return {
    ...sidecar,
    nativeByNode,
    nodeByNative,
    parsedByNative,
    bumpedFromNative,
    dirtyNative,
    exactReplay: sidecar.exactReplay && result.applied.length === 0,
    unrepresentable: [...new Set(unrepresentable)].sort(),
  }
}

function rewriteNativePackageId(
  id: DenoNpmPackageId,
  bumps: readonly { from: DenoNpmPackageId; toVersion: string }[],
): DenoNpmPackageId {
  const matching = bumps.find(bump => sameNativeTree(id, bump.from))
  const peers = id.peers.map(peer => rewriteNativePackageId(peer, bumps))
  return {
    ...id,
    version: matching?.toVersion ?? id.version,
    peers,
  }
}

// === NATIVE NPM ID GRAMMAR ==================================================
// The raw peer suffix is authoritative on emit; parsed peer semantics are
// one-way, discardable evidence.

function sameNativeTree(a: DenoNpmPackageId, b: DenoNpmPackageId): boolean {
  return a.name === b.name
    && a.version === b.version
    && a.peers.length === b.peers.length
    && a.peers.every((peer, index) => sameNativeTree(peer, b.peers[index]!))
}

function parseNpmPackageId(raw: string): DenoNpmPackageId {
  const parsed = parseNpmPackageIdAt(raw, 0, 0)
  if (parsed.offset !== raw.length) {
    throw failure(`deno adapter: invalid npm package id ${JSON.stringify(raw)}`)
  }
  return parsed.id
}

function parseNpmPackageIdAt(
  raw: string,
  offset: number,
  level: number,
): { id: DenoNpmPackageId; offset: number } {
  const start = offset
  let at = -1
  for (let i = offset; i < raw.length; i++) {
    if (i > offset && raw[i] === '@') {
      at = i
      break
    }
  }
  if (at < 0) throw failure(`deno adapter: invalid npm package id ${JSON.stringify(raw)}`)
  let end = at + 1
  while (end < raw.length && raw[end] !== '_') end++
  const encodedName = raw.slice(offset, at)
  const version = raw.slice(at + 1, end)
  if (encodedName === '' || version === '') {
    throw failure(`deno adapter: invalid npm package id ${JSON.stringify(raw)}`)
  }
  const peers: DenoNpmPackageId[] = []
  offset = end
  while (offset < raw.length) {
    let underscores = 0
    while (raw[offset + underscores] === '_') underscores++
    if (underscores !== level + 1) break
    const peer = parseNpmPackageIdAt(raw, offset + underscores, level + 1)
    peers.push(peer.id)
    offset = peer.offset
  }
  const name = level === 0 ? encodedName : encodedName.replaceAll('+', '/')
  const baseEnd = end
  return {
    id: {
      name,
      version,
      peers,
      raw: raw.slice(start, offset),
      rawSuffix: raw.slice(baseEnd, offset),
    },
    offset,
  }
}

function canonicalNodeId(id: DenoNpmPackageId): string {
  return serializeNodeId(id.name, id.version, canonicalPeerContext(id))
}

function canonicalPeerContext(
  id: DenoNpmPackageId,
  forceDiscriminator = false,
  isEdgeBearing: (peer: DenoNpmPackageId) => boolean = () => true,
): string[] {
  const peerByBase = new Map<string, string>()
  let lostDuplicate = false
  for (const peer of id.peers) {
    if (!isEdgeBearing(peer)) {
      lostDuplicate = true
      continue
    }
    const base = serializeNodeId(peer.name, peer.version, [])
    if (peerByBase.has(base)) {
      lostDuplicate = true
      continue
    }
    peerByBase.set(base, canonicalNodeId(peer))
  }
  const peers = [...peerByBase.values()]
  if ((lostDuplicate || forceDiscriminator) && id.rawSuffix !== '') {
    peers.push(createHash('sha256').update(id.rawSuffix).digest('hex'))
  }
  return peers.sort(compareStrings)
}

function serializeNativePackageId(id: DenoNpmPackageId, level = 0): string {
  const name = level === 0 ? id.name : id.name.replaceAll('/', '+')
  let value = `${name}@${id.version}`
  for (const peer of id.peers) {
    value += '_'.repeat(level + 1) + serializeNativePackageId(peer, level + 1)
  }
  return value
}

function defaultNpmTarballUrl(name: string, version: string): string {
  const scope = name.startsWith('@') ? name.slice(0, name.indexOf('/')) : undefined
  const unscoped = scope === undefined ? name : name.slice(scope.length).replace(/^\/+/, '')
  return `https://registry.npmjs.org/${name}/-/${unscoped}-${version}.tgz`
}

// === VALIDATION AND STRUCTURAL GUARDS =======================================

// A jsr entry with NO `integrity` key is a different fact from one whose value is
// malformed, and the two must not share a message — reporting absence as
// malformation sends the reader looking for a corrupt digest that is not there.
// Absence is nonetheless a REFUSAL, not a tolerable gap. It is the opposite of the
// v5 patched-npm `{}` case: there deno's own printer declares the field optional and
// deno reads the file back, whereas here every deno that can open the document
// rejects it — 1.44.4 (contemporary with these v3 files) with "Unable to parse
// contents of lockfile: missing field `integrity`", and 2.9.4 with "Invalid jsr
// section: missing field `integrity`". Eight entries across two corpus files, all
// v3 and all from the first weeks of `jsr:` support, are orphans of a producer whose
// output its successors will not read. Accepting them would let us mint a graph no
// deno can install from.
// v4 narrowed the specifier VALUE from v3's `npm:<name>@<version>` locator to a bare
// `<version>`; the native id is rebuilt as `<name>@<value>`. Real v4 files carry the
// v3 value shape anyway — when they do it is EVERY specifier in the file, jsr
// included — so the rebuild yields `<name>@npm:<name>@<version>`. That is not a
// lookup being fumbled here: deno builds the very same id and rejects it ("Invalid
// npm package id '@types/node@npm:@types/node@18.16.19'. Invalid npm version."), so
// the document is unreadable by its own producer. Fail closed naming the cause,
// rather than reporting a missing package and inviting the reader to "fix" a lookup
// that is not wrong — the value is.
//
// This is a document property, so it is validated once at parse, where PARSE_FAILED
// is the honest code. `nativeIdFromSpecifier` is shared with the convert path and
// stays a pure function; keeping the guard there would have let an emit surface a
// parse diagnostic.
function validateSpecifierValueShape(layout: DenoLayout): void {
  if (layout.version === '2' || layout.version === '3') return
  for (const [request, resolved] of Object.entries(layout.specifiers)) {
    if (!request.startsWith('npm:') || !resolved.startsWith('npm:')) continue
    // Same target-name derivation `nativeIdFromSpecifier` uses, so the id named here
    // is the one that would have been built — including the aliased
    // `npm:<alias>@npm:<target>@<range>` request shape.
    const requestBody = request.slice('npm:'.length)
    const requestParts = splitNameAndTail(requestBody)
    const alias = requestParts?.name ?? requestBody
    const name = requestParts?.tail.startsWith('npm:')
      ? splitNameAndTail(requestParts.tail.slice('npm:'.length))?.name ?? alias
      : alias
    throw failure(
      `deno adapter: specifier ${request} resolves to ${resolved}, a lockfile-v3 locator; `
        + `v${layout.version} specifiers carry a bare version, so this yields the invalid npm `
        + `package id ${name}@${resolved} that deno itself refuses`,
    )
  }
}

function validateNonNpmIntegrity(layout: DenoLayout): void {
  for (const [name, value] of Object.entries(layout.jsr)) {
    if (isObject(value) && value.integrity === undefined) {
      throw failure(
        `deno adapter: jsr ${name} has no integrity field; deno itself refuses such a `
          + `lockfile with "missing field \`integrity\`"`,
      )
    }
    if (!isObject(value) || typeof value.integrity !== 'string' || !/^[0-9a-f]{64}$/.test(value.integrity)) {
      throw failure(`deno adapter: jsr ${name} integrity must be lowercase SHA-256 hex`)
    }
  }
  for (const [url, value] of Object.entries(layout.remote)) {
    if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
      throw failure(`deno adapter: remote ${url} integrity must be lowercase SHA-256 hex`)
    }
  }
}

function hasConflictMarkers(input: string): boolean {
  return /^(?:<{7}|\|{7}|={7}|>{7})(?: .*)?$/m.test(input)
}

function splitNameAndTail(value: string): { name: string; tail: string } | undefined {
  for (let i = 1; i < value.length; i++) {
    if (value[i] === '@') return { name: value.slice(0, i), tail: value.slice(i + 1) }
  }
  return undefined
}

function npmRecord(value: unknown): Record<string, DenoNpmPackageEntry> {
  const object = optionalObject(value, 'npm')
  for (const [key, entry] of Object.entries(object)) {
    if (!isObject(entry)) throw failure(`deno adapter: npm.${key} must be an object`)
  }
  return object as Record<string, DenoNpmPackageEntry>
}

function stringRecord(value: unknown, path: string): Record<string, string> {
  const object = optionalObject(value, path)
  for (const [key, entry] of Object.entries(object)) {
    if (typeof entry !== 'string') throw failure(`deno adapter: ${path}.${key} must be a string`)
  }
  return object as Record<string, string>
}

function requiredObject(value: unknown, path: string): JsonObject {
  if (!isObject(value)) throw failure(`deno adapter: ${path} must be an object`)
  return value
}

function optionalObject(value: unknown, path: string): JsonObject {
  if (value === undefined) return {}
  return requiredObject(value, path)
}

function validateStringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) {
    throw failure(`deno adapter: ${path} must be a string array`)
  }
  return [...value]
}

// === HELPERS ================================================================

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function failure(message: string): LockfileError {
  return new LockfileError({ code: 'PARSE_FAILED', message })
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function compareEntries(a: readonly [string, unknown], b: readonly [string, unknown]): number {
  return compareStrings(a[0], b[0])
}
