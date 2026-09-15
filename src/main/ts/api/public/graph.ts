import type {
  Diagnostic as InternalDiagnostic,
  Edge as InternalEdge,
  EdgeAttributes as InternalEdgeAttributes,
  EdgeKind,
  Graph as InternalGraph,
  GraphChange as InternalGraphChange,
  GraphMutation as InternalGraphMutation,
  Integrity as InternalIntegrity,
  Manifest as InternalManifest,
  Node as InternalNode,
  OverrideConstraint as InternalOverrideConstraint,
  OverrideManager,
  Patch,
  SourceDiscriminator,
  TarballPayload as InternalTarballPayload,
  WorkspaceRange as InternalWorkspaceRange,
} from '../../graph.ts'
import type { ResolutionCanonical } from '../../recipe/resolution.ts'
import {
  internalDiagnostic,
  publicDiagnostic,
  publicEdgeTriple,
  type Diagnostic,
} from './diagnostics.ts'

export type { EdgeKind, OverrideManager, Patch, SourceDiscriminator }
export type NodeId = string
export type TarballKey = string

export interface Node {
  readonly id: NodeId
  readonly name: string
  readonly version: string
  readonly peerContext: readonly NodeId[]
  readonly patch?: Patch
  readonly source?: SourceDiscriminator
  readonly workspacePath?: string
}

export type HashOrigin =
  | 'sri'
  | 'berry-zip'
  | 'url-fragment'
  | 'registry'
  | 'recomputed'

export interface IntegrityHash {
  readonly algorithm: string
  readonly digest: string
  readonly origin: HashOrigin
}

export interface Integrity {
  readonly hashes: readonly IntegrityHash[]
}

export type HostingProvider = 'github' | 'gitlab' | 'bitbucket'

export type Resolution =
  | Readonly<{ kind: 'registry'; bind?: string }>
  | Readonly<{
      kind: 'tarball'
      url: string
      hostingProvider?: HostingProvider
      bind?: string
    }>
  | Readonly<{
      kind: 'git'
      url: string
      sha: string
      hostingProvider?: HostingProvider
    }>
  | Readonly<{ kind: 'directory'; path: string }>
  | Readonly<{ kind: 'unknown'; raw: string }>

export interface TarballKeyInput {
  readonly name: string
  readonly version: string
  readonly patch?: Patch
  readonly source?: SourceDiscriminator
}

export interface TarballPayload {
  readonly integrity?: Integrity
  readonly berryChecksumCacheKey?: string
  readonly engines?: Readonly<Record<string, string>>
  readonly funding?: unknown
  readonly license?: string
  readonly bin?: string | Readonly<Record<string, string>>
  readonly deprecated?: string
  readonly cpu?: readonly string[]
  readonly os?: readonly string[]
  readonly libc?: readonly string[]
  readonly hasInstallScript?: boolean
  readonly bundledDependencies?: readonly string[]
  readonly peerDependencies?: Readonly<Record<string, string>>
  readonly peerDependenciesMeta?: Readonly<
    Record<string, Readonly<{ optional?: boolean }>>
  >
  readonly resolution?: Resolution
  readonly nativeResolution?: string
}

export interface WorkspaceRange {
  readonly protocol: 'workspace'
  readonly selector: string
}

export interface EdgeAttributes {
  readonly range?: string
  readonly overrideRange?: string
  readonly optional?: boolean
  readonly workspace?: boolean
  readonly alias?: string
  readonly workspaceRange?: WorkspaceRange
}

export interface Edge {
  readonly source: NodeId
  readonly target: NodeId
  readonly kind: EdgeKind
  readonly attributes?: EdgeAttributes
}

export interface EdgeTriple {
  readonly source: NodeId
  readonly target: NodeId
  readonly kind: EdgeKind
}

export interface LayoutHints {
  readonly strategy?: 'isolated' | 'hoisted' | 'pnp' | 'nm-linked'
}

