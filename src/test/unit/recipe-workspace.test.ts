import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import {
  bunTextWouldCollapse,
  isCanonical as isWorkspaceCanonical,
  isPendingSpecifier,
  isWorkspaceConcrete,
  isWorkspaceEdge,
  isWorkspaceSpecifier,
  isWorkspaceWildcard,
  parse as parseWorkspace,
  shouldEmitWorkspaceResolved,
  stringifyForBunText,
  stringifyForVersionOnly,
  stringifyForWorkspaceProtocol,
  workspaceRangeOfEdge,
} from '../../main/ts/recipe/workspace.ts'
import {
  workspaceCollapsedDiagnostic,
  workspaceResolvedDiagnostic,
  workspaceUnresolvedDiagnostic,
} from '../../main/ts/recipe/diagnostics.ts'
import type { Diagnostic } from '../../main/ts/graph.ts'
import { convert, parse } from '../../main/ts/index.ts'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = (rel: string): string =>
  readFileSync(resolve(here, '../resources/fixtures/lockfiles', rel), 'utf8')

// === Primitive predicates ===================================================

describe('recipe/workspace — predicates', () => {
  it('isWorkspaceSpecifier matches `workspace:`-prefixed strings only', () => {
    expect(isWorkspaceSpecifier('workspace:^')).toBe(true)
    expect(isWorkspaceSpecifier('workspace:~')).toBe(true)
    expect(isWorkspaceSpecifier('workspace:*')).toBe(true)
    expect(isWorkspaceSpecifier('workspace:1.2.3')).toBe(true)
    expect(isWorkspaceSpecifier('workspace:')).toBe(true)
    expect(isWorkspaceSpecifier('')).toBe(false)
    expect(isWorkspaceSpecifier('1.2.3')).toBe(false)
    expect(isWorkspaceSpecifier('^1.2.3')).toBe(false)
  })

  it('isPendingSpecifier matches the empty-string sentinel only', () => {
    expect(isPendingSpecifier('')).toBe(true)
    expect(isPendingSpecifier('workspace:*')).toBe(false)
    expect(isPendingSpecifier('1.0.0')).toBe(false)
  })

  it('isWorkspaceWildcard matches workspace:*, workspace:^, workspace:~', () => {
    expect(isWorkspaceWildcard('workspace:*')).toBe(true)
    expect(isWorkspaceWildcard('workspace:^')).toBe(true)
    expect(isWorkspaceWildcard('workspace:~')).toBe(true)
    expect(isWorkspaceWildcard('workspace:1.0.0')).toBe(false)
    expect(isWorkspaceWildcard('workspace:^1.0.0')).toBe(false)
    expect(isWorkspaceWildcard('')).toBe(false)
    expect(isWorkspaceWildcard('1.0.0')).toBe(false)
  })

  it('isWorkspaceConcrete matches richer-than-wildcard workspace specifiers', () => {
    expect(isWorkspaceConcrete('workspace:1.0.0')).toBe(true)
    expect(isWorkspaceConcrete('workspace:^1.0.0')).toBe(true)
    expect(isWorkspaceConcrete('workspace:>=1')).toBe(true)
    expect(isWorkspaceConcrete('workspace:*')).toBe(false)
    expect(isWorkspaceConcrete('workspace:^')).toBe(false)
    expect(isWorkspaceConcrete('1.0.0')).toBe(false)
  })

  it('bunTextWouldCollapse fires only for richer-than-workspace:* specifiers', () => {
    expect(bunTextWouldCollapse('workspace:^')).toBe(true)
    expect(bunTextWouldCollapse('workspace:~')).toBe(true)
    expect(bunTextWouldCollapse('workspace:1.0.0')).toBe(true)
    expect(bunTextWouldCollapse('workspace:*')).toBe(false)
    expect(bunTextWouldCollapse('')).toBe(false)
    expect(bunTextWouldCollapse('1.0.0')).toBe(false)
  })
})

// === Primitive parse ========================================================

