import { CONTRACTS, type ConversionContract } from '../_matrix.ts'
import { runIntraFamily } from '../intra-family/_runner.ts'

const YB6_BUN_CONTRACTS = CONTRACTS.filter(contract =>
  contract.from === 'yarn-berry-v6' && contract.to === 'bun-text',
) as ConversionContract[]

runIntraFamily('interop: yarn-berry-v6 -> bun-text (cross-family)', YB6_BUN_CONTRACTS)
