import fs from 'node:fs/promises'
import path from 'node:path'
import * as process from 'node:process'
import {TDependencies} from "./interface";

export const sortObject = <T extends Record<string, any>>(
  unordered: T,
  predicate: (a: [string, any], b: [string, any]) => number = ([a], [b]) => a > b ? 1 : -1 // This is actually what npm does
): T =>
  Object.entries({...unordered})
    .sort(predicate)
    .reduce((obj, [key, value]: [keyof T, T[keyof T]]) => {
        obj[key] = value
        return obj
    },
    flushObject(unordered) as T,
  )

export const flushObject = (obj: Record<string, any>) => {
    for (const key in obj) {
        delete obj[key]
    }

    return obj
}

export const loadContents = async (value: string): Promise<string> =>
  value.includes('\n')
    ? value
    : fs.readFile(value, 'utf-8')

export const debug = Object.assign((...chunks: any[]) => {
  if (!debug.enable) return

  console.log(...chunks)
}, {
  enable: process.env.DEBUG,
  async json(data: any, name: any = `debug-${Math.random().toString(16).slice(2)}.json`, base?: string) {
    if (!this.enable) return

    if (typeof data === 'string') {
      await this.json(name, data)
      return
    }

    const _data = typeof data === 'function' ? data() : data
    const _base = base || await this.tempy()

    await fs.writeFile(path.resolve(_base, name), JSON.stringify(_data, null, 2))
  },
  async tempy() {
    const temp = path.resolve(process.cwd(), process.env.TEMP || 'temp')
    await fs.mkdir(temp, { recursive: true })

    return temp
  }
})

export const mergeDeps = (...deps: (TDependencies|undefined)[]): TDependencies | undefined => {
  const _deps = deps.filter(Boolean)
  if (!_deps.length) return

  return Object.assign({}, ..._deps)
}


export const unique = (arr: string[]): string[] => [...new Set(arr)]
