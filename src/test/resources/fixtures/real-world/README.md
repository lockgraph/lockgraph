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

See [findings.md](./findings.md) for the per-fixture cross-family probe
catalogue.
