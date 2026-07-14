import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, posix, resolve, sep } from 'node:path'
import type {
  CompanionSetOperation,
  FormatId,
  FrozenVerificationSubject,
  FrozenVerificationReceipt,
} from '../../main/ts/index.ts'

export type FrozenOracleFamily = 'npm' | 'yarn-classic' | 'yarn-berry' | 'pnpm' | 'bun'

export interface FrozenOracleAdapter {
  readonly family: FrozenOracleFamily
  readonly format: FormatId
  readonly version: string
  readonly alias: string
  readonly binName: 'npm' | 'yarn' | 'pnpm' | 'bun'
  readonly runtime?: 'node' | 'native'
  readonly nativeLockfileVersion?: 1 | 2 | 3
  readonly nativeYarnLockfileVersion?: 1 | 4 | 5 | 6 | 7 | 8 | 9
  readonly nativePnpmLockfileVersion?: '5.3' | '5.4' | '6.0' | '9.0'
  readonly nativeBunLockfileVersion?: 1
  readonly nodeRange?: string
  readonly nodeBinaryEnv?: 'LOCKGRAPH_PNPM6_NODE'
}

export interface FrozenOracleResult {
  readonly receipt?: FrozenVerificationReceipt
  readonly reason?: string
}

export interface FrozenOracleCandidate extends FrozenVerificationSubject {
  readonly lockfile: string
  readonly companions: readonly CompanionSetOperation[]
}

