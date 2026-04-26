import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

interface PmEntry {
  alias: string
  binName: string
  expectedPrefix: string
  runtime: 'node' | 'native'
}

const MATRIX: PmEntry[] = [
  { alias: 'pm-npm-6',   binName: 'npm',  expectedPrefix: '6.',   runtime: 'node' },
  { alias: 'pm-npm-7',   binName: 'npm',  expectedPrefix: '7.',   runtime: 'node' },
  { alias: 'pm-npm-8',   binName: 'npm',  expectedPrefix: '8.',   runtime: 'node' },
  { alias: 'pm-npm-9',   binName: 'npm',  expectedPrefix: '9.',   runtime: 'node' },
  { alias: 'pm-npm-10',  binName: 'npm',  expectedPrefix: '10.',  runtime: 'node' },
  { alias: 'pm-npm-11',  binName: 'npm',  expectedPrefix: '11.',  runtime: 'node' },
  { alias: 'pm-yarn-1',  binName: 'yarn', expectedPrefix: '1.',   runtime: 'node' },
  { alias: 'pm-yarn-2',  binName: 'yarn', expectedPrefix: '2.',   runtime: 'node' },
  { alias: 'pm-pnpm-6',  binName: 'pnpm', expectedPrefix: '6.',   runtime: 'node' },
  { alias: 'pm-pnpm-7',  binName: 'pnpm', expectedPrefix: '7.',   runtime: 'node' },
  { alias: 'pm-pnpm-8',  binName: 'pnpm', expectedPrefix: '8.',   runtime: 'node' },
  { alias: 'pm-pnpm-9',  binName: 'pnpm', expectedPrefix: '9.',   runtime: 'node' },
  { alias: 'pm-pnpm-10', binName: 'pnpm', expectedPrefix: '10.',  runtime: 'node' },
  { alias: 'bun',        binName: 'bun',  expectedPrefix: '1.2.', runtime: 'native' },
]

// `require.resolve('<alias>/package.json')` fails on packages that gate
// `./package.json` behind their `exports` field (pnpm 8+).
function resolveBinPath(alias: string, binName: string): string {
  const pkgRoot = path.resolve(process.cwd(), 'node_modules', alias)
  const pkg = JSON.parse(fs.readFileSync(path.resolve(pkgRoot, 'package.json'), 'utf-8'))
  const bin = pkg.bin
  if (typeof bin === 'string') return path.resolve(pkgRoot, bin)
  if (bin && typeof bin === 'object' && bin[binName]) return path.resolve(pkgRoot, bin[binName])
  throw new Error(`bin '${binName}' not found in ${alias} (bin field: ${JSON.stringify(bin)})`)
}

function getVersion(entry: PmEntry): string {
  const binPath = resolveBinPath(entry.alias, entry.binName)
  const [cmd, args] = entry.runtime === 'native'
    ? [binPath, ['--version']]
    : [process.execPath, [binPath, '--version']]
  // pnpm 9+ refuses to run when the surrounding `packageManager` field
  // names a different PM, so we run PMs from a tmpdir.
  return execFileSync(cmd, args, {
    encoding: 'utf-8',
    timeout: 30_000,
    cwd: os.tmpdir(),
  }).trim()
}

describe('infra: every PM binary in the matrix is reachable and prints its pinned version', () => {
  for (const entry of MATRIX) {
    it(`${entry.alias} → ${entry.binName} --version starts with "${entry.expectedPrefix}"`, () => {
      const version = getVersion(entry)
      expect(version, `${entry.alias} returned ${JSON.stringify(version)}`)
        .toMatch(new RegExp(`^${entry.expectedPrefix.replace(/\./g, '\\.')}`))
    })
  }
})
