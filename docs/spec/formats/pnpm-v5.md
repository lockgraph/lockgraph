# `pnpm-v5` — pnpm `pnpm-lock.yaml` (lockfileVersion 5.x)

> Status: stable (adapter + pnpm-flat round-trip suite; pnpm 7 default-5.4 verified).
> Updated: 2026-08-01
> Provenance: **Source-only**.

## Compatibility

### Writers — PM semvers that *emit* this format

| PM | semver range | Default? | How to opt in |
|----|--------------|:--------:|---------------|
| pnpm | `>=3 <8` | ✓ | minor bumps `5.0` … `5.4` inside this window; pnpm 7 still defaults to `5.4` (verified empirically — pm-pnpm-7 produces `lockfileVersion: 5.4`) |

### Readers — PM semvers that *install* from this format

| PM | semver range | Notes |
|----|--------------|-------|
| pnpm | `>=3` | newer pnpm auto-migrates on install |

## File

- **Filename:** `pnpm-lock.yaml`
- **Encoding:** UTF-8 YAML.
- **Sibling files:**
  - `node_modules/.modules.yaml` — install state
  - `node_modules/.pnpm/` — content-addressable instance directories
  - `.pnpmfile.cjs` — optional resolve hooks

## Sources

- [`pnpm/spec/lockfile/5.md`](https://github.com/pnpm/spec/blob/master/lockfile/5.md)
  — official schema spec for the 5.x family.
- [`pnpm/spec/lockfile/5.2.md`](https://github.com/pnpm/spec/blob/master/lockfile/5.2.md)
  — minor-version spec capturing the 5.0 → 5.2 deltas.
- [`pnpm/pnpm` types](https://github.com/pnpm/pnpm/blob/main/lockfile/types/src/index.ts)
  — TypeScript surface of the lockfile object (current main).
- [`pnpm/pnpm` lockfile package](https://github.com/pnpm/pnpm/tree/main/lockfile)
  — types / file / utils / migration code.

## Schema sketch

```yaml
lockfileVersion: 5.4

overrides:
  foo: 1.0.3

importers:
  .:
    specifiers:
      foo: ^1.0.0
    dependencies:
      foo: 1.0.3
  packages/app:
    specifiers: {...}
    dependencies: {...}

packages:
  /foo/1.0.3:
    resolution: { integrity: sha512-... }
    dependencies:
      bar: 2.0.0
  /react/18.0.0_some-peer-hash:
    resolution: { integrity: ... }
    peerDependencies:
      react: '*'
```

## Capabilities

| Feature | Supported | Notes |
|---------|:---------:|-------|
| Workspaces                                | ✓ | one `importers` entry per workspace |
| Workspace protocol                        | ✓ | `link:` resolution |
| Peer-dep virtualization                   | ✓ | encoded as `_peer-hash` suffix in package id |
| `npm:` alias                              | ✓ | |
| `git` / `github` protocols                | ✓ | |
| `file` / `link` / `portal`                | ✓ | first-class |
| `patch:` protocol                         | ✓ | via `pnpm.patchedDependencies` in package.json + lock entry |
| Integrity hashes                          | ✓ | `resolution.integrity` |
| `dev` / `optional` / `peer` separation    | ✓ | per-importer keyed buckets + `dev: true` flag |
| Bundled deps                              | ~ | rare; respected if present |
| Overrides / resolutions                   | ✓ | top-level `overrides:` block (after `lockfileVersion`), captured verbatim + re-emitted; pnpm 6–7 frozen-compare it against config |

## Integrity

The model is the shared [`_common.md` §3 integrity model](./_common.md#3-integrity-model);
this is only how pnpm *carries* it.

- Integrity lives under each `packages` entry as
  `resolution: { integrity: sha512-<base64> }` — a Subresource-Integrity
  string parsed with `parseSri(…, 'sri')` and emitted with `emitSri`
  (shared `_pnpm-flat-core.ts`). The hash is of the **tarball** bytes
  (`origin: 'sri'`).
- An `integrity`-only `resolution` block implies the **registry** tarball
  whose URL is derived by convention from `name@version` (no explicit
  `tarball:` URL is needed or emitted for the npm-registry default).
- A space-joined multi-algorithm SRI is preserved in full as a multiset
  ([`_common.md` §3.5](./_common.md#35-the-multi-hash-case-and-the-equivalence-rule)).
  This carry shape is identical across pnpm-v5 / v6 / v9.

## Conversion inputs

| Operation | Option       | Required? | Effect when omitted |
|-----------|--------------|:---------:|---------------------|
| Parse     | —            | none      | `importers` block enumerates workspaces by path |
| Stringify | `manifests`  | optional  | enriches per-package metadata; pnpm consumers may rely on `engines` for skip decisions |

## Quirks

### Numeric-looking scalars carry a YAML type

A quoted decimal is a **string**; a bare one is a **number**. The distinction is
load-bearing wherever a dependency range happens to look numeric — a manifest
declaring `"babel-loader": "8"` produces `babel-loader: '8'` in `specifiers`, and
pnpm compares that string against the manifest under a frozen install.

Emitting it bare changes its type, the comparison no longer matches, and the lock
is refused. The inverse rule holds equally: a genuine bare number must stay bare,
or a numeric setting silently becomes a string.

> **Measured** · pnpm 6.35.1 · `pnpm install --frozen-lockfile` · a lock whose
> root `specifiers` keeps `babel-loader: '8'` is accepted; the same lock with only
> the quotes removed fails `ERR_PNPM_OUTDATED_LOCKFILE`.

The rule is a property of the YAML codec, so it holds identically on
[v6](./pnpm-v6.md) and [v9](./pnpm-v9.md).

### `requiresBuild` on a package entry

A `packages` entry may carry `requiresBuild: true`. pnpm uses the bit when it
records pending dependency build scripts; it is not implied by `hasBin` or any
other package metadata. Same-format replay preserves a source-authored true
value, while an entry that omits the key remains key-free. The field is written
before the entry's `dev` flag.

The v5 implementation owns a standalone parse/stringify pipeline because its
package-key and importer shapes predate the shared v6/v9 layout; native carriers
must therefore be handled explicitly in that adapter as well as in the shared
core.

- Package id grammar: `/<name>/<version>` for plain, `/<name>/<version>_<peerHash>`
  for peer-virtualised, `/<name>/<version>_<peerHash><sub>` for chained.
  This is **the** reference for "how pnpm encodes peerContext" — the model's
  [NodeId](./_common.md#41-nodeid) / `peerContext` vocabulary is borrowed
  verbatim from this pnpm package-id form.
- `specifiers` block in each importer mirrors the manifest's range section —
  used for upgrade detection.
- Project-root authority comes only from a parse-captured native root importer
  or an explicit node with `workspacePath: ""`. A sole DAG root remains a
  package entry; rootless input receives the native neutral importer.
- A workspace importer's dependency key is its **declared manifest slot**, not
  the target importer directory or package-node name. The adapter retains that
  slot independently from the `link:<dir>` value and re-emits it in both
  `specifiers` and the matching dependency block.
- Whenever the graph already holds a representable local-directory package,
  stringify emits `resolution: {directory: <dir>, type: directory}`; the type
  tag is required for pnpm to treat the payload as a directory rather than a
  tarball. This does **not** close the separate native pnpm 5–8 input gap: those
  producers key local packages as bare `file:<dir>`, which the current v5
  packages-key parser still rejects with `PNPM_BAD_ENTRY` (see below).
- `lockfileVersion` is a **string**, not a number (`'5.4'`).
- Top-level `overrides:` block (pnpm 6–7): pnpm's frozen install
  (`--frozen-lockfile`) DEEP-COMPARES it against current config
  (`getOutdatedLockfileSetting`) and rejects with `LockfileConfigMismatchError`
  on mismatch — so an override-using project whose lock omits the block is NOT
  frozen-clean. lockgraph captures + re-emits it verbatim (after `lockfileVersion`).
- Top-level `time` block (optional) records first-seen timestamps.
- Importer `dep` / `dev` / `optional` declarations and package-entry
  `dep` / `optional` declarations can exist even when their version or
  `link:` value binds to no package/workspace node. Parse emits
  `PNPM_UNRESOLVED_DEP` and retains owner, kind, name, specifier, resolved
  value, and native channel (`importer` or `package`). Stringify restores the
  declaration to that channel; graph-derived bound edges win on collision. If
  output reparse loses it, strict output rejects
  `COMPLETENESS_OUTPUT_UNRESOLVED_DECLARATION_DROPPED` as irreducible, with no
  registry remedy.
- A `link:<dir>` value inside a PACKAGE entry's `dependencies` /
  `optionalDependencies` is a workspace-directory reference resolved against the
  lockfile directory, not a `packages` key — pnpm 7 writes it for a peer
  satisfied by a workspace member. Handling matches
  [pnpm-v9](./pnpm-v9.md#link-inside-a-snapshots-dependency-block), with two
  v5 specifics: the peer tail is frequently a hash, so a workspace-satisfied
  peer is often not recoverable from the key and the
  `PNPM_WORKSPACE_LINK_PEER_BOUND` branch does not arise — the published
  consumer reports `PNPM_WORKSPACE_LINK_EDGE_DROPPED`; and pnpm keys a local
  directory package as a bare `file:<dir>`, which `parsePackagesKey` rejects
  (`PNPM_BAD_ENTRY`), so the local-consumer bind is unreachable on real v5
  input.

### `_<peer>` tail encoding

The tail is built by `createPeersFolderSuffix`. Read from the producers' own
bundles rather than inferred, because two details differ between them and
neither is guessable from a lockfile:

```js
// pnpm 6.35.1 and pnpm 7 — identical except for the threshold and the encoding
function createPeersFolderSuffix (peers) {
  const folderName = peers
    .map(({ name, version }) => `${name.replace('/', '+')}@${version}`)
    .sort()
    .join('+')
  if (folderName.length > THRESHOLD) return `_${HASH(folderName)}`
  return `_${folderName}`
}
```

| producer | `THRESHOLD` | `HASH` | rendered width |
| --- | --: | --- | --- |
| pnpm 6 | 32 | `md5(s)` as lowercase hex | 32 |
| pnpm 7+ | 26 | `base32(md5(s))`, RFC 4648, padding stripped, lowercased | 26 |

> **Read** · `pnpm 7.33.7` · `createPeersFolderSuffix` in `dist/pnpm.cjs` · hashes
> the tail when the rendered name exceeds 26 characters, encoding md5 as unpadded
> lowercase RFC 4648 base32. `pnpm 6.35.1` uses threshold 32 and md5 as hex.

Neither number is derivable from a lockfile: a lock shows a hashed tail or a plain
one, never the length at which the producer switched. Both come from the shipped
bundle, which is why this is a `Read` and not a census — and why a claim that pnpm
hashes *every* peer set, which the two thresholds contradict, survived as long as it
did.

Note `name.replace('/', '+')` replaces only the **first** `/`, which for
`@scope/name` is exactly the scope separator.

So `+` is overloaded three ways inside one tail: the scope separator of a peer
**name**, the separator **between** peers, and — via
[`filenamify(dir, {replacement: '+'})`](./pnpm-v9.md#workspace-directory-peer-locators)
— the directory separator of a workspace-peer **version**. They are separable
without ambiguity:

- a segment opening with `@` and carrying no second `@` is a scope, and takes
  the following segment as its name half — `@antv+g2@3.5.19` is the package
  `@antv/g2`, never a directory;
- a segment with no `@` at all belongs to the version before it, which is how
  semver build metadata (`1.0.0+build`) survives;
- everything else starts a new peer.

**A hashed tail is a peer context, not part of the version.** The digest replaces
the whole rendered list, so it names no package and can bear no peer edge, but it
still discriminates one variant of a package from another. It is therefore
carried as a single opaque context token: the node keeps its real version, its
base identity still matches a peer reference naming `name@version`, and the seal
exempts exactly this token from edge/context coherence. Recovering the
peer set from a digest is not possible — `md5` is one-way — though a candidate
set can be *verified* by re-rendering and re-hashing it.

The one `_` in a key is the version/tail boundary and never a peer separator.
Peers are joined by `+`. Eight keys in the scraped corpus carry two underscores;
all eight are package names such as `@types/babel__core`, so peeling from the
right on `_` splits a name in half.

## Degradation rules

| Feature | Action |
|---------|--------|
| Patches → npm-* / yarn-classic | **strip** |
| Peer virtualization → npm-* / yarn-classic | **flatten** |

For an npm-4 source, the native raw-SRI / path patch carrier is not a pnpm
patch declaration, and npm manifest-extension fingerprints / applied provenance
have no pnpm-v5 carrier. Non-strict conversion reports both losses (while
retaining representable effective graph edges); strict projection rejects.

For yarn-berry-v10 interchange, pnpm-v5 re-encodes peer virtualization but
uses a different workspace identity convention and a tarball-SRI integrity
origin. The calibrated v10 cell records workspace rekeying and tarball payload
loss; the reverse cell records peer-virtual and tarball payload loss. Missing
target integrity is reported and never fabricated.

The complete matrix pins the same directional profile for yarn-berry-v4
through v8: Berry → pnpm-v5 rekeys workspace ids and loses cross-sidecar
tarball metadata; pnpm-v5 → Berry flattens peer-virtual ids, loses tarball
metadata, and synthesizes the destination preamble. The npm-{1,2} cells are
also contract-backed. npm-1 → pnpm-v5 rekeys the root workspace id; the reverse
loses nested-tree edges, peer virtualization, and tarball metadata. npm-2 →
pnpm-v5 rekeys workspace ids and loses tarball metadata; the reverse flattens
peer-virtual ids. Integrity remains tarball SRI across npm/pnpm.

## Fixtures

> **TBD:** no pnpm fixtures carried over yet; generated via the test bench.

## Open questions

> **Open:** exact 5.0 → 5.4 differences. Some are tolerated by all 5.x
> readers, others not. Need a compat matrix.

## Unknown top-level extension keys

Pinned pnpm 7.33.7 accepts and byte-preserves producer-extension values at the
project root. The adapter deep-clones such values, replays them only for
`pnpm-v5`, and preserves their source key placement; modeled fields always win
on collision. Detached-state and cross-format losses name every
`top-level:<key>` and strict conversion fails closed.