export const FROZEN_ORACLE_MATRIX: readonly FrozenOracleAdapter[] = Object.freeze([
  {
    family: 'npm', format: 'npm-1', version: '6.14.18', alias: 'pm-npm-6', binName: 'npm',
    nativeLockfileVersion: 1, nodeRange: '6 >=6.2.0 || 8 || >=9.3.0',
  },
  {
    family: 'npm', format: 'npm-2', version: '7.24.2', alias: 'pm-npm-7', binName: 'npm',
    nativeLockfileVersion: 2, nodeRange: '>=10',
  },
  {
    family: 'npm', format: 'npm-2', version: '8.19.4', alias: 'pm-npm-8', binName: 'npm',
    nativeLockfileVersion: 2, nodeRange: '^12.13.0 || ^14.15.0 || >=16.0.0',
  },
  {
    family: 'npm', format: 'npm-3', version: '9.9.4', alias: 'pm-npm-9', binName: 'npm',
    nativeLockfileVersion: 3, nodeRange: '^14.17.0 || ^16.13.0 || >=18.0.0',
  },
  {
    family: 'npm', format: 'npm-3', version: '10.9.8', alias: 'pm-npm-10', binName: 'npm',
    nativeLockfileVersion: 3, nodeRange: '^18.17.0 || >=20.5.0',
  },
  {
    family: 'npm', format: 'npm-3', version: '11.18.0', alias: 'pm-npm-11', binName: 'npm',
    nativeLockfileVersion: 3, nodeRange: '^20.17.0 || >=22.9.0',
  },
  {
    family: 'npm',
    format: 'npm-3',
    version: '12.0.1',
    alias: 'pm-npm-12',
    binName: 'npm',
    nativeLockfileVersion: 3,
    nodeRange: '^22.22.2 || ^24.15.0 || >=26.0.0',
  },
  {
    family: 'yarn-classic', format: 'yarn-classic', version: '1.22.22', alias: 'pm-yarn-1', binName: 'yarn',
    nativeYarnLockfileVersion: 1, nodeRange: '>=4.0.0',
  },
  {
    family: 'yarn-berry', format: 'yarn-berry-v4', version: '2.4.3', alias: 'pm-yarn-2', binName: 'yarn',
    nativeYarnLockfileVersion: 4, nodeRange: '>=10',
  },
  {
    family: 'yarn-berry', format: 'yarn-berry-v5', version: '3.1.1', alias: 'pm-yarn-berry-v5', binName: 'yarn',
    nativeYarnLockfileVersion: 5, nodeRange: '>=12 <14 || 14.2 - 14.9 || >14.10.0',
  },
  {
    family: 'yarn-berry', format: 'yarn-berry-v6', version: '3.8.7', alias: 'pm-yarn-berry-v6', binName: 'yarn',
    nativeYarnLockfileVersion: 6, nodeRange: '>=12 <14 || 14.2 - 14.9 || >14.10.0',
  },
  {
    family: 'yarn-berry', format: 'yarn-berry-v7', version: '4.0.0-rc.46', alias: 'pm-yarn-berry-v7', binName: 'yarn',
    nativeYarnLockfileVersion: 7, nodeRange: '>=14.15.0',
  },
  {
    family: 'yarn-berry', format: 'yarn-berry-v8', version: '4.13.0', alias: 'pm-yarn-berry-v8', binName: 'yarn',
    nativeYarnLockfileVersion: 8, nodeRange: '>=18.12.0',
  },
  {
    family: 'yarn-berry', format: 'yarn-berry-v9', version: '4.14.1', alias: 'pm-yarn-berry-v9', binName: 'yarn',
    nativeYarnLockfileVersion: 9, nodeRange: '>=18.12.0',
  },
  {
    family: 'pnpm',
    format: 'pnpm-v5',
    version: '6.35.1',
    alias: 'pm-pnpm-6',
    binName: 'pnpm',
    nativePnpmLockfileVersion: '5.3',
    nodeRange: '>=12.17',
    nodeBinaryEnv: 'LOCKGRAPH_PNPM6_NODE',
  },
  {
    family: 'pnpm', format: 'pnpm-v5', version: '7.33.7', alias: 'pm-pnpm-7', binName: 'pnpm',
    nativePnpmLockfileVersion: '5.4', nodeRange: '>=14.6',
  },
  {
    family: 'pnpm', format: 'pnpm-v6', version: '8.15.9', alias: 'pm-pnpm-8', binName: 'pnpm',
    nativePnpmLockfileVersion: '6.0', nodeRange: '>=16.14',
  },
  {
    family: 'pnpm', format: 'pnpm-v9', version: '9.15.9', alias: 'pm-pnpm-9', binName: 'pnpm',
    nativePnpmLockfileVersion: '9.0', nodeRange: '>=18.12',
  },
  {
    family: 'pnpm', format: 'pnpm-v9', version: '10.34.5', alias: 'pm-pnpm-10', binName: 'pnpm',
    nativePnpmLockfileVersion: '9.0', nodeRange: '>=18.12',
  },
  {
    family: 'bun', format: 'bun-text', version: '1.3.14', alias: 'bun', binName: 'bun',
    runtime: 'native', nativeBunLockfileVersion: 1,
  },
])

const LOCK_PATH: Readonly<Partial<Record<FormatId, string>>> = Object.freeze({
  'npm-1': 'package-lock.json',
  'npm-2': 'package-lock.json',
  'npm-3': 'package-lock.json',
  'yarn-classic': 'yarn.lock',
  'yarn-berry-v4': 'yarn.lock',
  'yarn-berry-v5': 'yarn.lock',
  'yarn-berry-v6': 'yarn.lock',
  'yarn-berry-v7': 'yarn.lock',
  'yarn-berry-v8': 'yarn.lock',
  'yarn-berry-v9': 'yarn.lock',
  'pnpm-v5': 'pnpm-lock.yaml',
  'pnpm-v6': 'pnpm-lock.yaml',
  'pnpm-v9': 'pnpm-lock.yaml',
  'bun-text': 'bun.lock',
})

