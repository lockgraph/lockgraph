import { describe, expect, it } from 'vitest'

import {
  parse as parseV9,
  stringify as stringifyV9,
  enrich as enrichV9,
  optimize as optimizeV9,
} from '../../main/ts/formats/pnpm-v9.ts'

import {
  parse as parseV6,
  stringify as stringifyV6,
} from '../../main/ts/formats/pnpm-v6.ts'

import { parse as parseBerry } from '../../main/ts/formats/yarn-berry-v9.ts'

import {
  parseOverrideKey,
  matcherMatches,
  patchPathOfResolution,
  resolvePeerTargetById,
  encodeWorkspaceDirectory,
  resolveWorkspacePeerId,
  derivePeerCandidates,
  resolveLinkPath,
  relativeImporterPath,
} from '../../main/ts/formats/_pnpm-flat-core.ts'

import { LockfileError } from '../../main/ts/api/errors.ts'

import { fixture } from '../helpers/lockfile-test-utils.ts'

const V9 = (body: string): string =>
  `lockfileVersion: '9.0'\n\n` +
  `settings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n\n` +
  body

// react-dom@19.2.0's real integrity, taken from a lock pnpm 9.15.9 wrote —
// the byte-replay cases need an SRI that survives canonicalisation unchanged.
const REACT_DOM_SRI =
  'sha512-UlbRu4cAiGaIewkPyiRGJk0imDN2T3JjieT6spoL2UeSf5od4n5LB/mQ4ejmxhCFT1tYe8IvaFulzynWovsEFQ=='

const V6 = (body: string): string =>
  `lockfileVersion: '6.0'\n\n` +
  `settings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n\n` +
  body

