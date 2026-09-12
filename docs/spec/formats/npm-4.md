# `npm-4` — npm `package-lock.json` (lockfileVersion 4)

> Status: stable (adapter, native-output corpus, byte-identity round-trip, and
> frozen-oracle contract).
> Updated: 2026-07-29.
> Provenance: **Source-only / empirical** — audited against npm 12.0.1 native
> output; npm has not yet published a standalone v4 schema document.

## Compatibility

### Writers

| PM | semver range | Default? | Activation |
|----|--------------|:--------:|------------|
| npm | `>=12` | feature-triggered | native `npm patch`, `packageExtensions`, or `.npm-extension` state |

npm 12 still writes [`npm-3`](./npm-3.md) for an ordinary project. v4 is the
packages-only v3 layout plus native patch / manifest-extension evidence.

### Readers

| PM | semver range | Notes |
|----|--------------|-------|
| npm | `>=12` | applies v4 patch and extension semantics |

npm 11 may accept the JSON and install without rewriting it, but it ignores the
v4 patch carrier. That is not semantic compatibility and must not be treated as
a successful frozen oracle.

## File

- **Filename:** `package-lock.json`
- **Encoding:** UTF-8 JSON
- **Sibling files:** the path named by `patched.path` is required to validate a
  native patch. `package.json` and/or `.npm-extension` remain the authoritative
  extension definitions whose fingerprints appear in the lock.

## Schema sketch

```json
{
  "lockfileVersion": 4,
  "requires": true,
  "packages": {
    "": {
      "packageExtensionsHash": "sha512-...",
      "npmExtensionHash": "sha512-..."
    },
    "node_modules/example": {
      "version": "1.2.3",
      "resolved": "...",
      "integrity": "sha512-...",
      "patched": {
        "integrity": "sha512-...",
        "path": "patches/example@1.2.3.patch"
      },
      "packageExtensionsApplied": {},
      "npmExtensionApplied": {}
    }
  }
}
```

The extension hash / applied pairs are independent: declarative
`packageExtensions` uses `packageExtensionsHash` and
`packageExtensionsApplied`; imperative `.npm-extension` uses
`npmExtensionHash` and `npmExtensionApplied`. The applied objects are native
provenance. Effective grafted dependencies also appear in the normal dependency
maps and are therefore represented as graph edges.

## Capabilities

Inherits [`npm-3`](./npm-3.md), with native per-node patches added.

| Feature | Supported | Notes |
|---------|:---------:|-------|
| Project root / workspaces | ✓ | packages-only install-path map |
| Tarball integrity | ✓ | normal package `integrity` SRI |
| Native patch | ✓ | `patched: { integrity, path }` |
| Manifest-extension evidence | ✓ | root fingerprints plus per-entry applied provenance |
| Cross-PM patch synthesis | ✗ | native raw-integrity carrier cannot be derived from canonical identity alone |

## Patch identity and integrity

The two patch hashes have deliberately different meanings:

- npm's `patched.integrity` is the SHA-512 SRI of the **raw patch file bytes**;
- `Node.patch` is the project's F2 identity over **F5-normalized
  bytes** (UTF-8 BOM removed and CRLF normalized to LF).

When `parse` receives `workspaceRoot`, the adapter reads the confined
`patched.path`, verifies the raw npm SRI, computes the canonical F2 identity,
and emits `RECIPE_PATCH_NORMALISED` if normalization changed the bytes. A path
escape or malformed SRI fails closed. A raw-integrity mismatch emits
`NPM_V4_PATCH_INTEGRITY_MISMATCH`: the graph identity follows the available
bytes while npm's native SRI is preserved verbatim so the drift is neither
hidden nor erased.

