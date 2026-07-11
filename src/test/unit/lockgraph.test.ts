// lockgraph adapter tests (#101) — the native graph-serialization format.
//
// The headline contract is GRAPH-IDENTITY: parse(serialize(g)) ≡ g, verified
// via Graph.diff being empty on every axis (in BOTH directions), tarballs()
// iterating byte-equal, and a re-serialize being byte-identical (modulo META's
// volatile generatedAt/generator). Coverage:
//
//   §A  hand-built 3-node graph (peer-virt + integrity + edge attrs)
//   §B  real yarn-berry-v8 fixtures → graph-identity round-trip
//   §C  real pnpm-v9 fixtures → graph-identity round-trip
//   §D  META + region structural invariants (META outside the canonical body;
//       byte-stable body across generatedAt; no checksum/seal; CRLF; envelope
//       versioning; detection)
//   §E  every model element round-trips (integrity multi-hash + origins,
//       berryChecksumCacheKey, peerContext, patch sentinel, EdgeAttrs incl.
//       optional/alias/range/workspaceRange, workspaces, layout-hints,
//       diagnostics-not-persisted)
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
import {
  parse,
  stringify,
  check,
  escapeTsv,
  unescapeTsv,
  parsePeerContext,
  resolveNativeResolution,
  registrySourceOf,
  encodeIntegrityColumn,
  decodeIntegrityColumn,
  splitFirstUnescaped,
  parseSlots,
  flattenToSlots,
  isRecomposableTarballResolution,
} from '../../main/ts/formats/lockgraph.ts'
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
 *   4. re-serialize of `g2` is byte-identical to the first serialization (the
 *      three tables are canonical + pinned generatedAt makes META stable too).
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

