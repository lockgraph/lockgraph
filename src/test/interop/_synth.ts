// Constructors / synthesis from minimal seed. Functions here build graph state
// or lockfile text from scratch (or from a fixture passed through a pipeline);
// `_normalize.ts` owns transformations of existing graphs.

import type { Graph } from '../../main/ts/graph.ts'
import { parse as parseClassic } from '../../main/ts/formats/yarn-classic.ts'
import { berryCacheKeyOf, parseFormat, stringifyFormat } from './_dispatch.ts'
import { CLASSIC_SHARED_FIXTURES, fixtureLockfile } from './_fixtures.ts'
import { normalizeGraphForBerry } from './_normalize.ts'
import type { FormatId } from './_types.ts'

export function classicFixtureAsBerrySource(
  fixtureName: (typeof CLASSIC_SHARED_FIXTURES)[number],
  format: Extract<FormatId, `yarn-berry-${string}`>,
): { lockfile: string; graph: Graph } {
  const sourceGraph = normalizeGraphForBerry(parseClassic(fixtureLockfile(fixtureName, 'yarn-classic')))
  const emitted = stringifyFormat(format, sourceGraph, { cacheKey: berryCacheKeyOf(format) })
  return {
    lockfile: emitted.lockfile,
    graph: parseFormat(format, emitted.lockfile),
  }
}

export function workspaceFixtureGraph(): Graph {
  return parseFormat('yarn-classic', fixtureLockfile('workspaces-basic', 'yarn-classic')).mutate(m => {
    m.addNode({
      id: '@case-ws/a@0.0.0-use.local',
      name: '@case-ws/a',
      version: '0.0.0-use.local',
      peerContext: [],
    })
    m.addNode({
      id: '@case-ws/b@0.0.0-use.local',
      name: '@case-ws/b',
      version: '0.0.0-use.local',
      peerContext: [],
    })
    m.addEdge('@case-ws/a@0.0.0-use.local', 'ms@2.1.3', 'dep', { range: '2.1.3' })
    m.addEdge('@case-ws/b@0.0.0-use.local', 'ms@2.1.3', 'dep', { range: '2.1.3' })
  }).graph
}

export function minimalBerryLockfile(
  format: Extract<FormatId, `yarn-berry-${string}`>,
  options: { conditions?: boolean; compressionLevel?: boolean } = {},
): string {
  const cacheKey = berryCacheKeyOf(format)
  const checksum = format === 'yarn-berry-v8' || format === 'yarn-berry-v9'
    ? `${cacheKey}/deadbeef`
    : 'deadbeef'
  const compressionLine = options.compressionLevel ? '  compressionLevel: 0\n' : ''
  const conditionsBlock = options.conditions ? '  conditions:\n    os: linux\n' : ''

  return (
    '__metadata:\n' +
    `  version: ${format.slice('yarn-berry-v'.length)}\n` +
    `  cacheKey: ${cacheKey}\n` +
    compressionLine +
    '\n' +
    '"pkg@npm:1.0.0":\n' +
    '  version: 1.0.0\n' +
    '  resolution: "https://registry.yarnpkg.com/pkg/-/pkg-1.0.0.tgz#0000000000000000000000000000000000000000"\n' +
    conditionsBlock +
    `  checksum: ${checksum}\n` +
    '  languageName: node\n' +
    '  linkType: hard\n'
  )
}
