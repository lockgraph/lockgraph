// ADR-0037 — completion constraints: a NODE-LOCAL acceptance filter.
//
// A NEW transitive node is selected as the HIGHEST range-satisfying version
// whose OWN metadata passes every constraint. Pluggable function seam
// (`Condition.evaluate(ctx) → Verdict`, sync or async); built-in `engines` +
// `license` factories. No cross-node coupling, no backtracking (PMs do not
// backtrack version selection on engines — a backtracker would emit a lock no
// PM produces; see ADR-0037 / spec/bindings/constraints-api.md).

import semver from 'semver'
import type { Limiter, Packument, PackumentVersion, RegistryAdapter } from '../registry/types.ts'
import { isLicenseFlagged, isLicenseExpression } from '../recipe/license.ts'
import type { RejectedCandidate } from './diagnostics.ts'

/** A value a condition may return synchronously OR asynchronously — the engine
 *  always `await`s, so a sync gate is indistinguishable at the call site. */
export type Awaitable<T> = T | Promise<T>

/** A condition's verdict on one candidate. `'unevaluable'` (distinct from
 *  `false`) = "I could not judge" (e.g. a license gate on a corgi-only adapter);
 *  the engine applies the caller's `onUnevaluable` policy. */
export type Verdict =
  | { ok: true }
  | { ok: false; reason?: string }
  | { ok: 'unevaluable'; reason?: string }

/** Per-candidate context. `corgi` is the abbreviated packument-version already
 *  in hand (engines/os/cpu/libc/deprecated/dependencies — free). `manifest()`
 *  pulls the FULL single-version doc (adds `license`) on demand, MEMOISED per
 *  candidate; `undefined` on a corgi-only adapter. */
export interface ConditionContext {
  readonly name:    string
  readonly version: string
  readonly corgi:   PackumentVersion
  manifest(): Promise<PackumentVersion | undefined>
  /** The registry's scheduling policy (pool / rate-limit / debounce), or a
   *  no-op if none was injected. Route a custom constraint's OWN async work
   *  (e.g. a `fetch`) through it — `await ctx.limit(() => fetch(url))` — so it
   *  shares the same quota as the registry's calls. */
  limit: Limiter
}

/** One acceptance gate. `cost` orders evaluation cheap-first (0 = corgi field,
 *  10 = one manifest fetch) — an open number, not a closed tier enum. */
export interface Condition {
  readonly kind: string
  readonly cost?: number
  evaluate(ctx: ConditionContext): Awaitable<Verdict>
}

/** What an `{ ok: 'unevaluable' }` verdict means: `'reject'` (default — treat
 *  the candidate as rejected; folds into `NO_CANDIDATE` if it exhausts) or
 *  `'accept'` (best-effort, skip the check). */
export type OnUnevaluable = 'reject' | 'accept'

export interface SelectResult {
  /** The winning version's PackumentVersion (libc-backfilled, mint-ready), or
   *  undefined when no candidate passed / the package is unknown. */
  selected?: PackumentVersion
  /** Every rejected candidate, in descending order tried — the why-payload. */
  rejected:  RejectedCandidate[]
}

// ── Built-in constraints ────────────────────────────────────────────────────

/**
 * `engines` — accept iff the candidate supports the MINIMUM version of the
 * required target: `semver.satisfies(minVersion(required[engine]), declared)`.
 * So target `node '>=18'` (floor = node 18) ACCEPTS a package declaring
 * `>=16`, `>=18`, or the ubiquitous discrete `^16 || ^18 || ^20`, and REJECTS
 * one declaring `>=20` (it needs a newer node than your floor — the pijma
 * break: install passes, runtime on the older node fails). A point target
 * (`'18.17.0'`) degrades to npm's exact `satisfies`. NOTE the target's floor is
 * what's checked: for a multi-range target like `'18 || 20'` only node 18 (the
 * minimum) is verified. `mode` `'lenient'` (default, npm parity): a package
 * with no `engines[engine]` is accepted; `'strict'`: rejected.
 */
