import {ICheck, IFormat, IPreformat, TSnapshot} from '../interface'
import {preformat as preformatNpm1, TNpm1LockfileDeps, TNpm1Lockfile} from './npm-1'
import {preformat as preformatNpm3, TNpm3LockfileDeps, TNpm3Lockfile} from './npm-3'
import {analyze} from '../analyze'

export type TNpm2Lockfile = {
  lockfileVersion: 2
  name: string
  version: string
  requires?: true
  packages: TNpm3LockfileDeps
  dependencies: TNpm1LockfileDeps
}

export const version = 'npm-2'

export {parse} from './npm-3'

export const check: ICheck = (lockfile: string) => lockfile.includes('  "lockfileVersion": 2')

export const preformat: IPreformat<TNpm2Lockfile> = (idx): TNpm2Lockfile => {
  const lfnpm1: TNpm1Lockfile = preformatNpm1(idx)
  const lfnpm3: TNpm3Lockfile = preformatNpm3(idx)

  return {
    name: lfnpm1.name,
    version: lfnpm1.version,
    lockfileVersion: 2,
    requires: true,
    packages: lfnpm3.packages,
    dependencies: lfnpm1.dependencies,
  }
}

export const format: IFormat = (snapshot: TSnapshot): string => JSON.stringify(preformat(analyze(snapshot)), null, 2)
