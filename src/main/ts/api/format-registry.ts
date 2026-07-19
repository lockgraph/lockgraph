import type { Graph, OverrideConstraint } from '../graph.ts'
import type {
  FormatAdapterContract,
  FormatId,
  StringifyOptions,
} from './format-contract.ts'
import {
  hasAdapterState as hasPnpmFlatAdapterState,
  rebindAdapterState as rebindPnpmFlatAdapterState,
  stringifyFamily as stringifyPnpmFamily,
  type PnpmWorkspacePeerProjection,
} from '../formats/_pnpm-flat-core.ts'
import {
  hasAdapterState as hasNpmFlatAdapterState,
  rebindAdapterState as rebindNpmFlatAdapterState,
} from '../formats/_npm-core.ts'
import { rebindNpm2MirrorState } from '../formats/_npm-2-mirror.ts'
import {
  hasAdapterState as hasYarnBerryAdapterState,
  rebindAdapterState as rebindYarnBerryAdapterState,
} from '../formats/_yarn-berry-core.ts'

import * as bunText from '../formats/bun-text.ts'
import * as npm1 from '../formats/npm-1.ts'
import * as npm2 from '../formats/npm-2.ts'
import * as npm3 from '../formats/npm-3.ts'
import * as pnpmV5 from '../formats/pnpm-v5.ts'
import * as pnpmV6 from '../formats/pnpm-v6.ts'
import * as pnpmV9 from '../formats/pnpm-v9.ts'
import * as yarnBerryV4 from '../formats/yarn-berry-v4.ts'
import * as yarnBerryV5 from '../formats/yarn-berry-v5.ts'
import * as yarnBerryV6 from '../formats/yarn-berry-v6.ts'
import * as yarnBerryV7 from '../formats/yarn-berry-v7.ts'
import * as yarnBerryV8 from '../formats/yarn-berry-v8.ts'
import * as yarnBerryV9 from '../formats/yarn-berry-v9.ts'
import * as yarnBerryV10 from '../formats/yarn-berry-v10.ts'
import * as yarnClassic from '../formats/yarn-classic.ts'
import * as lockgraph from '../formats/lockgraph.ts'

export interface ParseDispatchContext {
  readonly workspaceRoot?: string
  readonly overrides?: OverrideConstraint[]
}

export type StringifyDispatchContext = StringifyOptions & {
  readonly targetVersion?: string
  readonly pnpmWorkspacePeerProjection?: PnpmWorkspacePeerProjection
  readonly pnpmWorkspaceNames?: ReadonlyMap<string, string>
}

type FormatAdapter = FormatAdapterContract<
  ParseDispatchContext,
  StringifyDispatchContext
>

interface AdapterStateRebindResult {
  readonly graph: Graph
  readonly invalidated: readonly string[]
}

interface AdapterStateContract {
  readonly hasAdapterState: (graph: Graph) => boolean
  readonly rebindAdapterState: (
    source: Graph,
    target: Graph,
  ) => AdapterStateRebindResult
}

const yarnBerryAdapter = (
  adapter: Pick<typeof yarnBerryV4, 'check' | 'parse' | 'stringify'>,
): FormatAdapter => ({
  check: adapter.check,
  parse: (input, context) => adapter.parse(input, {
    workspaceRoot: context.workspaceRoot,
    overrides: context.overrides,
  }),
  stringify: (graph, context) => adapter.stringify(graph, {
    lineEnding: context.lineEnding,
    cacheKey: context.cacheKey,
    onDiagnostic: context.onDiagnostic,
  }),
})

const npmFlatAdapter = (
  adapter: Pick<typeof npm2, 'check' | 'parse' | 'stringify'>,
): FormatAdapter => ({
  check: adapter.check,
  parse: input => adapter.parse(input),
  stringify: (graph, context) => adapter.stringify(graph, {
    lineEnding: context.lineEnding,
    onDiagnostic: context.onDiagnostic,
    overrides: context.overrides,
  }),
})

const pnpmFlatAdapter = (
  adapter: Pick<typeof pnpmV6, 'check' | 'parse' | 'stringify'>,
  profile: 'v6-collapsed-root' | 'v9-importers-snapshots',
): FormatAdapter => ({
  check: adapter.check,
  parse: (input, context) => adapter.parse(input, { workspaceRoot: context.workspaceRoot }),
  stringify: (graph, context) => context.pnpmWorkspacePeerProjection === undefined
    ? adapter.stringify(graph, {
        lineEnding: context.lineEnding,
        onDiagnostic: context.onDiagnostic,
        overrides: context.overrides,
      })
    : stringifyPnpmFamily(
        graph,
        { profile },
        {
          lineEnding: context.lineEnding,
          onDiagnostic: context.onDiagnostic,
          overrides: context.overrides,
        },
        {
          workspacePeerProjection: context.pnpmWorkspacePeerProjection,
          workspaceNames: context.pnpmWorkspaceNames,
        },
      ),
})

const yarnBerryStateAdapter = {
  hasAdapterState: hasYarnBerryAdapterState,
  rebindAdapterState: rebindYarnBerryAdapterState,
} satisfies AdapterStateContract

const npmFlatStateAdapter = {
  hasAdapterState: hasNpmFlatAdapterState,
  rebindAdapterState: rebindNpmFlatAdapterState,
} satisfies AdapterStateContract

const pnpmFlatStateAdapter = {
  hasAdapterState: hasPnpmFlatAdapterState,
  rebindAdapterState: rebindPnpmFlatAdapterState,
} satisfies AdapterStateContract

