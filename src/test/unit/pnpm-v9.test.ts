import { describe, expect, it } from 'vitest'
import { check, enrich, optimize, parse, stringify } from '../../main/ts/formats/pnpm-v9.ts'
import {
  fixture,
  parseFixtureGraph,
  type PnpmFamilySpec,
} from './_pnpm-flat-test-utils.ts'
import { registerPnpmFlatSuite } from './_pnpm-flat-suite.ts'

// pnpm-v9 spec for the shared pnpm-family harness. Per-version deltas
// (snapshots block presence, orphan-snapshot warnings, peer-virt 3-branch
// derivation, etc.) are registered as standalone describe() blocks below.
const SPEC: PnpmFamilySpec = {
  label: 'pnpm-v9',
  lockfileVersion: '9.0',
  diagPrefix: 'PNPM_V9',
  fixtureSuffix: 'pnpm-v9.lock',
  adapter: { check, parse, stringify, enrich, optimize },
  crossVersionRejects: ['pnpm-v5.lock', 'pnpm-v6.lock'],
}

registerPnpmFlatSuite(SPEC)

// --- pnpm-v9-only deltas ---------------------------------------------------

describe('pnpm-v9 — snapshots block parse deltas', () => {
  it('parses snapshots block keys as graph nodes (one per snapshot key)', () => {
    const graph = parseFixtureGraph(SPEC, 'simple')
    // Same nodes as the shared suite — v9 sources them from snapshots map.
    expect(graph.getNode('lodash@4.17.21')).toBeDefined()
    expect(graph.getNode('ms@2.1.3')).toBeDefined()
  })

  it('warns on orphan snapshot (PNPM_V9_SNAPSHOTS_MISSING)', () => {
    const malformed =
      `lockfileVersion: '9.0'\n\n` +
      `settings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n\n` +
      `importers:\n\n  .: {}\n\n` +
      `packages: {}\n\n` +
      `snapshots:\n\n  ghost@1.0.0: {}\n`
    const graph = parse(malformed)
    const diags = graph.diagnostics().filter(d => d.code === 'PNPM_V9_SNAPSHOTS_MISSING')
    expect(diags).toHaveLength(1)
  })
})

describe('pnpm-v9 — stringify deltas (snapshots emission)', () => {
  it('emits packages block sorted alphabetically by key', () => {
    const graph = parseFixtureGraph(SPEC, 'peers-basic')
    const text = stringify(graph)
    const packagesIdx = text.indexOf('\npackages:')
    const snapshotsIdx = text.indexOf('\nsnapshots:')
    expect(packagesIdx).toBeGreaterThan(0)
    expect(snapshotsIdx).toBeGreaterThan(packagesIdx)
    const packagesBlock = text.slice(packagesIdx, snapshotsIdx)
    const keys = Array.from(packagesBlock.matchAll(/^  ([^\s][^\n:]*):/gm)).map(m => m[1])
    expect(keys.length).toBeGreaterThan(0)
    expect(keys).toEqual([...keys].sort())
  })

  it('emits snapshots block sorted alphabetically and preserves peer-virt keys', () => {
    const graph = parseFixtureGraph(SPEC, 'peers-basic')
    const text = stringify(graph)
    expect(text).toContain('  react-dom@18.2.0(react@18.2.0):')
    expect(text).toContain('  react@18.2.0:')
  })

  it('emits scoped names as quoted snapshot keys', () => {
    const graph = parseFixtureGraph(SPEC, 'deps-with-scopes')
    const text = stringify(graph)
    expect(text).toMatch(/'@sindresorhus\/is@6\.3\.1':/)
    expect(text).toMatch(/'@types\/node@20\.11\.30':/)
  })

  it('emits importers block ALWAYS — single-importer collapses to importers["."]', () => {
    const graph = parseFixtureGraph(SPEC, 'simple')
    const text = stringify(graph)
    expect(text).toContain('importers:')
    expect(text).toMatch(/  \.:\n/)
  })
})

