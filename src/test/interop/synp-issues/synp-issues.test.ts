// Regression corpus for the concrete repros reported against `synp`
// (https://github.com/imsnif/synp/issues). Each block reproduces the exact
// input an author attached to an issue and proves lockgraph closes it.
//
// synp shells out to npm/yarn and reads an installed `node_modules` tree; most
// of its crashes are that model meeting a lockfile it cannot reconcile against
// disk (a git/github/file source, CRLF bytes, a v3 lock with no `dependencies`
// mirror, a stale or absent install). lockgraph is a pure-bytes model: it parses
// the lockfile (plus, optionally, `package.json` bytes) with no package manager
// and no `node_modules`, so those failure modes structurally cannot occur.
//
// SYNP.md carries the full 50-issue coverage table; this file is the executable
// half. Issues whose repro is a real-world lockfile from the yaf sweep
// (git+ssh #27/#46, git:// #27, file:/link:/portal: #30, duplicate descriptors
// #3/#4, multi-hash integrity #7) are already pinned in
// real-world/yarn-classic-robustness.test.ts and cross-referenced there rather
// than duplicated here.

import { describe, expect, it } from 'vitest'
import { convert, detect, parse, stringify } from '../../../main/ts/index.ts'

// Valid-format sha512 SRIs (correct 88-char base64 length). SRI values that are
// not the right length are — correctly — rejected on parse, so fixtures that
// assert integrity survival must use well-formed hashes.
const SRI_A = 'sha512-me2VZyr3OjqRpFrYQJJYy7x/zbFSl9nt+MAGnIcBtjDsN00iTVqEaKxBjPBFQV9BDAgPz2SRWes/DhhVm5SmMw=='
const SRI_B = 'sha512-6FlzubTLZG3J2a/NVCAleEhjzq5oxgHyaCU9yYXvcLsvoVaHJq/s5xXI6/XXP6tNr2r+H1Nn58DwXVA0/y2y4Q=='
const SRI_C = 'sha512-8wvzyM0c6RV5MAsWxkB/C1CMthSIGE+SZE1a5yc5MBzHb7hUkb/d6e7YaadkddicjicMpbFkGziA1e6TBvqC1A=='

describe('synp#6 / #12 — package-lock.json with a github: source (Cannot read property "replace" of undefined)', () => {
  // https://github.com/imsnif/synp/issues/6 — synp's npmToYarnResolved did
  // `.replace()` on an undefined integrity for a `github:` version and crashed.
  // https://github.com/imsnif/synp/issues/12 — the same github source was
  // silently mis-converted npm->yarn; the reporter's workaround was to hand-strip
  // the github entries. The repro is the formula.js github dependency.
  const packageLock = JSON.stringify({
    name: 'app', version: '1.0.0', lockfileVersion: 1, requires: true,
    dependencies: {
      formulajs: {
        version: 'github:handsontable/formula.js#aa9d4acc54e4e0959b70dd0f8c6019774d57498d',
        requires: { bessel: '0.2.0' },
      },
      bessel: {
        version: '0.2.0',
        resolved: 'https://registry.npmjs.org/bessel/-/bessel-0.2.0.tgz',
        integrity: SRI_A,
      },
    },
  }, null, 2)

  it('converts npm->yarn without throwing and preserves the github ref verbatim', () => {
    let out = ''
    expect(() => { out = convert(packageLock, { from: 'npm-1', to: 'yarn-classic' }) }).not.toThrow()
    // The github locator survives as the yarn descriptor/version — not fabricated,
    // not dropped, not turned into a bad registry tarball.
    expect(out).toContain('github:handsontable/formula.js#aa9d4acc54e4e0959b70dd0f8c6019774d57498d')
  })

  it('models the github node without inventing an integrity hash', () => {
    const g = parse('npm-1', packageLock)
    expect(g.byName('formulajs')).toEqual(['formulajs@github:handsontable/formula.js#aa9d4acc54e4e0959b70dd0f8c6019774d57498d'])
    // A git/github source has no registry tarball integrity; lockgraph does not
    // fabricate one (the exact undefined synp dereferenced).
    const node = g.byName('formulajs')[0]!
    expect(g.tarballOf(node)?.integrity).toBeUndefined()
  })
})

