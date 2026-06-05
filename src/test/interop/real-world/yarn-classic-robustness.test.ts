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

  it('gregros-k8ts-853de0d (berry file:-alias vs npm:) parses with distinct sentinel-disambiguated nodes', () => {
    // A `file:` local-tarball alias and an `npm:` locator both resolve to
    // @k8ts/sample-interfaces@0.6.3 yet are genuinely different artefacts
    // (canonical tarball vs registry, different checksums + dep ranges). The
    // `::locator=`-qualified `file:` entry takes the same `+patch=unresolved-…`
    // sentinel slot as link:/portal:, so the two stay DISTINCT nodes instead of
    // colliding on one NodeId. Lives in the focused `alias/` dir (NOT the
    // auto-scanned `real-world/`, which would convert this 255KB berry lock
    // cross-family and slow the suite).
    const content = readFileSync(
      resolve(here, '../../resources/fixtures/alias/gregros-k8ts-853de0d/yarn.lock'), 'utf8')
    expect(detect(content)).toMatch(/^yarn-berry/)

    const g = parse('yarn-berry-v8', content)
    const sampleNodes = Array.from(g.nodes()).filter(n => n.name === '@k8ts/sample-interfaces')
    // Both 0.6.3 entries survive as separate nodes: the plain registry node and
    // the `file:`-alias node carrying the `unresolved-…` sentinel patch.
    const versioned = sampleNodes.filter(n => n.version === '0.6.3')
    expect(versioned.length).toBe(2)
    const patched = versioned.filter(n => n.patch?.startsWith('unresolved-'))
    const unpatched = versioned.filter(n => n.patch === undefined)
    expect(patched.length).toBe(1)
    expect(unpatched.length).toBe(1)
    // The sentinel node round-trips its verbatim `file:` locator (incl. the
    // `::locator=` qualifier); the registry node keeps its `npm:` resolution.
    expect(patched[0]!.resolution).toMatch(/@file:.*::(hash=[0-9a-f]+&)?locator=/)
    expect(unpatched[0]!.resolution).toBe('@k8ts/sample-interfaces@npm:0.6.3')

    // Faithful round-trip: stringify → reparse yields the same two distinct nodes.
    const out = stringify('yarn-berry-v8', g)
    const g2 = parse('yarn-berry-v8', out)
    const reSample = Array.from(g2.nodes())
      .filter(n => n.name === '@k8ts/sample-interfaces' && n.version === '0.6.3')
    expect(reSample.length).toBe(2)
    expect(reSample.filter(n => n.patch?.startsWith('unresolved-')).length).toBe(1)
  })
})
