import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { detect, parse, stringify } from '../../../main/ts/index.ts'

// Real yarn.lock files from the yarn-audit-fix real-world sweep that reproduced
// parser-robustness gaps on snapshot.49 (git-protocol resolved URLs aborting the
// parse; duplicate descriptors throwing instead of merging). Each fixture dir is
// pinned `<owner>-<repo>-<sha7>`. With the snapshot.49 fixes they must now parse
// and round-trip.
const here = dirname(fileURLToPath(import.meta.url))
const lock = (name: string): string =>
  readFileSync(resolve(here, '../../resources/fixtures/real-world', name, 'yarn.lock'), 'utf8')

const CLASSIC = [
  'amedina-agentic-web-labs-4066eb3',       // git+ssh resolved URL
  'lightsydeco-fusion-d9af0e7',             // git+ssh resolved URL (813 nodes)
  'shareable-resources-eurus-5b26db2',      // git:// resolved URL
  'ratnasari124-frontend-fintrack-43abe57', // duplicate descriptors
  'scvodigital-http-c54c08a',               // duplicate descriptors
  'wasya-co-piousbox-drupal-theme-0a9b3e1', // duplicate descriptors
  'dougyshy-mern-skeleton-f510b7a',         // duplicate descriptors
  'lodash-lodash-5a3ff73',                  // entry immediately after header (no blank line)
] as const

describe('real-world yarn-classic robustness (yarn-audit-fix sweep)', () => {
  for (const name of CLASSIC) {
    it(`${name} detects as yarn-classic, parses, and round-trips`, () => {
      const content = lock(name)
      expect(detect(content)).toBe('yarn-classic')
      const g = parse('yarn-classic', content)
      expect(Array.from(g.nodes()).length).toBeGreaterThan(0)
      expect(() => stringify('yarn-classic', g)).not.toThrow()
    })
  }

  it('gregros-k8ts-853de0d (berry npm:-alias) still collapses — known gap, tracked separately', () => {
    // A `file:` tarball alias and an `npm:` locator both resolve to
    // @k8ts/sample-interfaces@0.6.3; the locator qualifier is dropped so they
    // collapse onto one NodeId. Distinct from the yarn-classic duplicate-merge —
    // fixing it needs locator-aware disambiguation. Lives under `known-failing/`
    // (not the auto-scanned `real-world/`); flip to no-throw + move it when fixed.
    const content = readFileSync(
      resolve(here, '../../resources/fixtures/known-failing/gregros-k8ts-853de0d/yarn.lock'), 'utf8')
    expect(detect(content)).toMatch(/^yarn-berry/)
    expect(() => parse('yarn-berry-v8', content)).toThrow(/collapse onto NodeId @k8ts\/sample-interfaces@0\.6\.3/)
  })
})
