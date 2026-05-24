import { CONTRACTS, type ConversionContract } from '../_matrix.ts'
import { runIntraFamily } from '../intra-family/_runner.ts'

const YB8_BUN_CONTRACTS = CONTRACTS.filter(contract =>
  contract.from === 'yarn-berry-v8' && contract.to === 'bun-text',
) as ConversionContract[]

runIntraFamily('interop: yarn-berry-v8 -> bun-text (cross-family)', YB8_BUN_CONTRACTS)
