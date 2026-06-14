import { describe, expect, it } from 'vitest'
import { newBuilder, toTarballKey } from '../../../main/ts/graph.ts'
import { assertConversionContract } from '../_assert.ts'
import { berryCacheKeyOf, convert, formatCode, parseFormat, stringifyFormat } from '../_dispatch.ts'
import { CLASSIC_SHARED_FIXTURES } from '../_fixtures.ts'
import { CONTRACTS, type ConversionContract } from '../_matrix.ts'
import { classicFixtureAsBerrySource, minimalBerryLockfile } from '../_synth.ts'
import { activeContract, observeInteropDiagnostics } from '../_observe.ts'

const CONTRACTS_TO_CLASSIC = CONTRACTS.filter(contract =>
  contract.to === 'yarn-classic' && contract.from.startsWith('yarn-berry-')
) as ConversionContract[]

describe('interop: yarn-berry -> yarn-classic (classic-compatible berry fixtures)', () => {
  for (const contract of CONTRACTS_TO_CLASSIC) {
    describe(`${contract.from} -> ${contract.to}`, () => {
      it.each(CLASSIC_SHARED_FIXTURES)('%s fixture satisfies the declared contract', fixtureName => {
        const source = classicFixtureAsBerrySource(
          fixtureName,
          contract.from as Extract<ConversionContract['from'], `yarn-berry-${string}`>,
        )
        const result = convert({
          from: contract.from,
          to: 'yarn-classic',
          source: source.lockfile,
          mode: 'naive',
        })
        const observedContract = activeContract(contract, {
          sourceGraph: result.sourceGraph,
          destinationGraph: result.destinationGraph,
          sourceLockfile: source.lockfile,
          destinationLockfile: result.lockfile,
          mode: 'naive',
        })

        assertConversionContract(observedContract, {
          graphSource: result.sourceGraph,
          graphDestination: result.destinationGraph,
          diagnostics: result.diagnostics,
          mode: 'naive',
          fixture: `classic-compatible:${fixtureName}`,
        })
      })
    })
  }
})

describe('interop: yarn-berry -> yarn-classic targeted loss classes', () => {
  for (const contract of CONTRACTS_TO_CLASSIC) {
    const berryFormat = contract.from as Extract<ConversionContract['from'], `yarn-berry-${string}`>

    it(`${contract.from} drops declared metadata fields and conditions when present`, () => {
      const sourceLockfile = minimalBerryLockfile(berryFormat, {
        conditions: contract.from !== 'yarn-berry-v4',
        compressionLevel: true,
      })
      const result = convert({
        from: contract.from,
        to: 'yarn-classic',
        source: sourceLockfile,
        mode: 'naive',
      })
      const codes = new Set(
        result.diagnostics
          .filter(d => d.code.startsWith('INTEROP_'))
          .map(diagnostic => `${diagnostic.code}:${diagnostic.severity}`),
      )

      expect(codes).toContain(
        `INTEROP_${formatCode(contract.from)}_TO_YARN_CLASSIC_CACHEKEY_DROPPED:info`,
      )
      expect(codes).toContain(
        `INTEROP_${formatCode(contract.from)}_TO_YARN_CLASSIC_COMPRESSIONLEVEL_DROPPED:info`,
      )

      if (contract.from !== 'yarn-berry-v4') {
        expect(codes).toContain(
          `INTEROP_${formatCode(contract.from)}_TO_YARN_CLASSIC_CONDITIONS_DROPPED:warning`,
        )
      }
    })

    // Synthetic in-memory graph: builds peer/patch/virtual/workspace state that
    // would not survive a berry->classic source-lockfile round-trip (workspace
    // resolutions like `pkg@workspace:...` raise on classic parse), so this case
    // bypasses `convert` and exercises `stringifyFormat` + `observeInteropDiagnostics`
    // directly. Surface coverage is still real-graph comparison via featurePresence.
    it(`${contract.from} drops peer virtualisation, patches, virtual keys, and workspace metadata when present`, () => {
      const graph = newBuilder()
      graph.addNode({
        id: 'root@1.0.0',
        name: 'root',
        version: '1.0.0',
        peerContext: [],
        workspacePath: '',
      })
      graph.addNode({
        id: 'peer@2.0.0',
        name: 'peer',
        version: '2.0.0',
        peerContext: [],
      })
      graph.addNode({
        id: 'consumer@1.0.0(peer@2.0.0)',
        name: 'consumer',
        version: '1.0.0',
        peerContext: ['peer@2.0.0'],
      })
      graph.setTarball({ name: 'peer', version: '2.0.0' }, { nativeResolution: 'https://registry.yarnpkg.com/peer/-/peer-2.0.0.tgz#1111111111111111111111111111111111111111' })
      graph.setTarball({ name: 'consumer', version: '1.0.0' }, { nativeResolution: 'https://registry.yarnpkg.com/consumer/-/consumer-1.0.0.tgz#2222222222222222222222222222222222222222' })
      graph.addNode({
        id: toTarballKey({
          name: 'pkg',
          version: '1.0.0',
          patch: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        }),
        name: 'pkg',
        version: '1.0.0',
        peerContext: [],
        patch: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        workspacePath: 'packages/pkg',
      })
      graph.addEdge(
        'root@1.0.0',
        toTarballKey({
          name: 'pkg',
          version: '1.0.0',
          patch: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        }),
        'dep',
        { range: 'workspace:*', workspace: true },
      )
      graph.addEdge('consumer@1.0.0(peer@2.0.0)', 'peer@2.0.0', 'peer', { range: '^2.0.0' })
      const sourceGraph = graph.seal()
      const sourceLockfile = stringifyFormat(berryFormat, sourceGraph, {
        cacheKey: berryCacheKeyOf(berryFormat),
      }).lockfile
      const emitted = stringifyFormat('yarn-classic', sourceGraph)
      const destinationGraph = parseFormat('yarn-classic', emitted.lockfile)
      const interopDiagnostics = observeInteropDiagnostics(contract, {
        sourceGraph,
        destinationGraph,
        sourceLockfile,
        destinationLockfile: emitted.lockfile,
        mode: 'naive',
      })
      const codes = new Set(interopDiagnostics.map(diagnostic => `${diagnostic.code}:${diagnostic.severity}`))

      expect(codes).toContain(
        `INTEROP_${formatCode(contract.from)}_TO_YARN_CLASSIC_PEER_VIRT_DROPPED:warning`,
      )
      expect(codes).toContain(
        `INTEROP_${formatCode(contract.from)}_TO_YARN_CLASSIC_PATCH_DROPPED:warning`,
      )
      expect(codes).toContain(
        `INTEROP_${formatCode(contract.from)}_TO_YARN_CLASSIC_VIRTUAL_DROPPED:warning`,
      )
      expect(codes).toContain(
        `INTEROP_${formatCode(contract.from)}_TO_YARN_CLASSIC_WORKSPACE_METADATA_DROPPED:info`,
      )
    })
  }
})
