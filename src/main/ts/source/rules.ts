export type SourceRuleKind = 'npm' | 'git' | 'url'

export type SourceRuleSelectorType =
  | 'all'
  | 'package'
  | 'scope'
  | 'origin'
  | 'origin-path'
  | 'git-owner'
  | 'git-repository'

export interface SourceRule {
  readonly raw: string
  readonly kind: SourceRuleKind
  readonly selector: string
  readonly selectorType: SourceRuleSelectorType
  readonly destination: string
  readonly specificity: number
}

function invalidRule(raw: string, reason: string): never {
  throw new TypeError(`Invalid source rule ${JSON.stringify(raw)}: ${reason}`)
}

function assertPercentEncoding(value: string, raw: string): void {
  if (/%(?![\da-f]{2})/iu.test(value)) invalidRule(raw, 'malformed percent escape')
}

function canonicalUrlPrefix(value: string, raw: string, role: 'selector' | 'destination'): string {
  assertPercentEncoding(value, raw)
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return invalidRule(raw, `${role} must be an absolute URL`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return invalidRule(raw, `${role} must use http or https`)
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return invalidRule(raw, `${role} must not contain credentials`)
  }
  if (parsed.hash !== '') return invalidRule(raw, `${role} must not contain a fragment`)
  if (parsed.search !== '') return invalidRule(raw, `${role} must not contain a query`)
  parsed.hostname = parsed.hostname.toLowerCase()
  if ((parsed.protocol === 'https:' && parsed.port === '443')
    || (parsed.protocol === 'http:' && parsed.port === '80')) {
    parsed.port = ''
  }
  const path = parsed.pathname === '/'
    ? ''
    : parsed.pathname.replace(/\/+$/u, '')
  return `${parsed.protocol}//${parsed.host}${path}${parsed.search}`
}

function selectorUrl(value: string, raw: string): string {
  return canonicalUrlPrefix(
    /^[a-z][a-z\d+.-]*:\/\//iu.test(value) ? value : `https://${value}`,
    raw,
    'selector',
  )
}

function selectorPathSegments(prefix: string): string[] {
  return new URL(prefix).pathname.split('/').filter(Boolean)
}

function urlSpecificity(prefix: string): number {
  const location = new URL(prefix).pathname.replace(/\/+$/u, '')
  return 300 + location.length / (location.length + 1)
}

