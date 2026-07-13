# CONVERT — the conversion reference

How every lockfile format converts to every other: what aligns, what a target
cannot represent (a dedicated **Lost / breaks** column), what must be supplied
from `package.json`, and what — if anything — is pulled from the registry.

## How conversion works

`convert(input, { from, to })` is `parse(from) → Graph → stringify(to)`. The
**Graph** (L2) is the canonical, package-manager-independent model; every format
is just a parser and a stringifier over it. There is no pairwise converter — any
source reaches any target through the one graph.

Conversion is **lossy by design**: the aim is a *semantically equivalent* target
lock, not a byte-copy. Two rules bound the loss:

- **Irreducible facts are never silently lost** — integrity, resolution URLs,
  signatures. When a fact cannot be carried it is **omitted, never fabricated**
  (e.g. a berry-zip checksum has no tarball-SRI form — it is dropped, and the PM
  recomputes it on install, rather than inventing a wrong hash).
- **What the lockfile bytes cannot carry comes from two opt-in sources** —
  `manifests` (the project `package.json`s) and the registry. Everything else
  succeeds offline against the bytes alone.

Formats and the package-manager versions behind them:

| Family | Format ids | PM versions | Lock file |
| --- | --- | --- | --- |
| npm | `npm-1`, `npm-2`, `npm-3` | npm 5–6 / 7–8 / 9+ (lockfileVersion 1/2/3) | `package-lock.json` |
| yarn classic | `yarn-classic` | yarn 1.x | `yarn.lock` |
| yarn berry | `yarn-berry-v4` … `yarn-berry-v10` | yarn 2/3/4 (`__metadata.version` 4–10) | `yarn.lock` |
| pnpm | `pnpm-v5`, `pnpm-v6`, `pnpm-v9` | pnpm 3–7 / 7–8 / 9+ | `pnpm-lock.yaml` |
| bun | `bun-text` | bun 1.2+ (textual `bun.lock`; binary `bun.lockb` is detect-only) | `bun.lock` |
| lockgraph | `lockgraph` | — (the L2 graph serialized; lossless round-trip) | — |

## Expressiveness — what each family can represent

A target loses a feature exactly when it is `✗` for that target but present in the
source. `~` = representable only with `manifests`, or in a degraded form.

| Feature | npm-1 | npm-2/3 | yarn-classic | yarn-berry | pnpm-v5/6 | pnpm-v9 | bun-text |
| --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| Project root in lock | ✗ | ✓ (`""`) | ✗ (rootless) | ✓ (`root@workspace:.`) | ✓ (`importers`) | ✓ (`importers['.']`) | ✓ (`workspaces[""]`) |
| Workspaces (members) | ✗ | ✓ | ~ (needs manifests) | ✓ | ✓ | ✓ | ✓ |
| `workspace:` protocol | ✗ | ~ (`*` + `link`) | ✗ | ✓ | ✓ | ✓ | ✓ |
| Peer virtualization | ✗ | ✗ | ✗ | ✓ (`virtual:`) | ✓ (key suffix) | ✓ (snapshot key) | ✗ |
| `dev` / `peer` edge distinction | ~ (flags) | ✓ | ~ (needs manifests) | ✓ | ✓ | ~ (from reachability) | ✓ |
| `optional` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `peerDependenciesMeta` | ✗ | ✓ | ✗ | ✓ | ✓ | ✓ | ~ (declarative) |
| Overrides / resolutions block | ✗ | ✗ (manifest-only) | ✗ (rewrites entry key) | ✗ (manifest-only) | ✓ (`overrides:`) | ✓ | ✓ (npm-shaped) |
| `patch:` protocol | ✗ | ✗ | ✗ | ✓ (per-node) | ✓ | ✓ | ~ (top-level map only) |
| `conditions` (os/cpu/libc gate) | ✗ | ✗ | ✗ | ✓ (v5+) | ✗ | ✗ | ✗ |
| `catalog:` protocol | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ (9.5+) | ✗ |
| Integrity form | tarball SRI | tarball SRI | tarball SRI | **berry-zip** checksum | tarball SRI | tarball SRI | tarball SRI |
| Bundled deps | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ |

