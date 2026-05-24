import { CONTRACTS, type ConversionContract } from '../_matrix.ts'
import { runIntraFamily } from '../intra-family/_runner.ts'

// ADR-0020 Phase C-v: cross-family bun-text -> yarn-berry-v9 reverse contract.
// Asymmetric reentrancy class; graph state fully preserved across the corpus
// (bun-text source aligns with yarn-berry-v9 NodeId convention through the
// member-ref `[<name>@workspace:<path>]` shape). `__metadata.version`
// PREAMBLE_SYNTHESIZED fires universally (yarn-berry destinations always
// synthesise a `__metadata` block absent from bun-text sources).
const BUN_YB9_CONTRACTS = CONTRACTS.filter(contract =>
  contract.from === 'bun-text' && contract.to === 'yarn-berry-v9',
) as ConversionContract[]

runIntraFamily('interop: bun-text -> yarn-berry-v9 (cross-family)', BUN_YB9_CONTRACTS)
