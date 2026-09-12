import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { detect } from '../../main/ts/api/format-api.ts'
import type { FormatId } from '../../main/ts/api/format-contract.ts'
import {
  overrideSource,
  type SourceCounts,
  type SourceStatus,
} from '../../main/ts/source/operations.ts'
import { scanSourceEntries } from '../../main/ts/source/scanners.ts'
import { corpusBudget } from './_corpus-budget.ts'

const npmRoot = resolve('tmp/npm-corpus/raw')
const yarnRoot = resolve('tmp/yarn-corpus/raw')
const pnpmRoot = resolve('tmp/pnpm-corpus/raw')
const denoRoot = resolve('tmp/deno-corpus/raw')
const corpusAvailable = [npmRoot, yarnRoot, pnpmRoot, denoRoot].every(root => existsSync(root))
const suite = corpusAvailable ? describe : describe.skip

type JsonRecord = Record<string, unknown>

function record(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : undefined
}

function isNpmLocator(value: string): boolean {
  const query = value.indexOf('?')
  const fragment = value.indexOf('#')
  const ends = [query, fragment].filter(index => index >= 0)
  const base = value.slice(0, ends.length === 0 ? value.length : Math.min(...ends))
  if (base.startsWith('git+')
    || /^(?:git:|ssh:|git@|github:)/iu.test(base)) return false
  try {
    const url = new URL(base)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
    const host = url.hostname.toLowerCase()
    if (host === 'codeload.github.com'
      && /^\/[^/]+\/[^/]+\/(?:tar\.gz|zip)\/[\da-f]{7,64}$/iu.test(url.pathname)) return false
    if (host === 'github.com'
      && /^\/[^/]+\/[^/]+\/(?:archive|tarball)\/[\da-f]{7,64}(?:\.tar\.gz)?$/iu.test(url.pathname)) {
      return false
    }
    return true
  } catch {
    return false
  }
}

function yamlScalar(raw: string): string {
  const value = raw.trim()
  if (value.startsWith('"')) {
    try { return JSON.parse(value) as string } catch { return value }
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/gu, "'")
  }
  return value.replace(/\s+#.*$/u, '').trimEnd()
}

