# `pnpm-v9` — pnpm `pnpm-lock.yaml` (lockfileVersion 9)

> Status: stub.
> Provenance: **Source-only**.

## Compatibility

### Writers — PM semvers that *emit* this format

| PM | semver range | Default? | How to opt in |
|----|--------------|:--------:|---------------|
| pnpm | `>=9`  | ✓ | pnpm 9 jumped lockfileVersion from 6.x to 9.0; both 9.x and 10.x default to `'9.0'` |

### Readers — PM semvers that *install* from this format

| PM | semver range | Notes |
|----|--------------|-------|
| pnpm | `>=9`  | a writer must be its own reader; both pnpm 9.x and 10.x read and write `'9.0'` |

## File

Same as [pnpm-v5](./pnpm-v5.md#file).

## Sources

- [`pnpm/spec/lockfile/9.0.md`](https://github.com/pnpm/spec/blob/master/lockfile/9.0.md)
  — official schema spec for 9.0; primary evidence for the
  `packages` / `snapshots` split.
- [pnpm Discussion #6857](https://github.com/orgs/pnpm/discussions/6857)
  — maintainer rationale for jumping `6.x → 9.0` (skipping 7 and 8):
  *"in the future lockfile version will equal the pnpm version in
  which it got introduced."*
- See also [pnpm-v5 sources](./pnpm-v5.md#sources) for shared
  references.

## Schema sketch

```yaml
lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:
  .:
    dependencies:
      foo:
        specifier: ^1.0.0
        version: 1.0.3

packages:
  foo@1.0.3:
    resolution: { integrity: sha512-... }
    engines: { node: '>=14' }

snapshots:
  foo@1.0.3:
    dependencies:
      bar: 2.0.0
```

## Capabilities

Same as [pnpm-v6](./pnpm-v6.md#capabilities). The expressiveness ceiling is
unchanged from the 6.x family; the v9 jump is structural, not capability-led.

## Conversion inputs

Same as [pnpm-v6](./pnpm-v6.md#conversion-inputs).

## Quirks

Compared to v6:

- Two top-level blocks instead of one — `packages` (immutable manifest
  data: resolution, integrity, engines) and `snapshots` (resolution-time
  data: dependency edges, peer bindings). One package can have many
  snapshots when peer-virtualisation creates instances.
- The leading slash in package ids was dropped (`foo@1.0.3` instead of
  `/foo@1.0.3`).
- pnpm jumped lockfileVersion `6.x` → `9.0` directly. **There is no
  v7 or v8 schema in the wild.** Both pnpm 9.x and pnpm 10.x default to
  `'9.0'`; what differs between them is engine behaviour, not the
  written lockfile schema.
- The `packages` / `snapshots` split mirrors our internal model
  (package metadata vs peer-bound instance) — see
  [02-graph.md](../02-graph.md#node-identity).

## Degradation rules

Same as [pnpm-v6](./pnpm-v6.md#degradation-rules).

## Fixtures

> **TBD:** generate.

## Open questions

> **Open:** capture exact pnpm 10 behavioural shifts (peer auto-install
> defaults, store v6 introduction, etc.) that may affect what the lockfile
> encodes.
