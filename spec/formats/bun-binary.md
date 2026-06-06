# `bun-binary` — bun `bun.lockb`

> Status: deferred.
> Provenance: Reverse-engineered (anatomy only, for detection).

> **Permanent non-goal** — read body. `deferred` here means
> *acknowledged-and-not-pursued*, with no expectation of revisit.
> A dedicated `non-goal` status value would be more truthful, but the
> spec status vocabulary admits only `stub` / `draft` / `stable` /
> `deferred` today, so the bare `deferred` value is used and its
> permanence is stated in prose here.

`@antongolub/lockfile` does **not** parse `bun.lockb` and never will.
The format is undocumented, version-fragile, and obsoleted by bun's
own move to text format in 1.2. The library's path for any bun
input is [bun-text](./bun-text.md); the `bun-binary` adapter exists
only as a **detection-and-diagnostic** stub: when a `bun.lockb` is
passed to `parse()`, we identify it by magic bytes and emit a clear
error directing the user to migrate first.

The binary anatomy — a 54-byte header carrying the shebang + version
string, a `FormatVersion` enum, and tagged sections after the header —
is understood well enough for detection (see the byte-offset evidence
under [Detection](#detection), which cites bun's own source). We do not
extend that understanding to a parser.

## Compatibility

### Writers — PM semvers that *emit* this format

| PM | semver range | Default? | How to opt in |
|----|--------------|:--------:|---------------|
| bun | `<1.2`  | ✓ | original lockfile format |
| bun | `>=1.2` | – | `bun install --save-binary-lockfile` (verify exact flag name) |

### Readers — PM semvers that *install* from this format

bun's own binary reader behaviour is bun's concern, not the
library's. We do not install from `bun.lockb` at any tier — the
detection-and-throw path is the entire contract.

## File

- **Filename:** `bun.lockb`
- **Encoding:** custom binary, version-tagged.
- **Sibling files:** none required.

## Sources

- [`src/install/lockfile.zig` on main](https://github.com/oven-sh/bun/blob/main/src/install/lockfile.zig)
  — `format: FormatVersion = FormatVersion.current;` defines the
  binary writer pin.
- [Bun blog — text-based lockfile](https://bun.com/blog/bun-lock-text-lockfile)
  — historical context: `bun.lockb` was the only format until 1.1.39.
- [`src/cli/package_manager_command.zig` (bun-v1.2.5)](https://github.com/oven-sh/bun/blob/bun-v1.2.5/src/cli/package_manager_command.zig)
  — confirms there is no `bun pm cat` subcommand; the only
  `lockb → text` migration path is
  `bun install --save-text-lockfile --frozen-lockfile --lockfile-only`,
  which has install side-effects and writes a *new* text lockfile to
  disk, not a parseable dump. That is the full verdict: no read-only
  binary-to-text dump exists, so migration is the sole path.

## Detection

Magic-byte sniff at byte 0 — the file begins with the literal
shebang `#!/usr/bin/env bun\n` followed by the version string
`bun-lockfile-format-v0\n`. The format-version u32 lives at byte 42
([`bun.lockb.zig`](https://github.com/oven-sh/bun/blob/main/src/install/lockfile/bun.lockb.zig#L14-L29)).
Detection only needs the first 42 bytes; we do not unpack further.

## Capabilities

Not applicable — no parser, no writer, no conversion target.

## Conversion inputs

None. Users with a legacy `bun.lockb` must migrate first using
bun's own tooling:

```
bun install --save-text-lockfile --frozen-lockfile --lockfile-only
rm bun.lockb
```

This produces `bun.lock` (text), which the [bun-text](./bun-text.md)
adapter handles. The migration is bun-side; the library does not
shell out.

## Diagnostic

When `parse()` detects `bun.lockb` magic, it throws `LockfileError`
with a `BUN_BINARY_NOT_SUPPORTED` code (or, as an interim, the
existing `CAPABILITY_LACK` code with a format-specific message),
including the migration command above as a hint. No partial parse
is attempted.

## Fixtures

None planned. A single byte-prefix sample (the first 54 bytes of any
`bun.lockb`) suffices for the detection test; we do not need
end-to-end binary fixtures.

## Open questions

> **Open:** dedicated `BUN_BINARY_NOT_SUPPORTED` error code vs.
> reusing `CAPABILITY_LACK`. The diagnostic message carries the
> actual useful content (migration command); the code matters only
> for programmatic dispatch. Revisit when the detector lands.
