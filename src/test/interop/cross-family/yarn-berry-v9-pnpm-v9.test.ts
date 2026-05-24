import { CONTRACTS, type ConversionContract } from '../_matrix.ts'
import { runIntraFamily } from '../intra-family/_runner.ts'

// ADR-0020 Phase C-i: cross-family yarn-berry-v9 -> pnpm-v9 contract.
// Reverse direction (pnpm-v9 -> yarn-berry-v9) is OUT-OF-PHASE-C-i-SCOPE per
// _matrix.ts (bare-range entry-key composition bug + sentinel-divergence
// patch-yarn crash in yarn-berry-v9 stringifier). The asymmetric reentrancy
// class means `runIntraFamily` skips reenter — the runner shape matches
// cross-family pairs as-is despite the name.
const YB9_PNPM9_CONTRACTS = CONTRACTS.filter(contract =>
  contract.from === 'yarn-berry-v9' && contract.to === 'pnpm-v9',
) as ConversionContract[]

runIntraFamily('interop: yarn-berry-v9 -> pnpm-v9 (cross-family)', YB9_PNPM9_CONTRACTS)
