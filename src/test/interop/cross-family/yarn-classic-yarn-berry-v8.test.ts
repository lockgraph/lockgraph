import { CONTRACTS, type ConversionContract } from '../_matrix.ts'
import { runIntraFamily } from '../intra-family/_runner.ts'

const CLASSIC_YB8_CONTRACTS = CONTRACTS.filter(contract =>
  contract.from === 'yarn-classic' && contract.to === 'yarn-berry-v8',
) as ConversionContract[]

runIntraFamily('interop: yarn-classic -> yarn-berry-v8 (cross-family)', CLASSIC_YB8_CONTRACTS)
