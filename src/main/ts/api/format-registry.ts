import type { Graph, Manifest, OverrideConstraint } from '../graph.ts'
import type {
  FormatAdapterContract,
  FormatId,
  StringifyOptions,
} from './format-contract.ts'
import { isDenoFormat } from './format-contract.ts'
import { LockfileError } from './errors.ts'
import {
  adapterStateSubjects as pnpmFlatAdapterStateSubjects,
  hasAdapterState as hasPnpmFlatAdapterState,
  rebindAdapterState as rebindPnpmFlatAdapterState,
  stringifyFamily as stringifyPnpmFamily,
  type PnpmWorkspacePeerProjection,
} from '../formats/_pnpm-flat-core.ts'
import {
  adapterStateSubjects as npmFlatAdapterStateSubjects,
  hasAdapterState as hasNpmFlatAdapterState,
  rebindAdapterState as rebindNpmFlatAdapterState,
} from '../formats/_npm-core.ts'
import { rebindNpm2MirrorState } from '../formats/_npm-2-mirror.ts'
import {
  adapterStateSubjects as yarnBerryAdapterStateSubjects,
  hasAdapterState as hasYarnBerryAdapterState,
  rebindAdapterState as rebindYarnBerryAdapterState,
} from '../formats/_yarn-berry-core.ts'

import * as bunText from '../formats/bun-text.ts'
import * as bunTextV2 from '../formats/bun-text-v2.ts'
import {
  adapterStateSubjects as denoAdapterStateSubjects,
  hasAdapterState as hasDenoAdapterState,
  rebindAdapterState as rebindDenoAdapterState,
} from '../formats/_deno-core.ts'
import * as denoV2 from '../formats/deno-v2.ts'
import * as denoV3 from '../formats/deno-v3.ts'
import * as denoV4 from '../formats/deno-v4.ts'
import * as denoV5 from '../formats/deno-v5.ts'
import * as npm1 from '../formats/npm-1.ts'
import * as npm2 from '../formats/npm-2.ts'
import * as npm3 from '../formats/npm-3.ts'
import * as npm4 from '../formats/npm-4.ts'
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
  readonly manifests?: Readonly<Record<string, Manifest>>
  readonly registryFor?: (packageName: string) => string | undefined
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
  readonly adapterStateSubjects?: (graph: Graph) => readonly string[]
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
    registryFor: context.registryFor,
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
  parse: (input, context) => adapter.parse(input, {
    workspaceRoot: context.workspaceRoot,
    registryFor: context.registryFor,
  }),
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
  parse: (input, context) => adapter.parse(input, {
    workspaceRoot: context.workspaceRoot,
    registryFor: context.registryFor,
  }),
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
  adapterStateSubjects: yarnBerryAdapterStateSubjects,
  hasAdapterState: hasYarnBerryAdapterState,
  rebindAdapterState: rebindYarnBerryAdapterState,
} satisfies AdapterStateContract

const npmFlatStateAdapter = {
  adapterStateSubjects: npmFlatAdapterStateSubjects,
  hasAdapterState: hasNpmFlatAdapterState,
  rebindAdapterState: rebindNpmFlatAdapterState,
} satisfies AdapterStateContract

const pnpmFlatStateAdapter = {
  adapterStateSubjects: pnpmFlatAdapterStateSubjects,
  hasAdapterState: hasPnpmFlatAdapterState,
  rebindAdapterState: rebindPnpmFlatAdapterState,
} satisfies AdapterStateContract

