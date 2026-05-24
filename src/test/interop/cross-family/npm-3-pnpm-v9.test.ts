import { CONTRACTS, type ConversionContract } from '../_matrix.ts'
import { runIntraFamily } from '../intra-family/_runner.ts'

// ADR-0020 Phase C-iv: cross-family npm-3 -> pnpm-v9 reverse direction.
// workspace-rekey fires universally (npm-3 named identity vs pnpm-v9
// path-keyed); tarballs drops on sidecar-gated extras (bin/funding) for
// 4/6 fixtures. Asymmetric: round-trip back через npm-3 loses the original
// package-name identity.
const NPM3_PNPM9_CONTRACTS = CONTRACTS.filter(contract =>
  contract.from === 'npm-3' && contract.to === 'pnpm-v9',
) as ConversionContract[]

runIntraFamily('interop: npm-3 -> pnpm-v9 (cross-family)', NPM3_PNPM9_CONTRACTS)
