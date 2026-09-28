import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { parse, stringify } from '../../main/ts/formats/npm-2.ts'

const fixture = resolve('tmp/npm-corpus/raw/tmquan2508__Q-bot-afk__package-lock.json')
const corpusAvailable = existsSync(fixture)
const suite = corpusAvailable ? describe : describe.skip
const npmPath = 'node_modules/npm'
const pathLocalWitnessNames = new Set([
  'ms',
  'process',
  'safe-buffer',
  'safer-buffer',
  'smart-buffer',
  'string_decoder',
  'util-deprecate',
  'yallist',
])

function source(): string {
  return readFileSync(fixture, 'utf8')
}

function packageJson(lock: { packages: Record<string, Record<string, unknown>> }): string {
  const root = structuredClone(lock.packages['']!)
  delete root.resolved
  delete root.integrity
  delete root.link
  return `${JSON.stringify(root, null, 2)}\n`
}

function writeProject(path: string, lock: Record<string, unknown>, manifest: string): void {
  mkdirSync(path, { recursive: true })
  writeFileSync(resolve(path, 'package.json'), manifest)
  writeFileSync(resolve(path, 'package-lock.json'), `${JSON.stringify(lock, null, 2)}\n`)
}

function tree(root: string, prefix = ''): readonly string[] {
  const rows: string[] = []
  for (const name of readdirSync(resolve(root, prefix)).sort()) {
    const relative = prefix === '' ? name : `${prefix}/${name}`
    // Compared semantically below: its bytes preserve source formatting while
    // its parsed object records the materialized package tree.
    if (relative === '.package-lock.json') continue
    const absolute = resolve(root, relative)
    const stat = lstatSync(absolute)
    if (stat.isSymbolicLink()) {
      rows.push(`l ${relative} -> ${readlinkSync(absolute)}`)
    } else if (stat.isDirectory()) {
      rows.push(`d ${relative}`)
      rows.push(...tree(root, relative))
    } else {
      rows.push(`f ${relative} ${stat.size} ${createHash('sha256').update(readFileSync(absolute)).digest('hex')}`)
    }
  }
  return rows
}

function hiddenLock(root: string): unknown {
  return JSON.parse(readFileSync(resolve(root, 'node_modules/.package-lock.json'), 'utf8'))
}

function packageName(path: string, entry: Record<string, unknown>): string | undefined {
  if (typeof entry.name === 'string') return entry.name
  return (`/${path}`).split('/node_modules/').filter(Boolean).at(-1)
}

suite(
  corpusAvailable
    ? 'npm installed-package bundle carrier native oracle'
    : 'npm installed-package bundle carrier native oracle [skipped: exact corpus fixture absent]',
  () => {
    it('pins the exact real npm@9.7.2 bundle-carrier witness', () => {
      expect(Buffer.byteLength(source())).toBe(284_499)
      expect(createHash('sha256').update(source()).digest('hex'))
        .toBe('020ade74c7de2a70cc222962f950f84027a8bdc772d52effd03782285a119f0f')
      const authored = JSON.parse(source()) as {
        packages: Record<string, { bundleDependencies?: string[] }>
      }
      expect(authored.packages[npmPath]?.bundleDependencies).toHaveLength(66)
    })

    it('retains the exact installed npm@9.7.2 bundle carrier on replay', () => {
      const authored = JSON.parse(source()) as {
        packages: Record<string, { bundleDependencies?: string[] }>
      }
      const emitted = JSON.parse(stringify(parse(source()))) as typeof authored
      expect(emitted.packages[npmPath]?.bundleDependencies)
        .toEqual(authored.packages[npmPath]?.bundleDependencies)
    })

    it('replays every collapsed witness entry exactly before npm observes the lock', () => {
      const authored = JSON.parse(source()) as {
        packages: Record<string, Record<string, unknown>>
      }
      const emitted = JSON.parse(stringify(parse(source()))) as typeof authored
      const witnessPaths = Object.entries(authored.packages)
        .filter(([path, entry]) => path !== '' && pathLocalWitnessNames.has(packageName(path, entry) ?? ''))
        .map(([path]) => path)

      expect(witnessPaths).toHaveLength(23)
      for (const path of witnessPaths) {
        expect(emitted.packages[path], path).toEqual(authored.packages[path])
      }
    })

    const native = process.env.LOCKGRAPH_NPM_BUNDLED_OFFLINE_ORACLE === '1' ? it : it.skip
    for (const [label, cli] of [
      ['npm 8.19.4', resolve('node_modules/pm-npm-8/bin/npm-cli.js')],
      ['npm 11.20.0', resolve('node_modules/pm-npm-11/bin/npm-cli.js')],
    ] as const) {
      native(`${label} accepts source and replay offline with identical installed trees`, () => {
        const base = mkdtempSync(resolve(tmpdir(), 'lockgraph-npm-bundled-'))
        try {
          const authored = JSON.parse(source()) as {
            packages: Record<string, Record<string, unknown>>
            [key: string]: unknown
          }
          const emitted = JSON.parse(stringify(parse(source()))) as typeof authored
          const manifest = packageJson(authored)
          const cache = resolve(base, 'cache')
          const run = (cwd: string, offline: boolean) => spawnSync(process.execPath, [
            cli,
            'ci',
            '--ignore-scripts',
            '--audit=false',
            '--fund=false',
            '--cache', cache,
            ...(offline ? ['--offline'] : []),
          ], {
            cwd,
            encoding: 'utf8',
            env: {
              ...process.env,
              HOME: resolve(base, 'home'),
              NO_UPDATE_NOTIFIER: '1',
              npm_config_cache: cache,
            },
          })

          mkdirSync(resolve(base, 'home'), { recursive: true })
          const prime = resolve(base, 'prime')
          const sourceOffline = resolve(base, 'source-offline')
          const replayOffline = resolve(base, 'replay-offline')
          writeProject(prime, authored, manifest)
          writeProject(sourceOffline, authored, manifest)
          writeProject(replayOffline, emitted, manifest)

          expect(run(prime, false).status, `${label} online prime`).toBe(0)
          expect(run(sourceOffline, true).status, `${label} exact source offline`).toBe(0)
          expect(run(replayOffline, true).status, `${label} replay offline`).toBe(0)
          expect(hiddenLock(replayOffline), `${label} semantic hidden lock`)
            .toEqual(hiddenLock(sourceOffline))
          expect(tree(resolve(replayOffline, 'node_modules')))
            .toEqual(tree(resolve(sourceOffline, 'node_modules')))
        } finally {
          rmSync(base, { recursive: true, force: true })
        }
      }, 300_000)
    }
  },
)
