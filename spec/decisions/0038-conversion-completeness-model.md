# ADR-0038 — Evidence-layered conversion assessment and frozen certification

> Status: `accepted`
> Date: `2026-07-13`
> Design provenance: sequential Codex/Claude design and adversarial review,
> accepted by Anton through seven stable-state gates and the strict conversion
> redesign. The implementation commits are recorded in §5.

## Context

An unqualified claim that a lockfile conversion is "supported" or
"frozen-clean" combines different guarantees:

1. the resolved graph can be represented by the target lock format;
2. authored resolution policy survives in the lock or project configuration;
3. the complete target project consists of a coherent lock plus companion files;
4. one exact package-manager version accepts that project without rewriting its
   inputs.

These guarantees cannot be inferred from graph shape alone. An absent fact may
mean either "authoritatively absent" or "not observable from this source." Some
policy is outside the lock: npm and Yarn read overrides or resolutions from the
root manifest, while pnpm also reconciles its lock carrier with project config.
Package metadata and target-specific integrity may require manifests, registry
records, or artifact bytes. Native frozen acceptance is empirical and is scoped
to an exact manager, version, platform, configuration, and input tree.

A permissive converter can therefore emit plausible bytes while lacking the
evidence needed for a project or frozen guarantee. The architecture needs to
represent unknowns explicitly, withhold certified output, and remain a converter
rather than becoming a package-manager orchestrator.

## Decision

### 1. Separate contracts, completeness, and readiness

Lockgraph exposes four cumulative conversion contracts:

| Contract | Guarantee |
| --- | --- |
| `snapshot` | The canonical resolved graph is projected into the target lock format. |
| `policy` | The authored resolution policy is preserved or a typed loss is reported. |
| `project` | A coherent target lock and required companion operations are produced. |
| `frozen` | The exact projected project has a successful native frozen-install receipt. |

Every `ConversionAssessment` contains typed requirements with one of three
statuses:

- `satisfied` — the requirement is proven by modeled facts and evidence;
- `unsatisfied` — a known target limitation, conflict, or irreducible loss
  prevents the requested contract;
- `unassessed` — required authoritative or runtime evidence is unavailable.

The aggregate is `satisfied` only when every requirement for the requested
contract is satisfied. Certified APIs do not turn `unassessed` into success.

Canonical completeness is separate from target readiness. `completenessOf`
reports a multidimensional conservative profile for topology, resolved graph,
edge kinds, peers, policy, package metadata, artifacts, layout, and verification.
`sourceCapabilitiesOf` supplies a generation-aware floor; target profiles and
runtime projection results decide whether that evidence satisfies a particular
contract. A complete canonical dimension is not silently redefined per target.

### 2. Keep evidence outside Graph identity

Evidence is retained in an immutable `EvidenceContext` associated with a graph,
not embedded in canonical `Graph`, `Node`, or `Edge` identity. The public ledger
records provenance references; normalized manifests, config authority, package
metadata, artifact observations, and oracle bindings remain in private runtime
state.

The rules are:

- parse attaches source-lock and explicitly supplied local evidence;
- authoritative evidence can establish presence or absence;
- inference may fill a working graph but cannot prove completeness or frozen
  verification;
- conflicting authoritative inputs emit diagnostics and lower the affected
  requirements;
- evidence is scoped to its graph and exact subject; it is never generalized to
  a mutated graph or another target;
- a bare `graph.mutate()` does not inherit side-table evidence. Callers either
  thread the prior context explicitly or use evidence-aware operations that
  return a newly associated graph.

This preserves canonical graph equality and seal semantics while preventing the
absence of a diagnostic from being mistaken for proof.

### 3. Use one parse → enrich → stringify pipeline

There are no pairwise converters. Every conversion follows the same model:

```text
normalize input → parse source → optionally enrich for target → stringify target
```

- **Parse** is offline. It builds the canonical graph and records only facts
  available from the lock and explicitly supplied project input.
- **Enrich** is opt-in and target-aware. It consumes caller-controlled
  manifests, registry, artifact, and config sources; it fills only facts proven
  by those sources and diagnoses unresolved or conflicting facts.
- **Stringify** is offline. It performs one target projection, emits from that
  projection, reparses the output when required, and feeds the same projection
  result into assessment. Gate and emitter must not select independent
  authorities.

