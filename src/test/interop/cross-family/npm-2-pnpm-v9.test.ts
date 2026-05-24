import { CONTRACTS, type ConversionContract } from '../_matrix.ts'
import { runIntraFamily } from '../intra-family/_runner.ts'

const NPM2_PNPM9_CONTRACTS = CONTRACTS.filter(contract =>
  contract.from === 'npm-2' && contract.to === 'pnpm-v9',
) as ConversionContract[]

runIntraFamily('interop: npm-2 -> pnpm-v9 (cross-family)', NPM2_PNPM9_CONTRACTS)
