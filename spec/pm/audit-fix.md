# `audit-fix` — vulnerability remediation across package managers

> Status: **preview** (source-derived) — grounded in the real npm (6 / 10 / 11), pnpm (6 / 9 / 10), and `yarn-audit-fix` source read on 2026-07-06, not only docs.
> Updated: 2026-07-06.
> Provenance: **Source-derived** — the fix ALGORITHM and the `--force` semantics below are read out of each PM's shipped source (`@npmcli/arborist`, npm's `lib/`, the pnpm bundle) and cross-checked against `yarn-audit-fix`. File references are the ground truth; the running CLIs confirm the surface.
> Family: cross-cutting — this is the **driver feature** of the whole library ([`00-overview`](../00-overview.md)); the advisory transport it consumes lives in [`spec/registry/_common.md §8`](../registry/_common.md#8-advisories--audit-api).

"Audit-fix" is the remediation half of a PM's security surface: given a set of
installed `name@version` nodes and a set of advisories, **change the graph so no
node resolves to a vulnerable version**, then persist that change to the manifest
and/or lockfile. The **query** half (which node is vulnerable) is a registry
concern ([`spec/registry/_common.md §8`](../registry/_common.md#8-advisories--audit-api));
this doc is the **remediation** half — how each PM turns advisories into edits,
and what `--force` changes.

The central fact: there are **two structurally different ways a fix is persisted**
— bump the declared range, or write an override pin — and a PM's fixer commits to
one of them (deno's native fixer is the degenerate range-family case: it stays
in-range, so nothing is rewritten — §4.6). Getting a fix that survives the PM's own
frozen install ([`_common §… frozen invariant`](../formats/_common.md#111-fundamental-invariant--frozen--ci-acceptance))
means reproducing the model the target PM uses — not a generic "bump the version."

---

## §1 The pipeline (all PMs)

Four stages. Stage 3 is where the models diverge.

1. **Collect** the installed set — `{ name: [versions…] }` from the lockfile (+ manifest for the declared ranges), filtered by dependency scope (`--omit`/`--include` dev/optional/peer).
2. **Query** advisories — POST the set to the registry advisory API (§2), receive per-package advisories: `{ id, url, title, severity, vulnerable_versions, patched_versions?, cwe[], cvss }`.
3. **Select + apply** the fix — compute, per vulnerable node, a non-vulnerable target, and edit the graph (this is the **model** — §3).
4. **Persist** — write the manifest ranges and/or the lockfile and/or an overrides block (§3), such that a subsequent frozen install accepts it with no rewrite (§7).

---

## §2 Advisory transport — which client hits which endpoint

Two registry endpoints exist ([`registry/_common.md §8`](../registry/_common.md#8-advisories--audit-api)); the client split is NOT "modern vs legacy by PM age". All endpoint rows below were read **first-hand from the installed PM source** (versions in Sources):

| endpoint | request | clients |
|---|---|---|
| `POST /-/npm/v1/security/advisories/bulk` | flat `{ name: [versions] }` | **npm 7+ ONLY** (`audit-report.js` / arborist) |
| `POST /-/npm/v1/security/audits` (full) | lockfile-shaped tree (`{ name, version, requires, dependencies }`, gzipped) | **npm 6**, **pnpm 6 / 9 / 10**, **yarn-classic** `yarn audit` |
| `POST /-/npm/v1/security/audits/quick` | same tree | **yarn-berry** `yarn npm audit`; **npm 10** (only as a fallback behind bulk — dropped in npm 11) |

The corrected picture: **the only bulk client is npm 7+.** *Both* yarn lineages and
pnpm POST a lockfile-shaped tree to the legacy `/audits` family — pnpm (all versions)
and yarn-classic to full `/audits`, yarn-berry to `/audits/quick` (not bulk, contrary
to a common assumption; verified in the yarn 2.4.3 bundle). The full `/audits`
response additionally carries a server-computed remediation plan — npm 6 consumes it,
pnpm ignores it and computes overrides locally from the advisories. npm 10 keeps
`/audits/quick` as a fallback behind bulk; npm 11 dropped it and speaks only `bulk`.
Bun's endpoint is unconfirmed (open question in [`registry/bun.md`](../registry/bun.md)).

---

## §3 The two remediation models

| | **Range-bump** | **Override-pin** |
|---|---|---|
| PMs | npm, yarn-classic / berry (via `yarn-audit-fix`) | pnpm; bun's manual channel |
| edits | the **declared range** of the dependency that pulls the vuln, in the manifest, + the lockfile | an **`overrides` entry** keyed by the vulnerable package, in the manifest only |
| fixes at | the **consumer** (whoever declared the range) | the **source** (the vulnerable node itself, anywhere in the tree) |
| transitive vulns | reached indirectly — re-resolve the declaring edge to a version whose closure is clean | reached directly — the override pins the vulnerable package everywhere |
| semver contract | **respected** — a breaking (major) fix crosses the declared range and is gated behind `--force` | **bypassed by design** — an override is a hard pin; a breaking fix applies unconditionally |
| `--force` | **needed** to cross the range / apply a SemVer-major fix (§5) | **absent** — there is nothing to force |
| persistence | manifest ranges + lockfile (npm), or manifest ranges (yaf) | manifest `overrides` only; a follow-up install materialises it |

The models are not interchangeable: an override-pin lock has no bumped ranges (the
declared `^4` stays, an `overrides` block does the work); a range-bump lock has no
overrides (the declared `^4` became `^5`). A cross-PM convert or a fix emitted for
the wrong model desynchronises the manifest from the lock and the PM rewrites on
install.

---

## §4 Per-PM mechanics

### 4.1 npm 7+ — Arborist, client-computed range-bump

The fix is computed locally by `@npmcli/arborist` (no server remediation plan).
`npm audit fix` is `arb.audit({ fix: true })` → a normal `reify()` whose ideal-tree
build has the audit report injected (`arborist/index.js`); `npm audit` (no `fix`)
returns the report only.

- **Per-vuln fix state** — `Vuln.fixAvailable` (`arborist/lib/vuln.js`) is one of:
  - `true` — an in-range, non-breaking update exists (applied WITHOUT `--force`);
  - `false` — no fix (the spec is non-registry — git/file/url — or no avoidable version exists);
  - `{ name, version, isSemVerMajor: true }` — a fix exists but needs `--force` and is a **SemVer-major** bump; or `{ name, version }` (no `isSemVerMajor`) — needs `--force` but is only **out-of-declared-range, same-major**. `vuln.js` emits these as two distinct object shapes; `isSemVerMajor` is what tells them apart.
- **Target selection** — `npm-pick-manifest` with `avoid: <vulnerable range>, avoidStrict: true` walks a ladder: (1) a non-vulnerable version **inside the declared range** → in-range fix; else (2) inside `^current` → out-of-range, same-major (`isSemVerMajor: false`); else (3) inside `*` → SemVer-major (`isSemVerMajor: true`); else `ETARGET` → `false`.
- **Apply** — in-range fixes flow through the normal `avoid`-range re-resolution of every vulnerable node's dependents (`build-ideal-tree.js` queues `edgesIn.from`). Out-of-range / major fixes for **top-level (root/workspace) deps** are applied ONLY inside `if (this.options.force && this.auditReport && this.auditReport.topVulns.size)` via an explicit `#add(node, { add: ['name@version'] })`.
- **Persist** — the lockfile is always written; the manifest **range is bumped** for a direct fix (`^1.0.0` → `^1.2.3`, or `^2.0.0` under force-major), preserving the original spec's prefix; an exact original spec stays a pin. Transitive fixes touch the lockfile only. npm's `audit fix` never writes to the manifest `overrides` field.

### 4.2 npm 6 — server-computed range-bump (legacy)

npm 6 is a thin client: it POSTs the scrubbed lockfile tree to `/-/npm/v1/security/audits`
and the **registry** returns the remediation plan. The response `actions[]` each carry
`{ action: install | update | review, module, target, isMajor, resolves[] }` — the
target version and the `isMajor` (breaking) flag are decided server-side. `npm audit fix`
buckets them (`lib/audit.js`): `install` → a top-level bump, `update` → a transitive
path re-fetch, `review` → manual (no auto-fix), and `isMajor` → a separate bucket gated
by `--force`. It writes both `package.json` ranges (save-on by default) and the lockfile.
This server-`isMajor` gate is the direct ancestor of Arborist's local `fixAvailable.isSemVerMajor`.

### 4.3 pnpm — override-pin

`pnpm audit --fix` (`audit/lib/fix.js`, identical across pnpm 6 / 9 / 10) does no
semver math of its own. `createOverrides()` maps each advisory that has a real fix to:

```
pnpm.overrides["<module_name>@<vulnerable_versions>"] = "<patched_versions>"
```

— key scoped by the advisory's **vulnerable** range, value the advisory's **patched**
range VERBATIM (e.g. `"lodash@<4.17.21": ">=4.17.21"`). It merges into any existing
`pnpm.overrides` in **`package.json`** (pnpm 10 keeps it in `package.json`, NOT
`pnpm-workspace.yaml`), pins EVERY vulnerable node — direct or transitive — at the
source, and applies breaking fixes unconditionally (an override is the hard pin, so
**there is no `--force`**). Advisories with `vulnerable_versions === ">=0.0.0"` (no
fix exists) or `patched_versions === "<0.0.0"` (nothing patched) are skipped. `--fix`
writes only the manifest; a follow-up `pnpm install` rewrites the lockfile / store.
`--audit-level` filters the printed report, not the fix set.

### 4.4 yarn — no native fix → `yarn-audit-fix`

Neither yarn lineage ships a remediation command: yarn-classic has `yarn audit`
(scan) and berry has `yarn npm audit` (scan) — both query-only. Remediation is
supplied by **`yarn-audit-fix`** (yaf), which implements the **range-bump** model in
npm parity across every lockfile format this library reads: default applies only
semver-compatible (in-range) fixes and flags the rest; `--force` applies SemVer-major
upgrades and rewrites the declared range in `package.json`. Like npm, yaf leaves an
`overrides` / `resolutions` pin untouched even under `--force` (an override is authority,
not a range to widen).

### 4.5 bun — scan only

`bun audit` (bun ≥ 1.2.15) queries the npm advisory API and reports; there is **no
`bun audit fix`**. The manual channel is bun's honouring of BOTH npm `overrides` and
yarn `resolutions`, which surface as a top-level `overrides` block in `bun.lock` — an
override-pin done by hand. Bun's blunt automatic option is `bun update`.

### 4.6 deno — native, constraint-preserving fix

Deno is the **inverse of bun**: it ships BOTH `deno audit` (scan) and native
remediation. `deno audit fix` / `deno audit --fix` (Deno 2.6+) upgrades each affected
package to the **nearest patched version that still satisfies the declared
constraints** — a constraint-preserving, in-range bump across BOTH npm and JSR deps.
Because it stays inside the declared constraints by design, there is no documented
`--force` breaking-bump escape hatch (unlike npm); `--level=high` gates by severity
and advisories can be suppressed by CVE id. Advisory source is the **GitHub
Advisory / CVE** database (+ optional socket.dev), not the npm bulk endpoint —
see [`spec/pm/deno.md §6.3`](./deno.md#63-advisories--audit--deno-audit-directly-on-this-projects-spine).
For deno the native path is real and constraint-aware, so this library's value-add is
cross-PM / format breadth rather than the fix itself.

---

## §5 The `--force` axis

`--force` is the boundary between "stay inside the declared semver contract" and
"cross it." It is meaningful ONLY for the range-bump model — the override-pin model
crosses the contract by design and has no such flag.

| PM | default (no `--force`) | `--force` |
|---|---|---|
| **npm 7+** | in-range fixes only; a SemVer-major / out-of-range fix is withheld and reported "fix available via `npm audit fix --force`" | applies out-of-range + SemVer-major fixes to top-level deps (bumps/ rewrites the range); ALSO overrides peerDependency conflicts and `engines`/platform checks (except optional deps, checked with force off so unusable ones still prune) |
| **npm 6** | applies `install`/`update` actions; withholds `isMajor` actions, prints "use `npm audit fix --force` to install breaking changes" | additionally applies the server's `isMajor` actions |
| **yarn (yaf)** | in-range only; flags a fix that needs a major bump or that breaks a consumer's declared range | applies SemVer-major upgrades and rewrites the declaring `package.json` range |
| **pnpm** | — (no flag) — an override applies the patched range whether or not it is a major bump | — |
| **deno** | — (no flag) — `deno audit fix` stays inside the declared constraints (nearest patched satisfying version) | — (no breaking-bump escape hatch documented) |
| **bun** | — (no fix command) | — |

Invariant across the range-bump PMs: **`--force` does NOT rewrite an existing
`overrides` / `resolutions` pin** — a user-declared override is authority the fixer
respects, not a range to widen. `--force` also never touches a git/file/url spec (there
is no registry version to move to).

---

## §6 Modifiers (range-bump PMs)

- **`--dry-run`** — compute + report the fix, write nothing.
- **`--package-lock-only`** (npm) — write the lockfile only, no `node_modules`; npm rejects `audit fix` outright under `--no-package-lock` (a fix needs a lock to write).
- **`--audit-level <low|moderate|high|critical>`** — gates the REPORT / exit code only; it does NOT constrain which vulns get fixed (npm and pnpm alike).
- **`--omit` / `--include <dev|optional|peer>`** — narrows which dependency groups are audited and therefore fixed.
- **workspaces** (`-w` / `--workspaces`) — restricts the fix to the named workspace's deps.

---

## §7 Frozen-install interaction (why this library models it)

Audit-fix is this library's driver feature because a fix is only useful if the PM's
own **freeze mode** accepts it with NO rewrite (`npm ci`, `yarn install --frozen-lockfile`
/ `--immutable`, `pnpm install --frozen-lockfile`) — a fix that desynchronises the
manifest from the lockfile fails CI. That imposes model-faithfulness on the emitted
artefact:

- the **range-bump** model must keep the manifest range and the locked version in
  agreement (a bumped `^4`→`^5` matched by a `5.x` resolution), re-key the lockfile
  entry by the DECLARED descriptor not the resolved version ([`_common §1.8`-class
  entry-key fidelity](../formats/_common.md), the `yarn-classic` bump case), and carry
  a byte-exact integrity/checksum for the minted node ([`spec/formats/_common.md §1.7.1`](../formats/_common.md#171-checksum-recompute-reproducibility));
- the **override-pin** model must write the `overrides`/`resolutions` block the target
  PM reads (pnpm `pnpm.overrides` in `package.json`, bun `overrides` in `bun.lock`) and
  leave the declared ranges untouched.

So the fix engine is not "pick the highest safe version" — it is "produce the exact
manifest+lock edit the target PM would produce, in that PM's model, such that the PM
re-reads it as already-satisfied."

---

## Sources

- npm 7+: `@npmcli/arborist` `lib/audit-report.js`, `lib/vuln.js`, `lib/arborist/build-ideal-tree.js`, `lib/arborist/reify.js`, `lib/arborist/index.js`; `npm-pick-manifest/lib/index.js`; npm `lib/commands/audit.js`; `@npmcli/config` force definition. Read from `pm-npm-10` (Arborist 8) + `pm-npm-11` (Arborist 9) — fix path byte-identical bar npm 11 dropping the `/audits/quick` fallback.
- npm 6: `lib/audit.js`, `lib/install/audit.js`, `lib/install/save.js` (`pm-npm-6`, 6.14.18).
- pnpm: bundled `dist/pnpm.cjs` `audit/lib/fix.js` + `audit/lib/audit.js` (`pm-pnpm-6` / `-9` / `-10`).
- yarn: no native fix; remediation model read from `yarn-audit-fix` (`src/main/ts/lockfile.ts`, `cli.ts`).
- bun: `bun audit` surface — [`spec/pm/bun.md`](./bun.md); no fix command.
- **Advisory endpoints (§2), verified first-hand from installed source:** npm-10 `advisories/bulk` + `/audits/quick` fallback, npm-11 `advisories/bulk` only (arborist / npm-audit-report); pnpm `${registry}-/npm/v1/security/audits` (`pnpm.cjs`, pnpm 6.35 / 9.15 / 10.0); yarn-classic `${registry}/-/npm/v1/security/audits` (`pm-yarn-1` 1.22.22 `lib/cli.js`); yarn-berry `/-/npm/v1/security/audits/quick` (`pm-yarn-2` 2.4.3 `bin/yarn.js`).
- Advisory transport (registry side): [`spec/registry/_common.md §8`](../registry/_common.md#8-advisories--audit-api).
