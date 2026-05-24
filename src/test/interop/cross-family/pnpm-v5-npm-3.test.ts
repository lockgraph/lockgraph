import { CONTRACTS, type ConversionContract } from '../_matrix.ts'
import { runIntraFamily } from '../intra-family/_runner.ts'

const PNPM5_NPM3_CONTRACTS = CONTRACTS.filter(contract =>
  contract.from === 'pnpm-v5' && contract.to === 'npm-3',
) as ConversionContract[]

runIntraFamily('interop: pnpm-v5 -> npm-3 (cross-family)', PNPM5_NPM3_CONTRACTS)
