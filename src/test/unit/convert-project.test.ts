import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  convertProject,
  evidenceOf,
  parse,
  stringifyAssessed,
  withEvidence,
  type ConvertProjectOptions,
  type TargetOracleEvidence,
} from '../../main/ts/index.ts'
import type { Manifest } from '../../main/ts/graph.ts'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = (group: string, file: string): string =>
  readFileSync(resolve(here, `../resources/fixtures/lockfiles/${group}/${file}`), 'utf8')

const repositoryManifests: Record<string, Manifest> = {
  '': {
    name: 'case-simple',
    version: '0.0.0',
    dependencies: { lodash: '4.17.21', ms: '2.1.3' },
    overrides: [],
  },
}

const packageManifests = {
  kind: 'package-manifests' as const,
  authority: 'version-manifest' as const,
  manifests: {
    'lodash@4.17.21': { name: 'lodash', version: '4.17.21' },
    'ms@2.1.3': { name: 'ms', version: '2.1.3' },
  },
}

describe('convertProject', () => {
  it('returns one immutable satisfied npm project bundle', () => {
    const input = fixture('simple', 'npm-3.lock')
    const result = convertProject(input, {
      from: 'npm-3',
      to: 'npm-3',
      targetVersion: '9.9.4',
      manifestCoverage: 'complete',
      manifests: repositoryManifests,
      evidenceInputs: [packageManifests],
    })

    expect(result.assessment.status).toBe('satisfied')
    expect(result.lockfile).toBeTypeOf('string')
    expect(result.companions).toEqual([])
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.companions)).toBe(true)

    const graph = parse('npm-3', input, { manifests: repositoryManifests })
    let evidence = withEvidence(evidenceOf(graph), {
      kind: 'repository-manifests',
      coverage: 'complete',
      manifests: repositoryManifests,
    })
    evidence = withEvidence(evidence, packageManifests)
    const assessed = stringifyAssessed(graph, {
      contract: 'project',
      target: { format: 'npm-3', managerVersion: '9.9.4' },
      evidence,
    })
    expect(result.lockfile).toBe(assessed.output)
  })

  it('returns the same authored pnpm policy in the companion and lock carrier', () => {
    const input = fixture('simple', 'pnpm-v9.lock').replace(
      "lockfileVersion: '9.0'\n",
      "lockfileVersion: '9.0'\n\noverrides:\n  foo: 2.0.0\n",
    )
    const result = convertProject(input, {
      from: 'pnpm-v9',
      to: 'pnpm-v9',
      sourceVersion: '10.0.0',
      targetVersion: '10.0.0',
      manifestCoverage: 'complete',
      manifests: repositoryManifests,
      evidenceInputs: [{
        kind: 'pm-config',
        manager: 'pnpm',
        version: '10.0.0',
        source: 'package.json',
        surface: 'overrides',
        coverage: 'complete',
        overrides: [{ package: 'foo', to: '2.0.0' }],
      }, packageManifests],
    })

    expect(result.assessment.status).toBe('satisfied')
    expect(result.companions).toEqual([{
      path: 'package.json',
      op: 'set',
      pointer: '/pnpm/overrides',
      value: { foo: '2.0.0' },
    }])
    expect(result.lockfile).toMatch(/overrides:\n  foo: 2\.0\.0/)
    expect(Object.isFrozen(result.companions![0])).toBe(true)
    expect(Object.isFrozen(result.companions![0]!.value)).toBe(true)
    expect(result.assessment.requirements).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'target:resolution-policy', status: 'satisfied' }),
      expect.objectContaining({ key: 'target:companion-projection', status: 'satisfied' }),
    ]))
  })

  it('returns neither artifact when package metadata is incomplete', () => {
    const result = convertProject(fixture('simple', 'npm-3.lock'), {
      from: 'npm-3',
      to: 'npm-3',
      targetVersion: '9.9.4',
      manifestCoverage: 'complete',
      manifests: repositoryManifests,
    })

    expect(result.assessment.status).toBe('unassessed')
    expect(result.lockfile).toBeUndefined()
    expect(result.companions).toBeUndefined()
  })

  it('returns neither artifact for an ambiguous target or lossy companion grammar', () => {
    const ambiguous = convertProject(fixture('simple', 'pnpm-v9.lock'), {
      from: 'pnpm-v9',
      to: 'pnpm-v9',
      manifestCoverage: 'complete',
      manifests: {
        '': { ...repositoryManifests[''], overrides: [{ package: 'foo', to: '2.0.0' }] },
      },
      evidenceInputs: [packageManifests],
    })
    expect(ambiguous.assessment.status).toBe('unassessed')
    expect(ambiguous.lockfile).toBeUndefined()
    expect(ambiguous.companions).toBeUndefined()

    const lossy = convertProject(fixture('simple', 'npm-3.lock'), {
      from: 'npm-3',
      to: 'yarn-classic',
      targetVersion: '1.22.22',
      manifestCoverage: 'complete',
      manifests: {
        '': { ...repositoryManifests[''], overrides: [{ package: 'lodash', to: '4.17.20' }] },
      },
      evidenceInputs: [packageManifests],
    })
    expect(lossy.assessment.status).toBe('unsatisfied')
    expect(lossy.lockfile).toBeUndefined()
    expect(lossy.companions).toBeUndefined()
  })

  it('fails closed on conflicting repository authority', () => {
    const result = convertProject(fixture('simple', 'npm-3.lock'), {
      from: 'npm-3',
      to: 'npm-3',
      targetVersion: '9.9.4',
      manifestCoverage: 'complete',
      manifests: repositoryManifests,
      evidenceInputs: [
        {
          kind: 'repository-manifests',
          coverage: 'complete',
          manifests: {
            '': { ...repositoryManifests[''], overrides: [{ package: 'foo', to: '2.0.0' }] },
          },
        },
        packageManifests,
      ],
    })

    expect(result.assessment.status).not.toBe('satisfied')
    expect(result.lockfile).toBeUndefined()
    expect(result.companions).toBeUndefined()
    expect(result.assessment.diagnostics).toContainEqual(expect.objectContaining({
      code: 'COMPLETENESS_EVIDENCE_CONFLICT',
    }))
  })

  it('returns a structured rejection for invalid evidence and source input', () => {
    const invalidEvidence = convertProject(fixture('simple', 'npm-3.lock'), {
      from: 'npm-3',
      to: 'npm-3',
      evidenceInputs: [{ kind: 'package-manifests', authority: 'unknown' } as never],
    })
    expect(invalidEvidence.assessment.status).toBe('unsatisfied')
    expect(invalidEvidence.assessment.diagnostics).toContainEqual(expect.objectContaining({
      code: 'COMPLETENESS_EVIDENCE_INVALID',
    }))

    const invalidSource = convertProject('not a lockfile', { to: 'npm-3' })
    expect(invalidSource.assessment.status).toBe('unsatisfied')
    expect(invalidSource.assessment.diagnostics).toContainEqual(expect.objectContaining({
      code: 'COMPLETENESS_SOURCE_FORMAT_UNKNOWN',
    }))
  })

  it('keeps a non-registry graph outside the project bundle', () => {
    const result = convertProject(fixture('git-github-tarball', 'npm-3.lock'), {
      from: 'npm-3',
      to: 'npm-3',
      targetVersion: '9.9.4',
      manifestCoverage: 'complete',
      manifests: {
        '': {
          name: 'case-git-github-tarball',
          version: '0.0.0',
          dependencies: {
            'is-git': 'git+https://github.com/sindresorhus/is.git#v6.3.1',
            'is-github': 'github:sindresorhus/is#v6.3.1',
            'ms-tarball': 'https://registry.npmjs.org/ms/-/ms-2.1.3.tgz',
          },
          overrides: [],
        },
      },
      evidenceInputs: [{
        kind: 'package-manifests',
        authority: 'version-manifest',
        manifests: {
          '@sindresorhus/is@6.3.1': {
            name: '@sindresorhus/is',
            version: '6.3.1',
            license: 'MIT',
            engines: { node: '>=16' },
            funding: { url: 'https://github.com/sindresorhus/is?sponsor=1' },
          },
          'ms@2.1.3': { name: 'ms', version: '2.1.3', license: 'MIT' },
        },
      }],
    })

    expect(result.assessment.status).toBe('unassessed')
    expect(result.lockfile).toBeUndefined()
    expect(result.companions).toBeUndefined()
    expect(result.assessment.diagnostics).toContainEqual(expect.objectContaining({
      code: 'COMPLETENESS_PACKAGE_METADATA_SOURCE_UNSUPPORTED',
    }))
  })

  it('excludes graph-scoped target oracles from pre-parse evidence inputs', () => {
    const graph = parse('npm-3', fixture('simple', 'npm-3.lock'))
    const oracle: TargetOracleEvidence = {
      kind: 'target-oracle',
      graph,
      target: { format: 'npm-3', managerVersion: '9.9.4' },
      verification: 'frozen-verified',
      platform: 'linux-x64',
      configDigest: 'config',
      inputDigest: 'input',
    }
    // @ts-expect-error target oracles are graph-scoped and cannot be supplied before parsing
    const options: ConvertProjectOptions = { to: 'npm-3', evidenceInputs: [oracle] }
    expect(options.evidenceInputs).toEqual([oracle])
  })
})
