import { CONTRACTS, type ConversionContract } from '../_matrix.ts'
import { runIntraFamily } from '../intra-family/_runner.ts'

// ADR-0020 Phase C-iii: cross-family npm-3 -> yarn-berry-v9 reverse contract.
// Asymmetric reentrancy class; `tarballs` loss fires on 4/6 fixtures (engines/
// funding extras drop via cross-family sidecar-bridge gap, mirrors Phase B/C-i
// precedent). `__metadata.version` PREAMBLE_SYNTHESIZED fires universally.
const NPM3_YB9_CONTRACTS = CONTRACTS.filter(contract =>
  contract.from === 'npm-3' && contract.to === 'yarn-berry-v9',
) as ConversionContract[]

runIntraFamily('interop: npm-3 -> yarn-berry-v9 (cross-family)', NPM3_YB9_CONTRACTS)