const npm2StateAdapter = {
  hasAdapterState: hasNpmFlatAdapterState,
  rebindAdapterState(source, target): AdapterStateRebindResult {
    const flat = rebindNpmFlatAdapterState(source, target)
    return {
      graph: flat.graph,
      invalidated: [...new Set([
        ...flat.invalidated,
        ...rebindNpm2MirrorState(source, flat.graph),
      ])].sort(),
    }
  },
} satisfies AdapterStateContract

const FORMAT_STATE_REGISTRY = {
  'yarn-berry-v4': yarnBerryStateAdapter,
  'yarn-berry-v5': yarnBerryStateAdapter,
  'yarn-berry-v6': yarnBerryStateAdapter,
  'yarn-berry-v7': yarnBerryStateAdapter,
  'yarn-berry-v8': yarnBerryStateAdapter,
  'yarn-berry-v9': yarnBerryStateAdapter,
  'yarn-berry-v10': yarnBerryStateAdapter,
  'yarn-classic': yarnClassic,
  'npm-1': npm1,
  'npm-2': npm2StateAdapter,
  'npm-3': npmFlatStateAdapter,
  'pnpm-v5': pnpmV5,
  'pnpm-v6': pnpmFlatStateAdapter,
  'pnpm-v9': pnpmFlatStateAdapter,
  'bun-text': bunText,
  lockgraph: undefined,
} as const satisfies Readonly<Record<FormatId, AdapterStateContract | undefined>>

export const FORMAT_REGISTRY: Readonly<Record<FormatId, FormatAdapter>> = {
  'yarn-berry-v4': yarnBerryAdapter(yarnBerryV4),
  'yarn-berry-v5': yarnBerryAdapter(yarnBerryV5),
  'yarn-berry-v6': yarnBerryAdapter(yarnBerryV6),
  'yarn-berry-v7': yarnBerryAdapter(yarnBerryV7),
  'yarn-berry-v8': yarnBerryAdapter(yarnBerryV8),
  'yarn-berry-v9': yarnBerryAdapter(yarnBerryV9),
  'yarn-berry-v10': yarnBerryAdapter(yarnBerryV10),
  'yarn-classic': {
    check: yarnClassic.check,
    parse: (input, context) => yarnClassic.parse(input, { overrides: context.overrides }),
    stringify: (graph, context) => yarnClassic.stringify(graph, {
      lineEnding: context.lineEnding,
      onDiagnostic: context.onDiagnostic,
    }),
  },
  'npm-1': {
    check: npm1.check,
    parse: input => npm1.parse(input),
    stringify: (graph, context) => npm1.stringify(graph, {
      lineEnding: context.lineEnding,
      onDiagnostic: context.onDiagnostic,
    }),
  },
  'npm-2': npmFlatAdapter(npm2),
  'npm-3': npmFlatAdapter(npm3),
  'pnpm-v5': {
    check: pnpmV5.check,
    parse: input => pnpmV5.parse(input),
    stringify: (graph, context) => pnpmV5.stringify(
      graph,
      {
        lineEnding: context.lineEnding,
        onDiagnostic: context.onDiagnostic,
        overrides: context.overrides,
      },
      { workspaceNames: context.pnpmWorkspaceNames },
    ),
  },
  'pnpm-v6': pnpmFlatAdapter(pnpmV6, 'v6-collapsed-root'),
  'pnpm-v9': pnpmFlatAdapter(pnpmV9, 'v9-importers-snapshots'),
  'bun-text': {
    check: bunText.check,
    parse: input => bunText.parse(input),
    stringify: (graph, context) => bunText.stringify(graph, {
      lineEnding: context.lineEnding,
      onDiagnostic: context.onDiagnostic,
      overrides: context.overrides,
    }),
  },
  lockgraph: {
    check: lockgraph.check,
    parse: input => lockgraph.parse(input),
    stringify: (graph, context) => lockgraph.stringify(graph, {
      lineEnding: context.lineEnding,
      onDiagnostic: context.onDiagnostic,
    }),
  },
} as const satisfies Readonly<Record<FormatId, FormatAdapter>>

// First-match order is observable behavior. Registry property order is not.
export const DETECTION_ORDER = [
  'lockgraph',
  'bun-text',
  'yarn-berry-v10',
  'yarn-berry-v9',
  'yarn-berry-v8',
  'yarn-berry-v7',
  'yarn-berry-v6',
  'yarn-berry-v5',
  'yarn-berry-v4',
  'pnpm-v9',
  'pnpm-v6',
  'pnpm-v5',
  'yarn-classic',
  'npm-3',
  'npm-2',
  'npm-1',
] as const satisfies readonly FormatId[]

export function checkFormat(format: FormatId, input: string): boolean {
  return FORMAT_REGISTRY[format].check(input)
}

export function detectFormat(input: string): FormatId | undefined {
  for (const format of DETECTION_ORDER) {
    if (checkFormat(format, input)) return format
  }
  return undefined
}

export function parseFormat(
  format: FormatId,
  input: string,
  context: ParseDispatchContext = {},
): Graph {
  return FORMAT_REGISTRY[format].parse(input, context)
}

export function stringifyFormat(
  format: FormatId,
  graph: Graph,
  context: StringifyDispatchContext = {},
): string {
  return FORMAT_REGISTRY[format].stringify(graph, context)
}

/** Whether the graph identity still carries its source adapter's native replay state. */
export function hasFormatAdapterState(format: FormatId, graph: Graph): boolean {
  return FORMAT_STATE_REGISTRY[format]?.hasAdapterState(graph) ?? false
}

/** @internal Rebind source-format replay state after a graph transformation. */
export function rebindFormatAdapterState(
  format: FormatId | undefined,
  source: Graph,
  target: Graph,
): AdapterStateRebindResult {
  const adapter = format === undefined ? undefined : FORMAT_STATE_REGISTRY[format]
  return adapter?.rebindAdapterState(source, target) ?? { graph: target, invalidated: [] }
}
