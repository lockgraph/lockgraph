import { describe, expect, it } from 'vitest'
import { convert } from '../_dispatch.ts'
import { fixtureLockfile } from '../_fixtures.ts'
import { graphSubset } from '../_graph-features.ts'

describe('interop adversarial §8.5 — CRLF normalisation', () => {
  it('classic -> berry-v9 preserves graph identity while honoring CRLF output', () => {
    const sourceLockfile = fixtureLockfile('yarn-crlf', 'yarn-classic')
    const result = convert({
      from: 'yarn-classic',
      to: 'yarn-berry-v9',
      source: sourceLockfile,
      mode: 'naive',
      options: { lineEnding: 'crlf' },
    })

    expect(result.lockfile).toContain('\r\n')
    // Cross-format identity is the origin-aware `graphSubset` (the classic→berry
    // graph-identity feature set), NOT byte-identical `graphSnapshot` equality:
    // ADR-0014 §4.F3 makes the registry `resolution` URL host attribution
    // (yarn-classic emits `registry.yarnpkg.com`; yarn-berry recomposes the
    // canonical `registry.npmjs.org` from the `<name>@npm:<version>` locator) and
    // the PM-native `nativeResolution` sidecar adapter-specific — so a registry
    // tarball legitimately changes URL host + sheds its classic URL sidecar across
    // the convert while node / edge / canonical-resolution-type identity holds.
    // `integrity` is excluded for the same reason `graphSnapshot` excluded it
    // (ADR-0031: a tarball SRI and a berry zip digest are different artefacts, so
    // a cross-origin classic→berry convert does not carry the source digest).
    // `integrity` is the SINGLE legitimate exclusion (above); every other feature
    // is asserted so a registry-host change is the only divergence this allows.
    expect(graphSubset(
      result.sourceGraph,
      result.destinationGraph,
      ['nodes', 'edges', 'edge-kinds', 'resolved-url', 'tarballs', 'workspace-membership', 'patch-slots', 'peer-virt', 'conditions'],
    )).toBe(true)
  })
})
