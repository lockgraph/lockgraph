import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const sriOf = (s: string): string => 'sha512-' + createHash('sha512').update(s).digest('base64')
const MODIFIED_SRI = sriOf('modified-ms-integrity')
import { newBuilder, serializeNodeId, type Diagnostic, type Graph, type GraphDiff } from '../../main/ts/graph.ts'
import { LockfileError } from '../../main/ts/api/errors.ts'
import { check as checkV4, parse as parseV4 } from '../../main/ts/formats/yarn-berry-v4.ts'
import { check as checkV5, parse as parseV5 } from '../../main/ts/formats/yarn-berry-v5.ts'
import { check as checkV6, parse as parseV6 } from '../../main/ts/formats/yarn-berry-v6.ts'
import { check as checkV8, parse as parseV8 } from '../../main/ts/formats/yarn-berry-v8.ts'
import { check as checkV9, parse as parseV9 } from '../../main/ts/formats/yarn-berry-v9.ts'
import {
  check,
  enrich,
  optimize,
  parse,
  stringify,
  parseSpec,
  specIdentity,
  splitEntryKey,
  parseEntryKeyToken,
  parseDependencyLine,
  parseQuotedToken,
  isClassicRegistryRange,
  descriptorSatisfies,
  isYarnClassicResolvableUrl,
  isYarnClassicLocalSpec,
  parseLocalSpec,
  canonicalResolutionOfResolved,
  parseResolution as parseClassicResolution,
  formatResolution,
  deriveResolvedFromCanonical,
  registryBaseOf,
  scopeOf,
  mustQuoteSpec,
  quoteDepName,
  stringifyEntryKey,
  parseEntries,
  inferRegistryBases,
} from '../../main/ts/formats/yarn-classic.ts'
import { replaceVersion } from '../../main/ts/modify/replace-version.ts'
import { parse as parseResolution } from '../../main/ts/recipe/resolution.ts'
import { toTarballKey } from '../../main/ts/graph.ts'
import { mkIntegrity, sri } from '../_integrity-fixtures.ts'
import { canonicalDigest } from '../../main/ts/recipe/integrity.ts'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = (rel: string): string =>
  readFileSync(resolve(here, '../resources/fixtures/lockfiles', rel), 'utf8')

const FIXTURES = [
  'deps-with-scopes',
  'git-github-tarball',
  'peers-basic',
  'peers-multi',
  'simple',
  'workspaces-basic',
  'yarn-crlf',
] as const

function graphSnapshot(graph: Graph) {
  return {
    nodes: Array.from(graph.nodes(), node => ({ ...node })),
    edges: Array.from(graph.nodes(), node =>
      graph.out(node.id).map(edge => ({
        src: edge.src,
        dst: edge.dst,
        kind: edge.kind,
        attrs: edge.attrs === undefined ? undefined : { ...edge.attrs },
      })),
    ).flat(),
    tarballs: Array.from(graph.tarballs(), ([key, payload]) => [key, { ...payload }] as const),
    diagnostics: graph.diagnostics().map(diagnostic => ({ ...diagnostic })),
  }
}

function expectEmptyGraphDiff(diff: GraphDiff) {
  expect(diff).toEqual({
    addedNodes: [],
    removedNodes: [],
    changedNodes: [],
    addedEdges: [],
    removedEdges: [],
  })
}

function parseFixtureGraph(name: typeof FIXTURES[number]): Graph {
  return parse(fixture(`${name}/yarn-classic.lock`))
}

function stringifyWithDiagnostics(graph: Graph) {
  const diagnostics: Diagnostic[] = []
  const lockfile = stringify(graph, {
    onDiagnostic(diagnostic) {
      diagnostics.push(diagnostic)
    },
  })

  return { lockfile, diagnostics }
}

function workspaceFixtureGraph(): Graph {
  return parseFixtureGraph('workspaces-basic').mutate(m => {
    m.addNode({
      id: '@case-ws/a@0.0.0-use.local',
      name: '@case-ws/a',
      version: '0.0.0-use.local',
      peerContext: [],
    })
    m.addNode({
      id: '@case-ws/b@0.0.0-use.local',
      name: '@case-ws/b',
      version: '0.0.0-use.local',
      peerContext: [],
    })
    m.addEdge('@case-ws/a@0.0.0-use.local', 'ms@2.1.3', 'dep', { range: '2.1.3' })
    m.addEdge('@case-ws/b@0.0.0-use.local', 'ms@2.1.3', 'dep', { range: '2.1.3' })
  }).graph
}

const WORKSPACE_MANIFESTS = {
  '': {
    name: 'case-workspaces-basic',
    version: '0.0.0',
    dependencies: { '@case-ws/a': 'workspace:*' },
    devDependencies: { '@case-ws/b': 'workspace:^' },
    optionalDependencies: { ms: '2.1.3' },
  },
  'packages/a': {
    name: '@case-ws/a',
    version: '1.0.0',
    dependencies: { ms: '2.1.3' },
  },
  'packages/b': {
    name: '@case-ws/b',
    version: '1.1.0',
    dependencies: { ms: '2.1.3' },
  },
} as const

describe('yarn-classic — minted resolved URL: yarn-1 host + #<sha1> fragment (yaf frozen-clean)', () => {
  // yaf bumps a dep → the lib mints a node from the registry (npmjs `dist.tarball` +
  // `dist.shasum`). yarn 1 writes the `resolved` host as ITS registry (not npmjs) and
  // appends the tarball sha1 as `#<sha1>` — a mint that keeps the npmjs host or drops the
  // fragment desyncs the lock → `yarn --frozen-lockfile` rewrites it.
  const sha1   = 'a'.repeat(40)                                 // dist.shasum
  const sha512 = 'b'.repeat(128)                                // dist.integrity
  const mintedIntegrity = () => ({ hashes: [
    { algorithm: 'sha512', digest: sha512, origin: 'registry' as const },
    { algorithm: 'sha1',   digest: sha1,   origin: 'url-fragment' as const },
  ] })
  // a MINTED node: registry `dist.tarball` (npmjs by default) + NO nativeResolution sidecar.
  const addMinted = (b: ReturnType<typeof newBuilder>, host = 'https://registry.npmjs.org') => {
    b.addNode({ id: 'ms@2.1.3', name: 'ms', version: '2.1.3', peerContext: [] })
    b.setTarball({ name: 'ms', version: '2.1.3' }, {
      resolution: { type: 'tarball', url: `${host}/ms/-/ms-2.1.3.tgz` },
      integrity:  mintedIntegrity(),
    })
  }
  // a NATIVE round-tripped sibling on `base` (verbatim `nativeResolution` — what inference reads).
  const addNativeSibling = (b: ReturnType<typeof newBuilder>, base: string) => {
    b.addNode({ id: 'chalk@2.4.2', name: 'chalk', version: '2.4.2', peerContext: [] })
    const url = `${base}/chalk/-/chalk-2.4.2.tgz`
    b.setTarball({ name: 'chalk', version: '2.4.2' }, {
      resolution: { type: 'tarball', url }, nativeResolution: `${url}#${'c'.repeat(40)}`,
    })
  }

  it('rehosts npmjs dist.tarball → yarn-1 default + appends #<sha1>; SRI stays sha512-only', () => {
    const b = newBuilder(); addMinted(b)                        // npmjs, no native sibling → default
    const { lockfile } = stringifyWithDiagnostics(b.seal())
    expect(lockfile).toContain(`resolved "https://registry.yarnpkg.com/ms/-/ms-2.1.3.tgz#${sha1}"`)
    expect(lockfile).not.toContain('registry.npmjs.org')       // host rewritten off npmjs
    const integrityLine = lockfile.split('\n').find(l => l.trimStart().startsWith('integrity'))
    expect(integrityLine).toBeDefined()
    expect(integrityLine).not.toContain('sha1-')               // url-fragment sha1 never enters the SRI
  })

  it('rehosts to the base the lock ALREADY uses (native siblings), not the default', () => {
    const b = newBuilder(); addNativeSibling(b, 'https://registry.yarnpkg.com'); addMinted(b)
    const { lockfile } = stringifyWithDiagnostics(b.seal())
    expect(lockfile).toContain(`resolved "https://registry.yarnpkg.com/ms/-/ms-2.1.3.tgz#${sha1}"`)
  })

  it('preserves a private-mirror base inferred from native siblings — no host hardcode imposed', () => {
    const mirror = 'https://nexus.corp/repository/npm'
    const b = newBuilder(); addNativeSibling(b, mirror); addMinted(b)
    const { lockfile } = stringifyWithDiagnostics(b.seal())
    expect(lockfile).toContain(`resolved "${mirror}/ms/-/ms-2.1.3.tgz#${sha1}"`)
  })

  it('routes PER-SCOPE — a minted @scope pkg keeps its scope registry, NOT the global majority (@scope:registry)', () => {
    // The lock's MAJORITY is the public registry (unscoped `chalk`), but `@mycorp` is pinned
    // to a private one. A blind majority-rehost would drag `@mycorp/new` onto the public
    // registry (yarn would reject it). Scope-aware routing keeps `@mycorp/*` on nexus.
    const priv = 'https://nexus.corp/repository/npm'
    const b = newBuilder()
    addNativeSibling(b, 'https://registry.yarnpkg.com')        // unscoped majority = public
    b.addNode({ id: '@mycorp/util@1.0.0', name: '@mycorp/util', version: '1.0.0', peerContext: [] })
    b.setTarball({ name: '@mycorp/util', version: '1.0.0' }, {  // native `@mycorp` sibling on the private registry
      resolution: { type: 'tarball', url: `${priv}/@mycorp/util/-/util-1.0.0.tgz` },
      nativeResolution: `${priv}/@mycorp/util/-/util-1.0.0.tgz#${'d'.repeat(40)}`,
    })
    b.addNode({ id: '@mycorp/new@2.0.0', name: '@mycorp/new', version: '2.0.0', peerContext: [] })
    b.setTarball({ name: '@mycorp/new', version: '2.0.0' }, {   // MINTED (npmjs dist.tarball)
      resolution: { type: 'tarball', url: 'https://registry.npmjs.org/@mycorp/new/-/new-2.0.0.tgz' },
      integrity:  mintedIntegrity(),
    })
    const { lockfile } = stringifyWithDiagnostics(b.seal())
    expect(lockfile).toContain(`resolved "${priv}/@mycorp/new/-/new-2.0.0.tgz#${sha1}"`)
    expect(lockfile).not.toContain('yarnpkg.com/@mycorp')      // NOT dragged onto the public registry
    expect(lockfile).not.toContain('npmjs.org/@mycorp')
  })

  it('config `registryFor` routes a BRAND-NEW private scope the lock has no sibling for', () => {
    // The lock has no `@newcorp` entry, so lock-inference has no signal for it. The caller's
    // config (`@newcorp:registry`) supplies the base → the minted node routes to the private
    // registry; without config it falls back to the public default.
    const priv = 'https://nexus.corp/repository/npm'
    const b = newBuilder()
    addNativeSibling(b, 'https://registry.yarnpkg.com')        // only PUBLIC siblings — no @newcorp
    b.addNode({ id: '@newcorp/pkg@1.0.0', name: '@newcorp/pkg', version: '1.0.0', peerContext: [] })
    b.setTarball({ name: '@newcorp/pkg', version: '1.0.0' }, { // MINTED, no @newcorp sibling to learn from
      resolution: { type: 'tarball', url: 'https://registry.npmjs.org/@newcorp/pkg/-/pkg-1.0.0.tgz' },
      integrity:  mintedIntegrity(),
    })
    const graph = b.seal()

    // no config → no signal for @newcorp → falls back to the public default
    expect(stringify(graph)).toContain('registry.yarnpkg.com/@newcorp/pkg/-/pkg-1.0.0.tgz')
    // config routes it to the private registry (authoritative over inference)
    const withCfg = stringify(graph, { registryFor: name => name.startsWith('@newcorp/') ? priv : undefined })
    expect(withCfg).toContain(`resolved "${priv}/@newcorp/pkg/-/pkg-1.0.0.tgz#${sha1}"`)
  })
})

