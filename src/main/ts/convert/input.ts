import path from 'node:path'
import { LockfileError } from '../api/errors.ts'
import { readYaml } from '../formats/_pnpm-yaml.ts'
import type { Diagnostic, Graph, Manifest, OverrideConstraint, OverridePM } from '../graph.ts'
import { evidenceOf, internalEvidenceOf } from '../completeness/evidence.ts'
import { captureOverrides } from '../recipe/overrides.ts'
import { isDenoFormat, type FormatId } from '../api/format-contract.ts'
import { expandBraces, matchesGlobSet } from './glob.ts'
import type {
  ConvertDependencies,
  ConvertFileSystem,
  ConvertInput,
  ProjectInput,
  ProjectPathInput,
} from './types.ts'
import type { FileSource } from '../api/operation.ts'
import type { ManifestCoverage } from '../completeness/types.ts'

// === CONSTANTS ==============================================================

const WINDOWS_DRIVE_RE = /^[A-Za-z]:([\\/]|$)/
const decoder = new TextDecoder('utf-8', { fatal: true })
const CONFIG_NAMES = [
  'pnpm-workspace.yaml',
  '.npmrc',
  '.yarnrc.yml',
  'deno.json',
  'deno.jsonc',
] as const

// === TYPES ==================================================================

type FileRole =
  | { readonly kind: 'lock'; readonly family: 'npm' | 'yarn' | 'pnpm' | 'bun' | 'deno' | 'lockgraph' }
  | { readonly kind: 'manifest' }
  | { readonly kind: 'config' }
  | { readonly kind: 'other' }

interface NormalizedFile {
  readonly path: string
  readonly content: string | Uint8Array
}

export interface PreparedConvertInput {
  readonly lockfile: string
  readonly graph?: Graph
  readonly source: FormatId
  readonly manifests?: Readonly<Record<string, Manifest>>
  readonly manifestCoverage?: ManifestCoverage
  readonly diagnostics: readonly Diagnostic[]
  readonly mode: 'content' | 'graph' | 'project' | 'path'
}

export interface PreparedManifestSource {
  readonly manifests: Readonly<Record<string, Manifest>>
  readonly coverage: ManifestCoverage
  readonly diagnostics: readonly Diagnostic[]
}

interface PrepareOptions {
  readonly from?: FormatId
}

interface PrepareRuntime {
  readonly detect: (input: string) => FormatId | undefined
}

function invalid(message: string, cause?: unknown): LockfileError {
  return new LockfileError({ code: 'INVALID_INPUT', message, ...(cause === undefined ? {} : { cause }) })
}

function detectFailure(message: string): LockfileError {
  return new LockfileError({ code: 'FORMAT_DETECT_FAILED', message })
}

function mismatch(message: string): LockfileError {
  return new LockfileError({ code: 'FORMAT_MISMATCH', message })
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined
}

function isMissing(error: unknown): boolean {
  const code = errorCode(error)
  return code === 'ENOENT' || code === 'ENOTDIR'
}

function decodeText(content: string | Uint8Array, filename: string): string {
  if (typeof content === 'string') return content
  try {
    return decoder.decode(content)
  } catch (cause) {
    throw invalid(`${filename}: content is not valid UTF-8`, cause)
  }
}

function normalizeRelativePath(candidate: string): string {
  if (candidate.includes('\0')) throw invalid('project path must not contain NUL')
  if (candidate.includes('\\')) throw invalid(`project path must use POSIX separators: ${candidate}`)
  if (candidate.startsWith('/') || WINDOWS_DRIVE_RE.test(candidate)) {
    throw invalid(`project path must be relative: ${candidate}`)
  }
  if (candidate.split('/').includes('..')) {
    throw invalid(`project path must not contain traversal segments: ${candidate}`)
  }
  const normalized = path.posix.normalize(candidate)
  if (normalized === '.' || normalized === '') throw invalid(`project path must name a file: ${candidate}`)
  if (normalized === '..' || normalized.startsWith('../')) {
    throw invalid(`project path escapes the project root: ${candidate}`)
  }
  return normalized.startsWith('./') ? normalized.slice(2) : normalized
}

