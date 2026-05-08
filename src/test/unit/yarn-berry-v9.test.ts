import { describe, expect, it } from 'vitest'
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { newBuilder, type Diagnostic, type Graph, type GraphDiff, type Node } from '../../main/ts/graph.ts'
import { LockfileError } from '../../main/ts/errors.ts'
import { parse, stringify, check, enrich, optimize } from '../../main/ts/formats/yarn-berry-v9.ts'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = (rel: string): string =>
  readFileSync(resolve(here, '../resources/fixtures/lockfiles', rel), 'utf8')
const templateDir = (rel: string): string =>
  resolve(here, '../resources/fixtures/templates', rel)
const PATCH_FILE = '.yarn/patches/lodash-npm-4.17.21-6382451519.patch'
const STRINGIFY_ROUNDTRIP_FIXTURES = [
  'simple',
  'patch-yarn',
  'peers-basic',
  'peers-multi',
  'workspaces-basic',
  'deps-with-scopes',
  'workspace-cross-refs',
] as const

function patchLocatorOfResolution(resolution: string): string {
  const idx = resolution.indexOf('@patch:')
  return idx >= 0 ? resolution.slice(idx + 1) : resolution
}

function parseFixtureGraph(name: typeof STRINGIFY_ROUNDTRIP_FIXTURES[number] | 'yarn-crlf'): Graph {
  const workspaceRoot = name === 'patch-yarn' ? templateDir('patch-yarn') : undefined
  return parse(fixture(`${name}/yarn-berry-v9.lock`), workspaceRoot === undefined ? undefined : { workspaceRoot })
}

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