describe('yarn-classic — entry key keeps the declared descriptor across a version bump (yaf --frozen-lockfile)', () => {
  const fakeRegistry = {
    // eslint-disable-next-line @typescript-eslint/require-await
    async packument() { return undefined },
    // eslint-disable-next-line @typescript-eslint/require-await
    async resolve(name: string) {
      return { name, version: '4.18.0',
        tarball: 'https://registry.npmjs.org/lodash/-/lodash-4.18.0.tgz',
        integrity: sri('sha512-' + Buffer.alloc(64, 7).toString('base64')) }
    },
  }
  const lockWith = (key: string): string =>
    `# THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.\n# yarn lockfile v1\n\n\n${key}:\n` +
    `  version "4.17.11"\n` +
    `  resolved "https://registry.yarnpkg.com/lodash/-/lodash-4.17.11.tgz#b39ea6229ef607ecd89e2c8df12536891cac9b8d"\n` +
    `  integrity sha512-cQKh8igo5QUhZ7lg38DYWAxMvjSAKG0A8wGSVimP07SIUEK2UO+arSRKbRZWtelMtN5V0Hkwh5ryOto/SshYIg==\n`
  const bumpKey = async (inputKey: string): Promise<string | undefined> => {
    const g = parse(lockWith(inputKey))
    const r = await replaceVersion(g, { name: 'lodash', fromRange: '^4.17.0' }, '4.18.0', { registry: fakeRegistry })
    return stringify(r.graph).split('\n').find(l => /^"?lodash@/.test(l))?.trim()
  }

  it('an IN-RANGE caret descriptor SURVIVES the bump (^4.17.0 still satisfies 4.18.0) — no orphan', async () => {
    // Manifest-blind (no package.json → no incoming edge): pre-fix this reset the key to
    // `lodash@4.18.0`, orphaning package.json's `^4.17.0` → `yarn --frozen-lockfile` exit 1.
    expect(await bumpKey('lodash@^4.17.0')).toBe('lodash@^4.17.0:')
  })

  it('an EXACT pin does NOT survive an out-of-range bump (4.17.11 ∌ 4.18.0) — resets, as yarn would', async () => {
    // The pin no longer matches; the manifest pin must change too, so `lodash@4.18.0` is correct.
    expect(await bumpKey('lodash@4.17.11')).toBe('lodash@4.18.0:')
  })
})

describe('yarn-classic — discriminant and isolation', () => {
  it('accepts the classic header and rejects yarn-berry headers', () => {
    const classic = fixture('simple/yarn-classic.lock')
    const v4 = fixture('simple/yarn-berry-v4.lock')
    const v5 = fixture('simple/yarn-berry-v5.lock')
    const v6 = fixture('simple/yarn-berry-v6.lock')
    const v8 = fixture('simple/yarn-berry-v8.lock')
    const v9 = fixture('simple/yarn-berry-v9.lock')

    expect(check(classic)).toBe(true)
    expect(check(v4)).toBe(false)
    expect(check(v5)).toBe(false)
    expect(check(v6)).toBe(false)
    expect(check(v8)).toBe(false)
    expect(check(v9)).toBe(false)

    expect(checkV4(classic)).toBe(false)
    expect(checkV5(classic)).toBe(false)
    expect(checkV6(classic)).toBe(false)
    expect(checkV8(classic)).toBe(false)
    expect(checkV9(classic)).toBe(false)
  })

  it('parses only with the matching adapter', () => {
    const classic = fixture('simple/yarn-classic.lock')
    const v4 = fixture('simple/yarn-berry-v4.lock')
    const v5 = fixture('simple/yarn-berry-v5.lock')
    const v6 = fixture('simple/yarn-berry-v6.lock')
    const v8 = fixture('simple/yarn-berry-v8.lock')
    const v9 = fixture('simple/yarn-berry-v9.lock')

    expect(parse(classic).getNode('lodash@4.17.21')).toBeDefined()
    expect(parseV4(v4).getNode('case-simple@0.0.0-use.local')).toBeDefined()
    expect(parseV5(v5).getNode('case-simple@0.0.0-use.local')).toBeDefined()
    expect(parseV6(v6).getNode('case-simple@0.0.0-use.local')).toBeDefined()
    expect(parseV8(v8).getNode('case-simple@0.0.0-use.local')).toBeDefined()
    expect(parseV9(v9).getNode('case-simple@0.0.0-use.local')).toBeDefined()

    for (const lock of [v4, v5, v6, v8, v9]) {
      expect(() => parse(lock)).toThrow(LockfileError)
      try {
        parse(lock)
      } catch (error) {
        expect((error as LockfileError).code).toBe('FORMAT_MISMATCH')
      }
    }

    for (const parseOther of [parseV4, parseV5, parseV6, parseV8, parseV9]) {
      expect(() => parseOther(classic)).toThrow()
    }
  })
})

describe('yarn-classic — parse fixtures', () => {
  it.each(FIXTURES)('parses %s fixture', (fixtureName) => {
    const graph = parseFixtureGraph(fixtureName)
    expect(Array.from(graph.nodes())).not.toHaveLength(0)
  })
})

describe('yarn-classic — stringify', () => {
  it.each(FIXTURES.filter(name => name !== 'yarn-crlf'))('roundtrips %s at Graph level', (fixtureName) => {
    const original = parseFixtureGraph(fixtureName)
    const emitted = stringify(original)
    const reparsed = parse(emitted)

    expect(graphSnapshot(reparsed)).toEqual(graphSnapshot(original))
    expectEmptyGraphDiff(original.diff(reparsed))
  })

  it('roundtrips yarn-crlf at Graph level when CRLF is requested', () => {
    const original = parseFixtureGraph('yarn-crlf')
    const emitted = stringify(original, { lineEnding: 'crlf' })
    const reparsed = parse(emitted)

    expect(emitted).toContain('\r\n')
    expect(emitted.replace(/\r\n/g, '\n')).toBe(stringify(original))
    expect(graphSnapshot(reparsed)).toEqual(graphSnapshot(original))
    expectEmptyGraphDiff(original.diff(reparsed))
  })

  // ADR-0020 §8.1: stringify on a zero-node graph must emit a §A header that
  // the strict parser accepts; the round-trip must yield an empty graph with
  // no spurious diagnostics.
  it('emits §A header on the empty graph and round-trips to zero nodes', () => {
    const original = newBuilder().seal()
    const emitted = stringify(original)

    expect(check(emitted)).toBe(true)
    expect(emitted).toBe(
      '# THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.\n# yarn lockfile v1\n\n\n',
    )

    const { lockfile, diagnostics } = stringifyWithDiagnostics(original)
    expect(lockfile).toBe(emitted)
    expect(diagnostics).toEqual([])

    const reparsed = parse(emitted)
    expect(Array.from(reparsed.nodes())).toEqual([])
    expectEmptyGraphDiff(original.diff(reparsed))
  })

  // F9/#113 — modern-yarn multi-descriptor key with a STRING-vs-NUMERIC ordering
  // quirk. yarn sorts an entry's descriptors with `sortAlpha` (charCode order),
  // NOT numeric semver order. Among webpack's `@babel/helper-plugin-utils` ranges
  // `^7.8.0` therefore sorts LAST — char '8' (0x38) outranks the '1' of `^7.10.4`
  // / `^7.14.5` at the first differing position, even though 8 < 10 < 14 as
  // numbers. The emit must reproduce that exact order (and quote each scoped
  // descriptor independently), and a parse → stringify round-trip must be
  // byte-faithful for the key line.
  it('orders a multi-descriptor key by sortAlpha (`^7.8.0` sorts last), byte-faithful', () => {
    const input =
      '# THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.\n' +
      '# yarn lockfile v1\n\n\n' +
      '"@babel/helper-plugin-utils@^7.0.0", "@babel/helper-plugin-utils@^7.10.4", ' +
      '"@babel/helper-plugin-utils@^7.14.5", "@babel/helper-plugin-utils@^7.8.0":\n' +
      '  version "7.14.5"\n' +
      '  resolved "https://registry.yarnpkg.com/@babel/helper-plugin-utils/-/helper-plugin-utils-7.14.5.tgz#abcdef"\n' +
      `  integrity ${sriOf('babelhpu')}\n`

    const emitted = stringify(parse(input))
    const expectedKey =
      '"@babel/helper-plugin-utils@^7.0.0", "@babel/helper-plugin-utils@^7.10.4", ' +
      '"@babel/helper-plugin-utils@^7.14.5", "@babel/helper-plugin-utils@^7.8.0":'
    // The key line is re-emitted verbatim, with `^7.8.0` LAST (sortAlpha, not numeric).
    expect(emitted).toContain(expectedKey)
    // The whole input round-trips byte-for-byte (header + the single entry).
    expect(emitted).toBe(input)
  })

  // Real-world regression (commit 0775b26): yarn-berry locators on cross-family
  // sources (`<n>@patch:...`, `<n>@npm:<ver>`) reach yarn-classic stringify as
  // `{ type: 'unknown', raw }` canonical. The pre-fix `deriveResolvedFromCanonical`
  // forwarded `raw` verbatim, which yarn-classic's parser rejects on reparse
  // because it is not a URL. `isYarnClassicResolvedUrl` now gates the emit so
  // only URL-shaped resolutions land in `resolved`; the patch loss is attributed
  // via the existing `warnPatchDrop` channel (verified in the patched-sibling
  // dedup test below).
  it('omits `resolved` when canonical is non-URL unknown (yarn-berry patch leak)', () => {
    const b = newBuilder()
    b.addNode({
      id: 'foo@1.0.0',
      name: 'foo',
      version: '1.0.0',
      peerContext: [],
    })
    b.setTarball({ name: 'foo', version: '1.0.0' }, {
      integrity: sri(sriOf('deadbeef')),
      resolution: { type: 'unknown', raw: 'foo@patch:foo@npm%3A1.0.0#./.yarn/patches/foo.patch::version=1.0.0' },
    })
    const graph = b.seal()

    const emitted = stringify(graph)

    expect(emitted).not.toContain('resolved "foo@patch:')
    expect(emitted).toContain('foo@1.0.0:')
    expect(emitted).toContain(`integrity ${sriOf('deadbeef')}`)
  })

  it('emits `resolved "<url>"` when canonical is tarball URL', () => {
    const b = newBuilder()
    b.addNode({
      id: 'foo@1.0.0',
      name: 'foo',
      version: '1.0.0',
      peerContext: [],
    })
    b.setTarball({ name: 'foo', version: '1.0.0' }, {
      integrity: sri(sriOf('deadbeef')),
      resolution: { type: 'tarball', url: 'https://registry.yarnpkg.com/foo/-/foo-1.0.0.tgz' },
    })
    const graph = b.seal()

    const emitted = stringify(graph)

    expect(emitted).toContain('resolved "https://registry.yarnpkg.com/foo/-/foo-1.0.0.tgz"')
  })

  // Real-world regression: yarn-berry
  // collapses npm-aliased entries onto the dominant target name, so the entry-
  // key spec[0] name (e.g. `string-width-cjs`) disagrees with the `resolution:`
  // field's name (`string-width`). The pre-fix `peelYarnBerryLocator` rejected
  // the parse when `options.name` mismatched the locator's own name, returning
  // `unknown` and leaking a non-URL through `resolved` (handled by the gate
  // above). The fix relaxes the peel to a SOFT match — the locator's parsed
  // name passes through to URL derivation, so the npm-alias case resolves to a
  // proper registry tarball URL.
  it('parseResolution: soft name match — npm-alias locator derives registry URL despite options.name mismatch', () => {
    const canonical = parseResolution('string-width@npm:4.2.3', {
      sourceKind: 'yarn-berry-locator',
      name: 'string-width-cjs',
    })

    expect(canonical).toEqual({
      type: 'tarball',
      url:  'https://registry.npmjs.org/string-width/-/string-width-4.2.3.tgz',
    })
  })
})

describe('yarn-classic — modify', () => {
  it('roundtrips addNode', () => {
    const original = parseFixtureGraph('simple')
    const result = original.mutate(m => {
      m.addNode({
        id: 'debug@4.4.1',
        name: 'debug',
        version: '4.4.1',
        peerContext: [],
      })
      m.setTarball({ name: 'debug', version: '4.4.1' }, { nativeResolution: 'https://registry.yarnpkg.com/debug/-/debug-4.4.1.tgz#0000000000000000000000000000000000000000' })
    })
    const reparsed = parse(stringify(result.graph))

    expectEmptyGraphDiff(result.graph.diff(reparsed))
    expect(result.applied).toEqual([
      { kind: 'node-added', subject: 'debug@4.4.1' },
      { kind: 'tarball-set', subject: 'debug@4.4.1' },
    ])
  })

  it('roundtrips addEdge dep', () => {
    const original = parseFixtureGraph('simple')
    const result = original.mutate(m => {
      m.addEdge('lodash@4.17.21', 'ms@2.1.3', 'dep', { range: '2.1.3' })
    })
    const reparsed = parse(stringify(result.graph))

    expectEmptyGraphDiff(result.graph.diff(reparsed))
    expect(result.applied).toEqual([
      { kind: 'edge-added', subject: { src: 'lodash@4.17.21', dst: 'ms@2.1.3', kind: 'dep' } },
    ])
  })

  it('collapses addEdge dev to dep on reparse', () => {
    const original = parseFixtureGraph('simple')
    const result = original.mutate(m => {
      m.addEdge('lodash@4.17.21', 'ms@2.1.3', 'dev', { range: '2.1.3' })
    })
    const reparsed = parse(stringify(result.graph))
    const flattened = original.mutate(m => {
      m.addEdge('lodash@4.17.21', 'ms@2.1.3', 'dep', { range: '2.1.3' })
    }).graph

    expectEmptyGraphDiff(flattened.diff(reparsed))
    expect(result.applied).toEqual([
      { kind: 'edge-added', subject: { src: 'lodash@4.17.21', dst: 'ms@2.1.3', kind: 'dev' } },
    ])
  })

  it('roundtrips addEdge optional', () => {
    const original = parseFixtureGraph('simple')
    const result = original.mutate(m => {
      m.addEdge('lodash@4.17.21', 'ms@2.1.3', 'optional', { range: '2.1.3' })
    })
    const reparsed = parse(stringify(result.graph))

    expectEmptyGraphDiff(result.graph.diff(reparsed))
    expect(result.applied).toEqual([
      { kind: 'edge-added', subject: { src: 'lodash@4.17.21', dst: 'ms@2.1.3', kind: 'optional' } },
    ])
  })

  it('roundtrips removeEdge', () => {
    const original = parseFixtureGraph('peers-basic')
    const result = original.mutate(m => {
      m.removeEdge('react-dom@18.2.0', 'scheduler@0.23.2', 'dep')
    })
    const reparsed = parse(stringify(result.graph))

    expectEmptyGraphDiff(result.graph.diff(reparsed))
    expect(result.applied).toEqual([
      { kind: 'edge-removed', subject: { src: 'react-dom@18.2.0', dst: 'scheduler@0.23.2', kind: 'dep' } },
    ])
  })

  it('roundtrips removeNode', () => {
    const original = parseFixtureGraph('peers-basic')
    const result = original.mutate(m => {
      m.removeEdge('react-dom@18.2.0', 'scheduler@0.23.2', 'dep')
      m.removeNode('scheduler@0.23.2')
    })
    const reparsed = parse(stringify(result.graph))

    expectEmptyGraphDiff(result.graph.diff(reparsed))
    expect(result.applied).toEqual([
      { kind: 'edge-removed', subject: { src: 'react-dom@18.2.0', dst: 'scheduler@0.23.2', kind: 'dep' } },
      { kind: 'node-removed', subject: 'scheduler@0.23.2' },
    ])
  })

  it('roundtrips setTarball', () => {
    const original = parseFixtureGraph('simple')
    const result = original.mutate(m => {
      m.setTarball({ name: 'ms', version: '2.1.3' }, { integrity: sri(MODIFIED_SRI) })
    })
    const reparsed = parse(stringify(result.graph))

    expectEmptyGraphDiff(result.graph.diff(reparsed))
    // ADR-0014 §4.F3 — round-trip parse re-derives canonical resolution.
    expect(canonicalDigest(reparsed.tarballOf('ms@2.1.3')!.integrity!)).toBe(MODIFIED_SRI)
    expect(result.applied).toEqual([
      { kind: 'tarball-set', subject: 'ms@2.1.3' },
    ])
  })

  it('emits addEdge peer warning once and reparses without the peer edge', () => {
    const original = parseFixtureGraph('peers-basic')
    const result = original.mutate(m => {
      m.addNode({
        id: 'peer-consumer@1.0.0(react@18.2.0)',
        name: 'peer-consumer',
        version: '1.0.0',
        peerContext: ['react@18.2.0'],
      })
      m.addEdge('peer-consumer@1.0.0(react@18.2.0)', 'react@18.2.0', 'peer', { range: '^18.2.0' })
      m.setTarball({ name: 'peer-consumer', version: '1.0.0' }, { nativeResolution: 'https://registry.yarnpkg.com/peer-consumer/-/peer-consumer-1.0.0.tgz#1111111111111111111111111111111111111111' })
    })
    const flattened = original.mutate(m => {
      m.addNode({
        id: 'peer-consumer@1.0.0',
        name: 'peer-consumer',
        version: '1.0.0',
        peerContext: [],
      })
      m.setTarball({ name: 'peer-consumer', version: '1.0.0' }, { nativeResolution: 'https://registry.yarnpkg.com/peer-consumer/-/peer-consumer-1.0.0.tgz#1111111111111111111111111111111111111111' })
    }).graph
    const { lockfile, diagnostics } = stringifyWithDiagnostics(result.graph)
    const reparsed = parse(lockfile)

    expectEmptyGraphDiff(flattened.diff(reparsed))
    expect(diagnostics.map(diagnostic => diagnostic.code).sort()).toEqual([
      'YARN_CLASSIC_PEER_DROPPED',
      'YARN_CLASSIC_PEER_VIRT_FLATTENED',
    ])
    expect(diagnostics.find(diagnostic => diagnostic.code === 'YARN_CLASSIC_PEER_DROPPED')).toEqual(
      expect.objectContaining({
        severity: 'warning',
        subject: 'peer-consumer@1.0.0(react@18.2.0)',
      }),
    )
    expect(diagnostics.find(diagnostic => diagnostic.code === 'YARN_CLASSIC_PEER_DROPPED')?.message)
      .toContain('peer-consumer@1.0.0(react@18.2.0) -> react@^18.2.0')
    expect(reparsed.out('peer-consumer@1.0.0', 'peer')).toEqual([])
    expect(result.applied).toEqual([
      { kind: 'node-added', subject: 'peer-consumer@1.0.0(react@18.2.0)' },
      { kind: 'edge-added', subject: { src: 'peer-consumer@1.0.0(react@18.2.0)', dst: 'react@18.2.0', kind: 'peer' } },
      { kind: 'tarball-set', subject: 'peer-consumer@1.0.0' },
    ])
  })

  it('replacePeerContext reparses to the flattened graph and emits one warning per affected node', () => {
    const original = parseFixtureGraph('peers-basic')
    const result = original.mutate(m => {
      m.replacePeerContext('react-dom@18.2.0', ['react@18.2.0'])
    })
    const { lockfile, diagnostics } = stringifyWithDiagnostics(result.graph)
    const reparsed = parse(lockfile)

    expectEmptyGraphDiff(original.diff(reparsed))
    expect(diagnostics.map(diagnostic => diagnostic.code).sort()).toEqual([
      'YARN_CLASSIC_PEER_DROPPED',
      'YARN_CLASSIC_PEER_VIRT_FLATTENED',
    ])
    expect(diagnostics.find(diagnostic => diagnostic.code === 'YARN_CLASSIC_PEER_VIRT_FLATTENED')).toEqual(
      expect.objectContaining({
        severity: 'warning',
        subject: 'react-dom@18.2.0(react@18.2.0)',
      }),
    )
    expect(diagnostics.find(diagnostic => diagnostic.code === 'YARN_CLASSIC_PEER_VIRT_FLATTENED')?.message)
      .toContain('["react@18.2.0"]')
    expect(result.applied).toEqual([
      { kind: 'peer-context-replaced', subject: 'react-dom@18.2.0(react@18.2.0)', oldSubject: 'react-dom@18.2.0' },
    ])
  })

  it('drops patch metadata on emit and warns once per affected node', () => {
    const original = parseFixtureGraph('simple')
    const patch = 'a'.repeat(128)
    const current = original.getNode('ms@2.1.3')
    expect(current).toBeDefined()

    const result = original.mutate(m => {
      m.replaceNode('ms@2.1.3', {
        ...current!,
        patch,
      })
      m.setTarball({ name: 'ms', version: '2.1.3', patch }, { integrity: sri(sriOf('patched-ms-integrity')) })
      m.removeTarball({ name: 'ms', version: '2.1.3' })
    })
    const flattened = original.mutate(m => {
      m.setTarball({ name: 'ms', version: '2.1.3' }, { integrity: sri(sriOf('patched-ms-integrity')) })
    }).graph
    const { lockfile, diagnostics } = stringifyWithDiagnostics(result.graph)
    const reparsed = parse(lockfile)

    expectEmptyGraphDiff(flattened.diff(reparsed))
    expect(reparsed.getNode('ms@2.1.3')?.patch).toBeUndefined()
    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: 'RECIPE_FEATURE_DROPPED',
        severity: 'warning',
        subject: 'ms@2.1.3',
      }),
    ])
    expect(diagnostics[0]?.message).toContain(patch)
    expect(result.applied).toEqual([
      { kind: 'node-replaced', subject: 'ms@2.1.3' },
      { kind: 'tarball-set', subject: `ms@2.1.3+patch=${patch}` },
      { kind: 'tarball-removed', subject: 'ms@2.1.3' },
    ])
  })

  // Real-world regression (commit 0775b26): yarn-classic identifies entries by
  // `<n>@<ver>` (no patch disambiguator). A graph carrying both bare and
  // patched siblings would emit two entries that collapse onto a single key on
  // reparse and trip the seal с `IRREDUCIBLE_LOSS: two entries collapse onto
  // NodeId …`. The fix dedups at emit (prefer unpatched, drop the patched
  // sibling via `warnPatchDrop` / RECIPE_FEATURE_DROPPED).
  it('dedups bare + patched siblings of the same `<n>@<ver>` on emit (no IRREDUCIBLE_LOSS)', () => {
    const patch = 'a'.repeat(128)
    const patchedId = toTarballKey({ name: 'typescript', version: '5.4.5', patch })
    const original = parseFixtureGraph('simple')
    const result = original.mutate(m => {
      m.addNode({
        id: 'typescript@5.4.5',
        name: 'typescript',
        version: '5.4.5',
        peerContext: [],
      })
      m.setTarball({ name: 'typescript', version: '5.4.5' }, { integrity: sri(sriOf('typescript-bare')), nativeResolution: 'https://registry.yarnpkg.com/typescript/-/typescript-5.4.5.tgz#0000000000000000000000000000000000000000' })
      m.addNode({
        id: patchedId,
        name: 'typescript',
        version: '5.4.5',
        peerContext: [],
        patch,
      })
      m.setTarball({ name: 'typescript', version: '5.4.5', patch }, { integrity: sri(sriOf('typescript-patched')), nativeResolution: 'https://registry.yarnpkg.com/typescript/-/typescript-5.4.5.tgz#0000000000000000000000000000000000000000' })
    })

    const { lockfile, diagnostics } = stringifyWithDiagnostics(result.graph)
    // Reparse must not throw the seal `IRREDUCIBLE_LOSS: two entries collapse`.
    const reparsed = parse(lockfile)
    const typescriptNodes = Array.from(reparsed.nodes()).filter(n => n.name === 'typescript')
    expect(typescriptNodes).toHaveLength(1)
    expect(typescriptNodes[0]?.id).toBe('typescript@5.4.5')
    expect(typescriptNodes[0]?.patch).toBeUndefined()

    // Patch loss attributed via RECIPE_FEATURE_DROPPED on the patched sibling.
    const patchDrops = diagnostics.filter(d =>
      d.code === 'RECIPE_FEATURE_DROPPED' && d.subject === patchedId,
    )
    expect(patchDrops).toHaveLength(1)
  })
})