function sha256(bytes: string | Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

function safePath(path: string): string {
  if (path.length === 0 || path.includes('\\') || posix.isAbsolute(path)) {
    throw new TypeError(`unsafe oracle input path: ${JSON.stringify(path)}`)
  }
  const normalized = posix.normalize(path)
  if (normalized === '..' || normalized.startsWith('../') || normalized !== path) {
    throw new TypeError(`unsafe oracle input path: ${JSON.stringify(path)}`)
  }
  return normalized
}

function resolveInside(root: string, path: string): string {
  const normalized = safePath(path)
  const absolute = resolve(root, ...normalized.split('/'))
  if (!absolute.startsWith(`${root}${sep}`)) throw new TypeError(`oracle path escapes root: ${path}`)
  return absolute
}

function resolveBin(adapter: FrozenOracleAdapter): string {
  const root = resolve(process.cwd(), 'node_modules', adapter.alias)
  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
    bin?: string | Readonly<Record<string, string>>
  }
  const relative = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.[adapter.binName]
  if (relative === undefined) throw new Error(`${adapter.alias} has no ${adapter.binName} binary`)
  return resolve(root, relative)
}

function argvFor(adapter: FrozenOracleAdapter, mode: 'create' | 'frozen'): readonly string[] {
  if (adapter.family === 'npm') {
    return mode === 'create'
      ? ['install', '--package-lock-only', '--ignore-scripts', '--audit=false', '--fund=false']
      : ['ci', '--ignore-scripts', '--audit=false', '--fund=false']
  }
  if (adapter.family === 'yarn-classic') {
    return mode === 'create'
      ? ['install', '--ignore-scripts', '--non-interactive']
      : ['install', '--frozen-lockfile', '--ignore-scripts', '--non-interactive']
  }
  if (adapter.family === 'yarn-berry') {
    return mode === 'create'
      ? adapter.nativeYarnLockfileVersion === 4
        ? ['install']
        : ['install', '--no-immutable']
      : ['install', '--immutable']
  }
  if (adapter.family === 'bun') {
    return mode === 'create'
      ? ['install', '--lockfile-only', '--ignore-scripts']
      : ['install', '--frozen-lockfile', '--ignore-scripts']
  }
  return mode === 'create'
    ? ['install', '--lockfile-only', '--ignore-scripts']
    : ['install', '--frozen-lockfile', '--ignore-scripts']
}

function commandFor(adapter: FrozenOracleAdapter, binary: string, argv: readonly string[]): {
  readonly command: string
  readonly args: readonly string[]
} {
  const skipReason = frozenOracleSkipReason(adapter)
  if (skipReason !== undefined) throw new Error(skipReason)
  if (adapter.runtime === 'native') return { command: binary, args: argv }
  const command = adapter.nodeBinaryEnv === undefined
    ? process.execPath
    : process.env[adapter.nodeBinaryEnv]!
  return { command, args: [binary, ...argv] }
}

export function frozenOracleSkipReason(adapter: FrozenOracleAdapter): string | undefined {
  if (adapter.nodeBinaryEnv === undefined) return undefined
  const configured = process.env[adapter.nodeBinaryEnv]
  return configured === undefined || configured.length === 0
    ? `${adapter.nodeBinaryEnv} is not configured for ${adapter.alias}`
    : undefined
}

// Windows resolves the per-user home and config roots from USERPROFILE/APPDATA/LOCALAPPDATA. The
// isolated environment is a fresh object (it deliberately does not inherit process.env), so on win32
// those are undefined and @pnpm/npm-conf calls path.resolve(undefined) -> ERR_INVALID_ARG_TYPE before
// any lock work happens. Point the config roots into `base` to keep the run hermetic, and inherit only
// the OS plumbing a Windows subprocess needs (SystemRoot for crypto/DNS, PATHEXT/COMSPEC for spawn).
// Returns {} off win32, so Linux/macOS environments are byte-identical to before.
function windowsEnvironment(base: string, home: string): NodeJS.ProcessEnv {
  if (process.platform !== 'win32') return {}
  const appData = resolve(base, 'appdata')
  const localAppData = resolve(base, 'localappdata')
  const temp = resolve(base, 'temp')
  mkdirSync(appData, { recursive: true })
  mkdirSync(localAppData, { recursive: true })
  mkdirSync(temp, { recursive: true })
  const inherit = (name: string): NodeJS.ProcessEnv => {
    const value = process.env[name]
    return value === undefined ? {} : { [name]: value }
  }
  return {
    USERPROFILE: home,
    APPDATA: appData,
    LOCALAPPDATA: localAppData,
    TEMP: temp,
    TMP: temp,
    ...inherit('SystemRoot'),
    ...inherit('PATHEXT'),
    ...inherit('COMSPEC'),
  }
}

