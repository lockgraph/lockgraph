import { detect } from '../api/format-api.ts'
import type { FormatId } from '../api/format-contract.ts'
import { LockfileError } from '../api/errors.ts'
import {
  normalizeSourceRules,
  type SourceRule,
} from './rules.ts'
import {
  scanSourceEntries,
  type SourceEntry,
  type SourceLocalReason,
} from './scanners.ts'

export type SourceStatus =
  | 'rewritten'
  | 'compliant'
  | 'violation'
  | 'uncertifiable'
  | 'unguarded'
  | 'unrewritable'
  | 'local'
  | 'unmatched'

export interface SourceResultItem {
  readonly status: SourceStatus
  readonly rule: SourceRule
  readonly format: FormatId
  readonly key?: string
  readonly packageName?: string
  readonly locator?: string
  readonly rewrittenLocator?: string
  readonly guarantee?: 'bytes' | 'commit'
  readonly localReason?: SourceLocalReason
}

export type SourceCounts = Readonly<Record<SourceStatus, number>>

export interface SourceOperationOptions {
  readonly format?: FormatId
  readonly allowEmptyRules?: boolean
}

export interface OverrideSourceResult {
  readonly ok: boolean
  readonly format: FormatId
  readonly output: string
  readonly items: readonly SourceResultItem[]
  readonly counts: SourceCounts
}

export interface AssertSourceResult {
  readonly ok: boolean
  readonly format: FormatId
  readonly items: readonly SourceResultItem[]
  readonly counts: SourceCounts
}

function hasBoundaryPrefix(value: string, prefix: string): boolean {
  return value === prefix || value.startsWith(`${prefix}/`)
}

function ruleTier(rule: SourceRule): number {
  switch (rule.selectorType) {
    case 'package': return 5
    case 'scope': return 4
    case 'origin':
    case 'origin-path':
    case 'git-owner':
    case 'git-repository': return 3
    case 'all': return 1
  }
}

function ruleSourcePrefix(rule: SourceRule): string | undefined {
  switch (rule.selectorType) {
    case 'origin':
    case 'origin-path':
    case 'git-repository':
      return rule.selector
    case 'git-owner':
      return rule.selector.slice(0, -2)
    default:
      return undefined
  }
}

function ruleLocationLength(rule: SourceRule): number {
  const prefix = ruleSourcePrefix(rule)
  return prefix === undefined ? 0 : new URL(prefix).pathname.replace(/\/+$/u, '').length
}

function destinationMatchedBy(rule: SourceRule, candidate: SourceRule): boolean {
  const prefix = ruleSourcePrefix(candidate)
  return prefix !== undefined && hasBoundaryPrefix(rule.destination, prefix)
}

function validateNoCascade(rules: readonly SourceRule[]): void {
  for (const [index, rule] of rules.entries()) {
    for (const [candidateIndex, candidate] of rules.entries()) {
      if (index === candidateIndex) continue
      if (destinationMatchedBy(rule, candidate)) {
        throw new TypeError(
          `Source rule destination ${JSON.stringify(rule.destination)} is matched by ${JSON.stringify(candidate.raw)}`,
        )
      }
    }
  }
}

function packageRuleMatches(entry: SourceEntry, rule: SourceRule): boolean {
  if (rule.kind !== 'npm' || entry.locatorKind === 'git' || entry.packageName === undefined) return false
  if (rule.selectorType === 'package') return entry.packageName === rule.selector
  if (rule.selectorType === 'scope') return entry.packageName.startsWith(`${rule.selector.slice(0, -1)}`)
  return false
}

function sourceMatches(entry: SourceEntry, rule: SourceRule): boolean {
  if (packageRuleMatches(entry, rule)) return true
  if (entry.localReason !== undefined) {
    return rule.kind === 'npm'
      && rule.selectorType === 'all'
  }
  if (rule.kind === 'npm') {
    if (rule.selectorType === 'all') return entry.locatorKind !== 'git'
    return false
  }
  if (rule.kind === 'url') {
    const prefix = ruleSourcePrefix(rule)
    const protocol = entry.locatorBase === undefined ? undefined : sourceProtocol(entry.locatorBase)
    return (entry.locatorKind === 'npm' || entry.locatorKind === 'git')
      && (protocol === 'http:' || protocol === 'https:')
      && entry.locatorMatch !== undefined
      && prefix !== undefined
      && hasBoundaryPrefix(entry.locatorMatch, prefix)
  }
  const prefix = ruleSourcePrefix(rule)
  return entry.locatorKind === 'git' && entry.locatorMatch !== undefined
    && prefix !== undefined && hasBoundaryPrefix(entry.locatorMatch, prefix)
}

