import { CONTRACTS, type ConversionContract } from '../_matrix.ts'
import { runIntraFamily } from './_runner.ts'

// ADR-0020 Phase A: npm-family intra contracts (npm-1 / npm-2 / npm-3, 6 pairs).
// Loss profile per `_matrix.ts` `buildNpmIntraPair`:
//   - npm-1 → npm-{2,3} and npm-{2,3} ↔ npm-{2,3}: `lossless-reentrant`
//   - npm-{2,3} → npm-1: `asymmetric` — first-class
//     `INTEROP_NPM_<n>_TO_NPM_1_{EDGES,TARBALLS,WORKSPACE}_DROPPED` losses
//     declared per ADR-0020 §2/§3.
const NPM_CONTRACTS = CONTRACTS.filter(contract =>
  contract.from.startsWith('npm-') && contract.to.startsWith('npm-'),
) as ConversionContract[]

runIntraFamily('interop: npm intra-family fixtures', NPM_CONTRACTS)