describe('synp#13 — a github: source inside `requires` (Cannot read property "replace" of undefined)', () => {
  // https://github.com/imsnif/synp/issues/13 — the amplitude-js lock carried a
  // github source both as a nested `dependencies` version AND inside a parent's
  // `requires`; synp crashed dereferencing the missing integrity.
  const packageLock = JSON.stringify({
    name: 'app', version: '1.0.0', lockfileVersion: 1, requires: true,
    dependencies: {
      'amplitude-js': {
        version: '3.7.0',
        resolved: 'https://registry.npmjs.org/amplitude-js/-/amplitude-js-3.7.0.tgz',
        integrity: SRI_C,
        requires: { 'ua-parser-js': 'github:amplitude/ua-parser-js#ed538f16f5c6ecd8357da989b617d4f156dcf35d' },
      },
      'ua-parser-js': { version: 'github:amplitude/ua-parser-js#ed538f16f5c6ecd8357da989b617d4f156dcf35d' },
    },
  }, null, 2)

  it('converts npm->yarn without throwing and keeps the github dependency edge', () => {
    let out = ''
    expect(() => { out = convert(packageLock, { from: 'npm-1', to: 'yarn-classic' }) }).not.toThrow()
    expect(out).toContain('github:amplitude/ua-parser-js#ed538f16f5c6ecd8357da989b617d4f156dcf35d')
  })
})

describe('synp#8 — yarn.lock with CRLF line endings (Unknown token 3:1)', () => {
  // https://github.com/imsnif/synp/issues/8 — a Windows-authored yarn.lock with
  // CRLF endings broke yarn's own tokenizer ("Unknown token"). lockgraph
  // normalizes line endings before tokenizing, so CRLF parses identically to LF.
  const lf = `# yarn lockfile v1
ms@^2.1.3:
  version "2.1.3"
  resolved "https://registry.yarnpkg.com/ms/-/ms-2.1.3.tgz#574c8138ce1d2b5861f0b44579dbadd60c6615b2"
  integrity ${SRI_B}
`
  const crlf = lf.replace(/\n/g, '\r\n')

  it('detects and parses a CRLF lock without an "Unknown token" throw', () => {
    expect(detect(crlf)).toBe('yarn-classic')
    let g: ReturnType<typeof parse> | undefined
    expect(() => { g = parse('yarn-classic', crlf) }).not.toThrow()
    expect(g!.byName('ms')).toEqual(['ms@2.1.3'])
  })

  it('CRLF and LF inputs produce the same graph (endings are normalized, not significant)', () => {
    expect(stringify('yarn-classic', parse('yarn-classic', crlf)))
      .toBe(stringify('yarn-classic', parse('yarn-classic', lf)))
  })
})

describe('synp#9 — codeload.github.com tarball source', () => {
  // https://github.com/imsnif/synp/issues/9 — a yarn.lock whose `resolved` is a
  // `codeload.github.com/<o>/<r>/tar.gz/<sha>` URL (and the reverse github
  // package-lock) produced "Invalid hex string" / "Cannot read property replace
  // of undefined". lockgraph canonicalizes the codeload tarball as a git source.
  const yarnLock = `# yarn lockfile v1
throng@mixmaxhq/throng#eb_support:
  version "4.0.0"
  resolved "https://codeload.github.com/mixmaxhq/throng/tar.gz/8a015a378c2c0db0c760b2147b2468a1c1e86edf"
  dependencies:
    lodash.defaults "^4.0.1"
lodash.defaults@^4.0.1:
  version "4.2.0"
  resolved "https://registry.yarnpkg.com/lodash.defaults/-/lodash.defaults-4.2.0.tgz#d09178716ffea4dde9e5fb7b37f6f0802274580c"
  integrity sha1-0JF4cW/+pN3p5ft7N/bwgCJ0WAw=
`

  it('parses the codeload source, keeps the throng node, and round-trips the URL', () => {
    let g: ReturnType<typeof parse> | undefined
    expect(() => { g = parse('yarn-classic', yarnLock) }).not.toThrow()
    expect(g!.byName('throng').length).toBe(1)
    // The codeload URL survives the round-trip (no data loss, no crash).
    expect(stringify('yarn-classic', g!)).toContain(
      'https://codeload.github.com/mixmaxhq/throng/tar.gz/8a015a378c2c0db0c760b2147b2468a1c1e86edf')
  })

  it('converts yarn->npm without throwing', () => {
    expect(() => convert(yarnLock, { from: 'yarn-classic', to: 'npm-3' })).not.toThrow()
  })
})

