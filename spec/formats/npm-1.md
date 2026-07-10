# `npm-1` — npm `package-lock.json` (lockfileVersion 1)

> Status: stable (adapter + flat-family round-trip suite).
> Updated: 2026-06-16
> Provenance: **Official**.

## Compatibility

### Writers — PM semvers that *emit* this format

| PM | semver range | Default? | How to opt in |
|----|--------------|:--------:|---------------|
| npm | `>=5 <7` | ✓ | — (only format these versions know) |
| npm | `>=7 <9` | – | `npm install --lockfile-version=1` |
| npm | `>=9`    | – | writer dropped |

### Readers — PM semvers that *install* from this format

| PM | semver range | Notes |
|----|--------------|-------|
| npm | `>=5` | all npm; `>=7` auto-migrates lockfile to v2 / v3 on next install |

## File

- **Filename:** `package-lock.json` (or `npm-shrinkwrap.json` for shipped libs)
- **Encoding:** UTF-8 JSON, two-space indented, trailing newline.
- **Sibling files:** none required.

## Sources

- [npm v6 docs — package-lock.json](https://docs.npmjs.com/cli/v6/configuring-npm/package-lock-json)
  — schema reference for v1.
- [`lib/install/deps.js` at npm v6.14.18](https://github.com/npm/cli/blob/v6.14.18/lib/install/deps.js)
  — install path that reads / writes lockfileVersion 1 directly
  (pre-Arborist).
- [`shrinkwrap.js` at npm v9.9.4](https://github.com/npm/cli/blob/v9.9.4/workspaces/arborist/lib/shrinkwrap.js#L478-L481)
  — Arborist's read-path branches: `lockfileVersion === 1 ? defaultLockfileVersion : …` (npm 7+ migrates v1 on read).
- Existing legacy parser: `legacy/main/ts/formats/npm-1.ts`.
3. Existing parser: `legacy/main/ts/formats/npm-1.ts`

## Schema sketch

```json
{
  "name": "<root>",
  "version": "1.0.0",
  "lockfileVersion": 1,
  "requires": true,
  "dependencies": {
    "<name>": {
      "version": "1.2.3",
      "resolved": "https://registry.npmjs.org/...",
      "integrity": "sha512-...",
      "dev": true,
      "optional": true,
      "requires": { "<dep>": "^1.0.0" },
      "dependencies": { /* nested in case of conflict */ }
    }
  }
}
```

## Capabilities

| Feature | Supported | Notes |
|---------|:---------:|-------|
| Workspaces (root + members)               | ✗ | conceptually pre-workspaces era |
| Workspace protocol                        | ✗ | |
| Peer-dep virtualization                   | ✗ | flat tree only |
| `npm:` alias                              | ~ | partial; needs `requires` rewriting |
| `git` / `github` protocols                | ~ | resolved URL stored in `version` |
| `file` / `link` / `portal`                | ~ | as `file:` URL |
| `patch:` protocol                         | ✗ | |
| Integrity hashes                          | ✓ | `sha512` (and legacy `sha1`) |
| `dev` / `optional` / `peer` separation    | ~ | per-entry flags, not separate buckets |
| Bundled deps                              | ✓ | `bundled: true` |
| Overrides / resolutions                   | ✗ | |

## Integrity

The model is the shared [`_common.md` §3 integrity model](./_common.md#3-integrity-model);
this is only how npm-1 *carries* it.

- Each dependency entry's `integrity` field is a Subresource-Integrity
  string parsed with `parseSri(…, 'sri')` and emitted with `emitSri`
  (shared `_npm-core.ts`). The hash is of the **tarball** bytes
  (`origin: 'sri'`).
- This is the **legacy** lockfile: modern entries carry `sha512-<base64>`,
  but older v1 locks commonly carry `sha1-<base64>` — both are preserved
  verbatim ([`_common.md` §3.0](./_common.md#30-algorithms-and-digest-encoding)).
- A space-joined multi-algorithm SRI is preserved in full as a multiset
  ([`_common.md` §3.5](./_common.md#35-the-multi-hash-case-and-the-equivalence-rule)).

## Conversion inputs

Mostly self-contained: the lockfile encodes the full hoisted tree.

| Operation | Option | Required? | Effect when omitted |
|-----------|--------|:---------:|---------------------|
| Parse     | —                | none     | lockfile is the complete input |
| Stringify | `manifests['']`  | optional | source of root `name` / `version`; otherwise falls back to the graph's root annotation |

## Quirks

> Model terms used below — *graph*, *node*, *edge*, *peer virtualization*,
> *workspace* — are defined in
> [`_common.md` §4](./_common.md#4-reserved-vocabulary).

- Tree shape is **layout, not graph**: nesting in `dependencies` reflects the
  hoisted `node_modules` shape, not parent-child semantic edges.
- A package can appear multiple times at different paths; entries differ.
- `requires: true` at the root is a marker, not a value.
- `optional: true` is *inherited* down the subtree without being re-emitted —
  detection is non-local.
- **Emitted in `json-stringify-nice` key order** — the same serialiser arborist
  uses for v2/v3 (npm's `swKeyOrder` was designed to match npm 5/6's historical
  order), so a generated v1 lock is byte-identical to what npm 6 writes. See
  [npm-2 Quirks](./npm-2.md#quirks).

## Degradation rules

| Feature | Action |
|---------|--------|
| Workspaces | **fail** — emitting npm-1 from a workspace graph is unsafe |
| Peer virtualization | **flatten** — keep one instance, warn |
| Patches | **strip** with diagnostic |

## Fixtures

- `legacy/test/fixtures/npm-1/`
- `legacy/test/fixtures/npm-1-recursive/`

## Open questions

> **Open:** how do we round-trip `git+ssh://` URLs whose hash isn't in the
> npm registry — store the git ref or the resolved tarball URL?
