import {IFormatOpts} from './interface'
import {parse} from './parse'
import {format} from './format'

export const convert = async (lf: string | Buffer, pkgJsons: (string | Buffer)[] | string | Buffer, version: string, opts?: IFormatOpts) => {
  const snapshot = parse(lf, ...[pkgJsons].flat())
  return format(snapshot, version, opts)
}
