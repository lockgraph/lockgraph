# `yarn-berry-v4` — yarn berry `yarn.lock` (`__metadata.version: 4`)

> Status: stub.
> Provenance: **Source-only**.

## Compatibility

### Writers — PM semvers that *emit* this format

| PM | semver range | Default? | How to opt in |
|----|--------------|:--------:|---------------|
| yarn | `>=2.0.0-rc.20 <3.1` | ✓ | first stable berry schema; verified at multiple tags incl. 2.4.3 and 3.0.x |

### Readers — PM semvers that *install* from this format

| PM | semver range | Notes |
|----|--------------|-------|
| yarn | `>=2` | berry auto-migrates a v4 lockfile to its own current version on install |

## File

- **Filename:** `yarn.lock`
- **Encoding:** UTF-8 YAML (true YAML, unlike classic).
- **Sibling files:**
  - `.yarnrc.yml` — for nodeLinker, npmRegistries, plugins
  - `.yarn/cache/` — content-addressable archives
  - `.pnp.cjs` (PnP) or `node_modules/` (when `nodeLinker: node-modules`)

## Sources

- [`Project.ts` at yarn 2.4.3](https://github.com/yarnpkg/berry/blob/@yarnpkg/cli/2.4.3/packages/yarnpkg-core/sources/Project.ts)
  — `const LOCKFILE_VERSION = 4;` is the writer pin that produces v4.
- [`Project.ts` at yarn 3.0.0](https://github.com/yarnpkg/berry/blob/@yarnpkg/cli/3.0.0/packages/yarnpkg-core/sources/Project.ts)
  — same constant; v4 was still the default until 3.1.0.
- [`Project.ts` at yarn 3.0.2](https://github.com/yarnpkg/berry/blob/@yarnpkg/cli/3.0.2/packages/yarnpkg-core/sources/Project.ts)
  — last stable tag with `LOCKFILE_VERSION = 4`.
- [SYML parser](https://github.com/yarnpkg/berry/blob/master/packages/yarnpkg-parsers/sources/syml.ts)
  — yarn's yaml-flavoured parser used for `yarn.lock`.
- [`collab/research/lockfile-schema-history-yarn.md`](../../collab/research/lockfile-schema-history-yarn.md)
  — empirical walk across release tags.
- Existing parser: `legacy/main/ts/formats/yarn-berry.ts`.

## Schema sketch

```yaml
__metadata:
  version: 4
  cacheKey: ...

"foo@npm:^1.0.0":
  version: 1.0.3
  resolution: "foo@npm:1.0.3"
  checksum: ...
  languageName: node
  linkType: hard
```

## Capabilities

| Feature | Supported | Notes |
|---------|:---------:|-------|
| Workspaces                                | ✓ | resolution `name@workspace:path` |
| Workspace protocol                        | ✓ | `workspace:^`, `workspace:~`, `workspace:*` |
| Peer-dep virtualization                   | ✓ | `virtual:<hash>#npm:foo@1` resolution |
| `npm:` alias                              | ✓ | first-class |
| `git` / `github` protocols                | ✓ | own resolution scheme |
| `file` / `link` / `portal`                | ✓ | first-class |
| `patch:` protocol                         | ✓ | first-class; wraps another resolution |
| Integrity hashes                          | ✓ | `checksum` (custom format incl. cacheKey prefix) |
| `dev` / `optional` / `peer` separation    | ~ | derivable from manifest, not in lockfile |
| Bundled deps                              | ✗ | |
| Overrides / resolutions                   | ~ | applied at resolve time |

## Conversion inputs

Self-contained. Workspaces are named via `name@workspace:path` resolutions
inside the lockfile.

| Operation | Option | Required? | Effect when omitted |
|-----------|--------|:---------:|---------------------|
| Parse     | —      | none      | |
| Stringify | —      | none      | |

### Patch slot

For every node whose resolution is a `patch:` locator the adapter
populates `Node.patch` per
[ADR-0011](../decisions/0011-tarball-key-disambiguation.md).
The adapter computes the fingerprint itself; yarn's `hash=` parameter
is **never** the canonical value — it is recorded as PM-native
attribution per
[ADR-0013 (accepted)](../decisions/0013-multi-pm-scalability-invariant.md)
and surfaced through the format-layer carrier, not on `Node`.

| Locator shape | Canonical input | Hash |
|---|---|---|
| File-backed, e.g. `patch:lodash@npm%3A4.17.21#./patch.diff::version=4.17.21&hash=…` | patch source bytes (the `.patch` file referenced by the `#./<path>` fragment) | sha512, lower-case hex, no prefix |
| `~builtin<compat/…>`, e.g. `patch:typescript@npm%3A5.4.5#~builtin<compat/typescript>::…` | UTF-8 bytes of `<yarn-major>:<locator>`, e.g. `4:~builtin<compat/typescript>`. yarn-major sourcing per [ADR-0015 (proposed)](../decisions/0015-ambient-state-inputs-to-canonical-recipes.md) when sourceable; un-sourceable at parse time falls through to Row 3 | sha512, lower-case hex, no prefix |
| Patch input unreachable at parse time (CI artefact stripped of `.yarn/patches/`, slim source tarball, hand-edited entry, or `~builtin<…>` with un-sourceable yarn-major) | UTF-8 bytes of the locator string verbatim | sentinel `unresolved-<sha256-hex>`; emit `warning` diagnostic |

**Routing.** Row 1 fires when the locator is `patch:<spec>#<path>::…`,
the path resolves workspace-contained, and the file bytes are
readable. Row 2 fires when the locator is `~builtin<…>` and
yarn-major is sourceable per ADR-0015. Row 3 fires on any locator
that fails its shape's canonical-recipe preconditions — Row 1 with
a missing file, Row 2 with un-sourceable yarn-major. Path-containment
failures (`..`-escape, absolute path, symlink) are NOT a Row 3
fall-through: they throw `LockfileError({ code: 'INVALID_INPUT' })`
per [Path confinement](#path-confinement) and terminate the parse.
Sentinel covers "recipe input absent"; INVALID_INPUT covers "caller
provided malformed input".

Sentinel-keyed entries are read-only at the mutator layer per
[02-graph.md#mutator-coherence](../02-graph.md#mutator-coherence).

### Path confinement

The path component of a file-backed `patch:` locator (the segment
after `#`, before `::`) MUST resolve to a file under the workspace
root. Any violation throws
`LockfileError({ code: 'INVALID_INPUT' })` with the offending locator
in the diagnostic message.

- **Walk.** Percent-decode the path component; treat the result as
  posix-style. Reject absolute paths and Windows drive-letter
  prefixes outright. Join to the workspace root and lexically
  normalise (collapse `.`, `..`); reject if any `..` survives the
  collapse, or if the normalised result is not a strict descendant
  of the workspace root.
- **Symlinks.** Open every component including the leaf with
  `O_NOFOLLOW`-equivalent semantics (`openat(..., O_NOFOLLOW)` on
  POSIX, `FILE_FLAG_OPEN_REPARSE_POINT` on Windows). Symlinks are
  rejected wholesale at the adapter boundary — any symlink
  encountered throws `LockfileError({ code: 'INVALID_INPUT' })`.
  Yarn-berry writes `.yarn/patches/*.patch` as regular files in
  normal usage; admitting leaf symlinks would add TOCTOU surface
  between resolve and read for no compelling case.
- **Hardlinks.** Permitted within the workspace filesystem. A
  hardlink cannot cross filesystem boundaries, so the workspace
  containment check carries through; no separate hardlink check is
  required.
- **FDs.** One open file descriptor per concurrent fingerprint
  computation. Read fully, close, then hash. The adapter MUST close
  the descriptor before returning the fingerprint — no FD outlives
  the patch-extraction call.

## Quirks

- `checksum` is **not** a sha512 — it's a yarn-specific hash incorporating
  `cacheKey`. Two berry installs with different cacheKeys produce different
  checksums for the same archive. Keep raw, do not normalise.
- `linkType: hard` vs `soft` distinguishes hard-linkable vs symlink-only deps.
- Virtual instances appear with `virtual:<random>#<base-resolution>` keys.
  These are PEER-RESOLVED forks of one underlying package — handle in graph
  layer per [02-graph.md](../02-graph.md#node-identity).
- Multi-spec keys (`"foo@npm:^1, foo@npm:^1.2":`) common — single value per
  entry.

## Degradation rules

| Feature | Action |
|---------|--------|
| Patches → npm-* | **strip** with diagnostic |
| Virtual instances → npm-* | **flatten** to underlying resolution |

## Fixtures

- `legacy/test/fixtures/yarn-5-mr/` (note: existing `yarn-5/6/7` directories
  are berry-vN samples, despite the directory naming)

## Open questions

> **Open:** schema differences between v4 and v5 / v6 / v8 are incremental but
> not enumerated anywhere centrally. Need a diff-grid across all four (cacheKey
> presence, languageName defaults, conditions field, …).
