import type { Diagnostic, Graph, OverrideConstraint } from '../graph.ts'
import { projectOverrides } from '../recipe/overrides.ts'
import { internalEvidenceOf } from './evidence.ts'
import { authoritativePolicyOverridesOf, completenessOf } from './profile.ts'
import { targetProfileOf } from './targets.ts'
import type {
  CompanionSetOperation,
  ProjectCompanionOptions,
  ProjectCompanionResult,
  RequirementAssessment,
  RequirementStatus,
  TargetProfile,
} from './types.ts'

// === CONSTANTS ==============================================================

const emptyWorkspaceNames: ReadonlyMap<string, string> = new Map()

// === TYPES ==================================================================

interface CompanionProjectionPlan {
  readonly status: RequirementStatus
  readonly patches: readonly CompanionSetOperation[]
  readonly diagnostics: readonly Diagnostic[]
  readonly target: TargetProfile
  readonly pnpmWorkspaceNames: ReadonlyMap<string, string>
}

// === API ====================================================================

export function companionProjectionRuntime(
  graph: Graph,
  options: ProjectCompanionOptions,
): {
  readonly result: ProjectCompanionResult
  readonly policyRequirement: RequirementAssessment
  readonly pnpmWorkspaceNames: ReadonlyMap<string, string>
} {
  const plan = projectCompanionPlan(graph, options)
  const requirement = requirementOf(plan, 'target:companion-projection')
  return Object.freeze({
    result: Object.freeze({
      ...(plan.status === 'satisfied' ? { patches: plan.patches } : {}),
      requirement,
      target: plan.target,
      diagnostics: plan.diagnostics,
    }),
    policyRequirement: requirementOf(plan, 'target:resolution-policy'),
    pnpmWorkspaceNames: plan.pnpmWorkspaceNames,
  })
}

export function projectCompanionsOf(
  graph: Graph,
  options: ProjectCompanionOptions,
): ProjectCompanionResult {
  return companionProjectionRuntime(graph, options).result
}

// === INTERNALS ==============================================================

function diagnostic(code: string, message: string, data?: Readonly<Record<string, unknown>>): Diagnostic {
  return Object.freeze({
    code,
    severity: 'warning',
    message,
    ...(data === undefined ? {} : { data: Object.freeze({ ...data }) }),
  })
}

function operation(
  path: CompanionSetOperation['path'],
  pointer: string,
  value: Record<string, unknown>,
): CompanionSetOperation {
  return Object.freeze({
    path,
    op: 'set',
    pointer,
    value: freezeRecord(value),
  })
}

function freezeRecord(value: Record<string, unknown>): Readonly<Record<string, unknown>> {
  const copy: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    copy[key] = item !== null && typeof item === 'object' && !Array.isArray(item)
      ? freezeRecord(item as Record<string, unknown>)
      : item
  }
  return Object.freeze(copy)
}

function requirementOf(plan: CompanionProjectionPlan, key: string): RequirementAssessment {
  return Object.freeze({
    key,
    status: plan.status,
    dimension: 'resolutionPolicy',
    diagnostics: plan.diagnostics,
  })
}

function failedPlan(
  target: TargetProfile,
  status: Exclude<RequirementStatus, 'satisfied'>,
  diagnostics: readonly Diagnostic[],
  pnpmWorkspaceNames: ReadonlyMap<string, string> = emptyWorkspaceNames,
): CompanionProjectionPlan {
  return Object.freeze({
    status,
    patches: Object.freeze([]),
    diagnostics: Object.freeze([...diagnostics]),
    target,
    pnpmWorkspaceNames,
  })
}

function pnpmWorkspaceNamesOf(
  graph: Graph,
  state: ReturnType<typeof internalEvidenceOf>,
): ReadonlyMap<string, string> {
  const names = new Map<string, string>()
  if (state.repositoryManifests?.coverage !== 'complete') return names
  for (const node of graph.nodes()) {
    if (node.workspacePath === undefined) continue
    const manifest = state.repositoryManifests.manifests[node.workspacePath]
      ?? (node.workspacePath === '' ? state.repositoryManifests.manifests['.'] : undefined)
    if (manifest?.name !== undefined) names.set(node.id, manifest.name)
  }
  return names
}

