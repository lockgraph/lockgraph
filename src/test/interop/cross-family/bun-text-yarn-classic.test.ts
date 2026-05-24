import { CONTRACTS, type ConversionContract } from '../_matrix.ts'
import { runIntraFamily } from '../intra-family/_runner.ts'

const BUN_CLASSIC_CONTRACTS = CONTRACTS.filter(contract =>
  contract.from === 'bun-text' && contract.to === 'yarn-classic',
) as ConversionContract[]

runIntraFamily('interop: bun-text -> yarn-classic (cross-family)', BUN_CLASSIC_CONTRACTS)
