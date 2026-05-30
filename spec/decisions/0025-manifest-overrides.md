# ADR-0025 — Manifest layer materialisation & dependency-override capture

> Status: `proposed`
> Date: `2026-05-30`

## Context

The library parses lockfiles to a Graph and emits them back, but it has
**no representation of the manifest-level dependency-override mechanisms**
every package manager ships:

- npm `overrides` (root `package.json`; nested, parent-path-scoped, `$name`
  self-refs).
- yarn(-berry) `resolutions` (flat glob-ish patterns: `pkg`, `parent/child`,
  `**/child`, `pkg@range`).
- pnpm `pnpm.overrides` (flat selectors with `>` ancestor chains and
  version-conditional keys: `foo@2`, `a>b`, `>foo`).

A feature sweep of 22 popular real-world repos found these in **14** of them
(yarn `resolutions`: storybook 18 entries, backstage 17, babel 14, jest 10,
+5; npm `overrides`: vscode 5, socket.io 3, TypeScript 1; pnpm `overrides`:
directus 22). They are mainstream, not exotic. The owner's directive: capture
them, and make caller-supplied overrides **part of the stringify options**.

Three facts shape the decision (verified against the fixture corpus):

1. **A canonical `Manifest` type is promised but unbuilt.** ADR-0001 §L1
   lists "declared constraints from `package.json` … overrides" as Manifest
   content. The slots that should hold it already exist but are typed around
   the absence: `ModifyContext.manifests` is `Record<string, unknown>`
   (`modify/context.ts`), and `ParseOptions.manifests` is held back —
   commented out in `index.ts` pending the recipe primitives. Only PM-native
   manifest shapes (`PnpmManifest`, `BunTextManifest`, …) live in adapters;
   no PM-neutral `Manifest` symbol exists in `graph.ts`. Overrides are the
   forcing function to materialise L1 and give those loosely-typed slots a
   real shape.

2. **Only pnpm embeds overrides in the lockfile — and that round-trip is
   already implemented.** The `overrides:` top-level block appears in
   pnpm-lock (directus, vite, supabase, nx fixtures); parse captures it to
   `PnpmSidecar.overrides` and stringify re-emits it via
   `synthesiseOverridePatches`. npm package-lock v2/v3 carries **no**
   `overrides` key (zero across 5 fixtures); yarn-berry's forced resolutions
   appear as ordinary resolved entries, never an overrides block. So the
   work missing is L1 capture + a caller option + npm forward-projection —
   not a pnpm round-trip.

3. **For lockfile→lockfile conversion, overrides are already applied.** The
   lock is a *resolved* artefact (L2 = resolved instances). An override's job
   is to bend resolution; by the time a lock exists that bending is baked
   into the resolved versions. Converting lock→lock lifts L3→L2 then lowers
   L2→L3′; the override never re-runs, so it never needs translating between
   PM grammars for a pure conversion. Cross-grammar override *translation* is
   an N×N table — the alternative ADR-0013 explicitly rejected as
   combinatorial — and ADR-0014 twice defers override semantics to a future
   modifier-class ADR.

This ADR materialises L1 and captures the override *declarations*. It does
**not** attempt cross-PM override translation, and it does **not** address
per-context resolution (the npm deep-nested-hoist round-trip, "#10") — both
are deferred (see §Scope boundaries).

## Decision

**Materialise the L1 `Manifest` type and capture each PM's dependency-override
declaration on it in two coupled forms — verbatim PM-native (attribution) and
a derived canonical superset (load-bearing) — and expose a canonical
`overrides` option on `StringifyOptions` that each adapter projects to its
native form (or emits a loss diagnostic where the lock cannot carry it).**

### 1. The `Manifest` type (L1)

```ts
export interface Manifest {
  name?:        string
  version?:     string
  dependencies?:          Record<string, string>
  devDependencies?:       Record<string, string>
  optionalDependencies?:  Record<string, string>
  peerDependencies?:      Record<string, string>
  workspaces?:            string[]
  /** Canonical, PM-neutral override declarations (see §2). */
  overrides?:   OverrideConstraint[]
  /** Verbatim PM-native blocks, preserved for lossless same-PM round-trip
   *  and forensic fidelity (attribution per ADR-0013). At most one is
   *  populated per source manifest. */
  native?: {
    npmOverrides?:    unknown   // the raw `overrides` object
    yarnResolutions?: Record<string, string>
    pnpmOverrides?:   Record<string, string>
  }
}
```

`Manifest` is a pure data type in `graph.ts` (the PM-neutral core), keyed by
workspace path when supplied as `Record<string, Manifest>` (matching the
existing `ModifyContext.manifests` / `ParseOptions.manifests` references).
The Graph (L2) gains **no** overrides field — overrides are declared inputs,
not resolved instances; putting them on the Graph would collapse the
declared-vs-resolved separation ADR-0001 draws.

