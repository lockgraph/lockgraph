import { describe, expect, it } from 'vitest'
import {
  newBuilder,
  type PackageMetadataField,
  serializeNodeId,
  type Graph,
  type TarballPayload,
} from '../../main/ts/graph.ts'
import { parse, stringify, type FormatId } from '../../main/ts/index.ts'
import { targetProfileOf } from '../../main/ts/completeness/targets.ts'

function graphWith(payload: TarballPayload): Graph {
  const root = serializeNodeId('root', '1.0.0', [])
  const pkg = serializeNodeId('pkg', '1.0.0', [])
  const builder = newBuilder()
  builder.addNode({ id: root, name: 'root', version: '1.0.0', peerContext: [], workspacePath: '' })
  builder.addNode({ id: pkg, name: 'pkg', version: '1.0.0', peerContext: [] })
  builder.addEdge(root, pkg, 'dep', { range: '1.0.0' })
  builder.setTarball({ name: 'pkg', version: '1.0.0' }, {
    ...payload,
    resolution: { type: 'tarball', url: 'https://registry.npmjs.org/pkg/-/pkg-1.0.0.tgz' },
  })
  return builder.seal()
}

function expectStable(format: FormatId, payload: TarballPayload): string {
  const options = format.startsWith('pnpm-') || format.startsWith('yarn-berry-')
    ? { strict: false }
    : {}
  const output = stringify(format, graphWith(payload), options)
  expect(stringify(format, parse(format, output), options)).toBe(output)
  return output
}

function expectMetadataFields(format: FormatId, fields: PackageMetadataField[]): void {
  expect([...targetProfileOf({ format }).capabilities.metadataFields].sort()).toEqual(fields.sort())
}

describe('package metadata emitters', () => {
  it('reports native storage separately from canonical sidecar projection', () => {
    expectMetadataFields('npm-1', [])
    expectMetadataFields('yarn-classic', [])
    expectMetadataFields('bun-text', ['bin', 'cpu', 'os', 'peerDependencies'])
  })

  it('emits every npm-2/3 supported field from canonical payload', () => {
    const payload: TarballPayload = {
      engines: { node: '>=18' },
      funding: { url: 'https://example.test/fund' },
      license: 'MIT',
      bin: { pkg: 'bin.js' },
      deprecated: 'old',
      cpu: ['x64'],
      os: ['linux'],
      libc: ['glibc'],
      hasInstallScript: true,
      peerDependencies: { peer: '^1.0.0' },
      peerDependenciesMeta: { peer: { optional: true } },
    }
    const output = expectStable('npm-3', payload)
    const entry = JSON.parse(output).packages['node_modules/pkg']

    expect(entry).toMatchObject(payload)
    expectMetadataFields('npm-3', Object.keys(payload) as PackageMetadataField[])
    expectStable('npm-2', payload)
    expectMetadataFields('npm-2', Object.keys(payload) as PackageMetadataField[])
  })

  it('emits every Yarn Berry supported field from canonical payload', () => {
    const payload: TarballPayload = {
      bin: { pkg: 'bin.js' },
      cpu: ['x64'],
      os: ['linux'],
      libc: ['glibc'],
      peerDependencies: { peer: '^1.0.0' },
      peerDependenciesMeta: { peer: { optional: true } },
    }
    const output = expectStable('yarn-berry-v9', payload)

    expect(output).toContain('  bin:')
    expect(output).toContain('  conditions: os=linux & cpu=x64 & libc=glibc')
    expect(output).toContain('  peerDependencies:')
    expect(output).toContain('  peerDependenciesMeta:')
    expectMetadataFields('yarn-berry-v9', Object.keys(payload) as PackageMetadataField[])
  })

  it('emits canonical pnpm-v9 payload fields and reports hasBin storage', () => {
    const payload: TarballPayload = {
      engines: { node: '>=18' },
      deprecated: 'old',
      cpu: ['x64'],
      os: ['linux'],
      libc: ['glibc'],
      peerDependencies: { peer: '^1.0.0' },
      peerDependenciesMeta: { peer: { optional: true } },
    }
    const output = expectStable('pnpm-v9', payload)

    expect(output).toContain("    engines: {node: '>=18'}")
    expect(output).toContain('    deprecated: old')
    expect(output).toContain('    libc:')
    expect(output).toContain('    peerDependenciesMeta:')
    expectMetadataFields('pnpm-v9', [
      ...(Object.keys(payload) as PackageMetadataField[]),
      'bin',
    ])
  })

  it('uses the same canonical payload fields and hasBin storage in pnpm-v6', () => {
    const payload: TarballPayload = {
      engines: { node: '>=18' },
      deprecated: 'old',
      cpu: ['x64'],
      os: ['linux'],
      libc: ['glibc'],
      peerDependencies: { peer: '^1.0.0' },
      peerDependenciesMeta: { peer: { optional: true } },
    }

    expectStable('pnpm-v6', payload)
    expectMetadataFields('pnpm-v6', [
      ...(Object.keys(payload) as PackageMetadataField[]),
      'bin',
    ])
  })

  it('emits canonical pnpm-v5 payload fields and reports hasBin storage', () => {
    const payload: TarballPayload = {
      engines: { node: '>=18' },
      cpu: ['x64'],
      os: ['linux'],
      peerDependencies: { peer: '^1.0.0' },
    }
    const output = expectStable('pnpm-v5', payload)

    expect(output).toContain("    engines: {node: '>=18'}")
    expect(output).toContain('    peerDependencies:')
    expectMetadataFields('pnpm-v5', [
      ...(Object.keys(payload) as PackageMetadataField[]),
      'bin',
    ])
  })

  it('emits the complete canonical metadata universe through lockgraph', () => {
    const payload: TarballPayload = {
      engines: { node: '>=18' },
      funding: { url: 'https://example.test/fund' },
      license: 'MIT',
      bin: { pkg: 'bin.js' },
      deprecated: 'old',
      cpu: ['x64'],
      os: ['linux'],
      libc: ['glibc'],
      hasInstallScript: true,
      bundledDependencies: ['bundled'],
      peerDependencies: { peer: '^1.0.0' },
      peerDependenciesMeta: { peer: { optional: true } },
    }

    expectStable('lockgraph', payload)
    expectMetadataFields('lockgraph', Object.keys(payload) as PackageMetadataField[])
  })
})