function normalizePattern(candidate: string): string {
  const negative = candidate.startsWith('!')
  const body = negative ? candidate.slice(1) : candidate
  const normalized = normalizeRelativePath(body)
  for (const expanded of expandBraces(normalized)) {
    normalizeRelativePath(expanded)
  }
  return negative ? `!${normalized}` : normalized
}

function classify(filename: string): FileRole {
  const basename = path.posix.basename(filename)
  if (basename === 'package-lock.json' || basename === 'npm-shrinkwrap.json') {
    return { kind: 'lock', family: 'npm' }
  }
  if (basename === 'yarn.lock') return { kind: 'lock', family: 'yarn' }
  if (basename === 'pnpm-lock.yaml') return { kind: 'lock', family: 'pnpm' }
  if (basename === 'bun.lock') return { kind: 'lock', family: 'bun' }
  if (basename === 'deno.lock') return { kind: 'lock', family: 'deno' }
  if (basename.endsWith('.lockgraph')) return { kind: 'lock', family: 'lockgraph' }
  if (basename === 'package.json') return { kind: 'manifest' }
  if (CONFIG_NAMES.some(name => name === basename)) return { kind: 'config' }
  return { kind: 'other' }
}

function familyOf(format: FormatId): Extract<FileRole, { kind: 'lock' }>['family'] {
  if (format.startsWith('npm-')) return 'npm'
  if (format.startsWith('yarn-')) return 'yarn'
  if (format.startsWith('pnpm-')) return 'pnpm'
  if (format === 'bun-text') return 'bun'
  if (isDenoFormat(format)) return 'deno'
  return 'lockgraph'
}

function overridePmOf(format: FormatId): OverridePM {
  if (format.startsWith('yarn-')) return 'yarn'
  if (format.startsWith('pnpm-')) return 'pnpm'
  return 'npm'
}

function stringRecord(value: unknown, label: string): Record<string, string> | undefined {
  if (value === undefined) return undefined
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw invalid(`${label} must be an object`)
  }
  const output: Record<string, string> = {}
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string') throw invalid(`${label}.${key} must be a string`)
    output[key] = item
  }
  return output
}

function workspacesOf(value: unknown, label: string): string[] | undefined {
  if (value === undefined) return undefined
  const candidate = Array.isArray(value)
    ? value
    : value !== null && typeof value === 'object' && Array.isArray((value as { packages?: unknown }).packages)
      ? (value as { packages: unknown[] }).packages
      : undefined
  if (candidate === undefined || candidate.some(item => typeof item !== 'string')) {
    throw invalid(`${label}.workspaces must be a string array or { packages: string[] }`)
  }
  return candidate as string[]
}

function pnpmWorkspacePackages(content: string, filename: string): string[] | undefined {
  let value: unknown
  try {
    value = readYaml(content).packages
  } catch (cause) {
    throw invalid(`${filename}: pnpm workspace parse failed`, cause)
  }
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw invalid(`${filename}.packages must be a string array`)
  }
  return value as string[]
}

export function parseProjectManifest(
  content: string,
  filename: string,
  source: FormatId,
): Manifest {
  let value: unknown
  try {
    value = JSON.parse(content)
  } catch (cause) {
    throw invalid(`${filename}: package.json parse failed`, cause)
  }
  return normalizeProjectManifest(value, filename, source)
}

