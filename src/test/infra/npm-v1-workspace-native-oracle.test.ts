import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import { parse, stringify } from '../../main/ts/formats/npm-1.ts'
import {
  runFrozenOracle,
  runMutableLockfileOracle,
  type FrozenOracleAdapter,
  type FrozenOracleCandidate,
  type FrozenOracleProjectFiles,
} from '../helpers/frozen-oracle.ts'

const adapter: FrozenOracleAdapter = Object.freeze({
  family: 'npm',
  format: 'npm-1',
  version: '11.20.0',
  alias: 'pm-npm-11',
  binName: 'npm',
  nativeLockfileVersion: 1,
  nodeRange: '^20.17.0 || >=22.9.0',
})

const uncalibratedWriterAdapter: FrozenOracleAdapter = Object.freeze({
  family: 'npm',
  format: 'npm-1',
  version: '11.20.0',
  alias: 'pm-npm-11',
  binName: 'npm',
  nodeRange: '^20.17.0 || >=22.9.0',
})

const projectFiles = Object.freeze({
  'package.json': '{"name":"root","version":"1.0.0","private":true,"workspaces":["pkgs/*"]}',
  'pkgs/a/package.json': '{"name":"@w/a","version":"1.0.0","dependencies":{"minimist":"1.2.8"}}',
  'pkgs/b/package.json': '{"name":"@w/b","version":"1.0.0","dependencies":{"chalk":"5.3.0"}}',
})

const nativeWorkspaceLock = `{
  "name": "root",
  "version": "1.0.0",
  "lockfileVersion": 1,
  "requires": true,
  "dependencies": {
    "@w/a": {
      "version": "file:pkgs/a",
      "requires": {
        "minimist": "1.2.8"
      }
    },
    "@w/b": {
      "version": "file:pkgs/b",
      "requires": {
        "chalk": "5.3.0"
      }
    },
    "chalk": {
      "version": "5.3.0",
      "resolved": "https://registry.npmjs.org/chalk/-/chalk-5.3.0.tgz",
      "integrity": "sha512-dLitG79d+GV1Nb/VYcCDFivJeK1hiukt9QjRNVOsUtTy1rR1YJsmpGGTZ3qJos+uw7WmWF4wUwBd9jxjocFC2w=="
    },
    "minimist": {
      "version": "1.2.8",
      "resolved": "https://registry.npmjs.org/minimist/-/minimist-1.2.8.tgz",
      "integrity": "sha512-2yyAR8qBkN3YuheJanUpWC5U3bb5osDywNB8RzDVlDwDHbocAJveqqj1u8+SVD7jkWT4yvsHCpWqqWqAxb0zCA=="
    }
  }
}
`

const preFixWorkspaceLock = `{
  "name": "root",
  "version": "1.0.0",
  "lockfileVersion": 1,
  "requires": true,
  "dependencies": {
    "@w/a": {
      "version": "file:pkgs/a",
      "resolved": "file:pkgs/a",
      "requires": {
        "minimist": "1.2.8"
      }
    },
    "@w/b": {
      "version": "file:pkgs/b",
      "resolved": "file:pkgs/b",
      "requires": {
        "chalk": "5.3.0"
      }
    },
    "chalk": {
      "version": "5.3.0",
      "resolved": "https://registry.npmjs.org/chalk/-/chalk-5.3.0.tgz",
      "integrity": "sha512-dLitG79d+GV1Nb/VYcCDFivJeK1hiukt9QjRNVOsUtTy1rR1YJsmpGGTZ3qJos+uw7WmWF4wUwBd9jxjocFC2w=="
    },
    "minimist": {
      "version": "1.2.8",
      "resolved": "https://registry.npmjs.org/minimist/-/minimist-1.2.8.tgz",
      "integrity": "sha512-2yyAR8qBkN3YuheJanUpWC5U3bb5osDywNB8RzDVlDwDHbocAJveqqj1u8+SVD7jkWT4yvsHCpWqqWqAxb0zCA=="
    }
  }
}
`

const nativeGitLock = `{
  "name": "f",
  "version": "1.0.0",
  "lockfileVersion": 1,
  "requires": true,
  "dependencies": {
    "is-number": {
      "version": "git+ssh://git@github.com/jonschlinkert/is-number.git#98e8ff1da1a89f93d1397a24d7413ed15421c139",
      "from": "is-number@github:jonschlinkert/is-number#7.0.0"
    }
  }
}
`

