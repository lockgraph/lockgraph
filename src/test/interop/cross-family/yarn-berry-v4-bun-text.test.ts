import { CONTRACTS, type ConversionContract } from '../_matrix.ts'
import { runIntraFamily } from '../intra-family/_runner.ts'

const YB4_BUN_CONTRACTS = CONTRACTS.filter(contract =>
  contract.from === 'yarn-berry-v4' && contract.to === 'bun-text',
) as ConversionContract[]

runIntraFamily('interop: yarn-berry-v4 -> bun-text (cross-family)', YB4_BUN_CONTRACTS)
