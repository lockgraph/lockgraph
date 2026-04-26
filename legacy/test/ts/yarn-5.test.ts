import { suite } from 'uvu'
import path from 'node:path'
import assert from 'node:assert'
import {parse, format, parseResolution, formatResolution} from '../../main/ts/formats/yarn-berry'
import { testInterop } from './helpers'
import {TResolution} from "../../main/ts/interface";

const test = suite('yarn-5')
test('parse/format interop for monorepo', async () => {
  await testInterop(
    parse,
    format,
    path.resolve(__dirname, '../fixtures/yarn-5-mr/yarn.lock'),
    path.resolve(__dirname, '../fixtures/yarn-5-mr/package.json'),
  )
})

test('parseResolution/formatResolution', () => {
  const cases: [string, TResolution][] = [
    [
      '@ampproject/remapping@npm:2.2.0',
      {type: 'npm', id: '2.2.0', name: '@ampproject/remapping'}
    ],
    [
      'throng@https://github.com/mixmaxhq/throng.git#commit=8a015a378c2c0db0c760b2147b2468a1c1e86edf',
      {type: 'github', id: '8a015a378c2c0db0c760b2147b2468a1c1e86edf', name: 'mixmaxhq/throng', alias: 'throng'}
    ]
  ];

  cases.forEach(([input, result]) => {
    assert.deepStrictEqual(parseResolution(input), result)
    assert.deepStrictEqual(formatResolution(result), input)
  })
})

test.run()
