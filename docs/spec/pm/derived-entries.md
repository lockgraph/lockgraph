# Package-manager-derived lock entries

> Status: **native-probed and corpus-measured reference** for PM-derived
> package facts.
> Updated: 2026-07-26.
> Provenance: official Yarn source plus byte-identical native probes against
> pinned Yarn 4.13.0 and 4.14.1 releases, and npm 12.0.1 native patch /
> extension artifacts.
> Layer: package-manager behavior — the lockfile byte grammar remains in
> [`docs/spec/formats/`](../formats).

A **package-manager-derived lock entry** is an entry whose identity or manifest
facts are introduced by the target package manager rather than read from the
registry package document or the project manifest. It can still refer to a
registry package, but registry metadata alone is insufficient to reconstruct
it.

This distinction matters to converters and lock generators. A registry
completion pass can select versions, mint registry nodes, and follow declared
dependencies. It cannot safely invent a target package manager's internal
patch, compatibility locator, injected dependency, or cache checksum. Those
facts need a target-PM authority and, where they affect frozen-install
acceptance, proof from the exact target producer.

## 1. Classification

Derived behavior is classified by the fact the package manager adds:

| Kind | Added fact | Example | Owning layer |
| --- | --- | --- | --- |
| **Derived locator** | A second locator for an existing package version | Yarn `patch:` locator for a builtin compatibility patch | target-PM post-completion materializer |
| **Target manifest overlay** | Dependencies or metadata absent from the registry observation | Yarn adds `node-gyp: npm:latest` while generating a target lock | target-PM registry view before completion |
| **Source manifest injection** | An edge present in source lock bytes but absent from the published manifest and other PMs' native locks | Berry `nan@2.22.2 → node-gyp@latest` | source-provenance projection before target completion |
| **Derived artifact fact** | PM-specific checksum or condition on the derived locator | Yarn cache-zip checksum on `resolve` and `typescript`; condition/bare checksum on `fsevents` | target-PM materializer, then native emitter |

One behavior may span the three kinds. The `fsevents` builtin-compat behavior
uses all three; `resolve` and `typescript` use the derived-locator and
derived-artifact kinds but need no manifest injection.

The taxonomy classifies **what fact the package manager derived**, not how many
rows its lockfile uses to store that fact. Yarn's builtin patch protocol records
a registry base and a derived `patch:` sibling. npm 12's native patch semantics
belong to the same derived-locator / artifact-fact classes but are stored as one
installed entry carrying `patched: { integrity, path }`. A converter must follow
the producer artifact and must not manufacture npm base/sibling rows by analogy
with Yarn.

This is not a license to infer arbitrary PM behavior. Each target-derived
behavior is a profile row keyed by the package, resolved version, builtin
marker, inner-locator spelling, locator hash, artifact rule, and exact producer
versions. A source-derived edge is removed only for an evidence-backed source
format, exact owner package/version, edge kind/range, and non-Berry target.
Unprofiled observations remain unchanged, unresolved, or unassessed.

## 2. Yarn builtin compatibility patches

