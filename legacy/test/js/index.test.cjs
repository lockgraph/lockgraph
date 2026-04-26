const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const {suite} = require('uvu')
const { parse, format} = require('@antongolub/lockfile')

const test = suite('index (cjs)')

const lf = fs.readFileSync(path.resolve(__dirname, '../fixtures/npm-1/package-lock.json'), 'utf-8').trim()
const pkgJson = fs.readFileSync(path.resolve(__dirname, '../fixtures/npm-1/package.json'), 'utf-8')

test('parse-format', () => {
  const snapshot = parse(lf, pkgJson)
  const _lf = format(snapshot, 'npm-1')
  assert.equal(lf, _lf)
})

test.run()
