import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  evidenceOf,
  parse,
  projectCompanionsOf,
  stringify,
  stringifyAssessed,
  withEvidence,
  type EvidenceContext,
} from '../../main/ts/index.ts'
import type { Graph, OverrideConstraint } from '../../main/ts/graph.ts'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = (file: string): string =>
  readFileSync(resolve(here, '../resources/fixtures/lockfiles/simple', file), 'utf8')

function authored(overrides: readonly OverrideConstraint[]): { graph: Graph; evidence: EvidenceContext } {
  const graph = parse('npm-3', fixture('npm-3.lock'))
  const evidence = withEvidence(evidenceOf(graph), {
    kind: 'repository-manifests',
    coverage: 'complete',
    manifests: {
      '': {
        name: 'case-simple',
        version: '0.0.0',
        dependencies: { lodash: '4.17.21', ms: '2.1.3' },
        overrides: [...overrides],
      },
    },
  })
  return { graph, evidence }
}

describe('projectCompanionsOf', () => {
  it.each([
    [
      'npm',
      { format: 'npm-3' as const, managerVersion: '11.0.0' },
      { path: 'package.json', op: 'set', pointer: '/overrides', value: { foo: '2.0.0' } },
    ],
    [
      'yarn classic',
      { format: 'yarn-classic' as const, managerVersion: '1.22.22' },
      { path: 'package.json', op: 'set', pointer: '/resolutions', value: { foo: '2.0.0' } },
    ],
    [
      'yarn berry',
      { format: 'yarn-berry-v9' as const, managerVersion: '4.14.0' },
      { path: 'package.json', op: 'set', pointer: '/resolutions', value: { foo: '2.0.0' } },
    ],
    [
      'pnpm 10',
      { format: 'pnpm-v9' as const, managerVersion: '10.0.0' },
      { path: 'package.json', op: 'set', pointer: '/pnpm/overrides', value: { foo: '2.0.0' } },
    ],
    [
      'pnpm 11',
      { format: 'pnpm-v9' as const, managerVersion: '11.0.0' },
      { path: 'pnpm-workspace.yaml', op: 'set', pointer: '/overrides', value: { foo: '2.0.0' } },
    ],
    [
      'bun',
      { format: 'bun-text' as const, managerVersion: '1.2.0' },
      { path: 'package.json', op: 'set', pointer: '/overrides', value: { foo: '2.0.0' } },
    ],
  ])('projects an exact %s companion operation', (_label, target, expected) => {
    const { graph, evidence } = authored([{ package: 'foo', to: '2.0.0' }])
    const result = projectCompanionsOf(graph, { target, evidence })

    expect(result.requirement.status).toBe('satisfied')
    expect(result.patches).toEqual([expected])
    expect(Object.isFrozen(result.patches)).toBe(true)
    expect(Object.isFrozen(result.patches![0]!.value)).toBe(true)
  })

  it('returns an empty proven plan for authoritative policy absence', () => {
    const { graph, evidence } = authored([])
    const result = projectCompanionsOf(graph, {
      target: { format: 'npm-3', managerVersion: '11.0.0' },
      evidence,
    })

    expect(result.requirement.status).toBe('satisfied')
    expect(result.patches).toEqual([])
  })

  it('does not require a target version when authoritative policy is absent', () => {
    const { graph, evidence } = authored([])
    const result = projectCompanionsOf(graph, {
      target: { format: 'pnpm-v9' },
      evidence,
    })

    expect(result.requirement.status).toBe('satisfied')
    expect(result.patches).toEqual([])
  })

  it('freezes nested npm projection values', () => {
    const { graph, evidence } = authored([
      { package: 'child', parentPath: ['parent'], to: '2.0.0' },
    ])
    const result = projectCompanionsOf(graph, {
      target: { format: 'npm-3', managerVersion: '11.0.0' },
      evidence,
    })

    expect(result.patches![0]!.value).toEqual({ parent: { child: '2.0.0' } })
    expect(Object.isFrozen(result.patches![0]!.value.parent)).toBe(true)
  })

  it('renders yarn berry descriptor conditions with an explicit protocol', () => {
    const { graph, evidence } = authored([
      { package: 'foo', versionCondition: '^1', to: '2.0.0' },
    ])
    const result = projectCompanionsOf(graph, {
      target: { format: 'yarn-berry-v9', managerVersion: '4.14.0' },
      evidence,
    })

    expect(result.patches![0]!.value).toEqual({ 'foo@npm:^1': '2.0.0' })
  })

  it('requires a target version when the companion location is ambiguous', () => {
    const { graph, evidence } = authored([{ package: 'foo', to: '2.0.0' }])
    const result = projectCompanionsOf(graph, {
      target: { format: 'pnpm-v9' },
      evidence,
    })

    expect(result.requirement.status).toBe('unassessed')
    expect(result.patches).toBeUndefined()
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: 'COMPLETENESS_TARGET_CAPABILITY_AMBIGUOUS',
    }))
  })

  it.each([
    [
      'bun nested scope',
      { format: 'bun-text' as const, managerVersion: '1.2.0' },
      { package: 'foo', parentPath: ['parent'], to: '2.0.0' },
    ],
    [
      'yarn classic descriptor condition',
      { format: 'yarn-classic' as const, managerVersion: '1.22.22' },
      { package: 'foo', versionCondition: '^1', to: '2.0.0' },
    ],
    [
      'yarn berry deep parent scope',
      { format: 'yarn-berry-v9' as const, managerVersion: '4.14.0' },
      { package: 'foo', parentPath: ['a', 'b'], to: '2.0.0' },
    ],
    [
      'yarn self reference',
      { format: 'yarn-berry-v9' as const, managerVersion: '4.14.0' },
      { package: 'foo', to: '$bar', selfRef: true },
    ],
    [
      'yarn classic direct dependency',
      { format: 'yarn-classic' as const, managerVersion: '1.22.22' },
      { package: 'lodash', to: '4.17.20' },
    ],
  ])('fails closed for %s', (_label, target, override) => {
    const { graph, evidence } = authored([override])
    const result = projectCompanionsOf(graph, { target, evidence })

    expect(result.requirement.status).toBe('unsatisfied')
    expect(result.patches).toBeUndefined()
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: expect.stringMatching(/^COMPLETENESS_|^BUN_/),
    }))
  })

  it('uses one exact authority for pnpm companion and lock carrier projection', () => {
    const input = fixture('pnpm-v9.lock').replace(
      "lockfileVersion: '9.0'\n",
      "lockfileVersion: '9.0'\n\noverrides:\n  foo: 2.0.0\n",
    )
    const graph = parse('pnpm-v9', input)
    let evidence = withEvidence(evidenceOf(graph), {
      kind: 'repository-manifests',
      coverage: 'complete',
      manifests: { '': { overrides: [] } },
    })
    evidence = withEvidence(evidence, {
      kind: 'pm-config',
      manager: 'pnpm',
      version: '10.0.0',
      source: 'package.json',
      surface: 'overrides',
      coverage: 'complete',
      overrides: [{ package: 'foo', to: '2.0.0' }],
    })
    const companion = projectCompanionsOf(graph, {
      target: { format: 'pnpm-v9', managerVersion: '10.0.0' },
      evidence,
    })
    const assessed = stringifyAssessed(graph, {
      contract: 'policy',
      target: { format: 'pnpm-v9', managerVersion: '10.0.0' },
      evidence,
    })

    expect(companion.patches![0]!.value).toEqual({ foo: '2.0.0' })
    expect(assessed.assessment.status).toBe('satisfied')
    expect(assessed.output).toMatch(/overrides:\n  foo: 2\.0\.0/)
  })

  it.each([
    [
      'pnpm-v5' as const,
      'pnpm-v5.lock',
      'lodash: 4.17.20',
      'lodash: 4.17.21',
      /specifiers:\n  lodash: 4\.17\.20/,
    ],
    [
      'pnpm-v6' as const,
      'pnpm-v6.lock',
      'specifier: 4.17.20',
      'specifier: 4.17.21',
      /dependencies:\n  lodash:\n    specifier: 4\.17\.20/,
    ],
    [
      'pnpm-v9' as const,
      'pnpm-v9.lock',
      'specifier: 4.17.20',
      'specifier: 4.17.21',
      /dependencies:\n      lodash:\n        specifier: 4\.17\.20/,
    ],
  ])('projects direct override specifiers for %s', (format, file, marker, declared, expected) => {
    const input = fixture(file)
      .replaceAll('4.17.21', '4.17.20')
      .replace(marker, declared)
    const graph = parse(format, input)
    const output = stringify(format, graph, {
      overrides: [{ package: 'lodash', to: '4.17.20' }],
    })

    expect(output).toMatch(expected)
  })

  it('closes only the companion gate for a deferred project assessment', () => {
    const { graph, evidence } = authored([{ package: 'foo', to: '2.0.0' }])
    const assessed = stringifyAssessed(graph, {
      contract: 'project',
      target: { format: 'npm-3', managerVersion: '11.0.0' },
      evidence,
    })

    expect(assessed.output).toBeUndefined()
    expect(assessed.assessment.status).toBe('unassessed')
    expect(assessed.assessment.requirements).toContainEqual(expect.objectContaining({
      key: 'target:companion-projection',
      status: 'satisfied',
    }))
    expect(assessed.assessment.requirements).toContainEqual(expect.objectContaining({
      key: 'canonical:package-metadata',
      status: 'unassessed',
    }))
  })
})
