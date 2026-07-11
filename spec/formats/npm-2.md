# `npm-2` — npm `package-lock.json` (lockfileVersion 2)

> Status: stable (adapter + flat-family round-trip suite; dual-mode drift covered).
> Updated: 2026-06-16
> Provenance: **Official**.

## Compatibility

### Writers — PM semvers that *emit* this format

| PM | semver range | Default? | How to opt in |
|----|--------------|:--------:|---------------|
| npm | `>=7 <9` | ✓ | introduced workspaces, `packages` field |
| npm | `>=9`    | – | `npm install --lockfile-version=2` |

### Readers — PM semvers that *install* from this format

| PM | semver range | Notes |
|----|--------------|-------|
| npm | `>=7` | npm 5 / 6 cannot read `lockfileVersion: 2` |

> Verified through **npm 12**: npm 7–12 read v2; npm 9–12 still emit it under
> `--lockfile-version=2` (their default output is v3).

## File

- **Filename:** `package-lock.json`
- **Encoding:** UTF-8 JSON.
- **Sibling files:** none required.

## Sources

- [npm v8 docs — package-lock.json](https://docs.npmjs.com/cli/v8/configuring-npm/package-lock-json)
  — schema reference for v2.
- [npm v7 series blog — beta release & semver-major changes](https://blog.npmjs.org/post/626173315965468672/npm-v7-series-beta-release-and-semver-major.html)
  — narrative for the v2 introduction (`packages` block, workspaces).
- [`shrinkwrap.js` at npm v8.19.4](https://github.com/npm/cli/blob/v8.19.4/workspaces/arborist/lib/shrinkwrap.js)
  — Arborist's writer for v2 (carries the legacy v1 mirror unless `lockfileVersion=3`).

## Schema sketch

```json
{
  "name": "<root>",
  "version": "1.0.0",
  "lockfileVersion": 2,
  "requires": true,
  "packages": {
    "":                       { "name": "<root>", "workspaces": ["packages/*"] },
    "node_modules/<name>":    { "version": "1.2.3", "resolved": "...", "integrity": "...", "engines": {...} },
    "packages/<workspace>":   { "name": "@scope/ws", "version": "1.0.0" }
  },
  "dependencies": { /* legacy mirror of v1 shape, kept for back-compat */ }
}
```

## Capabilities

| Feature | Supported | Notes |
|---------|:---------:|-------|
| Workspaces (root + members)               | ✓ | keys are paths |
| Workspace protocol                        | ~ | as `*` resolution + `link: true` |
| Peer-dep virtualization                   | ✗ | still flat |
| `npm:` alias                              | ✓ | `name@npm:<other>@…` shape |
| `git` / `github` protocols                | ✓ | `resolved` carries git URL |
| `file` / `link` / `portal`                | ~ | `link: true` for symlink |
| `patch:` protocol                         | ✗ | |
| Integrity hashes                          | ✓ | sha512 |
| `dev` / `optional` / `peer` separation    | ✓ | per-entry flags + `peerDependencies` block |
| Bundled deps                              | ✓ | `inBundle: true` |
| Overrides / resolutions                   | ~ | overrides applied at resolve time, not annotated |

## Integrity

The model is the shared [`_common.md` §3 integrity model](./_common.md#3-integrity-model);
this is only how npm-2 *carries* it.

- Each `packages` entry's `integrity` field is a Subresource-Integrity
  string parsed with `parseSri(…, 'sri')` and emitted with `emitSri`
  (shared `_npm-core.ts`). The hash is of the **tarball** bytes
  (`origin: 'sri'`), normally `sha512-<base64>`; legacy `sha1` entries are
  accepted and preserved verbatim.
- A space-joined multi-algorithm SRI is preserved in full as a multiset
  ([`_common.md` §3.5](./_common.md#35-the-multi-hash-case-and-the-equivalence-rule)).

## Conversion inputs

| Operation | Option       | Required? | Effect when omitted |
|-----------|--------------|:---------:|---------------------|
| Parse     | —            | none      | `packages` block names workspaces by path; lockfile is complete |
| Stringify | `manifests`  | optional  | populates per-entry `engines`, `funding`, `license`, `bin`. Without them the lockfile is emit-valid but npm 7+ may not skip incompatible installs |

## Quirks

> Model terms used below — *graph*, *layout*, *peer virtualization*,
> *workspace* — are defined in
> [`_common.md` §4](./_common.md#4-reserved-vocabulary).

- Two parallel sections: `packages` (path-keyed, layout) and `dependencies`
  (legacy v1 shape). They must stay consistent or older tooling breaks. We
  parse `packages`; we may emit both.
- The empty-string key `""` is the *root project itself*, not a workspace.
- `engines`, `funding`, `license` are present per entry — they're load-bearing
  for npm to skip optional/incompatible installs.
- Workspaces appear under their on-disk path (`packages/foo`) **and** as
  symlinks at `node_modules/<name>` with `link: true, resolved: "packages/foo"`.
- **Serialization key order is `json-stringify-nice`, not `JSON.stringify`.** npm
  (via arborist's `lib/shrinkwrap.js`) orders every object's keys so scalar/array
  values precede nested objects, with a fixed
  `name, version, lockfileVersion, resolved, integrity, requires, packages,
  dependencies` prefix and the remainder alphabetical by `localeCompare('en')` —
  the `packages`/`dependencies` MAP keys included. The emitter reproduces this
  exactly, so a generated lock is byte-identical to npm's own and a MUTABLE
  `npm install` (not only the order-insensitive `npm ci`) leaves it unrewritten.
- `peerDependenciesMeta` (optional-peer markers) and `hasInstallScript` are
  preserved verbatim per entry — manifest-derived metadata npm re-adds on install
  if absent, which would otherwise force a rewrite.

## Degradation rules

| Feature | Action |
|---------|--------|
| Peer virtualization | **flatten** with warning |
| Patches | **strip** |

## Fixtures

See the test-bench fixtures under [`src/test/resources/fixtures/`](../../src/test/resources/fixtures) — `lockfiles/<case>/<format>.lock` for canonical per-case locks (`npm run build:fixtures`), `real-world/` for whole-project samples.

## Open questions

> **Open:** is `engines`/`funding`/`license` data we can reasonably *not*
> store, or is it required for emitting valid npm-2 lockfiles? Likely the
> latter — nominate `meta` as an opt-in `parse({manifests})` source.
