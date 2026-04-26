import {parse as parseNpm1, check as checkNpm1} from './formats/npm-1'
import {parse as parseNpm2, check as checkNpm2} from './formats/npm-2'
import {parse as parseNpm3, check as checkNpm3} from './formats/npm-3'
import {parse as parseYarnClassic, check as checkYarnClassic} from './formats/yarn-classic'
import {parse as parseYarnBerry, check as checkYarnBerry} from './formats/yarn-berry'
import {ICheck, IParse, TSnapshot} from './interface'

const isPkgJson = (input: string) => input.startsWith('{') && input.includes('"name":')
const variants: [ICheck, IParse][] = [
  [checkNpm1, parseNpm1],
  [checkNpm2, parseNpm2],
  [checkNpm3, parseNpm3],
  [checkYarnClassic, parseYarnClassic],
  [checkYarnBerry, parseYarnBerry],
]
export const parse = (...inputs: (string|Buffer)[]): TSnapshot => {
  const [lockfile, ...pkgJsons] = inputs.map((input) => input.toString('utf8'))
  if (!lockfile) {
    throw new TypeError('Lockfile is required')
  }

  const [,parser] = variants.find(([check]) => check(lockfile)) || []
  if (!parser) {
    throw new TypeError('Unsupported lockfile format')
  }

  if (!pkgJsons.every(isPkgJson)) {
    throw new TypeError('Invalid package json')
  }

  return parser(lockfile, ...pkgJsons)
}
