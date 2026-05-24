import { CONTRACTS, type ConversionContract } from '../_matrix.ts'
import { runIntraFamily } from '../intra-family/_runner.ts'

// ADR-0020 Phase E-i: cross-family npm-3 -> yarn-berry-v4 reverse contract.
// Tarball extras drop as in npm-3 -> yb9, but the v4 corpus includes the git
// fixture, so the declared loss also covers git-side `license` payloads.
const NPM3_YB4_CONTRACTS = CONTRACTS.filter(contract =>
  contract.from === 'npm-3' && contract.to === 'yarn-berry-v4',
) as ConversionContract[]

runIntraFamily('interop: npm-3 -> yarn-berry-v4 (cross-family)', NPM3_YB4_CONTRACTS)
