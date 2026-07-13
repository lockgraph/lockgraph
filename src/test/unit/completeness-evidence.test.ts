import { describe, expect, it } from 'vitest'
import { newBuilder, type Manifest } from '../../main/ts/graph.ts'
import {
  evidenceOf,
  parse,
  withEvidence,
  type EvidenceContext,
} from '../../main/ts/index.ts'
import { internalEvidenceOf } from '../../main/ts/completeness/evidence.ts'

const npmLock = JSON.stringify({
  name: 'root',
  version: '1.0.0',
  lockfileVersion: 3,
  requires: true,
  packages: {
    '': { name: 'root', version: '1.0.0' },
  },
})

describe('completeness evidence', () => {
  it('attaches lock provenance to parsed graph handles', () => {
    const graph = parse('npm-3', npmLock)
    const evidence = evidenceOf(graph)

    expect(evidence.ledger.source).toEqual({ format: 'npm-3', manager: 'npm' })
    expect(evidence.ledger.refs).toEqual([{ kind: 'lockfile', subject: 'npm-3' }])
    expect(Object.isFrozen(evidence)).toBe(true)
    expect(Object.isFrozen(evidence.ledger)).toBe(true)
  })

  it('records ParseOptions.manifests without exposing manifest payloads', () => {
    const manifests: Record<string, Manifest> = {
      '': { name: 'root', version: '1.0.0' },
    }
    const evidence = evidenceOf(parse('npm-3', npmLock, { manifests }))

    expect(evidence.ledger.refs).toContainEqual({
      kind: 'repository-manifest',
      subject: '',
      coverage: 'partial',
    })
    expect(JSON.stringify(evidence.ledger)).not.toContain('1.0.0')
  })

  it('enriches immutable contexts and preserves the base context', () => {
    const base = evidenceOf(parse('npm-3', npmLock))
    const enriched = withEvidence(base, {
      kind: 'repository-manifests',
      coverage: 'complete',
      manifests: { '': { name: 'root', version: '1.0.0' } },
    })

    expect(enriched).not.toBe(base)
    expect(base.ledger.refs).toHaveLength(1)
    expect(enriched.ledger.refs).toHaveLength(2)
    expect(Object.isFrozen(enriched.ledger.refs)).toBe(true)
  })

  it('rejects forged contexts and malformed evidence', () => {
    const forged = { ledger: { refs: [], diagnostics: [] } } as unknown as EvidenceContext
    expect(() => withEvidence(forged, {
      kind: 'repository-manifests',
      coverage: 'complete',
      manifests: {},
    })).toThrowError('invalid evidence context')

    const base = evidenceOf(parse('npm-3', npmLock))
    expect(() => withEvidence(base, {
      kind: 'pm-config',
      manager: 'pnpm',
      version: '',
      source: 'pnpm-workspace.yaml',
      surface: 'overrides',
      coverage: 'complete',
      overrides: [],
    })).toThrowError('invalid package-manager config evidence')
  })

  it('does not propagate attached evidence through a bare mutation', () => {
    const source = parse('npm-3', npmLock)
    const modified = source.mutate(() => {}).graph

    expect(evidenceOf(source).ledger.source?.format).toBe('npm-3')
    expect(evidenceOf(modified).ledger.source).toBeUndefined()
  })

  it('records conflicts between authoritative repository snapshots', () => {
    const base = evidenceOf(parse('npm-3', npmLock))
    const first = withEvidence(base, {
      kind: 'repository-manifests',
      coverage: 'complete',
      manifests: { '': { name: 'root', version: '1.0.0' } },
    })
    const conflict = withEvidence(first, {
      kind: 'repository-manifests',
      coverage: 'complete',
      manifests: { '': { name: 'root', version: '2.0.0' } },
    })

    expect(conflict.ledger.diagnostics).toEqual([
      expect.objectContaining({
        code: 'COMPLETENESS_EVIDENCE_CONFLICT',
        data: expect.objectContaining({ dimension: 'projectTopology' }),
      }),
    ])
  })

  it('deduplicates repeated evidence references', () => {
    const base = evidenceOf(parse('npm-3', npmLock))
    const input = {
      kind: 'repository-manifests' as const,
      coverage: 'complete' as const,
      manifests: { '': { name: 'root', version: '1.0.0' } },
    }
    const once = withEvidence(base, input)
    const twice = withEvidence(once, input)

    expect(twice.ledger.refs).toEqual(once.ledger.refs)
    expect(twice.ledger.diagnostics).toEqual(once.ledger.diagnostics)
  })

  it('detects authoritative contradictions across coverage orderings', () => {
    const base = evidenceOf(parse('npm-3', npmLock))
    const partial = withEvidence(base, {
      kind: 'repository-manifests',
      coverage: 'partial',
      manifests: { '': { name: 'root', dependencies: { foo: '1.0.0' } } },
    })
    const partialThenComplete = withEvidence(partial, {
      kind: 'repository-manifests',
      coverage: 'complete',
      manifests: { '': { name: 'root', dependencies: { foo: '2.0.0' } } },
    })
    expect(partialThenComplete.ledger.diagnostics).toContainEqual(expect.objectContaining({
      code: 'COMPLETENESS_EVIDENCE_CONFLICT',
    }))

    const completeThenPartial = withEvidence(withEvidence(base, {
      kind: 'repository-manifests',
      coverage: 'complete',
      manifests: { '': { name: 'root' } },
    }), {
      kind: 'repository-manifests',
      coverage: 'partial',
      manifests: { 'packages/extra': { name: 'extra' } },
    })
    expect(completeThenPartial.ledger.diagnostics).toContainEqual(expect.objectContaining({
      code: 'COMPLETENESS_EVIDENCE_CONFLICT',
      data: expect.objectContaining({ dimension: 'projectTopology' }),
    }))
  })

  it('validates modeled manifest and oracle fields', () => {
    const graph = parse('npm-3', npmLock)
    const base = evidenceOf(graph)
    expect(() => withEvidence(base, {
      kind: 'repository-manifests',
      coverage: 'complete',
      manifests: { '': { overrides: 'invalid' } },
    } as never)).toThrowError('overrides must be an array')
    expect(() => withEvidence(base, {
      kind: 'target-oracle',
      graph,
      target: { format: 'npm-3', managerVersion: 'latest' },
      verification: 'frozen-verified',
      platform: 'linux-x64',
      configDigest: 'config',
      inputDigest: 'input',
      projectionDigest: 'invalid',
    })).toThrowError('invalid target oracle evidence')
  })

  it('rejects cyclic or multiply-attributed native override payloads', () => {
    const base = evidenceOf(parse('npm-3', npmLock))
    const cyclic: Record<string, unknown> = {}
    cyclic.foo = cyclic
    expect(() => withEvidence(base, {
      kind: 'repository-manifests',
      coverage: 'complete',
      manifests: { '': { native: { npmOverrides: cyclic } } },
    })).toThrowError('must not contain cycles')

    expect(() => withEvidence(base, {
      kind: 'repository-manifests',
      coverage: 'complete',
      manifests: {
        '': {
          native: {
            npmOverrides: { foo: '1.0.0' },
            yarnResolutions: { foo: '1.0.0' },
          },
        },
      },
    })).toThrowError('at most one native override block')

    expect(() => withEvidence(base, {
      kind: 'repository-manifests',
      coverage: 'complete',
      manifests: {
        '': {
          overrides: [],
          native: { npmOverrides: { foo: '1.0.0' } },
        },
      },
    })).toThrowError('both canonical and native overrides')
  })

  it('canonicalizes root subjects and rejects duplicate aliases', () => {
    const base = evidenceOf(parse('npm-3', npmLock))
    const evidence = withEvidence(base, {
      kind: 'repository-manifests',
      coverage: 'complete',
      manifests: { '.': { name: 'root' } },
    })
    expect(internalEvidenceOf(evidence).repositoryManifests?.manifests['']).toEqual({ name: 'root' })
    expect(() => withEvidence(base, {
      kind: 'repository-manifests',
      coverage: 'complete',
      manifests: { '': { name: 'left' }, '.': { name: 'right' } },
    })).toThrowError('duplicate root subjects')
  })

  it('rejects hidden and symbol evidence fields', () => {
    const base = evidenceOf(parse('npm-3', npmLock))
    const hidden = { kind: 'repository-manifests', coverage: 'complete', manifests: {} }
    Object.defineProperty(hidden, 'future', { value: true })
    expect(() => withEvidence(base, hidden as never)).toThrowError('enumerable string keys')
    const symbol = {
      kind: 'repository-manifests',
      coverage: 'complete',
      manifests: { [Symbol('future')]: {} },
    }
    expect(() => withEvidence(base, symbol as never)).toThrowError('enumerable string keys')
  })

  it('returns an inert context for graph handles without attached evidence', () => {
    const graph = newBuilder().seal()
    expect(evidenceOf(graph).ledger).toEqual({
      refs: [],
      diagnostics: [],
    })
  })

  it('exposes package-manifest state through a non-mutating map view', () => {
    const base = evidenceOf(parse('npm-3', npmLock))
    const evidence = withEvidence(base, {
      kind: 'package-manifests',
      authority: 'tarball-manifest',
      manifests: { 'foo@1.0.0': { name: 'foo', version: '1.0.0' } },
    })
    const map = internalEvidenceOf(evidence).packageManifests as unknown as {
      set?: (key: string, value: unknown) => void
    }

    expect(map.set).toBeUndefined()
  })

  it('does not expose package or native override payloads through the ledger', () => {
    const base = evidenceOf(parse('npm-3', npmLock))
    const packages = withEvidence(base, {
      kind: 'package-manifests',
      authority: 'tarball-manifest',
      manifests: {
        'public-key@1.0.0': {
          name: 'private-payload-name',
          version: 'private-payload-version',
        },
      },
    })
    const native = withEvidence(base, {
      kind: 'repository-manifests',
      coverage: 'complete',
      manifests: {
        '': {
          native: { pnpmOverrides: { 'private-selector': 'private-target' } },
        },
      },
    })

    expect(JSON.stringify(packages.ledger)).not.toContain('private-payload')
    expect(JSON.stringify(native.ledger)).not.toContain('private-selector')
    expect(JSON.stringify(native.ledger)).not.toContain('private-target')
  })
})
