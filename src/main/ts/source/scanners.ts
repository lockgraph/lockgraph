import type { FormatId } from '../api/format-contract.ts'

export interface SourceSpan {
  readonly start: number
  readonly end: number
  readonly render: (value: string) => string
}

export type SourceLocalReason =
  | 'bundled'
  | 'in-bundle'
  | 'workspace-link'
  | 'workspace-member'
  | 'file'
  | 'link'
  | 'directory'

export interface SourceEntry {
  readonly format: FormatId
  readonly key: string
  readonly packageName?: string
  readonly locator?: string
  readonly locatorBase?: string
  readonly locatorTail?: string
  readonly locatorKind?: 'npm' | 'git'
  readonly locatorMatch?: string
  readonly locatorRemainder?: string
  readonly span?: SourceSpan
  readonly guarded: boolean
  readonly guarantee?: 'bytes' | 'commit'
  readonly localReason?: SourceLocalReason
}

interface JsonStringNode {
  readonly type: 'string'
  readonly value: string
  readonly start: number
  readonly end: number
  readonly contentStart: number
  readonly contentEnd: number
}

interface JsonObjectNode {
  readonly type: 'object'
  readonly properties: readonly JsonProperty[]
}

interface JsonArrayNode {
  readonly type: 'array'
  readonly items: readonly JsonNode[]
}

interface JsonScalarNode {
  readonly type: 'scalar'
  readonly value: unknown
}

interface JsonProperty {
  readonly key: JsonStringNode
  readonly value: JsonNode
}

type JsonNode = JsonStringNode | JsonObjectNode | JsonArrayNode | JsonScalarNode

function parseJsonDocument(input: string): JsonNode {
  let offset = 0
  const whitespace = (): void => {
    while (/\s/u.test(input[offset] ?? '')) offset += 1
  }
  const stringNode = (): JsonStringNode => {
    const start = offset
    if (input[offset] !== '"') throw new SyntaxError(`Expected JSON string at ${offset}`)
    offset += 1
    const contentStart = offset
    while (offset < input.length) {
      const char = input[offset]
      if (char === '\\') {
        offset += 2
        continue
      }
      if (char === '"') break
      offset += 1
    }
    if (input[offset] !== '"') throw new SyntaxError(`Unterminated JSON string at ${start}`)
    const contentEnd = offset
    offset += 1
    const end = offset
    return Object.freeze({
      type: 'string',
      value: JSON.parse(input.slice(start, end)) as string,
      start,
      end,
      contentStart,
      contentEnd,
    })
  }
  const value = (): JsonNode => {
    whitespace()
    const char = input[offset]
    if (char === '"') return stringNode()
    if (char === '{') {
      offset += 1
      whitespace()
      const properties: JsonProperty[] = []
      while (input[offset] !== '}') {
        const key = stringNode()
        whitespace()
        if (input[offset] !== ':') throw new SyntaxError(`Expected JSON colon at ${offset}`)
        offset += 1
        const propertyValue = value()
        properties.push(Object.freeze({ key, value: propertyValue }))
        whitespace()
        if (input[offset] === ',') {
          offset += 1
          whitespace()
          continue
        }
        if (input[offset] !== '}') throw new SyntaxError(`Expected JSON object end at ${offset}`)
      }
      offset += 1
      return Object.freeze({ type: 'object', properties: Object.freeze(properties) })
    }
    if (char === '[') {
      offset += 1
      whitespace()
      const items: JsonNode[] = []
      while (input[offset] !== ']') {
        items.push(value())
        whitespace()
        if (input[offset] === ',') {
          offset += 1
          whitespace()
          continue
        }
        if (input[offset] !== ']') throw new SyntaxError(`Expected JSON array end at ${offset}`)
      }
      offset += 1
      return Object.freeze({ type: 'array', items: Object.freeze(items) })
    }
    const start = offset
    while (offset < input.length && !/[\s,\]}]/u.test(input[offset] ?? '')) offset += 1
    const raw = input.slice(start, offset)
    return Object.freeze({ type: 'scalar', value: JSON.parse(raw) as unknown })
  }
  const root = value()
  whitespace()
  if (offset !== input.length) throw new SyntaxError(`Unexpected JSON token at ${offset}`)
  return root
}

function objectProperty(object: JsonObjectNode | undefined, key: string): JsonProperty | undefined {
  return object?.properties.find(property => property.key.value === key)
}

