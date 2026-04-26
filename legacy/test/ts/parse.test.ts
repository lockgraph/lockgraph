import { suite } from 'uvu'
import path from 'node:path'
import fs from 'node:fs'
import assert from 'node:assert'
import {parse} from '../../main/ts/parse'

const test = suite('parse')
const lf: Buffer = fs.readFileSync(path.resolve(__dirname, '../fixtures/npm-1/package-lock.json'))
const pkgJson: string = fs.readFileSync(path.resolve(__dirname, '../fixtures/npm-1/package.json'), 'utf-8')

test('throws err on unsupported lockfile', () => {
  assert.throws(() => parse('broken'), new TypeError('Unsupported lockfile format'))
})

test('throws err on empty lockfile', () => {
  assert.throws(() => parse(), new TypeError('Lockfile is required'))
})

test('throws err on `suspicious` pkg json input', () => {
  assert.throws(() => parse(lf, '{"foo": "bar"}'), new TypeError('Invalid package json'))
})

test('returns a snapshot if possible', () => {
  const snapshot = parse(lf, pkgJson)
  assert.equal(snapshot[""]?.manifest?.name, JSON.parse(pkgJson).name)
})

test.run()