function stringifyWithDiagnostics(graph: Graph) {
  const diagnostics: Diagnostic[] = []
  const lockfile = stringify(graph, {
    onDiagnostic(diagnostic) {
      diagnostics.push(diagnostic)
    },
  })

  return { lockfile, diagnostics }
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

describe('yarn-berry-v9 — discriminant', () => {
  it('accepts v9 lockfile header', () => {
    expect(check(fixture('simple/yarn-berry-v9.lock'))).toBe(true)
  })

  it('rejects v8 lockfile header', () => {
    const v8 = fixture('simple/yarn-berry-v8.lock')
    expect(check(v8)).toBe(false)
  })

  it('rejects npm-1 lockfile (json shape, no __metadata)', () => {
    const lock = fixture('simple/npm-1.lock')
    expect(check(lock)).toBe(false)
  })

  it('parse rejects format mismatch loudly', () => {
    const lock = fixture('simple/yarn-berry-v8.lock')
    expect(() => parse(lock)).toThrow(LockfileError)
    try {
      parse(lock)
    } catch (error) {
      expect((error as LockfileError).code).toBe('FORMAT_MISMATCH')
    }
  })
})

describe('yarn-berry-v9 — simple fixture', () => {
  const g = parse(fixture('simple/yarn-berry-v9.lock'))

  it('three nodes: workspace + lodash + ms', () => {
    expect([...g.nodes()].map(n => n.id).sort()).toEqual([
      'case-simple@0.0.0-use.local',
      'lodash@4.17.21',
      'ms@2.1.3',
    ])
  })

  it('workspace node carries workspacePath = empty (root)', () => {
    const ws = g.getNode('case-simple@0.0.0-use.local')
    expect(ws?.workspacePath).toBe('')
    expect(ws?.resolution).toBe('case-simple@workspace:.')
  })

  it('workspace dep edges to lodash and ms', () => {
    const out = g.out('case-simple@0.0.0-use.local').map(e => ({ dst: e.dst, kind: e.kind, range: e.attrs?.range }))
    expect(out.sort((a, b) => a.dst.localeCompare(b.dst))).toEqual([
      { dst: 'lodash@4.17.21', kind: 'dep', range: 'npm:4.17.21' },
      { dst: 'ms@2.1.3',       kind: 'dep', range: 'npm:2.1.3'   },
    ])
  })

  it('roots() = the workspace node', () => {
    expect([...g.roots()]).toEqual(['case-simple@0.0.0-use.local'])
  })

  it('tarball entries carry yarn checksum verbatim (cacheKey-prefixed)', () => {
    const lodash = g.tarball({ name: 'lodash', version: '4.17.21' })
    expect(lodash?.integrity).toMatch(/^10c0\//)
    expect(g.tarball({ name: 'ms', version: '2.1.3' })?.integrity).toMatch(/^10c0\//)
  })

  it('workspace nodes have no tarball entry (no artifact)', () => {
    expect(g.tarball({ name: 'case-simple', version: '0.0.0-use.local' })).toBeUndefined()
  })
})

describe('yarn-berry-v9 — peers-basic', () => {
  const g = parse(fixture('peers-basic/yarn-berry-v9.lock'))

  it('all 6 expected nodes present', () => {
    expect([...g.nodes()].map(n => n.id).sort()).toEqual([
      'case-peers-basic@0.0.0-use.local',
      'js-tokens@4.0.0',
      'loose-envify@1.4.0',
      'react-dom@18.2.0',
      'react@18.2.0',
      'scheduler@0.23.2',
    ])
  })

  it('workspace deps include react and react-dom', () => {
    const dsts = g.out('case-peers-basic@0.0.0-use.local').map(e => e.dst).sort()
    expect(dsts).toEqual(['react-dom@18.2.0', 'react@18.2.0'])
  })

  it('react-dom has its regular deps (peer skipped in v1)', () => {
    const dsts = g.out('react-dom@18.2.0').map(e => e.dst).sort()
    expect(dsts).toEqual(['loose-envify@1.4.0', 'scheduler@0.23.2'])
    // peer edge to react@18.2.0 is intentionally absent — see file header in yarn-berry-v9.ts
    expect(g.out('react-dom@18.2.0', 'peer')).toEqual([])
  })

  it('multi-spec key resolves: loose-envify deps js-tokens via "^3 || ^4" range', () => {
    const dsts = g.out('loose-envify@1.4.0').map(e => e.dst)
    expect(dsts).toContain('js-tokens@4.0.0')
  })
})

describe('yarn-berry-v9 — peers-multi', () => {
  const g = parse(fixture('peers-multi/yarn-berry-v9.lock'))

  it('captures both react versions side-by-side', () => {
    const reacts = g.byName('react').slice().sort()
    expect(reacts).toEqual(['react@17.0.2', 'react@18.2.0'])
  })

  it('captures both react-dom versions side-by-side', () => {
    const rds = g.byName('react-dom').slice().sort()
    expect(rds).toEqual(['react-dom@17.0.2', 'react-dom@18.2.0'])
  })

  it('workspace_a binds to react@17 chain via direct deps', () => {
    const a = g.out('@case-peers-multi/a@0.0.0-use.local').map(e => e.dst).sort()
    expect(a).toEqual(['react-dom@17.0.2', 'react@17.0.2'])
  })

  it('workspace_b binds to react@18 chain via direct deps', () => {
    const b = g.out('@case-peers-multi/b@0.0.0-use.local').map(e => e.dst).sort()
    expect(b).toEqual(['react-dom@18.2.0', 'react@18.2.0'])
  })
})

describe('yarn-berry-v9 — workspaces-basic', () => {
  const g = parse(fixture('workspaces-basic/yarn-berry-v9.lock'))

  it('three workspace nodes: root, a, b', () => {
    const ws = [...g.nodes()].filter(n => n.workspacePath !== undefined)
    expect(ws.map(n => `${n.id} @ ${n.workspacePath}`).sort()).toEqual([
      '@case-ws/a@0.0.0-use.local @ packages/a',
      '@case-ws/b@0.0.0-use.local @ packages/b',
      'case-workspaces-basic@0.0.0-use.local @ ',
    ])
  })

  it('child workspaces depend on shared ms', () => {
    expect(g.out('@case-ws/a@0.0.0-use.local').map(e => e.dst)).toEqual(['ms@2.1.3'])
    expect(g.out('@case-ws/b@0.0.0-use.local').map(e => e.dst)).toEqual(['ms@2.1.3'])
  })

  it('ms appears once and has both workspaces as dependents', () => {
    expect(g.byName('ms')).toEqual(['ms@2.1.3'])
    const inc = g.in('ms@2.1.3').map(e => e.src).sort()
    expect(inc).toEqual([
      '@case-ws/a@0.0.0-use.local',
      '@case-ws/b@0.0.0-use.local',
    ])
  })
})

describe('yarn-berry-v9 — patch extraction', () => {
  const lock = fixture('patch-yarn/yarn-berry-v9.lock')
  const workspaceRoot = templateDir('patch-yarn')
  const fixtureLocator = patchLocatorOfResolution(
    /resolution: "(?:[^"]*@)?(patch:[^"]+)"/.exec(lock)?.[1] ?? (() => { throw new Error('missing patch fixture resolution') })(),
  )
  const unresolvedSentinel = (locator: string): string =>
    `unresolved-${createHash('sha256').update(locator, 'utf8').digest('hex')}`
  const patchResolution = (locator: string): string => `foo@${locator}`
  const singlePatchInput = (locator: string): string =>
    '__metadata:\n  version: 9\n  cacheKey: 10c0\n\n' +
    '"foo@npm:1.0.0":\n' +
    '  version: 1.0.0\n' +
    `  resolution: "${patchResolution(locator)}"\n`

  it('canonical file-backed patch stamps sha512 hex and keys tarball payload by +patch=', () => {
    const patchBytes = readFileSync(resolve(workspaceRoot, PATCH_FILE))
    const expectedPatch = createHash('sha512').update(patchBytes).digest('hex')
    const g = parse(lock, { workspaceRoot })

    expect(g.getNode('lodash@4.17.21')?.patch).toBe(expectedPatch)
    expect(g.tarballOf('lodash@4.17.21')?.integrity).toMatch(/^10c0\//)
    expect(g.tarball({ name: 'lodash', version: '4.17.21', patch: expectedPatch })?.integrity).toMatch(/^10c0\//)
    expect(g.tarball({ name: 'lodash', version: '4.17.21' })).toBeUndefined()
    expect([...g.tarballs()].map(([key]) => key)).toContain(`lodash@4.17.21+patch=${expectedPatch}`)
  })

  it('missing patch file falls back to sentinel and warns on the full locator envelope', () => {
    const tempParent = mkdtempSync(resolve(tmpdir(), 'lockfile-patch-yarn-'))
    const tempRoot = resolve(tempParent, 'workspace')
    try {
      cpSync(workspaceRoot, tempRoot, { recursive: true })
      rmSync(resolve(tempRoot, PATCH_FILE))

      const g = parse(lock, { workspaceRoot: tempRoot })
      const resolution = g.getNode('lodash@4.17.21')?.resolution
      expect(resolution).toBeDefined()
      const locator = patchLocatorOfResolution(resolution!)
      const sentinel = `unresolved-${createHash('sha256').update(locator, 'utf8').digest('hex')}`

      expect(g.getNode('lodash@4.17.21')?.patch).toBe(sentinel)
      expect(g.diagnostics().filter(d => d.code === 'YARN_BERRY_PATCH_UNRESOLVED')).toEqual([
        expect.objectContaining({ severity: 'warning', subject: 'lodash@4.17.21' }),
      ])
      expect(g.tarballOf('lodash@4.17.21')?.integrity).toMatch(/^10c0\//)
      expect(g.tarball({ name: 'lodash', version: '4.17.21', patch: sentinel })?.integrity).toMatch(/^10c0\//)
    } finally {
      rmSync(tempParent, { recursive: true, force: true })
    }
  })

  it('leaf symlink swap throws INVALID_INPUT', () => {
    const tempParent = mkdtempSync(resolve(tmpdir(), 'lockfile-patch-yarn-link-'))
    const tempRoot = resolve(tempParent, 'workspace')
    const outsidePatch = resolve(tempParent, 'outside.patch')
    const patchPath = resolve(tempRoot, PATCH_FILE)
    try {
      cpSync(workspaceRoot, tempRoot, { recursive: true })
      writeFileSync(outsidePatch, 'outside workspace bytes\n')
      rmSync(patchPath)
      symlinkSync(outsidePatch, patchPath)

      expect(() => parse(lock, { workspaceRoot: tempRoot })).toThrow(LockfileError)
      try {
        parse(lock, { workspaceRoot: tempRoot })
      } catch (e) {
        expect((e as LockfileError).code).toBe('INVALID_INPUT')
      }
    } finally {
      rmSync(tempParent, { recursive: true, force: true })
    }
  })

  it.each([
    {
      label: 'outermost .yarn segment',
      patchFile: PATCH_FILE,
      setup(tempRoot: string): void {
        rmSync(resolve(tempRoot, '.yarn'), { recursive: true, force: true })
        writeFileSync(resolve(tempRoot, '.yarn'), 'not a directory\n')
      },
    },
    {
      label: 'middle .yarn/patches segment',
      patchFile: PATCH_FILE,
      setup(tempRoot: string): void {
        rmSync(resolve(tempRoot, '.yarn/patches'), { recursive: true, force: true })
        writeFileSync(resolve(tempRoot, '.yarn/patches'), 'not a directory\n')
      },
    },
    {
      label: 'deeper .yarn/patches/sub segment',
      patchFile: '.yarn/patches/sub/foo.patch',
      setup(tempRoot: string): void {
        writeFileSync(resolve(tempRoot, '.yarn/patches/sub'), 'not a directory\n')
      },
    },
  ])('non-directory intermediate patch segments throw INVALID_INPUT for $label', ({ patchFile, setup }) => {
    const tempParent = mkdtempSync(resolve(tmpdir(), 'lockfile-patch-yarn-nondir-'))
    const tempRoot = resolve(tempParent, 'workspace')
    const nestedLock = patchFile === PATCH_FILE ? lock : lock.replace(PATCH_FILE, patchFile)
    const locator = patchFile === PATCH_FILE ? fixtureLocator : fixtureLocator.replace(PATCH_FILE, patchFile)
    try {
      cpSync(workspaceRoot, tempRoot, { recursive: true })
      setup(tempRoot)

      expect(() => parse(nestedLock, { workspaceRoot: tempRoot })).toThrow(LockfileError)
      try {
        parse(nestedLock, { workspaceRoot: tempRoot })
      } catch (e) {
        expect((e as LockfileError).code).toBe('INVALID_INPUT')
        expect((e as Error).message).toContain(locator)
      }
    } finally {
      rmSync(tempParent, { recursive: true, force: true })
    }
  })

  it('builtin patches without sourceable yarn-major fall back to a sentinel warning', () => {
    const input =
      '__metadata:\n  version: 9\n  cacheKey: 10c0\n\n' +
      '"typescript@npm:5.4.5":\n' +
      '  version: 5.4.5\n' +
      '  resolution: "typescript@patch:typescript@npm%3A5.4.5#~builtin<compat/typescript>::version=5.4.5&hash=abc123"\n' +
      '  checksum: 10c0/abc123\n'

    const g = parse(input)
    const resolution = g.getNode('typescript@5.4.5')?.resolution
    expect(resolution).toBeDefined()
    const locator = patchLocatorOfResolution(resolution!)
    const sentinel = `unresolved-${createHash('sha256').update(locator, 'utf8').digest('hex')}`

    expect(g.getNode('typescript@5.4.5')?.patch).toBe(sentinel)
    expect(g.diagnostics().filter(d => d.code === 'YARN_BERRY_PATCH_UNRESOLVED')).toEqual([
      expect.objectContaining({
        severity: 'warning',
        subject: 'typescript@5.4.5',
      }),
    ])
  })

  it('deleted workspaceRoot falls back to sentinel warning', () => {
    const tempRoot = mkdtempSync(resolve(tmpdir(), 'lockfile-patch-yarn-root-missing-'))
    try {
      rmSync(tempRoot, { recursive: true, force: true })

      const g = parse(lock, { workspaceRoot: tempRoot })
      const resolution = g.getNode('lodash@4.17.21')?.resolution
      expect(resolution).toBeDefined()
      const locator = patchLocatorOfResolution(resolution!)
      const sentinel = `unresolved-${createHash('sha256').update(locator, 'utf8').digest('hex')}`

      expect(g.getNode('lodash@4.17.21')?.patch).toBe(sentinel)
      expect(g.diagnostics().filter(d => d.code === 'YARN_BERRY_PATCH_UNRESOLVED')).toEqual([
        expect.objectContaining({
          severity: 'warning',
          subject: 'lodash@4.17.21',
        }),
      ])
    } finally {
      rmSync(tempRoot, { recursive: true, force: true })
    }
  })

  it('workspace escape patch paths throw INVALID_INPUT', () => {
    const input =
      '__metadata:\n  version: 9\n  cacheKey: 10c0\n\n' +
      '"lodash@npm:4.17.21":\n' +
      '  version: 4.17.21\n' +
      '  resolution: "lodash@patch:lodash@npm%3A4.17.21#../../../etc/passwd::version=4.17.21&hash=deadbe"\n' +
      '  checksum: 10c0/d8cbea072bb08655bb4c989da418994b073a608dffa608b09ac04b43a791b12aeae7cd7ad919aa4c925f33b48490b5cfe6c1f71d827956071dae2e7bb3a6b74c\n'

    expect(() => parse(input, { workspaceRoot })).toThrow(LockfileError)
    try {
      parse(input, { workspaceRoot })
    } catch (e) {
      expect((e as LockfileError).code).toBe('INVALID_INPUT')
    }
  })

  it('parse() without workspaceRoot falls through to sentinel for file-backed patches', () => {
    const g = parse(lock)
    const resolution = g.getNode('lodash@4.17.21')?.resolution
    expect(resolution).toBeDefined()
    const locator = patchLocatorOfResolution(resolution!)
    const sentinel = `unresolved-${createHash('sha256').update(locator, 'utf8').digest('hex')}`

    expect(g.getNode('lodash@4.17.21')?.patch).toBe(sentinel)
    expect(g.diagnostics().filter(d => d.code === 'YARN_BERRY_PATCH_UNRESOLVED')).toEqual([
      expect.objectContaining({
        severity: 'warning',
        subject: 'lodash@4.17.21',
      }),
    ])
  })

  it('empty patch fragments fall back to sentinel warning', () => {
    const locator = 'patch:foo@npm%3A1.0.0#::version=1.0.0&hash=abc123'
    const input = singlePatchInput(locator)

    const g = parse(input, { workspaceRoot })
    expect(g.getNode('foo@1.0.0')?.resolution).toBe(patchResolution(locator))

    expect(g.getNode('foo@1.0.0')?.patch).toBe(unresolvedSentinel(locator))
    expect(g.diagnostics().filter(d => d.code === 'YARN_BERRY_PATCH_UNRESOLVED')).toEqual([
      expect.objectContaining({
        severity: 'warning',
        subject: 'foo@1.0.0',
      }),
    ])
  })

  it('whitespace-only patch fragments fall back to sentinel warning on the full locator', () => {
    const locator = 'patch:foo@npm%3A1.0.0#  ::version=1.0.0&hash=abc123'
    const input = singlePatchInput(locator)

    const g = parse(input, { workspaceRoot })
    expect(g.getNode('foo@1.0.0')?.resolution).toBe(patchResolution(locator))

    expect(g.getNode('foo@1.0.0')?.patch).toBe(unresolvedSentinel(locator))
    expect(g.diagnostics().filter(d => d.code === 'YARN_BERRY_PATCH_UNRESOLVED')).toEqual([
      expect.objectContaining({
        severity: 'warning',
        subject: 'foo@1.0.0',
        message: expect.stringContaining(locator),
      }),
    ])
  })

  it.each(['./', '.'])('dot-only patch fragment %j falls back to sentinel warning on the full locator', (fragment) => {
    const locator = `patch:foo@npm%3A1.0.0#${fragment}::version=1.0.0&hash=abc123`
    const input = singlePatchInput(locator)

    const g = parse(input, { workspaceRoot })
    expect(g.getNode('foo@1.0.0')?.resolution).toBe(patchResolution(locator))

    expect(g.getNode('foo@1.0.0')?.patch).toBe(unresolvedSentinel(locator))
    expect(g.diagnostics().filter(d => d.code === 'YARN_BERRY_PATCH_UNRESOLVED')).toEqual([
      expect.objectContaining({
        severity: 'warning',
        subject: 'foo@1.0.0',
        message: expect.stringContaining(locator),
      }),
    ])
  })

  it.each([
    'patch:foo@npm%3A1.0.0#%20%20::version=1.0.0&hash=abc123',
    'patch:foo@npm%3A1.0.0#%09::version=1.0.0&hash=abc123',
    'patch:foo@npm%3A1.0.0#%20./%20::version=1.0.0&hash=abc123',
  ])('degenerate encoded patch fragment %j falls back to sentinel warning on the full locator', (locator) => {
    const g = parse(singlePatchInput(locator), { workspaceRoot })
    const diagnostics = g.diagnostics().filter(d => d.code === 'YARN_BERRY_PATCH_UNRESOLVED')

    expect(g.getNode('foo@1.0.0')?.resolution).toBe(patchResolution(locator))
    expect(g.getNode('foo@1.0.0')?.patch).toBe(unresolvedSentinel(locator))
    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]).toEqual(expect.objectContaining({
      severity: 'warning',
      subject: 'foo@1.0.0',
      message: expect.stringContaining('patch locator has no source fragment'),
    }))
    expect(diagnostics[0]?.message).toContain(locator)
  })

  it.each([
    'patch:foo@npm%3A1.0.0#..::version=1.0.0&hash=abc123',
    'patch:foo@npm%3A1.0.0#/abs/path::version=1.0.0&hash=abc123',
  ])('invalid patch fragment %j throws INVALID_INPUT', (locator) => {
    expect(() => parse(singlePatchInput(locator), { workspaceRoot })).toThrow(LockfileError)
    try {
      parse(singlePatchInput(locator), { workspaceRoot })
    } catch (e) {
      expect((e as LockfileError).code).toBe('INVALID_INPUT')
    }
  })
})

describe('yarn-berry-v9 — alias collision rejection (ADR-0010)', () => {

  it('throws IRREDUCIBLE_LOSS on TarballKey collision (alias-style)', () => {
    // Two entries collapse onto `lodash@1.0.0` — once they have the same name+version, our keying
    // can't tell them apart until ADR-0011.
    const input =
      '__metadata:\n  version: 9\n  cacheKey: 10c0\n\n' +
      '"lodash@npm:1.0.0":\n  version: 1.0.0\n  resolution: "lodash@npm:1.0.0"\n\n' +
      '"my-lodash@npm:lodash@1.0.0":\n  version: 1.0.0\n  resolution: "lodash@npm:1.0.0"\n'
    // The second entry's first spec parses as name=`my-lodash`, but the lookup-by-version still
    // collides only if both entries happen to derive the same NodeId. In this synthetic case
    // they don't — name differs — so we won't collide here. The collision case requires
    // matching name@version on both sides.
    // Use a tighter scenario: two entries with same parsed (name, version) tuple.
    const input2 =
      '__metadata:\n  version: 9\n  cacheKey: 10c0\n\n' +
      '"foo@npm:1.0.0":\n  version: 1.0.0\n  resolution: "foo@npm:1.0.0"\n\n' +
      '"foo@npm:1.0.0-alias":\n  version: 1.0.0\n  resolution: "foo@npm:1.0.0"\n'
    expect(() => parse(input2)).toThrow(/IRREDUCIBLE_LOSS|collapse onto NodeId/)
  })
})

describe('yarn-berry-v9 — diagnostics', () => {
  it('unresolvable dep emits warning, not error', () => {
    const input =
      '__metadata:\n  version: 9\n  cacheKey: 10c0\n\n' +
      '"foo@workspace:.":\n  version: 0.0.0-use.local\n  resolution: "foo@workspace:."\n  dependencies:\n    ghost: "npm:1.0.0"\n'
    const g = parse(input)
    const diags = g.diagnostics()
    expect(diags.some(d => d.code === 'YARN_BERRY_UNRESOLVED_DEP')).toBe(true)
    expect(diags.every(d => d.severity !== 'error')).toBe(true)
  })
})

describe('yarn-berry-v9 — stringify', () => {
  it.each(STRINGIFY_ROUNDTRIP_FIXTURES)('roundtrips %s at Graph level', (fixtureName) => {
    const original = parseFixtureGraph(fixtureName)
    const emitted = stringify(original)
    const reparsed = parse(
      emitted,
      fixtureName === 'patch-yarn' ? { workspaceRoot: templateDir('patch-yarn') } : undefined,
    )

    expect(graphSnapshot(reparsed)).toEqual(graphSnapshot(original))
  })

  it('roundtrips yarn-crlf at Graph level when CRLF is explicitly requested', () => {
    const original = parseFixtureGraph('yarn-crlf')
    const emitted = stringify(original, { lineEnding: 'crlf' })
    const reparsed = parse(emitted)

    expect(emitted).toContain('\r\n')
    expect(graphSnapshot(reparsed)).toEqual(graphSnapshot(original))
  })

  it('is deterministic across independently parsed graphs', () => {
    const first = parseFixtureGraph('workspace-cross-refs')
    const second = parseFixtureGraph('workspace-cross-refs')
    const options = { cacheKey: '10c0', lineEnding: 'lf' as const }

    expect(stringify(first, options)).toBe(stringify(second, options))
  })

  it('omits __metadata.cacheKey unless requested', () => {
    const withoutCacheKey = fixture('simple/yarn-berry-v9.lock').replace('  cacheKey: 10c0\n', '')
    const emitted = stringify(parse(withoutCacheKey))

    expect(emitted).toContain('__metadata:\n  version: 9\n')
    expect(emitted).not.toContain('cacheKey:')
  })

  it('keeps __metadata.version unquoted to match yarn writer output', () => {
    const emitted = stringify(parseFixtureGraph('simple'), { cacheKey: '10c0' })

    expect(emitted).toContain('__metadata:\n  version: 9\n  cacheKey: 10c0\n')
    expect(emitted).not.toContain('version: "9"')
  })

  it('quotes YAML-colliding keys and values canonically', () => {
    const builder = newBuilder()
    builder.addNode({
      id: 'case-stringify@0.0.0-use.local',
      name: 'case-stringify',
      version: '0.0.0-use.local',
      peerContext: [],
      workspacePath: '',
      resolution: 'case-stringify@workspace:.',
    })
    builder.addNode({
      id: 'true@1.0.0',
      name: 'true',
      version: '1.0.0',
      peerContext: [],
      resolution: 'true@npm:1.0.0',
    })
    builder.addNode({
      id: '@scope/name@2.0.0',
      name: '@scope/name',
      version: '2.0.0',
      peerContext: [],
      resolution: '@scope/name@npm:2.0.0',
    })
    builder.addNode({
      id: 'pkg#hash@3.0.0',
      name: 'pkg#hash',
      version: '3.0.0',
      peerContext: [],
      resolution: 'pkg#hash@npm:3.0.0',
    })
    builder.addNode({
      id: 'pkg:colon@4.0.0',
      name: 'pkg:colon',
      version: '4.0.0',
      peerContext: [],
      resolution: 'pkg:colon@npm:4.0.0',
    })
    builder.addNode({
      id: 'dash-version@-1.0.0',
      name: 'dash-version',
      version: '-1.0.0',
      peerContext: [],
      resolution: 'dash-version@npm:-1.0.0',
    })
    builder.addEdge('case-stringify@0.0.0-use.local', 'true@1.0.0', 'dep', { range: 'npm:1.0.0' })
    builder.addEdge('case-stringify@0.0.0-use.local', '@scope/name@2.0.0', 'dep', { range: 'npm:2.0.0' })
    builder.addEdge('case-stringify@0.0.0-use.local', 'pkg#hash@3.0.0', 'dep', { range: 'npm:3.0.0' })
    builder.addEdge('case-stringify@0.0.0-use.local', 'pkg:colon@4.0.0', 'dep', { range: 'npm:4.0.0' })
    builder.addEdge('case-stringify@0.0.0-use.local', 'dash-version@-1.0.0', 'dep', { range: 'npm:-1.0.0' })
    const graph = builder.seal()

    const emitted = stringify(graph)

    expect(emitted).toContain('    "true": "npm:1.0.0"\n')
    expect(emitted).toContain('    "@scope/name": "npm:2.0.0"\n')
    expect(emitted).toContain('    "pkg#hash": "npm:3.0.0"\n')
    expect(emitted).toContain('    "pkg:colon": "npm:4.0.0"\n')
    expect(emitted).toContain('  version: "-1.0.0"\n')
  })

  it('emits peerDependenciesMeta, dependenciesMeta, and conditions when supplied as raw entry hints', () => {
    const builder = newBuilder()
    const hintedNode: Node & Record<string, unknown> = {
      id: 'pkg@1.0.0',
      name: 'pkg',
      version: '1.0.0',
      peerContext: [],
      resolution: 'pkg@npm:1.0.0',
      peerDependencies: { react: '^18.2.0' },
      peerDependenciesMeta: { react: { optional: true } },
      dependenciesMeta: { lodash: { unplugged: true } },
      conditions: { os: 'linux' },
    }
    builder.addNode(hintedNode)
    const graph = builder.seal()

    const emitted = stringify(graph)

    expect(emitted).toContain('  peerDependencies:\n    react: ^18.2.0\n')
    expect(emitted).toContain('  peerDependenciesMeta:\n    react:\n      optional: "true"\n')
    expect(emitted).toContain('  dependenciesMeta:\n    lodash:\n      unplugged: "true"\n')
    expect(emitted).toContain('  conditions:\n    os: linux\n')
  })

  it('synthesizes peerDependencies blocks from graph peer edges', () => {
    const builder = newBuilder()
    builder.addNode({
      id: 'react@18.2.0',
      name: 'react',
      version: '18.2.0',
      peerContext: [],
      resolution: 'react@npm:18.2.0',
    })
    builder.addNode({
      id: 'react-dom@18.2.0(react@18.2.0)',
      name: 'react-dom',
      version: '18.2.0',
      peerContext: ['react@18.2.0'],
      resolution: 'react-dom@npm:18.2.0',
    })
    builder.addEdge('react-dom@18.2.0(react@18.2.0)', 'react@18.2.0', 'peer', { range: '^18.2.0' })
    const graph = builder.seal()

    expect(stringify(graph)).toContain('  peerDependencies:\n    react: ^18.2.0\n')
  })

  it('omits peerDependencies when every peer edge is missing attrs.range', () => {
    const builder = newBuilder()
    builder.addNode({
      id: 'react@18.2.0',
      name: 'react',
      version: '18.2.0',
      peerContext: [],
      resolution: 'react@npm:18.2.0',
    })
    builder.addNode({
      id: 'react-dom@18.2.0(react@18.2.0)',
      name: 'react-dom',
      version: '18.2.0',
      peerContext: ['react@18.2.0'],
      resolution: 'react-dom@npm:18.2.0',
    })
    builder.addEdge('react-dom@18.2.0(react@18.2.0)', 'react@18.2.0', 'peer')
    const graph = builder.seal()

    const emitted = stringify(graph)

    expect(emitted).not.toContain('peerDependencies:\n')
  })

  it('can emit CRLF line endings', () => {
    const graph = parseFixtureGraph('simple')
    const emitted = stringify(graph, { lineEnding: 'crlf' })

    expect(emitted.endsWith('\r\n')).toBe(true)
    const stripped = emitted.replace(/\r\n/g, '')
    expect(stripped).not.toContain('\n')
    expect(stripped).not.toContain('\r')
  })

  it('throws IRREDUCIBLE_LOSS when peer-virtual siblings collide on emit entry key', () => {
    const builder = newBuilder()
    builder.addNode({
      id: 'react@17.0.0',
      name: 'react',
      version: '17.0.0',
      peerContext: [],
      resolution: 'react@npm:17.0.0',
    })
    builder.addNode({
      id: 'react@18.0.0',
      name: 'react',
      version: '18.0.0',
      peerContext: [],
      resolution: 'react@npm:18.0.0',
    })
    builder.addNode({
      id: 'lib@1.0.0(react@17.0.0)',
      name: 'lib',
      version: '1.0.0',
      peerContext: ['react@17.0.0'],
      resolution: 'lib@npm:1.0.0',
    })
    builder.addNode({
      id: 'lib@1.0.0(react@18.0.0)',
      name: 'lib',
      version: '1.0.0',
      peerContext: ['react@18.0.0'],
      resolution: 'lib@npm:1.0.0',
    })
    builder.addEdge('lib@1.0.0(react@17.0.0)', 'react@17.0.0', 'peer', { range: '^17' })
    builder.addEdge('lib@1.0.0(react@18.0.0)', 'react@18.0.0', 'peer', { range: '^18' })
    const graph = builder.seal()

    expect(() => stringify(graph)).toThrow(LockfileError)
    try {
      stringify(graph)
    } catch (error) {
      expect((error as LockfileError).code).toBe('IRREDUCIBLE_LOSS')
      expect((error as Error).message)
        .toContain('duplicate node id collides on emit: lib@1.0.0 from lib@1.0.0(react@17.0.0), lib@1.0.0(react@18.0.0)')
    }
  })

  it('throws IRREDUCIBLE_LOSS when peer-virtual siblings have divergent incoming dep ranges', () => {
    const builder = newBuilder()
    builder.addNode({
      id: 'app-a@1.0.0',
      name: 'app-a',
      version: '1.0.0',
      peerContext: [],
      workspacePath: 'packages/app-a',
      resolution: 'app-a@workspace:packages/app-a',
    })
    builder.addNode({
      id: 'app-b@1.0.0',
      name: 'app-b',
      version: '1.0.0',
      peerContext: [],
      workspacePath: 'packages/app-b',
      resolution: 'app-b@workspace:packages/app-b',
    })
    builder.addNode({
      id: 'react@17.0.0',
      name: 'react',
      version: '17.0.0',
      peerContext: [],
      resolution: 'react@npm:17.0.0',
    })
    builder.addNode({
      id: 'react@18.0.0',
      name: 'react',
      version: '18.0.0',
      peerContext: [],
      resolution: 'react@npm:18.0.0',
    })
    builder.addNode({
      id: 'lib@1.0.0(react@17.0.0)',
      name: 'lib',
      version: '1.0.0',
      peerContext: ['react@17.0.0'],
      resolution: 'lib@npm:1.0.0',
    })
    builder.addNode({
      id: 'lib@1.0.0(react@18.0.0)',
      name: 'lib',
      version: '1.0.0',
      peerContext: ['react@18.0.0'],
      resolution: 'lib@npm:1.0.0',
    })
    builder.addEdge('app-a@1.0.0', 'lib@1.0.0(react@17.0.0)', 'dep', { range: '^1.0.0' })
    builder.addEdge('app-b@1.0.0', 'lib@1.0.0(react@18.0.0)', 'dep', { range: '~1.0.0' })
    builder.addEdge('lib@1.0.0(react@17.0.0)', 'react@17.0.0', 'peer', { range: '^17' })
    builder.addEdge('lib@1.0.0(react@18.0.0)', 'react@18.0.0', 'peer', { range: '^18' })
    const graph = builder.seal()

    expect(() => stringify(graph)).toThrow(LockfileError)
    try {
      stringify(graph)
    } catch (error) {
      expect((error as LockfileError).code).toBe('IRREDUCIBLE_LOSS')
      expect((error as Error).message)
        .toContain('duplicate node id collides on emit: lib@1.0.0 from lib@1.0.0(react@17.0.0), lib@1.0.0(react@18.0.0)')
    }
  })
})

describe('yarn-berry-v9 — modify', () => {
  it('roundtrips addEdge dep', () => {
    const original = parseFixtureGraph('simple')
    const result = original.mutate(m => {
      m.addEdge('lodash@4.17.21', 'ms@2.1.3', 'dep', { range: 'npm:2.1.3' })
    })
    const reparsed = parse(stringify(result.graph))

    expectEmptyGraphDiff(result.graph.diff(reparsed))
    expect(result.applied).toEqual([
      { kind: 'edge-added', subject: { src: 'lodash@4.17.21', dst: 'ms@2.1.3', kind: 'dep' } },
    ])
  })

  it('roundtrips addEdge optional', () => {
    const original = parseFixtureGraph('simple')
    const result = original.mutate(m => {
      m.addEdge('case-simple@0.0.0-use.local', 'ms@2.1.3', 'optional', { range: 'npm:2.1.3' })
    })
    const reparsed = parse(stringify(result.graph))

    expectEmptyGraphDiff(result.graph.diff(reparsed))
    expect(result.applied).toEqual([
      { kind: 'edge-added', subject: { src: 'case-simple@0.0.0-use.local', dst: 'ms@2.1.3', kind: 'optional' } },
    ])
  })

  it('emits addEdge peer through peerDependencies and reparses to the flattened graph', () => {
    const original = parseFixtureGraph('peers-basic')
    const result = original.mutate(m => {
      m.addNode({
        id: 'peer-consumer@1.0.0(react@18.2.0)',
        name: 'peer-consumer',
        version: '1.0.0',
        peerContext: ['react@18.2.0'],
        resolution: 'peer-consumer@npm:1.0.0',
      })
      m.addEdge('peer-consumer@1.0.0(react@18.2.0)', 'react@18.2.0', 'peer', { range: 'npm:18.2.0' })
    })
    const flattened = original.mutate(m => {
      m.addNode({
        id: 'peer-consumer@1.0.0',
        name: 'peer-consumer',
        version: '1.0.0',
        peerContext: [],
        resolution: 'peer-consumer@npm:1.0.0',
      })
    }).graph
    const { lockfile, diagnostics } = stringifyWithDiagnostics(result.graph)
    const reparsed = parse(lockfile)

    expect(lockfile).toContain('  peerDependencies:\n    react: "npm:18.2.0"\n')
    expectEmptyGraphDiff(flattened.diff(reparsed))
    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: 'YARN_BERRY_V9_PEER_VIRT_FLATTENED',
        severity: 'warning',
        subject: 'peer-consumer@1.0.0(react@18.2.0)',
      }),
    ])
    expect(result.applied).toEqual([
      { kind: 'node-added', subject: 'peer-consumer@1.0.0(react@18.2.0)' },
      { kind: 'edge-added', subject: { src: 'peer-consumer@1.0.0(react@18.2.0)', dst: 'react@18.2.0', kind: 'peer' } },
    ])
  })

  it('does not add incoming peer ranges to the provider entry key', () => {
    const builder = newBuilder()
    builder.addNode({
      id: 'react@18.2.0',
      name: 'react',
      version: '18.2.0',
      peerContext: [],
      resolution: 'react@npm:18.2.0',
    })
    builder.addNode({
      id: 'peer-consumer@1.0.0(react@18.2.0)',
      name: 'peer-consumer',
      version: '1.0.0',
      peerContext: ['react@18.2.0'],
      resolution: 'peer-consumer@npm:1.0.0',
    })
    builder.addEdge('peer-consumer@1.0.0(react@18.2.0)', 'react@18.2.0', 'peer', { range: '^18' })
    const graph = builder.seal()

    const emitted = stringify(graph)

    expect(emitted).toContain('"react@npm:18.2.0":\n')
    expect(emitted).not.toContain('"react@npm:18.2.0, react@^18":\n')
    expect(emitted).toContain('  peerDependencies:\n    react: ^18\n')
  })

  it('roundtrips removeEdge', () => {
    const original = parseFixtureGraph('simple')
    const result = original.mutate(m => {
      m.removeEdge('case-simple@0.0.0-use.local', 'ms@2.1.3', 'dep')
    })
    const reparsed = parse(stringify(result.graph))

    expectEmptyGraphDiff(result.graph.diff(reparsed))
    expect(result.applied).toEqual([
      { kind: 'edge-removed', subject: { src: 'case-simple@0.0.0-use.local', dst: 'ms@2.1.3', kind: 'dep' } },
    ])
  })

  it('roundtrips addNode', () => {
    const original = parseFixtureGraph('simple')
    const result = original.mutate(m => {
      m.addNode({
        id: 'debug@1.0.0',
        name: 'debug',
        version: '1.0.0',
        peerContext: [],
        resolution: 'debug@npm:1.0.0',
      })
    })
    const reparsed = parse(stringify(result.graph))

    expectEmptyGraphDiff(result.graph.diff(reparsed))
    expect(result.applied).toEqual([
      { kind: 'node-added', subject: 'debug@1.0.0' },
    ])
  })

  it('roundtrips removeNode', () => {
    const original = parseFixtureGraph('simple')
    const result = original.mutate(m => {
      m.removeEdge('case-simple@0.0.0-use.local', 'ms@2.1.3', 'dep')
      m.removeNode('ms@2.1.3')
    })
    const reparsed = parse(stringify(result.graph))

    expectEmptyGraphDiff(result.graph.diff(reparsed))
    expect(result.applied).toEqual([
      { kind: 'edge-removed', subject: { src: 'case-simple@0.0.0-use.local', dst: 'ms@2.1.3', kind: 'dep' } },
      { kind: 'node-removed', subject: 'ms@2.1.3' },
    ])
  })

  it('roundtrips replaceNode version bump', () => {
    const original = parseFixtureGraph('simple')
    const current = original.getNode('ms@2.1.3')
    expect(current).toBeDefined()

    const result = original.mutate(m => {
      m.replaceNode('ms@2.1.3', {
        ...current!,
        id: 'ms@2.1.4',
        version: '2.1.4',
        resolution: 'ms@npm:2.1.4',
      })
    })
    const reparsed = parse(stringify(result.graph))

    expectEmptyGraphDiff(result.graph.diff(reparsed))
    expect(result.applied).toEqual([
      { kind: 'node-replaced', subject: 'ms@2.1.4' },
    ])
  })

  it('roundtrips setTarball', () => {
    const original = parseFixtureGraph('simple')
    const result = original.mutate(m => {
      m.setTarball({ name: 'ms', version: '2.1.3' }, { integrity: '10c0/modified-ms-integrity' })
    })
    const reparsed = parse(stringify(result.graph))

    expectEmptyGraphDiff(result.graph.diff(reparsed))
    expect(reparsed.tarballOf('ms@2.1.3')).toEqual({ integrity: '10c0/modified-ms-integrity' })
    expect(result.applied).toEqual([
      { kind: 'tarball-set', subject: 'ms@2.1.3' },
    ])
  })

  it('roundtrips removeTarball', () => {
    const original = parseFixtureGraph('simple')
    const result = original.mutate(m => {
      m.removeTarball({ name: 'ms', version: '2.1.3' })
    })
    const reparsed = parse(stringify(result.graph))

    expectEmptyGraphDiff(result.graph.diff(reparsed))
    expect(reparsed.tarballOf('ms@2.1.3')).toBeUndefined()
    expect(result.applied).toEqual([
      { kind: 'tarball-removed', subject: 'ms@2.1.3' },
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
    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: 'YARN_BERRY_V9_PEER_VIRT_FLATTENED',
        severity: 'warning',
        subject: 'react-dom@18.2.0(react@18.2.0)',
        message: expect.stringContaining('["react@18.2.0"]'),
      }),
    ])
    expect(diagnostics[0]?.message).toContain('react-dom@npm:18.2.0')
    expect(result.applied).toEqual([
      { kind: 'peer-context-replaced', subject: 'react-dom@18.2.0(react@18.2.0)' },
    ])
  })

  it('refuses replaceNode on sentinel-keyed entries', () => {
    const graph = parse(fixture('patch-yarn/yarn-berry-v9.lock'))
    const current = graph.getNode('lodash@4.17.21')
    expect(current?.patch?.startsWith('unresolved-')).toBe(true)

    expect(() => graph.mutate(m => {
      m.replaceNode('lodash@4.17.21', {
        ...current!,
        id: 'lodash@4.17.22',
        version: '4.17.22',
        resolution: 'lodash@npm:4.17.22',
      })
    })).toThrow(LockfileError)

    try {
      graph.mutate(m => {
        m.replaceNode('lodash@4.17.21', {
          ...current!,
          id: 'lodash@4.17.22',
          version: '4.17.22',
          resolution: 'lodash@npm:4.17.22',
        })
      })
    } catch (error) {
      expect((error as LockfileError).code).toBe('IRREDUCIBLE_LOSS')
    }
  })
})