The public surface forms a raw/certified matrix:

| Input | Raw projection | Certified projection |
| --- | --- | --- |
| `Graph` | `stringify` | `stringifyAssessed` |
| Lock or project input | `convert` | `convertAssessed` / `convertProject` |

`projectCompanionsOf` is the pure planning primitive for owned manifest or
workspace-config fields. `convertProject` returns the target lock and the exact
ordered companion operations as one immutable bundle only when the `project`
contract is satisfied. The library describes operations and never writes them to
the filesystem.

### 4. Make projection strict by default

Raw `stringify` and `convert` use `strict: true` by default. They share the
certified target-projection gate; `convert` additionally enforces source and
snapshot readiness after enrichment.

Projection losses are classified:

- an enrichable loss names the missing evidence source;
- an inherent meaningful loss requires explicit `strict: false` best-effort
  opt-in;
- the Berry checksum class remains pending only for the narrow frozen-oracle
  path described in §6.

Strict failure throws a structured `LockfileError` and returns no misleading
output. `strict: false` preserves an explicit compatibility escape hatch, but it
does not upgrade an assessment or create a certified result. A fact that a
mutable install could regenerate is still missing when an immutable install
would reject or rewrite the projection.

### 5. Preserve the seven-state assessment architecture

The final design was landed as seven stable states. Each state remains a
load-bearing layer rather than discarded implementation history:

| State | Permanent architectural contribution | Commit |
| ---: | --- | --- |
| 1 | Preserve native pnpm workspace-peer attribution and surface typed gaps instead of collapsing identity. | `a974f45` |
| 2 | Add capability floors, the evidence ledger, completeness profiles, target requirements, and structured assessed conversion. | `a31d1fa` |
| 3 | Restore workspace-peer facts from exact authoritative evidence and use one plan for both gate and emitter. | `c6239dc` |
| 4 | Add pure, immutable, verified project companion projection from canonical policy authority. | `197512b` |
| 5 | Assess the closed canonical package-metadata universe against authoritative exact-package evidence. | `bcea386` |
| 6 | Add `convertProject`, withholding both lock and companions unless the whole project contract is satisfied. | `ae08de5` |
| 7 | Add exact native frozen-install certification through an opaque candidate and bound receipt. | `b74f9e7` |

Before State 7, the conversion pipeline was made explicit and safe through the
documented model (`fee0f27`), metadata hydration (`68d8dd7`), target-aware
enrichment (`816be13`), composite input normalization (`4435c79`), and the
strict-default gate (`7665371`). These are cross-cutting prerequisites, not an
eighth assessment state.

### 6. Split frozen certification around an external oracle

Frozen certification has two library phases separated by a consumer-controlled
native package-manager oracle:

```text
prepareFrozen → external exact-version native oracle → certifyFrozen
```

1. `prepareFrozen` requires an exact full target manager version and runs the
   normal parse, enrichment, companion projection, emission, and output-probe
   gates. It returns an immutable opaque `FrozenCandidate` only when every
   non-oracle requirement is ready. The candidate remains `unassessed` for
   frozen verification and is not an applicable certified result.
2. The external runner materializes the exact lock and ordered companion
   operations in an isolated project, runs the exact manager's native
   frozen/immutable command, and issues a receipt only after successful exit and
   an unchanged protected input tree.
3. `certifyFrozen` accepts only the original runtime-bound candidate. It
   recomputes the projection digest from private candidate state, checks the
   receipt protocol and exact target/projection, requires well-formed recorded
   platform/config/input digests and oracle identity, then returns the same lock
   and companion objects with a satisfied assessment. Failure returns no
   artifacts.

Core never shells out. The native runner is a consumer/CI responsibility.
Repository tests bundle calibrated pinned producers, but external callers may
provide receipts for other exact versions without changing core.

The only pre-oracle target-loss exception is a classifier-produced missing Yarn
Berry checksum for a Berry-zip target. No placeholder checksum is fabricated.
Only a receipt for that exact candidate may discharge that pending checksum and
the paired integrity requirement; no oracle receipt discharges unrelated source,
project, or projection gaps.

### 7. Treat receipt binding as integrity, not authenticity

