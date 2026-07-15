import { describe, expect, it } from 'vitest'
import {
  LockfileError,
  enrich,
  parse,
  stringify,
  type FormatId,
} from '../../main/ts/index.ts'
import { fixture } from '../helpers/lockfile-test-utils.ts'

function harmlessMutation(format: FormatId, input: string) {
  return parse(format, input).mutate(mutator => {
    mutator.diagnostic({
      code: 'TEST_MUTATION',
      severity: 'info',
      message: 'mutation with no canonical graph delta',
    })
  }).graph
}

function strictError(format: FormatId, input: string): LockfileError {
  try {
    stringify(format, harmlessMutation(format, input))
  } catch (error) {
    expect(error).toBeInstanceOf(LockfileError)
    return error as LockfileError
  }
  throw new Error(`expected ${format} mutation to fail closed`)
}

const PNPM_V9 =
  `lockfileVersion: '9.0'\n\n` +
  `settings:\n  autoInstallPeers: false\n  dedupePeers: true\n  excludeLinksFromLockfile: false\n\n` +
  `overrides:\n  left-pad: 1.3.0\n\n` +
  `packageExtensionsChecksum: sha256-a=\n\n` +
  `pnpmfileChecksum: sha256-b=\n\n` +
  `importers:\n\n  .: {}\n\npackages: {}\n\nsnapshots: {}\n`

const PNPM_V5 =
  `lockfileVersion: 5.4\n\n` +
  `overrides:\n  left-pad: 1.3.0\n\n` +
  `specifiers: {}\n\npackages: {}\n`

const BUN = JSON.stringify({
  lockfileVersion: 1,
  workspaces: { '': { name: 'root', dependencies: { lodash: '^4.17.20' } } },
  overrides: { lodash: '4.17.21' },
  trustedDependencies: ['esbuild'],
  patchedDependencies: { 'lodash@4.17.21': 'patches/lodash.patch' },
  packages: {
    lodash: ['lodash@4.17.21', '', {}, 'sha512-YQ=='],
  },
}, null, 2)

describe('strict mutation sidecar containment', () => {
  it.each([
    ['pnpm-v9', PNPM_V9],
    ['pnpm-v5', PNPM_V5],
    ['bun-text', BUN],
  ] as const)('%s rejects a public mutation after native replay state is detached', (format, input) => {
    const error = strictError(format, input)
    expect(error.code).toBe('IRREDUCIBLE_LOSS')
    expect(error.losses?.some(loss => loss.feature === 'adapter-state')).toBe(true)
    expect(error.message).toContain('adapter state')
  })

  it('covers every non-propagating public adapter, not only the three carrier repros', () => {
    const fixtures: Array<[FormatId, string]> = [
      ['npm-1', fixture('simple/npm-1.lock')],
      ['npm-2', fixture('simple/npm-2.lock')],
      ['npm-3', fixture('simple/npm-3.lock')],
      ['pnpm-v5', fixture('simple/pnpm-v5.lock')],
      ['pnpm-v6', fixture('simple/pnpm-v6.lock')],
      ['pnpm-v9', fixture('simple/pnpm-v9.lock')],
      ['bun-text', fixture('simple/bun-text.lock')],
    ]
    for (const [format, input] of fixtures) {
      const error = strictError(format, input)
      expect(error.losses?.some(loss => loss.feature === 'adapter-state')).toBe(true)
    }
  })

  it('leaves parse → stringify untouched and preserves all demonstrated carriers', () => {
    const pnpmV9 = stringify('pnpm-v9', parse('pnpm-v9', PNPM_V9))
    expect(pnpmV9).toContain('dedupePeers: true')
    expect(pnpmV9).toContain('packageExtensionsChecksum: sha256-a=')
    expect(pnpmV9).toContain('pnpmfileChecksum: sha256-b=')
    expect(pnpmV9).toContain('overrides:')

    expect(stringify('pnpm-v5', parse('pnpm-v5', PNPM_V5))).toContain('overrides:')
    const bun = stringify('bun-text', parse('bun-text', BUN))
    expect(bun).toContain('"overrides"')
    expect(bun).toContain('"trustedDependencies"')
    expect(bun).toContain('"patchedDependencies"')
  })

  it('keeps strict:false as an explicit, diagnosed loss escape hatch', () => {
    const diagnostics: string[] = []
    const output = stringify('pnpm-v9', harmlessMutation('pnpm-v9', PNPM_V9), {
      strict: false,
      onDiagnostic: diagnostic => diagnostics.push(diagnostic.code),
    })
    expect(output).not.toContain('dedupePeers: true')
    expect(output).not.toContain('packageExtensionsChecksum')
    expect(output).not.toContain('pnpmfileChecksum')
    expect(output).not.toContain('overrides:')
    expect(diagnostics).toContain('COMPLETENESS_ADAPTER_STATE_LOST')
    expect(diagnostics).toContain('PROJECTION_LOSS')
  })

  it('accepts the enrich facade after it explicitly rebinds adapter state', async () => {
    const graph = parse('pnpm-v9', PNPM_V9)
    const enriched = await enrich(graph, {
      config: {
        kind: 'pm-config',
        manager: 'pnpm',
        version: '10.0.0',
        source: 'pnpm-workspace.yaml',
        surface: 'overrides',
        coverage: 'complete',
        overrides: [],
      },
    }, {
      target: { format: 'pnpm-v9' },
      contract: 'snapshot',
    })
    expect(() => stringify('pnpm-v9', enriched.graph)).not.toThrow()
    expect(stringify('pnpm-v9', enriched.graph)).toContain('dedupePeers: true')
  })

  it('does not penalize Yarn adapters whose graph wrappers propagate sidecars', () => {
    for (const format of ['yarn-classic', 'yarn-berry-v9'] as const) {
      const input = fixture(`simple/${format}.lock`)
      const mutated = harmlessMutation(format, input)
      expect(() => stringify(format, mutated)).not.toThrow()
    }
  })
})
