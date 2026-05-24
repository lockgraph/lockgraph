import { CONTRACTS, type ConversionContract } from '../_matrix.ts'
import { runIntraFamily } from '../intra-family/_runner.ts'

const BUN_NPM1_CONTRACTS = CONTRACTS.filter(contract =>
  contract.from === 'bun-text' && contract.to === 'npm-1',
) as ConversionContract[]

runIntraFamily('interop: bun-text -> npm-1 (cross-family)', BUN_NPM1_CONTRACTS)
