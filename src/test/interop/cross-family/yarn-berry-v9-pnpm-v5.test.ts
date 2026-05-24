import { CONTRACTS, type ConversionContract } from '../_matrix.ts'
import { runIntraFamily } from '../intra-family/_runner.ts'

const YB9_PNPM5_CONTRACTS = CONTRACTS.filter(contract =>
  contract.from === 'yarn-berry-v9' && contract.to === 'pnpm-v5',
) as ConversionContract[]

runIntraFamily('interop: yarn-berry-v9 -> pnpm-v5 (cross-family)', YB9_PNPM5_CONTRACTS)
