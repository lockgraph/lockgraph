import { CONTRACTS, type ConversionContract } from '../_matrix.ts'
import { runIntraFamily } from '../intra-family/_runner.ts'

const BUN_NPM3_CONTRACTS = CONTRACTS.filter(contract =>
  contract.from === 'bun-text' && contract.to === 'npm-3',
) as ConversionContract[]

runIntraFamily('interop: bun-text -> npm-3 (cross-family)', BUN_NPM3_CONTRACTS)
