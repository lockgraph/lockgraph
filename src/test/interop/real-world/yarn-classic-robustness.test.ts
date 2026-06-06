import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { detect, parse, stringify } from '../../../main/ts/index.ts'

// Real yarn.lock files from the yarn-audit-fix real-world sweep that reproduced
// parser-robustness gaps on snapshot.49 (git-protocol resolved URLs aborting the
// parse; duplicate descriptors throwing instead of merging). Most fixture dirs
// are pinned `<owner>-<repo>-<sha7>`. With the snapshot.49 fixes they must now
// parse and round-trip.
//
// The `*-localdep` fixtures (#83 finding 1) carry the yarn-1 local-dependency
// `resolved` shape — `resolved "file:…"` / `"link:…"` / `"portal:…"` — that
// magento/pwa-studio and hahazexia/scan2findimgs exhibited at sweep time. Their
// current default branches have since DROPPED these local deps, so the dirs
// carry the honest `-localdep` provenance suffix (NOT a fabricated `<sha7>`):
// they reproduce the exact on-disk shape rather than pin a now-absent blob.
// yarn 1 writes `resolved: remote.resolved` verbatim for copy/link references
// (src/lockfile/index.js), so the bare specifier — not an http(s) URL — is the
// genuine value; it previously aborted the whole-file parse.
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
  'magento-pwa-studio-localdep',            // link:/file:/portal: resolved (workspace monorepo)
  'hahazexia-scan2findimgs-localdep',       // file:/link: resolved + legacy uid (single-app)
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

  it('magento-pwa-studio-localdep round-trips the link:/file:/portal: resolved values verbatim', () => {
    const content = lock('magento-pwa-studio-localdep')
    const g = parse('yarn-classic', content)
    // The three local-dep nodes carry their bare specifier on Node.resolution
    // and canonicalise to a `directory` resolution (NOT a registry tarball).
    expect(g.getNode('@magento/peregrine@0.0.0')?.resolution).toBe('link:packages/peregrine')
    expect(g.getNode('@magento/pwa-buildpack@0.0.0')?.resolution).toBe('file:packages/pwa-buildpack')
    expect(g.getNode('@magento/venia-ui@0.0.0')?.resolution).toBe('portal:packages/venia-ui')
    expect(g.tarballOf('@magento/peregrine@0.0.0')?.resolution?.type).toBe('directory')
    // No spurious RECIPE_RESOLUTION_UNKNOWN for the recognised local specifiers.
    expect(g.diagnostics().some(d => d.code === 'RECIPE_RESOLUTION_UNKNOWN')).toBe(false)
    const out = stringify('yarn-classic', g)
    expect(out).toContain('resolved "link:packages/peregrine"')
    expect(out).toContain('resolved "file:packages/pwa-buildpack"')
    expect(out).toContain('resolved "portal:packages/venia-ui"')
    // Idempotent re-emit.
    expect(stringify('yarn-classic', parse('yarn-classic', out))).toBe(out)
  })

  it('hahazexia-scan2findimgs-localdep round-trips file:/link: resolved + legacy uid', () => {
    const content = lock('hahazexia-scan2findimgs-localdep')
    const g = parse('yarn-classic', content)
    expect(g.getNode('my-local-scanner@1.0.0')?.resolution).toBe('file:../my-local-scanner')
    expect(g.getNode('vendored-utils@0.0.0')?.resolution).toBe('link:./vendor/utils')
    const out = stringify('yarn-classic', g)
    expect(out).toContain('resolved "file:../my-local-scanner"')
    expect(out).toContain('resolved "link:./vendor/utils"')
    expect(out).toContain('  uid ""')
    expect(stringify('yarn-classic', parse('yarn-classic', out))).toBe(out)
  })

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
