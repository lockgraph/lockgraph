import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { newBuilder, type Diagnostic, type Graph } from '../../main/ts/graph.ts'
import { enrich as enrichClassic, parse as parseClassic, stringify as stringifyClassic, type YarnClassicManifest } from '../../main/ts/formats/yarn-classic.ts'
import { rawConditionsBlockOfNode } from '../../main/ts/formats/_yarn-berry-core.ts'
import { parse as parseSyml, type SymlMap } from '../../main/ts/formats/_yarn-syml.ts'
import { parse as parseV4, stringify as stringifyV4 } from '../../main/ts/formats/yarn-berry-v4.ts'
import { parse as parseV5, stringify as stringifyV5 } from '../../main/ts/formats/yarn-berry-v5.ts'
import { parse as parseV6, stringify as stringifyV6 } from '../../main/ts/formats/yarn-berry-v6.ts'
import { parse as parseV8, stringify as stringifyV8 } from '../../main/ts/formats/yarn-berry-v8.ts'
import { parse as parseV9, stringify as stringifyV9 } from '../../main/ts/formats/yarn-berry-v9.ts'
import { graphSubset } from './_helpers.ts'
import type { AdditionEntry, ConversionContract, FormatId, LossEntry, PassthroughEntry } from './_matrix.ts'

const here = dirname(fileURLToPath(import.meta.url))

export const WORKSPACE_MANIFESTS: Record<string, YarnClassicManifest> = {
  '': {
    name: 'case-workspaces-basic',
    version: '0.0.0',
    dependencies: { '@case-ws/a': 'workspace:*' },
    devDependencies: { '@case-ws/b': 'workspace:^' },
    optionalDependencies: { ms: '2.1.3' },
  },
  'packages/a': {
    name: '@case-ws/a',
    version: '1.0.0',
    dependencies: { ms: '2.1.3' },
  },
  'packages/b': {
    name: '@case-ws/b',
    version: '1.1.0',
    dependencies: { ms: '2.1.3' },
  },
}

export const CLASSIC_SHARED_FIXTURES = [
  'deps-with-scopes',
  'git-github-tarball',
  'peers-basic',
  'peers-multi',
  'simple',
  'workspaces-basic',
  'yarn-crlf',
] as const

type StringifyOptions = {
  cacheKey?: string
  lineEnding?: 'lf' | 'crlf'
}

type ObservationContext = {
  sourceGraph: Graph
  destinationGraph: Graph
  sourceLockfile?: string
  destinationLockfile?: string
  mode: 'naive' | 'enrich-aware'
  manifestsProvided?: boolean
}

export function fixtureLockfile(fixtureName: string, format: FormatId): string {
  return readFileSync(
    resolve(here, '../resources/fixtures/lockfiles', fixtureName, `${format}.lock`),
    'utf8',
  )
}

export function parseFormat(format: FormatId, lockfile: string): Graph {
  switch (format) {
    case 'yarn-berry-v4':
      return parseV4(lockfile)
    case 'yarn-berry-v5':
      return parseV5(lockfile)
    case 'yarn-berry-v6':
      return parseV6(lockfile)
    case 'yarn-berry-v8':
      return parseV8(lockfile)
    case 'yarn-berry-v9':
      return parseV9(lockfile)
    case 'yarn-classic':
      return parseClassic(lockfile)
    default:
      throw new Error(`parseFormat: unsupported format ${format}`)
  }
}

