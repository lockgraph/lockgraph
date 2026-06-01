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
  // alias-on-emit fix) and is also clean. directus and supabase carry
  // nested-peer-suffix consumers (#70 — `@vitejs/plugin-vue`,
  // `@react-router/fs-routes`) whose distinct virtual-store instances now
  // stay distinct NodeIds, so both are clean too.
  for (const dir of [
    'vuejs-core-main-86ad076',
    'vitejs-vite-main-646dbed',
    'directus-directus-main-4290f6e',
    'supabase-supabase-master-a4334a2',
  ]) {
    const p = resolve(realWorld, dir, 'pnpm-lock.yaml')
    if (!existsSync(p)) continue
    it(`real-world/${dir}: 0 LAYOUT_RESOLVE_VIOLATION`, () => {
      expect(collectResolveViolations('pnpm-v9', readFileSync(p, 'utf8'))).toEqual([])
    })
  }

  // Known limitation (NOT fixed here — #69, deferred behind an ADR): a
  // bare-HEX hashed-peer-set segment (`name@version(<hex>)`, pnpm v9's "merged
  // peers" spelling) is dropped by the parser (`isPatchHashSegment`'s bare-hex
  // branch, `_pnpm-flat-core.ts`), collapsing two such snapshot keys onto one
  // bare NodeId. That collapsed consumer then carries TWO edges to two distinct
  // peer-virt instances of the SAME dep name — unrepresentable in one snapshot
  // dep block (one slot per name), so INV-RESOLVE reports the unrepresentable
  // edge. Distinct from #70 (nested peer SUFFIX truncation), which IS fixed:
  // directus/supabase are now clean (asserted above). angular's `@angular/build`
  // is the canonical bare-hex case (`@angular/build@22.0.0-rc.2(53b8…)` vs
  // `(76f7…)` differ only by the dropped hash). This test PINS that the verifier
  // SURFACES the #69 gap on angular (an error diagnostic, never a throw) so the
  // gap stays tracked, never silently emitted — and that EVERY residual angular
  // violation is the bare-hex `@angular/build` consumer (no #70 leakage).
  it('surfaces (not throws) the #69 bare-hex peer-set collapse on angular', () => {
    const lock = readFileSync(resolve(realWorld, 'angular-angular-main-45e8fb5/pnpm-lock.yaml'), 'utf8')
    let out = ''
    const diagnostics: Diagnostic[] = []
    expect(() => {
      out = stringify('pnpm-v9', parse('pnpm-v9', lock), { onDiagnostic: d => diagnostics.push(d) })
    }).not.toThrow()
    const violations = diagnostics.filter(d => d.code === 'LAYOUT_RESOLVE_VIOLATION')
    expect(violations.length).toBeGreaterThanOrEqual(1)
    expect(violations.every(d => d.severity === 'error')).toBe(true)
    // Every residual violation is the bare-hex `@angular/build` consumer (#69)
    // — NOT a #70 nested-suffix consumer (those are now fixed). This keeps the
    // #69 gap pinned and proves the #70 fix did not regress into a new class.
    const graph = parse('pnpm-v9', lock)
    for (const d of violations) {
      const subj = d.subject as { src: string; dst: string; kind: string }
      expect(d.message).toContain('INV-RESOLVE violated')
      expect(subj.src).toBe('@angular/build@22.0.0-rc.2')
      expect(graph.getNode(subj.dst)).toBeDefined()
    }
    // Still emits a parseable lock.
    expect(() => parse('pnpm-v9', out)).not.toThrow()
  })
})

