import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newBuilder, type Graph } from '../../main/ts/graph.ts'
import { parse as parsePnpmV9 } from '../../main/ts/formats/pnpm-v9.ts'
import { enrich, stringify } from '../../main/ts/formats/yarn-berry-v9.ts'
import { recipePeerMetaIncomplete } from '../../main/ts/recipe/diagnostics.ts'
import { readInstalledManifest } from '../../main/ts/complete/local-manifest.ts'

// Task #86 — peerDependenciesMeta reconstruction on non-yarn → yarn-berry.
// Covers: rung-2 local-manifest fill of EdgeAttrs.optional; the
// RECIPE_PEER_META_INCOMPLETE degradation; idempotence; pnpm→yarn-berry
// interop round-trip of the optional flag; and the diagnostic factory shape.

// A minimal npm-shaped graph: `consumer` declares a required-looking peer edge
// to `peerpkg` (no optional flag — the npm/bun parser drops it). Enrich's job
// is to recover optionality from the parent's installed manifest.
function npmLikeGraph(): Graph {
  const builder = newBuilder()
  builder.addNode({
    id: 'peerpkg@2.0.0',
    name: 'peerpkg',
    version: '2.0.0',
    peerContext: [],
    resolution: 'peerpkg@npm:2.0.0',
  })
  builder.addNode({
    id: 'consumer@1.0.0(peerpkg@2.0.0)',
    name: 'consumer',
    version: '1.0.0',
    peerContext: ['peerpkg@2.0.0'],
    resolution: 'consumer@npm:1.0.0',
  })
  builder.addEdge('consumer@1.0.0(peerpkg@2.0.0)', 'peerpkg@2.0.0', 'peer', { range: '^2.0.0' })
  return builder.seal()
}

function peerEdgeOptional(graph: Graph, consumerId: string, peerName: string): boolean | undefined {
  const edge = graph.out(consumerId, 'peer').find(e => graph.getNode(e.dst)?.name === peerName)
  return edge?.attrs?.optional
}