function isolatedEnvironment(base: string, family: FrozenOracleFamily): NodeJS.ProcessEnv {
  const home = resolve(base, 'home')
  const cache = resolve(base, 'cache')
  mkdirSync(home, { recursive: true })
  mkdirSync(cache, { recursive: true })
  const registry = process.env.LOCKGRAPH_TEST_REGISTRY
  return {
    HOME: home,
    PATH: process.env.PATH ?? '',
    CI: '1',
    NO_COLOR: '1',
    npm_config_cache: cache,
    npm_config_update_notifier: 'false',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    PNPM_HOME: resolve(base, 'pnpm-home'),
    COREPACK_ENABLE_PROJECT_SPEC: '0',
    LOCKGRAPH_ORACLE_FAMILY: family,
    ...windowsEnvironment(base, home),
    ...(family === 'bun' ? {
      BUN_INSTALL_CACHE_DIR: cache,
    } : {}),
    ...(family === 'yarn-classic' ? {
      YARN_CACHE_FOLDER: cache,
    } : {}),
    ...(family === 'yarn-berry' ? {
      YARN_ENABLE_GLOBAL_CACHE: 'false',
      YARN_ENABLE_SCRIPTS: 'false',
    } : {}),
    ...(registry === undefined || (family !== 'npm' && family !== 'pnpm' && family !== 'bun') ? {} : {
      npm_config_registry: registry,
    }),
    ...(registry === undefined || family !== 'yarn-classic' ? {} : {
      YARN_REGISTRY: registry,
    }),
    ...(registry === undefined || family !== 'yarn-berry' ? {} : {
      YARN_NPM_REGISTRY_SERVER: registry,
    }),
  }
}

function run(
  adapter: FrozenOracleAdapter,
  binary: string,
  argv: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): ReturnType<typeof spawnSync> {
  const command = commandFor(adapter, binary, argv)
  return spawnSync(command.command, command.args, {
    cwd,
    env,
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: 30_000,
  })
}

function jsonPointerSet(document: unknown, pointer: string, value: unknown): unknown {
  if (pointer === '') return value
  if (!pointer.startsWith('/')) throw new TypeError(`invalid companion JSON pointer: ${pointer}`)
  if (document === null || typeof document !== 'object' || Array.isArray(document)) {
    throw new TypeError('companion carrier is not a JSON object')
  }
  const segments = pointer.slice(1).split('/').map(segment =>
    segment.replaceAll('~1', '/').replaceAll('~0', '~'))
  let cursor = document as Record<string, unknown>
  for (const segment of segments.slice(0, -1)) {
    const next = cursor[segment]
    if (next === undefined) cursor[segment] = {}
    else if (next === null || typeof next !== 'object' || Array.isArray(next)) {
      throw new TypeError(`companion pointer crosses non-object segment: ${segment}`)
    }
    cursor = cursor[segment] as Record<string, unknown>
  }
  cursor[segments[segments.length - 1]!] = value
  return document
}

function applyCompanions(root: string, operations: readonly CompanionSetOperation[]): void {
  for (const operation of operations) {
    const carrier = resolveInside(root, operation.path)
    if (operation.op !== 'set') throw new TypeError(`unsupported companion operation: ${operation.op}`)
    let document: unknown
    try {
      document = JSON.parse(readFileSync(carrier, 'utf8'))
    } catch {
      throw new TypeError(`companion carrier is missing or not JSON: ${operation.path}`)
    }
    jsonPointerSet(document, operation.pointer, operation.value)
    writeFileSync(carrier, `${JSON.stringify(document, null, 2)}\n`)
  }
}

interface TreeEntry {
  readonly kind: 'file' | 'symlink'
  readonly mode: number
  readonly bytes: string
}

