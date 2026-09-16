import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parse, stringify } from '../../main/ts/api/format-api.ts'
import type { FormatId } from '../../main/ts/api/format-contract.ts'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = (relative: string): string => readFileSync(
  resolve(here, '../resources/fixtures/lockfiles', relative),
  'utf8',
)

const implicitCases = [
  ['pnpm-v9', 'simple/pnpm-v9.lock'],
  ['yarn-berry-v9', 'simple/yarn-berry-v9.lock'],
  ['bun-text', 'simple/bun-text.lock'],
  ['deno-v5', 'simple/deno.lock'],
] as const satisfies readonly (readonly [FormatId, string])[]

const crossFormatSources = implicitCases.slice(0, 3)

function implicitRegistryPayloads(format: FormatId, source: string) {
  const graph = parse(format, source)
  return [...graph.tarballs()].filter(([, payload]) => payload.resolution?.type === 'registry')
}

function classicResolvedUrls(lockfile: string): string[] {
  return [...lockfile.matchAll(/^  resolved "([^"]+)"$/gm)].map(match => match[1]!)
}

describe('undetermined npm-class registry', () => {
  it.each(implicitCases)('%s does not fabricate a public registry URL', (format, path) => {
    const rows = implicitRegistryPayloads(format, fixture(path))
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every(([, payload]) => payload.resolution?.type === 'registry')).toBe(true)
  })

  it.each(implicitCases)('%s uses an explicit registry authority', (format, path) => {
    const graph = parse(format, fixture(path), { registry: 'https://packages.example.test/npm/' })
    const resolutions = [...graph.tarballs()]
      .map(([, payload]) => payload.resolution)
      .filter(resolution => resolution?.type === 'tarball')
    expect(resolutions.some(resolution => resolution!.url.startsWith('https://packages.example.test/npm/')))
      .toBe(true)

    const classic = stringify('yarn-classic', graph, { strict: false })
    const classicUrls = classicResolvedUrls(classic)
    expect(classicUrls).toHaveLength(resolutions.length)
    expect(classicUrls.every(url => url.startsWith('https://packages.example.test/npm/'))).toBe(true)
  })

  it.each([
    ['pnpm-v9', 'simple/pnpm-v9.lock', '.npmrc', 'registry=https://cwd.example.test/pnpm/\n'],
    ['yarn-berry-v9', 'simple/yarn-berry-v9.lock', '.yarnrc.yml', 'npmRegistryServer: "https://cwd.example.test/berry/"\n'],
    ['bun-text', 'simple/bun-text.lock', 'bunfig.toml', '[install]\nregistry = "https://cwd.example.test/bun/"\n'],
    ['deno-v5', 'simple/deno.lock', '.npmrc', 'registry=https://cwd.example.test/deno/\n'],
  ] as const)('%s discovers registry authority from an explicit cwd', (format, path, configName, config) => {
    const cwd = mkdtempSync(join(tmpdir(), 'lockgraph-registry-'))
    writeFileSync(join(cwd, configName), config)
    const graph = parse(format, fixture(path), { cwd })
    const urls = [...graph.tarballs()]
      .map(([, payload]) => payload.resolution)
      .filter(resolution => resolution?.type === 'tarball')
      .map(resolution => resolution!.url)
    expect(urls.some(url => url.startsWith('https://cwd.example.test/'))).toBe(true)

    const classic = stringify('yarn-classic', graph, { strict: false })
    const classicUrls = classicResolvedUrls(classic)
    expect(classicUrls).toHaveLength(urls.length)
    expect(classicUrls.every(url => url.startsWith('https://cwd.example.test/'))).toBe(true)
  })

  it('keeps the unknown registry bare in Node identity and explicit in lockgraph', () => {
    const graph = parse('pnpm-v9', fixture('simple/pnpm-v9.lock'))
    const ms = [...graph.nodes()].find(node => node.name === 'ms' && node.version === '2.1.3')!
    expect(ms.source).toBeUndefined()
    expect(ms.id).toBe('ms@2.1.3')

    const lock = stringify('lockgraph', graph, { strict: false })
    expect(lock).toContain('npm\t-')
    expect(lock).toContain('resolution.type=registry')
    const reparsed = parse('lockgraph', lock)
    expect(reparsed.tarballOf(ms.id)?.resolution).toEqual({ type: 'registry' })
  })

  it.each(crossFormatSources)('%s cross-format targets never recover the fabricated public URL', (format, path) => {
    const graph = parse(format, fixture(path))
    const npm = JSON.parse(stringify('npm-3', graph, { strict: false })) as {
      packages: Record<string, { resolved?: string }>
    }
    expect(npm.packages['node_modules/ms']?.resolved).toBeUndefined()

    for (const target of ['pnpm-v9', 'yarn-berry-v9', 'bun-text', 'lockgraph'] as const) {
      expect(stringify(target, graph, { strict: false })).not.toContain('registry.npmjs.org')
    }
    expect(() => stringify('yarn-classic', graph, { strict: false })).toThrowError(
      /registry is undetermined; parse with options\.registry or options\.cwd/,
    )
  })

  it('rejects malformed explicit registry authority', () => {
    expect(() => parse('pnpm-v9', fixture('simple/pnpm-v9.lock'), { registry: 'relative/path' }))
      .toThrowError(/absolute http\(s\) URL/)
  })

  it('never carries registry credentials into canonical source URLs', () => {
    const graph = parse('pnpm-v9', fixture('simple/pnpm-v9.lock'), {
      registry: 'https://user:password@packages.example.test/npm/',
    })
    const urls = [...graph.tarballs()].flatMap(([, payload]) =>
      payload.resolution?.type === 'tarball' ? [payload.resolution.url] : [])
    expect(urls.length).toBeGreaterThan(0)
    expect(urls.every(url => !url.includes('user') && !url.includes('password'))).toBe(true)
    expect(urls.every(url => url.startsWith('https://packages.example.test/npm/'))).toBe(true)
  })
})
