import { lstat, readFile, readdir, realpath } from 'node:fs/promises'
import path from 'node:path'
import {
  expandBraces,
  globSegmentRegExp,
  hasGlobMagic,
  matchesGlobSet,
} from './glob.ts'
import type { ConvertFileSystem } from './types.ts'

async function pathKind(candidate: string): Promise<'file' | 'directory' | 'other' | undefined> {
  try {
    const stat = await lstat(candidate)
    if (stat.isSymbolicLink()) return 'other'
    if (stat.isFile()) return 'file'
    if (stat.isDirectory()) return 'directory'
    return 'other'
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined
    throw error
  }
}

async function expandSegments(
  cwd: string,
  segments: readonly string[],
  index: number,
  output: Set<string>,
): Promise<void> {
  if (index === segments.length) {
    if (await pathKind(cwd) === 'file') output.add(cwd)
    return
  }

  const segment = segments[index]!
  if (segment === '**') {
    await expandSegments(cwd, segments, index + 1, output)
    if (await pathKind(cwd) !== 'directory') return
    const entries = await readdir(cwd, { withFileTypes: true })
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      await expandSegments(path.join(cwd, entry.name), segments, index, output)
    }
    return
  }

  if (!hasGlobMagic(segment)) {
    await expandSegments(path.join(cwd, segment), segments, index + 1, output)
    return
  }

  if (await pathKind(cwd) !== 'directory') return
  const matcher = globSegmentRegExp(segment)
  const dot = segment.startsWith('.')
  const entries = await readdir(cwd, { withFileTypes: true })
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.isSymbolicLink() || (!dot && entry.name.startsWith('.'))) continue
    if (!matcher.test(entry.name)) continue
    await expandSegments(path.join(cwd, entry.name), segments, index + 1, output)
  }
}

async function glob(
  patterns: readonly string[],
  options: Parameters<ConvertFileSystem['glob']>[1],
): Promise<readonly string[]> {
  const included = new Set<string>()
  const excluded: string[] = []
  for (const raw of patterns) {
    if (raw.startsWith('!')) {
      excluded.push(raw.slice(1))
      continue
    }
    for (const pattern of expandBraces(raw)) {
      await expandSegments(
        options.cwd,
        pattern.split('/').filter(segment => segment !== '' && segment !== '.'),
        0,
        included,
      )
    }
  }
  if (excluded.length === 0) return [...included].sort()
  return [...included].filter(candidate => {
    const relative = path.relative(options.cwd, candidate).split(path.sep).join('/')
    return !excluded.some(pattern => matchesGlobSet(relative, [pattern]))
  }).sort()
}

export const nodeFileSystem: ConvertFileSystem = {
  readFile: async candidate => new Uint8Array(await readFile(candidate)),
  glob,
  realpath,
}
