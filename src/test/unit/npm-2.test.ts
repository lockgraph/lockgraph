import { describe, expect, it } from 'vitest'
import { LockfileError } from '../../main/ts/errors.ts'
import { check, enrich, optimize, parse, stringify } from '../../main/ts/formats/npm-2.ts'
import { parse as parseV3 } from '../../main/ts/formats/npm-3.ts'
import { fixture, parseFixtureGraph, type FlatFamilySpec } from './_npm-flat-test-utils.ts'
import { registerFlatFamilySuite } from './_npm-flat-suite.ts'

// npm-2 spec for the shared flat-family harness. Per-version deltas
// (dual-block FORMAT_MISMATCH preconditions, legacy mirror shape,
// NPM_V2_DUAL_MODE_DRIFT diagnostics) are registered as standalone
// describe() blocks below.
const SPEC: FlatFamilySpec = {
  label: 'npm-2',
  lockfileVersion: 2,
  diagPrefix: 'NPM_V2',
  fixtureSuffix: 'npm-2.lock',
  adapter: { check, parse, stringify, enrich, optimize },
  // npm-2 has an extra cross-adapter rejector: npm-3 must reject npm-2 input.
  crossAdapterRejectExtra: [parseV3],
}

registerFlatFamilySuite(SPEC)

// --- npm-2-only deltas -----------------------------------------------------

describe('npm-2 — dual-mode parse preconditions', () => {
  it('check() rejects npm-3 fixtures (cross-version isolation)', () => {
    const v3 = fixture('simple/npm-3.lock')
    expect(check(v3)).toBe(false)
  })

  it('FORMAT_MISMATCH if `packages` block is missing (dual-mode require)', () => {
    const malformed = JSON.stringify({
      name: 'x',
      version: '0.0.0',
      lockfileVersion: 2,
      requires: true,
      dependencies: { ms: { version: '2.1.3' } },
    }, null, 2)
    expect(() => parse(malformed)).toThrow(LockfileError)
    try { parse(malformed) } catch (error) {
      expect((error as LockfileError).code).toBe('FORMAT_MISMATCH')
    }
  })

  it('FORMAT_MISMATCH if `dependencies` block is missing (dual-mode require)', () => {
    const malformed = JSON.stringify({
      name: 'x',
      version: '0.0.0',
      lockfileVersion: 2,
      requires: true,
      packages: {
        '': { name: 'x', version: '0.0.0', dependencies: { ms: '2.1.3' } },
        'node_modules/ms': { version: '2.1.3', resolved: 'https://registry.npmjs.org/ms/-/ms-2.1.3.tgz', integrity: 'sha512-abc' },
      },
    }, null, 2)
    expect(() => parse(malformed)).toThrow(LockfileError)
    try { parse(malformed) } catch (error) {
      expect((error as LockfileError).code).toBe('FORMAT_MISMATCH')
    }
  })
})

describe('npm-2 — legacy `dependencies` mirror emit', () => {
  it('emits both `packages` and `dependencies` blocks (dual mode)', () => {
    const graph = parseFixtureGraph(SPEC, 'simple')
    const text = stringify(graph)
    const parsed = JSON.parse(text)
    expect(parsed.lockfileVersion).toBe(2)
    expect(parsed.packages).toBeDefined()
    expect(parsed.dependencies).toBeDefined()
    expect(typeof parsed.dependencies).toBe('object')
  })

  it('emits legacy dependencies mirror sorted alphabetically', () => {
    const graph = parseFixtureGraph(SPEC, 'simple')
    const text = stringify(graph)
    const obj = JSON.parse(text)
    const keys = Object.keys(obj.dependencies)
    expect(keys).toEqual([...keys].sort())
  })

  it('legacy mirror keys are bare names (npm-1 shape, no node_modules/ prefix)', () => {
    const graph = parseFixtureGraph(SPEC, 'simple')
    const text = stringify(graph)
    const obj = JSON.parse(text)
    expect(Object.keys(obj.dependencies)).toContain('ms')
    expect(Object.keys(obj.dependencies)).toContain('lodash')
    expect(Object.keys(obj.dependencies).every(k => !k.includes('/node_modules/'))).toBe(true)
  })

  it('legacy mirror entries carry version + resolved + integrity for tarball nodes', () => {
    const graph = parseFixtureGraph(SPEC, 'simple')
    const text = stringify(graph)
    const obj = JSON.parse(text)
    expect(obj.dependencies.ms).toMatchObject({
      version: '2.1.3',
      resolved: 'https://registry.npmjs.org/ms/-/ms-2.1.3.tgz',
      integrity: expect.stringMatching(/^sha512-/),
    })
  })

  it('legacy mirror entries carry `requires` (npm-1 shape, not inner `dependencies`)', () => {
    const graph = parseFixtureGraph(SPEC, 'peers-basic')
    const text = stringify(graph)
    const obj = JSON.parse(text)
    expect(obj.dependencies.react?.requires).toEqual({
      'loose-envify': '^1.1.0',
    })
    // Peers are absent from legacy mirror (npm-1 shape).
    expect(obj.dependencies['react-dom']?.peerDependencies).toBeUndefined()
  })

  it('legacy mirror records workspace members as `version: file:<wsPath>`', () => {
    const graph = parseFixtureGraph(SPEC, 'workspaces-basic')
    const text = stringify(graph)
    const obj = JSON.parse(text)
    expect(obj.dependencies['@case-ws/a']).toMatchObject({
      version: 'file:packages/a',
      requires: { ms: '2.1.3' },
    })
    expect(obj.dependencies['@case-ws/b']).toMatchObject({
      version: 'file:packages/b',
      requires: { ms: '2.1.3' },
    })
  })

  it('legacy mirror does NOT carry peerDependencies under flattened peer-edge consumers', () => {
    const original = parseFixtureGraph(SPEC, 'simple')
    const result = original.mutate(m => {
      m.addNode({
        id: 'peer-consumer@1.0.0(ms@2.1.3)',
        name: 'peer-consumer',
        version: '1.0.0',
        peerContext: ['ms@2.1.3'],
      })
      m.addEdge('peer-consumer@1.0.0(ms@2.1.3)', 'ms@2.1.3', 'peer', { range: '^2.1.0' })
    })
    const text = stringify(result.graph)
    const obj = JSON.parse(text)
    // Packages block carries peers; legacy mirror (npm-1 shape) does not.
    expect(obj.packages['node_modules/peer-consumer']?.peerDependencies).toEqual({ ms: '^2.1.0' })
    expect(obj.dependencies['peer-consumer']?.peerDependencies).toBeUndefined()
  })
})

