# `pnpm-v5` — pnpm `pnpm-lock.yaml` (lockfileVersion 5.x)

> Status: stub.
> Provenance: **Source-only**.

## Compatibility

### Writers — PM semvers that *emit* this format

| PM | semver range | Default? | How to opt in |
|----|--------------|:--------:|---------------|
| pnpm | `>=3 <8` | ✓ | minor bumps `5.0` … `5.4` inside this window; pnpm 7 still defaults to `5.4` (verified empirically — pm-pnpm-7 produces `lockfileVersion: 5.4`) |

### Readers — PM semvers that *install* from this format

| PM | semver range | Notes |
|----|--------------|-------|
| pnpm | `>=3` | newer pnpm auto-migrates on install |

## File

- **Filename:** `pnpm-lock.yaml`
- **Encoding:** UTF-8 YAML.
- **Sibling files:**
  - `node_modules/.modules.yaml` — install state
  - `node_modules/.pnpm/` — content-addressable instance directories
  - `.pnpmfile.cjs` — optional resolve hooks

## Sources

- [`pnpm/spec/lockfile/5.md`](https://github.com/pnpm/spec/blob/master/lockfile/5.md)
  — official schema spec for the 5.x family.
- [`pnpm/spec/lockfile/5.2.md`](https://github.com/pnpm/spec/blob/master/lockfile/5.2.md)
  — minor-version spec capturing the 5.0 → 5.2 deltas.
- [`pnpm/pnpm` types](https://github.com/pnpm/pnpm/blob/main/lockfile/types/src/index.ts)
  — TypeScript surface of the lockfile object (current main).
- [`pnpm/pnpm` lockfile package](https://github.com/pnpm/pnpm/tree/main/lockfile)
  — types / file / utils / migration code.

## Schema sketch

```yaml
lockfileVersion: 5.4

importers:
  .:
    specifiers:
      foo: ^1.0.0
    dependencies:
      foo: 1.0.3
  packages/app:
    specifiers: {...}
    dependencies: {...}

packages:
  /foo/1.0.3:
    resolution: { integrity: sha512-... }
    dependencies:
      bar: 2.0.0
  /react/18.0.0_some-peer-hash:
    resolution: { integrity: ... }
    peerDependencies:
      react: '*'
```

## Capabilities

| Feature | Supported | Notes |
|---------|:---------:|-------|
| Workspaces                                | ✓ | one `importers` entry per workspace |
| Workspace protocol                        | ✓ | `link:` resolution |
| Peer-dep virtualization                   | ✓ | encoded as `_peer-hash` suffix in package id |
| `npm:` alias                              | ✓ | |
| `git` / `github` protocols                | ✓ | |
| `file` / `link` / `portal`                | ✓ | first-class |
| `patch:` protocol                         | ✓ | via `pnpm.patchedDependencies` in package.json + lock entry |
| Integrity hashes                          | ✓ | `resolution.integrity` |
| `dev` / `optional` / `peer` separation    | ✓ | per-importer keyed buckets + `dev: true` flag |
| Bundled deps                              | ~ | rare; respected if present |
| Overrides / resolutions                   | ✓ | `pnpm.overrides` baked in |

## Conversion inputs

| Operation | Option       | Required? | Effect when omitted |
|-----------|--------------|:---------:|---------------------|
| Parse     | —            | none      | `importers` block enumerates workspaces by path |
| Stringify | `manifests`  | optional  | enriches per-package metadata; pnpm consumers may rely on `engines` for skip decisions |

## Quirks

- Package id grammar: `/<name>/<version>` for plain, `/<name>/<version>_<peerHash>`
  for peer-virtualised, `/<name>/<version>_<peerHash><sub>` for chained.
  This is **the** reference for "how pnpm encodes peerContext" — see
  [02-graph.md](../02-graph.md#node-identity).
- `specifiers` block in each importer mirrors the manifest's range section —
  used for upgrade detection.
- `lockfileVersion` is a **string**, not a number (`'5.4'`).
- Top-level `time` block (optional) records first-seen timestamps.

## Degradation rules

| Feature | Action |
|---------|--------|
| Patches → npm-* / yarn-classic | **strip** |
| Peer virtualization → npm-* / yarn-classic | **flatten** |

## Fixtures

> **TBD:** no pnpm fixtures in `legacy/`. To be generated via test bench.

## Open questions

> **Open:** exact 5.0 → 5.4 differences. Some are tolerated by all 5.x
> readers, others not. Need a compat matrix.
