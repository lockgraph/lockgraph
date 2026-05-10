import type { Diagnostic, Graph } from '../../main/ts/graph.ts'
import { parse as parseClassic, stringify as stringifyClassic } from '../../main/ts/formats/yarn-classic.ts'
import { parse as parseV4, stringify as stringifyV4 } from '../../main/ts/formats/yarn-berry-v4.ts'
import { parse as parseV5, stringify as stringifyV5 } from '../../main/ts/formats/yarn-berry-v5.ts'
import { parse as parseV6, stringify as stringifyV6 } from '../../main/ts/formats/yarn-berry-v6.ts'
import { parse as parseV8, stringify as stringifyV8 } from '../../main/ts/formats/yarn-berry-v8.ts'
import { parse as parseV9, stringify as stringifyV9 } from '../../main/ts/formats/yarn-berry-v9.ts'
import type { YarnClassicManifest } from '../../main/ts/formats/yarn-classic.ts'
import { CONTRACTS } from './_matrix.ts'
import type { ConversionContract, FormatId } from './_matrix.ts'
import { enrichClassicGraph, normalizeGraphForBerry } from './_normalize.ts'
import { observeInteropDiagnostics } from './_observe.ts'

export type StringifyOptions = {
  cacheKey?: string
  lineEnding?: 'lf' | 'crlf'
}

type BerryStringifyOptions = {
  cacheKey?: string
  lineEnding?: 'lf' | 'crlf'
  onDiagnostic?: (diagnostic: Diagnostic) => void
}

type ClassicStringifyOptions = {
  lineEnding?: 'lf' | 'crlf'
  onDiagnostic?: (diagnostic: Diagnostic) => void
}

type Stringifier =
  | { kind: 'berry'; emit: (graph: Graph, options: BerryStringifyOptions) => string }
  | { kind: 'classic'; emit: (graph: Graph, options: ClassicStringifyOptions) => string }

const PARSERS: Record<FormatId, ((lockfile: string) => Graph) | undefined> = {
  'yarn-berry-v4': parseV4,
  'yarn-berry-v5': parseV5,
  'yarn-berry-v6': parseV6,
  'yarn-berry-v8': parseV8,
  'yarn-berry-v9': parseV9,
  'yarn-classic': parseClassic,
  'npm-1': undefined,
  'npm-2': undefined,
  'npm-3': undefined,
  'pnpm-v5': undefined,
  'pnpm-v6': undefined,
  'pnpm-v9': undefined,
  'bun-text': undefined,
}

const STRINGIFIERS: Record<FormatId, Stringifier | undefined> = {
  'yarn-berry-v4': { kind: 'berry', emit: stringifyV4 },
  'yarn-berry-v5': { kind: 'berry', emit: stringifyV5 },
  'yarn-berry-v6': { kind: 'berry', emit: stringifyV6 },
  'yarn-berry-v8': { kind: 'berry', emit: stringifyV8 },
  'yarn-berry-v9': { kind: 'berry', emit: stringifyV9 },
  'yarn-classic': { kind: 'classic', emit: stringifyClassic },
  'npm-1': undefined,
  'npm-2': undefined,
  'npm-3': undefined,
  'pnpm-v5': undefined,
  'pnpm-v6': undefined,
  'pnpm-v9': undefined,
  'bun-text': undefined,
}

const BERRY_CACHE_KEYS: Record<Extract<FormatId, `yarn-berry-${string}`>, string> = {
  'yarn-berry-v4': '7',
  'yarn-berry-v5': '8',
  'yarn-berry-v6': '8',
  'yarn-berry-v8': '10c0',
  'yarn-berry-v9': '10c0',
}

export function parseFormat(format: FormatId, lockfile: string): Graph {
  const parser = PARSERS[format]
  if (parser === undefined) throw new Error(`parseFormat: unsupported format ${format}`)
  return parser(lockfile)
}

