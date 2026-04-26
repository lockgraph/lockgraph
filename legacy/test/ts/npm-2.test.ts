import assert from 'node:assert'
import path from 'node:path'
import {parse, format, check} from '../../main/ts/formats/npm-2'
import { suite } from 'uvu'
import { testInteropBySnapshot } from './helpers'

const test = suite('npm-2')

test('detects npm lockfile v2', () => {
  assert.ok(check(`
{
  "name": "@antongolub/npm-test",
  "version": "5.0.0",
  "lockfileVersion": 2,
  "requires": true,
`))

  assert.ok(!check(`
{
  "name": "@antongolub/npm-test",
  "version": "5.0.0",
  "lockfileVersion": 1,
  "requires": true,
`))
})

test('parse/format interop for regular repo', async () => {
  await testInteropBySnapshot(
    parse,
    format,
    path.resolve(__dirname, '../fixtures/npm-2/package-lock.json'),
    path.resolve(__dirname, '../fixtures/npm-2/package.json'),
  )
})

test.run()
