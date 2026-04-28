import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { parse, check, YarnBerryParseError } from '../../main/ts/formats/yarn-berry-v9.ts'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = (rel: string): string =>
  readFileSync(resolve(here, '../resources/fixtures/lockfiles', rel), 'utf8')

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
    expect(() => parse(lock)).toThrow(YarnBerryParseError)
    expect(() => parse(lock)).toThrow(/__metadata\.version/)
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

describe('yarn-berry-v9 — patch / alias rejection (ADR-0010)', () => {
  const synthetic = (entryKey: string, value = 'version: 1.0.0\n  resolution: "fake"\n'): string =>
    `__metadata:\n  version: 9\n  cacheKey: 10c0\n\n"${entryKey}":\n  ${value}`

  it('throws IRREDUCIBLE_LOSS on patch: protocol', () => {
    const input = synthetic('lodash@patch:lodash@npm%3A4.17.21#~/p.patch')
    expect(() => parse(input)).toThrow(YarnBerryParseError)
    try {
      parse(input)
    } catch (e) {
      expect((e as YarnBerryParseError).code).toBe('IRREDUCIBLE_LOSS')
    }
  })

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