export function stringifyFormat(
  format: FormatId,
  graph: Graph,
  options: StringifyOptions = {},
): { lockfile: string; diagnostics: Diagnostic[] } {
  const stringifier = STRINGIFIERS[format]
  if (stringifier === undefined) throw new Error(`stringifyFormat: unsupported format ${format}`)
  const diagnostics: Diagnostic[] = []
  const onDiagnostic = (diagnostic: Diagnostic) => { diagnostics.push(diagnostic) }
  const lockfile = stringifier.kind === 'berry'
    ? stringifier.emit(graph, { cacheKey: options.cacheKey, lineEnding: options.lineEnding, onDiagnostic })
    : stringifier.emit(graph, { lineEnding: options.lineEnding, onDiagnostic })
  return { lockfile, diagnostics }
}

export function berryCacheKeyOf(format: Extract<FormatId, `yarn-berry-${string}`>): string {
  return BERRY_CACHE_KEYS[format]
}

export function formatCode(format: FormatId): string {
  return format.replaceAll('-', '_').toUpperCase()
}

export type ConvertMode = 'naive' | 'enrich-aware'

export type ConvertInputOptions = {
  cacheKey?: string
  lineEnding?: 'lf' | 'crlf'
  manifests?: Record<string, YarnClassicManifest>
}

export type ConvertInput = {
  from: FormatId
  to: FormatId
  source: string
  options?: ConvertInputOptions
  mode?: ConvertMode
}

export type ConvertResult = {
  sourceGraph: Graph
  destinationGraph: Graph
  lockfile: string
  diagnostics: Diagnostic[]
}

// `convert` is the front door for interop tests: parse_A → (optional enrich) →
// stringify_B → parse_B, and emit per-format + real INTEROP_* diagnostics.
// INTEROP_* emission compares actual sourceGraph vs destinationGraph state via
// `observeInteropDiagnostics`; if the matrix declares a loss but the adapter
// silently preserves the feature (or vice-versa), the assert layer surfaces
// the divergence as missing/spurious instead of fabricating consistency.
export function convert(input: ConvertInput): ConvertResult {
  const mode: ConvertMode = input.mode ?? 'naive'
  const options = input.options ?? {}
  const cacheKey = options.cacheKey ?? berryCacheKeyForFormat(input.to)

  const parsedSource = parseFormat(input.from, input.source)
  const sourceGraph = prepareSourceGraph(parsedSource, input, mode, options)

  const stringified = stringifyFormat(input.to, sourceGraph, {
    cacheKey,
    lineEnding: options.lineEnding,
  })
  const destinationGraph = parseFormat(input.to, stringified.lockfile)

  const contract = findContract(input.from, input.to)
  const interopDiagnostics = contract === undefined ? [] : observeInteropDiagnostics(contract, {
    sourceGraph,
    destinationGraph,
    sourceLockfile: input.source,
    destinationLockfile: stringified.lockfile,
    mode,
    manifestsProvided: options.manifests !== undefined,
  })

  return {
    sourceGraph,
    destinationGraph,
    lockfile: stringified.lockfile,
    diagnostics: [
      ...sourceGraph.diagnostics(),
      ...stringified.diagnostics,
      ...destinationGraph.diagnostics(),
      ...interopDiagnostics,
    ],
  }
}

function prepareSourceGraph(
  parsed: Graph,
  input: ConvertInput,
  mode: ConvertMode,
  options: ConvertInputOptions,
): Graph {
  if (input.from === 'yarn-classic' && input.to.startsWith('yarn-berry-')) {
    if (mode === 'enrich-aware' && options.manifests !== undefined) {
      const enriched = enrichClassicGraph(parsed, 'enrich-aware')
      return normalizeGraphForBerry(enriched.graph)
    }
    return normalizeGraphForBerry(parsed)
  }
  return parsed
}

function findContract(from: FormatId, to: FormatId): ConversionContract | undefined {
  return CONTRACTS.find(c => c.from === from && c.to === to)
}

function berryCacheKeyForFormat(format: FormatId): string | undefined {
  if (format.startsWith('yarn-berry-')) {
    return BERRY_CACHE_KEYS[format as Extract<FormatId, `yarn-berry-${string}`>]
  }
  return undefined
}
