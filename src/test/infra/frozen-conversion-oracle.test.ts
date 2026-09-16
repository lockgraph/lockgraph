import semver from 'semver'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  certifyFrozen,
  convert,
  prepareFrozen,
} from '../../main/ts/convert/orchestrator.ts'
import type {
  Packument,
  PackumentVersion,
  RemoteArtifactRegistry,
} from '../../main/ts/registry/types.ts'
import {
  createNativeLock,
  FROZEN_ORACLE_MATRIX,
  frozenOracleSkipReason,
  isFrozenOracleOutputAllowed,
  runFrozenOracle,
  type FrozenOracleCandidate,
  type FrozenOracleAdapter,
  type FrozenOracleFamily,
} from '../helpers/frozen-oracle.ts'
import {
  startFrozenRegistry,
  stopFrozenRegistry,
  type FrozenRegistryProcess,
} from '../helpers/frozen-registry-process.ts'

const here = dirname(fileURLToPath(import.meta.url))
const tarballPath = resolve(here, '../resources/fixtures/tarballs/ms-2.1.3.tgz')
const denoNpmOnlyPath = resolve(
  here,
  '../resources/fixtures/lockfiles/deno-npm-only/deno.lock',
)
const registryScript = resolve(here, '../helpers/frozen-registry.mjs')
let registry: FrozenRegistryProcess | undefined

const adapterSelector = (() => {
  const raw = process.env.LOCKGRAPH_FROZEN_ORACLE_ADAPTERS
  if (raw === undefined) return undefined
  const selected = new Set(raw.split(',').map(alias => alias.trim()).filter(Boolean))
  if (selected.size === 0) throw new Error('LOCKGRAPH_FROZEN_ORACLE_ADAPTERS selects no adapters')
  const known = new Set(FROZEN_ORACLE_MATRIX.map(adapter => adapter.alias))
  for (const alias of selected) {
    if (!known.has(alias)) throw new Error(`unknown frozen oracle adapter: ${alias}`)
  }
  return selected
})()

function adapterSelected(adapter: FrozenOracleAdapter): boolean {
  return adapterSelector === undefined || adapterSelector.has(adapter.alias)
}

const fullMatrixIt = adapterSelector === undefined ? it : it.skip

beforeAll(async () => {
  registry = await startFrozenRegistry(registryScript, [tarballPath])
  if (registry.registry !== undefined) {
    process.env.LOCKGRAPH_TEST_REGISTRY = registry.registry
  }
})

afterAll(async () => {
  delete process.env.LOCKGRAPH_TEST_REGISTRY
  await stopFrozenRegistry(registry?.child)
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
          '.yarnrc.yml': 'nodeLinker: node-modules\nenableScripts: false\n'
            + 'unsafeHttpWhitelist:\n  - 127.0.0.1\n'
            + (adapter.format === 'yarn-berry-v10' ? 'npmMinimalAgeGate: 0\n' : ''),
        }
      : {}),
  }
}

function lockPath(adapter: FrozenOracleAdapter): string {
  if (adapter.family === 'npm') return 'package-lock.json'
  if (adapter.family === 'pnpm') return 'pnpm-lock.yaml'
  if (adapter.family === 'bun') return 'bun.lock'
  return 'yarn.lock'
}