Notes: npm-1 predates workspaces and the `packages` block, so it also has no
`peerDependenciesMeta` / `hasInstallScript` / `engines`-`os`-`cpu` / overrides.
yarn-classic's `~` cells are the **manifest-blindness axis** (below). The berry
integrity form is the single most consequential cross-family break.

## Lost / breaks — the conversion loss table

Organised by feature axis. "Direction" is the family boundary that loses it;
"Recoverable" states whether anything can bring it back.

| Feature lost | Direction (source → target) | Runtime diagnostic | Recoverable? |
| --- | --- | --- | --- |
| **Integrity — berry-zip ↔ tarball SRI** | berry → npm / yarn-classic / pnpm / bun (and back) | `RECIPE_INTEGRITY_INCOMPLETE` | Only by fetching the tarball and **recomputing** the target's hash (opt-in registry). Never fabricated; the PM refills it on install. |
| **Peer virtualization** | berry / pnpm → npm / yarn-classic / bun | `YARN_CLASSIC_PEER_VIRT_FLATTENED` / `NPM_V1_PEER_VIRT_FLATTENED` / `BUN_TEXT_PEER_VIRT_FLATTENED` (per target adapter) | No — flat targets model one instance per (name, version); peer-context forks collapse. |
| **`patch:` protocol** | berry / pnpm → npm / yarn-classic / bun | `RECIPE_FEATURE_DROPPED` (`feature='patch'`) | No — no patch protocol in the target; the patched copy becomes the base package. |
| **`conditions` (os/cpu/libc)** | berry v5+ → any non-berry (and berry → v4) | **— none (silent loss)** | Re-derivable on a completion mint from `os`/`cpu`/`libc` (needs the **full** manifest — corgi omits `libc`). |
| **`workspace:` protocol** | berry / pnpm / bun → npm / yarn-classic | `RECIPE_WORKSPACE_COLLAPSED` (also `_RESOLVED` / `_UNRESOLVED`) | npm keeps members via `packages/<path>` + `link`; yarn-classic keeps them only via manifests (see below). |
| **Overrides / resolutions block** | pnpm / bun (lock carriers) → npm / yarn-classic / yarn-berry (manifest-only) | `INTEROP_OVERRIDE_NOT_PROJECTED` | The resolved *graph* still reflects the pin; the re-emittable overrides *block* is lost. npm & yarn read the policy from the root manifest, never the lock (npm `package.json.overrides`, yarn `resolutions`) — so the declaration is owed to a companion manifest patch (project-level API), never synthesized into a lock the manager ignores. |
| **`catalog:` protocol** | pnpm-v9 → anything | **— none (silent)**; missing target → `RECIPE_RESOLUTION_UNKNOWN` | No equivalent elsewhere; a `catalog:` ref binds to the resolved entry the lock already carries. |
| **`dev` / `peer` classification** | any → yarn-classic **without manifests** | `YARN_CLASSIC_NO_MANIFESTS`; peer edges also `YARN_CLASSIC_PEER_DROPPED` | `dev` is recoverable with `manifests[<path>]`; **`peer` is not** — a `yarn.lock` cannot record it and yarn-classic manifest synthesis reads only `dependencies`. |
| **Bundled deps** | npm → yarn / pnpm / bun | **— none (silent)** | Carried as a `bundled` edge kind in the graph but not re-emitted by non-npm targets. |
| **`peerDependenciesMeta`** | npm-2/3 / berry / pnpm → npm-1 / yarn-classic | `RECIPE_PEER_META_INCOMPLETE` | Re-derivable from the member `package.json` (manifest metadata npm re-adds on install). |
| **Legacy `dependencies` mirror / workspaces** | npm-2/3 → npm-1 | `NPM_V1_WORKSPACES_UNSAFE`, `NPM_V1_PEER_DROPPED`, `NPM_V1_PEER_VIRT_FLATTENED` | No — npm-1 predates workspaces; members are omitted, peer edges dropped, peer context flattened. |
| **Resolution URL** (canonical berry locator) | berry → npm-1/2/3 / bun / pnpm | **— none (silent)**; non-recomposable locator → `RECIPE_RESOLUTION_UNKNOWN` | The registry tarball URL is recomposed from `(name, version)`; a non-registry locator that cannot be recomposed drops. |
| **Multi-descriptor entry-key set** | yarn-classic → berry, berry → yarn-classic | **— none (silent)** | Cosmetic: the merged descriptor set narrows; resolution is unaffected. |

