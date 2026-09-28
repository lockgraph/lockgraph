import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  parse,
  stringify,
} from '../../main/ts/index.ts'
import type { Diagnostic } from '../../main/ts/graph.ts'
import type { DenoFormatId } from '../../main/ts/api/format-contract.ts'

interface DenoOracle {
  readonly lockVersion: '3' | '4' | '5'
  readonly denoVersion: '1.44.4' | '2.2.8' | '2.9.6'
  readonly fixture: string
  readonly importRange: string
  readonly tamperedExit: number
  readonly command: readonly string[]
}

const oracles: readonly DenoOracle[] = [
  {
    lockVersion: '3',
    denoVersion: '1.44.4',
    fixture: 'deno-v3.lock',
    importRange: '19.1.1',
    tamperedExit: 10,
    command: ['cache', '--lock=deno.lock', 'main.ts'],
  },
  {
    lockVersion: '4',
    denoVersion: '2.2.8',
    fixture: 'deno-v4.lock',
    importRange: '19.1.1',
    tamperedExit: 10,
    command: ['install', '--frozen', '--entrypoint', 'main.ts'],
  },
  {
    lockVersion: '5',
    denoVersion: '2.9.6',
    fixture: 'deno.lock',
    importRange: '^19.1.0',
    tamperedExit: 1,
    command: ['install', '--frozen', '--entrypoint', 'main.ts'],
  },
]

const fixtureRoot = resolve('src/test/resources/fixtures/lockfiles/simple')

function tamperNpmIntegrity(lockfile: string): string {
  const tampered = lockfile.replace(
    /"integrity": "sha512-([A-Za-z0-9+/])/,
    (_match, first: string) => `"integrity": "sha512-${first === 'A' ? 'B' : 'A'}`,
  )
  if (tampered === lockfile) throw new Error('Deno oracle fixture has no npm SHA-512 integrity')
  return tampered
}

function runOracle(
  oracle: DenoOracle,
  lockfile: string,
  leg: 'clean' | 'tampered' | 'restored',
  importRange = oracle.importRange,
  includeJsr = true,
): {
  readonly status: number | null
  readonly output: string
  readonly resultingLockfile: string
} {
  const projectRoot = mkdtempSync(resolve(tmpdir(), `lockgraph-deno-v${oracle.lockVersion}-${leg}-`))
  const binary = resolve(`tmp/deno-oracle/${oracle.denoVersion}/deno`)
  try {
    writeFileSync(
      resolve(projectRoot, 'deno.json'),
      `${JSON.stringify({
        imports: {
          ...(includeJsr ? { '@std/assert': 'jsr:@std/assert@1.0.19' } : {}),
          'react-dom': `npm:react-dom@${importRange}`,
        },
      }, null, 2)}\n`,
    )
    writeFileSync(
      resolve(projectRoot, 'main.ts'),
      includeJsr
        ? "import { assert } from '@std/assert'\nimport { renderToString } from 'react-dom/server'\nassert(renderToString('oracle') === 'oracle')\n"
        : "import { renderToString } from 'react-dom/server'\nif (renderToString('oracle') !== 'oracle') throw new Error('render mismatch')\n",
    )
    writeFileSync(resolve(projectRoot, 'deno.lock'), lockfile)

    const result = spawnSync(binary, [...oracle.command], {
      cwd: projectRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        DENO_DIR: resolve(projectRoot, '.deno-cache'),
        DENO_NO_PROMPT: '1',
        DENO_NO_UPDATE_CHECK: '1',
        NO_COLOR: '1',
      },
      maxBuffer: 4 * 1024 * 1024,
      timeout: 180_000,
    })

    return {
      status: result.status,
      output: `${result.stdout}${result.stderr}`,
      resultingLockfile: readFileSync(resolve(projectRoot, 'deno.lock'), 'utf8'),
    }
  } finally {
    rmSync(projectRoot, { force: true, recursive: true })
  }
}