function destinationMatches(entry: SourceEntry, rule: SourceRule): boolean {
  const kindMatches = rule.kind === 'url'
    ? entry.locatorKind === 'npm' || entry.locatorKind === 'git'
    : rule.kind === 'git'
      ? entry.locatorKind === 'git'
        || (entry.locatorBase !== undefined
          && /\/(?:tar\.gz|zip)\/[\da-f]{7,64}$/iu.test(entry.locatorBase))
      : entry.locatorKind === 'npm'
  return kindMatches
    && entry.locatorMatch !== undefined
    && hasBoundaryPrefix(entry.locatorMatch, rule.destination)
}

function destinationCommitGuarded(entry: SourceEntry, rule: SourceRule): boolean {
  return rule.kind === 'git' && destinationMatches(entry, rule)
    && entry.locatorBase !== undefined
    && /\/(?:tar\.gz|zip)\/[\da-f]{7,64}$/iu.test(entry.locatorBase)
}

function selectedRule(entry: SourceEntry, rules: readonly SourceRule[]): SourceRule | undefined {
  const sourceCandidates = rules.filter(rule => sourceMatches(entry, rule))
  const candidates = (sourceCandidates.length > 0
    ? sourceCandidates
    : rules.filter(rule => destinationMatches(entry, rule)))
    .sort((left, right) => {
      const tier = ruleTier(right) - ruleTier(left)
      if (tier !== 0) return tier
      if (ruleTier(left) === 3) {
        const prefixLength = ruleLocationLength(right) - ruleLocationLength(left)
        if (prefixLength !== 0) return prefixLength
      }
      return 0
    })
  const first = candidates[0]
  const second = candidates[1]
  if (first !== undefined && second !== undefined
    && ruleTier(first) === ruleTier(second)
    && (ruleTier(first) !== 3
      || ruleLocationLength(first) === ruleLocationLength(second))) {
    throw new TypeError(
      `Overlapping source rules have equal specificity for ${JSON.stringify(entry.key)}: `
      + `${JSON.stringify(first.raw)} and ${JSON.stringify(second.raw)}`,
    )
  }
  return first
}

function sourceProtocol(locatorBase: string): string | undefined {
  try {
    return new URL(locatorBase.startsWith('git+') ? locatorBase.slice(4) : locatorBase).protocol
  } catch {
    return undefined
  }
}

function joinedUrl(destination: string, remainder: string): string {
  const left = destination.replace(/\/+$/u, '')
  const right = remainder.replace(/^\/+/u, '')
  return right === '' ? left : `${left}/${right}`
}