function snapshotTree(root: string): ReadonlyMap<string, TreeEntry> {
  const entries = new Map<string, TreeEntry>()
  const visit = (absolute: string, relative: string): void => {
    for (const name of readdirSync(absolute).sort()) {
      const path = relative === '' ? name : `${relative}/${name}`
      const target = resolve(absolute, name)
      const stat = lstatSync(target)
      if (stat.isDirectory()) visit(target, path)
      else if (stat.isFile()) entries.set(path, {
        kind: 'file',
        mode: stat.mode & 0o777,
        bytes: readFileSync(target).toString('base64'),
      })
      else if (stat.isSymbolicLink()) entries.set(path, {
        kind: 'symlink',
        mode: stat.mode & 0o777,
        bytes: Buffer.from(readlinkSync(target)).toString('base64'),
      })
      else throw new TypeError(`unsupported oracle tree entry: ${path}`)
    }
  }
  visit(root, '')
  return entries
}

function treeDigest(tree: ReadonlyMap<string, TreeEntry>): string {
  return sha256(JSON.stringify([...tree].map(([path, entry]) => [path, entry.kind, entry.mode, entry.bytes])))
}

export function isFrozenOracleOutputAllowed(
  family: FrozenOracleFamily,
  path: string,
): boolean {
  if (path === 'node_modules' || path.startsWith('node_modules/')) return true
  if (family !== 'yarn-berry') return false
  return path === '.pnp.cjs'
    || path === '.pnp.loader.mjs'
    || path === '.yarn/install-state.gz'
    || path.startsWith('.yarn/cache/')
    || path.startsWith('.yarn/unplugged/')
}

function unchangedInputs(
  before: ReadonlyMap<string, TreeEntry>,
  after: ReadonlyMap<string, TreeEntry>,
): string | undefined {
  for (const [path, entry] of before) {
    const observed = after.get(path)
    if (observed === undefined || JSON.stringify(observed) !== JSON.stringify(entry)) {
      return `pre-existing input changed: ${path}`
    }
  }
  return undefined
}

function unknownOutput(
  family: FrozenOracleFamily,
  before: ReadonlyMap<string, TreeEntry>,
  after: ReadonlyMap<string, TreeEntry>,
): string | undefined {
  for (const path of after.keys()) {
    if (!before.has(path) && !isFrozenOracleOutputAllowed(family, path)) return path
  }
  return undefined
}