describe('synp#44 — duplicate versions of one package are preserved (not collapsed)', () => {
  // https://github.com/imsnif/synp/issues/44 — synp's node_modules walk collapsed
  // three lodash versions to whichever was last written on disk. lockgraph keys
  // each resolved instance by (name, version), so all three survive as distinct
  // nodes. (Full workspace-member/dev classification additionally needs the
  // package.json manifests; the version-fidelity half is unconditional.)
  const yarnLock = `# yarn lockfile v1
lodash@4.0.0:
  version "4.0.0"
  resolved "https://registry.yarnpkg.com/lodash/-/lodash-4.0.0.tgz#9ac43844c595e28d30108b7ba583703395922dfc"
  integrity sha1-msQ4RMWV4o0wEIt7pYNwM5WSLfw=
lodash@4.17.0:
  version "4.17.0"
  resolved "https://registry.yarnpkg.com/lodash/-/lodash-4.17.0.tgz#93f4466e5ab73e5a1f1216c34eea11535f0a8df5"
  integrity sha1-k/RGblq3PlofEhbDTuoRU18KjfU=
lodash@^3.0.0:
  version "3.10.1"
  resolved "https://registry.yarnpkg.com/lodash/-/lodash-3.10.1.tgz#5bf45e8e49ba4189e17d482789dfd15bd140b7b6"
  integrity sha1-W/Rejkm6QYnhfUgnid/RW9FAt7Y=
`

  it('keeps all three lodash versions as distinct nodes', () => {
    const g = parse('yarn-classic', yarnLock)
    expect([...g.byName('lodash')].sort()).toEqual(['lodash@3.10.1', 'lodash@4.0.0', 'lodash@4.17.0'])
  })

  it('carries all three versions through a yarn->npm conversion', () => {
    const out = convert(yarnLock, { from: 'yarn-classic', to: 'npm-3' })
    for (const v of ['4.0.0', '4.17.0', '3.10.1']) expect(out).toContain(v)
  })
})

describe('synp#55 — package-lock `requires` keep declared ranges (not resolved pins)', () => {
  // https://github.com/imsnif/synp/issues/55 — synp wrote `requires` with the
  // resolved version ("3.2.1"), diverging from `npm i` which keeps the declared
  // range ("^3.2.1"). lockgraph carries the declared range on the edge.
  const yarnLock = `# yarn lockfile v1
chalk@^2.4.2:
  version "2.4.2"
  resolved "https://registry.yarnpkg.com/chalk/-/chalk-2.4.2.tgz#cd42541677a54333cf541a49108c1432b44c9424"
  integrity ${SRI_A}
  dependencies:
    ansi-styles "^3.2.1"
ansi-styles@^3.2.1:
  version "3.2.1"
  resolved "https://registry.yarnpkg.com/ansi-styles/-/ansi-styles-3.2.1.tgz#41fbb64068497c568b1a7b1e2e5f6c7cf1a1b2c3"
  integrity ${SRI_B}
`

  it('emits the caret range chalk declared for ansi-styles, not the resolved pin', () => {
    const out = convert(yarnLock, { from: 'yarn-classic', to: 'npm-3' })
    expect(out).toContain('"ansi-styles": "^3.2.1"')
    expect(out).not.toContain('"ansi-styles": "3.2.1"')
  })
})

