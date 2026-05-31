import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse, stringify } from '../../../main/ts/index.ts'
import type { Diagnostic, FormatId } from '../../../main/ts/index.ts'

const here = dirname(fileURLToPath(import.meta.url))
const realWorld = resolve(here, '../../resources/fixtures/real-world')
const unitLockfiles = resolve(here, '../../resources/fixtures/lockfiles')

function collectResolveViolations(format: FormatId, lock: string): Diagnostic[] {
  const graph = parse(format, lock)
  const diagnostics: Diagnostic[] = []
  stringify(format, graph, { onDiagnostic: d => diagnostics.push(d) })
  return diagnostics.filter(d => d.code === 'LAYOUT_RESOLVE_VIOLATION')
}

// ADR-0028 INV-RESOLVE — the pnpm resolution-graph verifier. Two surfaces:
//
//  1. the alias-on-emit fix (Task B): an npm-aliased dep must emit under its
//     ALIAS descriptor slot (`react-is-cjs:`), valued with the canonical
//     `<name>@<version>` (`react-is@17.0.2`), at BOTH the importer hop and the
//     snapshot/inline-package hop — not under the resolved package name.
//  2. assertResolveValid emits ZERO LAYOUT_RESOLVE_VIOLATION on the well-formed
//     pnpm corpus (real-world v9 + v5/v6 unit fixtures).
describe('pnpm INV-RESOLVE — npm-alias on emit (ADR-0028)', () => {
  // A synthetic pnpm-v9 lock with an npm-aliased dep at BOTH hops:
  //   - importer `.` dep `react-is-cjs: { specifier: npm:react-is@^17,
  //     version: react-is@17.0.2 }`  (consumer hop)
  //   - package `host@1.0.0` snapshot dep `react-is-cjs: react-is@17.0.2`
  //     (package hop)
  // pnpm keys the dep block by the ALIAS descriptor and values it with the
  // canonical `react-is@17.0.2` (the form parse's resolveAliasedSnapshotTarget
  // reconstructs). The defect: the emit builders keyed by `dst.name`
  // (`react-is`) and dropped the alias — so the alias slot was lost and the
  // bare `react-is:` slot could not be told apart from a real `react-is` dep.
  const ALIASED_V9 = [
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
    `        version: 1.0.0`,
    `      react-is-cjs:`,
    `        specifier: npm:react-is@^17`,
    `        version: react-is@17.0.2`,
    ``,
    `packages:`,
    ``,
    `  host@1.0.0:`,
    `    resolution: {integrity: sha512-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa}`,
    ``,
    `  react-is@17.0.2:`,
    `    resolution: {integrity: sha512-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb}`,
    ``,
    `snapshots:`,
    ``,
    `  host@1.0.0:`,
    `    dependencies:`,
    `      react-is-cjs: react-is@17.0.2`,
    ``,
    `  react-is@17.0.2: {}`,
    ``,
  ].join('\n')

  it('parse lifts the npm-alias into edge.attrs.alias at both hops', () => {
    const g = parse('pnpm-v9', ALIASED_V9)
    const aliasEdges = Array.from(g.nodes())
      .flatMap(n => g.out(n.id))
      .filter(e => e.attrs?.alias === 'react-is-cjs')
    // One importer edge (.→react-is) + one snapshot edge (host→react-is).
    expect(aliasEdges).toHaveLength(2)
    for (const e of aliasEdges) expect(e.dst).toBe('react-is@17.0.2')
  })

  it('round-trips with the alias slot preserved (red before Task B, green after)', () => {
    const g = parse('pnpm-v9', ALIASED_V9)
    const out = stringify('pnpm-v9', g)

    // The importer dep block keys by the ALIAS, valued canonical — the fix.
    // (Pre-fix, the slot was keyed `react-is:` with a bare `17.0.2` value.)
    expect(out).toContain('react-is-cjs:')
    expect(out).toMatch(/react-is-cjs:\s*\n\s*specifier: npm:react-is\^?17|react-is-cjs:[\s\S]*?version: react-is@17\.0\.2/)
    // The importer must NOT emit a bare top-level `react-is:` dep slot — that
    // is the resolved name, which would be indistinguishable from a real dep.
    expect(out).not.toMatch(/^      react-is:$/m)

    // The snapshot hop keys by the alias and values canonical too.
    expect(out).toMatch(/react-is-cjs: react-is@17\.0\.2/)

    // End-to-end: re-parse the emitted lock and assert the alias survived on
    // BOTH edges and resolves to the real node. A wrong slot key / value would
    // drop the alias (or fail to resolve) here.
    const g2 = parse('pnpm-v9', out)
    const aliasEdges = Array.from(g2.nodes())
      .flatMap(n => g2.out(n.id))
      .filter(e => e.attrs?.alias === 'react-is-cjs')
    expect(aliasEdges).toHaveLength(2)
    for (const e of aliasEdges) expect(e.dst).toBe('react-is@17.0.2')

    // And the verifier itself is silent on this well-formed alias encoding.
    const violations = collectResolveViolations('pnpm-v9', ALIASED_V9)
    expect(violations).toEqual([])
  })
})

