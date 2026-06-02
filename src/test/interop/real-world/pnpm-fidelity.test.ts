import { describe, expect, it } from 'vitest'
import { parse, stringify } from '../../../main/ts/index.ts'

// pnpm-v9 ROUND-TRIP FIDELITY — four packages/snapshots fields that the
// parser/stringifier previously dropped on `parse → stringify`, each riding an
// EXISTING model carrier (no model change):
//
//   A. `packages[<k>].libc`                 → TarballPayload.libc (+ sidecar)
//   B. `packages[<k>].deprecated`           → TarballPayload.deprecated
//   C. `snapshots[<k>].transitivePeerDependencies` → PnpmNodeSidecar
//   D. `packages[<k>].peerDependenciesMeta` → EdgeAttrs.optional (bound peers)
//      + verbatim PnpmNodeSidecar carrier (unbound optional peers, which have
//      no peer-virt instance and thus no edge).
//
// The synthetic lock exercises all four, INCLUDING the hard case for D — an
// optional peer pnpm never resolved (`unresolved-optional`, no snapshot, no
// edge) alongside a resolved optional peer (`peerpkg`, bound + edge-flagged).

const sha = (c: string) => `sha512-${c.repeat(86)}`

const FIDELITY_V9 = [
  `lockfileVersion: '9.0'`,
  ``,
  `settings:`,
  `  autoInstallPeers: true`,
  `  excludeLinksFromLockfile: false`,
  ``,
  `importers:`,
  ``,
  `  .:`,
  `    dependencies:`,
  `      host:`,
  `        specifier: ^1.0.0`,
  `        version: 1.0.0(peerpkg@2.0.0)`,
  ``,
  `packages:`,
  ``,
  `  host@1.0.0:`,
  `    resolution: {integrity: ${sha('a')}}`,
  `    engines: {node: '>=18'}`,
  `    deprecated: use host2 instead — this build is EOL`,
  `    cpu: [x64]`,
  `    os: [linux]`,
  `    libc: [glibc]`,
  `    peerDependencies:`,
  `      peerpkg: ^2.0.0`,
  `      unresolved-optional: '*'`,
  `    peerDependenciesMeta:`,
  `      peerpkg:`,
  `        optional: true`,
  `      unresolved-optional:`,
  `        optional: true`,
  ``,
  `  peerpkg@2.0.0:`,
  `    resolution: {integrity: ${sha('b')}}`,
  ``,
  `  leaf@3.0.0:`,
  `    resolution: {integrity: ${sha('c')}}`,
  ``,
  `snapshots:`,
  ``,
  `  'host@1.0.0(peerpkg@2.0.0)':`,
  `    dependencies:`,
  `      leaf: 3.0.0`,
  `      peerpkg: 2.0.0`,
  `    transitivePeerDependencies:`,
  `      - some-transitive-peer`,
  `      - another-transitive-peer`,
  ``,
  `  peerpkg@2.0.0: {}`,
  ``,
  `  leaf@3.0.0: {}`,
  ``,
].join('\n')

describe('pnpm-v9 round-trip fidelity — libc / deprecated / transitivePeerDependencies / peerDependenciesMeta', () => {
  it('A: libc rides through and re-parses as an array', () => {
    const out = stringify('pnpm-v9', parse('pnpm-v9', FIDELITY_V9))
    expect(out).toMatch(/host@1\.0\.0:[\s\S]*?libc:/)
    const g2 = parse('pnpm-v9', out)
    const t = g2.tarballOf('host@1.0.0(peerpkg@2.0.0)')
    expect(t?.libc).toEqual(['glibc'])
  })

  it('B: deprecated rides through (TarballPayload) and re-parses', () => {
    const out = stringify('pnpm-v9', parse('pnpm-v9', FIDELITY_V9))
    expect(out).toContain('deprecated: use host2 instead')
    const g2 = parse('pnpm-v9', out)
    expect(g2.tarballOf('host@1.0.0(peerpkg@2.0.0)')?.deprecated).toBe(
      'use host2 instead — this build is EOL',
    )
  })

  it('C: transitivePeerDependencies round-trips verbatim', () => {
    const out = stringify('pnpm-v9', parse('pnpm-v9', FIDELITY_V9))
    expect(out).toContain('transitivePeerDependencies:')
    expect(out).toContain('- some-transitive-peer')
    expect(out).toContain('- another-transitive-peer')
  })

  it('D: peerDependenciesMeta — bound peer flagged on its edge (EdgeAttrs.optional)', () => {
    const g = parse('pnpm-v9', FIDELITY_V9)
    const peerEdges = g.out('host@1.0.0(peerpkg@2.0.0)').filter(e => e.kind === 'peer')
    const bound = peerEdges.find(e => g.getNode(e.dst)?.name === 'peerpkg')
    expect(bound).toBeDefined()
    expect(bound!.attrs?.optional).toBe(true)
  })

  it('D: peerDependenciesMeta round-trips fully — INCLUDING the unbound optional peer', () => {
    const out = stringify('pnpm-v9', parse('pnpm-v9', FIDELITY_V9))
    // Both the resolved (peerpkg) and the never-resolved (unresolved-optional)
    // markers survive — the latter has no edge, so the verbatim sidecar carrier
    // is what preserves it.
    expect(out).toContain('peerDependenciesMeta:')
    expect(out).toMatch(/peerpkg:\s*\n\s*optional: true/)
    expect(out).toMatch(/unresolved-optional:\s*\n\s*optional: true/)

    const g2 = parse('pnpm-v9', out)
    const peerEdges = g2.out('host@1.0.0(peerpkg@2.0.0)').filter(e => e.kind === 'peer')
    expect(peerEdges.find(e => g2.getNode(e.dst)?.name === 'peerpkg')?.attrs?.optional).toBe(true)
  })

  it('all four fields are byte-stable under a second round-trip (idempotent)', () => {
    const once = stringify('pnpm-v9', parse('pnpm-v9', FIDELITY_V9))
    const twice = stringify('pnpm-v9', parse('pnpm-v9', once))
    expect(twice).toBe(once)
  })

  it('no identity/seal perturbation — node set is unchanged by the optional attr', () => {
    const g = parse('pnpm-v9', FIDELITY_V9)
    const ids = Array.from(g.nodes()).map(n => n.id).sort()
    expect(ids).toContain('host@1.0.0(peerpkg@2.0.0)')
    expect(ids).toContain('peerpkg@2.0.0')
    expect(ids).toContain('leaf@3.0.0')
    // host carries exactly its one bound peer in peerContext (the unbound
    // optional peer does NOT enter identity).
    const host = g.getNode('host@1.0.0(peerpkg@2.0.0)')
    expect(host?.peerContext).toEqual(['peerpkg@2.0.0'])
  })
})
