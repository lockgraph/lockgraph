import assert from 'node:assert'
import path from 'node:path'
import fs from 'node:fs/promises'
import { suite } from 'uvu'
import { parse, analyze } from '../../main/ts'
import { TEntry, TSnapshotIndex } from '../../main/ts/interface'

const test = suite('snippets')

test('gets all deps by depth', async () => {
  const pkgJson = await fs.readFile(path.resolve(__dirname, '../fixtures/issue-2/package.json'), 'utf8')
  const yarnLock = await fs.readFile(path.resolve(__dirname, '../fixtures/issue-2/yarn.lock'), 'utf8')

  const snapshot = await parse(yarnLock, pkgJson)
  const idx = await analyze(snapshot)
  const getDepsByDepth = (idx: TSnapshotIndex, depth = 0) => Object.values(idx.tree)
    .filter(({depth: d}) => d === depth)
    .map(({entry}) => entry)

  const deps0 = getDepsByDepth(idx)
  const deps1 = getDepsByDepth(idx, 1)
  const deps2 = getDepsByDepth(idx, 2)
  const deps3 = getDepsByDepth(idx, 3)

  assert.equal(deps0.length, 1)
  assert.equal(deps1.length, 31)
  assert.equal(deps2.length, 138)
  assert.equal(deps3.length, 592)
})

test('gets the longest dep chain', async () => {
  const pkgJson = await fs.readFile(path.resolve(__dirname, '../fixtures/issue-2/package.json'), 'utf8')
  const yarnLock = await fs.readFile(path.resolve(__dirname, '../fixtures/issue-2/yarn.lock'), 'utf8')

  const snapshot = await parse(yarnLock, pkgJson)
  const idx = await analyze(snapshot)
  const getLongestChain = (): TEntry[] => {
    let max = 0
    let chain: TEntry[] = []

    for (const e of Object.values(idx.tree)) {
      if (e.depth > max) {
        max = e.depth
        chain = [...e.parents, e.entry]
      }
    }
    return chain
  }
  const expected =  [
    'tools-backup@0.0.0',
    'ngx-build-plus@16.0.0',
    '@angular-devkit/build-angular@16.2.8',
    'babel-plugin-istanbul@6.1.1',
    'istanbul-lib-instrument@5.2.1',
    '@babel/core@7.23.2',
    '@babel/helpers@7.23.2',
    '@babel/traverse@7.23.2',
    '@babel/helper-function-name@7.23.0',
    '@babel/template@7.22.15',
    '@babel/code-frame@7.22.13',
    '@babel/highlight@7.22.20',
    'chalk@2.4.2',
    'ansi-styles@3.2.1',
    'color-convert@1.9.3',
    'color-name@1.1.3'
  ]

  assert.deepEqual(getLongestChain().map((e) => idx.getEntryId(e)), expected)
})

test.run()