describe('yarn-classic — enrich', () => {
  it('synthesizes the workspace root and classifies root edges from manifests', () => {
    const result = enrich(workspaceFixtureGraph(), undefined, { manifests: WORKSPACE_MANIFESTS })

    expect(result.diagnostics).toEqual([])
    expect(result.graph.getNode('case-workspaces-basic@0.0.0')).toEqual({
      id: 'case-workspaces-basic@0.0.0',
      name: 'case-workspaces-basic',
      version: '0.0.0',
      peerContext: [],
      workspacePath: '',
    })
    expect(result.graph.out('case-workspaces-basic@0.0.0').map(edge => ({
      dst: edge.dst,
      kind: edge.kind,
      range: edge.attrs?.range,
      workspace: edge.attrs?.workspace,
    })).sort((a, b) => a.dst.localeCompare(b.dst))).toEqual([
      { dst: '@case-ws/a@0.0.0-use.local', kind: 'dep', range: 'workspace:*', workspace: true },
      { dst: '@case-ws/b@0.0.0-use.local', kind: 'dev', range: 'workspace:^', workspace: true },
      { dst: 'ms@2.1.3', kind: 'optional', range: '2.1.3', workspace: undefined },
    ])
  })

  // ADR-0019 §C item (b): "distinguish workspace-member entries from such
  // external lookalikes". Without setting `workspacePath` on member nodes,
  // downstream emit (yarn-berry stringify) cannot tell members apart from
  // external nodes that happen to share the `0.0.0-use.local` version literal,
  // and the `attrs.workspace = true` markers fall off across format boundaries.
  it('marks workspace-member nodes with workspacePath from manifest paths', () => {
    const result = enrich(workspaceFixtureGraph(), undefined, { manifests: WORKSPACE_MANIFESTS })

    expect(result.graph.getNode('@case-ws/a@0.0.0-use.local')?.workspacePath).toBe('packages/a')
    expect(result.graph.getNode('@case-ws/b@0.0.0-use.local')?.workspacePath).toBe('packages/b')
    // Non-member nodes stay unmarked.
    expect(result.graph.getNode('ms@2.1.3')?.workspacePath).toBeUndefined()
  })

  it('warns once without manifests and leaves local-member edges flat', () => {
    const graph = parseFixtureGraph('simple').mutate(m => {
      m.addNode({
        id: 'case-simple@0.0.0-use.local',
        name: 'case-simple',
        version: '0.0.0-use.local',
        peerContext: [],
      })
      m.addEdge('case-simple@0.0.0-use.local', 'ms@2.1.3', 'dep', { range: '2.1.3' })
    }).graph
    const result = enrich(graph)

    expect(result.diagnostics).toEqual([
      {
        code: 'YARN_CLASSIC_NO_MANIFESTS',
        severity: 'warning',
        message: 'workspace concretisation requires manifests; leaving yarn-classic graph unclassified',
      },
    ])
    expect(result.graph.getNode('case-simple@0.0.0-use.local')).toEqual({
      id: 'case-simple@0.0.0-use.local',
      name: 'case-simple',
      version: '0.0.0-use.local',
      peerContext: [],
    })
    expect(result.graph.out('case-simple@0.0.0-use.local')).toEqual([
      {
        src: 'case-simple@0.0.0-use.local',
        dst: 'ms@2.1.3',
        kind: 'dep',
        attrs: { range: '2.1.3' },
      },
    ])
  })

  it('never derives peers or emits YARN_CLASSIC_PEER_* diagnostics', () => {
    const result = enrich(parseFixtureGraph('peers-basic'), undefined, { manifests: {} })

    expect(Array.from(result.graph.nodes(), node => node.peerContext)).toEqual([
      [],
      [],
      [],
      [],
      [],
    ])
    expect(result.diagnostics.filter(diagnostic => diagnostic.code.startsWith('YARN_CLASSIC_PEER_'))).toEqual([])
  })

  it('is idempotent', () => {
    const once = enrich(workspaceFixtureGraph(), undefined, { manifests: WORKSPACE_MANIFESTS })
    const twice = enrich(once.graph, undefined, { manifests: WORKSPACE_MANIFESTS })

    expect(graphSnapshot(twice.graph)).toEqual(graphSnapshot(once.graph))
    expect(twice.diagnostics).toEqual(once.diagnostics)
  })
})