describe('recipe/workspace — parse', () => {
  it('parse with resolvedVersion populates both halves', () => {
    expect(parseWorkspace('workspace:^', '1.2.3')).toEqual({
      specifier: 'workspace:^',
      resolvedVersion: '1.2.3',
    })
  })
  it('parse without resolvedVersion omits the field (pending enrich)', () => {
    expect(parseWorkspace('workspace:^')).toEqual({ specifier: 'workspace:^' })
  })
  it('parse empty specifier (pending sentinel) round-trips verbatim', () => {
    expect(parseWorkspace('', '1.0.0')).toEqual({ specifier: '', resolvedVersion: '1.0.0' })
    expect(parseWorkspace('')).toEqual({ specifier: '' })
  })
  it('parse accepts any string as specifier — no validation', () => {
    expect(parseWorkspace('workspace:1.0.0', '1.0.0')).toEqual({
      specifier: 'workspace:1.0.0',
      resolvedVersion: '1.0.0',
    })
  })

  it('isWorkspaceCanonical narrows runtime values', () => {
    expect(isWorkspaceCanonical({ specifier: 'workspace:^' })).toBe(true)
    expect(isWorkspaceCanonical({ specifier: 'workspace:^', resolvedVersion: '1.0.0' })).toBe(true)
    expect(isWorkspaceCanonical({ specifier: '' })).toBe(true)
    expect(isWorkspaceCanonical({})).toBe(false)
    expect(isWorkspaceCanonical(null)).toBe(false)
    expect(isWorkspaceCanonical({ specifier: 42 })).toBe(false)
    expect(isWorkspaceCanonical({ specifier: 'workspace:^', resolvedVersion: 42 })).toBe(false)
  })
})

// === Primitive stringify ====================================================

describe('recipe/workspace — stringify', () => {
  it('stringifyForWorkspaceProtocol round-trips non-empty specifier verbatim', () => {
    expect(stringifyForWorkspaceProtocol({ specifier: 'workspace:^' })).toBe('workspace:^')
    expect(stringifyForWorkspaceProtocol({ specifier: 'workspace:1.0.0' })).toBe('workspace:1.0.0')
    expect(stringifyForWorkspaceProtocol({ specifier: 'workspace:*' })).toBe('workspace:*')
  })
  it('stringifyForWorkspaceProtocol synthesises workspace:* default for empty pending specifier', () => {
    expect(stringifyForWorkspaceProtocol({ specifier: '' })).toBe('workspace:*')
    expect(stringifyForWorkspaceProtocol({ specifier: '', resolvedVersion: '1.0.0' })).toBe('workspace:*')
  })

  it('stringifyForVersionOnly returns resolvedVersion when defined', () => {
    expect(stringifyForVersionOnly({ specifier: 'workspace:^', resolvedVersion: '1.2.3' })).toBe('1.2.3')
    expect(stringifyForVersionOnly({ specifier: '', resolvedVersion: '1.0.0' })).toBe('1.0.0')
  })
  it('stringifyForVersionOnly returns undefined for unresolved (pending) range', () => {
    expect(stringifyForVersionOnly({ specifier: 'workspace:^' })).toBeUndefined()
    expect(stringifyForVersionOnly({ specifier: '' })).toBeUndefined()
  })

  it('stringifyForBunText collapses any input to workspace:*', () => {
    expect(stringifyForBunText({ specifier: 'workspace:*' })).toBe('workspace:*')
    expect(stringifyForBunText({ specifier: 'workspace:^' })).toBe('workspace:*')
    expect(stringifyForBunText({ specifier: 'workspace:1.0.0' })).toBe('workspace:*')
    expect(stringifyForBunText({ specifier: '' })).toBe('workspace:*')
  })
})

// === workspaceRangeOfEdge synthesis =========================================

