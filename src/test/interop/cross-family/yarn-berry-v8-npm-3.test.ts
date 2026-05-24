import { CONTRACTS, type ConversionContract } from '../_matrix.ts'
import { runIntraFamily } from '../intra-family/_runner.ts'

// ADR-0020 Phase E-ii: cross-family yarn-berry-v8 -> npm-3 forward contract.
// Mirrors the yb4 forward npm shape: universal resolved-url degradation,
// including the shared git fixture.
const YB8_NPM3_CONTRACTS = CONTRACTS.filter(contract =>
  contract.from === 'yarn-berry-v8' && contract.to === 'npm-3',
) as ConversionContract[]

runIntraFamily('interop: yarn-berry-v8 -> npm-3 (cross-family)', YB8_NPM3_CONTRACTS)