describe('synp#100 — every module has a populated `requires` (npm install fails on empty)', () => {
  // https://github.com/imsnif/synp/issues/100 — synp emitted `requires: {}` for
  // every module, so `npm install` failed. lockgraph reconstructs each node's
  // dependency edges, so `requires` is populated at every level.
  const npm3 = JSON.stringify({
    name: 'app', version: '1.0.0', lockfileVersion: 3, requires: true,
    packages: {
      '': { name: 'app', version: '1.0.0', dependencies: { chalk: '^2.4.2' } },
      'node_modules/chalk': { version: '2.4.2', resolved: 'https://registry.npmjs.org/chalk/-/chalk-2.4.2.tgz', integrity: SRI_A, dependencies: { 'ansi-styles': '^3.2.1' } },
      'node_modules/ansi-styles': { version: '3.2.1', resolved: 'https://registry.npmjs.org/ansi-styles/-/ansi-styles-3.2.1.tgz', integrity: SRI_B, dependencies: { 'color-convert': '^1.9.0' } },
      'node_modules/color-convert': { version: '1.9.3', resolved: 'https://registry.npmjs.org/color-convert/-/color-convert-1.9.3.tgz', integrity: SRI_C },
    },
  }, null, 2)

  it('re-emits populated `requires` at every non-leaf node (v3->v1)', () => {
    const v1 = convert(npm3, { from: 'npm-3', to: 'npm-1' })
    expect(v1).toContain('"ansi-styles": "^3.2.1"')   // chalk -> ansi-styles
    expect(v1).toContain('"color-convert": "^1.9.0"') // ansi-styles -> color-convert
    expect(v1).not.toContain('"requires": {}')        // no empty requires anywhere
  })
})

describe('synp#103 — optionalDependencies are preserved (yarn->npm)', () => {
  // https://github.com/imsnif/synp/issues/103 — synp dropped optionalDependencies
  // (breaking @swc/core platform packages for Next.js). lockgraph models optional
  // deps as first-class `optional` edges and carries the platform package —
  // integrity included — into the npm target.
  const yarnLock = `# yarn lockfile v1
"@swc/core@^1.3.82":
  version "1.3.105"
  resolved "https://registry.yarnpkg.com/@swc/core/-/core-1.3.105.tgz#2b78db067b2dc90f3f398a08bb649a3d2ad74e8e"
  integrity ${SRI_A}
  dependencies:
    "@swc/counter" "^0.1.1"
  optionalDependencies:
    "@swc/core-darwin-arm64" "1.3.105"
"@swc/core-darwin-arm64@1.3.105":
  version "1.3.105"
  resolved "https://registry.yarnpkg.com/@swc/core-darwin-arm64/-/core-darwin-arm64-1.3.105.tgz#5f7de41d5b8e18d391e94266adb5f9e2d8d76a76"
  integrity ${SRI_B}
"@swc/counter@^0.1.1":
  version "0.1.3"
  resolved "https://registry.yarnpkg.com/@swc/counter/-/counter-0.1.3.tgz#9c8891bf572fb9c39a3d9d68e0b5b34069e10f47"
  integrity ${SRI_C}
`

  it('models the optional relationship as a first-class optional edge', () => {
    const g = parse('yarn-classic', yarnLock)
    expect(g.out('@swc/core@1.3.105', 'optional').map(e => e.dst))
      .toContain('@swc/core-darwin-arm64@1.3.105')
  })

  it('carries the platform package into the npm target with its integrity intact', () => {
    const pkgs = JSON.parse(convert(yarnLock, { from: 'yarn-classic', to: 'npm-3' })).packages
    const darwin = pkgs['node_modules/@swc/core-darwin-arm64']
    expect(darwin).toBeDefined()
    // The optional platform package keeps its resolved URL and integrity — so npm
    // installs it from the lock rather than dropping it (synp's failure) or
    // refetching it.
    expect(darwin.integrity).toBe(SRI_B)
    expect(darwin.resolved).toContain('core-darwin-arm64-1.3.105.tgz')
  })
})

