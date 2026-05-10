import type { Diagnostic, Graph } from '../../main/ts/graph.ts'
import { parse as parseClassic, stringify as stringifyClassic } from '../../main/ts/formats/yarn-classic.ts'
import { parse as parseV4, stringify as stringifyV4 } from '../../main/ts/formats/yarn-berry-v4.ts'
import { parse as parseV5, stringify as stringifyV5 } from '../../main/ts/formats/yarn-berry-v5.ts'
import { parse as parseV6, stringify as stringifyV6 } from '../../main/ts/formats/yarn-berry-v6.ts'
import { parse as parseV8, stringify as stringifyV8 } from '../../main/ts/formats/yarn-berry-v8.ts'
import { parse as parseV9, stringify as stringifyV9 } from '../../main/ts/formats/yarn-berry-v9.ts'
import type { FormatId } from './_matrix.ts'

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