export function runFrozenOracle(
  candidate: FrozenOracleCandidate,
  adapter: FrozenOracleAdapter,
  files: Readonly<Record<string, string | Uint8Array>>,
): FrozenOracleResult {
  const skipReason = frozenOracleSkipReason(adapter)
  if (skipReason !== undefined) return { reason: `oracle skipped: ${skipReason}` }
  if (candidate.target.format !== adapter.format || candidate.target.managerVersion !== adapter.version) {
    return { reason: 'candidate target does not match calibrated adapter' }
  }
  const lockPath = LOCK_PATH[adapter.format]
  if (lockPath === undefined) return { reason: 'target has no calibrated lock path' }
  const base = mkdtempSync(resolve(tmpdir(), 'lockgraph-frozen-oracle-'))
  const root = resolve(base, 'project')
  mkdirSync(root)
  try {
    for (const [path, bytes] of Object.entries(files)) {
      const target = resolveInside(root, path)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, bytes)
      chmodSync(target, 0o644)
    }
    const lock = resolveInside(root, lockPath)
    mkdirSync(dirname(lock), { recursive: true })
    writeFileSync(lock, candidate.lockfile)
    chmodSync(lock, 0o644)
    applyCompanions(root, candidate.companions)

    const before = snapshotTree(root)
    if ([...before.values()].some(entry => entry.kind === 'symlink')) {
      return { reason: 'caller input contains a symlink' }
    }
    const binary = resolveBin(adapter)
    const env = isolatedEnvironment(base, adapter.family)
    const versionRun = run(adapter, binary, ['--version'], root, env)
    const version = typeof versionRun.stdout === 'string' ? versionRun.stdout.trim() : ''
    if (versionRun.status !== 0 || versionRun.signal !== null || version !== adapter.version) {
      return { reason: `exact package-manager version unavailable: ${JSON.stringify(version)}` }
    }

    const argv = argvFor(adapter, 'frozen')
    const executed = run(adapter, binary, argv, root, env)
    if (executed.error !== undefined) return { reason: executed.error.message }
    if (executed.status !== 0 || executed.signal !== null) {
      return { reason: `frozen command rejected candidate (status=${String(executed.status)}, signal=${String(executed.signal)})` }
    }

    const after = snapshotTree(root)
    const mutation = unchangedInputs(before, after)
    if (mutation !== undefined) return { reason: mutation }
    const extra = unknownOutput(adapter.family, before, after)
    if (extra !== undefined) return { reason: `unknown package-manager output: ${extra}` }
    const command = commandFor(adapter, binary, argv)
    const configDigest = sha256(JSON.stringify({
      protocol: 'lockgraph-native-frozen/v1',
      family: adapter.family,
      binary: sha256(readFileSync(binary)),
      command: command.command === process.execPath
        ? sha256(readFileSync(process.execPath))
        : command.command === binary
          ? sha256(readFileSync(binary))
          : command.command,
      argv: command.args,
      node: process.version,
      env: Object.fromEntries(Object.entries(env).sort()),
    }))
    return {
      receipt: Object.freeze({
        protocol: 'lockgraph-frozen-projection/v1',
        target: candidate.target,
        projectionDigest: candidate.projectionDigest,
        verification: 'frozen-verified',
        platform: `${process.platform}-${process.arch}`,
        configDigest,
        inputDigest: treeDigest(before),
        oracle: Object.freeze({
          protocol: 'lockgraph-native-frozen/v1',
          runner: 'lockgraph-test-oracle',
          version: '1.0.0',
        }),
      }),
    }
  } catch (error) {
    return { reason: error instanceof Error ? error.message : 'frozen oracle failed' }
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
}

export function createNativeLock(
  adapter: FrozenOracleAdapter,
  files: Readonly<Record<string, string | Uint8Array>>,
): Readonly<Record<string, string | Uint8Array>> {
  const lockPath = LOCK_PATH[adapter.format]
  if (lockPath === undefined) throw new Error('target has no calibrated lock path')
  const base = mkdtempSync(resolve(tmpdir(), 'lockgraph-native-lock-'))
  const root = resolve(base, 'project')
  mkdirSync(root)
  try {
    for (const [path, bytes] of Object.entries(files)) {
      const target = resolveInside(root, path)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, bytes)
    }
    const binary = resolveBin(adapter)
    const env = isolatedEnvironment(base, adapter.family)
    const versionRun = run(adapter, binary, ['--version'], root, env)
    if (versionRun.status !== 0 || String(versionRun.stdout).trim() !== adapter.version) {
      throw new Error(`unable to run exact ${adapter.alias}`)
    }
    const created = run(adapter, binary, argvFor(adapter, 'create'), root, env)
    if (created.status !== 0 || created.signal !== null) {
      throw new Error(`native lock creation failed (status=${String(created.status)}, signal=${String(created.signal)}): ${String(created.stdout)}\n${String(created.stderr)}\n${created.error?.message ?? ''}`)
    }
    const result: Record<string, string | Uint8Array> = {}
    for (const path of Object.keys(files)) {
      result[path] = typeof files[path] === 'string'
        ? readFileSync(resolveInside(root, path), 'utf8')
        : readFileSync(resolveInside(root, path))
    }
    try {
      result[lockPath] = readFileSync(resolveInside(root, lockPath), 'utf8')
    } catch (error) {
      throw new Error(`native lock was not created by ${adapter.alias}: ${String(created.stdout)}\n${String(created.stderr)}`, { cause: error })
    }
    return Object.freeze(result)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
}