describe('yarn-berry peerDependenciesMeta reconstruction (task #86)', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'lf-peer-meta-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function writeInstalledManifest(name: string, manifest: Record<string, unknown>): void {
    const dir = join(root, 'node_modules', ...name.split('/'))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest), 'utf8')
  }

  it('reads peerDependenciesMeta.optional from an installed parent manifest', () => {
    writeInstalledManifest('consumer', {
      name: 'consumer',
      version: '1.0.0',
      peerDependencies: { peerpkg: '^2.0.0' },
      peerDependenciesMeta: { peerpkg: { optional: true } },
    })

    const meta = readInstalledManifest(root, 'consumer')
    expect(meta?.peerDependenciesMeta?.peerpkg?.optional).toBe(true)
  })

  it('returns undefined when the parent manifest is absent from node_modules', () => {
    expect(readInstalledManifest(root, 'consumer')).toBeUndefined()
  })

  it('rung-2: enrich sets EdgeAttrs.optional from the local manifest', () => {
    writeInstalledManifest('consumer', {
      name: 'consumer',
      version: '1.0.0',
      peerDependenciesMeta: { peerpkg: { optional: true } },
    })

    const { graph, diagnostics } = enrich(npmLikeGraph(), { workspaceRoot: root })
    expect(peerEdgeOptional(graph, 'consumer@1.0.0(peerpkg@2.0.0)', 'peerpkg')).toBe(true)
    expect(diagnostics.filter(d => d.code === 'RECIPE_PEER_META_INCOMPLETE')).toHaveLength(0)
    // And the reconstructed flag now emits the yarn-berry block.
    expect(stringify(graph)).toContain('peerDependenciesMeta:')
  })

  it('rung-2: a manifest that does NOT mark the peer optional leaves the edge required (no diagnostic)', () => {
    writeInstalledManifest('consumer', {
      name: 'consumer',
      version: '1.0.0',
      peerDependencies: { peerpkg: '^2.0.0' },
      // No peerDependenciesMeta → peerpkg is a required peer.
    })

    const { graph, diagnostics } = enrich(npmLikeGraph(), { workspaceRoot: root })
    expect(peerEdgeOptional(graph, 'consumer@1.0.0(peerpkg@2.0.0)', 'peerpkg')).toBeUndefined()
    expect(diagnostics.filter(d => d.code === 'RECIPE_PEER_META_INCOMPLETE')).toHaveLength(0)
    expect(stringify(graph)).not.toContain('peerDependenciesMeta')
  })

  it('emits RECIPE_PEER_META_INCOMPLETE when an external rung is requested but cannot answer', () => {
    // workspaceRoot supplied (external rung requested) but no manifest on disk.
    const { graph, diagnostics } = enrich(npmLikeGraph(), { workspaceRoot: root })
    const warn = diagnostics.find(d => d.code === 'RECIPE_PEER_META_INCOMPLETE')
    expect(warn).toBeDefined()
    expect(warn!.severity).toBe('warning')
    expect(warn!.subject).toBe('consumer@1.0.0(peerpkg@2.0.0)')
    expect(warn!.message).toContain('peerpkg')
    // The edge is left untouched (omit, never fabricate).
    expect(peerEdgeOptional(graph, 'consumer@1.0.0(peerpkg@2.0.0)', 'peerpkg')).toBeUndefined()
  })

  it('stays SILENT in pure rung-1 mode (no workspaceRoot, no resolver)', () => {
    // Bare offline enrich: the graph is the sole authority. A genuinely-
    // required peer must NOT produce warning noise.
    const { graph, diagnostics } = enrich(npmLikeGraph())
    expect(diagnostics.filter(d => d.code === 'RECIPE_PEER_META_INCOMPLETE')).toHaveLength(0)
    expect(peerEdgeOptional(graph, 'consumer@1.0.0(peerpkg@2.0.0)', 'peerpkg')).toBeUndefined()
  })

  it('rung-3/4: an opt-in resolver fills optional without touching the filesystem', () => {
    const { graph, diagnostics } = enrich(npmLikeGraph(), {
      peerMetaResolver: (parentName, _v, peerName) =>
        parentName === 'consumer' && peerName === 'peerpkg' ? true : undefined,
    })
    expect(peerEdgeOptional(graph, 'consumer@1.0.0(peerpkg@2.0.0)', 'peerpkg')).toBe(true)
    expect(diagnostics.filter(d => d.code === 'RECIPE_PEER_META_INCOMPLETE')).toHaveLength(0)
  })

  it('is idempotent — a second enrich pass makes no change and emits no new diagnostic', () => {
    writeInstalledManifest('consumer', {
      name: 'consumer',
      version: '1.0.0',
      peerDependenciesMeta: { peerpkg: { optional: true } },
    })

    const first = enrich(npmLikeGraph(), { workspaceRoot: root })
    expect(peerEdgeOptional(first.graph, 'consumer@1.0.0(peerpkg@2.0.0)', 'peerpkg')).toBe(true)

    const second = enrich(first.graph, { workspaceRoot: root })
    expect(peerEdgeOptional(second.graph, 'consumer@1.0.0(peerpkg@2.0.0)', 'peerpkg')).toBe(true)
    // Rung-1 already satisfied → no RECIPE_PEER_META_INCOMPLETE, and the
    // emitted bytes are stable.
    expect(second.diagnostics.filter(d => d.code === 'RECIPE_PEER_META_INCOMPLETE')).toHaveLength(0)
    expect(stringify(second.graph)).toBe(stringify(first.graph))
  })

  it('monotone-additive: an already-optional edge is never cleared and yields no diagnostic', () => {
    const builder = newBuilder()
    builder.addNode({ id: 'peerpkg@2.0.0', name: 'peerpkg', version: '2.0.0', peerContext: [], resolution: 'peerpkg@npm:2.0.0' })
    builder.addNode({ id: 'consumer@1.0.0(peerpkg@2.0.0)', name: 'consumer', version: '1.0.0', peerContext: ['peerpkg@2.0.0'], resolution: 'consumer@npm:1.0.0' })
    builder.addEdge('consumer@1.0.0(peerpkg@2.0.0)', 'peerpkg@2.0.0', 'peer', { range: '^2.0.0', optional: true })
    // workspaceRoot supplied but no manifest: rung-1 already says optional, so
    // the ladder must short-circuit and NOT warn.
    const { graph, diagnostics } = enrich(builder.seal(), { workspaceRoot: root })
    expect(peerEdgeOptional(graph, 'consumer@1.0.0(peerpkg@2.0.0)', 'peerpkg')).toBe(true)
    expect(diagnostics.filter(d => d.code === 'RECIPE_PEER_META_INCOMPLETE')).toHaveLength(0)
  })

  it('diagnostic factory shape: RECIPE_PEER_META_INCOMPLETE', () => {
    const d = recipePeerMetaIncomplete('host@1.0.0', 'peerpkg', 'no source')
    expect(d).toMatchObject({
      code: 'RECIPE_PEER_META_INCOMPLETE',
      severity: 'warning',
      subject: 'host@1.0.0',
    })
    expect(d.message).toContain('peerpkg')
  })
})