describe('parse', () => {
  it('warns PNPM_BAD_ENTRY on a v9 snapshot key with no `@` separator', () => {
    const graph = parseV9(V9('importers:\n\n  .: {}\n\npackages: {}\n\nsnapshots:\n\n  no-at-sign: {}\n'))
    expect(graph.diagnostics().map(d => d.code)).toContain('PNPM_BAD_ENTRY')
  })

  it('names the unparseable v9 snapshot key as the PNPM_BAD_ENTRY subject', () => {
    // No NodeId exists for an entry that cannot be parsed — without the key as
    // subject the warning identifies nothing.
    const graph = parseV9(V9('importers:\n\n  .: {}\n\npackages: {}\n\nsnapshots:\n\n  no-at-sign: {}\n'))
    const bad = graph.diagnostics().filter(d => d.code === 'PNPM_BAD_ENTRY')
    expect(bad.map(d => d.subject)).toEqual(['no-at-sign'])
  })

  it('warns PNPM_BAD_ENTRY on a v6 packages key that has no `@` after slash-strip', () => {
    const graph = parseV6(
      V6('dependencies:\n  lodash: 4.17.21\n\npackages:\n\n  /no-at-sign-here:\n    resolution: {integrity: sha512-x}\n    dev: false\n'),
    )
    expect(graph.diagnostics().map(d => d.code)).toContain('PNPM_BAD_ENTRY')
  })

  it('names the unparseable v6 packages key as the PNPM_BAD_ENTRY subject', () => {
    const graph = parseV6(
      V6('dependencies:\n  lodash: 4.17.21\n\npackages:\n\n  /no-at-sign-here:\n    resolution: {integrity: sha512-x}\n    dev: false\n'),
    )
    const bad = graph.diagnostics().filter(d => d.code === 'PNPM_BAD_ENTRY')
    expect(bad.map(d => d.subject)).toEqual(['/no-at-sign-here'])
  })

  it('rethrows a GraphError seal failure as a PARSE_FAILED LockfileError (v9)', () => {
    // A snapshot whose peer-context references a node that does not exist → the
    // seal rejects, caught and rewrapped.
    const lock = V9(
      'importers:\n\n  .: {}\n\n' +
        'packages:\n\n  host@1.0.0:\n    resolution: {integrity: sha512-h}\n' +
        "    peerDependencies:\n      react: '*'\n\n" +
        'snapshots:\n\n  host@1.0.0(react@18.2.0): {}\n',
    )
    expect(() => parseV9(lock)).toThrow(LockfileError)
    try {
      parseV9(lock)
    } catch (error) {
      expect((error as LockfileError).code).toBe('PARSE_FAILED')
      expect((error as LockfileError).message).toContain('seal failed')
    }
  })

  it('warns PNPM_UNRESOLVED_DEP for a snapshot dep with no matching snapshot', () => {
    const graph = parseV9(
      V9(
        'importers:\n\n  .:\n    dependencies:\n      host:\n        specifier: 1.0.0\n        version: 1.0.0\n\n' +
          'packages:\n\n  host@1.0.0:\n    resolution: {integrity: sha512-h}\n\n' +
          'snapshots:\n\n  host@1.0.0:\n    dependencies:\n      ghostdep: 9.9.9\n',
      ),
    )
    const diags = graph.diagnostics().filter(d => d.code === 'PNPM_UNRESOLVED_DEP')
    expect(diags.some(d => d.message.includes('ghostdep'))).toBe(true)
  })

  it('resolves an npm-alias importer dep (`npm:react-is@^17` → react-is@17.0.2) and records the alias', () => {
    const graph = parseV9(
      V9(
        'importers:\n\n  .:\n    dependencies:\n      my-alias:\n        specifier: npm:react-is@^17\n        version: react-is@17.0.2\n\n' +
          'packages:\n\n  react-is@17.0.2:\n    resolution: {integrity: sha512-r}\n\n' +
          'snapshots:\n\n  react-is@17.0.2: {}\n',
      ),
    )
    const edge = graph.out('.@0.0.0', 'dep').find(e => e.dst === 'react-is@17.0.2')
    expect(edge).toBeDefined()
    expect(edge!.attrs?.alias).toBe('my-alias')
    // The alias round-trips: emitted under the alias slot with the canonical value.
    const out = stringifyV9(graph)
    expect(out).toMatch(/my-alias:\n\s+specifier: npm:react-is@\^17\n\s+version: react-is@17\.0\.2/)
  })

  it('warns PNPM_UNRESOLVED_DEP for a v9 importer dep resolving to an unknown workspace path', () => {
    const graph = parseV9(
      V9(
        'importers:\n\n  .:\n    dependencies:\n      x:\n        specifier: workspace:*\n        version: link:../nowhere\n\n' +
          'packages: {}\n\nsnapshots: {}\n',
      ),
    )
    const diags = graph.diagnostics().filter(d => d.code === 'PNPM_UNRESOLVED_DEP')
    expect(diags.length).toBeGreaterThan(0)
    expect(diags[0]!.message).toContain('nowhere')
  })

  it.each([
    ['v9', parseV9, stringifyV9, V9],
    ['v6', parseV6, stringifyV6, V6],
  ] as const)('re-emits a %s importer workspace dependency under its declared package name', (
    _version,
    parse,
    stringify,
    wrap,
  ) => {
    const source = wrap(
      'importers:\n\n' +
        '  .:\n    dependencies:\n      docs:\n        specifier: workspace:*\n        version: link:packages/docs\n\n' +
        '  packages/docs: {}\n\n' +
        'packages: {}\n',
    )
    const output = stringify(parse(source))

    expect(output).toMatch(/dependencies:\n\s+docs:\n\s+specifier: workspace:\*/)
    expect(output).not.toMatch(/dependencies:\n\s+packages\/docs:/)
  })

  // A `link:` in a `snapshots` / inline `packages` dependency block is a
  // WORKSPACE-DIRECTORY reference, not a snapshot reference — pnpm materialises
  // it as a symlink resolved against the LOCKFILE directory. Measured against
  // pnpm 10.34.5: such a lock installs under `--frozen-lockfile` (exit 0, lock
  // unrewritten) and yields
  // `node_modules/.pnpm/<consumer>/node_modules/<dep> -> ../../../../<path>`.
  const V9_WORKSPACE_LINK_SNAPSHOT = V9(
    'importers:\n\n' +
      '  .:\n    dependencies:\n' +
      "      '@tailwindcss/aspect-ratio':\n        specifier: 0.4.2\n        version: 0.4.2(tailwindcss@packages+tailwindcss)\n" +
      '      tailwindcss:\n        specifier: workspace:*\n        version: link:packages/tailwindcss\n\n' +
      '  packages/tailwindcss: {}\n\n' +
      'packages:\n\n' +
      "  '@tailwindcss/aspect-ratio@0.4.2':\n    resolution: {integrity: sha512-a}\n" +
      "    peerDependencies:\n      tailwindcss: '>=2.0.0'\n\n" +
      'snapshots:\n\n' +
      "  '@tailwindcss/aspect-ratio@0.4.2(tailwindcss@packages+tailwindcss)':\n" +
      '    dependencies:\n      tailwindcss: link:packages/tailwindcss\n',
  )

  // A LOCAL (`resolution: {type: directory}`) package's own dependencies name
  // sibling members. No peer suffix carries them, and the seal admits a local
  // node's edge into a workspace member (amendment).
  const V9_LOCAL_LINK_CONSUMER = V9(
    'importers:\n\n' +
      '  .:\n    dependencies:\n      courses:\n        specifier: file:nx-dev/courses\n        version: file:nx-dev/courses\n\n' +
      '  nx-dev/docs: {}\n\n' +
      'packages:\n\n' +
      "  'courses@file:nx-dev/courses':\n    resolution: {directory: nx-dev/courses, type: directory}\n\n" +
      'snapshots:\n\n' +
      "  'courses@file:nx-dev/courses':\n    dependencies:\n      docs: link:nx-dev/docs\n",
  )

  it('binds a v9 snapshot `link:` dep of a local `file:` package to the workspace member', () => {
    const graph = parseV9(V9_LOCAL_LINK_CONSUMER)
    const edge = graph.out('courses@file:nx-dev/courses', 'dep')
      .find(e => e.dst === 'nx-dev/docs@0.0.0')
    expect(edge).toBeDefined()
    expect(edge!.attrs?.range).toBe('link:nx-dev/docs')
  })

  it('reports no diagnostic for a bound local `file:` package `link:` dep', () => {
    expect(parseV9(V9_LOCAL_LINK_CONSUMER).diagnostics()).toEqual([])
  })

  it('binds a v9 snapshot `link:` into a sub-directory publish to its ancestor importer', () => {
    // `packages/mui-material/build` is published from inside the importer at
    // `packages/mui-material`; only the ancestor is an importer.
    const graph = parseV9(
      V9(
        'importers:\n\n  .: {}\n\n  packages/mui-material: {}\n\n' +
          'packages:\n\n  local@file:tools/local:\n    resolution: {directory: tools/local, type: directory}\n\n' +
          'snapshots:\n\n  local@file:tools/local:\n    dependencies:\n' +
          "      '@mui/material': link:packages/mui-material/build\n",
      ),
    )
    const edge = graph.out('local@file:tools/local', 'dep')
      .find(e => e.dst === 'packages/mui-material@0.0.0')
    expect(edge).toBeDefined()
  })

  it('binds a workspace peer whose importer directory contains a `+`', () => {
    // Emitted by pnpm 9.15.9 for an importer at `plus+dir`. pnpm encodes the
    // directory with `filenamify(dir, {replacement: '+'})`, which leaves an
    // existing `+` untouched — so `+`→`/` decoding alone reads the locator as
    // `plus/dir`, binds nothing, and the peerContext/peer-edge seal throws.
    const graph = parseV9(
      V9(
        'importers:\n\n  .: {}\n\n  plus+dir: {}\n\n' +
          'packages:\n\n  react-dom@19.2.0:\n    resolution: {integrity: sha512-r}\n' +
          '    peerDependencies:\n      react: ^19.2.0\n\n' +
          'snapshots:\n\n  react-dom@19.2.0(react@plus+dir):\n    dependencies:\n' +
          '      react: link:plus+dir\n',
      ),
    )
    const consumer = 'react-dom@19.2.0(plus+dir@0.0.0)'
    expect(graph.out(consumer, 'peer').map(e => e.dst)).toEqual(['plus+dir@0.0.0'])
  })

  it('binds a workspace peer satisfied by the ROOT importer', () => {
    // Emitted by pnpm 9.15.9 when the root importer satisfies the peer: the
    // linked directory is the empty string, so the locator is bare `react@`.
    // Rejecting an empty version made the whole snapshot key unparseable and
    // dropped the package.
    const graph = parseV9(
      V9(
        'importers:\n\n  .: {}\n\n  consumer: {}\n\n' +
          'packages:\n\n  react-dom@19.2.0:\n    resolution: {integrity: sha512-r}\n' +
          '    peerDependencies:\n      react: ^19.2.0\n\n' +
          "snapshots:\n\n  react-dom@19.2.0(react@):\n    dependencies:\n      react: 'link:'\n",
      ),
    )
    const consumer = 'react-dom@19.2.0(.@0.0.0)'
    expect(graph.getNode(consumer)).toBeDefined()
    expect(graph.out(consumer, 'peer').map(e => e.dst)).toEqual(['.@0.0.0'])
    expect(graph.diagnostics().filter(d => d.code === 'PNPM_BAD_ENTRY')).toEqual([])
  })

  it('replays a `+`-bearing workspace-peer locator verbatim', () => {
    const source = V9(
      'importers:\n\n  .: {}\n\n  plus+dir: {}\n\n' +
        'packages:\n\n  react-dom@19.2.0:\n    resolution: {integrity: ' + REACT_DOM_SRI + '}\n' +
        '    peerDependencies:\n      react: ^19.2.0\n\n' +
        'snapshots:\n\n  react-dom@19.2.0(react@plus+dir):\n    dependencies:\n' +
        '      react: link:plus+dir\n',
    )
    expect(stringifyV9(parseV9(source))).toBe(source)
  })

  it('replays the bare root workspace-peer locator verbatim', () => {
    const source = V9(
      'importers:\n\n  .: {}\n\n  consumer: {}\n\n' +
        'packages:\n\n  react-dom@19.2.0:\n    resolution: {integrity: ' + REACT_DOM_SRI + '}\n' +
        '    peerDependencies:\n      react: ^19.2.0\n\n' +
        "snapshots:\n\n  react-dom@19.2.0(react@):\n    dependencies:\n      react: 'link:'\n",
    )
    expect(stringifyV9(parseV9(source))).toBe(source)
  })

  it('reports PNPM_WORKSPACE_LINK_PEER_BOUND (info) when the peer suffix already binds the member', () => {
    // The published consumer's peer edge models the relationship; the seal
    // admits no dependency edge from a published package into a workspace
    // member, so nothing further is representable and nothing is lost.
    const graph = parseV9(V9_WORKSPACE_LINK_SNAPSHOT)
    const consumer = '@tailwindcss/aspect-ratio@0.4.2(packages/tailwindcss@0.0.0)'
    expect(graph.out(consumer, 'peer').map(e => e.dst)).toContain('packages/tailwindcss@0.0.0')
    const diags = graph.diagnostics().filter(d => d.code === 'PNPM_WORKSPACE_LINK_PEER_BOUND')
    expect(diags).toHaveLength(1)
    expect(diags[0]!.severity).toBe('info')
    expect(graph.diagnostics().filter(d => d.code === 'PNPM_UNRESOLVED_DEP')).toEqual([])
  })

  it('reports PNPM_WORKSPACE_LINK_EDGE_DROPPED (warning) when no peer binding covers the member', () => {
    // A project `overrides:` entry redirects a published package's ordinary
    // dependency onto a workspace member — nothing in the model can carry it.
    const graph = parseV9(
      V9(
        'importers:\n\n  .: {}\n\n  packages/kit: {}\n\n' +
          'packages:\n\n  host@1.0.0:\n    resolution: {integrity: sha512-h}\n\n' +
          "snapshots:\n\n  host@1.0.0:\n    dependencies:\n      '@nuxt/kit': link:packages/kit\n",
      ),
    )
    const diags = graph.diagnostics().filter(d => d.code === 'PNPM_WORKSPACE_LINK_EDGE_DROPPED')
    expect(diags).toHaveLength(1)
    expect(diags[0]!.severity).toBe('warning')
    expect(diags[0]!.message).toContain('packages/kit@0.0.0')
    expect(graph.out('host@1.0.0', 'dep')).toEqual([])
  })

  it('reports PNPM_WORKSPACE_LINK_PEER_BOUND for a v6 inline `packages` `link:` dep', () => {
    const graph = parseV6(
      V6(
        'importers:\n\n' +
          '  .:\n    dependencies:\n' +
          "      '@tailwindcss/aspect-ratio':\n        specifier: 0.4.2\n        version: 0.4.2(tailwindcss@packages+tailwindcss)\n" +
          '      tailwindcss:\n        specifier: workspace:*\n        version: link:packages/tailwindcss\n\n' +
          '  packages/tailwindcss: {}\n\n' +
          'packages:\n\n' +
          "  /@tailwindcss/aspect-ratio@0.4.2(tailwindcss@packages+tailwindcss):\n    resolution: {integrity: sha512-a}\n" +
          "    peerDependencies:\n      tailwindcss: '>=2.0.0'\n" +
          '    dependencies:\n      tailwindcss: link:packages/tailwindcss\n    dev: false\n',
      ),
    )
    expect(graph.diagnostics().map(d => d.code)).toContain('PNPM_WORKSPACE_LINK_PEER_BOUND')
    expect(graph.diagnostics().filter(d => d.code === 'PNPM_UNRESOLVED_DEP')).toEqual([])
  })

  it('still warns PNPM_UNRESOLVED_DEP when a v9 snapshot `link:` names no workspace importer', () => {
    const graph = parseV9(
      V9(
        'importers:\n\n  .: {}\n\n' +
          'packages:\n\n  host@1.0.0:\n    resolution: {integrity: sha512-h}\n\n' +
          'snapshots:\n\n  host@1.0.0:\n    dependencies:\n      stray: link:nowhere/at/all\n',
      ),
    )
    const diags = graph.diagnostics().filter(d => d.code === 'PNPM_UNRESOLVED_DEP')
    expect(diags).toHaveLength(1)
    // The residual names the LINK channel — the target is a directory pnpm links
    // by path, so "resolves to no snapshot" would describe the wrong lookup.
    expect(diags[0]!.message).toContain('no workspace importer')
    expect(diags[0]!.message).toContain('nowhere/at/all')
  })
})

