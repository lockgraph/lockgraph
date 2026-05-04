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
const YARN_BIN_DIR  = path.resolve(PROJECT_ROOT, '.cache/yarn-bin')

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
  // ADR-0005 / C2: yarn 3+/4+ producers via downloaded .cjs (gitignored .cache/yarn-bin/).
  { id: 'yarn-berry-v5', yarnBundle: '3.1.0',  runtime: 'yarn-bundle',
    args: ['install'], lockfile: 'yarn.lock',
    setup: { '.yarnrc.yml': 'enableImmutableInstalls: false\nnodeLinker: node-modules\n' } },
  { id: 'yarn-berry-v6', yarnBundle: '3.6.4',  runtime: 'yarn-bundle',
    args: ['install'], lockfile: 'yarn.lock',
    setup: { '.yarnrc.yml': 'enableImmutableInstalls: false\nnodeLinker: node-modules\n' } },
  { id: 'yarn-berry-v8', yarnBundle: '4.13.0', runtime: 'yarn-bundle',
    args: ['install', '--mode=update-lockfile'], lockfile: 'yarn.lock',
    setup: { '.yarnrc.yml': 'enableImmutableInstalls: false\nnodeLinker: node-modules\n' } },
  { id: 'yarn-berry-v9', yarnBundle: '4.14.1', runtime: 'yarn-bundle',
    args: ['install', '--mode=update-lockfile'], lockfile: 'yarn.lock',
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

// Download a yarn .cjs into .cache/yarn-bin/yarn-<version>.cjs if not already present.
async function ensureYarnBundle (version) {
  fs.mkdirSync(YARN_BIN_DIR, { recursive: true })
  const dst = path.join(YARN_BIN_DIR, `yarn-${version}.cjs`)
  if (fs.existsSync(dst) && fs.statSync(dst).size > 0) return dst
  const url = `https://repo.yarnpkg.com/${version}/packages/yarnpkg-cli/bin/yarn.js`
  process.stdout.write(`fetching yarn ${version} … `)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`download failed: ${url}: HTTP ${res.status}`)
  const body = Buffer.from(await res.arrayBuffer())
  fs.writeFileSync(dst, body)
  process.stdout.write(`(${body.length}b) `)
  return dst
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

function loadCaseConfig (caseName) {
  const file = path.join(TEMPLATES_DIR, caseName, '.fixture.json')
  if (!fs.existsSync(file)) return {}
  return JSON.parse(fs.readFileSync(file, 'utf-8'))
}

function postProcessLockfile (file, caseConfig) {
  if (caseConfig.post?.lineEndings !== 'crlf') return
  const input = fs.readFileSync(file, 'utf8')
  const output = input.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n')
  fs.writeFileSync(file, output)
}

async function runOne (caseName, caseConfig, adapter) {
  if (adapter.skip) return { ok: false, skipped: true, reason: adapter.skip }
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `lockfile-fixture-${caseName}-${adapter.id}-`))
  try {
    copyDir(path.join(TEMPLATES_DIR, caseName), tempRoot)
    if (adapter.setup) {
      for (const [name, content] of Object.entries(adapter.setup)) {
        fs.writeFileSync(path.join(tempRoot, name), content)
      }
    }

    let binPath, cmd, args
    if (adapter.runtime === 'yarn-bundle') {
      binPath = await ensureYarnBundle(adapter.yarnBundle)
      cmd = process.execPath
      args = [binPath, ...adapter.args]
    } else {
      binPath = resolveBinPath(adapter.alias, adapter.bin)
      cmd = adapter.runtime === 'native' ? binPath : process.execPath
      args = adapter.runtime === 'native' ? adapter.args : [binPath, ...adapter.args]
    }

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
    const outFile = path.join(outDir, `${adapter.id}.lock`)
    fs.copyFileSync(produced, outFile)
    postProcessLockfile(outFile, caseConfig)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err.message?.split('\n')[0] || String(err), stderr: err.stderr?.toString().slice(-500) }
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
}

async function main () {
  const filter = process.argv.slice(2)
  const cases = listCases().filter(c => filter.length === 0 || filter.includes(c))
  const report = []

  for (const caseName of cases) {
    const caseConfig = loadCaseConfig(caseName)
    const adapters = Array.isArray(caseConfig.adapters)
      ? ADAPTERS.filter(adapter => caseConfig.adapters.includes(adapter.id))
      : ADAPTERS

    for (const adapter of adapters) {
      const start = Date.now()
      process.stdout.write(`[${caseName}] ${adapter.id} ... `)
      let result = await runOne(caseName, caseConfig, adapter)
      if (!result.ok && result.error?.includes('ETIMEDOUT')) {
        process.stdout.write(`retry (${Date.now() - start}ms) ... `)
        result = await runOne(caseName, caseConfig, adapter)
      }
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

main().catch(e => { console.error(e); process.exit(1) })
