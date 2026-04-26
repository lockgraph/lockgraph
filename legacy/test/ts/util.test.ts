import assert from 'node:assert'
import fs from 'node:fs/promises'
import path from 'node:path'
import { suite } from 'uvu'
import { loadContents } from '../../main/ts/util'

const test = suite('util')

test('`loadContents` detects path-like arguments and loads the file contents', async () => {
  const ref = path.resolve(__dirname, '../fixtures/yarn-1/yarn.lock')
  const contents = await fs.readFile(ref, 'utf8')

  assert.equal(await loadContents(ref), contents)
})

test('`loadContents` returns content-like input as is', async () => {
  assert.equal(await loadContents(`foo
`), 'foo\n')
})

test.run()
