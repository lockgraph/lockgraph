import { CONTRACTS, type ConversionContract } from '../_matrix.ts'
import { runIntraFamily } from '../intra-family/_runner.ts'

const PNPM5_CLASSIC_CONTRACTS = CONTRACTS.filter(contract =>
  contract.from === 'pnpm-v5' && contract.to === 'yarn-classic',
) as ConversionContract[]

runIntraFamily('interop: pnpm-v5 -> yarn-classic (cross-family)', PNPM5_CLASSIC_CONTRACTS)
