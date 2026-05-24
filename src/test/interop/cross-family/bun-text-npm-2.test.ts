import { CONTRACTS, type ConversionContract } from '../_matrix.ts'
import { runIntraFamily } from '../intra-family/_runner.ts'

const BUN_NPM2_CONTRACTS = CONTRACTS.filter(contract =>
  contract.from === 'bun-text' && contract.to === 'npm-2',
) as ConversionContract[]

runIntraFamily('interop: bun-text -> npm-2 (cross-family)', BUN_NPM2_CONTRACTS)