describe('yarn-classic — optimize', () => {
  function graphWithOrphan(): Graph {
    const base = parseFixtureGraph('simple')
    return base.mutate(m => {
      m.addNode({
        id: 'orphan@9.9.9',
        name: 'orphan',
        version: '9.9.9',
        peerContext: [],
      })
      m.addEdge('orphan@9.9.9', 'orphan@9.9.9', 'dep', { range: '9.9.9' })
      m.setTarball({ name: 'orphan', version: '9.9.9' }, { integrity: mkIntegrity('sha512-orphan'), nativeResolution: 'https://registry.yarnpkg.com/orphan/-/orphan-9.9.9.tgz#0000000000000000000000000000000000000000' })
    }).graph
  }

  function graphWithCyclePair(): Graph {
    const base = parseFixtureGraph('simple')
    return base.mutate(m => {
      m.addNode({
        id: 'cycle-a@1.0.0',
        name: 'cycle-a',
        version: '1.0.0',
        peerContext: [],
      })
      m.addNode({
        id: 'cycle-b@1.0.0',
        name: 'cycle-b',
        version: '1.0.0',
        peerContext: [],
      })
      m.addEdge('cycle-a@1.0.0', 'cycle-b@1.0.0', 'dep', { range: '1.0.0' })
      m.addEdge('cycle-b@1.0.0', 'cycle-a@1.0.0', 'dep', { range: '1.0.0' })
      m.setTarball({ name: 'cycle-a', version: '1.0.0' }, { integrity: mkIntegrity('sha512-cycle-a'), nativeResolution: 'https://registry.yarnpkg.com/cycle-a/-/cycle-a-1.0.0.tgz#1111111111111111111111111111111111111111' })
      m.setTarball({ name: 'cycle-b', version: '1.0.0' }, { integrity: mkIntegrity('sha512-cycle-b'), nativeResolution: 'https://registry.yarnpkg.com/cycle-b/-/cycle-b-1.0.0.tgz#2222222222222222222222222222222222222222' })
    }).graph
  }

  it('is idempotent', () => {
    const once = optimize(graphWithOrphan())
    const twice = optimize(once.graph)

    expect(graphSnapshot(twice.graph)).toEqual(graphSnapshot(once.graph))
    expect(twice.diagnostics).toEqual(once.diagnostics)
  })

  it('prunes an unreachable orphan cycle and its tarball', () => {
    const graph = graphWithOrphan()
    const result = optimize(graph)

    expect(result.graph.getNode('orphan@9.9.9')).toBeUndefined()
    expect(result.graph.tarball({ name: 'orphan', version: '9.9.9' })).toBeUndefined()
    expect(graph.diff(result.graph)).toEqual({
      addedNodes: [],
      removedNodes: ['orphan@9.9.9'],
      changedNodes: [],
      addedEdges: [],
      removedEdges: [{ src: 'orphan@9.9.9', dst: 'orphan@9.9.9', kind: 'dep' }],
    })
  })

  it('prunes unreachable mutual-cycle nodes', () => {
    const graph = graphWithCyclePair()
    const result = optimize(graph)

    expect(result.graph.getNode('cycle-a@1.0.0')).toBeUndefined()
    expect(result.graph.getNode('cycle-b@1.0.0')).toBeUndefined()
    expect(result.graph.tarball({ name: 'cycle-a', version: '1.0.0' })).toBeUndefined()
    expect(result.graph.tarball({ name: 'cycle-b', version: '1.0.0' })).toBeUndefined()
    expect(graph.diff(result.graph)).toEqual({
      addedNodes: [],
      removedNodes: ['cycle-a@1.0.0', 'cycle-b@1.0.0'],
      changedNodes: [],
      addedEdges: [],
      removedEdges: [
        { src: 'cycle-a@1.0.0', dst: 'cycle-b@1.0.0', kind: 'dep' },
        { src: 'cycle-b@1.0.0', dst: 'cycle-a@1.0.0', kind: 'dep' },
      ],
    })
  })

  it('preserves every reachable node and tarball on fixture graphs', () => {
    const graph = parseFixtureGraph('peers-basic')
    const result = optimize(graph)

    expect(graphSnapshot(result.graph)).toEqual(graphSnapshot(graph))
    expect(Array.from(result.graph.tarballs(), ([key]) => key)).toEqual(
      Array.from(graph.tarballs(), ([key]) => key),
    )
    expect(result.diagnostics).toEqual([])
  })

  it('prunes an orphan node lacking a tarball entry without crashing', () => {
    const base = parseFixtureGraph('simple')
    const graph = base.mutate(m => {
      m.addNode({
        id: 'orphan-no-tarball@9.9.9',
        name: 'orphan-no-tarball',
        version: '9.9.9',
        peerContext: [],
      })
      m.addEdge('orphan-no-tarball@9.9.9', 'orphan-no-tarball@9.9.9', 'dep', { range: '9.9.9' })
    }).graph
    expect(graph.tarball({ name: 'orphan-no-tarball', version: '9.9.9' })).toBeUndefined()

    const result = optimize(graph)

    expect(result.graph.getNode('orphan-no-tarball@9.9.9')).toBeUndefined()
    expect(result.graph.tarball({ name: 'orphan-no-tarball', version: '9.9.9' })).toBeUndefined()
    expect(graph.diff(result.graph)).toEqual({
      addedNodes: [],
      removedNodes: ['orphan-no-tarball@9.9.9'],
      changedNodes: [],
      addedEdges: [],
      removedEdges: [{ src: 'orphan-no-tarball@9.9.9', dst: 'orphan-no-tarball@9.9.9', kind: 'dep' }],
    })
  })

  it('survives yarn-classic stringify/parse roundtrip when re-enrich compensates for the synthesized root', () => {
    const enriched = enrich(parseFixtureGraph('workspaces-basic'), undefined, { manifests: WORKSPACE_MANIFESTS })
    const optimized = optimize(enriched.graph)
    const reparsed = enrich(parse(stringify(optimized.graph)), undefined, { manifests: WORKSPACE_MANIFESTS })

    expect(graphSnapshot(reparsed.graph)).toEqual(graphSnapshot(enriched.graph))
    expectEmptyGraphDiff(enriched.graph.diff(reparsed.graph))
    expect(reparsed.diagnostics).toEqual([])
  })
})

