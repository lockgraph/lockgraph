import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse, stringify } from '../../../main/ts/index.ts'

// Bug #4 (yarn-audit-fix sweep): yarnpkg/berry's own monorepo lock failed seal
// because a `portal:` package (a local directory link, not a workspace) declares
// `"<root>": "workspace:^"`, giving the root workspace an incoming edge from a
// non-workspace source. ADR-0017's intent is to block *published* packages from
// depending on a workspace; a LOCAL node (canonical resolution type 'directory')
// may. The full 980KB lock is the only repro — the trigger is graph-shape-
// dependent — so it lives here (not the auto-scanned `real-world/` corpus).
const here = dirname(fileURLToPath(import.meta.url))
const berryLock = readFileSync(
  resolve(here, '../../resources/fixtures/seal/yarnpkg-berry-v7-a66e5285/yarn.lock'), 'utf8')

describe('real-world berry workspace seal (yarn-audit-fix #4)', () => {
  it('parses berry monorepo lock where a portal: package depends on the root via workspace:^', () => {
    const g = parse('yarn-berry-v7', berryLock)
    const root = g.getNode('@yarnpkg/monorepo@0.0.0-use.local')
    expect(root).toBeDefined()
    // The fix permits the incoming edge — the root IS depended upon by locals.
    expect(g.in('@yarnpkg/monorepo@0.0.0-use.local').length).toBeGreaterThan(0)
    // …and at least one such incoming source is a local `portal:`/directory node
    // (not a workspace), which is exactly the case the old seal rejected.
    const incomingFromNonWorkspace = g
      .in('@yarnpkg/monorepo@0.0.0-use.local')
      .some(e => g.getNode(e.src)?.workspacePath === undefined)
    expect(incomingFromNonWorkspace).toBe(true)
  })

  it('round-trips without throwing', () => {
    expect(() => stringify('yarn-berry-v7', parse('yarn-berry-v7', berryLock))).not.toThrow()
  })
})
