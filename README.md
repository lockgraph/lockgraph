# lockgraph

> Universal lockfile model and converter for **npm**, **yarn**, **pnpm**, **bun**.

<p><img alt="lockgraph — universal lockfile model and converter for npm, yarn, pnpm, bun" src="./pics/lockfile.svg" align="right" width="300">

Each package manager brings its own philosophy of how to describe, store and
control project dependencies. Inside a single repo it's invisible to the
developer — but it becomes a recurring cost for InfoSec, DevOps and release
engineers, and makes consistent policy unenforceable across the enterprise.

This library models the dependency graph independent of any specific
package manager, then projects it back into the format you need.
Conversion is one use case; modification (audit-fix, override pinning,
license filtering) is the headline.

</p>

## Install
```shell
npm i lockgraph
yarn add lockgraph
```

## Compatibility

- **Node ≥ 14.18** No browser build planned
- **ESM only** Consumers on CommonJS use dynamic `await import(…)`


## Status

**First public release.** Every format below parses and stringifies. Cross-family
conversion is *semantically equivalent*, not byte-identical (see [Concept](#concept)),
and **fail-closed by default** — a lossy projection throws rather than silently dropping
data (`strict: false` opts out). [SCHEMAS.md](./SCHEMAS.md) maps each format id to the
package-manager versions that emit it; [Known limitations](#known-limitations) lists what
a point release will close.

> **ℹ️ 0.x — early but honest.** The public API is stabilising; expect additive changes
> within the 0.x line. Every limitation is fail-closed — the tool never emits a lock it
> cannot prove — so nothing degrades silently.

| Format | `detect` | `parse` | `stringify` |
|--------|:-:|:-:|:-:|
| `npm-1` · `npm-2` · `npm-3`        | ✓ | ✓ | ✓ |
| `yarn-classic`                    | ✓ | ✓ | ✓ |
| `yarn-berry-v4` … `yarn-berry-v10`| ✓ | ✓ | ✓ |
| `pnpm-v5` · `pnpm-v6` · `pnpm-v9`  | ✓ | ✓ | ✓ |
| `bun-text`                        | ✓ | ✓ | ✓ |

Graph-level operations apply to **any** parsed graph, regardless of source
format: `convert` (parse any → stringify any), `modify` (audit-fix,
override-pin, license-filter), and `optimize` (orphan GC / dedup).

### Known limitations

Every item below is **fail-closed** — the tool throws (or diagnoses) rather than
emitting a lock it cannot prove. All are point-release targets.

- **`modify` on pnpm / bun / npm graphs carrying native replay state.** `convert`
  preserves native fidelity fully; `modify` (audit-fix, override-pin, license-filter)
  propagates it today only for **Yarn**. On a pnpm/bun/npm graph whose native state is
  load-bearing (pnpm `packageExtensionsChecksum` / `pnpmfileChecksum` / `settings`;
  bun `trustedDependencies` / `patchedDependencies`; npm native layout), a mutation
  detaches that state, so strict `modify` **fails closed** rather than silently emitting
  a frozen-invalid lock. Pass `strict: false` to accept the loss, or use Yarn.
- **pnpm-v5 workspace-peer projection** is unsupported and fail-closed — the v6/v9
  workspace-peer machinery is not yet ported to the standalone v5 grammar. Ordinary
  pnpm-v5 parse/stringify is fully supported.
- **npm → Yarn Classic git locators** fail the output self-check and fail closed;
  registry dependencies are unaffected.
- **pnpm catalogs and build-trust policy** are preserved in same-format round trips;
  cross-family conversions that would need external workspace evidence fail closed on
  the unsupported loss.

## Concept

A target lockfile is **constructed** from facts gathered across whatever
sources are available: the input lockfile bytes, project `package.json`s,
the package-manager cache, and (opt-in) the registry. The simplest case is
*conversion* — parse one format, stringify another. The general case is
*construction*: assemble what the target requires from whichever source can
supply it.

Three layers, never collapsed:

- **Manifest** — declared constraints from `package.json`(s).
- **Graph** — resolved package instances (peer-aware) and the edges
  between them. The canonical internal model. Modifiers operate here.
- **Layout** — physical projection on disk: hoisted, isolated (pnpm-style),
  PnP, nm-linked.

Conversion is **lossy by design**. We aim for *semantically equivalent*,
not *byte-identical*. Irreducible facts (integrity hashes, resolution URLs,
signatures) are the exception — they are never silently lost.

## API

```ts
import { parse, stringify, convert } from 'lockgraph'

// explicit format (it's always the first argument):
const graph = parse('pnpm-v9', raw)
const out   = stringify('npm-3', graph)

// or one step, auto-detecting the source:
const npm = convert(raw, { to: 'npm-3' })
```

The format is **explicit**, never implicit — `parse` and `stringify` both take
it as the first argument; `detect` sniffs it from the bytes when you don't know
it. Round-tripping is a choice the caller makes, not a default.

```ts
detect(input: string): FormatId | undefined
check(format: FormatId, input: string): boolean
parse(format: FormatId, input: string, opts?: ParseOptions): Graph
stringify(format: FormatId, graph: Graph, opts?: StringifyOptions): string
convert(input: string, opts: ConvertOptions): string   // parse(from) → stringify(to)
```

`Graph` is the canonical, package-manager-independent model; `FormatId` is a
string-literal union (the [Status](#status) table lists every id, and
[SCHEMAS.md](./SCHEMAS.md) maps each to the package-manager versions behind it).

### Frozen-certified conversion

`prepareFrozen` emits an opaque challenge for one exact package-manager version;
it is **not** a usable certified result. Materialize its lockfile and companion
operations in an isolated project, run that exact manager's native frozen command,
and pass the resulting receipt to `certifyFrozen`:

```ts
import { prepareFrozen, certifyFrozen } from 'lockgraph'

const prepared = await prepareFrozen(input, {
  from: 'pnpm-v9',
  to: 'npm-3',
  sourceVersion: '10.0.0',
  targetVersion: '10.9.2',       // exact full version; no ranges or `latest`
  manifestCoverage: 'complete',
  manifests,
  evidenceInputs,
})

if (prepared.candidate) {
  const receipt = await yourNativePmOracle(prepared.candidate)
  const certified = certifyFrozen(prepared.candidate, receipt)
  if (certified.assessment.status === 'satisfied') {
    // Only this lockfile + companion bundle is frozen-certified.
  }
}
```

Core never shells out. A receipt is bound to the candidate's exact target,
lockfile bytes, ordered companion operations, platform, config digest, and input
tree digest. A stale, copied, hand-built, or cross-target candidate fails closed,
and unsuccessful certification returns no final artifacts.

> **Trust boundary:** receipt hashes provide **integrity** — they prevent a
> receipt from being reused for another projection. They do **not** provide
> **authenticity** — they cannot prove that an untrusted party really ran the
> package manager. Lockgraph's own frozen claims rely on CI running the genuine
> pinned binaries. Third-party `frozen-verified` results are only as trustworthy
> as the authority that produced the receipt (or a future signed attestation).

See [CONVERT.md](./CONVERT.md#frozen-candidate-and-certification-lifecycle) for
the candidate gates, oracle bounds, and Berry-checksum exception.

### Operating on the graph

The graph is where the value lives — `modify` and `optimize` transform it,
format-agnostically:

- **`modify`** applies a `Primitive[]` — `replaceVersion`, `pinOverride`,
  `addDependency`, `removeDependency`, `applyPatch`, `filterLicense` — the
  building blocks of audit-fix, override-pinning and license filtering.
- **`optimize`** runs orphan GC / dedup over the graph (a production-reachability
  sweep). **`pruneOrphans`** (via `lockgraph/optimize`) is the
  reference-count sibling: it retires only nodes that lost their *last* incoming
  edge of any kind — post-bump cleanup that, unlike reachability, never
  over-collects a still-referenced dev/optional/peer dep.
- **`overridesOf(graph)`** reads the canonical overrides back out.

### Options

```ts
type ParseOptions = {
  workspaceRoot?: string                     // FS root for out-of-lockfile reads (patch bytes, manifests)
  manifests?:     Record<string, Manifest>   // package.jsons keyed by workspace path
  onDiagnostic?:  (d: Diagnostic) => void
}

type StringifyOptions = {
  lineEnding?:   'lf' | 'crlf'
  cacheKey?:     string                       // yarn-berry cache-key prefix
  overrides?:    OverrideConstraint[]         // canonical overrides → native projection
  onDiagnostic?: (d: Diagnostic) => void
}

// lockgraph/registry — liveRegistry({ … }); the transport seams:
type LiveRegistryOptions = {
  url?:        string                         // registry URL (default registry.npmjs.org)
  auth?:       string                         // Bearer token (authHeader? for a verbatim 'Bearer …' / 'Basic …')
  fetch?:      typeof fetch                   // transport — proxy/CA, and where RETRY + HTTP cache belong (compose your own)
  limit?:      Limiter                        // scheduler — concurrency pool / rate-limit / debounce; re-surfaced as reg.limit / ctx.registry
}
type Limiter = <T>(task: () => Promise<T>) => Promise<T>

// lockgraph/complete — completeTransitives(graph, registry, { … }):
type CompletionOptions = {
  constraints?:   Condition[]                 // node-local acceptance gates (engines / license / custom); ADR-0037
  budget?:        { maxCombinations: number } // opt-in bounded-backtracking discovery (suggests the override to pin)
  onUnevaluable?: 'reject' | 'accept'         // an 'unevaluable' verdict → fold into NO_CANDIDATE (default) / skip the check
  overrides?:     OverrideConstraint[]        // honour declared pins so the completed closure stays frozen-clean
  resolution?:    'highest' | 'prefer-existing'
  seed?:          CompletionSeed              // bound the frontier for incremental completion
}
```

`manifests` supplies the workspace/override context the lockfile bytes cannot
carry on their own (notably for `yarn-classic` monorepos); everything else
succeeds offline against the bytes alone. Registry- and cache-backed refinement
ships as opt-in adapters (see [Sub-imports](#sub-imports)).

### Registry, config & audit

Registry-backed work — re-resolution, checksum refill, advisory audit — needs a
registry URL and its auth, resolved from the package-manager config, never guessed.

```ts
import { resolveRegistry, liveRegistry } from 'lockgraph/registry'
import { registryPackages } from 'lockgraph/optimize'

// Resolve routing + host-bound auth for ONE ecosystem. `ecosystem` is REQUIRED:
// it fixes exactly which config files + env namespace are read, so a planted
// `.yarnrc.yml` can't inject into an npm resolve — npm and yarn directives never mix.
const cfg = resolveRegistry(cwd, { ecosystem: 'npm' })  // 'npm' | 'pnpm' | 'yarn-classic' | 'yarn-berry'
cfg.registryFor('@scope/pkg')   // scope-aware registry URL (@scope:registry / npmScopes)
cfg.authHeaderFor(url)          // 'Bearer …' | 'Basic …', https-only, longest host-prefix wins
cfg.tokenFor(url)               // Bearer-only convenience

// A live adapter already wired to the resolved registry + auth:
const reg = liveRegistry.fromConfig(cwd, '@scope/pkg', { ecosystem: 'npm' })
await reg.packument('@scope/pkg')

// Bulk security audit — the graph's registry packages → RAW npm advisories
// (no normalization; severity / fix-selection stay the caller's):
const advisories = await reg.audit(registryPackages(graph))
```

Auth follows the npm/yarn taxonomy (Bearer `_authToken` / `npmAuthToken`; Basic
`_auth`, `username`+`_password`, `npmAuthIdent`), bound to the declaring host —
`always-auth` is deliberately not honoured (it would send a credential beyond its
host prefix). Pass `env: {}` to ignore environment config entirely.

**Customising the transport.** The library ships no fetch policy — two seams let you
supply your own, and it's the integration's job to compose them:

- **`fetch`** — the transport. Proxy / custom-CA, and where **retry** (backoff) and
  an **HTTP response cache** belong (compose your own, e.g. `make-fetch-happen`). A
  retried/cached GET must return the same bytes (frozen-clean); the POST audit is
  retry-safe for availability only — never cache it (advisories are time-varying).
- **`limit`** — the scheduler (concurrency pool / rate-limit / debounce): `liveRegistry({ fetch, limit })`
  runs every registry call through it, and re-surfaces it as `reg.limit` — a custom
  completion constraint gets the whole configured client as `ctx.registry`, so its own
  registry calls share the same quota (and it never hand-rolls a `fetch`).

```ts
import pLimit from 'p-limit'
const pool = pLimit(8)
const reg = liveRegistry({ fetch: fetchWithRetry, limit: task => pool(task) })
```

### Constraint-aware completion

`completeTransitives(graph, registry, { constraints })` (from
`lockgraph/complete`) selects each newly-introduced transitive as the
**highest range-satisfying version that also passes every constraint** — so a
post-bump closure stays compatible with the target environment, not merely
semver-valid. Constraints are pluggable acceptance gates; `engines` and `license`
ship built-in:

```ts
import { completeTransitives, engines, license } from 'lockgraph/complete'

const { graph: completed, unresolved } = await completeTransitives(graph, registry, {
  constraints: [
    engines({ node: '>=18' }),                        // reject a version needing a newer node than your floor
    license({ allow: ['MIT', 'Apache-2.0', 'ISC'] }), // needs a manifest()-capable registry (liveRegistry)
  ],
})
```

`engines` accepts a version whose declared engines support the **minimum** of the
target (so a discrete `^16 || ^18 || ^20` passes for `>=18`, while a version
needing `>=20` is rejected); a point target degrades to npm-exact `satisfies`. When
no in-range version passes, completion leaves that edge unwired and emits a
**recoverable** `COMPLETION_NO_CANDIDATE` (a `warning` in `unresolved`) carrying a
per-candidate `{ version, by, reason }` payload — the caller decides whether to skip
that fix or stop (`onUnevaluable: 'reject' | 'accept'` governs the missing-`manifest()`
case).

**Bounded-backtracking discovery (opt-in).** Pass `budget: { maxCombinations }` and, when
a dep hits `NO_CANDIDATE`, completion searches — bounded by that combinatorial budget — for
a *lower* version of the **consumer** whose closure is constraint-clean (the `foo@1.9→bar`
cliff that `foo@1.4→bar` clears), attaching it to the diagnostic as a `suggestion` (the
override to pin — durable across installs). It is **read-only**: the emitted lock is
byte-identical to the no-budget run, so it only ever *advises*, never rewrites.

**Custom constraints.** A constraint is any `{ kind, cost?, evaluate(ctx) }` object, so
any per-package decision becomes a gate. `evaluate` is sync or async and returns
`{ ok: true } | { ok: false, reason? } | { ok: 'unevaluable', reason? }`; `ctx` gives
`{ name, version, corgi, manifest(), registry }` — use `ctx.manifest()` / `ctx.registry`
(the configured client: URL / auth / `fetch` / `limit` / cache), never a hand-rolled
`fetch`. Example — reject an ESM-only package for a CommonJS consumer:

```ts
const commonjsCompatible = () => ({
  kind: 'commonjs',
  cost: 10,                                                  // needs the full manifest → runs after the corgi gates
  async evaluate(ctx) {
    const m = await ctx.manifest()                           // the configured client — no URL/auth/fetch glue
    if (m === undefined) return { ok: 'unevaluable', reason: 'no manifest()-capable registry' }
    if (m.type !== 'module') return { ok: true }             // CJS by default → requireable
    const hasCjsEntry = typeof m.main === 'string'
      || /"(require|default)"\s*:/.test(JSON.stringify(m.exports ?? null))
    return hasCjsEntry ? { ok: true } : { ok: false, reason: `${ctx.name}@${ctx.version} is ESM-only` }
  },
})

await completeTransitives(graph, registry, { constraints: [engines({ node: '>=18' }), commonjsCompatible()] })
```

(A node-local *approximation*: true `require(ESM)` compatibility is per-edge and
Node-version-gated, which is why module-format isn't a built-in — it belongs in
user-land as a custom axis.)

**`cost`** orders evaluation cheap-first and short-circuits on the first rejection —
it is an **optimisation, never a priority**: every constraint must pass, and the
verdict is identical regardless of order. Convention: `0` reads only the corgi
packument already in hand (`engines`), `10` needs one full-manifest fetch (`license`),
`20` an external call. So a version `engines` (cost 0) rejects never triggers a
`license` (cost 10) manifest fetch. Default `0`; equal costs keep declaration order.

### Sub-imports

| Surface | Importable as | Contains |
|---------|---------------|----------|
| Root | `lockgraph` | `detect`, `check`, `parse`, `stringify`, `convert`, `modify`, `optimize`, `overridesOf`, plus types `Graph`, `FormatId`, `ParseOptions`, `StringifyOptions`, `ConvertOptions`, `Manifest` |
| Modifiers | `lockgraph/modify` | the individual `Primitive` functions behind `modify` (audit-fix, override-pin, license-filter) |
| Complete | `lockgraph/complete` | `completeTransitives` — registry-backed tree completion that wires the transitive deps a modify introduced, with optional node-local `constraints` (`engines`, `license`) for engine/license-aware version selection |
| Optimize | `lockgraph/optimize` | `optimize` (reachability orphan GC), `pruneOrphans` (reference-count orphan GC), `registryPackages` (the graph's registry deps as a `{name: versions[]}` audit input) |
| Enrich | `lockgraph/enrich` | `refurbish` — monotone field-fill (e.g. recomputes a yarn-berry zip `checksum` from a tarball source so a patched lock installs without `yarn install`) |
| Registry | `lockgraph/registry` | `frozenRegistry`, `liveRegistry` (+ `.fromConfig`, `.audit`), `resolveRegistry`, `npmCache`, `pnpmCache`, `yarnBerryCache` |
| Per-format | `lockgraph/formats/<id>` | a single adapter directly (test surface; not a primary user API) |

### Errors

Format and conversion APIs throw `LockfileError`, discriminated by `code`:

```ts
'PARSE_FAILED' | 'FORMAT_DETECT_FAILED' | 'FORMAT_MISMATCH'
| 'CAPABILITY_LACK' | 'MISSING_REQUIRED_FIELD'
| 'INVALID_INPUT' | 'ENRICH_REQUIRED' | 'IRREDUCIBLE_LOSS'
| 'INVARIANT_VIOLATION'
```

Graph construction and mutation use the separate `GraphError` class with
`INVARIANT_VIOLATION` and `PATCH_REJECTED` codes. Recoverable loss, incomplete
evidence, and transformation events use the non-throwing `Diagnostic` channel
(`info` / `warning` / `error`) and can surface through graph/results plus the
`onDiagnostic` callback. In strict stringify, classified `PROJECTION_LOSS`
diagnostics become `ENRICH_REQUIRED` or `IRREDUCIBLE_LOSS` with structured
`losses[].remedy` guidance.

See [ERRORS.md](./ERRORS.md) for the complete exception and diagnostic
taxonomy, causes, and remedies.

## Schemas

Every recognised lockfile schema is enumerated in
[SCHEMAS.md](./SCHEMAS.md), with adapter ids, the schema-marker each
carries, the package-manager versions that emit it by default, and
permalinked sources. Use that table as the index when calling
`parse({ format })` or `stringify({ format })`.

## Predecessor and inspirations

This project is the architectural successor to
[`yarn-audit-fix`](https://github.com/antongolub/yarn-audit-fix), generalised
beyond yarn.

Earlier work in this space:

- [synp](https://github.com/imsnif/synp)
- [snyk-nodejs-lockfile-parser](https://github.com/snyk/nodejs-lockfile-parser)
- [`@yarnpkg/lockfile`](https://github.com/yarnpkg/yarn/tree/master/packages/lockfile)
- [`pnpm/lockfile-utils`](https://github.com/pnpm/pnpm/tree/main/lockfile)

## Package-manager docs

- [`package-lock.json`](https://docs.npmjs.com/cli/v10/configuring-npm/package-lock-json)
  — npm
- [yarn lockfile (classic)](https://classic.yarnpkg.com/lang/en/docs/yarn-lock/)
  / [yarn lockfile (berry)](https://github.com/yarnpkg/berry/blob/master/packages/yarnpkg-core/sources/Project.ts)
- [`pnpm/spec/lockfile/`](https://github.com/pnpm/spec/tree/master/lockfile)
  — pnpm
- [bun lockfile](https://bun.com/docs/pm/lockfile) — bun

## License

[MIT](./LICENSE)
