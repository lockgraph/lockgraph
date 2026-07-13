import { describe, expect, it } from 'vitest'
import {
  newBuilder,
  serializeNodeId,
  type Graph,
  type TarballPayload,
} from '../../main/ts/graph.ts'
import { assessConversion } from '../../main/ts/completeness/assessment.ts'
import {
  completenessOf,
  evidenceOf,
  parse,
  stringifyAssessed,
  withEvidence,
} from '../../main/ts/index.ts'
import {
  PACKAGE_METADATA_FIELDS,
  packageMetadataOfPayload,
  payloadOfPackumentVersion,
} from '../../main/ts/registry/payload.ts'
import type { PackumentVersion } from '../../main/ts/registry/types.ts'

const manifest: PackumentVersion = {
  name: 'pkg',
  version: '1.0.0',
  engines: { node: '>=18' },
  funding: { type: 'individual', url: 'https://example.test/fund' },
  license: 'MIT',
  bin: { pkg: 'bin.js' },
  deprecated: 'use pkg-next',
  cpu: ['x64'],
  os: ['linux'],
  libc: ['glibc'],
  hasInstallScript: true,
  bundledDependencies: ['bundled'],
  peerDependencies: { peer: '^1.0.0' },
  peerDependenciesMeta: { peer: { optional: true } },
}

function graphWith(payload: TarballPayload, resolution: TarballPayload['resolution'] = {
  type: 'tarball',
  url: 'https://registry.npmjs.org/pkg/-/pkg-1.0.0.tgz',
}): Graph {
  const root = serializeNodeId('root', '1.0.0', [])
  const pkg = serializeNodeId('pkg', '1.0.0', [])
  const builder = newBuilder()
  builder.addNode({ id: root, name: 'root', version: '1.0.0', peerContext: [], workspacePath: '' })
  builder.addNode({ id: pkg, name: 'pkg', version: '1.0.0', peerContext: [] })
  builder.addEdge(root, pkg, 'dep', { range: '1.0.0' })
  builder.setTarball({ name: 'pkg', version: '1.0.0' }, { ...payload, resolution })
  return builder.seal()
}

function packageEvidence(graph: Graph, value: PackumentVersion = manifest) {
  return withEvidence(evidenceOf(graph), {
    kind: 'package-manifests',
    authority: 'version-manifest',
    manifests: { 'pkg@1.0.0': value },
  })
}