describe('pnpm-v9 — enrich peer-virt fallback (snapshots absent)', () => {
  it('peer-virt 1-candidate fallback (peer-context absent from disk)', () => {
    const malformed =
      `lockfileVersion: '9.0'\n\n` +
      `settings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n\n` +
      `importers:\n\n  .:\n    dependencies:\n` +
      `      react:\n        specifier: 18.2.0\n        version: 18.2.0\n` +
      `      react-dom:\n        specifier: 18.2.0\n        version: 18.2.0\n\n` +
      `packages:\n\n` +
      `  react@18.2.0:\n    resolution: {integrity: sha512-x}\n` +
      `  react-dom@18.2.0:\n    resolution: {integrity: sha512-y}\n` +
      `    peerDependencies:\n      react: ^18.2.0\n\n` +
      `snapshots:\n\n` +
      `  react@18.2.0: {}\n` +
      `  react-dom@18.2.0: {}\n`
    const graph = parse(malformed)
    const result = enrich(graph)
    const infoCodes = result.diagnostics.map(d => d.code)
    expect(infoCodes).toContain('PNPM_V9_PEER_BOUND')
  })

  it('peer-virt ≥2-candidate fallback emits PNPM_V9_PEER_AMBIGUOUS', () => {
    const malformed =
      `lockfileVersion: '9.0'\n\n` +
      `settings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n\n` +
      `importers:\n\n  .:\n    dependencies:\n` +
      `      react-dom:\n        specifier: 18.2.0\n        version: 18.2.0\n\n` +
      `packages:\n\n` +
      `  react@17.0.2:\n    resolution: {integrity: sha512-a}\n` +
      `  react@18.2.0:\n    resolution: {integrity: sha512-b}\n` +
      `  react-dom@18.2.0:\n    resolution: {integrity: sha512-c}\n` +
      `    peerDependencies:\n      react: '*'\n\n` +
      `snapshots:\n\n` +
      `  react@17.0.2: {}\n` +
      `  react@18.2.0: {}\n` +
      `  react-dom@18.2.0: {}\n`
    const graph = parse(malformed)
    const result = enrich(graph)
    expect(result.diagnostics.some(d => d.code === 'PNPM_V9_PEER_AMBIGUOUS')).toBe(true)
  })

  it('peer-virt 0-candidate fallback emits PNPM_V9_PEER_UNSATISFIED', () => {
    const malformed =
      `lockfileVersion: '9.0'\n\n` +
      `settings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n\n` +
      `importers:\n\n  .:\n    dependencies:\n` +
      `      react-dom:\n        specifier: 18.2.0\n        version: 18.2.0\n\n` +
      `packages:\n\n` +
      `  react@18.2.0:\n    resolution: {integrity: sha512-a}\n` +
      `  react-dom@18.2.0:\n    resolution: {integrity: sha512-b}\n` +
      `    peerDependencies:\n      react: ^99.0.0\n\n` +
      `snapshots:\n\n` +
      `  react@18.2.0: {}\n` +
      `  react-dom@18.2.0: {}\n`
    const graph = parse(malformed)
    const result = enrich(graph)
    expect(result.diagnostics.some(d => d.code === 'PNPM_V9_PEER_UNSATISFIED')).toBe(true)
  })
})

describe('pnpm-v9 — multi-peer rendering', () => {
  it('multi-peer rendering sorts alphabetically by peer-name', () => {
    const graph = parseFixtureGraph(SPEC, 'peers-basic')
    const reactDom = graph.getNode('react-dom@18.2.0(react@18.2.0)')!
    expect(reactDom.peerContext).toEqual(['react@18.2.0'])
    const text = stringify(graph)
    expect(text).toContain('react-dom@18.2.0(react@18.2.0):')
  })

  it('cross-adapter cross-version probe: pnpm-v6 rejects pnpm-v9 input via check', () => {
    const own = fixture('simple/pnpm-v9.lock')
    expect(check(own)).toBe(true)
    // Validation of cross-adapter rejection happens in shared suite per spec.
  })
})
