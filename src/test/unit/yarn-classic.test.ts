import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const sriOf = (s: string): string => 'sha512-' + createHash('sha512').update(s).digest('base64')
const MODIFIED_SRI = sriOf('modified-ms-integrity')
import { newBuilder, type Diagnostic, type Graph, type GraphDiff } from '../../main/ts/graph.ts'
import { LockfileError } from '../../main/ts/errors.ts'
import { check as checkV4, parse as parseV4 } from '../../main/ts/formats/yarn-berry-v4.ts'
import { check as checkV5, parse as parseV5 } from '../../main/ts/formats/yarn-berry-v5.ts'
import { check as checkV6, parse as parseV6 } from '../../main/ts/formats/yarn-berry-v6.ts'
import { check as checkV8, parse as parseV8 } from '../../main/ts/formats/yarn-berry-v8.ts'
import { check as checkV9, parse as parseV9 } from '../../main/ts/formats/yarn-berry-v9.ts'
import { check, enrich, optimize, parse, stringify } from '../../main/ts/formats/yarn-classic.ts'
import { parse as parseResolution } from '../../main/ts/recipe/resolution.ts'
import { toTarballKey } from '../../main/ts/graph.ts'

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
      integrity: 'sha512-deadbeef',
      resolution: { type: 'unknown', raw: 'foo@patch:foo@npm%3A1.0.0#./.yarn/patches/foo.patch::version=1.0.0' },
    })
    const graph = b.seal()

    const emitted = stringify(graph)

    expect(emitted).not.toContain('resolved "foo@patch:')
    expect(emitted).toContain('foo@1.0.0:')
    expect(emitted).toContain('integrity sha512-deadbeef')
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
      integrity: 'sha512-deadbeef',
      resolution: { type: 'tarball', url: 'https://registry.yarnpkg.com/foo/-/foo-1.0.0.tgz' },
    })
    const graph = b.seal()

    const emitted = stringify(graph)

    expect(emitted).toContain('resolved "https://registry.yarnpkg.com/foo/-/foo-1.0.0.tgz"')
  })

  // Real-world regression (commit 0775b26 / qiwi-mware blocker 2): yarn-berry
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
        resolution: 'https://registry.yarnpkg.com/debug/-/debug-4.4.1.tgz#0000000000000000000000000000000000000000',
      })
    })
    const reparsed = parse(stringify(result.graph))

    expectEmptyGraphDiff(result.graph.diff(reparsed))
    expect(result.applied).toEqual([
      { kind: 'node-added', subject: 'debug@4.4.1' },
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
      m.setTarball({ name: 'ms', version: '2.1.3' }, { integrity: MODIFIED_SRI })
    })
    const reparsed = parse(stringify(result.graph))

    expectEmptyGraphDiff(result.graph.diff(reparsed))
    // ADR-0014 §4.F3 — round-trip parse re-derives canonical resolution.
    expect(reparsed.tarballOf('ms@2.1.3')?.integrity).toBe(MODIFIED_SRI)
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
        resolution: 'https://registry.yarnpkg.com/peer-consumer/-/peer-consumer-1.0.0.tgz#1111111111111111111111111111111111111111',
      })
      m.addEdge('peer-consumer@1.0.0(react@18.2.0)', 'react@18.2.0', 'peer', { range: '^18.2.0' })
    })
    const flattened = original.mutate(m => {
      m.addNode({
        id: 'peer-consumer@1.0.0',
        name: 'peer-consumer',
        version: '1.0.0',
        peerContext: [],
        resolution: 'https://registry.yarnpkg.com/peer-consumer/-/peer-consumer-1.0.0.tgz#1111111111111111111111111111111111111111',
      })
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
      { kind: 'peer-context-replaced', subject: 'react-dom@18.2.0(react@18.2.0)' },
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
      m.setTarball({ name: 'ms', version: '2.1.3', patch }, { integrity: 'sha512-patched-ms-integrity' })
      m.removeTarball({ name: 'ms', version: '2.1.3' })
    })
    const flattened = original.mutate(m => {
      m.setTarball({ name: 'ms', version: '2.1.3' }, { integrity: 'sha512-patched-ms-integrity' })
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
        resolution: 'https://registry.yarnpkg.com/typescript/-/typescript-5.4.5.tgz#0000000000000000000000000000000000000000',
      })
      m.setTarball({ name: 'typescript', version: '5.4.5' }, { integrity: 'sha512-bare' })
      m.addNode({
        id: patchedId,
        name: 'typescript',
        version: '5.4.5',
        peerContext: [],
        patch,
        resolution: 'https://registry.yarnpkg.com/typescript/-/typescript-5.4.5.tgz#0000000000000000000000000000000000000000',
      })
      m.setTarball({ name: 'typescript', version: '5.4.5', patch }, { integrity: 'sha512-patched' })
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
        resolution: 'https://registry.yarnpkg.com/orphan/-/orphan-9.9.9.tgz#0000000000000000000000000000000000000000',
      })
      m.addEdge('orphan@9.9.9', 'orphan@9.9.9', 'dep', { range: '9.9.9' })
      m.setTarball({ name: 'orphan', version: '9.9.9' }, { integrity: 'sha512-orphan' })
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
        resolution: 'https://registry.yarnpkg.com/cycle-a/-/cycle-a-1.0.0.tgz#1111111111111111111111111111111111111111',
      })
      m.addNode({
        id: 'cycle-b@1.0.0',
        name: 'cycle-b',
        version: '1.0.0',
        peerContext: [],
        resolution: 'https://registry.yarnpkg.com/cycle-b/-/cycle-b-1.0.0.tgz#2222222222222222222222222222222222222222',
      })
      m.addEdge('cycle-a@1.0.0', 'cycle-b@1.0.0', 'dep', { range: '1.0.0' })
      m.addEdge('cycle-b@1.0.0', 'cycle-a@1.0.0', 'dep', { range: '1.0.0' })
      m.setTarball({ name: 'cycle-a', version: '1.0.0' }, { integrity: 'sha512-cycle-a' })
      m.setTarball({ name: 'cycle-b', version: '1.0.0' }, { integrity: 'sha512-cycle-b' })
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
        resolution: 'https://registry.yarnpkg.com/orphan-no-tarball/-/orphan-no-tarball-9.9.9.tgz#3333333333333333333333333333333333333333',
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

// Real-world regression edge-case coverage (commit 0775b26): the URL-shape
// filter inside `deriveResolvedFromCanonical` accepts exactly four prefix
// shapes — `https://`, `http://`, `https://codeload.github.com/`, and
// `git+https://`. Other URL-ish shapes (the SCP-form `git@host:owner/repo`
// и `git+ssh://`) get dropped from the `resolved` field; downstream
// `warnPatchDrop` / RECIPE_FEATURE_DROPPED attribute any feature loss. The
// other inline tests already pin the npm-locator + patch-leak cases; this
// block pins the URL-shape gate explicitly across every accepted prefix and
// the rejected git protocols.
describe('yarn-classic — deriveResolvedFromCanonical URL-shape exhaustive coverage', () => {
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

  it('keeps each of the four accepted URL prefixes (https, http, codeload, git+https)', () => {
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

  it('drops non-URL git protocols (git@host:path SCP form, git+ssh://)', () => {
    for (const raw of [
      'git+ssh://git@github.com/owner/repo.git#abcdef1234567890abcdef1234567890abcdef12',
      'git@github.com:owner/repo.git#abcdef1234567890abcdef1234567890abcdef12',
    ]) {
      const emitted = emitFor({ type: 'unknown', raw })
      expect(emitted).not.toContain(`resolved "${raw}"`)
    }
  })
})