> The codes above are the runtime `onDiagnostic` codes `convert()` actually emits.
> The `INTEROP_*_DROPPED` names used by the interop **test** matrix
> (`src/test/interop/_matrix.ts`) are that suite's observation vocabulary — they
> are synthesized by the harness to assert an expected loss, and never appear in
> a real `onDiagnostic` stream. `RECIPE_FEATURE_DROPPED` fires only for
> `feature='patch'`; the remaining feature losses are either an adapter-specific
> code (above) or silent.

**The two breaks that make a lock non-installable if mishandled** (both now
handled, listed because they are the sharp edges):

- **Monorepos cannot be described in a `yarn.lock` alone.** yarn 1 records a
  workspace member only when something depends on it (a `file:` entry); an
  independent member has no lock entry at all. Converting a yarn-classic
  workspace to npm/pnpm therefore requires **every** member `package.json` via
  `manifests` — the members and their dependency edges are synthesized from the
  manifests. Without them the members vanish and unhoistable transitive versions
  leak into an internal `node_modules/.lockfile-…` store key npm cannot install.
- **The dependency-scope marker (`dev`/`peer`) is not in a `yarn.lock`.** It
  lives only in `package.json`, so yarn-classic → any conversion needs
  `manifests[<workspacePath>]` to recover **`dev`** (and `optional`); without it
  `dev` collapses to `dep`. **`peer` is not recoverable from a yarn-classic
  source** — its manifest synthesis reads only `dependencies`, so a peer edge
  that was never in the lock cannot be re-derived.

## What must come from `manifests` (`package.json`)

`manifests` is keyed by workspace path (`''` = root). It supplies what the
lockfile bytes structurally cannot.

| Needed for | Which manifest | If omitted |
| --- | --- | --- |
| **yarn-classic project root** (rootless source) | `manifests['']` | A top-of-DAG dependency is promoted to the `""` root and its own installable node vanishes → fails `npm ci`. |
| **yarn-classic workspace members** (independent members absent from the lock) | `manifests[<memberPath>]` (every member) | Members are dropped; unhoistable versions leak into `.lockfile-…` keys. |
| **`dev` classification** (any → yarn-classic; workspace-member edges any family) | `manifests[<path>]` | `dev` collapses to `dep`; only `dep`/`optional` are lockfile-derivable. **`peer` is never recovered from a yarn-classic source** — its manifest synthesis reads only `dependencies`. |
| **Non-satisfying `resolutions`/overrides pin** | `manifests['']` (`native.yarnResolutions` / `overrides`) | A pin forcing a version the declared range does not satisfy, with ≥2 candidates, has no unique semver target — without the overrides the edge drops and the dependency disappears. |

Every other family (npm, berry, pnpm, bun) encodes its own root and workspace
members in the lock, so `manifests` is optional for them and only refines
`dev`/`peer`/`optional` classification of workspace-member edges.

## Project companion projection

`projectCompanionsOf(graph, { target, evidence })` projects an authoritative
canonical override policy onto the target manager's project configuration. It
is pure and returns immutable `set` operations; it never reads or writes files.
Each operation replaces only the owned value at its JSON-pointer-shaped path,
creating intermediate containers while preserving sibling fields.

