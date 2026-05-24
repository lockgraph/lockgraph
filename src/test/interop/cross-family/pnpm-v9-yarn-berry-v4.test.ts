import { CONTRACTS, type ConversionContract } from '../_matrix.ts'
import { runIntraFamily } from '../intra-family/_runner.ts'

// ADR-0020 Phase E-i: cross-family pnpm-v9 -> yarn-berry-v4 reverse contract.
// Mirrors the yb9 reverse peer-virt cascade; v4-specific difference is only
// the synthesized preamble handshake (`__metadata.version: 4`).
const PNPM9_YB4_CONTRACTS = CONTRACTS.filter(contract =>
  contract.from === 'pnpm-v9' && contract.to === 'yarn-berry-v4',
) as ConversionContract[]

runIntraFamily('interop: pnpm-v9 -> yarn-berry-v4 (cross-family)', PNPM9_YB4_CONTRACTS)