describe('recipe/workspace — workspaceRangeOfEdge', () => {
  it('honours explicit attrs.workspaceRange when present', () => {
    const edge = {
      attrs: {
        range: 'workspace:^',
        workspace: true,
        workspaceRange: { specifier: 'workspace:*', resolvedVersion: '1.2.3' },
      },
    }
    const dst = { workspacePath: 'packages/foo', version: '1.0.0' }
    expect(workspaceRangeOfEdge(edge, dst)).toEqual({
      specifier: 'workspace:*',
      resolvedVersion: '1.2.3',
    })
  })

  it('synthesises {specifier:<range>, resolvedVersion:<dst.version>} for workspace-protocol attrs.range', () => {
    const edge = { attrs: { range: 'workspace:^', workspace: true } }
    const dst = { workspacePath: 'packages/foo', version: '1.2.3' }
    expect(workspaceRangeOfEdge(edge, dst)).toEqual({
      specifier: 'workspace:^',
      resolvedVersion: '1.2.3',
    })
  })

  it('uses empty-string pending sentinel when attrs.range lacks workspace: prefix', () => {
    const edge = { attrs: { range: '*', workspace: true } }
    const dst = { workspacePath: 'packages/foo', version: '1.2.3' }
    expect(workspaceRangeOfEdge(edge, dst)).toEqual({
      specifier: '',
      resolvedVersion: '1.2.3',
    })
  })

  it('returns undefined when edge.attrs.workspace !== true (not a workspace edge)', () => {
    // ADR-0014 §4.F4 — FIXIT-2: predicate is the explicit edge marker,
    // not dst.workspacePath. Edges landing on workspace nodes without the
    // marker are NOT eligible for F4 translation.
    const edge = { attrs: { range: 'workspace:^' } }
    const dst = { workspacePath: 'packages/foo', version: '1.2.3' }
    expect(workspaceRangeOfEdge(edge, dst)).toBeUndefined()
  })

  it('omits resolvedVersion when dst.version is undefined or empty', () => {
    const edge = { attrs: { range: 'workspace:^', workspace: true } }
    expect(workspaceRangeOfEdge(edge, { workspacePath: 'pkg' })).toEqual({ specifier: 'workspace:^' })
    expect(workspaceRangeOfEdge(edge, { workspacePath: 'pkg', version: '' })).toEqual({ specifier: 'workspace:^' })
  })
})

// === isWorkspaceEdge + shouldEmitWorkspaceResolved predicates ==============

describe('recipe/workspace — F4 gate predicates', () => {
  it('isWorkspaceEdge gates on attrs.workspace marker', () => {
    expect(isWorkspaceEdge({ attrs: { workspace: true } })).toBe(true)
    expect(isWorkspaceEdge({ attrs: { workspace: false } })).toBe(false)
    expect(isWorkspaceEdge({ attrs: { range: 'workspace:^' } })).toBe(false)
    expect(isWorkspaceEdge({ attrs: {} })).toBe(false)
    expect(isWorkspaceEdge({})).toBe(false)
  })

  it('shouldEmitWorkspaceResolved suppresses (empty) → version spam (B1 gate)', () => {
    expect(shouldEmitWorkspaceResolved({ specifier: 'workspace:^', resolvedVersion: '1.0.0' })).toBe(true)
    expect(shouldEmitWorkspaceResolved({ specifier: 'workspace:*' })).toBe(true)
    // An empty pending specifier carried nothing to drop, so the gate is false.
    expect(shouldEmitWorkspaceResolved({ specifier: '', resolvedVersion: '1.0.0' })).toBe(false)
    expect(shouldEmitWorkspaceResolved({ specifier: '' })).toBe(false)
    expect(shouldEmitWorkspaceResolved(undefined)).toBe(false)
  })
})

// === Diagnostic factories ===================================================

describe('recipe/workspace — diagnostic factories', () => {
  it('workspaceResolvedDiagnostic shape is RECIPE_WORKSPACE_RESOLVED info', () => {
    const d = workspaceResolvedDiagnostic(
      { src: 'app@1.0.0', dst: 'foo@1.2.3', kind: 'dep' },
      'workspace:^',
      '1.2.3',
    )
    expect(d.code).toBe('RECIPE_WORKSPACE_RESOLVED')
    expect(d.severity).toBe('info')
    expect(d.subject).toEqual({ src: 'app@1.0.0', dst: 'foo@1.2.3', kind: 'dep' })
    expect(d.message).toContain('workspace:^')
    expect(d.message).toContain('1.2.3')
  })

  it('workspaceResolvedDiagnostic renders empty specifier as (empty)', () => {
    const d = workspaceResolvedDiagnostic(
      { src: 'app@1.0.0', dst: 'foo@1.2.3', kind: 'dep' },
      '',
      '1.2.3',
    )
    expect(d.message).toContain('(empty)')
  })

  it('workspaceCollapsedDiagnostic shape is RECIPE_WORKSPACE_COLLAPSED info', () => {
    const d = workspaceCollapsedDiagnostic(
      { src: 'app@1.0.0', dst: 'foo@1.2.3', kind: 'dep' },
      'workspace:^',
    )
    expect(d.code).toBe('RECIPE_WORKSPACE_COLLAPSED')
    expect(d.severity).toBe('info')
    expect(d.message).toContain('workspace:^')
    expect(d.message).toContain('workspace:*')
  })

  it('workspaceUnresolvedDiagnostic shape is RECIPE_WORKSPACE_UNRESOLVED warning', () => {
    const d = workspaceUnresolvedDiagnostic({ src: 'app@1.0.0', dst: 'foo@1.0.0', kind: 'dep' })
    expect(d.code).toBe('RECIPE_WORKSPACE_UNRESOLVED')
    expect(d.severity).toBe('warning')
  })
})