/** Normalize a package.json object while ignoring fields the graph does not model. */
export function normalizeProjectManifest(
  value: unknown,
  filename: string,
  source: FormatId,
): Manifest {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw invalid(`${filename}: package.json root must be an object`)
  }
  const raw = value as Record<string, unknown>
  const manifest: Manifest = {}
  if (raw.name !== undefined) {
    if (typeof raw.name !== 'string') throw invalid(`${filename}.name must be a string`)
    manifest.name = raw.name
  }
  if (raw.version !== undefined) {
    if (typeof raw.version !== 'string') throw invalid(`${filename}.version must be a string`)
    manifest.version = raw.version
  }
  const dependencyFields = [
    'dependencies',
    'devDependencies',
    'optionalDependencies',
    'peerDependencies',
  ] as const
  for (const field of dependencyFields) {
    const record = stringRecord(raw[field], `${filename}.${field}`)
    if (record !== undefined) manifest[field] = record
  }
  const workspaces = workspacesOf(raw.workspaces, filename)
  if (workspaces !== undefined) manifest.workspaces = workspaces

  const pm = overridePmOf(source)
  const block = pm === 'npm'
    ? raw.overrides
    : pm === 'yarn'
      ? raw.resolutions
      : raw.pnpm !== null && typeof raw.pnpm === 'object' && !Array.isArray(raw.pnpm)
        ? (raw.pnpm as Record<string, unknown>).overrides
        : undefined
  if (block !== undefined) {
    const captured = captureOverrides(block, pm)
    manifest.overrides = materializeOverrides(captured.canonical)
  }
  return manifest
}

function stripJsoncExtensions(input: string): string {
  const output: string[] = []
  let index = 0
  let inString = false
  let escaped = false
  while (index < input.length) {
    const character = input[index]!
    if (inString) {
      output.push(character)
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') inString = false
      index++
      continue
    }
    if (character === '"') {
      inString = true
      output.push(character)
      index++
      continue
    }
    if (character === '/' && input[index + 1] === '/') {
      index += 2
      while (index < input.length && input[index] !== '\n') index++
      continue
    }
    if (character === '/' && input[index + 1] === '*') {
      index += 2
      while (
        index + 1 < input.length
        && !(input[index] === '*' && input[index + 1] === '/')
      ) index++
      if (index + 1 >= input.length) throw invalid('deno.jsonc: unterminated block comment')
      index += 2
      continue
    }
    if (character === ',') {
      let lookahead = index + 1
      while (lookahead < input.length && /\s/.test(input[lookahead]!)) lookahead++
      if (input[lookahead] === '}' || input[lookahead] === ']') {
        index++
        continue
      }
    }
    output.push(character)
    index++
  }
  return output.join('')
}

function parseDenoProjectManifest(content: string, filename: string): Manifest {
  let value: unknown
  try {
    value = JSON.parse(
      filename.endsWith('.jsonc') ? stripJsoncExtensions(content) : content,
    )
  } catch (cause) {
    throw invalid(`${filename}: Deno config parse failed`, cause)
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw invalid(`${filename}: Deno config root must be an object`)
  }
  const raw = value as Record<string, unknown>
  const manifest: Manifest = {}
  if (raw.name !== undefined) {
    if (typeof raw.name !== 'string') throw invalid(`${filename}.name must be a string`)
    manifest.name = raw.name
  }
  if (raw.version !== undefined) {
    if (typeof raw.version !== 'string') throw invalid(`${filename}.version must be a string`)
    manifest.version = raw.version
  }
  const imports = stringRecord(raw.imports, `${filename}.imports`)
  if (imports !== undefined) manifest.dependencies = imports
  return manifest
}

function mergeDenoManifestEvidence(
  packageManifest: Manifest | undefined,
  denoManifest: Manifest,
): Manifest {
  if (packageManifest === undefined) return denoManifest
  const declaredNames = new Set([
    ...Object.keys(packageManifest.dependencies ?? {}),
    ...Object.keys(packageManifest.devDependencies ?? {}),
    ...Object.keys(packageManifest.optionalDependencies ?? {}),
    ...Object.keys(packageManifest.peerDependencies ?? {}),
  ])
  const denoOnlyDependencies = Object.fromEntries(
    Object.entries(denoManifest.dependencies ?? {})
      .filter(([name]) => !declaredNames.has(name)),
  )
  return {
    ...packageManifest,
    ...(packageManifest.name !== undefined || denoManifest.name === undefined
      ? {}
      : { name: denoManifest.name }),
    ...(packageManifest.version !== undefined || denoManifest.version === undefined
      ? {}
      : { version: denoManifest.version }),
    ...(Object.keys(denoOnlyDependencies).length === 0
      ? {}
      : {
          dependencies: {
            ...denoOnlyDependencies,
            ...packageManifest.dependencies,
          },
        }),
  }
}

