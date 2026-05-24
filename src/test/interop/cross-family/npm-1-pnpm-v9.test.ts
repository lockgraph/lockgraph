import { CONTRACTS, type ConversionContract } from '../_matrix.ts'
import { runIntraFamily } from '../intra-family/_runner.ts'

const NPM1_PNPM9_CONTRACTS = CONTRACTS.filter(contract =>
  contract.from === 'npm-1' && contract.to === 'pnpm-v9',
) as ConversionContract[]

runIntraFamily('interop: npm-1 -> pnpm-v9 (cross-family)', NPM1_PNPM9_CONTRACTS)
