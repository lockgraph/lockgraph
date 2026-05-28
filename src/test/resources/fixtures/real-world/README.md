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
| `qiwi-pijma` | `https://github.com/qiwi/pijma` | `18d531c4e41ea1b30c7b2f998d434f9531c8e030` | `yarn.lock` | `yarn-berry-v8` |
| `antongolub-misc` | `https://github.com/antongolub/misc` | `ee9a6d9ef4dd35fcb79daa217ed6680d0d5a1015` | `yarn.lock` | `yarn-berry-v8` |
| `qiwi-masker` | `https://github.com/qiwi/masker` | `1b3cf47948381e82cb775eb450cf7064b82c5d3d` | `yarn.lock` | `yarn-berry-v8` |
| `qiwi-mware` | `https://github.com/qiwi/mware` | `ed822d4d23737268917097a07e46b9ac559bed43` | `yarn.lock` | `yarn-berry-v6` |
| `qiwi-uniconfig` | `https://github.com/qiwi/uniconfig` | `c5e7d5a33e9c1b773eb235ab943c9f77e7a459ec` | `yarn.lock` | `yarn-berry-v7` |
| `qiwi-nestjs-enterprise` | `https://github.com/qiwi/nestjs-enterprise` | `1a002336c7847ac3d981769ff6fcc367b55d4532` | `yarn.lock` | `yarn-berry-v7` |

Fixtures with `__metadata.version: 7` were emitted by Yarn 4 during a brief
intermediate lockfile-format window between v6 and v8. The `yarn-berry-v7`
adapter (added per `implementer/yarn-berry-v7-adapter` dispatch) maps the
transitional shape onto the shared `_yarn-berry-core` family pipeline
(quoted-protocol ranges like v8/v9 + raw-hex checksum like v4/v5/v6 +
`conditions:` blocks per the v5+ inheritance).

### Sister-session canary import — Yarn 4 large monorepos

Fetch date: `2026-05-28`. Sourced via the `yarn-audit-fix` sister-session's
real-world canary against `@antongolub/lockfile@0.0.0-snapshot.45`. Each
lockfile is the latest `main`-branch tip from its upstream repo at the
import date; no specific commit SHA pinning (re-snapshot for stability if
the canary suite needs determinism).

| Repo handle | Source repo | Stars | File | Detected format | snapshot.45 outcome |
| --- | --- | ---: | --- | --- | --- |
| `storybookjs-storybook` | `https://github.com/storybookjs/storybook` | 90k | `yarn.lock` | `yarn-berry-v8` | ✅ 3073 nodes, parse + round-trip + patch clean |
| `parcel-bundler-parcel` | `https://github.com/parcel-bundler/parcel` | 44k | `yarn.lock` | `yarn-berry-v8` | ✅ 2216 nodes |
| `redwoodjs-redwood` | `https://github.com/redwoodjs/redwood` | 17k | `yarn.lock` | `yarn-berry-v8` | ✅ 2840 nodes |
| `backstage-backstage` | `https://github.com/backstage/backstage` | 33k | `yarn.lock` | `yarn-berry-v8` | ❌ Bug #2 — `link:` NodeId collision on multi-workspace links |
| `babel-babel` | `https://github.com/babel/babel` | 44k | `yarn.lock` | `yarn-berry-v9` | ❌ Bug #2 — `link:` NodeId collision (`$repo-utils`) |
| `facebook-jest` | `https://github.com/facebook/jest` | 45k | `yarn.lock` | `yarn-berry-v9` | ❌ Bug #3 — duplicate edge on aliased dep (`metro-source-map` → `@babel/traverse--for-generate-function-map`) |
| `prettier-prettier` | `https://github.com/prettier/prettier` | 52k | `yarn.lock` | `yarn-berry-v10` | ❌ Bug #1 — `__metadata.version: 10` adapter missing (yarn 5 dev-branch) |
| `yarnpkg-berry` | `https://github.com/yarnpkg/berry` | 8k | `yarn.lock` | `yarn-berry-v10` | ❌ Bug #1 — `__metadata.version: 10` adapter missing |

Bug fixes for #1 / #2 / #3 are in flight on
`implementer/edge-descriptor-identity` and
`implementer/yarn-berry-link-and-v10`; these fixtures pin the regression
surface for snapshot.46.

See [findings.md](./findings.md) for the per-fixture cross-family probe
catalogue.
