import { CONTRACTS, type ConversionContract } from '../_matrix.ts'
import { runIntraFamily } from '../intra-family/_runner.ts'

const BUN_PNPM5_CONTRACTS = CONTRACTS.filter(contract =>
  contract.from === 'bun-text' && contract.to === 'pnpm-v5',
) as ConversionContract[]

runIntraFamily('interop: bun-text -> pnpm-v5 (cross-family)', BUN_PNPM5_CONTRACTS)
