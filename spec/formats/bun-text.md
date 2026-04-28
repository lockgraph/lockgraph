# `bun-text` — bun `bun.lock`

> Status: stub.
> Provenance: Official (since Bun 1.2).

**Primary bun target** — audit-friendly, human-readable; all bun-related
work in v1 starts and stays here.

## Compatibility

### Writers — PM semvers that *emit* this format

| PM | semver range | Default? | How to opt in |
|----|--------------|:--------:|---------------|
| bun | `>=1.2`     | ✓ | text default since 1.2 |
| bun | `>=1.1 <1.2` | – | `bun install --save-text-lockfile` (verify exact minor of intro) |

### Readers — PM semvers that *install* from this format

| PM | semver range | Notes |
|----|--------------|-------|
| bun | `>=1.1`     | text reader landed alongside the writer flag |

## File

- **Filename:** `bun.lock`
- **Encoding:** UTF-8, JSONC-flavoured (allows trailing commas + comments).
  Indented two spaces.
- **Sibling files:** none required.

## Sources

- [Bun docs — Lockfile](https://bun.com/docs/pm/lockfile)
  — current schema reference for `bun.lock`.
- [Bun blog — Bun's new text-based lockfile](https://bun.com/blog/bun-lock-text-lockfile)
  — narrative for the introduction: text format added in Bun 1.1.39
  via `--save-text-lockfile`, became default in 1.2.
- [`src/install/lockfile.zig` on main](https://github.com/oven-sh/bun/blob/main/src/install/lockfile.zig)
  — `text_lockfile_version: TextLockfile.Version = TextLockfile.Version.current;` defines the writer pin.

## Schema sketch

```jsonc
{
  "lockfileVersion": 1,
  "workspaces": {
    "": { "name": "<root>", "dependencies": {...} },
    "packages/app": { "name": "@scope/app", "dependencies": {...} }
  },
  "packages": {
    "foo": ["foo@1.0.3", "<integrity>", { /* deps */ }, "<extra>"],
    "react": ["react@18.0.0", "...", { ... }, "..."]
  },
  "trustedDependencies": ["..."],
  "patchedDependencies": {"foo@1.0.3": "patches/foo.patch"}
}
```

Each `packages[name]` entry is a positional array — bun-specific encoding.

## Capabilities

| Feature | Supported | Notes |
|---------|:---------:|-------|
| Workspaces                                | ✓ | top-level `workspaces` map keyed by path |
| Workspace protocol (`workspace:*`)        | ✓ | first-class |
| Peer-dep virtualization                   | ~ | bun resolves peers but virtualization detail TBD |
| `npm:` alias                              | ✓ | |
| `git` / `github` protocols                | ✓ | |
| `file` / `link` / `portal`                | ~ | `file:`, `link:` supported; `portal:` is yarn-only |
| `patch:` protocol                         | ✓ | top-level `patchedDependencies` |
| Integrity hashes                          | ✓ | sha-family in positional slot 2 |
| `dev` / `optional` / `peer` separation    | ✓ | manifest mirror in `workspaces` |
| Bundled deps                              | ✗ | |
| Overrides / resolutions                   | ✓ | `overrides` block |

## Conversion inputs

| Operation | Option       | Required?      | Effect when omitted |
|-----------|--------------|:--------------:|---------------------|
| Parse     | —            | none           | top-level `workspaces` block enumerates members |
| Stringify | `manifests`  | optional (TBD) | bun's positional `extras` slot may need manifest-derived data — verify against samples |

## Quirks

- Positional array encoding for `packages` entries — slots are
  `[id, integrity, deps, extras]`. Trailing slots may be omitted.
- `lockfileVersion: 1` for bun-text refers to bun's own text-format version,
  unrelated to npm's `lockfileVersion: 1`.
- JSONC parser must tolerate trailing commas and line comments.
- The empty-string workspace key (`""`) is the root project.
- `trustedDependencies` controls postinstall execution — load-bearing for
  reproduces, even though it's not strictly resolution data.

## Degradation rules

| Feature | Action |
|---------|--------|
| `trustedDependencies` → npm-*, yarn-*, pnpm-* | **strip** with diagnostic |
| Positional encoding | not user-visible — internal only |

## Fixtures

> **TBD:** no bun fixtures in `legacy/`. Generate.

## Open questions

> **Open:** how does bun express peer virtualization in `bun.lock`? The text
> format is younger than the binary one — needs probing with peer-heavy fixtures.
