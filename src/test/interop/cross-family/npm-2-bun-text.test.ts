import { CONTRACTS, type ConversionContract } from '../_matrix.ts'
import { runIntraFamily } from '../intra-family/_runner.ts'

const NPM2_BUN_CONTRACTS = CONTRACTS.filter(contract =>
  contract.from === 'npm-2' && contract.to === 'bun-text',
) as ConversionContract[]

runIntraFamily('interop: npm-2 -> bun-text (cross-family)', NPM2_BUN_CONTRACTS)
