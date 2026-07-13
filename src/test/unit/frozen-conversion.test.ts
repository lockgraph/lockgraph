import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  certifyFrozen,
  prepareFrozen,
  type FrozenCandidate,
  type FrozenVerificationReceipt,
} from '../../main/ts/index.ts'
import type { Manifest } from '../../main/ts/graph.ts'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = (file: string): string =>
  readFileSync(resolve(here, `../resources/fixtures/lockfiles/simple/${file}`), 'utf8')

const repositoryManifests: Record<string, Manifest> = {
  '': {
    name: 'case-simple',
    version: '0.0.0',
    dependencies: { lodash: '4.17.21', ms: '2.1.3' },
    overrides: [],
  },
}

const packageManifests = {
  kind: 'package-manifests' as const,
  authority: 'version-manifest' as const,
  manifests: {
    'lodash@4.17.21': { name: 'lodash', version: '4.17.21' },
    'ms@2.1.3': { name: 'ms', version: '2.1.3' },
  },
}

const sha = (digit: string): string => `sha256:${digit.repeat(64)}`

function receipt(candidate: FrozenCandidate): FrozenVerificationReceipt {
  return {
    protocol: 'lockgraph-frozen-projection/v1',
    target: candidate.target,
    projectionDigest: candidate.projectionDigest,
    verification: 'frozen-verified',
    platform: 'linux-x64-glibc',
    configDigest: sha('a'),
    inputDigest: sha('b'),
    oracle: {
      protocol: 'lockgraph-native-frozen/v1',
      runner: 'unit-oracle',
      version: '1.0.0',
    },
  }
}

async function npmCandidate(): Promise<FrozenCandidate> {
  const prepared = await prepareFrozen(fixture('npm-3.lock'), {
    from: 'npm-3',
    to: 'npm-3',
    targetVersion: '9.9.4',
    manifestCoverage: 'complete',
    manifests: repositoryManifests,
    evidenceInputs: [packageManifests],
  })
  expect(prepared.assessment.contract).toBe('frozen')
  expect(prepared.assessment.status).toBe('unassessed')
  expect(prepared.assessment.requirements).toContainEqual(expect.objectContaining({
    key: 'target:frozen-verification',
    status: 'unassessed',
  }))
  expect(prepared.candidate).toBeDefined()
  return prepared.candidate!
}

