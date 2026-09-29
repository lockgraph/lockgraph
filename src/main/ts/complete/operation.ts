import type {
  EdgeTriple,
  Graph,
  NodeId,
  OverrideConstraint,
} from '../graph.ts'
import type { GraphOperationResult, OperationOptions } from '../api/operation.ts'
import { frozenRegistry } from '../registry/frozen.ts'
import type { PackumentVersion, RegistryAdapter } from '../registry/types.ts'
import type { GraphFrontier } from '../modify/operation.ts'
import { pruneOrphans } from '../optimize/prune.ts'
import {
  engines as legacyEngines,
  license as legacyLicense,
  selectConstrained as legacySelectConstrained,
  type Condition as LegacyCondition,
  type ConditionContext as LegacyConditionContext,
  type OnUnevaluable,
} from './constraints.ts'
import {
  completeTransitives,
  type ResolutionStrategy,
} from './tree-complete.ts'
import type { CompletionBudget } from './backtrack.ts'
import { targetRequestOf } from '../completeness/targets.ts'
import {
  descriptorBindingsForTarget,
  packageVariantBindingsForTarget,
} from './descriptor-bindings.ts'

export type Awaitable<Value> = Value | Promise<Value>

export type ConditionVerdict =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; reason?: string }>
  | Readonly<{ ok: 'unevaluable'; reason?: string }>

export interface ConditionContext {
  readonly name: string
  readonly version: string
  readonly candidate: PackumentVersion
  manifest(): Promise<PackumentVersion | undefined>
  readonly registry: RegistryAdapter
}

export interface Condition {
  readonly kind: string
  readonly cost?: number
  evaluate(context: ConditionContext): Awaitable<ConditionVerdict>
}

export interface RejectedCandidate {
  readonly name: string
  readonly version: string
  readonly condition: string
  readonly reason?: string
}

export interface SelectConstrainedOptions {
  readonly registry: RegistryAdapter
  readonly conditions: readonly Condition[]
  readonly onUnevaluable?: OnUnevaluable
}

export interface SelectConstrainedResult {
  readonly selected?: PackumentVersion
  readonly rejected: readonly RejectedCandidate[]
}

function legacyContext(context: ConditionContext): LegacyConditionContext {
  return {
    name: context.name,
    version: context.version,
    corgi: context.candidate,
    manifest: context.manifest,
    registry: context.registry,
  }
}

function legacyCondition(condition: Condition): LegacyCondition {
  return {
    kind: condition.kind,
    cost: condition.cost,
    evaluate(context) {
      return condition.evaluate({
        name: context.name,
        version: context.version,
        candidate: context.corgi,
        manifest: context.manifest,
        registry: context.registry,
      })
    },
  }
}

function publicCondition(condition: LegacyCondition): Condition {
  return Object.freeze({
    kind: condition.kind,
    cost: condition.cost,
    evaluate: (context: ConditionContext) => condition.evaluate(legacyContext(context)),
  })
}

export function engines(
  required: Readonly<Record<string, string>>,
  options?: Readonly<{ mode?: 'lenient' | 'strict' }>,
): Condition {
  return publicCondition(legacyEngines({ ...required }, options))
}

export function license(options: Readonly<{
  allow?: readonly string[]
  deny?: readonly string[]
}>): Condition {
  return publicCondition(legacyLicense(options))
}

export async function selectConstrained(
  name: string,
  range: string,
  options: SelectConstrainedOptions,
): Promise<SelectConstrainedResult> {
  const result = await legacySelectConstrained(
    options.registry,
    name,
    range,
    options.conditions.map(legacyCondition),
    options.onUnevaluable ?? 'reject',
  )
  return Object.freeze({
    ...(result.selected === undefined ? {} : { selected: result.selected }),
    rejected: Object.freeze(result.rejected.map(candidate => Object.freeze({
      name,
      version: candidate.version,
      condition: candidate.by,
      ...(candidate.reason === undefined ? {} : { reason: candidate.reason }),
    }))),
  })
}

export interface CompleteOptions extends OperationOptions {
  readonly seed?: GraphFrontier
  readonly pruneOrphans?: boolean
  readonly resolution?: ResolutionStrategy
  readonly overrides?: readonly OverrideConstraint[]
  readonly constraints?: readonly Condition[]
  readonly onUnevaluable?: OnUnevaluable
  readonly budget?: CompletionBudget
}

export interface CompleteResult extends GraphOperationResult {
  readonly added: readonly NodeId[]
  readonly wired: readonly EdgeTriple[]
  readonly removed: readonly NodeId[]
}

function operationRegistry(graph: Graph, options: CompleteOptions): RegistryAdapter {
  const registries = options.sources?.packuments ?? []
  if (registries.length === 0) return frozenRegistry(graph)
  if (registries.length === 1) return registries[0]!

  const first = async <Value>(
    read: (registry: RegistryAdapter) => Promise<Value | undefined>,
  ): Promise<Value | undefined> => {
    for (const registry of registries) {
      const value = await read(registry)
      if (value !== undefined) return value
    }
    return undefined
  }
  return Object.freeze({
    packument: (name: string) => first(registry => registry.packument(name)),
    resolve: (name: string, range: string) => first(registry => registry.resolve(name, range)),
    manifest: (name: string, version: string) => first(registry =>
      registry.manifest?.(name, version) ?? Promise.resolve(undefined)),
  })
}

export async function complete(
  graph: Graph,
  options: CompleteOptions,
): Promise<CompleteResult> {
  const registry = operationRegistry(graph, options)
  const target = targetRequestOf(options.target)
  const result = await completeTransitives(graph, registry, {
    ...(options.seed === undefined ? {} : {
      seed: {
        recentlyAdded: new Set(options.seed.added),
        recentlyOrphaned: new Set(options.seed.orphaned),
      },
    }),
    onDiagnostic: options.onDiagnostic,
    resolution: options.resolution,
    overrides: options.overrides,
    constraints: options.constraints?.map(legacyCondition),
    onUnevaluable: options.onUnevaluable,
    budget: options.budget,
    descriptorBindings: descriptorBindingsForTarget(graph, target.format),
    packageVariants: packageVariantBindingsForTarget(graph, target.format),
  })
  let completed = result.graph
  const diagnostics = [...result.unresolved]
  let removed: readonly NodeId[] = []

  if (options.pruneOrphans === true && options.seed !== undefined) {
    const pruned = pruneOrphans(completed, {
      seed: options.seed.orphaned,
      onDiagnostic: options.onDiagnostic,
    })
    completed = pruned.graph
    diagnostics.push(...pruned.unresolved)
    removed = pruned.removed
  }

  return Object.freeze({
    graph: completed,
    diagnostics: Object.freeze(diagnostics),
    added: Object.freeze([...result.added]),
    wired: Object.freeze([...result.wired]),
    removed: Object.freeze([...removed]),
  })
}

export type { CompletionBudget, OnUnevaluable }