export interface Manifest {
  readonly name?: string
  readonly version?: string
  readonly dependencies?: Readonly<Record<string, string>>
  readonly devDependencies?: Readonly<Record<string, string>>
  readonly optionalDependencies?: Readonly<Record<string, string>>
  readonly peerDependencies?: Readonly<Record<string, string>>
  readonly workspaces?: readonly string[]
  readonly overrides?: readonly OverrideConstraint[]
  readonly native?: Readonly<{
    npmOverrides?: unknown
    yarnResolutions?: Readonly<Record<string, string>>
    pnpmOverrides?: Readonly<Record<string, string>>
  }>
}

export interface OverrideConstraint {
  readonly name: string
  readonly parentPath?: readonly string[]
  readonly versionCondition?: string
  readonly to: string
  readonly selfRef?: boolean
  readonly origin?: OverrideManager
  readonly captureIndex?: number
}

export interface GraphWalkOptions {
  readonly direction?: 'out' | 'in'
  readonly kinds?: readonly EdgeKind[]
  readonly maxDepth?: number
}

export interface GraphDiff {
  readonly addedNodes: readonly NodeId[]
  readonly removedNodes: readonly NodeId[]
  readonly changedNodes: readonly NodeId[]
  readonly addedEdges: readonly EdgeTriple[]
  readonly removedEdges: readonly EdgeTriple[]
}

export type GraphChange =
  | Readonly<{ kind: 'node-added'; subject: NodeId }>
  | Readonly<{ kind: 'node-removed'; subject: NodeId }>
  | Readonly<{ kind: 'node-replaced'; subject: NodeId; previous?: NodeId }>
  | Readonly<{ kind: 'edge-added'; subject: EdgeTriple }>
  | Readonly<{ kind: 'edge-removed'; subject: EdgeTriple }>
  | Readonly<{ kind: 'peer-context-replaced'; subject: NodeId; previous?: NodeId }>
  | Readonly<{ kind: 'tarball-set'; subject: TarballKey }>
  | Readonly<{ kind: 'tarball-removed'; subject: TarballKey }>

export interface GraphMutation {
  replaceNode(id: NodeId, replacement: Node): void
  addNode(node: Node): void
  removeNode(id: NodeId): void
  addEdge(
    source: NodeId,
    target: NodeId,
    kind: EdgeKind,
    attributes?: EdgeAttributes,
  ): void
  removeEdge(source: NodeId, target: NodeId, kind: EdgeKind): void
  replacePeerContext(id: NodeId, peers: readonly NodeId[]): void
  setTarball(key: TarballKeyInput, payload: TarballPayload): void
  removeTarball(key: TarballKeyInput): void
  addDiagnostic(diagnostic: Diagnostic): void
}

export interface GraphMutationResult {
  readonly graph: Graph
  readonly diagnostics: readonly Diagnostic[]
  readonly applied: readonly GraphChange[]
}

export interface Graph {
  getNode(id: NodeId): Node | undefined
  nodes(): IterableIterator<Node>
  byName(name: string): readonly NodeId[]
  roots(): ReadonlySet<NodeId>
  out(id: NodeId, kind?: EdgeKind): readonly Edge[]
  in(id: NodeId, kind?: EdgeKind): readonly Edge[]
  walk(seeds: NodeId | readonly NodeId[], options?: GraphWalkOptions): IterableIterator<NodeId>
  topoSort(): readonly (readonly NodeId[])[]
  subgraph(seeds: NodeId | readonly NodeId[], options?: GraphWalkOptions): Graph
  diff(other: Graph): GraphDiff
  tarball(key: TarballKeyInput): TarballPayload | undefined
  tarballOf(node: NodeId): TarballPayload | undefined
  tarballs(): IterableIterator<readonly [TarballKey, TarballPayload]>
  overrides(): readonly OverrideConstraint[]
  governingOverride(
    name: string,
    consumerPath: readonly string[],
    declaredRange?: string,
  ): OverrideConstraint | undefined
  registryPackages(): Readonly<Record<string, readonly string[]>>
  diagnostics(): readonly Diagnostic[]
  layoutHints(): LayoutHints | undefined
  mutate(transaction: (mutation: GraphMutation) => void): GraphMutationResult
}

const publicToInternal = new WeakMap<Graph, InternalGraph>()
const internalToPublic = new WeakMap<InternalGraph, Graph>()

