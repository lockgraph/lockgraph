import { execFileSync, spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const generator = resolve('src/test/resources/fixtures/_gen.mjs')

function plan (args: string[]) {
  return JSON.parse(execFileSync(process.execPath, [generator, '--plan', ...args], {
    encoding: 'utf8',
  })) as {
    expected: number
    cells: Array<{ case: string, adapter: string }>
  }
}

describe('fixture generator selection', () => {
  it('accepts exact case names and case globs', () => {
    const result = plan(['--cases', 'simple', 'peers-*'])

    expect(result.expected).toBe(39)
    expect(new Set(result.cells.map(cell => cell.case))).toEqual(new Set([
      'peers-basic',
      'peers-multi',
      'simple',
    ]))
  })

  it('accepts an explicit adapter list across applicable cases', () => {
    const result = plan(['--adapters', 'pnpm-v9,yarn-berry-v9'])

    expect(result.expected).toBe(15)
    expect(result.cells.every(cell => ['pnpm-v9', 'yarn-berry-v9'].includes(cell.adapter))).toBe(true)
    expect(result.cells).toContainEqual({ case: 'patch-yarn', adapter: 'yarn-berry-v9' })
    expect(result.cells).not.toContainEqual({ case: 'patch-yarn', adapter: 'pnpm-v9' })
  })

  it('intersects case and adapter selectors', () => {
    const result = plan(['--cases', 'workspace*', '--adapters', 'pnpm-v9'])

    expect(result.cells).toEqual([
      { case: 'workspace-cross-refs', adapter: 'pnpm-v9' },
      { case: 'workspaces-basic', adapter: 'pnpm-v9' },
    ])
  })

  it('preserves positional case selection', () => {
    expect(plan(['patch-yarn']).cells).toEqual([
      { case: 'patch-yarn', adapter: 'yarn-berry-v9' },
    ])
  })

  it.each([
    { args: [], message: 'fixture selection is required' },
    { args: ['--cases', 'missing-*'], message: 'case selector matched nothing: missing-*' },
    { args: ['--adapters', 'npm-missing'], message: 'unknown adapter id: npm-missing' },
    { args: ['--cases', 'patch-yarn', '--adapters', 'npm-1'], message: 'selection produced no fixture cells' },
  ])('rejects invalid selection: $message', ({ args, message }) => {
    const result = spawnSync(process.execPath, [generator, '--plan', ...args], { encoding: 'utf8' })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain(message)
  })
})