// Real-world regression edge-case coverage. The `resolved` URL-shape filter
// (shared by `formatResolution` and `deriveResolvedFromCanonical` via
// `isYarnClassicResolvableUrl`) must round-trip EVERY shape `parseResolution`
// accepts off disk — any scheme-based URL (`https://`, `http://`, `git+https://`,
// `git+ssh://`, `git://`, `ssh://`, …) AND the SCP-form `git@host:owner/repo`
// shorthand. yarn-classic git deps are first-class: snapshot.50 made them parse,
// so dropping the `resolved` line on emit produced a lockfile `yarn install
// --immutable` rejects (F2). This block pins symmetric parse/emit acceptance
// across the URL prefixes plus the git protocols that were previously dropped.
describe('yarn-classic — resolved URL-shape exhaustive coverage', () => {
  function emitFor(can: import('../../main/ts/recipe/resolution.ts').ResolutionCanonical): string {
    const builder = newBuilder()
    builder.addNode({
      id: 'pkg@1.0.0',
      name: 'pkg',
      version: '1.0.0',
      peerContext: [],
    })
    builder.setTarball({ name: 'pkg', version: '1.0.0' }, { resolution: can })
    return stringify(builder.seal())
  }

  it('keeps each of the accepted URL prefixes (https, http, codeload, git+https)', () => {
    for (const url of [
      'https://registry.yarnpkg.com/ms/-/ms-2.1.3.tgz',
      'http://registry.example.com/foo/-/foo-1.0.0.tgz',
      'https://codeload.github.com/owner/repo/tar.gz/abcdef1234567890abcdef1234567890abcdef12',
      'git+https://github.com/owner/repo.git#abcdef1234567890abcdef1234567890abcdef12',
    ]) {
      const emitted = emitFor({ type: 'unknown', raw: url })
      expect(emitted).toContain(`resolved "${url}"`)
    }
  })

  it('keeps the git protocols parse accepts (git+ssh://, git://, ssh://, SCP-form git@host:path) — F2', () => {
    for (const raw of [
      'git+ssh://git@github.com/owner/repo.git#abcdef1234567890abcdef1234567890abcdef12',
      'git://github.com/owner/repo.git#abcdef1234567890abcdef1234567890abcdef12',
      'ssh://git@github.com/owner/repo.git#abcdef1234567890abcdef1234567890abcdef12',
      'git@github.com:owner/repo.git#abcdef1234567890abcdef1234567890abcdef12',
    ]) {
      const emitted = emitFor({ type: 'unknown', raw })
      expect(emitted).toContain(`resolved "${raw}"`)
    }
  })
})

