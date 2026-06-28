// registry/config — DETERMINISTIC, per-ecosystem registry routing + HOST-BOUND
// auth. Focus: the security invariants — no cross-registry token leak, https-only,
// longest-prefix, the auth taxonomy (§2), and ecosystem ISOLATION (npm and yarn
// directives never mix, so a planted foreign config can't inject).

import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveRegistry, DEFAULT_REGISTRY, type Ecosystem } from '../../main/ts/registry/config.ts'
import { liveRegistry } from '../../main/ts/registry/live.ts'

const mkdir = (files: Record<string, string>): string => {
  const dir = mkdtempSync(join(tmpdir(), 'lf-reg-'))
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content)
  return dir
}
type Opts = { ecosystem?: Ecosystem; env?: Record<string, string | undefined>; registry?: string }
// Project files + an EMPTY temp home (isolate from real ~/.npmrc) + empty env;
// ecosystem defaults to npm. Overridable via opts.
const resolve = (files: Record<string, string>, opts: Opts = {}) =>
  resolveRegistry(mkdir(files), { ecosystem: 'npm', home: mkdir({}), env: {}, ...opts })

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64')
const basic = (cred: string) => `Basic ${b64(cred)}`

describe('registry/config — resolveRegistry', () => {
  it('defaults to registry.npmjs.org with no token', () => {
    const c = resolve({})
    expect(c.registryFor('lodash')).toBe(DEFAULT_REGISTRY)
    expect(c.registryFor('@scope/x')).toBe(DEFAULT_REGISTRY)
    expect(c.tokenFor(DEFAULT_REGISTRY)).toBeUndefined()
  })

  it('routes a scope to its registry — .npmrc `@scope:registry` and yarn `npmScopes`', () => {
    const npm = resolve({ '.npmrc': '@acme:registry=https://acme.example.com/\n' })
    expect(npm.registryFor('@acme/widget')).toBe('https://acme.example.com')
    expect(npm.registryFor('lodash')).toBe(DEFAULT_REGISTRY)

    const yarn = resolve({ '.yarnrc.yml': 'npmScopes:\n  acme:\n    npmRegistryServer: "https://acme.example.com"\n' }, { ecosystem: 'yarn-berry' })
    expect(yarn.registryFor('@acme/widget')).toBe('https://acme.example.com')
  })

  it('binds a token to its host — no leak to another registry (.npmrc)', () => {
    const c = resolve({ '.npmrc': '@acme:registry=https://acme.example.com/\n//acme.example.com/:_authToken=ACME_TOK\n' })
    expect(c.tokenFor('https://acme.example.com')).toBe('ACME_TOK')
    expect(c.tokenFor('https://acme.example.com/@acme%2Fwidget')).toBe('ACME_TOK')
    expect(c.tokenFor('https://evil.example.com')).toBeUndefined()
    expect(c.tokenFor(DEFAULT_REGISTRY)).toBeUndefined()
  })

  it('yarn `npmRegistries: "//host"` token resolves (the silently-dropped bug)', () => {
    const c = resolve({ '.yarnrc.yml': 'npmRegistries:\n  "//acme.example.com/":\n    npmAuthToken: "YARN_TOK"\n' }, { ecosystem: 'yarn-berry' })
    expect(c.tokenFor('https://acme.example.com')).toBe('YARN_TOK')
    expect(c.tokenFor('https://other.example.com')).toBeUndefined()
  })

  it('is https-only — never hands a token to a plaintext URL', () => {
    const c = resolve({ '.npmrc': 'registry=http://insecure.example.com/\n//insecure.example.com/:_authToken=TOK\n' })
    expect(c.registryFor('lodash')).toBe('http://insecure.example.com')
    expect(c.tokenFor('http://insecure.example.com')).toBeUndefined()
    expect(c.tokenFor('https://insecure.example.com')).toBe('TOK')
  })

  it('longest matching prefix wins (most specific credential)', () => {
    const c = resolve({ '.npmrc': '//host.example.com/:_authToken=ROOT\n//host.example.com/team/:_authToken=TEAM\n' })
    expect(c.tokenFor('https://host.example.com/team/pkg')).toBe('TEAM')
    expect(c.tokenFor('https://host.example.com/other')).toBe('ROOT')
  })

  it('expands ${VAR} from env only', () => {
    const c = resolve({ '.npmrc': '//host.example.com/:_authToken=${MY_TOKEN}\n' }, { env: { MY_TOKEN: 's3cret' } })
    expect(c.tokenFor('https://host.example.com')).toBe('s3cret')
  })

  it('rejects prototype-pollution keys from config', () => {
    const c = resolve({ '.npmrc': '@__proto__:registry=https://evil.example.com/\n' })
    expect((Object.prototype as Record<string, unknown>)['@__proto__']).toBeUndefined()
    expect(c.registryFor('lodash')).toBe(DEFAULT_REGISTRY)
  })

  it('precedence: explicit override > env > project files', () => {
    const files = { '.npmrc': 'registry=https://from-file.example.com/\n' }
    expect(resolve(files).registryFor('x')).toBe('https://from-file.example.com')
    expect(resolve(files, { env: { npm_config_registry: 'https://from-env.example.com/' } }).registryFor('x')).toBe('https://from-env.example.com')
    expect(resolve(files, { registry: 'https://from-flag.example.com/' }).registryFor('x')).toBe('https://from-flag.example.com')
  })
})