Without `workspaceRoot`, or when the confined file is unavailable, the adapter
emits `NPM_V4_PATCH_UNRESOLVED`, assigns a deterministic unresolved sentinel
from the package identity and exact native carrier, then preserves that carrier
in the npm-family sidecar. Same-graph
npm-4 stringify can replay it byte-identically; a foreign or mutated
`Node.patch` without matching native sidecar state is dropped with
`RECIPE_FEATURE_DROPPED` (and strict conversion rejects the loss).

## Manifest-extension evidence

`packageExtensionsHash` and `npmExtensionHash` are validated as exact SHA-512
SRIs, preserved byte-for-byte, and surfaced as observed manifest-knowledge
fingerprints. Their per-package applied objects are treated as opaque native
provenance and replayed exactly. They are evidence of the manifest semantics
used to build the graph, not a portable reconstruction of the source
`packageExtensions` or `.npm-extension` program.

## Conversion inputs

| Operation | Option | Required? | Effect when omitted |
|-----------|--------|:---------:|---------------------|
| Parse | `workspaceRoot` | for resolved patch identity | omitted ⇒ stable unresolved patch sentinel and exact native replay state |
| Stringify | — | none | native patch carrier emits only when it still matches `Node.patch` |

## Retained unresolved declarations

npm-4 inherits npm-3's package-entry declaration carrier. An authored
`dependencies`, `devDependencies`, or `optionalDependencies` member that did
not bind during parse is retained with its owner, kind, name, and range and is
merged back beside graph-derived bound members. Bound graph edges are
authoritative on collision. A target that cannot carry the retained fact fails
strict output with
`COMPLETENESS_OUTPUT_UNRESOLVED_DECLARATION_DROPPED` (irreducible, no registry
remedy).

## Degradation rules

| Feature | Action |
|---------|--------|
| Native npm-4 patch → same graph / npm-4 | replay exact `patched` carrier |
| Foreign or mutated patch → npm-4 | **drop** with `RECIPE_FEATURE_DROPPED`; strict projection rejects |
| Native npm-4 patch → any non-npm-4 format | the raw-SRI / path carrier is not a target-native patch declaration; non-strict conversion reports `PROJECTION_LOSS`, strict projection rejects |
| Extension fingerprint / applied provenance → any non-npm-4 format | effective graph edges remain where representable, but the npm-native fingerprints and applied-provenance carrier are dropped with `PROJECTION_LOSS` (`manifest-extension-provenance`); strict projection rejects |
| Declarative-extension graph → bun-text | bun-text does not encode the npm root workspace version; its flat dependency index also cannot preserve edges to both root `is-number@7` and nested `is-number@6` without source-native de-hoist keys. Non-strict conversion reports the root-identity and edge-target losses; strict projection rejects |

The yarn-berry-v10 pair follows both native boundaries above. npm-4 patch and
manifest-extension carriers have no v10 representation; conversely a Berry
patch identity cannot synthesize npm's raw-SRI/path carrier. Tarball SRI and
Berry zip checksum are different artifacts, so neither is relabelled across the
pair. Best-effort conversion reports every accepted loss; strict projection
rejects until the required evidence is supplied.

## Fixtures and oracle

Genuine npm 12.0.1 artifacts live under
two npm-4 projects: a native patch project and an imperative
`.npm-extension` project. The simple matrix fixture is a genuine declarative
`packageExtensions` lock. Unit coverage checks detection, byte identity,
carrier validation, sentinel behavior, F5 normalization, and fail-closed
foreign patch emission.

npm 12 writes the raw patch SRI itself, and a second mutable install over its
own output leaves the file unchanged — the patch carrier is stable under
regeneration, not merely on first write.

## Unknown top-level extension keys

Pinned npm 12.0.1 accepts and byte-preserves producer-extension values in a
native patch-triggered v4 lock. The adapter therefore deep-clones unmodelled
top-level values, replays them only for `npm-4`, and preserves their source key
placement; modeled fields always win on collision. A detached-state or
cross-format loss names each key as `top-level:<key>` and strict conversion
fails closed.
