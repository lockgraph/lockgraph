import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  evidenceOf,
  parse,
  projectCompanionsOf,
  stringify,
  withEvidence,
} from '../../main/ts/index.ts'

const yarnClassicBin = resolve(process.cwd(), 'node_modules/pm-yarn-1/bin/yarn.js')
const yarnBerryBin = resolve(process.cwd(), 'node_modules/pm-yarn-2/bin/yarn.js')

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

describe('project companions: yarn native semantics', () => {
  it('confirms Yarn Classic resolutions do not replace direct dependencies', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'lockgraph-yarn-classic-companion-'))
    try {
      const v1 = resolve(root, 'foo-v1')
      const v2 = resolve(root, 'foo-v2')
      mkdirSync(v1)
      mkdirSync(v2)
      writeJson(resolve(v1, 'package.json'), { name: 'foo', version: '1.0.0' })
      writeJson(resolve(v2, 'package.json'), { name: 'foo', version: '2.0.0' })
      writeJson(resolve(root, 'package.json'), {
        name: 'classic-companion-oracle',
        version: '1.0.0',
        private: true,
        dependencies: { foo: 'file:./foo-v1' },
        resolutions: { foo: 'file:./foo-v2' },
      })

      execFileSync(process.execPath, [
        yarnClassicBin,
        'install',
        '--offline',
        '--ignore-scripts',
        '--no-progress',
      ], {
        cwd: root,
        encoding: 'utf8',
        timeout: 30_000,
        stdio: 'pipe',
      })

      const installed = JSON.parse(readFileSync(resolve(root, 'node_modules/foo/package.json'), 'utf8'))
      expect(installed.version).toBe('1.0.0')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('accepts a Berry descriptor resolution under immutable install', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'lockgraph-yarn-berry-companion-'))
    try {
      const consumer = resolve(root, 'packages/consumer')
      const foo = resolve(root, 'packages/foo')
      mkdirSync(consumer, { recursive: true })
      mkdirSync(foo, { recursive: true })
      writeFileSync(resolve(root, '.yarnrc.yml'), 'nodeLinker: node-modules\n')
      writeJson(resolve(root, 'package.json'), {
        name: 'berry-companion-oracle',
        version: '1.0.0',
        private: true,
        workspaces: ['packages/*'],
        dependencies: { consumer: 'workspace:*' },
        resolutions: { 'foo@npm:^1': 'workspace:packages/foo' },
      })
      writeJson(resolve(consumer, 'package.json'), {
        name: 'consumer',
        version: '1.0.0',
        dependencies: { foo: 'npm:^1' },
      })
      writeJson(resolve(foo, 'package.json'), { name: 'foo', version: '2.0.0' })

      try {
        execFileSync(process.execPath, [yarnBerryBin, 'install'], {
          cwd: root,
          encoding: 'utf8',
          timeout: 30_000,
          stdio: 'pipe',
        })
      } catch (error) {
        const output = error as { stdout?: string; stderr?: string }
        throw new Error(`${output.stdout ?? ''}\n${output.stderr ?? ''}`)
      }
      const lockfile = readFileSync(resolve(root, 'yarn.lock'), 'utf8')
      expect(lockfile).toContain('foo@workspace:packages/foo')
      const installed = JSON.parse(readFileSync(resolve(root, 'node_modules/foo/package.json'), 'utf8'))
      expect(installed.version).toBe('2.0.0')

      const graph = parse('yarn-berry-v4', lockfile)
      const evidence = withEvidence(evidenceOf(graph), {
        kind: 'repository-manifests',
        coverage: 'complete',
        manifests: {
          '': {
            dependencies: { consumer: 'workspace:*' },
            workspaces: ['packages/*'],
            overrides: [{
              package: 'foo',
              versionCondition: '^1',
              to: 'workspace:packages/foo',
            }],
          },
        },
      })
      const target = { format: 'yarn-berry-v4' as const, managerVersion: '2.4.3' }
      const companions = projectCompanionsOf(graph, { target, evidence })
      const emitted = stringify('yarn-berry-v4', graph)

      expect(companions.patches).toEqual([{
        path: 'package.json',
        op: 'set',
        pointer: '/resolutions',
        value: { 'foo@npm:^1': 'workspace:packages/foo' },
      }])
      writeFileSync(resolve(root, 'yarn.lock'), emitted)

      execFileSync(process.execPath, [yarnBerryBin, 'install', '--immutable'], {
        cwd: root,
        encoding: 'utf8',
        timeout: 30_000,
        stdio: 'pipe',
      })
      expect(readFileSync(resolve(root, 'yarn.lock'), 'utf8')).toBe(emitted)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
