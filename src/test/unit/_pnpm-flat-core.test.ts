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
  resolveWorkspacePeerId,
  derivePeerCandidates,
  resolveLinkPath,
  relativeImporterPath,
} from '../../main/ts/formats/_pnpm-flat-core.ts'

import { LockfileError } from '../../main/ts/errors.ts'

import { fixture } from '../helpers/lockfile-test-utils.ts'

const V9 = (body: string): string =>
  `lockfileVersion: '9.0'\n\n` +
  `settings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n\n` +
  body

const V6 = (body: string): string =>
  `lockfileVersion: '6.0'\n\n` +
  `settings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n\n` +
  body

describe('parse', () => {
  it('warns PNPM_BAD_ENTRY on a v9 snapshot key with no `@` separator', () => {
    const graph = parseV9(V9('importers:\n\n  .: {}\n\npackages: {}\n\nsnapshots:\n\n  no-at-sign: {}\n'))
    expect(graph.diagnostics().map(d => d.code)).toContain('PNPM_BAD_ENTRY')
  })

  it('warns PNPM_BAD_ENTRY on a v6 packages key that has no `@` after slash-strip', () => {
    const graph = parseV6(
      V6('dependencies:\n  lodash: 4.17.21\n\npackages:\n\n  /no-at-sign-here:\n    resolution: {integrity: sha512-x}\n    dev: false\n'),
    )
    expect(graph.diagnostics().map(d => d.code)).toContain('PNPM_BAD_ENTRY')
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
    expect(out).toContain('resolution: {directory: loc}')
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
