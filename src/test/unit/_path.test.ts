import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, statSync, realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  readWorkspaceFileBytes,
  resolveWorkspacePath,
  resolveWorkspaceRoot,
  decodeWorkspacePath,
  normalizeWorkspacePath,
  ensureRegularFile,
  ensureDescendantOfWorkspace,
  sameFileIdentity,
  codeOf,
  invalidWorkspacePath,
} from '../../main/ts/formats/_path.ts'

const LOC = 'pkg@patch:./x.diff'

describe('codeOf', () => {
  it('extracts a string `code` from an error-like object', () => {
    expect(codeOf({ code: 'ENOENT' })).toBe('ENOENT')
    expect(codeOf({ code: 42 })).toBe('42')
  })
  it('is undefined for non-objects / objects without a code', () => {
    expect(codeOf('ENOENT')).toBeUndefined()
    expect(codeOf(null)).toBeUndefined()
    expect(codeOf({})).toBeUndefined()
  })
})

describe('sameFileIdentity', () => {
  it('is identity by (dev, ino)', () => {
    const a = { dev: 1, ino: 2 } as never
    expect(sameFileIdentity(a, { dev: 1, ino: 2 } as never)).toBe(true)
    expect(sameFileIdentity(a, { dev: 1, ino: 9 } as never)).toBe(false)
    expect(sameFileIdentity(a, { dev: 9, ino: 2 } as never)).toBe(false)
  })
})

describe('invalidWorkspacePath', () => {
  it('produces an INVALID_INPUT LockfileError carrying the locator + cause', () => {
    const cause = new Error('boom')
    const err = invalidWorkspacePath(LOC, 'nope', cause)
    expect(err.code).toBe('INVALID_INPUT')
    expect(err.message).toContain('nope')
    expect(err.message).toContain(LOC)
    expect(err.cause).toBe(cause)
  })
})

describe('decodeWorkspacePath', () => {
  it('percent-decodes', () => {
    expect(decodeWorkspacePath('a%2Fb', LOC)).toBe('a/b')
  })
  it('throws on malformed percent-encoding', () => {
    expect(() => decodeWorkspacePath('bad%', LOC)).toThrowError(/valid percent-encoding/)
  })
})

describe('normalizeWorkspacePath', () => {
  it('normalises a portable `~/` prefix and collapses `.`/`..` inside root', () => {
    expect(normalizeWorkspacePath('~/foo', LOC)).toBe('foo')
    expect(normalizeWorkspacePath('a/./b/../c', LOC)).toBe('a/c')
  })
  it('rejects absolute paths', () => {
    expect(() => normalizeWorkspacePath('/etc/passwd', LOC)).toThrowError(/workspace-relative/)
  })
  it('rejects Windows drive prefixes', () => {
    expect(() => normalizeWorkspacePath('C:\\win', LOC)).toThrowError(/Windows drive/)
    expect(() => normalizeWorkspacePath('d:/win', LOC)).toThrowError(/Windows drive/)
  })
  it('rejects paths that escape the root', () => {
    expect(() => normalizeWorkspacePath('../escape', LOC)).toThrowError(/escapes the workspace root/)
    expect(() => normalizeWorkspacePath('..', LOC)).toThrowError(/escapes the workspace root/)
  })
})

describe('ensureDescendantOfWorkspace', () => {
  it('accepts a descendant, rejects a sibling/parent', () => {
    const root = '/ws/root'
    expect(() => ensureDescendantOfWorkspace(root, '/ws/root/a/b', LOC)).not.toThrow()
    expect(() => ensureDescendantOfWorkspace(root, '/ws/other', LOC)).toThrowError(/escapes the workspace root/)
  })
})

describe('resolveWorkspaceRoot', () => {
  let root: string
  beforeEach(() => { root = mkdtempSync(path.join(os.tmpdir(), 'lg-path-')) })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })
  it('realpaths an existing dir, returns undefined for a missing one', () => {
    expect(resolveWorkspaceRoot(root)).toBe(realpathSync.native(root))
    expect(resolveWorkspaceRoot(path.join(root, 'nope'))).toBeUndefined()
  })
})

describe('resolveWorkspacePath', () => {
  let root: string
  beforeEach(() => { root = mkdtempSync(path.join(os.tmpdir(), 'lg-path-')) })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })
  it('returns the resolved path + segments for a nested file', () => {
    const { resolved, segments } = resolveWorkspacePath(root, 'sub/patch.diff', LOC)
    expect(segments).toEqual(['sub', 'patch.diff'])
    expect(resolved).toBe(path.join(root, 'sub', 'patch.diff'))
  })
})

describe('ensureRegularFile', () => {
  let root: string
  beforeEach(() => { root = mkdtempSync(path.join(os.tmpdir(), 'lg-path-')) })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })
  it('passes for a file, throws for a directory', () => {
    writeFileSync(path.join(root, 'f.diff'), 'x')
    expect(() => ensureRegularFile(statSync(path.join(root, 'f.diff')), LOC)).not.toThrow()
    expect(() => ensureRegularFile(statSync(root), LOC)).toThrowError(/regular file/)
  })
})

describe('readWorkspaceFileBytes', () => {
  let root: string
  beforeEach(() => { root = mkdtempSync(path.join(os.tmpdir(), 'lg-path-')) })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })
  it('reads the bytes of a real workspace-relative file', () => {
    writeFileSync(path.join(root, 'patch.diff'), 'hello patch')
    expect(readWorkspaceFileBytes(root, 'patch.diff', LOC)?.toString()).toBe('hello patch')
  })
  it('returns undefined for a missing file and a missing workspace root', () => {
    expect(readWorkspaceFileBytes(root, 'nope.diff', LOC)).toBeUndefined()
    expect(readWorkspaceFileBytes(path.join(root, 'gone'), 'x.diff', LOC)).toBeUndefined()
  })
  it('throws when the target is a directory (not a regular file)', () => {
    mkdirSync(path.join(root, 'adir'))
    expect(() => readWorkspaceFileBytes(root, 'adir', LOC)).toThrowError(/regular file|non-directory/)
  })
  it('throws when a path component is a symlink', () => {
    writeFileSync(path.join(root, 'real.diff'), 'x')
    symlinkSync(path.join(root, 'real.diff'), path.join(root, 'link.diff'))
    expect(() => readWorkspaceFileBytes(root, 'link.diff', LOC)).toThrowError(/symlink/)
  })
  it('throws ENOTDIR when a mid-path segment is a file', () => {
    writeFileSync(path.join(root, 'file'), 'x')
    expect(() => readWorkspaceFileBytes(root, 'file/deeper.diff', LOC)).toThrowError(/non-directory/)
  })
})