// #70 — nested-peer-suffix preservation. A consumer that pnpm peer-virtualises
// against the SAME peer at two DIFFERENT transitive (peer-of-a-peer)
// resolutions gets two distinct virtual-store keys differing only in the
// peer's OWN nested `(...)` suffix (the directus `@vitejs/plugin-vue` shape:
// `@vitejs/plugin-vue@6.0.1(vite@8.0.8(…esbuild@0.26.0…))` vs the
// `esbuild@0.27.3` sibling). Pre-fix the parser FLATTENED the peer entry —
// dropping the nested suffix — so both keys collapsed to one NodeId carrying
// two dep edges to the same name (unrepresentable → LAYOUT_RESOLVE_VIOLATION,
// and silent data loss on round-trip). The fix carries the nested suffix into
// both the consumer's peerContext token and the peer edge target, keeping the
// instances distinct.
describe('pnpm INV-RESOLVE — nested-peer-suffix preserved (#70)', () => {
  // Minified synthetic v9, the directus `@vitejs/plugin-vue` shape: importer
  // `.` pulls two virtual-store instances of `widget@1.0.0` that differ ONLY in
  // the `esbuild` resolution nested under their shared `vite` peer.
  const sha = (c: string) => `sha512-${c.repeat(88)}`
  const NESTED_V9 = [
    `lockfileVersion: '9.0'`,
    ``,
    `importers:`,
    ``,
    `  .:`,
    `    dependencies:`,
    `      widget:`,
    `        specifier: ^1.0.0`,
    `        version: 1.0.0(vite@2.0.0(esbuild@1.0.0))`,
    `      widget2:`,
    `        specifier: ^1.0.0`,
    `        version: 1.0.0(vite@2.0.0(esbuild@2.0.0))`,
    ``,
    `packages:`,
    ``,
    `  widget@1.0.0:`,
    `    resolution: {integrity: ${sha('a')}}`,
    `    peerDependencies:`,
    `      vite: '*'`,
    `  vite@2.0.0:`,
    `    resolution: {integrity: ${sha('b')}}`,
    `    peerDependencies:`,
    `      esbuild: '*'`,
    `  esbuild@1.0.0:`,
    `    resolution: {integrity: ${sha('c')}}`,
    `  esbuild@2.0.0:`,
    `    resolution: {integrity: ${sha('d')}}`,
    ``,
    `snapshots:`,
    ``,
    `  'widget@1.0.0(vite@2.0.0(esbuild@1.0.0))':`,
    `    dependencies:`,
    `      vite: 2.0.0(esbuild@1.0.0)`,
    `  'widget@1.0.0(vite@2.0.0(esbuild@2.0.0))':`,
    `    dependencies:`,
    `      vite: 2.0.0(esbuild@2.0.0)`,
    `  'vite@2.0.0(esbuild@1.0.0)':`,
    `    dependencies:`,
    `      esbuild: 1.0.0`,
    `  'vite@2.0.0(esbuild@2.0.0)':`,
    `    dependencies:`,
    `      esbuild: 2.0.0`,
    `  esbuild@1.0.0: {}`,
    `  esbuild@2.0.0: {}`,
    ``,
  ].join('\n')

  it('keeps two nested-peer-variant instances distinct and clean (red before #70 fix)', () => {
    const g = parse('pnpm-v9', NESTED_V9)
    // TWO distinct `widget` nodes, each carrying its full nested `vite` suffix.
    // Pre-fix this was a SINGLE collapsed `widget@1.0.0(vite@2.0.0)` node.
    const widgets = Array.from(g.nodes()).filter(n => n.name === 'widget').map(n => n.id).sort()
    expect(widgets).toEqual([
      'widget@1.0.0(vite@2.0.0(esbuild@1.0.0))',
      'widget@1.0.0(vite@2.0.0(esbuild@2.0.0))',
    ])
    // No unrepresentable edge — the distinct instances each own a single
    // `vite` dep edge to the matching nested instance.
    expect(collectResolveViolations('pnpm-v9', NESTED_V9)).toEqual([])
  })

  it('round-trips both instances byte-stably (no silent collapse)', () => {
    const out = stringify('pnpm-v9', parse('pnpm-v9', NESTED_V9))
    const g2 = parse('pnpm-v9', out)
    const widgets = Array.from(g2.nodes()).filter(n => n.name === 'widget').map(n => n.id).sort()
    expect(widgets).toEqual([
      'widget@1.0.0(vite@2.0.0(esbuild@1.0.0))',
      'widget@1.0.0(vite@2.0.0(esbuild@2.0.0))',
    ])
    expect(collectResolveViolations('pnpm-v9', out)).toEqual([])
    // The emitted lock re-emits both nested snapshot keys verbatim.
    expect(out).toContain('widget@1.0.0(vite@2.0.0(esbuild@1.0.0))')
    expect(out).toContain('widget@1.0.0(vite@2.0.0(esbuild@2.0.0))')
  })
})
