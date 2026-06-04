import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { newBuilder } from '../../../main/ts/graph.ts'
import { optimize as optimizeV9 } from '../../../main/ts/formats/yarn-berry-v9.ts'
import { parseFormat, stringifyFormat } from '../_dispatch.ts'
import { graphSnapshot } from '../_snapshot.ts'
import { parseBerryChecksum, type Integrity } from '../../../main/ts/recipe/integrity.ts'

// This graph converts TO yarn-berry-v9, whose integrity field is the zip-cache
// `checksum` — a berry-zip-origin digest (ADR-0031). Build one from the content
// hex so it survives the berry emit→reparse round-trip used below.
const berryChecksum = (s: string): Integrity =>
  parseBerryChecksum(createHash('sha512').update(s).digest('hex')).integrity

describe('interop adversarial §8.6 — cycle pruning interaction', () => {
  it('classic-compatible graph -> berry-v9 keeps optimize idempotent after conversion', () => {
    const builder = newBuilder()
    builder.addNode({
      id: 'root@1.0.0',
      name: 'root',
      version: '1.0.0',
      peerContext: [],
      resolution: 'https://registry.yarnpkg.com/root/-/root-1.0.0.tgz#0000000000000000000000000000000000000000',
    })
    builder.addNode({
      id: 'cycle-a@1.0.0',
      name: 'cycle-a',
      version: '1.0.0',
      peerContext: [],
      resolution: 'https://registry.yarnpkg.com/cycle-a/-/cycle-a-1.0.0.tgz#1111111111111111111111111111111111111111',
    })
    builder.addNode({
      id: 'cycle-b@1.0.0',
      name: 'cycle-b',
      version: '1.0.0',
      peerContext: [],
      resolution: 'https://registry.yarnpkg.com/cycle-b/-/cycle-b-1.0.0.tgz#2222222222222222222222222222222222222222',
    })
    builder.addEdge('cycle-a@1.0.0', 'cycle-b@1.0.0', 'dep', { range: 'npm:1.0.0' })
    builder.addEdge('cycle-b@1.0.0', 'cycle-a@1.0.0', 'dep', { range: 'npm:1.0.0' })
    builder.setTarball({ name: 'root', version: '1.0.0' }, { integrity: berryChecksum('root') })
    builder.setTarball({ name: 'cycle-a', version: '1.0.0' }, { integrity: berryChecksum('cycle-a') })
    builder.setTarball({ name: 'cycle-b', version: '1.0.0' }, { integrity: berryChecksum('cycle-b') })
    const sourceGraph = builder.seal()
    const emitted = stringifyFormat('yarn-berry-v9', sourceGraph)
    const destinationGraph = parseFormat('yarn-berry-v9', emitted.lockfile)
    const once = optimizeV9(destinationGraph)
    const twice = optimizeV9(once.graph)

    expect(graphSnapshot(twice.graph)).toEqual(graphSnapshot(once.graph))
    expect(twice.diagnostics).toEqual(once.diagnostics)
  })
})
