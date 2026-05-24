import { CONTRACTS, type ConversionContract } from '../_matrix.ts'
import { runIntraFamily } from '../intra-family/_runner.ts'

const CLASSIC_NPM2_CONTRACTS = CONTRACTS.filter(contract =>
  contract.from === 'yarn-classic' && contract.to === 'npm-2',
) as ConversionContract[]

runIntraFamily('interop: yarn-classic -> npm-2 (cross-family)', CLASSIC_NPM2_CONTRACTS)