| Target | Companion operation |
| --- | --- |
| npm with override support | `package.json` → `/overrides` |
| Yarn Classic / Berry | `package.json` → `/resolutions` |
| pnpm ≤10 | `package.json` → `/pnpm/overrides` |
| pnpm ≥11 | `pnpm-workspace.yaml` → `/overrides` |
| Bun | `package.json` → `/overrides` |

The result is gated independently from full project conversion: a proven
companion plan may be returned while the broader `project` contract remains
unassessed for package metadata. No patch is returned for ambiguous authority,
an unpinned load-bearing target generation, unsupported policy, or a lossy
grammar projection. Examples that fail closed include nested Bun rules, npm
`$name` references outside npm, Yarn Classic descriptor predicates and direct
dependency overrides, and Yarn Berry selectors deeper than its supported
single-parent form.

For pnpm, the same canonical authority feeds the companion operation, the lock
`overrides:` carrier, and importer specifiers. This is required because frozen
install compares importer specifiers after applying the configured override;
preserving the original direct-dependency range would make an otherwise
matching companion and lock carrier fail `--frozen-lockfile`.

## Bundled project conversion

`convertProject(input, options)` returns a lockfile and its companion operations
only when the complete `project` contract is satisfied. The result is pure and
immutable; the API never reads or writes project files. Failed or unassessed
conversions return only their structured assessment, so callers cannot apply a
partial project bundle accidentally. `projectCompanionsOf` remains available
when a caller intentionally needs the independently proven companion plan.

Repository manifests may be supplied through the existing `manifests` and
`manifestCoverage: 'complete'` convenience fields. `evidenceInputs` accepts
repository manifests, package manifests, and package-manager config authority;
these inputs are applied after the convenience manifest evidence and conflicts
fail closed. Graph-scoped target-oracle evidence is not accepted by this
pre-parse API.

The bundled output, assessment requirements, and native lock policy carrier all
consume one companion-projection runtime. No second post-emission projection is
performed, so the returned operation cannot diverge from the authority used to
emit and assess the lockfile.

## What is pulled from the registry — and why

**Plain conversion never touches the registry.** Every format carries an
integrity hash and a resolution, so `parse → stringify` is fully offline; the one
exception is the berry-zip ↔ tarball-SRI crossing, which *omits* the hash rather
than fetching (the PM refills it on install).

The registry is an **opt-in** adapter (`liveRegistry`, `lockgraph/registry`)
used by three refinement paths:

| Path | What it fetches | Why |
| --- | --- | --- |
| **`completeTransitives(graph, registry, …)`** | the **packument** (all versions of a name), memoised per name, concurrency-bounded | To wire in transitive dependencies a partial lock is missing — turning a manifest-only or shallow graph into a full, installable one. Reads are order-independent (a packument is the same bytes whenever fetched), so the resulting lock is deterministic. |
| **Minting a node** (audit-fix version bump, add-dependency) | the packument **version** → tarball URL + `dist.integrity` / `dist.shasum` | To materialise a version not already in the lock. For a berry target the tarball bytes are then used to **recompute** the berry-zip checksum; corgi (npm's abbreviated packument) **omits `libc`**, so the full single-version manifest is fetched to backfill `conditions … & libc=<glibc|musl>` (else yarn rejects with YN0028). |
| **`audit(registryPackages(graph))`** | raw npm bulk advisories | Security audit of the graph's registry packages (severity and fix-selection stay the caller's). |

Registry routing and auth are resolved from the package-manager config, **never
guessed**, and are ecosystem-scoped (`resolveRegistry(cwd, { ecosystem })` — a
planted `.yarnrc.yml` cannot inject into an npm resolve; npm and yarn directives
never mix). A minted registry tarball is re-hosted onto the lock's own
scope-inferred registry so a `--frozen-lockfile` install does not rewrite it.

## Package-metadata completeness