export function stringifyFormat(
  format: FormatId,
  graph: Graph,
  options: StringifyOptions = {},
): { lockfile: string; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = []
  switch (format) {
    case 'yarn-berry-v4':
      return {
        lockfile: stringifyV4(graph, {
          cacheKey: options.cacheKey,
          lineEnding: options.lineEnding,
          onDiagnostic(diagnostic) {
            diagnostics.push(diagnostic)
          },
        }),
        diagnostics,
      }
    case 'yarn-berry-v5':
      return {
        lockfile: stringifyV5(graph, {
          cacheKey: options.cacheKey,
          lineEnding: options.lineEnding,
          onDiagnostic(diagnostic) {
            diagnostics.push(diagnostic)
          },
        }),
        diagnostics,
      }
    case 'yarn-berry-v6':
      return {
        lockfile: stringifyV6(graph, {
          cacheKey: options.cacheKey,
          lineEnding: options.lineEnding,
          onDiagnostic(diagnostic) {
            diagnostics.push(diagnostic)
          },
        }),
        diagnostics,
      }
    case 'yarn-berry-v8':
      return {
        lockfile: stringifyV8(graph, {
          cacheKey: options.cacheKey,
          lineEnding: options.lineEnding,
          onDiagnostic(diagnostic) {
            diagnostics.push(diagnostic)
          },
        }),
        diagnostics,
      }
    case 'yarn-berry-v9':
      return {
        lockfile: stringifyV9(graph, {
          cacheKey: options.cacheKey,
          lineEnding: options.lineEnding,
          onDiagnostic(diagnostic) {
            diagnostics.push(diagnostic)
          },
        }),
        diagnostics,
      }
    case 'yarn-classic':
      return {
        lockfile: stringifyClassic(graph, {
          lineEnding: options.lineEnding,
          onDiagnostic(diagnostic) {
            diagnostics.push(diagnostic)
          },
        }),
        diagnostics,
      }
    default:
      throw new Error(`stringifyFormat: unsupported format ${format}`)
  }
}

export function defaultBerryCacheKey(format: Extract<FormatId, `yarn-berry-${string}`>): string {
  switch (format) {
    case 'yarn-berry-v4':
      return '7'
    case 'yarn-berry-v5':
    case 'yarn-berry-v6':
      return '8'
    case 'yarn-berry-v8':
    case 'yarn-berry-v9':
      return '10c0'
  }
}

export function classicFixtureAsBerrySource(
  fixtureName: (typeof CLASSIC_SHARED_FIXTURES)[number],
  format: Extract<FormatId, `yarn-berry-${string}`>,
): { lockfile: string; graph: Graph } {
  const sourceGraph = normalizeGraphForBerry(parseClassic(fixtureLockfile(fixtureName, 'yarn-classic')))
  const emitted = stringifyFormat(format, sourceGraph, { cacheKey: defaultBerryCacheKey(format) })
  return {
    lockfile: emitted.lockfile,
    graph: parseFormat(format, emitted.lockfile),
  }
}

export function minimalBerryLockfile(
  format: Extract<FormatId, `yarn-berry-${string}`>,
  options: { conditions?: boolean; compressionLevel?: boolean } = {},
): string {
  const checksum =
    format === 'yarn-berry-v8' || format === 'yarn-berry-v9'
      ? `${defaultBerryCacheKey(format)}/deadbeef`
      : 'deadbeef'
  const compressionLine = options.compressionLevel ? '  compressionLevel: 0\n' : ''
  const conditionsBlock = options.conditions ? '  conditions:\n    os: linux\n' : ''

  return (
    '__metadata:\n' +
    `  version: ${format.slice('yarn-berry-v'.length)}\n` +
    `  cacheKey: ${defaultBerryCacheKey(format)}\n` +
    compressionLine +
    '\n' +
    '"pkg@npm:1.0.0":\n' +
    '  version: 1.0.0\n' +
    '  resolution: "https://registry.yarnpkg.com/pkg/-/pkg-1.0.0.tgz#0000000000000000000000000000000000000000"\n' +
    conditionsBlock +
    `  checksum: ${checksum}\n` +
    '  languageName: node\n' +
    '  linkType: hard\n'
  )
}

export function emptyGraph(): Graph {
  return newBuilder().seal()
}

export function graphSnapshot(graph: Graph) {
  return {
    nodes: Array.from(graph.nodes(), node => ({ ...node })),
    edges: Array.from(graph.nodes(), node =>
      graph.out(node.id).map(edge => ({
        src: edge.src,
        dst: edge.dst,
        kind: edge.kind,
        attrs: edge.attrs === undefined ? undefined : { ...edge.attrs },
      })),
    ).flat(),
    tarballs: Array.from(graph.tarballs(), ([key, payload]) => [key, { ...payload }] as const),
    diagnostics: graph.diagnostics().map(diagnostic => ({ ...diagnostic })),
  }
}

