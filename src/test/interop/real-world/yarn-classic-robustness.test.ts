import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
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
    // The three local-dep nodes carry their bare specifier on the per-tarball
    // nativeResolution and canonicalise to a `directory` resolution (NOT a
    // registry tarball).
    expect(g.tarballOf('@magento/peregrine@0.0.0')?.nativeResolution).toBe('link:packages/peregrine')
    expect(g.tarballOf('@magento/pwa-buildpack@0.0.0')?.nativeResolution).toBe('file:packages/pwa-buildpack')
    expect(g.tarballOf('@magento/venia-ui@0.0.0')?.nativeResolution).toBe('portal:packages/venia-ui')
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
    expect(g.tarballOf('my-local-scanner@1.0.0')?.nativeResolution).toBe('file:../my-local-scanner')
    expect(g.tarballOf('vendored-utils@0.0.0')?.nativeResolution).toBe('link:./vendor/utils')
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
    // `::locator=` qualifier) — a NON-canonical native, so it is stored. The
    // registry node's resolution is the canonical `@k8ts/sample-interfaces@npm:0.6.3`,
    // which the berry adapter NO LONGER stores (it is recomposed from the node's
    // (name, version) at emit), so its stored native is undefined while its
    // canonical tarball resolution survives.
    expect(g.tarballOf(patched[0]!.id)?.nativeResolution).toMatch(/@file:.*::(hash=[0-9a-f]+&)?locator=/)
    expect(g.tarballOf(unpatched[0]!.id)?.nativeResolution).toBeUndefined()
    expect(g.tarballOf(unpatched[0]!.id)?.resolution).toEqual({
      type: 'tarball',
      url:  'https://registry.npmjs.org/@k8ts/sample-interfaces/-/sample-interfaces-0.6.3.tgz',
    })

    // Faithful round-trip: stringify → reparse yields the same two distinct nodes.
    const out = stringify('yarn-berry-v8', g, { strict: false })
    const g2 = parse('yarn-berry-v8', out)
    const reSample = Array.from(g2.nodes())
      .filter(n => n.name === '@k8ts/sample-interfaces' && n.version === '0.6.3')
    expect(reSample.length).toBe(2)
    expect(reSample.filter(n => n.patch?.startsWith('unresolved-')).length).toBe(1)
  })

  // F5 (#92) — a gatsby-class lock carrying the quoted, space-separated
  // multi-hash integrity form (`integrity "sha1-… sha512-…"`). Repro class:
  // gatsbyjs/gatsby@1f38c85963fd6bcfa9ccee2f925e5e02b00eafbb (12/12 entries
  // dropped their integrity entirely on parse pre-fix). Lives in the focused
  // `integrity/` dir (small, asserted directly) rather than the auto-scanned
  // `real-world/`. Every algorithm of every multi-hash entry must survive.
  it('gatsbyjs-gatsby-1f38c85 multi-hash integrity — every algorithm survives parse + round-trip (F5)', () => {
    const content = readFileSync(
      resolve(here, '../../resources/fixtures/integrity/gatsbyjs-gatsby-1f38c85-multihash/yarn.lock'), 'utf8')
    expect(detect(content)).toBe('yarn-classic')
    const g = parse('yarn-classic', content)
    // The two multi-hash entries each keep BOTH a sha1 and a sha512 (not
    // collapsed to one, not dropped).
    for (const id of ['abbrev@1.1.1', 'ansi-regex@3.0.1']) {
      const integrity = g.tarballOf(id)?.integrity
      expect(integrity, id).toBeDefined()
      expect(integrity!.hashes.map(h => h.algorithm).sort(), id).toEqual(['sha1', 'sha512'])
    }
    // No silent integrity loss anywhere.
    expect(g.diagnostics().some(d => d.code === 'YARN_CLASSIC_INVALID_INTEGRITY')).toBe(false)
    const out = stringify('yarn-classic', g)
    // The multi-hash form re-emits QUOTED; the single-hash `ms` entry stays bare.
    expect(out).toContain('integrity "sha1-')
    expect(out).toMatch(/\n {2}integrity sha512-[A-Za-z0-9+/]+=*\n/)
    expect(stringify('yarn-classic', parse('yarn-classic', out))).toBe(out)
  })

  // F6 (#93) — the `<pkg>-cjs@npm:<pkg>@^N` self-alias trio (`string-width-cjs`
  // / `strip-ansi-cjs` / `wrap-ansi-cjs`) that @isaacs/cliui declares. Each
  // aliased entry must stay ONE node keyed by its target, not split into a
  // phantom `<alias>@<version>` duplicate. Focused `alias/` dir (not the
  // auto-scanned `real-world/`).
  it('isaacs-cliui-8.0.1 cjs-alias trio — each aliased entry is one node by target, round-trips (F6)', () => {
    const content = readFileSync(
      resolve(here, '../../resources/fixtures/alias/isaacs-cliui-8.0.1-cjs-aliastrio/yarn.lock'), 'utf8')
    expect(detect(content)).toBe('yarn-classic')
    const g = parse('yarn-classic', content)
    // Each alias target is a SINGLE node; no phantom `<alias>@<version>` siblings.
    for (const [target, version] of [['string-width', '4.2.3'], ['strip-ansi', '6.0.1'], ['wrap-ansi', '7.0.0']] as const) {
      expect(g.byName(target), target).toEqual([`${target}@${version}`])
    }
    expect(g.byName('string-width-cjs')).toEqual([])
    expect(g.byName('strip-ansi-cjs')).toEqual([])
    expect(g.byName('wrap-ansi-cjs')).toEqual([])
    // The cliui consumer's three alias deps each bind to the target node, with
    // the alias recorded on the edge.
    const cliuiEdges = g.out('@isaacs/cliui@8.0.2', 'dep')
    const byAlias = new Map(cliuiEdges.map(e => [e.attrs?.alias, e.dst]))
    expect(byAlias.get('string-width-cjs')).toBe('string-width@4.2.3')
    expect(byAlias.get('strip-ansi-cjs')).toBe('strip-ansi@6.0.1')
    expect(byAlias.get('wrap-ansi-cjs')).toBe('wrap-ansi@7.0.0')
    // No dropped edges / integrity loss for the trio.
    expect(g.diagnostics().some(d => d.code === 'YARN_CLASSIC_INVALID_INTEGRITY')).toBe(false)
    // Faithful round-trip: the alias descriptors + alias dep lines survive.
    const out = stringify('yarn-classic', g)
    expect(out).toContain('string-width-cjs@npm:string-width@^4.2.0')
    expect(out).toContain('strip-ansi-cjs "npm:strip-ansi@^6.0.1"')
    expect(stringify('yarn-classic', parse('yarn-classic', out))).toBe(out)
  })

  // D1 (#94) — a header-less classic lock (the two header comments stripped by a
  // tool). detect() recognises it via the entry-block structural fallback and
  // parses it. Focused `detect/` dir.
  it('yarn-classic-headerless — detect() recovers it via structural fallback, parses + round-trips (D1)', () => {
    const content = readFileSync(
      resolve(here, '../../resources/fixtures/detect/yarn-classic-headerless/yarn.lock'), 'utf8')
    expect(content.startsWith('#')).toBe(false) // genuinely header-less
    expect(detect(content)).toBe('yarn-classic')
    const g = parse('yarn-classic', content)
    expect(g.getNode('lodash@4.17.21')).toBeDefined()
    expect(g.getNode('ms@2.1.3')).toBeDefined()
    expect(() => stringify('yarn-classic', g)).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// F9 — entry-key quoting fidelity.
//
// yarn 1 builds every entry-key line as `valKeys.sort().map(maybeWrap).join(', ')`
// (@yarnpkg/lockfile stringify, mirrored in yarn cli.js `_stringify`): each
// descriptor is quote-decided INDEPENDENTLY by `shouldWrapKey`, then comma-joined.
// It NEVER wraps the whole joined key.
//
// Pre-fix our emit whole-quoted any multi-descriptor key
// (`"abbrev@1, abbrev@^1.0.0":`) — non-yarn-faithful (and yarn-unreadable) for
// every dedup'd package — and ALSO over-quoted bare single descriptors whose
// range carries `>`/`<`/`*`/`|` (e.g. `amdefine@>=0.0.4`), none of which are yarn
// quote triggers.
//
// yarn's `shouldWrapKey(str)` wraps iff: str starts with `true`/`false`, OR str
// contains one of `: \s \ " , [ ]`, OR str does not begin with an ASCII letter
// (the last clause is what wraps every `@scope/...` and leading-digit descriptor).
const realWorldDir = resolve(here, '../../resources/fixtures/real-world')

// A faithful re-statement of yarn 1's `shouldWrapKey`, kept INDEPENDENT of the
// production `mustQuoteSpec` so a drift in either is caught. It is asserted below
// to agree with what real yarn wrote on disk across the whole corpus (Oracle 1),
// then asserted to match what we EMIT (Oracle 2).
const yarnShouldWrapKey = (spec: string): boolean =>
  spec.startsWith('true')
  || spec.startsWith('false')
  || /[:\s\\",[\]]/.test(spec)
  || !/^[a-zA-Z]/.test(spec)

// The col-0 `<descriptors>:` header lines of a classic lock, verbatim.
const entryKeyLines = (content: string): string[] =>
  content
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter(line => line.length > 0 && line[0] !== ' ' && line[0] !== '\t' && line[0] !== '#' && line.endsWith(':'))

// Split a raw `<descriptors>:` header line into its descriptors, recording for
// each whether it was wrapped in quotes and its unquoted content — the
// per-descriptor quoting observation (yarn's actual output is the ground truth).
function descriptorsOf(keyLine: string): Array<{ content: string; quoted: boolean }> {
  const key = keyLine.endsWith(':') ? keyLine.slice(0, -1) : keyLine
  const raw: string[] = []
  let start = 0, quoted = false, escaped = false
  for (let i = 0; i < key.length; i++) {
    const c = key[i]
    if (escaped) { escaped = false; continue }
    if (c === '\\') { escaped = true; continue }
    if (c === '"') { quoted = !quoted; continue }
    if (!quoted && c === ',' && key[i + 1] === ' ') { raw.push(key.slice(start, i)); start = i + 2; i++ }
  }
  raw.push(key.slice(start))
  return raw.map(t => {
    if (!t.startsWith('"')) return { content: t, quoted: false }
    let v = ''
    for (let i = 1; i < t.length - 1; i++) {
      const c = t[i]
      if (c !== '\\') { v += c; continue }
      v += t[++i]
    }
    return { content: v, quoted: true }
  })
}

// Discover EVERY real-world fixture that detect()s as yarn-classic — the corpus
// is the oracle, not first-principles. webpack is one; the sweep finds the rest
// (the git-resolved / duplicate-descriptor robustness set, lodash, *-localdep).
const classicFixtures = readdirSync(realWorldDir, { withFileTypes: true })
  .filter(e => e.isDirectory())
  .map(e => e.name)
  .filter(name => {
    try {
      return detect(lock(name)) === 'yarn-classic'
    } catch {
      return false
    }
  })
  .sort()

describe('yarn-classic entry-key quoting fidelity (F9)', () => {
  it('the corpus sweep found yarn-classic fixtures (incl. webpack)', () => {
    expect(classicFixtures.length).toBeGreaterThan(0)
    expect(classicFixtures).toContain('webpack-webpack-main-66f71f8')
  })

  // ORACLE 1 — the corpus is truth. For every descriptor REAL YARN wrote on disk,
  // the `yarnShouldWrapKey` rule must reproduce its exact quoted/bare state. This
  // MINES the bare-vs-quoted boundary across every genuine classic key and proves
  // the rule (and the production `mustQuoteSpec` port of it) is not a
  // first-principles guess but matches yarn byte-for-byte. A single divergence
  // (e.g. if `>` were a trigger, bare `amdefine@>=0.0.4` — which appears bare in
  // BOTH webpack and lodash — would mismatch) fails here naming the descriptor.
  //
  // EXCLUSION: a descriptor whose range is a URL/git protocol (`…://…`) is skipped.
  // Such entry keys appear ONLY in the hand-authored git-protocol PARSE-robustness
  // repros (e.g. amedina's `from-git@git+ssh://…:`, written BARE by hand even
  // though yarn — whose `shouldWrapKey` triggers on the `:` — would QUOTE it). They
  // are parse fixtures, not yarn-emitted quoting oracles; genuine yarn locks key
  // registry entries by `name@range`, never by a URL. Oracle 2 still asserts our
  // EMIT quotes such descriptors (yarn-faithfully), so nothing is left unchecked.
  it('disk quoting of EVERY descriptor across the corpus matches yarn shouldWrapKey', () => {
    let checked = 0
    for (const name of classicFixtures) {
      for (const line of entryKeyLines(lock(name))) {
        for (const d of descriptorsOf(line)) {
          if (d.content.includes('://')) continue // hand-authored git/url repro key
          expect(
            yarnShouldWrapKey(d.content),
            `${name}: descriptor ${JSON.stringify(d.content)} disk-quoted=${d.quoted}`,
          ).toBe(d.quoted)
          checked++
        }
      }
    }
    expect(checked).toBeGreaterThan(1000) // a real sweep, not a trivially-empty pass
  })

  // ORACLE 2 — our EMIT matches the rule. For every fixture, every emitted
  // descriptor is quoted iff `yarnShouldWrapKey` says so, and a multi-descriptor
  // key is NEVER whole-wrapped (`"a, b":`). Order/set-independent: it judges the
  // QUOTING of each emitted descriptor, not which descriptors survive
  // (orphan-drop) or their sort order. With Oracle 1 (disk==rule) this
  // transitively gives emit==disk quoting.
  for (const name of classicFixtures) {
    it(`${name}: every emitted entry-key descriptor is quoted per yarn's rule`, () => {
      const out = stringify('yarn-classic', parse('yarn-classic', lock(name)))
      for (const line of entryKeyLines(out)) {
        const key = line.slice(0, -1)
        const ds = descriptorsOf(line)
        // No whole-key wrap: a top-level ', ' inside ONE quote pair is the F9 bug
        // (a single `<name>@<range>` descriptor never contains a bare ', ').
        if (key.includes(', ') && key.startsWith('"') && key.endsWith('"')) {
          expect(ds.length, `${name}: whole-wrapped multi-key ${JSON.stringify(key)}`).toBeGreaterThan(1)
        }
        for (const d of ds) {
          expect(
            d.quoted,
            `${name}: emitted descriptor ${JSON.stringify(d.content)} quoted=${d.quoted}, rule=${yarnShouldWrapKey(d.content)}`,
          ).toBe(yarnShouldWrapKey(d.content))
        }
      }
    })
  }

  // NOTE on whole-line round-trip: post C-KEYDROP the descriptor SET no longer
  // shrinks — the emit unions the live-edge-reconstructed descriptors with the
  // verbatim parse-time entry-key sidecar, so a merged descriptor with no
  // surviving consumer edge (the former "orphan-descriptor gap") now round-trips.
  // What may still differ from disk byte-for-byte at a merged key is the sort
  // ORDER (we always re-sort; some pre-strict locks merged in resolution order),
  // which is SEPARATE from F9 quoting and intentionally not asserted here — the
  // two oracles above pin the quoting, which is what F9 governs. The
  // descriptor-SET equality the C-KEYDROP fix guarantees is asserted directly
  // below (and on a minimal repro in yarn-classic-edge-cases.test.ts).

  // gatsby F5 (#92) — its ONLY divergence from disk was the multi-key whole-quote
  // (`abbrev@1, abbrev@^1.0.0:`). Post-F9 it byte-round-trips in FULL.
  it('gatsbyjs-gatsby-1f38c85 byte-round-trips in full (only divergence was multi-key quoting)', () => {
    const content = readFileSync(
      resolve(here, '../../resources/fixtures/integrity/gatsbyjs-gatsby-1f38c85-multihash/yarn.lock'), 'utf8')
    expect(detect(content)).toBe('yarn-classic')
    // The repro: the bare multi-key must stay BARE, not become `"abbrev@1, …":`.
    const out = stringify('yarn-classic', parse('yarn-classic', content))
    expect(out).toContain('\nabbrev@1, abbrev@^1.0.0:\n')
    expect(out).not.toContain('"abbrev@1, abbrev@^1.0.0"')
    expect(out).toBe(content)
  })

  // webpack — the confirmed repro corpus. Targeted boundary assertions drawn
  // straight from the on-disk bytes (these exact keys survive intact):
  //  - a bare multi-key of plain (letter-leading, `^`-range) descriptors stays
  //    all-bare and comma-joined, NOT whole-wrapped;
  //  - a scoped descriptor is quoted (leading `@` ⇒ not-letter ⇒ wrap); a scoped
  //    MULTI-key wraps EACH descriptor, never the whole line;
  //  - a bare `>=` range descriptor stays bare — `>` is NOT a yarn quote trigger.
  it('webpack — per-descriptor quoting boundary matches disk (bare multi / scoped / >= range)', () => {
    const content = lock('webpack-webpack-main-66f71f8')
    const out = stringify('yarn-classic', parse('yarn-classic', content))
    // bare multi stays bare (NOT whole-quoted)
    expect(out).toContain('\nacorn@^8.15.0, acorn@^8.16.0, acorn@^8.5.0:\n')
    expect(out).not.toContain('"acorn@^8.15.0, acorn@^8.16.0, acorn@^8.5.0"')
    // a single scoped descriptor is quoted, never whole-wrapped with siblings
    expect(out).toContain('\n"@babel/compat-data@^7.29.7":\n')
    // the scoped @babel/core key wraps EACH descriptor independently (whatever the
    // surviving range set), and is NOT a single whole-wrapped pair
    const babelCore = entryKeyLines(out).find(l => l.includes('@babel/core@'))
    expect(babelCore, 'no @babel/core entry key emitted').toBeDefined()
    for (const d of descriptorsOf(babelCore!)) {
      expect(d.quoted, `@babel/core descriptor ${JSON.stringify(d.content)} must be quoted`).toBe(true)
    }
    expect(babelCore!.startsWith('"@babel/core@')).toBe(true)
    // a bare `>=` range descriptor stays bare — `>` is NOT a yarn quote trigger
    expect(out).toContain('\namdefine@>=0.0.4:\n')
    expect(out).not.toContain('"amdefine@>=0.0.4"')
  })
})

// ---------------------------------------------------------------------------
// C-KEYDROP — entry-key descriptor SET equality (no orphan-descriptor loss).
//
// A multi-descriptor entry key (`"@babel/core@^7.23.9", "@babel/core@^7.24.4", …:`)
// merges every consumer descriptor that shares one resolution. A `dependencies:`
// block only re-creates an edge for an IN-LOCK consumer, so a descriptor declared
// only by a manifest-blind workspace (or a peer/dev dep in a root manifest absent
// from the lock) ORPHANS on parse-without-manifests. Pre-fix the emit rebuilt the
// key from LIVE in-edges alone and DROPPED those orphans — a real data loss
// (facebook/react@557e28f: key descriptor set 2940→2912, e.g. `@babel/core`'s
// `^7.11.1` + `^7.24.4` vanished, so their consumers no longer found the locked
// entry). The fix unions the live descriptors with the verbatim parse-time
// sidecar, so every on-disk entry-key descriptor survives the round-trip.
const descriptorSetOf = (keyLine: string): string[] =>
  descriptorsOf(keyLine).map(d => d.content)

describe('yarn-classic entry-key descriptor-set equality (C-KEYDROP)', () => {
  // The webpack corpus is the oracle (it carries the `@babel/core` multi-range
  // key whose `^7.27.1` / `^7.27.4` are devDep/peer-only — declared by a manifest
  // absent from the lock — and so orphan). Every descriptor real yarn wrote on a
  // col-0 entry key must reappear on emit; NONE may be dropped.
  it('webpack — every on-disk entry-key descriptor survives emit (no orphan dropped)', () => {
    const content = lock('webpack-webpack-main-66f71f8')
    const out = stringify('yarn-classic', parse('yarn-classic', content))

    const diskDescriptors = new Set<string>()
    for (const line of entryKeyLines(content)) for (const d of descriptorSetOf(line)) diskDescriptors.add(d)
    const emitDescriptors = new Set<string>()
    for (const line of entryKeyLines(out)) for (const d of descriptorSetOf(line)) emitDescriptors.add(d)

    expect(diskDescriptors.size).toBeGreaterThan(1000) // a real sweep
    const dropped = [...diskDescriptors].filter(d => !emitDescriptors.has(d)).sort()
    expect(dropped, `dropped on-disk descriptors: ${JSON.stringify(dropped.slice(0, 20))}`).toEqual([])
  })

  // The exact react finding, on the webpack `@babel/core` analogue: the full
  // on-disk descriptor SET round-trips. Pre-fix the live-edge-only emit dropped
  // the orphaned `^7.27.1` / `^7.27.4` (declared by manifests absent from the
  // lock); post-fix every on-disk range survives. Asserted as set CONTAINMENT
  // (no disk descriptor dropped) — the fix's precise guarantee — rather than
  // strict equality, since a legitimate in-lock consumer whose range semver-binds
  // (Rung 3) may add a range NOT present on the disk key, which is correct
  // (a live consumer), not invented loss.
  it('webpack — the @babel/core multi-range key re-emits its full on-disk descriptor set (none dropped)', () => {
    const content = lock('webpack-webpack-main-66f71f8')
    const diskBabel = entryKeyLines(content).find(l => l.includes('@babel/core@'))
    expect(diskBabel, 'fixture lacks an @babel/core multi-range key').toBeDefined()
    const diskSet = descriptorSetOf(diskBabel!).sort()
    expect(diskSet.length).toBeGreaterThan(1) // genuinely multi-descriptor

    const out = stringify('yarn-classic', parse('yarn-classic', content))
    const emitBabel = entryKeyLines(out).find(l => l.includes('@babel/core@'))
    expect(emitBabel, 'no @babel/core entry key emitted').toBeDefined()
    const emitSet = descriptorSetOf(emitBabel!)

    // Every disk descriptor survives the round-trip (the C-KEYDROP guarantee);
    // the emitted set never shrinks below the on-disk set.
    const dropped = diskSet.filter(d => !emitSet.includes(d))
    expect(dropped, `@babel/core dropped on emit: ${JSON.stringify(dropped)}`).toEqual([])
    expect(emitSet.length).toBeGreaterThanOrEqual(diskSet.length)
  })
})
