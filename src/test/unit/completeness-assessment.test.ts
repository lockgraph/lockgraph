import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  convertAssessed,
  evidenceOf,
  parse,
  stringify,
  stringifyAssessed,
  withEvidence,
} from '../../main/ts/index.ts'
import { newBuilder, type Edge, type Graph, type Node, type TarballPayload } from '../../main/ts/graph.ts'
import { assessConversion } from '../../main/ts/completeness/assessment.ts'
import { detectGraphFeatures } from '../../main/ts/completeness/features.ts'
import { targetProfileOf } from '../../main/ts/completeness/targets.ts'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = (file: string): string =>
  readFileSync(resolve(here, '../resources/fixtures/lockfiles/simple', file), 'utf8')

describe('targetProfileOf', () => {
  it('derives managers and keeps load-bearing unknown versions ambiguous', () => {
    expect(targetProfileOf({ format: 'npm-3' }).manager).toBe('npm')
    expect(targetProfileOf({ format: 'yarn-berry-v9' }).manager).toBe('yarn')
    expect(targetProfileOf({ format: 'pnpm-v9' }).manager).toBe('pnpm')
    expect(targetProfileOf({ format: 'bun-text' }).manager).toBe('bun')
    expect(targetProfileOf({ format: 'lockgraph' }).manager).toBe('lockgraph')

    const pnpm = targetProfileOf({ format: 'pnpm-v9' })
    expect([...pnpm.ambiguousCapabilities]).toEqual(expect.arrayContaining([
      'catalogs',
      'overridesConfigLocation',
    ]))
  })

  it('gates target capabilities by exact compatible manager version', () => {
    expect(targetProfileOf({
      format: 'npm-2',
      managerVersion: '8.2.0',
    }).capabilities.overridesConfigLocation).toBe('none')
    expect(targetProfileOf({
      format: 'npm-2',
      managerVersion: '8.3.0',
    }).capabilities.overridesConfigLocation).toBe('manifest')
    expect(targetProfileOf({
      format: 'pnpm-v9',
      managerVersion: '11.0.0',
    }).capabilities.overridesConfigLocation).toBe('workspace-yaml')
    expect(() => targetProfileOf({
      format: 'pnpm-v9',
      managerVersion: '8.15.9',
    })).toThrowError('incompatible with pnpm-v9')
    expect(() => targetProfileOf({
      format: 'pnpm-v6',
      managerVersion: '7.33.7',
    })).toThrowError('incompatible with pnpm-v6')
    expect(targetProfileOf({ format: 'yarn-berry-v6' }).capabilities.catalogs).toBe(false)
    expect(targetProfileOf({ format: 'yarn-berry-v8' }).capabilities.catalogs).toBe(true)
  })
})