describe('yarn-berry-v9 — enrich', () => {
  it('derives a peer edge and virtualizes the consumer when one candidate matches', () => {
    const input =
      '__metadata:\n  version: 9\n\n' +
      '"host@npm:1.0.0":\n' +
      '  version: 1.0.0\n' +
      '  resolution: "host@npm:1.0.0"\n' +
      '  peerDependencies:\n' +
      '    react: ^18.0.0\n' +
      '"react@npm:18.2.0":\n' +
      '  version: 18.2.0\n' +
      '  resolution: "react@npm:18.2.0"\n'

    const result = enrich(parse(input))

    expect(result.diagnostics).toEqual([])
    expect(result.graph.getNode('host@1.0.0(react@18.2.0)')).toBeDefined()
    expect(result.graph.out('host@1.0.0(react@18.2.0)', 'peer')).toEqual([
      {
        src: 'host@1.0.0(react@18.2.0)',
        dst: 'react@18.2.0',
        kind: 'peer',
        attrs: { range: '^18.0.0' },
      },
    ])
  })

  it('warns and leaves the source flat when a peer range is ambiguous', () => {
    const input =
      '__metadata:\n  version: 9\n\n' +
      '"host@npm:1.0.0":\n' +
      '  version: 1.0.0\n' +
      '  resolution: "host@npm:1.0.0"\n' +
      '  peerDependencies:\n' +
      '    react: "*"\n' +
      '"react@npm:17.0.2":\n' +
      '  version: 17.0.2\n' +
      '  resolution: "react@npm:17.0.2"\n' +
      '"react@npm:18.2.0":\n' +
      '  version: 18.2.0\n' +
      '  resolution: "react@npm:18.2.0"\n'

    const result = enrich(parse(input))

    expect(result.graph.getNode('host@1.0.0')).toBeDefined()
    expect(result.graph.out('host@1.0.0', 'peer')).toEqual([])
    expect(result.diagnostics).toEqual([
      {
        code: 'YARN_BERRY_V9_PEER_AMBIGUOUS',
        severity: 'warning',
        subject: 'host@1.0.0',
        message: 'peer "react" matches multiple installed versions: [react@17.0.2, react@18.2.0]',
      },
    ])
  })

  it('warns and leaves the source flat when a peer range is unsatisfied', () => {
    const input =
      '__metadata:\n  version: 9\n\n' +
      '"host@npm:1.0.0":\n' +
      '  version: 1.0.0\n' +
      '  resolution: "host@npm:1.0.0"\n' +
      '  peerDependencies:\n' +
      '    react: ^18.0.0\n' +
      '"react@npm:17.0.2":\n' +
      '  version: 17.0.2\n' +
      '  resolution: "react@npm:17.0.2"\n'

    const result = enrich(parse(input))

    expect(result.graph.getNode('host@1.0.0')).toBeDefined()
    expect(result.graph.out('host@1.0.0', 'peer')).toEqual([])
    expect(result.diagnostics).toEqual([
      {
        code: 'YARN_BERRY_V9_PEER_UNSATISFIED',
        severity: 'warning',
        subject: 'host@1.0.0',
        message: 'peer "react" range "^18.0.0" matches no installed version',
      },
    ])
  })

  it('throws INVALID_INPUT on a malformed peer range', () => {
    const input =
      '__metadata:\n  version: 9\n\n' +
      '"host@npm:1.0.0":\n' +
      '  version: 1.0.0\n' +
      '  resolution: "host@npm:1.0.0"\n' +
      '  peerDependencies:\n' +
      '    react: definitely-not-a-range\n'

    expect(() => enrich(parse(input))).toThrow(LockfileError)
    try {
      enrich(parse(input))
    } catch (error) {
      expect((error as LockfileError).code).toBe('INVALID_INPUT')
      expect((error as Error).message).toContain('react@definitely-not-a-range')
    }
  })

  it('marks workspace: prefixed dependency edges with attrs.workspace = true', () => {
    const input =
      '__metadata:\n  version: 9\n\n' +
      '"app@workspace:packages/app":\n' +
      '  version: 1.0.0\n' +
      '  resolution: "app@workspace:packages/app"\n' +
      '  dependencies:\n' +
      '    core-caret: "workspace:^"\n' +
      '    core-caret-ranged: "workspace:^1.0.0"\n' +
      '    core-exact: "workspace:1.0.0"\n' +
      '    core-link: "workspace:packages/core-link"\n' +
      '    core-range: "workspace:>=1.0.0 <2.0.0"\n' +
      '    core-star: "workspace:*"\n' +
      '    core-tilde-ranged: "workspace:~1.2.3"\n' +
      '    core-tilde: "workspace:~"\n' +
      '    core-x: "workspace:1.x"\n' +
      '"core-caret@workspace:^, core-caret@workspace:packages/core-caret":\n' +
      '  version: 1.2.3\n' +
      '  resolution: "core-caret@workspace:packages/core-caret"\n' +
      '"core-caret-ranged@workspace:^1.0.0, core-caret-ranged@workspace:packages/core-caret-ranged":\n' +
      '  version: 1.2.3\n' +
      '  resolution: "core-caret-ranged@workspace:packages/core-caret-ranged"\n' +
      '"core-exact@workspace:1.0.0, core-exact@workspace:packages/core-exact":\n' +
      '  version: 1.0.0\n' +
      '  resolution: "core-exact@workspace:packages/core-exact"\n' +
      '"core-link@workspace:packages/core-link":\n' +
      '  version: 1.2.3\n' +
      '  resolution: "core-link@workspace:packages/core-link"\n' +
      '"core-range@workspace:>=1.0.0 <2.0.0, core-range@workspace:packages/core-range":\n' +
      '  version: 1.5.0\n' +
      '  resolution: "core-range@workspace:packages/core-range"\n' +
      '"core-star@workspace:*, core-star@workspace:packages/core-star":\n' +
      '  version: 1.2.3\n' +
      '  resolution: "core-star@workspace:packages/core-star"\n' +
      '"core-tilde-ranged@workspace:~1.2.3, core-tilde-ranged@workspace:packages/core-tilde-ranged":\n' +
      '  version: 1.2.4\n' +
      '  resolution: "core-tilde-ranged@workspace:packages/core-tilde-ranged"\n' +
      '"core-tilde@workspace:~, core-tilde@workspace:packages/core-tilde":\n' +
      '  version: 1.2.3\n' +
      '  resolution: "core-tilde@workspace:packages/core-tilde"\n' +
      '"core-x@workspace:1.x, core-x@workspace:packages/core-x":\n' +
      '  version: 1.9.0\n' +
      '  resolution: "core-x@workspace:packages/core-x"\n'

    const result = enrich(parse(input))
    const out = result.graph.out('app@1.0.0').map(edge => ({
      dst: edge.dst,
      range: edge.attrs?.range,
      workspace: edge.attrs?.workspace,
    })).sort((a, b) => a.dst.localeCompare(b.dst))

    expect(out).toEqual([
      { dst: 'core-caret-ranged@1.2.3', range: 'workspace:^1.0.0', workspace: true },
      { dst: 'core-caret@1.2.3', range: 'workspace:^', workspace: true },
      { dst: 'core-exact@1.0.0', range: 'workspace:1.0.0', workspace: true },
      { dst: 'core-link@1.2.3', range: 'workspace:packages/core-link', workspace: true },
      { dst: 'core-range@1.5.0', range: 'workspace:>=1.0.0 <2.0.0', workspace: true },
      { dst: 'core-star@1.2.3', range: 'workspace:*', workspace: true },
      { dst: 'core-tilde-ranged@1.2.4', range: 'workspace:~1.2.3', workspace: true },
      { dst: 'core-tilde@1.2.3', range: 'workspace:~', workspace: true },
      { dst: 'core-x@1.9.0', range: 'workspace:1.x', workspace: true },
    ])
  })

  it('marks semver-shaped workspace ranges with attrs.workspace = true', () => {
    const input =
      '__metadata:\n  version: 9\n\n' +
      '"app@workspace:packages/app":\n' +
      '  version: 1.0.0\n' +
      '  resolution: "app@workspace:packages/app"\n' +
      '  dependencies:\n' +
      '    core-caret: "workspace:^1.0.0"\n' +
      '    core-exact: "workspace:1.0.0"\n' +
      '    core-tilde: "workspace:~1.2.3"\n' +
      '    core-x: "workspace:1.x"\n' +
      '"core-caret@workspace:^1.0.0, core-caret@workspace:packages/core-caret":\n' +
      '  version: 1.2.3\n' +
      '  resolution: "core-caret@workspace:packages/core-caret"\n' +
      '"core-exact@workspace:1.0.0, core-exact@workspace:packages/core-exact":\n' +
      '  version: 1.0.0\n' +
      '  resolution: "core-exact@workspace:packages/core-exact"\n' +
      '"core-tilde@workspace:~1.2.3, core-tilde@workspace:packages/core-tilde":\n' +
      '  version: 1.2.4\n' +
      '  resolution: "core-tilde@workspace:packages/core-tilde"\n' +
      '"core-x@workspace:1.x, core-x@workspace:packages/core-x":\n' +
      '  version: 1.9.0\n' +
      '  resolution: "core-x@workspace:packages/core-x"\n'

    const out = enrich(parse(input)).graph.out('app@1.0.0').map(edge => edge.attrs?.workspace)

    expect(out).toEqual([true, true, true, true])
  })

  it('marks workspace path links with attrs.workspace = true', () => {
    const input =
      '__metadata:\n  version: 9\n\n' +
      '"app@workspace:packages/app":\n' +
      '  version: 1.0.0\n' +
      '  resolution: "app@workspace:packages/app"\n' +
      '  dependencies:\n' +
      '    core: "workspace:packages/core"\n' +
      '"core@workspace:packages/core":\n' +
      '  version: 1.2.3\n' +
      '  resolution: "core@workspace:packages/core"\n'

    expect(enrich(parse(input)).graph.out('app@1.0.0')).toEqual([
      {
        src: 'app@1.0.0',
        dst: 'core@1.2.3',
        kind: 'dep',
        attrs: { range: 'workspace:packages/core', workspace: true },
      },
    ])
  })

  it('remaps ambiguous peer diagnostic candidates after candidate virtualization', () => {
    const input =
      '__metadata:\n  version: 9\n\n' +
      '"host@npm:1.0.0":\n' +
      '  version: 1.0.0\n' +
      '  resolution: "host@npm:1.0.0"\n' +
      '  peerDependencies:\n' +
      '    lib: "*"\n' +
      '"lib@npm:1.0.0":\n' +
      '  version: 1.0.0\n' +
      '  resolution: "lib@npm:1.0.0"\n' +
      '  peerDependencies:\n' +
      '    react: "^17.0.0"\n' +
      '"lib@npm:1.1.0":\n' +
      '  version: 1.1.0\n' +
      '  resolution: "lib@npm:1.1.0"\n' +
      '  peerDependencies:\n' +
      '    react: "^18.0.0"\n' +
      '"react@npm:17.0.2":\n' +
      '  version: 17.0.2\n' +
      '  resolution: "react@npm:17.0.2"\n' +
      '"react@npm:18.2.0":\n' +
      '  version: 18.2.0\n' +
      '  resolution: "react@npm:18.2.0"\n'

    const result = enrich(parse(input))

    expect(result.graph.getNode('lib@1.0.0(react@17.0.2)')).toBeDefined()
    expect(result.graph.getNode('lib@1.1.0(react@18.2.0)')).toBeDefined()
    expect(result.diagnostics).toEqual([
      {
        code: 'YARN_BERRY_V9_PEER_AMBIGUOUS',
        severity: 'warning',
        subject: 'host@1.0.0',
        message: 'peer "lib" matches multiple installed versions: [lib@1.0.0(react@17.0.2), lib@1.1.0(react@18.2.0)]',
      },
    ])
  })

  it('re-derives peers after stringify/parse and closes the §A.4 peers-basic degradation', () => {
    const first = enrich(parseFixtureGraph('peers-basic'))

    expect(first.graph.out('react-dom@18.2.0(react@18.2.0)', 'peer')).toEqual([
      {
        src: 'react-dom@18.2.0(react@18.2.0)',
        dst: 'react@18.2.0',
        kind: 'peer',
        attrs: { range: '^18.2.0' },
      },
    ])

    const second = enrich(parse(stringify(first.graph)))

    expectEmptyGraphDiff(first.graph.diff(second.graph))
  })
})

