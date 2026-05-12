import { describe, expect, it } from 'vitest'
import { check, enrich, optimize, parse, stringify } from '../../main/ts/formats/npm-3.ts'
import { fixture, parseFixtureGraph, type FlatFamilySpec } from './_npm-flat-test-utils.ts'
import { registerFlatFamilySuite } from './_npm-flat-suite.ts'

// npm-3 spec for the shared flat-family harness. Per-version deltas
// (NPM_V3_UNEXPECTED_LEGACY_MIRROR, parse-time resolution-undefined check)
// are registered as standalone describe() blocks below.
const SPEC: FlatFamilySpec = {
  label: 'npm-3',
  lockfileVersion: 3,
  diagPrefix: 'NPM_V3',
  fixtureSuffix: 'npm-3.lock',
  adapter: { check, parse, stringify, enrich, optimize },
}

registerFlatFamilySuite(SPEC)

// --- npm-3-only deltas -----------------------------------------------------

describe('npm-3 — parse deltas', () => {
  it('records resolution URL on node for tarball entries (npm-3 leaves resolution undefined)', () => {
    const graph = parseFixtureGraph(SPEC, 'simple')
    const ms = graph.getNode('ms@2.1.3')
    // resolution is not synced from `resolved` to Node; lives in sidecar / tarball flow.
    expect(ms?.resolution).toBeUndefined()
  })

  it('emits NPM_V3_UNEXPECTED_LEGACY_MIRROR when input carries top-level dependencies', () => {
    const malformed = JSON.stringify({
      name: 'x',
      version: '0.0.0',
      lockfileVersion: 3,
      requires: true,
      dependencies: { ms: { version: '2.1.3' } },
      packages: {
        '': { name: 'x', version: '0.0.0', dependencies: { ms: '2.1.3' } },
        'node_modules/ms': { version: '2.1.3', resolved: 'https://registry.npmjs.org/ms/-/ms-2.1.3.tgz', integrity: 'sha512-abc' },
      },
    }, null, 2)
    const graph = parse(malformed)
    const codes = graph.diagnostics().map(d => d.code)
    expect(codes).toContain('NPM_V3_UNEXPECTED_LEGACY_MIRROR')
  })

  it('check() rejects npm-2 fixtures (cross-version isolation)', () => {
    const v2 = fixture('simple/npm-2.lock')
    expect(check(v2)).toBe(false)
  })
})