describe('stringify', () => {
  it('round-trips an external tarball URL on a v9 packages entry', () => {
    const graph = parseV9(
      V9(
        'importers:\n\n  .: {}\n\n' +
          'packages:\n\n  ext@1.0.0:\n    resolution: {tarball: https://example.com/ext.tgz}\n\n' +
          'snapshots:\n\n  ext@1.0.0: {}\n',
      ),
    )
    const out = stringifyV9(graph)
    expect(out).toContain('ext@1.0.0:')
    expect(out).toContain('resolution: {tarball: https://example.com/ext.tgz}')
  })

  it('round-trips a directory resolution on a v9 packages entry', () => {
    const graph = parseV9(
      V9(
        'importers:\n\n  .: {}\n\n' +
          'packages:\n\n  loc@file:loc:\n    resolution: {directory: loc, type: directory}\n\n' +
          'snapshots:\n\n  loc@file:loc: {}\n',
      ),
    )
    const out = stringifyV9(graph)
    expect(out).toContain('resolution: {directory: loc, type: directory}')
  })

  it('emits a `deprecated:` scalar carried on the tarball payload', () => {
    const graph = parseV9(
      V9(
        'importers:\n\n  .:\n    dependencies:\n      old:\n        specifier: 1.0.0\n        version: 1.0.0\n\n' +
          'packages:\n\n  old@1.0.0:\n    resolution: {integrity: sha512-a}\n    deprecated: use @scope/new instead\n\n' +
          'snapshots:\n\n  old@1.0.0: {}\n',
      ),
    )
    const out = stringifyV9(graph)
    expect(out).toContain('deprecated: use @scope/new instead')
  })

  it('preserves per-entry `dev: true` on a v6 packages entry', () => {
    const graph = parseV6(
      V6(
        'devDependencies:\n  debug: 4.3.4\n\n' +
          'packages:\n\n  /debug@4.3.4:\n    resolution: {integrity: sha512-a}\n    dev: true\n',
      ),
    )
    const out = stringifyV6(graph)
    expect(out).toContain('/debug@4.3.4:')
    expect(out).toMatch(/dev: true/)
  })

  it('re-emits an optional peer marker from peerDependenciesMeta even with no bound peer edge', () => {
    // The optional peer has no installed instance → no peer edge, so only the
    // verbatim sidecar carrier makes it round-trip.
    const graph = parseV9(
      V9(
        'importers:\n\n  .:\n    dependencies:\n      widget:\n        specifier: 1.0.0\n        version: 1.0.0\n\n' +
          'packages:\n\n  widget@1.0.0:\n    resolution: {integrity: sha512-w}\n' +
          "    peerDependencies:\n      '@types/react': '*'\n" +
          "    peerDependenciesMeta:\n      '@types/react':\n        optional: true\n\n" +
          'snapshots:\n\n  widget@1.0.0: {}\n',
      ),
    )
    const out = stringifyV9(graph)
    expect(out).toContain('peerDependenciesMeta:')
    expect(out).toMatch(/'@types\/react':\n\s+optional: true/)
  })

  it('replays a top-level `catalogs:` block captured at parse', () => {
    const graph = parseV9(
      V9(
        "catalogs:\n  default:\n    lodash:\n      specifier: ^4.17.21\n      version: 4.17.21\n\n" +
          'importers:\n\n  .:\n    dependencies:\n      lodash:\n        specifier: \'catalog:\'\n        version: 4.17.21\n\n' +
          'packages:\n\n  lodash@4.17.21:\n    resolution: {integrity: sha512-a}\n\n' +
          'snapshots:\n\n  lodash@4.17.21: {}\n',
      ),
    )
    const out = stringifyV9(graph)
    expect(out).toContain('catalogs:')
    expect(out).toContain('default:')
    expect(out).toMatch(/lodash:\n\s+specifier: \^4\.17\.21/)
  })

  it('re-emits a bound `link:` dep under its declared slot name', () => {
    // The slot key is the DECLARED dep name (`docs`), not the target node's
    // name — a pnpm lock names importer members by DIRECTORY, so `dst.name` is
    // `nx-dev/docs` and emitting that would not resolve for pnpm.
    const source = V9(
      'importers:\n\n' +
        '  .:\n    dependencies:\n      courses:\n        specifier: file:nx-dev/courses\n        version: file:nx-dev/courses\n\n' +
        '  nx-dev/docs: {}\n\n' +
        'packages:\n\n' +
        '  courses@file:nx-dev/courses:\n    resolution: {directory: nx-dev/courses, type: directory}\n\n' +
        'snapshots:\n\n' +
        '  courses@file:nx-dev/courses:\n    dependencies:\n      docs: link:nx-dev/docs\n',
    )
    const out = stringifyV9(parseV9(source))
    expect(out).toContain('docs: link:nx-dev/docs')
    expect(out).toBe(source)
  })

  it('re-emits a bound `link:` into a sub-directory publish at its original path', () => {
    // The graph node collapses onto the ancestor importer, but the emitted
    // locator must stay the published sub-directory pnpm recorded.
    const source = V9(
      'importers:\n\n  .: {}\n\n  packages/mui-material: {}\n\n' +
        'packages:\n\n  local@file:tools/local:\n    resolution: {directory: tools/local, type: directory}\n\n' +
        'snapshots:\n\n  local@file:tools/local:\n    dependencies:\n' +
        "      '@mui/material': link:packages/mui-material/build\n",
    )
    expect(stringifyV9(parseV9(source))).toBe(source)
  })

  it('re-emits `type: directory` for a representable v6 local package resolution', () => {
    const source = V6(
      'importers:\n\n  .:\n    dependencies:\n      courses:\n        specifier: file:vendor/courses\n        version: file:vendor/courses\n\n' +
        'packages:\n\n  /courses@file:vendor/courses:\n' +
        '    resolution: {directory: vendor/courses, type: directory}\n    dev: false\n',
    )

    expect(stringifyV6(parseV6(source)))
      .toContain('resolution: {directory: vendor/courses, type: directory}')
  })

  it('replays a peer-bound `link:` slot verbatim from its retained declaration', () => {
    const source = V9(
      'importers:\n\n' +
        '  .:\n    dependencies:\n' +
        "      '@tailwindcss/aspect-ratio':\n        specifier: 0.4.2\n        version: 0.4.2(tailwindcss@packages+tailwindcss)\n\n" +
        '  packages/tailwindcss: {}\n\n' +
        'packages:\n\n' +
        "  '@tailwindcss/aspect-ratio@0.4.2':\n" +
        '    resolution: {integrity: sha512-8QPrypskfBa7QIMuKHg2TA7BqES6vhBrDLOv8Unb6FcFyd3TjKbc6lcmb9UPQHxfl24sXoJ41ux/H7qQQvfaSQ==}\n' +
        "    peerDependencies:\n      tailwindcss: '>=2.0.0'\n\n" +
        'snapshots:\n\n' +
        "  '@tailwindcss/aspect-ratio@0.4.2(tailwindcss@packages+tailwindcss)':\n" +
        '    dependencies:\n      tailwindcss: link:packages/tailwindcss\n',
    )
    expect(stringifyV9(parseV9(source))).toBe(source)
  })
})

