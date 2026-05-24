import { CONTRACTS, type ConversionContract } from '../_matrix.ts'
import { runIntraFamily } from '../intra-family/_runner.ts'

const CLASSIC_PNPM6_CONTRACTS = CONTRACTS.filter(contract =>
  contract.from === 'yarn-classic' && contract.to === 'pnpm-v6',
) as ConversionContract[]

runIntraFamily('interop: yarn-classic -> pnpm-v6 (cross-family)', CLASSIC_PNPM6_CONTRACTS)
