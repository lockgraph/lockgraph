import { describe, expect, it } from 'vitest'
import { newBuilder } from '../../../main/ts/graph.ts'
import { assertConversionContract } from '../_helpers.ts'
import { CONTRACTS, type ConversionContract } from '../_matrix.ts'
import {
  CLASSIC_SHARED_FIXTURES,
  activeContract,
  classicFixtureAsBerrySource,
  defaultBerryCacheKey,
  formatCode,
  minimalBerryLockfile,
  observeInteropDiagnostics,
  parseFormat,
  stringifyFormat,
} from '../_runtime.ts'

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
        const emitted = stringifyFormat('yarn-classic', source.graph)
        const destinationGraph = parseFormat('yarn-classic', emitted.lockfile)
        const interopDiagnostics = observeInteropDiagnostics(contract, {
          sourceGraph: source.graph,
          destinationGraph,
          sourceLockfile: source.lockfile,
          destinationLockfile: emitted.lockfile,
          mode: 'naive',
        })
        const observedContract = activeContract(contract, {
          sourceGraph: source.graph,
          destinationGraph,
          sourceLockfile: source.lockfile,
          destinationLockfile: emitted.lockfile,
          mode: 'naive',
        })

        assertConversionContract(observedContract, {
          graphSource: source.graph,
          graphDestination: destinationGraph,
          diagnostics: [
            ...source.graph.diagnostics(),
            ...emitted.diagnostics,
            ...destinationGraph.diagnostics(),
            ...interopDiagnostics,
          ],
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
      const sourceGraph = parseFormat(contract.from, sourceLockfile)
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
        resolution: 'https://registry.yarnpkg.com/peer/-/peer-2.0.0.tgz#1111111111111111111111111111111111111111',
      })
      graph.addNode({
        id: 'consumer@1.0.0(peer@2.0.0)',
        name: 'consumer',
        version: '1.0.0',
        peerContext: ['peer@2.0.0'],
        resolution: 'https://registry.yarnpkg.com/consumer/-/consumer-1.0.0.tgz#2222222222222222222222222222222222222222',
      })
      graph.addNode({
        id: 'pkg@1.0.0',
        name: 'pkg',
        version: '1.0.0',
        peerContext: [],
        patch: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        workspacePath: 'packages/pkg',
      })
      graph.addEdge('root@1.0.0', 'pkg@1.0.0', 'dep', { range: 'workspace:*', workspace: true })
      graph.addEdge('consumer@1.0.0(peer@2.0.0)', 'peer@2.0.0', 'peer', { range: '^2.0.0' })
      const sourceGraph = graph.seal()
      const sourceLockfile = stringifyFormat(berryFormat, sourceGraph, {
        cacheKey: defaultBerryCacheKey(berryFormat),
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