describe('synp#99 — npm v3 package-lock (packages-only, no `dependencies` mirror)', () => {
  // https://github.com/imsnif/synp/issues/99 — npm v9 writes a v3 lock with only
  // a `packages` map; synp passed the missing `dependencies` (undefined) into its
  // flattener and crashed. lockgraph reads the `packages` map directly.
  const npmV3 = JSON.stringify({
    name: 'app', version: '1.0.0', lockfileVersion: 3, requires: true,
    packages: {
      '': { name: 'app', version: '1.0.0', dependencies: { ms: '^2.1.3' } },
      'node_modules/ms': { version: '2.1.3', resolved: 'https://registry.npmjs.org/ms/-/ms-2.1.3.tgz', integrity: SRI_B },
    },
  }, null, 2)

  it('detects v3 and converts to yarn without throwing', () => {
    expect(detect(npmV3)).toBe('npm-3')
    expect(() => convert(npmV3, { to: 'yarn-classic' })).not.toThrow()
  })

  it('materializes the ms entry as a real node in the yarn output (not just a root dep line)', () => {
    // Parse the converted yarn.lock back into a graph and assert the ms *entry*
    // survives as its own resolved node — the substring `ms@^2.1.3` alone would
    // also match the root's dependency line, so this checks the entry, not the ref.
    const g = parse('yarn-classic', convert(npmV3, { to: 'yarn-classic' }))
    expect(g.byName('ms')).toEqual(['ms@2.1.3'])
  })
})

describe('synp#95 — Yarn 3.x/4.x berry lockfiles (Unknown token)', () => {
  // https://github.com/imsnif/synp/issues/95 — synp's berry parser threw
  // "Unknown token" on `__metadata.version: 6` (Yarn 3) and `version: 4` locks.
  // lockgraph detects and parses every berry schema from bytes.
  const berry6 = `# This file is generated by running "yarn install" inside your project.
# Manual changes might be lost - proceed with caution!

__metadata:
  version: 6
  cacheKey: 8

"app@workspace:.":
  version: 0.0.0-use.local
  resolution: "app@workspace:."
  dependencies:
    ms: "npm:^2.1.3"
  languageName: unknown
  linkType: soft

"ms@npm:^2.1.3":
  version: 2.1.3
  resolution: "ms@npm:2.1.3"
  checksum: aaaa
  languageName: node
  linkType: hard
`

  it('detects yarn-berry-v6 and converts it to a real npm lock (the ms dep survives)', () => {
    expect(detect(berry6)).toBe('yarn-berry-v6')
    let out = ''
    expect(() => { out = convert(berry6, { to: 'npm-3' }) }).not.toThrow()
    // The conversion actually produces the dependency, not an empty lock: the
    // `ms` package lands as a real node_modules entry under the workspace root.
    const pkgs = JSON.parse(out).packages
    expect(pkgs['node_modules/ms']).toBeDefined()
    expect(pkgs['node_modules/ms'].version).toBe('2.1.3')
  })
})

describe('synp#110 — bun.lock support', () => {
  // https://github.com/imsnif/synp/issues/110 — feature request to convert
  // bun.lock <-> package-lock.json so `npm audit` works on Bun projects.
  // lockgraph ships a bun-text adapter (the textual bun.lock; the binary
  // bun.lockb is an intentional non-goal).
  const bunLock = `{
  "lockfileVersion": 1,
  "workspaces": { "": { "name": "app", "dependencies": { "ms": "^2.1.3" } } },
  "packages": {
    "ms": ["ms@2.1.3", "", {}, "${SRI_B}"]
  }
}`

  it('detects bun-text and materializes the ms package in the npm target', () => {
    expect(detect(bunLock)).toBe('bun-text')
    let out = ''
    expect(() => { out = convert(bunLock, { to: 'npm-3' }) }).not.toThrow()
    const ms = JSON.parse(out).packages['node_modules/ms']
    expect(ms).toBeDefined()
    expect(ms.integrity).toBe(SRI_B)
  })
})