function nativeYarnLockfileVersion(
  adapter: FrozenOracleAdapter,
  lockfile: string,
): number | undefined {
  if (adapter.family === 'yarn-classic') {
    const observed = lockfile.match(/^# yarn lockfile v(\d+)[ \t]*\r?$/m)?.[1]
    return observed === undefined ? undefined : Number(observed)
  }
  if (adapter.family === 'yarn-berry') {
    const observed = lockfile.match(
      /^__metadata:[ \t]*\r?\n[ \t]+version:[ \t]+(\d+)[ \t]*\r?$/m,
    )?.[1]
    return observed === undefined ? undefined : Number(observed)
  }
  return undefined
}

function runnableFor(adapter: FrozenOracleAdapter): {
  readonly run: typeof it | typeof it.skip
  readonly suffix: string
} {
  const reason = frozenOracleSkipReason(adapter)
    ?? (adapter.nodeRange !== undefined && !semver.satisfies(process.versions.node, adapter.nodeRange)
      ? `Node ${process.versions.node} does not satisfy ${adapter.nodeRange}`
      : undefined)
  return reason === undefined
    ? { run: it, suffix: '' }
    : { run: it.skip, suffix: ` [skip: ${reason}]` }
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

const DENO_FORWARD_ORACLE_ALIASES = Object.freeze([
  'pm-npm-6',
  'pm-npm-8',
  'pm-npm-11',
  'pm-yarn-1',
  'pm-yarn-2',
  'pm-yarn-berry-v5',
  'pm-yarn-berry-v6',
  'pm-yarn-berry-v7',
  'pm-yarn-berry-v8',
  'pm-yarn-berry-v9',
  'pm-yarn-berry-v10',
  'pm-pnpm-7',
  'pm-pnpm-8',
  'pm-pnpm-10',
  'bun',
  'pm-bun-v2',
] as const)

function denoForwardCandidate(
  adapter: FrozenOracleAdapter,
  lockfile: string,
): FrozenOracleCandidate {
  const projectionDigest = `sha256:${createHash('sha256').update(JSON.stringify({
    target: { format: adapter.format, managerVersion: adapter.version },
    lockfile,
    companions: [],
  })).digest('hex')}`
  return Object.freeze({
    protocol: 'lockgraph-frozen-projection/v1',
    target: Object.freeze({ format: adapter.format, managerVersion: adapter.version }),
    projectionDigest,
    lockfile,
    companions: Object.freeze([]),
  })
}

describe('infra: frozen conversion native oracle', () => {
  beforeEach(context => {
    if (registry?.unavailableReason !== undefined) {
      context.skip(registry.unavailableReason)
    }
  })

  fullMatrixIt('certifies the exact core candidate bundle after a real pinned native verdict', async () => {
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

  fullMatrixIt('accepts a converted bun-text candidate with the exact pinned Bun binary', async () => {
    const adapter = FROZEN_ORACLE_MATRIX.find(entry => entry.family === 'bun')!
    const files = createNativeLock(adapter, projectFiles(adapter))
    const lockfile = await convert(String(files[lockPath(adapter)]!), {
      from: adapter.format,
      to: adapter.format,
      strict: false,
      manifests: {
        '': {
          name: 'lockgraph-frozen-oracle-case',
          dependencies: { ms: '2.1.3' },
          overrides: [],
        },
      },
    })
    expect(lockfile).toMatch(/^\s*"lockfileVersion":\s*1,?\s*$/m)
    const projectionDigest = `sha256:${createHash('sha256').update(JSON.stringify({
      target: { format: adapter.format, managerVersion: adapter.version },
      lockfile,
      companions: [],
    })).digest('hex')}`
    const candidate: FrozenOracleCandidate = Object.freeze({
      protocol: 'lockgraph-frozen-projection/v1',
      target: Object.freeze({ format: adapter.format, managerVersion: adapter.version }),
      projectionDigest,
      lockfile,
      companions: Object.freeze([]),
    })

    const oracle = runFrozenOracle(candidate, adapter, files)
    expect(oracle.reason).toBeUndefined()
    expect(oracle.receipt).toBeDefined()
    expect(oracle.receipt!.configDigest).toMatch(/^sha256:[a-f0-9]{64}$/)
  }, 60_000)

  const pnpm12 = FROZEN_ORACLE_MATRIX.find(entry => entry.alias === 'pm-pnpm-12')!
  if (adapterSelected(pnpm12)) {
    const runnable = runnableFor(pnpm12)
    runnable.run(`pm-pnpm-12 reads overrides only from pnpm-workspace.yaml${runnable.suffix}`, () => {
      const baseManifest = {
        name: 'lockgraph-pnpm-12-overrides',
        version: '1.0.0',
        private: true,
        packageManager: packageManager(pnpm12),
        dependencies: { ms: '2.1.3' },
      }
      const manifestCarrier = createNativeLock(pnpm12, {
        'package.json': `${JSON.stringify({
          ...baseManifest,
          pnpm: { overrides: { ms: '2.1.3' } },
        }, null, 2)}\n`,
      })
      const workspaceCarrier = createNativeLock(pnpm12, {
        'package.json': `${JSON.stringify(baseManifest, null, 2)}\n`,
        'pnpm-workspace.yaml': 'overrides:\n  ms: 2.1.3\n',
      })

      expect(String(manifestCarrier['pnpm-lock.yaml'])).not.toMatch(/^overrides:/m)
      expect(String(workspaceCarrier['pnpm-lock.yaml'])).toMatch(/^overrides:\n  ms: 2\.1\.3$/m)
    }, 60_000)
  }

  for (const alias of DENO_FORWARD_ORACLE_ALIASES) {
    const adapter = FROZEN_ORACLE_MATRIX.find(entry => entry.alias === alias)!
    const runnable = runnableFor(adapter)
    runnable.run(
      `deno-v5 -> ${adapter.format} is accepted by ${adapter.alias} frozen mode${runnable.suffix}`,
      async () => {
        const files = createNativeLock(adapter, projectFiles(adapter))
        const source = JSON.parse(readFileSync(denoNpmOnlyPath, 'utf8')) as unknown
        const nativeLockfile = String(files[lockPath(adapter)]!)
        const cacheKey = adapter.family === 'yarn-berry'
          ? nativeLockfile.match(/^\s+cacheKey:\s+(\S+)\s*$/m)?.[1]
          : undefined
        const nativeBerryChecksum = adapter.alias === 'pm-yarn-berry-v7'
          ? nativeLockfile.match(/^\s+checksum:\s+(\S+)\s*$/m)?.[1]
          : undefined
        const lockfile = await convert(`${JSON.stringify(source, null, 2)}\n`, {
          store: false,
          from: 'deno-v5',
          to: adapter.format,
          strict: false,
          targetVersion: adapter.version,
          ...(adapter.family === 'yarn-classic' && registry?.registry !== undefined
            ? { registry: registry.registry }
            : {}),
          ...(cacheKey === undefined ? {} : { cacheKey }),
          manifests: {
            '': {
              name: 'lockgraph-frozen-oracle-case',
              version: '1.0.0',
              dependencies: { ms: '2.1.3' },
              overrides: [],
            },
          },
          sources: {
            artifacts: {
              async tarball(name, version) {
                return name === 'ms' && version === '2.1.3'
                  ? readFileSync(tarballPath)
                  : undefined
              },
              async berryChecksum(name, version, requestedCacheKey) {
                return name === 'ms'
                  && version === '2.1.3'
                  && requestedCacheKey === cacheKey
                  ? nativeBerryChecksum
                  : undefined
              },
            },
          },
        })
        const candidate = denoForwardCandidate(adapter, lockfile)
        const oracle = runFrozenOracle(candidate, adapter, files)
        expect(oracle.reason).toBeUndefined()
        expect(oracle.receipt).toMatchObject({
          target: candidate.target,
          projectionDigest: candidate.projectionDigest,
          verification: 'frozen-verified',
        })
      },
      60_000,
    )
  }

  const remoteArtifactAdapter = FROZEN_ORACLE_MATRIX.find(
    entry => entry.alias === 'pm-yarn-berry-v9',
  )!
  const remoteArtifactRunnable = runnableFor(remoteArtifactAdapter)
  remoteArtifactRunnable.run(
    `verified remote tgz produces a ${remoteArtifactAdapter.alias} immutable candidate${remoteArtifactRunnable.suffix}`,
    async () => {
      const adapter = remoteArtifactAdapter
      const files = createNativeLock(adapter, projectFiles(adapter))
      const nativeLockfile = String(files[lockPath(adapter)]!)
      const cacheKey = nativeLockfile.match(/^\s+cacheKey:\s+(\S+)\s*$/m)?.[1]
      expect(cacheKey).toBeDefined()

      const bytes = readFileSync(tarballPath)
      const artifactUrl = 'https://registry.npmjs.org/ms/-/ms-2.1.3.tgz'
      const version: PackumentVersion = {
        name: 'ms',
        version: '2.1.3',
        tarball: artifactUrl,
      }
      const packument: Packument = {
        name: 'ms',
        distTags: {},
        versions: { '2.1.3': version },
      }
      const fetchArtifact = vi.fn(async () => new Response(bytes))
      const artifactRegistry: RemoteArtifactRegistry = {
        async packument() { return packument },
        async resolve() { return version },
        artifactRoute() {
          return {
            registryUrl: 'https://registry.test/npm',
            fetch: fetchArtifact as unknown as typeof fetch,
            authHeaderFor: () => undefined,
            limit: task => task(),
          }
        },
      }
      const source = JSON.parse(readFileSync(denoNpmOnlyPath, 'utf8')) as unknown
      const diagnostics: unknown[] = []
      const lockfile = await convert(`${JSON.stringify(source, null, 2)}\n`, {
        store: false,
        from: 'deno-v5',
        target: {
          format: adapter.format,
          managerVersion: adapter.version,
        },
        strict: false,
        cacheKey,
        manifests: {
          '': {
            name: 'lockgraph-frozen-oracle-case',
            version: '1.0.0',
            dependencies: { ms: '2.1.3' },
            overrides: [],
          },
        },
        sources: {
          artifacts: [artifactRegistry],
        },
        onDiagnostic(diagnostic) {
          diagnostics.push(diagnostic)
        },
      })
      expect(fetchArtifact, JSON.stringify(diagnostics, null, 2)).toHaveBeenCalledWith(
        artifactUrl,
        expect.objectContaining({ redirect: 'manual' }),
      )

      const candidate = denoForwardCandidate(adapter, lockfile)
      const oracle = runFrozenOracle(candidate, adapter, files)
      expect(oracle.reason).toBeUndefined()
      expect(oracle.receipt).toMatchObject({
        target: candidate.target,
        projectionDigest: candidate.projectionDigest,
        verification: 'frozen-verified',
      })
    },
    60_000,
  )

  fullMatrixIt('materializes external Yarn patch files for frozen verification', () => {
    const adapter = FROZEN_ORACLE_MATRIX.find(entry => entry.alias === 'pm-yarn-berry-v9')!
    const patchPath = '.yarn/patches/ms.patch'
    const patch = `diff --git a/index.js b/index.js
--- a/index.js
+++ b/index.js
@@ -1,5 +1,6 @@
 /**
+ * Lockgraph frozen-oracle external patch marker.
  * Helpers.
  */
${' '}
 var s = 1000;
`
    const manifest = {
      name: 'lockgraph-frozen-oracle-yarn-external-patch',
      version: '1.0.0',
      private: true,
      packageManager: packageManager(adapter),
      dependencies: { ms: '2.1.3' },
      resolutions: {
        'ms@npm:2.1.3': `patch:ms@npm%3A2.1.3#./${patchPath}`,
      },
    }
    const files = createNativeLock(adapter, {
      'package.json': `${JSON.stringify(manifest, null, 2)}\n`,
      '.yarnrc.yml': 'nodeLinker: node-modules\nenableScripts: false\nunsafeHttpWhitelist:\n  - 127.0.0.1\n',
      [patchPath]: patch,
    })
    const lockfile = String(files['yarn.lock'])
    expect(lockfile).toContain(`#./${patchPath}`)
    const projectionDigest = `sha256:${createHash('sha256').update(JSON.stringify({
      target: { format: adapter.format, managerVersion: adapter.version },
      lockfile,
      companions: [],
    })).digest('hex')}`
    const candidate: FrozenOracleCandidate = Object.freeze({
      protocol: 'lockgraph-frozen-projection/v1',
      target: Object.freeze({ format: adapter.format, managerVersion: adapter.version }),
      projectionDigest,
      lockfile,
      companions: Object.freeze([]),
    })

    const oracle = runFrozenOracle(candidate, adapter, files)
    expect(oracle.reason).toBeUndefined()
    expect(oracle.receipt).toMatchObject({
      target: candidate.target,
      projectionDigest,
      verification: 'frozen-verified',
    })
  }, 60_000)

  for (const adapter of FROZEN_ORACLE_MATRIX.filter(adapterSelected)) {
    const runnable = runnableFor(adapter)
    runnable.run(`${adapter.alias} accepts one exact byte-stable candidate${runnable.suffix}`, () => {
      const { candidate, files } = nativeCandidate(adapter)
      if (adapter.family === 'npm') {
        expect(JSON.parse(candidate.lockfile).lockfileVersion).toBe(adapter.nativeLockfileVersion)
      }
      if (adapter.family === 'yarn-classic' || adapter.family === 'yarn-berry') {
        expect(nativeYarnLockfileVersion(adapter, candidate.lockfile))
          .toBe(adapter.nativeYarnLockfileVersion)
      }
      if (adapter.family === 'pnpm') {
        const observed = candidate.lockfile.match(
          /^lockfileVersion:\s*['"]?([^'"\s]+)['"]?\s*$/m,
        )?.[1]
        expect(observed).toBe(adapter.nativePnpmLockfileVersion)
      }
      if (adapter.family === 'bun') {
        const observed = candidate.lockfile.match(
          /^\s*"lockfileVersion":\s*(\d+),?\s*$/m,
        )?.[1]
        expect(observed === undefined ? undefined : Number(observed))
          .toBe(adapter.nativeBunLockfileVersion)
      }
      const oracle = runFrozenOracle(candidate, adapter, files)
      expect(oracle.reason).toBeUndefined()
      expect(oracle.receipt).toBeDefined()
      expect(oracle.receipt).toMatchObject({
        target: candidate.target,
        projectionDigest: candidate.projectionDigest,
        verification: 'frozen-verified',
        platform: `${process.platform}-${process.arch}`,
      })
    }, 60_000)
  }

  const staleAdapters = [
    ...FROZEN_ORACLE_MATRIX.filter(entry => entry.family === 'npm'),
    FROZEN_ORACLE_MATRIX.find(entry => entry.family === 'yarn-classic')!,
    ...FROZEN_ORACLE_MATRIX.filter(entry => entry.family === 'yarn-berry'),
    ...FROZEN_ORACLE_MATRIX.filter(entry => entry.family === 'pnpm'),
    ...FROZEN_ORACLE_MATRIX.filter(entry => entry.family === 'bun'),
  ].filter(adapterSelected)
  for (const adapter of staleAdapters) {
    const runnable = runnableFor(adapter)
    runnable.run(`${adapter.alias} produces no receipt for a manifest that would rewrite the lock${runnable.suffix}`, () => {
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

})

describe('infra: frozen conversion oracle policy', () => {
  it('pins narrow family-specific generated-output allowlists in both directions', () => {
    const families: readonly FrozenOracleFamily[] = ['npm', 'yarn-classic', 'yarn-berry', 'pnpm', 'bun']
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
      expect(isFrozenOracleOutputAllowed(family, '.bun/install/cache/pkg')).toBe(false)
    }
    expect(isFrozenOracleOutputAllowed('yarn-berry', '.yarn/install-state.gz')).toBe(true)
    expect(isFrozenOracleOutputAllowed('yarn-berry', '.yarn/cache/pkg.zip')).toBe(true)
    expect(isFrozenOracleOutputAllowed('npm', '.yarn/install-state.gz')).toBe(false)
    expect(isFrozenOracleOutputAllowed('pnpm', '.pnpm-store/state.json')).toBe(false)
    expect(isFrozenOracleOutputAllowed('bun', 'bun.lockb')).toBe(false)
  })
})
