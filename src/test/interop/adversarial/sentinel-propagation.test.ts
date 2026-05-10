import { describe, expect, it } from 'vitest'
import { newBuilder } from '../../../main/ts/graph.ts'
import { parseFormat, stringifyFormat } from '../_dispatch.ts'
import { CONTRACTS } from '../_matrix.ts'
import { observeInteropDiagnostics } from '../_observe.ts'

// Synthetic in-memory graph: sentinel patches and out-of-band tarball payloads
// can't be expressed by parsing a real berry lockfile, so this test exercises
// `stringifyFormat` + `observeInteropDiagnostics` directly rather than going
// through `convert`. Coverage remains real-graph comparison via featurePresence.
describe('interop adversarial §8.2 — sentinel propagation', () => {
  it('berry-v9 -> yarn-classic collapses a sentinel patch and still surfaces the loss through interop diagnostics', () => {
    const contract = CONTRACTS.find(entry => entry.from === 'yarn-berry-v9' && entry.to === 'yarn-classic')
    if (contract === undefined) throw new Error('missing interop contract for yarn-berry-v9 -> yarn-classic')

    const builder = newBuilder()
    builder.addNode({
      id: 'pkg@1.0.0',
      name: 'pkg',
      version: '1.0.0',
      peerContext: [],
      patch: 'unresolved-deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      resolution: 'https://registry.yarnpkg.com/pkg/-/pkg-1.0.0.tgz#0000000000000000000000000000000000000000',
    })
    builder.setTarball(
      {
        name: 'pkg',
        version: '1.0.0',
        patch: 'unresolved-deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      },
      { integrity: 'sha512-pkg' },
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

  it.todo(
    'berry-v9 -> yarn-classic should grow an explicit INTEROP_YARN_BERRY_V9_TO_YARN_CLASSIC_SENTINEL_COLLAPSED diagnostic once the matrix adds sentinel-specific rows',
  )
})
