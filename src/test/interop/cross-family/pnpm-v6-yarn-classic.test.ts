import { CONTRACTS, type ConversionContract } from '../_matrix.ts'
import { runIntraFamily } from '../intra-family/_runner.ts'

const PNPM6_CLASSIC_CONTRACTS = CONTRACTS.filter(contract =>
  contract.from === 'pnpm-v6' && contract.to === 'yarn-classic',
) as ConversionContract[]

runIntraFamily('interop: pnpm-v6 -> yarn-classic (cross-family)', PNPM6_CLASSIC_CONTRACTS)
