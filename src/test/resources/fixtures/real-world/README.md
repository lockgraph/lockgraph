# Real-world lockfile fixtures

These fixtures are snapshots from real repositories, not synthetic templates.
They exist to exercise cross-family conversion against graph shapes emitted by
actual package-manager workflows.

Conversion behaviour here is empirical and exploratory. The corresponding probe
test validates that each conversion either:

- emits target output that the target adapter accepts and reparses, or
- fails with a classified error shape

Unlike `fixtures/lockfiles/`, these files are not contract-pinned loss
profiles. They preserve the original source filenames (`yarn.lock`,
`package-lock.json`, `pnpm-lock.yaml`, `bun.lock`) and the probe detects the
source format at runtime.

## Snapshot manifest

Fetch date: `2026-05-22`

| Repo handle | Source repo | Commit SHA | File | Detected format |
| --- | --- | --- | --- | --- |
| `qiwi-pijma-master-18d531c` | `https://github.com/qiwi/pijma` | `18d531c4e41ea1b30c7b2f998d434f9531c8e030` | `yarn.lock` | `yarn-berry-v8` |
| `antongolub-misc-master-ee9a6d9` | `https://github.com/antongolub/misc` | `ee9a6d9ef4dd35fcb79daa217ed6680d0d5a1015` | `yarn.lock` | `yarn-berry-v8` |
| `qiwi-masker-master-1b3cf47` | `https://github.com/qiwi/masker` | `1b3cf47948381e82cb775eb450cf7064b82c5d3d` | `yarn.lock` | `yarn-berry-v8` |
| `qiwi-mware-master-ed822d4` | `https://github.com/qiwi/mware` | `ed822d4d23737268917097a07e46b9ac559bed43` | `yarn.lock` | `yarn-berry-v6` |
| `qiwi-uniconfig-master-c5e7d5a` | `https://github.com/qiwi/uniconfig` | `c5e7d5a33e9c1b773eb235ab943c9f77e7a459ec` | `yarn.lock` | `yarn-berry-v7` |
| `qiwi-nestjs-enterprise-master-1a00233` | `https://github.com/qiwi/nestjs-enterprise` | `1a002336c7847ac3d981769ff6fcc367b55d4532` | `yarn.lock` | `yarn-berry-v7` |

Fixtures with `__metadata.version: 7` were emitted by Yarn 4 during a brief
intermediate lockfile-format window between v6 and v8. The `yarn-berry-v7`
adapter (added per `implementer/yarn-berry-v7-adapter` dispatch) maps the
transitional shape onto the shared `_yarn-berry-core` family pipeline
(quoted-protocol ranges like v8/v9 + raw-hex checksum like v4/v5/v6 +
`conditions:` blocks per the v5+ inheritance).

### Sister-session canary import — Yarn 4 large monorepos

Discovered via the `yarn-audit-fix` sister-session's real-world canary
(first run against `@antongolub/lockfile@0.0.0-snapshot.45`, 2026-05-28).
Re-pinned 2026-05-29 to exact commits: each fixture's directory handle is
`<space>-<repo>-<branch>-<sha7>` and its `yarn.lock` is byte-identical to
that commit's `yarn.lock` (re-fetched from `raw.githubusercontent.com` at
the recorded SHA — provenance is verifiable, not approximate).

| Repo handle | Source repo | Stars | Branch | Format | Historically exercised |
| --- | --- | ---: | --- | --- | --- |
| `storybookjs-storybook-next-d6ce689` | `https://github.com/storybookjs/storybook` | 90k | `next` | `yarn-berry-v8` | clean baseline (3074 nodes) |
| `parcel-bundler-parcel-v2-5948485` | `https://github.com/parcel-bundler/parcel` | 44k | `v2` | `yarn-berry-v8` | clean baseline (2216 nodes) |
| `redwoodjs-redwood-main-a7852fb` | `https://github.com/redwoodjs/redwood` | 17k | `main` | `yarn-berry-v8` | clean baseline (2840 nodes) |
| `backstage-backstage-master-b55138e` | `https://github.com/backstage/backstage` | 33k | `master` | `yarn-berry-v8` | Bug #2 — `link:` NodeId collision on multi-workspace links |
| `babel-babel-main-ae57969` | `https://github.com/babel/babel` | 44k | `main` | `yarn-berry-v9` | Bug #2 — `link:` NodeId collision (`$repo-utils`) |
| `facebook-jest-main-4c3091b` | `https://github.com/facebook/jest` | 45k | `main` | `yarn-berry-v10` | Bug #3 (aliased `metro-source-map`→`@babel/traverse`) + Bug #4 (published-self-link `jest-preset-angular`→`@jest/environment-jsdom-abstract`) |
| `prettier-prettier-main-08c9bbd` | `https://github.com/prettier/prettier` | 52k | `main` | `yarn-berry-v10` | Bug #1 — `__metadata.version: 10` adapter (yarn 5 dev-branch) |
| `yarnpkg-berry-master-6861e75` | `https://github.com/yarnpkg/berry` | 8k | `master` | `yarn-berry-v10` | Bug #1 — `__metadata.version: 10` adapter |
| `highlight-highlight-main-7a297b5` | `https://github.com/highlight/highlight` | 9k | `main` | `yarn-berry-v8` | Bug #5 — YAML explicit `? key` / `:` block-mapping (over-long composite `typescript@patch:` descriptor, ~2 KB key) |

