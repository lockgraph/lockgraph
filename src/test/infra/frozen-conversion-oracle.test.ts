import semver from 'semver'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { certifyFrozen, prepareFrozen } from '../../main/ts/index.ts'
import {
  createNativeLock,
  FROZEN_ORACLE_MATRIX,
  isFrozenOracleOutputAllowed,
  runFrozenOracle,
  type FrozenOracleCandidate,
  type FrozenOracleAdapter,
  type FrozenOracleFamily,
} from '../helpers/frozen-oracle.ts'

const here = dirname(fileURLToPath(import.meta.url))
const tarballPath = resolve(here, '../resources/fixtures/tarballs/ms-2.1.3.tgz')
const registryScript = resolve(here, '../helpers/frozen-registry.mjs')
let registry: ChildProcess | undefined

beforeAll(async () => {
  registry = spawn(process.execPath, [registryScript, tarballPath], {
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  const port = await new Promise<string>((resolvePort, reject) => {
    const timeout = setTimeout(() => reject(new Error('local frozen registry did not start')), 10_000)
    registry!.once('error', reject)
    registry!.stdout!.once('data', chunk => {
      clearTimeout(timeout)
      resolvePort(String(chunk).trim())
    })
  })
  process.env.LOCKGRAPH_TEST_REGISTRY = `http://127.0.0.1:${port}/`
})

afterAll(() => {
  delete process.env.LOCKGRAPH_TEST_REGISTRY
  registry?.kill('SIGTERM')
})

function packageManager(adapter: FrozenOracleAdapter): string {
  if (adapter.family === 'yarn-classic' || adapter.family === 'yarn-berry') {
    return `yarn@${adapter.version}`
  }
  return `${adapter.family}@${adapter.version}`
}

function projectFiles(adapter: FrozenOracleAdapter): Readonly<Record<string, string | Uint8Array>> {
  const manifest = {
    name: 'lockgraph-frozen-oracle-case',
    version: '1.0.0',
    private: true,
    packageManager: packageManager(adapter),
    dependencies: { ms: '2.1.3' },
  }
  return {
    'package.json': `${JSON.stringify(manifest, null, 2)}\n`,
    ...(adapter.family === 'yarn-berry'
      ? {
          '.yarnrc.yml': 'nodeLinker: node-modules\nenableScripts: false\nunsafeHttpWhitelist:\n  - 127.0.0.1\n',
        }
      : {}),
  }
}

function lockPath(adapter: FrozenOracleAdapter): string {
  if (adapter.family === 'npm') return 'package-lock.json'
  if (adapter.family === 'pnpm') return 'pnpm-lock.yaml'
  return 'yarn.lock'
}

function nativeCandidate(adapter: FrozenOracleAdapter): {
  readonly candidate: FrozenOracleCandidate
  readonly files: Readonly<Record<string, string | Uint8Array>>
} {
  const files = createNativeLock(adapter, projectFiles(adapter))
  const lockfile = String(files[lockPath(adapter)]!)
  const projectionDigest = `sha256:${createHash('sha256').update(JSON.stringify({
    target: { format: adapter.format, managerVersion: adapter.version },
    lockfile,
    companions: [],
  })).digest('hex')}`
  return {
    candidate: Object.freeze({
      protocol: 'lockgraph-frozen-projection/v1',
      target: Object.freeze({ format: adapter.format, managerVersion: adapter.version }),
      projectionDigest,
      lockfile,
      companions: Object.freeze([]),
    }),
    files,
  }
}

describe('infra: frozen conversion native oracle', () => {
  it('certifies the exact core candidate bundle after a real pinned native verdict', async () => {
    const adapter = FROZEN_ORACLE_MATRIX.find(entry => entry.alias === 'pm-npm-9')!
    const files = createNativeLock(adapter, {
      'package.json': `${JSON.stringify({
        name: 'lockgraph-frozen-oracle-empty',
        version: '1.0.0',
        private: true,
        packageManager: packageManager(adapter),
      }, null, 2)}\n`,
    })
    const prepared = await prepareFrozen(String(files[lockPath(adapter)]!), {
      from: adapter.format,
      to: adapter.format,
      sourceVersion: adapter.version,
      targetVersion: adapter.version,
      manifestCoverage: 'complete',
      manifests: {
        '': {
          name: 'lockgraph-frozen-oracle-empty',
          version: '1.0.0',
          overrides: [],
        },
      },
    })
    expect(
      prepared.candidate,
      JSON.stringify(prepared.assessment.diagnostics, null, 2),
    ).toBeDefined()

    const oracle = runFrozenOracle(prepared.candidate!, adapter, files)
    expect(oracle.reason).toBeUndefined()
    expect(oracle.receipt).toBeDefined()

    const certified = certifyFrozen(prepared.candidate!, oracle.receipt!)
    expect(certified.assessment.status).toBe('satisfied')
    expect(certified.lockfile).toBe(prepared.candidate!.lockfile)
    expect(certified.companions).toBe(prepared.candidate!.companions)
  }, 60_000)

  for (const adapter of FROZEN_ORACLE_MATRIX) {
    const runnable = adapter.nodeRange !== undefined
      && !semver.satisfies(process.versions.node, adapter.nodeRange)
      ? it.skip
      : it
    runnable(`${adapter.alias} accepts one exact byte-stable candidate`, () => {
      const { candidate, files } = nativeCandidate(adapter)
      const oracle = runFrozenOracle(candidate, adapter, files)
      expect(oracle.reason).toBeUndefined()
      expect(oracle.receipt).toBeDefined()
      expect(oracle.receipt).toMatchObject({
        target: candidate.target,
        projectionDigest: candidate.projectionDigest,
        verification: 'frozen-verified',
      })
    }, 60_000)
  }

  for (const family of ['npm', 'yarn-classic', 'yarn-berry', 'pnpm'] as const) {
    const adapter = FROZEN_ORACLE_MATRIX.find(entry =>
      entry.family === family && (family !== 'pnpm' || entry.version === '7.33.7'))!
    it(`${family} produces no receipt for a manifest that would rewrite the lock`, () => {
      const { candidate, files } = nativeCandidate(adapter)
      const staleManifest = {
        ...JSON.parse(String(files['package.json']!)),
        dependencies: { 'left-pad': '1.3.0' },
      }
      const staleFiles = {
        ...files,
        'package.json': `${JSON.stringify(staleManifest, null, 2)}\n`,
      }
      const oracle = runFrozenOracle(candidate, adapter, staleFiles)
      expect(oracle.receipt).toBeUndefined()
      expect(oracle.reason).toMatch(/rejected|changed|output/)
    }, 60_000)
  }

  it('pins narrow family-specific generated-output allowlists in both directions', () => {
    const families: readonly FrozenOracleFamily[] = ['npm', 'yarn-classic', 'yarn-berry', 'pnpm']
    for (const family of families) {
      expect(isFrozenOracleOutputAllowed(family, 'node_modules/.state')).toBe(true)
      expect(isFrozenOracleOutputAllowed(family, 'package.json')).toBe(false)
      expect(isFrozenOracleOutputAllowed(family, 'package-lock.json')).toBe(false)
      expect(isFrozenOracleOutputAllowed(family, 'pnpm-lock.yaml')).toBe(false)
      expect(isFrozenOracleOutputAllowed(family, 'yarn.lock')).toBe(false)
      expect(isFrozenOracleOutputAllowed(family, '.npmrc')).toBe(false)
      expect(isFrozenOracleOutputAllowed(family, '.yarnrc.yml')).toBe(false)
      expect(isFrozenOracleOutputAllowed(family, 'pnpm-workspace.yaml')).toBe(false)
      expect(isFrozenOracleOutputAllowed(family, 'patches/change.patch')).toBe(false)
    }
    expect(isFrozenOracleOutputAllowed('yarn-berry', '.yarn/install-state.gz')).toBe(true)
    expect(isFrozenOracleOutputAllowed('yarn-berry', '.yarn/cache/pkg.zip')).toBe(true)
    expect(isFrozenOracleOutputAllowed('npm', '.yarn/install-state.gz')).toBe(false)
    expect(isFrozenOracleOutputAllowed('pnpm', '.pnpm-store/state.json')).toBe(false)
  })
})