function httpLocatorParts(locatorBase: string): Readonly<{
  marker: string
  path: string
}> | undefined {
  const marker = locatorBase.startsWith('git+') ? 'git+' : ''
  const transport = marker === '' ? locatorBase : locatorBase.slice(marker.length)
  const authority = /^https?:\/\/[^/?#]+/iu.exec(transport)?.[0]
  if (authority === undefined) return undefined
  return Object.freeze({ marker, path: transport.slice(authority.length) })
}

function decodedPackageName(value: string): string | undefined {
  try { return decodeURIComponent(value) } catch { return undefined }
}

function registryLayoutRemainder(path: string, packageName: string | undefined): string | undefined {
  let marker = path.indexOf('/-/')
  while (marker >= 0) {
    const prefix = path.slice(0, marker)
    const starts = [0, ...[...prefix.matchAll(/\//gu)].map(match => (match.index ?? -1) + 1)]
      .filter(start => start >= 0 && start < prefix.length)
      .sort((left, right) => right - left)
    if (packageName !== undefined) {
      for (const start of starts) {
        const candidate = prefix.slice(start)
        if (decodedPackageName(candidate) === packageName) return path.slice(start)
      }
    } else {
      const segments = prefix.split('/')
      const last = segments[segments.length - 1]
      const previous = segments[segments.length - 2]
      if (last !== undefined && last !== '') {
        const rawName = previous?.startsWith('@') === true ? `${previous}/${last}` : last
        return `${rawName}${path.slice(marker)}`
      }
    }
    marker = path.indexOf('/-/', marker + 3)
  }
  return undefined
}

function npmRemainder(entry: SourceEntry): string {
  const parts = entry.locatorBase === undefined ? undefined : httpLocatorParts(entry.locatorBase)
  if (parts === undefined) throw new TypeError(`Entry ${JSON.stringify(entry.key)} has no HTTP locator`)
  return registryLayoutRemainder(parts.path, entry.packageName) ?? parts.path
}

function literalRemainder(entry: SourceEntry, rule: SourceRule): Readonly<{
  marker: string
  remainder: string
}> {
  const parts = entry.locatorBase === undefined ? undefined : httpLocatorParts(entry.locatorBase)
  if (parts === undefined) throw new TypeError(`Entry ${JSON.stringify(entry.key)} has no HTTP locator`)
  const selectorPath = new URL(rule.selector).pathname.replace(/\/+$/u, '')
  if (!parts.path.startsWith(selectorPath)) {
    throw new TypeError(`Entry ${JSON.stringify(entry.key)} does not contain source prefix ${JSON.stringify(rule.selector)}`)
  }
  return Object.freeze({ marker: parts.marker, remainder: parts.path.slice(selectorPath.length) })
}

function rewrittenBase(entry: SourceEntry, rule: SourceRule): string {
  const locatorBase = entry.locatorBase
  const locatorMatch = entry.locatorMatch
  if (locatorBase === undefined || locatorMatch === undefined) {
    throw new TypeError(`Entry ${JSON.stringify(entry.key)} has no rewritable source locator`)
  }
  if (sourceProtocol(locatorBase) === 'https:' && rule.destination.startsWith('http:')) {
    throw new TypeError(`Source rule ${JSON.stringify(rule.raw)} would downgrade HTTPS to HTTP`)
  }

  if (rule.kind === 'url') {
    const { marker, remainder } = literalRemainder(entry, rule)
    return `${marker}${joinedUrl(rule.destination, remainder)}`
  }

  if (rule.kind === 'git') {
    const prefix = ruleSourcePrefix(rule)
    if (prefix === undefined) throw new TypeError(`Invalid git source rule ${JSON.stringify(rule.raw)}`)
    const repositorySuffix = rule.selectorType === 'git-owner'
      ? locatorMatch.slice(prefix.length)
      : ''
    const gitPrefix = /^(?:git\+|git:|ssh:|git@|github:)/iu.test(locatorBase) ? 'git+' : ''
    return `${gitPrefix}${rule.destination}${repositorySuffix}${entry.locatorRemainder ?? ''}`
  }

  return joinedUrl(rule.destination, npmRemainder(entry))
}

function item(
  status: SourceStatus,
  format: FormatId,
  rule: SourceRule,
  entry?: SourceEntry,
  replacement?: string,
  guarantee?: 'bytes' | 'commit',
): SourceResultItem {
  const effectiveGuarantee = entry?.guarantee ?? guarantee
  return Object.freeze({
    status,
    rule,
    format,
    ...(entry === undefined ? {} : {
      key: entry.key,
      ...(entry.packageName === undefined ? {} : { packageName: entry.packageName }),
      ...(entry.locator === undefined ? {} : { locator: entry.locator }),
      ...(effectiveGuarantee === undefined ? {} : { guarantee: effectiveGuarantee }),
      ...(entry.localReason === undefined ? {} : { localReason: entry.localReason }),
    }),
    ...(replacement === undefined ? {} : { rewrittenLocator: replacement }),
  })
}

function countsOf(items: readonly SourceResultItem[]): SourceCounts {
  const counts: Record<SourceStatus, number> = {
    rewritten: 0,
    compliant: 0,
    violation: 0,
    uncertifiable: 0,
    unguarded: 0,
    unrewritable: 0,
    local: 0,
    unmatched: 0,
  }
  for (const result of items) counts[result.status] += 1
  return Object.freeze(counts)
}

function operationInput(
  input: string,
  values: string | SourceRule | readonly (string | SourceRule)[],
  options: SourceOperationOptions,
): Readonly<{
  format: FormatId
  rules: readonly SourceRule[]
  entries: readonly SourceEntry[]
}> {
  const rules = normalizeSourceRules(values)
  validateNoCascade(rules)
  const format = options.format ?? detect(input)
  if (format === undefined) {
    throw new LockfileError({
      code: 'FORMAT_DETECT_FAILED',
      message: 'Unable to detect lockfile format for source operation',
    })
  }
  const unsupported = format === 'lockgraph'
    ? 'a lockgraph snapshot is not a package manager lockfile; run it on the source lockfile'
    : format.startsWith('yarn-berry-')
      ? 'yarn berry records no locator for a registry package; change npmRegistryServer in .yarnrc.yml'
      : format === 'bun-text' || format === 'bun-text-v2'
        ? 'bun records no locator for a registry package; change the registry in .npmrc or bunfig.toml'
        : undefined
  if (unsupported !== undefined) {
    throw new LockfileError({
      code: 'CAPABILITY_LACK',
      message: `Source locator operations are not supported for ${format}: ${unsupported}`,
    })
  }
  return Object.freeze({ format, rules, entries: scanSourceEntries(input, format) })
}

function unmatchedItems(
  format: FormatId,
  rules: readonly SourceRule[],
  matched: ReadonlyMap<SourceRule, number>,
  allowEmptyRules: boolean,
): readonly SourceResultItem[] {
  if (allowEmptyRules) return Object.freeze([])
  return Object.freeze(rules
    .filter(rule => (matched.get(rule) ?? 0) === 0)
    .map(rule => item('unmatched', format, rule)))
}

export function overrideSource(
  input: string,
  rulesInput: string | SourceRule | readonly (string | SourceRule)[],
  options: SourceOperationOptions = {},
): OverrideSourceResult {
  const { format, rules, entries } = operationInput(input, rulesInput, options)
  const matched = new Map<SourceRule, number>()
  const items: SourceResultItem[] = []
  const replacements: Array<Readonly<{ start: number; end: number; value: string }>> = []

  for (const entry of entries) {
    const rule = selectedRule(entry, rules)
    if (rule === undefined) continue
    matched.set(rule, (matched.get(rule) ?? 0) + 1)
    if (entry.localReason !== undefined) {
      items.push(item('local', format, rule, entry))
      continue
    }
    if (entry.locator === undefined || entry.span === undefined) {
      items.push(item('unrewritable', format, rule, entry))
      continue
    }
    const destinationGuarded = destinationCommitGuarded(entry, rule)
    if (destinationMatches(entry, rule) && (entry.guarded || destinationGuarded)) {
      items.push(item('compliant', format, rule, entry, undefined, destinationGuarded ? 'commit' : undefined))
      continue
    }
    if (!entry.guarded) {
      items.push(item('unguarded', format, rule, entry))
      continue
    }
    const replacement = rewrittenBase(entry, rule)
    replacements.push(Object.freeze({
      start: entry.span.start,
      end: entry.span.end,
      value: entry.span.render(replacement),
    }))
    items.push(item('rewritten', format, rule, entry, `${replacement}${entry.locatorTail ?? ''}`))
  }
  items.push(...unmatchedItems(format, rules, matched, options.allowEmptyRules === true))

  replacements.sort((left, right) => right.start - left.start)
  for (let index = 1; index < replacements.length; index += 1) {
    const previous = replacements[index - 1]
    const current = replacements[index]
    if (previous !== undefined && current !== undefined && current.end > previous.start) {
      throw new TypeError('Source rewrite spans overlap')
    }
  }
  let output = input
  for (const replacement of replacements) {
    output = output.slice(0, replacement.start) + replacement.value + output.slice(replacement.end)
  }
  const frozenItems = Object.freeze(items)
  const counts = countsOf(frozenItems)
  return Object.freeze({
    ok: counts.unguarded === 0 && counts.unrewritable === 0 && counts.unmatched === 0,
    format,
    output,
    items: frozenItems,
    counts,
  })
}

export function assertSource(
  input: string,
  rulesInput: string | SourceRule | readonly (string | SourceRule)[],
  options: SourceOperationOptions = {},
): AssertSourceResult {
  const { format, rules, entries } = operationInput(input, rulesInput, options)
  const matched = new Map<SourceRule, number>()
  const items: SourceResultItem[] = []
  for (const entry of entries) {
    const rule = selectedRule(entry, rules)
    if (rule === undefined) continue
    matched.set(rule, (matched.get(rule) ?? 0) + 1)
    if (entry.localReason !== undefined) {
      items.push(item('local', format, rule, entry))
      continue
    }
    const destinationGuarded = destinationCommitGuarded(entry, rule)
    if (entry.locator === undefined) {
      items.push(item('uncertifiable', format, rule, entry))
      continue
    }
    if (!destinationMatches(entry, rule)) {
      items.push(item('violation', format, rule, entry))
      continue
    }
    if (!entry.guarded && !destinationGuarded) {
      items.push(item('uncertifiable', format, rule, entry))
      continue
    }
    items.push(item(
      'compliant',
      format,
      rule,
      entry,
      undefined,
      destinationGuarded ? 'commit' : undefined,
    ))
  }
  items.push(...unmatchedItems(format, rules, matched, options.allowEmptyRules === true))
  const frozenItems = Object.freeze(items)
  const counts = countsOf(frozenItems)
  return Object.freeze({
    ok: counts.violation === 0 && counts.uncertifiable === 0 && counts.unmatched === 0,
    format,
    items: frozenItems,
    counts,
  })
}
