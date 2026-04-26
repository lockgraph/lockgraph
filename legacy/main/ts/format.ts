import {IFormat, IFormatOpts, TSnapshot} from './interface'

import {version as versionNpm1, format as formatNpm1} from './formats/npm-1'
import {version as versionNpm2, format as formatNpm2} from './formats/npm-2'
import {version as versionNpm3, format as formatNpm3} from './formats/npm-3'
import {version as versionYarnClassic, format as formatYarnClassic} from './formats/yarn-classic'
import {version as versionYarnBerry, format as formatYarnBerry} from './formats/yarn-berry'

const variants: [string, IFormat][] = [
  [versionNpm1, formatNpm1],
  [versionNpm2, formatNpm2],
  [versionNpm3, formatNpm3],
  [versionYarnClassic, formatYarnClassic],
  [versionYarnBerry, formatYarnBerry],
]

export const format = (snapshot: TSnapshot, version: string, opts?: IFormatOpts): string => {
  const [,formatter] = variants.find(([_version]) => version === _version) || []

  if (!formatter) {
    throw new TypeError(`Unsupported lockfile format: ${version}`)
  }

  return formatter(snapshot, opts)
}