describe('yarn-berry-v9 — optimize', () => {
  function graphWithOrphan(): Graph {
    const base = parseFixtureGraph('simple')
    return base.mutate(m => {
      m.addNode({
        id: 'orphan@9.9.9',
        name: 'orphan',
        version: '9.9.9',
        peerContext: [],
        resolution: 'orphan@npm:9.9.9',
      })
      m.addEdge('orphan@9.9.9', 'orphan@9.9.9', 'dep', { range: 'npm:9.9.9' })
      m.setTarball({ name: 'orphan', version: '9.9.9' }, { integrity: '10c0/orphan' })
    }).graph
  }

  it('is idempotent', () => {
    const once = optimize(graphWithOrphan())
    const twice = optimize(once.graph)

    expect(graphSnapshot(twice.graph)).toEqual(graphSnapshot(once.graph))
    expect(twice.diagnostics).toEqual(once.diagnostics)
  })

  it('removes exactly the unreachable orphan node', () => {
    const graph = graphWithOrphan()
    const result = optimize(graph)

    expect(result.graph.getNode('orphan@9.9.9')).toBeUndefined()
    expect(graph.diff(result.graph)).toEqual({
      addedNodes: [],
      removedNodes: ['orphan@9.9.9'],
      changedNodes: [],
      addedEdges: [],
      removedEdges: [{ src: 'orphan@9.9.9', dst: 'orphan@9.9.9', kind: 'dep' }],
    })
  })

  it('survives parse/stringify roundtrip', () => {
    const optimized = optimize(graphWithOrphan())
    const reparsed = optimize(parse(stringify(optimized.graph)))

    expect(graphSnapshot(reparsed.graph)).toEqual(graphSnapshot(optimized.graph))
    expect(reparsed.diagnostics).toEqual(optimized.diagnostics)
  })

  it('is a no-op when no orphans exist', () => {
    const graph = parseFixtureGraph('simple')
    const result = optimize(graph)

    expect(graphSnapshot(result.graph)).toEqual(graphSnapshot(graph))
    expect(result.diagnostics).toEqual([])
  })

  it('removes the orphan tarball entry', () => {
    const result = optimize(graphWithOrphan())

    expect(result.graph.tarball({ name: 'orphan', version: '9.9.9' })).toBeUndefined()
    expect(Array.from(result.graph.tarballs(), ([key]) => key)).not.toContain('orphan@9.9.9')
  })
})
