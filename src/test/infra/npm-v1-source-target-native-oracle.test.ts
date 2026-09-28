import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import { parse, stringify } from '../../main/ts/formats/npm-1.ts'
import {
  runFrozenOracle,
  type FrozenOracleAdapter,
  type FrozenOracleCandidate,
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

// Exact authored package-lock.json from
// reedhong/bbctoken@24acb40667644a1924cdf3f9511a2be65a9117bd
// (sha256:11e53517861148865fcebfdcb118c3fdfd3776ad561882dd9aa86975e0b2af1f).
const lockfile = `{
  "requires": true,
  "lockfileVersion": 1,
  "dependencies": {
    "dotenv": {
      "version": "4.0.0",
      "resolved": "http://registry.npm.taobao.org/dotenv/download/dotenv-4.0.0.tgz",
      "integrity": "sha1-hk7xN5rO1Vzm+V3r7NzhefegzR0="
    },
    "zeppelin-solidity": {
      "version": "1.5.0",
      "resolved": "http://registry.npm.taobao.org/zeppelin-solidity/download/zeppelin-solidity-1.5.0.tgz",
      "integrity": "sha1-3bbbmjesE9cwNYp0zwvZT6r1618=",
      "requires": {
        "dotenv": "4.0.0"
      }
    }
  }
}
`

// The source repository contains only the lockfile. This minimal manifest
// supplies its one root dependency so npm can exercise the authored tree.
const projectFiles = Object.freeze({
  'package.json': JSON.stringify({
    name: 'bbctoken',
    version: '1.0.0',
    private: true,
    dependencies: { 'zeppelin-solidity': '1.5.0' },
  }),
})

function candidate(candidateLockfile: string): FrozenOracleCandidate {
  const target = { format: adapter.format, managerVersion: adapter.version } as const
  const projectionDigest = `sha256:${createHash('sha256').update(JSON.stringify({
    target,
    lockfile: candidateLockfile,
    companions: [],
  })).digest('hex')}`
  return Object.freeze({
    protocol: 'lockgraph-frozen-projection/v1',
    target: Object.freeze(target),
    projectionDigest,
    lockfile: candidateLockfile,
    companions: Object.freeze([]),
  })
}

describe('infra: npm 11 acceptance of a real npm-v1 mirror lock', () => {
  it('roundtrips the producer-authored taobao dependency tree and exact URLs', () => {
    const emitted = stringify(parse(lockfile))
    expect(stringify(parse(emitted))).toBe(emitted)
    expect(JSON.parse(emitted).dependencies).toEqual(JSON.parse(lockfile).dependencies)
  })

  it('accepts the emitted taobao lock with npm ci', () => {
    const emitted = stringify(parse(lockfile))
    const result = runFrozenOracle(candidate(emitted), adapter, projectFiles)
    expect(result.reason).toBeUndefined()
    expect(result.receipt).toMatchObject({ verification: 'frozen-verified' })
  }, 60_000)
})
