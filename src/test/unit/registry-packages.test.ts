// optimize/registryPackages — the locator-aware "which nodes are real
// npm-registry packages" classification (so audit consumers don't re-derive it).

import { describe, it, expect } from 'vitest'
import { registryPackages } from '../../main/ts/optimize/registry-packages.ts'
import { graphOf, addPackage } from './_modify-test-utils.ts'

describe('optimize/registryPackages', () => {
  it('groups registry packages by name (deduped + semver-sorted), excluding non-registry', () => {
    const graph = graphOf(b => {
      // included — registry releases:
      addPackage(b, { name: 'lodash', version: '4.17.21' })
      addPackage(b, { name: 'lodash', version: '4.17.20' })            // same name, 2nd version
      addPackage(b, { name: '@scope/x', version: '1.0.0' })
      addPackage(b, { name: 'tarpkg', version: '2.0.0',               // bare default-registry tarball (source undefined)
        resolution: { type: 'tarball', url: 'https://registry.npmjs.org/tarpkg/-/tarpkg-2.0.0.tgz' } })

      // excluded:
      addPackage(b, { name: 'w', version: '0.0.0', workspacePath: 'packages/w' })                 // workspace
      addPackage(b, { name: 'gitpkg', version: '1.0.0', source: 'deadbeef0badf00d' })              // git / non-registry tarball
      addPackage(b, { name: 'linkpkg', version: '0.0.0', resolution: { type: 'directory', path: '../local' } }) // file:/link:/portal:
      addPackage(b, { name: 'unkpkg', version: '1.0.0', resolution: { type: 'unknown', raw: '???' } })          // unparseable
    })

    expect({ ...registryPackages(graph) }).toEqual({
      lodash: ['4.17.20', '4.17.21'],
      '@scope/x': ['1.0.0'],
      tarpkg: ['2.0.0'],
    })
  })

  it('returns an empty object for a graph with no registry packages', () => {
    const graph = graphOf(b => {
      addPackage(b, { name: 'root', version: '0.0.0', workspacePath: '.' })
    })
    expect({ ...registryPackages(graph) }).toEqual({})
  })
})