function npmLocatorPositions(input: string): readonly string[] {
  const root = record(JSON.parse(input))
  const values: string[] = []
  for (const value of Object.values(record(root?.packages) ?? {})) {
    const resolved = record(value)?.resolved
    if (typeof resolved === 'string') values.push(resolved)
  }
  const walk = (dependencies: JsonRecord | undefined): void => {
    for (const value of Object.values(dependencies ?? {})) {
      const dependency = record(value)
      if (dependency === undefined) continue
      const resolved = dependency.resolved
      const version = dependency.version
      if (typeof resolved === 'string') values.push(resolved)
      else if (typeof version === 'string' && /^https?:\/\//iu.test(version)) values.push(version)
      walk(record(dependency.dependencies))
    }
  }
  walk(record(root?.dependencies))
  return Object.freeze(values)
}

function yarnLocatorPositions(input: string): readonly string[] {
  const values: string[] = []
  for (const match of input.matchAll(/^\s+resolved\s+(.+)$/gmu)) {
    if (match[1] !== undefined) values.push(yamlScalar(match[1]))
  }
  return Object.freeze(values)
}

function pnpmLocatorPositions(input: string): readonly string[] {
  const values: string[] = []
  const pattern = /(?:^|[,{])\s*tarball:\s*("(?:\\.|[^"])*"|'(?:''|[^'])*'|[^,}\s#]+)/gmu
  for (const match of input.matchAll(pattern)) {
    if (match[1] !== undefined) values.push(yamlScalar(match[1]))
  }
  return Object.freeze(values)
}

function denoLocatorPositions(input: string): readonly string[] {
  const root = record(JSON.parse(input))
  const values: string[] = []
  for (const value of Object.values(record(root?.npm) ?? {})) {
    const tarball = record(value)?.tarball
    if (typeof tarball === 'string') values.push(tarball)
  }
  return Object.freeze(values)
}

function locatorPositions(input: string, format: FormatId): readonly string[] {
  if (format.startsWith('npm-')) return npmLocatorPositions(input)
  if (format === 'yarn-classic') return yarnLocatorPositions(input)
  if (format.startsWith('pnpm-')) return pnpmLocatorPositions(input)
  if (format.startsWith('deno-')) return denoLocatorPositions(input)
  return Object.freeze([])
}

function residueCount(observed: readonly string[], reported: readonly string[]): number {
  const remaining = new Map<string, number>()
  for (const locator of reported) remaining.set(locator, (remaining.get(locator) ?? 0) + 1)
  let residue = 0
  for (const locator of observed) {
    const available = remaining.get(locator) ?? 0
    if (available === 0) residue += 1
    else remaining.set(locator, available - 1)
  }
  residue += [...remaining.values()].reduce((total, count) => total + count, 0)
  return residue
}

function emptyCounts(): Record<keyof SourceCounts, number> {
  return {
    rewritten: 0,
    compliant: 0,
    violation: 0,
    uncertifiable: 0,
    unguarded: 0,
    unrewritable: 0,
    local: 0,
    unmatched: 0,
  }
}

function addCounts(target: Record<keyof SourceCounts, number>, counts: SourceCounts): void {
  for (const key of Object.keys(target) as Array<keyof SourceCounts>) target[key] += counts[key]
}

function audit(
  root: string,
  accepts: (format: FormatId | undefined, file: string) => format is FormatId,
): Readonly<{
  files: number
  failedFiles: number
  counts: SourceCounts
  failureReasons: Readonly<Record<string, number>>
  localReasons: Readonly<Record<string, number>>
  residue: number
  entryResidue: number
  failures: readonly string[]
}> {
  const counts = emptyCounts()
  const failureReasons: Record<string, number> = {}
  const localReasons: Record<string, number> = {}
  const failures: string[] = []
  let files = 0
  let failedFiles = 0
  let residue = 0
  let entryResidue = 0
  for (const file of readdirSync(root).sort()) {
    const input = readFileSync(resolve(root, file), 'utf8')
    if (root === npmRoot || root === denoRoot) {
      try { JSON.parse(input) } catch { continue }
    }
    const format = detect(input)
    if (!accepts(format, file)) continue
    try {
      const result = overrideSource(input, 'npm:*=https://mirror.invalid/npm', {
        format,
        allowEmptyRules: true,
      })
      const rewrittenItems = result.items.filter(item => item.status === 'rewritten')
      if (rewrittenItems.length !== result.counts.rewritten) {
        failures.push(`${file}: rewrite/native-span count failed`)
      }
      if (result.counts.rewritten === 0 && result.output !== input) {
        failures.push(`${file}: output changed without a rewrite span`)
      }
      const observed = locatorPositions(result.output, format).filter(isNpmLocator)
      const reported = result.items
        .map(item => item.status === 'rewritten' ? item.rewrittenLocator : item.locator)
        .filter((locator): locator is string => locator !== undefined && isNpmLocator(locator))
      const fileResidue = residueCount(observed, reported)
      residue += fileResidue
      if (fileResidue !== 0) failures.push(`${file}: ${fileResidue} unreported npm-kind locators`)
      const expectedEntries = scanSourceEntries(input, format)
        .filter(entry => entry.localReason === undefined && entry.locatorKind !== 'git')
        .map(entry => entry.key)
      const reportedEntries = result.items
        .filter(item => item.status !== 'local' && item.status !== 'unmatched')
        .map(item => item.key)
        .filter((key): key is string => key !== undefined)
      const fileEntryResidue = residueCount(expectedEntries, reportedEntries)
      entryResidue += fileEntryResidue
      if (fileEntryResidue !== 0) {
        failures.push(`${file}: ${fileEntryResidue} unreported non-local npm package entries`)
      }
      for (const item of result.items) {
        if (item.status === 'local' && item.localReason !== undefined) {
          localReasons[item.localReason] = (localReasons[item.localReason] ?? 0) + 1
        }
      }
      if (!result.ok) {
        failedFiles += 1
        const blocking = (['unguarded', 'unrewritable', 'unmatched'] as SourceStatus[])
          .filter(status => result.counts[status] > 0)
          .join('+')
        failureReasons[blocking] = (failureReasons[blocking] ?? 0) + 1
      }
      addCounts(counts, result.counts)
      files += 1
    } catch (error) {
      failures.push(`${file}: ${String((error as Error).message).slice(0, 180)}`)
    }
  }
  return Object.freeze({
    files,
    failedFiles,
    counts: Object.freeze(counts),
    failureReasons: Object.freeze(failureReasons),
    localReasons: Object.freeze(localReasons),
    residue,
    entryResidue,
    failures: Object.freeze(failures),
  })
}

suite(
  corpusAvailable
    ? 'source override corpus audit'
    : 'source override corpus audit [skipped: external corpora absent]',
  () => {
    it('audits supported corpora with native-entry/span, local-source, and carrier invariants', () => {
      const npm = audit(npmRoot, (format): format is FormatId => format?.startsWith('npm-') === true)
      const yarn = audit(
        yarnRoot,
        (format): format is FormatId => format === 'yarn-classic',
      )
      const pnpm = audit(pnpmRoot, (format): format is FormatId => format?.startsWith('pnpm-') === true)
      const deno = audit(denoRoot, (format): format is FormatId => format?.startsWith('deno-') === true)
      const audits = { npm, 'yarn-classic': yarn, pnpm, deno }
      for (const [name, value] of Object.entries(audits)) {
        console.log(`source override ${name} corpus: files=${value.files} failedFiles=${value.failedFiles} residue=${value.residue} entryResidue=${value.entryResidue} counts=${JSON.stringify(value.counts)} failureReasons=${JSON.stringify(value.failureReasons)} localReasons=${JSON.stringify(value.localReasons)}`)
        expect(value.failures).toEqual([])
        expect(value.files).toBeGreaterThan(0)
        expect(value.residue).toBe(0)
        expect(value.entryResidue).toBe(0)
      }
      expect(npm.counts.rewritten).toBeGreaterThan(0)
      expect(yarn.counts.rewritten).toBeGreaterThan(0)
    }, corpusBudget(300_000))
  },
)