// === Integration via public surface =========================================

import * as yarnBerryV9 from '../../main/ts/formats/yarn-berry-v9.ts'
import * as npm2 from '../../main/ts/formats/npm-2.ts'
import * as npm3 from '../../main/ts/formats/npm-3.ts'
import * as yarnClassic from '../../main/ts/formats/yarn-classic.ts'
import type { Graph as GraphType } from '../../main/ts/graph.ts'

describe('recipe/workspace — parse populates attrs on workspace edges', () => {
  it('yarn-berry-v9 workspace edges carry workspace:<spec> in attrs.range', () => {
    const g = parse('yarn-berry-v9', fixture('workspace-cross-refs/yarn-berry-v9.lock'))
    const appId = '@case-ws/app@0.0.0-use.local'
    const edges = g.out(appId)
    const wsEdges = edges.filter(e => typeof e.attrs?.range === 'string' && e.attrs.range.startsWith('workspace:'))
    expect(wsEdges.length).toBeGreaterThan(0)
  })

  it('yarn-berry-v9 parse + enrich populate attrs.workspaceRange = { specifier: workspace:<spec>, resolvedVersion: <dst.version> }', () => {
    // FIXIT-3 — yarn-berry now marks workspace edges at parse time via
    // `markWorkspaceEdgesAtParse()` (mirrors enrich-time logic so convert
    // path produces F4-ready edges without explicit enrich step). Enrich
    // is still exercised here for belt-and-suspenders verification, but
    // the parse-side carrier is the primary source of truth.
    const g0 = parse('yarn-berry-v9', fixture('workspace-cross-refs/yarn-berry-v9.lock'))
    const g = yarnBerryV9.enrich(g0).graph
    const appId = '@case-ws/app@0.0.0-use.local'
    const wsEdges = g.out(appId).filter(e => e.attrs?.workspace === true)
    expect(wsEdges.length).toBeGreaterThan(0)
    for (const edge of wsEdges) {
      expect(edge.attrs?.workspaceRange).toBeDefined()
      expect(edge.attrs?.workspaceRange?.specifier).toMatch(/^workspace:/)
      expect(edge.attrs?.workspaceRange?.resolvedVersion).toBe('0.0.0-use.local')
    }
  })

  it('pnpm-v9 parse populates attrs.workspaceRange = { specifier: workspace:<spec>, resolvedVersion: <dst.version> }', () => {
    const g = parse('pnpm-v9', fixture('workspace-cross-refs/pnpm-v9.lock'))
    // pnpm importer NodeId is `<importerPath>@<version>` (synthesised
    // member nodes; manifests don't drive identity here).
    const appId = 'packages/app@0.0.0'
    const wsEdges = g.out(appId).filter(e => e.attrs?.workspace === true)
    expect(wsEdges.length).toBeGreaterThan(0)
    for (const edge of wsEdges) {
      expect(edge.attrs?.workspaceRange).toBeDefined()
      expect(edge.attrs?.workspaceRange?.specifier).toMatch(/^workspace:/)
      expect(edge.attrs?.workspaceRange?.resolvedVersion).toBe('0.0.0')
    }
  })

  it('npm-2 enrich populates attrs.workspaceRange = { specifier: "", resolvedVersion: <dst.version> } (empty pending)', async () => {
    // npm-2/3 link entries carry no source-side specifier — F4 canonical
    // is the empty pending sentinel + dst.version best-effort. Use the
    // convert path from yarn-berry-v9 (which carries actual root-to-
    // workspace-member edges) → npm-2, then re-parse + enrich the result
    // to exercise the marking pass on a realistic edge set.
    const npm2Text = await convert(fixture('workspace-cross-refs/yarn-berry-v9.lock'), {
      from: 'yarn-berry-v9',
      to:   'npm-2',
      strict: false,
    })
    const g0 = parse('npm-2', npm2Text)
    const g = npm2.enrich(g0).graph as GraphType
    let found = 0
    for (const node of g.nodes()) {
      for (const edge of g.out(node.id)) {
        if (edge.attrs?.workspace !== true) continue
        found++
        expect(edge.attrs?.workspaceRange).toBeDefined()
        expect(edge.attrs?.workspaceRange?.specifier).toBe('')
        expect(edge.attrs?.workspaceRange?.resolvedVersion).toBeDefined()
      }
    }
    expect(found).toBeGreaterThan(0)
  })

  it('npm-3 enrich populates attrs.workspaceRange = { specifier: "", resolvedVersion: <dst.version> }', async () => {
    const npm3Text = await convert(fixture('workspace-cross-refs/yarn-berry-v9.lock'), {
      from: 'yarn-berry-v9',
      to:   'npm-3',
      strict: false,
    })
    const g0 = parse('npm-3', npm3Text)
    const g = npm3.enrich(g0).graph as GraphType
    let found = 0
    for (const node of g.nodes()) {
      for (const edge of g.out(node.id)) {
        if (edge.attrs?.workspace !== true) continue
        found++
        expect(edge.attrs?.workspaceRange?.specifier).toBe('')
        expect(edge.attrs?.workspaceRange?.resolvedVersion).toBeDefined()
      }
    }
    expect(found).toBeGreaterThan(0)
  })

  it('bun-text parse populates attrs.workspaceRange = { specifier: "workspace:*", resolvedVersion: <dst.version> }', () => {
    const g = parse('bun-text', fixture('workspace-cross-refs/bun-text.lock'))
    const appId = '@case-ws/app@1.0.0'
    const wsEdges = g.out(appId).filter(e => e.attrs?.workspace === true)
    expect(wsEdges.length).toBeGreaterThan(0)
    for (const edge of wsEdges) {
      expect(edge.attrs?.workspaceRange?.specifier).toBe('workspace:*')
      // bun-text member versions vary across fixture entries (1.0.0 here);
      // assert it's defined and non-empty.
      expect(edge.attrs?.workspaceRange?.resolvedVersion).toBeTruthy()
    }
  })

  it('yarn-classic convert from yarn-berry-v9 populates attrs.workspaceRange (sentinel-version-only) on re-parse + enrich', async () => {
    // yarn-classic owns workspace marking via enrich (manifests-driven);
    // use the convert path to produce a yarn-classic lockfile carrying
    // workspace edges, then re-parse + enrich with manifests reflecting
    // the cross-refs fixture topology.
    const yarnText = await convert(fixture('workspace-cross-refs/yarn-berry-v9.lock'), {
      from: 'yarn-berry-v9',
      to:   'yarn-classic',
      strict: false,
    })
    const g0 = parse('yarn-classic', yarnText)
    const g = yarnClassic.enrich(g0, undefined, {
      manifests: {
        '': {
          name: 'case-workspace-cross-refs',
          version: '0.0.0',
          dependencies: {
            '@case-ws/app':  'workspace:*',
            '@case-ws/core': 'workspace:*',
            '@case-ws/util': 'workspace:*',
          },
        },
        'packages/app':  { name: '@case-ws/app',  version: '0.0.0', dependencies: { '@case-ws/core': 'workspace:*', '@case-ws/util': 'workspace:1.0.0' } },
        'packages/core': { name: '@case-ws/core', version: '0.0.0', dependencies: { ms: '2.1.3' } },
        'packages/util': { name: '@case-ws/util', version: '0.0.0', dependencies: { '@case-ws/core': 'workspace:^' } },
      },
    }).graph as GraphType
    let found = 0
    for (const node of g.nodes()) {
      for (const edge of g.out(node.id)) {
        if (edge.attrs?.workspace !== true) continue
        const dst = g.getNode(edge.dst)
        if (dst?.workspacePath === undefined) continue
        found++
        expect(edge.attrs?.workspaceRange).toBeDefined()
        // yarn-classic root deps may carry source-side `workspace:` ranges
        // when the root manifest spells them; the no-manifest path produces
        // empty pending. Accept either shape so the test is robust across
        // root-spec variants — invariant is "sidecar populated".
        const spec = edge.attrs?.workspaceRange?.specifier
        expect(spec === '' || spec?.startsWith('workspace:')).toBe(true)
        expect(edge.attrs?.workspaceRange?.resolvedVersion).toBeTruthy()
      }
    }
    expect(found).toBeGreaterThan(0)
  })
})

