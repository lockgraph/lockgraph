import { suite } from 'uvu'
import path from 'node:path'
import fs from 'node:fs/promises'
import {parse, format, preparse, formatResolution, parseResolution} from '../../main/ts/formats/yarn-classic'
import { testInterop } from './helpers'
import assert from "node:assert";
import {TResolution} from "../../main/ts/interface";

const test = suite('yarn-1')
// const fixtures = path.resolve(__dirname, '../fixtures/yarn-1')


// test.only('parse() returns valid dep snapshot', async () => {
//   const input = `
// "@parcel/fs-write-stream-atomic@^2.0.1":
//   version "2.0.1"
//   resolved "https://registry.yarnpkg.com/@parcel/fs-write-stream-atomic/-/fs-write-stream-atomic-2.0.1.tgz#700f9f2b3761494af305e71a185117e804b1ae41"
//   integrity sha512-+CSeXRCnI9f9K4jeBOYzZiOf+qw6t3TvhEstR/zeXenzx0nBMzPv28mjUMZ33vRMy8bQOHAim8qy/AMSIMolEg==
//   dependencies:
//     graceful-fs "^4.1.2"
//     iferr "^1.0.2"
//     imurmurhash "^0.1.4"
//     readable-stream "1 || 2"
// `
//   const snap = await parse(input)
//   console.log('snap', snap)
// })

// test.only('parse() returns valid dep snapshot', async () => {
//   const lf = await fs.readFile(path.resolve(__dirname, '../fixtures/yarn-1/yarn.lock'), 'utf8')
//   const snap = await parse(lf)
//   // console.log('snap', snap)
// })

test('parse/format interop for regular repo', async () => {
  await testInterop(
    parse,
    format,
    path.resolve(__dirname, '../fixtures/yarn-1/yarn.lock'),
    path.resolve(__dirname, '../fixtures/yarn-1/package.json'),
  )
})

test('parse/format interop for monorepo', async () => {
  await testInterop(
    parse,
    format,
    path.resolve(__dirname, '../fixtures/yarn-1-mr/yarn.lock'),
    path.resolve(__dirname, '../fixtures/yarn-1-mr/package.json'),
  )
})

test('parseResolution/formatResolution interop', () => {
  const cases: [string, TResolution][] = [
    [
      'https://codeload.github.com/mixmaxhq/throng/tar.gz/8a015a378c2c0db0c760b2147b2468a1c1e86edf',
      {type: 'github', id: '8a015a378c2c0db0c760b2147b2468a1c1e86edf', name: 'mixmaxhq/throng'}
    ],
    [
      'https://registry.yarnpkg.com/@babel/code-frame/-/code-frame-7.5.5.tgz#bc0782f6d69f7b7d49531219699b988f669a8f9d',
      {type: 'npm', id: '7.5.5', name: '@babel/code-frame', registry: 'https://registry.yarnpkg.com', hash: '#bc0782f6d69f7b7d49531219699b988f669a8f9d'}
    ]
  ];

  cases.forEach(([input, result]) => {
    assert.deepStrictEqual(parseResolution(input), result)
    assert.deepStrictEqual(formatResolution(result), input)
  })
})

test.run()