function objectValue(object: JsonObjectNode | undefined, key: string): JsonNode | undefined {
  return objectProperty(object, key)?.value
}

function asObject(node: JsonNode | undefined): JsonObjectNode | undefined {
  return node?.type === 'object' ? node : undefined
}

function asString(node: JsonNode | undefined): JsonStringNode | undefined {
  return node?.type === 'string' ? node : undefined
}

function asBoolean(node: JsonNode | undefined): boolean | undefined {
  return node?.type === 'scalar' && typeof node.value === 'boolean' ? node.value : undefined
}

function localSpecifierReason(value: string | undefined): SourceLocalReason | undefined {
  if (value === undefined) return undefined
  if (value.startsWith('file:')) return 'file'
  if (value.startsWith('link:')) return 'link'
  if (value.startsWith('workspace:')) return 'workspace-link'
  if (/^(?:\.{1,2}[\\/]|[\\/]|[a-z]:[\\/])/iu.test(value)) return 'directory'
  return undefined
}

function decodedOffsetInJsonString(input: string, node: JsonStringNode, decodedOffset: number): number {
  let raw = node.contentStart
  let decoded = 0
  while (raw < node.contentEnd && decoded < decodedOffset) {
    if (input[raw] !== '\\') {
      raw += 1
      decoded += 1
      continue
    }
    const escape = input[raw + 1]
    if (escape === 'u') raw += 6
    else raw += 2
    decoded += 1
  }
  return raw
}

function splitLocator(value: string): Readonly<{ base: string; tail: string }> {
  const query = value.indexOf('?')
  const fragment = value.indexOf('#')
  const candidates = [query, fragment].filter(index => index >= 0)
  const end = candidates.length === 0 ? value.length : Math.min(...candidates)
  return Object.freeze({ base: value.slice(0, end), tail: value.slice(end) })
}

function jsonSpan(input: string, node: JsonStringNode, baseLength: number): SourceSpan {
  return Object.freeze({
    start: node.contentStart,
    end: decodedOffsetInJsonString(input, node, baseLength),
    render: (value: string) => JSON.stringify(value).slice(1, -1),
  })
}

function canonicalHttpBase(value: string): string | undefined {
  const withoutGit = value.startsWith('git+') ? value.slice(4) : value
  let url: URL
  try {
    url = new URL(withoutGit)
  } catch {
    return undefined
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
  url.hostname = url.hostname.toLowerCase()
  if ((url.protocol === 'https:' && url.port === '443')
    || (url.protocol === 'http:' && url.port === '80')) {
    url.port = ''
  }
  const path = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/u, '')
  return `${url.protocol}//${url.host}${path}`
}

