import { CONTRACTS, type ConversionContract } from '../_matrix.ts'
import { runIntraFamily } from '../intra-family/_runner.ts'

const NPM3_BUN_CONTRACTS = CONTRACTS.filter(contract =>
  contract.from === 'npm-3' && contract.to === 'bun-text',
) as ConversionContract[]

runIntraFamily('interop: npm-3 -> bun-text (cross-family)', NPM3_BUN_CONTRACTS)
