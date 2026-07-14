import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import semver from 'semver'

interface PmEntry {
  alias: string
  binName: string
  expectedVersion: string
  runtime: 'node' | 'native'
  // Node engine range the PM binary itself needs to run. When the running Node
  // does not satisfy it, the binary errors, so the check is skipped.
  nodeRange?: string
}

const MATRIX: PmEntry[] = [
  {
    alias: 'pm-npm-6', binName: 'npm', expectedVersion: '6.14.18', runtime: 'node',
    nodeRange: '6 >=6.2.0 || 8 || >=9.3.0',
  },
  {
    alias: 'pm-npm-7', binName: 'npm', expectedVersion: '7.24.2', runtime: 'node',
    nodeRange: '>=10',
  },
  {
    alias: 'pm-npm-8', binName: 'npm', expectedVersion: '8.19.4', runtime: 'node',
    nodeRange: '^12.13.0 || ^14.15.0 || >=16.0.0',
  },
  {
    alias: 'pm-npm-9', binName: 'npm', expectedVersion: '9.9.4', runtime: 'node',
    nodeRange: '^14.17.0 || ^16.13.0 || >=18.0.0',
  },
  {
    alias: 'pm-npm-10', binName: 'npm', expectedVersion: '10.9.8', runtime: 'node',
    nodeRange: '^18.17.0 || >=20.5.0',
  },
  {
    alias: 'pm-npm-11', binName: 'npm', expectedVersion: '11.18.0', runtime: 'node',
    nodeRange: '^20.17.0 || >=22.9.0',
  },
  {
    alias: 'pm-npm-12', binName: 'npm', expectedVersion: '12.0.1', runtime: 'node',
    nodeRange: '^22.22.2 || ^24.15.0 || >=26.0.0',
  },
  {
    alias: 'pm-yarn-1', binName: 'yarn', expectedVersion: '1.22.22', runtime: 'node',
    nodeRange: '>=4.0.0',
  },
  {
    alias: 'pm-yarn-2', binName: 'yarn', expectedVersion: '2.4.3', runtime: 'node',
    nodeRange: '>=10',
  },
  {
    alias: 'pm-yarn-berry-v5', binName: 'yarn', expectedVersion: '3.1.1', runtime: 'node',
    nodeRange: '>=12 <14 || 14.2 - 14.9 || >14.10.0',
  },
  {
    alias: 'pm-yarn-berry-v6', binName: 'yarn', expectedVersion: '3.8.7', runtime: 'node',
    nodeRange: '>=12 <14 || 14.2 - 14.9 || >14.10.0',
  },
  {
    alias: 'pm-yarn-berry-v7', binName: 'yarn', expectedVersion: '4.0.0-rc.46', runtime: 'node',
    nodeRange: '>=14.15.0',
  },
  {
    alias: 'pm-yarn-berry-v8', binName: 'yarn', expectedVersion: '4.13.0', runtime: 'node',
    nodeRange: '>=18.12.0',
  },
  {
    alias: 'pm-yarn-berry-v9', binName: 'yarn', expectedVersion: '4.14.1', runtime: 'node',
    nodeRange: '>=18.12.0',
  },
  {
    alias: 'pm-pnpm-6', binName: 'pnpm', expectedVersion: '6.35.1', runtime: 'node',
    nodeRange: '>=12.17',
  },
  {
    alias: 'pm-pnpm-7', binName: 'pnpm', expectedVersion: '7.33.7', runtime: 'node',
    nodeRange: '>=14.6',
  },
  {
    alias: 'pm-pnpm-8', binName: 'pnpm', expectedVersion: '8.15.9', runtime: 'node',
    nodeRange: '>=16.14',
  },
  {
    alias: 'pm-pnpm-9', binName: 'pnpm', expectedVersion: '9.15.9', runtime: 'node',
    nodeRange: '>=18.12',
  },
  {
    alias: 'pm-pnpm-10', binName: 'pnpm', expectedVersion: '10.34.5', runtime: 'node',
    nodeRange: '>=18.12',
  },
  { alias: 'bun', binName: 'bun', expectedVersion: '1.3.14', runtime: 'native' },
]

interface PmPackage {
  readonly version?: string
  readonly engines?: Readonly<{ node?: string }>
  readonly bin?: string | Readonly<Record<string, string>>
}

function readPmPackage(alias: string): PmPackage {
  const pkgRoot = path.resolve(process.cwd(), 'node_modules', alias)
  return JSON.parse(fs.readFileSync(path.resolve(pkgRoot, 'package.json'), 'utf-8')) as PmPackage
}

// `require.resolve('<alias>/package.json')` fails on packages that gate
// `./package.json` behind their `exports` field (pnpm 8+).
function resolveBinPath(alias: string, binName: string): string {
  const pkgRoot = path.resolve(process.cwd(), 'node_modules', alias)
  const pkg = readPmPackage(alias)
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
    it(`${entry.alias} package metadata matches its calibrated identity`, () => {
      const pkg = readPmPackage(entry.alias)
      expect(pkg.version).toBe(entry.expectedVersion)
      if (entry.nodeRange !== undefined) expect(pkg.engines?.node).toBe(entry.nodeRange)
    })

    // Skip a PM whose own Node engine range the current runtime does not meet.
    const run = entry.nodeRange !== undefined && !semver.satisfies(process.versions.node, entry.nodeRange)
      ? it.skip
      : it
    run(`${entry.alias} → ${entry.binName} --version is exactly "${entry.expectedVersion}"`, () => {
      const version = getVersion(entry)
      expect(version, `${entry.alias} returned ${JSON.stringify(version)}`)
        .toBe(entry.expectedVersion)
    })
  }
})
