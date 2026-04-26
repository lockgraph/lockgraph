import { suite } from 'uvu'
import path from 'node:path'
import {parse, format, parseResolution, formatResolution} from '../../main/ts/formats/npm-1'
import { testInterop } from './helpers'
import {TResolution} from "../../main/ts/interface";
import assert from "node:assert";

const test = suite('npm-1')

test('parse/format interop for regular repo', async () => {
  await testInterop(
    parse,
    format,
    path.resolve(__dirname, '../fixtures/npm-1/package-lock.json'),
    path.resolve(__dirname, '../fixtures/npm-1/package.json')
  )
})

test('parse/format interop for regular repo with recursive deps', async () => {
  await testInterop(
    parse,
    format,
    path.resolve(__dirname, '../fixtures/npm-1-recursive/package-lock.json'),
    path.resolve(__dirname, '../fixtures/npm-1-recursive/package.json'),
  )
})

test('parseResolution/formatResolution interop', () => {
  const cases: [string, TResolution][] = [
    [
      'https://registry.npmjs.org/@ampproject/remapping/-/remapping-2.2.0.tgz',
      {type: 'npm', id: '2.2.0', name: '@ampproject/remapping', registry: 'https://registry.npmjs.org', hash: ''}
    ],
    [
      'github:mixmaxhq/throng#8a015a378c2c0db0c760b2147b2468a1c1e86edf',
      {type: 'github', id: '8a015a378c2c0db0c760b2147b2468a1c1e86edf', name: 'mixmaxhq/throng'}
    ]
  ];

  cases.forEach(([input, result]) => {
    assert.deepStrictEqual(parseResolution(input), result)
    assert.deepStrictEqual(formatResolution(result), input)
  })
})

test.run()