export function enrichClassicGraph(
  graph: Graph,
  mode: 'naive' | 'enrich-aware',
): { graph: Graph; diagnostics: Diagnostic[] } {
  if (mode === 'naive') {
    return enrichClassic(graph)
  }

  return enrichClassic(graph, undefined, { manifests: WORKSPACE_MANIFESTS })
}

export function workspaceFixtureGraph(): Graph {
  return parseFormat('yarn-classic', fixtureLockfile('workspaces-basic', 'yarn-classic')).mutate(m => {
    m.addNode({
      id: '@case-ws/a@0.0.0-use.local',
      name: '@case-ws/a',
      version: '0.0.0-use.local',
      peerContext: [],
    })
    m.addNode({
      id: '@case-ws/b@0.0.0-use.local',
      name: '@case-ws/b',
      version: '0.0.0-use.local',
      peerContext: [],
    })
    m.addEdge('@case-ws/a@0.0.0-use.local', 'ms@2.1.3', 'dep', { range: '2.1.3' })
    m.addEdge('@case-ws/b@0.0.0-use.local', 'ms@2.1.3', 'dep', { range: '2.1.3' })
  }).graph
}

export function normalizeGraphForBerry(graph: Graph): Graph {
  return graph.mutate(m => {
    for (const node of graph.nodes()) {
      for (const edge of graph.out(node.id)) {
        const range = edge.attrs?.range
        if (range === undefined || range.includes(':') || range.startsWith('workspace:')) continue
        m.removeEdge(edge.src, edge.dst, edge.kind)
        m.addEdge(edge.src, edge.dst, edge.kind, { ...edge.attrs, range: `npm:${range}` })
      }
    }
  }).graph
}

export function activeContract(
  contract: ConversionContract,
  context: ObservationContext,
): ConversionContract {
  return {
    ...contract,
    lost: contract.lost.filter(entry => lossObserved(entry, context)),
    added: contract.added.filter(entry =>
      entry.diagnostic !== undefined
      && entry.severity !== undefined
      && additionObserved(entry, context),
    ),
    passthrough: contract.passthrough.filter(entry => passthroughObserved(entry, context)),
  }
}

export function observeInteropDiagnostics(
  contract: ConversionContract,
  context: ObservationContext,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = []

  for (const entry of contract.lost) {
    if (lossObserved(entry, context)) {
      diagnostics.push(toDiagnostic(entry.diagnostic, entry.severity, contract, entry.feature))
    }
  }

  for (const entry of contract.added) {
    if (
      entry.diagnostic !== undefined
      && entry.severity !== undefined
      && additionObserved(entry, context)
    ) {
      diagnostics.push(toDiagnostic(entry.diagnostic, entry.severity, contract, entry.field))
    }
  }

  for (const entry of contract.passthrough) {
    if (passthroughObserved(entry, context)) {
      diagnostics.push(toDiagnostic(entry.diagnostic, entry.severity, contract, entry.feature))
    }
  }

  return diagnostics
}

function toDiagnostic(
  code: string,
  severity: 'warning' | 'info',
  contract: ConversionContract,
  subject: string,
): Diagnostic {
  return {
    code,
    severity,
    message: `${contract.from} -> ${contract.to}: ${subject}`,
  }
}

function lossObserved(entry: LossEntry, context: ObservationContext): boolean {
  switch (entry.feature) {
    case 'conditions':
      return hasConditions(context.sourceGraph)
        && !graphSubset(context.sourceGraph, context.destinationGraph, ['conditions'])
    case 'peer-virt':
      return hasPeerVirtual(context.sourceGraph)
        && !graphSubset(context.sourceGraph, context.destinationGraph, ['peer-virt'])
    case 'patch':
      return hasPatch(context.sourceGraph) && !hasPatch(context.destinationGraph)
    case 'virtual':
      return hasVirtualKeys(context.sourceGraph) && !hasVirtualKeys(context.destinationGraph)
    case 'workspace-metadata':
      return hasWorkspaceMetadata(context.sourceGraph)
        && !workspaceMetadataPreserved(context.sourceGraph, context.destinationGraph)
    case 'cacheKey':
      return hasBerryMetadataField(context.sourceLockfile, 'cacheKey')
        && !hasBerryMetadataField(context.destinationLockfile, 'cacheKey')
    case 'compressionLevel':
      return hasBerryMetadataField(context.sourceLockfile, 'compressionLevel')
        && !hasBerryMetadataField(context.destinationLockfile, 'compressionLevel')
    case 'sentinel':
      return hasSentinel(context.sourceGraph) && !hasSentinel(context.destinationGraph)
    default:
      throw new Error(`lossObserved: unsupported feature ${entry.feature}`)
  }
}

