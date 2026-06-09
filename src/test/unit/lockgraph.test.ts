// lockgraph adapter tests (#101) — the native graph-serialization format.
//
// The headline contract is GRAPH-IDENTITY: parse(serialize(g)) ≡ g, verified
// via Graph.diff being empty on every axis (in BOTH directions), tarballs()
// iterating byte-equal, and a re-serialize being byte-identical. Coverage:
//
//   §A  hand-built 3-node graph (peer-virt + integrity + edge attrs)
//   §B  real yarn-berry-v8 fixtures → graph-identity round-trip
//   §C  real pnpm-v9 fixtures → graph-identity round-trip
//   §D  HEADER/BODY/SEAL structural invariants (generatedAt outside seal;
//       byte-stable body; seal tamper detection; schema/envelope versioning)
//   §E  every model element round-trips (integrity multi-hash + origins,
//       berryChecksumCacheKey, peerContext, patch sentinel, EdgeAttrs incl.
//       optional/alias/range/workspaceRange, workspaces, layout-hints,
//       diagnostics)
//   §F  public-surface dispatcher + detect integration

import { describe, expect, it } from 'vitest'
import {
  newBuilder,
  serializeNodeId,
  toTarballKey,
  type Graph,
  type Node,
  type TarballPayload,
} from '../../main/ts/graph.ts'
import { LockfileError } from '../../main/ts/errors.ts'
import { parse, stringify, check } from '../../main/ts/formats/lockgraph.ts'
import { parse as parseYarnBerryV8 } from '../../main/ts/formats/yarn-berry-v8.ts'
import { parse as parsePnpmV9 } from '../../main/ts/formats/pnpm-v9.ts'
import { check as detectAndCheck, detect, parse as dispatchParse, stringify as dispatchStringify } from '../../main/ts/index.ts'
import { fixture, graphSnapshot, expectEmptyGraphDiff } from '../helpers/lockfile-test-utils.ts'
import { sri } from '../_integrity-fixtures.ts'

const PINNED = '2026-01-01T00:00:00Z'

// === Round-trip identity harness ============================================

/**
 * Assert the full graph-IDENTITY contract for `g`:
 *   1. serialize → parse → `g2`.
 *   2. `g.diff(g2)` empty on all axes AND `g2.diff(g)` empty (diff is
 *      directional; both directions guard added-vs-removed asymmetry).
 *   3. `graphSnapshot` deep-equal — this compares nodes (every field, via
 *      object spread), edges (+attrs), AND tarballs (every TarballPayload
 *      field), so it catches any payload/peerContext/resolution drift that a
 *      pure `diff` (which ignores integrity) would miss.
 *   4. re-serialize of `g2` is byte-identical to the first serialization
 *      (BODY canonical + seal stable + pinned generatedAt).
 * Returns the serialized text for size/structure assertions.
 */
function assertRoundTripIdentity(g: Graph): string {
  const text1 = stringify(g, { generatedAt: PINNED })
  const g2 = parse(text1)

  expectEmptyGraphDiff(g.diff(g2))
  expectEmptyGraphDiff(g2.diff(g))
  expect(graphSnapshot(g2)).toEqual(graphSnapshot(g))

  const text2 = stringify(g2, { generatedAt: PINNED })
  expect(text2).toBe(text1)

  return text1
}

// Extract the canonical BODY region (between the two `---` markers) from a
// lockgraph document — used to prove the body is generatedAt-independent.
function bodyOf(text: string): string {
  const lines = text.split(/\r?\n/)
  const first = lines.indexOf('---')
  const last = lines.lastIndexOf('---')
  return lines.slice(first + 1, last).join('\n')
}

function sealOf(text: string): string {
  const m = text.match(/seal sha256 ([0-9a-f]+)/)
  return m![1]!
}

// =====================================================================================
// §A — hand-built 3-node graph
// =====================================================================================

