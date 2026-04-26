import path from 'node:path'
import fs from 'node:fs/promises'
import { suite } from 'uvu'
import {parse, analyze, format} from '../../main/ts'
import {checkLineByLine} from './helpers'

const test = suite('issue-1')

test('handles pkg aliases for yarn-classic lockfiles', async () => {
  const pkgJson = await fs.readFile(path.resolve(__dirname, '../fixtures/issue-2/package.json'), 'utf8')
  const yarnLock = await fs.readFile(path.resolve(__dirname, '../fixtures/issue-2/yarn.lock'), 'utf8')

  const snapshot = await parse(yarnLock, pkgJson)
  // await fs.writeFile('snap.json', JSON.stringify(snapshot, null, 2))
  const tree = await analyze(snapshot)
  const lf = await format(snapshot, 'yarn-classic')

  await checkLineByLine(
    yarnLock,
    lf
  )
})

test.run()
