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
    // makes the registry `resolution` URL host attribution and the PM-native
    // `nativeResolution` sidecar adapter-specific. Berry's npm locator records
    // no host, so ADR-0041 reparses it as `{type:'registry'}` rather than
    // fabricating `registry.npmjs.org`.
    // `integrity` is excluded for the same reason `graphSnapshot` excluded it
    // (: a tarball SRI and a berry zip digest are different artefacts, so
    // a cross-origin classic→berry convert does not carry the source digest).
    // Integrity and the explicitly declared resolved-url carrier loss are the
    // only exclusions; every other feature remains asserted.
    expect(graphSubset(
      result.sourceGraph,
      result.destinationGraph,
      ['nodes', 'edges', 'edge-kinds', 'tarballs', 'workspace-membership', 'patch-slots', 'peer-virt', 'conditions'],
    )).toBe(true)
  })
})
