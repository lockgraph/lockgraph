import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { YarnClassicManifest } from '../../main/ts/formats/yarn-classic.ts'
import type { FormatId } from './_types.ts'

const here = dirname(fileURLToPath(import.meta.url))

export function fixtureLockfile(fixtureName: string, format: FormatId): string {
  return readFileSync(
    resolve(here, '../resources/fixtures/lockfiles', fixtureName, `${format}.lock`),
    'utf8',
  )
}

export const WORKSPACE_MANIFESTS: Record<string, YarnClassicManifest> = {
  '': {
    name: 'case-workspaces-basic',
    version: '0.0.0',
    dependencies: { '@case-ws/a': 'workspace:*' },
    devDependencies: { '@case-ws/b': 'workspace:^' },
    optionalDependencies: { ms: '2.1.3' },
  },
  'packages/a': {
    name: '@case-ws/a',
    version: '1.0.0',
    dependencies: { ms: '2.1.3' },
  },
  'packages/b': {
    name: '@case-ws/b',
    version: '1.1.0',
    dependencies: { ms: '2.1.3' },
  },
}

// Classic-compatible shared corpus:
// - bundled-deps excluded because no yarn-classic fixture exists on disk
// - patch-yarn excluded because yarn-classic cannot represent patch slots;
//   patch-loss path covered by synthetic graph
//   (cross-family/yarn-berry-to-yarn-classic.test.ts:97-157), TODO
//   real-fixture coverage tracked under `interop-real-diagnostic-emission` stub
// - workspace-cross-refs excluded because no yarn-classic fixture exists on disk
export const CLASSIC_SHARED_FIXTURES = [
  'deps-with-scopes',
  'git-github-tarball',
  'peers-basic',
  'peers-multi',
  'simple',
  'workspaces-basic',
  'yarn-crlf',
] as const

// Shared berry corpus across v4/v5/v6/v8 pairs:
// - bundled-deps excluded because no yarn-berry fixture exists on disk
// - patch-yarn excluded because only yarn-berry-v9.lock exists on disk
// - workspace-cross-refs excluded because yarn-berry-v4.lock is absent
export const BERRY_SHARED_FIXTURES = [
  'deps-with-scopes',
  'git-github-tarball',
  'peers-basic',
  'peers-multi',
  'simple',
  'workspaces-basic',
  'yarn-crlf',
] as const

// Shared berry corpus for v9<->v4 pairs: derives from BERRY_SHARED_FIXTURES minus
// `git-github-tarball` (yarn-berry-v9.lock absent on disk).
export const BERRY_SHARED_NO_GIT_FOR_V9 = BERRY_SHARED_FIXTURES.filter(
  (fixture): fixture is Exclude<typeof BERRY_SHARED_FIXTURES[number], 'git-github-tarball'> =>
    fixture !== 'git-github-tarball',
)

// Workspace-focused berry corpus for v5/v6/v8/v9 pairs: derives from
// BERRY_SHARED_NO_GIT_FOR_V9 plus `workspace-cross-refs` (workspace-only signal).
export const BERRY_WORKSPACE_FIXTURES = [
  ...BERRY_SHARED_NO_GIT_FOR_V9,
  'workspace-cross-refs' as const,
]
