import { describe, expect, it } from 'vitest'
import { convert } from '../_dispatch.ts'
import { fixtureLockfile } from '../_fixtures.ts'
import { graphSnapshot } from '../_snapshot.ts'

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
    expect(graphSnapshot(result.destinationGraph)).toEqual(graphSnapshot(result.sourceGraph))
  })
})