The `project` contract requires authoritative package manifests for every
non-workspace package used by the graph. `full-packument`, `version-manifest`,
and `tarball-manifest` evidence can establish both presence and absence within
the closed canonical metadata universe; abbreviated/corgi packuments cannot,
because omitted fields such as `libc` and `license` remain unknown.

Coverage alone is insufficient. `packageMetadata: complete` requires the
canonical metadata already stored in each graph tarball payload to equal its
authoritative manifest projection, including authoritative absence. Detached
evidence never substitutes for graph state that an emitter cannot see. Peer
virtual variants share one TarballKey subject. Git, directory, and other
non-registry subjects remain fail-closed until a source-specific manifest
evidence input exists.

Target readiness is assessed separately from canonical completeness. A target
claims support for a metadata field only when its emitter reads that field from
the canonical tarball payload. A present field that the target cannot preserve
makes `project` conversion unsatisfied rather than silently lossy.

## Byte-identity of the target

Freeze-mode acceptance (`npm ci`, `yarn install --immutable`, `pnpm install
--frozen-lockfile`) is the gate — the generated lock must install without a
rewrite.

For **npm and yarn**, the frozen unit is the lock **plus the root manifest**, not
the lock alone: the override policy lives in `package.json` (`overrides` /
`resolutions`), never the lock, so a project that uses overrides needs a matching
companion manifest for the target to freeze-clean — the lock carries the resolved
graph, not the policy. (pnpm/bun persist an in-lock `overrides` carrier and
additionally deep-compare it against config in frozen mode — pnpm 6–10 reject on
mismatch.)

Beyond acceptance, some targets are byte-identical to the PM's own output:

- **npm** emits `json-stringify-nice` key order (matching arborist) and preserves
  `peerDependenciesMeta` / `hasInstallScript`, so a generated `package-lock.json`
  survives even a mutable `npm install` unchanged, not only `npm ci`.
- **yarn-berry** re-emits the canonical preamble, field schedule, quoting, and
  `cacheKey`-prefixed checksums byte-for-byte (checksums recomputed byte-exact for
  cacheKey 7/8/9 via pure-JS; cacheKey 10 via optional `@yarnpkg/libzip`).
- **Cross-family** output is *semantically* equivalent and frozen-clean, but not
  byte-identical to what the target PM would generate from scratch (layout and
  hoisting are re-synthesized; `LAYOUT_PLACEMENT_RESYNTHESISED`).

## Per-family quick reference

Headline for each source family → target family (see the loss table for the
diagnostic codes). "clean" = frozen-clean with no feature loss beyond layout.

| From ↓ \ To → | npm | yarn-classic | yarn-berry | pnpm | bun |
| --- | --- | --- | --- | --- | --- |
| **npm** | clean (v3↔v2; v→v1 drops workspaces/peerMeta) | needs manifests for dev/peer + workspaces | overrides are manifest-only (neither lock carries them); integrity omitted (berry recompute on install) | clean | clean |
| **yarn-classic** | needs manifests (root + members + dev/peer) | — | preamble/workspace synthesized | needs manifests for dev/peer | resolved-URL forms may drop |
| **yarn-berry** | drops peer-virt, patch, conditions; integrity omitted | drops peer-virt, patch, conditions, workspace; needs manifests | clean (v-to-v; v→v4 drops conditions) | drops peer-virt→pnpm keeps it; **integrity omitted** | drops peer-virt, patch, conditions |
| **pnpm** | drops peer-virt, patch, catalog | drops peer-virt, patch, workspace; needs manifests | drops catalog; preamble synthesized | clean (v-to-v; v9↔v5/6 settings drop) | drops peer-virt, patch, catalog |
| **bun** | clean | drops resolved-URL forms; needs manifests | preamble synthesized | clean | — |

`lockgraph` is the lossless waypoint: any format → `lockgraph` → the same format
round-trips graph-identical; it is the model itself serialized, not a PM lock.
