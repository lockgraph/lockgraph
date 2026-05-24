import { CONTRACTS, type ConversionContract } from '../_matrix.ts'
import { runIntraFamily } from '../intra-family/_runner.ts'

// ADR-0020 Phase E-i: cross-family yarn-berry-v4 -> npm-3 forward contract.
// Same resolved-url degradation class as yb9, widened to include the git
// fixture because yarn-berry-v4.lock exists there on disk.
const YB4_NPM3_CONTRACTS = CONTRACTS.filter(contract =>
  contract.from === 'yarn-berry-v4' && contract.to === 'npm-3',
) as ConversionContract[]

runIntraFamily('interop: yarn-berry-v4 -> npm-3 (cross-family)', YB4_NPM3_CONTRACTS)
