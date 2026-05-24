import { CONTRACTS, type ConversionContract } from '../_matrix.ts'
import { runIntraFamily } from '../intra-family/_runner.ts'

const CLASSIC_PNPM5_CONTRACTS = CONTRACTS.filter(contract =>
  contract.from === 'yarn-classic' && contract.to === 'pnpm-v5',
) as ConversionContract[]

runIntraFamily('interop: yarn-classic -> pnpm-v5 (cross-family)', CLASSIC_PNPM5_CONTRACTS)
