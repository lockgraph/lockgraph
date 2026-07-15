import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { canonicalGraphSnapshot } from '../../main/ts/api/format-api.ts'
import { parse } from '../../main/ts/index.ts'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = readFileSync(resolve(
  here,
  '../resources/fixtures/lockfiles/simple/npm-3.lock',
), 'utf8')

describe('canonicalGraphSnapshot', () => {
  it('rebuilds its sort index after same-identity node, edge, and tarball deltas', () => {
    const graph = parse('npm-3', fixture)
    const assertObserved = (mutate: () => void) => {
      const before = canonicalGraphSnapshot(graph, 'snapshot')
      mutate()
      expect(canonicalGraphSnapshot(graph, 'snapshot')).not.toBe(before)
    }

    const node = [...graph.nodes()].find(candidate => candidate.workspacePath === undefined)!
    const payload = graph.tarballOf(node.id)!
    assertObserved(() => { node.version = '99.0.0' })

    const root = [...graph.nodes()].find(candidate => candidate.workspacePath === '')!
    const edge = graph.out(root.id).find(candidate => candidate.attrs?.range !== undefined)!
    assertObserved(() => { edge.attrs!.range = '99.0.0' })

    assertObserved(() => { payload.license = 'P4-sentinel' })
  })
})
