import { CONTRACTS, type ConversionContract } from '../_matrix.ts'
import { runIntraFamily } from '../intra-family/_runner.ts'

const NPM1_YB9_CONTRACTS = CONTRACTS.filter(contract =>
  contract.from === 'npm-1' && contract.to === 'yarn-berry-v9',
) as ConversionContract[]

runIntraFamily('interop: npm-1 -> yarn-berry-v9 (cross-family)', NPM1_YB9_CONTRACTS)
