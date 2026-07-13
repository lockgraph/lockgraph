import { describe, it, expect } from 'vitest'
import { convert } from '../../main/ts/index.ts'

// yarn 1.0–1.5 carry a registry package's tarball sha1 ONLY as the
// `resolved#<sha1>` fragment — no `integrity:` line. That sha1 is the entry's
// only checksum; dropping it on a cross-family emit strands the lock (an npm
// entry with no `integrity` does not survive `npm ci`). These tests pin that
// the fragment is captured on ingest and carried to every target.

const SHA1_HEX = '5faad9c2c07f60dd76770f71cf025b62a63cfd4e'
const SHA1_SRI = 'sha1-X6rZwsB/YN12dw9xzwJbYqY8/U4=' // == 'sha1-' + base64(hex)
const FRAG_YARN =
  `# yarn lockfile v1\n` +
  `abab@^1.0.1:\n` +
  `  version "1.0.4"\n` +
  `  resolved "https://registry.npmjs.org/abab/-/abab-1.0.4.tgz#${SHA1_HEX}"\n`
const MANIFESTS = { '': { name: 'app', version: '1.0.0', dependencies: { abab: '^1.0.1' } } }
const to = (fmt: string): Promise<string> =>
  convert(FRAG_YARN, { from: 'yarn-classic', to: fmt as never, manifests: MANIFESTS })

const REGISTRY_TARGETS = ['npm-1', 'npm-2', 'npm-3', 'pnpm-v5', 'pnpm-v9', 'bun-text']

describe('yarn-classic resolved#<sha1> fragment → integrity', () => {
  it('npm-3: promotes the fragment sha1 to `integrity` + emits a clean `resolved`', async () => {
    const e = JSON.parse(await to('npm-3')).packages['node_modules/abab']
    expect(e.integrity).toBe(SHA1_SRI)
    expect(e.resolved).toBe('https://registry.npmjs.org/abab/-/abab-1.0.4.tgz')
  })

  it('npm-1: carries the sha1 as `integrity`', async () => {
    const out = await to('npm-1')
    expect(out).toContain(SHA1_SRI)
  })

  it('every registry target carries the sha1 as an `sha1-<base64>` integrity', async () => {
    for (const fmt of REGISTRY_TARGETS) {
      expect(await to(fmt), `${fmt} lost the checksum`).toContain(SHA1_SRI)
    }
  })

  it('no target leaks the raw yarn `#<sha1>` fragment into its output', async () => {
    for (const fmt of REGISTRY_TARGETS) {
      expect(await to(fmt), `${fmt} leaked the fragment`).not.toContain(`#${SHA1_HEX}`)
    }
  })

  it('yarn → yarn: byte-identical — the fragment stays in the URL, no `integrity:` line added', async () => {
    const back = await to('yarn-classic')
    expect(back).toContain(`resolved "https://registry.npmjs.org/abab/-/abab-1.0.4.tgz#${SHA1_HEX}"`)
    expect(back).not.toMatch(/^\s*integrity/m)
  })

  it('an explicit `integrity:` line still wins and is unaffected', async () => {
    const withLine =
      `# yarn lockfile v1\n` +
      `abab@^1.0.1:\n` +
      `  version "1.0.4"\n` +
      `  resolved "https://registry.npmjs.org/abab/-/abab-1.0.4.tgz"\n` +
      `  integrity sha512-Cha2R6XPr4gX6vfChANU/svAWK8bmp5o2FGrfPFqNVjD0As8fFbANv0jVn9CmSg96q3xVEP9UZQ5CIVojYyfjA==\n`
    const e = JSON.parse(await convert(withLine, { from: 'yarn-classic', to: 'npm-3', manifests: MANIFESTS })).packages['node_modules/abab']
    expect(e.integrity).toBe('sha512-Cha2R6XPr4gX6vfChANU/svAWK8bmp5o2FGrfPFqNVjD0As8fFbANv0jVn9CmSg96q3xVEP9UZQ5CIVojYyfjA==')
  })
})
