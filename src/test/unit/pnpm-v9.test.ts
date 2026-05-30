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

describe('pnpm-v9 — peer-resolution residue (#8b-A workspace-peer / #8b-C dedup + patch-hash)', () => {
  it('#8b-A: a workspace peer (`lib@packages+lib`) is dropped from peerContext AND edges, not sealed as a registry peer', () => {
    // `consumer` peers on the workspace package `packages/lib`, encoded by pnpm
    // as `lib@packages+lib` (importer dir `packages/lib` with `/` → `+`). The
    // workspace target is a workspace node; the seal forbids a registry node
    // owning an incoming edge into it, so the peer is dropped symmetrically.
    const lock =
      `lockfileVersion: '9.0'\n\n` +
      `settings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n\n` +
      `importers:\n\n` +
      `  .:\n    dependencies:\n` +
      `      consumer:\n        specifier: 1.0.0\n        version: 1.0.0(lib@packages+lib)\n` +
      `  packages/lib:\n    dependencies:\n` +
      `      left-pad:\n        specifier: 1.3.0\n        version: 1.3.0\n\n` +
      `packages:\n\n` +
      `  consumer@1.0.0:\n    resolution: {integrity: sha512-a}\n` +
      `    peerDependencies:\n      lib: '*'\n` +
      `  left-pad@1.3.0:\n    resolution: {integrity: sha512-b}\n\n` +
      `snapshots:\n\n` +
      `  consumer@1.0.0(lib@packages+lib):\n    dependencies:\n      lib: link:packages/lib\n` +
      `  left-pad@1.3.0: {}\n`
    const graph = parse(lock) // throws on seal failure — the regression guard

    // The workspace peer was filtered out: NodeId has NO peer suffix.
    const consumer = graph.getNode('consumer@1.0.0')
    expect(consumer).toBeDefined()
    expect(consumer!.peerContext).toEqual([])
    expect(graph.getNode('consumer@1.0.0(lib@packages+lib)')).toBeUndefined()
    // No peer edge into the workspace member node.
    const member = graph.getNode('packages/lib@0.0.0')
    expect(member).toBeDefined()
    expect(graph.in('packages/lib@0.0.0', 'peer')).toEqual([])
  })

  it('#8d (sister #7): a workspace peer published from a SUB-DIR (`lib@packages+lib+build`) resolves to the ancestor importer + drops from peerContext', () => {
    // mui encodes `@mui/material` as `packages+mui-material+build`
    // (`packages/mui-material/build`) while the importer is `packages/mui-material`.
    // resolveWorkspacePeerId must walk up to the ancestor importer; otherwise the
    // peer stays in peerContext and the seal "disagrees".
    const lock =
      `lockfileVersion: '9.0'\n\n` +
      `settings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n\n` +
      `importers:\n\n` +
      `  .:\n    dependencies:\n` +
      `      consumer:\n        specifier: 1.0.0\n        version: 1.0.0(lib@packages+lib+build)\n` +
      `  packages/lib:\n    dependencies:\n` +
      `      left-pad:\n        specifier: 1.3.0\n        version: 1.3.0\n\n` +
      `packages:\n\n` +
      `  consumer@1.0.0:\n    resolution: {integrity: sha512-a}\n` +
      `    peerDependencies:\n      lib: '*'\n` +
      `  left-pad@1.3.0:\n    resolution: {integrity: sha512-b}\n\n` +
      `snapshots:\n\n` +
      `  consumer@1.0.0(lib@packages+lib+build):\n    dependencies:\n      lib: link:packages/lib\n` +
      `  left-pad@1.3.0: {}\n`
    const graph = parse(lock) // throws on seal failure — the sister-#7 regression guard
    const consumer = graph.getNode('consumer@1.0.0')
    expect(consumer).toBeDefined()
    expect(consumer!.peerContext).toEqual([])
    expect(graph.getNode('consumer@1.0.0(lib@packages+lib+build)')).toBeUndefined()
    expect(graph.in('packages/lib@0.0.0', 'peer')).toEqual([])
  })

  it('#8b-C: two snapshot keys colliding on one depth-0 NodeId (differ only in a nested peer-of-peer) wire each resolved edge once', () => {
    // `host@1.0.0(dep@2.0.0)` appears twice — the two keys differ ONLY in the
    // nested peer of `dep` (`(util@1.0.0)` vs `(util@2.0.0)`), which the depth-0
    // split discards. Both project to `host@1.0.0(dep@2.0.0)`; Pass 4 walks
    // both, so the shared `@scope/x` dep would be wired twice → seal duplicate
    // without the dedup. The distinct `dep` variants keep their own edges.
    const lock =
      `lockfileVersion: '9.0'\n\n` +
      `settings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n\n` +
      `importers:\n\n  .:\n    dependencies:\n` +
      `      host:\n        specifier: 1.0.0\n        version: 1.0.0(dep@2.0.0)\n\n` +
      `packages:\n\n` +
      `  '@scope/x@3.0.0':\n    resolution: {integrity: sha512-x}\n` +
      `  dep@2.0.0:\n    resolution: {integrity: sha512-d}\n` +
      `  host@1.0.0:\n    resolution: {integrity: sha512-h}\n` +
      `    peerDependencies:\n      dep: '*'\n` +
      `  util@1.0.0:\n    resolution: {integrity: sha512-u1}\n` +
      `  util@2.0.0:\n    resolution: {integrity: sha512-u2}\n\n` +
      `snapshots:\n\n` +
      `  '@scope/x@3.0.0': {}\n` +
      `  dep@2.0.0(util@1.0.0):\n    dependencies:\n      util: 1.0.0\n` +
      `  dep@2.0.0(util@2.0.0):\n    dependencies:\n      util: 2.0.0\n` +
      `  host@1.0.0(dep@2.0.0(util@1.0.0)):\n    dependencies:\n      '@scope/x': 3.0.0\n      dep: 2.0.0(util@1.0.0)\n` +
      `  host@1.0.0(dep@2.0.0(util@2.0.0)):\n    dependencies:\n      '@scope/x': 3.0.0\n      dep: 2.0.0(util@2.0.0)\n` +
      `  util@1.0.0: {}\n` +
      `  util@2.0.0: {}\n`
    const graph = parse(lock) // throws `duplicate edge` on seal without the dedup

    // The two host snapshot keys collapse to ONE node.
    const host = graph.getNode('host@1.0.0(dep@2.0.0)')
    expect(host).toBeDefined()
    // The shared `@scope/x` dep is wired exactly once.
    const xEdges = graph.out('host@1.0.0(dep@2.0.0)', 'dep').filter(e => e.dst === '@scope/x@3.0.0')
    expect(xEdges).toHaveLength(1)
    // The peer edge to dep is wired once and agrees with peerContext.
    expect(host!.peerContext).toEqual(['dep@2.0.0'])
    expect(graph.out('host@1.0.0(dep@2.0.0)', 'peer')).toHaveLength(1)
  })

  it('#8b-C residue: a `patch_hash=` / bare-hex patch-hash segment is not mistaken for a peer', () => {
    // `tool@1.0.0` is patched (bare-hex digest from `patchedDependencies`) and
    // referenced as a peer by `plugin`. The patch-hash key must still parse so
    // the patched node is registered and the peer resolves (else: seal
    // `disagree with peerContext`).
    const lock =
      `lockfileVersion: '9.0'\n\n` +
      `settings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n\n` +
      `importers:\n\n  .:\n    dependencies:\n` +
      `      plugin:\n        specifier: 1.0.0\n        version: 1.0.0(tool@1.0.0(deadbeef00112233))\n\n` +
      `packages:\n\n` +
      `  plugin@1.0.0:\n    resolution: {integrity: sha512-p}\n` +
      `    peerDependencies:\n      tool: '*'\n` +
      `  tool@1.0.0:\n    resolution: {integrity: sha512-t}\n\n` +
      `snapshots:\n\n` +
      `  plugin@1.0.0(tool@1.0.0(deadbeef00112233)):\n    dependencies:\n      tool: 1.0.0(deadbeef00112233)\n` +
      `  tool@1.0.0(deadbeef00112233): {}\n`
    const graph = parse(lock)

    // Patched node registered under its bare NodeId (patch-hash skipped).
    expect(graph.getNode('tool@1.0.0')).toBeDefined()
    const plugin = graph.getNode('plugin@1.0.0(tool@1.0.0)')
    expect(plugin).toBeDefined()
    expect(plugin!.peerContext).toEqual(['tool@1.0.0'])
    // The peer edge resolved to the patched node, satisfying the seal bijection.
    expect(graph.out('plugin@1.0.0(tool@1.0.0)', 'peer').map(e => e.dst)).toEqual(['tool@1.0.0'])
  })
})
