import { describe, expect, it } from 'vitest'
import { parseFormat, stringifyFormat } from '../_dispatch.ts'
import { fixtureLockfile } from '../_fixtures.ts'
import { graphSnapshot } from '../_snapshot.ts'

describe('interop adversarial §8.5 — CRLF normalisation', () => {
  it('classic -> berry-v9 preserves graph identity while honoring CRLF output', () => {
    const sourceLockfile = fixtureLockfile('yarn-crlf', 'yarn-classic')
    const sourceGraph = parseFormat('yarn-classic', sourceLockfile)
    const emitted = stringifyFormat('yarn-berry-v9', sourceGraph, { lineEnding: 'crlf' })
    const destinationGraph = parseFormat('yarn-berry-v9', emitted.lockfile)

    expect(emitted.lockfile).toContain('\r\n')
    expect(graphSnapshot(destinationGraph)).toEqual(graphSnapshot(sourceGraph))
  })
})
