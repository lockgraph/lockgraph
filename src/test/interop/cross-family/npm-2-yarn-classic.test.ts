import { CONTRACTS, type ConversionContract } from '../_matrix.ts'
import { runIntraFamily } from '../intra-family/_runner.ts'

const NPM2_CLASSIC_CONTRACTS = CONTRACTS.filter(contract =>
  contract.from === 'npm-2' && contract.to === 'yarn-classic',
) as ConversionContract[]

runIntraFamily('interop: npm-2 -> yarn-classic (cross-family)', NPM2_CLASSIC_CONTRACTS)