/** @internal Distinguishes the stable caller view from a core graph. */
export function isPublicGraph(value: unknown): value is Graph {
  return value !== null
    && typeof value === 'object'
    && publicToInternal.has(value as Graph)
}

function publicNode(node: InternalNode): Node {
  return Object.freeze({ ...node, peerContext: Object.freeze([...node.peerContext]) })
}

function internalNode(node: Node): InternalNode {
  return { ...node, peerContext: [...node.peerContext] }
}

function publicWorkspaceRange(value: InternalWorkspaceRange): WorkspaceRange {
  return Object.freeze({
    protocol: 'workspace',
    selector: value.specifier.startsWith('workspace:')
      ? value.specifier.slice('workspace:'.length)
      : value.specifier,
  })
}

function publicAttributes(value: InternalEdgeAttributes): EdgeAttributes {
  const { workspaceRange, ...attributes } = value
  return Object.freeze({
    ...attributes,
    ...(workspaceRange === undefined
      ? {}
      : { workspaceRange: publicWorkspaceRange(workspaceRange) }),
  })
}

function internalAttributes(value: EdgeAttributes): InternalEdgeAttributes {
  const { workspaceRange, ...attributes } = value
  return {
    ...attributes,
    ...(workspaceRange === undefined
      ? {}
      : { workspaceRange: { specifier: `workspace:${workspaceRange.selector}` } }),
  }
}

function publicEdge(value: InternalEdge): Edge {
  return Object.freeze({
    source: value.src,
    target: value.dst,
    kind: value.kind,
    ...(value.attrs === undefined ? {} : { attributes: publicAttributes(value.attrs) }),
  })
}

function publicResolution(value: ResolutionCanonical): Resolution {
  const { type, ...rest } = value
  return Object.freeze({ kind: type, ...rest }) as Resolution
}

function internalResolution(value: Resolution): ResolutionCanonical {
  const { kind, ...rest } = value
  return { type: kind, ...rest } as ResolutionCanonical
}

function publicIntegrity(value: InternalIntegrity): Integrity {
  return Object.freeze({
    hashes: Object.freeze(value.hashes.map(hash => Object.freeze({ ...hash }))),
  })
}

function internalIntegrity(value: Integrity): InternalIntegrity {
  return { hashes: value.hashes.map(hash => ({ ...hash })) }
}

function publicPayload(value: InternalTarballPayload): TarballPayload {
  const {
    integrity,
    resolution,
    engines,
    bin,
    cpu,
    os,
    libc,
    bundledDependencies,
    peerDependencies,
    peerDependenciesMeta,
    ...payload
  } = value
  return Object.freeze({
    ...payload,
    ...(integrity === undefined ? {} : { integrity: publicIntegrity(integrity) }),
    ...(resolution === undefined ? {} : { resolution: publicResolution(resolution) }),
    ...(engines === undefined ? {} : { engines: Object.freeze({ ...engines }) }),
    ...(bin === undefined ? {} : {
      bin: typeof bin === 'string' ? bin : Object.freeze({ ...bin }),
    }),
    ...(cpu === undefined ? {} : { cpu: Object.freeze([...cpu]) }),
    ...(os === undefined ? {} : { os: Object.freeze([...os]) }),
    ...(libc === undefined ? {} : { libc: Object.freeze([...libc]) }),
    ...(bundledDependencies === undefined
      ? {}
      : { bundledDependencies: Object.freeze([...bundledDependencies]) }),
    ...(peerDependencies === undefined
      ? {}
      : { peerDependencies: Object.freeze({ ...peerDependencies }) }),
    ...(peerDependenciesMeta === undefined
      ? {}
      : {
          peerDependenciesMeta: Object.freeze(Object.fromEntries(
            Object.entries(peerDependenciesMeta).map(([name, metadata]) => [
              name,
              Object.freeze({ ...metadata }),
            ]),
          )),
        }),
  })
}