// Real-world regression: yarn 1 lockfiles freely mix quoted and unquoted
// descriptors in the same comma-separated entry head, e.g.:
//   "readable-stream@1 || 2", readable-stream@^2.0.2:
// The parser previously rejected these because parseEntryKeyToken checked only
// the first character — if the head started with `"` it tried to parse the
// entire raw token as a single quoted string, failing when the token ended with
// an unquoted segment.  The fix splits on top-level `, ` first, then un-quotes
// each descriptor independently.
describe('yarn-classic — mixed quoted/unquoted descriptor lists', () => {
  function makeFixture(head: string, pkg: string, version: string): string {
    return (
      '# THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.\n' +
      '# yarn lockfile v1\n\n\n' +
      `${head}:\n` +
      `  version "${version}"\n` +
      `  resolved "https://registry.yarnpkg.com/${pkg}/-/${pkg}-${version}.tgz"\n` +
      `  integrity sha512-deadbeef\n`
    )
  }

  it('parses mixed: first quoted, second unquoted', () => {
    const lock = makeFixture('"foo@^1.0.0", foo@^1.1.0', 'foo', '1.2.0')
    const graph = parse(lock)
    expect(graph.getNode('foo@1.2.0')).toBeDefined()
  })

  it('parses mixed: first unquoted, second quoted', () => {
    const lock = makeFixture('foo@^1.0.0, "foo@^1.1.0"', 'foo', '1.2.0')
    const graph = parse(lock)
    expect(graph.getNode('foo@1.2.0')).toBeDefined()
  })

  it('parses all-unquoted control', () => {
    const lock = makeFixture('foo@^1.0.0, foo@^1.1.0', 'foo', '1.2.0')
    const graph = parse(lock)
    expect(graph.getNode('foo@1.2.0')).toBeDefined()
  })

  it('parses all-quoted control', () => {
    const lock = makeFixture('"foo@^1.0.0", "foo@^1.1.0"', 'foo', '1.2.0')
    const graph = parse(lock)
    expect(graph.getNode('foo@1.2.0')).toBeDefined()
  })

  it('parses the real-world readable-stream composite key pattern', () => {
    const lock = makeFixture('"readable-stream@1 || 2", readable-stream@^2.0.2', 'readable-stream', '2.3.7')
    const graph = parse(lock)
    expect(graph.getNode('readable-stream@2.3.7')).toBeDefined()
  })

  it('round-trips mixed-descriptor graph through stringify/parse', () => {
    // Use a canonical SRI so the tarball entry round-trips without diagnostic noise.
    const integrity = sriOf('foo-1.2.0-content')
    const lock = (
      '# THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.\n' +
      '# yarn lockfile v1\n\n\n' +
      '"foo@^1.0.0", foo@^1.1.0:\n' +
      '  version "1.2.0"\n' +
      `  resolved "https://registry.yarnpkg.com/foo/-/foo-1.2.0.tgz"\n` +
      `  integrity ${integrity}\n`
    )
    const graph = parse(lock)
    // stringify always quotes multi-spec entry keys (mustQuoteEntryKey returns
    // true for specs.length > 1), so the emitted form will be all-quoted — that
    // is acceptable; what matters is that the graph round-trips without loss.
    const emitted = stringify(graph)
    const reparsed = parse(emitted)
    expect(graphSnapshot(reparsed)).toEqual(graphSnapshot(graph))
    expectEmptyGraphDiff(graph.diff(reparsed))
  })
})

const CLASSIC_HEADER =
  '# THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.\n' +
  '# yarn lockfile v1\n\n\n'

describe('parseSpec', () => {
  it('splits a scoped descriptor at the range `@`, not the leading scope `@`', () => {
    expect(parseSpec('@scope/pkg@^1.2.3')).toEqual({ name: '@scope/pkg', spec: '^1.2.3' })
  })

  it('rejects a bare package name with no `@<range>`', () => {
    expect(() => parseSpec('lodash')).toThrow(/bare package name with no '@<range>'/)
  })

  it('rejects a leading-`@`-only / trailing-`@` spec', () => {
    expect(() => parseSpec('@foo')).toThrow(/bare package name/)
    expect(() => parseSpec('foo@')).toThrow(/bad entry-spec/)
  })
})

describe('specIdentity', () => {
  it('resolves an npm-alias descriptor to the TARGET name, keeping the alias', () => {
    expect(specIdentity({ name: 'my-lodash', spec: 'npm:lodash@^4.17.0' })).toEqual({
      resolvedName: 'lodash',
      aliasName: 'my-lodash',
      descriptorKey: 'my-lodash@npm:lodash@^4.17.0',
    })
  })

  it('treats `npm:<bare-range>` (no embedded `@`) as the descriptor own name, not an alias', () => {
    // `npm:~5.26.4` is a default-protocol range, NOT an alias to a package
    // literally called `~5.26.4`.
    expect(specIdentity({ name: 'undici-types', spec: 'npm:~5.26.4' })).toEqual({
      resolvedName: 'undici-types',
      descriptorKey: 'undici-types@npm:~5.26.4',
    })
  })

  it('treats a self-referential `npm:` alias to the same name as non-alias', () => {
    expect(specIdentity({ name: 'foo', spec: 'npm:foo@^1.0.0' })).toEqual({
      resolvedName: 'foo',
      descriptorKey: 'foo@npm:foo@^1.0.0',
    })
  })

  it('keeps a scoped npm-alias TARGET name', () => {
    expect(specIdentity({ name: 'alias', spec: 'npm:@scope/pkg@^1' })).toEqual({
      resolvedName: '@scope/pkg',
      aliasName: 'alias',
      descriptorKey: 'alias@npm:@scope/pkg@^1',
    })
  })
})

describe('splitEntryKey', () => {
  it('splits on `, ` and drops empties', () => {
    expect(splitEntryKey('a@^1, a@^2')).toEqual(['a@^1', 'a@^2'])
    expect(splitEntryKey('')).toEqual([])
  })
})

describe('parseEntryKeyToken', () => {
  it('un-quotes individual descriptors and preserves a quoted range with a comma-free `||`', () => {
    // `"foo@1 || 2"` is a single quoted descriptor whose range has spaces; the
    // top-level `, ` splitter must not cut inside it.
    expect(parseEntryKeyToken('"foo@1 || 2", foo@^2.0.0')).toBe('foo@1 || 2, foo@^2.0.0')
  })

  it('leaves a fully-bare list untouched', () => {
    expect(parseEntryKeyToken('acorn@^8.15.0, acorn@^8.16.0')).toBe('acorn@^8.15.0, acorn@^8.16.0')
  })
})

describe('parseDependencyLine', () => {
  it('parses a bare name + bare range dependency line', () => {
    expect(parseDependencyLine('    lodash ^4.17.0')).toEqual(['lodash', '^4.17.0'])
  })

  it('parses a quoted name + quoted range with an embedded space', () => {
    expect(parseDependencyLine('    "@scope/pkg" "npm:^1 || ^2"')).toEqual(['@scope/pkg', 'npm:^1 || ^2'])
  })

  it('rejects a malformed dependency line (single token)', () => {
    expect(() => parseDependencyLine('    lodash')).toThrow(/malformed dependency line/)
  })
})

describe('parseQuotedToken', () => {
  it('decodes escaped quote and backslash', () => {
    expect(parseQuotedToken('"a\\"b\\\\c"')).toBe('a"b\\c')
  })

  it('rejects a non-quoted token', () => {
    expect(() => parseQuotedToken('bare')).toThrow(/expected quoted token/)
  })

  it('rejects an unsupported escape sequence', () => {
    expect(() => parseQuotedToken('"a\\nb"')).toThrow(/unsupported escape sequence/)
  })
})

describe('isClassicRegistryRange', () => {
  it('npm-alias, bare semver, and tag are registry; explicit protocols are not', () => {
    expect(isClassicRegistryRange('npm:lodash@^4')).toBe(true)
    expect(isClassicRegistryRange('^1.2.3')).toBe(true)
    expect(isClassicRegistryRange('latest')).toBe(true)
    expect(isClassicRegistryRange('file:../local')).toBe(false)
    expect(isClassicRegistryRange('git+https://x/y.git')).toBe(false)
    // A URL whose scheme part is not a bare lowercase protocol token is treated
    // as a registry range.
    expect(isClassicRegistryRange('1.x:weird')).toBe(true)
  })
})

describe('descriptorSatisfies', () => {
  it('an in-range descriptor carries; an exact-pin miss and a non-semver range do not', () => {
    expect(descriptorSatisfies('lodash@^4.17.0', '4.18.0')).toBe(true)
    expect(descriptorSatisfies('lodash@4.17.11', '4.18.0')).toBe(false)
    expect(descriptorSatisfies('lodash@not-a-range', '4.18.0')).toBe(false)
    expect(descriptorSatisfies('lodash', '4.18.0')).toBe(false)
  })
})

describe('isYarnClassicResolvableUrl', () => {
  it('accepts scheme URLs and the scp-like git shorthand', () => {
    expect(isYarnClassicResolvableUrl('https://registry.npmjs.org/ms/-/ms-2.1.3.tgz')).toBe(true)
    expect(isYarnClassicResolvableUrl('git+ssh://git@host/o/r.git')).toBe(true)
    expect(isYarnClassicResolvableUrl('git@github.com:o/r.git')).toBe(true)
    expect(isYarnClassicResolvableUrl('file:../local')).toBe(false)
  })
})

describe('isYarnClassicLocalSpec', () => {
  it('accepts non-authority file/link/portal specs only', () => {
    expect(isYarnClassicLocalSpec('file:./pkg')).toBe(true)
    expect(isYarnClassicLocalSpec('link:../x')).toBe(true)
    expect(isYarnClassicLocalSpec('portal:packages/y')).toBe(true)
    // `//`-authority is a URL, handled by isYarnClassicResolvableUrl.
    expect(isYarnClassicLocalSpec('file://host/x')).toBe(false)
    // empty body after the colon is not a usable specifier.
    expect(isYarnClassicLocalSpec('file:')).toBe(false)
  })
})

describe('parseLocalSpec', () => {
  it('splits protocol + verbatim path, undefined for a URL', () => {
    expect(parseLocalSpec('link:../a/b')).toEqual({ protocol: 'link', path: '../a/b' })
    expect(parseLocalSpec('https://x/y')).toBeUndefined()
  })
})

describe('canonicalResolutionOfResolved', () => {
  it('maps a local spec to a directory canonical, delegates a tarball to the recipe', () => {
    expect(canonicalResolutionOfResolved('file:./vendor/pkg')).toEqual({ type: 'directory', path: './vendor/pkg' })
    const tar = canonicalResolutionOfResolved('https://registry.npmjs.org/ms/-/ms-2.1.3.tgz')
    expect(tar.type).toBe('tarball')
  })
})