describe('readInstalledManifest — reader edge cases & confinement (task #86)', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'lf-peer-meta-reader-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function write(name: string, manifest: unknown): void {
    const dir = join(root, 'node_modules', ...name.split('/'))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest), 'utf8')
  }

  it('resolves a scoped parent name (@scope/pkg)', () => {
    write('@scope/pkg', { name: '@scope/pkg', peerDependenciesMeta: { react: { optional: true } } })
    expect(readInstalledManifest(root, '@scope/pkg')?.peerDependenciesMeta?.react?.optional).toBe(true)
  })

  it('rejects path-traversal / malformed parent names (fail closed)', () => {
    expect(readInstalledManifest(root, '../../../etc')).toBeUndefined()
    expect(readInstalledManifest(root, '..')).toBeUndefined()
    expect(readInstalledManifest(root, '.')).toBeUndefined()
    expect(readInstalledManifest(root, 'a/b/c')).toBeUndefined()        // unscoped multi-segment
    expect(readInstalledManifest(root, '@scope/pkg/extra')).toBeUndefined() // scoped 3-segment
    expect(readInstalledManifest(root, '')).toBeUndefined()
  })

  it('a found manifest WITHOUT a meta block is present (not undefined) but empty', () => {
    write('plain', { name: 'plain', peerDependencies: { x: '1' } })
    const meta = readInstalledManifest(root, 'plain')
    expect(meta).toBeDefined()
    expect(meta?.peerDependenciesMeta).toBeUndefined()
  })

  it('malformed / non-object JSON degrades to undefined', () => {
    write('bad', '{ this is not json ')
    expect(readInstalledManifest(root, 'bad')).toBeUndefined()
    write('arr', '[1,2,3]')
    expect(readInstalledManifest(root, 'arr')).toBeUndefined()
    write('scalar', '"a-string"')
    expect(readInstalledManifest(root, 'scalar')).toBeUndefined()
  })

  it('surfaces dependenciesMeta (read but model-deferred) for the follow-up', () => {
    write('dm', { dependenciesMeta: { foo: { optional: true } } })
    expect(readInstalledManifest(root, 'dm')?.dependenciesMeta?.foo?.optional).toBe(true)
  })
})

describe('interop: pnpm-v9 → yarn-berry-v9 peer-optional round-trip (task #86)', () => {
  const sha = (c: string) => `sha512-${c.repeat(86)}`

  // pnpm source that models an optional peer via peerDependenciesMeta. The
  // bound peer (peerpkg) carries EdgeAttrs.optional after parse; converting to
  // yarn-berry must now surface it as a peerDependenciesMeta block.
  const PNPM_SRC = [
    `lockfileVersion: '9.0'`,
    ``,
    `settings:`,
    `  autoInstallPeers: true`,
    `  excludeLinksFromLockfile: false`,
    ``,
    `importers:`,
    ``,
    `  .:`,
    `    dependencies:`,
    `      host:`,
    `        specifier: ^1.0.0`,
    `        version: 1.0.0(peerpkg@2.0.0)`,
    ``,
    `packages:`,
    ``,
    `  host@1.0.0:`,
    `    resolution: {integrity: ${sha('a')}}`,
    `    peerDependencies:`,
    `      peerpkg: ^2.0.0`,
    `    peerDependenciesMeta:`,
    `      peerpkg:`,
    `        optional: true`,
    ``,
    `  peerpkg@2.0.0:`,
    `    resolution: {integrity: ${sha('b')}}`,
    ``,
    `snapshots:`,
    ``,
    `  'host@1.0.0(peerpkg@2.0.0)':`,
    `    dependencies:`,
    `      peerpkg: 2.0.0`,
    ``,
    `  peerpkg@2.0.0: {}`,
    ``,
  ].join('\n')

  it('source peerDependenciesMeta:{peerpkg:{optional:true}} survives the conversion', () => {
    const graph = parsePnpmV9(PNPM_SRC)
    // Sanity: the optional flag is on the bound peer edge after pnpm parse.
    const edge = graph.out('host@1.0.0(peerpkg@2.0.0)', 'peer').find(e => graph.getNode(e.dst)?.name === 'peerpkg')
    expect(edge?.attrs?.optional).toBe(true)

    // Bare convert is offline + sync; emit-from-edge carries the flag with no
    // enrich step and no workspaceRoot.
    const yarn = stringify(graph)
    expect(yarn).toContain('peerDependenciesMeta:')
    // Emitted BARE, like yarn (the #89 regression quoted it).
    expect(yarn).toMatch(/peerpkg:\s*\n\s*optional: true\n/)
    expect(yarn).not.toContain('optional: "true"')
  })
})
