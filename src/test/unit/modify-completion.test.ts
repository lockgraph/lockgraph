// ADR-0023 §9.2 — tree completion BFS acceptance gate.

import { describe, expect, it } from 'vitest'
import { completeTransitives } from '../../main/ts/complete/tree-complete.ts'
import { frozenRegistry } from '../../main/ts/registry/frozen.ts'
import type { Packument, RegistryAdapter } from '../../main/ts/registry/types.ts'
import { addEdge, addPackage, graphOf } from './_modify-test-utils.ts'

describe('complete/completeTransitives', () => {
  it('no-op when graph is already fully wired', async () => {
    const graph = graphOf(builder => {
      const ws = addPackage(builder, { name: 'app', version: '0.0.0', workspacePath: '.' })
      const lodash = addPackage(builder, { name: 'lodash', version: '4.17.21' })
      addEdge(builder, ws, lodash, 'dep')
    })

    const result = await completeTransitives(graph, frozenRegistry(graph))
    expect(result.added).toEqual([])
    expect(result.wired).toEqual([])
  })

  it('workspace skip — workspace nodes are not queried as packument targets', async () => {
    const graph = graphOf(builder => {
      addPackage(builder, { name: '@my/workspace', version: '1.0.0', workspacePath: 'packages/workspace' })
    })

    // frozenRegistry returns undefined for workspace; completion must
    // skip the workspace node, not emit COMPLETION_NODE_UNKNOWN.
    const result = await completeTransitives(graph, frozenRegistry(graph))
    const codes = result.unresolved.map(d => d.code)
    expect(codes).not.toContain('COMPLETION_NODE_UNKNOWN')
  })

  it('walks workspace OUT-edges normally even when workspace itself is skipped', async () => {
    const graph = graphOf(builder => {
      const ws = addPackage(builder, { name: '@my/ws', version: '1.0.0', workspacePath: '.' })
      const lodash = addPackage(builder, { name: 'lodash', version: '4.17.21' })
      addEdge(builder, ws, lodash, 'dep')
    })

    // Workspace is skipped, but lodash should be visited (via the out-edge walk).
    const result = await completeTransitives(graph, frozenRegistry(graph))
    expect(result.unresolved.filter(d => d.code === 'COMPLETION_NODE_UNKNOWN')).toEqual([])
  })

  it('seed-driven — recently-added nodes seed the frontier', async () => {
    const graph = graphOf(builder => {
      const ws = addPackage(builder, { name: 'app', version: '0.0.0', workspacePath: '.' })
      const a = addPackage(builder, { name: 'a', version: '1.0.0' })
      addEdge(builder, ws, a, 'dep')
    })

    const result = await completeTransitives(graph, frozenRegistry(graph), {
      seed: {
        recentlyAdded:    new Set(['a@1.0.0']),
        recentlyOrphaned: new Set(),
      },
    })
    expect(result.added).toEqual([])
  })

  it('orphan exclusion — recently-orphaned NodeIds are skipped from the frontier seed', async () => {
    // We build a graph where one node is technically a root (no incoming
    // edges) but marked as orphaned. Without the exclusion it would be
    // visited; with it, no COMPLETION_NODE_UNKNOWN emits for it (assuming
    // frozenRegistry has its packument).
    const graph = graphOf(builder => {
      const ws = addPackage(builder, { name: 'app', version: '0.0.0', workspacePath: '.' })
      const a = addPackage(builder, { name: 'a', version: '1.0.0' })
      // a is a root (no incoming edges) but we tag it orphaned.
      addEdge(builder, ws, a, 'dep')   // give a parent so frozenRegistry sees it
    })

    // Mark a@1.0.0 as orphaned; the BFS frontier should not seed it.
    // Roots() returns workspace 'app' only (since a has incoming from ws).
    // So this test mainly checks the seed code path doesn't crash when
    // recentlyOrphaned is non-empty.
    const result = await completeTransitives(graph, frozenRegistry(graph), {
      seed: {
        recentlyAdded:    new Set(),
        recentlyOrphaned: new Set(['a@1.0.0']),
      },
    })
    expect(result.added).toEqual([])
  })

  it('monotone-additive — never removes existing nodes', async () => {
    const graph = graphOf(builder => {
      const ws = addPackage(builder, { name: 'app', version: '0.0.0', workspacePath: '.' })
      const orphan = addPackage(builder, { name: 'orphan', version: '1.0.0' })
      addEdge(builder, ws, 'orphan@1.0.0', 'dep')
    })

    const before = new Set(Array.from(graph.nodes()).map(n => n.id))
    const result = await completeTransitives(graph, frozenRegistry(graph))
    const after = new Set(Array.from(result.graph.nodes()).map(n => n.id))
    // Every "before" node still exists in "after".
    for (const id of before) expect(after.has(id)).toBe(true)
  })

  it('async fixpoint — second invocation is a no-op', async () => {
    const graph = graphOf(builder => {
      const ws = addPackage(builder, { name: 'app', version: '0.0.0', workspacePath: '.' })
      const lodash = addPackage(builder, { name: 'lodash', version: '4.17.21' })
      addEdge(builder, ws, lodash, 'dep')
    })

    const first  = await completeTransitives(graph, frozenRegistry(graph))
    const second = await completeTransitives(first.graph, frozenRegistry(first.graph))
    expect(second.added).toEqual([])
    expect(second.wired).toEqual([])
  })

  it('frozen registry — COMPLETION_UNRESOLVED when packument lacks a needed transitive', async () => {
    // Compose a frozen registry that says lodash depends on ms@^2,
    // but only lodash itself is in the graph — ms is unknown.
    const graph = graphOf(builder => {
      const ws = addPackage(builder, { name: 'app', version: '0.0.0', workspacePath: '.' })
      addPackage(builder, { name: 'lodash', version: '4.17.21' })
      addEdge(builder, ws, 'lodash@4.17.21', 'dep')
    })

    // Hand-roll a registry that adds an `ms@^2` dep to lodash@4.17.21.
    const lodashPkg: Packument = {
      name: 'lodash',
      distTags: { latest: '4.17.21' },
      versions: {
        '4.17.21': {
          name: 'lodash',
          version: '4.17.21',
          dependencies: { ms: '^2.0.0' },
        },
      },
    }
    const fakeRegistry: RegistryAdapter = {
      async packument(name) {
        if (name === 'lodash') return lodashPkg
        return undefined
      },
      async resolve(name, range) {
        if (name === 'lodash' && range === '4.17.21') {
          return { name: 'lodash', version: '4.17.21' }
        }
        return undefined
      },
    }

    const result = await completeTransitives(graph, fakeRegistry)
    const codes = result.unresolved.map(d => d.code)
    expect(codes).toContain('COMPLETION_UNRESOLVED')
  })

  it('happy-path completion — wires a transitive that the registry can resolve', async () => {
    const graph = graphOf(builder => {
      const ws = addPackage(builder, { name: 'app', version: '0.0.0', workspacePath: '.' })
      addPackage(builder, { name: 'lodash', version: '4.17.21' })
      addEdge(builder, ws, 'lodash@4.17.21', 'dep')
    })

    const lodashPkg: Packument = {
      name: 'lodash',
      distTags: { latest: '4.17.21' },
      versions: {
        '4.17.21': {
          name: 'lodash',
          version: '4.17.21',
          dependencies: { ms: '^2.0.0' },
        },
      },
    }
    const msPkg: Packument = {
      name: 'ms',
      distTags: { latest: '2.1.3' },
      versions: {
        '2.1.3': { name: 'ms', version: '2.1.3' },
      },
    }
    const fakeRegistry: RegistryAdapter = {
      async packument(name) {
        if (name === 'lodash') return lodashPkg
        if (name === 'ms') return msPkg
        return undefined
      },
      async resolve(name, range) {
        if (name === 'lodash') return { name: 'lodash', version: '4.17.21' }
        if (name === 'ms' && range === '^2.0.0') return { name: 'ms', version: '2.1.3' }
        return undefined
      },
    }

    const result = await completeTransitives(graph, fakeRegistry)
    expect(result.added).toContain('ms@2.1.3')
    expect(result.graph.getNode('ms@2.1.3')).toBeDefined()
    // Edge wired: lodash → ms
    const lodashOut = result.graph.out('lodash@4.17.21')
    expect(lodashOut.some(e => e.dst === 'ms@2.1.3' && e.kind === 'dep')).toBe(true)
  })

  // ADR-0023 §8.6 — COMPLETION_* diagnostics land on Graph.diagnostics().
  it('§8.6 — COMPLETION_NODE_ADDED lands on Graph.diagnostics()', async () => {
    const graph = graphOf(builder => {
      const ws = addPackage(builder, { name: 'app', version: '0.0.0', workspacePath: '.' })
      addPackage(builder, { name: 'lodash', version: '4.17.21' })
      addEdge(builder, ws, 'lodash@4.17.21', 'dep')
    })

    const lodashPkg: Packument = {
      name: 'lodash',
      distTags: { latest: '4.17.21' },
      versions: {
        '4.17.21': {
          name: 'lodash',
          version: '4.17.21',
          dependencies: { ms: '^2.0.0' },
        },
      },
    }
    const msPkg: Packument = {
      name: 'ms',
      distTags: { latest: '2.1.3' },
      versions: { '2.1.3': { name: 'ms', version: '2.1.3' } },
    }
    const fakeRegistry: RegistryAdapter = {
      async packument(name) {
        if (name === 'lodash') return lodashPkg
        if (name === 'ms') return msPkg
        return undefined
      },
      async resolve(name, range) {
        if (name === 'lodash') return { name: 'lodash', version: '4.17.21' }
        if (name === 'ms' && range === '^2.0.0') return { name: 'ms', version: '2.1.3' }
        return undefined
      },
    }

    const result = await completeTransitives(graph, fakeRegistry)
    const codes = result.graph.diagnostics().map(d => d.code)
    expect(codes).toContain('COMPLETION_NODE_ADDED')
  })

  it('§8.6 — COMPLETION_UNRESOLVED lands on Graph.diagnostics()', async () => {
    const graph = graphOf(builder => {
      const ws = addPackage(builder, { name: 'app', version: '0.0.0', workspacePath: '.' })
      addPackage(builder, { name: 'lodash', version: '4.17.21' })
      addEdge(builder, ws, 'lodash@4.17.21', 'dep')
    })

    const lodashPkg: Packument = {
      name: 'lodash',
      distTags: { latest: '4.17.21' },
      versions: {
        '4.17.21': {
          name: 'lodash',
          version: '4.17.21',
          dependencies: { 'missing-dep': '^1.0.0' },
        },
      },
    }
    const fakeRegistry: RegistryAdapter = {
      async packument(name) {
        if (name === 'lodash') return lodashPkg
        return undefined
      },
      async resolve(name) {
        if (name === 'lodash') return { name: 'lodash', version: '4.17.21' }
        return undefined
      },
    }

    const result = await completeTransitives(graph, fakeRegistry)
    const codes = result.graph.diagnostics().map(d => d.code)
    expect(codes).toContain('COMPLETION_UNRESOLVED')
  })

  // NIT-C — info-severity diagnostics flow through ModifyResult.unresolved
  // (previous build dropped them, asymmetric with per-primitive modifiers).
  it('§7.5 — info-severity COMPLETION_NODE_ADDED appears in unresolved (NIT-C symmetry)', async () => {
    const graph = graphOf(builder => {
      const ws = addPackage(builder, { name: 'app', version: '0.0.0', workspacePath: '.' })
      addPackage(builder, { name: 'lodash', version: '4.17.21' })
      addEdge(builder, ws, 'lodash@4.17.21', 'dep')
    })

    const lodashPkg: Packument = {
      name: 'lodash',
      distTags: { latest: '4.17.21' },
      versions: {
        '4.17.21': {
          name:         'lodash',
          version:      '4.17.21',
          dependencies: { ms: '^2.0.0' },
        },
      },
    }
    const msPkg: Packument = {
      name:     'ms',
      distTags: { latest: '2.1.3' },
      versions: { '2.1.3': { name: 'ms', version: '2.1.3' } },
    }
    const fakeRegistry: RegistryAdapter = {
      async packument(name) {
        if (name === 'lodash') return lodashPkg
        if (name === 'ms')     return msPkg
        return undefined
      },
      async resolve(name, range) {
        if (name === 'lodash')                        return { name: 'lodash', version: '4.17.21' }
        if (name === 'ms' && range === '^2.0.0')      return { name: 'ms', version: '2.1.3' }
        return undefined
      },
    }

    const result = await completeTransitives(graph, fakeRegistry)
    const codes  = result.unresolved.map(d => d.code)
    // The added ms node fires an info-level COMPLETION_NODE_ADDED — must
    // appear in unresolved post-NIT-C (was previously dropped by the
    // severity filter at L78).
    expect(codes).toContain('COMPLETION_NODE_ADDED')
  })

  it('§7.5 — Graph.diagnostics() and unresolved are symmetric across severities (NIT-C)', async () => {
    // The two channels (Graph-level + streaming hook) must carry the same
    // diagnostic set after NIT-C alignment — previously info-severity events
    // landed on Graph but were filtered out of unresolved.
    const graph = graphOf(builder => {
      const ws = addPackage(builder, { name: 'app', version: '0.0.0', workspacePath: '.' })
      addPackage(builder, { name: 'lodash', version: '4.17.21' })
      addEdge(builder, ws, 'lodash@4.17.21', 'dep')
    })

    const lodashPkg: Packument = {
      name: 'lodash',
      distTags: { latest: '4.17.21' },
      versions: {
        '4.17.21': {
          name:         'lodash',
          version:      '4.17.21',
          dependencies: { ms: '^2.0.0' },
        },
      },
    }
    const msPkg: Packument = {
      name:     'ms',
      distTags: { latest: '2.1.3' },
      versions: { '2.1.3': { name: 'ms', version: '2.1.3' } },
    }
    const fakeRegistry: RegistryAdapter = {
      async packument(name) {
        if (name === 'lodash') return lodashPkg
        if (name === 'ms')     return msPkg
        return undefined
      },
      async resolve(name, range) {
        if (name === 'lodash')                   return { name: 'lodash', version: '4.17.21' }
        if (name === 'ms' && range === '^2.0.0') return { name: 'ms', version: '2.1.3' }
        return undefined
      },
    }

    const result      = await completeTransitives(graph, fakeRegistry)
    const graphCodes  = result.graph.diagnostics().map(d => d.code).sort()
    const streamCodes = result.unresolved.map(d => d.code).sort()
    expect(streamCodes).toEqual(graphCodes)
  })

  it('excludes a transitive node\'s devDependencies — does not traverse the dev universe', async () => {
    // `file-exists` (a transitive dep) has a prod dep (`debug`) AND devDeps
    // (`jest` / `typescript`). Completion must follow only the install tree —
    // a transitive's devDependencies are never installed; traversing them pulls
    // the whole dev universe and never terminates.
    const graph = graphOf(builder => {
      const ws = addPackage(builder, { name: 'app', version: '0.0.0', workspacePath: '.' })
      addPackage(builder, { name: 'file-exists', version: '1.1.1' })
      addEdge(builder, ws, 'file-exists@1.1.1', 'dep')
    })

    const requested: string[] = []
    const pkgs: Record<string, Packument> = {
      'file-exists': {
        name: 'file-exists', distTags: { latest: '1.1.1' },
        versions: { '1.1.1': { name: 'file-exists', version: '1.1.1',
          dependencies: { debug: '^4.0.0' },
          devDependencies: { jest: '^29.0.0', typescript: '^5.0.0' } } },
      },
      debug:      { name: 'debug',      distTags: { latest: '4.3.4' },  versions: { '4.3.4':  { name: 'debug',      version: '4.3.4' } } },
      jest:       { name: 'jest',       distTags: { latest: '29.0.0' }, versions: { '29.0.0': { name: 'jest',       version: '29.0.0' } } },
      typescript: { name: 'typescript', distTags: { latest: '5.0.0' },  versions: { '5.0.0':  { name: 'typescript', version: '5.0.0' } } },
    }
    const ver: Record<string, string> = { debug: '4.3.4', jest: '29.0.0', typescript: '5.0.0' }
    const fakeRegistry: RegistryAdapter = {
      async packument(name) { requested.push(name); return pkgs[name] },
      async resolve(name) {
        const v = ver[name]
        return v !== undefined ? { name, version: v } : undefined
      },
    }

    const result = await completeTransitives(graph, fakeRegistry)

    // prod dep followed:
    expect(result.graph.getNode('debug@4.3.4')).toBeDefined()
    // devDependencies NEVER traversed — no dev node lands, no dev packument fetched:
    expect(result.graph.getNode('jest@29.0.0')).toBeUndefined()
    expect(result.graph.getNode('typescript@5.0.0')).toBeUndefined()
    expect(requested).not.toContain('jest')
    expect(requested).not.toContain('typescript')
  })

  // Anton's wish 2026-06-21 — when a freshly-introduced transitive's range is
  // already met by a version PRESENT in the lockfile (but not find-up-reachable
  // from the consumer), reuse it instead of fetching the registry's latest.
  it('reuse — a new dep binds to an existing satisfying version, not a registry fetch', async () => {
    // bumped@2.0.0 newly declares foo:^1.0.0. foo@1.2.0 already lives in the
    // project under an UNRELATED branch (`other`), so find-up from `bumped`
    // can't see it — but project-wide reuse must.
    const graph = graphOf(builder => {
      const ws     = addPackage(builder, { name: 'app',    version: '0.0.0', workspacePath: '.' })
      const bumped = addPackage(builder, { name: 'bumped', version: '2.0.0' })
      const other  = addPackage(builder, { name: 'other',  version: '1.0.0' })
      const foo    = addPackage(builder, { name: 'foo',    version: '1.2.0' })
      addEdge(builder, ws,    bumped, 'dep')
      addEdge(builder, ws,    other,  'dep')
      addEdge(builder, other, foo,    'dep', '^1.0.0')   // existing, satisfies ^1.0.0
    })

    const resolved: string[] = []
    const pkgs: Record<string, Packument> = {
      bumped: { name: 'bumped', distTags: { latest: '2.0.0' }, versions: { '2.0.0': { name: 'bumped', version: '2.0.0', dependencies: { foo: '^1.0.0' } } } },
      other:  { name: 'other',  distTags: { latest: '1.0.0' }, versions: { '1.0.0': { name: 'other',  version: '1.0.0' } } },
      foo:    { name: 'foo',    distTags: { latest: '1.5.0' }, versions: { '1.2.0': { name: 'foo', version: '1.2.0' }, '1.5.0': { name: 'foo', version: '1.5.0' } } },
    }
    const fakeRegistry: RegistryAdapter = {
      async packument(name) { return pkgs[name] },
      async resolve(name, range) {
        resolved.push(name)
        if (name === 'foo' && range === '^1.0.0') return { name: 'foo', version: '1.5.0' } // latest — must NOT be used
        const v = pkgs[name]?.distTags.latest
        return v !== undefined ? { name, version: v } : undefined
      },
    }

    const result = await completeTransitives(graph, fakeRegistry, { resolution: 'prefer-existing' })

    // bumped → foo wired to the EXISTING 1.2.0, latest 1.5.0 never materialised.
    const bumpedOut = result.graph.out('bumped@2.0.0')
    expect(bumpedOut.some(e => e.dst === 'foo@1.2.0' && e.kind === 'dep')).toBe(true)
    expect(result.graph.getNode('foo@1.5.0')).toBeUndefined()
    expect(result.added).not.toContain('foo@1.5.0')
    expect(resolved).not.toContain('foo')   // registry never consulted for foo
  })

  it('reuse is range-gated — an existing version that does NOT satisfy falls through to the registry', async () => {
    // foo@1.2.0 is present but bumped now wants foo:^2.0.0 — 1.2.0 can't serve,
    // so completion fetches foo@2.3.0 from the registry (and keeps 1.2.0).
    const graph = graphOf(builder => {
      const ws     = addPackage(builder, { name: 'app',    version: '0.0.0', workspacePath: '.' })
      const bumped = addPackage(builder, { name: 'bumped', version: '2.0.0' })
      const other  = addPackage(builder, { name: 'other',  version: '1.0.0' })
      const foo    = addPackage(builder, { name: 'foo',    version: '1.2.0' })
      addEdge(builder, ws,    bumped, 'dep')
      addEdge(builder, ws,    other,  'dep')
      addEdge(builder, other, foo,    'dep', '^1.0.0')
    })

    const pkgs: Record<string, Packument> = {
      bumped: { name: 'bumped', distTags: { latest: '2.0.0' }, versions: { '2.0.0': { name: 'bumped', version: '2.0.0', dependencies: { foo: '^2.0.0' } } } },
      other:  { name: 'other',  distTags: { latest: '1.0.0' }, versions: { '1.0.0': { name: 'other',  version: '1.0.0' } } },
      foo:    { name: 'foo',    distTags: { latest: '2.3.0' }, versions: { '1.2.0': { name: 'foo', version: '1.2.0' }, '2.3.0': { name: 'foo', version: '2.3.0' } } },
    }
    const fakeRegistry: RegistryAdapter = {
      async packument(name) { return pkgs[name] },
      async resolve(name, range) {
        if (name === 'foo' && range === '^2.0.0') return { name: 'foo', version: '2.3.0' }
        const v = pkgs[name]?.distTags.latest
        return v !== undefined ? { name, version: v } : undefined
      },
    }

    const result = await completeTransitives(graph, fakeRegistry)

    expect(result.graph.getNode('foo@2.3.0')).toBeDefined()
    expect(result.added).toContain('foo@2.3.0')
    expect(result.graph.out('bumped@2.0.0').some(e => e.dst === 'foo@2.3.0')).toBe(true)
    // monotone: the non-satisfying 1.2.0 is untouched.
    expect(result.graph.getNode('foo@1.2.0')).toBeDefined()
  })

  it('reuse picks the HIGHEST satisfying version already present (find-up tiebreaker)', async () => {
    // Two existing foo versions both satisfy ^1.0.0; reuse must take 1.4.0.
    const graph = graphOf(builder => {
      const ws     = addPackage(builder, { name: 'app',    version: '0.0.0', workspacePath: '.' })
      const bumped = addPackage(builder, { name: 'bumped', version: '2.0.0' })
      const a      = addPackage(builder, { name: 'a',      version: '1.0.0' })
      const b      = addPackage(builder, { name: 'b',      version: '1.0.0' })
      const fooLo  = addPackage(builder, { name: 'foo',    version: '1.2.0' })
      const fooHi  = addPackage(builder, { name: 'foo',    version: '1.4.0' })
      addEdge(builder, ws, bumped, 'dep')
      addEdge(builder, ws, a,      'dep')
      addEdge(builder, ws, b,      'dep')
      addEdge(builder, a,  fooLo,  'dep', '^1.0.0')
      addEdge(builder, b,  fooHi,  'dep', '^1.0.0')
    })

    const pkgs: Record<string, Packument> = {
      bumped: { name: 'bumped', distTags: { latest: '2.0.0' }, versions: { '2.0.0': { name: 'bumped', version: '2.0.0', dependencies: { foo: '^1.0.0' } } } },
      a:      { name: 'a',      distTags: { latest: '1.0.0' }, versions: { '1.0.0': { name: 'a', version: '1.0.0' } } },
      b:      { name: 'b',      distTags: { latest: '1.0.0' }, versions: { '1.0.0': { name: 'b', version: '1.0.0' } } },
      foo:    { name: 'foo',    distTags: { latest: '1.9.0' }, versions: { '1.2.0': { name: 'foo', version: '1.2.0' }, '1.4.0': { name: 'foo', version: '1.4.0' } } },
    }
    const fakeRegistry: RegistryAdapter = {
      async packument(name) { return pkgs[name] },
      async resolve(name) { const v = pkgs[name]?.distTags.latest; return v !== undefined ? { name, version: v } : undefined },
    }

    const result = await completeTransitives(graph, fakeRegistry, { resolution: 'prefer-existing' })

    expect(result.graph.out('bumped@2.0.0').some(e => e.dst === 'foo@1.4.0' && e.kind === 'dep')).toBe(true)
    expect(result.graph.out('bumped@2.0.0').some(e => e.dst === 'foo@1.2.0')).toBe(false)
  })

  it('an empty seed does ZERO registry work; the seed bounds completion (incremental contract)', async () => {
    const graph = graphOf(builder => {
      const ws = addPackage(builder, { name: 'app', version: '0.0.0', workspacePath: '.' })
      addPackage(builder, { name: 'a', version: '1.0.0' })
      addEdge(builder, ws, 'a@1.0.0', 'dep')
    })
    const queried: string[] = []
    const reg: RegistryAdapter = {
      async packument(name) {
        queried.push(name)
        if (name === 'a') return { name: 'a', distTags: { latest: '1.0.0' }, versions: { '1.0.0': { name: 'a', version: '1.0.0', dependencies: { b: '^1.0.0' } } } }
        if (name === 'b') return { name: 'b', distTags: { latest: '1.0.0' }, versions: { '1.0.0': { name: 'b', version: '1.0.0' } } }
        return undefined
      },
      async resolve(name) {
        return name === 'a' || name === 'b' ? { name, version: '1.0.0' } : undefined
      },
    }

    // EMPTY seed → empty frontier → ZERO registry queries (was O(graph)).
    queried.length = 0
    await completeTransitives(graph, reg, { seed: { recentlyAdded: new Set(), recentlyOrphaned: new Set() } })
    expect(queried).toEqual([])

    // NO seed → full completion from roots.
    queried.length = 0
    await completeTransitives(graph, reg)
    expect(queried).toContain('a')

    // Seed = { a } → bounded to a's subtree (still reaches a).
    queried.length = 0
    await completeTransitives(graph, reg, { seed: { recentlyAdded: new Set(['a@1.0.0']), recentlyOrphaned: new Set() } })
    expect(queried).toContain('a')
  })

  // ── resolution strategy: prefer-existing vs highest ─────────────────────────
  // Mirrors the real qiwi/mware `--immutable` break: a bumped `qs@6.13.0`
  // requests `side-channel@^1.0.6`; an older `side-channel@1.1.0` (which
  // satisfies ^1.0.6) is already in the graph; the registry's highest match is
  // `1.1.1`, which pulls a NEW dep `side-channel-list@1.0.1`. yarn resolves the
  // new descriptor to 1.1.1 — reusing 1.1.0 diverges and gets rewritten.
  const sideChannelScenario = (): { graph: ReturnType<typeof graphOf>; registry: RegistryAdapter } => {
    const graph = graphOf(builder => {
      const ws = addPackage(builder, { name: 'app', version: '0.0.0', workspacePath: '.' })
      addPackage(builder, { name: 'qs', version: '6.13.0' })
      addPackage(builder, { name: 'side-channel', version: '1.1.0' })   // older, satisfies ^1.0.6
      addEdge(builder, ws, 'qs@6.13.0', 'dep')
    })
    const packuments: Record<string, Packument> = {
      qs: {
        name: 'qs', distTags: { latest: '6.13.0' },
        versions: { '6.13.0': { name: 'qs', version: '6.13.0', dependencies: { 'side-channel': '^1.0.6' } } },
      },
      'side-channel': {
        name: 'side-channel', distTags: { latest: '1.1.1' },
        versions: {
          '1.1.0': { name: 'side-channel', version: '1.1.0' },
          '1.1.1': { name: 'side-channel', version: '1.1.1', dependencies: { 'side-channel-list': '^1.0.1' } },
        },
      },
      'side-channel-list': {
        name: 'side-channel-list', distTags: { latest: '1.0.1' },
        versions: { '1.0.1': { name: 'side-channel-list', version: '1.0.1' } },
      },
    }
    const resolved: Record<string, { name: string; version: string }> = {
      'side-channel@^1.0.6':      { name: 'side-channel',      version: '1.1.1' },
      'side-channel-list@^1.0.1': { name: 'side-channel-list', version: '1.0.1' },
    }
    const registry: RegistryAdapter = {
      async packument(name) { return packuments[name] },
      async resolve(name, range) { return resolved[`${name}@${range}`] },
    }
    return { graph, registry }
  }

  it("resolution 'prefer-existing' (opt-in) reuses the older satisfying version — minimal diff, NOT frozen-clean", async () => {
    const { graph, registry } = sideChannelScenario()
    const result = await completeTransitives(graph, registry, { resolution: 'prefer-existing' })
    // qs→side-channel binds to the EXISTING 1.1.0; no new node, no transitive pull.
    expect(result.added).toEqual([])
    expect(result.graph.getNode('side-channel@1.1.1')).toBeUndefined()
    expect(result.graph.getNode('side-channel-list@1.0.1')).toBeUndefined()
  })

  it("resolution 'highest' (DEFAULT) resolves a NEW descriptor to the registry's highest — yarn --immutable fidelity", async () => {
    const { graph, registry } = sideChannelScenario()
    const result = await completeTransitives(graph, registry, { resolution: 'highest' })
    // matches yarn: ^1.0.6 → 1.1.1, which in turn pulls side-channel-list@1.0.1.
    expect(result.added).toContain('side-channel@1.1.1')
    expect(result.added).toContain('side-channel-list@1.0.1')
    expect(result.graph.getNode('side-channel@1.1.1')).toBeDefined()
    expect(result.graph.getNode('side-channel-list@1.0.1')).toBeDefined()
  })

  it("'highest' is the DEFAULT — omitting the option gives the frozen-clean resolution", async () => {
    const { graph, registry } = sideChannelScenario()
    const result = await completeTransitives(graph, registry)            // no option → default
    expect(result.added).toContain('side-channel@1.1.1')
    expect(result.added).toContain('side-channel-list@1.0.1')
  })
})
