import { CONTRACTS, type ConversionContract } from '../_matrix.ts'
import { runIntraFamily } from '../intra-family/_runner.ts'

const PNPM9_BUN_CONTRACTS = CONTRACTS.filter(contract =>
  contract.from === 'pnpm-v9' && contract.to === 'bun-text',
) as ConversionContract[]

runIntraFamily('interop: pnpm-v9 -> bun-text (cross-family)', PNPM9_BUN_CONTRACTS)
