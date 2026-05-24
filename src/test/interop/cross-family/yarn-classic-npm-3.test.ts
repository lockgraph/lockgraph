import { CONTRACTS, type ConversionContract } from '../_matrix.ts'
import { runIntraFamily } from '../intra-family/_runner.ts'

const CLASSIC_NPM3_CONTRACTS = CONTRACTS.filter(contract =>
  contract.from === 'yarn-classic' && contract.to === 'npm-3',
) as ConversionContract[]

runIntraFamily('interop: yarn-classic -> npm-3 (cross-family)', CLASSIC_NPM3_CONTRACTS)
