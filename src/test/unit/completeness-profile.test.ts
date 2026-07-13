import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  completenessOf,
  evidenceOf,
  parse,
  withEvidence,
} from '../../main/ts/index.ts'
import { getBunOverridesCanonical } from '../../main/ts/formats/bun-text.ts'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = (file: string): string =>
  readFileSync(resolve(here, '../resources/fixtures/lockfiles/simple', file), 'utf8')

describe('completenessOf', () => {
  it('reports the source floor with structural and sealed-graph evidence', () => {
    const graph = parse('npm-3', fixture('npm-3.lock'))
    const result = completenessOf(graph)

    expect(result.profile).toMatchObject({
      projectTopology: 'complete',
      resolvedGraph: 'complete',
      edgeKinds: 'partial',
      peerModel: 'declared',
      resolutionPolicy: 'outcome-only',
      packageMetadata: 'partial',
      artifacts: 'identified',
      layout: 'source-native-encoded',
      verification: 'graph-validated',
    })
    expect(result.structural.verification).toBe('graph-validated')
  })

  it('upgrades observable pnpm-v9 graphs but retains opaque peer-set uncertainty', () => {
    expect(completenessOf(parse('pnpm-v9', fixture('pnpm-v9.lock'))).profile).toMatchObject({
      resolvedGraph: 'complete',
      edgeKinds: 'complete',
      artifacts: 'identified',
    })

    const opaque = parse('pnpm-v9',
      `lockfileVersion: '9.0'\n\n`
      + `settings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n\n`
      + `importers:\n\n  .:\n    dependencies:\n`
      + `      tool:\n        specifier: 1.0.0\n        version: 1.0.0(deadbeef00112233)\n\n`
      + `packages:\n\n  tool@1.0.0:\n    resolution: {integrity: sha512-t}\n\n`
      + `snapshots:\n\n  tool@1.0.0(deadbeef00112233): {}\n`,
    )
    expect(completenessOf(opaque).profile).toMatchObject({
      resolvedGraph: 'partial',
      edgeKinds: 'partial',
    })

    const nestedOpaque = parse('pnpm-v9',
      `lockfileVersion: '9.0'\n\n`
      + `settings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n\n`
      + `importers:\n\n  .:\n    dependencies:\n`
      + `      plugin:\n        specifier: 1.0.0\n        version: 1.0.0(tool@1.0.0(deadbeef00112233))\n\n`
      + `packages:\n\n`
      + `  plugin@1.0.0:\n    resolution: {integrity: sha512-p}\n    peerDependencies:\n      tool: '*'\n`
      + `  tool@1.0.0:\n    resolution: {integrity: sha512-t}\n\n`
      + `snapshots:\n\n`
      + `  plugin@1.0.0(tool@1.0.0(deadbeef00112233)):\n    dependencies:\n      tool: 1.0.0(deadbeef00112233)\n`
      + `  tool@1.0.0(deadbeef00112233): {}\n`,
    )
    expect(completenessOf(nestedOpaque).profile.resolvedGraph).toBe('partial')
  })

  it('uses an observed pnpm-v5 override carrier without inferring authored policy', () => {
    const input = fixture('pnpm-v5.lock').replace(
      'lockfileVersion: 5.4\n',
      'lockfileVersion: 5.4\n\noverrides:\n  lodash: 4.17.21\n',
    )
    expect(completenessOf(parse('pnpm-v5', input)).profile.resolutionPolicy).toBe('normalized')
  })

  it('allows pnpm 5 manifest authority without a normalized lock carrier', () => {
    const graph = parse('pnpm-v5', fixture('pnpm-v5.lock'))
    let evidence = withEvidence(evidenceOf(graph), {
      kind: 'repository-manifests',
      coverage: 'complete',
      manifests: {
        '': { overrides: [{ package: 'lodash', to: '4.17.21' }] },
      },
    })
    evidence = withEvidence(evidence, {
      kind: 'pm-config',
      manager: 'pnpm',
      version: '5.18.10',
      source: '.npmrc',
      surface: 'overrides',
      coverage: 'complete',
      overrides: [],
    })

    expect(completenessOf(graph, { evidence }).profile.resolutionPolicy).toBe('authored')
  })

  it('treats parse-time manifests as partial evidence', () => {
    const graph = parse('npm-3', fixture('npm-3.lock'), {
      manifests: {
        '': { name: 'simple', version: '1.0.0', overrides: [] },
      },
    })

    expect(completenessOf(graph).profile.resolutionPolicy).toBe('outcome-only')
  })

  it('uses complete root manifests as npm override authority', () => {
    const graph = parse('npm-3', fixture('npm-3.lock'))
    const evidence = withEvidence(evidenceOf(graph), {
      kind: 'repository-manifests',
      coverage: 'complete',
      manifests: {
        '': { overrides: [] },
      },
    })

    expect(completenessOf(graph, { evidence }).profile.resolutionPolicy).toBe('authored')
  })

  it('upgrades topology only when repository declarations are preserved', () => {
    const graph = parse('npm-1', fixture('npm-1.lock'))
    const matching = withEvidence(evidenceOf(graph), {
      kind: 'repository-manifests',
      coverage: 'complete',
      manifests: {
        '': {
          name: 'case-simple',
          version: '0.0.0',
          dependencies: { lodash: '4.17.21', ms: '2.1.3' },
        },
      },
    })
    expect(completenessOf(graph, { evidence: matching }).profile.projectTopology).toBe('complete')

    const missingWorkspace = withEvidence(evidenceOf(graph), {
      kind: 'repository-manifests',
      coverage: 'complete',
      manifests: {
        '': {
          name: 'case-simple',
          version: '0.0.0',
          dependencies: { lodash: '4.17.21', ms: '2.1.3' },
        },
        'packages/missing': { name: 'missing', version: '1.0.0' },
      },
    })
    expect(completenessOf(graph, { evidence: missingWorkspace }).profile.projectTopology).toBe('partial')

    const conflictingName = withEvidence(evidenceOf(graph), {
      kind: 'repository-manifests',
      coverage: 'complete',
      manifests: {
        '': {
          name: 'other-project',
          version: '0.0.0',
          dependencies: { lodash: '4.17.21', ms: '2.1.3' },
        },
      },
    })
    expect(completenessOf(graph, { evidence: conflictingName }).profile.projectTopology).toBe('partial')
  })

  it('upgrades edge kinds only when every package edge is classified', () => {
    const graph = parse('npm-1', fixture('npm-1.lock'))
    let evidence = withEvidence(evidenceOf(graph), {
      kind: 'repository-manifests',
      coverage: 'complete',
      manifests: {
        '': {
          name: 'case-simple',
          version: '0.0.0',
          dependencies: { lodash: '4.17.21', ms: '2.1.3' },
        },
      },
    })
    evidence = withEvidence(evidence, {
      kind: 'package-manifests',
      authority: 'tarball-manifest',
      manifests: {
        'lodash@4.17.21': { name: 'lodash', version: '4.17.21' },
        'ms@2.1.3': { name: 'ms', version: '2.1.3' },
      },
    })

    expect(completenessOf(graph, { evidence }).profile.edgeKinds).toBe('complete')

    const conflict = withEvidence(evidence, {
      kind: 'package-manifests',
      authority: 'tarball-manifest',
      manifests: {
        'lodash@4.17.21': {
          name: 'lodash',
          version: '4.17.21',
          dependencies: { extra: '1.0.0' },
        },
      },
    })
    expect(completenessOf(graph, { evidence: conflict }).profile.edgeKinds).toBe('partial')
  })

  it('requires complete pnpm config evidence for authored policy', () => {
    const graph = parse('pnpm-v9', fixture('pnpm-v9.lock'))
    const manifests = withEvidence(evidenceOf(graph), {
      kind: 'repository-manifests',
      coverage: 'complete',
      manifests: {
        '': { overrides: [] },
      },
    })

    expect(completenessOf(graph, { evidence: manifests }).profile.resolutionPolicy).toBe('normalized')

    const configured = withEvidence(manifests, {
      kind: 'pm-config',
      manager: 'pnpm',
      version: '9.15.0',
      source: 'pnpm-workspace.yaml',
      surface: 'overrides',
      coverage: 'complete',
      overrides: [],
    })
    expect(completenessOf(graph, { evidence: configured }).profile.resolutionPolicy).toBe('authored')
  })

  it('downgrades conflicting pnpm manifest and config declarations', () => {
    const graph = parse('pnpm-v9', fixture('pnpm-v9.lock'))
    const manifests = withEvidence(evidenceOf(graph), {
      kind: 'repository-manifests',
      coverage: 'complete',
      manifests: {
        '': {
          overrides: [{ package: 'foo', to: '1.0.0' }],
        },
      },
    })
    const configured = withEvidence(manifests, {
      kind: 'pm-config',
      manager: 'pnpm',
      version: '9.15.0',
      source: 'pnpm-workspace.yaml',
      surface: 'overrides',
      coverage: 'complete',
      overrides: [{ package: 'foo', to: '2.0.0' }],
    })
    const result = completenessOf(graph, { evidence: configured })

    expect(result.profile.resolutionPolicy).toBe('normalized')
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: 'COMPLETENESS_EVIDENCE_CONFLICT',
      data: expect.objectContaining({ dimension: 'resolutionPolicy' }),
    }))
  })

  it('threads evidence explicitly across a bare mutation', () => {
    const source = parse('npm-3', fixture('npm-3.lock'))
    const evidence = withEvidence(evidenceOf(source), {
      kind: 'repository-manifests',
      coverage: 'complete',
      manifests: {
        '': { overrides: [] },
      },
    })
    const modified = source.mutate(() => {}).graph

    expect(completenessOf(modified).profile.resolutionPolicy).toBe('none')
    expect(completenessOf(modified, { evidence }).profile.resolutionPolicy).toBe('authored')
  })

  it('keeps target oracle verification out of target-independent completeness', () => {
    const source = parse('npm-3', fixture('npm-3.lock'))
    const modified = source.mutate(() => {}).graph
    const evidence = withEvidence(evidenceOf(source), {
      kind: 'target-oracle',
      graph: source,
      target: { format: 'npm-3', managerVersion: '11.4.2' },
      verification: 'frozen-verified',
      platform: 'linux-x64',
      configDigest: `sha256:${'a'.repeat(64)}`,
      inputDigest: `sha256:${'b'.repeat(64)}`,
      projectionDigest: `sha256:${'c'.repeat(64)}`,
    })

    expect(completenessOf(source, { evidence }).profile.verification).toBe('graph-validated')
    expect(completenessOf(modified, { evidence }).profile.verification).toBe('graph-validated')
    expect(evidence.ledger.refs).toContainEqual(expect.objectContaining({
      kind: 'target-oracle',
      target: { format: 'npm-3', managerVersion: '11.4.2' },
      platform: 'linux-x64',
      configDigest: `sha256:${'a'.repeat(64)}`,
      inputDigest: `sha256:${'b'.repeat(64)}`,
      projectionDigest: `sha256:${'c'.repeat(64)}`,
    }))
  })

  it('downgrades source-floor claims after a material graph mutation', () => {
    const source = parse('npm-3', fixture('npm-3.lock'))
    const root = [...source.nodes()].find(node => node.workspacePath === '')!
    const edge = source.out(root.id)[0]!
    const modified = source.mutate(mutator => {
      mutator.removeEdge(edge.src, edge.dst, edge.kind)
    }).graph
    const result = completenessOf(modified, { evidence: evidenceOf(source) })

    expect(result.profile.resolvedGraph).toBe('partial')
    expect(result.profile.projectTopology).toBe('partial')
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: 'COMPLETENESS_EVIDENCE_SCOPE_MISMATCH',
      data: expect.objectContaining({ edges: true }),
    }))
  })

  it('detects same-identity edge attribute mutations and refuses manifest re-upgrade', () => {
    const source = parse('npm-1', fixture('npm-1.lock'))
    const root = [...source.nodes()].find(node => node.workspacePath === '')!
    const edge = source.out(root.id)[0]!
    const evidence = withEvidence(evidenceOf(source), {
      kind: 'repository-manifests',
      coverage: 'complete',
      manifests: {
        '': {
          name: 'case-simple',
          version: '0.0.0',
          dependencies: { lodash: '4.17.21', ms: '2.1.3' },
        },
      },
    })
    const modified = source.mutate(mutator => {
      mutator.removeEdge(edge.src, edge.dst, edge.kind)
      mutator.addEdge(edge.src, edge.dst, edge.kind, { ...edge.attrs, range: '9.9.9' })
    }).graph
    const result = completenessOf(modified, { evidence })

    expect(result.profile.projectTopology).toBe('partial')
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: 'COMPLETENESS_EVIDENCE_SCOPE_MISMATCH',
      data: expect.objectContaining({ edges: true }),
    }))
  })

  it('requires an identifiable source for every non-workspace artifact', () => {
    const source = parse('npm-3', fixture('npm-3.lock'))
    const node = [...source.nodes()].find(candidate => candidate.workspacePath === undefined)!
    const modified = source.mutate(mutator => {
      mutator.removeTarball({
        name: node.name,
        version: node.version,
        patch: node.patch,
        source: node.source,
      })
    }).graph

    expect(completenessOf(modified, { evidence: evidenceOf(source) }).profile.artifacts).toBe('none')
  })

  it('invalidates graph and edge knowledge when tarball payload facts change', () => {
    const source = parse('bun-text', fixture('bun-text.lock'))
    const node = [...source.nodes()].find(candidate => candidate.workspacePath === undefined)!
    const payload = source.tarballOf(node.id)!
    const modified = source.mutate(mutator => {
      mutator.setTarball({
        name: node.name,
        version: node.version,
        patch: node.patch,
        source: node.source,
      }, {
        ...payload,
        resolution: { type: 'unknown', raw: 'opaque' },
        peerDependencies: { peer: '*' },
      })
    }).graph
    const result = completenessOf(modified, { evidence: evidenceOf(source) })

    expect(result.profile.resolvedGraph).toBe('partial')
    expect(result.profile.edgeKinds).toBe('partial')
    expect(result.profile.artifacts).toBe('none')
  })

  it('does not use a manager version incompatible with the pnpm lock format', () => {
    const graph = parse('pnpm-v9', fixture('pnpm-v9.lock'))
    const manifests = withEvidence(evidenceOf(graph), {
      kind: 'repository-manifests',
      coverage: 'complete',
      manifests: { '': { name: '.', version: '0.0.0' } },
    })
    const incompatible = withEvidence(manifests, {
      kind: 'pm-config',
      manager: 'pnpm',
      version: '6.35.1',
      source: 'pnpm-workspace.yaml',
      surface: 'overrides',
      coverage: 'complete',
      overrides: [],
    })

    expect(completenessOf(graph, { evidence: incompatible }).profile.resolutionPolicy).toBe('normalized')
  })

  it('refuses authored policy when the pnpm lock carrier conflicts with config', () => {
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
      overrides: [{ package: 'foo', to: '2.0.0' }],
    })
    const result = completenessOf(graph, { evidence })

    expect(result.profile.resolutionPolicy).toBe('normalized')
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: 'COMPLETENESS_EVIDENCE_CONFLICT',
      data: expect.objectContaining({ dimension: 'resolutionPolicy' }),
    }))
  })

  it('treats a missing required pnpm carrier as a policy conflict', () => {
    const graph = parse('pnpm-v9', fixture('pnpm-v9.lock'))
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

    expect(completenessOf(graph, { evidence }).profile.resolutionPolicy).toBe('normalized')
  })

  it('retains observed carrier evidence across a graph-identical mutation', () => {
    const input = fixture('pnpm-v9.lock').replace(
      "lockfileVersion: '9.0'\n",
      "lockfileVersion: '9.0'\n\noverrides:\n  foo: 1.0.0\n",
    )
    const source = parse('pnpm-v9', input)
    let evidence = withEvidence(evidenceOf(source), {
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
    const modified = source.mutate(() => {}).graph

    expect(completenessOf(modified, { evidence }).profile.resolutionPolicy).toBe('authored')
  })

  it('refuses authored policy when the bun lock carrier conflicts with manifests', () => {
    const input = fixture('bun-text.lock').replace(
      '  "lockfileVersion": 1,\n',
      '  "lockfileVersion": 1,\n  "overrides": { "foo": "1.0.0" },\n',
    )
    const graph = parse('bun-text', input)
    const evidence = withEvidence(evidenceOf(graph), {
      kind: 'repository-manifests',
      coverage: 'complete',
      manifests: {
        '': { overrides: [{ package: 'foo', to: '2.0.0' }] },
      },
    })
    const result = completenessOf(graph, { evidence })

    expect(result.profile.resolutionPolicy).toBe('normalized')
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: 'COMPLETENESS_EVIDENCE_CONFLICT',
    }))
  })

  it('treats bun override declaration order as policy semantics', () => {
    const input = fixture('bun-text.lock').replace(
      '  "lockfileVersion": 1,\n',
      '  "lockfileVersion": 1,\n  "overrides": { "foo": "1.0.0", "foo@^1": "2.0.0" },\n',
    )
    const graph = parse('bun-text', input)
    const carrier = getBunOverridesCanonical(graph)!
    const reversed = [...carrier].reverse().map(({ captureIndex: _captureIndex, ...override }) => override)
    const evidence = withEvidence(evidenceOf(graph), {
      kind: 'repository-manifests',
      coverage: 'complete',
      manifests: { '': { overrides: reversed } },
    })

    expect(completenessOf(graph, { evidence }).profile.resolutionPolicy).toBe('normalized')
  })

  it('treats a missing bun carrier as a policy conflict', () => {
    const graph = parse('bun-text', fixture('bun-text.lock'))
    const evidence = withEvidence(evidenceOf(graph), {
      kind: 'repository-manifests',
      coverage: 'complete',
      manifests: {
        '': { overrides: [{ package: 'foo', to: '1.0.0' }] },
      },
    })

    expect(completenessOf(graph, { evidence }).profile.resolutionPolicy).toBe('normalized')
  })

  it('uses retained parse-gap diagnostics as downgrade signals', () => {
    const source = parse('bun-text', fixture('bun-text.lock'))
    const graph = source.mutate(mutator => {
      mutator.diagnostic({
        code: 'PNPM_UNRESOLVED_DEP',
        severity: 'warning',
        message: 'synthetic unresolved dependency gap',
      })
    }).graph
    const result = completenessOf(graph, { evidence: evidenceOf(source) })

    expect(result.profile.resolvedGraph).toBe('partial')
    expect(result.profile.edgeKinds).toBe('partial')
  })
})
