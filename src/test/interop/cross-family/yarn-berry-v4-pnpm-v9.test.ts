import { CONTRACTS, type ConversionContract } from '../_matrix.ts'
import { runIntraFamily } from '../intra-family/_runner.ts'

// ADR-0020 Phase E-i: cross-family yarn-berry-v4 -> pnpm-v9 forward contract.
// Older berry surface matches the yb9 forward loss shape on the shared-disk
// corpus: universal workspace-rekey plus peer-fixture tarball extras drop.
const YB4_PNPM9_CONTRACTS = CONTRACTS.filter(contract =>
  contract.from === 'yarn-berry-v4' && contract.to === 'pnpm-v9',
) as ConversionContract[]

runIntraFamily('interop: yarn-berry-v4 -> pnpm-v9 (cross-family)', YB4_PNPM9_CONTRACTS)