describe('parseResolution', () => {
  it('stores a valid URL/local verbatim and rejects an unsupported shape', () => {
    expect(parseClassicResolution('git+https://x/y.git#deadbeef')).toBe('git+https://x/y.git#deadbeef')
    expect(parseClassicResolution('portal:packages/y')).toBe('portal:packages/y')
    expect(() => parseClassicResolution('lodash@npm:4.17.21')).toThrow(/unsupported resolved URL/)
  })
})

describe('formatResolution', () => {
  it('round-trips accepted shapes and returns undefined for a foreign locator', () => {
    expect(formatResolution('https://x/y.tgz')).toBe('https://x/y.tgz')
    expect(formatResolution('link:../x')).toBe('link:../x')
    expect(formatResolution(undefined)).toBeUndefined()
    // A yarn-berry locator is neither a URL nor a local spec, so emit falls back
    // to the canonical-derived path rather than throwing.
    expect(formatResolution('lodash@npm:4.17.21')).toBeUndefined()
  })
})

describe('registryBaseOf', () => {
  it('extracts the base of a registry-tarball URL, undefined otherwise', () => {
    expect(registryBaseOf('https://registry.yarnpkg.com/ms/-/ms-2.1.3.tgz#abc'))
      .toBe('https://registry.yarnpkg.com')
    expect(registryBaseOf('https://registry.npmjs.org/@scope/pkg/-/pkg-1.0.0.tgz'))
      .toBe('https://registry.npmjs.org')
    expect(registryBaseOf('git+https://x/y.git')).toBeUndefined()
  })
})

describe('scopeOf', () => {
  it('returns the scope for a scoped name, empty for unscoped', () => {
    expect(scopeOf('@mycorp/pkg')).toBe('@mycorp')
    expect(scopeOf('lodash')).toBe('')
  })
})

describe('deriveResolvedFromCanonical', () => {
  it('rehosts a registry tarball onto the supplied base and appends the #<sha1>', () => {
    const canonical = { type: 'tarball' as const, url: 'https://registry.npmjs.org/ms/-/ms-2.1.3.tgz' }
    // The sha1 emits as a `#<sha1>` fragment only for a `url-fragment`-origin hash.
    const integrity = { hashes: [{ algorithm: 'sha1', digest: '574c8138ce1d2b5861f0b44579dbadd60c6615b2', origin: 'url-fragment' as const }] }
    const out = deriveResolvedFromCanonical(canonical, integrity, 'https://registry.yarnpkg.com')
    expect(out).toBe('https://registry.yarnpkg.com/ms/-/ms-2.1.3.tgz#574c8138ce1d2b5861f0b44579dbadd60c6615b2')
  })

  it('returns undefined for a canonical that projects to a non-reparseable shape', () => {
    // An `unknown` canonical projects to a raw yarn-berry locator, not a classic
    // `resolved` shape.
    expect(deriveResolvedFromCanonical({ type: 'unknown', raw: 'lodash@patch:lodash@npm%3A4#p' })).toBeUndefined()
    expect(deriveResolvedFromCanonical(undefined)).toBeUndefined()
  })
})

describe('inferRegistryBases', () => {
  it('majority-votes the per-scope base from native entries and falls back to the yarn-1 default', () => {
    const graph = parse(
      CLASSIC_HEADER +
      'lodash@4.17.21:\n' +
      '  version "4.17.21"\n' +
      '  resolved "https://registry.yarnpkg.com/lodash/-/lodash-4.17.21.tgz#679591c564c3bffaae8454cf0b3df370c3d6911c"\n' +
      `  integrity ${sriOf('lodash')}\n`,
    )
    const baseFor = inferRegistryBases(graph)
    expect(baseFor('lodash')).toBe('https://registry.yarnpkg.com')
    // An unscoped name with no sibling base learned falls back to the majority
    // unscoped base (here yarnpkg.com is the only vote).
    expect(baseFor('anything-else')).toBe('https://registry.yarnpkg.com')
  })
})

describe('mustQuoteSpec', () => {
  it('wraps a descriptor with the exact trigger class + non-letter leading char', () => {
    // colon / space / scoped-@ / leading-digit → wrapped.
    expect(mustQuoteSpec('lodash@npm:^4')).toBe(true) // has a colon
    expect(mustQuoteSpec('foo@1 || 2')).toBe(true) // has a space
    expect(mustQuoteSpec('@scope/pkg@^1')).toBe(true) // leading @ (not a letter)
    expect(mustQuoteSpec('7zip@^1')).toBe(true) // leading digit
    expect(mustQuoteSpec('true@^1')).toBe(true) // begins with `true`
    // bare caret/tilde/star ranges stay UNQUOTED (deliberately narrower rule).
    expect(mustQuoteSpec('acorn@^8.5.0')).toBe(false)
    expect(mustQuoteSpec('foo@*')).toBe(false)
    expect(mustQuoteSpec('amdefine@>=0.0.4')).toBe(false)
  })
})

describe('quoteDepName', () => {
  it('quotes a scoped or non-bare name, leaves a plain name bare', () => {
    expect(quoteDepName('@scope/pkg')).toBe('"@scope/pkg"')
    expect(quoteDepName('lodash')).toBe('lodash')
    expect(quoteDepName('weird name')).toBe('"weird name"')
  })
})

describe('stringifyEntryKey', () => {
  it('quote-decides each descriptor independently then comma-joins', () => {
    expect(stringifyEntryKey(['@babel/core@^7.23.9', '@babel/core@^7.24.4']))
      .toBe('"@babel/core@^7.23.9", "@babel/core@^7.24.4"')
    expect(stringifyEntryKey(['acorn@^8.15.0', 'acorn@^8.16.0']))
      .toBe('acorn@^8.15.0, acorn@^8.16.0')
  })
})

describe('parseEntries', () => {
  it('captures an unknown scalar entry field (yarn-1 `uid ""`) verbatim in extras', () => {
    const entries = parseEntries(
      CLASSIC_HEADER +
      '"pkg@file:./x":\n' +
      '  version "0.0.0"\n' +
      '  resolved "file:./x"\n' +
      '  uid ""\n',
    )
    expect(entries).toHaveLength(1)
    expect(entries[0]!.extras).toEqual(['uid ""'])
    expect(entries[0]!.version).toBe('0.0.0')
    expect(entries[0]!.resolved).toBe('file:./x')
  })

  it('parses a multi-hash integrity that is QUOTED (space-joined) by un-quoting it', () => {
    const value = `"sha1-abc sha512-${createHash('sha512').update('x').digest('base64')}"`
    const entries = parseEntries(
      CLASSIC_HEADER +
      'ms@2.1.3:\n' +
      '  version "2.1.3"\n' +
      `  integrity ${value}\n`,
    )
    // The surrounding quotes must be stripped so the multi-hash parser sees both.
    expect(entries[0]!.integrity).toBe(value.slice(1, -1))
    expect(entries[0]!.integrity!.startsWith('sha1-abc sha512-')).toBe(true)
  })

  it('rejects a top-level line that does not end with `:`', () => {
    expect(() => parseEntries(CLASSIC_HEADER + 'not-a-key\n  version "1.0.0"\n'))
      .toThrow(/top-level entry line must end with ':'/)
  })

  it('rejects a body line before any entry header', () => {
    expect(() => parseEntries(CLASSIC_HEADER + '  version "1.0.0"\n'))
      .toThrow(/body line without entry header/)
  })

  it('rejects a 4-space dependency line outside a dependency block', () => {
    expect(() => parseEntries(
      CLASSIC_HEADER +
      'a@^1:\n' +
      '  version "1.0.0"\n' +
      '    lodash ^4.0.0\n',
    )).toThrow(/dependency line outside dependency block/)
  })

  it('rejects an odd indent (single leading space) that is neither a field nor a dep line', () => {
    // A single-space-indented body line is neither a top-level key, a 2-space
    // field, nor a 4-space dep line.
    expect(() => parseEntries(
      CLASSIC_HEADER +
      'a@^1:\n' +
      '  version "1.0.0"\n' +
      ' weird\n',
    )).toThrow(/unexpected indent/)
  })

  it('rejects a quoted field-KEY (a yarn-error.log "Lockfile:" dump signature)', () => {
    expect(() => parseEntries(
      CLASSIC_HEADER +
      'a@^1:\n' +
      '  "version" "1.0.0"\n',
    )).toThrow(/quoted field-key .* is not valid yarn-classic/)
  })
})