### 2. Canonical override form

```ts
export interface OverrideConstraint {
  /** Package whose resolution is forced. */
  package:  string
  /** Optional ancestor scope: the override applies only when `package` is
   *  reached under this consumer chain. Empty = global. One segment for the
   *  common single-parent case; multiple for pnpm `a>b>c` chains. */
  parentPath?: string[]
  /** Optional version condition gating the override (pnpm `foo@2`, yarn
   *  `foo@range`). Empty = unconditional. */
  versionCondition?: string
  /** The forced resolution: a version, range, dist-tag, `npm:` alias, or a
   *  `$name` self-ref (npm). Carried verbatim. */
  to: string
  /** Whether `to` is a `$name` parent-version back-reference (npm), which
   *  has no yarn/pnpm equivalent. */
  selfRef?: boolean
}
```

The canonical superset is modelled on **npm's nested form**, the only one
that expresses parent-scoping; pnpm `>`-chains and yarn flat patterns are
losslessly *derivable* from it, not vice-versa. The three irreducibly
PM-specific tails are recorded but flagged on cross-PM projection:

- npm `$name` self-ref (`selfRef: true`) — relational, no yarn/pnpm form.
- yarn `**/child` unbounded-depth glob — pnpm `>` is single-edge, npm exact-path.
- pnpm leading-`>foo` ("transitive-only") — no clean npm/yarn peer.

### 3. Capture (parse side)

When a manifest is supplied (`ParseOptions.manifests` / a future
`pmConfig`), the recipe layer normalises its PM-native override block into
both `Manifest.overrides` (canonical) and `Manifest.native.*` (verbatim).
This is **recipe feature F6** — the slot ADR-0014 §8 anticipated
("`+overrides=` … new ADR"). pnpm's already-captured `sidecar.overrides`
remains the format-layer round-trip carrier and is unaffected; F6 operates
on the *manifest*, not the lock.

### 4. Caller option + projection (stringify side)

```ts
export type StringifyOptions = {
  lineEnding?:   'lf' | 'crlf'
  cacheKey?:     string
  overrides?:    OverrideConstraint[]   // NEW — canonical, caller-supplied
  onDiagnostic?: (d: Diagnostic) => void
}
```

Per-adapter projection of `options.overrides`:

