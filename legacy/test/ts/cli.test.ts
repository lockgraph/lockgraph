import path from 'node:path'
import assert from 'node:assert'
import fs from 'node:fs/promises'
import process from 'node:process'
import { suite } from 'uvu'
import { tempy } from './helpers'

const test = suite('cli')

const _argv = process.argv
const exit = process.exit
const pkgJson = path.resolve(__dirname, '../fixtures/issue-2/package.json')
const yarnLock = path.resolve(__dirname, '../fixtures/issue-2/yarn.lock')

test('invokes `parse` and `parse`', async () => {
  const temp = await tempy()

  await fs.copyFile(pkgJson, path.resolve(temp, 'package.json'))
  await fs.copyFile(yarnLock, path.resolve(temp, 'yarn.lock'))

  // @ts-ignore
  process.exit = () => {}
  // parse
  {
    process.argv = [..._argv.slice(0, 2),
      'parse',
      '--input', 'yarn.lock,package.json',
      '--output', 'snapshot.json',
      '--cwd', temp
    ]
    await (await import('../../main/ts/cli')).main()
    const snapshot = JSON.parse(await fs.readFile(path.resolve(temp, 'snapshot.json'), 'utf8'))
    assert.equal(snapshot[""].name, 'tools-backup')
  }

  // format
  {
    process.argv = [..._argv.slice(0, 2),
      'format',
      '--input', 'snapshot.json',
      '--output', 'yarn.lock2',
      '--cwd', temp,
      '--format', 'yarn-classic'
    ]
    await (await import('../../main/ts/cli')).main()
    assert.equal(
      await fs.readFile(path.resolve(temp, 'yarn.lock2'), 'utf8'),
      await fs.readFile(yarnLock, 'utf8')
    )
  }

  // convert
  {
    process.argv = [..._argv.slice(0, 2),
      'convert',
      '--input', 'yarn.lock,package.json',
      '--output', 'yarn.lock3',
      '--format', 'yarn-classic',
      '--cwd', temp
    ]
    await (await import('../../main/ts/cli')).main()
    assert.equal(
      await fs.readFile(path.resolve(temp, 'yarn.lock3'), 'utf8'),
      await fs.readFile(yarnLock, 'utf8')
    )
  }

  process.argv = _argv
  process.exit = exit
})

test.run()
