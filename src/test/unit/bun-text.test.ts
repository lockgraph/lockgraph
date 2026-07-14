// bun-text adapter tests — standalone-fit per the yarn-classic / npm-1 /
// pnpm-v5 precedent. Covers the 7-fixture parse matrix, §A.4 Graph-level
// roundtrip, §B mutator coverage с lossy diagnostics, §C peer-virt absence +
// manifest-driven workspace enrich, §D prune unreachable + idempotence, plus
// cross-adapter isolation rejection.

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  GraphError,
  newBuilder,
  toTarballKey,
  type Diagnostic,
  type EdgeKind,
  type Graph,
} from '../../main/ts/graph.ts'
import { LockfileError } from '../../main/ts/api/errors.ts'

const sriOf = (s: string): string => 'sha512-' + createHash('sha512').update(s).digest('base64')
const MODIFIED_SRI = sriOf('modified-ms-integrity')
const BUMPED_SRI = sriOf('bumped-ms-integrity')
import {
  addBlockEdges,
  buildInnerBlock,
  buildWorkspaceManifest,
  check,
  enrich,
  getBunOverridesCanonical,
  optimize,
  parse,
  renderInlineValue,
  renderValue,
  resolveOverridesBlock,
  stringify,
} from '../../main/ts/formats/bun-text.ts'
import { parse as parseNpm1 } from '../../main/ts/formats/npm-1.ts'
import { parse as parseNpm3 } from '../../main/ts/formats/npm-3.ts'
import { parse as parseClassic } from '../../main/ts/formats/yarn-classic.ts'
import { parse as parseYarnBerry } from '../../main/ts/formats/yarn-berry-v9.ts'
import { parse as parseV5 } from '../../main/ts/formats/pnpm-v5.ts'
import { parse as parseV9 } from '../../main/ts/formats/pnpm-v9.ts'
import {
  fixture,
  graphSnapshot,
  expectEmptyGraphDiff,
  stringifyWithDiagnostics,
} from '../helpers/lockfile-test-utils.ts'
import { mkIntegrity, sri } from '../_integrity-fixtures.ts'
import { canonicalDigest } from '../../main/ts/recipe/integrity.ts'

// === Fixture matrix =========================================================

const FIXTURES = [
  'deps-with-scopes',
  'peers-basic',
  'peers-multi',
  'simple',
  'workspace-cross-refs',
  'workspaces-basic',
  'yarn-crlf',
] as const

const parseFixtureGraph = (name: typeof FIXTURES[number]): Graph =>
  parse(fixture(`${name}/bun-text.lock`))

// === Cross-version isolation ================================================

describe('bun-text — discriminant and isolation (§A cross-version)', () => {
  it('accepts bun-text fixture and rejects npm-* / yarn-* / pnpm-* inputs', () => {
    const own = fixture('simple/bun-text.lock')
    expect(check(own)).toBe(true)
    expect(check(fixture('simple/npm-1.lock'))).toBe(false)
    expect(check(fixture('simple/npm-2.lock'))).toBe(false)
    expect(check(fixture('simple/npm-3.lock'))).toBe(false)
    expect(check(fixture('simple/yarn-classic.lock'))).toBe(false)
    expect(check(fixture('simple/yarn-berry-v9.lock'))).toBe(false)
    expect(check(fixture('simple/pnpm-v5.lock'))).toBe(false)
    expect(check(fixture('simple/pnpm-v9.lock'))).toBe(false)
  })

  it('parse rejects npm-1 with FORMAT_MISMATCH (no workspaces block)', () => {
    const npm1 = fixture('simple/npm-1.lock')
    expect(() => parse(npm1)).toThrow(LockfileError)
    try { parse(npm1) } catch (error) {
      expect((error as LockfileError).code).toBe('FORMAT_MISMATCH')
    }
  })

  it('parse rejects npm-3 with FORMAT_MISMATCH (lockfileVersion 3)', () => {
    const npm3 = fixture('simple/npm-3.lock')
    expect(() => parse(npm3)).toThrow(LockfileError)
    try { parse(npm3) } catch (error) {
      expect((error as LockfileError).code).toBe('FORMAT_MISMATCH')
    }
  })

  it('parse rejects yarn-classic with FORMAT_MISMATCH (non-JSON)', () => {
    const yc = fixture('simple/yarn-classic.lock')
    expect(() => parse(yc)).toThrow(LockfileError)
    try { parse(yc) } catch (error) {
      expect((error as LockfileError).code).toBe('FORMAT_MISMATCH')
    }
  })

  it('parse rejects yarn-berry-v9 with FORMAT_MISMATCH (non-JSON)', () => {
    const yb = fixture('simple/yarn-berry-v9.lock')
    expect(() => parse(yb)).toThrow(LockfileError)
    try { parse(yb) } catch (error) {
      expect((error as LockfileError).code).toBe('FORMAT_MISMATCH')
    }
  })

  it('parse rejects pnpm-v9 with FORMAT_MISMATCH (non-JSON)', () => {
    const v9 = fixture('simple/pnpm-v9.lock')
    expect(() => parse(v9)).toThrow(LockfileError)
    try { parse(v9) } catch (error) {
      expect((error as LockfileError).code).toBe('FORMAT_MISMATCH')
    }
  })

  it('parse rejects flat-object packages map (npm-flat shape) with FORMAT_MISMATCH', () => {
    const malformed = JSON.stringify({
      lockfileVersion: 1,
      workspaces: { '': { name: 'x' } },
      packages: { '': { name: 'x', version: '0.0.0' } },
    }, null, 2)
    expect(() => parse(malformed)).toThrow(LockfileError)
    try { parse(malformed) } catch (error) {
      expect((error as LockfileError).code).toBe('FORMAT_MISMATCH')
    }
  })

  it('cross-adapter probe: npm-* / yarn-* / pnpm-* parsers reject bun-text input', () => {
    const own = fixture('simple/bun-text.lock')
    expect(() => parseNpm1(own)).toThrow()
    expect(() => parseNpm3(own)).toThrow()
    expect(() => parseClassic(own)).toThrow()
    expect(() => parseYarnBerry(own)).toThrow()
    expect(() => parseV5(own)).toThrow()
    expect(() => parseV9(own)).toThrow()
  })
})

// === Parse fixture matrix ===================================================

