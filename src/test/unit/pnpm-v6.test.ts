import { describe, expect, it } from 'vitest'
import { check, enrich, optimize, parse, stringify } from '../../main/ts/formats/pnpm-v6.ts'
import {
  fixture,
  parseFixtureGraph,
  type PnpmFamilySpec,
} from './_pnpm-flat-test-utils.ts'
import { registerPnpmFlatSuite } from './_pnpm-flat-suite.ts'

// pnpm-v6 spec for the shared pnpm-family harness. Per-version deltas
// (top-level `dependencies` collapsed-root shape, slash-leading packages
// keys, peer-context on packages keys, no snapshots block, dev:false|true
// per-entry flag) are registered as standalone describe() blocks below.
const SPEC: PnpmFamilySpec = {
  label: 'pnpm-v6',
  lockfileVersion: '6.0',
  diagPrefix: 'PNPM_V6',
  fixtureSuffix: 'pnpm-v6.lock',
  adapter: { check, parse, stringify, enrich, optimize },
  crossVersionRejects: ['pnpm-v5.lock', 'pnpm-v9.lock'],
}

registerPnpmFlatSuite(SPEC)

// --- pnpm-v6-only deltas ---------------------------------------------------

describe('pnpm-v6 — schema deltas (top-level dependencies / slash-leading keys)', () => {
  it('parses top-level `dependencies` collapsed-root (no importers block in single-importer mode)', () => {
    const text = fixture('simple/pnpm-v6.lock')
    expect(text).toContain('\ndependencies:\n')
    expect(text).not.toContain('\nimporters:\n')
    const graph = parse(text)
    // The implicit `.` importer pulled from top-level dep blocks materialises root edges.
    const out = graph.out('.@0.0.0', 'dep').map(e => e.dst).sort()
    expect(out).toEqual(['lodash@4.17.21', 'ms@2.1.3'])
  })

  it('parses slash-leading packages keys `/<name>@<version>` into bare NodeIds', () => {
    const text = fixture('simple/pnpm-v6.lock')
    expect(text).toContain('  /lodash@4.17.21:')
    expect(text).toContain('  /ms@2.1.3:')
    const graph = parse(text)
    expect(graph.getNode('lodash@4.17.21')).toBeDefined()
    expect(graph.getNode('ms@2.1.3')).toBeDefined()
  })

  it('parses peer-context directly on packages keys (no separate snapshots block)', () => {
    const text = fixture('peers-basic/pnpm-v6.lock')
    expect(text).toContain('  /react-dom@18.2.0(react@18.2.0):')
    expect(text).not.toContain('\nsnapshots:')
    const graph = parse(text)
    const peerVirtId = 'react-dom@18.2.0(react@18.2.0)'
    expect(graph.getNode(peerVirtId)).toBeDefined()
    expect(graph.getNode(peerVirtId)?.peerContext).toEqual(['react@18.2.0'])
  })

  it('parses inline `dependencies` block under each packages entry as resolved-tree edges', () => {
    const text = fixture('peers-basic/pnpm-v6.lock')
    const graph = parse(text)
    // react-dom@18.2.0(react@18.2.0) inlines deps on loose-envify, react, scheduler.
    const outDeps = graph.out('react-dom@18.2.0(react@18.2.0)', 'dep').map(e => e.dst).sort()
    expect(outDeps).toEqual(['loose-envify@1.4.0', 'react@18.2.0', 'scheduler@0.23.2'])
  })

  it('parses multi-importer fixture using importers block', () => {
    const text = fixture('peers-multi/pnpm-v6.lock')
    expect(text).toContain('importers:')
    const graph = parse(text)
    const wsNodes = Array.from(graph.nodes()).filter(n => n.workspacePath !== undefined && n.workspacePath !== '')
    expect(wsNodes.map(n => n.workspacePath).sort()).toEqual(['packages/a', 'packages/b'])
  })
})

describe('pnpm-v6 — stringify (top-level collapsed shape + dev flag)', () => {
  it('emits top-level `dependencies` in single-importer mode (no importers block)', () => {
    const graph = parseFixtureGraph(SPEC, 'simple')
    const text = stringify(graph)
    expect(text).toMatch(/\ndependencies:\n/)
    expect(text).not.toMatch(/\nimporters:\n/)
  })

  it('emits slash-leading packages keys `/<name>@<version>`', () => {
    const graph = parseFixtureGraph(SPEC, 'simple')
    const text = stringify(graph)
    expect(text).toContain('  /lodash@4.17.21:')
    expect(text).toContain('  /ms@2.1.3:')
  })

  it('emits peer-context directly on packages keys (slash + parens)', () => {
    const graph = parseFixtureGraph(SPEC, 'peers-basic')
    const text = stringify(graph)
    expect(text).toContain('  /react-dom@18.2.0(react@18.2.0):')
  })

  it('does NOT emit `snapshots` block (v6 inlines transitives)', () => {
    const graph = parseFixtureGraph(SPEC, 'peers-basic')
    const text = stringify(graph)
    expect(text).not.toContain('\nsnapshots:')
  })

  it('emits `dev: false` per-entry flag', () => {
    const graph = parseFixtureGraph(SPEC, 'simple')
    const text = stringify(graph)
    // Each packages entry carries a `dev: false` line.
    expect(text).toMatch(/\n    dev: false/)
  })

  it('emits inline `dependencies:` block under packages entries (transitives)', () => {
    const graph = parseFixtureGraph(SPEC, 'peers-basic')
    const text = stringify(graph)
    // react-dom packages entry inlines its transitives.
    const startIdx = text.indexOf('/react-dom@18.2.0(react@18.2.0):')
    expect(startIdx).toBeGreaterThan(0)
    const segment = text.slice(startIdx, text.indexOf('\n  /', startIdx + 1))
    expect(segment).toContain('dependencies:')
    expect(segment).toContain('loose-envify:')
  })

  it('emits multi-importer block when workspace members are present', () => {
    const graph = parseFixtureGraph(SPEC, 'peers-multi')
    const text = stringify(graph)
    expect(text).toContain('importers:')
    expect(text).toMatch(/  \.:/)
    expect(text).toContain('packages/a:')
    expect(text).toContain('packages/b:')
  })
})

describe('pnpm-v6 — discriminant detail', () => {
  it('check() rejects pnpm-v9 fixture (quoted "9.0" vs "6.0")', () => {
    const v9 = fixture('simple/pnpm-v9.lock')
    expect(check(v9)).toBe(false)
  })

  it('check() rejects pnpm-v5 fixture (decimal 5.x vs quoted "6.0")', () => {
    const v5 = fixture('simple/pnpm-v5.lock')
    expect(check(v5)).toBe(false)
  })
})
