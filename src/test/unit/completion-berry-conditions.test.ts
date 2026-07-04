// Regression (yaf pijma real-world break): `completeTransitives` adds berry nodes
// (platform-optional packages: `@napi-rs/nice-*`, `@esbuild/*`, `@rollup/rollup-*`,
// `@swc/*`, lightningcss, … — ubiquitous) that carry STRUCTURED os/cpu/libc from
// their packument but NO parse-captured `conditions` sidecar. The berry emit must
// COMPOSE `conditions:` from those structured fields, else yarn re-ADDS the field on
// `yarn install --immutable` → YN0028. Same question for peerDependencies /
// peerDependenciesMeta on a completion-added package (probed below).

import { describe, expect, it } from 'vitest'
import { stringify } from '../../main/ts/index.ts'
import { completeTransitives } from '../../main/ts/complete/tree-complete.ts'
import type { Packument, RegistryAdapter } from '../../main/ts/registry/types.ts'
import { addEdge, addPackage, graphOf } from './_modify-test-utils.ts'

const registry: RegistryAdapter = {
  async packument(name): Promise<Packument | undefined> {
    if (name === 'native-host') return {
      name, distTags: { latest: '1.0.0' },
      versions: { '1.0.0': { name, version: '1.0.0',
        dependencies: { 'needs-peer': '^1.0.0' },
        optionalDependencies: {
          '@napi-rs/nice-darwin-arm64': '1.1.1',
          '@napi-rs/nice-linux-x64-musl': '1.1.1',
          'no-windows': '1.0.0',
        },
      } },
    }
    if (name === '@napi-rs/nice-darwin-arm64') return {
      name, distTags: { latest: '1.1.1' },
      versions: { '1.1.1': { name, version: '1.1.1', os: ['darwin'], cpu: ['arm64'] } },
    }
    if (name === '@napi-rs/nice-linux-x64-musl') return {
      name, distTags: { latest: '1.1.1' },
      versions: { '1.1.1': { name, version: '1.1.1', os: ['linux'], cpu: ['x64'], libc: ['musl'] } },
    }
    // eiows-style negated platform constraint.
    if (name === 'no-windows') return {
      name, distTags: { latest: '1.0.0' },
      versions: { '1.0.0': { name, version: '1.0.0', os: ['!win32'] } },
    }
    if (name === 'needs-peer') return {
      name, distTags: { latest: '1.0.0' },
      versions: { '1.0.0': { name, version: '1.0.0',
        peerDependencies: { react: '^18.0.0' },
        peerDependenciesMeta: { react: { optional: true } },
      } },
    }
    return undefined
  },
  async resolve(name, range) {
    const p = await this.packument(name)
    if (p === undefined) return undefined
    return p.versions[range] ?? Object.values(p.versions)[0]
  },
}

const seed = () => graphOf(b => {
  const ws = addPackage(b, { name: 'app', version: '0.0.0', workspacePath: '.' })
  const h = addPackage(b, { name: 'native-host', version: '1.0.0' })
  addEdge(b, ws, h, 'dep', '^1.0.0')
})

describe('completion → yarn-berry emit derives platform/peer fields from structured data (yaf pijma/napi-rs)', () => {
  it('composes conditions for a completion-added platform-optional package (os+cpu)', async () => {
    const { graph } = await completeTransitives(seed(), registry)
    const out = stringify('yarn-berry-v8', graph)
    expect(out).toContain('conditions: os=darwin & cpu=arm64')
  })

  it('composes conditions including libc (os+cpu+libc)', async () => {
    const { graph } = await completeTransitives(seed(), registry)
    const out = stringify('yarn-berry-v8', graph)
    expect(out).toContain('conditions: os=linux & cpu=x64 & libc=musl')
  })

  it('composes a NEGATED os value with the ! BEFORE the axis (yarn toConditionToken)', async () => {
    const { graph } = await completeTransitives(seed(), registry)
    const out = stringify('yarn-berry-v8', graph)
    expect(out).toContain('conditions: !os=win32') // NOT `os=!win32` (would be YN0028)
    expect(out).not.toContain('os=!win32')
  })

  // The composer lives in the SHARED berry core — so it is NOT v8-specific. Prove it
  // on v10 (newest) and confirm the per-version `conditionsAllowed` gate on v4.
  it('is version-general: yarn-berry-v10 composes conditions too (shared core, not v8-only)', async () => {
    const { graph } = await completeTransitives(seed(), registry)
    const out = stringify('yarn-berry-v10', graph)
    expect(out).toContain('conditions: os=darwin & cpu=arm64')
    expect(out).toContain('conditions: os=linux & cpu=x64 & libc=musl')
  })

  it('respects conditionsAllowed=false: yarn-berry-v4 drops conditions (unsupported), no stray field', async () => {
    const { graph } = await completeTransitives(seed(), registry)
    const out = stringify('yarn-berry-v4', graph)
    expect(out).not.toContain('conditions:')
  })

  it('emits peerDependencies for a completion-added package (byte-exact block)', async () => {
    const { graph } = await completeTransitives(seed(), registry)
    const out = stringify('yarn-berry-v8', graph)
    // Bare range, matching yarn's own `ajv: ^8.0.0` form (corpus-verified).
    expect(out).toContain('  peerDependencies:\n    react: ^18.0.0\n')
  })

  it('emits peerDependenciesMeta.optional for a completion-added package (byte-exact block)', async () => {
    const { graph } = await completeTransitives(seed(), registry)
    const out = stringify('yarn-berry-v8', graph)
    expect(out).toContain('  peerDependenciesMeta:\n    react:\n      optional: true\n')
  })
})