describe('graph feature default-deny', () => {
  const graphWith = (mutate: (parts: {
    node: Node
    edge: Edge
    payload: TarballPayload
  }) => void) => {
    const graph = parse('npm-3', fixture('npm-3.lock'))
    const node = [...graph.nodes()].find(candidate => candidate.workspacePath === undefined)!
    const root = [...graph.nodes()].find(candidate => candidate.workspacePath === '')!
    const edge = graph.out(root.id)[0]!
    const payload = graph.tarballOf(node.id)!
    mutate({ node, edge, payload })
    return graph
  }

  it.each([
    ['node', (parts: { node: Node }) => { Object.assign(parts.node, { futureNodeField: true }) }],
    ['edge', (parts: { edge: Edge }) => { Object.assign(parts.edge, { futureEdgeField: true }) }],
    ['edge attrs', (parts: { edge: Edge }) => { Object.assign(parts.edge.attrs!, { futureAttr: true }) }],
    ['tarball', (parts: { payload: TarballPayload }) => { Object.assign(parts.payload, { futurePayload: true }) }],
    ['resolution', (parts: { payload: TarballPayload }) => {
      Object.assign(parts.payload.resolution!, { futureResolutionField: true })
    }],
  ])('rejects an unknown %s key', (_label, mutate) => {
    const detection = detectGraphFeatures(graphWith(mutate as never))
    expect(detection.unmodeled).toContainEqual(expect.objectContaining({ reason: 'unknown-key' }))
  })

  it('rejects unknown closed-union values and sidecar keys', () => {
    const graph = graphWith(({ edge, payload }) => {
      Object.assign(edge, { kind: 'future-edge-kind' })
      Object.assign(payload.resolution!, { type: 'future-resolution' })
    })
    const detection = detectGraphFeatures(graph, {
      available: true,
      present: false,
      futureCatalogField: true,
    })

    expect(detection.unmodeled).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'edge.kind', reason: 'invalid-value' }),
      expect.objectContaining({ path: 'tarball.resolution.type', reason: 'invalid-value' }),
      expect.objectContaining({ path: 'sidecar.catalog.futureCatalogField', reason: 'unknown-key' }),
    ]))
  })

  it('rejects unknown nested, non-enumerable, and symbol keys', () => {
    const graph = graphWith(({ node, edge, payload }) => {
      Object.defineProperty(node, 'hiddenFutureField', { value: true })
      Object.assign(node, { [Symbol('future')]: true })
      Object.assign(edge.attrs!, {
        workspaceRange: { specifier: 'workspace:*', futureWorkspaceField: true },
      })
      payload.integrity = {
        hashes: [{ algorithm: 'sha512', digest: 'a', origin: 'sri', futureHashField: true }],
        futureIntegrityField: true,
      } as never
    })
    const paths = detectGraphFeatures(graph).unmodeled.map(fact => fact.path)

    expect(paths).toEqual(expect.arrayContaining([
      'node.hiddenFutureField',
      'node.Symbol(future)',
      'edge.attrs.workspaceRange.futureWorkspaceField',
      'tarball.integrity.futureIntegrityField',
      'tarball.integrity.hashes[0].futureHashField',
    ]))
  })

  it('fails closed for malformed graph iterators', () => {
    const malformed = {
      nodes: () => [null][Symbol.iterator](),
      out: () => [],
      tarballs: () => [][Symbol.iterator](),
    } as unknown as Graph

    expect(detectGraphFeatures(malformed).unmodeled).toContainEqual({
      subject: '<node>',
      path: 'node',
      reason: 'invalid-shape',
    })
  })

})

describe('sidecar feature attribution', () => {
  const berryWithCondition = (condition: string) => `__metadata:
  version: 8
  cacheKey: 10c0

"pkg@npm:1.0.0":
  version: 1.0.0
  resolution: "pkg@npm:1.0.0"
  conditions: ${condition}
  languageName: node
  linkType: hard
`

  const pnpmWithCatalog = (version: string) => fixture('pnpm-v9.lock').replace(
    "lockfileVersion: '9.0'\n",
    "lockfileVersion: '9.0'\n\ncatalogs:\n  default:\n    lodash:\n      specifier: ^4.17.21\n      version: " + version + '\n',
  )

  it('fingerprints complete Berry condition and pnpm catalog contents', () => {
    const berryA = detectGraphFeatures(parse('yarn-berry-v8', berryWithCondition('os=darwin')))
    const berryB = detectGraphFeatures(parse('yarn-berry-v8', berryWithCondition('os=linux')))
    const pnpmA = detectGraphFeatures(parse('pnpm-v9', pnpmWithCatalog('4.17.21')))
    const pnpmB = detectGraphFeatures(parse('pnpm-v9', pnpmWithCatalog('4.17.20')))

    expect(berryA.attribution.berryConditions.present).toBe(true)
    expect(berryA.attribution.berryConditions.fingerprint)
      .not.toBe(berryB.attribution.berryConditions.fingerprint)
    expect(pnpmA.attribution.pnpmCatalogs.present).toBe(true)
    expect(pnpmA.attribution.pnpmCatalogs.fingerprint)
      .not.toBe(pnpmB.attribution.pnpmCatalogs.fingerprint)
  })

  it.each([
    ['conditions', 'yarn-berry-v8' as const, berryWithCondition('os=darwin')],
    ['catalogs', 'pnpm-v9' as const, pnpmWithCatalog('4.17.21')],
  ])('blocks assessment when %s sidecar attribution is lost', (feature, format, input) => {
    const source = parse(format, input)
    const current = parse('lockgraph', stringify('lockgraph', source))
    const assessment = assessConversion(current, {
      contract: 'snapshot',
      target: { format },
      evidence: evidenceOf(source),
    }, { outputProbe: { accepted: true, diagnostics: [] } })

    expect(assessment.requirements).toContainEqual(expect.objectContaining({
      key: `source-sidecar:${feature}`,
      status: 'unassessed',
    }))
    expect(assessment.status).toBe('unassessed')
  })

  it('blocks current-only sidecar attribution against a condition-free source', () => {
    const source = parse('yarn-berry-v8', berryWithCondition('os=darwin').replace(
      '  conditions: os=darwin\n',
      '',
    ))
    const current = parse('yarn-berry-v8', berryWithCondition('os=darwin'))
    const assessment = assessConversion(current, {
      contract: 'snapshot',
      target: { format: 'yarn-berry-v8' },
      evidence: evidenceOf(source),
    }, { outputProbe: { accepted: true, diagnostics: [] } })

    expect(assessment.requirements).toContainEqual(expect.objectContaining({
      key: 'source-sidecar:conditions',
      status: 'unassessed',
    }))
  })
})

