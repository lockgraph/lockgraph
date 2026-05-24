import { CONTRACTS, type ConversionContract } from '../_matrix.ts'
import { runIntraFamily } from '../intra-family/_runner.ts'

const PNPM6_YB9_CONTRACTS = CONTRACTS.filter(contract =>
  contract.from === 'pnpm-v6' && contract.to === 'yarn-berry-v9',
) as ConversionContract[]

runIntraFamily('interop: pnpm-v6 -> yarn-berry-v9 (cross-family)', PNPM6_YB9_CONTRACTS)
