import { describe, expect, it } from 'vitest'
import { convert, parse, stringify } from '../../main/ts/index.ts'

// Round-2 enterprise discovery: a cross-format convert to npm must NOT leak a
// yarn-berry locator into the `resolved` field (it makes the lock `npm ci`-
// unusable), and a `file:` archive carrying a `::locator=` qualifier keeps its
// `linkType: hard`.
const CK = (c: string) => '10c0/' + c.repeat(128)

describe('yarn-berry → npm: a private-registry `::__archiveUrl=` package emits a valid resolved URL', () => {
  const lock = `__metadata:
  version: 8
  cacheKey: 10c0

"app@workspace:.":
  version: 0.0.0-use.local
  resolution: "app@workspace:."
  dependencies:
    "@company/widget": "npm:^1.2.3"
  languageName: unknown
  linkType: soft

"@company/widget@npm:1.2.3::__archiveUrl=https%3A%2F%2Fnpm.corp.com%2F%40company%2Fwidget%2F-%2Fwidget-1.2.3.tgz":
  version: 1.2.3
  resolution: "@company/widget@npm:1.2.3::__archiveUrl=https%3A%2F%2Fnpm.corp.com%2F%40company%2Fwidget%2F-%2Fwidget-1.2.3.tgz"
  checksum: ${CK('a')}
  languageName: node
  linkType: hard
`
  for (const to of ['npm-1', 'npm-2', 'npm-3'] as const) {
    it(`${to}: emits the archive URL, never the yarn locator, as resolved`, async () => {
      const out = await convert(lock, { to, strict: false })
      const leaked = (out.match(/"resolved":\s*"[^"]*"/g) || []).filter(s => s.includes('::') || s.includes('@npm:'))
      expect(leaked).toEqual([])
      expect(out).toContain('https://npm.corp.com/@company/widget/-/widget-1.2.3.tgz')
    })
  }
})

describe('yarn-berry → npm: a `patch:` node omits `resolved` rather than leaking the patch locator', () => {
  const lock = `__metadata:
  version: 8
  cacheKey: 10c0

"app@workspace:.":
  version: 0.0.0-use.local
  resolution: "app@workspace:."
  dependencies:
    left-pad: "patch:left-pad@npm%3A1.3.0#./p.patch"
  languageName: unknown
  linkType: soft

"left-pad@npm:1.3.0":
  version: 1.3.0
  resolution: "left-pad@npm:1.3.0"
  checksum: ${CK('b')}
  languageName: node
  linkType: hard

"left-pad@patch:left-pad@npm%3A1.3.0#./p.patch::version=1.3.0&hash=abc123":
  version: 1.3.0
  resolution: "left-pad@patch:left-pad@npm%3A1.3.0#./p.patch::version=1.3.0&hash=abc123"
  checksum: ${CK('c')}
  languageName: node
  linkType: hard
`
  it('npm-3: no emitted `resolved` is a leaked `patch:` / `::` locator', async () => {
    const out = await convert(lock, { to: 'npm-3', strict: false })
    const leaked = (out.match(/"resolved":\s*"[^"]*"/g) || []).filter(s => s.includes('::') || s.includes('@patch:'))
    expect(leaked).toEqual([])
  })
})

describe('yarn-berry: a `file:` archive (.tgz) with a `::locator=` qualifier keeps linkType hard', () => {
  it('round-trip preserves `linkType: hard` (the `::` tail must not fall through to soft)', () => {
    const lock = `__metadata:
  version: 8
  cacheKey: 10c0

"vendored@file:./vendor/vendored-1.0.0.tgz::locator=app%40workspace%3A.":
  version: 1.0.0
  resolution: "vendored@file:./vendor/vendored-1.0.0.tgz::locator=app%40workspace%3A."
  checksum: ${CK('a')}
  languageName: node
  linkType: hard
`
    const out = stringify('yarn-berry-v8', parse('yarn-berry-v8', lock))
    expect(out).toContain('linkType: hard')
    expect(out).not.toContain('linkType: soft')
  })
})