describe('assessConversion', () => {
  it('requires an output probe before reaching satisfied', () => {
    const graph = parse('npm-3', fixture('npm-3.lock'))
    const options = { contract: 'snapshot' as const, target: { format: 'npm-3' as const } }

    expect(assessConversion(graph, options).status).toBe('unassessed')
    expect(assessConversion(graph, options, {
      outputProbe: { accepted: true, diagnostics: [] },
    }).status).toBe('satisfied')
  })

  it('gives proven target incompatibility precedence over evidence gaps', () => {
    const builder = newBuilder()
    builder.addNode({
      id: 'root@1.0.0',
      name: 'root',
      version: '1.0.0',
      peerContext: [],
      workspacePath: '',
    })
    builder.addNode({ id: 'git-package@1.0.0', name: 'git-package', version: '1.0.0', peerContext: [] })
    builder.addEdge('root@1.0.0', 'git-package@1.0.0', 'bundled', { range: '1.0.0' })
    builder.setTarball({ name: 'git-package', version: '1.0.0' }, {
      resolution: { type: 'git', url: 'https://example.test/repo.git', sha: 'a'.repeat(40) },
    })

    const assessment = assessConversion(builder.seal(), {
      contract: 'snapshot',
      target: { format: 'pnpm-v6', managerVersion: '8.15.9' },
    }, { outputProbe: { accepted: true, diagnostics: [] } })
    expect(assessment.status).toBe('unsatisfied')
    expect(assessment.requirements).toContainEqual(expect.objectContaining({
      key: 'target-feature:edge:bundled',
      status: 'unsatisfied',
    }))
  })

  it('keeps project and frozen unassessed despite a high canonical profile', () => {
    const graph = parse('npm-3', fixture('npm-3.lock'))
    const evidence = withEvidence(evidenceOf(graph), {
      kind: 'repository-manifests',
      coverage: 'complete',
      manifests: {
        '': {
          name: 'case-simple',
          version: '0.0.0',
          dependencies: { lodash: '4.17.21', ms: '2.1.3' },
          overrides: [],
        },
      },
    })
    expect(assessConversion(graph, {
      contract: 'project',
      target: { format: 'npm-3', managerVersion: '11.0.0' },
      evidence,
    }, { outputProbe: { accepted: true, diagnostics: [] } }).status).toBe('unassessed')
    const oracle = withEvidence(evidence, {
      kind: 'target-oracle',
      graph,
      target: { format: 'npm-3', managerVersion: '11.0.0' },
      verification: 'frozen-verified',
      platform: 'linux-x64',
      configDigest: 'config-digest',
      inputDigest: 'input-digest',
    })
    expect(assessConversion(graph, {
      contract: 'frozen',
      target: { format: 'npm-3', managerVersion: '11.0.0' },
      evidence: oracle,
    }, { outputProbe: { accepted: true, diagnostics: [] } }).status).toBe('unassessed')
  })

  it('emits source generation ambiguity only for a policy-sensitive contract', () => {
    const graph = parse('pnpm-v5', fixture('pnpm-v5.lock'))
    expect(assessConversion(graph, {
      contract: 'snapshot',
      target: { format: 'pnpm-v5' },
    }).diagnostics.some(diagnostic =>
      diagnostic.code === 'COMPLETENESS_MANAGER_GENERATION_AMBIGUOUS')).toBe(false)
    expect(assessConversion(graph, {
      contract: 'policy',
      target: { format: 'pnpm-v5' },
    }).diagnostics.some(diagnostic =>
      diagnostic.code === 'COMPLETENESS_MANAGER_GENERATION_AMBIGUOUS')).toBe(true)
  })

  it('invalidates parse evidence after an in-place canonical graph mutation', () => {
    const graph = parse('npm-3', fixture('npm-3.lock'))
    const node = [...graph.nodes()].find(candidate => candidate.workspacePath === undefined)!
    node.version = '99.0.0'
    const assessment = assessConversion(graph, {
      contract: 'snapshot',
      target: { format: 'npm-3' },
    }, { outputProbe: { accepted: true, diagnostics: [] } })

    expect(assessment.status).toBe('unassessed')
    expect(assessment.diagnostics).toContainEqual(expect.objectContaining({
      code: 'COMPLETENESS_EVIDENCE_SCOPE_MISMATCH',
    }))
  })

  it('requires target config evidence to prove empty pnpm v11 policy', () => {
    const graph = parse('npm-3', fixture('npm-3.lock'))
    const evidence = withEvidence(evidenceOf(graph), {
      kind: 'repository-manifests',
      coverage: 'complete',
      manifests: { '': { name: 'case-simple', overrides: [] } },
    })
    const assessment = assessConversion(graph, {
      contract: 'policy',
      target: { format: 'pnpm-v9', managerVersion: '11.0.0' },
      evidence,
    }, { outputProbe: { accepted: true, diagnostics: [] } })

    expect(assessment.requirements).toContainEqual(expect.objectContaining({
      key: 'target:resolution-policy',
      status: 'unassessed',
    }))
  })
})

