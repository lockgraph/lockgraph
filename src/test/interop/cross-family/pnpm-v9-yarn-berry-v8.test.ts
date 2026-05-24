import { CONTRACTS, type ConversionContract } from '../_matrix.ts'
import { runIntraFamily } from '../intra-family/_runner.ts'

// ADR-0020 Phase E-ii: cross-family pnpm-v9 -> yarn-berry-v8 reverse contract.
// Mirrors the yb4/yb9 reverse peer-virt cascade; v8-specific delta is the
// synthesized preamble handshake (`__metadata.version: 8`).
const PNPM9_YB8_CONTRACTS = CONTRACTS.filter(contract =>
  contract.from === 'pnpm-v9' && contract.to === 'yarn-berry-v8',
) as ConversionContract[]

runIntraFamily('interop: pnpm-v9 -> yarn-berry-v8 (cross-family)', PNPM9_YB8_CONTRACTS)
