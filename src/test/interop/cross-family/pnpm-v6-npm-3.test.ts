import { CONTRACTS, type ConversionContract } from '../_matrix.ts'
import { runIntraFamily } from '../intra-family/_runner.ts'

const PNPM6_NPM3_CONTRACTS = CONTRACTS.filter(contract =>
  contract.from === 'pnpm-v6' && contract.to === 'npm-3',
) as ConversionContract[]

runIntraFamily('interop: pnpm-v6 -> npm-3 (cross-family)', PNPM6_NPM3_CONTRACTS)
