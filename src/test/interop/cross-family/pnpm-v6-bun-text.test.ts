import { CONTRACTS, type ConversionContract } from '../_matrix.ts'
import { runIntraFamily } from '../intra-family/_runner.ts'

const PNPM6_BUN_CONTRACTS = CONTRACTS.filter(contract =>
  contract.from === 'pnpm-v6' && contract.to === 'bun-text',
) as ConversionContract[]

runIntraFamily('interop: pnpm-v6 -> bun-text (cross-family)', PNPM6_BUN_CONTRACTS)
