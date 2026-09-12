# `yarn-berry-v4` — yarn berry `yarn.lock` (`__metadata.version: 4`)

> Status: preview (adapter + round-trip tested; family anchor; frozen certification contract available).
> Updated: 2026-07-13
> Provenance: **Source-only**.
> Frozen certification: `prepareFrozen` / `certifyFrozen`; the repository bundles a calibrated Yarn 2.4.3 producer for this schema, and certification requires an exact-version native-PM oracle receipt.

The version-invariant emit contract — the *Graph-level roundtrip*
property, canonical form, field schedule, SYML quoting, line endings,
and `__metadata.cacheKey` threading — is shared across the yarn-berry
family and lives in [`_common.md` §1](./_common.md#1-yarn-berry-emit-invariants-version-invariant);
this spec is the family **anchor** and records the v4-specific deltas
(no `conditions`, bare inner-block dependency ranges, the v4-only
`cacheKey: 7`, the `<cacheKey>/<hex>` checksum-prefix round-trip) plus
the patch-slot recipe detail inline. Graph modification, enrichment and orphan collection are library phases
rather than properties of this file format; they are specified outside this
document and are not needed to read or write a `yarn-berry-v4` lock.

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
  — empirical walk across release tags.

## Schema sketch

Same shape as the later pre-v8 family, but without `conditions`, with
bare inner-block dependency ranges, and with `checksum` values that may
be EITHER a bare sha512 hex OR a `<cacheKey>/<sha512-hex>` prefixed form
— both occur in the wild (see Quirks → checksum cacheKey prefix).

## Capabilities

Parse / stringify / graph-level mutate roundtrip / enrich / optimize
implemented against the fixture matrix at
the per-case `yarn-berry-v4` locks.

## Conversion inputs

Workspaces are named via `name@workspace:path` resolutions inside the
lockfile. File-backed `patch:` fingerprints are not self-contained:
Row 1 reads `.yarn/patches/*` under an explicit `workspaceRoot`;
omission falls through to Row 3.

| Operation | Option | Required? | Effect when omitted |
|-----------|--------|:---------:|---------------------|
| Parse     | `workspaceRoot` | no | File-backed `patch:` locators fall through to Row 3; the adapter MUST NOT default to `cwd` |
| Stringify | —      | none      | |

### Patch slot

For every node whose resolution is a `patch:` locator the adapter
populates `Node.patch` — the per-node carrier for the shared
`+patch=` [`TarballKey`](./_common.md#43-tarballkey) slot
([`_common.md` §2](./_common.md#2-patch-slot--tarballkey-sentinel)).
The adapter computes the fingerprint itself; yarn's `hash=` parameter
is **never** the canonical value — it is recorded as PM-native
attribution per the canonical-vs-PM-native attribution principle
([`_common.md` §2.3](./_common.md#23-canonical-vs-pm-native-attribution-principle))
and surfaced through the format-layer carrier, not on `Node`.

| Locator shape | Canonical input | Hash |
|---|---|---|
| File-backed, e.g. `patch:lodash@npm%3A4.17.21#./patch.diff::version=4.17.21&hash=…` | patch source bytes (the `.patch` file referenced by the `#./<path>` fragment) | sha512, lower-case hex, no prefix |
| `~builtin<compat/…>`, e.g. `patch:typescript@npm%3A5.4.5#~builtin<compat/typescript>::…` | UTF-8 bytes of `<yarn-major>:<locator>` where `<locator>` is the bare `~builtin<…>` slice (strip `patch:<spec>#` prefix and `::<params>` suffix), e.g. `4:~builtin<compat/typescript>`. yarn-major is an ambient-state input sourced from the install context when present; un-sourceable at parse time falls through to Row 3 | sha512, lower-case hex, no prefix |
| Patch input unreachable at parse time (CI artefact stripped of `.yarn/patches/`, omitted `workspaceRoot`, slim source tarball, hand-edited entry, or `~builtin<…>` with un-sourceable yarn-major) | UTF-8 bytes of the locator string **as recorded in the lockfile** — `::<params>` (`::version=…`, `::hash=…`, …) included | sentinel `unresolved-<sha256-hex>`; emit `warning` diagnostic |

**Routing.**

*Row 1* fires when (a) the locator shape is `patch:<spec>#<path>::…`,
(b) the path resolves workspace-contained, and (c) the source bytes
are readable. On (b) violation (`..`-escape, absolute path, Windows
drive, symlink): throw `LockfileError({ code: 'INVALID_INPUT' })`
per [Path confinement](#path-confinement) and terminate the parse —
caller-supplied path escapes the workspace, malformed input. On (a)
or (c) violation: fall through to Row 3 — the input is well-formed
but the canonical recipe cannot run.

*Row 2* fires when (a) the locator is `~builtin<…>` and (b)
yarn-major is sourceable from the ambient install context. On (b)
violation: fall through to Row 3 — recipe input absent.

*Row 3* covers the residual. Sentinel covers "recipe input absent";
INVALID_INPUT covers "caller provided malformed input".

**Notes on recipe-input scope.**

- *Row 2 (`<locator>`).* Bare `~builtin<…>` slice — strip the
  `patch:<spec>#` prefix and any `::<params>` suffix. Worked
  example: lockfile entry
  `patch:typescript@npm%3A5.4.5#~builtin<compat/typescript>::version=5.4.5&hash=abc123`
  → extracted slice `~builtin<compat/typescript>` → fingerprint
  input `4:~builtin<compat/typescript>` (the shared built-in recipe,
  [`_common.md` §2.1](./_common.md#21-the-patch-slot)). *Why bare
  slice:* yarn-berry ships one compat bundle
  per (yarn-major, `~builtin<…>` token) regardless of the patched
  package's version embedded in the envelope; the slice
  disambiguates compat bundles, the envelope adds spurious version
  dependence that would over-fragment the dedup space.
- *Row 3 ("verbatim").* The locator string **as recorded in the
  lockfile**, `::<params>` included. *Reject* the surface read that
  `::<params>` should be stripped as PM-native attribution under the
  attribution-vs-key principle
  ([`_common.md` §2.3](./_common.md#23-canonical-vs-pm-native-attribution-principle)):
  that principle governs the *canonical* namespace where input
  divergence breaks dedup; the sentinel namespace is by design
  PM-native and explicitly degraded
  ([`_common.md` §2.2](./_common.md#22-the-unresolved-sha256-sentinel))
  — two adapters reading the same artefact with different input
  encodings produce different sentinels intentionally, and sentinels
  do NOT participate in cross-PM identity.

Sentinel-keyed entries are read-only at the mutator layer per
[`_common.md` §4.5](./_common.md#45-mutator-coherence).

### Path confinement

The path component of a file-backed `patch:` locator (the segment
after `#`, before `::`) MUST resolve to a file under the workspace
root in the stable filesystem view the parser observes. Static
violations throw `LockfileError({ code: 'INVALID_INPUT' })` with the
offending locator in the diagnostic message.

- **Walk.** Percent-decode the path component; treat the result as
  posix-style. Reject absolute paths and Windows drive-letter
  prefixes outright. Join to the workspace root and lexically
  normalise (collapse `.`, `..`); reject if any `..` survives the
  collapse, or if the normalised result is not a strict descendant
  of the workspace root.
- **Symlinks.** Pure-JS implementations may `lstat`-walk existing
  components, open the leaf with `O_NOFOLLOW`-equivalent semantics,
  require `fstat` regular-file, and re-check containment from the
  opened fd when the runtime exposes an fd-path primitive. This MUST
  reject static symlinks and leaf swaps; a parent-directory swap
  between the walk and the leaf open remains an accepted pure-JS
  residual. A dirfd/`openat` walker is stronger, not required.
- **Hardlinks.** Permitted within the workspace filesystem. A
  hardlink cannot cross filesystem boundaries, so the workspace
  containment check carries through; no separate hardlink check is
  required.
- **FDs.** One open file descriptor per concurrent fingerprint
  computation. Read fully, close, then hash. The adapter MUST close
  the descriptor before returning the fingerprint — no FD outlives
  the patch-extraction call.

### Patch-descriptor edges

A dependency may reference its target **directly through a `patch:`
descriptor** — `"<dep>": "patch:<inner>#<patchPath>"` in a consumer's
`dependencies` / `optionalDependencies` block — rather than through a
plain `npm:` range. The consumer edge MUST resolve to the **patch
node** (the `+patch=unresolved-…` sentinel node carrying that locator),
not to the plain `npm:` base node, and not be dropped.

Two consumer forms occur in the wild; **both** resolve to the patch
node:

- **Form a — plain `npm:` range, patch on the entry's resolution.** The
  consumer declares `"<dep>": "npm:<ver>"` and the bound entry keeps the
  key `<dep>@npm:<ver>` while recording the patch only on its
  `resolution:` (e.g. resolution
  `lodash@patch:lodash@npm%3A4.17.21#./.yarn/patches/…::version=…&hash=…&locator=…`).
  Here the entry key IS the consumer's descriptor, so the ordinary
  spec-index lookup already lands on the patch node — no special handling.
- **Form b — `patch:` descriptor.** The consumer declares
  `"<dep>": "patch:<inner>#<patchPath>"`. Yarn binds an extra
  `::version=…&hash=…[&locator=…]` parameter block onto the patch
  **entry key** (`<dep>@patch:<inner>#<patchPath>::version=…&hash=…`)
  that the consumer's descriptor omits, so the bare descriptor never
  matches the entry key verbatim. The adapter resolves it by **stripping
  that trailing `::`-param block** from each patch entry's spec — taking
  everything up to the first `::` that follows the first `#` (yarn percent-encodes any
  inner locator's `#` as `%23`, so the first literal `#` is the outer
  patch-path separator) — and
  binding the consumer descriptor to the entry that strips to the same
  key. The descriptor's percent-encoded inner spec (`npm%3A…` decodes to
  `npm:…`, i.e. `lodash@npm:4.17.15`) is the identity that makes
  descriptor and locator share that stripped prefix.

**Multi-consumer disambiguation.** The same patch file applied from
different workspaces produces several distinct patch entries that strip
to one descriptor, told apart only by their `&locator=<encoded-consumer>`
qualifier (the same qualifier the `link:` / `portal:` reconstruction
uses). When more than one patch entry shares a stripped descriptor, the
consumer edge binds to the entry whose `&locator=` equals
`encodeURIComponent(<the consumer's own resolution>)`, mirroring the
`link:` / `portal:` per-consumer reconstruction. A single candidate binds
unconditionally; an ambiguous descriptor with no matching `&locator=`
stays unresolved and emits `YARN_BERRY_UNRESOLVED_DEP` rather than
guessing.

### Descriptor→node resolution ladder (shared)

The patch-descriptor and `link:` / `portal:` reconstructions above are
**Rung 1** of the version-invariant yarn-family descriptor→node ladder —
normative source [`_common.md` §5](./_common.md#5-descriptornode-resolution-yarn-family-parse).
The berry rungs are: Rung 0 (exact entry-key match) → **Rung 1** (the
patch-descriptor + `link:`/`portal:` `::locator=` fallbacks documented here)
→ Rung 2 (override map) → Rung 3 (source-gated max-satisfying semver) → Rung 3.5
(dist-tag — a `latest`/`next` descriptor binds the single registry sibling; ≥2
siblings → drop) → Rung 4 (`YARN_BERRY_UNRESOLVED_DEP` drop). Rungs 1–3.5 run
**only** on a Rung-0 miss, so the steady-state cost is one lookup. A registry edge
that bound a base node with a sibling `patch:` copy is additionally re-targeted by
the **patch-preference overlay** ([`_common.md` §5.5](./_common.md#55-patch-preference-lock-borne),
`YARN_BERRY_*_PATCH_PREFERRED` info) — the lock-borne `patchedDependencies`
behaviour, with the base left GC-able.

Rungs 2–3 close Bug #99: a yarn `resolutions` pin **rewrites the affected
entry key to the pinned descriptor** and drops the consumer's range, so a
consumer still declaring `csstype: "npm:^3.1.3"` misses Rung 0. The pin can be
**non-satisfying** (`3.0.9` ∉ `^3.1.3`) and can target a non-version
(`patch:` / `portal:`), so the **override map** (Rung 2) is required — and
since yarn writes no lock-borne resolutions, it exists only when the caller
passes `manifests` (captured per published
ADR-0025). Without `manifests`,
Rung 3 recovers only the *satisfying* slice (source-gated to registry tarballs
per [`_common.md` §5.3](./_common.md#53-the-source-awareness-invariant) — an
`npm:` range never binds a git / directory / unknown node); a non-satisfying
miss drops with `<prefix>_RESOLUTION_PIN_UNRESOLVED` (info, e.g.
`YARN_BERRY_V4_RESOLUTION_PIN_UNRESOLVED`). A Rung-3 max-satisfying tie emits
`<prefix>_AMBIGUOUS_RESOLUTION` (warning) and drops without guessing.

## Integrity

The model is the shared [`_common.md` §3 integrity model](./_common.md#3-integrity-model);
this is only how yarn-berry v4 *carries* it.

- Integrity is the per-entry `checksum:` field, parsed with
  `parseBerryChecksum` (shared `_yarn-berry-core.ts`). A yarn-berry checksum
  is a **sha512 of yarn's post-processed zip-cache, NOT the tarball**, so it
  is tagged `origin: 'berry-zip'` and is **not** interchangeable with a
  tarball SRI ([`_common.md` §3.3](./_common.md#33-the-berry-zip--tarball-sri-boundary)).
  It is **not directly tarball-verifiable** — verifying it requires
  reproducing yarn's zip transform.
- **Body shape (v4, `checksumPrefix: false`).** The default v4 shape is bare
  `<128-hex>`, but real yarn-2.0 v4 locks write the **prefixed**
  `<cacheKey>/<128-hex>` form (e.g. `2/<hex>`). `parseBerryChecksum` accepts
  both; the cacheKey prefix is captured per-node
  (`TarballPayload.berryChecksumCacheKey`) and re-emitted verbatim — see
  [Emit](#emit) and [Quirks](#quirks).
- Converting **into** v4 from a tarball-only source (npm / pnpm / bun /
  yarn-classic) yields **no** `berry-zip` digest, so `checksum:` is **omitted**
  with `RECIPE_INTEGRITY_INCOMPLETE` rather than fabricated from a tarball
  sha512 ([`_common.md` §3.4](./_common.md#34-omit-never-fabricate)); yarn
  recomputes it on install.

## Emit

Emit (`stringify(graph, options?)`) is governed by the shared,
version-invariant yarn-berry emit contract
([`_common.md` §1](./_common.md#1-yarn-berry-emit-invariants-version-invariant)
— *Graph-level roundtrip* property, canonical preamble, block ordering,
entry-internal field schedule, SYML quoting predicate, indent, line
endings, `__metadata.cacheKey` threading, non-goals), evaluated against
the v4 fixture set via the acceptance gate
([`_common.md` §1.9](./_common.md#19-acceptance-gate)). The v4-specific
emit deltas layered on top of that contract:

- `__metadata.version` emits the literal `4`.
- `__metadata.cacheKey` defaults to absent; when present (caller-supplied
  via `options.cacheKey` or sidecar-preserved from parse) it emits as
  a bare numeric literal (`cacheKey: 7` empirically — note the v4-only
  value differs from v5/v6's `8`) — pre-v8 form, no string quoting.
- Inner `dependencies` / `optionalDependencies` emit the bare form
  (for example `lodash: 4.17.21`), not v8/v9's quoted protocol. An unmodified
  source-authored explicit plain range (`lodash: "npm:4.17.21"`) replays with
  that exact prefix; mint, mutation/rebind, and cross-generation output remain
  bare. A structural self-alias (`lodash: "npm:lodash@4.17.21"`) always retains
  `npm:<target>@`, because that prefix carries target identity rather than
  source-only default-protocol spelling.
- `checksum` values ROUND-TRIP whatever was parsed (a `berry-zip`-origin
  hash under the shared integrity model,
  [`_common.md` §3](./_common.md#3-integrity-model); berry↔berry is a pure
  hex re-encode of the same zip-cache digest per the berry-zip ≠
  tarball-SRI boundary,
  [`_common.md` §3.3](./_common.md#33-the-berry-zip--tarball-sri-boundary)):
  if the source carried a `<cacheKey>/<hex>` prefix (yarn-2.0 writes
  `2/<hex>`) the same prefix is re-emitted; a bare source stays bare. The
  cacheKey
  is captured per-node on parse (`TarballPayload.berryChecksumCacheKey`)
  rather than from `__metadata.cacheKey`, since yarn-2.0 v4 omits the
  `__metadata.cacheKey` line yet still prefixes each checksum. This is
  intentionally NOT version-gated: dropping the prefix for v4 while
  keeping v8's `10c0/` would be an internal inconsistency that yields a
  lockfile `yarn install --immutable` rejects. (`config.checksumPrefix`
  is `false` for v4 and now only governs the cross-family-convert default,
  not same-format round-trip.)
- `conditions` are NOT supported on emit (v4 predates the field;
  v5 introduced it). `conditions` is a verbatim SCALAR token (e.g.
  `os=darwin & cpu=arm64`) captured per-node as a `Map<string,string>` of
  nodeId → scalar — NOT a structured block. If a parsed/synthetic graph
  carries such a captured scalar, the v4 emitter drops it with diagnostic
  `YARN_BERRY_V4_CONDITIONS_DROPPED`.
- `compressionLevel` is not present in the v4 corpus.

## Quirks

- `__metadata.cacheKey` is empirically `7` across the current v4 fixtures.
- Inner `dependencies` / `optionalDependencies` emit bare ranges
  (`lodash: 4.17.21`), unlike v8/v9's quoted protocol form. A **complex**
  range stays bare too — `js-tokens: ^3.0.0 || ^4.0.0` is emitted unquoted,
  NOT `"^3.0.0 || ^4.0.0"` (F3c/#106): the SYML quoting predicate
  ([`_common.md` §1.5](./_common.md#15-quoting-the-syml-quoting-predicate))
  permits interior spaces and `||` in the body, so only a leading `>` or a
  `:` (the v8/v9 `npm:` protocol prefix) forces the quotes. Per-peer
  `peerDependencies` ranges follow the same rule (`react: ^16 || ^17` bare).
- **Source-authored explicit plain `npm:` is preserved.** The measured v4
  corpus contains 43 such values across three locks: the exact Yarn rc.18 and
  rc.19 locks each carry one and require it for unchanged replay, while one
  unattributed later lock carries 41. Canonical rc.28 rejects an injected
  explicit prefix for a bare source and normalises it away on write; rc.28,
  rc.29, and rc.31 also lack `__metadata.cacheKey`, so lock bytes provide no
  generation discriminator. These producer requirements **cannot both be
  satisfied by a single unconditional spelling rule**. The adapter deliberately
  preserves source spelling for unchanged v4 replay and emits bare for mint,
  mutation/rebind, or conversion. This is the source-presence sidecar boundary
  in [`_common.md` §4.4](./_common.md#44-graph), not an always-prefix rule.
- `checksum` cacheKey prefix: BOTH shapes occur in the wild. yarn-2.0
  (the earliest v4 producer) writes `checksum: 2/<sha512-hex>` — the same
  `<cacheKey>/<hex>` shape v8/v9 use (`10c0/…`) — with NO
  `__metadata.cacheKey` line. Later v4 producers (and the synthetic
  the per-case v4 locks) write
  a bare sha512 hex. The library preserves whichever was parsed, per-node;
  see Emit.
- `conditions` are absent in the current v4 fixtures and unsupported on
  emit; the field is a verbatim SCALAR capture (a `Map<string,string>` of
  nodeId → scalar token), not a structured block. If a parsed/synthetic
  graph carries such a captured scalar, the v4 emitter drops it with
  `YARN_BERRY_V4_CONDITIONS_DROPPED`.
- `linkType: hard` vs `soft` distinguishes copied/extracted deps (registry,
  git, tarball, `patch:`) from filesystem-in-place deps (`workspace:`, `link:`,
  `portal:`, a `file:` directory link). Derived on emit — see
  [`_common.md` §1.4.1](./_common.md#141-linktype--languagename-derivation-95).
- Virtual instances appear with `virtual:<random>#<base-resolution>` keys.
  These are PEER-RESOLVED forks of one underlying package — modelled in the
  graph layer as distinct peer-context NodeIds
  ([`_common.md` §4.1](./_common.md#41-nodeid), the readable grammar that
  replaces yarn-berry's opaque `virtual:<hash>#…` form).
- Multi-spec keys (`"foo@npm:^1, foo@npm:^1.2":`) common — single value per
  entry.

## Degradation rules

| Feature | Action |
|---------|--------|
| Patches → npm-* | **strip** with diagnostic |
| Virtual instances → npm-* | **flatten** to underlying resolution |

For an npm-4 source, the native raw-SRI / path patch carrier is not a
yarn-berry patch locator, and npm manifest-extension fingerprints / applied
provenance have no v4 carrier. Non-strict conversion reports both losses (while
retaining representable effective graph edges); strict projection rejects.

For a yarn-berry-v10 source, the calibrated body is the same Berry graph shape
but v4 cannot encode `conditions`. The emitter drops that scalar with
`YARN_BERRY_V4_CONDITIONS_DROPPED`; the reverse direction synthesizes the v10
marker without inventing conditions. Berry zip checksum bytes remain
origin-compatible and are re-encoded in the target version's checksum syntax.

The complete pair matrix also pins v4 ↔ npm-{1,2} and v4 ↔ pnpm-v{5,6}.
On v4 → npm-1 the nested-tree target loses some edges, canonical resolution
URLs, tarball payload metadata, and patch slots; v4 → npm-2 loses the canonical
resolution URL. The reverse npm-1 path preserves the representable graph and
synthesizes only the v4 preamble, while npm-2 → v4 also loses target tarball
payload metadata. Across pnpm, v4 → pnpm rekeys workspace identities and loses
tarball metadata; pnpm → v4 flattens peer-virtual ids, loses tarball metadata,
and synthesizes the v4 preamble. Tarball SRI and Berry zip checksums remain
different origins in every direction and are omitted, never relabelled.

## Fixtures

Per-case locks and whole-project samples, as described in [Evidence](./README.md#evidence). A claim resting on a real-world lock cites it by upstream identity at the point it is made.

## Open questions

> None at preview. Fixture verification matched the documented v4
> deltas on every observed field: handshake `4`, cacheKey `7`, bare
> inner dep ranges, no `conditions`, and no `compressionLevel` in the
> current fixture corpus. NOTE (F1, snapshot.50 round-trip sweep): the synthetic fixtures
> use a bare checksum, but real yarn-2.0 v4 locks write the prefixed
> `checksum: 2/<hex>` form; the library round-trips either per-node
> (`TarballPayload.berryChecksumCacheKey`). See Emit / Quirks.

## Unknown `__metadata` keys

Pinned Yarn 2.4.3 removes an unrecognised `__metadata` subkey during a mutable
install. The same unstripped lock is rejected by `--immutable`, while the
repaired lock is accepted. Accordingly non-strict emit removes the key and
reports `YARN_BERRY_V4_UNKNOWN_METADATA_DROPPED` with the full
`__metadata.<key>` path; strict emit fails closed. This producer-faithful repair
can improve an input that was already invalid for immutable CI. `version` and
`cacheKey` are the recognized metadata fields; the pinned producer also removes
the legacy-looking `compressionLevel` subkey.