describe('enrich', () => {
  it('adds a root dep edge (and its mutate pass) when the manifest declares a dep absent from the lock', () => {
    const graph = parseV9(
      V9('importers:\n\n  .: {}\n\npackages:\n\n  lodash@4.17.21:\n    resolution: {integrity: sha512-a}\n\nsnapshots:\n\n  lodash@4.17.21: {}\n'),
    )
    expect(graph.out('.@0.0.0', 'dep')).toEqual([])
    const result = enrichV9(graph, {
      manifests: { '': { name: 'root', dependencies: { lodash: '4.17.21' } } },
    })
    expect(result.graph.out('.@0.0.0', 'dep').map(e => e.dst)).toEqual(['lodash@4.17.21'])
  })

  it('resolves a root manifest workspace dep BY NAME to the member node', () => {
    const graph = parseV9(
      V9('importers:\n\n  .: {}\n  packages/b:\n    dependencies: {}\n\npackages: {}\n\nsnapshots: {}\n'),
    )
    const result = enrichV9(graph, {
      manifests: {
        '': { name: 'root', dependencies: { 'b-pkg': 'workspace:*' } },
        'packages/b': { name: 'b-pkg', version: '0.0.0' },
      },
    })
    const edge = result.graph.out('.@0.0.0', 'dep').find(e => e.dst === 'packages/b@0.0.0')
    expect(edge).toBeDefined()
    expect(edge!.attrs?.workspace).toBe(true)
  })

  it('rewrites an existing root workspace edge when the manifest range differs (range drift)', () => {
    // Parse binds `b` at `workspace:^1.0.0`; the manifest declares `workspace:*`
    // → range drift → markWorkspaceEdges remove+add mutate.
    const graph = parseV9(
      V9(
        'importers:\n\n  .:\n    dependencies:\n      b:\n        specifier: workspace:^1.0.0\n        version: link:packages/b\n' +
          '  packages/b:\n    dependencies: {}\n\npackages: {}\n\nsnapshots: {}\n',
      ),
    )
    expect(graph.out('.@0.0.0', 'dep').find(e => e.dst === 'packages/b@0.0.0')!.attrs?.range).toBe(
      'workspace:^1.0.0',
    )
    const result = enrichV9(graph, {
      manifests: {
        '': { name: 'root', dependencies: { b: 'workspace:*' } },
        'packages/b': { name: 'b', version: '0.0.0' },
      },
    })
    expect(result.graph.out('.@0.0.0', 'dep').find(e => e.dst === 'packages/b@0.0.0')!.attrs?.range).toBe(
      'workspace:*',
    )
  })
})

