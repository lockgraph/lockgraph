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
const REPORT_FILE   = path.join(HERE, '_report.json')

let activeReport

const USAGE = `Usage:
  npm run build:fixtures -- --cases <name-or-glob...> [--adapters <id...>]
  npm run build:fixtures -- --adapters <id...> [--cases <name-or-glob...>]

Options:
  --cases       Exact case names or patterns using * and ?
  --adapters    Exact adapter ids
  --plan        Print the selected cells without running package managers
  --help        Print this help

Positional arguments are treated as case selectors.`

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

function parseList (values) {
  return values.flatMap(value => value.split(',')).map(value => value.trim()).filter(Boolean)
}

function parseArgs (argv) {
  const cases = []
  const adapters = []
  let plan = false
  let help = false

  for (let index = 0; index < argv.length;) {
    const arg = argv[index]
    if (arg === '--plan') {
      plan = true
      index++
      continue
    }
    if (arg === '--help' || arg === '-h') {
      help = true
      index++
      continue
    }
    if (arg === '--cases' || arg === '--adapters') {
      const target = arg === '--cases' ? cases : adapters
      const values = []
      index++
      while (index < argv.length && !argv[index].startsWith('--')) {
        values.push(argv[index])
        index++
      }
      if (values.length === 0) throw new Error(`${arg} requires at least one value`)
      target.push(...parseList(values))
      continue
    }
    if (arg.startsWith('-')) throw new Error(`unknown option: ${arg}`)
    cases.push(...parseList([arg]))
    index++
  }

  return { cases: [...new Set(cases)], adapters: [...new Set(adapters)], plan, help }
}

function matchesCaseSelector (caseName, selector) {
  const source = selector
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
  return new RegExp(`^${source}$`).test(caseName)
}

function selectPlans (selection) {
  const allCases = listCases()
  const adapterIds = new Set(ADAPTERS.map(adapter => adapter.id))

  for (const selector of selection.cases) {
    if (!allCases.some(caseName => matchesCaseSelector(caseName, selector))) {
      throw new Error(`case selector matched nothing: ${selector}`)
    }
  }
  for (const adapterId of selection.adapters) {
    if (!adapterIds.has(adapterId)) throw new Error(`unknown adapter id: ${adapterId}`)
  }

  const selectedCases = selection.cases.length === 0
    ? allCases
    : allCases.filter(caseName => selection.cases.some(selector => matchesCaseSelector(caseName, selector)))
  const selectedAdapters = new Set(selection.adapters)
  const plans = selectedCases.map(caseName => {
    const caseConfig = loadCaseConfig(caseName)
    const configured = Array.isArray(caseConfig.adapters)
      ? ADAPTERS.filter(adapter => caseConfig.adapters.includes(adapter.id))
      : ADAPTERS
    const adapters = selectedAdapters.size === 0
      ? configured
      : configured.filter(adapter => selectedAdapters.has(adapter.id))
    return { caseName, caseConfig, adapters }
  }).filter(plan => plan.adapters.length > 0)

  if (plans.length === 0) throw new Error('selection produced no fixture cells')
  return plans
}

function postProcessLockfile (file, caseConfig) {
  if (caseConfig.post?.lineEndings !== 'crlf') return
  const input = fs.readFileSync(file, 'utf8')
  const output = input.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n')
  fs.writeFileSync(file, output)
}

function writeReport (report) {
  const ok = report.runs.filter(run => run.ok).length
  const skipped = report.runs.filter(run => run.skipped).length
  const failed = report.runs.length - ok - skipped
  const output = {
    ...report,
    summary: {
      expected: report.expected,
      completed: report.runs.length,
      remaining: report.expected - report.runs.length,
      ok,
      skipped,
      failed,
    },
  }
  fs.writeFileSync(REPORT_FILE, `${JSON.stringify(output, null, 2)}\n`)
}

function interruptReport (signal) {
  if (activeReport) {
    activeReport.status = 'interrupted'
    activeReport.completedAt = new Date().toISOString()
    activeReport.signal = signal
    writeReport(activeReport)
  }
  process.exit(signal === 'SIGINT' ? 130 : 143)
}

process.once('SIGINT', () => interruptReport('SIGINT'))
process.once('SIGTERM', () => interruptReport('SIGTERM'))

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
    return {
      ok: false,
      code: err.code,
      status: err.status,
      signal: err.signal,
      error: err.message || String(err),
      stdout: err.stdout?.toString(),
      stderr: err.stderr?.toString(),
    }
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
}

async function main () {
  const selection = parseArgs(process.argv.slice(2))
  if (selection.help) {
    console.log(USAGE)
    return
  }
  if (selection.cases.length === 0 && selection.adapters.length === 0) {
    throw new Error(`fixture selection is required\n\n${USAGE}`)
  }
  const plans = selectPlans(selection)
  const cases = plans.map(plan => plan.caseName)
  const cells = plans.flatMap(plan => plan.adapters.map(adapter => ({ case: plan.caseName, adapter: adapter.id })))
  if (selection.plan) {
    console.log(JSON.stringify({
      selection: { cases: selection.cases, adapters: selection.adapters },
      expected: cells.length,
      cells,
    }, null, 2))
    return
  }
  const report = {
    status: 'running',
    startedAt: new Date().toISOString(),
    selection: { cases: selection.cases, adapters: selection.adapters },
    cases,
    expected: plans.reduce((total, plan) => total + plan.adapters.length, 0),
    active: null,
    runs: [],
  }
  activeReport = report
  writeReport(report)

  for (const { caseName, caseConfig, adapters } of plans) {
    for (const adapter of adapters) {
      const start = Date.now()
      let attempts = 1
      report.active = { case: caseName, adapter: adapter.id, startedAt: new Date(start).toISOString() }
      writeReport(report)
      process.stdout.write(`[${caseName}] ${adapter.id} ... `)
      let result = await runOne(caseName, caseConfig, adapter)
      if (!result.ok && result.error?.includes('ETIMEDOUT')) {
        attempts++
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
      report.runs.push({ case: caseName, adapter: adapter.id, attempts, ms, ...result })
      report.active = null
      writeReport(report)
    }
  }

  const ok      = report.runs.filter(run => run.ok).length
  const skipped = report.runs.filter(run => run.skipped).length
  const failed  = report.runs.length - ok - skipped
  report.status = failed === 0 ? 'passed' : 'failed'
  report.completedAt = new Date().toISOString()
  writeReport(report)
  console.log(`\n${ok}/${report.runs.length} ok, ${skipped} skipped, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch(error => {
  if (activeReport) {
    activeReport.status = 'errored'
    activeReport.completedAt = new Date().toISOString()
    activeReport.fatal = error.stack || String(error)
    writeReport(activeReport)
  }
  console.error(error)
  process.exit(1)
})
