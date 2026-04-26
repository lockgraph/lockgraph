import { suite } from 'uvu'
import path from 'node:path'
import fs from 'node:fs'
import assert from 'node:assert'
import {parse} from '../../main/ts/parse'
import {format} from '../../main/ts/format'

const test = suite('format')
const lf = fs.readFileSync(path.resolve(__dirname, '../fixtures/npm-1/package-lock.json'), 'utf-8').trim()
const pkgJson = fs.readFileSync(path.resolve(__dirname, '../fixtures/npm-1/package.json'), 'utf-8')
const snapshot = parse(lf, pkgJson)

test('throws err on unsupported version', () => {
  assert.throws(() => format(snapshot, 'foo'), new TypeError('Unsupported lockfile format: foo'))
})

test('returns a lockfile if possible', () => {
  const _lf = format(snapshot, 'npm-1')
  assert.equal(lf, _lf)
})

test.run()
