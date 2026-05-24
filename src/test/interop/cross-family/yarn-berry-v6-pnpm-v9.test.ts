import { CONTRACTS, type ConversionContract } from '../_matrix.ts'
import { runIntraFamily } from '../intra-family/_runner.ts'

// ADR-0020 Phase E-ii: cross-family yarn-berry-v6 -> pnpm-v9 forward contract.
// Matches the yb4/yb9 forward shape on the widened corpus: universal
// workspace-rekey plus peer-fixture tarball-extra loss.
const YB6_PNPM9_CONTRACTS = CONTRACTS.filter(contract =>
  contract.from === 'yarn-berry-v6' && contract.to === 'pnpm-v9',
) as ConversionContract[]

runIntraFamily('interop: yarn-berry-v6 -> pnpm-v9 (cross-family)', YB6_PNPM9_CONTRACTS)