export function materializeOverrides(
  overrides: readonly OverrideConstraint[],
): OverrideConstraint[] {
  return overrides.map(override => ({
    package: override.package,
    ...(override.parentPath === undefined ? {} : { parentPath: [...override.parentPath] }),
    ...(override.versionCondition === undefined
      ? {}
      : { versionCondition: override.versionCondition }),
    to: override.to,
    ...(override.selfRef === undefined ? {} : { selfRef: override.selfRef }),
    ...(override.origin === undefined ? {} : { origin: override.origin }),
    ...(override.captureIndex === undefined ? {} : { captureIndex: override.captureIndex }),
  }))
}

function normalizedFiles(files: ProjectInput['files']): readonly NormalizedFile[] {
  const seen = new Map<string, string>()
  const output: NormalizedFile[] = []
  for (const [rawPath, content] of Object.entries(files)) {
    const normalized = normalizeRelativePath(rawPath)
    const previous = seen.get(normalized)
    if (previous !== undefined) {
      throw invalid(`project paths collide after normalization: ${previous}, ${rawPath}`)
    }
    seen.set(normalized, rawPath)
    output.push({ path: normalized, content })
  }
  return output.sort((left, right) => left.path.localeCompare(right.path))
}

function workspacePackagePatterns(patterns: readonly string[]): string[] {
  return patterns.map(raw => {
    const negative = raw.startsWith('!')
    const body = negative ? raw.slice(1) : raw
    const normalized = normalizePattern(body)
    const packagePattern = normalized.endsWith('/package.json') || normalized === 'package.json'
      ? normalized
      : `${normalized.replace(/\/$/, '')}/package.json`
    return negative ? `!${packagePattern}` : packagePattern
  })
}

function missingWorkspaceDiagnostics(manifests: Readonly<Record<string, Manifest>>): Diagnostic[] {
  const manifestPaths = Object.keys(manifests)
    .map(key => key === '' ? 'package.json' : `${key}/package.json`)
  const diagnostics: Diagnostic[] = []
  for (const [key, manifest] of Object.entries(manifests).sort(([left], [right]) => left.localeCompare(right))) {
    if (manifest.workspaces === undefined) continue
    const prefix = key === '' ? '' : `${key}/`
    const declared = workspacePackagePatterns(manifest.workspaces)
      .map(pattern => pattern.startsWith('!') ? `!${prefix}${pattern.slice(1)}` : `${prefix}${pattern}`)
    const positives = declared.filter(pattern => !pattern.startsWith('!'))
    const negatives = declared.filter(pattern => pattern.startsWith('!'))
    for (const pattern of positives) {
      if (manifestPaths.some(candidate => matchesGlobSet(candidate, [pattern, ...negatives]))) continue
      diagnostics.push({
        code: 'CONVERT_WORKSPACE_MANIFEST_MISSING',
        severity: 'warning',
        message: `workspace pattern ${JSON.stringify(pattern)} has no supplied package.json`,
        data: { manifest: key, pattern },
      })
    }
  }
  return diagnostics
}

function prepareManifestFiles(
  files: Readonly<Record<string, string | Uint8Array>>,
  source: FormatId,
): PreparedManifestSource {
  const manifests: Record<string, Manifest> = {}
  const denoManifests: Record<string, Manifest> = {}
  for (const file of normalizedFiles(files)) {
    const role = classify(file.path)
    const directory = path.posix.dirname(file.path)
    const key = directory === '.' ? '' : directory
    if (role.kind === 'manifest') {
      manifests[key] = parseProjectManifest(
        decodeText(file.content, file.path),
        file.path,
        source,
      )
      continue
    }
    if (role.kind === 'config' && isDenoFormat(source)) {
      const basename = path.posix.basename(file.path)
      if (basename === 'deno.json' || basename === 'deno.jsonc') {
        denoManifests[key] = parseDenoProjectManifest(
          decodeText(file.content, file.path),
          file.path,
        )
      }
    }
  }
  for (const [key, denoManifest] of Object.entries(denoManifests)) {
    manifests[key] = mergeDenoManifestEvidence(manifests[key], denoManifest)
  }
  const diagnostics = missingWorkspaceDiagnostics(manifests)
  return {
    manifests,
    coverage: diagnostics.length === 0 ? 'complete' : 'partial',
    diagnostics,
  }
}

