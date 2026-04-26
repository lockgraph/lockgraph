import path from 'node:path'
import fs from 'node:fs/promises'
import { suite } from 'uvu'
import { convert } from '../../main/ts'
import {checkLineByLine} from './helpers'

const test = suite('convert')

test('composes parse and format', async () => {
  const pkgJson = await fs.readFile(path.resolve(__dirname, '../fixtures/issue-2/package.json'), 'utf8')
  const yarnLock = await fs.readFile(path.resolve(__dirname, '../fixtures/issue-2/yarn.lock'), 'utf8')

  const yarnLock2 = await convert(yarnLock, pkgJson, 'yarn-classic')

  await checkLineByLine(
    yarnLock,
    yarnLock2
  )
})

test.run()
