// Shared lockfile path and filesystem guards.

import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
} from 'node:fs'
import path from 'node:path'
import { LockfileError } from '../api/errors.ts'

const WINDOWS_DRIVE_RE = /^[A-Za-z]:([\\/]|$)/
type FileStat = NonNullable<ReturnType<typeof statSync>>

/**
 * Reads a lockfile-carried workspace-relative file while enforcing the
 * pure-JS confinement model documented for yarn-berry patch inputs.
 *
 * Existing components are lstat-walked so static symlinks are rejected before
 * open. The leaf is then opened once with O_NOFOLLOW, required to be a regular
 * file via fstat, and read back from that same fd, which closes the leaf-swap
 * window. Parent-directory swaps between the lstat walk and the leaf open
 * remain an accepted pure-JS residual; Linux gets a post-open containment
 * re-check via /proc/self/fd/<fd>, and other platforms fall back to a weaker
 * realpath consistency check because Node does not expose dirfd/openat.
 */
export function readWorkspaceFileBytes(
  workspaceRoot: string,
  candidatePath: string,
  locator: string,
): Buffer | undefined {
  const root = resolveWorkspaceRoot(workspaceRoot)
  if (root === undefined) return undefined

  const { resolved, segments } = resolveWorkspacePath(root, candidatePath, locator)
  ensureNoSymlinksOnExistingPath(root, segments, locator)

  let fd: number | undefined
  try {
    fd = openSync(resolved, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  } catch (cause) {
    const code = codeOf(cause)
    if (code === 'ENOENT' || code === 'EACCES') return undefined
    if (code === 'ENOTDIR') {
      throw invalidWorkspacePath(locator, `patch path traverses a non-directory segment`, cause)
    }
    if (code === 'ELOOP') {
      throw invalidWorkspacePath(locator, `patch path contains a symlink`, cause)
    }
    throw cause
  }

  try {
    const stat = fstatSync(fd)
    ensureRegularFile(stat, locator)
    ensureOpenedPathStillContained(root, resolved, fd, stat, locator)
    return readFileSync(fd)
  } finally {
    closeSync(fd)
  }
}

export function resolveWorkspacePath(
  root: string,
  candidatePath: string,
  locator: string,
): { resolved: string; segments: string[] } {
  const decoded = decodeWorkspacePath(candidatePath, locator)
  const normalized = normalizeWorkspacePath(decoded, locator)
  const segments = normalized.split('/').filter(segment => segment !== '' && segment !== '.')
  const resolved = segments.length === 0 ? root : path.join(root, ...segments)
  const relative = path.relative(root, resolved)

  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw invalidWorkspacePath(locator, `patch path escapes the workspace root`)
  }

  return { resolved, segments }
}

export function resolveWorkspaceRoot(workspaceRoot: string): string | undefined {
  try {
    return realpathSync.native(workspaceRoot)
  } catch (cause) {
    const code = codeOf(cause)
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EACCES') return undefined
    throw cause
  }
}

export function decodeWorkspacePath(candidatePath: string, locator: string): string {
  try {
    return decodeURIComponent(candidatePath)
  } catch (cause) {
    throw invalidWorkspacePath(locator, `patch path is not valid percent-encoding`, cause)
  }
}

export function normalizeWorkspacePath(candidatePath: string, locator: string): string {
  const portable = candidatePath.startsWith('~/')
    ? `./${candidatePath.slice(2)}`
    : candidatePath

  if (portable.startsWith('/')) {
    throw invalidWorkspacePath(locator, `patch path must be workspace-relative`)
  }
  if (WINDOWS_DRIVE_RE.test(portable)) {
    throw invalidWorkspacePath(locator, `patch path must not use a Windows drive prefix`)
  }

  const normalized = path.posix.normalize(portable)
  if (normalized === '..' || normalized.startsWith('../')) {
    throw invalidWorkspacePath(locator, `patch path escapes the workspace root`)
  }

  return normalized
}

export function ensureNoSymlinksOnExistingPath(root: string, segments: string[], locator: string): void {
  let current = root

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]
    if (segment === undefined) continue
    current = path.join(current, segment)

    let stat: ReturnType<typeof lstatSync> | undefined
    try {
      stat = lstatSync(current)
    } catch (cause) {
      const code = codeOf(cause)
      if (code === 'ENOENT' || code === 'EACCES') return
      if (code === 'ENOTDIR') {
        throw invalidWorkspacePath(locator, `patch path traverses a non-directory segment`, cause)
      }
      throw cause
    }
    if (stat === undefined) return

    if (stat.isSymbolicLink()) {
      throw invalidWorkspacePath(locator, `patch path contains a symlink`)
    }
    if (i < segments.length - 1 && !stat.isDirectory()) {
      throw invalidWorkspacePath(locator, `patch path traverses a non-directory segment`)
    }
  }
}

export function ensureRegularFile(stat: FileStat, locator: string): void {
  if (!stat.isFile()) {
    throw invalidWorkspacePath(locator, `patch path must resolve to a regular file`)
  }
}

export function ensureOpenedPathStillContained(
  root: string,
  resolved: string,
  fd: number,
  openedStat: FileStat,
  locator: string,
): void {
  const fdPath = fdPathOf(fd)
  if (fdPath !== undefined) {
    ensureDescendantOfWorkspace(root, fdPath, locator)
    return
  }

  ensureRealpathStillContained(root, resolved, openedStat, locator)
}

export function fdPathOf(fd: number): string | undefined {
  if (process.platform !== 'linux') return undefined

  try {
    const target = readlinkSync(`/proc/self/fd/${fd}`)
    return path.isAbsolute(target) ? target : undefined
  } catch (cause) {
    const code = codeOf(cause)
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EACCES') return undefined
    throw cause
  }
}

export function ensureRealpathStillContained(
  root: string,
  resolved: string,
  openedStat: FileStat,
  locator: string,
): void {
  let realResolved: string
  try {
    realResolved = realpathSync.native(resolved)
  } catch (cause) {
    const code = codeOf(cause)
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EACCES') {
      throw invalidWorkspacePath(locator, `patch path changed after validation`, cause)
    }
    if (code === 'ELOOP') {
      throw invalidWorkspacePath(locator, `patch path contains a symlink`, cause)
    }
    throw cause
  }

  ensureDescendantOfWorkspace(root, realResolved, locator)
  if (path.normalize(realResolved) !== path.normalize(resolved)) {
    throw invalidWorkspacePath(locator, `patch path contains a symlink`)
  }

  const realResolvedStat = statSync(realResolved)
  if (!sameFileIdentity(openedStat, realResolvedStat)) {
    throw invalidWorkspacePath(locator, `patch path changed after validation`)
  }
}

export function ensureDescendantOfWorkspace(root: string, candidate: string, locator: string): void {
  const relative = path.relative(root, candidate)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw invalidWorkspacePath(locator, `patch path escapes the workspace root`)
  }
}

export function sameFileIdentity(left: FileStat, right: FileStat): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

export function invalidWorkspacePath(locator: string, reason: string, cause?: unknown): LockfileError {
  return new LockfileError({
    code: 'INVALID_INPUT',
    message: `${reason} (${locator})`,
    cause,
  })
}

export function codeOf(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : undefined
}
