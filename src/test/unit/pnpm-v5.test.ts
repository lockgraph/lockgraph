// pnpm-v5 adapter tests — standalone-fit per ADR-0022 §5 r2 amendment.
//
// Lifecycle coverage (parse-fixture, modify, enrich, optimize, ADR-0006
// roundtrip) is delegated к `_pnpm-suite-core.ts` — the shape-agnostic
// suite extracted во время r1 collab F4 fix-up. v5-specific deltas
// (decimal `5.x` handshake, slash-separator packages keys, underscore
// peer-context, dual-top-level drift, settings-dropped sidecar
// composition, peer-virt 3-branch fallback synthesis) stay here.

import { describe, expect, it } from 'vitest'
import { type Graph } from '../../main/ts/graph.ts'
import { LockfileError } from '../../main/ts/errors.ts'
import { check, enrich, optimize, parse, stringify } from '../../main/ts/formats/pnpm-v5.ts'
import { parse as parseV6 } from '../../main/ts/formats/pnpm-v6.ts'
import { parse as parseV9 } from '../../main/ts/formats/pnpm-v9.ts'
import { parse as parseClassic } from '../../main/ts/formats/yarn-classic.ts'
import { parse as parseYarnBerry } from '../../main/ts/formats/yarn-berry-v9.ts'
import { parse as parseNpm3 } from '../../main/ts/formats/npm-3.ts'
import {
  fixture,
} from '../helpers/lockfile-test-utils.ts'
import { registerPnpmCoreSuite, type PnpmCoreSuiteSpec } from './_pnpm-suite-core.ts'

// v5 fixture matrix per ADR-0022 §A acceptance gate (7 fixtures — no
// patch-yarn per the gate's working set table).
const FIXTURES = [
  'deps-with-scopes',
  'peers-basic',
  'peers-multi',
  'simple',
  'workspace-cross-refs',
  'workspaces-basic',
  'yarn-crlf',
] as const

const SPEC: PnpmCoreSuiteSpec = {
  label: 'pnpm-v5',
  diagPrefix: 'PNPM_V5',
  fixtureSuffix: 'pnpm-v5.lock',
  fixtures: FIXTURES,
  adapter: { check, parse, stringify, enrich, optimize },
}

registerPnpmCoreSuite(SPEC)

const parseFixtureGraph = (name: typeof FIXTURES[number]): Graph =>
  parse(fixture(`${name}/pnpm-v5.lock`))

// === v5-only — cross-version rejection (decimal vs quoted handshake) ========

describe('pnpm-v5 — cross-version rejection (decimal vs quoted handshake)', () => {
  it('check() rejects pnpm-v6 / pnpm-v9 fixtures (quoted handshake)', () => {
    expect(check(fixture('simple/pnpm-v6.lock'))).toBe(false)
    expect(check(fixture('simple/pnpm-v9.lock'))).toBe(false)
  })

  it('parse rejects pnpm-v6 (quoted "6.0") with FORMAT_MISMATCH', () => {
    const v6 = fixture('simple/pnpm-v6.lock')
    expect(() => parse(v6)).toThrow(LockfileError)
    try { parse(v6) } catch (error) {
      expect((error as LockfileError).code).toBe('FORMAT_MISMATCH')
    }
  })

  it('parse rejects pnpm-v9 (quoted "9.0") with FORMAT_MISMATCH', () => {
    const v9 = fixture('simple/pnpm-v9.lock')
    expect(() => parse(v9)).toThrow(LockfileError)
    try { parse(v9) } catch (error) {
      expect((error as LockfileError).code).toBe('FORMAT_MISMATCH')
    }
  })

  for (const [name, foreignFixture] of [
    ['yarn-classic', 'simple/yarn-classic.lock'],
    ['yarn-berry-v9', 'simple/yarn-berry-v9.lock'],
    ['npm-3', 'simple/npm-3.lock'],
  ] as const) {
    it(`parse rejects ${name} input with FORMAT_MISMATCH`, () => {
      const text = fixture(foreignFixture)
      expect(() => parse(text)).toThrow(LockfileError)
      try { parse(text) } catch (error) {
        expect((error as LockfileError).code).toBe('FORMAT_MISMATCH')
      }
    })
  }

  it('cross-adapter probe: pnpm-v6 / pnpm-v9 / yarn-* / npm-3 parsers reject pnpm-v5 input', () => {
    const own = fixture('simple/pnpm-v5.lock')
    expect(() => parseV6(own)).toThrow()
    expect(() => parseV9(own)).toThrow()
    expect(() => parseClassic(own)).toThrow()
    expect(() => parseYarnBerry(own)).toThrow()
    expect(() => parseNpm3(own)).toThrow()
  })

  it('accepts pnpm-v5 fixture across all 5.x literals (parse never throws on the working corpus)', () => {
    for (const name of FIXTURES) {
      const text = fixture(`${name}/pnpm-v5.lock`)
      expect(check(text)).toBe(true)
      expect(() => parse(text)).not.toThrow()
    }
  })
})