describe('optimize', () => {
  it('drops a cyclic pair unreachable from the root importer and keeps the reachable dep (v9)', () => {
    const graph = parseV9(
      V9(
        'importers:\n\n  .:\n    dependencies:\n      lodash:\n        specifier: 4.17.21\n        version: 4.17.21\n\n' +
          'packages:\n\n' +
          '  lodash@4.17.21:\n    resolution: {integrity: sha512-a}\n' +
          '  cyc-a@1.0.0:\n    resolution: {integrity: sha512-b}\n' +
          '  cyc-b@1.0.0:\n    resolution: {integrity: sha512-c}\n\n' +
          'snapshots:\n\n' +
          '  lodash@4.17.21: {}\n' +
          '  cyc-a@1.0.0:\n    dependencies:\n      cyc-b: 1.0.0\n' +
          '  cyc-b@1.0.0:\n    dependencies:\n      cyc-a: 1.0.0\n',
      ),
    )
    expect(graph.getNode('cyc-a@1.0.0')).toBeDefined()
    const result = optimizeV9(graph)
    expect(result.graph.getNode('cyc-a@1.0.0')).toBeUndefined()
    expect(result.graph.getNode('cyc-b@1.0.0')).toBeUndefined()
    expect(result.graph.getNode('lodash@4.17.21')).toBeDefined()
  })
})

