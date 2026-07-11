# `npm-3` — npm `package-lock.json` (lockfileVersion 3)

> Status: stable (adapter + flat-family round-trip suite).
> Updated: 2026-06-16
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

> **npm 12 (2026-07):** stays on the `>=9` default and emits v3 **byte-identical
> to npm 9–11** (empirically confirmed — see Open questions). npm 12 raises its
> own Node floor to `^22.22.2 || ^24.15.0 || >=26.0.0` (Node ≤ 21 dropped); this
> gates *running* npm 12 (fixture generation) — the `pm-npm-12` infra check is
> Node-range-skipped — not the lock format. The npm 12 breaking changes
> (install-scripts opt-in, `--allow-git` / `--allow-remote` default `none`,
> `npm-shrinkwrap.json` removed) are runtime / `package.json` policy and do not
> touch `package-lock.json` content, so a v3 lock re-emitted unchanged still
> installs frozen-clean under npm 12.

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

## Integrity

Identical to [npm-2](./npm-2.md#integrity): each `packages` entry's
`integrity` is an SRI (`origin: 'sri'`, normally `sha512`, legacy `sha1`
accepted), parsed/emitted via the shared `_npm-core.ts`
(`parseSri` / `emitSri`) under the
[`_common.md` §3 model](./_common.md#3-integrity-model). v3 drops the legacy
`dependencies` mirror, so each package's integrity appears **once**, in
`packages`.

## Conversion inputs

Same as [npm-2](./npm-2.md#conversion-inputs).

## Quirks

- npm 7 and 8 **cannot install** from a v3 lockfile; they ignore the lock and
  re-resolve. The converter must warn when emitting v3 if backward-install is
  important.
- **Integrity is preserved as a multi-hash multiset.** Every algorithm and every
  member of a space-joined SRI (`sha1-… sha512-…`) is kept verbatim — `sha1`,
  `sha256`, `sha384`, `sha512` — not collapsed to sha512-only. The strongest
  tarball digest is used for cross-format comparison. This is the shared model
  defined in [`_common.md` §3](./_common.md#3-integrity-model); npm-3 emits
  every member of the multiset into the `integrity` SRI field.
- **A `resolved` URL may carry a legacy `#<sha1>` fragment in place of a separate
  `integrity` line.** When a yarn-classic source stored a registry dep's checksum
  as the `#<40-hex-sha1>` fragment of its `resolved` URL (no `integrity:` line),
  the converter re-emits `resolved` with that fragment and **no** `integrity`
  field — the sha1 rides the resolution sidecar
  ([`_common.md` §3](./_common.md#3-integrity-model)), it is not promoted into the
  integrity multiset. npm 7–12 accept this: the fragment sha1 *is* the integrity
  check. Verified with both `npm ci` and `npm install` — each leaves the lock
  byte-unchanged (no fragment→`integrity` rewrite). This is the legacy npm-5/6
  form, not a defect.
- Otherwise inherits all npm-2 quirks.

## Degradation rules

Inherits npm-2's rules. Choose npm-2 over npm-3 when the consumer's npm
version is unknown.

## Fixtures

- `legacy/test/fixtures/npm-3/`
- `legacy/test/fixtures/npm-3-mr/`
- `legacy/test/fixtures/npm-3-aliases/`

## Open questions

> **Resolved (audited against npm 12.0.1, 2026-07):** **npm 10 introduced the
> per-entry `license` field** — the last descriptor addition, and the *only* field
> diff across the v3 era. npm 10, 11, 12 share the field set `version, resolved,
> integrity, link, dev, optional, devOptional, inBundle, hasInstallScript,
> hasShrinkwrap, bin, license, engines, funding, os, cpu, libc, dependencies,
> optionalDependencies, peerDependencies, peerDependenciesMeta`, and npm 11 emits
> `lockfileVersion: 3` **byte-identical to npm 12** (full-lock diff). **npm 9
> predates `license`**, so the canonical `npm-3` fixture writer (`pm-npm-9`) omits
> it — but the lib captures and re-emits `license` verbatim, so an npm 10–12 lock
> round-trips byte-identical. `pm-npm-12` was added to the PM matrix to keep this
> pinned.