describe('bun-text — parse fixtures (7-fixture matrix)', () => {
  it.each(FIXTURES)('parses %s fixture', (name) => {
    const graph = parseFixtureGraph(name)
    expect(Array.from(graph.nodes())).not.toHaveLength(0)
  })

  it('parses the root node with workspacePath = ""', () => {
    const graph = parseFixtureGraph('simple')
    const root = graph.getNode('case-simple@0.0.0')
    expect(root).toBeDefined()
    expect(root?.workspacePath).toBe('')
  })

  it('parses top-level dependencies into dep edges from root', () => {
    const graph = parseFixtureGraph('simple')
    const out = graph.out('case-simple@0.0.0')
    const depDsts = out.filter(edge => edge.kind === 'dep').map(edge => edge.dst).sort()
    expect(depDsts).toEqual(['lodash@4.17.21', 'ms@2.1.3'])
  })

  it('parses tuple-form `packages` entries into (name, version) nodes с integrity tarball', () => {
    const graph = parseFixtureGraph('simple')
    const ms = graph.getNode('ms@2.1.3')
    expect(ms).toBeDefined()
    expect(ms?.peerContext).toEqual([])
    const tarball = graph.tarballOf('ms@2.1.3')
    expect(canonicalDigest(tarball!.integrity!)).toBe('sha512-6FlzubTLZG3J2a/NVCAleEhjzq5oxgHyaCU9yYXvcLsvoVaHJq/s5xXI6/XXP6tz7R9xAOtHnSO/tXtF3WRTlA==')
  })

  it('parses inner-block `dependencies` into dep edges between packages', () => {
    const graph = parseFixtureGraph('peers-basic')
    const reactOut = graph.out('react@18.2.0').filter(edge => edge.kind === 'dep').map(edge => edge.dst)
    expect(reactOut).toContain('loose-envify@1.4.0')
  })

  it('parses scoped names verbatim (no transformation)', () => {
    const graph = parseFixtureGraph('deps-with-scopes')
    expect(graph.getNode('@sindresorhus/is@6.3.1')).toBeDefined()
    expect(graph.getNode('@types/node@20.11.30')).toBeDefined()
  })

  it('parses workspace-ref tuples `[<name>@workspace:<path>]` as workspace-tagged nodes', () => {
    const graph = parseFixtureGraph('workspaces-basic')
    const a = graph.getNode('@case-ws/a@0.0.0')
    const b = graph.getNode('@case-ws/b@0.0.0')
    expect(a?.workspacePath).toBe('packages/a')
    expect(b?.workspacePath).toBe('packages/b')
  })

  it('parses workspace-cross-refs: workspace-protocol edges marked с workspace:true', () => {
    const graph = parseFixtureGraph('workspace-cross-refs')
    const app = graph.getNode('@case-ws/app@1.0.0')
    expect(app?.workspacePath).toBe('packages/app')
    const edges = graph.out('@case-ws/app@1.0.0', 'dep')
    const wsEdge = edges.find(e => e.dst === '@case-ws/core@1.0.0')
    expect(wsEdge?.attrs?.workspace).toBe(true)
    expect(wsEdge?.attrs?.range).toBe('workspace:*')
  })

  it('parses CRLF-input fixture (yarn-crlf has LF on disk; ensure normaliser unaffected)', () => {
    // bun-text on-disk format is LF; we test that LF input parses identically.
    const graph = parseFixtureGraph('yarn-crlf')
    expect(graph.getNode('is-buffer@2.0.5')).toBeDefined()
    expect(graph.getNode('ms@2.1.3')).toBeDefined()
  })

  it('parses CRLF-line-ending input via explicit normalisation', () => {
    const lf = fixture('simple/bun-text.lock')
    const crlf = lf.replace(/\n/g, '\r\n')
    const graph = parse(crlf)
    expect(graph.getNode('case-simple@0.0.0')).toBeDefined()
  })

  it('parses peers-multi: de-hoisted scoped keys produce additional packages nodes', () => {
    const graph = parseFixtureGraph('peers-multi')
    // a-workspace pins react@17, b-workspace pins react@18. The flat-hoist key
    // for `react` is 17.0.2; the b-workspace de-hoists на `@case-peers-multi/b/react`.
    expect(graph.getNode('react@17.0.2')).toBeDefined()
    expect(graph.getNode('react@18.2.0')).toBeDefined()
  })
})

// === §A.4 Graph-level roundtrip =============================================

describe('bun-text — §A.4 Graph-level roundtrip', () => {
  it.each(FIXTURES)('roundtrips %s at Graph level (parse(stringify(parse(x))) ≡ parse(x))', (name) => {
    const original = parseFixtureGraph(name)
    const emitted = stringify(original)
    const reparsed = parse(emitted)
    expect(graphSnapshot(reparsed)).toEqual(graphSnapshot(original))
    expectEmptyGraphDiff(original.diff(reparsed))
    expect(Array.from(reparsed.tarballs())).toEqual(Array.from(original.tarballs()))
  })

  it('emits valid JSONC (JSON.parse fails on raw output, succeeds after trailing-comma strip)', () => {
    const graph = parseFixtureGraph('simple')
    const text = stringify(graph)
    // Raw JSONC c trailing commas: JSON.parse rejects.
    expect(() => JSON.parse(text)).toThrow()
    // Stripped trailing commas: JSON.parse accepts.
    const stripped = text.replace(/,(\s*[}\]])/g, '$1')
    expect(() => JSON.parse(stripped)).not.toThrow()
  })

  it('emits lockfileVersion: 1 numeric literal (NOT quoted)', () => {
    const graph = parseFixtureGraph('simple')
    const text = stringify(graph)
    expect(text).toMatch(/"lockfileVersion":\s*1\b/)
    expect(text).not.toMatch(/"lockfileVersion":\s*"1"/)
  })

  it('emits packages entries as positional tuples (4-elem for regular, 1-elem for workspace-ref)', () => {
    const graph = parseFixtureGraph('workspaces-basic')
    const text = stringify(graph)
    // Workspace-ref tuple shape.
    expect(text).toContain('["@case-ws/a@workspace:packages/a"]')
    // Regular tuple shape (length 4).
    expect(text).toMatch(/\["ms@2\.1\.3", "", \{\}, "sha512-/)
  })

  it('emits CRLF line endings when requested', () => {
    const graph = parseFixtureGraph('simple')
    const text = stringify(graph, { lineEnding: 'crlf' })
    expect(text).toContain('\r\n')
    expect(text.replace(/\r\n/g, '\n')).toBe(stringify(graph))
  })

  it('emits workspace manifest section c name + version', () => {
    const graph = parseFixtureGraph('workspaces-basic')
    const text = stringify(graph)
    expect(text).toContain('"name": "case-workspaces-basic"')
    expect(text).toContain('"packages/a"')
    expect(text).toContain('"name": "@case-ws/a"')
  })
})

// === §B Mutator surface ====================================================