The versioned projection digest binds the exact target format/version, lock path
and bytes, and ordered companion operations. The receipt additionally records
platform, config digest, input-tree digest, and oracle identity. Candidate object
identity and private retained state prevent a hand-built, copied/spread, or
target-tampered candidate from being certified.

These checks provide **integrity**: a receipt cannot be reused for another
projection or target, and every claim remains scoped to the input, config, and
platform tuple recorded by the receipt. They do not provide **authenticity**:
core cannot prove that an untrusted party actually ran the declared
package-manager binary. Lockgraph's own frozen claims rely on CI running
calibrated pinned binaries. A third-party `frozen-verified` result is only as
trustworthy as the authority that produced the receipt, unless a separate
signed-attestation system establishes authenticity.

## Consequences

- **Positive:** conversion guarantees are explicit, machine-readable, and
  fail-closed; missing evidence is distinguishable from known incompatibility.
- **Positive:** raw, assessed, project, and frozen APIs share one projection and
  evidence model, reducing gate/emitter divergence.
- **Positive:** native frozen acceptance is extensible to exact external manager
  versions without putting process execution in core.
- **Cost:** capability tables, canonical metadata fields, companion grammars,
  evidence authority, and native-oracle calibration must evolve together as
  package-manager behavior changes.
- **Boundary:** neither `strict: false` nor a caller-supplied receipt is a proof of
  authenticity. Consumers must choose and secure their evidence authorities.
- **Deferred:** additional calibrated producers, platforms, and signed
  attestations are additive follow-ups; they do not weaken the exact existing
  contract.

## Alternatives considered

- *One `complete` or `supported` boolean* — rejected because completeness is
  multidimensional and evidence-relative.
- *Purely structural completeness* — rejected because graph shape cannot
  distinguish authoritative absence from missing observation.
- *Diagnostics as the sole authority* — rejected because some missing facts
  never emit a parse diagnostic; capability floors and evidence are primary.
- *Per-field provenance inside canonical Graph* — rejected because it would
  change graph identity, equality, and sealing semantics.
- *Permissive projection by default* — rejected because it returns plausible
  but knowingly incomplete artifacts without an explicit opt-in.
- *Core-owned live package-manager execution* — rejected to keep the library
  deterministic, offline by default, and free of ambient process authority.
- *Treat `prepareFrozen` output as certified* — rejected because preparation can
  prove readiness but not empirical native acceptance.
- *Accept manager ranges or major-version receipts* — rejected because frozen
  behavior and lock interpretation can change between exact releases.

## Links

- [`CONVERT.md`](../../CONVERT.md) — contract, pipeline, companion, and frozen
  lifecycle reference.
