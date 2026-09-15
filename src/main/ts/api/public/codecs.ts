import type { Graph as InternalGraph } from '../../graph.ts'
import { targetRequestOf } from '../../completeness/targets.ts'
import type { TargetInput } from './assessment.ts'
import { internalObserver } from './diagnostics.ts'
import {
  internalGraph,
  publicGraph,
  type Graph,
} from './graph.ts'
import type { ObserveOptions, OperationSources } from './operation.ts'
import { internalPmConfig } from './assessment.ts'
import { rethrowPublic } from './errors.ts'
import type {
  FormatId,
  ParseOptions as InternalParseOptions,
  StringifyOptions as InternalStringifyOptions,
} from '../format-contract.ts'
import {
  check as checkInternal,
  detect as detectInternal,
  isFormatId,
  parse as parseInternal,
  stringify as stringifyInternal,
} from '../format-api.ts'

/** Public parse policy; adapter-only context stays internal. */
export interface ParseOptions extends ObserveOptions {
  readonly cwd?: string
  readonly registry?: string
  readonly sources?: Pick<OperationSources, 'policy'>
}

/** Public stringify policy; target-specific spelling lives on TargetInput. */
export interface StringifyOptions extends ObserveOptions {
  readonly strict?: boolean
  readonly lineEnding?: 'lf' | 'crlf'
  readonly sources?: Pick<OperationSources, 'policy'>
}

export function detect(input: string): FormatId | undefined {
  return detectInternal(input)
}

export function check(input: string, format: FormatId): boolean
/** @internal Pre-0.6 source compatibility; stripped from the declaration. */
export function check(format: FormatId, input: string): boolean
export function check(a: string, b: string): boolean {
  return (checkInternal as (...args: string[]) => boolean)(a, b)
}

interface InternalParseOptionsWithFormat extends InternalParseOptions {
  readonly format?: FormatId
}

export function parse(
  input: string,
  format?: FormatId,
  options?: ParseOptions,
): Graph
/** @internal Pre-0.6 source compatibility; stripped from the declaration. */
export function parse(input: string, options: InternalParseOptionsWithFormat): InternalGraph
/** @internal Pre-0.6 source compatibility; stripped from the declaration. */
export function parse(format: FormatId, input: string, options?: InternalParseOptions): InternalGraph
export function parse(
  a: string,
  b?: unknown,
  c?: unknown,
): Graph | InternalGraph {
  if (typeof b === 'string' && isFormatId(a) && !isFormatId(b)) {
    return (parseInternal as (...args: unknown[]) => InternalGraph)(a, b, c)
  }
  if (b !== null && typeof b === 'object') {
    return parseInternal(a, b as InternalParseOptionsWithFormat)
  }
  const options = c as ParseOptions | undefined
  try {
    const parsed = parseInternal(a, b as FormatId | undefined, {
      ...(options?.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options?.registry === undefined ? {} : { registry: options.registry }),
      ...(options?.sources?.policy === undefined
        ? {}
        : { sources: { policy: internalPmConfig(options.sources.policy) } }),
      ...(options?.onDiagnostic === undefined
        ? {}
        : { onDiagnostic: internalObserver(options.onDiagnostic) }),
    })
    return publicGraph(parsed)
  } catch (error) {
    return rethrowPublic(error)
  }
}

interface InternalStringifyOptionsWithFormat extends InternalStringifyOptions {
  readonly format?: FormatId
}

export function stringify(
  graph: Graph,
  target: TargetInput,
  options?: StringifyOptions,
): string
/** @internal Pre-0.6 core-graph compatibility; stripped from the declaration. */
export function stringify(
  graph: InternalGraph,
  target: TargetInput,
  options?: StringifyOptions,
): string
/** @internal Pre-0.6 source compatibility; stripped from the declaration. */
export function stringify(graph: InternalGraph, options: InternalStringifyOptionsWithFormat): string
/** @internal Pre-0.6 source compatibility; stripped from the declaration. */
export function stringify(format: FormatId, graph: InternalGraph, options?: InternalStringifyOptions): string
export function stringify(
  a: FormatId | Graph | InternalGraph,
  b: unknown,
  c?: unknown,
): string {
  if (typeof a === 'string') {
    return (stringifyInternal as (...args: unknown[]) => string)(a, b, c)
  }
  if (b !== null && typeof b === 'object' && !Array.isArray(b)
    && 'format' in b && !('nodes' in b)) {
    const { format, ...options } = b as InternalStringifyOptionsWithFormat & { format: FormatId }
    return stringifyInternal(a as InternalGraph, format, options)
  }
  const normalized = targetRequestOf(b as TargetInput)
  const options = c as StringifyOptions | undefined
  try {
    return stringifyInternal(internalGraph(a as Graph), normalized.format, {
      ...(options?.strict === undefined ? {} : { strict: options.strict }),
      ...(options?.lineEnding === undefined ? {} : { lineEnding: options.lineEnding }),
      ...(options?.sources?.policy === undefined
        ? {}
        : { sources: { policy: internalPmConfig(options.sources.policy) } }),
      ...(options?.onDiagnostic === undefined
        ? {}
        : { onDiagnostic: internalObserver(options.onDiagnostic) }),
      ...('cacheKey' in normalized && normalized.cacheKey !== undefined
        ? { cacheKey: normalized.cacheKey }
        : {}),
    })
  } catch (error) {
    return rethrowPublic(error)
  }
}
