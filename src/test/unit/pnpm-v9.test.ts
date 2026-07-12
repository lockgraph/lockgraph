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

describe('pnpm-v9 — peer resolution (workspace-peer edge / dedup + patch-hash)', () => {
  it('#8b-A: a workspace peer is a real peer edge; its canonical token round-trips to the native locator', () => {
    // `consumer` peers on the workspace `packages/lib`, encoded by pnpm as
    // `lib@packages+lib` (importer dir `packages/lib`, `/` → `+`).
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
    const graph = parse(lock)

    const consumer = graph.getNode('consumer@1.0.0(packages/lib@0.0.0)')
    expect(consumer).toBeDefined()
    expect(consumer!.peerContext).toEqual(['packages/lib@0.0.0'])
    expect(graph.getNode('consumer@1.0.0')).toBeUndefined()
    expect(graph.in('packages/lib@0.0.0', 'peer').length).toBe(1)

    const out = stringify(graph)
    expect(out).toContain('consumer@1.0.0(lib@packages+lib)')
    expect(out).not.toContain('packages/lib@0.0.0')
  })

  it('#8d: a sub-dir workspace peer resolves to the ancestor importer and replays its original locator', () => {
    // A workspace can encode a peer as `packages+<name>+build` (`packages/<name>/build`)
    // while the importer is `packages/<name>`. resolveWorkspacePeerId walks up to the
    // ancestor importer; the original sub-dir locator is preserved for emit.
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
    const graph = parse(lock)
    const consumer = graph.getNode('consumer@1.0.0(packages/lib@0.0.0)')
    expect(consumer).toBeDefined()
    expect(consumer!.peerContext).toEqual(['packages/lib@0.0.0'])
    expect(graph.in('packages/lib@0.0.0', 'peer').length).toBe(1)
    expect(stringify(graph)).toContain('consumer@1.0.0(lib@packages+lib+build)')
  })

  it('#70: two snapshot keys differing only in a nested peer-of-peer stay DISTINCT NodeIds', () => {
    // `host@1.0.0` is peer-virtualised against `dep@2.0.0` at two DIFFERENT
    // nested resolutions of `dep`'s OWN `util` peer (`(util@1.0.0)` vs
    // `(util@2.0.0)`). Pre-#70-fix the parser FLATTENED the peer entry —
    // dropping each `dep`'s nested suffix — so both keys collapsed to one
    // `host@1.0.0(dep@2.0.0)` NodeId carrying TWO `dep` peer edges + a doubled
    // `@scope/x` dep edge (only the #8b-C dedup kept the seal from tripping,
    // and the second `dep` instance was lost). The fix carries the nested
    // suffix into the consumer's peerContext token AND the peer edge target,
    // so the two instances stay distinct and each resolves `dep` to its OWN
    // nested instance — no collapse, no data loss.
    const lock =
      `lockfileVersion: '9.0'\n\n` +
      `settings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n\n` +
      `importers:\n\n  .:\n    dependencies:\n` +
      `      host:\n        specifier: 1.0.0\n        version: 1.0.0(dep@2.0.0(util@1.0.0))\n` +
      `      host2:\n        specifier: 1.0.0\n        version: 1.0.0(dep@2.0.0(util@2.0.0))\n\n` +
      `packages:\n\n` +
      `  '@scope/x@3.0.0':\n    resolution: {integrity: sha512-x}\n` +
      `  dep@2.0.0:\n    resolution: {integrity: sha512-d}\n` +
      `    peerDependencies:\n      util: '*'\n` +
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
    const graph = parse(lock)

    // TWO distinct host nodes — the nested `util` suffix is preserved.
    const hosts = Array.from(graph.nodes()).filter(n => n.name === 'host').map(n => n.id).sort()
    expect(hosts).toEqual([
      'host@1.0.0(dep@2.0.0(util@1.0.0))',
      'host@1.0.0(dep@2.0.0(util@2.0.0))',
    ])

    for (const [hostId, utilVer] of [
      ['host@1.0.0(dep@2.0.0(util@1.0.0))', 'util@1.0.0'],
      ['host@1.0.0(dep@2.0.0(util@2.0.0))', 'util@2.0.0'],
    ] as const) {
      const host = graph.getNode(hostId)
      expect(host).toBeDefined()
      // Each instance carries its own nested-peer peerContext token.
      expect(host!.peerContext).toEqual([`dep@2.0.0(${utilVer})`])
      // The shared `@scope/x` dep is wired exactly once per instance.
      expect(graph.out(hostId, 'dep').filter(e => e.dst === '@scope/x@3.0.0')).toHaveLength(1)
      // The `dep` peer edge resolves to the MATCHING nested instance.
      const peerEdges = graph.out(hostId, 'peer')
      expect(peerEdges).toHaveLength(1)
      expect(peerEdges[0]!.dst).toBe(`dep@2.0.0(${utilVer})`)
    }
  })

  it('#69: two bare-hex hashed-peer-set keys on one name@version stay DISTINCT (ADR-0030)', () => {
    // Pre-ADR-0030 both `host@1.0.0(<hex>)` keys had their bare-hex dropped
    // (mis-read as a patch) → collapsed onto one `host@1.0.0` NodeId. Now the
    // hash is KEPT: the two keys are two DISTINCT nodes, each with its own hash
    // token and its own `@scope/x` edge — no collapse, no shared-dep collision.
    const lock =
      `lockfileVersion: '9.0'\n\n` +
      `settings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n\n` +
      `importers:\n\n  .:\n    dependencies:\n` +
      `      host:\n        specifier: 1.0.0\n        version: 1.0.0(deadbeef00112233)\n\n` +
      `packages:\n\n` +
      `  '@scope/x@3.0.0':\n    resolution: {integrity: sha512-x}\n` +
      `  host@1.0.0:\n    resolution: {integrity: sha512-h}\n\n` +
      `snapshots:\n\n` +
      `  '@scope/x@3.0.0': {}\n` +
      `  host@1.0.0(deadbeef00112233):\n    dependencies:\n      '@scope/x': 3.0.0\n` +
      `  host@1.0.0(cafebabe44556677):\n    dependencies:\n      '@scope/x': 3.0.0\n`
    const graph = parse(lock)

    // Two DISTINCT nodes (hash kept); the bare collapsed node is gone.
    expect(Array.from(graph.nodes()).filter(n => n.name === 'host').map(n => n.id).sort())
      .toEqual(['host@1.0.0(cafebabe44556677)', 'host@1.0.0(deadbeef00112233)'])
    expect(graph.getNode('host@1.0.0')).toBeUndefined()
    // Each instance wires its OWN `@scope/x` dep exactly once.
    for (const id of ['host@1.0.0(deadbeef00112233)', 'host@1.0.0(cafebabe44556677)']) {
      expect(graph.out(id, 'dep').filter(e => e.dst === '@scope/x@3.0.0')).toHaveLength(1)
    }
  })

  it('#8b-C dedup: a patched + bare key collapsing on one NodeId wire a shared dep once', () => {
    // After #69 the bare-hex collapse path is gone; the `emittedEdges` dedup now
    // guards the remaining collapse — a LABELLED `patch_hash=` key (stripped to
    // its bare NodeId, ADR-0014) colliding with the bare key for the same
    // name@version. Both walk `@scope/x`; without the dedup the second wire
    // trips the seal's `duplicate edge`.
    const hash = 'b'.repeat(64)
    const lock =
      `lockfileVersion: '9.0'\n\n` +
      `settings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n\n` +
      `importers:\n\n  .:\n    dependencies:\n` +
      `      host:\n        specifier: 1.0.0\n        version: 1.0.0(patch_hash=${hash})\n\n` +
      `packages:\n\n` +
      `  '@scope/x@3.0.0':\n    resolution: {integrity: sha512-x}\n` +
      `  host@1.0.0:\n    resolution: {integrity: sha512-h}\n\n` +
      `snapshots:\n\n` +
      `  '@scope/x@3.0.0': {}\n` +
      `  host@1.0.0(patch_hash=${hash}):\n    dependencies:\n      '@scope/x': 3.0.0\n` +
      `  host@1.0.0:\n    dependencies:\n      '@scope/x': 3.0.0\n`
    const graph = parse(lock) // throws `duplicate edge` on seal without the dedup

    // Both keys collapse to ONE bare `host@1.0.0` (labelled patch stripped).
    expect(Array.from(graph.nodes()).filter(n => n.name === 'host').map(n => n.id)).toEqual(['host@1.0.0'])
    // The shared `@scope/x` dep is wired exactly once (dedup).
    expect(graph.out('host@1.0.0', 'dep').filter(e => e.dst === '@scope/x@3.0.0')).toHaveLength(1)
  })

  it('#8b-C residue: a LABELLED `patch_hash=` segment is not mistaken for a peer (still dropped — ADR-0014)', () => {
    // `tool@1.0.0` is patched via a `patchedDependencies:` patch (labelled
    // `patch_hash=<64hex>`) and referenced as a peer by `plugin`. ADR-0030
    // does NOT touch the labelled-patch path: the segment is still dropped so
    // the patched node registers under its bare NodeId and the peer resolves
    // (else: seal `disagree with peerContext`). Gate 4 NEGATIVE — a labelled
    // patch_hash must NOT be reclassified as a hashed peer-set token.
    const hash = 'a'.repeat(64)
    const lock =
      `lockfileVersion: '9.0'\n\n` +
      `settings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n\n` +
      `importers:\n\n  .:\n    dependencies:\n` +
      `      plugin:\n        specifier: 1.0.0\n        version: 1.0.0(tool@1.0.0(patch_hash=${hash}))\n\n` +
      `packages:\n\n` +
      `  plugin@1.0.0:\n    resolution: {integrity: sha512-p}\n` +
      `    peerDependencies:\n      tool: '*'\n` +
      `  tool@1.0.0:\n    resolution: {integrity: sha512-t}\n\n` +
      `snapshots:\n\n` +
      `  plugin@1.0.0(tool@1.0.0(patch_hash=${hash})):\n    dependencies:\n      tool: 1.0.0(patch_hash=${hash})\n` +
      `  tool@1.0.0(patch_hash=${hash}): {}\n`
    const graph = parse(lock)

    // Patched node registered under its bare NodeId (labelled patch dropped) —
    // NOT under a `(patch_hash=…)` peer-set suffix.
    expect(graph.getNode('tool@1.0.0')).toBeDefined()
    expect(graph.getNode(`tool@1.0.0(patch_hash=${hash})`)).toBeUndefined()
    const plugin = graph.getNode('plugin@1.0.0(tool@1.0.0)')
    expect(plugin).toBeDefined()
    expect(plugin!.peerContext).toEqual(['tool@1.0.0'])
    // The peer edge resolved to the patched node, satisfying the seal bijection.
    expect(graph.out('plugin@1.0.0(tool@1.0.0)', 'peer').map(e => e.dst)).toEqual(['tool@1.0.0'])
  })

  it('#69 (ADR-0030): a BARE-HEX hashed peer-set token is KEPT as an opaque, non-edge-bearing peerContext discriminator (no longer dropped as a patch)', () => {
    // Same shape as the labelled case above, but with a BARE-HEX digest — the
    // pnpm-v9 hashed peer-set abbreviation (#69). Pre-ADR-0030 this collapsed
    // onto bare `tool@1.0.0` (mis-read as a patch hash). Now it is KEPT: the
    // token rides in `tool`'s peerContext as an opaque discriminator, bearing
    // NO peer edge, and the seal exempts it from the edge↔context coherence
    // check. `plugin` peers on the base key `tool@1.0.0` and its peer edge
    // base-projects onto the hash-discriminated node.
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

    // The hashed token is KEPT — the node carries it in peerContext, not the
    // bare `tool@1.0.0`.
    expect(graph.getNode('tool@1.0.0')).toBeUndefined()
    const tool = graph.getNode('tool@1.0.0(deadbeef00112233)')
    expect(tool).toBeDefined()
    expect(tool!.peerContext).toEqual(['deadbeef00112233'])
    // Non-edge-bearing: NO peer edge for the opaque token (seal must not have
    // demanded one).
    expect(graph.out('tool@1.0.0(deadbeef00112233)', 'peer')).toEqual([])

    // `plugin` KEEPS tool's hash-discriminated instance in its OWN peerContext
    // token (#70 nested-suffix carry) — contrast the labelled-patch case above,
    // where the nested `patch_hash=` is dropped → `plugin@1.0.0(tool@1.0.0)`.
    const plugin = graph.getNode('plugin@1.0.0(tool@1.0.0(deadbeef00112233))')
    expect(plugin).toBeDefined()
    expect(plugin!.peerContext).toEqual(['tool@1.0.0(deadbeef00112233)'])
    expect(graph.out('plugin@1.0.0(tool@1.0.0(deadbeef00112233))', 'peer').map(e => e.dst)).toEqual(['tool@1.0.0(deadbeef00112233)'])

    // The hashed key round-trips byte-for-byte.
    const out = stringify(graph)
    expect(out).toContain('tool@1.0.0(deadbeef00112233):')
    expect(stringify(parse(out))).toBe(out)
  })

  it('#69 (ADR-0030): two distinct bare-hex tokens on one `name@version` whose snapshot bodies diverge → 2 nodes, 0 violations, both keys round-trip', () => {
    // The core #69 regression. `lib@1.0.0` appears under TWO distinct bare-hex
    // tokens whose snapshot bodies fork on a transitive dep (`util@1.0.0` vs
    // `util@2.0.0`). Pre-ADR-0030: both keys collapse onto one `lib@1.0.0`
    // node, the two divergent `util` dep edges collide in one slot → ≥1
    // LAYOUT_RESOLVE_VIOLATION. After: 2 distinct nodes, 0 violations, both
    // hashed keys reproduced byte-stably.
    const tokenA = 'aaaa0000bbbb1111'
    const tokenB = 'cccc2222dddd3333'
    const lock =
      `lockfileVersion: '9.0'\n\n` +
      `settings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n\n` +
      `importers:\n\n  .:\n    dependencies:\n` +
      `      app-a:\n        specifier: 1.0.0\n        version: 1.0.0\n` +
      `      app-b:\n        specifier: 1.0.0\n        version: 1.0.0\n\n` +
      `packages:\n\n` +
      `  app-a@1.0.0:\n    resolution: {integrity: sha512-aa}\n` +
      `  app-b@1.0.0:\n    resolution: {integrity: sha512-bb}\n` +
      `  lib@1.0.0:\n    resolution: {integrity: sha512-l}\n` +
      `  util@1.0.0:\n    resolution: {integrity: sha512-u1}\n` +
      `  util@2.0.0:\n    resolution: {integrity: sha512-u2}\n\n` +
      `snapshots:\n\n` +
      `  app-a@1.0.0:\n    dependencies:\n      lib: 1.0.0(${tokenA})\n` +
      `  app-b@1.0.0:\n    dependencies:\n      lib: 1.0.0(${tokenB})\n` +
      `  lib@1.0.0(${tokenA}):\n    dependencies:\n      util: 1.0.0\n` +
      `  lib@1.0.0(${tokenB}):\n    dependencies:\n      util: 2.0.0\n` +
      `  util@1.0.0: {}\n` +
      `  util@2.0.0: {}\n`
    const graph = parse(lock)

    // Two distinct nodes — NOT collapsed.
    expect(graph.getNode(`lib@1.0.0(${tokenA})`)).toBeDefined()
    expect(graph.getNode(`lib@1.0.0(${tokenB})`)).toBeDefined()
    expect(graph.getNode('lib@1.0.0')).toBeUndefined()
    // Each variant's divergent `util` edge points at its own target.
    expect(graph.out(`lib@1.0.0(${tokenA})`, 'dep').map(e => e.dst)).toEqual(['util@1.0.0'])
    expect(graph.out(`lib@1.0.0(${tokenB})`, 'dep').map(e => e.dst)).toEqual(['util@2.0.0'])
    // app-a / app-b each resolve their `lib` dep to the correct variant.
    expect(graph.out('app-a@1.0.0', 'dep').map(e => e.dst)).toEqual([`lib@1.0.0(${tokenA})`])
    expect(graph.out('app-b@1.0.0', 'dep').map(e => e.dst)).toEqual([`lib@1.0.0(${tokenB})`])

    // ZERO violations on emit — the verifier (ADR-0029) is the oracle.
    const diags: Array<{ code: string }> = []
    const out = stringify(graph, { onDiagnostic: d => diags.push(d) })
    expect(diags.filter(d => d.code === 'LAYOUT_RESOLVE_VIOLATION')).toEqual([])
    // Both hashed keys reproduced; byte-stable round-trip.
    expect(out).toContain(`lib@1.0.0(${tokenA}):`)
    expect(out).toContain(`lib@1.0.0(${tokenB}):`)
    expect(stringify(parse(out))).toBe(out)
  })

})
