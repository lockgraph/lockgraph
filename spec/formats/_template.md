# `<id>` — `<human-readable name>`

> Status: stub (template — copy this skeleton for new format specs; stays a stub by design).
> Updated: 2026-06-16
> Provenance: **Official** | **Source-only** | **Reverse-engineered**.

## Compatibility

> **PM versions and lockfile-format versions are independent.** A given format
> is typically *written* by a range of PM versions (default for some, opt-in
> for others) and *read* by an even wider range. Never assume a 1:1 mapping
> between a PM major and a lockfile-format id.

### Writers — PM semvers that *emit* this format

| PM | semver range | Default? | How to opt in |
|----|--------------|:--------:|---------------|
| | | | |

### Readers — PM semvers that *install* from this format

| PM | semver range | Notes |
|----|--------------|-------|
| | | |

## File

- **Filename:** `…`
- **Encoding:** `…` (UTF-8 JSON / YAML / yaml-ish / binary / …)
- **Sibling files:** any companion files the PM expects alongside (e.g.
  `.yarn/install-state.gz`, `.pnp.cjs`, `node_modules/.modules.yaml`).

## Sources

Authoritative references in priority order:

1. … (link to docs / RFC / blog)
2. … (link to producer source code — `parse` and `format` paths)
3. … (prior art: snyk, synp, lockfile-utils, …)

## Schema sketch

A skeletal example of the on-disk shape, annotated. Not exhaustive — fields
go into the cells below.

```yaml
# placeholder
```

## Capabilities

What features can this format encode without loss? Used by the converter to
decide whether a target can express the source graph.

| Feature | Supported | Notes |
|---------|:---------:|-------|
| Workspaces (root + members)               | | |
| Workspace protocol (`workspace:*` etc.)   | | |
| Peer-dep virtualization                   | | |
| `npm:` alias                              | | |
| `git` / `github` protocols                | | |
| `file` / `link` / `portal`                | | |
| `patch:` protocol                         | | |
| Integrity hashes (`sha512` / `sha1`)      | | |
| `dev` / `optional` / `peer` separation    | | |
| Bundled deps                              | | |
| Overrides / resolutions                   | | |
| Optional-peer marker                      | | |

## Conversion inputs

What the converter needs in addition to the lockfile bytes. Wired through
[`ParseOptions` / `StringifyOptions`](../09-api.md). Optional inputs fall
back to documented defaults; required inputs that are absent cause
`parse` / `stringify` to throw.

| Operation   | Option | Required? | Effect when omitted |
|-------------|--------|:---------:|---------------------|
| Parse       | | | |
| Stringify   | | | |

## Quirks

Behaviours that are not obvious from the schema alone — version ranges that
look the same but resolve differently, key-ordering requirements, undocumented
fields, fields that are *load-bearing* despite looking optional.

-

## Degradation rules

When a `Lockfile` contains features that this format cannot encode, how do we
lower it? Options for each unsupported feature:

- **strip** — drop with a diagnostic
- **flatten** — collapse with a documented loss (e.g. peer virtualization → flat)
- **embed** — attach as a side channel (comment, custom field) the producer ignores
- **fail** — refuse and throw `CapabilityError`

Default policy:

| Feature | Action | Diagnostic code |
|---------|--------|------------------|
| | | |

## Fixtures

Canonical inputs against which the parser/formatter is verified.

- **Existing in repo:** `legacy/test/fixtures/<name>/…`
- **To generate:** small projects that exercise specific shapes (workspaces,
  peer deps, aliases, patches, …) via the [test bench](../08-test-bench.md).

## Open questions

> **Open:** seed initial unknowns here as they come up during exploration.
