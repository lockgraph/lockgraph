import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { newBuilder } from '../../main/ts/graph.ts'
import type { FormatId } from '../../main/ts/api/format-contract.ts'
import {
  DETECTION_ORDER,
  FORMAT_REGISTRY,
  checkFormat,
  detectFormat,
  hasFormatAdapterState,
  parseFormat,
  rebindFormatAdapterState,
  stringifyFormat,
} from '../../main/ts/api/format-registry.ts'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = (file: string): string => readFileSync(
  resolve(here, '../resources/fixtures/lockfiles/simple', file),
  'utf8',
)

const EXPECTED_FORMATS = [
  'bun-text',
  'lockgraph',
  'npm-1',
  'npm-2',
  'npm-3',
  'pnpm-v5',
  'pnpm-v6',
  'pnpm-v9',
  'yarn-berry-v10',
  'yarn-berry-v4',
  'yarn-berry-v5',
  'yarn-berry-v6',
  'yarn-berry-v7',
  'yarn-berry-v8',
  'yarn-berry-v9',
  'yarn-classic',
] as const satisfies readonly FormatId[]

const EXPECTED_DETECTION_ORDER = [
  'lockgraph',
  'bun-text',
  'yarn-berry-v10',
  'yarn-berry-v9',
  'yarn-berry-v8',
  'yarn-berry-v7',
  'yarn-berry-v6',
  'yarn-berry-v5',
  'yarn-berry-v4',
  'pnpm-v9',
  'pnpm-v6',
  'pnpm-v5',
  'yarn-classic',
  'npm-3',
  'npm-2',
  'npm-1',
] as const satisfies readonly FormatId[]

function inputFor(format: FormatId): string {
  if (format === 'lockgraph') return stringifyFormat(format, newBuilder().seal())
  if (format === 'yarn-berry-v10') {
    return fixture('yarn-berry-v9.lock')
      .replace(/(^__metadata:\s*\n\s+version:\s*)9(\s)/m, '$110$2')
  }
  return fixture(`${format}.lock`)
}

describe('typed format registry — inventory and raw dispatch', () => {
  it('is exactly exhaustive over FormatId', () => {
    expect(Object.keys(FORMAT_REGISTRY).sort()).toEqual([...EXPECTED_FORMATS])
  })

  it('pins first-match detection order independently of registry key order', () => {
    expect(DETECTION_ORDER).toEqual(EXPECTED_DETECTION_ORDER)
    expect(new Set(DETECTION_ORDER).size).toBe(DETECTION_ORDER.length)
    expect([...new Set(DETECTION_ORDER)].sort()).toEqual([...EXPECTED_FORMATS])
  })

  it.each(EXPECTED_FORMATS)('maps %s through check / parse / stringify', format => {
    const input = inputFor(format)
    expect(checkFormat(format, input)).toBe(true)
    const graph = parseFormat(format, input)
    const output = stringifyFormat(format, graph)
    expect(checkFormat(format, output)).toBe(true)
  })
})

describe('typed format registry — adapter state dispatch', () => {
  it.each(EXPECTED_FORMATS)('maps %s state capability exhaustively', format => {
    const source = parseFormat(format, inputFor(format))

    expect(hasFormatAdapterState(format, source)).toBe(format !== 'lockgraph')
  })

  it.each(EXPECTED_FORMATS)('reports absent %s state on an unrelated graph', format => {
    expect(hasFormatAdapterState(format, newBuilder().seal())).toBe(false)
  })

  it.each(EXPECTED_FORMATS.filter(format => format !== 'lockgraph'))(
    'transfers %s state onto an identity-preserving graph copy',
    format => {
      const source = parseFormat(format, inputFor(format))
      const target = source.mutate(() => {}).graph
      const rebound = rebindFormatAdapterState(format, source, target)

      expect(rebound.graph).toBe(target)
      expect(rebound.invalidated).toEqual([])
      expect(hasFormatAdapterState(format, rebound.graph)).toBe(true)
    },
  )

  it('shares family state adapters across format aliases', () => {
    const berry = parseFormat('yarn-berry-v8', inputFor('yarn-berry-v8'))
    for (const format of EXPECTED_FORMATS.filter(format => format.startsWith('yarn-berry-'))) {
      expect(hasFormatAdapterState(format, berry)).toBe(true)
    }

    const npmFlat = parseFormat('npm-3', inputFor('npm-3'))
    expect(hasFormatAdapterState('npm-2', npmFlat)).toBe(true)
    expect(hasFormatAdapterState('npm-3', npmFlat)).toBe(true)

    const pnpmFlat = parseFormat('pnpm-v6', inputFor('pnpm-v6'))
    expect(hasFormatAdapterState('pnpm-v6', pnpmFlat)).toBe(true)
    expect(hasFormatAdapterState('pnpm-v9', pnpmFlat)).toBe(true)
  })

  it.each([undefined, 'lockgraph'] as const)('keeps %s rebinding a no-op', format => {
    const source = newBuilder().seal()
    const target = newBuilder().seal()

    expect(rebindFormatAdapterState(format, source, target)).toEqual({
      graph: target,
      invalidated: [],
    })
  })
})

describe('typed format registry — ambiguous-input precedence', () => {
  it('prefers lockgraph over simultaneous yarn-classic and npm-3 probes', () => {
    const input = '@lockgraph 1\n"lockfileVersion": 3\n"packages": {\nfoo@^1:\n  version "1.0.0"\n'
    expect(checkFormat('lockgraph', input)).toBe(true)
    expect(checkFormat('yarn-classic', input)).toBe(true)
    expect(checkFormat('npm-3', input)).toBe(true)
    expect(detectFormat(input)).toBe('lockgraph')
  })

  it('prefers pnpm-v9 over simultaneous yarn-classic and npm-3 probes', () => {
    const input = 'lockfileVersion: \'9.0\'\n"lockfileVersion": 3\n"packages": {\nfoo@^1:\n  version "1.0.0"\n'
    expect(checkFormat('pnpm-v9', input)).toBe(true)
    expect(checkFormat('yarn-classic', input)).toBe(true)
    expect(checkFormat('npm-3', input)).toBe(true)
    expect(detectFormat(input)).toBe('pnpm-v9')
  })

  it('prefers bun-text over a simultaneous yarn-classic probe', () => {
    const input = '{"lockfileVersion":1,"workspaces":{},"packages":{}}\nfoo@^1:\n  version "1.0.0"\n'
    expect(checkFormat('bun-text', input)).toBe(true)
    expect(checkFormat('yarn-classic', input)).toBe(true)
    expect(detectFormat(input)).toBe('bun-text')
  })

  it('keeps unrecognized input undefined', () => {
    expect(detectFormat('this is not a lockfile')).toBeUndefined()
  })
})
