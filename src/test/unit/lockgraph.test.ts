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
    expect(text).toMatch(/\ngenerator @antongolub\/lockfile@/)
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
    // markers (s=sri, z=berry-zip, r=registry), in source order.
    const row = text.split('\n').find(l => l.startsWith('lodash\t'))!
    const integrityCol = row.split('\t')[3]!
    expect(integrityCol).toBe(
      `ssha1-${'1'.repeat(40)};ssha512-${'2'.repeat(128)};zsha512-${'3'.repeat(128)};rsha512-${'4'.repeat(128)}`,
    )
    // explicit: the reconstructed payload equals the original verbatim
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
    // the F row is keyed by the FULL TarballKey (both discriminators) and flattens
    // the non-canonical git resolution union under `resolution.*` dot-path slots.
    const fRow = text.split('\n').find(l => l.startsWith(`is-git@6.3.1+patch=${patch}+src=${src}\t`))!
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
    // tarball's residual is empty → NO F row.
    expect(text.split('\n').some(l => l.startsWith('JSV@4.0.2\t'))).toBe(false)
    // and it all reconstructs identity-exact (native sidecar + payload).
    const g2 = parse(stringify(g, { generatedAt: PINNED }))
    expect(g2.tarball({ name: 'JSV', version: '4.0.2' })!.nativeResolution).toBe(`${url}#${sha1}`)
    expect(g2.tarball({ name: 'JSV', version: '4.0.2' })!.resolution).toEqual({ type: 'tarball', url })
    // the u-member is TRANSPORT-ONLY: it is NOT added to the integrity multiset.
    expect(g2.tarball({ name: 'JSV', version: '4.0.2' })!.integrity).toBeUndefined()
  })

  it('berry npm locator nativeResolution → `nativeResolution.berry=` F marker, recomposed on parse', () => {
    const b = newBuilder()
    const id = serializeNodeId('react', '18.0.0', [])
    // payload.nativeResolution byte-equals the recomposed berry locator `react@npm:18.0.0`.
    b.addNode({ id, name: 'react', version: '18.0.0', peerContext: [] })
    b.setTarball({ name: 'react', version: '18.0.0' }, {
      integrity: sri('sha512-' + 'a'.repeat(86) + '=='),
      nativeResolution: 'react@npm:18.0.0',
    })
    const g = b.seal()
    const text = assertRoundTripIdentity(g)
    // the F row carries the valueless berry MARKER `nativeResolution.berry=`,
    // NOT the verbatim `nativeResolution=react@npm:18.0.0`.
    const fRow = text.split('\n').find(l => l.startsWith('react@18.0.0\t'))!
    expect(fRow).toContain('\tnativeResolution.berry=')
    expect(fRow).not.toContain('nativeResolution=react@npm')
    // the N row no longer carries any res token.
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
    const fRow = text.split('\n').find(l => l.startsWith('left-pad@1.3.0\t'))!
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
    // the F row (keyed by the bare TarballKey `x@1.0.0`) flattens the union.
    const fRow = text.split('\n').find(l => l.startsWith('x@1.0.0\t'))!
    expect(fRow).toBeDefined()
    expect(fRow).toContain('\tresolution.type=tarball')
    expect(fRow).toContain('\tresolution.hostingProvider=github')
    expect(parse(stringify(g, { generatedAt: PINNED })).tarball({ name: 'x', version: '1.0.0' })!.resolution).toEqual(resolution)
  })

  it('berryChecksumCacheKey rides the dedicated F ck= slot (out of payload JSON) and round-trips', () => {
    const b = newBuilder()
    const id = serializeNodeId('y', '2.0.0', [])
    b.addNode({ id, name: 'y', version: '2.0.0', peerContext: [] })
    b.setTarball({ name: 'y', version: '2.0.0' }, {
      integrity: sri('sha512-' + 'c'.repeat(86) + '=='),
      berryChecksumCacheKey: '10c0',
    })
    const g = b.seal()
    const text = assertRoundTripIdentity(g)
    // `ck` rides the severable F section now, NOT the N row.
    const row = rowOf(text, 'y')
    expect(row).not.toContain('ck=')
    const fRow = text.split('\n').find(l => l.startsWith('y@2.0.0\t'))!
    expect(fRow).toContain('\tck=10c0')
    expect(fRow).not.toContain('berryChecksumCacheKey') // rides the dedicated ck= slot, never a field slot
    expect(parse(stringify(g, { generatedAt: PINNED })).tarball({ name: 'y', version: '2.0.0' })!.berryChecksumCacheKey).toBe('10c0')
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
    // (a) inject an F section with a malformed slot (no `=`) before EOF.
    const badF = base.replace(/F 0\n$/, 'F 1\npkg@1.0.0\tnotaslot\n')
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