function internalPayload(value: TarballPayload): InternalTarballPayload {
  const {
    integrity,
    resolution,
    engines,
    bin,
    cpu,
    os,
    libc,
    bundledDependencies,
    peerDependencies,
    peerDependenciesMeta,
    ...payload
  } = value
  return {
    ...payload,
    ...(integrity === undefined ? {} : { integrity: internalIntegrity(integrity) }),
    ...(resolution === undefined ? {} : { resolution: internalResolution(resolution) }),
    ...(engines === undefined ? {} : { engines: { ...engines } }),
    ...(bin === undefined ? {} : { bin: typeof bin === 'string' ? bin : { ...bin } }),
    ...(cpu === undefined ? {} : { cpu: [...cpu] }),
    ...(os === undefined ? {} : { os: [...os] }),
    ...(libc === undefined ? {} : { libc: [...libc] }),
    ...(bundledDependencies === undefined
      ? {}
      : { bundledDependencies: [...bundledDependencies] }),
    ...(peerDependencies === undefined
      ? {}
      : { peerDependencies: { ...peerDependencies } }),
    ...(peerDependenciesMeta === undefined
      ? {}
      : {
          peerDependenciesMeta: Object.fromEntries(
            Object.entries(peerDependenciesMeta).map(([name, metadata]) => [
              name,
              { ...metadata },
            ]),
          ),
        }),
  }
}

export function publicOverride(value: InternalOverrideConstraint): OverrideConstraint {
  const { package: name, ...rest } = value
  return Object.freeze({
    name,
    ...rest,
    ...(value.parentPath === undefined ? {} : { parentPath: Object.freeze([...value.parentPath]) }),
  })
}

export function internalOverride(value: OverrideConstraint): InternalOverrideConstraint {
  const { name: packageName, parentPath, ...rest } = value
  return {
    package: packageName,
    ...rest,
    ...(parentPath === undefined ? {} : { parentPath: [...parentPath] }),
  }
}

export function publicGraphChange(value: InternalGraphChange): GraphChange {
  if ((value.kind === 'edge-added' || value.kind === 'edge-removed')) {
    return Object.freeze({ ...value, subject: publicEdgeTriple(value.subject) })
  }
  return Object.freeze({ ...value }) as GraphChange
}

function publicMutation(value: InternalGraphMutation): GraphMutation {
  return Object.freeze({
    replaceNode: (id: NodeId, replacement: Node) => value.replaceNode(id, internalNode(replacement)),
    addNode: (node: Node) => value.addNode(internalNode(node)),
    removeNode: (id: NodeId) => value.removeNode(id),
    addEdge: (
      source: NodeId,
      target: NodeId,
      kind: EdgeKind,
      attributes?: EdgeAttributes,
    ) => value.addEdge(
      source,
      target,
      kind,
      ...(attributes === undefined ? [] : [internalAttributes(attributes)]),
    ),
    removeEdge: (source: NodeId, target: NodeId, kind: EdgeKind) =>
      value.removeEdge(source, target, kind),
    replacePeerContext: (id: NodeId, peers: readonly NodeId[]) =>
      value.replacePeerContext(id, [...peers]),
    setTarball: (key: TarballKeyInput, payload: TarballPayload) =>
      value.setTarball({ ...key }, internalPayload(payload)),
    removeTarball: (key: TarballKeyInput) => value.removeTarball({ ...key }),
    addDiagnostic: (diagnostic: Diagnostic) => value.addDiagnostic(internalDiagnostic(diagnostic)),
  })
}

function readonlyRecord(
  value: Readonly<Record<string, readonly string[]>>,
): Readonly<Record<string, readonly string[]>> {
  return Object.freeze(Object.fromEntries(Object.entries(value).map(([name, versions]) => [
    name,
    Object.freeze([...versions]),
  ])))
}

function publicManifest(value: InternalManifest): Manifest {
  const { overrides, workspaces, native, ...manifest } = value
  return Object.freeze({
    ...manifest,
    ...(workspaces === undefined ? {} : { workspaces: Object.freeze([...workspaces]) }),
    ...(overrides === undefined
      ? {}
      : { overrides: Object.freeze(overrides.map(publicOverride)) }),
    ...(native === undefined ? {} : { native: Object.freeze({ ...native }) }),
  })
}

/** @internal Converts the public library-owned graph back to its core authority. */
export function internalGraph(value: Graph | InternalGraph): InternalGraph {
  return publicToInternal.get(value as Graph) ?? value as InternalGraph
}

