// npm serialisation fidelity — a lockgraph-emitted `package-lock.json` is
// BYTE-IDENTICAL to what npm itself writes, so a MUTABLE `npm install` (not only
// `npm ci`) leaves it untouched. This requires three things, all asserted here:
//   1. json-stringify-nice key order (scalars/arrays before nested objects;
//      swKeyOrder prefix then localeCompare), matching arborist's serialiser;
//   2. the `packages`-map key order (npm sorts by localeCompare, not codepoint);
//   3. every manifest-metadata field preserved, including `peerDependenciesMeta`
//      and `hasInstallScript` (previously dropped).
//
// Fixtures are REAL locks: `esbuild@0.20.2 + debug@4.3.4` written by npm 11
// (lockfileVersion 3 — exercises cpu/os/optional arrays, engines, bin,
// peerDependenciesMeta, hasInstallScript, scoped `@esbuild/*` keys) and
// `chalk + ms` written by npm 6 (lockfileVersion 1). If npm's output changes the
// fixtures can be regenerated with `npm install --package-lock-only`.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse, stringify } from '../../main/ts/index.ts'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = (name: string): string =>
  readFileSync(resolve(here, '../resources/fixtures/npm-serialize', name), 'utf8')

describe('npm serialisation fidelity — byte-identical to npm', () => {
  it('npm-3 (esbuild+debug) round-trips BYTE-IDENTICAL', () => {
    const lock = fixture('esbuild-debug-package-lock.json')
    expect(stringify('npm-3', parse('npm-3', lock))).toBe(lock)
  })

  it('npm-1 (chalk+ms, npm 6) round-trips BYTE-IDENTICAL', () => {
    const lock = fixture('chalk-ms-npm6-v1-package-lock.json')
    expect(stringify('npm-1', parse('npm-1', lock))).toBe(lock)
  })

  it('preserves peerDependenciesMeta and hasInstallScript (the fields npm re-adds on install)', () => {
    const lock = fixture('esbuild-debug-package-lock.json')
    const out = JSON.parse(stringify('npm-3', parse('npm-3', lock))) as {
      packages: Record<string, { peerDependenciesMeta?: unknown; hasInstallScript?: unknown }>
    }
    // debug declares supports-color as an optional peer.
    expect(out.packages['node_modules/debug']!.peerDependenciesMeta)
      .toEqual({ 'supports-color': { optional: true } })
    // esbuild has a postinstall script.
    expect(out.packages['node_modules/esbuild']!.hasInstallScript).toBe(true)
  })

  it('emits json-stringify-nice key order on an optional platform entry (arrays before objects)', () => {
    const lock = fixture('esbuild-debug-package-lock.json')
    const out = stringify('npm-3', parse('npm-3', lock))
    // For an @esbuild/<plat> entry npm orders: version, resolved, integrity (pref),
    // then cpu, license, optional, os (scalars/arrays, localeCompare), then engines
    // (nested object, last). Assert `os` precedes `engines` — the exact reordering
    // json-stringify-nice performs that plain JSON.stringify would not.
    const entry = out.slice(out.indexOf('"node_modules/@esbuild/'))
    const osAt = entry.indexOf('"os"')
    const enginesAt = entry.indexOf('"engines"')
    expect(osAt).toBeGreaterThan(-1)
    expect(enginesAt).toBeGreaterThan(-1)
    expect(osAt).toBeLessThan(enginesAt)
  })

  it('sorts the packages map by localeCompare (scoped keys), same as npm', () => {
    const lock = fixture('esbuild-debug-package-lock.json')
    const out = stringify('npm-3', parse('npm-3', lock))
    // The emitted packages-map key order must equal npm's own (byte-identity
    // already proves this, but pin the localeCompare intent directly).
    const keysOf = (s: string): string[] =>
      [...s.matchAll(/^ {4}"(node_modules\/[^"]+|)":/gm)].map(m => m[1]!)
    expect(keysOf(out)).toEqual(keysOf(lock))
  })
})
