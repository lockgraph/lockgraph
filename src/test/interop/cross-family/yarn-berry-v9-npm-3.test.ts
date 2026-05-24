import { CONTRACTS, type ConversionContract } from '../_matrix.ts'
import { runIntraFamily } from '../intra-family/_runner.ts'

// ADR-0020 Phase C-iii: cross-family yarn-berry-v9 -> npm-3 forward contract.
// Empirically lossless-reentrant across the 6-fixture corpus; only
// `resolved-url` degrades on the destination side.
const YB9_NPM3_CONTRACTS = CONTRACTS.filter(contract =>
  contract.from === 'yarn-berry-v9' && contract.to === 'npm-3',
) as ConversionContract[]

runIntraFamily('interop: yarn-berry-v9 -> npm-3 (cross-family)', YB9_NPM3_CONTRACTS)