function projectedRecord(
  canonical: readonly OverrideConstraint[],
  manager: 'npm' | 'pnpm' | 'bun',
): { value?: Record<string, unknown>; diagnostics: readonly Diagnostic[] } {
  const diagnostics: Diagnostic[] = []
  const value = projectOverrides(canonical, manager, item => diagnostics.push(item))
  if (manager === 'bun' && canonical.some(item => item.selfRef === true)) {
    diagnostics.push(diagnostic(
      'COMPLETENESS_OVERRIDE_GRAMMAR_UNSUPPORTED',
      'bun overrides cannot represent package-manager self references',
    ))
  }
  return diagnostics.length === 0
    ? { value, diagnostics: Object.freeze([]) }
    : { diagnostics: Object.freeze(diagnostics) }
}

function yarnSelector(
  constraint: OverrideConstraint,
  target: TargetProfile,
): { selector?: string; diagnostic?: Diagnostic } {
  if (constraint.selfRef === true) {
    return { diagnostic: diagnostic(
      'COMPLETENESS_OVERRIDE_GRAMMAR_UNSUPPORTED',
      'yarn resolutions cannot represent package-manager self references',
    ) }
  }
  if (target.format === 'yarn-classic' && constraint.versionCondition !== undefined) {
    return { diagnostic: diagnostic(
      'COMPLETENESS_OVERRIDE_GRAMMAR_UNSUPPORTED',
      'yarn classic resolutions cannot predicate on the dependency descriptor range',
      { package: constraint.package },
    ) }
  }
  const leaf = constraint.versionCondition === undefined
    ? constraint.package
    : `${constraint.package}@${constraint.versionCondition.includes(':')
      ? constraint.versionCondition
      : `npm:${constraint.versionCondition}`}`
  const parents = constraint.parentPath ?? []
  if (target.format !== 'yarn-classic' && parents.length > 1) {
    return { diagnostic: diagnostic(
      'COMPLETENESS_OVERRIDE_GRAMMAR_UNSUPPORTED',
      'yarn berry resolutions support at most one parent selector',
      { package: constraint.package, depth: parents.length },
    ) }
  }
  if (target.format !== 'yarn-classic' && parents.length > 0
    && constraint.versionCondition !== undefined) {
    return { diagnostic: diagnostic(
      'COMPLETENESS_OVERRIDE_GRAMMAR_UNSUPPORTED',
      'yarn berry cannot combine a parent selector with a child descriptor condition',
      { package: constraint.package },
    ) }
  }
  if (parents.length === 0) return { selector: leaf }
  return {
    selector: target.format === 'yarn-classic'
      ? `**/${[...parents, leaf].join('/')}`
      : `${parents[0]}/${leaf}`,
  }
}

function projectYarn(
  graph: Graph,
  canonical: readonly OverrideConstraint[],
  target: TargetProfile,
): { value?: Record<string, unknown>; diagnostics: readonly Diagnostic[] } {
  const value: Record<string, unknown> = {}
  const diagnostics: Diagnostic[] = []
  for (const constraint of canonical) {
    if (target.format === 'yarn-classic' && (constraint.parentPath?.length ?? 0) === 0) {
      const direct = [...graph.nodes()].some(node => node.workspacePath !== undefined
        && graph.out(node.id).some(edge => {
          const targetNode = graph.getNode(edge.dst)
          return (edge.attrs?.alias ?? targetNode?.name) === constraint.package
        }))
      if (direct) {
        diagnostics.push(diagnostic(
          'COMPLETENESS_OVERRIDE_GRAMMAR_UNSUPPORTED',
          'yarn classic resolutions cannot override direct project dependencies',
          { package: constraint.package },
        ))
        continue
      }
    }
    const projected = yarnSelector(constraint, target)
    if (projected.diagnostic !== undefined) {
      diagnostics.push(projected.diagnostic)
      continue
    }
    const selector = projected.selector!
    const existing = value[selector]
    if (existing !== undefined && existing !== constraint.to) {
      diagnostics.push(diagnostic(
        'COMPLETENESS_OVERRIDE_PROJECTION_CONFLICT',
        'multiple canonical overrides project to the same yarn resolution selector',
        { selector },
      ))
      continue
    }
    value[selector] = constraint.to
  }
  return diagnostics.length === 0
    ? { value, diagnostics: Object.freeze([]) }
    : { diagnostics: Object.freeze(diagnostics) }
}

