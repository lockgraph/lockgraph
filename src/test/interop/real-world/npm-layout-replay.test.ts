import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse, stringify } from '../../../main/ts/index.ts'

const here = dirname(fileURLToPath(import.meta.url))
const realWorld = (rel: string): string =>
  readFileSync(resolve(here, '../../resources/fixtures/real-world', rel), 'utf8')

// ADR-0026 install-path replay — sister #8 / #10. An un-mutated same-PM npm
// round-trip replays the parse-captured placement verbatim (skips the
// re-hoisting BFS), so a real lock with deep nested-hoist:
//   - re-stringifies WITHOUT IRREDUCIBLE_LOSS (vscode — the THROW manifestation),
//   - preserves the install-path key-set (socket.io — the same-version-multipath
//     COLLAPSE manifestation),
// modulo two out-of-#10-scope entry classes excluded from BOTH sides:
//   - `{optional:true}` uninstalled-optional placeholders (Bug #11 non-nodes), and
//   - workspace symlinks (`{link:true}`) — these are emitted by a separate code
//     path (workspace-member linking), and a known emission divergence exists
//     there for non-depended-on members (tracked separately, not #10).
// The comparison is the RESOLVED-node install-path key-set — exactly what the
// install-path replay governs.
const installPathKeys = (pkgs: Record<string, unknown>): string[] =>
  Object.keys(pkgs)
    .filter(k => {
      const e = pkgs[k] as { optional?: boolean; version?: unknown; link?: boolean } | null
      if (e !== null && typeof e === 'object' && e.link === true) return false
      if (JSON.stringify(e) === '{"optional":true}') return false
      return true
    })
    .sort()

describe('npm install-path replay (ADR-0026, #10/#8)', () => {
  for (const dir of [
    'microsoft-vscode-main-ddd12d5', // THROW: deep-nested brace-expansion collision
    'socketio-socket.io-main-190572d', // COLLAPSE: same-(name,version) at multiple paths
  ]) {
    it(`${dir} round-trips without IRREDUCIBLE_LOSS, resolved install-path key-set preserved`, () => {
      const lock = realWorld(`${dir}/package-lock.json`)
      const orig = JSON.parse(lock) as { packages: Record<string, unknown> }
      let out: { packages: Record<string, unknown> }
      expect(() => {
        out = JSON.parse(stringify('npm-3', parse('npm-3', lock)))
      }).not.toThrow()
      expect(installPathKeys(out!.packages)).toEqual(installPathKeys(orig.packages))
    })
  }
})
