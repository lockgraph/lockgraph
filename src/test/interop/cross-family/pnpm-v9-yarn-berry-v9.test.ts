import { CONTRACTS, type ConversionContract } from '../_matrix.ts'
import { runIntraFamily } from '../intra-family/_runner.ts'

// ADR-0020 Phase C-ii: cross-family pnpm-v9 -> yarn-berry-v9 reverse direction.
// Asymmetric reentrancy class; `runIntraFamily` skips reenter — the runner
// shape matches cross-family pairs as-is despite the name (rename to a
// neutral form captured as separate QUEUE refactor per Phase C-i codex NIT).
const PNPM9_YB9_CONTRACTS = CONTRACTS.filter(contract =>
  contract.from === 'pnpm-v9' && contract.to === 'yarn-berry-v9',
) as ConversionContract[]

runIntraFamily('interop: pnpm-v9 -> yarn-berry-v9 (cross-family)', PNPM9_YB9_CONTRACTS)