Yarn Berry ships a compatibility plugin with builtin patch sources for
`fsevents`, `resolve`, and `typescript`
([official plugin source](https://github.com/yarnpkg/berry/tree/master/packages/plugin-compat/sources/patches)).
The plugin's package extensions are separate from the patch sources
([official extensions source](https://github.com/yarnpkg/berry/blob/master/packages/plugin-compat/sources/extensions.ts)).
The resulting entries use the ordinary Yarn
[`patch:` protocol](https://yarnpkg.com/protocol/patch), but their patch source
is internal to Yarn rather than a project-owned patch file.

The repository fixture corpus contains all three families:

| Builtin family | Corpus occurrences |
| --- | ---: |
| `compat/resolve` | 159 |
| `compat/typescript` | 84 |
| `compat/fsevents` | 72 |

The observed space is 18 distinct `(builtin family, locator hash)` pairs:

- `resolve`: `07638b`, `3388aa`, `3bafbf`, `c3c19d`;
- `typescript`: `1a91c8`, `289587`, `5786d5`, `5adc0c`, `5bf698`,
  `5da071`, `8c6c40`, `a1c5e5`, `bbeadb`, `e012d7`;
- `fsevents`: `127e8e`, `18f3a7`, `d11327`, `df0bf1`.

The corpus also contains three source syntaxes:

```text
#builtin<compat/<package>>
#optional!builtin<compat/<package>>
#~builtin<compat/<package>>
```

Builtin marker and inner-locator spelling are two orthogonal producer-era axes.
The corpus contains 21 bare inner locators such as `resolve@^1.1.6` and 294
`npm%3A`-encoded locators. Real locks with the same `__metadata.version`
contain different markers, inner spellings, and locator hashes. A converter
therefore stores both axes independently and keys synthesis authority by the
complete observed profile rather than by `yarn.lock` format alone.

### 2.1 Identity

A native entry has a locator of the following shape:

```text
<name>@patch:<name>@npm%3A<version>#<builtin-source>::version=<version>&hash=<locator-hash>
```

The six-hex `hash=` value is Yarn locator metadata. It is package-specific, not
a global builtin-compat constant, and it is not the graph model's `Node.patch`.
The graph patch slot uses the unresolved-locator sentinel so that native
emit → parse preserves identity without claiming to possess Yarn's internal
patch file.

### 2.2 Current evidence-backed profile

The following rows are byte-identical under both pinned producers:

| Package | Resolved version(s) | Builtin marker | Inner spelling | Locator hash | Injected dependencies | Derived patch checksum | Pinned producers |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `fsevents` | `2.3.2`, `2.3.3` | `optional!builtin` | `npm%3A`-encoded | `df0bf1` | `node-gyp: npm:latest` | bare | Yarn `4.13.0`, `4.14.1` |
| `resolve` | `1.22.8` | `optional!builtin` | `npm%3A`-encoded | `c3c19d` | none beyond its registry-declared dependencies | `10c0/0446f024439cd2e50c6c8fa8ba77eaa8370b4180f401a96abf3d1ebc770ac51c1955e12764cde449fde3fff480a61f84388e3505ecdbab778f4bef5f8212c729` | Yarn `4.13.0`, `4.14.1` |
| `typescript` | `5.6.2` | `optional!builtin` | `npm%3A`-encoded | `8c6c40` | none | `10c0/94eb47e130d3edd964b76da85975601dcb3604b0c848a36f63ac448d0104e93819d94c8bdf6b07c00120f2ce9c05256b8b6092d23cf5cf1c6fa911159e4d572f` | Yarn `4.13.0`, `4.14.1` |

The two hashed values are Yarn cache-zip digests, not npm tarball integrity.
They are valid only for the exact package bytes, builtin patch, cache key, and
producer profile named by the row.

### 2.3 Conditions and checksum presence

The profiled `fsevents` package is `os=darwin` conditioned and enters Yarn's
optional-build handling. Under the pinned producers its registry base carries a
checksum while the derived patch entry is checksum-bare. The same behavior also
injects `node-gyp: npm:latest`, and both the base and derived patch entries carry
that dependency.

The profiled `resolve` and `typescript` entries are unconditioned. Their
derived patch entries carry cache-zip checksums. `resolve` retains its own
registry-declared dependencies on the derived entry; no target registry overlay
is required for either package.

Checksum presence is therefore a row-owned policy. It is not correct to copy
the `fsevents` bare-patch rule to every builtin patch, or to synthesize a cache
checksum from registry SRI.

## 3. Source-derived `node-gyp` edges

Yarn's `NpmSemverResolver` adds `node-gyp: npm:latest` when a published
manifest declares neither a hard nor peer `node-gyp` dependency and a
lifecycle script mentions `node-gyp` or `prebuild-install`. The dependency is
therefore present in Berry source bytes but absent from npm and pnpm locks
generated from the same package manifest. Carrying the edge into a non-Berry
target changes dependency semantics and exposes a mutable dist-tag descriptor.

The measured corpus contains 86 such edges on 20 package names and 36 exact
owner package/version pairs. Thirty-four occurrences are on `fsevents`; the
other 52 are on 19 unpatched package families, so an unrepresentable builtin
patch cannot block the bad cross-PM projection.

Parsing remains lossless. A source-provenance overlay runs in `enrich/`, where
both source and target formats are known:

- Berry → Berry retains every edge;
- proved Berry v7-v10 → non-Berry removes only a `dep` edge to `node-gyp`
  whose range is exactly `npm:latest`, alias is absent, and owner
  package/version is one of the 36 measured rows;
- Berry v4-v6, other source PMs, unknown owners, other ranges/kinds, and
  author-declared lookalikes remain unchanged.

The exact owner table is implementation data because the source lock does not
mark injection provenance and a package author could declare identical edge
text. The structural spelling alone is never authority. Removal is
deterministic, idempotent, and covered by a `target-compatibility` receipt,
including newly rooted nodes.

## 4. Projection model

Source and target overlays surround ordinary registry completion:

```text
source-provenance carry/drop
  →
package-keyed target registry view
  → generic registry completion
  → package-keyed derived-entry materialization
  → metadata and artifact refurbish
  → optimize
  → strict target projection
```

The target profile row owns:

- package name and proven resolved versions;
- builtin marker, inner-locator spelling, and locator hash;
- dependencies to inject, if any;
- patch checksum policy (`bare` or an exact native-proved cache-zip digest);
- pinned producer format and version pairs.

The registry view changes only rows with declared injections. The generic
completion pass remains the sole resolver and node-minting authority. The
materializer runs only after completion, clones the base's install edges and
canonical package metadata, rewires install consumers to the derived locator,
and stamps only the row-authorized checksum/conditions.

The operation is atomic, deterministic, idempotent, and receipted as a
`target-compatibility` derivation. It remains distinct from a user-requested
`applyPatch` operation.

### 4.1 Public orchestration boundary

The `enrich()` facade is the public entry that owns this order-sensitive
pipeline. The separately exported `completeTransitives` and `refurbish`
functions remain useful primitives, but composing them directly bypasses both
the target-scoped registry view and the post-completion materializer. Such a
graph is correct as parsed and may contain a freshly completed registry base,
yet it is incomplete for a profiled Berry target because the injected
dependency and derived sibling were never created.

Strict projection reports this state as
`COMPLETENESS_TARGET_COMPATIBILITY_OVERLAY_REQUIRED` and directs the caller to
`enrich()`. It does not run the overlay implicitly: materialization is valid
only after accepted completion and before artifact refurbishment. For the same
reason, the order-sensitive `materializeYarnBerryPluginCompat` implementation
remains internal rather than becoming a public primitive that callers could
invoke in the wrong phase.

## 5. Parse recognition versus emit synthesis

Parse-side recognition and emit-side synthesis have different authority
requirements. The parser recognizes `builtin`, `~builtin`, and
`optional!builtin` compatibility sources with either bare or `npm%3A`-encoded
inner locators. It assigns the ordinary unresolved-locator sentinel and reports
that a builtin source is intrinsically not on disk. It never opens a workspace
path named after a builtin source.

Recognition does not authorize synthesis. Emission still requires every
evidence-backed target-profile field, including both syntax axes and the exact
locator hash/checksum policy. This removes the former dead `~builtin` branch
without broadening the synthesis table.

## 6. Fail-closed boundary

A derived entry is materialized only when every row key and prerequisite is
present. The operation fails closed when any of these is unknown:

- package or resolved version;
- target producer version or target lock format;
- builtin source syntax or locator hash;
- required injected dependency after generic completion;
- derived checksum for a row declared `hashed`;
- consumer descriptor or canonical locator identity.

Other versions, the `builtin<...>` and `~builtin<...>` eras, other hashes, and
unpinned producers are not generalized from nearby evidence. A mutable native
install may be able to repair an incomplete lock, but that is not authority for
a generator that promises frozen-install acceptance.

## 7. Parking the next case

When another PM-specific lock entry appears, classify it before implementing
it:

1. Identify which fact is absent from registry/project input: locator,
   manifest overlay, artifact fact, or a combination.
2. Put target-neutral version selection and declared dependency traversal in
   generic completion.
3. Put target-specific manifest changes in a scoped registry view.
4. Put target-specific locators, conditions, and PM artifact facts in the
   target-PM materializer.
5. Add a profile row only after the exact producer generates a byte-identical
   lock and accepts it in its immutable/frozen mode without changing inputs.
6. Keep other versions, eras, and producers fail-closed until independently
   proved.

This placement rule lets the table grow without adding package-name branches to
the algorithm and prevents PM folklore from becoming generic resolution logic.

## 8. Verification standard

Every row in the current table is covered by a fresh local registry fixture and
both pinned Yarn binaries. The oracle requires:

- complete generated `yarn.lock` byte identity with native Yarn;
- exact derived-package subtree identity;
- the row's locator hash and checksum presence/value;
- unchanged project inputs; and
- `yarn install --immutable` exit 0.

The public behavior spec records the evidence boundary. The implementation
decision and graph invariants are in
ADR-0039.
