import { suite } from 'uvu'
import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { parse, format } from '@antongolub/lockfile'

const test = suite('index (mjs)')

const __dirname = path.dirname(new URL(import.meta.url).pathname)
const lf = fs.readFileSync(path.resolve(__dirname, '../fixtures/npm-1/package-lock.json'), 'utf-8').trim()
const pkgJson = fs.readFileSync(path.resolve(__dirname, '../fixtures/npm-1/package.json'), 'utf-8')

test('parse-format', () => {
  const snapshot = parse(lf, pkgJson)
  const _lf = format(snapshot, 'npm-1')
  assert.equal(lf, _lf)
})

test.run()