/** Resolves the common FileSource manifest authority without selecting a lock. */
export async function prepareManifestSource(
  source: FileSource,
  format: FormatId,
  cwd = process.cwd(),
  fileSystem?: ConvertFileSystem,
): Promise<PreparedManifestSource> {
  if (!Array.isArray(source)) {
    return prepareManifestFiles(
      source as Readonly<Record<string, string | Uint8Array>>,
      format,
    )
  }
  if (source.length === 0 || source.some(pattern => typeof pattern !== 'string')) {
    throw invalid('manifest FileSource paths must be a non-empty string array')
  }
  const patterns = source.map(normalizePattern)
  const fs = fileSystem ?? (await import('./node-fs.ts')).nodeFileSystem
  const root = await fs.realpath(cwd)
  const matches = [...await fs.glob(patterns, {
    cwd: root,
    onlyFiles: true,
    followSymbolicLinks: false,
  })].sort()
  const files: Record<string, string | Uint8Array> = {}
  for (const match of matches) {
    const absolute = path.isAbsolute(match) ? match : path.resolve(root, match)
    const resolved = await containedRealpath(fs, root, absolute)
    files[relativePortable(root, resolved)] = await fs.readFile(resolved)
  }
  return prepareManifestFiles(files, format)
}

function validateSource(
  filename: string | undefined,
  content: string,
  from: FormatId | undefined,
  detect: PrepareRuntime['detect'],
): FormatId {
  const detected = detect(content)
  if (detected === undefined) throw detectFailure('convert: source format not detected')
  if (from !== undefined && from !== detected) {
    throw mismatch(`convert: explicit source ${from} disagrees with detected ${detected}`)
  }
  if (filename !== undefined) {
    const role = classify(filename)
    if (role.kind !== 'lock') throw invalid(`${filename}: selected source is not a supported lock filename`)
    if (role.family !== familyOf(detected)) {
      throw mismatch(`${filename}: filename family ${role.family} disagrees with detected ${detected}`)
    }
  }
  return detected
}

