import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  evidenceOf,
  parse,
  projectCompanionsOf,
  stringifyAssessed,
  withEvidence,
} from '../../main/ts/index.ts'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = (file: string): string =>
  readFileSync(resolve(here, '../resources/fixtures/lockfiles/simple', file), 'utf8')
const pnpmBin = resolve(process.cwd(), 'node_modules/pm-pnpm-10/bin/pnpm.cjs')

describe('project companions: pnpm frozen oracle', () => {
  it('accepts the projected manifest authority without rewriting the lock', () => {
    const input = fixture('pnpm-v9.lock')
      .replace("lockfileVersion: '9.0'\n", "lockfileVersion: '9.0'\n\noverrides:\n  lodash: 4.17.20\n")
      .replaceAll('version: 4.17.21', 'version: 4.17.20')
      .replaceAll('lodash@4.17.21', 'lodash@4.17.20')
    const graph = parse('pnpm-v9', input)
    let evidence = withEvidence(evidenceOf(graph), {
      kind: 'repository-manifests',
      coverage: 'complete',
      manifests: {
        '': {
          dependencies: { lodash: '4.17.21', ms: '2.1.3' },
          overrides: [],
        },
      },
    })
    evidence = withEvidence(evidence, {
      kind: 'pm-config',
      manager: 'pnpm',
      version: '10.34.5',
      source: 'package.json',
      surface: 'overrides',
      coverage: 'complete',
      overrides: [{ package: 'lodash', to: '4.17.20' }],
    })
    const target = { format: 'pnpm-v9' as const, managerVersion: '10.34.5' }
    const companions = projectCompanionsOf(graph, { target, evidence })
    const assessed = stringifyAssessed(graph, { contract: 'policy', target, evidence })

    expect(companions.patches).toEqual([{
      path: 'package.json',
      op: 'set',
      pointer: '/pnpm/overrides',
      value: { lodash: '4.17.20' },
    }])
    expect(assessed.assessment.status).toBe('satisfied')
    const lockfile = assessed.output!
    const root = mkdtempSync(resolve(tmpdir(), 'lockgraph-pnpm-companion-'))
    try {
      writeFileSync(resolve(root, 'package.json'), JSON.stringify({
        name: 'case-simple',
        version: '0.0.0',
        private: true,
        packageManager: 'pnpm@10.34.5',
        dependencies: { lodash: '4.17.21', ms: '2.1.3' },
        pnpm: { overrides: companions.patches![0]!.value },
      }, null, 2))
      writeFileSync(resolve(root, 'pnpm-lock.yaml'), lockfile)

      try {
        execFileSync(process.execPath, [
          pnpmBin,
          'install',
          '--lockfile-only',
          '--frozen-lockfile',
          '--offline',
          '--ignore-scripts',
        ], {
          cwd: root,
          encoding: 'utf8',
          timeout: 30_000,
          stdio: 'pipe',
        })
      } catch (error) {
        const output = error as { stdout?: string; stderr?: string }
        throw new Error(`${output.stdout ?? ''}\n${output.stderr ?? ''}`)
      }

      expect(readFileSync(resolve(root, 'pnpm-lock.yaml'), 'utf8')).toBe(lockfile)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('applies a workspace-scoped override to the workspace importer specifier', () => {
    const input = `lockfileVersion: '9.0'\n\n`
      + `settings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n\n`
      + `overrides:\n  app>lodash: 4.17.20\n\n`
      + `importers:\n\n  .: {}\n\n  packages/app:\n    dependencies:\n`
      + `      lodash:\n        specifier: 4.17.21\n        version: 4.17.20\n\n`
      + `packages:\n\n  lodash@4.17.20:\n`
      + `    resolution: {integrity: sha512-v2kDEe57lecTulaDIuNTPy3Ry4gLGJ6Z1O3vE1krgXZNrsQ+LFTGHVxVjcXPs17LhbZVGedAJv8XZ1tvj5FvSg==}\n\n`
      + `snapshots:\n\n  lodash@4.17.20: {}\n`
    const manifests = {
      '': { name: 'workspace-oracle', workspaces: ['packages/app'] },
      'packages/app': {
        name: 'app',
        dependencies: { lodash: '4.17.21' },
      },
    }
    const graph = parse('pnpm-v9', input, { manifests })
    let evidence = withEvidence(evidenceOf(graph), {
      kind: 'repository-manifests',
      coverage: 'complete',
      manifests,
    })
    evidence = withEvidence(evidence, {
      kind: 'pm-config',
      manager: 'pnpm',
      version: '10.34.5',
      source: 'package.json',
      surface: 'overrides',
      coverage: 'complete',
      overrides: [{ package: 'lodash', parentPath: ['app'], to: '4.17.20' }],
    })
    const target = { format: 'pnpm-v9' as const, managerVersion: '10.34.5' }
    const companions = projectCompanionsOf(graph, { target, evidence })
    const assessed = stringifyAssessed(graph, { contract: 'policy', target, evidence })

    expect(companions.patches![0]!.value).toEqual({ 'app>lodash': '4.17.20' })
    expect(assessed.assessment.status).toBe('satisfied')
    const lockfile = assessed.output!
    const root = mkdtempSync(resolve(tmpdir(), 'lockgraph-pnpm-workspace-companion-'))
    try {
      const app = resolve(root, 'packages/app')
      mkdirSync(app, { recursive: true })
      writeFileSync(resolve(root, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n")
      writeFileSync(resolve(root, 'package.json'), JSON.stringify({
        name: 'workspace-oracle',
        version: '1.0.0',
        private: true,
        packageManager: 'pnpm@10.34.5',
        pnpm: { overrides: companions.patches![0]!.value },
      }, null, 2))
      writeFileSync(resolve(app, 'package.json'), JSON.stringify({
        name: 'app',
        version: '1.0.0',
        dependencies: { lodash: '4.17.21' },
      }, null, 2))
      writeFileSync(resolve(root, 'pnpm-lock.yaml'), lockfile)

      execFileSync(process.execPath, [
        pnpmBin,
        'install',
        '--lockfile-only',
        '--frozen-lockfile',
        '--offline',
        '--ignore-scripts',
      ], {
        cwd: root,
        encoding: 'utf8',
        timeout: 30_000,
        stdio: 'pipe',
      })

      expect(readFileSync(resolve(root, 'pnpm-lock.yaml'), 'utf8')).toBe(lockfile)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
