import assert from 'node:assert'
import path from 'node:path'
import {parse, format, check} from '../../main/ts/formats/npm-3'
import { suite } from 'uvu'
import {testInteropBySnapshot} from './helpers'

const test = suite('npm-3')

test('detects npm lockfile v3', () => {
  assert.ok(check(`
{
  "name": "@antongolub/npm-test",
  "version": "5.0.0",
  "lockfileVersion": 3,
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
    path.resolve(__dirname, '../fixtures/npm-3/package-lock.json'),
    path.resolve(__dirname, '../fixtures/npm-3/package.json'),
  )
})


test('parse/format interop for monorerepo', async () => {
  await testInteropBySnapshot(
    parse,
    format,
    path.resolve(__dirname, '../fixtures/npm-3-mr/package-lock.json'),
    path.resolve(__dirname, '../fixtures/npm-3-mr/package.json'),
  )
})

test('parse/format interop for repo with deps aliases', async () => {
  await testInteropBySnapshot(
    parse,
    format,
    path.resolve(__dirname, '../fixtures/npm-3-aliases/package-lock.json'),
    path.resolve(__dirname, '../fixtures/npm-3-aliases/package.json'),
  )
})

test.run()
