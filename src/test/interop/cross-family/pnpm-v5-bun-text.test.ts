import { CONTRACTS, type ConversionContract } from '../_matrix.ts'
import { runIntraFamily } from '../intra-family/_runner.ts'

const PNPM5_BUN_CONTRACTS = CONTRACTS.filter(contract =>
  contract.from === 'pnpm-v5' && contract.to === 'bun-text',
) as ConversionContract[]

runIntraFamily('interop: pnpm-v5 -> bun-text (cross-family)', PNPM5_BUN_CONTRACTS)
