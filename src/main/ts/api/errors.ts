// Cross-layer error class — see spec/bindings/ts.md#error-model.
// Single discriminated class for parse/stringify and graph gates.

import type { Diagnostic } from '../graph.ts'
import type { FormatId } from './format-contract.ts'

export type LockfileErrorCode =
  | 'PARSE_FAILED'
  | 'FORMAT_DETECT_FAILED'
  | 'FORMAT_MISMATCH'
  | 'CAPABILITY_LACK'
  | 'IRREDUCIBLE_LOSS'
  | 'INVALID_INPUT'
  | 'ENRICH_REQUIRED'
  | 'MISSING_REQUIRED_FIELD'
  | 'INVARIANT_VIOLATION'

export type ProjectionLossClass =
  | 'enrichable'
  | 'inherent-meaningful'
  | 'berry-checksum'
  | 'structural-expected'

export type ProjectionRemedy =
  | Readonly<{
      kind: 'supply'
      source: 'registry' | 'artifacts' | 'manifests' | 'config'
      subject?: string
    }>
  | Readonly<{ kind: 'use-project-api'; api: 'convertProject' }>
  | Readonly<{ kind: 'allow-loss'; option: 'strict'; value: false }>
  | Readonly<{ kind: 'verify-target'; requirement: 'pinned-frozen-oracle' }>

export interface ProjectionLoss {
  readonly class: ProjectionLossClass
  readonly feature: string
  readonly target: FormatId
  readonly subject?: Diagnostic['subject']
  readonly remedy: ProjectionRemedy
  readonly diagnostic: Diagnostic
}

export interface LockfileErrorInit {
  code:     LockfileErrorCode
  message?: string
  cause?:   unknown
  losses?:  readonly ProjectionLoss[]
}

export class LockfileError extends Error {
  readonly code: LockfileErrorCode
  /**
   * Classified projection losses. An `IRREDUCIBLE_LOSS` without this property
   * is a structural emitter failure such as an on-disk identity collision.
   */
  readonly losses?: readonly ProjectionLoss[]

  constructor(init: LockfileErrorInit) {
    super(init.message ?? init.code, init.cause !== undefined ? { cause: init.cause } : undefined)
    this.name = 'LockfileError'
    this.code = init.code
    if (init.losses !== undefined) this.losses = Object.freeze([...init.losses])
  }
}
