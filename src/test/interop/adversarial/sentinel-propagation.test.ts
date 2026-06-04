import { describe, expect, it } from 'vitest'
import { newBuilder, toTarballKey } from '../../../main/ts/graph.ts'
import { parseFormat, stringifyFormat } from '../_dispatch.ts'
import { CONTRACTS } from '../_matrix.ts'
import { observeInteropDiagnostics } from '../_observe.ts'
import { sri } from '../../_integrity-fixtures.ts'

// A real sha512 SRI so the value survives yarn-classic emit→reparse byte-exact
// (a sentinel marker would not round-trip and would spuriously diverge the
// tarball payload). Integrity is incidental here — these tests assert patch /
// sentinel-collapse interop diagnostics, not the digest.
const PKG_SRI = sri('sha512-6IMTriUmvsjHUjNtEDudZfuDQUoWXVxKHhlEGSk81n4YFS+r/Kl99wXiwlVXtPBtJenozv2P+hxDsw9eA7Xo6g==')

// Synthetic in-memory graph: sentinel patches and out-of-band tarball payloads
// can't be expressed by parsing a real berry lockfile, so this test exercises
// `stringifyFormat` + `observeInteropDiagnostics` directly rather than going
// through `convert`. Coverage remains real-graph comparison via featurePresence.
describe('interop adversarial §8.2 — sentinel propagation', () => {
  const patch = 'unresolved-deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef'
  const nodeId = toTarballKey({ name: 'pkg', version: '1.0.0', patch })

  it('berry-v9 -> yarn-classic collapses a sentinel patch and still surfaces the loss through interop diagnostics', () => {
    const contract = CONTRACTS.find(entry => entry.from === 'yarn-berry-v9' && entry.to === 'yarn-classic')
    if (contract === undefined) throw new Error('missing interop contract for yarn-berry-v9 -> yarn-classic')

    const builder = newBuilder()
    builder.addNode({
      id: nodeId,
      name: 'pkg',
      version: '1.0.0',
      peerContext: [],
      patch,
      resolution: 'https://registry.yarnpkg.com/pkg/-/pkg-1.0.0.tgz#0000000000000000000000000000000000000000',
    })
    builder.setTarball(
      {
        name: 'pkg',
        version: '1.0.0',
        patch,
      },
      { integrity: PKG_SRI },
    )
    const sourceGraph = builder.seal()
    const emitted = stringifyFormat('yarn-classic', sourceGraph)
    const destinationGraph = parseFormat('yarn-classic', emitted.lockfile)
    const interopDiagnostics = observeInteropDiagnostics(contract, {
      sourceGraph,
      destinationGraph,
      sourceLockfile: '__metadata:\n  version: 9\n  cacheKey: 10c0\n',
      destinationLockfile: emitted.lockfile,
      mode: 'naive',
    })

    expect(Array.from(destinationGraph.nodes()).some(node => node.patch?.startsWith('unresolved-') === true)).toBe(false)
    expect(interopDiagnostics.map(diagnostic => diagnostic.code)).toContain(
      'INTEROP_YARN_BERRY_V9_TO_YARN_CLASSIC_PATCH_DROPPED',
    )
  })

  it('berry-v9 -> yarn-classic emits the explicit INTEROP_YARN_BERRY_V9_TO_YARN_CLASSIC_SENTINEL_COLLAPSED diagnostic alongside the coarser PATCH_DROPPED row', () => {
    const contract = CONTRACTS.find(entry => entry.from === 'yarn-berry-v9' && entry.to === 'yarn-classic')
    if (contract === undefined) throw new Error('missing interop contract for yarn-berry-v9 -> yarn-classic')

    const builder = newBuilder()
    builder.addNode({
      id: nodeId,
      name: 'pkg',
      version: '1.0.0',
      peerContext: [],
      patch,
      resolution: 'https://registry.yarnpkg.com/pkg/-/pkg-1.0.0.tgz#0000000000000000000000000000000000000000',
    })
    builder.setTarball(
      {
        name: 'pkg',
        version: '1.0.0',
        patch,
      },
      { integrity: PKG_SRI },
    )
    const sourceGraph = builder.seal()
    const emitted = stringifyFormat('yarn-classic', sourceGraph)
    const destinationGraph = parseFormat('yarn-classic', emitted.lockfile)
    const interopDiagnostics = observeInteropDiagnostics(contract, {
      sourceGraph,
      destinationGraph,
      sourceLockfile: '__metadata:\n  version: 9\n  cacheKey: 10c0\n',
      destinationLockfile: emitted.lockfile,
      mode: 'naive',
    })

    expect(interopDiagnostics.map(diagnostic => diagnostic.code)).toContain(
      'INTEROP_YARN_BERRY_V9_TO_YARN_CLASSIC_SENTINEL_COLLAPSED',
    )
  })
})