// Extract the canonical body region (everything from the first region header
// `R <n>` onward) from a lockgraph document — used to prove the body is
// generatedAt-independent. META is the four lines before it.
function bodyOf(text: string): string {
  const lines = text.split(/\r?\n/)
  const first = lines.findIndex(l => /^R \d+$/.test(l))
  return lines.slice(first).join('\n')
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
      nativeResolution: 'react-dom@npm:18.0.0',
    })
    return b.seal()
  }

  it('round-trips graph-identical', () => {
    const text = assertRoundTripIdentity(build3())
    expect(check(text)).toBe(true)
    expect(text.startsWith('@lockgraph 1\n')).toBe(true)
  })

  it('body (the three tables) is byte-identical regardless of generatedAt', () => {
    const g = build3()
    const a = stringify(g, { generatedAt: '2020-01-01T00:00:00Z' })
    const b = stringify(g, { generatedAt: '2099-12-31T23:59:59Z' })
    expect(a).not.toBe(b)              // META differs (generatedAt)
    expect(bodyOf(a)).toBe(bodyOf(b))  // canonical body identical
  })

  it('carries no checksum / seal line', () => {
    const text = stringify(build3(), { generatedAt: PINNED })
    expect(text).not.toMatch(/\bseal\b/)
    expect(text).not.toMatch(/\bchecksum\b/)
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
// §D — META + region structural invariants
// =====================================================================================

describe('lockgraph §D — META / regions', () => {
  const sample = (): Graph => parsePnpmV9(fixture('peers-multi/pnpm-v9.lock'))

  it('emits magic + schema + generatedAt + generator META, then R/N/E regions', () => {
    const text = stringify(sample(), { generatedAt: PINNED })
    expect(text).toMatch(/^@lockgraph 1\n/)
    expect(text).toMatch(/\nschema 1\.0\n/)
    expect(text).toContain(`generatedAt ${PINNED}`)
    expect(text).toMatch(/\ngenerator lockgraph@/)
    // the three region headers, space-separated framing, in order
    expect(text).toMatch(/\nR \d+\n/)
    expect(text).toMatch(/\nN \d+\n/)
    expect(text).toMatch(/\nE \d+\n/)
    const ri = text.indexOf('\nR '), ni = text.indexOf('\nN '), ei = text.indexOf('\nE ')
    expect(ri).toBeLessThan(ni)
    expect(ni).toBeLessThan(ei)
  })

  it('ends with a trailing newline', () => {
    expect(stringify(sample(), { generatedAt: PINNED }).endsWith('\n')).toBe(true)
  })

  it('refuses a newer format generation with CAPABILITY_LACK', () => {
    const text = stringify(sample(), { generatedAt: PINNED }).replace('@lockgraph 1', '@lockgraph 2')
    try {
      parse(text)
      expect.unreachable('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(LockfileError)
      expect((e as LockfileError).code).toBe('CAPABILITY_LACK')
    }
  })

  it('round-trips through CRLF line endings (body is a function of the LF model)', () => {
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

  it('tolerates a leading UTF-8 BOM on detect and parse', () => {
    const text = stringify(sample(), { generatedAt: PINNED })
    const bom = '﻿' + text
    expect(check(bom)).toBe(true)
    const g2 = parse(bom)
    expectEmptyGraphDiff(sample().diff(g2))
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
      // sha1 + sha512 SRI, plus a berry-zip checksum digest, plus a
      // registry-origin sha512 — three origin classes, multiple algorithms.
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
    const text = assertRoundTripIdentity(g)
    // the integrity column carries the FULL `;`-joined multiset with origin
    // markers (s=sri, z=berry-zip, r=registry), in source order. The berry
    // checksum-cache-key (`10c0`) folds INTO the berry-zip z-member as
    // `z<cacheKey>/<algo>-<digest>` (ADR-0031) — NOT a separate F slot.
    const row = text.split('\n').find(l => l.startsWith('lodash\t'))!
    const integrityCol = row.split('\t')[3]!
    expect(integrityCol).toBe(
      `ssha1-${'1'.repeat(40)};ssha512-${'2'.repeat(128)};z10c0/sha512-${'3'.repeat(128)};rsha512-${'4'.repeat(128)}`,
    )
    // explicit: the reconstructed payload equals the original verbatim (the
    // cacheKey reattaches from the z-member into berryChecksumCacheKey).
    const g2 = parse(stringify(g, { generatedAt: PINNED }))
    expect(g2.tarball({ name: 'lodash', version: '4.17.21' })).toEqual(payload)
  })

  it('preserves a +patch= sentinel slot + the canonical ResolutionCanonical union', () => {
    const b = newBuilder()
    const patch = 'unresolved-' + 'a'.repeat(64) // sentinel form
    // git resolution → a well-formed node carries a `source` discriminator (set by
    // the adapter; ADR-0032). The format stores it VERBATIM in a `src=` slot.
    const src = 'a26ae4a95234d808'
    const id = serializeNodeId('left-pad', '1.3.0', [], patch, src)
    b.addNode({ id, name: 'left-pad', version: '1.3.0', peerContext: [], patch, source: src })
    const payload: TarballPayload = {
      resolution: { type: 'git', url: 'https://github.com/foo/left-pad.git', sha: 'deadbeef', hostingProvider: 'github' },
    }
    b.setTarball({ name: 'left-pad', version: '1.3.0', patch, source: src }, payload)
    const g = b.seal()
    const text = assertRoundTripIdentity(g)
    // the patch sentinel rides the `patch=` node slot, verbatim; the `+src=` is
    // stored verbatim in the `src=` slot (NOT re-derived), in patch-then-src order.
    const row = text.split('\n').find(l => l.startsWith('left-pad\t'))!
    expect(row).toContain(`\tpatch=${patch}`)
    expect(row).toContain(`\tsrc=${src}`)
    expect(row.indexOf('\tpatch=')).toBeLessThan(row.indexOf('\tsrc='))
    const g2 = parse(stringify(g, { generatedAt: PINNED }))
    expect(g2.tarball({ name: 'left-pad', version: '1.3.0', patch, source: src })).toEqual(payload)
  })

  it('preserves a node carrying BOTH +patch= AND +src= slots (both stored verbatim)', () => {
    // The highest-risk codec path: a node that is yarn-patched AND resolved from
    // a non-registry (git) source. Its TarballKey is
    // `name@version+patch=<128hex>+src=<16hex>` — both disambiguator slots on one
    // node. BOTH are stored explicitly as N-row slots (`patch=` and `src=`), in
    // patch-then-src order, and folded back into the re-derived NodeId on parse —
    // `src` is read verbatim from its slot, NOT re-derived from the resolution.
    // This exercises (a) the explicit `patch=` slot on the N row, (b) the explicit
    // `src=` slot, and (c) that the both-slots TarballKey re-keys the payload
    // exactly. No PM adapter emits a both-slots node today, so this is a hand-built
    // guard.
    const b = newBuilder()
    const patch = 'a'.repeat(128)        // canonical 128-hex patch token
    const src = 'cd5b24a7a2d10325'        // the 16-hex discriminator for the git source below
    const id = serializeNodeId('is-git', '6.3.1', [], patch, src)
    // canonical slot order is patch-then-src ('patch' < 'src' under cmpStr)
    expect(id).toBe(`is-git@6.3.1+patch=${patch}+src=${src}`)
    expect(id.indexOf('+patch=')).toBeLessThan(id.indexOf('+src='))
    // assemble the node in the canonical adapter key-order (patch, source) so
    // `Graph.diff`'s JSON.stringify-based node equality is byte-exact. The
    // PM-native resolution sidecar now rides the per-tarball payload.
    const node: Node = { id, name: 'is-git', version: '6.3.1', peerContext: [] }
    node.patch = patch
    node.source = src
    b.addNode(node)
    const payload: TarballPayload = {
      integrity: { hashes: [{ algorithm: 'sha512', digest: 'd'.repeat(128), origin: 'sri' }] },
      resolution: { type: 'git', url: 'https://github.com/foo/is-git.git', sha: 'abc123' },
      nativeResolution: 'is-git@npm:6.3.1',
    }
    b.setTarball({ name: 'is-git', version: '6.3.1', patch, source: src }, payload)
    const g = b.seal()

    const text = assertRoundTripIdentity(g)
    // the N row carries BOTH disambiguators as explicit slots — `patch=` then
    // `src=` (both stored verbatim, src NOT re-derived). The residual artifact
    // metadata now lives in the severable F section, keyed by the full TarballKey.
    const row = text.split('\n').find(l => l.startsWith('is-git\t'))!
    expect(row).toContain(`\tpatch=${patch}`)
    expect(row).toContain(`\tsrc=${src}`)
    expect(row.indexOf('\tpatch=')).toBeLessThan(row.indexOf('\tsrc='))
    // the F row is keyed by the representative NODE INDEX (the sole is-git node,
    // idx 0) and flattens the non-canonical git resolution union under
    // `resolution.*` dot-path slots. The full TarballKey (both discriminators) is
    // re-derived from that node's name/version/patch/src on parse.
    const fRow = text.split('\n').find(l => l.startsWith('0\t'))!
    expect(fRow).toBeDefined()
    expect(fRow).toContain('\tresolution.type=git')
    // the both-slots TarballKey re-keys the payload exactly on parse
    const g2 = parse(stringify(g, { generatedAt: PINNED }))
    expect(g2.tarball({ name: 'is-git', version: '6.3.1', patch, source: src })).toEqual(payload)
  })

  it('preserves a both-slots node WITH a peerContext (peer parens trail the +src= slot)', () => {
    // The peerContext suffix `(…)` must come AFTER both slots on the NodeId:
    // `name@version+patch=…+src=…(<peerId>)`. Guards that the slot recovery + the
    // peer-context parse compose for a both-slots peer-virtual node.
    const b = newBuilder()
    const peerId = serializeNodeId('react', '18.0.0', [])
    b.addNode({ id: peerId, name: 'react', version: '18.0.0', peerContext: [] })
    const patch = 'c'.repeat(128)
    const src = 'd2a64f79f21e9643' // stored verbatim in the `src=` slot (ADR-0032)
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
    const text = assertRoundTripIdentity(g)
    // New slot-based E-row: descriptor is positional field 4 (NO `-` alias
    // padding); trailing slots in fixed order = flag cluster, then alias=/rv=/sp=.
    // The optional edge: `opt` kind word + descriptor `npm:^2.0.0` + `o` flag +
    // `alias=pkg-alias` (NO trailing `-` padding).
    const optRow = text.split('\n').find(l => /\topt\tnpm:\^2\.0\.0\t/.test(l))!
    expect(optRow.split('\t')).toEqual(['0', expect.any(String), 'opt', 'npm:^2.0.0', 'o', 'alias=pkg-alias'])
    // The workspace edge: `w` flag + `rv=1.0.0`. NO `sp=` slot, because the
    // specifier (`workspace:^`) IS the descriptor — it is reconstructed from it,
    // never stored twice (the old `workspaceRange` JSON is gone).
    const wsRow = text.split('\n').find(l => /\tdep\tworkspace:\^\t/.test(l))!
    expect(wsRow.split('\t')).toEqual(['0', expect.any(String), 'dep', 'workspace:^', 'w', 'rv=1.0.0'])
    expect(wsRow).not.toContain('{') // no JSON, no specifier duplication
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

  it('preserves layout hints; diagnostics are NOT persisted (re-derived by seal)', () => {
    const b = newBuilder()
    const id = serializeNodeId('ms', '2.1.3', [])
    b.addNode({ id, name: 'ms', version: '2.1.3', peerContext: [] })
    b.setTarball({ name: 'ms', version: '2.1.3' }, { integrity: sri('sha512-' + 'd'.repeat(86) + '==') })
    b.layoutHints({ strategy: 'isolated' })
    b.diagnostic({ code: 'RECIPE_INTEGRITY_INCOMPLETE', subject: id, severity: 'warning', message: 'demo' })
    const g = b.seal()
    const text = stringify(g, { generatedAt: PINNED })
    // layout hints ride the optional trailing L line as canonical JSON.
    expect(text).toContain('\nL {"strategy":"isolated"}\n')
    // diagnostics are NOT serialized (no slot/column/line for them).
    expect(text).not.toContain('RECIPE_INTEGRITY_INCOMPLETE')
    const g2 = parse(text)
    expectEmptyGraphDiff(g.diff(g2))
    expect(g2.layoutHints()).toEqual({ strategy: 'isolated' })
    // the round-tripped graph re-derives its own (adapter/seal) diagnostics; the
    // hand-added RECIPE_* diagnostic is not part of identity and is not persisted.
    expect(g2.diagnostics().some(d => d.code === 'RECIPE_INTEGRITY_INCOMPLETE')).toBe(false)
    expect(stringify(g2, { generatedAt: PINNED })).toBe(text)
  })

  it('omits the L line entirely when the graph has no layout hints', () => {
    const b = newBuilder()
    const id = serializeNodeId('ms', '2.1.3', [])
    b.addNode({ id, name: 'ms', version: '2.1.3', peerContext: [] })
    const text = stringify(b.seal(), { generatedAt: PINNED })
    expect(text).not.toMatch(/\nL /)
  })

  it('preserves a version that is a `:`-containing locator (git/file/url)', () => {
    // Real pnpm/bun locks put a `github:`/`file:`/`https:` locator in the VERSION
    // position for non-registry resolutions. The version is an ordinary TSV value
    // (`:` is not a delimiter), so it round-trips verbatim.
    const b = newBuilder()
    const gh = '@angular/domino'
    const ver = 'https://codeload.github.com/angular/domino/tar.gz/a9e9e17af7a54af8dde66f651bfde671c3a10444'
    const file = 'file:nx-dev/ui-blog'
    // these nodes carry an explicit `source` (set as any well-behaved adapter
    // would, per ADR-0032); it is stored verbatim in the `src=` slot and read back
    // exactly on parse.
    const ghSrc = '2cb51226d1722190'
    const ghId = serializeNodeId(gh, ver, [], undefined, ghSrc)
    const fileId = serializeNodeId('@nx/ui-blog', file, [])
    b.addNode({ id: ghId, name: gh, version: ver, peerContext: [], source: ghSrc })
    b.addNode({ id: fileId, name: '@nx/ui-blog', version: file, peerContext: [] })
    b.setTarball({ name: gh, version: ver, source: ghSrc }, {
      resolution: { type: 'git', url: 'https://github.com/angular/domino.git', sha: 'a9e9e17af7a54af8dde66f651bfde671c3a10444', hostingProvider: 'github' },
    })
    const g = b.seal()
    // the `src=` slot is stored verbatim, so the round-trip reconstructs the
    // +src= node exactly (see assertion below).
    const g2 = parse(stringify(g, { generatedAt: PINNED }))
    expect(g2.getNode(ghId)).toBeDefined()
    assertRoundTripIdentity(g)
  })

  it('preserves a version with semver build-metadata (`+build`) without false patch', () => {
    // `+` in a version must not be mistaken for the `+patch=` slot.
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
    // SEAL_* diagnostics are re-derived by the graph seal on every reconstruction.
    // They are not persisted, so the body stays byte-stable across round-trips. A
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
    // diagnostic set is stable (the seal re-derives the same set; nothing accrued)
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
    const text = assertRoundTripIdentity(g)
    // the integrity column carries the algorithm verbatim (`sha1`), not an
    // implied sha512.
    const row = text.split('\n').find(l => l.startsWith('legacy-pkg\t'))!
    expect(row.split('\t')[3]).toBe(`ssha1-${'f'.repeat(40)}`)
    expect(parse(stringify(g, { generatedAt: PINNED })).tarball({ name: 'legacy-pkg', version: '0.1.0' })).toEqual(payload)
  })

  it('escapes values containing newlines / backslashes / tabs', () => {
    const b = newBuilder()
    const id = serializeNodeId('weird', '1.0.0', [])
    // a nativeResolution sidecar carrying control chars that would corrupt the
    // TSV row framing if written raw — must be escaped in the F `nativeResolution=`
    // slot.
    const weirdRes = 'custom:line1\nline2\twith\\backslash'
    b.addNode({ id, name: 'weird', version: '1.0.0', peerContext: [] })
    b.setTarball({ name: 'weird', version: '1.0.0' }, { nativeResolution: weirdRes })
    const g = b.seal()
    const text = assertRoundTripIdentity(g)
    // the raw bytes contain the escaped forms, not literal control chars.
    expect(text).toContain('nativeResolution=custom:line1\\nline2\\twith\\\\backslash')
    expect(parse(stringify(g, { generatedAt: PINNED })).tarball({ name: 'weird', version: '1.0.0' })!.nativeResolution).toBe(weirdRes)
  })

  it('handles a node whose TarballKey has no payload (workspace / pre-enrich)', () => {
    const b = newBuilder()
    const ws = serializeNodeId('myapp', '0.0.0', [])
    b.addNode({ id: ws, name: 'myapp', version: '0.0.0', peerContext: [], workspacePath: '' })
    const g = b.seal()
    const text = assertRoundTripIdentity(g)
    // the root workspace is pinned at node 0, carrying `ws=` with an empty path.
    const firstNodeRow = text.split('\n')[text.split('\n').findIndex(l => /^N \d+$/.test(l)) + 1]!
    expect(firstNodeRow.split('\t')).toEqual(['myapp', '0.0.0', 'r0', '-', 'ws='])
    const g2 = parse(stringify(g, { generatedAt: PINNED }))
    expect(g2.tarball({ name: 'myapp', version: '0.0.0' })).toBeUndefined()
  })
})

// =====================================================================================
// §G — res=/payload recomposition + the confirmed-bug regressions
// =====================================================================================

describe('lockgraph §G — recomposition (res=/payload) + bug regressions', () => {
  // Find a node row by package name in a serialized doc.
  const rowOf = (text: string, name: string): string =>
    text.split('\n').find(l => l.startsWith(name + '\t'))!

  // --- PART A: recomposition (store facts, derive mechanics) ----------------

  it('yarn-classic-shape <url>#<sha1> resolution → usha1 in integrity, nativeResolution F slot omitted, byte-exact round-trip', () => {
    // The exact shape a yarn-classic node carries: payload.nativeResolution is the
    // canonical npm tarball URL + a `#<sha1>` fragment, and payload.resolution is
    // the canonical {type:'tarball', url} (no fragment). Both collapse: the URL
    // recomposes from the npm R base, the fragment rides the N-row integrity
    // u-member, and the canonical payload.resolution is omitted.
    const b = newBuilder()
    const url = 'https://registry.yarnpkg.com/JSV/-/JSV-4.0.2.tgz'
    const sha1 = 'd077f6825571f82132f9dffaed587b4029feff57'
    const id = serializeNodeId('JSV', '4.0.2', [])
    b.addNode({ id, name: 'JSV', version: '4.0.2', peerContext: [] })
    b.setTarball({ name: 'JSV', version: '4.0.2' }, { resolution: { type: 'tarball', url }, nativeResolution: `${url}#${sha1}` })
    const g = b.seal()
    const text = assertRoundTripIdentity(g)
    const row = rowOf(text, 'JSV')
    // the #<sha1> rides the integrity column's trailing u-member.
    expect(row.split('\t')[3]).toBe(`usha1-${sha1}`)
    // both the canonical bare {type:'tarball'} payload resolution AND the
    // nativeResolution (it rides the u-member) are omitted from F, so this
    // tarball's residual is empty → the F section has zero rows (`F 0`).
    expect(text).toContain('\nF 0\n')
    // and it all reconstructs identity-exact (native sidecar + payload).
    const g2 = parse(stringify(g, { generatedAt: PINNED }))
    expect(g2.tarball({ name: 'JSV', version: '4.0.2' })!.nativeResolution).toBe(`${url}#${sha1}`)
    expect(g2.tarball({ name: 'JSV', version: '4.0.2' })!.resolution).toEqual({ type: 'tarball', url })
    // the u-member is TRANSPORT-ONLY: it is NOT added to the integrity multiset.
    expect(g2.tarball({ name: 'JSV', version: '4.0.2' })!.integrity).toBeUndefined()
  })

  it('canonical berry npm locator nativeResolution stored VERBATIM by lockgraph (recompose moved to the berry adapter)', () => {
    const b = newBuilder()
    const id = serializeNodeId('react', '18.0.0', [])
    // payload.nativeResolution byte-equals the canonical berry locator
    // `react@npm:18.0.0`. The lockgraph layer NO LONGER special-cases this
    // (the old valueless `nativeResolution.berry=` marker is gone): a native
    // present on the model is stored VERBATIM. The OMISSION of a canonical
    // berry native is the berry ADAPTER's job (it never puts one on the model),
    // verified in the yarn-berry suites — so a native that DOES reach lockgraph
    // round-trips byte-faithfully as a verbatim F slot.
    b.addNode({ id, name: 'react', version: '18.0.0', peerContext: [] })
    b.setTarball({ name: 'react', version: '18.0.0' }, {
      integrity: sri('sha512-' + 'a'.repeat(86) + '=='),
      nativeResolution: 'react@npm:18.0.0',
    })
    const g = b.seal()
    const text = assertRoundTripIdentity(g)
    // the F row (keyed by the representative NODE INDEX — the sole node, idx 0)
    // carries the VERBATIM `nativeResolution=react@npm:18.0.0`, and there is NO
    // berry marker slot anywhere.
    const fRow = text.split('\n').find(l => l.startsWith('0\t'))!
    expect(fRow).toContain('\tnativeResolution=react@npm:18.0.0')
    expect(fRow).not.toContain('nativeResolution.berry')
    // the N row carries no res token.
    const row = rowOf(text, 'react')
    expect(row.split('\t')).not.toContain('res')
    expect(parse(stringify(g, { generatedAt: PINNED })).tarball({ name: 'react', version: '18.0.0' })!.nativeResolution).toBe('react@npm:18.0.0')
  })

  it('non-canonical resolution (git/codeload) → nativeResolution= kept VERBATIM (exact-match-or-verbatim)', () => {
    const b = newBuilder()
    const id = serializeNodeId('left-pad', '1.3.0', [])
    // a git+ssh locator with a #<sha> — NOT a canonical npm tarball URL, so it is
    // kept verbatim in the F `nativeResolution=` slot and the fragment is NOT
    // moved to the integrity column.
    const res = 'git+ssh://git@github.com/foo/left-pad.git#deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'
    b.addNode({ id, name: 'left-pad', version: '1.3.0', peerContext: [] })
    b.setTarball({ name: 'left-pad', version: '1.3.0' }, {
      resolution: { type: 'git', url: 'https://github.com/foo/left-pad.git', sha: 'deadbeef' },
      nativeResolution: res,
    })
    const g = b.seal()
    const text = assertRoundTripIdentity(g)
    const row = rowOf(text, 'left-pad')
    expect(row).not.toContain('usha1-')          // fragment NOT hijacked into integrity
    // F row keyed by the representative NODE INDEX (the sole node, idx 0).
    const fRow = text.split('\n').find(l => l.startsWith('0\t'))!
    expect(fRow).toContain(`\tnativeResolution=${res}`)
    expect(parse(stringify(g, { generatedAt: PINNED })).tarball({ name: 'left-pad', version: '1.3.0' })!.nativeResolution).toBe(res)
  })

  it('a node with NO nativeResolution stays undefined on parse (never invented)', () => {
    // The phantom-resolution failure class: the parse must NOT mint a native
    // resolution on a tarball that never had one, even though its
    // payload.resolution recomposes.
    const b = newBuilder()
    const url = 'https://registry.npmjs.org/ms/-/ms-2.1.3.tgz'
    const id = serializeNodeId('ms', '2.1.3', [])
    // NO `nativeResolution` — only a canonical payload.resolution.
    b.addNode({ id, name: 'ms', version: '2.1.3', peerContext: [] })
    b.setTarball({ name: 'ms', version: '2.1.3' }, {
      integrity: sri('sha512-' + 'b'.repeat(86) + '=='),
      resolution: { type: 'tarball', url },
    })
    const g = b.seal()
    const text = assertRoundTripIdentity(g)
    const row = rowOf(text, 'ms')
    expect(row).not.toContain('res')   // no res= AND no bare res marker on N row
    const g2 = parse(stringify(g, { generatedAt: PINNED }))
    expect(g2.tarball({ name: 'ms', version: '2.1.3' })!.nativeResolution).toBeUndefined() // stayed undefined
    // payload.resolution WAS recomposed (it existed on the payload)
    expect(g2.tarball({ name: 'ms', version: '2.1.3' })!.resolution).toEqual({ type: 'tarball', url })
  })

  it('payload.resolution kept verbatim when NON-canonical (extra hostingProvider key)', () => {
    const b = newBuilder()
    const url = 'https://registry.npmjs.org/x/-/x-1.0.0.tgz'
    const id = serializeNodeId('x', '1.0.0', [])
    b.addNode({ id, name: 'x', version: '1.0.0', peerContext: [] })
    // a `tarball` union carrying an EXTRA key (hostingProvider) is NOT the bare
    // two-key {type,url} canonical shape, so the WHOLE union flattens under the
    // F row's `resolution.*` dot-path slots (no partial split, no recomposition).
    const resolution = { type: 'tarball' as const, url, hostingProvider: 'github' as const }
    b.setTarball({ name: 'x', version: '1.0.0' }, { resolution })
    const g = b.seal()
    const text = assertRoundTripIdentity(g)
    // the F row (keyed by the representative NODE INDEX — the sole node, idx 0)
    // flattens the union.
    const fRow = text.split('\n').find(l => l.startsWith('0\t'))!
    expect(fRow).toBeDefined()
    expect(fRow).toContain('\tresolution.type=tarball')
    expect(fRow).toContain('\tresolution.hostingProvider=github')
    expect(parse(stringify(g, { generatedAt: PINNED })).tarball({ name: 'x', version: '1.0.0' })!.resolution).toEqual(resolution)
  })

  it('berryChecksumCacheKey folds INTO the berry-zip integrity z-member (z<cacheKey>/…) and round-trips', () => {
    const b = newBuilder()
    const id = serializeNodeId('y', '2.0.0', [])
    b.addNode({ id, name: 'y', version: '2.0.0', peerContext: [] })
    // The realistic combination: a berry zip-cache checksum (berry-zip origin)
    // ALWAYS accompanies its `<cacheKey>/` prefix — they are one value. The
    // cacheKey now folds into that hash's z-member as `z<cacheKey>/<algo>-<digest>`
    // (ADR-0031); there is NO separate `ck=` F slot anymore. (A cacheKey present
    // with NO berry-zip member is a model anomaly that does not occur in the
    // corpus — `parseBerryChecksum` only sets the cacheKey alongside a berry-zip
    // digest — and the removed `ck=` slot no longer carries it.)
    const digest = 'c'.repeat(128)
    b.setTarball({ name: 'y', version: '2.0.0' }, {
      integrity: { hashes: [{ algorithm: 'sha512', digest, origin: 'berry-zip' }] },
      berryChecksumCacheKey: '10c0',
    })
    const g = b.seal()
    const text = assertRoundTripIdentity(g)
    // the cacheKey rides the N-row integrity column's z-member, NOT a slot.
    const row = rowOf(text, 'y')
    expect(row.split('\t')[3]).toBe(`z10c0/sha512-${digest}`)
    expect(row).not.toContain('ck=')
    // no F row at all: the only facts (berry-zip integrity + cacheKey) both
    // ride the N row, so the residual is empty → the F section has zero rows.
    expect(text).toContain('\nF 0\n')
    const g2 = parse(stringify(g, { generatedAt: PINNED }))
    expect(g2.tarball({ name: 'y', version: '2.0.0' })!.berryChecksumCacheKey).toBe('10c0')
    expect(g2.tarball({ name: 'y', version: '2.0.0' })!.integrity).toEqual({ hashes: [{ algorithm: 'sha512', digest, origin: 'berry-zip' }] })
  })

  // --- PART B: the 8 confirmed bugs -----------------------------------------

  it('B1: an R registry url containing a backslash / tab round-trips (R values are TSV-escaped)', () => {
    // A url carrying control bytes must not split the R row. The R table is now
    // normative, so the url must survive verbatim through escape→unescape. We use
    // a tarball-type source (kept verbatim) so the literal url is the R url.
    const b = newBuilder()
    const weirdUrl = 'https://example.com/weird\tpath\\seg/pkg.tgz'
    const id = serializeNodeId('weirdpkg', '1.0.0', [])
    b.addNode({ id, name: 'weirdpkg', version: '1.0.0', peerContext: [] })
    b.setTarball({ name: 'weirdpkg', version: '1.0.0' }, { resolution: { type: 'tarball', url: weirdUrl } })
    const g = b.seal()
    const text = assertRoundTripIdentity(g)
    // the raw R row carries the ESCAPED forms, not literal control bytes.
    const rRow = text.split('\n').find(l => l.startsWith('tarball\t'))!
    expect(rRow).toContain('weird\\tpath\\\\seg')
    expect(rRow.split('\t').length).toBe(2) // type + url — the tab inside the url did NOT split it
    expect(parse(stringify(g, { generatedAt: PINNED })).tarball({ name: 'weirdpkg', version: '1.0.0' })!.resolution).toEqual({ type: 'tarball', url: weirdUrl })
  })

  it('B2: a literal `-` range AND a literal `-` alias round-trip (distinct from absent)', () => {
    // '-' is a legal npm package name → alias '-' and range '-' are representable.
    // They must NOT collapse to the absent sentinel.
    const b = newBuilder()
    const root = serializeNodeId('root', '0.0.0', [])
    const dash = serializeNodeId('-', '1.0.0', [])
    const dep = serializeNodeId('dep', '1.0.0', [])
    b.addNode({ id: root, name: 'root', version: '0.0.0', peerContext: [], workspacePath: '' })
    b.addNode({ id: dash, name: '-', version: '1.0.0', peerContext: [] })
    b.addNode({ id: dep, name: 'dep', version: '1.0.0', peerContext: [] })
    // edge with a literal '-' range
    b.addEdge(root, dep, 'dep', { range: '-' })
    // edge with a literal '-' alias (npm:-@1.0.0 style)
    b.addEdge(root, dash, 'dep', { range: 'npm:-@1.0.0', alias: '-' })
    const g = b.seal()
    const text = assertRoundTripIdentity(g)
    // the literal '-' value is escaped to `\-` so it never aliases the sentinel.
    expect(text).toContain('\\-')
    const g2 = parse(stringify(g, { generatedAt: PINNED }))
    const rng = g2.out(root, 'dep').find(e => e.dst === dep)!
    expect(rng.attrs!.range).toBe('-')
    const ali = g2.out(root, 'dep').find(e => e.dst === dash)!
    expect(ali.attrs!.alias).toBe('-')
  })

  it('B2: alias-distinct sibling edges where one alias is the literal `-` (edge identity)', () => {
    // Two src→dst edges of the same kind, distinguished ONLY by alias, where one
    // alias is the colliding literal '-'. If '-' collapsed to absent, this would
    // either lose an edge or throw 'duplicate edge'.
    const b = newBuilder()
    const root = serializeNodeId('root', '0.0.0', [])
    const tgt = serializeNodeId('pkg', '1.0.0', [])
    b.addNode({ id: root, name: 'root', version: '0.0.0', peerContext: [], workspacePath: '' })
    b.addNode({ id: tgt, name: 'pkg', version: '1.0.0', peerContext: [] })
    b.addEdge(root, tgt, 'dep')                                  // canonical descriptor (no alias)
    b.addEdge(root, tgt, 'dep', { range: 'npm:pkg@1', alias: '-' }) // alias = literal '-'
    const g = b.seal()
    assertRoundTripIdentity(g)
    expect(g.out(root, 'dep').length).toBe(2)
    const g2 = parse(stringify(g, { generatedAt: PINNED }))
    expect(g2.out(root, 'dep').length).toBe(2)
    expect(g2.out(root, 'dep').some(e => e.attrs?.alias === '-')).toBe(true)
    expect(g2.out(root, 'dep').some(e => e.attrs?.alias === undefined)).toBe(true)
  })

  it('B2: an empty-string range/alias stays empty (distinct from absent and from `-`)', () => {
    const b = newBuilder()
    const root = serializeNodeId('root', '0.0.0', [])
    const tgt = serializeNodeId('pkg', '1.0.0', [])
    b.addNode({ id: root, name: 'root', version: '0.0.0', peerContext: [], workspacePath: '' })
    b.addNode({ id: tgt, name: 'pkg', version: '1.0.0', peerContext: [] })
    b.addEdge(root, tgt, 'dep', { range: '', alias: '' })
    const g = b.seal()
    assertRoundTripIdentity(g)
    const e = parse(stringify(g, { generatedAt: PINNED })).out(root, 'dep')[0]!
    expect(e.attrs!.range).toBe('')
    expect(e.attrs!.alias).toBe('')
  })

  // --- E-row slot redesign regressions (#101) -------------------------------
  // The E row dropped positional `-` alias padding and the workspaceRange JSON.
  // descriptor = field 4 (EdgeAttrs.range); trailing slots = a flag cluster
  // (o/w/ow), then alias=/rv=/sp=; workspaceRange.specifier IS the descriptor.

  it('E-slot: a workspace edge with resolvedVersion round-trips via rv= (workspaceRange reconstructed, NO JSON)', () => {
    const b = newBuilder()
    const root = serializeNodeId('root', '0.0.0', [])
    const ws = serializeNodeId('@ws/m', '1.2.2', [])
    b.addNode({ id: root, name: 'root', version: '0.0.0', peerContext: [], workspacePath: '' })
    b.addNode({ id: ws, name: '@ws/m', version: '1.2.2', peerContext: [], workspacePath: 'packages/m' })
    b.addEdge(root, ws, 'dev', {
      range: 'workspace:*',
      workspace: true,
      workspaceRange: { specifier: 'workspace:*', resolvedVersion: '1.2.2' },
    })
    const g = b.seal()
    const text = assertRoundTripIdentity(g)
    const row = text.split('\n').find(l => /\tdev\tworkspace:\*\t/.test(l))!
    // descriptor `workspace:*` + `w` flag + `rv=1.2.2`; specifier NOT stored (it
    // is the descriptor). No JSON, no `sp=`, no trailing `-`.
    expect(row.split('\t')).toEqual(['0', expect.any(String), 'dev', 'workspace:*', 'w', 'rv=1.2.2'])
    const e = parse(text).out(root, 'dev')[0]!
    expect(e.attrs!.workspaceRange).toEqual({ specifier: 'workspace:*', resolvedVersion: '1.2.2' })
  })

  it('E-slot: a w-edge with NO resolvedVersion reconstructs { specifier } from the descriptor', () => {
    const b = newBuilder()
    const root = serializeNodeId('root', '0.0.0', [])
    const ws = serializeNodeId('@ws/m', '1.0.0', [])
    b.addNode({ id: root, name: 'root', version: '0.0.0', peerContext: [], workspacePath: '' })
    b.addNode({ id: ws, name: '@ws/m', version: '1.0.0', peerContext: [], workspacePath: 'packages/m' })
    b.addEdge(root, ws, 'dep', {
      range: 'workspace:^',
      workspace: true,
      workspaceRange: { specifier: 'workspace:^' },
    })
    const g = b.seal()
    const text = assertRoundTripIdentity(g)
    const row = text.split('\n').find(l => /\tdep\tworkspace:\^\t/.test(l))!
    // bare `w` flag only — specifier comes from the descriptor, no rv=/sp=.
    expect(row.split('\t')).toEqual(['0', expect.any(String), 'dep', 'workspace:^', 'w'])
    const e = parse(text).out(root, 'dep')[0]!
    expect(e.attrs!.workspaceRange).toEqual({ specifier: 'workspace:^' })
  })

  it('E-slot: a w-edge whose adapter canonicalised specifier ≠ descriptor stores sp= (the bun-text fallback)', () => {
    // bun-text keeps a verbatim descriptor `workspace:` but a canonical specifier
    // `workspace:*`. They differ, so the specifier rides the `sp=` fallback slot.
    const b = newBuilder()
    const root = serializeNodeId('root', '0.0.0', [])
    const ws = serializeNodeId('@ws/m', '0.0.0', [])
    b.addNode({ id: root, name: 'root', version: '0.0.0', peerContext: [], workspacePath: '' })
    b.addNode({ id: ws, name: '@ws/m', version: '0.0.0', peerContext: [], workspacePath: 'packages/m' })
    b.addEdge(root, ws, 'dep', {
      range: 'workspace:',
      workspace: true,
      workspaceRange: { specifier: 'workspace:*', resolvedVersion: '0.0.0' },
    })
    const g = b.seal()
    const text = assertRoundTripIdentity(g)
    const row = text.split('\n').find(l => /\tdep\tworkspace:\t/.test(l))!
    // descriptor `workspace:` + `w` + `rv=0.0.0` + `sp=workspace:*` (the rare
    // fallback — specifier differs from the descriptor).
    expect(row.split('\t')).toEqual(['0', expect.any(String), 'dep', 'workspace:', 'w', 'rv=0.0.0', 'sp=workspace:*'])
    const e = parse(text).out(root, 'dep')[0]!
    expect(e.attrs!.range).toBe('workspace:')
    expect(e.attrs!.workspaceRange).toEqual({ specifier: 'workspace:*', resolvedVersion: '0.0.0' })
  })

  it('E-slot: an optional edge emits just the `o` flag (no JSON, no padding)', () => {
    const b = newBuilder()
    const root = serializeNodeId('root', '0.0.0', [])
    const dep = serializeNodeId('pkg', '1.0.0', [])
    b.addNode({ id: root, name: 'root', version: '0.0.0', peerContext: [], workspacePath: '' })
    b.addNode({ id: dep, name: 'pkg', version: '1.0.0', peerContext: [] })
    b.addEdge(root, dep, 'dep', { range: '^1.0.0', optional: true })
    const g = b.seal()
    const text = assertRoundTripIdentity(g)
    const row = text.split('\n').find(l => /\tdep\t\^1\.0\.0/.test(l))!
    expect(row.split('\t')).toEqual(['0', expect.any(String), 'dep', '^1.0.0', 'o'])
  })

  it('E-slot: an optional+workspace edge packs the flag cluster as `ow`', () => {
    const b = newBuilder()
    const root = serializeNodeId('root', '0.0.0', [])
    const ws = serializeNodeId('@ws/m', '2.0.0', [])
    b.addNode({ id: root, name: 'root', version: '0.0.0', peerContext: [], workspacePath: '' })
    b.addNode({ id: ws, name: '@ws/m', version: '2.0.0', peerContext: [], workspacePath: 'packages/m' })
    b.addEdge(root, ws, 'dep', {
      range: 'workspace:*',
      optional: true,
      workspace: true,
      workspaceRange: { specifier: 'workspace:*', resolvedVersion: '2.0.0' },
    })
    const g = b.seal()
    const text = assertRoundTripIdentity(g)
    const row = text.split('\n').find(l => /\tdep\tworkspace:\*\t/.test(l))!
    expect(row.split('\t')).toEqual(['0', expect.any(String), 'dep', 'workspace:*', 'ow', 'rv=2.0.0'])
    const e = parse(text).out(root, 'dep')[0]!
    expect(e.attrs!.optional).toBe(true)
    expect(e.attrs!.workspace).toBe(true)
  })

  it('E-slot: an npm-alias edge stores alias= (no positional padding)', () => {
    const b = newBuilder()
    const root = serializeNodeId('root', '0.0.0', [])
    const dep = serializeNodeId('pm', '6.0.0', [])
    b.addNode({ id: root, name: 'root', version: '0.0.0', peerContext: [], workspacePath: '' })
    b.addNode({ id: dep, name: 'pm', version: '6.0.0', peerContext: [] })
    b.addEdge(root, dep, 'dep', { range: 'npm:pm@^1', alias: 'pm-npm-6' })
    const g = b.seal()
    const text = assertRoundTripIdentity(g)
    const row = text.split('\n').find(l => /\tdep\tnpm:pm@\^1/.test(l))!
    expect(row.split('\t')).toEqual(['0', expect.any(String), 'dep', 'npm:pm@^1', 'alias=pm-npm-6'])
  })

  it('E-slot: a no-range edge emits the descriptor as `-` and stops (no slots)', () => {
    const b = newBuilder()
    const root = serializeNodeId('root', '0.0.0', [])
    const dep = serializeNodeId('pkg', '1.0.0', [])
    b.addNode({ id: root, name: 'root', version: '0.0.0', peerContext: [], workspacePath: '' })
    b.addNode({ id: dep, name: 'pkg', version: '1.0.0', peerContext: [] })
    b.addEdge(root, dep, 'dep') // no attrs → no declared range
    const g = b.seal()
    const text = assertRoundTripIdentity(g)
    const row = text.split('\n').find(l => /\tdep\t/.test(l) && l.startsWith('0\t'))!
    expect(row.split('\t')).toEqual(['0', expect.any(String), 'dep', '-'])
    const e = parse(text).out(root, 'dep')[0]!
    expect(e.attrs?.range).toBeUndefined()
  })

  it('E-slot: a descriptor that literally contains `=` (URL query) stays positional field 4 (unambiguous)', () => {
    // The descriptor is positional field 4, BEFORE any slot, so an `=` inside it
    // is never mistaken for a key=value slot. A git URL with a query is the case.
    const b = newBuilder()
    const root = serializeNodeId('root', '0.0.0', [])
    const dep = serializeNodeId('pkg', '1.0.0', [])
    b.addNode({ id: root, name: 'root', version: '0.0.0', peerContext: [], workspacePath: '' })
    b.addNode({ id: dep, name: 'pkg', version: '1.0.0', peerContext: [] })
    const weird = 'git+https://host/r.git?ref=main&token=x#deadbeef'
    b.addEdge(root, dep, 'dep', { range: weird })
    const g = b.seal()
    const text = assertRoundTripIdentity(g)
    const row = text.split('\n').find(l => l.includes(weird))!
    expect(row.split('\t')).toEqual(['0', expect.any(String), 'dep', weird])
    const e = parse(text).out(root, 'dep')[0]!
    expect(e.attrs!.range).toBe(weird)
  })

  it('E-slot: NO edge emits trailing `-` padding anywhere in a real-world render', () => {
    // The old format padded a bare `-` alias column onto ~99% of edges. The new
    // format omits absent slots, so no E row ends with a `\t-` that is mere
    // padding. (A descriptor of `-` is field 4 and legitimate; assert no SLOT is
    // a bare `-`.)
    const g = parsePnpmV9(fixture('peers-multi/pnpm-v9.lock'))
    const text = stringify(g, { generatedAt: PINNED })
    const lines = text.split('\n')
    const eHeaderIdx = lines.findIndex(l => /^E \d+$/.test(l))
    const eCount = Number(lines[eHeaderIdx]!.slice(2))
    for (let i = eHeaderIdx + 1; i <= eHeaderIdx + eCount; i++) {
      const fields = lines[i]!.split('\t')
      // fields[4..] are the trailing SLOTS; none may be a bare `-` (padding).
      for (let f = 4; f < fields.length; f++) {
        expect(fields[f], `E row ${i}: a slot is bare '-' (padding): ${lines[i]}`).not.toBe('-')
      }
    }
  })

  it('B6: a kind word that names an Object.prototype member throws PARSE_FAILED', () => {
    const base = stringify(buildMinimal(), { generatedAt: PINNED })
    for (const evil of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      // forge an E row whose kind column is a prototype member name.
      const forged = base.replace(/\nE 1\n.*$/s, `\nE 1\n0\t0\t${evil}\t-\n`)
      expect(() => parse(forged), evil).toThrowError(LockfileError)
      try { parse(forged) } catch (e) { expect((e as LockfileError).code).toBe('PARSE_FAILED') }
    }
  })

  it('B7: a malformed F slot / broken L JSON throws PARSE_FAILED (not raw SyntaxError)', () => {
    // The body is JSON-free except the optional `L` line: the residual artifact
    // metadata is now FLAT dot-path slots in the F section (no `payload=` JSON),
    // and the E row carries no JSON either. A malformed F slot (no `=`) and a
    // broken `L` line must both fail with a located LockfileError, never a raw
    // SyntaxError.
    const base = stringify(buildMinimal(), { generatedAt: PINNED })
    // (a) inject an F section with a malformed slot (no `=`) before EOF. Field 1 is
    // the representative node index (0 — a valid ref so parse reaches the slot),
    // then the malformed slot `notaslot`.
    const badF = base.replace(/F 0\n$/, 'F 1\n0\tnotaslot\n')
    expect(badF).not.toBe(base) // guard: the F 0 region header was present and rewritten
    expectParseFailed(badF)
    // (b) an L line with broken JSON (append after the E region, before the F region)
    const badL = base.replace(/\nF 0\n$/, '\nL {bad json\nF 0\n')
    expectParseFailed(badL)
  })

  it('B8: an empty / non-integer / out-of-range edge src or dst throws PARSE_FAILED', () => {
    const base = stringify(buildMinimal(), { generatedAt: PINNED })
    const mk = (src: string, dst: string): string => base.replace(/\nE 1\n.*$/s, `\nE 1\n${src}\t${dst}\tdep\t-\n`)
    expectParseFailed(mk('', '0'))     // empty src — Number('')===0 would silently attach to root
    expectParseFailed(mk('0', ''))     // empty dst
    expectParseFailed(mk('1.5', '0'))  // non-integer
    expectParseFailed(mk('0x1', '0'))  // hex
    expectParseFailed(mk('99', '0'))   // out of range (only 1 node)
    expectParseFailed(mk('-1', '0'))   // negative
  })

  // --- PART C: the worthwhile nits ------------------------------------------

  it('N2: an integrity hash with an out-of-alphabet origin is rejected at emit', () => {
    const b = newBuilder()
    const id = serializeNodeId('pkg', '1.0.0', [])
    b.addNode({ id, name: 'pkg', version: '1.0.0', peerContext: [] })
    // `bogus` is not a documented HashOrigin → no marker → must throw, not coerce.
    b.setTarball({ name: 'pkg', version: '1.0.0' }, {
      integrity: { hashes: [{ algorithm: 'sha512', digest: 'a'.repeat(128), origin: 'bogus' as unknown as 'sri' }] },
    })
    const g = b.seal()
    expect(() => stringify(g, { generatedAt: PINNED })).toThrowError(LockfileError)
  })

  it('N9: a node r<idx> that does not resolve to a real R row throws PARSE_FAILED', () => {
    const base = stringify(buildMinimal(), { generatedAt: PINNED })
    expectParseFailed(base.replace('\tr0\t', '\tr999\t')) // out of range
    expectParseFailed(base.replace('\tr0\t', '\tr-1\t'))  // negative / non-match
    expectParseFailed(base.replace('\tr0\t', '\txyz\t'))  // not an r<idx> at all
  })
})

// A minimal 1-node + 1-self-edge graph used as a forgeable base for the
// malformed-input regressions. Node `pkg@1.0.0` with a registry integrity, plus
// a single dep self-edge so the `E 1` region exists to mutate.
function buildMinimal(): Graph {
  const b = newBuilder()
  const id = serializeNodeId('pkg', '1.0.0', [])
  b.addNode({ id, name: 'pkg', version: '1.0.0', peerContext: [] })
  b.setTarball({ name: 'pkg', version: '1.0.0' }, { integrity: sri('sha512-' + 'a'.repeat(86) + '==') })
  b.addEdge(id, id, 'dep', { range: '1.0.0' })
  return b.seal()
}

function expectParseFailed(text: string): void {
  let threw: unknown
  try { parse(text) } catch (e) { threw = e }
  expect(threw).toBeInstanceOf(LockfileError)
  expect((threw as LockfileError).code).toBe('PARSE_FAILED')
}

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

// =====================================================================================
// Internal codec helpers — error/throw paths, rare F-slot shapes, the
// integrity-column codec, and document-level parse framing errors.
// =====================================================================================

const KEY = toTarballKey({ name: 'p', version: '1.0.0' })

// Assert `fn` throws a LockfileError whose code is `code` and whose message
// contains `msgFragment` (message asserted only where it encodes real behavior,
// e.g. WHICH field / marker the parser rejected).
function expectLockError(fn: () => unknown, code: string, msgFragment?: string): void {
  try {
    fn()
    expect.unreachable(`expected a LockfileError(${code})`)
  } catch (e) {
    expect(e).toBeInstanceOf(LockfileError)
    expect((e as LockfileError).code).toBe(code)
    if (msgFragment !== undefined) expect((e as LockfileError).message).toContain(msgFragment)
  }
}

describe('escapeTsv', () => {
  it('escapes exactly the four framing bytes and leaves ordinary bytes', () => {
    // `:` `/` `@` `+` `{` `}` `,` are ordinary value bytes (NOT escaped); only
    // backslash / TAB / LF / CR are framing bytes.
    expect(escapeTsv('a\\b\tc\nd\re:/@+{},')).toBe('a\\\\b\\tc\\nd\\re:/@+{},')
  })

  it('escapeTsv → unescapeTsv round-trips a value carrying every framing byte', () => {
    const v = 'x\ty\nz\rw\\q'
    expect(unescapeTsv(escapeTsv(v))).toBe(v)
  })
})

describe('unescapeTsv', () => {
  it('leaves an escape pair whose second byte is NOT n/r/t/\\ intact', () => {
    expect(unescapeTsv('a\\bc')).toBe('a\\bc')
  })

  it('leaves a trailing lone backslash intact (no following byte)', () => {
    expect(unescapeTsv('ab\\')).toBe('ab\\')
  })
})

describe('splitFirstUnescaped', () => {
  it('returns [whole, undefined] when the separator is absent', () => {
    expect(splitFirstUnescaped('abc', '=')).toEqual(['abc', undefined])
  })

  it('splits on the first UNESCAPED separator, skipping an escaped one', () => {
    // `a\=b=c`: the first `=` is escaped (odd backslash run) → split at the second.
    expect(splitFirstUnescaped('a\\=b=c', '=')).toEqual(['a\\=b', 'c'])
  })

  it('treats a separator after an EVEN backslash run as unescaped', () => {
    // `a\\=b`: two backslashes → the `=` is NOT escaped → split there.
    expect(splitFirstUnescaped('a\\\\=b', '=')).toEqual(['a\\\\', 'b'])
  })
})

describe('parsePeerContext', () => {
  it('splits sibling peer NodeIds on depth-0 parens, keeping nested parens inside a member', () => {
    // `(a@1.0.0(b@2.0.0))(c@3.0.0)` → two members; the inner `(b@2.0.0)` stays part
    // of the first member (a nested peer context), split only at depth-0 boundaries.
    expect(parsePeerContext('(a@1.0.0(b@2.0.0))(c@3.0.0)')).toEqual(['a@1.0.0(b@2.0.0)', 'c@3.0.0'])
  })

  it('returns [] for an empty peer slot', () => {
    expect(parsePeerContext('')).toEqual([])
  })
})

describe('registrySourceOf', () => {
  const node = (extra: Record<string, unknown> = {}) =>
    ({ id: 'x', name: 'x', version: '1', peerContext: [], ...extra }) as any

  it('a workspace member is the `workspace` pseudo-source (no external URL)', () => {
    expect(registrySourceOf(node({ workspacePath: 'pkg/a' }), undefined)).toEqual({ type: 'workspace', url: '-' })
  })

  it('no resolution at all → `npm` + `-` (npm-class, host unrecorded)', () => {
    expect(registrySourceOf(node(), undefined)).toEqual({ type: 'npm', url: '-' })
  })

  it('a canonical registry tarball URL → `npm` + the derived base', () => {
    const payload = { resolution: { type: 'tarball', url: 'https://registry.npmjs.org/x/-/x-1.tgz' } } as any
    expect(registrySourceOf(node(), payload)).toEqual({ type: 'npm', url: 'https://registry.npmjs.org' })
  })

  it('a NON-canonical tarball URL is kept verbatim as a `tarball` source', () => {
    const payload = { resolution: { type: 'tarball', url: 'https://custom.example/blob.tgz' } } as any
    expect(registrySourceOf(node(), payload)).toEqual({ type: 'tarball', url: 'https://custom.example/blob.tgz' })
  })

  it('a git resolution uses hostingProvider as the type when present', () => {
    const payload = { resolution: { type: 'git', url: 'https://g/x.git', sha: 'abc', hostingProvider: 'github' } } as any
    expect(registrySourceOf(node(), payload)).toEqual({ type: 'github', url: 'https://g/x.git' })
  })

  it('a git resolution WITHOUT hostingProvider falls back to the `git` type', () => {
    const payload = { resolution: { type: 'git', url: 'https://g/x.git', sha: 'abc' } } as any
    expect(registrySourceOf(node(), payload)).toEqual({ type: 'git', url: 'https://g/x.git' })
  })

  it('a directory resolution maps to `directory` + the path', () => {
    const payload = { resolution: { type: 'directory', path: '/foo' } } as any
    expect(registrySourceOf(node(), payload)).toEqual({ type: 'directory', url: '/foo' })
  })

  it('an unknown resolution maps to `unknown` + the raw string', () => {
    const payload = { resolution: { type: 'unknown', raw: 'weird:thing' } } as any
    expect(registrySourceOf(node(), payload)).toEqual({ type: 'unknown', url: 'weird:thing' })
  })
})

describe('isRecomposableTarballResolution', () => {
  it('true for the bare 2-key {type:tarball,url} canonical shape', () => {
    expect(isRecomposableTarballResolution(
      { type: 'tarball', url: 'https://registry.npmjs.org/p/-/p-1.0.0.tgz' } as any, 'p', '1.0.0',
    )).toBe(true)
  })

  it('false when an extra key is present (not the bare 2-key shape)', () => {
    expect(isRecomposableTarballResolution(
      { type: 'tarball', url: 'https://registry.npmjs.org/p/-/p-1.0.0.tgz', bind: 'x' } as any, 'p', '1.0.0',
    )).toBe(false)
  })

  it('false when the URL is not the canonical registry-tarball shape', () => {
    expect(isRecomposableTarballResolution(
      { type: 'tarball', url: 'https://custom.example/p.tgz' } as any, 'p', '1.0.0',
    )).toBe(false)
  })
})

describe('resolveNativeResolution', () => {
  it('recomposes <url>#<fragment> from an N-row u-member fragment + a hosted base', () => {
    expect(resolveNativeResolution(undefined, 'p', '1.0.0', 'a'.repeat(40), 'https://registry.npmjs.org'))
      .toBe('https://registry.npmjs.org/p/-/p-1.0.0.tgz#' + 'a'.repeat(40))
  })

  it('a verbatim F-slot native passes through untouched (fragment ignored)', () => {
    expect(resolveNativeResolution('git+ssh://x#deadbeef', 'p', '1.0.0', undefined, undefined))
      .toBe('git+ssh://x#deadbeef')
  })

  it('undefined when neither a verbatim native nor a fragment is present', () => {
    expect(resolveNativeResolution(undefined, 'p', '1.0.0', undefined, 'https://registry.npmjs.org'))
      .toBeUndefined()
  })

  it('throws PARSE_FAILED when a fragment is present but there is NO hosted npm base', () => {
    expectLockError(
      () => resolveNativeResolution(undefined, 'p', '1.0.0', 'a'.repeat(40), undefined),
      'PARSE_FAILED',
      'u-member requires a hosted npm registry row',
    )
  })
})

describe('encodeIntegrityColumn', () => {
  it('folds the berryChecksumCacheKey INTO the berry-zip z-member on encode', () => {
    const digest = 'a'.repeat(128)
    expect(
      encodeIntegrityColumn({ hashes: [{ algorithm: 'sha512', digest, origin: 'berry-zip' }] }, undefined, '10c0'),
    ).toBe(`z10c0/sha512-${digest}`)
  })

  it('encode → decode round-trips a multi-origin multiset (s/z/r/c markers, source order)', () => {
    const integrity = {
      hashes: [
        { algorithm: 'sha1', digest: '1'.repeat(40), origin: 'sri' as const },
        { algorithm: 'sha512', digest: '2'.repeat(128), origin: 'berry-zip' as const },
        { algorithm: 'sha512', digest: '3'.repeat(128), origin: 'registry' as const },
        { algorithm: 'sha512', digest: '4'.repeat(128), origin: 'recomputed' as const },
      ],
    }
    const col = encodeIntegrityColumn(integrity, undefined, undefined)
    expect(col).toBe(
      `ssha1-${'1'.repeat(40)};zsha512-${'2'.repeat(128)};rsha512-${'3'.repeat(128)};csha512-${'4'.repeat(128)}`,
    )
    expect(decodeIntegrityColumn(col)).toEqual({ integrity })
  })

  it('appends the transport u-member LAST and returns it as `fragment` (NOT in the multiset) on decode', () => {
    const frag = 'b'.repeat(40)
    const col = encodeIntegrityColumn(
      { hashes: [{ algorithm: 'sha512', digest: 'a'.repeat(128), origin: 'sri' }] }, frag, undefined,
    )
    expect(col).toBe(`ssha512-${'a'.repeat(128)};usha1-${frag}`)
    const decoded = decodeIntegrityColumn(col)
    expect(decoded.fragment).toBe(frag)
    expect(decoded.integrity).toEqual({ hashes: [{ algorithm: 'sha512', digest: 'a'.repeat(128), origin: 'sri' }] })
  })

  it('REJECTS a url-fragment-origin hash as a multiset member (INVARIANT_VIOLATION)', () => {
    expectLockError(
      () => encodeIntegrityColumn(
        { hashes: [{ algorithm: 'sha1', digest: 'a'.repeat(40), origin: 'url-fragment' as any }] }, undefined, undefined,
      ),
      'INVARIANT_VIOLATION',
      'url-fragment-origin hash must ride the resolution sidecar',
    )
  })

  it('REJECTS an origin with no marker in {s,z,r,c,u} (INVARIANT_VIOLATION)', () => {
    expectLockError(
      () => encodeIntegrityColumn(
        { hashes: [{ algorithm: 'sha1', digest: 'a'.repeat(40), origin: 'bogus' as any }] }, undefined, undefined,
      ),
      'INVARIANT_VIOLATION',
      "unknown integrity hash origin 'bogus'",
    )
  })
})

describe('decodeIntegrityColumn', () => {
  it('lifts the cacheKey back off the z-member on decode (split at the first `/`)', () => {
    const digest = 'a'.repeat(128)
    expect(decodeIntegrityColumn(`z10c0/sha512-${digest}`)).toEqual({
      integrity: { hashes: [{ algorithm: 'sha512', digest, origin: 'berry-zip' }] },
      cacheKey: '10c0',
    })
  })

  it('a bare `-` column decodes to no integrity / fragment / cacheKey', () => {
    expect(decodeIntegrityColumn('-')).toEqual({})
  })

  it('REJECTS two `/`-bearing z-members (duplicate cacheKey)', () => {
    expectLockError(
      () => decodeIntegrityColumn(`z10c0/sha512-${'a'.repeat(128)};z8/sha512-${'b'.repeat(128)}`),
      'PARSE_FAILED',
      'duplicate berry checksum-cache-key',
    )
  })

  it('REJECTS a member with no algo/digest `-` separator', () => {
    expectLockError(
      () => decodeIntegrityColumn('ssha512' + 'a'.repeat(128)),
      'PARSE_FAILED',
      'malformed integrity member',
    )
  })

  it('REJECTS a duplicate u (url-fragment) member', () => {
    expectLockError(
      () => decodeIntegrityColumn(`usha1-${'a'.repeat(40)};usha1-${'b'.repeat(40)}`),
      'PARSE_FAILED',
      'duplicate u (url-fragment) integrity member',
    )
  })

  it('REJECTS a u member whose algorithm is not sha1', () => {
    expectLockError(
      () => decodeIntegrityColumn(`usha512-${'a'.repeat(128)}`),
      'PARSE_FAILED',
      "u (url-fragment) member must be sha1, got 'sha512'",
    )
  })

  it('REJECTS an unknown origin marker', () => {
    expectLockError(
      () => decodeIntegrityColumn(`xsha512-${'a'.repeat(128)}`),
      'PARSE_FAILED',
      "unknown integrity origin marker 'x'",
    )
  })
})

describe('flattenToSlots', () => {
  it('hasInstallScript emits a bare boolean-string slot', () => {
    expect(flattenToSlots({ hasInstallScript: true } as TarballPayload, 'p', '1.0.0'))
      .toEqual(['hasInstallScript=true'])
  })

  it('peerDependenciesMeta emits `<peer>.optional=<bool>`; a peer without `optional` emits nothing', () => {
    const payload = { peerDependenciesMeta: { react: { optional: true }, vue: {} } } as TarballPayload
    expect(flattenToSlots(payload, 'p', '1.0.0')).toEqual(['peerDependenciesMeta.react.optional=true'])
  })

  it('a bin MAP flattens per-entry (keys cmpStr-sorted), never collapsing a 1-entry map to a string', () => {
    const payload = { bin: { zeta: 'z.js', alpha: 'a.js' } } as TarballPayload
    expect(flattenToSlots(payload, 'p', '1.0.0')).toEqual(['bin.alpha=a.js', 'bin.zeta=z.js'])
  })

  it('a string bin emits the bare `bin=<v>` form', () => {
    expect(flattenToSlots({ bin: 'cli.js' } as TarballPayload, 'p', '1.0.0')).toEqual(['bin=cli.js'])
  })

  it('funding OBJECT flattens to `funding.<key>=` slots, keys cmpStr-sorted', () => {
    const payload = { funding: { url: 'https://x', type: 'oc' } } as TarballPayload
    expect(flattenToSlots(payload, 'p', '1.0.0')).toEqual(['funding.type=oc', 'funding.url=https://x'])
  })

  it('funding ARRAY flattens to ascending `funding.<i>=` slots', () => {
    const payload = { funding: ['https://a', 'https://b'] } as TarballPayload
    expect(flattenToSlots(payload, 'p', '1.0.0')).toEqual(['funding.0=https://a', 'funding.1=https://b'])
  })

  it('funding SCALAR emits the bare `funding=<v>` slot', () => {
    expect(flattenToSlots({ funding: 'https://x' } as TarballPayload, 'p', '1.0.0')).toEqual(['funding=https://x'])
  })

  it('a NON-recomposable resolution flattens the WHOLE union under resolution.* (cmpStr keys)', () => {
    const payload = { resolution: { type: 'git', url: 'https://g/x.git', sha: 'abc' } } as TarballPayload
    expect(flattenToSlots(payload, 'p', '1.0.0'))
      .toEqual(['resolution.sha=abc', 'resolution.type=git', 'resolution.url=https://g/x.git'])
  })

  it('a recomposable {type:tarball} resolution emits NO resolution slot (omitted, recomposed from R)', () => {
    const payload = { resolution: { type: 'tarball', url: 'https://registry.npmjs.org/p/-/p-1.0.0.tgz' } } as TarballPayload
    expect(flattenToSlots(payload, 'p', '1.0.0')).toEqual([])
  })

  it('the full field order is fixed: license, deprecated, cpu, os, libc, bundled, engines', () => {
    const payload = {
      license: 'MIT',
      deprecated: 'old',
      cpu: ['x64'],
      os: ['linux'],
      libc: ['glibc'],
      bundledDependencies: ['dep-a'],
      engines: { node: '>=8' },
    } as TarballPayload
    expect(flattenToSlots(payload, 'p', '1.0.0')).toEqual([
      'license=MIT', 'deprecated=old', 'cpu.0=x64', 'os.0=linux', 'libc.0=glibc',
      'bundled.0=dep-a', 'engines.node=>=8',
    ])
  })

  it('an empty residual yields no slots (no F row for that tarball)', () => {
    expect(flattenToSlots({ integrity: { hashes: [] } } as TarballPayload, 'p', '1.0.0')).toEqual([])
  })

  it('a KEY containing `.`/`=` is key-segment-escaped (then TSV-escaped) and round-trips', () => {
    // A funding-object key carrying the two structural key bytes exercises the
    // key-segment escape (escapeKeySegment) on emit and its inverse
    // (splitDotpath keeping the escape pair + unescapeKeySegment) on parse.
    const payload = { funding: { 'weird.key=with': 'https://x' } } as TarballPayload
    const slots = flattenToSlots(payload, 'p', '1.0.0')
    expect(slots).toEqual(['funding.weird\\\\.key\\\\=with=https://x'])
    expect(parseSlots(slots, KEY)).toEqual({ funding: { 'weird.key=with': 'https://x' } })
  })
})

describe('parseSlots', () => {
  it('engines slots rebuild a Record<string,string>', () => {
    expect(parseSlots(['engines.node=>=8', 'engines.npm=>=6'], KEY))
      .toEqual({ engines: { node: '>=8', npm: '>=6' } })
  })

  it('hasInstallScript decodes `true`/`false` to a real boolean', () => {
    expect(parseSlots(['hasInstallScript=true'], KEY)).toEqual({ hasInstallScript: true })
    expect(parseSlots(['hasInstallScript=false'], KEY)).toEqual({ hasInstallScript: false })
  })

  it('peerDependenciesMeta rebuilds nested `<peer>.optional`', () => {
    expect(parseSlots(['peerDependenciesMeta.react.optional=true'], KEY))
      .toEqual({ peerDependenciesMeta: { react: { optional: true } } })
  })

  it('a bin map rebuilds a Record; a bare bin rebuilds a string', () => {
    expect(parseSlots(['bin.foo=cli.js', 'bin.bar=other.js'], KEY))
      .toEqual({ bin: { foo: 'cli.js', bar: 'other.js' } })
    expect(parseSlots(['bin=cli.js'], KEY)).toEqual({ bin: 'cli.js' })
  })

  it('a resolution.* union rebuilds the canonical resolution object', () => {
    expect(parseSlots(['resolution.type=git', 'resolution.url=https://g', 'resolution.sha=abc'], KEY))
      .toEqual({ resolution: { type: 'git', url: 'https://g', sha: 'abc' } })
  })

  it('funding rebuilds a scalar / an array / an object / an array-of-objects / a nested array by STRUCTURE', () => {
    expect(parseSlots(['funding=https://x'], KEY)).toEqual({ funding: 'https://x' })
    expect(parseSlots(['funding.0=https://a', 'funding.1=https://b'], KEY))
      .toEqual({ funding: ['https://a', 'https://b'] })
    expect(parseSlots(['funding.type=oc', 'funding.url=https://x'], KEY))
      .toEqual({ funding: { type: 'oc', url: 'https://x' } })
    expect(parseSlots(['funding.0.type=oc', 'funding.0.url=https://a', 'funding.1.url=https://b'], KEY))
      .toEqual({ funding: [{ type: 'oc', url: 'https://a' }, { url: 'https://b' }] })
    expect(parseSlots(['funding.sponsors.0=https://a', 'funding.sponsors.1=https://b'], KEY))
      .toEqual({ funding: { sponsors: ['https://a', 'https://b'] } })
  })

  it('a verbatim nativeResolution slot round-trips its value', () => {
    expect(parseSlots(['nativeResolution=react@npm:18.0.0'], KEY))
      .toEqual({ nativeResolution: 'react@npm:18.0.0' })
  })

  it('an unknown F slot root is rejected', () => {
    expectLockError(() => parseSlots(['bogusRoot=x'], KEY), 'PARSE_FAILED', "unknown F slot root 'bogusRoot'")
  })

  it('a leading `=` (empty key) is rejected as an unknown root', () => {
    expectLockError(() => parseSlots(['=value'], KEY), 'PARSE_FAILED', "unknown F slot root ''")
  })

  it('a field with no `=` is rejected at slot-decode', () => {
    expectLockError(() => parseSlots(['licensewithnoeq'], KEY), 'PARSE_FAILED', "malformed F slot (no '=')")
  })

  it('a scalar (license/deprecated) slot with a sub-path or a duplicate is rejected', () => {
    expectLockError(() => parseSlots(['license.sub=MIT'], KEY), 'PARSE_FAILED', "malformed scalar 'license'")
    expectLockError(() => parseSlots(['license=MIT', 'license=ISC'], KEY), 'PARSE_FAILED', "malformed scalar 'license'")
  })

  it('a string[] slot (cpu/os/libc/bundled) with a non-numeric index is rejected', () => {
    expectLockError(() => parseSlots(['cpu.x=x64'], KEY), 'PARSE_FAILED', "malformed array 'cpu'")
  })

  it('a string[] slot with a GAP in indices is rejected (parser never hole-fills)', () => {
    expectLockError(() => parseSlots(['cpu.0=x64', 'cpu.2=arm'], KEY), 'PARSE_FAILED', 'cpu array indices must be contiguous')
  })

  it('an engines slot at the wrong depth is rejected', () => {
    expectLockError(() => parseSlots(['engines=x'], KEY), 'PARSE_FAILED', 'malformed engines slot')
  })

  it('bin carrying BOTH string and map forms is rejected', () => {
    expectLockError(() => parseSlots(['bin=cli.js', 'bin.foo=cli.js'], KEY), 'PARSE_FAILED', 'bin carries both string and map forms')
  })

  it('a duplicate bare bin slot is rejected', () => {
    expectLockError(() => parseSlots(['bin=a', 'bin=b'], KEY), 'PARSE_FAILED', 'duplicate bare bin slot')
  })

  it('a bin map slot at the wrong depth is rejected', () => {
    expectLockError(() => parseSlots(['bin.a.b=c'], KEY), 'PARSE_FAILED', 'malformed bin map slot')
  })

  it('a hasInstallScript slot with a sub-path is rejected', () => {
    expectLockError(() => parseSlots(['hasInstallScript.x=true'], KEY), 'PARSE_FAILED', 'malformed hasInstallScript slot')
  })

  it('a peerDependenciesMeta slot that is not `<peer>.optional` is rejected (both wrong depth and wrong leaf)', () => {
    expectLockError(() => parseSlots(['peerDependenciesMeta.react=true'], KEY), 'PARSE_FAILED', 'malformed peerDependenciesMeta slot')
    expectLockError(() => parseSlots(['peerDependenciesMeta.react.foo=true'], KEY), 'PARSE_FAILED', 'malformed peerDependenciesMeta slot')
  })

  it('duplicate nativeResolution slots are rejected', () => {
    expectLockError(() => parseSlots(['nativeResolution=a', 'nativeResolution=b'], KEY), 'PARSE_FAILED', 'duplicate nativeResolution slot')
  })

  it('a nativeResolution slot with a sub-path is rejected', () => {
    expectLockError(() => parseSlots(['nativeResolution.x=a'], KEY), 'PARSE_FAILED', 'malformed nativeResolution slot')
  })

  it('a resolution slot at the wrong depth is rejected', () => {
    expectLockError(() => parseSlots(['resolution=x'], KEY), 'PARSE_FAILED', 'malformed resolution slot')
  })

  it('funding with an array/object shape conflict is rejected', () => {
    expectLockError(() => parseSlots(['funding.0=a', 'funding.type=b'], KEY), 'PARSE_FAILED', "funding array/object shape conflict at 'type'")
  })

  it('funding descending from a SCALAR leaf into a container is rejected', () => {
    expectLockError(() => parseSlots(['funding=scalar', 'funding.x=y'], KEY), 'PARSE_FAILED', "funding scalar/container conflict at 'x'")
  })

  it('a funding ARRAY with an index gap is rejected (contiguity check)', () => {
    expectLockError(() => parseSlots(['funding.0=a', 'funding.2=b'], KEY), 'PARSE_FAILED', 'funding array indices must be contiguous')
  })
})

// Assemble a minimal well-formed lockgraph document body around the caller's
// region lines, for targeted framing-error tests.
const DOC = (...bodyLines: string[]): string =>
  ['@lockgraph 1', 'schema 1.0', 'generatedAt ' + PINNED, 'generator lockgraph@0.0.0', ...bodyLines].join('\n') + '\n'

describe('parse', () => {
  it('an unexpected end of input (document truncated before a region) is rejected', () => {
    expectLockError(() => parse('@lockgraph 1\nschema 1.0'), 'PARSE_FAILED', 'unexpected end of input')
  })

  it('a missing @lockgraph magic is rejected', () => {
    expectLockError(() => parse('@notlockgraph 1\nR 0\nN 0\nE 0\n'), 'PARSE_FAILED', 'missing @lockgraph magic')
  })

  it('a newer format GENERATION is rejected with CAPABILITY_LACK', () => {
    expectLockError(() => parse('@lockgraph 2\nR 0\nN 0\nE 0\n'), 'CAPABILITY_LACK', 'format generation 2 newer than supported')
  })

  it('a newer SCHEMA major is rejected with CAPABILITY_LACK', () => {
    expectLockError(() => parse('@lockgraph 1\nschema 2.0\nR 0\nN 0\nE 0\n'), 'CAPABILITY_LACK', 'schema major 2.0 newer than supported')
  })

  it('a region header with the wrong letter is rejected (expectHeader)', () => {
    // R is consumed by the META boundary; the N header is then validated by
    // expectHeader and a wrong letter is rejected with the region-header message.
    expectLockError(() => parse('@lockgraph 1\nschema 1.0\nR 0\nBOGUS 0\nE 0\n'), 'PARSE_FAILED', "expected 'N <count>' region header")
  })

  it('a region header with a negative / non-integer count is rejected (expectHeader)', () => {
    expectLockError(() => parse('@lockgraph 1\nschema 1.0\nR 0\nN -1\nE 0\n'), 'PARSE_FAILED', "expected 'N <count>' region header")
    expectLockError(() => parse('@lockgraph 1\nschema 1.0\nR 0\nN abc\nE 0\n'), 'PARSE_FAILED', "expected 'N <count>' region header")
  })

  it('a malformed registry row (no url field) is rejected', () => {
    expectLockError(() => parse(DOC('R 1', 'npm', 'N 0', 'E 0')), 'PARSE_FAILED', 'malformed registry row')
  })

  it('a malformed node row (fewer than 4 columns) is rejected', () => {
    expectLockError(() => parse(DOC('R 1', 'npm\t-', 'N 1', 'foo\t1.0.0', 'E 0')), 'PARSE_FAILED', 'malformed node row')
  })

  it('a malformed node trailing slot (no `=`) is rejected', () => {
    expectLockError(
      () => parse(DOC('R 1', 'npm\t-', 'N 1', 'foo\t1.0.0\tr0\t-\tbadslot', 'E 0')),
      'PARSE_FAILED', "malformed node slot (no '='): badslot",
    )
  })

  it('a bad registry reference on an N row is rejected', () => {
    expectLockError(
      () => parse(DOC('R 1', 'npm\t-', 'N 1', 'foo\t1.0.0\tr9\t-', 'E 0')),
      'PARSE_FAILED', "bad registry reference 'r9'",
    )
  })

  it('a malformed edge row (fewer than 4 columns) is rejected', () => {
    expectLockError(
      () => parse(DOC('R 1', 'npm\t-', 'N 1', 'foo\t1.0.0\tr0\t-', 'E 1', '0\t0')),
      'PARSE_FAILED', 'malformed edge row',
    )
  })

  it('an unknown edge kind is rejected', () => {
    expectLockError(
      () => parse(DOC('R 1', 'npm\t-', 'N 1', 'foo\t1.0.0\tr0\t-', 'E 1', '0\t0\tbogus\t-')),
      'PARSE_FAILED', "unknown edge kind 'bogus'",
    )
  })

  it('an edge src index out of range is rejected (parseNodeIndex bound)', () => {
    expectLockError(
      () => parse(DOC('R 1', 'npm\t-', 'N 1', 'foo\t1.0.0\tr0\t-', 'E 1', '5\t0\tdep\t-')),
      'PARSE_FAILED', 'edge src index 5 out of range [0, 1)',
    )
  })

  it('an F row whose representative index is out of range is rejected', () => {
    expectLockError(
      () => parse(DOC('R 1', 'npm\t-', 'N 1', 'foo\t1.0.0\tr0\t-', 'E 0', 'F 1', '9\tlicense=MIT')),
      'PARSE_FAILED', 'F row representative index 9 out of range [0, 1)',
    )
  })

  it('an F row whose representative field is not an integer is rejected', () => {
    expectLockError(
      () => parse(DOC('R 1', 'npm\t-', 'N 1', 'foo\t1.0.0\tr0\t-', 'E 0', 'F 1', '\tlicense=MIT')),
      'PARSE_FAILED', 'F row representative must be a non-negative integer',
    )
  })

  it('forwards every re-derived seal diagnostic to the onDiagnostic callback', () => {
    // A published (registry-range) dep resolving onto a co-located workspace makes
    // the seal emit SEAL_PUBLISHED_SELF_LINK. Diagnostics are NOT persisted — they
    // are re-derived by the seal and streamed via onDiagnostic.
    const b = newBuilder()
    const ws = serializeNodeId('@app/web', '1.0.0', [])
    const dep = serializeNodeId('shared', '2.0.0', [])
    b.addNode({ id: ws, name: '@app/web', version: '1.0.0', peerContext: [], workspacePath: 'packages/web' })
    b.addNode({ id: dep, name: 'shared', version: '2.0.0', peerContext: [] })
    b.addEdge(dep, ws, 'dep', { range: '^1.0.0' })
    const g: Graph = b.seal()
    const doc = stringify(g, { generatedAt: PINNED })

    const seen: string[] = []
    parse(doc, { onDiagnostic: (d) => seen.push(d.code) })
    expect(seen).toContain('SEAL_PUBLISHED_SELF_LINK')
  })
})
