import { CONTRACTS, type ConversionContract } from '../_matrix.ts'
import { runIntraFamily } from '../intra-family/_runner.ts'

const NPM1_BUN_CONTRACTS = CONTRACTS.filter(contract =>
  contract.from === 'npm-1' && contract.to === 'bun-text',
) as ConversionContract[]

runIntraFamily('interop: npm-1 -> bun-text (cross-family)', NPM1_BUN_CONTRACTS)
