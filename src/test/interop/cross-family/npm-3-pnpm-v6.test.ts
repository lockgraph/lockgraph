import { CONTRACTS, type ConversionContract } from '../_matrix.ts'
import { runIntraFamily } from '../intra-family/_runner.ts'

const NPM3_PNPM6_CONTRACTS = CONTRACTS.filter(contract =>
  contract.from === 'npm-3' && contract.to === 'pnpm-v6',
) as ConversionContract[]

runIntraFamily('interop: npm-3 -> pnpm-v6 (cross-family)', NPM3_PNPM6_CONTRACTS)
