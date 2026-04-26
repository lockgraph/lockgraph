import { suite } from 'uvu'
import assert from 'node:assert'
import { parse, format, analyze, getSources } from '../../main/ts/index'

const test = suite('index')

test('properly exports its inners', async () => {
  const fns = [
    parse,
    analyze,
    format,
    getSources,
  ];

  fns.forEach((fn) => assert.ok(fn instanceof Function))
})

test.run()
