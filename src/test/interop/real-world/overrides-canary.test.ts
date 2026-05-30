import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { detect, overridesOf, parse, stringify } from '../../../main/ts/index.ts'
import type { Manifest } from '../../../main/ts/graph.ts'

// Real-world overrides canary (ADR-0025 A1/A2). Exercises overridesOf on the
// actual published lockfiles + their package.json override blocks — the in-house
// mirror of the sister yarn-audit-fix canary that surfaced bugs #1–#11.
//
// Two findings this pinned: (1) real npm locks do NOT mirror root `overrides`
// into `packages[""].overrides` (vscode/TS/socket.io carry them only in
// package.json), so A2 manifest-capture is the primary npm path — overridesOf is
// fed the fixture's package.json via `manifests`. (2) re-stringifying some real
// npm locks throws `IRREDUCIBLE_LOSS` from the install-path re-derive (Bug #10,
// deferred to ADR-0026) — the round-trip below pins that as a known-deferred
// outcome rather than failing the overrides canary on an orthogonal bug.

const here = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(here, '../../resources/fixtures/real-world')
const LOCK_NAMES = ['pnpm-lock.yaml', 'yarn.lock', 'package-lock.json', 'bun.lock'] as const

/** Build a Manifest from a fixture's root package.json native override blocks. */
function manifestOf(dir: string): Manifest | undefined {
  const p = resolve(ROOT, dir, 'package.json')
  if (!existsSync(p)) return undefined
  let pkg: Record<string, unknown>
  try { pkg = JSON.parse(readFileSync(p, 'utf8')) } catch { return undefined }
  const native: NonNullable<Manifest['native']> = {}
  if (pkg.overrides !== undefined) native.npmOverrides = pkg.overrides
  if (pkg.resolutions !== undefined) native.yarnResolutions = pkg.resolutions as Record<string, string>
  const pnpm = pkg.pnpm as { overrides?: Record<string, string> } | undefined
  if (pnpm?.overrides !== undefined) native.pnpmOverrides = pnpm.overrides
  return Object.keys(native).length > 0 ? { native } : undefined
}

/** Locate + detect the lockfile in a fixture dir, attach its package.json manifest. */
function loadFixture(dir: string): { format: ReturnType<typeof detect>; text: string; manifests?: Record<string, Manifest> } | undefined {
  const files = readdirSync(resolve(ROOT, dir))
  for (const name of LOCK_NAMES) {
    if (!files.includes(name)) continue
    const text = readFileSync(resolve(ROOT, dir, name), 'utf8')
    const format = detect(text)
    if (format === undefined) continue
    const m = manifestOf(dir)
    return { format, text, manifests: m ? { '.': m } : undefined }
  }
  return undefined
}

const fixtures = readdirSync(ROOT, { withFileTypes: true })
  .filter(e => e.isDirectory()).map(e => e.name).sort()

// Fixtures that declare overrides (lock-borne pnpm OR manifest npm `overrides`).
const OVERRIDE_RICH = new Set([
  'directus-directus-main-4290f6e', // pnpm overrides: in the lock (22)
  'microsoft-vscode-main-ddd12d5', // npm overrides in package.json only (5)
  'microsoft-TypeScript-main-f3d3968', // npm overrides in package.json only (1, selfRef)
  'socketio-socket.io-main-190572d', // npm overrides in package.json only (3)
])

describe('real-world overrides canary (ADR-0025 A1/A2)', () => {
  it('overridesOf never throws on any real-world fixture', () => {
    for (const dir of fixtures) {
      const fx = loadFixture(dir)
      if (fx?.format === undefined) continue
      const g = parse(fx.format, fx.text, fx.manifests ? { manifests: fx.manifests } : {})
      expect(() => overridesOf(g), dir).not.toThrow()
      expect(Array.isArray(overridesOf(g)), dir).toBe(true)
    }
  })

  it('surfaces overrides on the override-rich fixtures (lock-borne pnpm + manifest-F6 npm)', () => {
    for (const dir of OVERRIDE_RICH) {
      const fx = loadFixture(dir)!
      const g = parse(fx.format!, fx.text, fx.manifests ? { manifests: fx.manifests } : {})
      expect(overridesOf(g).length, `${dir} expected ≥1 override`).toBeGreaterThan(0)
    }
  })

  it('overrides survive a canonical round-trip, or the re-emit is a known #10 IRREDUCIBLE_LOSS', () => {
    for (const dir of OVERRIDE_RICH) {
      const fx = loadFixture(dir)!
      const g1 = parse(fx.format!, fx.text, fx.manifests ? { manifests: fx.manifests } : {})
      const ov1 = overridesOf(g1)
      expect(ov1.length, dir).toBeGreaterThan(0)
      let re: string
      try {
        re = stringify(fx.format!, g1, { overrides: ov1 })
      } catch (err) {
        // Bug #10 (deferred → ADR-0026): the install-path re-derive can throw
        // IRREDUCIBLE_LOSS (install-path collision) on a deep-nested real npm
        // lock. Pin as known-deferred, not an overrides regression.
        const e = err as { code?: string }
        const isKnown10 = e.code === 'IRREDUCIBLE_LOSS' || String(err).includes('collides')
        expect(isKnown10, `${dir}: unexpected non-#10 stringify error: ${String(err)}`).toBe(true)
        continue
      }
      const ov2 = overridesOf(parse(fx.format!, re, fx.manifests ? { manifests: fx.manifests } : {}))
      expect(ov2.length, `${dir} overrides vanished on canonical round-trip`).toBeGreaterThan(0)
    }
  })

  it('a non-override fixture yields []', () => {
    const fx = loadFixture('lodash-lodash-main-a023532')!
    expect(overridesOf(parse(fx.format!, fx.text))).toEqual([])
  })
})
