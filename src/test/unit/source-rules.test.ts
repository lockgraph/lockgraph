import { describe, expect, it } from 'vitest'
import { normalizeSourceRules, parseSourceRule } from '../../main/ts/source/rules.ts'

describe('source rule parser', () => {
  it('parses every selector family and normalizes URL prefixes', () => {
    expect(parseSourceRule('npm:@scope/*=https://mirror.example/npm')).toMatchObject({
      selectorType: 'scope',
      selector: '@scope/*',
    })
    expect(parseSourceRule('npm:@scope/name=https://mirror.example/npm')).toMatchObject({
      selectorType: 'package',
      selector: '@scope/name',
    })
    expect(parseSourceRule('npm:*=https://mirror.example/npm')).toMatchObject({
      kind: 'npm',
      selectorType: 'all',
      selector: '*',
    })
    expect(parseSourceRule('https://REGISTRY.EXAMPLE:443/team/=https://mirror.example/npm')).toMatchObject({
      kind: 'url',
      selectorType: 'origin-path',
      selector: 'https://registry.example/team',
    })
    expect(parseSourceRule('git:github.com/owner/*=https://git.example/cache')).toMatchObject({
      selectorType: 'git-owner',
      selector: 'https://github.com/owner/*',
    })
    expect(parseSourceRule('git:https://github.com/owner/repo=https://git.example/cache')).toMatchObject({
      selectorType: 'git-repository',
      selector: 'https://github.com/owner/repo',
    })
  })

  it('returns deeply immutable rule records', () => {
    expect(Object.isFrozen(parseSourceRule('npm:*=https://mirror.example'))).toBe(true)
  })

  it('rejects frozen records whose parsed fields were forged', () => {
    const forged = Object.freeze({
      ...parseSourceRule('npm:*=https://mirror.example'),
      destination: 'http://forged.example',
    })
    expect(() => normalizeSourceRules(forged)).toThrow(/must come from parseSourceRule/u)
  })

  it.each([
    '',
    'npm:*',
    'npm:all=https://mirror.example',
    'npm:default-public=https://mirror.example',
    'npm:https://registry.example/team=https://mirror.example',
    'npm:registry.example/team=https://mirror.example',
    'npm:@scope=https://mirror.example',
    'wat:all=https://mirror.example',
    'git:all=https://mirror.example',
    'git:github.com/owner=https://mirror.example',
    'npm:*=ftp://mirror.example',
    'npm:*=https://user:pass@mirror.example',
    'npm:*=https://mirror.example/path#fragment',
    'npm:registry.example/path?query=https://mirror.example',
    'npm:*=https://mirror.example/%zz',
    ' npm:*=https://mirror.example',
  ])('rejects invalid rule %j', value => {
    expect(() => parseSourceRule(value)).toThrow(TypeError)
  })

  it('refuses git:* because paths are not unique across hosts', () => {
    expect(() => parseSourceRule('git:*=https://mirror.example'))
      .toThrow(/owner\/repository paths are not unique across hosts/u)
  })
})
