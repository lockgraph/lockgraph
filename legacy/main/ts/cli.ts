#!/usr/bin/env node

import fs from 'node:fs/promises'
import * as process from 'node:process'
import path from 'node:path'
import { glob, minimist } from './vendor'
import { parse, format, convert } from './index'
import { TSnapshot } from './interface'

export const parseArgv = (argv: string[] = process.argv.slice(2)) => {
  const _argv = minimist(argv, {
    string: ['input', 'output', 'nmtree', 'format']
  })

  const cmd = _argv._[0]
  const cwd = _argv.cwd || process.cwd()
  const input = [
    _argv._.slice(1),
    _argv.input?.split(','),
  ].flat(1).filter(Boolean)

  return {
    ..._argv,
    cwd,
    cmd,
    input,
  }
}

export const outputResult = async (result: string, cwd?: string, output?: string) => {
  if (output && cwd) {
    await fs.writeFile(path.resolve(cwd, output), result)
    return
  }
  console.log(result)
}

export const invoke = async (cmd: string, opts: Record<string, any>)=> {
  if (!opts.input) {
    throw new TypeError('input is required')
  }

  if (cmd === 'parse') {
    const inputs = await glob(opts.input, {cwd: opts.cwd, absolute: true, onlyFiles: true})
    const files = await Promise.all(inputs.map(v => fs.readFile(v, 'utf8')))
    const snapshot = parse(...files)
    const result = JSON.stringify(snapshot, null, 2)

    return outputResult(result, opts.cwd, opts.output)
  }

  if (cmd === 'format') {
    const snapshot = JSON.parse(await fs.readFile(path.resolve(opts.cwd, opts.input[0]), 'utf8')) as TSnapshot
    const result = format(snapshot, opts.format)

    return outputResult(result, opts.cwd, opts.output)
  }

  if (cmd === 'convert') {
    const inputs = await glob(opts.input, {cwd: opts.cwd, absolute: true, onlyFiles: true})
    const [lf, ...jsons] = await Promise.all(inputs.map(v => fs.readFile(v, 'utf8')))
    const result = await convert(lf, jsons, opts.format)

    return outputResult(result, opts.cwd, opts.output)
  }

  throw new TypeError(`unsupported command: ${cmd}`)
}

export const main = async () => {
  try {
    const argv = parseArgv()
    await invoke(argv.cmd, argv)
    process.exit(0)
  } catch (e) {
    console.error(e)
    process.exit(1)
  }
}

main()