describe('infra: pinned Deno native frozen oracles', () => {
  for (const oracle of oracles) {
    const binary = resolve(`tmp/deno-oracle/${oracle.denoVersion}/deno`)
    const available = existsSync(binary)
    const runnable = available ? it : it.skip
    runnable(
      `Deno ${oracle.denoVersion} certifies v${oracle.lockVersion} clean/tampered/restored byte identity`
        + (available ? '' : ` [skip: pinned binary ${oracle.denoVersion} is absent]`),
      () => {
        const lockfile = readFileSync(resolve(fixtureRoot, oracle.fixture), 'utf8')

        const clean = runOracle(oracle, lockfile, 'clean')
        expect(clean.status, clean.output).toBe(0)
        expect(clean.resultingLockfile).toBe(lockfile)

        const tampered = runOracle(oracle, tamperNpmIntegrity(lockfile), 'tampered')
        expect(tampered.status, tampered.output).toBe(oracle.tamperedExit)
        expect(tampered.output).toMatch(/cache|checksum|integrity|lock|mismatch/i)

        const restored = runOracle(oracle, lockfile, 'restored')
        expect(restored.status, restored.output).toBe(0)
        expect(restored.resultingLockfile).toBe(lockfile)
      },
      600_000,
    )
  }

  const supportedCrossVersionPairs = [
    ['deno-v2', 'deno-v3'],
    ['deno-v4', 'deno-v3'],
    ['deno-v5', 'deno-v3'],
    ['deno-v2', 'deno-v4'],
    ['deno-v3', 'deno-v4'],
    ['deno-v5', 'deno-v4'],
  ] as const satisfies readonly (readonly [DenoFormatId, DenoFormatId])[]

  for (const [from, to] of supportedCrossVersionPairs) {
    const targetVersion = to.slice(-1) as DenoOracle['lockVersion']
    const oracle = oracles.find(candidate => candidate.lockVersion === targetVersion)!
    const binary = resolve(`tmp/deno-oracle/${oracle.denoVersion}/deno`)
    const available = existsSync(binary)
    const runnable = available ? it : it.skip
    runnable(
      `${from} -> ${to} passes target Deno ${oracle.denoVersion} cold-cache frozen acceptance`
        + (available ? '' : ` [skip: pinned binary ${oracle.denoVersion} is absent]`),
      () => {
        const sourceVersion = from.slice(-1)
        const sourceFixture = sourceVersion === '5'
          ? 'deno.lock'
          : `deno-v${sourceVersion}.lock`
        const source = readFileSync(resolve(fixtureRoot, sourceFixture), 'utf8')
        const sourceRange = from === 'deno-v5' ? '^19.1.0' : '19.1.1'
        const graph = parse(from, source, {
          manifests: {
            '': {
              name: 'case-deno',
              version: '1.0.0',
              dependencies: { 'react-dom': sourceRange },
            },
          },
        })
        const diagnostics: Diagnostic[] = []
        const converted = stringify(to, graph, {
          strict: false,
          onDiagnostic: diagnostic => diagnostics.push(diagnostic),
        })
        expect(JSON.parse(converted).version).toBe(targetVersion)
        expect(diagnostics.map(diagnostic => diagnostic.code))
          .not.toContain('COMPLETENESS_ADAPTER_STATE_LOST')

        const includeJsr = from !== 'deno-v2'
        const clean = runOracle(oracle, converted, 'clean', sourceRange, includeJsr)
        expect(clean.status, clean.output).toBe(0)
        expect(clean.resultingLockfile).toBe(converted)

        const tampered = runOracle(
          oracle,
          tamperNpmIntegrity(converted),
          'tampered',
          sourceRange,
          includeJsr,
        )
        expect(tampered.status, tampered.output).toBe(oracle.tamperedExit)
        expect(tampered.output).toMatch(/cache|checksum|integrity|lock|mismatch/i)

        const restored = runOracle(oracle, converted, 'restored', sourceRange, includeJsr)
        expect(restored.status, restored.output).toBe(0)
        expect(restored.resultingLockfile).toBe(converted)
        expect(stringify(to, parse(to, restored.resultingLockfile))).toBe(converted)
      },
      600_000,
    )
  }

  it('labels every target-v2 cell as parse/emit-only while preserving byte identity', () => {
    for (const from of ['deno-v3', 'deno-v4', 'deno-v5'] as const) {
      const source = readFileSync(
        resolve(fixtureRoot, from === 'deno-v5' ? 'deno.lock' : `${from}.lock`),
        'utf8',
      )
      const output = stringify('deno-v2', parse(from, source), { strict: false })
      expect(JSON.parse(output).version).toBe('2')
      expect(stringify('deno-v2', parse('deno-v2', output))).toBe(output)
    }
  })
})