function isOriginSelector(value: string): boolean {
  if (/^https?:\/\//iu.test(value)) return true
  if (value.startsWith('@')) return false
  const slash = value.indexOf('/')
  if (slash < 0) return false
  const host = value.slice(0, slash)
  return host === 'localhost' || host.includes('.') || host.includes(':')
}

function packageSelector(value: string, raw: string): Readonly<{
  selector: string
  selectorType: 'package' | 'scope'
  specificity: number
}> {
  if (value.endsWith('/*')) {
    const scope = value.slice(0, -2)
    if (!/^@[a-z\d][a-z\d._-]*$/iu.test(scope)) {
      return invalidRule(raw, 'invalid npm scope selector')
    }
    return Object.freeze({ selector: `${scope}/*`, selectorType: 'scope', specificity: 400 })
  }
  if (!/^(?:@[a-z\d][a-z\d._-]*\/)?[a-z\d][a-z\d._-]*$/iu.test(value)) {
    return invalidRule(raw, 'invalid npm package selector')
  }
  return Object.freeze({ selector: value, selectorType: 'package', specificity: 500 })
}

function parseNpmSelector(value: string, raw: string): Readonly<{
  selector: string
  selectorType: SourceRuleSelectorType
  specificity: number
}> {
  if (value === '*') {
    return Object.freeze({ selector: value, selectorType: 'all', specificity: 100 })
  }
  if (value === 'all') return invalidRule(raw, 'npm:all was replaced by npm:*')
  if (value === 'default-public') {
    return invalidRule(raw, 'npm:default-public was removed; use npm:* or an explicit URL')
  }
  if (isOriginSelector(value)) {
    return invalidRule(raw, 'npm URL selectors were removed; use a bare URL rule')
  }
  return packageSelector(value, raw)
}

function parseGitSelector(value: string, raw: string): Readonly<{
  selector: string
  selectorType: 'git-owner' | 'git-repository'
  specificity: number
}> {
  if (value === '*') {
    return invalidRule(
      raw,
      'git:* is not supported because owner/repository paths are not unique across hosts',
    )
  }
  if (value === 'all' || value === 'default-public') {
    return invalidRule(raw, 'git rules require an explicit owner or repository')
  }
  const selector = selectorUrl(value, raw)
  const segments = selectorPathSegments(selector)
  if (segments.length !== 2) {
    return invalidRule(raw, 'git selector must be origin/owner/* or origin/owner/repository')
  }
  if (segments[0] === undefined || segments[0] === '' || segments[1] === undefined || segments[1] === '') {
    return invalidRule(raw, 'git selector must include owner and repository')
  }
  if (segments[1] === '*') {
    const ownerPrefix = selector.slice(0, -1).replace(/\/+$/u, '')
    return Object.freeze({
      selector: `${ownerPrefix}/*`,
      selectorType: 'git-owner',
      specificity: urlSpecificity(ownerPrefix),
    })
  }
  if (segments[0] === '*' || segments[1].includes('*')) {
    return invalidRule(raw, 'wildcards are allowed only as the repository segment')
  }
  const repository = segments[1]
  const canonical = repository.endsWith('.git') ? selector.slice(0, -4) : selector
  return Object.freeze({
    selector: canonical,
    selectorType: 'git-repository',
    specificity: urlSpecificity(canonical),
  })
}

export function parseSourceRule(raw: string): SourceRule {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new TypeError('Source rule must be a non-empty string')
  }
  if (raw !== raw.trim()) invalidRule(raw, 'leading or trailing whitespace is not allowed')
  const bareUrl = /^https?:\/\//iu.test(raw)
  const colon = raw.indexOf(':')
  const equals = raw.indexOf('=', bareUrl ? 0 : colon + 1)
  if ((!bareUrl && colon <= 0) || equals <= (bareUrl ? 0 : colon + 1) || equals === raw.length - 1) {
    return invalidRule(raw, 'expected <selector>=<destination>')
  }
  const kind: SourceRuleKind = bareUrl ? 'url' : raw.slice(0, colon) as SourceRuleKind
  if (kind !== 'npm' && kind !== 'git' && kind !== 'url') {
    invalidRule(raw, 'kind must be npm or git, or the selector must be an http(s) URL')
  }
  const selectorText = raw.slice(bareUrl ? 0 : colon + 1, equals)
  const destinationText = raw.slice(equals + 1)
  const parsedSelector = kind === 'npm'
    ? parseNpmSelector(selectorText, raw)
    : kind === 'git'
      ? parseGitSelector(selectorText, raw)
      : (() => {
          const selector = canonicalUrlPrefix(selectorText, raw, 'selector')
          const path = selectorPathSegments(selector)
          return Object.freeze({
            selector,
            selectorType: path.length === 0 ? 'origin' as const : 'origin-path' as const,
            specificity: urlSpecificity(selector),
          })
        })()
  const destination = canonicalUrlPrefix(destinationText, raw, 'destination')
  return Object.freeze({
    raw,
    kind,
    selector: parsedSelector.selector,
    selectorType: parsedSelector.selectorType,
    destination,
    specificity: parsedSelector.specificity,
  })
}

export function normalizeSourceRules(
  values: string | SourceRule | readonly (string | SourceRule)[],
): readonly SourceRule[] {
  const inputs = Array.isArray(values) ? values : [values]
  if (inputs.length === 0) throw new TypeError('At least one source rule is required')
  const rules = inputs.map(value => typeof value === 'string' ? parseSourceRule(value) : value)
  for (const [index, rule] of rules.entries()) {
    if (rule === null || typeof rule !== 'object' || !Object.isFrozen(rule)) {
      throw new TypeError(`Source rule at index ${index} must come from parseSourceRule()`)
    }
    const parsed = parseSourceRule(rule.raw)
    if (rule.kind !== parsed.kind
      || rule.selector !== parsed.selector
      || rule.selectorType !== parsed.selectorType
      || rule.destination !== parsed.destination
      || rule.specificity !== parsed.specificity) {
      throw new TypeError(`Source rule at index ${index} must come from parseSourceRule()`)
    }
  }

  for (let left = 0; left < rules.length; left += 1) {
    const a = rules[left]
    if (a === undefined) continue
    for (let right = left + 1; right < rules.length; right += 1) {
      const b = rules[right]
      if (b === undefined) continue
      if (a.kind === b.kind && a.selector === b.selector) {
        throw new TypeError(`Overlapping source rules have identical selectors: ${JSON.stringify(a.selector)}`)
      }
    }
  }
  return Object.freeze([...rules])
}
