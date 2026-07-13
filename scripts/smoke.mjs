// Smoke test — verifies the BUILT `dist` loads and performs the core conversion
// on the target Node (the 14.18 floor and current 26). Runs on bare `node` (no
// vitest — that needs modern Node) against a prod-deps-only install (`npm ci
// --omit=dev`), so it doubles as a "the published package works with only its
// declared dependencies" check. Imports by package name to exercise the real
// `exports` map (Node self-reference). Registry- and libzip-free by design.
import { strict as assert } from 'node:assert'  // `node:assert/strict` subpath is unknown on Node 14
import { parse, stringify, convert } from 'lockgraph'

// 1) npm-3 parse -> stringify is byte-identical (the round-trip invariant).
const npm3 = JSON.stringify({
  name: 'smoke',
  version: '1.0.0',
  lockfileVersion: 3,
  requires: true,
  packages: { '': { name: 'smoke', version: '1.0.0' } },
}, null, 2) + '\n'

const graph = parse('npm-3', npm3)
assert.equal(stringify('npm-3', graph), npm3, 'npm-3 round-trip must be byte-identical')

// 2) Cross-family convert (npm-3 -> yarn-classic) — the headline feature.
const yarnLock = await convert(npm3, { from: 'npm-3', to: 'yarn-classic' })
assert.ok(yarnLock.includes('# yarn lockfile v1'), 'convert must emit a yarn.lock header')

// 3) A dependency edge survives the graph model.
const withDep = JSON.stringify({
  name: 'smoke', version: '1.0.0', lockfileVersion: 3, requires: true,
  packages: {
    '': { name: 'smoke', version: '1.0.0', dependencies: { dep: '^1.0.0' } },
    'node_modules/dep': { version: '1.2.3' },
  },
}, null, 2) + '\n'
const g2 = parse('npm-3', withDep)
assert.ok([...g2.byName('dep')].length === 1, 'the dependency node must be present')

console.log(`smoke OK — lockgraph loads + converts on ${process.version}`)