- [`README.md`](../../README.md#frozen-certified-conversion) — public frozen API
  and trust-boundary example.
- PM-native attribution stays outside the canonical graph; this decision treats
  it as evidence or adapter state rather than canonical identity.
- [ADR-0017](./0017-graph-seal-workspace-edges.md) — graph sealing and
  workspace-peer identity groundwork.
- [ADR-0023](./0023-graph-modification-and-completion.md) and
  [ADR-0024](./0024-optimize-phase.md) — graph modification, completion, and
  optimization phases.
- [ADR-0025](./0025-manifest-overrides.md) — authored policy carriers and the
  evidence-lifecycle precedent.

## §8 Revision (2026-07-16) — Structural-expected package-metadata projection

### Concern

Completion and mint (`payloadOfPackumentVersion`) hydrate packument metadata onto
minted nodes. Projecting a node whose target lock format has no slot for such a field
currently fails strict as an `inherent-meaningful` loss, which §4 raises to
`IRREDUCIBLE_LOSS` and requires `strict:false` to bypass. This blocks the common
audit-fix case: a completed transitive dependency that declares `engines` (or, from a
full-manifest fetch, `deprecated` or `bin`) cannot round-trip through yarn-classic or
yarn-berry strict, even though no yarn lock format persists those fields and dropping
them is frozen-clean. Two gates fire independently: the `metadataPreflight` classifier,
and the output probe, because `canonicalGraphSnapshot` carries these fields so an emit
that omits them yields `COMPLETENESS_OUTPUT_GRAPH_MISMATCH`.

### Decision

The §4 taxonomy gains a fourth projection-loss class, `structural-expected`: a canonical
package-metadata field whose drop on a specific target is confirmed frozen-clean — the
target lock never persists the field, so an immutable install never rewrites or rejects
for it — and advisory. It emits a warning diagnostic and does not raise `IRREDUCIBLE_LOSS`;
strict projection does not block on it.

The safe `(field, target)` pairs are an explicit allowlist, the single source of truth
for both the classifier and the output probe. The allowlist is not derived from
`target.capabilities.metadataFields`: that table is a conservative blunt guard, not a
safe-to-drop oracle. Two tables under-report what their format stores — `bun.lock`
records `os`, `cpu`, and `bin` per package while its table is empty, and pnpm records
`bin` as `hasBin` — so deriving "safe to drop" from the table complement would certify a
frozen-breaking loss. The allowlist admits only per-pair-verified true negatives.

Initial allowlist:

| field | targets | basis |
| --- | --- | --- |
| `engines` | yarn-classic, yarn-berry-v4 … v10 | no yarn lock stores `engines`; engine-strict is opt-in |
| `deprecated` | yarn-classic, yarn-berry-v4 … v10 | no yarn lock stores `deprecated` |
| `bin` | yarn-classic | classic v1 stores no per-package metadata; `bin` derives from the installed manifest |

Pairs deliberately excluded and kept `inherent-meaningful`: `bin` on yarn-berry, bun, and
pnpm (all store it); `os` and `cpu` on bun (platform gating it stores and regenerates);
`engines` on pnpm and npm (both store it). Everything absent from the allowlist stays
`inherent-meaningful`. The allowlist is extended only when a new pair is independently
verified frozen-clean, never by table inference.

### Mechanism

Both layers are driven by the allowlist. The `metadataPreflight` classifier partitions a
detected metadata loss: allowlisted fields become `structural-expected`, the rest remain
`inherent-meaningful`. The strict gate (`format-api` and `convert/orchestrator`) throws
only on the non-`structural-expected` losses; `structural-expected` losses surface as
warnings. `canonicalProjectionGraphSnapshot` drops an allowlisted field for its target
from both sides of the snapshot comparison; a field not on the allowlist is retained and
compared, so any real drop still mismatches and fails closed.

### Consequences

- The audit-fix completion case goes green for the allowlisted pairs while the assessment
  still surfaces each drop as a warning diagnostic.
- The allowlist is a small, per-pair-verified, inspectable table, extended only on proof.
- `inherent-meaningful` is unchanged for install-affecting features and for every
  non-allowlisted metadata pair; `strict:false` remains the escape hatch.
- The `bun` and `pnpm` `metadataFields` inaccuracies are recorded as a separate follow-up;
  they affect other capability decisions and the feasibility of minted bun and pnpm
  metadata round-trips, not the soundness of this decision.

### Alternatives rejected

- *Reclassify the `target.capabilities.metadataFields` complement* — rejected as unsound:
  an adversarial review confirmed it certifies frozen-breaking losses for `bun`
  (`os`/`cpu`/`bin`) and pnpm (`bin`) because the tables under-report stored fields.
- *Drop target-unstorable metadata at completion instead of projecting per-target* —
  rejected because it couples completion to one target and loses metadata for targets that
  do store it (for example `engines` on pnpm), violating the §1 separation of canonical
  completeness from target readiness.
- *Fix the capability tables to be precise and keep using the complement* — deferred to a
  separate track; not required once the allowlist is the source of truth, and larger in
  blast radius.

### §8.1 addendum (2026-07-17) — Overrides with no target carrier are recoverable, not irreducible

The same frozen-clean reasoning extends to a supplied override that the target lock format
structurally cannot carry. yarn-classic, yarn-berry, npm, and bun locks have no overrides
block; the pin lives in the project manifest (`resolutions` / `overrides`), where it was read
from, and an immutable install honours it there. `INTEROP_OVERRIDE_NOT_PROJECTED` is therefore
classed `enrichable` (it surfaces as `ENRICH_REQUIRED`, remedy `use-project-api convertProject`),
not `inherent-meaningful` — a lock that cannot hold an override must not fail-closed on it.
Unlike the metadata `structural-expected` class, this remains a blocking-but-recoverable loss:
the override needs an action (the project API, or the manifest carrier) to be persisted, so raw
strict still reports it rather than passing silently. pnpm locks DO carry an overrides block, so
they project the override and never reach this class.