describe('lockgraph §A — hand-built 3-node graph', () => {
  // react-dom@18.0.0(react@18.0.0) → peer → react@18.0.0 ; react-dom → dep →
  // loose-envify@1.4.0. Exercises peer-virtualization (a peerContext NodeId),
  // a peer edge, a dep edge with a range, and per-node integrity.
  function build3(): Graph {
    const b = newBuilder()
    const reactId = serializeNodeId('react', '18.0.0', [])
    const looseId = serializeNodeId('loose-envify', '1.4.0', [])
    const reactDomId = serializeNodeId('react-dom', '18.0.0', [reactId])

    const react: Node = { id: reactId, name: 'react', version: '18.0.0', peerContext: [] }
    const loose: Node = { id: looseId, name: 'loose-envify', version: '1.4.0', peerContext: [] }
    const reactDom: Node = {
      id: reactDomId,
      name: 'react-dom',
      version: '18.0.0',
      peerContext: [reactId],
      resolution: 'react-dom@npm:18.0.0',
    }
    b.addNode(react)
    b.addNode(loose)
    b.addNode(reactDom)

    b.addEdge(reactDomId, reactId, 'peer', { range: '^18.0.0' })
    b.addEdge(reactDomId, looseId, 'dep', { range: '^1.1.0' })

    b.setTarball({ name: 'react', version: '18.0.0' }, {
      integrity: sri('sha512-' + 'a'.repeat(86) + '=='),
    })
    b.setTarball({ name: 'loose-envify', version: '1.4.0' }, {
      integrity: sri('sha512-' + 'b'.repeat(86) + '=='),
      bin: { 'loose-envify': 'cli.js' },
    })
    b.setTarball({ name: 'react-dom', version: '18.0.0' }, {
      integrity: sri('sha512-' + 'c'.repeat(86) + '=='),
    })
    return b.seal()
  }

  it('round-trips graph-identical', () => {
    const text = assertRoundTripIdentity(build3())
    expect(check(text)).toBe(true)
    expect(text.startsWith('@lockgraph 1\n')).toBe(true)
  })

  it('body is byte-identical regardless of generatedAt (seal stable)', () => {
    const g = build3()
    const a = stringify(g, { generatedAt: '2020-01-01T00:00:00Z' })
    const b = stringify(g, { generatedAt: '2099-12-31T23:59:59Z' })
    expect(a).not.toBe(b)               // headers differ
    expect(bodyOf(a)).toBe(bodyOf(b))   // bodies identical
    expect(sealOf(a)).toBe(sealOf(b))   // seal is over the body, not the header
  })
})

// =====================================================================================
// §B — real yarn-berry-v8 fixtures
// =====================================================================================

const BERRY_V8_FIXTURES = [
  'simple',
  'deps-with-scopes',
  'peers-basic',
  'peers-multi',
  'workspaces-basic',
  'workspace-cross-refs',
  'git-github-tarball',
  'yarn-crlf',
] as const

describe('lockgraph §B — real yarn-berry-v8 fixture round-trip', () => {
  for (const name of BERRY_V8_FIXTURES) {
    it(`${name} round-trips graph-identical`, () => {
      const g = parseYarnBerryV8(fixture(`${name}/yarn-berry-v8.lock`))
      assertRoundTripIdentity(g)
    })
  }
})

// =====================================================================================
// §C — real pnpm-v9 fixtures
// =====================================================================================

const PNPM_V9_FIXTURES = [
  'simple',
  'deps-with-scopes',
  'peers-basic',
  'peers-multi',
  'workspaces-basic',
  'workspace-cross-refs',
  'yarn-crlf',
] as const

describe('lockgraph §C — real pnpm-v9 fixture round-trip', () => {
  for (const name of PNPM_V9_FIXTURES) {
    it(`${name} round-trips graph-identical`, () => {
      const g = parsePnpmV9(fixture(`${name}/pnpm-v9.lock`))
      assertRoundTripIdentity(g)
    })
  }
})

// =====================================================================================
// §D — HEADER / BODY / SEAL structural invariants
// =====================================================================================