All nine now parse + round-trip clean at HEAD (9/9). Bugs #1–#5 are fixed
and additionally pinned by synthetic unit tests (`graph.test.ts`,
`yarn-berry-v9.test.ts`); these real-world fixtures provide breadth-canary
coverage. Note the 2026-05-29 re-pin moved `facebook-jest` from a v9 to a
v10 lockfile (the repo regenerated upstream), which now also exercises the
`yarn-berry-v10` adapter against a published-self-link graph.

### Cross-PM exotic fixtures — pnpm / npm / bun

Added to broaden the corpus beyond yarn (the overrides/resolutions sweep + the
L1 `Manifest` model). Directory handle is `<space>-<repo>-<branch>-<sha7>`; the
lockfile is byte-identical to that commit, re-fetched from
`raw.githubusercontent.com` at the `<sha7>` commit. **Nested workspace-member
`package.json` (and `pnpm-workspace.yaml`) are fetched preserving the repo's
folder hierarchy** so the manifest model (ADR-0025) gets the full per-workspace
tree, not just the root — a nested package that is itself a workspace root can
carry its own `overrides`.

| Repo handle | Source repo | Branch | Lockfile | Root overrides |
| --- | --- | --- | --- | --- |
| `directus-directus-main-4290f6e` | `https://github.com/directus/directus` | `main` | `pnpm-v9` | `pnpm.overrides`: 22 |
| `vitejs-vite-main-646dbed` | `https://github.com/vitejs/vite` | `main` | `pnpm-v9` | — |
| `vuejs-core-main-86ad076` | `https://github.com/vuejs/core` | `main` | `pnpm-v9` | — |
| `nrwl-nx-master-0939540` | `https://github.com/nrwl/nx` | `master` | `pnpm-v9` | — |
| `supabase-supabase-master-a4334a2` | `https://github.com/supabase/supabase` | `master` | `pnpm-v9` | — |
| `angular-angular-main-45e8fb5` | `https://github.com/angular/angular` | `main` | `pnpm-v9` | `resolutions`: 1 |
| `microsoft-vscode-main-ddd12d5` | `https://github.com/microsoft/vscode` | `main` | `npm` | `overrides`: 5 |
| `microsoft-TypeScript-main-f3d3968` | `https://github.com/microsoft/TypeScript` | `main` | `npm` | `overrides`: 1 |
| `socketio-socket.io-main-190572d` | `https://github.com/socketio/socket.io` | `main` | `npm` | `overrides`: 3 |
| `facebook-create-react-app-main-6254386` | `https://github.com/facebook/create-react-app` | `main` | `npm` | — |
| `lodash-lodash-main-a023532` | `https://github.com/lodash/lodash` | `main` | `npm` | — |
| `oven-sh-bun-main-3a79bd7` | `https://github.com/oven-sh/bun` | `main` | `bun` | `resolutions`: 3 |
| `honojs-hono-main-2cbeadd` | `https://github.com/honojs/hono` | `main` | `bun` | — |

The override declarations feed the ADR-0025 capture path: pnpm `overrides:` and
npm `packages[""].overrides` round-trip through the lock (captured on parse);
yarn-style `resolutions` (angular, bun) live only in `package.json` and surface
via `ParseOptions.manifests` + `overridesOf(graph)` (A2).

See [findings.md](./findings.md) for the per-fixture cross-family probe
catalogue.