function commitTail(tail: string): boolean {
  return /(?:^|[#?&])(?:commit=)?[\da-f]{7,64}(?:$|&)/iu.test(tail)
}

function classifiedLocator(locator: string): Readonly<{
  locatorBase: string
  locatorTail: string
  locatorKind: 'npm' | 'git'
  locatorMatch: string
  locatorRemainder: string
  commitGuarded: boolean
}> | undefined {
  const { base, tail } = splitLocator(locator)
  const github = /^github:([^/]+)\/([^/]+?)(?:\.git)?$/iu.exec(base)
  if (github?.[1] !== undefined && github[2] !== undefined) {
    return Object.freeze({
      locatorBase: base,
      locatorTail: tail,
      locatorKind: 'git',
      locatorMatch: `https://github.com/${github[1]}/${github[2]}`,
      locatorRemainder: '.git',
      commitGuarded: commitTail(tail),
    })
  }
  const scp = /^(?:git@)([^:]+):([^/]+)\/([^/]+?)(?:\.git)?$/iu.exec(base)
  if (scp?.[1] !== undefined && scp[2] !== undefined && scp[3] !== undefined) {
    return Object.freeze({
      locatorBase: base,
      locatorTail: tail,
      locatorKind: 'git',
      locatorMatch: `https://${scp[1].toLowerCase()}/${scp[2]}/${scp[3]}`,
      locatorRemainder: '.git',
      commitGuarded: commitTail(tail),
    })
  }

  const transportBase = base.startsWith('git+') ? base.slice(4) : base
  let transportUrl: URL | undefined
  try { transportUrl = new URL(transportBase) } catch { /* handled below */ }
  if (transportUrl !== undefined
    && (transportUrl.protocol === 'git:' || transportUrl.protocol === 'ssh:')) {
    const segments = transportUrl.pathname.split('/').filter(Boolean)
    const owner = segments[0]
    const repositoryRaw = segments[1]
    if (owner === undefined || repositoryRaw === undefined) return undefined
    const repository = repositoryRaw.replace(/\.git$/iu, '')
    return Object.freeze({
      locatorBase: base,
      locatorTail: tail,
      locatorKind: 'git',
      locatorMatch: `https://${transportUrl.host.toLowerCase()}/${owner}/${repository}`,
      locatorRemainder: repositoryRaw.endsWith('.git') ? '.git' : '',
      commitGuarded: commitTail(tail),
    })
  }

  const canonical = canonicalHttpBase(base)
  if (canonical === undefined) return undefined

  const parsed = new URL(base.startsWith('git+') ? base.slice(4) : base)
  const codeload = parsed.hostname.toLowerCase() === 'codeload.github.com'
    && /^\/[^/]+\/[^/]+\/(?:tar\.gz|zip)\/[\da-f]{7,64}$/iu.test(parsed.pathname)
  const githubArchive = parsed.hostname.toLowerCase() === 'github.com'
    && /^\/[^/]+\/[^/]+\/(?:archive|tarball)\/[\da-f]{7,64}(?:\.tar\.gz)?$/iu.test(parsed.pathname)
  const gitTransport = base.startsWith('git+')
  if (codeload || githubArchive || gitTransport) {
    const segments = parsed.pathname.split('/').filter(Boolean)
    const owner = segments[0]
    const repositoryRaw = segments[1]
    if (owner === undefined || repositoryRaw === undefined) return undefined
    const repository = repositoryRaw.replace(/\.git$/iu, '')
    const matchHost = codeload ? 'github.com' : parsed.host.toLowerCase()
    const match = `${parsed.protocol}//${matchHost}/${owner}/${repository}`
    const repositoryEnd = parsed.pathname.indexOf(repositoryRaw) + repositoryRaw.length
    const remainder = parsed.pathname.slice(repositoryEnd)
    return Object.freeze({
      locatorBase: base,
      locatorTail: tail,
      locatorKind: 'git',
      locatorMatch: match,
      locatorRemainder: `${repositoryRaw.endsWith('.git') ? '.git' : ''}${remainder}`,
      commitGuarded: codeload || githubArchive
        || commitTail(tail),
    })
  }

  const authority = /^(?:https?):\/\/[^/?#]+/iu.exec(base)?.[0]
  if (authority === undefined) return undefined
  return Object.freeze({
    locatorBase: base,
    locatorTail: tail,
    locatorKind: 'npm',
    locatorMatch: canonical,
    locatorRemainder: base.slice(authority.length),
    commitGuarded: false,
  })
}

function packageNameFromInstallPath(path: string): string | undefined {
  const marker = path.lastIndexOf('node_modules/')
  if (marker < 0) return undefined
  const suffix = path.slice(marker + 'node_modules/'.length)
  const parts = suffix.split('/')
  if (parts[0]?.startsWith('@')) {
    return parts[0] !== undefined && parts[1] !== undefined ? `${parts[0]}/${parts[1]}` : undefined
  }
  return parts[0]
}

function packageNameFromNpmKey(key: string): string | undefined {
  const peerless = key.split('(')[0] ?? key
  if (peerless.startsWith('/@')) {
    const parts = peerless.slice(1).split('/')
    if (parts[0] === undefined || parts[1] === undefined) return undefined
    const at = parts[1].indexOf('@')
    return `${parts[0]}/${at < 0 ? parts[1] : parts[1].slice(0, at)}`
  }
  if (peerless.startsWith('/')) {
    const rest = peerless.slice(1)
    const slash = rest.indexOf('/')
    const at = rest.indexOf('@')
    const ends = [slash, at].filter(index => index >= 0)
    const end = ends.length === 0 ? rest.length : Math.min(...ends)
    return rest.slice(0, end)
  }
  if (peerless.startsWith('@')) {
    const slash = peerless.indexOf('/')
    const at = peerless.indexOf('@', slash + 1)
    return at < 0 ? peerless : peerless.slice(0, at)
  }
  const at = peerless.indexOf('@')
  return at < 0 ? peerless : peerless.slice(0, at)
}

function npmAliasTarget(version: string | undefined, fallback: string): string {
  if (version?.startsWith('npm:') !== true) return fallback
  const target = version.slice(4)
  if (target.startsWith('@')) {
    const slash = target.indexOf('/')
    const at = target.indexOf('@', slash + 1)
    return at < 0 ? target : target.slice(0, at)
  }
  const at = target.indexOf('@')
  return at < 0 ? target : target.slice(0, at)
}

function inferNpmName(locator: string | undefined): string | undefined {
  if (locator === undefined) return undefined
  const classified = classifiedLocator(locator)
  if (classified?.locatorKind !== 'npm') return undefined
  let pathname: string
  try {
    pathname = decodeURIComponent(new URL(classified.locatorBase).pathname)
  } catch {
    return undefined
  }
  const segments = pathname.split('/').filter(Boolean)
  const dash = segments.indexOf('-')
  if (dash < 1) return undefined
  if (segments[dash - 2]?.startsWith('@')) return `${segments[dash - 2]}/${segments[dash - 1]}`
  return segments[dash - 1]
}

function sourceEntry(
  format: FormatId,
  key: string,
  packageName: string | undefined,
  locatorNode: JsonStringNode | undefined,
  input: string,
  digest: boolean,
  localReason?: SourceLocalReason,
): SourceEntry {
  if (localReason !== undefined) {
    const classified = locatorNode === undefined ? undefined : classifiedLocator(locatorNode.value)
    return Object.freeze({
      format,
      key,
      ...(packageName === undefined ? {} : { packageName }),
      ...(locatorNode === undefined ? {} : { locator: locatorNode.value }),
      ...(classified === undefined || locatorNode === undefined ? {} : {
        locatorBase: classified.locatorBase,
        locatorTail: classified.locatorTail,
        locatorKind: classified.locatorKind,
        locatorMatch: classified.locatorMatch,
        locatorRemainder: classified.locatorRemainder,
        span: jsonSpan(input, locatorNode, classified.locatorBase.length),
      }),
      guarded: false,
      localReason,
    })
  }
  if (locatorNode === undefined) {
    return Object.freeze({ format, key, ...(packageName === undefined ? {} : { packageName }), guarded: false })
  }
  const classified = classifiedLocator(locatorNode.value)
  if (classified === undefined) {
    return Object.freeze({ format, key, ...(packageName === undefined ? {} : { packageName }), guarded: false })
  }
  const commit = classified.locatorKind === 'git' && classified.commitGuarded
  return Object.freeze({
    format,
    key,
    ...(packageName === undefined ? {} : { packageName }),
    locator: locatorNode.value,
    locatorBase: classified.locatorBase,
    locatorTail: classified.locatorTail,
    locatorKind: classified.locatorKind,
    locatorMatch: classified.locatorMatch,
    locatorRemainder: classified.locatorRemainder,
    span: jsonSpan(input, locatorNode, classified.locatorBase.length),
    guarded: digest || commit,
    ...(digest ? { guarantee: 'bytes' as const } : commit ? { guarantee: 'commit' as const } : {}),
  })
}

function scanNpmJson(input: string, format: FormatId): readonly SourceEntry[] {
  const root = asObject(parseJsonDocument(input))
  if (root === undefined) return Object.freeze([])
  const packages = asObject(objectValue(root, 'packages'))
  const entries: SourceEntry[] = []
  if (packages !== undefined) {
    for (const property of packages.properties) {
      if (property.key.value === '') continue
      const value = asObject(property.value)
      if (value === undefined) continue
      const declared = asString(objectValue(value, 'name'))?.value
      const installName = packageNameFromInstallPath(property.key.value)
      const versionNode = asString(objectValue(value, 'version'))
      const version = versionNode?.value
      const resolved = asString(objectValue(value, 'resolved'))
      const inferred = inferNpmName(resolved?.value)
      const name = npmAliasTarget(version, inferred ?? declared ?? installName ?? '') || undefined
      const integrity = asString(objectValue(value, 'integrity'))?.value
      const shasum = asString(objectValue(value, 'shasum'))?.value
      const localReason = asBoolean(objectValue(value, 'inBundle')) === true
        ? 'in-bundle'
        : asBoolean(objectValue(value, 'link')) === true
          ? 'workspace-link'
          : !property.key.value.includes('node_modules/')
            ? 'workspace-member'
            : localSpecifierReason(resolved?.value) ?? localSpecifierReason(version)
      entries.push(sourceEntry(
        format,
        property.key.value,
        name,
        resolved,
        input,
        Boolean(integrity || shasum),
        localReason,
      ))
    }
  }

  const dependencyKeyPrefix = packages === undefined ? '' : 'dependencies:'
  const walk = (dependencies: JsonObjectNode | undefined, prefix: string): void => {
    for (const property of dependencies?.properties ?? []) {
      const value = asObject(property.value)
      if (value === undefined) continue
      const version = asString(objectValue(value, 'version'))?.value
      const resolved = asString(objectValue(value, 'resolved'))
      const versionNode = asString(objectValue(value, 'version'))
      const from = asString(objectValue(value, 'from'))?.value
      const locator = resolved ?? (versionNode !== undefined && classifiedLocator(versionNode.value) !== undefined
        ? versionNode
        : undefined)
      const inferred = inferNpmName(locator?.value)
      const name = npmAliasTarget(version, inferred ?? property.key.value)
      const key = prefix === ''
        ? `${dependencyKeyPrefix}${property.key.value}`
        : `${prefix}>${property.key.value}`
      const integrity = asString(objectValue(value, 'integrity'))?.value
      const shasum = asString(objectValue(value, 'shasum'))?.value
      const localReason = asBoolean(objectValue(value, 'bundled')) === true
        ? 'bundled'
        : localSpecifierReason(resolved?.value)
          ?? localSpecifierReason(version)
          ?? localSpecifierReason(from)
      entries.push(sourceEntry(
        format,
        key,
        name,
        locator,
        input,
        Boolean(integrity || shasum),
        localReason,
      ))
      walk(asObject(objectValue(value, 'dependencies')), key)
    }
  }
  walk(asObject(objectValue(root, 'dependencies')), '')
  return Object.freeze(entries)
}

function scanDenoJson(input: string, format: FormatId): readonly SourceEntry[] {
  const root = asObject(parseJsonDocument(input))
  const npm = asObject(objectValue(root, 'npm'))
  const entries: SourceEntry[] = []
  for (const property of npm?.properties ?? []) {
    const value = asObject(property.value)
    if (value === undefined) continue
    const name = packageNameFromNpmKey(property.key.value)
    const tarball = asString(objectValue(value, 'tarball'))
    const integrity = asString(objectValue(value, 'integrity'))?.value
    entries.push(sourceEntry(
      format,
      property.key.value,
      name,
      tarball,
      input,
      Boolean(integrity),
      localSpecifierReason(tarball?.value),
    ))
  }
  return Object.freeze(entries)
}

interface Line {
  readonly text: string
  readonly start: number
  readonly end: number
}

function linesOf(input: string): readonly Line[] {
  const lines: Line[] = []
  let start = 0
  while (start < input.length) {
    const lf = input.indexOf('\n', start)
    const end = lf < 0 ? input.length : lf
    const textEnd = end > start && input[end - 1] === '\r' ? end - 1 : end
    lines.push(Object.freeze({ text: input.slice(start, textEnd), start, end: textEnd }))
    if (lf < 0) break
    start = lf + 1
  }
  return Object.freeze(lines)
}

function scalarSpan(raw: string, absoluteStart: number): Readonly<{
  value: string
  span: SourceSpan
}> | undefined {
  const left = /^\s*/u.exec(raw)?.[0].length ?? 0
  let body = raw.slice(left)
  if (body === '') return undefined
  if (body.startsWith('"')) {
    let end = 1
    while (end < body.length) {
      if (body[end] === '\\') {
        end += 2
        continue
      }
      if (body[end] === '"') break
      end += 1
    }
    if (body[end] !== '"') return undefined
    const quoted = body.slice(0, end + 1)
    const value = JSON.parse(quoted) as string
    const split = splitLocator(value)
    const node: JsonStringNode = {
      type: 'string', value, start: 0, end: quoted.length, contentStart: 1, contentEnd: end,
    }
    const local = jsonSpan(quoted, node, split.base.length)
    return Object.freeze({
      value,
      span: Object.freeze({
        start: absoluteStart + left + local.start,
        end: absoluteStart + left + local.end,
        render: local.render,
      }),
    })
  }
  if (body.startsWith("'")) {
    const end = body.indexOf("'", 1)
    if (end < 0) return undefined
    const value = body.slice(1, end).replace(/''/gu, "'")
    const split = splitLocator(value)
    return Object.freeze({
      value,
      span: Object.freeze({
        start: absoluteStart + left + 1,
        end: absoluteStart + left + 1 + split.base.length,
        render: (replacement: string) => replacement.replace(/'/gu, "''"),
      }),
    })
  }
  const comment = /\s+#/u.exec(body)
  if (comment?.index !== undefined) body = body.slice(0, comment.index).trimEnd()
  else body = body.trimEnd()
  const split = splitLocator(body)
  return Object.freeze({
    value: body,
    span: Object.freeze({
      start: absoluteStart + left,
      end: absoluteStart + left + split.base.length,
      render: (replacement: string) => replacement,
    }),
  })
}

function yarnDescriptorName(key: string): string | undefined {
  const first = yarnDescriptors(key)[0]
  if (first === undefined) return undefined
  const separator = first.startsWith('@')
    ? first.indexOf('@', first.indexOf('/') + 1)
    : first.indexOf('@')
  if (separator < 0) return first
  const declared = first.slice(0, separator)
  const range = first.slice(separator + 1)
  if (!range.startsWith('npm:')) return declared
  const target = range.slice(4)
  if (/^[\d~^<>=*]/u.test(target)) return declared
  const targetSeparator = target.startsWith('@')
    ? target.indexOf('@', target.indexOf('/') + 1)
    : target.indexOf('@')
  return targetSeparator < 0 ? target : target.slice(0, targetSeparator)
}

function yarnDescriptors(key: string): readonly string[] {
  const descriptors: string[] = []
  let start = 0
  let quote = false
  let escaped = false
  for (let index = 0; index <= key.length; index += 1) {
    const char = key[index]
    if (quote) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') quote = false
      continue
    }
    if (char === '"') {
      quote = true
      continue
    }
    if (index < key.length && char !== ',') continue
    const raw = key.slice(start, index).trim()
    if (raw !== '') {
      if (raw.startsWith('"') && raw.endsWith('"')) {
        try { descriptors.push(JSON.parse(raw) as string) } catch { descriptors.push(raw) }
      } else descriptors.push(raw)
    }
    start = index + 1
  }
  return Object.freeze(descriptors)
}

function yarnDescriptorRange(descriptor: string): string | undefined {
  const separator = descriptor.startsWith('@')
    ? descriptor.indexOf('@', descriptor.indexOf('/') + 1)
    : descriptor.indexOf('@')
  return separator < 0 ? undefined : descriptor.slice(separator + 1)
}

function yarnLocalReason(key: string): SourceLocalReason | undefined {
  const reasons = yarnDescriptors(key).map(descriptor => localSpecifierReason(yarnDescriptorRange(descriptor)))
  return reasons.length > 0 && reasons.every(reason => reason !== undefined) ? reasons[0] : undefined
}

function scanYarnClassic(input: string, format: FormatId): readonly SourceEntry[] {
  const lines = linesOf(input)
  const entries: SourceEntry[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const header = lines[index]
    if (header === undefined || /^\s/u.test(header.text) || !header.text.endsWith(':')
      || header.text.startsWith('#')) continue
    const keyRaw = header.text.slice(0, -1)
    let key = keyRaw
    if (keyRaw.startsWith('"')) {
      try { key = JSON.parse(keyRaw) as string } catch { /* multi-descriptor key */ }
    }
    const end = (() => {
      let cursor = index + 1
      while (cursor < lines.length) {
        const line = lines[cursor]
        if (line !== undefined && line.text !== '' && !/^\s/u.test(line.text) && line.text.endsWith(':')) break
        cursor += 1
      }
      return cursor
    })()
    const resolved: Array<Readonly<{ value: string; span: SourceSpan }>> = []
    let integrity = false
    for (let cursor = index + 1; cursor < end; cursor += 1) {
      const line = lines[cursor]
      if (line === undefined) continue
      const resolvedMatch = /^\s+resolved\s+(.+)$/u.exec(line.text)
      if (resolvedMatch?.[1] !== undefined) {
        const valueStart = line.text.indexOf(resolvedMatch[1])
        const resolution = scalarSpan(resolvedMatch[1], line.start + valueStart)
        if (resolution !== undefined) resolved.push(resolution)
      }
      if (/^\s+integrity\s+\S+/u.test(line.text)) integrity = true
    }
    if (resolved.length === 0) {
      const name = yarnDescriptorName(keyRaw)
      const localReason = yarnLocalReason(keyRaw)
      entries.push(Object.freeze({
        format,
        key,
        ...(name === undefined ? {} : { packageName: name }),
        guarded: false,
        ...(localReason === undefined ? {} : { localReason }),
      }))
      index = end - 1
      continue
    }
    for (let resolvedIndex = 0; resolvedIndex < resolved.length; resolvedIndex += 1) {
      const resolution = resolved[resolvedIndex]
      if (resolution === undefined) continue
      const entryKey = resolvedIndex === 0 ? key : `${key}#resolved:${resolvedIndex + 1}`
      const classified = classifiedLocator(resolution.value)
      const name = inferNpmName(resolution.value) ?? yarnDescriptorName(keyRaw)
      const localReason = yarnLocalReason(keyRaw) ?? localSpecifierReason(resolution.value)
      if (localReason !== undefined) {
        entries.push(Object.freeze({
          format,
          key: entryKey,
          ...(name === undefined ? {} : { packageName: name }),
          locator: resolution.value,
          span: resolution.span,
          guarded: false,
          localReason,
        }))
        continue
      }
      if (classified === undefined) {
        entries.push(Object.freeze({
          format,
          key: entryKey,
          ...(name === undefined ? {} : { packageName: name }),
          locator: resolution.value,
          span: resolution.span,
          guarded: false,
        }))
        continue
      }
      const inlineSha1 = /#[\da-f]{40}$/iu.test(classified.locatorTail)
      const commit = classified.locatorKind === 'git' && classified.commitGuarded
      entries.push(Object.freeze({
        format,
        key: entryKey,
        ...(name === undefined ? {} : { packageName: name }),
        locator: resolution.value,
        locatorBase: classified.locatorBase,
        locatorTail: classified.locatorTail,
        locatorKind: classified.locatorKind,
        locatorMatch: classified.locatorMatch,
        locatorRemainder: classified.locatorRemainder,
        span: resolution.span,
        guarded: integrity || inlineSha1 || commit,
        ...(integrity || inlineSha1
          ? { guarantee: 'bytes' as const }
          : commit ? { guarantee: 'commit' as const } : {}),
      }))
    }
    index = end - 1
  }
  return Object.freeze(entries)
}

function unquoteYamlKey(value: string): string {
  const trimmed = value.trim()
  if (trimmed.startsWith('"')) {
    try { return JSON.parse(trimmed) as string } catch { return trimmed }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/gu, "'")
  }
  return trimmed
}

function flowField(
  body: string,
  field: string,
  absoluteStart: number,
): Readonly<{ value: string; span: SourceSpan }> | undefined {
  const pattern = new RegExp(`(?:^|[,\\{])\\s*${field}:\\s*`, 'u')
  const match = pattern.exec(body)
  if (match === null) return undefined
  const valueStart = match.index + match[0].length
  const rest = body.slice(valueStart)
  if (rest.startsWith('"') || rest.startsWith("'")) return scalarSpan(rest, absoluteStart + valueStart)
  const end = /[,}]/u.exec(rest)?.index ?? rest.length
  return scalarSpan(rest.slice(0, end), absoluteStart + valueStart)
}

function pnpmLocalReason(key: string): SourceLocalReason | undefined {
  const clean = (key.split('(')[0] ?? key).replace(/^\//u, '')
  const direct = localSpecifierReason(clean)
  if (direct !== undefined) return direct
  if (clean.startsWith('@')) {
    const packageSlash = clean.indexOf('/')
    if (packageSlash < 0) return undefined
    const at = clean.indexOf('@', packageSlash + 1)
    const slash = clean.indexOf('/', packageSlash + 1)
    const separator = [at, slash].filter(index => index >= 0).sort((left, right) => left - right)[0]
    return separator === undefined ? undefined : localSpecifierReason(clean.slice(separator + 1))
  }
  const at = clean.indexOf('@')
  const slash = clean.indexOf('/')
  const separator = [at, slash].filter(index => index >= 0).sort((left, right) => left - right)[0]
  return separator === undefined ? undefined : localSpecifierReason(clean.slice(separator + 1))
}

function scanPnpm(input: string, format: FormatId): readonly SourceEntry[] {
  const lines = linesOf(input)
  const entries: SourceEntry[] = []
  const packagesIndex = lines.findIndex(line => line.text === 'packages:')
  if (packagesIndex < 0) return Object.freeze(entries)
  for (let index = packagesIndex + 1; index < lines.length; index += 1) {
    const header = lines[index]
    if (header === undefined) continue
    if (/^\S/u.test(header.text)) break
    const match = /^ {2}(\S.*):\s*$/u.exec(header.text)
    if (match?.[1] === undefined) continue
    const key = unquoteYamlKey(match[1])
    const name = packageNameFromNpmKey(key)
    let localReason = pnpmLocalReason(key)
    let end = index + 1
    while (end < lines.length) {
      const line = lines[end]
      if (line === undefined || /^\S/u.test(line.text) || /^ {2}\S/u.test(line.text)) break
      end += 1
    }
    let tarball: Readonly<{ value: string; span: SourceSpan }> | undefined
    let integrity = false
    for (let cursor = index + 1; cursor < end; cursor += 1) {
      const line = lines[cursor]
      if (line === undefined) continue
      const resolution = /^ {4}resolution:\s*(.*)$/u.exec(line.text)
      if (resolution === null) continue
      const inline = resolution[1] ?? ''
      if (inline.startsWith('{')) {
        const bodyStart = line.text.indexOf(inline)
        tarball = flowField(inline, 'tarball', line.start + bodyStart)
        integrity = flowField(inline, 'integrity', line.start + bodyStart) !== undefined
        if (flowField(inline, 'directory', line.start + bodyStart) !== undefined) localReason = 'directory'
        break
      }
      const resolutionIndent = 4
      for (let child = cursor + 1; child < end; child += 1) {
        const childLine = lines[child]
        if (childLine === undefined) continue
        const indent = /^\s*/u.exec(childLine.text)?.[0].length ?? 0
        if (childLine.text.trim() !== '' && indent <= resolutionIndent) break
        const tarballMatch = /^\s+tarball:\s*(.+)$/u.exec(childLine.text)
        if (tarballMatch?.[1] !== undefined) {
          const valueStart = childLine.text.indexOf(tarballMatch[1])
          tarball = scalarSpan(tarballMatch[1], childLine.start + valueStart)
        }
        if (/^\s+integrity:\s*\S+/u.test(childLine.text)) integrity = true
        if (/^\s+(?:directory:\s*\S+|type:\s*directory)\s*$/u.test(childLine.text)) {
          localReason = 'directory'
        }
      }
      break
    }
    if (localReason !== undefined) {
      entries.push(Object.freeze({
        format,
        key,
        ...(name === undefined ? {} : { packageName: name }),
        ...(tarball === undefined ? {} : { locator: tarball.value, span: tarball.span }),
        guarded: false,
        localReason,
      }))
    } else if (tarball === undefined) {
      entries.push(Object.freeze({
        format,
        key,
        ...(name === undefined ? {} : { packageName: name }),
        guarded: false,
      }))
    } else {
      const classified = classifiedLocator(tarball.value)
      if (classified === undefined) {
        entries.push(Object.freeze({ format, key, ...(name === undefined ? {} : { packageName: name }), guarded: false }))
      } else {
        const commit = classified.locatorKind === 'git' && classified.commitGuarded
        entries.push(Object.freeze({
          format,
          key,
          ...(name === undefined ? {} : { packageName: name }),
          locator: tarball.value,
          locatorBase: classified.locatorBase,
          locatorTail: classified.locatorTail,
          locatorKind: classified.locatorKind,
          locatorMatch: classified.locatorMatch,
          locatorRemainder: classified.locatorRemainder,
          span: tarball.span,
          guarded: integrity || commit,
          ...(integrity ? { guarantee: 'bytes' as const } : commit ? { guarantee: 'commit' as const } : {}),
        }))
      }
    }
    index = end - 1
  }
  return Object.freeze(entries)
}

export function scanSourceEntries(input: string, format: FormatId): readonly SourceEntry[] {
  if (format.startsWith('npm-')) return scanNpmJson(input, format)
  if (format.startsWith('deno-')) return scanDenoJson(input, format)
  if (format === 'yarn-classic') return scanYarnClassic(input, format)
  if (format.startsWith('pnpm-')) return scanPnpm(input, format)
  return Object.freeze([])
}
