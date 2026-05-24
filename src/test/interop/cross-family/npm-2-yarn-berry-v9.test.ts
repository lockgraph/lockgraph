import { CONTRACTS, type ConversionContract } from '../_matrix.ts'
import { runIntraFamily } from '../intra-family/_runner.ts'

const NPM2_YB9_CONTRACTS = CONTRACTS.filter(contract =>
  contract.from === 'npm-2' && contract.to === 'yarn-berry-v9',
) as ConversionContract[]

runIntraFamily('interop: npm-2 -> yarn-berry-v9 (cross-family)', NPM2_YB9_CONTRACTS)