// === v5-only schema deltas (decimal / slash-separator / underscore peer) ===

describe('pnpm-v5 — schema deltas (decimal version / slash-separator / underscore peer)', () => {
  it('parses decimal `lockfileVersion: 5.4` (NOT quoted)', () => {
    const text = fixture('simple/pnpm-v5.lock')
    expect(text).toMatch(/^lockfileVersion: 5\.\d/)
    expect(text).not.toMatch(/^lockfileVersion: '5/)
    const graph = parse(text)
    expect(graph.getNode('.@0.0.0')).toBeDefined()
  })

  it('parses top-level `specifiers` + `dependencies` collapsed-root (no importers block)', () => {
    const text = fixture('simple/pnpm-v5.lock')
    expect(text).toContain('\nspecifiers:\n')
    expect(text).toContain('\ndependencies:\n')
    expect(text).not.toContain('\nimporters:\n')
  })

  it('parses slash-separator packages keys `/<name>/<version>` into bare NodeIds', () => {
    const text = fixture('simple/pnpm-v5.lock')
    expect(text).toContain('  /lodash/4.17.21:')
    expect(text).toContain('  /ms/2.1.3:')
    const graph = parse(text)
    expect(graph.getNode('lodash@4.17.21')).toBeDefined()
    expect(graph.getNode('ms@2.1.3')).toBeDefined()
  })

  it('parses underscore peer-context syntax `/<name>/<version>_<peer>@<v>` into peer-virt NodeIds', () => {
    const text = fixture('peers-basic/pnpm-v5.lock')
    expect(text).toContain('  /react-dom/18.2.0_react@18.2.0:')
    expect(text).not.toContain('\nsnapshots:')
    const graph = parse(text)
    const peerVirtId = 'react-dom@18.2.0(react@18.2.0)'
    expect(graph.getNode(peerVirtId)).toBeDefined()
  })

  it('parses scoped packages keys `/@scope/name/<version>` (last-slash split)', () => {
    const text = fixture('deps-with-scopes/pnpm-v5.lock')
    expect(text).toContain('  /@sindresorhus/is/6.3.1:')
    expect(text).toContain('  /@types/node/20.11.30:')
  })

  it('parses multi-importer fixture using `importers` block (no top-level `specifiers`)', () => {
    const text = fixture('peers-multi/pnpm-v5.lock')
    expect(text).toContain('importers:')
    expect(text).not.toMatch(/^specifiers:/m)
  })

  it('parses dependencies underscore peer-suffix value `<version>_<peer>@<v>`', () => {
    const text = fixture('peers-basic/pnpm-v5.lock')
    expect(text).toContain('  react-dom: 18.2.0_react@18.2.0')
    const graph = parse(text)
    const out = graph.out('.@0.0.0', 'dep').map(e => e.dst).sort()
    expect(out).toContain('react-dom@18.2.0(react@18.2.0)')
  })

  it('parses inline `dependencies:` block under packages entries as resolved-tree edges', () => {
    const graph = parseFixtureGraph('peers-basic')
    // react-dom@18.2.0(react@18.2.0) inlines deps on loose-envify, react, scheduler.
    const outDeps = graph.out('react-dom@18.2.0(react@18.2.0)', 'dep').map(e => e.dst).sort()
    expect(outDeps).toEqual(['loose-envify@1.4.0', 'react@18.2.0', 'scheduler@0.23.2'])
  })

  it('PNPM_V5_DUAL_TOP_LEVEL_DRIFT diagnostic when both shapes present', () => {
    const malformed = [
      'lockfileVersion: 5.4',
      '',
      'specifiers:',
      '  lodash: 4.17.21',
      '',
      'dependencies:',
      '  lodash: 4.17.21',
      '',
      'importers:',
      '  .:',
      '    specifiers: {}',
      '',
      'packages:',
      '',
      '  /lodash/4.17.21:',
      '    resolution: {integrity: sha512-faked}',
      '    dev: false',
      '',
    ].join('\n')
    const graph = parse(malformed)
    const drift = graph.diagnostics().find(d => d.code === 'PNPM_V5_DUAL_TOP_LEVEL_DRIFT')
    expect(drift).toBeDefined()
  })

  it('right-to-left peel grammar handles multi-peer chains', () => {
    const synthetic = [
      'lockfileVersion: 5.4',
      '',
      'specifiers:',
      '  host: 1.0.0',
      '',
      'dependencies:',
      '  host: 1.0.0_react@18.0.0_redux@4.2.0',
      '',
      'packages:',
      '',
      '  /react/18.0.0:',
      '    resolution: {integrity: sha512-r}',
      '    dev: false',
      '',
      '  /redux/4.2.0:',
      '    resolution: {integrity: sha512-x}',
      '    dev: false',
      '',
      '  /host/1.0.0_react@18.0.0_redux@4.2.0:',
      '    resolution: {integrity: sha512-h}',
      '    peerDependencies:',
      '      react: ^18.0.0',
      '      redux: ^4.0.0',
      '    dev: false',
      '',
    ].join('\n')
    const graph = parse(synthetic)
    const host = graph.getNode('host@1.0.0(react@18.0.0)(redux@4.2.0)')
    expect(host).toBeDefined()
    expect(host?.peerContext).toEqual(['react@18.0.0', 'redux@4.2.0'])
  })
})

// === v5-only — stringify emit shape =========================================

describe('pnpm-v5 — stringify deltas (decimal handshake / slash-separator / underscore peer)', () => {
  it('emits well-formed YAML with decimal lockfileVersion 5.4 (NOT quoted)', () => {
    const graph = parseFixtureGraph('simple')
    const text = stringify(graph)
    expect(text).toMatch(/^lockfileVersion: 5\.4\n/)
    expect(text).not.toMatch(/^lockfileVersion: '/)
  })

  it('emits canonical 2-space indent + trailing newline', () => {
    const graph = parseFixtureGraph('simple')
    const text = stringify(graph)
    expect(text.endsWith('\n')).toBe(true)
    expect(text).toContain('\n  /lodash/4.17.21:')
  })

  it('emits slash-separator packages keys `/<name>/<version>`', () => {
    const graph = parseFixtureGraph('simple')
    const text = stringify(graph)
    expect(text).toContain('  /lodash/4.17.21:')
    expect(text).toContain('  /ms/2.1.3:')
  })

  it('emits underscore peer-context on packages keys (slash + underscore)', () => {
    const graph = parseFixtureGraph('peers-basic')
    const text = stringify(graph)
    expect(text).toContain('  /react-dom/18.2.0_react@18.2.0:')
  })

  it('does NOT emit `settings` block (v5 schema delta)', () => {
    const graph = parseFixtureGraph('simple')
    const text = stringify(graph)
    expect(text).not.toContain('settings:')
  })

  it('does NOT emit `snapshots` block (v5 inlines transitives)', () => {
    const graph = parseFixtureGraph('peers-basic')
    const text = stringify(graph)
    expect(text).not.toContain('\nsnapshots:')
  })

  it('emits `dev: false` per-entry flag', () => {
    const graph = parseFixtureGraph('simple')
    const text = stringify(graph)
    expect(text).toMatch(/\n    dev: false/)
  })

  it('emits inline `dependencies:` block under packages entries (transitives)', () => {
    const graph = parseFixtureGraph('peers-basic')
    const text = stringify(graph)
    const startIdx = text.indexOf('/react-dom/18.2.0_react@18.2.0:')
    expect(startIdx).toBeGreaterThan(0)
    const segment = text.slice(startIdx, text.indexOf('\n  /', startIdx + 1))
    expect(segment).toContain('dependencies:')
    expect(segment).toContain('loose-envify:')
  })

  it('emits top-level `specifiers` + `dependencies` in single-importer mode (no importers)', () => {
    const graph = parseFixtureGraph('simple')
    const text = stringify(graph)
    expect(text).toMatch(/\nspecifiers:\n/)
    expect(text).toMatch(/\ndependencies:\n/)
    expect(text).not.toMatch(/\nimporters:\n/)
  })

  it('emits `importers` block when workspace members are present (multi-importer)', () => {
    const graph = parseFixtureGraph('peers-multi')
    const text = stringify(graph)
    expect(text).toContain('importers:')
    expect(text).toContain('packages/a:')
    expect(text).toContain('packages/b:')
  })

  it('emits scoped names as unquoted slash-leading packages keys (slash prefix obviates `@` quoting)', () => {
    const graph = parseFixtureGraph('deps-with-scopes')
    const text = stringify(graph)
    // v5 prefixes keys with `/` (e.g. `/@sindresorhus/is/6.3.1:`) — the leading
    // `/` defeats the YAML scalar quoting rule for `@`-leading keys, so the
    // packages key stays unquoted (matches the on-disk fixture verbatim).
    expect(text).toContain('  /@sindresorhus/is/6.3.1:')
    expect(text).toContain('  /@types/node/20.11.30:')
    // Specifiers + dependencies keys still need quotes (no `/` prefix).
    expect(text).toMatch(/  '@sindresorhus\/is':/)
    expect(text).toMatch(/  '@types\/node':/)
  })

  it('emits resolution as flow-style inline {integrity: ...}', () => {
    const graph = parseFixtureGraph('simple')
    const text = stringify(graph)
    expect(text).toMatch(/resolution: \{integrity: sha512-/)
  })

  it('roundtrips yarn-crlf at Graph level when CRLF is requested', () => {
    const original = parseFixtureGraph('yarn-crlf')
    const emitted = stringify(original, { lineEnding: 'crlf' })
    const reparsed = parse(emitted)

    expect(emitted).toContain('\r\n')
    expect(emitted.replace(/\r\n/g, '\n')).toBe(stringify(original))
    expect(reparsed.getNode('.@0.0.0')).toBeDefined()
  })
})

// === v5-only — enrich 3-branch peer-virt fallback ===========================

describe('pnpm-v5 — enrich 3-branch peer-virt fallback (synthetic)', () => {
  it('peer-virt 3-branch fallback: 1-candidate emits PNPM_V5_PEER_BOUND when on-disk context absent', () => {
    const synthetic = [
      'lockfileVersion: 5.4',
      '',
      'specifiers:',
      '  consumer: 1.0.0',
      '',
      'dependencies:',
      '  consumer: 1.0.0',
      '',
      'packages:',
      '',
      '  /consumer/1.0.0:',
      '    resolution: {integrity: sha512-c}',
      '    peerDependencies:',
      '      provider: ^1.0.0',
      '    dev: false',
      '',
      '  /provider/1.5.0:',
      '    resolution: {integrity: sha512-p}',
      '    dev: false',
      '',
    ].join('\n')
    const graph = parse(synthetic)
    const result = enrich(graph)
    const bound = result.diagnostics.find(d => d.code === 'PNPM_V5_PEER_BOUND')
    expect(bound).toBeDefined()
  })

  it('peer-virt 3-branch fallback: 0-candidate emits PNPM_V5_PEER_UNSATISFIED', () => {
    const synthetic = [
      'lockfileVersion: 5.4',
      '',
      'specifiers:',
      '  consumer: 1.0.0',
      '',
      'dependencies:',
      '  consumer: 1.0.0',
      '',
      'packages:',
      '',
      '  /consumer/1.0.0:',
      '    resolution: {integrity: sha512-c}',
      '    peerDependencies:',
      '      missing-provider: ^1.0.0',
      '    dev: false',
      '',
    ].join('\n')
    const graph = parse(synthetic)
    const result = enrich(graph)
    expect(result.diagnostics.some(d => d.code === 'PNPM_V5_PEER_UNSATISFIED')).toBe(true)
  })

  it('peer-virt 3-branch fallback: ≥2-candidate emits PNPM_V5_PEER_AMBIGUOUS', () => {
    const synthetic = [
      'lockfileVersion: 5.4',
      '',
      'specifiers:',
      '  consumer: 1.0.0',
      '',
      'dependencies:',
      '  consumer: 1.0.0',
      '',
      'packages:',
      '',
      '  /consumer/1.0.0:',
      '    resolution: {integrity: sha512-c}',
      '    peerDependencies:',
      '      provider: ^1.0.0',
      '    dev: false',
      '',
      '  /provider/1.0.0:',
      '    resolution: {integrity: sha512-p1}',
      '    dev: false',
      '',
      '  /provider/1.5.0:',
      '    resolution: {integrity: sha512-p2}',
      '    dev: false',
      '',
    ].join('\n')
    const graph = parse(synthetic)
    const result = enrich(graph)
    expect(result.diagnostics.some(d => d.code === 'PNPM_V5_PEER_AMBIGUOUS')).toBe(true)
  })
})

// === v5-only — multi-peer canonical NodeId encoding =========================

describe('pnpm-v5 — canonical NodeId multi-peer encoding (v5-specific underscore form)', () => {
  it('canonical NodeId form `name@version(peer@v)` encoded as `/name/version_peer@v` on emit', () => {
    const graph = parseFixtureGraph('peers-basic')
    const text = stringify(graph)
    expect(text).toContain('/react-dom/18.2.0_react@18.2.0:')
  })

  it('canonical NodeId multi-peer form `(p1@v1)(p2@v2)` encoded as `_p1@v1_p2@v2` on emit', () => {
    const synthetic = [
      'lockfileVersion: 5.4',
      '',
      'specifiers:',
      '  host: 1.0.0',
      '',
      'dependencies:',
      '  host: 1.0.0_react@18.0.0_redux@4.2.0',
      '',
      'packages:',
      '',
      '  /react/18.0.0:',
      '    resolution: {integrity: sha512-r}',
      '    dev: false',
      '',
      '  /redux/4.2.0:',
      '    resolution: {integrity: sha512-x}',
      '    dev: false',
      '',
      '  /host/1.0.0_react@18.0.0_redux@4.2.0:',
      '    resolution: {integrity: sha512-h}',
      '    peerDependencies:',
      '      react: ^18.0.0',
      '      redux: ^4.0.0',
      '    dev: false',
      '',
    ].join('\n')
    const original = parse(synthetic)
    const host = original.getNode('host@1.0.0(react@18.0.0)(redux@4.2.0)')
    expect(host).toBeDefined()
    const emitted = stringify(original)
    expect(emitted).toContain('/host/1.0.0_react@18.0.0_redux@4.2.0:')
    const reparsed = parse(emitted)
    expect(reparsed.getNode('host@1.0.0(react@18.0.0)(redux@4.2.0)')).toBeDefined()
  })
})