function prepareProjectFiles(
  files: ProjectInput['files'],
  options: PrepareOptions,
  runtime: PrepareRuntime,
  mode: 'project' | 'path',
): PreparedConvertInput {
  if (files === null || typeof files !== 'object' || Array.isArray(files)) {
    throw invalid('ProjectInput.files must be an object')
  }
  const normalized = normalizedFiles(files)
  const locks = normalized.filter(file => classify(file.path).kind === 'lock')
  if (locks.length === 0) throw detectFailure('convert: project input contains no supported lockfile')
  if (locks.length > 1) {
    throw invalid(`convert: project input contains multiple lockfiles: ${locks.map(file => file.path).join(', ')}`)
  }
  const lock = locks[0]!
  const lockfile = decodeText(lock.content, lock.path)
  const source = validateSource(lock.path, lockfile, options.from, runtime.detect)
  const root = path.posix.dirname(lock.path) === '.' ? '' : path.posix.dirname(lock.path)
  const prefix = root === '' ? '' : `${root}/`
  const pnpmWorkspacePath = `${prefix}pnpm-workspace.yaml`
  const pnpmWorkspaceFile = source.startsWith('pnpm-')
    ? normalized.find(file => file.path === pnpmWorkspacePath)
    : undefined
  const pnpmWorkspaces = pnpmWorkspaceFile === undefined
    ? undefined
    : pnpmWorkspacePackages(
        decodeText(pnpmWorkspaceFile.content, pnpmWorkspaceFile.path),
        'pnpm-workspace.yaml',
      )
  const manifests: Record<string, Manifest> = {}
  const denoManifests: Record<string, Manifest> = {}
  for (const file of normalized) {
    const role = classify(file.path)
    if (role.kind === 'other') continue
    if (root !== '' && !file.path.startsWith(prefix)) {
      throw invalid(`${file.path}: supported project fact is outside selected lock root ${root}`)
    }
    const rebased = root === '' ? file.path : file.path.slice(prefix.length)
    if (role.kind === 'config') {
      const content = decodeText(file.content, file.path)
      const basename = path.posix.basename(rebased)
      if (isDenoFormat(source) && (basename === 'deno.json' || basename === 'deno.jsonc')) {
        const directory = path.posix.dirname(rebased)
        const key = directory === '.' ? '' : directory
        denoManifests[key] = parseDenoProjectManifest(content, rebased)
      }
      continue
    }
    if (role.kind !== 'manifest') continue
    const directory = path.posix.dirname(rebased)
    const key = directory === '.' ? '' : directory
    manifests[key] = parseProjectManifest(decodeText(file.content, file.path), rebased, source)
  }
  for (const [key, denoManifest] of Object.entries(denoManifests)) {
    manifests[key] = mergeDenoManifestEvidence(manifests[key], denoManifest)
  }
  if (pnpmWorkspaces !== undefined) {
    manifests[''] = { ...manifests[''], workspaces: pnpmWorkspaces }
  }
  const diagnostics = missingWorkspaceDiagnostics(manifests)
  return {
    lockfile,
    source,
    ...(Object.keys(manifests).length === 0 ? {} : { manifests }),
    ...(Object.keys(manifests).length === 0 ? {} : {
      manifestCoverage: diagnostics.length === 0 ? 'complete' : 'partial',
    }),
    diagnostics,
    mode,
  }
}

function isProjectInput(input: ConvertInput): input is ProjectInput {
  return typeof input === 'object' && input !== null && 'files' in input
}

function isGraph(input: ConvertInput): input is Graph {
  return typeof input === 'object'
    && input !== null
    && 'nodes' in input
    && typeof input.nodes === 'function'
    && 'mutate' in input
    && typeof input.mutate === 'function'
}

function isProjectPathInput(input: ConvertInput): input is ProjectPathInput {
  return typeof input === 'object' && input !== null && 'patterns' in input
}

function within(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

async function containedRealpath(
  fs: ConvertFileSystem,
  root: string,
  candidate: string,
): Promise<string> {
  const resolved = await fs.realpath(candidate)
  if (!within(root, resolved)) throw invalid(`${candidate}: resolved path escapes ${root}`)
  return resolved
}

async function optionalFile(
  fs: ConvertFileSystem,
  root: string,
  candidate: string,
): Promise<string | Uint8Array | undefined> {
  try {
    const resolved = await containedRealpath(fs, root, candidate)
    return await fs.readFile(resolved)
  } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }
}

function relativePortable(root: string, candidate: string): string {
  return normalizeRelativePath(path.relative(root, candidate).split(path.sep).join('/'))
}

