import { CONTRACTS, type ConversionContract } from '../_matrix.ts'
import { runIntraFamily } from '../intra-family/_runner.ts'

const CLASSIC_NPM1_CONTRACTS = CONTRACTS.filter(contract =>
  contract.from === 'yarn-classic' && contract.to === 'npm-1',
) as ConversionContract[]

runIntraFamily('interop: yarn-classic -> npm-1 (cross-family)', CLASSIC_NPM1_CONTRACTS)
