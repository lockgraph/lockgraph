import { CONTRACTS, type ConversionContract } from '../_matrix.ts'
import { runIntraFamily } from '../intra-family/_runner.ts'

const BUN_PNPM6_CONTRACTS = CONTRACTS.filter(contract =>
  contract.from === 'bun-text' && contract.to === 'pnpm-v6',
) as ConversionContract[]

runIntraFamily('interop: bun-text -> pnpm-v6 (cross-family)', BUN_PNPM6_CONTRACTS)