// === Cross-format conversion ================================================

describe('recipe/workspace — yarn-berry-v9 → pnpm-v9 (both protocol-bearing): no F4 diagnostic', () => {
  it('workspace specifier survives without RECIPE_WORKSPACE_* fire', async () => {
    const diags: Diagnostic[] = []
    const out = await convert(fixture('workspace-cross-refs/yarn-berry-v9.lock'), {
      from: 'yarn-berry-v9',
      to:   'pnpm-v9',
      strict: false,
      onDiagnostic: d => diags.push(d),
    })
    expect(out).toContain('workspace:')
    const f4 = diags.filter(d =>
      d.code === 'RECIPE_WORKSPACE_RESOLVED'
      || d.code === 'RECIPE_WORKSPACE_COLLAPSED'
      || d.code === 'RECIPE_WORKSPACE_UNRESOLVED'
    )
    expect(f4).toEqual([])
  })
})

describe('recipe/workspace — yarn-berry-v9 → yarn-classic fires RECIPE_WORKSPACE_RESOLVED', () => {
  it('emit substitutes resolvedVersion + fires info per edge', async () => {
    const diags: Diagnostic[] = []
    const out = await convert(fixture('workspace-cross-refs/yarn-berry-v9.lock'), {
      from: 'yarn-berry-v9',
      to:   'yarn-classic',
      strict: false,
      onDiagnostic: d => diags.push(d),
    })
    const resolved = diags.filter(d => d.code === 'RECIPE_WORKSPACE_RESOLVED')
    expect(resolved.length).toBeGreaterThan(0)
    // Specifier dropped on emit — the dep block should not carry the `workspace:` protocol.
    // yarn-classic dep block lines look like `    "@case-ws/core" "<range>"` — confirm no `workspace:`.
    expect(out).not.toMatch(/"workspace:[^"]*"/)
  })
})

