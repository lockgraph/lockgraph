import { CONTRACTS, type ConversionContract } from '../_matrix.ts'
import { runIntraFamily } from '../intra-family/_runner.ts'

const CLASSIC_BUN_CONTRACTS = CONTRACTS.filter(contract =>
  contract.from === 'yarn-classic' && contract.to === 'bun-text',
) as ConversionContract[]

runIntraFamily('interop: yarn-classic -> bun-text (cross-family)', CLASSIC_BUN_CONTRACTS)
