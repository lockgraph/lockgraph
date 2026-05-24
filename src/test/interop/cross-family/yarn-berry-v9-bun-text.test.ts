import { CONTRACTS, type ConversionContract } from '../_matrix.ts'
import { runIntraFamily } from '../intra-family/_runner.ts'

// ADR-0020 Phase C-v: cross-family yarn-berry-v9 -> bun-text forward contract.
// Asymmetric reentrancy class; `workspace-rekey` + `resolved-url` fire across
// the full 7-fixture corpus (yarn-berry stamps root as `<name>@0.0.0-use.local`
// vs bun-text's `<name>@0.0.0` fallback; bun-text tuple emits integrity slot
// only — no URL). `tarballs` fires on peers-basic / peers-multi (loose-envify
// bin sidecar-bridge gap). `patch-yarn` excluded from corpus (bun-text has no
// patch primitive; RECIPE_FEATURE_DROPPED at adapter layer per ADR-0014 §4.F2).
const YB9_BUN_CONTRACTS = CONTRACTS.filter(contract =>
  contract.from === 'yarn-berry-v9' && contract.to === 'bun-text',
) as ConversionContract[]

runIntraFamily('interop: yarn-berry-v9 -> bun-text (cross-family)', YB9_BUN_CONTRACTS)
