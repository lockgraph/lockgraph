// Regression (yaf pijma http-proxy-middleware bump, .87): a node MINTED by a modify
// primitive (replaceVersion / addDependency) — NOT by completion — must keep its
// declared `peerDependencies` / `peerDependenciesMeta`, else the berry emit drops them
// and `yarn install --immutable` re-adds them (YN0028). There are THREE registry→payload
// projections (completion's `projectPackumentVersion` + modify's two `makeTarballPayload`);
// only completion's carried the peer blocks before this fix, so the bumped node lost them.

import { describe, expect, it } from 'vitest'
import { stringify } from '../../main/ts/index.ts'
import { replaceVersion } from '../../main/ts/modify/replace-version.ts'
import { addDependency } from '../../main/ts/modify/add-dependency.ts'
import type { Packument, RegistryAdapter } from '../../main/ts/registry/types.ts'
import { addEdge, addPackage, graphOf } from './_modify-test-utils.ts'

// `hpm@2.0.9` declares an OPTIONAL peer (`@types/express`) — as http-proxy-middleware does.
const registry: RegistryAdapter = {
  async packument(name): Promise<Packument | undefined> {
    if (name === 'hpm') return {
      name, distTags: { latest: '2.0.9' },
      versions: {
        '2.0.6': { name, version: '2.0.6' },
        '2.0.9': { name, version: '2.0.9', peerDependencies: { '@types/express': '^4.17.13' }, peerDependenciesMeta: { '@types/express': { optional: true } } },
      },
    }
    return undefined
  },
  async resolve(name, range) {
    const p = await this.packument(name)
    if (p === undefined) return undefined
    return p.versions[range] ?? Object.values(p.versions).pop()
  },
}

describe('modify mint paths preserve peer blocks (yaf hpm bump → berry frozen-clean)', () => {
  it('replaceVersion: the bumped node keeps peerDependencies / peerDependenciesMeta on its payload AND in emit', async () => {
    const graph = graphOf(b => {
      const ws = addPackage(b, { name: 'app', version: '0.0.0', workspacePath: '.' })
      const old = addPackage(b, { name: 'hpm', version: '2.0.6' })
      addEdge(b, ws, old, 'dep', '^2.0.0')
    })
    const { graph: bumped } = await replaceVersion(graph, { name: 'hpm', fromRange: '2.0.6' }, '2.0.9', { registry })

    // Definitive: the peer blocks PERSISTED onto the graph payload (the drop yaf hit).
    expect(bumped.tarballOf('hpm@2.0.9')?.peerDependencies).toEqual({ '@types/express': '^4.17.13' })
    expect(bumped.tarballOf('hpm@2.0.9')?.peerDependenciesMeta).toEqual({ '@types/express': { optional: true } })

    // …and survive to the yarn-berry emit (scoped peer key is quoted).
    const out = stringify('yarn-berry-v8', bumped)
    expect(out).toContain('peerDependencies:')
    expect(out).toContain('"@types/express": ^4.17.13')
    expect(out).toMatch(/peerDependenciesMeta:\n\s+"@types\/express":\n\s+optional: true/)
  })

  it('addDependency: the added node keeps its peer blocks', async () => {
    const graph = graphOf(b => {
      addPackage(b, { name: 'app', version: '0.0.0', workspacePath: '.' })
    })
    const { graph: withDep } = await addDependency(graph, 'app@0.0.0', 'hpm', '^2.0.0', 'dep', { registry })
    expect(withDep.tarballOf('hpm@2.0.9')?.peerDependencies).toEqual({ '@types/express': '^4.17.13' })
  })
})