describe('frozen conversion certification', () => {
  it('returns the exact opaque candidate bundle only after an exact receipt', async () => {
    const candidate = await npmCandidate()
    const companions = candidate.companions
    const result = certifyFrozen(candidate, receipt(candidate))

    expect(result.assessment.status).toBe('satisfied')
    expect(result.assessment.contract).toBe('frozen')
    expect(result.lockfile).toBe(candidate.lockfile)
    expect(result.companions).toBe(companions)
    expect(result.verification?.projectionDigest).toBe(candidate.projectionDigest)
    expect(Object.isFrozen(candidate)).toBe(true)
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.verification)).toBe(true)
    expect(result.assessment.requirements).toContainEqual(expect.objectContaining({
      key: 'target:frozen-verification',
      status: 'satisfied',
    }))
  })

  it('rejects forged, stale, target-mismatched, and malformed receipts without artifacts', async () => {
    const candidate = await npmCandidate()
    const forged = { ...candidate }
    const forgedResult = certifyFrozen(forged, receipt(candidate))
    expect(forgedResult.assessment.status).toBe('unsatisfied')
    expect(forgedResult.lockfile).toBeUndefined()
    expect(forgedResult.assessment.diagnostics).toContainEqual(expect.objectContaining({
      code: 'COMPLETENESS_FROZEN_CANDIDATE_INVALID',
    }))

    const stale = receipt(candidate)
    const staleResult = certifyFrozen(candidate, { ...stale, projectionDigest: sha('c') })
    expect(staleResult.assessment.status).toBe('unsatisfied')
    expect(staleResult.lockfile).toBeUndefined()
    expect(staleResult.assessment.diagnostics).toContainEqual(expect.objectContaining({
      code: 'COMPLETENESS_FROZEN_SUBJECT_MISMATCH',
    }))

    const targetResult = certifyFrozen(candidate, {
      ...stale,
      target: { format: 'npm-3', managerVersion: '10.9.2' },
    })
    expect(targetResult.assessment.status).toBe('unsatisfied')
    expect(targetResult.lockfile).toBeUndefined()

    const malformed = certifyFrozen(candidate, { ...stale, inputDigest: 'not-a-sha' })
    expect(malformed.assessment.status).toBe('unsatisfied')
    expect(malformed.lockfile).toBeUndefined()
    expect(malformed.assessment.diagnostics).toContainEqual(expect.objectContaining({
      code: 'COMPLETENESS_FROZEN_RECEIPT_INVALID',
    }))

    for (const runtimeMalformed of [
      null,
      { ...stale, platform: 42 },
      { ...stale, oracle: null },
      { ...stale, oracle: { ...stale.oracle, runner: '' } },
    ]) {
      expect(() => certifyFrozen(candidate, runtimeMalformed as never)).not.toThrow()
      const result = certifyFrozen(candidate, runtimeMalformed as never)
      expect(result.assessment.status).toBe('unsatisfied')
      expect(result.lockfile).toBeUndefined()
    }
  })

  it('binds exact emitted bytes and accepts externally attested compatible exact versions', async () => {
    const lf = await prepareFrozen(fixture('npm-3.lock'), {
      from: 'npm-3',
      to: 'npm-3',
      targetVersion: '99.0.0',
      lineEnding: 'lf',
      manifestCoverage: 'complete',
      manifests: repositoryManifests,
      evidenceInputs: [packageManifests],
    })
    const repeatedLf = await prepareFrozen(fixture('npm-3.lock'), {
      from: 'npm-3',
      to: 'npm-3',
      targetVersion: '99.0.0',
      lineEnding: 'lf',
      manifestCoverage: 'complete',
      manifests: repositoryManifests,
      evidenceInputs: [packageManifests],
    })
    const crlf = await prepareFrozen(fixture('npm-3.lock'), {
      from: 'npm-3',
      to: 'npm-3',
      targetVersion: '99.0.0',
      lineEnding: 'crlf',
      manifestCoverage: 'complete',
      manifests: repositoryManifests,
      evidenceInputs: [packageManifests],
    })
    expect(lf.candidate).toBeDefined()
    expect(repeatedLf.candidate).toBeDefined()
    expect(crlf.candidate).toBeDefined()
    expect(repeatedLf.candidate!.lockfile).toBe(lf.candidate!.lockfile)
    expect(repeatedLf.candidate!.companions).toEqual(lf.candidate!.companions)
    expect(repeatedLf.candidate!.projectionDigest).toBe(lf.candidate!.projectionDigest)
    expect(lf.candidate!.projectionDigest).not.toBe(crlf.candidate!.projectionDigest)
    expect(certifyFrozen(lf.candidate!, receipt(lf.candidate!)).assessment.status).toBe('satisfied')
    const crossed = certifyFrozen(crlf.candidate!, receipt(lf.candidate!))
    expect(crossed.assessment.status).toBe('unsatisfied')
    expect(crossed.lockfile).toBeUndefined()
  })

  it('fails closed without an exact native target version', async () => {
    const missing = await prepareFrozen(fixture('npm-3.lock'), {
      from: 'npm-3',
      to: 'npm-3',
      targetVersion: 'latest',
      manifests: repositoryManifests,
    })
    expect(missing.candidate).toBeUndefined()
    expect(missing.assessment.status).toBe('unsatisfied')
    expect(missing.assessment.diagnostics).toContainEqual(expect.objectContaining({
      code: 'COMPLETENESS_FROZEN_TARGET_UNPINNED',
    }))
  })

  it('emits the real best-effort Berry candidate and leaves only checksum/oracle verification pending', async () => {
    const prepared = await prepareFrozen(fixture('npm-3.lock'), {
      from: 'npm-3',
      to: 'yarn-berry-v4',
      targetVersion: '2.4.3',
      cacheKey: '4',
      manifestCoverage: 'complete',
      manifests: repositoryManifests,
      evidenceInputs: [packageManifests],
    })
    expect(prepared.candidate).toBeDefined()
    expect(prepared.assessment.status).toBe('unassessed')
    expect(prepared.assessment.requirements).toContainEqual(expect.objectContaining({
      key: 'target:projection:berry-checksum',
      status: 'unassessed',
    }))
    expect(prepared.candidate!.lockfile).not.toContain('checksum:')

    const certified = certifyFrozen(prepared.candidate!, receipt(prepared.candidate!))
    expect(certified.assessment.status).toBe('satisfied')
    expect(certified.lockfile).toBe(prepared.candidate!.lockfile)
    expect(certified.assessment.requirements).toContainEqual(expect.objectContaining({
      key: 'target:projection:berry-checksum',
      status: 'satisfied',
    }))
  })

  it('does not expose a candidate for a non-Berry projection loss', async () => {
    const prepared = await prepareFrozen(fixture('yarn-berry-v9.lock'), {
      from: 'yarn-berry-v9',
      sourceVersion: '4.0.0',
      to: 'npm-3',
      targetVersion: '9.9.4',
      manifestCoverage: 'complete',
      manifests: repositoryManifests,
      evidenceInputs: [packageManifests],
    })
    expect(prepared.candidate).toBeUndefined()
    expect(prepared.assessment.status).not.toBe('satisfied')
    expect(prepared.assessment.diagnostics).toContainEqual(expect.objectContaining({
      code: expect.stringMatching(/PROJECTION|TARGET_FEATURE/),
    }))
  })
})