async function preparePathInput(
  input: ProjectPathInput,
  options: PrepareOptions,
  runtime: PrepareRuntime,
  deps: ConvertDependencies,
): Promise<PreparedConvertInput> {
  if (!Array.isArray(input.patterns) || input.patterns.length === 0) {
    throw invalid('ProjectPathInput.patterns must be a non-empty array')
  }
  if (input.patterns.some(pattern => typeof pattern !== 'string')) {
    throw invalid('ProjectPathInput.patterns must contain only strings')
  }
  const patterns = input.patterns.map(normalizePattern)
  const fs = deps.fs ?? await deps.defaultFileSystem()
  const searchRoot = await fs.realpath(input.cwd ?? process.cwd())
  const seedMatches = [...await fs.glob(patterns, {
    cwd: searchRoot,
    onlyFiles: true,
    followSymbolicLinks: false,
  })].sort()
  const seedFiles: Record<string, string | Uint8Array> = {}
  for (const match of seedMatches) {
    const absolute = path.isAbsolute(match) ? match : path.resolve(searchRoot, match)
    const resolved = await containedRealpath(fs, searchRoot, absolute)
    seedFiles[relativePortable(searchRoot, resolved)] = await fs.readFile(resolved)
  }

  const seed = prepareProjectFiles(seedFiles, options, runtime, 'path')
  const selected = Object.keys(seedFiles).find(candidate => classify(candidate).kind === 'lock')!
  const selectedAbsolute = path.resolve(searchRoot, selected)
  const projectRoot = await containedRealpath(fs, searchRoot, path.dirname(selectedAbsolute))
  const projectRelative = path.relative(searchRoot, projectRoot).split(path.sep).join('/')
  const projectPrefix = projectRelative === '' ? '' : normalizeRelativePath(projectRelative)
  const projectPath = (relative: string): string => projectPrefix === '' ? relative : `${projectPrefix}/${relative}`

  for (const name of ['package.json', ...CONFIG_NAMES]) {
    const content = await optionalFile(fs, projectRoot, path.join(projectRoot, name))
    if (content !== undefined) seedFiles[projectPath(name)] = content
  }

  const visited = new Set<string>()
  for (;;) {
    const prepared = prepareProjectFiles(seedFiles, options, runtime, 'path')
    const next = Object.entries(prepared.manifests ?? {})
      .filter(([key, manifest]) => manifest.workspaces !== undefined && !visited.has(key))
      .sort(([left], [right]) => left.localeCompare(right))[0]
    if (next === undefined) return prepared
    const [key, manifest] = next
    visited.add(key)
    const declaringDirectory = key === '' ? projectRoot : path.join(projectRoot, ...key.split('/'))
    const workspacePatterns = workspacePackagePatterns(manifest.workspaces!)
    const matches = [...await fs.glob(workspacePatterns, {
      cwd: declaringDirectory,
      onlyFiles: true,
      followSymbolicLinks: false,
    })].sort()
    for (const match of matches) {
      const absolute = path.isAbsolute(match) ? match : path.resolve(declaringDirectory, match)
      const resolved = await containedRealpath(fs, projectRoot, absolute)
      const relative = relativePortable(projectRoot, resolved)
      seedFiles[projectPath(relative)] = await fs.readFile(resolved)
    }
  }
}

/** Resolves a conversion input to lockfile text and source context. */
export async function prepareConvertInput(
  input: ConvertInput,
  options: PrepareOptions,
  runtime: PrepareRuntime,
  deps: ConvertDependencies,
): Promise<PreparedConvertInput> {
  if (typeof input === 'string') {
    return {
      lockfile: input,
      source: validateSource(undefined, input, options.from, runtime.detect),
      diagnostics: [],
      mode: 'content',
    }
  }
  if (isGraph(input)) {
    return {
      lockfile: '',
      graph: input,
      source: internalEvidenceOf(evidenceOf(input)).source?.format ?? 'lockgraph',
      diagnostics: [],
      mode: 'graph',
    }
  }
  if (isProjectInput(input)) return prepareProjectFiles(input.files, options, runtime, 'project')
  if (isProjectPathInput(input)) return preparePathInput(input, options, runtime, deps)
  throw invalid('convert input must be lockfile content, ProjectInput, or ProjectPathInput')
}

export function structuralEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (typeof left !== typeof right || left === null || right === null) return false
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right)
      && left.length === right.length
      && left.every((item, index) => structuralEqual(item, right[index]))
  }
  if (typeof left !== 'object') return false
  const leftRecord = left as Record<string, unknown>
  const rightRecord = right as Record<string, unknown>
  const leftKeys = Object.keys(leftRecord).filter(key => leftRecord[key] !== undefined).sort()
  const rightKeys = Object.keys(rightRecord).filter(key => rightRecord[key] !== undefined).sort()
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index]
      && structuralEqual(leftRecord[key], rightRecord[key]))
}
