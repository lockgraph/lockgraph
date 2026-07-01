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

describe('npm-3 — stringify field order (round-trip fidelity)', () => {
  // ENTRY_FIELD_ORDER matches npm for its consistent fields: `license` before
  // `engines`, `bundleDependencies` before `dependencies`. Guards against a
  // silent reorder. (npm's full order is version-dependent — bundled-deps' older
  // `funding`-before-`engines` is intentionally NOT byte-identical; npm ci accepts
  // any order regardless.)
  it('git-github-tarball round-trips byte-identical (license before engines)', () => {
    const raw = fixture('git-github-tarball/npm-3.lock')
    expect(stringify(parse(raw))).toBe(raw)
  })
})

// --- npm-3-only deltas -----------------------------------------------------

describe('npm-3 — parse deltas', () => {
  it('records resolution URL on node for tarball entries (npm-3 leaves nativeResolution undefined)', () => {
    const graph = parseFixtureGraph(SPEC, 'simple')
    const ms = graph.getNode('ms@2.1.3')
    expect(ms).toBeDefined()
    // npm-core does NOT sync `resolved` to the per-tarball nativeResolution
    // sidecar; the `resolved` URL is recovered from the canonical resolution at
    // stringify time instead.
    expect(graph.tarballOf('ms@2.1.3')?.nativeResolution).toBeUndefined()
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

  it('skips an uninstalled optional-dependency placeholder ({optional:true}, no version) (#11)', () => {
    // npm records a bare `{optional:true}` entry for a platform-specific
    // optional native it did not install on this platform (real case:
    // a nested `node_modules/<pkg>/node_modules/<native-addon>` placeholder). There
    // is no resolved instance — parse must skip it, not throw "missing version".
    const input = JSON.stringify({
      name: 'x', version: '0.0.0', lockfileVersion: 3,
      packages: {
        '': { name: 'x', version: '0.0.0', dependencies: { ssh2: '1.0.0' } },
        'node_modules/ssh2': {
          version: '1.0.0',
          resolved: 'https://registry.npmjs.org/ssh2/-/ssh2-1.0.0.tgz',
          integrity: 'sha512-abc',
          optionalDependencies: { 'cpu-features': '0.0.10' },
        },
        'node_modules/ssh2/node_modules/cpu-features': { optional: true },
      },
    }, null, 2)
    expect(() => parse(input)).not.toThrow()
    const graph = parse(input)
    expect(graph.byName('cpu-features')).toEqual([]) // placeholder → no node
    expect(graph.getNode('ssh2@1.0.0')).toBeDefined()
  })
})
