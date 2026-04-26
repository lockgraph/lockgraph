import path from 'node:path'
import fs from 'node:fs/promises'
import fg from 'fast-glob'
import { suite } from 'uvu'
import { parse, analyze, format } from '../../main/ts'
import { checkLineByLine } from './helpers'

const test = suite('issue-3')

test('processes yarn entry patches for berry', async () => {
  const base = path.resolve(__dirname, '../fixtures/issue-3')
  const files = await fg([`${base}/packages/*/package.json`, `${base}/package.json`])
  const yarnLock = await fs.readFile(path.join(base, 'yarn.lock'), 'utf8')
  const pkgJsons = await Promise.all(files.map(async f => fs.readFile(f, 'utf-8')))
  const snapshot = await parse(yarnLock, ...pkgJsons)
  // await fs.writeFile('snap.json', JSON.stringify(snapshot, null, 2))
  const tree = await analyze(snapshot)
  const lf = await format(snapshot, 'yarn-berry', {
    __metadata: {
      version: 7,
      cacheKey: 9,
    }
  })

  await checkLineByLine(
    yarnLock,
    lf
  )
})

test.run()