const npm2StateAdapter = {
  adapterStateSubjects: npmFlatAdapterStateSubjects,
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

const denoStateAdapter = {
  adapterStateSubjects: denoAdapterStateSubjects,
  hasAdapterState: hasDenoAdapterState,
  rebindAdapterState: rebindDenoAdapterState,
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
  'npm-4': npmFlatStateAdapter,
  'pnpm-v5': pnpmV5,
  'pnpm-v6': pnpmFlatStateAdapter,
  'pnpm-v9': pnpmFlatStateAdapter,
  'bun-text': bunText,
  // Both generations share one adapter module, so one sidecar WeakMap and one
  // state contract — the generation is the format id, not adapter state.
  'bun-text-v2': bunText,
  'deno-v2': denoStateAdapter,
  'deno-v3': denoStateAdapter,
  'deno-v4': denoStateAdapter,
  'deno-v5': denoStateAdapter,
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
    parse: (input, context) => yarnClassic.parse(input, {
      overrides: context.overrides,
      registryFor: context.registryFor,
    }),
    stringify: (graph, context) => yarnClassic.stringify(graph, {
      lineEnding: context.lineEnding,
      onDiagnostic: context.onDiagnostic,
    }),
  },
  'npm-1': {
    check: npm1.check,
    parse: (input, context) => npm1.parse(input, { registryFor: context.registryFor }),
    stringify: (graph, context) => npm1.stringify(graph, {
      lineEnding: context.lineEnding,
      onDiagnostic: context.onDiagnostic,
    }),
  },
  'npm-2': npmFlatAdapter(npm2),
  'npm-3': npmFlatAdapter(npm3),
  'npm-4': npmFlatAdapter(npm4),
  'pnpm-v5': {
    check: pnpmV5.check,
    parse: (input, context) => pnpmV5.parse(input, { registryFor: context.registryFor }),
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
    parse: (input, context) => bunText.parse(input, { registryFor: context.registryFor }),
    stringify: (graph, context) => bunText.stringify(graph, {
      lineEnding: context.lineEnding,
      onDiagnostic: context.onDiagnostic,
      overrides: context.overrides,
    }),
  },
  'bun-text-v2': {
    check: bunTextV2.check,
    parse: (input, context) => bunTextV2.parse(input, { registryFor: context.registryFor }),
    stringify: (graph, context) => bunTextV2.stringify(graph, {
      lineEnding: context.lineEnding,
      onDiagnostic: context.onDiagnostic,
      overrides: context.overrides,
    }),
  },
  'deno-v2': denoAdapter(denoV2),
  'deno-v3': denoAdapter(denoV3),
  'deno-v4': denoAdapter(denoV4),
  'deno-v5': denoAdapter(denoV5),
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
  // Both bun generations precede the npm family: bun's `2` and npm-2's `2` are the
  // same integer, and only bun's TOP-LEVEL `workspaces` object separates them. Its
  // check parses to confirm that, so leading here costs npm nothing.
  'bun-text-v2',
  'bun-text',
  'deno-v5',
  'deno-v4',
  'deno-v3',
  'deno-v2',
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
  'npm-4',
  'npm-3',
  'npm-2',
  'npm-1',
] as const satisfies readonly FormatId[]

export function checkFormat(format: FormatId, input: string): boolean {
  return formatAdapter(format).check(input)
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
  return formatAdapter(format).parse(input, context)
}

export function stringifyFormat(
  format: FormatId,
  graph: Graph,
  context: StringifyDispatchContext = {},
): string {
  return formatAdapter(format).stringify(graph, context)
}

export function formatAdapterStateCompatible(source: FormatId, target: FormatId): boolean {
  // The npm root-entry carrier is proven portable only across npm-2/npm-3:
  // the real corpus exposes the same measured fourteen-key packages[""]
  // vocabulary in both, and pinned npm 8 accepts an unknown future key. Keep
  // this boundary explicit: npm-1 has no packages map, while npm-4 has no
  // root-entry corpus evidence and must not inherit compatibility through a
  // broader "npm flat" classification.
  const npmRootCarrierCompatible = (source === 'npm-2' || source === 'npm-3')
    && (target === 'npm-2' || target === 'npm-3')
  return source === target
    || npmRootCarrierCompatible
    || (isDenoFormat(source) && isDenoFormat(target))
}

function denoAdapter(
  adapter: Pick<typeof denoV2, 'check' | 'parse' | 'stringify'>,
): FormatAdapter {
  return {
    check: adapter.check,
    parse: (input, context) => adapter.parse(input, {
      manifests: context.manifests,
      registryFor: context.registryFor,
    }),
    stringify: (graph, context) => adapter.stringify(graph, {
      lineEnding: context.lineEnding,
      onDiagnostic: context.onDiagnostic,
    }),
  }
}

function formatAdapter(format: FormatId): FormatAdapter {
  const runtimeFormat = format as string
  const adapter = (FORMAT_REGISTRY as Readonly<Record<string, FormatAdapter | undefined>>)[runtimeFormat]
  if (adapter !== undefined) return adapter
  throw new LockfileError({
    code: 'FORMAT_MISMATCH',
    message: `unknown format id ${JSON.stringify(runtimeFormat)}`,
  })
}

/** Whether the graph identity still carries its source adapter's native replay state. */
export function hasFormatAdapterState(format: FormatId, graph: Graph): boolean {
  return FORMAT_STATE_REGISTRY[format]?.hasAdapterState(graph) ?? false
}

/** Key-addressable same-format carriers used by strict loss diagnostics. */
export function formatAdapterStateSubjects(format: FormatId, graph: Graph): readonly string[] {
  const adapter: AdapterStateContract | undefined = FORMAT_STATE_REGISTRY[format]
  return adapter?.adapterStateSubjects?.(graph) ?? []
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