describe('synp#53 — a version carrying build metadata is kept verbatim', () => {
  // https://github.com/imsnif/synp/issues/53 — synp read the version from the
  // installed package.json (@hot-loader/react-dom declares 16.12.0+4.12.19 while
  // publishing as 16.13.0), producing the wrong version. lockgraph never reads an
  // installed manifest; it carries the lockfile's own version string verbatim,
  // build metadata (`+...`) included.
  const npm3 = JSON.stringify({
    name: 'app', version: '1.0.0', lockfileVersion: 3, requires: true,
    packages: {
      '': { name: 'app', version: '1.0.0', dependencies: { widget: '^1.0.0' } },
      'node_modules/widget': { version: '16.12.0+4.12.19', resolved: 'https://registry.npmjs.org/widget/-/widget-16.13.0.tgz', integrity: SRI_A },
    },
  }, null, 2)

  it('preserves the +build-metadata version through a round-trip', () => {
    const g = parse('npm-3', npm3)
    expect(g.byName('widget')).toEqual(['widget@16.12.0+4.12.19'])
    expect(stringify('npm-3', g)).toContain('16.12.0+4.12.19')
  })
})

describe('synp#96 — the generated lock needs no correction from npm (frozen-clean)', () => {
  // https://github.com/imsnif/synp/issues/96 — synp generated a package-lock.json,
  // but `npm install` overwrote it (synp's lock was incomplete/incorrect). The
  // fundamental goal here is the inverse: a lockgraph-generated lock passes npm's
  // freeze mode (`npm ci`) with NO rewrite. This is the direct npm analog of the
  // yarn `--immutable` byte-identity yaf verified.
  //
  // This hermetic test asserts the substantive fidelity that makes npm accept the
  // lock: every package entry, its integrity and its resolved URL survive the
  // round-trip unchanged. The live proof — `npm ci` leaves a lockgraph-emitted
  // lock byte-identical (verified against npm 11 on a real esbuild tree with 23
  // optional platform packages, and on this debug/ms tree) — is recorded in
  // SYNP.md, the way yaf's `yarn --immutable` run is documented rather than run in
  // CI. A real npm-generated lock (debug + ms) is the fixture.
  const npmLock = `{
  "name": "npm96",
  "version": "1.0.0",
  "lockfileVersion": 3,
  "requires": true,
  "packages": {
    "": {
      "name": "npm96",
      "version": "1.0.0",
      "dependencies": {
        "debug": "^4.3.4"
      }
    },
    "node_modules/debug": {
      "version": "4.4.3",
      "resolved": "https://registry.npmjs.org/debug/-/debug-4.4.3.tgz",
      "integrity": "sha512-RGwwWnwQvkVfavKVt22FGLw+xYSdzARwm0ru6DhTVA3umU5hZc28V3kO4stgYryrTlLpuvgI9GiijltAjNbcqA==",
      "license": "MIT",
      "dependencies": {
        "ms": "^2.1.3"
      },
      "engines": {
        "node": ">=6.0"
      }
    },
    "node_modules/ms": {
      "version": "2.1.3",
      "resolved": "https://registry.npmjs.org/ms/-/ms-2.1.3.tgz",
      "integrity": "sha512-6FlzubTLZG3J2a/NVCAleEhjzq5oxgHyaCU9yYXvcLsvoVaHJq/s5xXI6/XXP6tz7R9xAOtHnSO/tXtF3WRTlA==",
      "license": "MIT"
    }
  }
}`

  it('round-trips a real npm lock preserving every package, integrity and resolved URL', () => {
    const orig = JSON.parse(npmLock) as { packages: Record<string, { integrity?: string; resolved?: string }> }
    const out = JSON.parse(stringify('npm-3', parse('npm-3', npmLock))) as typeof orig

    // Same package key-set (nothing dropped, nothing invented).
    expect(Object.keys(out.packages).sort()).toEqual(Object.keys(orig.packages).sort())

    // Every irreducible fact — integrity and resolved — is preserved verbatim on
    // every entry. This is what lets `npm ci` accept the lock without a rewrite.
    for (const key of Object.keys(orig.packages)) {
      if (key === '') continue
      expect(out.packages[key]!.integrity, `${key} integrity`).toBe(orig.packages[key]!.integrity)
      expect(out.packages[key]!.resolved, `${key} resolved`).toBe(orig.packages[key]!.resolved)
    }
  })
})
