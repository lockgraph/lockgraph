# ADR-0025 — Manifest layer materialisation & dependency-override capture

> Status: `proposed`
> Date: `2026-05-30`
> Amended: 2026-05-30 — §6 Override exposure (A2): `overridesOf(graph)` accessor + graph-keyed manifest carrier.

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

### 6. Override exposure — `overridesOf(graph)` (A2)

§3 captures a manifest's overrides; §4 projects a *caller-supplied* option. The
missing link is **cross-PM carry**: yarn resolutions live only in
`package.json` (never the lock), so `parse('yarn-berry-v9', lock, { manifests })`
→ `stringify('npm-3', g)` has no path for the resolutions to reach the npm
projection. Lock-borne overrides (npm `rootMeta.overrides`, pnpm
`sidecar.overrides`) sit in format-private sidecars the caller cannot read.

**Decision — explicit accessor, caller threads (model E2):**

```ts
export function overridesOf(graph: Graph): OverrideConstraint[]
//   → stringify(to, g, { overrides: overridesOf(g) })
```

A free function (matching `getFlatSidecar(graph)` / `frozenRegistry(graph)` —
graph-*associated*, format/recipe-derived state is a free function over `Graph`;
`Graph` *methods* are reserved for intrinsic L2 structure). It returns the
**union** of every captured override source for the graph, canonical:

- **manifest-F6** — when `ParseOptions.manifests` is supplied, `parse` runs
  `captureOverrides` on each manifest's `native` block and stashes the canonical
  result on a **recipe-owned `WeakMap<Graph, OverrideConstraint[]>`** carrier.
- **lock-borne** — npm `rootMeta.overrides` (already canonical) / pnpm
  `sidecar.overrides` (verbatim → canonicalised on read). Exactly one is ever
  populated (a graph is parsed from one format).

**Precedence.** Collisions are keyed by the tuple
`(package, parentPath, versionCondition)`, where `parentPath` compares as an
**ordered** sequence by element-wise string equality (join on the reserved `>`
separator for the map key — `a>b>c`). Manifest-F6 wins over lock-borne — the
manifest is the *current authored declaration*; the lock is a resolved snapshot
with the override already baked in. This mirrors the §4 stringify ladder
(caller-authored beats lock-borne `nativeOverrides`); `overridesOf` is the
programmatic "what the caller would supply", feeding that ladder's tier-1 slot.
Within one source, last-wins on duplicate tuples. A `selfRef`/`to` divergence on
an otherwise-equal tuple is moot across sources (manifest wins outright) and
last-wins within a source.

**Empty, never `undefined`.** `[]` means "found none from *any* source" (data),
distinct from *omitting* the stringify option (which triggers the §4 lock-borne
fallback). Because `overridesOf` folds lock-borne **into** its union,
`overridesOf(g) === []` genuinely means no overrides anywhere, so threading it
can never suppress a lock-borne block `overridesOf` would itself have surfaced.
Callers **MUST NOT** hand-thread `[]` from some *other* source into
`StringifyOptions.overrides` expecting the lock-borne fallback — pass `undefined`
(omit the option) for that.

**Layering.** Recipe is *below* format; it must not import the npm/pnpm cores.
So the recipe layer owns only the manifest carrier WeakMap + the merge helper;
the source-unifying `overridesOf` lives in `index.ts` (the one module that
imports every format), delegating per-format reads to small exported accessors
(`getFlatSidecar`; a new pnpm `getPnpmOverridesCanonical`). Placing the unify in
recipe would create a recipe→format cycle.

**Carrier lifecycle (normative).** The WeakMap carrier is dropped by every
`graph.mutate()` / enrich / optimize (which rebuild the graph). The format
sidecars survive only because each re-attaches via a per-format
`rebindGraph(oldGraph, newGraph)` hook (`_npm-flat-types.ts`); there is **no**
shared mutate-rebind hub in `graph.ts`. The recipe carrier MUST register an
analogous rebind callback — and, since the consumer flow is parse → **modify** →
stringify (audit-fix), that callback MUST be invoked from the modify/optimize
rebuild path, **which does not exist today** (the existing `rebindGraph` fires
only at npm stringify-time). Wiring a modify-side rebind invocation is part of
this slice; without it `overridesOf` silently returns `[]` after the first
mutation, inside the consumer's pipeline.

**Reconciliation with "Canonical-on-Graph (sidecar)" (rejected below).** The
load-bearing test is mechanical, not rhetorical: the rejected option put
overrides into the **resolved L2 node/edge structure** or a **`Graph`-interface
field** — observable by seal `validate()` and changing the `Graph` type. The §6
carrier is neither: a graph-*keyed* `WeakMap` side-table (the established posture
of every existing format sidecar, including the §3-blessed pnpm
`sidecar.overrides`), invisible to seal (`graph.ts` `validate()` reads no
WeakMap) and adding no `Graph` field. ADR-0013 §3 explicitly homes
derived/attribution PM state in exactly such a format-layer carrier and *rejects*
"attribution in the core Graph model" — so the carrier is the ADR-0013-**blessed**
posture, not the rejected one. The declarative *authority* remains the
caller-owned `Manifest` / lock verbatim block; the carrier holds a write-once,
read-only **copy** for the `overridesOf` read path.

**Scope (v1).** Lock-borne + **parse-time** manifest capture only. Deferred:
(i) **modify-time** manifest capture (`ModifyContext.manifests` stays a
half-wired type until re-resolution lands, near ADR-0026) — this is also where
§5's imperative-pin→`Manifest.overrides` merge lives, so that §5 reconcile sits
outside v1's parse-time union by construction, not contradiction; (ii) the
**imperative `pinOverride` channel** — `overridesOf` surfaces *declarative*
overrides only; a pin remains a separate stringify input via `Graph.diagnostics()`
per §5 (complementary channels — do **not** unify them in `overridesOf`). Auto-
projection at stringify (model E3 = stringify calling `overridesOf` internally
when the option is absent) remains deferred — it needs a lock-vs-manifest
*policy* at emit, overlapping the §202 translation boundary. E2 is a strict
subset of E3, so this forecloses nothing.

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
7. (A2 §6) `overridesOf(graph)` returns the canonical union of lock-borne +
   parse-time-manifest overrides (manifest-wins on collision), is mutation-free
   on caller input, and survives `mutate`/enrich/optimize so a
   parse→modify→stringify pipeline still surfaces them; `parse` actually runs
   F6 capture from `ParseOptions.manifests` (no longer a dead option).

## Alternatives considered

- *Canonical-on-Graph (sidecar/metadata) as the override HOME.* Rejected —
  overrides are declared inputs upstream of resolution, not resolved instances;
  making the Graph their *authority* (embedded in resolved L2 node/edge
  structure, or a `Graph`-interface field) collapses the declared-vs-resolved
  separation (ADR-0001). Narrower than it first reads: §6's A2 carrier is a
  graph-*keyed* `WeakMap` side-table — the established posture of every existing
  format sidecar, including the §3-blessed pnpm `sidecar.overrides` — holding a
  transient write-once **copy** for the `overridesOf` read path; association,
  not authority, and *not* the rejected option. See §6 Reconciliation.
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
