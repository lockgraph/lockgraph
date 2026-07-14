import { describe, expect, it } from 'vitest'
import type { Diagnostic } from '../../../main/ts/graph.ts'
import { ALL_FORMATS, loadRealWorldFixtures, probeConversion } from './_probe.ts'

const fixtures = loadRealWorldFixtures()

describe('interop: real-world cross-family probe', () => {
  it('discovers committed real-world fixtures', () => {
    expect(fixtures.length).toBeGreaterThan(0)
  })

  for (const fixture of fixtures) {
    describe(`${fixture.repoHandle}/${fixture.fileName} (${fixture.sourceFormat})`, () => {
      const targets = ALL_FORMATS.filter(format => format !== fixture.sourceFormat)

      it('covers every other adapter format id', () => {
        expect(targets).toHaveLength(ALL_FORMATS.length - 1)
      })

      for (const target of targets) {
        it(`probes ${fixture.sourceFormat} -> ${target}`, () => {
          const result = probeConversion(fixture, target)

          if (result.outcome === 'success') {
            assertDiagnosticArray(result.diagnostics)
            expect(result.summary.total).toBe(result.diagnostics.length)
            expect(result.summary.recipe).toBeGreaterThanOrEqual(0)
            expect(result.summary.interop).toBeGreaterThanOrEqual(0)
            expect(result.summary.adapter).toBeGreaterThanOrEqual(0)
          } else {
            expect(result.phase).toMatch(/convert|target-check|target-parse/)
            expect(result.error.name.length).toBeGreaterThan(0)
            expect(result.error.message.length).toBeGreaterThan(0)
            if (result.error.code !== undefined) {
              expect(result.error.code.length).toBeGreaterThan(0)
            }
          }
        }, 30_000)
      }
    })
  }
})

function assertDiagnosticArray(diagnostics: readonly Diagnostic[]): void {
  expect(Array.isArray(diagnostics)).toBe(true)

  for (const diagnostic of diagnostics) {
    expect(typeof diagnostic.code).toBe('string')
    expect(diagnostic.code.length).toBeGreaterThan(0)
    expect(['info', 'warning', 'error']).toContain(diagnostic.severity)
    expect(typeof diagnostic.message).toBe('string')
    expect(diagnostic.message.length).toBeGreaterThan(0)
    if (diagnostic.subject !== undefined) {
      expect(typeof diagnostic.subject === 'string' || typeof diagnostic.subject === 'object').toBe(true)
    }
  }
}