export function engines(
  required: Record<string, string>,
  opts?: { mode?: 'lenient' | 'strict' },
): Condition {
  const mode = opts?.mode ?? 'lenient'
  return {
    kind: 'engines',
    cost: 0,
    evaluate(ctx) {
      const declared = ctx.corgi.engines
      for (const [engine, want] of Object.entries(required)) {
        const have = declared?.[engine]
        if (have === undefined || have === '' || have === '*') {
          if (mode === 'strict' && have === undefined) {
            return { ok: false, reason: `declares no engines.${engine}` }
          }
          continue // unconstrained by this package → accept (npm-lenient)
        }
        if (semver.validRange(have) === null) {
          return { ok: 'unevaluable', reason: `engines.${engine} '${have}' is not a parseable range` }
        }
        let floor: semver.SemVer | null
        try {
          floor = semver.minVersion(want)
        } catch {
          floor = null
        }
        if (floor === null) {
          return { ok: 'unevaluable', reason: `target engines.${engine} '${want}' has no minimum version` }
        }
        if (!semver.satisfies(floor.version, have)) {
          return { ok: false, reason: `engines.${engine} '${have}' does not support ${engine} ${floor.version} (target '${want}')` }
        }
      }
      return { ok: true }
    },
  }
}

/**
 * `license` — accept by SPDX allow/deny over the candidate's `license` (from the
 * FULL manifest). Reuses the one shared policy predicate (`recipe/license.ts`),
 * so it never drifts from the `filterLicense` modifier. v1 compares SINGLE SPDX
 * ids; a compound EXPRESSION (`(MIT OR Apache-2.0)`) → `unevaluable` (a token
 * scan would invert AND/OR). `unevaluable` also when the adapter has no
 * `manifest()`.
 */
export function license(policy: { allow?: readonly string[]; deny?: readonly string[] }): Condition {
  return {
    kind: 'license',
    cost: 10,
    async evaluate(ctx) {
      const man = await ctx.manifest()
      // A corgi-only adapter (frozen / *Cache) has no manifest() → every
      // candidate is unevaluable. Under the default onUnevaluable:'reject' that
      // vetoes the whole completion — name the cause so it is not a silent wall
      // of NO_CANDIDATE. The `license` axis needs a manifest()-capable registry
      // (liveRegistry).
      if (man === undefined) {
        return { ok: 'unevaluable', reason: 'license unevaluable — registry has no manifest() (use liveRegistry, or onUnevaluable:\'accept\')' }
      }
      const lic = man.license
      if (lic !== undefined && isLicenseExpression(lic)) {
        return { ok: 'unevaluable', reason: `SPDX expression '${lic}' not id-comparable` }
      }
      return isLicenseFlagged(lic, policy.allow, policy.deny)
        ? { ok: false, reason: `license ${lic ?? '<none>'} not permitted` }
        : { ok: true }
    },
  }
}

// ── The selector ─────────────────────────────────────────────────────────────

/**
 * Pick the HIGHEST range-satisfying version passing ALL constraints. Cheap
 * conditions run first (a version an in-memory `engines` check rejects never
 * pays a manifest fetch). Candidate order is semver-descending — deterministic,
 * and matches `resolve`'s `maxSatisfying` preference. Async conditions are
 * awaited SEQUENTIALLY so promise timing can never pick the version. A condition
 * that THROWS aborts (a broken checker must not be silently skipped).
 */
export async function selectConstrained(
  registry: RegistryAdapter,
  name: string,
  range: string,
  constraints: readonly Condition[],
  onUnevaluable: OnUnevaluable,
): Promise<SelectResult> {
  const pack = await registry.packument(name)
  if (pack === undefined) return { rejected: [] } // package unknown → caller emits UNRESOLVED

  const ordered = orderByCost(constraints)
  const rejected: RejectedCandidate[] = []

  for (const version of candidatesFor(pack, range)) {
    const corgi = pack.versions[version]
    if (corgi === undefined) continue
    const ctx = makeContext(registry, name, version, corgi)
    const verdict = await evaluateOne(ctx, ordered, onUnevaluable)
    if (verdict.ok) return { selected: await mintReady(corgi, ctx), rejected }
    rejected.push({ version, by: verdict.by, ...(verdict.reason !== undefined ? { reason: verdict.reason } : {}) })
  }

  return { rejected } // exhausted: rejected.length > 0 ⇒ NO_CANDIDATE; === 0 ⇒ UNRESOLVED (no satisfying version)
}

