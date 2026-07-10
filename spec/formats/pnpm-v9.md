# `pnpm-v9` — pnpm `pnpm-lock.yaml` (lockfileVersion 9)

> Status: stable (adapter + pnpm-flat round-trip suite; packages/snapshots split covered).
> Updated: 2026-06-16
> Provenance: **Source-only**.

## Compatibility

### Writers — PM semvers that *emit* this format

| PM | semver range | Default? | How to opt in |
|----|--------------|:--------:|---------------|
| pnpm | `>=9`  | ✓ | pnpm 9 jumped lockfileVersion from 6.x to 9.0; both 9.x and 10.x default to `'9.0'` |

### Readers — PM semvers that *install* from this format

| PM | semver range | Notes |
|----|--------------|-------|
| pnpm | `>=9`  | a writer must be its own reader; both pnpm 9.x and 10.x read and write `'9.0'` |

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

- Two top-level blocks instead of one — `packages` (immutable manifest
  data: resolution, integrity, engines) and `snapshots` (resolution-time
  data: dependency edges, peer bindings). One package can have many
  snapshots when peer-virtualisation creates instances.
- The leading slash in package ids was dropped (`foo@1.0.3` instead of
  `/foo@1.0.3`).
- pnpm jumped lockfileVersion `6.x` → `9.0` directly. **There is no
  v7 or v8 schema in the wild.** Both pnpm 9.x and pnpm 10.x default to
  `'9.0'`; what differs between them is engine behaviour, not the
  written lockfile schema.
- The `packages` / `snapshots` split mirrors our internal model
  (package metadata vs peer-bound instance) — `packages` carries the
  identity-neutral tarball surface (`TarballKey` → `TarballPayload`),
  `snapshots` carries the peer-bound node instances (`NodeId`); see
  [_common.md §4.1](./_common.md#41-nodeid) and
  [§4.3](./_common.md#43-tarballkey).

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
  it is an OPAQUE, non-edge-bearing peer-context discriminator, kept verbatim in
  node identity so distinct hashed instances stay distinct. The same
  `name@version` may appear under several distinct hashes.
- Both collapse classes are guarded by a pnpm-specific resolution verifier:
  every declared dep/dev/optional edge must resolve, through the emitted
  adjacency, back to its target id — a miss surfaces as a soft, pnpm-specific
  `LAYOUT_RESOLVE_VIOLATION` [Diagnostic](./_common.md#4-reserved-vocabulary)
  (`warning` severity, never a throw).

### `catalog:` protocol (pnpm 9.5+)

- A top-level `catalogs:` block (named catalogs of `name → { specifier }`) plus
  `catalog:` / `catalog:<name>` importer specifiers. The `catalogs:` block is
  preserved **verbatim** on round-trip — losing it orphans every `catalog:` ref
  and yields a structurally-invalid lockfile. A handful of importer-EDGE
  `catalog:` refs (dev-tooling) are a known partial round-trip gap (tracked).

### Round-tripped package / snapshot fields

Captured + re-emitted verbatim (each was previously dropped): `libc` and
`deprecated` (`packages`); `transitivePeerDependencies` (`snapshots`);
`peerDependenciesMeta` (`{ <peer>: { optional: true } }` — also mirrored onto the
model's peer-edge `optional` attribute for bound peers, with a verbatim sidecar
carrier for optional peers pnpm never resolved into an edge). `os` / `cpu` /
`engines` / `hasBin` / `resolution.integrity` were already preserved.

### npm aliases

- A dependency installed under an alias (`react-is-cjs: "npm:react-is@^17"`) is
  keyed in the importer / snapshot dependency block by its **alias**, valued with
  the canonical `<real-name>@<version>(<peers>)`. Round-trips via the edge's
  `alias` attribute.

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

## Fixtures

> **TBD:** generate.

## Open questions

> **Open:** capture exact pnpm 10 behavioural shifts (peer auto-install
> defaults, store v6 introduction, etc.) that may affect what the lockfile
> encodes.
