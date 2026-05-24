import { CONTRACTS, type ConversionContract } from '../_matrix.ts'
import { runIntraFamily } from '../intra-family/_runner.ts'

const PNPM9_CLASSIC_CONTRACTS = CONTRACTS.filter(contract =>
  contract.from === 'pnpm-v9' && contract.to === 'yarn-classic',
) as ConversionContract[]

runIntraFamily('interop: pnpm-v9 -> yarn-classic (cross-family)', PNPM9_CLASSIC_CONTRACTS)
