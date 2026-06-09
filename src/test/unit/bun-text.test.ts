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
import { toTarballKey, type Graph } from '../../main/ts/graph.ts'
import { LockfileError } from '../../main/ts/errors.ts'

const sriOf = (s: string): string => 'sha512-' + createHash('sha512').update(s).digest('base64')
const MODIFIED_SRI = sriOf('modified-ms-integrity')
const BUMPED_SRI = sriOf('bumped-ms-integrity')
import { check, enrich, getBunOverridesCanonical, optimize, parse, stringify } from '../../main/ts/formats/bun-text.ts'
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