describe('parseOverrideKey', () => {
  it('classifies a bare name, an exact version (incl. `npm:` prefix), and a range', () => {
    expect(parseOverrideKey('lodash')).toEqual({ kind: 'bare', name: 'lodash' })
    expect(parseOverrideKey('lodash@4.17.21')).toEqual({ kind: 'exact', name: 'lodash', version: '4.17.21' })
    expect(parseOverrideKey('lodash@npm:4.17.21')).toEqual({ kind: 'exact', name: 'lodash', version: '4.17.21' })
    expect(parseOverrideKey('lodash@^4.0.0')).toEqual({ kind: 'range', name: 'lodash', range: '^4.0.0' })
    // Scoped exact: the separator is the SECOND `@`.
    expect(parseOverrideKey('@scope/pkg@1.2.3')).toEqual({ kind: 'exact', name: '@scope/pkg', version: '1.2.3' })
    // Degenerate keys.
    expect(parseOverrideKey('')).toBeUndefined()
    expect(parseOverrideKey('lodash@')).toBeUndefined()
    expect(parseOverrideKey('lodash@npm:')).toBeUndefined()
  })
})

describe('matcherMatches', () => {
  it('respects kind (bare/exact/range) and the name gate', () => {
    expect(matcherMatches({ kind: 'bare', name: 'lodash' }, 'lodash', '4.17.21')).toBe(true)
    expect(matcherMatches({ kind: 'bare', name: 'lodash' }, 'ms', '2.1.3')).toBe(false)
    expect(matcherMatches({ kind: 'exact', name: 'lodash', version: '4.17.21' }, 'lodash', '4.17.21')).toBe(true)
    expect(matcherMatches({ kind: 'exact', name: 'lodash', version: '4.17.21' }, 'lodash', '4.17.20')).toBe(false)
    expect(matcherMatches({ kind: 'range', name: 'lodash', range: '^4.0.0' }, 'lodash', '4.17.21')).toBe(true)
    // Default semantics: a bare caret range does NOT pick up a prerelease.
    expect(matcherMatches({ kind: 'range', name: 'lodash', range: '^4.0.0' }, 'lodash', '4.1.0-beta.1')).toBe(false)
  })
})

describe('patchPathOfResolution', () => {
  it('extracts the workspace path from a yarn-berry `@patch:…#<path>::version=…` locator', () => {
    const locator =
      'lodash@patch:lodash@npm%3A4.17.21#./.yarn/patches/lodash-npm-4.17.21-6382451519.patch::version=4.17.21&hash=858da5'
    expect(patchPathOfResolution(locator)).toBe('./.yarn/patches/lodash-npm-4.17.21-6382451519.patch')
  })

  it('returns the whole tail when there is no `::` parameter segment', () => {
    expect(patchPathOfResolution('patch:foo@npm%3A1.0.0#patches/foo.patch')).toBe('patches/foo.patch')
  })

  it('returns undefined when there is no patch locator or no `#` path', () => {
    expect(patchPathOfResolution(undefined)).toBeUndefined()
    expect(patchPathOfResolution('npm:lodash@4.17.21')).toBeUndefined()
    expect(patchPathOfResolution('patch:foo@npm%3A1.0.0')).toBeUndefined()
  })

  it('drives the overrides block on a berry→v9 cross-format patch conversion', () => {
    // End-to-end: berry parse populates nativeResolution with the patch locator;
    // v9 stringify calls patchPathOfResolution + synthesiseOverridePatches. Uses
    // the real patch-yarn berry fixture (carries the `@patch:…::version=…`
    // locator on lodash).
    const graph = parseBerry(fixture('patch-yarn/yarn-berry-v9.lock'))
    const out = stringifyV9(graph)
    expect(out).toContain('overrides:')
    expect(out).toContain('patch:lodash@npm%3A4.17.21#./.yarn/patches/lodash-npm-4.17.21-6382451519.patch')
  })
})

describe('resolvePeerTargetById', () => {
  it('resolves exact, bare fallback, deterministic prefix scan, and a miss', () => {
    const seen = new Set(['react@18.2.0(a@1.0.0)', 'react@18.2.0(b@2.0.0)', 'lodash@4.17.21'])
    // Exact full-form match.
    expect(resolvePeerTargetById(seen, 'react', '18.2.0(b@2.0.0)')).toBe('react@18.2.0(b@2.0.0)')
    // Bare base fallback.
    expect(resolvePeerTargetById(seen, 'lodash', '4.17.21')).toBe('lodash@4.17.21')
    // Prefix scan picks the lexicographically SMALLEST peer-virt sibling.
    expect(resolvePeerTargetById(seen, 'react', '18.2.0')).toBe('react@18.2.0(a@1.0.0)')
    // No match.
    expect(resolvePeerTargetById(seen, 'missing', '9.9.9')).toBeUndefined()
  })
})

describe('encodeWorkspaceDirectory', () => {
  // Ported from `filenamify@4.3.0`, which pnpm 6/9/10 call as
  // `filenamify(linkedDir, { replacement: '+' })`. Each case pins one rule.
  it.each([
    ['packages/core', 'packages+core', 'every path separator becomes `+`'],
    ['deep/a/b/c', 'deep+a+b+c', 'a nested path collapses separator by separator'],
    ['plus+dir', 'plus+dir', 'an existing `+` is NOT a separator and survives'],
    ['', '', 'the root importer, which pnpm links as `link:` with no path'],
    ['a//b', 'a+b', 'a run of `+` collapses to one'],
    ['+edge+', 'edge', 'one leading and one trailing `+` are stripped'],
    ['..', '+', 'a leading dot-run becomes ONE `+`, kept because outer-strip needs length > 1'],
    ['dir.', 'dir', 'a trailing dot-run is dropped'],
    ['a:b|c?d*e', 'a+b+c+d+e', 'every filename-reserved character becomes `+`'],
    ['aux', 'aux+', 'a Windows device name gains a trailing `+`'],
  ])('encodes %j as %j — %s', (input, expected) => {
    expect(encodeWorkspaceDirectory(input)).toBe(expected)
  })

  it('truncates at 100 characters, which makes the encoding lossy', () => {
    const long = 'p'.repeat(60) + '/' + 'q'.repeat(60)
    expect(encodeWorkspaceDirectory(long)).toHaveLength(100)
  })
})

