import { sentinelHashOfLocator } from './patch.ts'

const FSEVENTS_BUILTIN_COMPAT_SOURCE = 'optional!builtin<compat/fsevents>'
const BUILTIN_COMPAT_SOURCE =
  /^(?:optional!)?~?builtin<compat\/[A-Za-z0-9@/._-]+>$/

export interface YarnBerryBuiltinCompatIdentity {
  readonly locator: string
  readonly patch: string
}

/**
 * Decode the identity-bearing locator portion of a Yarn builtin compatibility
 * resolution. The on-lock `hash=` parameter is PM metadata; canonical Node
 * identity remains the unresolved-locator sentinel used by the Berry parser.
 */
export function yarnBerryBuiltinCompatIdentityOfResolution(
  resolution: string,
): YarnBerryBuiltinCompatIdentity | undefined {
  const patchAt = resolution.indexOf('@patch:')
  const locator = resolution.startsWith('patch:')
    ? resolution
    : patchAt < 0
      ? undefined
      : resolution.slice(patchAt + 1)
  if (locator === undefined) return undefined

  const hashAt = locator.indexOf('#')
  if (hashAt < 0) return undefined
  const paramsAt = locator.indexOf('::', hashAt + 1)
  const source = paramsAt < 0
    ? locator.slice(hashAt + 1)
    : locator.slice(hashAt + 1, paramsAt)
  if (!BUILTIN_COMPAT_SOURCE.test(source)) return undefined

  return Object.freeze({
    locator,
    patch: sentinelHashOfLocator(locator),
  })
}

/** Exact Yarn fsevents compatibility resolution assembled from an row. */
export function yarnBerryFseventsCompatResolution(
  version = '2.3.3',
  locatorHash = 'df0bf1',
  builtinSource = FSEVENTS_BUILTIN_COMPAT_SOURCE,
): string {
  return `fsevents@patch:fsevents@npm%3A${version}#${builtinSource}::version=${version}&hash=${locatorHash}`
}
