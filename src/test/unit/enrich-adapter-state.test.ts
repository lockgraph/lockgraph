import { describe, expect, it } from 'vitest'
import {
  enrich,
  parse,
  type FormatId,
  type Manifest,
} from '../../main/ts/index.ts'
import { newBuilder, type Graph } from '../../main/ts/graph.ts'
import * as bunText from '../../main/ts/formats/bun-text.ts'
import * as npm1 from '../../main/ts/formats/npm-1.ts'
import * as npm2 from '../../main/ts/formats/npm-2.ts'
import * as npm3 from '../../main/ts/formats/npm-3.ts'
import { rebindAdapterState as rebindNpmFlat } from '../../main/ts/formats/_npm-core.ts'
import { rebindNpm2MirrorState } from '../../main/ts/formats/_npm-2-mirror.ts'
import { rebindFormatAdapterState } from '../../main/ts/api/format-registry.ts'
import * as pnpmV5 from '../../main/ts/formats/pnpm-v5.ts'
import * as pnpmV9 from '../../main/ts/formats/pnpm-v9.ts'
import * as yarnBerryV8 from '../../main/ts/formats/yarn-berry-v8.ts'
import * as yarnClassic from '../../main/ts/formats/yarn-classic.ts'
import { enrichAdapterStateInvalidated } from '../../main/ts/enrich/diagnostics.ts'
import { fixture } from '../helpers/lockfile-test-utils.ts'

const manifests: Record<string, Manifest> = { '': { overrides: [] } }

interface StateCase {
  readonly label: string
  readonly format: FormatId
  readonly fixture: string
  readonly prepare: (graph: Graph) => Graph
  readonly emit: (graph: Graph) => string
}

const cases: readonly StateCase[] = [
  {
    label: 'Yarn Berry',
    format: 'yarn-berry-v8',
    fixture: 'simple/yarn-berry-v8.lock',
    prepare: graph => yarnBerryV8.enrich(graph).graph,
    emit: graph => yarnBerryV8.stringify(graph),
  },
  {
    label: 'Yarn Classic',
    format: 'yarn-classic',
    fixture: 'simple/yarn-classic.lock',
    prepare: graph => yarnClassic.enrich(graph, undefined, { manifests, overrides: [] }).graph,
    emit: graph => yarnClassic.stringify(graph),
  },
  {
    label: 'npm v1',
    format: 'npm-1',
    fixture: 'simple/npm-1.lock',
    prepare: graph => npm1.enrich(graph, { manifests }).graph,
    emit: graph => npm1.stringify(graph),
  },
  {
    label: 'npm flat',
    format: 'npm-3',
    fixture: 'simple/npm-3.lock',
    prepare: graph => npm3.enrich(graph).graph,
    emit: graph => npm3.stringify(graph),
  },
  {
    label: 'npm v2 mirror',
    format: 'npm-2',
    fixture: 'simple/npm-2.lock',
    prepare: graph => npm2.enrich(graph).graph,
    emit: graph => npm2.stringify(graph),
  },
  {
    label: 'pnpm flat',
    format: 'pnpm-v9',
    fixture: 'simple/pnpm-v9.lock',
    prepare: graph => pnpmV9.enrich(graph, { manifests }).graph,
    emit: graph => pnpmV9.stringify(graph),
  },
  {
    label: 'pnpm v5',
    format: 'pnpm-v5',
    fixture: 'simple/pnpm-v5.lock',
    prepare: graph => pnpmV5.enrich(graph, { manifests }).graph,
    emit: graph => pnpmV5.stringify(graph),
  },
  {
    label: 'Bun',
    format: 'bun-text',
    fixture: 'simple/bun-text.lock',
    prepare: graph => bunText.enrich(graph, { manifests }).graph,
    emit: graph => bunText.stringify(graph),
  },
]

describe('enrich adapter-state derivation', () => {
  for (const stateCase of cases) {
    it(`preserves ${stateCase.label} state across the full facade`, async () => {
      const input = parse(stateCase.format, fixture(stateCase.fixture))
      const expected = stateCase.emit(stateCase.prepare(input))
      const result = await enrich(input, { manifests }, {
        target: { format: stateCase.format },
        contract: 'snapshot',
      })

      expect(stateCase.emit(result.graph)).toBe(expected)
    })

    it(`prunes and reports invalidated ${stateCase.label} state`, () => {
      const source = parse(stateCase.format, fixture(stateCase.fixture))
      const rebound = rebindFormatAdapterState(
        stateCase.format,
        source,
        newBuilder().seal(),
      )

      expect(rebound.invalidated.length).toBeGreaterThan(0)
      expect(rebound.invalidated).toEqual([...rebound.invalidated].sort())
      expect(enrichAdapterStateInvalidated(stateCase.format, rebound.invalidated)).toMatchObject({
        code: 'ENRICH_ADAPTER_STATE_INVALIDATED',
        severity: 'warning',
        data: { format: stateCase.format, subjects: rebound.invalidated },
      })
    })
  }

  it('composes npm v2 flat and mirror invalidations in sorted unique order', () => {
    const source = parse('npm-2', fixture('simple/npm-2.lock'))
    const expectedFlat = rebindNpmFlat(source, newBuilder().seal())
    const expected = [...new Set([
      ...expectedFlat.invalidated,
      ...rebindNpm2MirrorState(source, expectedFlat.graph),
    ])].sort()
    const target = newBuilder().seal()
    const actual = rebindFormatAdapterState('npm-2', source, target)

    expect(actual.graph).toBe(target)
    expect(actual.invalidated).toEqual(expected)
    expect(actual.invalidated).toEqual([...new Set(actual.invalidated)].sort())
  })
})