describe('recipe/workspace — yarn-berry-v9 → npm-3 fires RECIPE_WORKSPACE_RESOLVED', () => {
  it('emit replaces workspace:* with resolvedVersion in package deps + link:true survives', async () => {
    const diags: Diagnostic[] = []
    const out = await convert(fixture('workspace-cross-refs/yarn-berry-v9.lock'), {
      from: 'yarn-berry-v9',
      to:   'npm-3',
      strict: false,
      onDiagnostic: d => diags.push(d),
    })
    const resolved = diags.filter(d => d.code === 'RECIPE_WORKSPACE_RESOLVED')
    expect(resolved.length).toBeGreaterThan(0)
    expect(out).toMatch(/"link":\s*true/)
  })
})

describe('recipe/workspace — yarn-berry-v9 → bun-text fires RECIPE_WORKSPACE_COLLAPSED for richer specifiers', () => {
  it('source `workspace:^` / `workspace:1.0.0` collapse to workspace:* (info per edge)', async () => {
    const diags: Diagnostic[] = []
    await convert(fixture('workspace-cross-refs/yarn-berry-v9.lock'), {
      from: 'yarn-berry-v9',
      to:   'bun-text',
      strict: false,
      onDiagnostic: d => diags.push(d),
    })
    const collapsed = diags.filter(d => d.code === 'RECIPE_WORKSPACE_COLLAPSED')
    expect(collapsed.length).toBeGreaterThan(0)
  })
})

describe('recipe/workspace — yarn-berry-v9 → npm-1 fires RECIPE_FEATURE_DROPPED (workspace)', () => {
  it('npm-1 drops workspace concept entirely per ADR-0021 §A', async () => {
    const diags: Diagnostic[] = []
    await convert(fixture('workspace-cross-refs/yarn-berry-v9.lock'), {
      from: 'yarn-berry-v9',
      to:   'npm-1',
      strict: false,
      onDiagnostic: d => diags.push(d),
    })
    const wsDrops = diags.filter(d =>
      d.code === 'RECIPE_FEATURE_DROPPED'
      && typeof d.message === 'string'
      && d.message.startsWith('workspace dropped'),
    )
    expect(wsDrops.length).toBeGreaterThan(0)
  })
})
