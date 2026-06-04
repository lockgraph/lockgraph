# `npm-3` — npm `package-lock.json` (lockfileVersion 3)

> Status: stub.
> Provenance: **Official**.

## Compatibility

### Writers — PM semvers that *emit* this format

| PM | semver range | Default? | How to opt in |
|----|--------------|:--------:|---------------|
| npm | `>=9` | ✓ | drops the legacy `dependencies` mirror |
| npm | `>=7 <9` | – | `npm install --lockfile-version=3` (verify minor where added) |

### Readers — PM semvers that *install* from this format

| PM | semver range | Notes |
|----|--------------|-------|
| npm | `>=7` | npm 5 / 6 cannot read; npm 7 / 8 can install but won't auto-emit v3 |

## File

- **Filename:** `package-lock.json`
- **Encoding:** UTF-8 JSON.
- **Sibling files:** none required.

## Sources

- [npm v10 docs — package-lock.json](https://docs.npmjs.com/cli/v10/configuring-npm/package-lock-json)
  — schema reference for v3.
- [`shrinkwrap.js` at npm v9.9.4 (line 13)](https://github.com/npm/cli/blob/v9.9.4/workspaces/arborist/lib/shrinkwrap.js#L13)
  — `const defaultLockfileVersion = 3` — primary evidence that v3 is
  the npm 9+ default.
- [GitHub Changelog — Dependabot supports npm v9](https://github.blog/changelog/2023-03-10-dependency-graph-and-dependabot-support-npm-v9/)
  — confirms v3 drops the legacy `dependencies` block.
- Existing legacy parser: `legacy/main/ts/formats/npm-3.ts`.

## Schema sketch

```json
{
  "name": "<root>",
  "version": "1.0.0",
  "lockfileVersion": 3,
  "requires": true,
  "packages": {
    "":                       { "name": "<root>", "workspaces": ["packages/*"] },
    "node_modules/<name>":    { "version": "1.2.3", "resolved": "...", "integrity": "..." }
  }
}
```

Identical to npm-2 minus the legacy `dependencies` block.

## Capabilities

Same as [npm-2](./npm-2.md) — diff is on-disk size, not expressiveness.

| Feature | Supported | Notes |
|---------|:---------:|-------|
| Legacy v1 `dependencies` mirror | ✗ | dropped — npm 7 / 8 cannot read v3 |

## Conversion inputs

Same as [npm-2](./npm-2.md#conversion-inputs).

## Quirks

- npm 7 and 8 **cannot install** from a v3 lockfile; they ignore the lock and
  re-resolve. The converter must warn when emitting v3 if backward-install is
  important.
- **Integrity is preserved as a multi-hash multiset.** Every algorithm and every
  member of a space-joined SRI (`sha1-… sha512-…`) is kept verbatim — `sha1`,
  `sha256`, `sha384`, `sha512` — not collapsed to sha512-only. The strongest
  tarball digest is used for cross-format comparison.
- Otherwise inherits all npm-2 quirks.

## Degradation rules

Inherits npm-2's rules. Choose npm-2 over npm-3 when the consumer's npm
version is unknown.

## Fixtures

- `legacy/test/fixtures/npm-3/`
- `legacy/test/fixtures/npm-3-mr/`
- `legacy/test/fixtures/npm-3-aliases/`

## Open questions

> **Open:** any v3-specific fields added since npm 10 (e.g. `funding` array
> handling, `hasShrinkwrap`)? Audit against current npm cli.