function projectCompanionPlan(
  graph: Graph,
  options: ProjectCompanionOptions,
): CompanionProjectionPlan {
  const target = targetProfileOf(options.target)
  const completeness = completenessOf(graph, { evidence: options.evidence })
  const state = internalEvidenceOf(completeness.evidence)
  const pnpmWorkspaceNames = target.manager === 'pnpm'
    ? pnpmWorkspaceNamesOf(graph, state)
    : emptyWorkspaceNames
  if (completeness.profile.resolutionPolicy !== 'authored') {
    return failedPlan(target, 'unassessed', [diagnostic(
      'COMPLETENESS_POLICY_AUTHORITY_REQUIRED',
      'authored resolution policy evidence is required to project companion files',
    )], pnpmWorkspaceNames)
  }
  const canonical = authoritativePolicyOverridesOf(state)
  if (canonical === undefined) {
    return failedPlan(target, 'unassessed', [diagnostic(
      'COMPLETENESS_POLICY_AUTHORITY_REQUIRED',
      'authoritative resolution policy could not be selected',
    )], pnpmWorkspaceNames)
  }
  if (canonical.length === 0) {
    return Object.freeze({
      status: 'satisfied',
      patches: Object.freeze([]),
      diagnostics: Object.freeze([]),
      target,
      pnpmWorkspaceNames,
    })
  }
  const ambiguous = ['overridesConfigLocation', 'overridesGrammar'] as const
  const unresolved = ambiguous.filter(capability => target.ambiguousCapabilities.has(capability))
  if (unresolved.length > 0) {
    return failedPlan(target, 'unassessed', [diagnostic(
      'COMPLETENESS_TARGET_CAPABILITY_AMBIGUOUS',
      'target manager version is required to project companion policy',
      { capabilities: unresolved },
    )], pnpmWorkspaceNames)
  }
  if (target.capabilities.overridesConfigLocation === 'none'
    || target.capabilities.overridesGrammar === 'none') {
    return failedPlan(target, 'unsatisfied', [diagnostic(
      'COMPLETENESS_TARGET_FEATURE_UNSUPPORTED',
      'target has no modeled override authority surface',
      { target: target.format },
    )], pnpmWorkspaceNames)
  }

  const projected = target.manager === 'yarn'
    ? projectYarn(graph, canonical, target)
    : target.manager === 'npm'
      ? projectedRecord(canonical, 'npm')
      : target.manager === 'pnpm'
        ? projectedRecord(canonical, 'pnpm')
        : target.manager === 'bun'
          ? projectedRecord(canonical, 'bun')
          : { diagnostics: Object.freeze([diagnostic(
              'COMPLETENESS_TARGET_FEATURE_UNSUPPORTED',
              'target has no companion override projection',
              { target: target.format },
            )]) }
  if (projected.value === undefined) {
    return failedPlan(target, 'unsatisfied', projected.diagnostics, pnpmWorkspaceNames)
  }

  let patch: CompanionSetOperation
  if (target.manager === 'npm' || target.manager === 'bun') {
    patch = operation('package.json', '/overrides', projected.value)
  } else if (target.manager === 'yarn') {
    patch = operation('package.json', '/resolutions', projected.value)
  } else if (target.capabilities.overridesConfigLocation === 'workspace-yaml') {
    patch = operation('pnpm-workspace.yaml', '/overrides', projected.value)
  } else {
    patch = operation('package.json', '/pnpm/overrides', projected.value)
  }
  return Object.freeze({
    status: 'satisfied',
    patches: Object.freeze([patch]),
    diagnostics: Object.freeze([]),
    target,
    pnpmWorkspaceNames,
  })
}