/** @internal Converts a core graph to the stable 0.6 caller view. */
export function publicGraph(value: InternalGraph): Graph {
  const existing = internalToPublic.get(value)
  if (existing !== undefined) return existing
  const graph: Graph = Object.freeze({
    getNode(id: NodeId) {
      const node = value.getNode(id)
      return node === undefined ? undefined : publicNode(node)
    },
    *nodes() {
      for (const node of value.nodes()) yield publicNode(node)
    },
    byName: (name: string) => Object.freeze([...value.byName(name)]),
    roots: () => Object.freeze(new Set(value.roots())),
    out: (id: NodeId, kind?: EdgeKind) =>
      Object.freeze(value.out(id, kind).map(publicEdge)),
    in: (id: NodeId, kind?: EdgeKind) =>
      Object.freeze(value.in(id, kind).map(publicEdge)),
    walk: (seeds: NodeId | readonly NodeId[], options?: GraphWalkOptions) =>
      value.walk(seeds, options),
    topoSort: () => Object.freeze(value.topoSort().map(part => Object.freeze([...part]))),
    subgraph: (seeds: NodeId | readonly NodeId[], options?: GraphWalkOptions) =>
      publicGraph(value.subgraph(seeds, options)),
    diff(other: Graph) {
      const diff = value.diff(internalGraph(other))
      return Object.freeze({
        addedNodes: Object.freeze([...diff.addedNodes]),
        removedNodes: Object.freeze([...diff.removedNodes]),
        changedNodes: Object.freeze([...diff.changedNodes]),
        addedEdges: Object.freeze(diff.addedEdges.map(publicEdgeTriple)),
        removedEdges: Object.freeze(diff.removedEdges.map(publicEdgeTriple)),
      })
    },
    tarball(key: TarballKeyInput) {
      const payload = value.tarball({ ...key })
      return payload === undefined ? undefined : publicPayload(payload)
    },
    tarballOf(node: NodeId) {
      const payload = value.tarballOf(node)
      return payload === undefined ? undefined : publicPayload(payload)
    },
    *tarballs() {
      for (const [key, payload] of value.tarballs()) {
        yield Object.freeze([key, publicPayload(payload)] as const)
      }
    },
    overrides: () => Object.freeze(value.overrides().map(publicOverride)),
    governingOverride(name: string, consumerPath: readonly string[], declaredRange?: string) {
      const constraint = value.governingOverride(name, consumerPath, declaredRange)
      return constraint === undefined ? undefined : publicOverride(constraint)
    },
    registryPackages: () => readonlyRecord(value.registryPackages()),
    diagnostics: () => Object.freeze(value.diagnostics().map(publicDiagnostic)),
    layoutHints() {
      const hints = value.layoutHints()
      return hints === undefined ? undefined : Object.freeze({ ...hints })
    },
    mutate(transaction: (mutation: GraphMutation) => void) {
      const result = value.mutate(mutation => transaction(publicMutation(mutation)))
      return Object.freeze({
        graph: publicGraph(result.graph),
        diagnostics: Object.freeze(result.diagnostics.map(publicDiagnostic)),
        applied: Object.freeze(result.applied.map(publicGraphChange)),
      })
    },
  })
  publicToInternal.set(graph, value)
  internalToPublic.set(value, graph)
  return graph
}

/** @internal Converts public manifests at structured-source boundaries. */
export function internalManifest(value: Manifest): InternalManifest {
  const { overrides, workspaces, native, ...manifest } = value
  return {
    ...manifest,
    ...(workspaces === undefined ? {} : { workspaces: [...workspaces] }),
    ...(overrides === undefined
      ? {}
      : { overrides: overrides.map(internalOverride) }),
    ...(native === undefined ? {} : {
      native: {
        ...native,
        ...(native.yarnResolutions === undefined
          ? {}
          : { yarnResolutions: { ...native.yarnResolutions } }),
        ...(native.pnpmOverrides === undefined
          ? {}
          : { pnpmOverrides: { ...native.pnpmOverrides } }),
      },
    }),
  }
}

/** @internal Converts legacy core diagnostics in public operation results. */
export function publicDiagnostics(values: readonly InternalDiagnostic[]): readonly Diagnostic[] {
  return Object.freeze(values.map(publicDiagnostic))
}