/**
 * Passing candidates for `name@range`, HIGHEST-first, each already mint-ready
 * (libc-backfilled) — the on-demand alternative stream the bounded-backtracking
 * escalation walks (ADR-0037 v2). Reuses the exact same enumeration + evaluation
 * as `selectConstrained`, lazily: a consumer that only pulls the first item pays
 * for one, exactly as v1 does.
 */
export async function* constrainedCandidates(
  registry: RegistryAdapter,
  name: string,
  range: string,
  constraints: readonly Condition[],
  onUnevaluable: OnUnevaluable,
): AsyncGenerator<{ version: string; node: PackumentVersion }> {
  const pack = await registry.packument(name)
  if (pack === undefined) return
  const ordered = orderByCost(constraints)
  for (const version of candidatesFor(pack, range)) {
    const corgi = pack.versions[version]
    if (corgi === undefined) continue
    const ctx = makeContext(registry, name, version, corgi)
    const verdict = await evaluateOne(ctx, ordered, onUnevaluable)
    if (verdict.ok) yield { version, node: await mintReady(corgi, ctx) }
  }
}

function orderByCost(constraints: readonly Condition[]): Condition[] {
  return [...constraints].sort((a, b) => (a.cost ?? 0) - (b.cost ?? 0))
}

function makeContext(
  registry: RegistryAdapter,
  name: string,
  version: string,
  corgi: PackumentVersion,
): ConditionContext {
  let manifestP: Promise<PackumentVersion | undefined> | undefined
  return {
    name,
    version,
    corgi,
    manifest: () => (manifestP ??= registry.manifest ? registry.manifest(name, version) : Promise.resolve(undefined)),
    limit: registry.limit ?? (task => task()),
  }
}

/** Evaluate every constraint (cost-ordered) against one candidate; first failure
 *  wins. A condition that THROWS aborts the whole call (a broken checker must not
 *  be silently skipped). */
async function evaluateOne(
  ctx: ConditionContext,
  ordered: readonly Condition[],
  onUnevaluable: OnUnevaluable,
): Promise<{ ok: true } | { ok: false; by: string; reason?: string }> {
  for (const c of ordered) {
    let verdict: Verdict
    try {
      verdict = await c.evaluate(ctx)
    } catch (cause) {
      // Node-14-safe: no Error `cause` option.
      throw new Error(`completion constraint '${c.kind}' threw for ${ctx.name}@${ctx.version}: ${errMessage(cause)}`)
    }
    if (verdict.ok === true) continue
    if (verdict.ok === 'unevaluable' && onUnevaluable === 'accept') continue
    return { ok: false, by: c.kind, ...(verdict.reason !== undefined ? { reason: verdict.reason } : {}) }
  }
  return { ok: true }
}

/** The winner's mint-ready node: mirror `liveRegistry.resolve`'s libc backfill so
 *  a constrained mint is byte-identical to an unconstrained one (corgi drops
 *  `libc`; a linux package missing it → YN0028 on `yarn install --immutable`). */
async function mintReady(corgi: PackumentVersion, ctx: ConditionContext): Promise<PackumentVersion> {
  if (corgi.os?.includes('linux') === true && corgi.libc === undefined) {
    const full = await ctx.manifest()
    if (full !== undefined) return full
  }
  return corgi
}

/** Candidate versions for `range`, mirroring `resolve`'s selection: an exact
 *  version or a dist-tag yields ONE candidate; otherwise the satisfying set,
 *  semver-DESCENDING (highest first). */
function candidatesFor(pack: Packument, range: string): string[] {
  if (pack.versions[range] !== undefined) return [range]
  const tagged = pack.distTags[range]
  if (tagged !== undefined) return pack.versions[tagged] !== undefined ? [tagged] : []
  const out: string[] = []
  for (const v of Object.keys(pack.versions)) {
    if (satisfiesQuiet(v, range)) out.push(v)
  }
  return out.sort((a, b) => rcompareQuiet(a, b))
}

function satisfiesQuiet(version: string, range: string): boolean {
  try {
    return semver.satisfies(version, range)
  } catch {
    return false
  }
}

function rcompareQuiet(a: string, b: string): number {
  try {
    return semver.rcompare(a, b)
  } catch {
    return a < b ? 1 : a > b ? -1 : 0 // stable fallback for non-semver keys
  }
}

function errMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
