# `pnpm-v6` — pnpm `pnpm-lock.yaml` (lockfileVersion 6.x)

> Status: stub.
> Provenance: **Source-only**.

## Compatibility

### Writers — PM semvers that *emit* this format

| PM | semver range | Default? | How to opt in |
|----|--------------|:--------:|---------------|
| pnpm | `>=7 <9` | ✓ | bumps `6.0`, `6.1` inside this window |

### Readers — PM semvers that *install* from this format

| PM | semver range | Notes |
|----|--------------|-------|
| pnpm | `>=7` | older pnpm cannot read the new `name@ver` package-id grammar |

## File

Same as [pnpm-v5](./pnpm-v5.md#file).

## Sources

- [`pnpm/spec/lockfile/6.0.md`](https://github.com/pnpm/spec/blob/master/lockfile/6.0.md)
  — official schema spec for 6.0; primary evidence for the package-id
  grammar shift (`/foo@1.0.0` instead of `/foo/1.0.0`).
- See also [pnpm-v5 sources](./pnpm-v5.md#sources) for shared
  references (types, lockfile package, migration converters).

## Schema sketch

```yaml
lockfileVersion: '6.0'

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
  /foo@1.0.3:                     # NOTE: '@' separator, not '/'
    resolution: { integrity: ... }
```

## Capabilities

Same matrix as [pnpm-v5](./pnpm-v5.md#capabilities). Schema cleanup, not
expressiveness change.

## Conversion inputs

Same as [pnpm-v5](./pnpm-v5.md#conversion-inputs).

## Quirks

Compared to v5:

- Package ids switch from `/<name>/<ver>` to `/<name>@<ver>` (and
  `/<name>@<ver>(peer@x)` for virtualised). Easier to read; trivial to migrate.
- `importers.<path>.dependencies.<name>` is now an object `{specifier, version}`
  instead of a plain version string.
- New top-level `settings` block reflecting `pnpm` config that affects resolution.
- `time` block deprecated.

## Degradation rules

Same as [pnpm-v5](./pnpm-v5.md#degradation-rules).

## Fixtures

> **TBD:** generate.

## Open questions

> **Open:** is `settings.autoInstallPeers` resolution-affecting (it changes
> what gets installed)? If yes, parsing without it loses information.
