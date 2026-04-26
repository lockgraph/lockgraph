import assert from 'node:assert'
import path from 'node:path'
// import {cp} from 'fs/promises'
// import {tempy} from './helpers'
import { suite } from 'uvu'
import {
  formatIntegrity,
  parseIntegrity,
  parseReference,
  normalizeReference,
  mapReference,
  switchMonorefs,
} from '../../main/ts/common'

const test = suite('common')

test('`parseIntegrity` extracts checksums from has string', async () => {
  const hash = 'sha512-foo sha256-bar sha1-baz'
  const integrity = parseIntegrity(hash)

  assert.equal(integrity['sha512'], 'foo')
  assert.equal(integrity['sha256'], 'bar')
  assert.equal(integrity['sha1'], 'baz')
  assert.equal(formatIntegrity(integrity), hash)

  assert.equal(parseIntegrity('qux').checksum, 'qux') // checksum is preferred
  assert.equal(formatIntegrity({checksum: 'qux', sha1: 'baz'}), 'qux')
})

test('`parseReference` poorly detects pkg reference type', () => {
  const cases = [
    ['1.0.0', {
      protocol: 'semver',
      id: '1.0.0',
    }],
    ['^1.0.0', {
      protocol: 'semver',
      id: '^1.0.0'
    }],
    ['1.2.3-beta.0', {
      protocol: 'semver',
      id: '1.2.3-beta.0'
    }],
    ['workspace:*', {
      protocol: 'workspace',
      id: '*'
    }],
    ['npm:1.0.0', {
      protocol: 'npm',
      id: '1.0.0'
    }],
    ['git+https://git@github.com/jsdom/abab.git#4327de3aae348710094d9f3c1f0c1477d9feb865', {
      protocol: 'git+https',
      id: '4327de3aae348710094d9f3c1f0c1477d9feb865',
      name: 'jsdom/abab',
      host: 'github.com'
    }],
    ['github:mixmaxhq/throng#8a015a378c2c0db0c760b2147b2468a1c1e86edf', {
      protocol: 'github',
      id: '8a015a378c2c0db0c760b2147b2468a1c1e86edf',
      name: 'mixmaxhq/throng',
      host: ''
    }],
    ['mixmaxhq/throng#8a015a378c2c0db0c760b2147b2468a1c1e86edf', {
      protocol: 'github',
      id: '8a015a378c2c0db0c760b2147b2468a1c1e86edf',
      name: 'mixmaxhq/throng'
    }],
    ['mixmaxhq/throng', {
      protocol: 'github',
      id: '',
      name: 'mixmaxhq/throng'
    }]
  ];

  cases.forEach(([input, output]) => {
    assert.deepStrictEqual(parseReference(input), output)
  })
})

test('`normalizeReference` normalizes inputs', () => {
  const cases: [string, string?][] = [
    ['git+ssh://git@github.com:npm/cli.git#v1.0.27'],
    ['git+ssh://git@github.com:npm/cli#semver:^5.0'],
    ['git+https://isaacs@github.com/npm/cli.git'],
    ['git://github.com/npm/cli.git#v1.0.27'],
    ['git://github.com/npm/cli.git'],
    ['git@github.com:foo/bar.git', 'git:git@github.com:foo/bar.git'],
    ['latest', 'tag:latest'],
    ['npm/cli', 'github:npm/cli'],
    ['github:foo/bar'],
    ['github:mochajs/mocha#4727d357ea'],
    ['github:user/repo#feature\/branch'],
    ['*', 'semver:*'],
    ['', 'semver:'],
    ['^1.2.3', 'semver:^1.2.3'],
    ['file:./my-package'],
    ['link:./my-folder'],
    ['portal:./my-folder'],
    ['workspace:*'],
    ['workspace:^'],
  ];

  cases.forEach(([input, expected = input]) => {
    assert.equal(normalizeReference(input), expected)
  })
})

test('`mapReference` maps v declaration as expected', () => {
  const cases: [string, string, string, string][] = [
    ['workspace:*',   'workspace',  'inherit',  'workspace:*'],
    ['10.0.0',        'workspace',  'pin',      'workspace:10.0.0'],
    ['npm:^10.0.0',   'workspace',  'pin',      'workspace:10.0.0'],
    ['npm:^10.0.0',   'workspace',  'inherit',  'workspace:^10.0.0'],
    ['^10.0.0',       'npm',        'inherit',  'npm:^10.0.0'],
    ['^10.0.0',       'npm',        'pin',      'npm:10.0.0'],
    ['workspace:^10', 'npm',        'pin',      'npm:10.0.0'],
    ['workspace:*',   'npm',        'pin',      'npm:*'],
    ['workspace:*',   'semver',     'pin',      '*'],
    ['workspace:^10', 'semver',     'inherit',  '^10.0.0'],
    ['*',             'semver',     'inherit',  '*'],
    ['*',             'workspace',  'inherit',  'workspace:*'],
  ];

  cases.forEach(([input, protocol, strategy, result]) => {
    assert.equal(mapReference(input, protocol, strategy), result)
  })
})

test('switchMonorefs() replaces `workspace:` protocol with regular semrel links', async () => {
  const fixtures = path.resolve(__dirname, '../fixtures/npm-2-mr')
  const packages = await switchMonorefs({
    cwd: path.resolve(__dirname, '../fixtures/npm-2-mr'),
    dryrun: true,
    protocol: 'workspace'
  })

  assert.deepStrictEqual(
    packages['@abstractest/fixture-basic-test'].manifest.devDependencies,
    {
      "@abstractest/infra": "workspace:*",
      "@abstractest/jest": "workspace:*",
      "@abstractest/native": "workspace:*",
      "@abstractest/types": "workspace:*",
      "abstractest": "workspace:*"
    }
  )
})

test.run()