function additionObserved(entry: AdditionEntry, context: ObservationContext): boolean {
  switch (entry.field) {
    case '__metadata.version':
      return !looksLikeBerry(context.sourceLockfile) && hasBerryMetadataField(context.destinationLockfile, 'version')
    case 'workspace metadata':
      return context.mode === 'enrich-aware'
        && context.manifestsProvided === true
        && hasWorkspaceMetadata(context.destinationGraph)
    default:
      return false
  }
}

function passthroughObserved(entry: PassthroughEntry, context: ObservationContext): boolean {
  switch (entry.feature) {
    case 'conditions':
      return hasConditions(context.sourceGraph)
        && graphSubset(context.sourceGraph, context.destinationGraph, ['conditions'])
    case 'compressionLevel':
      return hasBerryMetadataField(context.sourceLockfile, 'compressionLevel')
        && hasBerryMetadataField(context.destinationLockfile, 'compressionLevel')
    case 'sentinel':
      return hasSentinel(context.sourceGraph) && hasSentinel(context.destinationGraph)
    default:
      throw new Error(`passthroughObserved: unsupported feature ${entry.feature}`)
  }
}

function hasConditions(graph: Graph): boolean {
  return Array.from(graph.nodes()).some(node => rawConditionsBlockOfNode(graph, node.id) !== undefined)
}

function hasPatch(graph: Graph): boolean {
  return Array.from(graph.nodes()).some(node => node.patch !== undefined)
}

function hasPeerVirtual(graph: Graph): boolean {
  return Array.from(graph.nodes()).some(node => node.peerContext.length > 0)
}

function hasVirtualKeys(graph: Graph): boolean {
  return Array.from(graph.nodes()).some(node => node.id.includes('('))
}

function hasWorkspaceMetadata(graph: Graph): boolean {
  return Array.from(graph.nodes()).some(node => node.workspacePath !== undefined)
    || Array.from(graph.nodes()).some(node =>
      graph.out(node.id).some(edge => edge.attrs?.workspace === true),
    )
}

function workspaceMetadataPreserved(source: Graph, destination: Graph): boolean {
  for (const node of source.nodes()) {
    if (node.workspacePath !== undefined && destination.getNode(node.id)?.workspacePath !== node.workspacePath) {
      return false
    }
  }

  for (const node of source.nodes()) {
    for (const edge of source.out(node.id)) {
      if (edge.attrs?.workspace !== true) continue
      const found = destination.out(edge.src).some(candidate =>
        candidate.dst === edge.dst
          && candidate.kind === edge.kind
          && candidate.attrs?.workspace === true
          && isDeepStrictEqual(candidate.attrs?.range, edge.attrs?.range),
      )
      if (!found) return false
    }
  }

  return true
}

function hasSentinel(graph: Graph): boolean {
  return Array.from(graph.nodes()).some(node => node.patch?.startsWith('unresolved-') === true)
}

function looksLikeBerry(lockfile: string | undefined): boolean {
  return lockfile?.includes('__metadata:') === true
}

function hasBerryMetadataField(lockfile: string | undefined, field: string): boolean {
  const meta = berryMetadata(lockfile)
  return meta !== undefined && Object.prototype.hasOwnProperty.call(meta, field)
}

function berryMetadata(lockfile: string | undefined): SymlMap | undefined {
  if (lockfile === undefined || !looksLikeBerry(lockfile)) return undefined
  const parsed = parseSyml(lockfile)
  const meta = parsed['__metadata']
  return meta !== undefined && typeof meta === 'object' && !Array.isArray(meta)
    ? meta as SymlMap
    : undefined
}
