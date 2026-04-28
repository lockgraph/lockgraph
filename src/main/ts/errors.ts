// Cross-layer error class — see spec/bindings/ts.md#error-model.
// Single discriminated class for parse/stringify and graph gates.

export type LockfileErrorCode =
  | 'PARSE_FAILED'
  | 'FORMAT_DETECT_FAILED'
  | 'FORMAT_MISMATCH'
  | 'CAPABILITY_LACK'
  | 'MISSING_MANIFEST'
  | 'IRREDUCIBLE_LOSS'
  | 'INVALID_INPUT'
  | 'ENRICH_REQUIRED'
  | 'MISSING_REQUIRED_FIELD'
  | 'PIPELINE_DIVERGED'
  | 'REGISTRY_UNREACHABLE'
  | 'INVARIANT_VIOLATION'

export interface LockfileErrorInit {
  code:     LockfileErrorCode
  message?: string
  cause?:   unknown
}

export class LockfileError extends Error {
  readonly code: LockfileErrorCode

  constructor(init: LockfileErrorInit) {
    super(init.message ?? init.code, init.cause !== undefined ? { cause: init.cause } : undefined)
    this.name = 'LockfileError'
    this.code = init.code
  }
}