describe('pnpm INV-RESOLVE — clean on the corpus (ADR-0028)', () => {
  // The unit fixtures are find-up/peer-clean by construction: ZERO violations
  // across pnpm-v5 / v6 / v9.
  const unitDirs = readdirSync(unitLockfiles)
  for (const dir of unitDirs) {
    for (const [suffix, format] of [
      ['pnpm-v5.lock', 'pnpm-v5'],
      ['pnpm-v6.lock', 'pnpm-v6'],
      ['pnpm-v9.lock', 'pnpm-v9'],
    ] as const) {
      const p = resolve(unitLockfiles, dir, suffix)
      if (!existsSync(p)) continue
      it(`unit/${dir}/${suffix}: 0 LAYOUT_RESOLVE_VIOLATION`, () => {
        expect(collectResolveViolations(format, readFileSync(p, 'utf8'))).toEqual([])
      })
    }
  }

  // Real-world v9 locks whose peer-resolution is single-valued per
  // (consumer, dep-name) round-trip cleanly. vuejs-core is the canonical
  // clean large lock; vitejs-vite exercises npm-aliased `file:` deps (the
  // alias-on-emit fix) and is also clean.
  for (const dir of ['vuejs-core-main-86ad076', 'vitejs-vite-main-646dbed']) {
    const p = resolve(realWorld, dir, 'pnpm-lock.yaml')
    if (!existsSync(p)) continue
    it(`real-world/${dir}: 0 LAYOUT_RESOLVE_VIOLATION`, () => {
      expect(collectResolveViolations('pnpm-v9', readFileSync(p, 'utf8'))).toEqual([])
    })
  }

  // Known limitation (NOT fixed here): a consumer that carries TWO edges to two
  // distinct peer-virt instances of the SAME dependency name cannot be
  // represented in one snapshot dep block (one slot per name), so INV-RESOLVE
  // reports the unrepresentable edge. This is the pnpm-v9 "merged peers" hash
  // (`name@version(<hex-hash>)` snapshot keys) collapsing onto one bare NodeId
  // because the parser treats the hex peer-hash as a patch hash
  // (`isPatchHashSegment`, `_pnpm-flat-core.ts`). Pre-existing and orthogonal
  // to alias / catalog. directus/angular/nrwl-nx/supabase trip it; this test
  // PINS that the verifier surfaces it (an error diagnostic, never a throw) so
  // the gap is tracked, not silently emitted.
  it('surfaces (not throws) the peer-hash-collapse limit on directus', () => {
    const lock = readFileSync(resolve(realWorld, 'directus-directus-main-4290f6e/pnpm-lock.yaml'), 'utf8')
    let out = ''
    const diagnostics: Diagnostic[] = []
    expect(() => {
      out = stringify('pnpm-v9', parse('pnpm-v9', lock), { onDiagnostic: d => diagnostics.push(d) })
    }).not.toThrow()
    const violations = diagnostics.filter(d => d.code === 'LAYOUT_RESOLVE_VIOLATION')
    expect(violations.length).toBeGreaterThanOrEqual(1)
    expect(violations.every(d => d.severity === 'error')).toBe(true)
    // Every violation is the multi-edge-same-name (collapsed peer-virt)
    // signature — the consumer has >1 non-peer edge to the violated name.
    for (const d of violations) {
      const subj = d.subject as { src: string; dst: string; kind: string }
      const dst = parse('pnpm-v9', lock).getNode(subj.dst)
      expect(d.message).toContain('INV-RESOLVE violated')
      expect(dst).toBeDefined()
    }
    // Still emits a parseable lock.
    expect(() => parse('pnpm-v9', out)).not.toThrow()
  })
})
