# `pnpm-v9` — pnpm `pnpm-lock.yaml` (lockfileVersion 9)

> Status: stable (adapter + pnpm-flat round-trip suite; packages/snapshots split covered).
> Updated: 2026-08-02
> Provenance: **Source-only**.

## Compatibility

### Writers — PM semvers that *emit* this format

| PM | semver range | Default? | How to opt in |
|----|--------------|:--------:|---------------|
| pnpm | `>=9`  | ✓ | pnpm 9 jumped lockfileVersion from 6.x to 9.0; 9.x, 10.x, 11.x and 12.x all default to `'9.0'` |

### Readers — PM semvers that *install* from this format

| PM | semver range | Notes |
|----|--------------|-------|
| pnpm | `>=9`  | a writer must be its own reader; pnpm 9.x through 12.x read and write `'9.0'` |

## File

Same as [pnpm-v5](./pnpm-v5.md#file).

## Sources

- [`pnpm/spec/lockfile/9.0.md`](https://github.com/pnpm/spec/blob/master/lockfile/9.0.md)
  — official schema spec for 9.0; primary evidence for the
  `packages` / `snapshots` split.
- [pnpm Discussion #6857](https://github.com/orgs/pnpm/discussions/6857)
  — maintainer rationale for jumping `6.x → 9.0` (skipping 7 and 8):
  *"in the future lockfile version will equal the pnpm version in
  which it got introduced."*
- See also [pnpm-v5 sources](./pnpm-v5.md#sources) for shared
  references.

## Schema sketch

```yaml
lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

overrides:                              # top-level, re-emittable (see Capabilities)
  foo@1: 2.0.0

importers:
  .:
    dependencies:
      foo:
        specifier: ^1.0.0
        version: 1.0.3

packages:
  foo@1.0.3:
    resolution: { integrity: sha512-... }
    engines: { node: '>=14' }

snapshots:
  foo@1.0.3:
    dependencies:
      bar: 2.0.0
```

## Capabilities

Same as [pnpm-v6](./pnpm-v6.md#capabilities). The expressiveness ceiling is
unchanged from the 6.x family; the v9 jump is structural, not capability-led.

**Overrides — persisted in the lock (unlike npm/yarn).** pnpm writes a top-level
`overrides:` block (selector → target, e.g. `parent>child`, `foo@1: 2.0.0`,
removal `foo: '-'`, or a `patch:` directive) verbatim into `pnpm-lock.yaml`. This
project captures it at parse and canonicalises it to `OverrideConstraint[]`
(`_pnpm-flat-core.ts`, `captureOverrides('pnpm')`), so it **round-trips** and is
recoverable from the lock alone via [`overridesOf(graph)`](../06-modifiers.md) —
in contrast to npm `overrides` and yarn `resolutions`, which are resolve-time
`package.json` input never written into their locks
([npm §`overrides`](../pm/npm.md#overrides-manifest-driven-forced-replacement),
[yarn §1.3](../pm/yarn.md#13-resolutions-field)). bun likewise persists a
re-emittable `overrides` block; pnpm and bun are the two families where the pin
survives in the lockfile.

## Integrity

Identical to [pnpm-v5](./pnpm-v5.md#integrity): each `packages` entry carries
`resolution: { integrity: sha512-… }` (`origin: 'sri'`, tarball digest),
parsed/emitted via the shared `_pnpm-flat-core.ts` (`parseSri` / `emitSri`)
under the [`_common.md` §3 model](./_common.md#3-integrity-model). In v9 the
`packages` block holds the version-keyed `resolution.integrity`, while
`snapshots` holds the resolved dependency graph — integrity stays in
`packages`.

## Conversion inputs

Same as [pnpm-v6](./pnpm-v6.md#conversion-inputs).

## Quirks

Compared to v6:

- Root authority and neutral-importer synthesis inherit the
  [pnpm-v5 rule](./pnpm-v5.md#quirks); DAG reachability is not project identity.
- A workspace importer's dependency key is the **declared manifest slot**, not
  the target importer's directory or package-node name. Parse retains that key
  beside the bound edge; stringify reuses it while `version: link:<dir>` carries
  the target path. This distinction is producer-enforced: pnpm rejects a lock
  whose importer key no longer matches the manifest declaration.
- A representable local `file:` package is emitted with both directory fields:
  `resolution: {directory: <dir>, type: directory}`. Pinned pnpm 10.34.5 accepts
  those bytes under `--frozen-lockfile`, leaves them unchanged in write-enabled
  mode, and materialises both the root link and the local package's dependency
  link. Omitting `type: directory` makes pnpm treat the entry as a tarball.
- Two top-level blocks instead of one — `packages` (immutable manifest
  data: resolution, integrity, engines) and `snapshots` (resolution-time
  data: dependency edges, peer bindings). One package can have many
  snapshots when peer-virtualisation creates instances.
- The leading slash in package ids was dropped (`foo@1.0.3` instead of
  `/foo@1.0.3`).
- pnpm jumped lockfileVersion `6.x` → `9.0` directly. **There is no
  v7 or v8 schema in the wild.** pnpm 9.x, 10.x, 11.x and 12.x all default to
  `'9.0'`; what differs between them is engine behaviour, not the written
  lockfile schema. Measured on 11.26.0 and 12.3.4: a project exercising
  workspaces, an alias, a `workspace:` dependency, optional and peer deps with
  `peerDependenciesMeta` produces a lock byte-identical to pnpm 10.34.5's — with
  ONE exception, and it is a settings-source change rather than a schema change.
- **Where `overrides` is declared moved, and the majors barely overlap.**
  Measured, same project, same lock schema:

  | pnpm | `package.json#pnpm.overrides` | `pnpm-workspace.yaml#overrides` |
  |------|:----------------------------:|:-------------------------------:|
  | 8, 9 | honoured | **ignored** |
  | 10 | honoured | honoured |
  | 11, 12 | **ignored** (warns) | honoured |

  pnpm 11+ prints `The "pnpm" field in package.json is no longer read by pnpm`
  and resolves as if the override were absent — the lock is well-formed and
  simply pins the wrong version. **pnpm 10 is the only major that reads both**,
  so no single declaration site serves the whole `'9.0'` range; a projection that
  must target an unknown pnpm within it has to write both places or refuse.
- The `packages` / `snapshots` split mirrors our internal model
  (package metadata vs peer-bound instance) — `packages` carries the
  identity-neutral tarball surface (`TarballKey` → `TarballPayload`),
  `snapshots` carries the peer-bound node instances (`NodeId`); see
  [_common.md §4.1](./_common.md#41-nodeid) and
  [§4.3](./_common.md#43-tarballkey).
- An importer declaration or snapshot `dependencies` /
  `optionalDependencies` member may fail to bind to any package or snapshot.
  Parse emits `PNPM_UNRESOLVED_DEP` and retains owner, kind, name, specifier,
  resolved value, and native channel (`importer` or `package`). Stringify
  restores the fact to the importer object or snapshot adjacency block, with
  graph-derived bound edges authoritative on collision. Output reparse must
  recover the same fact; otherwise strict projection rejects
  `COMPLETENESS_OUTPUT_UNRESOLVED_DECLARATION_DROPPED` as irreducible and does
  not advertise registry evidence as a remedy.

### Peer-virtualisation in snapshot keys (node identity)

A peer-bound snapshot is keyed `name@version(peerA@v)(peerB@v)…`; the
parenthesised peer-context is part of node identity. This is exactly the
shared [NodeId](./_common.md#41-nodeid) grammar — pnpm's own
`lockfileVersion 6+` package-id form, from which the model's `NodeId` /
`peerContext` vocabulary is borrowed verbatim. Two encodings of that
suffix are load-bearing for faithful round-trip:

- **Nested peer suffixes.** A peer in the suffix carries its OWN nested `(...)`
  suffix, to the depth it was resolved at — e.g.
  `@vitejs/plugin-vue@6.0.1(vite@8.0.8(esbuild@0.26.0))(vue@3.5.24)`. The nested
  suffix is PRESERVED in the consumer's node id, so two consumer instances that
  differ only in a transitive peer's resolution stay DISTINCT nodes. Dropping it
  collapsed them onto one id and merged their divergent dep edges (unrepresentable
  → see the verifier below). This is the sub-peer nesting rule of
  [§4.1](./_common.md#41-nodeid).
- **Hashed peer-set tokens.** When the resolved peer set is long, pnpm
  abbreviates the whole expanded list into a single bare-hex digest segment —
  e.g. `@angular/build@22.0.0-rc.2(53b8fd9b7f33abb48dff18614cf85bde)`. This is
  **not** a patch hash (patches use the labelled `(patch_hash=<sha256>)` form):
  it is an opaque peer-context discriminator, kept verbatim in node identity so
  distinct hashed instances stay distinct. The same `name@version` may appear
  under several distinct hashes.

  A hash is non-edge-bearing by default, but it need not stay wholly opaque when
  the lock carries one complete, unambiguous producer preimage. Reconstruction
  takes every resolved own peer named by `packages[name@version].peerDependencies`,
  adds the uniquely observable external peers named by
  `snapshots[key].transitivePeerDependencies`, renders linked workspace peers
  with pnpm's encoded directory locator, sorts the resulting peer depPaths, and
  joins them with `)(`. If SHA-256 of that body, truncated to 32 lowercase hex
  characters, equals the native token, workspace peers in that exact set become
  real `peer` edges. The digest remains in node identity for the registry peers
  still hidden behind it. A missing input, two observable resolutions for one
  peer name, or a digest mismatch recovers no edge; no subset is guessed.

  > **Read** · `pnpm 11.3.0` · `createPeerDepGraphHash` in `dist/pnpm.cjs` · sorts
  > resolved peer depPaths, joins them with `)(`, and, above the configured
  > suffix-length ceiling, replaces that body with the first 32 lowercase hex
  > characters of SHA-256. Its caller hashes `allResolvedPeers`: own resolved
  > peers plus external peer resolutions propagated from children.

  `angular/angular@45e8fb5` contains two hashed `@angular/build@22.0.0-rc.2`
  instances with seven workspace peers apiece. The `76f7…` token has one complete
  observable 23-peer preimage and therefore binds its seven workspace edges; the
  `53b8…` token has no complete observable preimage and keeps all seven declared
  workspace links as explicit drops.
- Both collapse classes are guarded by a pnpm-specific resolution verifier:
  every declared dep/dev/optional edge must resolve, through the emitted
  adjacency, back to its target id — a miss surfaces as a soft, pnpm-specific
  `LAYOUT_RESOLVE_VIOLATION` [Diagnostic](./_common.md#4-reserved-vocabulary)
  (`warning` severity, never a throw).

#### Workspace-directory peer locators

A peer that a **workspace member** satisfies has no version to record, so pnpm
puts the member's directory in the peer's version slot instead:
`@angular/material@22.0.0-rc.2(@angular/core@packages+core)` binds the importer
at `packages/core`. The `name` half is the **alias the consumer declared the
peer under**, not the member's package name; the member is named by DIRECTORY
everywhere else in the lock, so the alias is the only record of the slot.

The directory is encoded with `filenamify(dir, { replacement: '+' })` —
`filenamify@4.3.0`, called from `peerNodeIdToPeerId` on the pnpm 9 and pnpm 10
code paths and from the `createPeersFolderSuffix` caller on pnpm 6. The full
rule, in order:

1. every filename-reserved character — `< > : " / \ | ? *` and `U+0000`–`U+001F`
   — becomes `+`;
2. `U+0080`–`U+009F` becomes `+`;
3. a LEADING run of `.` becomes a single `+`;
4. a TRAILING run of `.` is dropped;
5. runs of two or more `+` collapse to one;
6. when more than one character remains, one leading and one trailing `+` are
   stripped;
7. a Windows device name (`con`, `prn`, `aux`, `nul`, `com0`–`com9`,
   `lpt0`–`lpt9`, case-insensitive, whole string) gains a trailing `+`;
8. the result is truncated to 100 characters.

It is therefore **not** a `/` → `+` substitution, and it is **not invertible**:
steps 1, 5, 6 and 8 all lose information. A directory that already contains a
`+` encodes to itself — pnpm 9.15.9 writes `react-dom@19.2.0(react@plus+dir)`
for an importer at `plus+dir` — so decoding `+` back to `/` reads a directory
that does not exist. Resolution runs the ENCODER over each known importer and
matches the locator against its output. The decode-and-walk-up path survives
only for the sub-directory publish below, whose locator belongs to no importer
at all.

The ROOT importer is a special case in both directions. pnpm stores its link
target as the EMPTY string rather than `.`, so the encoding is empty too and the
locator is bare: pnpm 9.15.9 writes `react-dom@19.2.0(react@)` with
`react: 'link:'` in the snapshot's dependency block. An empty version slot is
therefore legal in the suffix grammar, and rejecting it discards the whole
snapshot key.

> **Census owed** · the population these counts came from — 109 locks, described as
> "70 scraped, the real-world fixtures, and the generated adapter matrix" — does not
> exist on disk: it was generated by real pnpm 6/7/8/9/10 during a working session
> and not retained. The reconstructible corpus today is 77 files (70 scraped + 7
> repository fixtures). The observations below are kept because they were made, but
> they are not verifiable until re-run against a named population.

Eleven carry a workspace-directory locator: 208
occurrences resolve to an importer exactly, 50 to a nearest-ancestor importer
(all in `mui/material-ui`, which publishes each member from `<member>/build`),
and none to an unknown directory. No ordinary semver build-metadata tail
(`1.0.0+build`) appears in a peer slot anywhere in that corpus. Every locator
replays byte-identically through `parse` → `stringify` in all eleven files. No
corpus importer directory contains a literal `+` and no corpus peer is satisfied
by the root importer; both shapes come from pnpm 9.15.9 directly.

### `catalog:` protocol (pnpm 9.5+)

- A top-level `catalogs:` block (named catalogs of `name → { specifier }`) plus
  `catalog:` / `catalog:<name>` importer specifiers. The `catalogs:` block is
  preserved **verbatim** on round-trip — losing it orphans every `catalog:` ref
  and yields a structurally-invalid lockfile. A handful of importer-EDGE
  `catalog:` refs (dev-tooling) are a known partial round-trip gap (tracked).

### `packageExtensionsChecksum` (frozen-compare digest)

- A top-level `packageExtensionsChecksum:` scalar — pnpm's digest of the effective
  `packageExtensions` config (from `pnpm-workspace.yaml` / `package.json#pnpm`). pnpm
  recomputes it on every install and **frozen-compares** it; a same-PM round-trip
  that dropped it would leave pnpm seeing "no checksum" ≠ "recomputed checksum",
  forcing a recompute and **breaking `--frozen-lockfile`**. Preserved **verbatim**
  and emitted right after `overrides:`, before `importers:`. It is a digest of the
  *manifest config*, not of the lock graph, so it is carried on the pnpm sidecar
  only and drops naturally on cross-PM conversion (the target has no such config).

### `patchedDependencies` (patch-file declarations)

- A top-level `patchedDependencies:` block — each patched dep `name@version →
  { hash, path }`, where `path` is the repo-relative patch file. pnpm frozen-compares
  it (same `getOutdatedLockfileSetting` path as `overrides:`), so a same-PM round-trip
  that dropped it would break `--frozen-lockfile`. The `path` is **not** recoverable
  from the modeled `patch_hash=<sha256>` snapshot-key markers (which carry only the
  hash), so the block is preserved **verbatim**, emitted after
  `packageExtensionsChecksum:` and before `importers:`. Sidecar-carried → drops
  naturally cross-PM (patch files are pnpm-specific config, not graph state).

### Round-tripped package / snapshot fields

Captured + re-emitted verbatim (each was previously dropped): `libc` and
`deprecated` (`packages`); `transitivePeerDependencies` (`snapshots`);
`peerDependenciesMeta` (`{ <peer>: { optional: true } }` — also mirrored onto the
model's peer-edge `optional` attribute for bound peers, with a verbatim sidecar
carrier for optional peers pnpm never resolved into an edge). `os` / `cpu` /
`engines` / `hasBin` / `resolution.integrity` were already preserved.

`requiresBuild` is not a v9 package or snapshot field. Pinned pnpm 10.34.5
writes it in neither section, matching its absence from a 65-lock v9 corpus.
The adapter therefore does not synthesize the older inline carrier when
emitting this generation.

- A quoted decimal scalar is a **string** and a bare one is a **number**; the
  codec preserves that distinction in every scalar context, including keys.
  A dependency range that looks numeric (`'8'`) must stay quoted or a frozen
  install rejects the lock — see the
  [pnpm-v5 rule](./pnpm-v5.md#numeric-looking-scalars-carry-a-yaml-type).

### `optional` on a snapshot entry

A `snapshots` entry may carry `optional: true`. It belongs to the resolved-tree
record, not to the `packages` metadata baseline — no observed producer writes it
into `packages` on this generation.

The bit is **not** implied by `os` / `cpu` / `libc`. Those gates answer whether a
package is *eligible* on the current platform; `optional` answers whether failing
to materialise an eligible snapshot is *soft*. Both can appear on the same entry
and neither can be derived from the other.

> **Measured** · pnpm 9.15.9 · `pnpm install --frozen-lockfile --offline` against a
> store primed only by the source install · a lock whose snapshot keeps
> `optional: true` installs; the same lock with only that bit removed fails
> `ERR_PNPM_NO_OFFLINE_TARBALL`, because pnpm then treats the reached snapshot as
> mandatory and requests a tarball the source install never needed.

### npm aliases

- A dependency installed under an alias (`react-is-cjs: "npm:react-is@^17"`) is
  keyed in the importer / snapshot dependency block by its **alias**, valued with
  the canonical `<real-name>@<version>(<peers>)`. Round-trips via the edge's
  `alias` attribute.

### `link:` inside a `snapshots` dependency block

A `snapshots[*].dependencies` / `optionalDependencies` value may be
`link:<dir>`. It is a **workspace-directory reference**, not a snapshot
reference: the path is resolved against the **lockfile directory** — not
against the consumer's own location, and not through the snapshot key set.
Measured on pnpm 10.34.5: a lock carrying one installs under
`--frozen-lockfile` (exit 0, lock unrewritten) and materialises
`node_modules/.pnpm/<consumer>/node_modules/<dep> -> ../../../../<dir>`;
retargeting the value at a directory that does not exist still exits 0 and
produces exactly that dangling symlink, so pnpm copies the path through
verbatim without validating it.

Two producers write the shape, and they need different handling:

- A **peer satisfied by a workspace member.** pnpm records it twice — once as
  the [workspace-directory locator](#workspace-directory-peer-locators) in the
  consumer's snapshot key, once as this dependency slot. The model binds the
  peer edge from the key; the slot is a duplicate. A member linked from the
  ROOT importer is written `link:` with no path.
- A **`file:`-protocol directory package** whose own dependencies name sibling
  members (`courses@file:nx-dev/courses` → `docs: link:nx-dev/docs`). No peer
  suffix carries these, so the slot is the sole record of the relationship.

The target is the importer at that directory, or — when the package publishes
from a **sub-directory** of its importer (`link:packages/mui-material/build`) —
its nearest ancestor importer, the same collapse
[`resolveWorkspacePeerId`](#peer-virtualisation-in-snapshot-keys-node-identity)
performs for workspace peers.

What the model does with it follows the seal's rule (ADR-0017 amendment) that a
workspace node accepts an incoming edge only from a workspace node, a **local**
(`resolution: {type: directory}`) package, or a `peer` edge:

| consumer | outcome | diagnostic |
| --- | --- | --- |
| local `file:` package | `dep`/`optional` edge bound to the member | none |
| published, member already bound by the consumer's peer suffix | peer edge models it; slot replayed verbatim | `PNPM_WORKSPACE_LINK_PEER_BOUND` (info) |
| published, no such peer binding | no edge; slot replayed verbatim | `PNPM_WORKSPACE_LINK_EDGE_DROPPED` (warning) |
| directory names no importer | no edge; slot replayed verbatim | `PNPM_UNRESOLVED_DEP` (warning) |

The third row has two real causes: pnpm folded the peer set into a **hashed**
token (`@angular/build@22.0.0-rc.2(53b8fd9b…)`), so the workspace peer is not
recoverable from the key; or a project `overrides:` entry
(`'@nuxt/kit': workspace:*`) redirected a published package's **ordinary**
dependency onto a member, which is not a peer at all.

The two causes are distinguishable without a manifest, because the lock carries
the consumer's own `packages[<bare-key>].peerDependencies` block. All 14
occurrences in the angular fixture are the hashed-token cause: they are the
seven names `@angular/compiler`, `@angular/compiler-cli`, `@angular/core`,
`@angular/localize`, `@angular/platform-browser`, `@angular/platform-server` and
`@angular/service-worker`, across the two hashed `@angular/build@22.0.0-rc.2`
snapshots, and every one of the seven is a declared `peerDependency` of
`@angular/build`. They are the same class of binding as row 2 — a
workspace-satisfied peer — carried by a token the encoding cannot express.
Resolving the `(name@dir)` locator does not reach them: their locators were
replaced by the digest before the lock was written.

Rows 2–4 keep the slot as an unresolved-dependency declaration, which is what
replays the `link:` line at stringify. Row 1 keeps the declared slot name and
the raw locator in the adapter sidecar instead: neither is derivable from the
target, because a pnpm lock names importer members by **directory**
(`packages/tailwindcss@0.0.0`, not `tailwindcss@3.4.0`) and because the
sub-directory collapse above is lossy in the emit direction.

> **Census owed** · the breakdown below does not add up — 32 + 77 + 23 + 0 = 132
> against a stated 133 — and its population is described as "70 scraped + the 6
> real-world fixtures", where the fixture count is 7, not 6. A re-run over the 70
> scraped locks alone finds 7 files, `PEER_BOUND` 48 and `EDGE_DROPPED` 8, which
> reconciles with neither. The figures are held here unverified rather than adjusted
> to sum: picking 132 or 133 would fix the arithmetic and preserve the error.

Census over 77 pnpm locks (70 scraped + the 6 real-world fixtures + generated):
133 occurrences across 12 files — 32 local, 77 peer-bound, 23 unrepresentable,
0 naming an unknown directory. The bound edge carries **no** `workspace: true`
attribute: that flag pairs with `workspaceRange` (ADR-0014 §4.F4) and this
channel records only the resolved directory, never the range the consumer
declared.

## Degradation rules

Same as [pnpm-v6](./pnpm-v6.md#degradation-rules). Multi-hash SRIs round-trip
verbatim within the SRI family — pnpm is an SRI format and emits every member of
the [integrity](./_common.md#3-integrity-model) multiset. Note: pnpm identifies a
registry tarball by its **integrity** (the default registry URL is implicit and
omitted), so converting from a yarn-berry source — which carries only a
`berry-zip` `checksum`, not a tarball SRI ([the berry-zip ≠ tarball-SRI
boundary](./_common.md#33-the-berry-zip--tarball-sri-boundary)) — omits integrity
under the [omit-never-fabricate](./_common.md#34-omit-never-fabricate) posture
(`RECIPE_INTEGRITY_INCOMPLETE`) and leaves such entries without a resolution
anchor until a registry fetch restores it.

For an npm-4 source, the native raw-SRI / path patch carrier is not a pnpm
`patchedDependencies` declaration, and npm manifest-extension fingerprints /
applied provenance have no pnpm-v9 carrier. Non-strict conversion reports both
losses (while retaining representable effective graph edges); strict projection
rejects.

The yarn-berry-v10 pair has the same calibrated boundary as v9 Berry:
workspace node identities are rekeyed across the PMs and Berry zip checksums
cannot become pnpm tarball SRIs. In the reverse direction pnpm's virtual
instance/payload shape and SRI cannot be claimed as a v10 Berry checksum.
Best-effort conversion reports these losses; strict projection requires the
corresponding evidence/remedies.

The transitional yarn-berry-v7 pair is contract-backed with the same profile:
v7 → pnpm-v9 rekeys workspace ids and loses cross-sidecar tarball metadata;
pnpm-v9 → v7 flattens peer-virtual ids, loses tarball metadata, synthesizes the
v7 preamble, and never relabels tarball SRI as a Berry checksum.

## Fixtures

> **TBD:** generate.

## Open questions

> **Open:** capture exact pnpm 10 behavioural shifts (peer auto-install
> defaults, store v6 introduction, etc.) that may affect what the lockfile
> encodes.

## Unknown top-level extension keys

Pinned pnpm 10.34.5 accepts and byte-preserves producer-extension values at the
project root. The adapter deep-clones such values, replays them only for
`pnpm-v9`, and preserves their source key placement; modeled fields always win
on collision. Detached-state and cross-format losses name every
`top-level:<key>` and strict conversion fails closed.

Bit's implementation writes a top-level `bit.depsRequiringBuild` extension
([source](https://github.com/teambit/bit/blob/master/scopes/dependencies/pnpm/lynx.ts)).
No committed Bit-produced lockfile artifact has been located, so this is an
implementation-backed statement, not an artifact-backed corpus claim.
