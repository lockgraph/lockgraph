import { CONTRACTS, type ConversionContract } from '../_matrix.ts'
import { runIntraFamily } from '../intra-family/_runner.ts'

const YB9_PNPM6_CONTRACTS = CONTRACTS.filter(contract =>
  contract.from === 'yarn-berry-v9' && contract.to === 'pnpm-v6',
) as ConversionContract[]

runIntraFamily('interop: yarn-berry-v9 -> pnpm-v6 (cross-family)', YB9_PNPM6_CONTRACTS)
