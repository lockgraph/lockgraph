import { createHash } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { parse, stringify } from '../../main/ts/api/format-api.ts'
import {
  FROZEN_ORACLE_MATRIX,
  runFrozenOracle,
  runMutableLockfileOracle,
  type FrozenOracleAdapter,
  type FrozenOracleCandidate,
} from '../helpers/frozen-oracle.ts'
import {
  startFrozenRegistry,
  stopFrozenRegistry,
  type FrozenRegistryProcess,
} from '../helpers/frozen-registry-process.ts'

const here = dirname(fileURLToPath(import.meta.url))
const tarballPath = resolve(here, '../resources/fixtures/tarballs/ms-2.1.3.tgz')
const registryScript = resolve(here, '../helpers/frozen-registry.mjs')
const adapter = FROZEN_ORACLE_MATRIX.find(entry => entry.alias === 'pm-npm-10')!
const yarnAdapter = FROZEN_ORACLE_MATRIX.find(entry => entry.alias === 'pm-yarn-1')!
let registry: FrozenRegistryProcess | undefined

const pnpm = `lockfileVersion: '9.0'

importers:
  .:
    dependencies:
      ms:
        specifier: 2.1.3
        version: 2.1.3

packages:
  ms@2.1.3:
    resolution: {integrity: sha512-6FlzubTLZG3J2a/NVCAleEhjzq5oxgHyaCU9yYXvcLsvoVaHJq/s5xXI6/XXP6tz7R9xAOtHnSO/tXtF3WRTlA==}

snapshots:
  ms@2.1.3: {}
`

const projectFiles = Object.freeze({
  'package.json': `${JSON.stringify({
    name: 'undetermined-registry-native-oracle',
    version: '1.0.0',
    private: true,
    packageManager: `npm@${adapter.version}`,
    dependencies: { ms: '2.1.3' },
  }, null, 2)}\n`,
})

const yarnLockfile = `# yarn lockfile v1

ms@2.1.3:
  version "2.1.3"
  integrity sha512-6FlzubTLZG3J2a/NVCAleEhjzq5oxgHyaCU9yYXvcLsvoVaHJq/s5xXI6/XXP6tz7R9xAOtHnSO/tXtF3WRTlA==
`

const yarnProjectFiles = Object.freeze({
  'package.json': `${JSON.stringify({
    name: 'undetermined-registry-yarn-native-oracle',
    version: '1.0.0',
    private: true,
    packageManager: `yarn@${yarnAdapter.version}`,
    dependencies: { ms: '2.1.3' },
  }, null, 2)}\n`,
})

beforeAll(async () => {
  registry = await startFrozenRegistry(registryScript, [tarballPath])
  if (registry.registry !== undefined) process.env.LOCKGRAPH_TEST_REGISTRY = registry.registry
})

afterAll(async () => {
  delete process.env.LOCKGRAPH_TEST_REGISTRY
  await stopFrozenRegistry(registry?.child)
})

function candidateFor(nativeAdapter: FrozenOracleAdapter, lockfile: string): FrozenOracleCandidate {
  const target = { format: nativeAdapter.format, managerVersion: nativeAdapter.version } as const
  return Object.freeze({
    protocol: 'lockgraph-frozen-projection/v1',
    target,
    projectionDigest: `sha256:${createHash('sha256').update(lockfile).digest('hex')}`,
    lockfile,
    companions: Object.freeze([]),
  })
}

describe('infra: undetermined registry native npm oracle', () => {
  beforeEach(context => {
    if (registry?.unavailableReason !== undefined) context.skip(registry.unavailableReason)
  })

  it('accepts an emitted npm lock with no fabricated resolved URL', () => {
    expect(registry?.registry).toBeDefined()

    const lockfile = stringify('npm-3', parse('pnpm-v9', pnpm), { strict: false })
    const body = JSON.parse(lockfile) as {
      packages: Record<string, { resolved?: string; integrity?: string }>
    }
    expect(body.packages['node_modules/ms']).toMatchObject({
      integrity: 'sha512-6FlzubTLZG3J2a/NVCAleEhjzq5oxgHyaCU9yYXvcLsvoVaHJq/s5xXI6/XXP6tz7R9xAOtHnSO/tXtF3WRTlA==',
    })
    expect(body.packages['node_modules/ms']?.resolved).toBeUndefined()

    const result = runFrozenOracle(candidateFor(adapter, lockfile), adapter, projectFiles)
    expect(result.reason).toBeUndefined()
    expect(result.receipt).toMatchObject({ verification: 'frozen-verified' })
  }, 60_000)

  it('measures Yarn classic as frozen-readable but producer-unstable without resolved', () => {
    expect(registry?.registry).toBeDefined()

    const frozen = runFrozenOracle(
      candidateFor(yarnAdapter, yarnLockfile),
      yarnAdapter,
      yarnProjectFiles,
    )
    expect(frozen.reason).toBeUndefined()
    expect(frozen.receipt).toMatchObject({ verification: 'frozen-verified' })

    const mutable = runMutableLockfileOracle(yarnLockfile, yarnAdapter, yarnProjectFiles)
    expect(mutable.reason).toBeUndefined()
    expect(mutable.lockfile).not.toBe(yarnLockfile)
    expect(mutable.lockfile).toContain(`resolved "${registry!.registry}ms/-/ms-2.1.3.tgz#`)
  }, 60_000)
})
