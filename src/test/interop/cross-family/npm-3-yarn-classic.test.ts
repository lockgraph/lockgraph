import { CONTRACTS, type ConversionContract } from '../_matrix.ts'
import { runIntraFamily } from '../intra-family/_runner.ts'

const NPM3_CLASSIC_CONTRACTS = CONTRACTS.filter(contract =>
  contract.from === 'npm-3' && contract.to === 'yarn-classic',
) as ConversionContract[]

runIntraFamily('interop: npm-3 -> yarn-classic (cross-family)', NPM3_CLASSIC_CONTRACTS)
