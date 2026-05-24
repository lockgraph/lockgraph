import { CONTRACTS, type ConversionContract } from '../_matrix.ts'
import { runIntraFamily } from '../intra-family/_runner.ts'

const YB5_BUN_CONTRACTS = CONTRACTS.filter(contract =>
  contract.from === 'yarn-berry-v5' && contract.to === 'bun-text',
) as ConversionContract[]

runIntraFamily('interop: yarn-berry-v5 -> bun-text (cross-family)', YB5_BUN_CONTRACTS)
