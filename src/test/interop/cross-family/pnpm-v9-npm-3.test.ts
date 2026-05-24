import { CONTRACTS, type ConversionContract } from '../_matrix.ts'
import { runIntraFamily } from '../intra-family/_runner.ts'

// ADR-0020 Phase C-iv: cross-family pnpm-v9 -> npm-3 forward direction.
// Workspace identity aligns (pnpm-v9 path-keyed shape round-trips through
// npm-3); peer-virt drops on peer-virt-bearing fixtures.
const PNPM9_NPM3_CONTRACTS = CONTRACTS.filter(contract =>
  contract.from === 'pnpm-v9' && contract.to === 'npm-3',
) as ConversionContract[]

runIntraFamily('interop: pnpm-v9 -> npm-3 (cross-family)', PNPM9_NPM3_CONTRACTS)
