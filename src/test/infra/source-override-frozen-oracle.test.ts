import { createHash } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { assertSource, overrideSource } from '../../main/ts/source/operations.ts'
import {
  createNativeLock,
  FROZEN_ORACLE_MATRIX,
  runFrozenOracle,
  type FrozenOracleAdapter,
  type FrozenOracleCandidate,
  type FrozenOracleProjectFiles,
} from '../helpers/frozen-oracle.ts'
import {
  startFrozenRegistry,
  stopFrozenRegistry,
  type FrozenRegistryProcess,
} from '../helpers/frozen-registry-process.ts'

const here = dirname(fileURLToPath(import.meta.url))
const tarballPath = resolve(here, '../resources/fixtures/tarballs/ms-2.1.3.tgz')
const registryScript = resolve(here, '../helpers/frozen-registry.mjs')
let registry: FrozenRegistryProcess | undefined

beforeAll(async () => {
  registry = await startFrozenRegistry(registryScript, [tarballPath])
  if (registry.registry !== undefined) process.env.LOCKGRAPH_TEST_REGISTRY = registry.registry
})

afterAll(async () => {
  delete process.env.LOCKGRAPH_TEST_REGISTRY
  await stopFrozenRegistry(registry?.child)
})

function filesFor(adapter: FrozenOracleAdapter): FrozenOracleProjectFiles {
  return Object.freeze({
    'package.json': `${JSON.stringify({
      name: 'source-override-frozen-oracle',
      version: '1.0.0',
      private: true,
      packageManager: `${adapter.family === 'yarn-classic' ? 'yarn' : adapter.family}@${adapter.version}`,
      dependencies: { ms: '2.1.3' },
    }, null, 2)}\n`,
  })
}

function lockPath(adapter: FrozenOracleAdapter): string {
  return adapter.family === 'npm' ? 'package-lock.json' : 'yarn.lock'
}

function candidate(adapter: FrozenOracleAdapter, lockfile: string): FrozenOracleCandidate {
  return Object.freeze({
    protocol: 'lockgraph-frozen-projection/v1',
    target: Object.freeze({ format: adapter.format, managerVersion: adapter.version }),
    projectionDigest: `sha256:${createHash('sha256').update(lockfile).digest('hex')}`,
    lockfile,
    companions: Object.freeze([]),
  })
}

describe('native frozen source override oracle', () => {
  for (const alias of ['pm-npm-10', 'pm-yarn-1'] as const) {
    const adapter = FROZEN_ORACLE_MATRIX.find(candidateAdapter => candidateAdapter.alias === alias)!
    it(`${alias} accepts the same tarball bytes under the rewritten target prefix`, () => {
      const registryUrl = registry?.registry
      if (registryUrl === undefined) {
        expect(registry?.unavailableReason).toMatch(/loopback bind/u)
        return
      }
      const registryBase = registryUrl.replace(/\/$/u, '')
      const project = filesFor(adapter)
      const native = createNativeLock(adapter, project)
      const original = String(native[lockPath(adapter)])
      const result = overrideSource(
        original,
        `${registryBase}=${registryBase}/mirror`,
        { format: adapter.format },
      )
      expect(result.ok).toBe(true)
      expect(result.counts.rewritten).toBe(1)
      expect(assertSource(result.output, `${registryBase}=${registryBase}/mirror`, {
        format: adapter.format,
      }).ok).toBe(true)
      expect(runFrozenOracle(candidate(adapter, result.output), adapter, project).reason).toBeUndefined()
    }, 60_000)
  }
})
