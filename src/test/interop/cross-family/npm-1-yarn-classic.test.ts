import { CONTRACTS, type ConversionContract } from '../_matrix.ts'
import { runIntraFamily } from '../intra-family/_runner.ts'

const NPM1_CLASSIC_CONTRACTS = CONTRACTS.filter(contract =>
  contract.from === 'npm-1' && contract.to === 'yarn-classic',
) as ConversionContract[]

runIntraFamily('interop: npm-1 -> yarn-classic (cross-family)', NPM1_CLASSIC_CONTRACTS)
