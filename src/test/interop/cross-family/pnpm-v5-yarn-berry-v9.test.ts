import { CONTRACTS, type ConversionContract } from '../_matrix.ts'
import { runIntraFamily } from '../intra-family/_runner.ts'

const PNPM5_YB9_CONTRACTS = CONTRACTS.filter(contract =>
  contract.from === 'pnpm-v5' && contract.to === 'yarn-berry-v9',
) as ConversionContract[]

runIntraFamily('interop: pnpm-v5 -> yarn-berry-v9 (cross-family)', PNPM5_YB9_CONTRACTS)
