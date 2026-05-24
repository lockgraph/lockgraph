import { CONTRACTS, type ConversionContract } from '../_matrix.ts'
import { runIntraFamily } from '../intra-family/_runner.ts'

const CLASSIC_PNPM9_CONTRACTS = CONTRACTS.filter(contract =>
  contract.from === 'yarn-classic' && contract.to === 'pnpm-v9',
) as ConversionContract[]

runIntraFamily('interop: yarn-classic -> pnpm-v9 (cross-family)', CLASSIC_PNPM9_CONTRACTS)