describe('npm-2 — NPM_V2_DUAL_MODE_DRIFT diagnostics', () => {
  it('emits NPM_V2_DUAL_MODE_DRIFT when packages and dependencies disagree on version', () => {
    const drift = JSON.stringify({
      name: 'x',
      version: '0.0.0',
      lockfileVersion: 2,
      requires: true,
      packages: {
        '': { name: 'x', version: '0.0.0', dependencies: { ms: '2.1.3' } },
        'node_modules/ms': {
          version: '2.1.3',
          resolved: 'https://registry.npmjs.org/ms/-/ms-2.1.3.tgz',
          integrity: 'sha512-PACKAGES_WINS',
        },
      },
      // Legacy mirror disagrees with packages on version (DRIFT).
      dependencies: {
        ms: {
          version: '2.1.2',
          resolved: 'https://registry.npmjs.org/ms/-/ms-2.1.2.tgz',
          integrity: 'sha512-LEGACY_LOSES',
        },
      },
    }, null, 2)
    const graph = parse(drift)
    const codes = graph.diagnostics().map(d => d.code)
    expect(codes).toContain('NPM_V2_DUAL_MODE_DRIFT')
    const driftDiagnostic = graph.diagnostics().find(d => d.code === 'NPM_V2_DUAL_MODE_DRIFT')
    expect(driftDiagnostic?.subject).toBe('ms')
    // `packages` wins on graph state.
    expect(graph.getNode('ms@2.1.3')).toBeDefined()
    expect(graph.getNode('ms@2.1.2')).toBeUndefined()
    const ms = graph.tarballOf('ms@2.1.3')
    expect(ms?.integrity).toBe('sha512-PACKAGES_WINS')
  })

  it('emits NPM_V2_DUAL_MODE_DRIFT for resolved / integrity disagreement', () => {
    const drift = JSON.stringify({
      name: 'x',
      version: '0.0.0',
      lockfileVersion: 2,
      requires: true,
      packages: {
        '': { name: 'x', version: '0.0.0', dependencies: { ms: '2.1.3' } },
        'node_modules/ms': {
          version: '2.1.3',
          resolved: 'https://registry.npmjs.org/ms/-/ms-2.1.3.tgz',
          integrity: 'sha512-PACKAGES_INTEGRITY',
        },
      },
      dependencies: {
        ms: {
          version: '2.1.3', // same version
          resolved: 'https://registry.npmjs.org/ms/-/ms-2.1.3.tgz',
          integrity: 'sha512-LEGACY_DIFFERENT_INTEGRITY',
        },
      },
    }, null, 2)
    const graph = parse(drift)
    const codes = graph.diagnostics().map(d => d.code)
    expect(codes).toContain('NPM_V2_DUAL_MODE_DRIFT')
  })

  it('no drift warning when packages and dependencies agree', () => {
    const graph = parseFixtureGraph(SPEC, 'simple')
    const codes = graph.diagnostics().map(d => d.code)
    expect(codes).not.toContain('NPM_V2_DUAL_MODE_DRIFT')
  })
})
