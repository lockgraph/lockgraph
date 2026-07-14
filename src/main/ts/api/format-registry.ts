import type { Graph, OverrideConstraint } from '../graph.ts'
import type {
  FormatAdapterContract,
  FormatId,
  StringifyOptions,
} from './format-contract.ts'
import {
  stringifyFamily as stringifyPnpmFamily,
  type PnpmWorkspacePeerProjection,
} from '../formats/_pnpm-flat-core.ts'

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

export const FORMAT_REGISTRY: Readonly<Record<FormatId, FormatAdapter>> = {
  'yarn-berry-v4': {
    check: yarnBerryV4.check,
    parse: (input, context) => yarnBerryV4.parse(input, {
      workspaceRoot: context.workspaceRoot,
      overrides: context.overrides,
    }),
    stringify: (graph, context) => yarnBerryV4.stringify(graph, {
      lineEnding: context.lineEnding,
      cacheKey: context.cacheKey,
      onDiagnostic: context.onDiagnostic,
    }),
  },
  'yarn-berry-v5': {
    check: yarnBerryV5.check,
    parse: (input, context) => yarnBerryV5.parse(input, {
      workspaceRoot: context.workspaceRoot,
      overrides: context.overrides,
    }),
    stringify: (graph, context) => yarnBerryV5.stringify(graph, {
      lineEnding: context.lineEnding,
      cacheKey: context.cacheKey,
      onDiagnostic: context.onDiagnostic,
    }),
  },
  'yarn-berry-v6': {
    check: yarnBerryV6.check,
    parse: (input, context) => yarnBerryV6.parse(input, {
      workspaceRoot: context.workspaceRoot,
      overrides: context.overrides,
    }),
    stringify: (graph, context) => yarnBerryV6.stringify(graph, {
      lineEnding: context.lineEnding,
      cacheKey: context.cacheKey,
      onDiagnostic: context.onDiagnostic,
    }),
  },
  'yarn-berry-v7': {
    check: yarnBerryV7.check,
    parse: (input, context) => yarnBerryV7.parse(input, {
      workspaceRoot: context.workspaceRoot,
      overrides: context.overrides,
    }),
    stringify: (graph, context) => yarnBerryV7.stringify(graph, {
      lineEnding: context.lineEnding,
      cacheKey: context.cacheKey,
      onDiagnostic: context.onDiagnostic,
    }),
  },
  'yarn-berry-v8': {
    check: yarnBerryV8.check,
    parse: (input, context) => yarnBerryV8.parse(input, {
      workspaceRoot: context.workspaceRoot,
      overrides: context.overrides,
    }),
    stringify: (graph, context) => yarnBerryV8.stringify(graph, {
      lineEnding: context.lineEnding,
      cacheKey: context.cacheKey,
      onDiagnostic: context.onDiagnostic,
    }),
  },
  'yarn-berry-v9': {
    check: yarnBerryV9.check,
    parse: (input, context) => yarnBerryV9.parse(input, {
      workspaceRoot: context.workspaceRoot,
      overrides: context.overrides,
    }),
    stringify: (graph, context) => yarnBerryV9.stringify(graph, {
      lineEnding: context.lineEnding,
      cacheKey: context.cacheKey,
      onDiagnostic: context.onDiagnostic,
    }),
  },
  'yarn-berry-v10': {
    check: yarnBerryV10.check,
    parse: (input, context) => yarnBerryV10.parse(input, {
      workspaceRoot: context.workspaceRoot,
      overrides: context.overrides,
    }),
    stringify: (graph, context) => yarnBerryV10.stringify(graph, {
      lineEnding: context.lineEnding,
      cacheKey: context.cacheKey,
      onDiagnostic: context.onDiagnostic,
    }),
  },
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
  'npm-2': {
    check: npm2.check,
    parse: input => npm2.parse(input),
    stringify: (graph, context) => npm2.stringify(graph, {
      lineEnding: context.lineEnding,
      onDiagnostic: context.onDiagnostic,
      overrides: context.overrides,
    }),
  },
  'npm-3': {
    check: npm3.check,
    parse: input => npm3.parse(input),
    stringify: (graph, context) => npm3.stringify(graph, {
      lineEnding: context.lineEnding,
      onDiagnostic: context.onDiagnostic,
      overrides: context.overrides,
    }),
  },
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
  'pnpm-v6': {
    check: pnpmV6.check,
    parse: (input, context) => pnpmV6.parse(input, { workspaceRoot: context.workspaceRoot }),
    stringify: (graph, context) => context.pnpmWorkspacePeerProjection === undefined
      ? pnpmV6.stringify(graph, {
          lineEnding: context.lineEnding,
          onDiagnostic: context.onDiagnostic,
          overrides: context.overrides,
        })
      : stringifyPnpmFamily(
          graph,
          { profile: 'v6-collapsed-root' },
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
  },
  'pnpm-v9': {
    check: pnpmV9.check,
    parse: (input, context) => pnpmV9.parse(input, { workspaceRoot: context.workspaceRoot }),
    stringify: (graph, context) => context.pnpmWorkspacePeerProjection === undefined
      ? pnpmV9.stringify(graph, {
          lineEnding: context.lineEnding,
          onDiagnostic: context.onDiagnostic,
          overrides: context.overrides,
        })
      : stringifyPnpmFamily(
          graph,
          { profile: 'v9-importers-snapshots' },
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
  },
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
