#!/usr/bin/env node
// Generate canonical lockfile fixtures by running each PM against each case.
// See spec/08-test-bench.md for the protocol; outputs land in lockfiles/.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE          = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT  = path.resolve(HERE, '../../../..')
const TEMPLATES_DIR = path.join(HERE, 'templates')
const LOCKFILES_DIR = path.join(HERE, 'lockfiles')

// (adapter-id) → canonical writer config. Mirrors spec/08-test-bench.md.
const ADAPTERS = [
  { id: 'npm-1',         alias: 'pm-npm-6',   bin: 'npm',  runtime: 'node',
    args: ['install', '--no-audit', '--package-lock-only'], lockfile: 'package-lock.json' },
  { id: 'npm-2',         alias: 'pm-npm-7',   bin: 'npm',  runtime: 'node',
    args: ['install', '--no-audit', '--package-lock-only'], lockfile: 'package-lock.json' },
  { id: 'npm-3',         alias: 'pm-npm-9',   bin: 'npm',  runtime: 'node',
    args: ['install', '--no-audit', '--package-lock-only'], lockfile: 'package-lock.json' },
  { id: 'yarn-classic',  alias: 'pm-yarn-1',  bin: 'yarn', runtime: 'node',
    args: ['install', '--no-progress', '--ignore-scripts'], lockfile: 'yarn.lock' },
  { id: 'yarn-berry-v4', alias: 'pm-yarn-2',  bin: 'yarn', runtime: 'node',
    args: ['install'], lockfile: 'yarn.lock',
    setup: { '.yarnrc.yml': 'enableImmutableInstalls: false\nnodeLinker: node-modules\n' } },
  { id: 'pnpm-v5',       alias: 'pm-pnpm-7',  bin: 'pnpm', runtime: 'node',
    args: ['install', '--lockfile-only'], lockfile: 'pnpm-lock.yaml' },
  { id: 'pnpm-v6',       alias: 'pm-pnpm-8',  bin: 'pnpm', runtime: 'node',
    args: ['install', '--lockfile-only'], lockfile: 'pnpm-lock.yaml' },
  { id: 'pnpm-v9',       alias: 'pm-pnpm-10', bin: 'pnpm', runtime: 'node',
    args: ['install', '--lockfile-only'], lockfile: 'pnpm-lock.yaml' },
  { id: 'bun-text',      alias: 'bun',        bin: 'bun',  runtime: 'native',
    args: ['install', '--lockfile-only'], lockfile: 'bun.lock' },
]

function resolveBinPath (alias, binName) {
  const pkgRoot = path.resolve(PROJECT_ROOT, 'node_modules', alias)
  const pkg = JSON.parse(fs.readFileSync(path.resolve(pkgRoot, 'package.json'), 'utf-8'))
  const bin = pkg.bin
  if (typeof bin === 'string') return path.resolve(pkgRoot, bin)
  if (bin && typeof bin === 'object' && bin[binName]) return path.resolve(pkgRoot, bin[binName])
  throw new Error(`bin '${binName}' not found in ${alias} (bin field: ${JSON.stringify(bin)})`)
}

function copyDir (src, dst) {
  fs.cpSync(src, dst, { recursive: true })
}

function listCases () {
  return fs.readdirSync(TEMPLATES_DIR).filter(name => {
    const dir = path.join(TEMPLATES_DIR, name)
    return fs.statSync(dir).isDirectory() && fs.existsSync(path.join(dir, 'package.json'))
  }).sort()
}

function runOne (caseName, adapter) {
  if (adapter.skip) return { ok: false, skipped: true, reason: adapter.skip }
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `lockfile-fixture-${caseName}-${adapter.id}-`))
  try {
    copyDir(path.join(TEMPLATES_DIR, caseName), tempRoot)
    if (adapter.setup) {
      for (const [name, content] of Object.entries(adapter.setup)) {
        fs.writeFileSync(path.join(tempRoot, name), content)
      }
    }

    const binPath = resolveBinPath(adapter.alias, adapter.bin)
    const [cmd, args] = adapter.runtime === 'native'
      ? [binPath, adapter.args]
      : [process.execPath, [binPath, ...adapter.args]]

    execFileSync(cmd, args, {
      cwd: tempRoot,
      timeout: 180_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const produced = path.join(tempRoot, adapter.lockfile)
    if (!fs.existsSync(produced)) {
      throw new Error(`lockfile ${adapter.lockfile} not produced`)
    }

    const outDir = path.join(LOCKFILES_DIR, caseName)
    fs.mkdirSync(outDir, { recursive: true })
    fs.copyFileSync(produced, path.join(outDir, `${adapter.id}.lock`))
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err.message?.split('\n')[0] || String(err), stderr: err.stderr?.toString().slice(-500) }
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
}

function main () {
  const filter = process.argv.slice(2)
  const cases = listCases().filter(c => filter.length === 0 || filter.includes(c))
  const report = []

  for (const caseName of cases) {
    for (const adapter of ADAPTERS) {
      const start = Date.now()
      process.stdout.write(`[${caseName}] ${adapter.id} ... `)
      const result = runOne(caseName, adapter)
      const ms = Date.now() - start
      if (result.ok) {
        process.stdout.write(`ok (${ms}ms)\n`)
      } else if (result.skipped) {
        process.stdout.write(`SKIP — ${result.reason}\n`)
      } else {
        process.stdout.write(`FAIL (${ms}ms): ${result.error}\n`)
      }
      report.push({ case: caseName, adapter: adapter.id, ms, ...result })
    }
  }

  const ok      = report.filter(r => r.ok).length
  const skipped = report.filter(r => r.skipped).length
  const fail    = report.length - ok - skipped
  console.log(`\n${ok}/${report.length} ok, ${skipped} skipped, ${fail} failed`)
  fs.writeFileSync(path.join(HERE, '_report.json'), JSON.stringify(report, null, 2))
  process.exit(fail === 0 ? 0 : 1)
}

main()