describe('package metadata completeness', () => {
  it('rejects abbreviated package metadata as authoritative evidence', () => {
    const graph = graphWith({})
    expect(() => withEvidence(evidenceOf(graph), {
      kind: 'package-manifests',
      authority: 'abbreviated-packument',
      manifests: { 'pkg@1.0.0': { name: 'pkg', version: '1.0.0' } },
    } as never)).toThrowError('invalid package manifest authority')
  })

  it('keeps the packument projection in parity with the closed field universe', () => {
    const projected = packageMetadataOfPayload(payloadOfPackumentVersion(manifest))

    expect(Object.keys(projected).sort()).toEqual([...PACKAGE_METADATA_FIELDS].sort())
    expect(projected).toEqual(expect.objectContaining({
      funding: manifest.funding,
      license: manifest.license,
      hasInstallScript: true,
    }))
  })

  it('normalizes semantically empty metadata before comparison', () => {
    const projected = packageMetadataOfPayload(payloadOfPackumentVersion({
      name: 'pkg',
      version: '1.0.0',
      engines: {},
      os: [],
      hasInstallScript: false,
      peerDependenciesMeta: { peer: { optional: false } },
    }))

    expect(projected).toEqual({})
  })

  it('requires exact graph projection equality with authoritative evidence', () => {
    const graph = graphWith(payloadOfPackumentVersion(manifest))
    const evidence = packageEvidence(graph)

    expect(completenessOf(graph).profile.packageMetadata).not.toBe('complete')
    expect(completenessOf(graph, { evidence }).profile.packageMetadata).toBe('complete')

    const detached = graphWith({})
    const detachedResult = completenessOf(detached, { evidence: packageEvidence(detached) })
    expect(detachedResult.profile.packageMetadata).not.toBe('complete')
    expect(detachedResult.diagnostics).toContainEqual(expect.objectContaining({
      code: 'COMPLETENESS_PACKAGE_METADATA_MISMATCH',
      subject: 'pkg@1.0.0',
    }))
  })

  it('treats authoritative absence and extra graph metadata as a mismatch', () => {
    const graph = graphWith({ license: 'MIT' })
    const evidence = packageEvidence(graph, { name: 'pkg', version: '1.0.0' })

    expect(completenessOf(graph, { evidence }).profile.packageMetadata).not.toBe('complete')
  })

  it('rejects missing subjects, identity mismatches, and authoritative conflicts', () => {
    const graph = graphWith(payloadOfPackumentVersion(manifest))
    expect(completenessOf(graph).diagnostics).toContainEqual(expect.objectContaining({
      code: 'COMPLETENESS_PACKAGE_METADATA_INCOMPLETE',
      subject: 'pkg@1.0.0',
    }))

    const wrongIdentity = packageEvidence(graph, { ...manifest, name: 'other' })
    expect(completenessOf(graph, { evidence: wrongIdentity }).diagnostics).toContainEqual(
      expect.objectContaining({ code: 'COMPLETENESS_PACKAGE_METADATA_MISMATCH' }),
    )

    const conflict = withEvidence(packageEvidence(graph), {
      kind: 'package-manifests',
      authority: 'tarball-manifest',
      manifests: { 'pkg@1.0.0': { ...manifest, license: 'Apache-2.0' } },
    })
    expect(completenessOf(graph, { evidence: conflict }).profile.packageMetadata).not.toBe('complete')
  })

  it('requires every distinct subject and deduplicates peer-virtual siblings', () => {
    const peerA = serializeNodeId('peer-a', '1.0.0', [])
    const peerB = serializeNodeId('peer-b', '1.0.0', [])
    const pkgA = serializeNodeId('pkg', '1.0.0', [peerA])
    const pkgB = serializeNodeId('pkg', '1.0.0', [peerB])
    const builder = newBuilder()
    builder.addNode({ id: peerA, name: 'peer-a', version: '1.0.0', peerContext: [] })
    builder.addNode({ id: peerB, name: 'peer-b', version: '1.0.0', peerContext: [] })
    builder.addNode({ id: pkgA, name: 'pkg', version: '1.0.0', peerContext: [peerA] })
    builder.addNode({ id: pkgB, name: 'pkg', version: '1.0.0', peerContext: [peerB] })
    builder.addEdge(pkgA, peerA, 'peer', { range: '^1.0.0' })
    builder.addEdge(pkgB, peerB, 'peer', { range: '^1.0.0' })
    builder.setTarball({ name: 'peer-a', version: '1.0.0' }, {
      resolution: { type: 'tarball', url: 'https://registry.npmjs.org/peer-a/-/peer-a-1.0.0.tgz' },
    })
    builder.setTarball({ name: 'peer-b', version: '1.0.0' }, {
      resolution: { type: 'tarball', url: 'https://registry.npmjs.org/peer-b/-/peer-b-1.0.0.tgz' },
    })
    builder.setTarball({ name: 'pkg', version: '1.0.0' }, payloadOfPackumentVersion(manifest))
    const graph = builder.seal()
    const partial = withEvidence(evidenceOf(graph), {
      kind: 'package-manifests',
      authority: 'version-manifest',
      manifests: {
        'pkg@1.0.0': manifest,
        'peer-a@1.0.0': { name: 'peer-a', version: '1.0.0' },
      },
    })
    expect(completenessOf(graph, { evidence: partial }).diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'COMPLETENESS_PACKAGE_METADATA_INCOMPLETE',
        subject: 'peer-b@1.0.0',
      }),
    )

    const complete = withEvidence(partial, {
      kind: 'package-manifests',
      authority: 'version-manifest',
      manifests: { 'peer-b@1.0.0': { name: 'peer-b', version: '1.0.0' } },
    })
    expect(completenessOf(graph, { evidence: complete }).profile.packageMetadata).toBe('complete')
  })

  it('keeps non-registry subjects blocked pending source-specific evidence', () => {
    const graph = graphWith(payloadOfPackumentVersion(manifest), {
      type: 'git',
      url: 'https://example.test/pkg.git',
      sha: 'a'.repeat(40),
    })
    const result = completenessOf(graph, { evidence: packageEvidence(graph) })

    expect(result.profile.packageMetadata).not.toBe('complete')
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: 'COMPLETENESS_PACKAGE_METADATA_SOURCE_UNSUPPORTED',
      subject: 'pkg@1.0.0',
    }))
  })

  it('uses deep metadata in canonical and target project requirements', () => {
    const graph = graphWith(payloadOfPackumentVersion(manifest))
    const evidence = packageEvidence(graph)
    const lockgraph = assessConversion(graph, {
      contract: 'project',
      target: { format: 'lockgraph' },
      evidence,
    })
    expect(lockgraph.requirements).toContainEqual(expect.objectContaining({
      key: 'canonical:package-metadata',
      status: 'satisfied',
    }))

    const pnpm = assessConversion(graph, {
      contract: 'project',
      target: { format: 'pnpm-v9', managerVersion: '10.0.0' },
      evidence,
    })
    expect(pnpm.requirements).toContainEqual(expect.objectContaining({
      key: 'target-feature:metadata:license',
      status: 'unsatisfied',
    }))
  })

  it('makes a fully evidenced npm project conversion satisfiable', () => {
    const input = readFileSync(resolve(
      'src/test/resources/fixtures/lockfiles/simple/npm-3.lock',
    ), 'utf8')
    const graph = parse('npm-3', input)
    let evidence = withEvidence(evidenceOf(graph), {
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
    evidence = withEvidence(evidence, {
      kind: 'package-manifests',
      authority: 'version-manifest',
      manifests: {
        'lodash@4.17.21': { name: 'lodash', version: '4.17.21' },
        'ms@2.1.3': { name: 'ms', version: '2.1.3' },
      },
    })

    const result = stringifyAssessed(graph, {
      contract: 'project',
      target: { format: 'npm-3', managerVersion: '9.9.4' },
      evidence,
    })
    expect(result.assessment.status).toBe('satisfied')
    expect(result.output).toBeDefined()
  })

  it('lowers metadata after a tarball mutation under threaded evidence', () => {
    const graph = graphWith(payloadOfPackumentVersion(manifest))
    const evidence = packageEvidence(graph)
    const changed = graph.mutate(mutator => {
      mutator.setTarball({ name: 'pkg', version: '1.0.0' }, {
        ...payloadOfPackumentVersion(manifest),
        license: 'Apache-2.0',
      })
    }).graph

    expect(completenessOf(changed, { evidence }).profile.packageMetadata).not.toBe('complete')
  })
})
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
