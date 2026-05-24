import { CONTRACTS, type ConversionContract } from '../_matrix.ts'
import { runIntraFamily } from '../intra-family/_runner.ts'

const YB9_NPM2_CONTRACTS = CONTRACTS.filter(contract =>
  contract.from === 'yarn-berry-v9' && contract.to === 'npm-2',
) as ConversionContract[]

runIntraFamily('interop: yarn-berry-v9 -> npm-2 (cross-family)', YB9_NPM2_CONTRACTS)