describe('registry/config — auth taxonomy (§2)', () => {
  it('Bearer `_authToken` → Bearer header + tokenFor', () => {
    const c = resolve({ '.npmrc': '//host.example.com/:_authToken=TOK\n' })
    expect(c.authHeaderFor('https://host.example.com')).toBe('Bearer TOK')
    expect(c.tokenFor('https://host.example.com')).toBe('TOK')
  })

  it('Basic legacy `_auth` → Basic header, not Bearer (the latent-bug fix)', () => {
    const c = resolve({ '.npmrc': `//host.example.com/:_auth=${b64('user:pass')}\n` })
    expect(c.authHeaderFor('https://host.example.com')).toBe(basic('user:pass'))
    expect(c.tokenFor('https://host.example.com')).toBeUndefined()
  })

  it('Basic split `username` + base64 `_password` → assembled Basic header', () => {
    const c = resolve({ '.npmrc': `//host.example.com/:username=user\n//host.example.com/:_password=${b64('pass')}\n` })
    expect(c.authHeaderFor('https://host.example.com')).toBe(basic('user:pass'))
  })

  it('yarn `npmAuthIdent` → Basic header', () => {
    const c = resolve({ '.yarnrc.yml': 'npmRegistryServer: "https://y.example.com"\nnpmAuthIdent: "user:pass"\n' }, { ecosystem: 'yarn-berry' })
    expect(c.authHeaderFor('https://y.example.com')).toBe(basic('user:pass'))
  })

  it('npm_config_* env is a config layer (auth + scope) above project files', () => {
    const c = resolve(
      { '.npmrc': '//host.example.com/:_authToken=FROM_FILE\n' },
      { env: { 'npm_config_//host.example.com/:_authToken': 'FROM_ENV', 'npm_config_@acme:registry': 'https://acme.example.com/' } },
    )
    expect(c.authHeaderFor('https://host.example.com')).toBe('Bearer FROM_ENV')
    expect(c.registryFor('@acme/widget')).toBe('https://acme.example.com')
  })

  it('YARN_NPM_* env globals — registry + Basic ident', () => {
    const c = resolve({}, { ecosystem: 'yarn-berry', env: { YARN_NPM_REGISTRY_SERVER: 'https://y.example.com/', YARN_NPM_AUTH_IDENT: 'user:pass' } })
    expect(c.registryFor('x')).toBe('https://y.example.com')
    expect(c.authHeaderFor('https://y.example.com')).toBe(basic('user:pass'))
  })
})

describe('registry/config — ecosystem ISOLATION (no npm/yarn directive mixing)', () => {
  const PLANTED_NPMRC = 'registry=https://evil.example.com/\n//evil.example.com/:_authToken=STOLEN\n'
  const PLANTED_YARN  = 'npmRegistryServer: "https://evil.example.com"\nnpmRegistries:\n  "//evil.example.com/":\n    npmAuthToken: "STOLEN"\n'

  it('npm/pnpm ignore a planted .yarnrc.yml', () => {
    const files = { '.npmrc': 'registry=https://good.example.com/\n', '.yarnrc.yml': PLANTED_YARN }
    for (const ecosystem of ['npm', 'pnpm'] as const) {
      const c = resolve(files, { ecosystem })
      expect(c.registryFor('x')).toBe('https://good.example.com')        // .yarnrc.yml not read
      expect(c.tokenFor('https://evil.example.com')).toBeUndefined()
    }
  })

  it('yarn-berry ignores a planted .npmrc', () => {
    const c = resolve({ '.yarnrc.yml': 'npmRegistryServer: "https://good.example.com"\n', '.npmrc': PLANTED_NPMRC }, { ecosystem: 'yarn-berry' })
    expect(c.registryFor('x')).toBe('https://good.example.com')          // .npmrc not read
    expect(c.tokenFor('https://evil.example.com')).toBeUndefined()
  })

  it('env namespaces do not cross — npm ignores YARN_*, yarn-berry ignores npm_config_*', () => {
    expect(resolve({}, { ecosystem: 'npm', env: { YARN_NPM_REGISTRY_SERVER: 'https://evil.example.com/' } }).registryFor('x')).toBe(DEFAULT_REGISTRY)
    expect(resolve({}, { ecosystem: 'yarn-berry', env: { npm_config_registry: 'https://evil.example.com/' } }).registryFor('x')).toBe(DEFAULT_REGISTRY)
  })

  it('yarn-classic reads .yarnrc + .npmrc (its real sources), not .yarnrc.yml', () => {
    const c = resolve({ '.yarnrc': 'registry "https://good.example.com/"\n', '.npmrc': '//good.example.com/:_authToken=CLASSIC_TOK\n', '.yarnrc.yml': PLANTED_YARN }, { ecosystem: 'yarn-classic' })
    expect(c.registryFor('x')).toBe('https://good.example.com')
    expect(c.tokenFor('https://good.example.com')).toBe('CLASSIC_TOK')
    expect(c.tokenFor('https://evil.example.com')).toBeUndefined()        // .yarnrc.yml not read
  })
})

describe('registry/config — liveRegistry.fromConfig', () => {
  it('opens the scoped registry and sends its host-bound token (end-to-end)', async () => {
    const cwd = mkdir({ '.npmrc': '@acme:registry=https://acme.example.com/\n//acme.example.com/:_authToken=ACME_TOK\n' })
    const calls: Array<{ url: string; auth?: string }> = []
    const fetchSpy = (async (url: string, init?: { headers?: Record<string, string> }) => {
      calls.push({ url: String(url), auth: init?.headers?.authorization })
      return { ok: true, status: 200, json: async () => ({ name: '@acme/widget', versions: {} }) }
    }) as unknown as typeof fetch

    const reg = liveRegistry.fromConfig(cwd, '@acme/widget', { ecosystem: 'npm', home: mkdir({}), env: {}, fetch: fetchSpy })
    await reg.packument('@acme/widget')

    expect(calls[0]!.url).toBe('https://acme.example.com/@acme%2Fwidget')
    expect(calls[0]!.auth).toBe('Bearer ACME_TOK')
  })
})
