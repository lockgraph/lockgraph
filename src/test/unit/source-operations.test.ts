import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { LockfileError } from '../../main/ts/api/errors.ts'
import { assertSource, overrideSource } from '../../main/ts/source/operations.ts'
import { scanSourceEntries } from '../../main/ts/source/scanners.ts'

function fixture(name: string): string {
  return readFileSync(new URL(`../resources/fixtures/source-override/${name}`, import.meta.url), 'utf8')
}

function lockfileFixture(name: string): string {
  return readFileSync(new URL(`../resources/fixtures/lockfiles/${name}`, import.meta.url), 'utf8')
}

describe('source locator operations', () => {
  it('rewrites only guarded npm locator spans and reports every blocking bucket', () => {
    const input = fixture('npm-mixed.package-lock.json')
    const rules = 'npm:*=https://mirror.example/npm'
    const result = overrideSource(input, rules)
    expect(result.ok).toBe(false)
    expect(result.counts).toMatchObject({ rewritten: 2, unguarded: 1, unrewritable: 1, local: 3 })
    expect(result.output).toBe(input
      .replace(
        'https://registry.npmjs.org/ms/-/ms-2.1.3.tgz',
        'https://mirror.example/npm/ms/-/ms-2.1.3.tgz',
      )
      .replace(
        'https://packages.example/private/-/private-1.0.0.tgz',
        'https://mirror.example/npm/private/-/private-1.0.0.tgz',
      ))
    expect(result.output).toContain('?cache=1#kept')
    expect(result.output).toContain('"integrity": "sha512-KEPT"')
    expect(result.output).toContain('https://mirror.example/npm/private/-/private-1.0.0.tgz')

    const originalAssertion = assertSource(input, rules)
    expect(originalAssertion.counts).toMatchObject({ violation: 3, uncertifiable: 1, local: 3 })
    expect(originalAssertion.items.find(item => item.packageName === 'unguarded')?.status).toBe('violation')

    const unguardedAtDestination = input.replace(
      'https://registry.npmjs.org/unguarded/-/unguarded-1.0.0.tgz',
      'https://mirror.example/npm/unguarded/-/unguarded-1.0.0.tgz',
    )
    expect(assertSource(
      unguardedAtDestination,
      'npm:unguarded=https://mirror.example/npm',
    ).counts.uncertifiable).toBe(1)

    const assertion = assertSource(result.output, rules)
    expect(assertion.ok).toBe(false)
    expect(assertion.counts).toMatchObject({ compliant: 2, violation: 1, uncertifiable: 1, local: 3 })
  })

  it('accounts for local workspace members without failing source rules', () => {
    const input = fixture('npm-mixed.package-lock.json')
    const rule = 'npm:@corp/*=https://mirror.example/npm'
    const overridden = overrideSource(input, rule)
    expect(overridden.ok).toBe(true)
    expect(overridden.output).toBe(input)
    expect(overridden.counts).toMatchObject({ local: 2, unrewritable: 0, unmatched: 0 })
    expect(new Set(overridden.items.map(item => item.localReason))).toEqual(
      new Set(['workspace-member', 'workspace-link']),
    )
    expect(assertSource(input, rule).ok).toBe(true)
  })

  it('separates npm v1 bundled and local-path entries from registry-derived entries', () => {
    const input = fixture('npm-v1-local.package-lock.json')
    const rule = 'npm:*=https://mirror.example/npm'
    const overridden = overrideSource(input, rule)
    expect(overridden.counts).toMatchObject({ rewritten: 1, local: 4, unrewritable: 1 })
    expect(overridden.output).toContain('https://mirror.example/npm/http-child/-/http-child-1.0.0.tgz')
    expect(new Set(overridden.items.filter(item => item.status === 'local').map(item => item.localReason)))
      .toEqual(new Set(['bundled', 'file', 'link', 'directory']))
    const assertion = assertSource(input, rule)
    expect(assertion.counts).toMatchObject({ violation: 1, local: 4, uncertifiable: 1 })
  })

  it('matches the resolved target name for npm aliases', () => {
    const input = '{"lockfileVersion":3,"packages":{"":{"name":"x"},"node_modules/alias":{"name":"actual","version":"1.0.0","resolved":"https://registry.npmjs.org/actual/-/actual-1.0.0.tgz","integrity":"sha512-x"}}}'
    const result = overrideSource(input, 'npm:actual=https://mirror.example')
    expect(result.ok).toBe(true)
    expect(result.counts.rewritten).toBe(1)
    expect(result.output).toContain('https://mirror.example/actual/-/actual-1.0.0.tgz')
  })

  it('orders explicit URL subsets above npm:*', () => {
    const input = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': { name: 'x' },
        'node_modules/public': {
          name: 'public',
          version: '1.0.0',
          resolved: 'https://registry.npmjs.org/public/-/public-1.0.0.tgz',
          integrity: 'sha512-public',
        },
        'node_modules/private': {
          name: 'private',
          version: '1.0.0',
          resolved: 'https://registry.corp.example/repository/npm/private/-/private-1.0.0.tgz',
          integrity: 'sha512-private',
        },
      },
    })
    const result = overrideSource(input, [
      'npm:*=https://all.example/group',
      'https://registry.npmjs.org=https://public.example/group',
    ])
    expect(result.ok).toBe(true)
    expect(result.counts.rewritten).toBe(2)
    expect(result.output).toContain('https://public.example/group/public/-/public-1.0.0.tgz')
    expect(result.output).toContain('https://all.example/group/private/-/private-1.0.0.tgz')
  })

  it('rebases npm registry paths while preserving scoped-name encoding', () => {
    const input = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': { name: 'x' },
        'node_modules/ms': {
          name: 'ms',
          version: '2.1.3',
          resolved: 'https://registry.corp.example/repository/npm-group/ms/-/ms-2.1.3.tgz',
          integrity: 'sha512-ms',
        },
        'node_modules/@scope/name': {
          name: '@scope/name',
          version: '1.0.0',
          resolved: 'https://registry.corp.example/repository/npm-group/%40scope%2fname/-/name-1.0.0.tgz',
          integrity: 'sha512-scope',
        },
        'node_modules/archive': {
          name: 'archive',
          version: '1.0.0',
          resolved: 'https://registry.corp.example/custom/archive.tgz',
          integrity: 'sha512-archive',
        },
      },
    })
    const result = overrideSource(input, 'npm:*=https://nexus.example/repository/npm-group')
    expect(result.ok).toBe(true)
    expect(result.counts.rewritten).toBe(3)
    expect(result.output).toContain('https://nexus.example/repository/npm-group/ms/-/ms-2.1.3.tgz')
    expect(result.output).toContain(
      'https://nexus.example/repository/npm-group/%40scope%2fname/-/name-1.0.0.tgz',
    )
    expect(result.output).toContain('https://nexus.example/repository/npm-group/custom/archive.tgz')
  })

  it.each([
    ['https://registry.corp.example/npm', 'https://nexus.example/repository/npm-group'],
    ['https://registry.corp.example/npm/', 'https://nexus.example/repository/npm-group'],
    ['https://registry.corp.example/npm', 'https://nexus.example/repository/npm-group/'],
    ['https://registry.corp.example/npm/', 'https://nexus.example/repository/npm-group/'],
  ])('joins bare URL rewrites with one slash for %s', (selector, destination) => {
    const input = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': { name: 'x' },
        'node_modules/ms': {
          name: 'ms',
          version: '2.1.3',
          resolved: 'https://registry.corp.example/npm/ms/-/ms-2.1.3.tgz',
          integrity: 'sha512-ms',
        },
      },
    })
    const result = overrideSource(input, `${selector}=${destination}`)
    expect(result.ok).toBe(true)
    expect(result.output).toContain(
      'https://nexus.example/repository/npm-group/ms/-/ms-2.1.3.tgz',
    )
  })

  it('treats the URL selector scheme as part of the literal prefix', () => {
    const input = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': { name: 'x' },
        'node_modules/secure': {
          name: 'secure',
          resolved: 'https://registry.npmjs.org/secure/-/secure-1.0.0.tgz',
          integrity: 'sha512-secure',
        },
        'node_modules/legacy': {
          name: 'legacy',
          resolved: 'http://registry.npmjs.org/legacy/-/legacy-1.0.0.tgz',
          integrity: 'sha512-legacy',
        },
      },
    })
    const result = overrideSource(
      input,
      'https://registry.npmjs.org=https://nexus.example/repository/npm-group',
    )
    expect(result.ok).toBe(true)
    expect(result.counts.rewritten).toBe(1)
    expect(result.output).toContain(
      'https://nexus.example/repository/npm-group/secure/-/secure-1.0.0.tgz',
    )
    expect(result.output).toContain('http://registry.npmjs.org/legacy/-/legacy-1.0.0.tgz')
  })

  it('applies bare URL rules to git+https while preserving marker and fragment', () => {
    const commit = '47f49741eacf0a3678684738159a87c2011bb026'
    const input = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': { name: 'x' },
        'node_modules/repo': {
          name: 'repo',
          version: `git+https://github.com/owner/repo.git#${commit}`,
          resolved: `git+https://github.com/owner/repo.git#${commit}`,
        },
      },
    })
    const result = overrideSource(
      input,
      'https://github.com/owner=https://nexus.example/git/',
    )
    expect(result.ok).toBe(true)
    expect(result.counts.rewritten).toBe(1)
    expect(result.output).toContain(`git+https://nexus.example/git/repo.git#${commit}`)
  })

  it('refuses equal-length git-pattern and URL locations for one entry', () => {
    const commit = '47f49741eacf0a3678684738159a87c2011bb026'
    const input = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': { name: 'x' },
        'node_modules/repo': {
          name: 'repo',
          version: `git+https://github.com/owner/repo.git#${commit}`,
          resolved: `git+https://github.com/owner/repo.git#${commit}`,
        },
      },
    })
    expect(() => overrideSource(input, [
      'git:github.com/owner/*=https://git-mirror.example/cache',
      'https://github.com/owner=https://url-mirror.example/cache',
    ])).toThrow(/equal specificity/u)
  })

  it('keeps scope precedence above long URL prefixes and chooses the longest URL prefix', () => {
    const input = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': { name: 'x' },
        'node_modules/@scope/name': {
          name: '@scope/name',
          version: '1.0.0',
          resolved: 'https://registry.example/a/b/c/d/@scope/name/-/name-1.0.0.tgz',
          integrity: 'sha512-scope',
        },
        'node_modules/plain': {
          name: 'plain',
          version: '1.0.0',
          resolved: 'https://registry.example/a/b/c/d/plain/-/plain-1.0.0.tgz',
          integrity: 'sha512-plain',
        },
      },
    })
    const result = overrideSource(input, [
      'npm:@scope/*=https://scope.example/group',
      'https://registry.example/a=https://short.example/group',
      'https://registry.example/a/b/c/d=https://long.example/group',
    ], { allowEmptyRules: true })
    expect(result.ok).toBe(true)
    expect(result.output).toContain('https://scope.example/group/@scope/name/-/name-1.0.0.tgz')
    expect(result.output).toContain('https://long.example/group/plain/-/plain-1.0.0.tgz')
    expect(result.output).not.toContain('https://short.example/group')
  })

  it('orders an exact scoped package above its scope pattern', () => {
    const input = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': { name: 'x' },
        'node_modules/@scope/pkg': {
          name: '@scope/pkg',
          version: '1.0.0',
          resolved: 'https://registry.example/npm/@scope/pkg/-/pkg-1.0.0.tgz',
          integrity: 'sha512-pkg',
        },
        'node_modules/@scope/other': {
          name: '@scope/other',
          version: '1.0.0',
          resolved: 'https://registry.example/npm/@scope/other/-/other-1.0.0.tgz',
          integrity: 'sha512-other',
        },
      },
    })
    const result = overrideSource(input, [
      'npm:@scope/*=https://scope.example/group',
      'npm:@scope/pkg=https://package.example/group',
    ])
    expect(result.ok).toBe(true)
    expect(result.counts.rewritten).toBe(2)
    expect(result.output).toContain('https://package.example/group/@scope/pkg/-/pkg-1.0.0.tgz')
    expect(result.output).toContain('https://scope.example/group/@scope/other/-/other-1.0.0.tgz')
  })

  it('preserves yarn classic inline sha1 byte-for-byte', () => {
    const input = fixture('yarn-classic-inline-sha1.lock')
    const result = overrideSource(input, 'https://registry.yarnpkg.com=https://mirror.example/npm', {
      format: 'yarn-classic',
    })
    expect(result.ok).toBe(true)
    expect(result.counts.local).toBe(0)
    expect(result.output).toBe(input.replace(
      'https://registry.yarnpkg.com/ms/-/ms-2.1.3.tgz',
      'https://mirror.example/npm/ms/-/ms-2.1.3.tgz',
    ))
    expect(result.output).toContain('?cache=kept#574c8138ce1d2b5861f0b44579dbadd60c6615b2"')
    expect(result.output).toContain('#574c8138ce1d2b5861f0b44579dbadd60c6615b2"')
  })

  it('accounts for every yarn classic resolved locator in a conflicted block', () => {
    const input = [
      'form-data@^2.1.2:',
      '<<<<<<< HEAD',
      '  resolved "http://registry.yarnpkg.com/form-data/-/form-data-2.1.2.tgz#1111111111111111111111111111111111111111"',
      '=======',
      '  resolved "https://registry.yarnpkg.com/form-data/-/form-data-2.1.4.tgz#2222222222222222222222222222222222222222"',
      '>>>>>>> branch',
      '',
    ].join('\n')
    const result = overrideSource(input, 'npm:*=https://mirror.example/npm', {
      format: 'yarn-classic',
    })
    expect(result.ok).toBe(true)
    expect(result.counts.rewritten).toBe(2)
    expect(result.output.match(/https:\/\/mirror\.example\/npm\/form-data\/-\/form-data-2\.1\.[24]\.tgz/gu))
      .toHaveLength(2)
  })

  it('rewrites commit-addressed git locators only under explicit git rules', () => {
    const input = fixture('yarn-classic-git.lock')
    expect(overrideSource(input, 'npm:*=https://mirror.example', {
      format: 'yarn-classic',
    }).counts.unmatched).toBe(1)

    const result = overrideSource(
      input,
      'git:github.com/sindresorhus/is=https://mirror.example/git/is',
      { format: 'yarn-classic' },
    )
    expect(result.ok).toBe(true)
    expect(result.items[0]?.guarantee).toBe('commit')
    expect(result.output).toContain(
      'https://mirror.example/git/is/tar.gz/47f49741eacf0a3678684738159a87c2011bb026',
    )
    const idempotent = overrideSource(
      result.output,
      'git:github.com/sindresorhus/is=https://mirror.example/git/is',
      { format: 'yarn-classic' },
    )
    expect(idempotent.ok).toBe(true)
    expect(idempotent.counts.compliant).toBe(1)
    expect(idempotent.items[0]?.guarantee).toBe('commit')
    expect(idempotent.output).toBe(result.output)
    const assertion = assertSource(result.output, 'git:github.com/sindresorhus/is=https://mirror.example/git/is', {
      format: 'yarn-classic',
    })
    expect(assertion.ok).toBe(true)
    expect(assertion.items[0]?.guarantee).toBe('commit')
  })

  it('rewrites npm v1 tarball versions and commit-addressed git shorthands', () => {
    const input = lockfileFixture('git-github-tarball/npm-1.lock')
    const tarball = overrideSource(input, 'https://registry.npmjs.org=https://mirror.example/npm')
    expect(tarball.ok).toBe(true)
    expect(tarball.counts.rewritten).toBe(1)
    expect(tarball.output).toBe(input.replace(
      'https://registry.npmjs.org/ms/-/ms-2.1.3.tgz',
      'https://mirror.example/npm/ms/-/ms-2.1.3.tgz',
    ))
    expect(tarball.output).toContain('"integrity": "sha512-6FlzubTLZG3J2a/NVCAleEhjzq5oxgHyaCU9yYXvcLsvoVaHJq/s5xXI6/XXP6tz7R9xAOtHnSO/tXtF3WRTlA=="')

    const git = overrideSource(input, 'git:github.com/sindresorhus/is=https://mirror.example/git/is')
    expect(git.ok).toBe(true)
    expect(git.counts.rewritten).toBe(2)
    expect(git.output).toContain(
      'git+https://mirror.example/git/is.git#47f49741eacf0a3678684738159a87c2011bb026',
    )
    expect(git.output.match(/#47f49741eacf0a3678684738159a87c2011bb026/gu)).toHaveLength(2)
    expect(assertSource(git.output, 'git:github.com/sindresorhus/is=https://mirror.example/git/is').ok)
      .toBe(true)
  })

  it('rewrites npm v2 git+ssh locators without changing commit fragments', () => {
    const input = lockfileFixture('git-github-tarball/npm-2.lock')
    const npmRule = overrideSource(input, 'npm:@sindresorhus/is=https://mirror.example/npm')
    expect(npmRule.output).toBe(input)
    expect(npmRule.counts).toMatchObject({ rewritten: 0, unmatched: 1 })

    const result = overrideSource(input, 'git:github.com/sindresorhus/is=https://mirror.example/git/is')
    expect(result.ok).toBe(true)
    expect(result.counts.rewritten).toBe(4)
    expect(result.output.match(
      /git\+https:\/\/mirror\.example\/git\/is\.git#47f49741eacf0a3678684738159a87c2011bb026/gu,
    )).toHaveLength(4)
    expect(assertSource(result.output, 'git:github.com/sindresorhus/is=https://mirror.example/git/is').ok)
      .toBe(true)
  })

  it('rewrites pnpm explicit resolution.tarball while keeping integrity', () => {
    const input = fixture('pnpm-explicit.yaml')
    const result = overrideSource(input, 'https://registry.npmjs.org=https://mirror.example/npm', {
      format: 'pnpm-v9',
    })
    expect(result.ok).toBe(true)
    expect(result.counts.local).toBe(0)
    expect(result.output).toBe(input.replace(
      'https://registry.npmjs.org/ms/-/ms-2.1.3.tgz',
      'https://mirror.example/npm/ms/-/ms-2.1.3.tgz',
    ))
    expect(result.output).toContain('integrity: sha512-KEPT')
  })

  it('rewrites quoted block-style pnpm tarballs without touching query carriers', () => {
    const input = fixture('pnpm-explicit-block.yaml')
    const result = overrideSource(input, 'https://registry.npmjs.org=https://mirror.example/npm', {
      format: 'pnpm-v6',
    })
    expect(result.ok).toBe(true)
    expect(result.output).toBe(input.replace(
      'https://registry.npmjs.org/ms/-/ms-2.1.3.tgz',
      'https://mirror.example/npm/ms/-/ms-2.1.3.tgz',
    ))
    expect(result.output).toContain('?signature=kept\'')
  })

  it('rewrites deno explicit npm tarballs and fails closed on derived locators', () => {
    const input = fixture('deno-explicit.lock')
    const result = overrideSource(input, 'npm:*=https://mirror.example/npm', { format: 'deno-v5' })
    expect(result.counts).toMatchObject({ rewritten: 1, unrewritable: 1 })
    expect(result.output).toBe(input.replace(
      'https://registry.npmjs.org/ms/-/ms-2.1.3.tgz',
      'https://mirror.example/npm/ms/-/ms-2.1.3.tgz',
    ))
    expect(assertSource(result.output, 'npm:*=https://mirror.example/npm', {
      format: 'deno-v5',
    }).counts.uncertifiable).toBe(1)
  })

  it.each([
    ['npm v3', 'npm-mixed.package-lock.json', 'npm-3', 'node_modules/derived'],
    ['npm v1', 'npm-v1-local.package-lock.json', 'npm-1', 'registry-derived'],
    ['pnpm', 'pnpm-explicit.yaml', 'pnpm-v9', 'derived@1.0.0'],
    ['deno', 'deno-explicit.lock', 'deno-v5', 'derived@1.0.0'],
  ] as const)('reports a missing %s locator under npm:* in both operations', (
    _label,
    fixtureName,
    format,
    missingKey,
  ) => {
    const input = fixture(fixtureName)
    const rule = 'npm:*=https://mirror.example/npm'
    const overridden = overrideSource(input, rule, { format })
    expect(overridden.ok).toBe(false)
    expect(overridden.counts.unrewritable).toBe(1)
    expect(overridden.items.find(item => item.key === missingKey)?.status).toBe('unrewritable')

    const assertion = assertSource(overridden.output, rule, { format })
    expect(assertion.ok).toBe(false)
    expect(assertion.counts.compliant).toBeGreaterThan(0)
    expect(assertion.counts.uncertifiable).toBe(1)
    expect(assertion.items.find(item => item.key === missingKey)?.status).toBe('uncertifiable')
  })

  it('reports unmatched rules unless allowEmptyRules is explicit', () => {
    const input = fixture('npm-mixed.package-lock.json')
    expect(overrideSource(input, 'npm:left-pad=https://mirror.example').counts.unmatched).toBe(1)
    expect(overrideSource(input, 'npm:left-pad=https://mirror.example', {
      allowEmptyRules: true,
    }).counts.unmatched).toBe(0)
  })

  it('uses package identity when several rules share a destination', () => {
    const input = fixture('npm-mixed.package-lock.json')
    const rules = [
      'npm:ms=https://mirror.example/npm',
      'npm:private=https://mirror.example/npm',
    ]
    const result = overrideSource(input, rules)
    expect(result.counts.rewritten).toBe(2)
    const idempotent = overrideSource(result.output, rules)
    expect(idempotent.counts.compliant).toBe(2)
    expect(idempotent.output).toBe(result.output)
  })

  it('maps each native locator in the real fixture matrix to one unique rewrite span', () => {
    const cases = [
      [fixture('npm-mixed.package-lock.json'), 'npm-3'],
      [fixture('npm-v1-local.package-lock.json'), 'npm-1'],
      [fixture('yarn-classic-inline-sha1.lock'), 'yarn-classic'],
      [fixture('yarn-classic-git.lock'), 'yarn-classic'],
      [fixture('pnpm-explicit.yaml'), 'pnpm-v9'],
      [fixture('pnpm-explicit-block.yaml'), 'pnpm-v6'],
      [fixture('deno-explicit.lock'), 'deno-v5'],
      [lockfileFixture('git-github-tarball/npm-1.lock'), 'npm-1'],
      [lockfileFixture('git-github-tarball/npm-2.lock'), 'npm-2'],
    ] as const
    for (const [input, format] of cases) {
      const native = scanSourceEntries(input, format).filter(entry => entry.locatorKind !== undefined)
      const spans = native.map(entry => entry.span)
      expect(spans.every(span => span !== undefined)).toBe(true)
      expect(new Set(spans.map(span => `${span?.start}:${span?.end}`)).size).toBe(native.length)
    }
  })

  it('rejects HTTPS downgrades, cascades, and equal-specificity overlaps', () => {
    const input = '{"lockfileVersion":3,"packages":{"":{"name":"x"},"node_modules/ms":{"name":"ms","resolved":"https://registry.npmjs.org/ms/-/ms.tgz","integrity":"sha512-x"}}}'
    expect(() => overrideSource(input, 'npm:ms=http://mirror.example')).toThrow(/downgrade/u)
    expect(() => overrideSource(input, [
      'npm:ms=https://packages.example/cache',
      'https://packages.example=https://mirror.example',
    ])).toThrow(/is matched by/u)
    expect(() => overrideSource(input, [
      'https://registry.npmjs.org=https://one.example',
      'https://registry.npmjs.org=https://two.example',
    ])).toThrow(/identical selectors/u)
  })

  it('reports a known unsupported format with a domain error', () => {
    try {
      overrideSource('__metadata:\n  version: 8\n', 'npm:*=https://mirror.example', {
        format: 'yarn-berry-v8',
      })
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(LockfileError)
      expect((error as LockfileError).code).toBe('CAPABILITY_LACK')
    }
  })
})
