import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse, stringify } from '../../../main/ts/index.ts'

const here = dirname(fileURLToPath(import.meta.url))
const realWorld = (rel: string): string =>
  readFileSync(resolve(here, '../../resources/fixtures/real-world', rel), 'utf8')

// ADR-0026 install-path replay. An un-mutated same-PM npm
// round-trip replays the parse-captured placement verbatim (skips the
// re-hoisting BFS), so a real lock with deep nested-hoist:
//   - re-stringifies WITHOUT IRREDUCIBLE_LOSS (the THROW manifestation),
//   - preserves the install-path key-set (the same-version-multipath
//     COLLAPSE manifestation),
// modulo `{optional:true}` uninstalled-optional placeholders (non-nodes),
// excluded from BOTH sides. Workspace symlinks (`{link:true}`) ARE now compared:
// ADR-0027 §4 (WS-LINK) fixed the over-emit (previously a link per member) so the
// emitted link-set matches npm's — link iff referenced; an unreferenced
// workspace member correctly gets none.
// The comparison is the RESOLVED-node + link install-path key-set.
const installPathKeys = (pkgs: Record<string, unknown>): string[] =>
  Object.keys(pkgs)
    .filter(k => {
      const e = pkgs[k] as { optional?: boolean } | null
      if (JSON.stringify(e) === '{"optional":true}') return false
      return true
    })
    .sort()

describe('npm install-path replay (ADR-0026)', () => {
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