describe('bun-text — modify (§B Mutator surface)', () => {
  it('roundtrips addNode + setTarball + addEdge', () => {
    const original = parseFixtureGraph('simple')
    const result = original.mutate(m => {
      m.addNode({
        id: 'debug@4.4.1',
        name: 'debug',
        version: '4.4.1',
        peerContext: [],
      })
      m.setTarball({ name: 'debug', version: '4.4.1' }, { integrity: mkIntegrity('sha512-fakedebugintegrity') })
      m.addEdge('case-simple@0.0.0', 'debug@4.4.1', 'dep', { range: '4.4.1' })
    })
    const reparsed = parse(stringify(result.graph))
    expectEmptyGraphDiff(result.graph.diff(reparsed))
    expect(reparsed.getNode('debug@4.4.1')).toBeDefined()
  })

  it('roundtrips addEdge dep + removeEdge', () => {
    const original = parseFixtureGraph('simple')
    const added = original.mutate(m => {
      m.addEdge('lodash@4.17.21', 'ms@2.1.3', 'dep', { range: '2.1.3' })
    })
    const reparsed = parse(stringify(added.graph))
    expectEmptyGraphDiff(added.graph.diff(reparsed))

    const removed = added.graph.mutate(m => {
      m.removeEdge('lodash@4.17.21', 'ms@2.1.3', 'dep')
    })
    const reparsedRemoved = parse(stringify(removed.graph))
    expectEmptyGraphDiff(removed.graph.diff(reparsedRemoved))
  })

  it('roundtrips removeNode + removeTarball', () => {
    const original = parseFixtureGraph('simple')
    const result = original.mutate(m => {
      m.removeEdge('case-simple@0.0.0', 'ms@2.1.3', 'dep')
      m.removeNode('ms@2.1.3')
      m.removeTarball({ name: 'ms', version: '2.1.3' })
    })
    const reparsed = parse(stringify(result.graph))
    expectEmptyGraphDiff(result.graph.diff(reparsed))
    expect(reparsed.getNode('ms@2.1.3')).toBeUndefined()
  })

  it('roundtrips setTarball (integrity update)', () => {
    const original = parseFixtureGraph('simple')
    const result = original.mutate(m => {
      m.setTarball({ name: 'ms', version: '2.1.3' }, { integrity: sri(MODIFIED_SRI) })
    })
    const reparsed = parse(stringify(result.graph))
    expectEmptyGraphDiff(result.graph.diff(reparsed))
    expect(reparsed.tarballOf('ms@2.1.3')).toEqual({ integrity: sri(MODIFIED_SRI) })
  })

  it('roundtrips replaceNode (version bump)', () => {
    const original = parseFixtureGraph('simple')
    const current = original.getNode('ms@2.1.3')!
    const result = original.mutate(m => {
      m.removeEdge('case-simple@0.0.0', 'ms@2.1.3', 'dep')
      m.replaceNode('ms@2.1.3', { ...current, id: 'ms@2.1.4', version: '2.1.4' })
      m.setTarball({ name: 'ms', version: '2.1.4' }, { integrity: sri(BUMPED_SRI) })
      m.removeTarball({ name: 'ms', version: '2.1.3' })
      m.addEdge('case-simple@0.0.0', 'ms@2.1.4', 'dep', { range: '2.1.4' })
    })
    const reparsed = parse(stringify(result.graph))
    expect(reparsed.getNode('ms@2.1.3')).toBeUndefined()
    expect(reparsed.getNode('ms@2.1.4')).toBeDefined()
    expectEmptyGraphDiff(result.graph.diff(reparsed))
  })

  it('setNode patch drops on emit с RECIPE_FEATURE_DROPPED diagnostic', () => {
    const original = parseFixtureGraph('simple')
    const patch = 'a'.repeat(128)
    const current = original.getNode('ms@2.1.3')!
    const result = original.mutate(m => {
      m.replaceNode('ms@2.1.3', { ...current, patch })
      m.setTarball({ name: 'ms', version: '2.1.3', patch }, { integrity: mkIntegrity('sha512-patched-ms-integrity') })
      m.removeTarball({ name: 'ms', version: '2.1.3' })
    })
    const { lockfile, diagnostics } = stringifyWithDiagnostics({ stringify }, result.graph)
    const reparsed = parse(lockfile)
    expect(reparsed.getNode('ms@2.1.3')?.patch).toBeUndefined()
    const drops = diagnostics.filter(d => d.code === 'RECIPE_FEATURE_DROPPED' && d.subject === 'ms@2.1.3')
    expect(drops).toHaveLength(1)
    expect(drops[0]).toEqual(
      expect.objectContaining({
        code: 'RECIPE_FEATURE_DROPPED',
        severity: 'warning',
        subject: 'ms@2.1.3',
      }),
    )
  })

  it('replacePeerContext (non-empty) flattens на emit с BUN_TEXT_PEER_VIRT_FLATTENED', () => {
    const original = parseFixtureGraph('peers-basic')
    const result = original.mutate(m => {
      m.replacePeerContext('react-dom@18.2.0', ['react@18.2.0'])
    })
    const { lockfile, diagnostics } = stringifyWithDiagnostics({ stringify }, result.graph)
    const reparsed = parse(lockfile)
    expect(reparsed.getNode('react-dom@18.2.0(react@18.2.0)')).toBeUndefined()
    expect(reparsed.getNode('react-dom@18.2.0')).toBeDefined()
    expect(diagnostics.filter(d => d.code === 'BUN_TEXT_PEER_VIRT_FLATTENED')).toHaveLength(1)
    expect(diagnostics[0]).toEqual(
      expect.objectContaining({
        code: 'BUN_TEXT_PEER_VIRT_FLATTENED',
        severity: 'warning',
        subject: 'react-dom@18.2.0(react@18.2.0)',
      }),
    )
  })

  it('emits each lossy diagnostic at most once per affected node', () => {
    const original = parseFixtureGraph('peers-basic')
    const patch = 'b'.repeat(128)
    const reactDom = original.getNode('react-dom@18.2.0')!
    const result = original.mutate(m => {
      m.replaceNode('react-dom@18.2.0', { ...reactDom, patch })
      m.setTarball({ name: 'react-dom', version: '18.2.0', patch }, { integrity: mkIntegrity('sha512-x') })
      m.removeTarball({ name: 'react-dom', version: '18.2.0' })
      m.addNode({
        id: 'peer-virt@1.0.0(react@18.2.0)',
        name: 'peer-virt',
        version: '1.0.0',
        peerContext: ['react@18.2.0'],
      })
      m.addEdge('peer-virt@1.0.0(react@18.2.0)', 'react@18.2.0', 'peer', { range: '^18.2.0' })
    })
    const { diagnostics } = stringifyWithDiagnostics({ stringify }, result.graph)
    const peerVirt = diagnostics.filter(d => d.code === 'BUN_TEXT_PEER_VIRT_FLATTENED')
    const patchDrop = diagnostics.filter(d => d.code === 'RECIPE_FEATURE_DROPPED' && d.subject === 'react-dom@18.2.0')
    expect(peerVirt).toHaveLength(1)
    expect(patchDrop).toHaveLength(1)
  })

  // Real-world regression (commit 0775b26): bun-text has no patch protocol,
  // so a graph carrying both bare `<n>@<ver>` and patched `<n>@<ver>+patch=<hash>`
  // siblings would emit two `packages` entries that collapse onto a single
  // identity on reparse and trip the seal с `bun-text seal failed: duplicate
  // edge …`. The fix deduplicates at emit (prefer unpatched, drop the patched
  // sibling via `warnPatchDrop` / RECIPE_FEATURE_DROPPED).
  it('dedups bare + patched siblings of the same `<n>@<ver>` on emit (no reparse seal failure)', () => {
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
      m.setTarball({ name: 'typescript', version: '5.4.5' }, { integrity: sri(sriOf('typescript-bare')) })
      m.addNode({
        id: patchedId,
        name: 'typescript',
        version: '5.4.5',
        peerContext: [],
        patch,
      })
      m.setTarball({ name: 'typescript', version: '5.4.5', patch }, { integrity: sri(sriOf('typescript-patched')) })
    })

    const { lockfile, diagnostics } = stringifyWithDiagnostics({ stringify }, result.graph)

    // Reparse must not throw the seal `duplicate edge` / IRREDUCIBLE_LOSS.
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

// === §C Enrich =============================================================

describe('bun-text — enrich (§C peer-virt absence + workspace concretisation)', () => {
  it('peer-virt structurally absent: no peer edges на the parsed graph (declarative only)', () => {
    const graph = parseFixtureGraph('peers-basic')
    // bun encodes peer-deps declaratively в inner-blocks; parse does NOT
    // synthesise peer edges (semver-matcher needed для derivation; §C only
    // surfaces concretisation when manifests provided).
    expect(graph.out('react-dom@18.2.0', 'peer')).toEqual([])
    for (const node of graph.nodes()) {
      expect(node.peerContext).toEqual([])
      expect(node.id).not.toMatch(/\(.+\)$/)
    }
  })

  it('without manifests + non-workspace graph: enrich is a no-op', () => {
    const graph = parseFixtureGraph('simple')
    const result = enrich(graph)
    expect(graphSnapshot(result.graph)).toEqual(graphSnapshot(graph))
    expect(result.diagnostics).toEqual([])
  })

  it('manifests-driven enrich tags workspace members c workspacePath', () => {
    const graph = parseFixtureGraph('workspaces-basic')
    const result = enrich(graph, {
      manifests: {
        '': {
          name: 'case-workspaces-basic',
          version: '0.0.0',
          dependencies: { '@case-ws/a': 'workspace:*' },
        },
        'packages/a': { name: '@case-ws/a', version: '0.0.0' },
        'packages/b': { name: '@case-ws/b', version: '0.0.0' },
      },
    })
    const memberA = result.graph.getNode('@case-ws/a@0.0.0')
    const memberB = result.graph.getNode('@case-ws/b@0.0.0')
    expect(memberA?.workspacePath).toBe('packages/a')
    expect(memberB?.workspacePath).toBe('packages/b')
  })

  it('idempotent — enrich(enrich(graph)) ≡ enrich(graph)', () => {
    const graph = parseFixtureGraph('peers-basic')
    const once = enrich(graph)
    const twice = enrich(once.graph)
    expect(graphSnapshot(twice.graph)).toEqual(graphSnapshot(once.graph))
    expect(twice.diagnostics).toEqual([])
  })

  it('idempotent on manifest-enriched workspace graph', () => {
    const graph = parseFixtureGraph('workspaces-basic')
    const manifests = {
      '': {
        name: 'case-workspaces-basic',
        version: '0.0.0',
        dependencies: { '@case-ws/a': 'workspace:*' },
      },
      'packages/a': { name: '@case-ws/a', version: '0.0.0' },
    }
    const once = enrich(graph, { manifests })
    const twice = enrich(once.graph, { manifests })
    expect(graphSnapshot(twice.graph)).toEqual(graphSnapshot(once.graph))
  })
})

// === §D Optimize ===========================================================

describe('bun-text — optimize (§D prune unreachable + idempotence)', () => {
  function graphWithOrphan(): Graph {
    const base = parseFixtureGraph('simple')
    return base.mutate(m => {
      m.addNode({ id: 'orphan@9.9.9', name: 'orphan', version: '9.9.9', peerContext: [] })
      m.addEdge('orphan@9.9.9', 'orphan@9.9.9', 'dep', { range: '9.9.9' })
      m.setTarball({ name: 'orphan', version: '9.9.9' }, { integrity: mkIntegrity('sha512-orphan') })
    }).graph
  }

  function graphWithCyclePair(): Graph {
    const base = parseFixtureGraph('simple')
    return base.mutate(m => {
      m.addNode({ id: 'cycle-a@1.0.0', name: 'cycle-a', version: '1.0.0', peerContext: [] })
      m.addNode({ id: 'cycle-b@1.0.0', name: 'cycle-b', version: '1.0.0', peerContext: [] })
      m.addEdge('cycle-a@1.0.0', 'cycle-b@1.0.0', 'dep', { range: '1.0.0' })
      m.addEdge('cycle-b@1.0.0', 'cycle-a@1.0.0', 'dep', { range: '1.0.0' })
      m.setTarball({ name: 'cycle-a', version: '1.0.0' }, { integrity: mkIntegrity('sha512-cycle-a') })
      m.setTarball({ name: 'cycle-b', version: '1.0.0' }, { integrity: mkIntegrity('sha512-cycle-b') })
    }).graph
  }

  it('prunes a self-loop orphan и its tarball', () => {
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

  it('prunes a mutual cycle и its tarballs', () => {
    const graph = graphWithCyclePair()
    const result = optimize(graph)
    expect(result.graph.getNode('cycle-a@1.0.0')).toBeUndefined()
    expect(result.graph.getNode('cycle-b@1.0.0')).toBeUndefined()
  })

  it('idempotent — optimize(optimize(graph)) ≡ optimize(graph)', () => {
    const once = optimize(graphWithOrphan())
    const twice = optimize(once.graph)
    expect(graphSnapshot(twice.graph)).toEqual(graphSnapshot(once.graph))
    expect(twice.diagnostics).toEqual(once.diagnostics)
  })

  it('preserves every reachable node + tarball на a fixture graph', () => {
    const graph = parseFixtureGraph('peers-basic')
    const result = optimize(graph)
    expect(graphSnapshot(result.graph)).toEqual(graphSnapshot(graph))
    expect(Array.from(result.graph.tarballs(), ([k]) => k)).toEqual(
      Array.from(graph.tarballs(), ([k]) => k),
    )
  })

  it('survives stringify/parse roundtrip composition с re-enrich (§A.4 + §C/§D)', () => {
    const base = parseFixtureGraph('peers-basic')
    const enriched = enrich(base)
    const optimized = optimize(enriched.graph)
    const reparsed = enrich(parse(stringify(optimized.graph)))
    expect(graphSnapshot(reparsed.graph)).toEqual(graphSnapshot(optimized.graph))
    expectEmptyGraphDiff(optimized.graph.diff(reparsed.graph))
  })
})

// === Top-level fidelity blocks (overrides / trusted / patched) ==============
//
// ADR-0025 §3 carrier + audit-fix write path. bun's `overrides` is the
// npm/bun analog of yarn `resolutions` — the mechanism an audit-fix uses to
// force a transitive vulnerable dep onto a safe version. These blocks were
// silently dropped on round-trip before this slice; the tests below pin the
// verbatim same-PM carrier, the caller-`options.overrides` projection, and
// the cross-PM canonical read.

describe('bun-text — top-level fidelity blocks (overrides / trusted / patched)', () => {
  const withBlocks = (extra: Record<string, unknown>): string =>
    JSON.stringify(
      {
        lockfileVersion: 1,
        workspaces: { '': { name: 'root', dependencies: { lodash: '^4.17.20' } } },
        ...extra,
        packages: {
          lodash: ['lodash@4.17.21', '', {}, sriOf('lodash')],
        },
      },
      null,
      2,
    )

  it('round-trips a verbatim `overrides` block (flat npm-shaped, parse-time order)', () => {
    const input = withBlocks({ overrides: { lodash: '4.17.21', '@types/node': '20.0.0' } })
    const out = stringify(parse(input))
    expect(out).toContain('"overrides"')
    expect(out).toMatch(/"overrides":\s*\{/)
    expect(out).toContain('"lodash": "4.17.21"')
    expect(out).toContain('"@types/node": "20.0.0"')
    // overrides sits between workspaces and packages (bun's key order).
    expect(out.indexOf('"overrides"')).toBeGreaterThan(out.indexOf('"workspaces"'))
    expect(out.indexOf('"overrides"')).toBeLessThan(out.indexOf('"packages"'))
  })

  it('round-trips `trustedDependencies` and `patchedDependencies`', () => {
    const input = withBlocks({
      trustedDependencies: ['esbuild', 'core-js'],
      patchedDependencies: { 'lodash@4.17.21': 'patches/lodash.patch' },
    })
    const out = stringify(parse(input))
    expect(out).toContain('"trustedDependencies"')
    expect(out).toContain('"esbuild"')
    expect(out).toContain('"patchedDependencies"')
    expect(out).toContain('"lodash@4.17.21": "patches/lodash.patch"')
  })

  it('absent blocks stay absent (no fabrication)', () => {
    const out = stringify(parse(withBlocks({})))
    expect(out).not.toContain('"overrides"')
    expect(out).not.toContain('"trustedDependencies"')
    expect(out).not.toContain('"patchedDependencies"')
  })

  it('caller `options.overrides` (canonical) projects into the emitted block — audit-fix write path', () => {
    const graph = parse(withBlocks({}))
    const out = stringify(graph, {
      overrides: [{ package: 'lodash', to: '4.17.21' }],
    })
    expect(out).toContain('"overrides"')
    expect(out).toContain('"lodash": "4.17.21"')
  })

  it('caller `options.overrides: []` suppresses the verbatim carrier', () => {
    const graph = parse(withBlocks({ overrides: { lodash: '4.17.21' } }))
    const out = stringify(graph, { overrides: [] })
    expect(out).not.toContain('"overrides"')
  })

  it('exposes captured overrides as canonical constraints for cross-PM reads', () => {
    const graph = parse(withBlocks({ overrides: { lodash: '4.17.21' } }))
    const canonical = getBunOverridesCanonical(graph)
    expect(canonical).toEqual([{ package: 'lodash', to: '4.17.21' }])
  })

  it('preserves blocks across optimize() (sidecar re-attached, blocks are project-global)', () => {
    // optimize re-attaches a pruned sidecar via rememberSidecar; the top-level
    // blocks are project-global (not per-node) so they survive verbatim.
    const graph = parse(
      withBlocks({ overrides: { lodash: '4.17.21' }, trustedDependencies: ['esbuild'] }),
    )
    const pruned = optimize(graph)
    const out = stringify(pruned.graph)
    expect(out).toContain('"overrides"')
    expect(out).toContain('"lodash": "4.17.21"')
    expect(out).toContain('"trustedDependencies"')
  })

  it('preserves the real-world oven-sh/bun `overrides` block on round-trip', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const realWorld = resolve(
      here,
      '../resources/fixtures/real-world/oven-sh-bun-main-3a79bd7/bun.lock',
    )
    const input = readFileSync(realWorld, 'utf8')
    const out = stringify(parse(input))
    // The fixture carries `{ "@types/node": "25.0.0", ... }` — must survive.
    expect(out).toContain('"overrides"')
    expect(out).toContain('"@types/node": "25.0.0"')
  })
})

// === Coverage supplement: error paths, rare branches, internal helpers ======
//
// Every test feeds a KNOWN input and asserts a SPECIFIC correct observable: a
// thrown LockfileError code, an emitted diagnostic, an exact emitted string, or
// an exact helper return value.

// A valid 88-char sha512 SRI (borrowed from the real `ms@2.1.3` fixture entry)
// so integrity survives parse instead of being dropped as invalid-length.
const MS_SRI =
  'sha512-6FlzubTLZG3J2a/NVCAleEhjzq5oxgHyaCU9yYXvcLsvoVaHJq/s5xXI6/XXP6tz7R9xAOtHnSO/tXtF3WRTlA=='

const lockJson = (extra: Record<string, unknown>): string =>
  JSON.stringify({
    lockfileVersion: 1,
    workspaces: { '': { name: 'root', version: '0.0.0' } },
    ...extra,
  })

describe('parse', () => {
  it('rejects a lockfile with no `packages` block (FORMAT_MISMATCH)', () => {
    let err: unknown
    try {
      parse(lockJson({ workspaces: { '': { name: 'root' } } }))
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(LockfileError)
    expect((err as LockfileError).code).toBe('FORMAT_MISMATCH')
    expect((err as LockfileError).message).toContain('missing required `packages` block')
  })

  it('rejects a non-object `packages` value (FORMAT_MISMATCH)', () => {
    let err: unknown
    try {
      parse(JSON.stringify({ lockfileVersion: 1, workspaces: { '': {} }, packages: 5 }))
    } catch (e) {
      err = e
    }
    expect((err as LockfileError).code).toBe('FORMAT_MISMATCH')
  })

  it('rejects a top-level JSON array via parseJsonc (FORMAT_MISMATCH)', () => {
    let err: unknown
    try {
      parse('[1, 2, 3]')
    } catch (e) {
      err = e
    }
    expect((err as LockfileError).code).toBe('FORMAT_MISMATCH')
    expect((err as LockfileError).message).toContain('top-level value must be a JSON object')
  })

  it('rejects a top-level JSON scalar via parseJsonc (FORMAT_MISMATCH)', () => {
    let err: unknown
    try {
      parse('42')
    } catch (e) {
      err = e
    }
    expect((err as LockfileError).code).toBe('FORMAT_MISMATCH')
    expect((err as LockfileError).message).toContain('top-level value must be a JSON object')
  })

  it('emits one BUN_TEXT_BAD_ENTRY diagnostic per malformed `packages` shape with the correct message', () => {
    const graph = parse(
      lockJson({
        packages: {
          empty: [], // len 0 -> "is not a positional tuple"
          numid: [42, '', {}, ''], // non-string id token -> "missing id token"
          badws: ['@workspace:x'], // len 1, unparseable ws-ref (empty name) -> "unparseable; skipping"
          noat: ['noatsign', '', {}, ''], // len 4, unparseable package id -> "unparseable; skipping"
          lodash: ['lodash@4.17.21', '', {}, ''], // one good entry so the graph still seals
        },
      }),
    )
    const diags = graph
      .diagnostics()
      .filter((d) => d.code === 'BUN_TEXT_BAD_ENTRY')
      .map((d) => d.message)
      .sort()
    expect(diags).toEqual(
      [
        'bun-text entry "empty" is not a positional tuple; skipping',
        'bun-text entry "numid" missing id token',
        'bun-text id "noatsign" unparseable; skipping',
        'bun-text workspace-ref "@workspace:x" unparseable; skipping',
      ].sort(),
    )
  })

  it('marks all BAD_ENTRY diagnostics as warnings and still parses the good entry', () => {
    const graph = parse(
      lockJson({
        packages: {
          empty: [],
          numid: [42, '', {}, ''],
          badws: ['@workspace:x'],
          noat: ['noatsign', '', {}, ''],
          lodash: ['lodash@4.17.21', '', {}, ''],
        },
      }),
    )
    for (const d of graph.diagnostics().filter((x) => x.code === 'BUN_TEXT_BAD_ENTRY')) {
      expect(d.severity).toBe('warning')
    }
    // The one well-formed entry became a node; the skipped ones did not.
    expect(graph.getNode('lodash@4.17.21')).toBeDefined()
    expect(graph.getNode('noatsign@')).toBeUndefined()
  })

  it('registers a workspace member that appears only in the workspaces map', () => {
    // `lonely` has a manifest in `workspaces` but no `packages` entry: the
    // pre-register loop must synthesise the node + tag its workspacePath.
    const graph = parse(
      lockJson({
        workspaces: {
          '': { name: 'root' },
          'packages/lonely': { name: 'lonely', version: '2.0.0' },
        },
        packages: {},
      }),
    )
    const node = graph.getNode('lonely@2.0.0')
    expect(node).toBeDefined()
    expect(node?.workspacePath).toBe('packages/lonely')
    expect(node?.version).toBe('2.0.0')
  })

  it('skips a workspaces-map member whose manifest has no usable name', () => {
    const graph = parse(
      lockJson({
        workspaces: {
          '': { name: 'root' },
          'packages/nameless': { name: '', version: '9.9.9' },
        },
        packages: {},
      }),
    )
    expect(Array.from(graph.nodes(), (n) => n.id)).toEqual(['root@0.0.0'])
  })

  it('defaults a missing member version to 0.0.0', () => {
    const graph = parse(
      lockJson({
        workspaces: {
          '': { name: 'root' },
          'packages/noversion': { name: 'noversion' },
        },
        packages: {},
      }),
    )
    expect(graph.getNode('noversion@0.0.0')?.workspacePath).toBe('packages/noversion')
  })

  it('wraps a duplicate-edge seal failure as a PARSE_FAILED LockfileError', () => {
    // The root's dep `lodash` is declared BOTH in `workspaces[''].dependencies`
    // AND in a regular `root@0.0.0` packages entry's inner block. Both passes
    // emit `root@0.0.0 -dep-> lodash@4.17.21`, so seal() throws a duplicate-edge
    // GraphError, which parse() rewraps.
    const input = JSON.stringify({
      lockfileVersion: 1,
      workspaces: { '': { name: 'root', version: '0.0.0', dependencies: { lodash: '4.17.21' } } },
      packages: {
        lodash: ['lodash@4.17.21', '', {}, ''],
        root: ['root@0.0.0', '', { dependencies: { lodash: '4.17.21' } }, ''],
      },
    })
    let err: unknown
    try {
      parse(input)
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(LockfileError)
    expect((err as LockfileError).code).toBe('PARSE_FAILED')
    expect((err as LockfileError).message).toContain('bun-text seal failed')
    expect((err as LockfileError).message).toContain('duplicate edge')
  })

  it('strips line + block comments and honors escaped quotes inside strings', () => {
    // The name `roo"t` carries an escaped quote that must survive the
    // string-state machine intact.
    const input = [
      '{',
      '  // a leading line comment',
      '  "lockfileVersion": 1,',
      '  /* a block',
      '     comment spanning two lines */',
      '  "workspaces": { "": { "name": "roo\\"t" } },', // escaped quote in the name
      '  "packages": {',
      '    "lodash": ["lodash@4.17.21", "", {}, ""],', // trailing comma before `}`
      '  },',
      '}',
    ].join('\n')
    const graph = parse(input)
    // The escaped quote survived the strip: the root name is literally `roo"t`.
    expect(graph.getNode('roo"t@0.0.0')?.name).toBe('roo"t')
    expect(graph.getNode('lodash@4.17.21')).toBeDefined()
  })

  it('does not treat `//` or `/*` inside a string value as a comment', () => {
    // A URL-ish range proves the string body is preserved verbatim.
    const input = JSON.stringify({
      lockfileVersion: 1,
      workspaces: { '': { name: 'root', dependencies: { dep: 'https://x/*y' } } },
      packages: { lodash: ['lodash@4.17.21', '', {}, ''] },
    })
    // The `https://x/*y` range contains both `//` and `/*`; parse must not
    // mangle it (it surfaces as an unresolved-dep range verbatim).
    const graph = parse(input)
    const unresolved = graph
      .diagnostics()
      .find((d) => d.code === 'BUN_TEXT_UNRESOLVED_DEP')
    expect(unresolved?.message).toContain('https://x/*y')
  })
})

describe('stringify', () => {
  it('preserves a nested-object override and emits it as a nested block', () => {
    const input = JSON.stringify({
      lockfileVersion: 1,
      workspaces: { '': { name: 'root', dependencies: { lodash: '^4' } } },
      overrides: { lodash: '4.17.21', nested: { foo: '1.0.0' } },
      packages: { lodash: ['lodash@4.17.21', '', {}, ''] },
    })
    const out = stringify(parse(input))
    // Flat scalar override.
    expect(out).toContain('"lodash": "4.17.21"')
    // Nested object override recurses through renderObject (not inlined).
    expect(out).toMatch(/"nested":\s*\{\s*\n\s*"foo": "1\.0\.0",/)
    // overrides sits between workspaces and packages.
    expect(out.indexOf('"overrides"')).toBeGreaterThan(out.indexOf('"workspaces"'))
    expect(out.indexOf('"overrides"')).toBeLessThan(out.indexOf('"packages"'))
  })
})

describe('enrich', () => {
  it('replaces a tarball-less regular node into a workspace member', () => {
    // `mypkg` parses as a regular package WITHOUT integrity (no tarball). A
    // manifest naming it a workspace member re-tags the existing node.
    const graph = parse(
      JSON.stringify({
        lockfileVersion: 1,
        workspaces: { '': { name: 'root', version: '0.0.0', dependencies: { mypkg: '2.0.0' } } },
        packages: { mypkg: ['mypkg@2.0.0', '', {}, ''] },
      }),
    )
    // Precondition: no tarball, so the replacement guard does NOT skip.
    expect(graph.tarball({ name: 'mypkg', version: '2.0.0' })).toBeUndefined()
    const result = enrich(graph, {
      manifests: {
        '': { name: 'root' },
        'packages/mypkg': { name: 'mypkg', version: '2.0.0' },
      },
    })
    expect(result.graph.getNode('mypkg@2.0.0')?.workspacePath).toBe('packages/mypkg')
  })

  it('adds a brand-new workspace member node absent from the graph', () => {
    const graph = parse(
      JSON.stringify({
        lockfileVersion: 1,
        workspaces: { '': { name: 'root', version: '0.0.0', dependencies: { lodash: '4.17.21' } } },
        packages: { lodash: ['lodash@4.17.21', '', {}, MS_SRI] },
      }),
    )
    const result = enrich(graph, {
      manifests: {
        '': { name: 'root' },
        'packages/featx': { name: 'featx', version: '3.0.0' },
      },
    })
    const added = result.graph.getNode('featx@3.0.0')
    expect(added).toBeDefined()
    expect(added?.workspacePath).toBe('packages/featx')
    expect(added?.version).toBe('3.0.0')
    // The tarball-bearing lodash node is untouched (the replacement guard skipped it).
    expect(result.graph.getNode('lodash@4.17.21')?.workspacePath).toBeUndefined()
  })

  it('re-tags an existing member node whose manifest path differs', () => {
    // `@case-ws/a` parses as a workspace member at `packages/a`. A manifest that
    // maps the SAME name@version to a DIFFERENT path is skipped by the first
    // loop and re-tagged by the second loop's existing-node branch.
    const graph = parse(
      JSON.stringify({
        lockfileVersion: 1,
        workspaces: {
          '': { name: 'root', version: '0.0.0' },
          'packages/a': { name: '@case-ws/a', version: '0.0.0' },
        },
        packages: { '@case-ws/a': ['@case-ws/a@workspace:packages/a'] },
      }),
    )
    expect(graph.getNode('@case-ws/a@0.0.0')?.workspacePath).toBe('packages/a')
    const result = enrich(graph, {
      manifests: {
        '': { name: 'root' },
        // Same member name+version, relocated to `apps/a`.
        'apps/a': { name: '@case-ws/a', version: '0.0.0' },
      },
    })
    expect(result.graph.getNode('@case-ws/a@0.0.0')?.workspacePath).toBe('apps/a')
  })

  it('leaves an already-correctly-tagged member untouched', () => {
    const graph = parse(
      JSON.stringify({
        lockfileVersion: 1,
        workspaces: {
          '': { name: 'root', version: '0.0.0' },
          'packages/a': { name: '@case-ws/a', version: '0.0.0' },
        },
        packages: { '@case-ws/a': ['@case-ws/a@workspace:packages/a'] },
      }),
    )
    const result = enrich(graph, {
      manifests: {
        '': { name: 'root' },
        'packages/a': { name: '@case-ws/a', version: '0.0.0' }, // same path -> no-op
      },
    })
    expect(result.graph.getNode('@case-ws/a@0.0.0')?.workspacePath).toBe('packages/a')
  })

  it('re-attaches the sidecar so a subsequent stringify still emits members', () => {
    const graph = parse(
      JSON.stringify({
        lockfileVersion: 1,
        workspaces: { '': { name: 'root', version: '0.0.0', dependencies: { lodash: '4.17.21' } } },
        packages: { lodash: ['lodash@4.17.21', '', {}, MS_SRI] },
      }),
    )
    const result = enrich(graph, {
      manifests: { '': { name: 'root' }, 'packages/featx': { name: 'featx', version: '3.0.0' } },
    })
    const out = stringify(result.graph)
    expect(out).toContain('["featx@workspace:packages/featx"]')
  })
})

describe('optimize', () => {
  it('prunes an unreachable mutual cycle from a fresh parse and keeps the reachable tree', () => {
    // cyc-a<->cyc-b reference each other and nothing else references them; each
    // has an incoming edge so neither is a root -> both unreachable from root.
    // Parsing directly (no mutate) keeps the sidecar on the graph so optimize
    // runs pruneSidecar.
    const graph = parse(
      JSON.stringify({
        lockfileVersion: 1,
        workspaces: { '': { name: 'root', version: '0.0.0', dependencies: { lodash: '4.17.21' } } },
        packages: {
          lodash: ['lodash@4.17.21', '', {}, MS_SRI],
          'cyc-a': ['cyc-a@1.0.0', '', { dependencies: { 'cyc-b': '1.0.0' } }, MS_SRI],
          'cyc-b': ['cyc-b@1.0.0', '', { dependencies: { 'cyc-a': '1.0.0' } }, MS_SRI],
        },
      }),
    )
    // Preconditions: cyc nodes are non-roots (they have incoming edges).
    expect(Array.from(graph.roots())).toEqual(['root@0.0.0'])

    const result = optimize(graph)
    expect(result.graph.getNode('cyc-a@1.0.0')).toBeUndefined()
    expect(result.graph.getNode('cyc-b@1.0.0')).toBeUndefined()
    expect(result.graph.getNode('lodash@4.17.21')).toBeDefined()

    // Sidecar re-attached: stringify still emits lodash, not the cycle.
    const out = stringify(result.graph)
    expect(out).toContain('lodash@4.17.21')
    expect(out).not.toContain('cyc-a')
  })

  it('drops pruned-node peer declarations but keeps surviving ones', () => {
    // cyc-a declares a peer dep -> peerDeclarations has `cyc-a@1.0.0|leftpad`.
    // lodash declares a peer dep -> `lodash@4.17.21|tslib`. After pruning the
    // cycle, pruneSidecar's peerDeclarations filter must drop the cyc-a entry
    // (src unreachable) and keep the lodash entry (src survives). The kept
    // declaration re-surfaces in lodash's emitted inner peerDependencies block.
    const graph = parse(
      JSON.stringify({
        lockfileVersion: 1,
        workspaces: { '': { name: 'root', version: '0.0.0', dependencies: { lodash: '4.17.21' } } },
        packages: {
          lodash: ['lodash@4.17.21', '', { peerDependencies: { tslib: '^2.0.0' } }, MS_SRI],
          tslib: ['tslib@2.6.0', '', {}, MS_SRI],
          'cyc-a': [
            'cyc-a@1.0.0',
            '',
            { dependencies: { 'cyc-b': '1.0.0' }, peerDependencies: { leftpad: '^1.0.0' } },
            MS_SRI,
          ],
          'cyc-b': ['cyc-b@1.0.0', '', { dependencies: { 'cyc-a': '1.0.0' } }, MS_SRI],
        },
      }),
    )
    const result = optimize(graph)
    expect(result.graph.getNode('cyc-a@1.0.0')).toBeUndefined()

    const out = stringify(result.graph)
    // The surviving lodash peer declaration is preserved through the prune.
    expect(out).toContain('"peerDependencies": { "tslib": "^2.0.0" }')
    // The pruned cyc-a's peer declaration is gone (no leftpad anywhere).
    expect(out).not.toContain('leftpad')
  })
})

describe('resolveOverridesBlock', () => {
  const collect = () => {
    const diags: Diagnostic[] = []
    return { diags, emit: (d: Diagnostic) => diags.push(d) }
  }

  it('projects a canonical-only sidecar (no nativeOverrides) via the npm grammar', () => {
    // callerOverrides undefined, nativeOverrides undefined, but a
    // canonicalOverrides carrier present -> project through npm grammar.
    const { emit } = collect()
    const block = resolveOverridesBlock(
      undefined,
      // Minimal sidecar shape: only canonicalOverrides set.
      { canonicalOverrides: [{ package: 'lodash', to: '4.17.21' }] } as never,
      emit,
    )
    expect(block).toEqual({ lodash: '4.17.21' })
  })

  it('lets caller overrides take precedence over any sidecar carrier', () => {
    const { emit } = collect()
    const block = resolveOverridesBlock(
      [{ package: 'left-pad', to: '1.3.0' }],
      { nativeOverrides: { lodash: '4.17.21' } } as never,
      emit,
    )
    expect(block).toEqual({ 'left-pad': '1.3.0' })
  })

  it('suppresses the carrier on an explicit empty caller-overrides array', () => {
    const { emit } = collect()
    const block = resolveOverridesBlock(
      [],
      { nativeOverrides: { lodash: '4.17.21' } } as never,
      emit,
    )
    expect(block).toBeUndefined()
  })

  it('returns the verbatim nativeOverrides when no caller override is given', () => {
    const { emit } = collect()
    const native = { lodash: '4.17.21', '@types/node': '20.0.0' }
    const block = resolveOverridesBlock(undefined, { nativeOverrides: native } as never, emit)
    expect(block).toBe(native)
  })

  it('returns undefined when nothing carries overrides', () => {
    const { emit } = collect()
    expect(resolveOverridesBlock(undefined, undefined, emit)).toBeUndefined()
    expect(resolveOverridesBlock(undefined, {} as never, emit)).toBeUndefined()
  })
})

describe('renderInlineValue', () => {
  it('renders JSON scalars in their canonical inline form', () => {
    expect(renderInlineValue(null)).toBe('null')
    expect(renderInlineValue(true)).toBe('true')
    expect(renderInlineValue(false)).toBe('false')
    expect(renderInlineValue(42)).toBe('42')
    expect(renderInlineValue('a"b')).toBe('"a\\"b"')
  })

  it('renders a non-finite number as null', () => {
    // JSON cannot carry Infinity/NaN, so this defensive branch is only
    // reachable by feeding the emitter a non-finite number directly.
    expect(renderInlineValue(Number.POSITIVE_INFINITY)).toBe('null')
    expect(renderInlineValue(Number.NaN)).toBe('null')
  })

  it('renders a nested array inline', () => {
    expect(renderInlineValue([1, 'x', true])).toBe('[1, "x", true]')
    expect(renderInlineValue([])).toBe('[]')
  })

  it('renders a nested object inline via renderInlineObject', () => {
    expect(renderInlineValue({})).toBe('{}')
    expect(renderInlineValue({ bin: 'cli.js', name: 'x' })).toBe(
      '{ "bin": "cli.js", "name": "x" }',
    )
  })

  it('renders an unsupported value type as null', () => {
    // undefined / bigint fall through every typed branch to the trailing
    // `return 'null'`.
    expect(renderInlineValue(undefined)).toBe('null')
    expect(renderInlineValue(10n)).toBe('null')
  })
})

describe('renderValue', () => {
  it('routes an array to the inline tuple emitter', () => {
    expect(renderValue(['a@1.0.0', '', {}, ''], 0, false)).toBe('["a@1.0.0", "", {}, ""]')
  })

  it('routes an object to renderObject with trailing commas', () => {
    // Non-top-level object -> multi-line, every entry trailing-comma terminated.
    expect(renderValue({ a: 1 }, 0, false)).toBe('{\n  "a": 1,\n}')
  })

  it('routes a scalar to renderInlineValue', () => {
    expect(renderValue('x', 0, false)).toBe('"x"')
    expect(renderValue(7, 0, false)).toBe('7')
    expect(renderValue(null, 0, false)).toBe('null')
  })
})

describe('addBlockEdges', () => {
  // Small helper: run addBlockEdges against a real builder + minimal node table.
  // `srcNode` is the block-bearing source; `extraNodes` are the edge targets.
  const runOnBuilder = (
    srcNode: { id: string; name: string; version: string; peerContext?: string[]; workspacePath?: string },
    blocks: Record<string, Record<string, string>>,
    byName: Map<string, string>,
    workspaceByPath: Map<string, string> | undefined,
    extraNodes: Array<{ id: string; name: string; version: string; workspacePath?: string }>,
  ) => {
    const builder = newBuilder()
    builder.addNode({ peerContext: [], ...srcNode })
    for (const n of extraNodes) builder.addNode({ ...n, peerContext: [] })
    const diags: Diagnostic[] = []
    const peerDecls = new Map<string, string>()
    addBlockEdges(builder, diags, srcNode.id, blocks, byName, workspaceByPath, peerDecls)
    return { builder, diags, peerDecls }
  }

  it('stamps workspaceRange without resolvedVersion when the target version is empty', () => {
    // A workspace member whose NodeId carries an EMPTY version (`member@`) makes
    // nodeVersionOf return '' -> the else branch omits resolvedVersion. The src
    // is itself a workspace node so the ws->ws edge is permitted at seal.
    const workspaceByPath = new Map<string, string>([
      ['', 'root@1.0.0'],
      ['packages/m', 'member@'], // empty version segment
    ])
    const { builder } = runOnBuilder(
      { id: 'root@1.0.0', name: 'root', version: '1.0.0', workspacePath: '' },
      { dependencies: { member: 'workspace:*' } },
      new Map(),
      workspaceByPath,
      [{ id: 'member@', name: 'member', version: '', workspacePath: 'packages/m' }],
    )
    const graph = builder.seal()
    const edge = graph.out('root@1.0.0', 'dep').find((e) => e.dst === 'member@')
    expect(edge).toBeDefined()
    expect(edge?.attrs?.workspace).toBe(true)
    // Empty target version -> coarse specifier, no resolvedVersion key.
    expect(edge?.attrs?.workspaceRange).toEqual({ specifier: 'workspace:*' })
  })

  it('stamps resolvedVersion when the target version is present', () => {
    const workspaceByPath = new Map<string, string>([
      ['', 'root@1.0.0'],
      ['packages/m', 'member@2.5.0'],
    ])
    const { builder } = runOnBuilder(
      { id: 'root@1.0.0', name: 'root', version: '1.0.0', workspacePath: '' },
      { dependencies: { member: 'workspace:^' } },
      new Map(),
      workspaceByPath,
      [{ id: 'member@2.5.0', name: 'member', version: '2.5.0', workspacePath: 'packages/m' }],
    )
    const graph = builder.seal()
    const edge = graph.out('root@1.0.0', 'dep').find((e) => e.dst === 'member@2.5.0')
    expect(edge?.attrs?.workspaceRange).toEqual({
      specifier: 'workspace:*',
      resolvedVersion: '2.5.0',
    })
    // The verbatim source-side range survives in attrs.range for same-format roundtrip.
    expect(edge?.attrs?.range).toBe('workspace:^')
  })

  it('emits BUN_TEXT_UNRESOLVED_DEP for a non-workspace dep with no index entry', () => {
    // byName has no `ghost` mapping and the range is not workspace:.
    const { diags } = runOnBuilder(
      { id: 'host@1.0.0', name: 'host', version: '1.0.0' },
      { dependencies: { ghost: '^1.0.0' } },
      new Map(), // empty index
      undefined,
      [],
    )
    const unresolved = diags.filter((d) => d.code === 'BUN_TEXT_UNRESOLVED_DEP')
    expect(unresolved).toHaveLength(1)
    expect(unresolved[0]?.severity).toBe('warning')
    expect(unresolved[0]?.subject).toBe('host@1.0.0')
    expect(unresolved[0]?.message).toBe('host@1.0.0: unresolved dep ghost@^1.0.0')
  })

  it('swallows an INVARIANT_VIOLATION from addEdge and continues', () => {
    // The real builder never throws INVARIANT_VIOLATION from addEdge (it defers
    // to seal), so drive the defensive catch with a stub builder whose addEdge
    // throws that exact code. The helper must NOT propagate it.
    let calls = 0
    const stub = {
      addNode() {},
      addEdge() {
        calls++
        throw new GraphError('INVARIANT_VIOLATION', 'synthetic duplicate edge')
      },
      setTarball() {},
      diagnostic() {},
      layoutHints() {},
      seal() {
        throw new Error('unused')
      },
    }
    const diags: Diagnostic[] = []
    expect(() =>
      addBlockEdges(
        stub as never,
        diags,
        'host@1.0.0',
        { dependencies: { dep: '1.0.0' } },
        new Map([['dep', 'dep@1.0.0']]),
        undefined,
        new Map(),
      ),
    ).not.toThrow()
    expect(calls).toBe(1)
  })

  it('re-throws a non-INVARIANT_VIOLATION error from addEdge', () => {
    // A PATCH_REJECTED (or any other) GraphError must propagate, not be swallowed.
    const stub = {
      addNode() {},
      addEdge() {
        throw new GraphError('PATCH_REJECTED', 'synthetic patch rejection')
      },
      setTarball() {},
      diagnostic() {},
      layoutHints() {},
      seal() {
        throw new Error('unused')
      },
    }
    expect(() =>
      addBlockEdges(
        stub as never,
        [],
        'host@1.0.0',
        { dependencies: { dep: '1.0.0' } },
        new Map([['dep', 'dep@1.0.0']]),
        undefined,
        new Map(),
      ),
    ).toThrow(/synthetic patch rejection/)
  })

  it('stashes peer ranges declaratively instead of emitting peer edges', () => {
    const { builder, peerDecls } = runOnBuilder(
      { id: 'host@1.0.0', name: 'host', version: '1.0.0' },
      { peerDependencies: { react: '^18.0.0' } },
      new Map([['react', 'react@18.2.0']]),
      undefined,
      [{ id: 'react@18.2.0', name: 'react', version: '18.2.0' }],
    )
    // No peer EDGE emitted...
    const graph = builder.seal()
    expect(graph.out('host@1.0.0', 'peer')).toEqual([])
    // ...but the range is recorded in the declarations map.
    expect(peerDecls.get('host@1.0.0|react')).toBe('^18.0.0')
  })
})

describe('buildWorkspaceManifest', () => {
  const graphWith = (
    nodes: Array<{ id: string; name: string; version: string; peerContext?: string[]; workspacePath?: string }>,
    edges: Array<{ src: string; dst: string; kind: EdgeKind; attrs?: Record<string, unknown> }>,
  ) => {
    const b = newBuilder()
    for (const n of nodes) b.addNode({ peerContext: [], ...n })
    for (const e of edges) b.addEdge(e.src, e.dst, e.kind, e.attrs as never)
    return b.seal()
  }

  it('falls back to the sidecar manifest name/version + dep blocks when the node is absent', () => {
    // workspaceNode undefined but a sidecarManifest is present -> pull name,
    // version, and every dep block straight from the sidecar.
    const emptyGraph = graphWith(
      [{ id: 'root@0.0.0', name: 'root', version: '0.0.0', workspacePath: '' }],
      [],
    )
    const manifest = {
      name: 'legacy-member',
      version: '4.2.0',
      dependencies: { lodash: '^4.17.0' },
      devDependencies: { typescript: '^5.0.0' },
      optionalDependencies: { fsevents: '^2.3.0' },
      peerDependencies: { react: '^18.0.0' },
    }
    const out = buildWorkspaceManifest(emptyGraph, undefined, manifest)
    expect(out).toEqual({
      name: 'legacy-member',
      version: '4.2.0',
      dependencies: { lodash: '^4.17.0' },
      devDependencies: { typescript: '^5.0.0' },
      optionalDependencies: { fsevents: '^2.3.0' },
      peerDependencies: { react: '^18.0.0' },
    })
  })

  it('returns an empty manifest when neither a node nor a sidecar manifest is given', () => {
    const g = graphWith([{ id: 'root@0.0.0', name: 'root', version: '0.0.0', workspacePath: '' }], [])
    expect(buildWorkspaceManifest(g, undefined, undefined)).toEqual({})
  })

  it('emits a peerDependencies block from a peer edge and drops a bundled edge', () => {
    // A workspace node with a peer edge -> the edge.kind==='peer' arm routes the
    // range into the peerDependencies bucket. A `bundled` edge falls through to
    // the `: undefined` arm (no bun manifest block for bundled) and is skipped.
    const graph = graphWith(
      [
        { id: 'root@0.0.0', name: 'root', version: '0.0.0', workspacePath: '' },
        { id: 'peerdep@1.0.0', name: 'peerdep', version: '1.0.0' },
        { id: 'bundledep@1.0.0', name: 'bundledep', version: '1.0.0' },
        {
          id: 'wsa@1.0.0(peerdep@1.0.0)',
          name: 'wsa',
          version: '1.0.0',
          peerContext: ['peerdep@1.0.0'],
          workspacePath: 'packages/a',
        },
      ],
      [
        { src: 'wsa@1.0.0(peerdep@1.0.0)', dst: 'peerdep@1.0.0', kind: 'peer', attrs: { range: '^1.0.0' } },
        { src: 'wsa@1.0.0(peerdep@1.0.0)', dst: 'bundledep@1.0.0', kind: 'bundled', attrs: { range: '1.0.0' } },
      ],
    )
    const wsNode = graph.getNode('wsa@1.0.0(peerdep@1.0.0)')!
    const out = buildWorkspaceManifest(graph, wsNode, undefined)
    expect(out.name).toBe('wsa')
    expect(out.version).toBe('1.0.0')
    expect(out.peerDependencies).toEqual({ peerdep: '^1.0.0' })
    // No dep/dev/optional blocks materialised; the bundled edge produced nothing.
    expect(out.dependencies).toBeUndefined()
    expect(out.devDependencies).toBeUndefined()
    expect(out.optionalDependencies).toBeUndefined()
  })
})

describe('buildInnerBlock', () => {
  it('routes dep/peer edges into inner blocks and drops a bundled edge', () => {
    const b = newBuilder()
    b.addNode({ id: 'root@0.0.0', name: 'root', version: '0.0.0', peerContext: [], workspacePath: '' })
    b.addNode({ id: 'peerdep@1.0.0', name: 'peerdep', version: '1.0.0', peerContext: [] })
    b.addNode({ id: 'bundledep@1.0.0', name: 'bundledep', version: '1.0.0', peerContext: [] })
    // A peer-virt node that is the sole entry for host@1.0.0, carrying a peer edge.
    b.addNode({
      id: 'host@1.0.0(peerdep@1.0.0)',
      name: 'host',
      version: '1.0.0',
      peerContext: ['peerdep@1.0.0'],
    })
    b.addEdge('host@1.0.0(peerdep@1.0.0)', 'peerdep@1.0.0', 'peer', { range: '^1.0.0' })
    b.addEdge('host@1.0.0(peerdep@1.0.0)', 'peerdep@1.0.0', 'dep', { range: '1.0.0' })
    // A bundled edge hits the `: undefined` fallthrough and is skipped.
    b.addEdge('host@1.0.0(peerdep@1.0.0)', 'bundledep@1.0.0', 'bundled', { range: '1.0.0' })
    const graph = b.seal()

    const node = graph.getNode('host@1.0.0(peerdep@1.0.0)')!
    const inner = buildInnerBlock(graph, node, undefined)
    // dep edge -> dependencies; peer edge -> peerDependencies (both to peerdep).
    expect(inner.dependencies).toEqual({ peerdep: '1.0.0' })
    expect(inner.peerDependencies).toEqual({ peerdep: '^1.0.0' })
    // The bundled edge produced no inner block entry.
    expect(inner.optionalDependencies).toBeUndefined()
    expect(JSON.stringify(inner)).not.toContain('bundledep')
  })
})