function candidate(lockfile: string): FrozenOracleCandidate {
  const target = { format: adapter.format, managerVersion: adapter.version } as const
  const projectionDigest = `sha256:${createHash('sha256').update(JSON.stringify({
    target,
    lockfile,
    companions: [],
  })).digest('hex')}`
  return Object.freeze({
    protocol: 'lockgraph-frozen-projection/v1',
    target: Object.freeze(target),
    projectionDigest,
    lockfile,
    companions: Object.freeze([]),
  })
}

function frozen(lockfile: string, files: FrozenOracleProjectFiles = projectFiles) {
  return runFrozenOracle(candidate(lockfile), adapter, files)
}

describe('infra: npm 11 acceptance of npm-v1 workspace locks', () => {
  it('accepts npm\'s own workspace v1 lock', () => {
    const result = frozen(nativeWorkspaceLock)
    expect(result.reason).toBeUndefined()
    expect(result.receipt).toMatchObject({ verification: 'frozen-verified' })
  }, 60_000)

  it('keeps the known pre-fix lock rejected', () => {
    const result = frozen(preFixWorkspaceLock)
    expect(result.receipt).toBeUndefined()
    expect(result.reason).toMatch(/frozen command rejected candidate/i)
  }, 60_000)

  it('emits npm\'s native workspace v1 bytes', () => {
    expect(stringify(parse(nativeWorkspaceLock))).toBe(nativeWorkspaceLock)
  })

  it('keeps a distinct file: resolution when the entry version is not the same carrier', () => {
    const lockfile = `${JSON.stringify({
      name: 'root',
      version: '1.0.0',
      lockfileVersion: 1,
      requires: true,
      dependencies: {
        pkg: { version: '1.0.0', resolved: 'file:vendor/pkg' },
      },
    }, null, 2)}\n`

    expect(JSON.parse(stringify(parse(lockfile))).dependencies.pkg).toEqual({
      version: '1.0.0',
      resolved: 'file:vendor/pkg',
    })
  })

  it('accepts the emitted workspace v1 lock in frozen mode', () => {
    const result = frozen(stringify(parse(nativeWorkspaceLock)))
    expect(result.reason).toBeUndefined()
    expect(result.receipt).toMatchObject({ verification: 'frozen-verified' })
  }, 60_000)

  it('leaves the emitted workspace v1 lock byte-identical in write-enabled mode', () => {
    const emitted = stringify(parse(nativeWorkspaceLock))
    const result = runMutableLockfileOracle(emitted, adapter, projectFiles)
    expect(result.reason).toBeUndefined()
    expect(result.status).toBe(0)
    expect(result.lockfile).toBe(emitted)
  }, 60_000)

  it('leaves npm\'s authored workspace v1 lock byte-identical when the dialect is pinned', () => {
    const result = runMutableLockfileOracle(nativeWorkspaceLock, adapter, projectFiles)
    expect(result.reason).toBeUndefined()
    expect(result.status).toBe(0)
    expect(result.lockfile).toBe(nativeWorkspaceLock)
  }, 60_000)

  it('migrates npm\'s authored workspace v1 lock to v3 without dialect calibration', () => {
    const result = runMutableLockfileOracle(
      nativeWorkspaceLock,
      uncalibratedWriterAdapter,
      projectFiles,
    )
    expect(result.reason).toBeUndefined()
    expect(result.status).toBe(0)
    expect(result.lockfile).not.toBe(nativeWorkspaceLock)
    expect(JSON.parse(result.lockfile!).lockfileVersion).toBe(3)
  }, 60_000)

  it('keeps npm\'s own git v1 lock rejected as a negative control', () => {
    const files = {
      'package.json': '{"name":"f","version":"1.0.0","dependencies":{"is-number":"github:jonschlinkert/is-number#7.0.0"}}',
    }
    const frozenResult = frozen(nativeGitLock, files)
    expect(frozenResult.receipt).toBeUndefined()
    expect(frozenResult.reason).toMatch(/frozen command rejected candidate/i)

    const mutableResult = runMutableLockfileOracle(nativeGitLock, adapter, files)
    expect(mutableResult.reason).toBeUndefined()
    expect(mutableResult.status).toBe(0)
    expect(mutableResult.lockfile).toBe(nativeGitLock)
  }, 60_000)
})
