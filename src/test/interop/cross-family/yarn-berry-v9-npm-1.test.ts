import { CONTRACTS, type ConversionContract } from '../_matrix.ts'
import { runIntraFamily } from '../intra-family/_runner.ts'

const YB9_NPM1_CONTRACTS = CONTRACTS.filter(contract =>
  contract.from === 'yarn-berry-v9' && contract.to === 'npm-1',
) as ConversionContract[]

runIntraFamily('interop: yarn-berry-v9 -> npm-1 (cross-family)', YB9_NPM1_CONTRACTS)