| PM | Lock target | Behaviour |
|----|-------------|-----------|
| **pnpm** | top-level `overrides:` block | Project canonical → `parent>child` keys; **overlay** onto the captured `sidecar.overrides` (caller wins per key, except synthesised `patch:` entries which win on collision — see §Risks). Hook exists (`synthesiseOverridePatches`); only the option seed is added. |
| **npm** | `packages[""].overrides` | Forward-synthesis only (lock carries none natively): add `overrides` to the root entry. |
| **yarn-berry** | — | No lock projection (resolutions don't reach the lock). Emit `INTEROP_OVERRIDE_NOT_PROJECTED` (warning) rather than silently dropping. |

Cross-PM projection of a constraint whose form has no native equivalent
emits a typed loss diagnostic (§6).

### 5. Reconciliation with `pinOverride` (ADR-0023)

ADR-0023 `pinOverride` is the **imperative** path: a graph mutation that
forces a name's resolution graph-wide and records `MODIFY_OVERRIDE_PINNED`
for stringify. ADR-0025's `Manifest.overrides` / `StringifyOptions.overrides`
is the **declarative** path: an authored block carried through a conversion.
**Precedence:** the declarative L1/option block is the carrier; a
`pinOverride` mutation reconciles *into* it (its pin record merges as an
additional `OverrideConstraint`), not a parallel channel. Where both name the
same package, the imperative mutation wins (it reflects an explicit caller
action on this graph). This **extends** ADR-0023 — which already designates
`Graph.diagnostics()` (not `ModifyResult.unresolved`) as the stringify read
channel for a pin — by adding `Manifest.overrides` as the *declarative*
carrier alongside that imperative diagnostic channel. The two are
complementary inputs to one per-PM projection, not competing channels.

## Consequences

- **Positive:** overrides become first-class — captured from manifests,
  carried losslessly through same-PM round-trips, injectable as a stringify
  option, and projected to npm/pnpm native forms. Delivers the owner's
  "часть опций" directive. Materialises the long-promised L1 `Manifest`,
  unblocking `ParseOptions.manifests` and `ModifyContext.manifests`.
- **Positive:** honours ADR-0013 — the canonical `OverrideConstraint` is the
  load-bearing layer-owned form; the verbatim PM block is attribution. Same
  posture as F1 integrity (canonical SRI + yarn-hex attribution). No N×N
  translation table enters the converter.
- **Negative / risk:** the canonical superset cannot represent three PM tails
  (`$name`, `**/`, leading-`>`) without a documented loss class. Same-PM
  round-trip is lossless; cross-PM manifest projection of a tail-form
  degrades with a diagnostic.
- **Open:** per-context resolution (#10) and **scoped-override application**
  (the *result* of a `parentPath`-bearing override) need the L3 Layout
  structure — deferred to **ADR-0026**. Cross-form override **translation**
  (canonical → a different PM's grammar, with the loss taxonomy) is an opt-in
  `applyOverrides` modifier — deferred to **ADR-0027**, gated on 0025+0026.

## Scope boundaries (explicit non-goals)

- **No cross-PM override translation.** Projection emits the source-form or a
  loss diagnostic; it does not rewrite an npm nested override into a pnpm
  `>`-chain. (→ ADR-0027.)
- **No per-context resolution / #10 fix.** A `parentPath`-scoped override
  *declares* context-specific intent, but applying it (and round-tripping
  npm's emergent per-path divergence) requires L3 Layout. This ADR stores the
  declaration; it does not resolve against it. (→ ADR-0026.)
- **`pnpm.packageExtensions` is not an override.** It is manifest
  *augmentation* (adds deps/peerDeps before resolution — closer to
  `addDependency` at resolve-time). A distinct canonical type and primitive;
  a sibling follow-up, not this slot.

## Diagnostics

| Code | Severity | Fires when |
|------|----------|------------|
| `RECIPE_OVERRIDE_NORMALISED` | info | a manifest override block is captured into canonical form |
| `INTEROP_OVERRIDE_NOT_PROJECTED` | warning | yarn-berry stringify receives `options.overrides` (no lock target) |
| `OVERRIDE_PARENT_REF_DROPPED` | warning | an npm `$name` self-ref is projected to a PM with no back-reference |
| `OVERRIDE_GLOB_NARROWED` | warning | a yarn `**/` deep-glob is projected to single-edge `>` / exact-path |
| `OVERRIDE_TRANSITIVE_HINT_DROPPED` | warning | a pnpm leading-`>` transitive-only selector is projected away |

## Acceptance gates

1. `Manifest` type exported from `graph.ts`; `ParseOptions.manifests` /
   `ModifyContext.manifests` retyped to `Record<string, Manifest>`.
2. Capturing a pnpm/npm/yarn manifest's override block populates both
   `Manifest.overrides` (canonical) and `Manifest.native.*` (verbatim).
3. `StringifyOptions.overrides` projects to pnpm `overrides:` + npm
   `packages[""].overrides`; yarn emits `INTEROP_OVERRIDE_NOT_PROJECTED`.
4. pnpm same-PM round-trip of a lock carrying `overrides:` is byte-stable
   (no regression — the existing sidecar path is preserved).
5. A constraint overlay where `options.overrides` and `sidecar.overrides`
   collide resolves caller-wins, except synthesised `patch:` entries win.
6. The three tail-forms emit their typed loss diagnostics on cross-PM
   projection; the intersection forms project clean.

## Alternatives considered

- *Canonical-on-Graph (sidecar/metadata).* Rejected — overrides are declared
  inputs upstream of resolution, not resolved instances; storing them on the
  Graph collapses the declared-vs-resolved separation (ADR-0001).
- *Recipe-layer auto-translation between PM grammars.* Rejected — the N×N
  table ADR-0013 forbids; override translation belongs in an opt-in modifier
  (ADR-0027), not the always-on recipe/interop path.
- *Three separate verbatim fields, no canonical.* Rejected as the *only*
  representation — it forecloses the option surface and the modifier
  translation; but retained *alongside* the canonical as `Manifest.native.*`
  for same-PM fidelity (the ADR-0013 attribution half).
- *Fix #10 here via a lossy planner / node-fork.* Rejected — node-fork breaks
  NodeId cross-PM byte-identity (ADR-0006); the lossy planner is throwaway
  once L3 lands. #10 is an L3 Layout concern (ADR-0026).

## Links

- `spec/01-model.md` (three-layer), `spec/09-api.md` (Manifest / options)
- ADR-0001 (three-layer model — L1 promised overrides)
- ADR-0013 (PM-native = attribution; canonical = load-bearing)
- ADR-0014 (recipe normalisation — overrides = F6)
- ADR-0021 (npm family — **supersedes** its §"overrides out of scope" carve-out)
- ADR-0023 (`pinOverride` — declarative-vs-imperative reconciliation)
- ADR-0026 (Layout layer / per-context resolution — *deferred dependant*)
- ADR-0027 (scoped overrides + `applyOverrides` translation — *deferred dependant*)
