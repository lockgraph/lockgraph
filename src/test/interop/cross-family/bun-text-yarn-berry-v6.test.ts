import { CONTRACTS, type ConversionContract } from '../_matrix.ts'
import { runIntraFamily } from '../intra-family/_runner.ts'

const BUN_YB6_CONTRACTS = CONTRACTS.filter(contract =>
  contract.from === 'bun-text' && contract.to === 'yarn-berry-v6',
) as ConversionContract[]

runIntraFamily('interop: bun-text -> yarn-berry-v6 (cross-family)', BUN_YB6_CONTRACTS)
