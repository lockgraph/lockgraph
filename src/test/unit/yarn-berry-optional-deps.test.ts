// yaf lockgraph-message (.69 follow-up) — yarn-berry has NO `optionalDependencies:`
// block. An optional dep belongs in `dependencies:` and is flagged via
// `dependenciesMeta.<name>.optional: true` (spec/formats/_common.md §1.4). A real
// yarn rejects a separate `optionalDependencies` map on `install --immutable`
// (YN0028). `optional`-KIND edges (completion / cross-family convert) must emit
// in the folded form, not their own block.

import { describe, expect, it } from 'vitest'
import { stringify } from '../../main/ts/index.ts'
import { addEdge, addPackage, graphOf } from './_modify-test-utils.ts'

describe('yarn-berry: optional deps fold into dependencies + dependenciesMeta', () => {
  it('an optional-kind edge emits folded, not as an optionalDependencies block', () => {
    const graph = graphOf(builder => {
      const ws       = addPackage(builder, { name: 'app',        version: '0.0.0', workspacePath: '.' })
      const hb       = addPackage(builder, { name: 'handlebars', version: '4.7.9' })
      const minimist = addPackage(builder, { name: 'minimist',   version: '1.2.8' })
      const uglify   = addPackage(builder, { name: 'uglify-js',  version: '3.17.4' })
      addEdge(builder, ws, hb,       'dep', '^4.7.9')
      addEdge(builder, hb, minimist, 'dep', '^1.2.5')
      addEdge(builder, hb, uglify,   'optional', '^3.1.4')
    })

    const out = stringify('yarn-berry-v8', graph, { strict: false })

    // No separate optionalDependencies map anywhere.
    expect(out).not.toContain('optionalDependencies:')
    // Optional dep folded into `dependencies` with the npm: protocol, alongside
    // the regular dep, name-sorted.
    expect(out).toContain('minimist: "npm:^1.2.5"')
    expect(out).toContain('uglify-js: "npm:^3.1.4"')
    // Flagged via dependenciesMeta.<name>.optional, emitted BARE (not "true").
    expect(out).toMatch(/dependenciesMeta:\n\s+uglify-js:\n\s+optional: true/)
    expect(out).not.toContain('optional: "true"')
  })
})
