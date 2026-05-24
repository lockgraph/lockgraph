import { CONTRACTS, type ConversionContract } from '../_matrix.ts'
import { runIntraFamily } from '../intra-family/_runner.ts'

const PNPM9_NPM1_CONTRACTS = CONTRACTS.filter(contract =>
  contract.from === 'pnpm-v9' && contract.to === 'npm-1',
) as ConversionContract[]

runIntraFamily('interop: pnpm-v9 -> npm-1 (cross-family)', PNPM9_NPM1_CONTRACTS)
