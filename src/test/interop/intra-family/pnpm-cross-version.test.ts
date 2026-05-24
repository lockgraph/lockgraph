import { CONTRACTS, type ConversionContract } from '../_matrix.ts'
import { runIntraFamily } from './_runner.ts'

// ADR-0020 Phase B: pnpm-family intra contracts (pnpm-v5 / pnpm-v6 / pnpm-v9,
// 6 pairs). Loss profile per `_matrix.ts` `buildPnpmIntraPair`:
//   - v6 ↔ v9: `lossless-reentrant` (flat-core shared sidecar)
//   - v5 ↔ {v6, v9}: `asymmetric` — tarball extras drop across the v5
//     sidecar bridge gap; downgrade-to-v5 ADDITIONALLY drops Node.patch
const PNPM_CONTRACTS = CONTRACTS.filter(contract =>
  contract.from.startsWith('pnpm-v') && contract.to.startsWith('pnpm-v'),
) as ConversionContract[]

runIntraFamily('interop: pnpm intra-family fixtures', PNPM_CONTRACTS)
