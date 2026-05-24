import { CONTRACTS, type ConversionContract } from '../_matrix.ts'
import { runIntraFamily } from '../intra-family/_runner.ts'

const BUN_PNPM9_CONTRACTS = CONTRACTS.filter(contract =>
  contract.from === 'bun-text' && contract.to === 'pnpm-v9',
) as ConversionContract[]

runIntraFamily('interop: bun-text -> pnpm-v9 (cross-family)', BUN_PNPM9_CONTRACTS)