describe('parse', () => {
  it('throws PARSE_FAILED-family on an entry missing a version', () => {
    expect(() => parse(CLASSIC_HEADER + 'a@^1:\n  resolved "https://x/y.tgz"\n'))
      .toThrow(LockfileError)
  })

  it('emits a git+ssh resolved line byte-for-byte on same-format round-trip', () => {
    const input =
      CLASSIC_HEADER +
      '"is-git@git+https://github.com/sindresorhus/is.git#v6.3.1":\n' +
      '  version "6.3.1"\n' +
      '  resolved "git+https://github.com/sindresorhus/is.git#47f49741eacf0a3678684738159a87c2011bb026"\n'
    const graph = parse(input)
    const out = stringify(graph)
    expect(out).toBe(input)
  })

  it('parse-then-stringify preserves an unknown `uid` field for a link: entry', () => {
    const input =
      CLASSIC_HEADER +
      '"pkg@link:../pkg":\n' +
      '  version "0.0.0"\n' +
      '  resolved "link:../pkg"\n' +
      '  uid ""\n'
    const out = stringify(parse(input))
    expect(out).toContain('  uid ""')
    expect(out).toContain('  resolved "link:../pkg"')
  })

  it('flags an invalid (empty) integrity with a diagnostic but still parses the node', () => {
    // An SRI whose algorithm is unknown parses to an empty Integrity → diagnostic.
    const graph = parse(
      CLASSIC_HEADER +
      'ms@2.1.3:\n' +
      '  version "2.1.3"\n' +
      '  resolved "https://registry.yarnpkg.com/ms/-/ms-2.1.3.tgz#abc"\n' +
      '  integrity md5-deadbeef==\n',
    )
    expect(graph.getNode('ms@2.1.3')).toBeDefined()
    expect(graph.diagnostics().some(d => d.code === 'YARN_CLASSIC_INVALID_INTEGRITY' || /integrity/i.test(d.message))).toBe(true)
  })

  it('diagnoses an ambiguous dist-tag (`latest`) against >=2 registry siblings and drops the edge', () => {
    const graph = parse(
      CLASSIC_HEADER +
      'consumer@1.0.0:\n' +
      '  version "1.0.0"\n' +
      '  resolved "https://registry.yarnpkg.com/consumer/-/consumer-1.0.0.tgz#aa"\n' +
      '  dependencies:\n' +
      '    lodash "latest"\n\n' +
      'lodash@4.17.20:\n' +
      '  version "4.17.20"\n' +
      '  resolved "https://registry.yarnpkg.com/lodash/-/lodash-4.17.20.tgz#bb"\n\n' +
      'lodash@4.17.21:\n' +
      '  version "4.17.21"\n' +
      '  resolved "https://registry.yarnpkg.com/lodash/-/lodash-4.17.21.tgz#cc"\n',
    )
    const codes = graph.diagnostics().map(d => d.code)
    expect(codes).toContain('YARN_CLASSIC_AMBIGUOUS_RESOLUTION')
    expect(codes).toContain('YARN_CLASSIC_RESOLUTION_PIN_UNRESOLVED')
    // No edge was guessed to either lodash sibling.
    expect(graph.out('consumer@1.0.0', 'dep')).toHaveLength(0)
  })

  it('captures an absent-target dep verbatim, warns MISSING_ENTRY, and re-emits it byte-for-byte', () => {
    const input =
      CLASSIC_HEADER +
      'consumer@1.0.0:\n' +
      '  version "1.0.0"\n' +
      '  resolved "https://registry.yarnpkg.com/consumer/-/consumer-1.0.0.tgz#aa"\n' +
      '  dependencies:\n' +
      '    ghost "^1.0.0"\n'
    const graph = parse(input)
    expect(graph.diagnostics().map(d => d.code)).toContain('YARN_CLASSIC_MISSING_ENTRY')
    // No phantom `ghost` node was minted.
    expect(graph.byName('ghost')).toHaveLength(0)
    // Same-format round-trip re-emits the dropped dep line verbatim.
    expect(stringify(graph)).toContain('    ghost "^1.0.0"')
  })

  it('rejects a berry metadata header with FORMAT_MISMATCH', () => {
    expect(() => parse('__metadata:\n  version: 8\n'))
      .toThrow(/yarn-berry metadata header/)
  })

  it('rejects a body whose first two lines are not the v1 header comments', () => {
    // Not the header, not a berry head, not a structural body → FORMAT_MISMATCH.
    expect(() => parse('# some other comment\nrandom junk\n'))
      .toThrow(LockfileError)
  })
})

describe('check', () => {
  it('accepts a headerless body with the col-0 name@range + `  version "…"` shape', () => {
    const headerless = 'lodash@4.17.21:\n  version "4.17.21"\n'
    expect(check(headerless)).toBe(true)
  })

  it('rejects a berry lock (has __metadata head)', () => {
    expect(check('__metadata:\n  version: 8\n')).toBe(false)
  })

  it('rejects a bare-package-name key (no `@<range>`) as a structural body', () => {
    expect(check('lodash:\n  version "4.17.21"\n')).toBe(false)
  })
})

describe('stringify', () => {
  it('warns YARN_CLASSIC_PEER_DROPPED + YARN_CLASSIC_PEER_VIRT_FLATTENED for a peer-virtual node', () => {
    const b = newBuilder()
    const peer = serializeNodeId('peerdep', '2.0.0', [])
    // A peer-virtual host: its peerContext lists the peer target, so the seal's
    // "peer edges agree with peerContext" invariant holds. The classic emit
    // cannot represent either → two warnings.
    const host = serializeNodeId('host', '1.0.0', [peer])
    b.addNode({ id: peer, name: 'peerdep', version: '2.0.0', peerContext: [] })
    b.addNode({ id: host, name: 'host', version: '1.0.0', peerContext: [peer] })
    b.setTarball({ name: 'host', version: '1.0.0' }, { resolution: { type: 'tarball', url: 'https://registry.npmjs.org/host/-/host-1.0.0.tgz' } })
    b.setTarball({ name: 'peerdep', version: '2.0.0' }, { resolution: { type: 'tarball', url: 'https://registry.npmjs.org/peerdep/-/peerdep-2.0.0.tgz' } })
    b.addEdge(host, peer, 'peer', { range: '^2.0.0' })
    const graph = b.seal()

    const diagnostics: string[] = []
    stringify(graph, { onDiagnostic: d => diagnostics.push(d.code) })
    expect(diagnostics).toContain('YARN_CLASSIC_PEER_DROPPED')
    expect(diagnostics).toContain('YARN_CLASSIC_PEER_VIRT_FLATTENED')
  })

  it('warns RECIPE_FEATURE_DROPPED (feature=patch) when a patched node is flattened on emit', () => {
    const b = newBuilder()
    const id = serializeNodeId('lodash', '4.17.21', [], 'a'.repeat(128))
    b.addNode({ id, name: 'lodash', version: '4.17.21', peerContext: [], patch: 'a'.repeat(128) })
    b.setTarball({ name: 'lodash', version: '4.17.21', patch: 'a'.repeat(128) }, { resolution: { type: 'tarball', url: 'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz' } })
    const graph = b.seal()
    const diagnostics: Array<{ code: string; message: string }> = []
    stringify(graph, { onDiagnostic: d => diagnostics.push({ code: d.code, message: d.message }) })
    // yarn-classic routes the patch drop through the shared recipe diagnostic.
    expect(diagnostics.some(d => d.code === 'RECIPE_FEATURE_DROPPED' && /patch/.test(d.message))).toBe(true)
  })
})

describe('optimize', () => {
  it('drops a mutually-referencing (rootless) pair and keeps a real root', () => {
    // a@1 <-> b@1 reference each other but nothing roots them; a genuine root
    // `r@1` -> keep@1 survives. optimize() prunes the unreachable pair.
    const b = newBuilder()
    const mk = (n: string) => {
      const id = serializeNodeId(n, '1.0.0', [])
      b.addNode({ id, name: n, version: '1.0.0', peerContext: [] })
      b.setTarball({ name: n, version: '1.0.0' }, { resolution: { type: 'tarball', url: `https://registry.npmjs.org/${n}/-/${n}-1.0.0.tgz` } })
      return id
    }
    const a = mk('acycle'); const bb = mk('bcycle'); const r = mk('rootpkg'); const keep = mk('keeppkg')
    b.addEdge(a, bb, 'dep', { range: '^1.0.0' })
    b.addEdge(bb, a, 'dep', { range: '^1.0.0' })
    b.addEdge(r, keep, 'dep', { range: '^1.0.0' })
    const graph = b.seal()
    const { graph: opt } = optimize(graph)
    const remaining = Array.from(opt.nodes(), n => n.name).sort()
    expect(remaining).toEqual(['keeppkg', 'rootpkg'])
  })
})

describe('enrich', () => {
  it('without manifests, returns the graph unchanged with a NO_MANIFESTS warning', () => {
    const graph = parse(
      CLASSIC_HEADER +
      'lodash@4.17.21:\n' +
      '  version "4.17.21"\n' +
      '  resolved "https://registry.yarnpkg.com/lodash/-/lodash-4.17.21.tgz#cc"\n',
    )
    const { diagnostics } = enrich(graph, undefined, {})
    expect(diagnostics.map(d => d.code)).toContain('YARN_CLASSIC_NO_MANIFESTS')
  })

  it('synthesizes the root workspace node + its declared dep edge from manifests', () => {
    // A lock carrying only a published `lodash` entry; the root manifest declares
    // `lodash: ^4.17.0`. enrich() mints the root workspace node and wires the edge.
    const graph = parse(
      CLASSIC_HEADER +
      'lodash@4.17.21:\n' +
      '  version "4.17.21"\n' +
      '  resolved "https://registry.yarnpkg.com/lodash/-/lodash-4.17.21.tgz#cc"\n' +
      `  integrity ${sriOf('lodash')}\n`,
    )
    const { graph: enriched } = enrich(graph, undefined, {
      manifests: {
        '': { name: 'my-root', version: '1.0.0', dependencies: { lodash: '^4.17.0' } },
      },
    })
    const root = enriched.getNode('my-root@1.0.0')
    expect(root).toBeDefined()
    expect(root!.workspacePath).toBe('')
    // The root's declared dep resolved to the locked lodash node.
    const edge = enriched.out('my-root@1.0.0', 'dep').find(e => e.dst === 'lodash@4.17.21')
    expect(edge).toBeDefined()
    expect(edge!.attrs?.range).toBe('^4.17.0')
  })

  it('marks a member entry as a workspace node and wires a member-to-member dep', () => {
    // The lock records member @ws/a via a `file:` entry (directory resolution);
    // enrich promotes it to a workspace member and synthesizes the independent
    // member @ws/b that nothing in the lock depends on.
    const graph = parse(
      CLASSIC_HEADER +
      '"@ws/a@file:packages/a":\n' +
      '  version "1.0.0"\n' +
      '  resolved "file:packages/a"\n',
    )
    const { graph: enriched } = enrich(graph, undefined, {
      manifests: {
        '': { name: 'root', version: '1.0.0', dependencies: { '@ws/a': 'workspace:*', '@ws/b': 'workspace:*' } },
        'packages/a': { name: '@ws/a', version: '1.0.0' },
        'packages/b': { name: '@ws/b', version: '2.0.0' },
      },
    })
    // The lock-carried member is now a workspace node.
    const a = Array.from(enriched.nodes()).find(n => n.name === '@ws/a')
    expect(a?.workspacePath).toBe('packages/a')
    // The independent member @ws/b was synthesized with its manifest version.
    const bNode = enriched.getNode('@ws/b@2.0.0')
    expect(bNode?.workspacePath).toBe('packages/b')
  })
})
