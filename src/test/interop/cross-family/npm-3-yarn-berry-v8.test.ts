import { CONTRACTS, type ConversionContract } from '../_matrix.ts'
import { runIntraFamily } from '../intra-family/_runner.ts'

// ADR-0020 Phase E-ii: cross-family npm-3 -> yarn-berry-v8 reverse contract.
// Tarball extras drop as in npm-3 -> yb4/yb9; the destination handshake is
// synthesized as `__metadata.version: 8`.
const NPM3_YB8_CONTRACTS = CONTRACTS.filter(contract =>
  contract.from === 'npm-3' && contract.to === 'yarn-berry-v8',
) as ConversionContract[]

runIntraFamily('interop: npm-3 -> yarn-berry-v8 (cross-family)', NPM3_YB8_CONTRACTS)