describe('lockgraph §D — header/body/seal', () => {
  const sample = (): Graph => parsePnpmV9(fixture('peers-multi/pnpm-v9.lock'))

  it('emits magic + schema + generatedAt + generator header', () => {
    const text = stringify(sample(), { generatedAt: PINNED })
    expect(text).toMatch(/^@lockgraph 1\n/)
    expect(text).toMatch(/\nschema 1\.0\n/)
    expect(text).toContain(`generatedAt ${PINNED}`)
    expect(text).toMatch(/\ngenerator @antongolub\/lockfile@/)
  })

  it('writes the optional source provenance line when supplied', () => {
    const text = stringify(sample(), { generatedAt: PINNED, source: { format: 'pnpm-v9', digest: 'abc123' } })
    expect(text).toContain('source pnpm-v9 abc123')
  })

  it('rejects a tampered body via the seal', () => {
    const text = stringify(sample(), { generatedAt: PINNED })
    // Flip one hex char of a long digest run anywhere in the BODY, leaving the
    // recorded seal untouched — the seal recompute must then reject the body.
    const lines = text.split('\n')
    const bodyLineIdx = lines.findIndex(l => /[0-9a-f]{32,}/.test(l))
    expect(bodyLineIdx).toBeGreaterThan(0)
    lines[bodyLineIdx] = lines[bodyLineIdx]!.replace(
      /([0-9a-f]{32,})/,
      run => (run[0] === 'a' ? 'b' : 'a') + run.slice(1),
    )
    const tampered = lines.join('\n')
    expect(() => parse(tampered)).toThrowError(LockfileError)
    expect(() => parse(tampered)).toThrowError(/seal mismatch/)
  })

  it('refuses a newer envelope major with CAPABILITY_LACK', () => {
    const text = stringify(sample(), { generatedAt: PINNED }).replace('@lockgraph 1', '@lockgraph 2')
    try {
      parse(text)
      expect.unreachable('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(LockfileError)
      expect((e as LockfileError).code).toBe('CAPABILITY_LACK')
    }
  })

  it('round-trips through CRLF line endings (seal computed over LF body)', () => {
    const g = sample()
    const crlf = stringify(g, { generatedAt: PINNED, lineEnding: 'crlf' })
    expect(crlf).toContain('\r\n')
    const g2 = parse(crlf)
    expectEmptyGraphDiff(g.diff(g2))
    expect(graphSnapshot(g2)).toEqual(graphSnapshot(g))
  })

  it('is not recognised as any PM format and vice versa', () => {
    const text = stringify(sample(), { generatedAt: PINNED })
    expect(check(text)).toBe(true)
    // a PM lockfile is not lockgraph
    expect(check(fixture('simple/yarn-berry-v8.lock'))).toBe(false)
    expect(check(fixture('simple/pnpm-v9.lock'))).toBe(false)
    expect(check(fixture('simple/npm-3.lock'))).toBe(false)
  })
})

// =====================================================================================
// §E — every model element round-trips
// =====================================================================================

describe('lockgraph §E — full fidelity of every model element', () => {
  it('preserves a multi-hash integrity multiset WITH origin tags + berry-zip + cacheKey', () => {
    const b = newBuilder()
    const id = serializeNodeId('lodash', '4.17.21', [])
    b.addNode({ id, name: 'lodash', version: '4.17.21', peerContext: [] })
    const payload: TarballPayload = {
      // space-joined SRI (sha1 + sha512), plus a berry-zip checksum digest, plus
      // a registry-origin sha512 — three origin classes, multiple algorithms.
      integrity: {
        hashes: [
          { algorithm: 'sha1', digest: '1'.repeat(40), origin: 'sri' },
          { algorithm: 'sha512', digest: '2'.repeat(128), origin: 'sri' },
          { algorithm: 'sha512', digest: '3'.repeat(128), origin: 'berry-zip' },
          { algorithm: 'sha512', digest: '4'.repeat(128), origin: 'registry' },
        ],
      },
      berryChecksumCacheKey: '10c0',
      license: 'MIT',
      engines: { node: '>=8' },
    }
    b.setTarball({ name: 'lodash', version: '4.17.21' }, payload)
    const g = b.seal()
    assertRoundTripIdentity(g)
    // explicit: the reconstructed payload equals the original verbatim
    const g2 = parse(stringify(g, { generatedAt: PINNED }))
    expect(g2.tarball({ name: 'lodash', version: '4.17.21' })).toEqual(payload)
  })

  it('preserves a +patch= sentinel slot + the canonical ResolutionCanonical union', () => {
    const b = newBuilder()
    const patch = 'unresolved-' + 'a'.repeat(64) // sentinel form
    const id = serializeNodeId('left-pad', '1.3.0', [], patch)
    b.addNode({ id, name: 'left-pad', version: '1.3.0', peerContext: [], patch })
    const payload: TarballPayload = {
      resolution: { type: 'git', url: 'https://github.com/foo/left-pad.git', sha: 'deadbeef', hostingProvider: 'github' },
    }
    b.setTarball({ name: 'left-pad', version: '1.3.0', patch }, payload)
    const g = b.seal()
    assertRoundTripIdentity(g)
    const g2 = parse(stringify(g, { generatedAt: PINNED }))
    expect(g2.tarball({ name: 'left-pad', version: '1.3.0', patch })).toEqual(payload)
  })

  it('preserves a node carrying BOTH +patch= AND +src= slots (two-slot peel)', () => {
    // The highest-risk codec path: a node that is yarn-patched AND resolved from
    // a non-registry source, so its TarballKey is
    // `name@version+patch=<128hex>+src=<16hex>` — both disambiguator slots on one
    // package row. Exercises (a) the canonical patch-then-src slot order on emit,
    // (b) the TWO-slot peel on parse (`parseTarballKey` strips the trailing `+src=`
    // first, then `+patch=`), and (c) that the package row carries the patch in the
    // `patch` column and the discriminator in the dedicated `src` column (so two
    // such siblings never collapse). No PM adapter emits a both-slots node today
    // (pnpm patches but does not discriminate; yarn-classic/npm discriminate but
    // drop patched siblings), so this is exclusively a hand-built regression guard.
    const b = newBuilder()
    const patch = 'a'.repeat(128)        // canonical 128-hex patch token
    const src = 'cd5b24a7a2d10325'        // a 16-hex source discriminator
    const id = serializeNodeId('is-git', '6.3.1', [], patch, src)
    // canonical slot order is patch-then-src ('patch' < 'src' under cmpStr)
    expect(id).toBe(`is-git@6.3.1+patch=${patch}+src=${src}`)
    expect(id.indexOf('+patch=')).toBeLessThan(id.indexOf('+src='))
    // assemble the node in the canonical adapter key-order (resolution, patch,
    // source) so `Graph.diff`'s JSON.stringify-based node equality is byte-exact.
    const node: Node = { id, name: 'is-git', version: '6.3.1', peerContext: [] }
    node.resolution = 'is-git@npm:6.3.1'
    node.patch = patch
    node.source = src
    b.addNode(node)
    const payload: TarballPayload = {
      integrity: { hashes: [{ algorithm: 'sha512', digest: 'd'.repeat(128), origin: 'sri' }] },
      resolution: { type: 'git', url: 'https://github.com/foo/is-git.git', sha: 'abc123' },
    }
    b.setTarball({ name: 'is-git', version: '6.3.1', patch, source: src }, payload)
    const g = b.seal()

    const text = assertRoundTripIdentity(g)
    // the package row carries patch in col 3 and src in col 4, both non-`-`
    const pRow = text.split('\n').find(l => l.startsWith('is-git:'))!
    const cols = pRow.split(':')
    expect(cols[2]).toBe(patch) // patch column
    expect(cols[3]).toBe(src)   // src column
    // the both-slots TarballKey re-keys the payload exactly on parse
    const g2 = parse(stringify(g, { generatedAt: PINNED }))
    expect(g2.tarball({ name: 'is-git', version: '6.3.1', patch, source: src })).toEqual(payload)
  })

  it('preserves a both-slots node WITH a peerContext (peer parens trail the +src= slot)', () => {
    // The peerContext suffix `(…)` must come AFTER both slots on the NodeId:
    // `name@version+patch=…+src=…(<peerId>)`. Guards that the slot peel + the
    // peer-suffix split compose for a both-slots peer-virtual node.
    const b = newBuilder()
    const peerId = serializeNodeId('react', '18.0.0', [])
    b.addNode({ id: peerId, name: 'react', version: '18.0.0', peerContext: [] })
    const patch = 'c'.repeat(128)
    const src = '141e9bbe3f1bc01c'
    const id = serializeNodeId('p', '2.0.0', [peerId], patch, src)
    expect(id).toBe(`p@2.0.0+patch=${patch}+src=${src}(${peerId})`)
    b.addNode({ id, name: 'p', version: '2.0.0', peerContext: [peerId], patch, source: src })
    b.addEdge(id, peerId, 'peer', { range: '^18.0.0' })
    b.setTarball({ name: 'p', version: '2.0.0', patch, source: src }, {
      resolution: { type: 'git', url: 'https://github.com/foo/p.git', sha: 'deadbeef' },
    })
    const g = b.seal()
    assertRoundTripIdentity(g)
  })

  it('preserves EdgeAttrs: optional + alias + range + workspaceRange', () => {
    const b = newBuilder()
    const root = serializeNodeId('root', '0.0.0', [])
    const dep = serializeNodeId('@scope/pkg', '2.0.0', [])
    const ws = serializeNodeId('@ws/member', '1.0.0', [])
    b.addNode({ id: root, name: 'root', version: '0.0.0', peerContext: [], workspacePath: '' })
    b.addNode({ id: dep, name: '@scope/pkg', version: '2.0.0', peerContext: [] })
    b.addNode({ id: ws, name: '@ws/member', version: '1.0.0', peerContext: [], workspacePath: 'packages/member' })
    // npm-alias dep with optional flag + a range containing the `:` delimiter.
    b.addEdge(root, dep, 'optional', { range: 'npm:^2.0.0', alias: 'pkg-alias', optional: true })
    // workspace edge carrying the canonical WorkspaceRange pair.
    b.addEdge(root, ws, 'dep', {
      range: 'workspace:^',
      workspace: true,
      workspaceRange: { specifier: 'workspace:^', resolvedVersion: '1.0.0' },
    })
    const g = b.seal()
    assertRoundTripIdentity(g)
    const g2 = parse(stringify(g, { generatedAt: PINNED }))
    const optEdge = g2.out(root, 'optional')[0]!
    expect(optEdge.attrs).toEqual({ range: 'npm:^2.0.0', alias: 'pkg-alias', optional: true })
    const wsEdge = g2.out(root, 'dep')[0]!
    expect(wsEdge.attrs).toEqual({
      range: 'workspace:^',
      workspace: true,
      workspaceRange: { specifier: 'workspace:^', resolvedVersion: '1.0.0' },
    })
  })

  it('preserves alias-distinct sibling edges (same src,dst,kind; different alias)', () => {
    const b = newBuilder()
    const root = serializeNodeId('root', '0.0.0', [])
    const traverse = serializeNodeId('@babel/traverse', '7.0.0', [])
    b.addNode({ id: root, name: 'root', version: '0.0.0', peerContext: [], workspacePath: '' })
    b.addNode({ id: traverse, name: '@babel/traverse', version: '7.0.0', peerContext: [] })
    // canonical descriptor (no alias) + an aliased descriptor to the same target.
    b.addEdge(root, traverse, 'dep')
    b.addEdge(root, traverse, 'dep', { range: 'npm:@babel/traverse@^7', alias: '@babel/traverse--for-x' })
    const g = b.seal()
    assertRoundTripIdentity(g)
    expect(g.out(root, 'dep').length).toBe(2)
  })

  it('preserves layout hints + diagnostics', () => {
    const b = newBuilder()
    const id = serializeNodeId('ms', '2.1.3', [])
    b.addNode({ id, name: 'ms', version: '2.1.3', peerContext: [] })
    b.setTarball({ name: 'ms', version: '2.1.3' }, { integrity: sri('sha512-' + 'd'.repeat(86) + '==') })
    b.layoutHints({ strategy: 'isolated' })
    b.diagnostic({ code: 'RECIPE_INTEGRITY_INCOMPLETE', subject: id, severity: 'warning', message: 'demo' })
    const g = b.seal()
    // diagnostics are NOT part of diff identity, but the format preserves them.
    const text = stringify(g, { generatedAt: PINNED })
    const g2 = parse(text)
    expectEmptyGraphDiff(g.diff(g2))
    expect(g2.layoutHints()).toEqual({ strategy: 'isolated' })
    expect(g2.diagnostics()).toEqual([
      { code: 'RECIPE_INTEGRITY_INCOMPLETE', subject: id, severity: 'warning', message: 'demo' },
    ])
    expect(stringify(g2, { generatedAt: PINNED })).toBe(text)
  })

  it('preserves a version that is a `:`-containing locator (git/file/url)', () => {
    // Regression: real pnpm/bun locks put a `github:`/`file:`/`https:` locator
    // in the VERSION position for non-registry resolutions. The version is not a
    // `:`-free simple token, so it must be ref-interned, not written inline.
    const b = newBuilder()
    const gh = '@angular/domino'
    const ver = 'https://codeload.github.com/angular/domino/tar.gz/a9e9e17af7a54af8dde66f651bfde671c3a10444'
    const file = 'file:nx-dev/ui-blog'
    const ghId = serializeNodeId(gh, ver, [])
    const fileId = serializeNodeId('@nx/ui-blog', file, [])
    b.addNode({ id: ghId, name: gh, version: ver, peerContext: [] })
    b.addNode({ id: fileId, name: '@nx/ui-blog', version: file, peerContext: [] })
    b.setTarball({ name: gh, version: ver }, {
      resolution: { type: 'git', url: 'https://github.com/angular/domino.git', sha: 'a9e9e17af7a54af8dde66f651bfde671c3a10444', hostingProvider: 'github' },
    })
    const g = b.seal()
    assertRoundTripIdentity(g)
  })

  it('preserves a version with semver build-metadata (`+build`) without false patch', () => {
    // Regression: `+` in a version must not be mistaken for the `+patch=` slot.
    const b = newBuilder()
    const ver = '1.0.0+build.5'
    const id = serializeNodeId('pkg', ver, [])
    b.addNode({ id, name: 'pkg', version: ver, peerContext: [] })
    b.setTarball({ name: 'pkg', version: ver }, { integrity: sri('sha512-' + 'e'.repeat(86) + '==') })
    const g = b.seal()
    assertRoundTripIdentity(g)
    expect(g.diff(parse(stringify(g, { generatedAt: PINNED }))).changedNodes).toEqual([])
  })

  it('is idempotent under re-serialization when the seal re-derives diagnostics', () => {
    // Regression: SEAL_* diagnostics are re-derived by the graph seal on every
    // reconstruction. They must not be persisted, or the diagnostic list grows
    // unboundedly across round-trips and the body stops being byte-stable. A
    // published self-link (a non-workspace node depending on a co-located
    // workspace via a registry range) triggers SEAL_PUBLISHED_SELF_LINK.
    const b = newBuilder()
    const ws = serializeNodeId('@app/web', '1.0.0', [])
    const dep = serializeNodeId('shared', '2.0.0', [])
    b.addNode({ id: ws, name: '@app/web', version: '1.0.0', peerContext: [], workspacePath: 'packages/web' })
    b.addNode({ id: dep, name: 'shared', version: '2.0.0', peerContext: [] })
    // a published (registry-range) dep that resolved onto the workspace.
    b.addEdge(dep, ws, 'dep', { range: '^1.0.0' })
    const g = b.seal()
    // sanity: the seal emitted the self-link diagnostic
    expect(g.diagnostics().some(d => d.code === 'SEAL_PUBLISHED_SELF_LINK')).toBe(true)

    const t1 = stringify(g, { generatedAt: PINNED })
    const g2 = parse(t1)
    const t2 = stringify(g2, { generatedAt: PINNED })
    expect(t2).toBe(t1) // byte-stable across the round-trip
    // diagnostic set is stable (no accumulation)
    expect(g2.diagnostics().map(d => d.code).sort()).toEqual(g.diagnostics().map(d => d.code).sort())
    // a THIRD pass stays stable too
    expect(stringify(parse(t2), { generatedAt: PINNED })).toBe(t1)
  })

  it('preserves a single non-sha512 integrity hash (e.g. sha1-only)', () => {
    const b = newBuilder()
    const id = serializeNodeId('legacy-pkg', '0.1.0', [])
    b.addNode({ id, name: 'legacy-pkg', version: '0.1.0', peerContext: [] })
    const payload: TarballPayload = {
      integrity: { hashes: [{ algorithm: 'sha1', digest: 'f'.repeat(40), origin: 'sri' }] },
    }
    b.setTarball({ name: 'legacy-pkg', version: '0.1.0' }, payload)
    const g = b.seal()
    assertRoundTripIdentity(g)
    expect(parse(stringify(g, { generatedAt: PINNED })).tarball({ name: 'legacy-pkg', version: '0.1.0' })).toEqual(payload)
  })

  it('escapes interned values containing newlines / backslashes / tabs', () => {
    const b = newBuilder()
    const id = serializeNodeId('weird', '1.0.0', [])
    // a resolution sidecar carrying control chars that would corrupt line framing
    // if written raw — must be backslash-escaped in the strings table.
    const weirdRes = 'custom:line1\nline2\twith\\backslash'
    b.addNode({ id, name: 'weird', version: '1.0.0', peerContext: [], resolution: weirdRes })
    const g = b.seal()
    assertRoundTripIdentity(g)
    expect(parse(stringify(g, { generatedAt: PINNED })).getNode(id)!.resolution).toBe(weirdRes)
  })

  it('handles a node whose TarballKey has no payload (workspace / pre-enrich)', () => {
    const b = newBuilder()
    const ws = serializeNodeId('myapp', '0.0.0', [])
    b.addNode({ id: ws, name: 'myapp', version: '0.0.0', peerContext: [], workspacePath: '' })
    const g = b.seal()
    assertRoundTripIdentity(g)
    const g2 = parse(stringify(g, { generatedAt: PINNED }))
    expect(g2.tarball({ name: 'myapp', version: '0.0.0' })).toBeUndefined()
  })
})

// =====================================================================================
// §F — public-surface dispatcher + detect
// =====================================================================================

describe('lockgraph §F — dispatcher integration', () => {
  it('detect() recognises a lockgraph document', () => {
    const g = parsePnpmV9(fixture('simple/pnpm-v9.lock'))
    const text = dispatchStringify('lockgraph', g)
    expect(detect(text)).toBe('lockgraph')
    expect(detectAndCheck('lockgraph', text)).toBe(true)
  })

  it('convert(pnpm → lockgraph → graph) preserves identity through the dispatcher', () => {
    const g = parsePnpmV9(fixture('peers-multi/pnpm-v9.lock'))
    const text = dispatchStringify('lockgraph', g, {})
    const g2 = dispatchParse('lockgraph', text)
    expectEmptyGraphDiff(g.diff(g2))
    expect(graphSnapshot(g2)).toEqual(graphSnapshot(g))
  })
})
