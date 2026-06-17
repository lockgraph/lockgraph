# `bun-text` — bun `bun.lock`

> Status: stable (adapter + round-trip tested; bun audit-fix native remediation still absent upstream).
> Updated: 2026-06-16
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
  "overrides": { "lodash": "4.17.21", "@types/node": "20.0.0" },
  "packages": {
    "foo": ["foo@1.0.3", "", { /* inner deps */ }, "<integrity>"],
    "react": ["react@18.0.0", "", { ... }, "sha512-…"],
    "@scope/app": ["@scope/app@workspace:packages/app"]
  },
  "patchedDependencies": { "foo@1.0.3": "patches/foo.patch" },
  "trustedDependencies": ["esbuild"]
}
```

Each `packages[name]` entry is a positional array — bun-specific encoding.
The regular-package tuple is **4 slots, `[id, "", inner, integrity]`**:
`id` (`<name>@<version>`), an **always-empty registry-marker slot** (`""`
for the default npm registry), the `inner` deps object
(`dependencies` / `optionalDependencies` / `peerDependencies` / `bin` / `os`
/ `cpu`), then the SRI `integrity` string. A workspace member is the
degenerate **1-slot** tuple `["<name>@workspace:<path>"]`. Trailing slots are
NOT freely omissible the way an early `[id, integrity, deps, extras]` reading
implied — `integrity` lives in slot **3** (0-based), not slot 1. Top-level
block order through `packages` (`lockfileVersion`, `workspaces`,
`overrides`, `packages`) is corroborated by the real-world corpus fixtures;
the trailing pair (`patchedDependencies`, `trustedDependencies`) and their
position after `packages` are adapter-chosen and not yet corroborated against
a real bun emit that carries them — confirm against bun's `lockfile.zig`
writer before relying on byte-exact same-PM round-trip of those two blocks.

## Capabilities

| Feature | Supported | Notes |
|---------|:---------:|-------|
| Workspaces                                | ✓ | top-level `workspaces` map keyed by path |
| Workspace protocol (`workspace:*`)        | ✓ | first-class |
| Peer-dep virtualization                   | ✗ | peers are **declarative** in each package's inner `peerDependencies` — no peer-virt nodes on disk; inbound `peerContext` flattens on emit (`BUN_TEXT_PEER_VIRT_FLATTENED`) |
| `npm:` alias                              | ✓ | |
| `git` / `github` protocols                | ✓ | |
| `file` / `link` / `portal`                | ~ | `file:`, `link:` supported; `portal:` is yarn-only |
| `patch:` protocol                         | ~ | top-level `patchedDependencies` map round-trips verbatim; the per-node `Node.patch` recipe form is NOT projected to it (drops with `RECIPE_FEATURE_DROPPED`) |
| Integrity hashes                          | ✓ | sha-family in positional slot **3** (`[id, "", inner, integrity]`), read/emitted as the SRI multiset (`_common.md` §3) |
| `dev` / `optional` / `peer` separation    | ✓ | manifest mirror in `workspaces`; peer-deps are declarative (no peer-virt nodes) |
| Bundled deps                              | ✗ | |
| Overrides / resolutions                   | ✓ | top-level `overrides` block (npm-shaped, flat `{name: target}` or nested); round-trips verbatim, accepts caller `StringifyOptions.overrides` (audit-fix write path), and surfaces canonically via `overridesOf(graph)` |
| `trustedDependencies`                     | ✓ | top-level allowlist; round-trips verbatim (load-bearing for reproducibility) |

## Integrity

The model is the shared [`_common.md` §3 integrity model](./_common.md#3-integrity-model);
this is only how bun-text *carries* it.

- Integrity is the **4th slot (index 3)** of a regular-package positional
  tuple: `["<name>@<version>", "", <inner>, "<integrity>"]`. The slot is a
  Subresource-Integrity string (normally `sha512-<base64>`), parsed with
  `parseSri(…, 'sri')` and emitted with `emitSri` (`bun-text.ts`). The hash
  is of the **tarball** bytes (`origin: 'sri'`).
- The slot is **read only when present and non-empty** (`raw[3]` is a
  string of length > 0); a workspace member is the degenerate 1-slot tuple
  and carries no integrity. On emit, a node with no tarball-origin hash
  writes `""` in slot 3 (the slot is positional and not freely omissible).
- A space-joined multi-algorithm SRI is preserved in full as a multiset
  ([`_common.md` §3.5](./_common.md#35-the-multi-hash-case-and-the-equivalence-rule)).

## Conversion inputs

| Operation | Option       | Required?      | Effect when omitted |
|-----------|--------------|:--------------:|---------------------|
| Parse     | —            | none           | top-level `workspaces` block enumerates members |
| Stringify | `overrides`  | optional       | caller-supplied canonical `OverrideConstraint[]` projected into the top-level `overrides` block (npm grammar). Omit ⇒ the verbatim parse-time block is re-emitted; explicit `[]` ⇒ suppress it. The audit-fix write path. |

## Quirks

- Positional array encoding for regular `packages` entries — **4 slots,
  `[id, "", inner, integrity]`**: `id` = `<name>@<version>`; slot 1 is an
  always-empty registry-marker (`""` = default npm registry); `inner` is the
  deps/`bin`/`os`/`cpu` object; `integrity` is the SRI string. Workspace
  members are the 1-slot tuple `["<name>@workspace:<path>"]`. The `integrity`
  hash is in slot **3**, NOT slot 1 — an earlier `[id, integrity, deps, extras]`
  reading was wrong.
- A single `<name>@<version>` may appear under multiple `packages` keys — via
  npm-alias siblings (e.g. `string-width` + `string-width-cjs`) and via
  de-hoist keys (`<consumer-path>/<dep-name>`). Parse dedups on NodeId and emits
  one tuple per `<name>@<version>`; the de-hoist scope is replayed at parse but
  collapses to the flat key on emit (lossless — the dep set is key-invariant).
- `lockfileVersion: 1` for bun-text refers to bun's own text-format version,
  unrelated to npm's `lockfileVersion: 1`. Real-world `bun.lock` files also
  carry a sibling `configVersion` integer the adapter currently ignores.
- JSONC parser must tolerate trailing commas and line comments.
- The empty-string workspace key (`""`) is the root project.
- `overrides` is bun's forced-resolution mechanism — the npm/bun analog of yarn
  `resolutions`, and the channel an audit-fix uses to pin a transitive
  vulnerable dependency onto a safe version. The block is **npm-shaped** (flat
  `{name: target}` in the common case, nested for parent-scoped overrides) and
  round-trips **verbatim** (preferred carrier; the canonical name-chain drops
  npm `pkg@version`-key qualifiers per ADR-0025 §2). It is captured canonically
  at parse for cross-PM reads (`getBunOverridesCanonical` → `overridesOf`).
- `trustedDependencies` controls postinstall execution — load-bearing for
  reproducibility, even though it's not strictly resolution data. Round-trips
  verbatim; emitted sorted.
- `patchedDependencies` (a `<name>@<version>` → patch-path map) round-trips
  verbatim. It is distinct from the per-node `Node.patch` recipe form, which
  bun-text cannot encode and drops with `RECIPE_FEATURE_DROPPED`.
- Integrity (positional slot **3**) is preserved as a multi-hash multiset —
  `sha1`, `sha256`, `sha384`, `sha512`, and every member of a space-joined SRI —
  not collapsed to sha512-only. The shared integrity model (verbatim multiset,
  per-hash origin tags, omit-never-fabricate emit) is in
  [`_common.md` §3](./_common.md#3-integrity-model); bun-text reads and
  emits SRI-origin hashes from this single positional slot.

## Degradation rules

| Feature | Action |
|---------|--------|
| `trustedDependencies` → npm-*, yarn-*, pnpm-* | **strip** (it is bun-only; survives only a bun→bun round-trip via the sidecar) |
| `overrides` → yarn-* | **strip** with `INTEROP_OVERRIDE_NOT_PROJECTED` (yarn carries no lockfile overrides block) — same as every other source |
| `overrides` → npm-2/3, pnpm | **project** through the canonical `OverrideConstraint[]` (npm-shaped block ⇒ npm/pnpm projection) |
| `patchedDependencies` → non-bun | **strip** (bun-only patch-map shape) |
| Per-node `Node.patch` (recipe form) → bun-text | **drop** with `RECIPE_FEATURE_DROPPED` (no per-node patch protocol; only the top-level `patchedDependencies` map) |
| Positional encoding | not user-visible — internal only |

## Fixtures

Synthetic matrix under `src/test/resources/fixtures/lockfiles/<case>/bun-text.lock`
(`simple`, `deps-with-scopes`, `peers-basic`, `peers-multi`,
`workspaces-basic`, `workspace-cross-refs`, `yarn-crlf`). Real-world corpus:
`src/test/resources/fixtures/real-world/oven-sh-bun-main-*/bun.lock` (carries a
live `overrides` + `configVersion`) and `honojs-hono-main-*/bun.lock`. The
`overrides` / `trustedDependencies` / `patchedDependencies` round-trip is
covered in `src/test/unit/bun-text.test.ts`.

## Open questions

> **Resolved (partial):** bun encodes peer-deps **declaratively** in each
> package's inner block (`peerDependencies`), NOT as virtualized peer-context
> nodes the way pnpm/yarn-berry do. The adapter therefore parses no peer-virt
> nodes and flattens any inbound `peerContext` on emit with
> `BUN_TEXT_PEER_VIRT_FLATTENED`. Whether bun's installer materializes a
> peer-specific dedup that a richer reader could recover is still open, but the
> on-disk `bun.lock` carries no peer-virtualization marker to recover from.
> **Open:** the always-empty slot-1 registry marker (`""`) — does bun ever
> populate it for a non-default registry? No sample observed yet; the adapter
> emits `""` unconditionally.
