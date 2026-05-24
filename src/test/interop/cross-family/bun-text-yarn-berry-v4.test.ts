import { CONTRACTS, type ConversionContract } from '../_matrix.ts'
import { runIntraFamily } from '../intra-family/_runner.ts'

const BUN_YB4_CONTRACTS = CONTRACTS.filter(contract =>
  contract.from === 'bun-text' && contract.to === 'yarn-berry-v4',
) as ConversionContract[]

runIntraFamily('interop: bun-text -> yarn-berry-v4 (cross-family)', BUN_YB4_CONTRACTS)