describe('resolveWorkspacePeerId', () => {
  it('resolves an exact importer, an ancestor walk-up, and rejects a registry peer', () => {
    const importerByPath = new Map([
      ['.', '.@0.0.0'],
      ['packages/lib', 'packages/lib@0.0.0'],
    ])
    // `+`-decoded exact importer dir.
    expect(resolveWorkspacePeerId('packages+lib', importerByPath)).toBe('packages/lib@0.0.0')
    // Sub-dir publish walks up to the ancestor importer.
    expect(resolveWorkspacePeerId('packages+lib+build', importerByPath)).toBe('packages/lib@0.0.0')
    // A real semver is not a workspace path.
    expect(resolveWorkspacePeerId('1.2.3', importerByPath)).toBeUndefined()
  })

  it('resolves an importer directory that itself contains a `+`', () => {
    // Measured on pnpm 9.15.9: an importer at `plus+dir` is encoded VERBATIM —
    // `filenamify` leaves `+` alone — so the token is `react@plus+dir`.
    // Decoding `+`→`/` yields `plus/dir`, which is no importer; only matching
    // against the ENCODING of each known importer finds it.
    const importerByPath = new Map([
      ['.', '.@0.0.0'],
      ['plus+dir', 'plus+dir@0.0.0'],
    ])
    expect(resolveWorkspacePeerId('plus+dir', importerByPath)).toBe('plus+dir@0.0.0')
  })

  it('resolves the empty locator the root importer encodes to', () => {
    // Measured on pnpm 9.15.9: a peer satisfied by the ROOT importer is stored
    // as `link:` with an empty directory, so `filenamify('')` yields `''` and
    // pnpm writes the bare token `react@`.
    const importerByPath = new Map([['.', '.@0.0.0']])
    expect(resolveWorkspacePeerId('', importerByPath)).toBe('.@0.0.0')
  })

  it('keeps a nested importer directory distinct from a same-named sibling', () => {
    const importerByPath = new Map([
      ['.', '.@0.0.0'],
      ['deep/a/b/c', 'deep/a/b/c@0.0.0'],
    ])
    expect(resolveWorkspacePeerId('deep+a+b+c', importerByPath)).toBe('deep/a/b/c@0.0.0')
  })
})

describe('derivePeerCandidates', () => {
  it('returns only bare nodes whose version satisfies the range', () => {
    const graph = parseV9(
      V9(
        'importers:\n\n  .: {}\n\n' +
          'packages:\n\n  react@17.0.2:\n    resolution: {integrity: sha512-a}\n  react@18.2.0:\n    resolution: {integrity: sha512-b}\n\n' +
          'snapshots:\n\n  react@17.0.2: {}\n  react@18.2.0: {}\n',
      ),
    )
    expect(derivePeerCandidates(graph, 'react', '^18.0.0')).toEqual(['react@18.2.0'])
    expect(derivePeerCandidates(graph, 'react', '>=17.0.0')).toEqual(['react@17.0.2', 'react@18.2.0'])
    expect(derivePeerCandidates(graph, 'react', '^99.0.0')).toEqual([])
  })
})

describe('resolveLinkPath', () => {
  it('resolves `../` and `./` relative link targets', () => {
    // Root importer collapses `./`/`../` prefixes.
    expect(resolveLinkPath('.', './packages/a')).toBe('packages/a')
    // Nested importer walks up for `..` and down for a plain segment.
    expect(resolveLinkPath('packages/a', '../b')).toBe('packages/b')
    expect(resolveLinkPath('packages/a', '../../vendor/x')).toBe('vendor/x')
  })
})

describe('relativeImporterPath', () => {
  it('computes the importer-relative path to a target', () => {
    // Root → verbatim target.
    expect(relativeImporterPath('.', 'packages/b')).toBe('packages/b')
    // Sibling importers: up one, down into the sibling.
    expect(relativeImporterPath('packages/a', 'packages/b')).toBe('../b')
    // Same path → `.`.
    expect(relativeImporterPath('packages/a', 'packages/a')).toBe('.')
  })
})

describe('packageExtensionsChecksum round-trip', () => {
  // pnpm recomputes this digest of the effective packageExtensions config and
  // frozen-compares it; dropping it on a same-PM round-trip forces a recompute-
  // mismatch and breaks --frozen-lockfile (real vite/angular v9 locks carry it).
  const CHK = 'sha256-Tldxs3DhJEw/FFBonUidqhCBqApA0zxQnop3Y+BTO3U='

  it('replays the checksum verbatim, after overrides and before importers (v9)', () => {
    const lock = V9(
      `overrides:\n  foo: 1.0.0\n\n` +
        `packageExtensionsChecksum: ${CHK}\n\n` +
        `importers:\n\n  .:\n    dependencies:\n      ms:\n        specifier: 2.1.3\n        version: 2.1.3\n\n` +
        `packages:\n\n  ms@2.1.3:\n    resolution: {integrity: sha512-x}\n\n` +
        `snapshots:\n\n  ms@2.1.3: {}\n`,
    )
    const out = stringifyV9(parseV9(lock))
    expect(out).toContain(`packageExtensionsChecksum: ${CHK}`)
    expect(out.indexOf('packageExtensionsChecksum')).toBeGreaterThan(out.indexOf('overrides:'))
    expect(out.indexOf('packageExtensionsChecksum')).toBeLessThan(out.indexOf('importers:'))
  })

  it('omits the key when the source lock carries none (v9)', () => {
    const lock = V9(
      `importers:\n\n  .:\n    dependencies:\n      ms:\n        specifier: 2.1.3\n        version: 2.1.3\n\n` +
        `packages:\n\n  ms@2.1.3:\n    resolution: {integrity: sha512-x}\n\n` +
        `snapshots:\n\n  ms@2.1.3: {}\n`,
    )
    expect(stringifyV9(parseV9(lock))).not.toContain('packageExtensionsChecksum')
  })

  it('replays the checksum for v6 too (defensive slot)', () => {
    const lock = V6(
      `overrides:\n  foo: 1.0.0\n\n` +
        `packageExtensionsChecksum: ${CHK}\n\n` +
        `dependencies:\n  ms: 2.1.3\n\n` +
        `packages:\n\n  /ms@2.1.3:\n    resolution: {integrity: sha512-x}\n    dev: false\n`,
    )
    expect(stringifyV6(parseV6(lock))).toContain(`packageExtensionsChecksum: ${CHK}`)
  })
})