describe('assessed output APIs', () => {
  it('returns output only after a successful snapshot probe', () => {
    const graph = parse('npm-3', fixture('npm-3.lock'))
    const result = stringifyAssessed(graph, {
      contract: 'snapshot',
      target: { format: 'npm-3', managerVersion: '11.0.0' },
    })

    expect(result.assessment.status).toBe('satisfied')
    expect(result.output).toBeTypeOf('string')
  })

  it('preserves frozen-load-bearing npm payload fields in the output probe', () => {
    const input = fixture('npm-3.lock').replace(
      '"version": "4.17.21",',
      '"version": "4.17.21", "cpu": ["x64"], "os": ["linux"], "libc": ["glibc"], "hasInstallScript": true,',
    )
    const result = stringifyAssessed(parse('npm-3', input), {
      contract: 'snapshot',
      target: { format: 'npm-3', managerVersion: '11.0.0' },
    })

    expect(result.assessment.status).toBe('satisfied')
    expect(result.output).toContain('"hasInstallScript": true')
    expect(result.output).toContain('"libc"')
  })

  it('converts a supported snapshot and omits output for deferred project conversion', () => {
    const snapshot = convertAssessed(fixture('npm-3.lock'), {
      from: 'npm-3',
      to: 'npm-3',
      targetVersion: '11.0.0',
      contract: 'snapshot',
    })
    expect(snapshot.assessment.status).toBe('satisfied')
    expect(snapshot.output).toBeTypeOf('string')

    const project = convertAssessed(fixture('npm-3.lock'), {
      from: 'npm-3',
      to: 'npm-3',
      targetVersion: '11.0.0',
      contract: 'project',
      manifestCoverage: 'complete',
      manifests: {
        '': {
          name: 'case-simple',
          version: '0.0.0',
          dependencies: { lodash: '4.17.21', ms: '2.1.3' },
          overrides: [],
        },
      },
    })
    expect(project.assessment.status).toBe('unassessed')
    expect(project.output).toBeUndefined()
  })

  it('emits a policy-assessed pnpm lock only when carrier authority matches', () => {
    const input = fixture('pnpm-v9.lock').replace(
      "lockfileVersion: '9.0'\n",
      "lockfileVersion: '9.0'\n\noverrides:\n  foo: 1.0.0\n",
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
      version: '9.15.0',
      source: '.npmrc',
      surface: 'overrides',
      coverage: 'complete',
      overrides: [{ package: 'foo', to: '1.0.0' }],
    })
    const result = stringifyAssessed(graph, {
      contract: 'policy',
      target: { format: 'pnpm-v9', managerVersion: '9.15.0' },
      evidence,
    })

    expect(result.assessment.status).toBe('satisfied')
    expect(result.output).toContain('overrides:')
  })

  it('returns a structured rejection for an unknown source format', () => {
    const result = convertAssessed('not a lockfile', {
      to: 'npm-3',
      contract: 'snapshot',
    })

    expect(result.output).toBeUndefined()
    expect(result.assessment.status).toBe('unsatisfied')
    expect(result.assessment.diagnostics).toContainEqual(expect.objectContaining({
      code: 'COMPLETENESS_SOURCE_FORMAT_UNKNOWN',
    }))
  })
})