describe('patchedDependencies round-trip', () => {
  // Top-level patch-file declarations (name@version → {hash, path}) pnpm frozen-
  // compares; the `path` isn't carried by the modeled patch_hash= markers, so the
  // block must round-trip verbatim or --frozen-lockfile breaks.
  const BLOCK = `patchedDependencies:\n  ms@2.1.3:\n    hash: 8a4f9e2b\n    path: patches/ms@2.1.3.patch\n\n`

  it('replays the block verbatim, after packageExtensionsChecksum and before importers (v9)', () => {
    const lock = V9(
      `overrides:\n  foo: 1.0.0\n\n` +
        `packageExtensionsChecksum: sha256-abc=\n\n` +
        BLOCK +
        `importers:\n\n  .:\n    dependencies:\n      ms:\n        specifier: 2.1.3\n        version: 2.1.3\n\n` +
        `packages:\n\n  ms@2.1.3:\n    resolution: {integrity: sha512-x}\n\n` +
        `snapshots:\n\n  ms@2.1.3: {}\n`,
    )
    const out = stringifyV9(parseV9(lock))
    expect(out).toContain('path: patches/ms@2.1.3.patch')
    expect(out.indexOf('patchedDependencies:')).toBeGreaterThan(out.indexOf('packageExtensionsChecksum'))
    expect(out.indexOf('patchedDependencies:')).toBeLessThan(out.indexOf('importers:'))
  })

  it('omits the block when the source lock carries none (v9)', () => {
    const lock = V9(
      `importers:\n\n  .:\n    dependencies:\n      ms:\n        specifier: 2.1.3\n        version: 2.1.3\n\n` +
        `packages:\n\n  ms@2.1.3:\n    resolution: {integrity: sha512-x}\n\n` +
        `snapshots:\n\n  ms@2.1.3: {}\n`,
    )
    expect(stringifyV9(parseV9(lock))).not.toContain('patchedDependencies:')
  })
})

describe('importer dep alias collision (plain + npm-alias to same target)', () => {
  // A plain `react: ^x` dep and an aliased `react-alias: npm:react@^x` dep resolve
  // to the SAME target node. Importer-edge sidecars were keyed src\0kind\0dst
  // WITHOUT the alias, so the two collided and the plain dep read back the alias's
  // descriptor (emitting `specifier: npm:react@^x, version: react@x`). Regression.
  it('keeps each dep its own specifier/version (no descriptor bleed)', () => {
    const lock = V9(
      `importers:\n\n  .:\n    dependencies:\n` +
        `      react:\n        specifier: ^19.2.6\n        version: 19.2.6\n` +
        `      react-alias:\n        specifier: npm:react@^19.2.6\n        version: react@19.2.6\n\n` +
        `packages:\n\n  react@19.2.6:\n    resolution: {integrity: sha512-x}\n\n` +
        `snapshots:\n\n  react@19.2.6: {}\n`,
    )
    const out = stringifyV9(parseV9(lock))
    expect(out).toContain('      react:\n        specifier: ^19.2.6\n        version: 19.2.6\n')
    expect(out).toContain('      react-alias:\n        specifier: npm:react@^19.2.6\n        version: react@19.2.6\n')
  })
})

describe('pnpmfileChecksum round-trip', () => {
  // pnpm's `.pnpmfile.cjs` digest — frozen-compared like packageExtensionsChecksum.
  it('replays the checksum, after packageExtensionsChecksum and before importers (v9)', () => {
    const lock = V9(
      `packageExtensionsChecksum: sha256-a=\n\n` +
        `pnpmfileChecksum: sha256-b=\n\n` +
        `importers:\n\n  .:\n    dependencies:\n      ms:\n        specifier: 2.1.3\n        version: 2.1.3\n\n` +
        `packages:\n\n  ms@2.1.3:\n    resolution: {integrity: sha512-x}\n\n` +
        `snapshots:\n\n  ms@2.1.3: {}\n`,
    )
    const out = stringifyV9(parseV9(lock))
    expect(out).toContain('pnpmfileChecksum: sha256-b=')
    expect(out.indexOf('pnpmfileChecksum')).toBeGreaterThan(out.indexOf('packageExtensionsChecksum'))
    expect(out.indexOf('pnpmfileChecksum')).toBeLessThan(out.indexOf('importers:'))
  })
})

describe('settings block round-trip', () => {
  // extractSettings keeps only the two resolution-affecting booleans for the model,
  // but pnpm frozen-compares the FULL block — dropping e.g. `dedupePeers` breaks it.
  it('preserves non-extracted settings keys verbatim (dedupePeers)', () => {
    const lock =
      `lockfileVersion: '9.0'\n\n` +
      `settings:\n  autoInstallPeers: false\n  dedupePeers: true\n  excludeLinksFromLockfile: false\n\n` +
      `importers:\n\n  .: {}\n\npackages: {}\n\nsnapshots: {}\n`
    const out = stringifyV9(parseV9(lock))
    expect(out).toContain('dedupePeers: true')
    expect(out).toContain('autoInstallPeers: false')
  })

  it('reconstructs the two-key block cross-PM (no verbatim sidecar)', () => {
    // A graph with no pnpm sidecar (npm→pnpm-shaped) still emits a valid settings block.
    const lock = V9(`importers:\n\n  .: {}\n\npackages: {}\n\nsnapshots: {}\n`)
    const out = stringifyV9(parseV9(lock))
    expect(out).toMatch(/^settings:/m)
    expect(out).toContain('autoInstallPeers:')
  })
})
