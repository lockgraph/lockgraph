# Errors and diagnostics

lockgraph reports problems through two deliberately different channels:

1. **Exceptions** stop the requested operation. Public format and conversion
   APIs throw `LockfileError`; graph construction and mutation can throw
   `GraphError`.
2. **Diagnostics** describe recoverable loss, incomplete evidence, policy
   decisions, and successful transformations. They are returned on graphs or
   results and can also be observed through `onDiagnostic`.

Do not treat every diagnostic as an exception. Callers decide whether an
`info` or `warning` is acceptable for their workflow. An `error` diagnostic is
blocking evidence; a graph builder refuses to seal while one remains unresolved.

Every diagnostic has this stable carrier:

```ts
interface Diagnostic {
  code: string
  severity: 'info' | 'warning' | 'error'
  subject?: NodeId | EdgeTriple
  message: string
  data?: Record<string, unknown>
}
```

`subject` and `data` are machine-readable context. Do not parse `message`.

## Exceptions

### `LockfileError`

`LockfileError.code` is the discriminant. `cause` retains a wrapped parser or
filesystem failure when available. Projection failures may also expose a frozen
`losses` array; see [Strict projection](#strict-projection).

| Code | Meaning and usual cause | Remedy |
|---|---|---|
| `PARSE_FAILED` | The selected adapter could not parse structurally invalid or truncated input. | Validate the source lockfile and its declared schema/version; use the matching adapter. |
| `FORMAT_DETECT_FAILED` | Conversion could not identify a supported input format. | Pass `from` explicitly or supply a complete supported lockfile. |
| `FORMAT_MISMATCH` | Input or requested output contradicts the adapter's schema marker/profile. | Select the adapter that matches the lockfile version or fix the marker. |
| `CAPABILITY_LACK` | The adapter recognises the format but cannot represent a required schema capability or version. | Use a supported schema/target or preserve the data through `lockgraph`. |
| `INVALID_INPUT` | An API option, path, graph slot, or modifier argument fails validation. | Correct the value identified by the message; do not retry unchanged. |
| `MISSING_REQUIRED_FIELD` | A value required for emission is absent. Currently emitted for a Yarn Berry dependency edge without `attrs.range`. | Supply the missing graph field or rebuild the graph from authoritative manifests/lock data. |
| `ENRICH_REQUIRED` | Strict projection found only enrichable losses. | Supply the indicated `losses[].remedy` evidence, run enrich/project APIs, then retry. |
| `IRREDUCIBLE_LOSS` | Strict projection found inherent semantic loss, or an emitter found a structural identity collision it cannot encode. | Choose a capable target, use `strict: false` only when the loss is accepted, or repair the graph collision. |
| `INVARIANT_VIOLATION` | Format emission or graph reconstruction encountered internally inconsistent canonical state. | Treat as corrupt/hand-built graph state or a library bug; rebuild from valid input and retain the repro. |

### `GraphError`

`GraphError` is separate from `LockfileError`: it protects the canonical graph
model itself.

| Code | Meaning and usual cause | Remedy |
|---|---|---|
| `INVARIANT_VIOLATION` | `seal()` found an invalid node id, dangling/duplicate edge, illegal workspace incoming edge, unresolved error diagnostic, or a builder was used after sealing. | Fix the builder inputs or operation order before sealing. |
| `PATCH_REJECTED` | `GraphMutator.apply()` could not apply an operation: its subject was missing, duplicated, still referenced, or would collide after replacement. | Rebase the patch against the current graph and order removals/rewires before deleting referenced nodes. |

## Strict projection

All projection loss first appears as a `PROJECTION_LOSS` warning carrying a
classified `ProjectionLoss`. With strict stringify (the default), the loss set
is converted to one exception:

- all losses are `enrichable` or `berry-checksum` → `ENRICH_REQUIRED`;
- any `inherent-meaningful` loss → `IRREDUCIBLE_LOSS`.

Use `error.losses`, not message matching. Each loss has one remedy:

| Remedy | Action |
|---|---|
| `{ kind: 'supply', source: 'registry' | 'artifacts' | 'manifests' | 'config' }` | Provide the missing authoritative evidence. |
| `{ kind: 'use-project-api', api: 'convertProject' }` | Emit the lockfile and required companion manifest/config patches as one bundle. |
| `{ kind: 'allow-loss', option: 'strict', value: false }` | Explicitly accept a lossy lockfile-only projection. |
| `{ kind: 'verify-target', requirement: 'pinned-frozen-oracle' }` | Run the exact target manager in frozen mode and certify its receipt. |

## Diagnostic catalogue

Generated format codes use the following notation in the tables:

- `YARN_BERRY_V{4..10}_X` means the seven concrete codes from
  `YARN_BERRY_V4_X` through `YARN_BERRY_V10_X`;
- `NPM_V{2,3}_X` and `PNPM_V{6,9}_X` expand to the two named versions;
- `{BUN_TEXT,NPM,PNPM,YARN_CLASSIC}_X` expands to those four concrete prefixes.

For example, `YARN_BERRY_V9_UNKNOWN_METADATA_DROPPED` is the v9 member of
`YARN_BERRY_V{4..10}_UNKNOWN_METADATA_DROPPED`; the literal example is included
so runtime output remains directly searchable.

### Parse, graph, and adapter fidelity

| Code | Severity | Meaning / cause | Remedy |
|---|---:|---|---|
| `SEAL_PUBLISHED_SELF_LINK` | info | A published dependency resolved to a co-located workspace self-link; sealing accepted the known special case. | No action unless the published/workspace binding was unintended. |
| `LAYOUT_PLACEMENT_RESYNTHESISED` | info | npm placement metadata was rebuilt from graph layout. | Verify layout only when byte-level placement is significant. |
| `LAYOUT_RESOLVE_VIOLATION` | error | The graph cannot be laid out while preserving the requested dependency binding. | Repair peer/dependency placement evidence or choose a compatible target. |
| `{BUN_TEXT,NPM,PNPM,YARN_CLASSIC}_INVALID_INTEGRITY` | warning | A present integrity value had no recognised hash shape and was dropped. | Repair the source integrity or provide verified artifact bytes. |
| `BUN_TEXT_BAD_ENTRY` | warning | A Bun text entry is malformed or lacks required identity fields. | Regenerate `bun.lock` with Bun or fix the entry. |
| `BUN_TEXT_UNRESOLVED_DEP` | warning | A Bun dependency descriptor could not be bound to a parsed node. | Supply the missing entry/manifest or regenerate the lock. |
| `BUN_TEXT_PEER_VIRT_FLATTENED` | warning | Peer-virtual identity was flattened because Bun text cannot encode it. | Accept the loss or target a peer-virtual-capable format. |
| `DENO_MANIFEST_REQUIRED` | error | Cross-format Deno projection has no sibling `deno.json`/`deno.jsonc` or `package.json`, so root dependency declarations and dev/production scope cannot be established. The conversion also throws `INVALID_INPUT`. | Supply the sibling root manifest as conversion evidence before targeting a Node-family lock. |
| `DENO_JSR_PACKAGES_DROPPED` | warning | Deno → Node-family conversion projects only the npm subgraph and omits the counted JSR packages. | Transform source dependencies first with `denoland/dnt` when npm output is required; Lockgraph does not invoke or certify dnt. |
| `DENO_REMOTE_PACKAGES_DROPPED` | warning | Deno → Node-family conversion projects only the npm subgraph and omits the counted remote URL modules. | Transform source dependencies first with `denoland/dnt` when npm output is required; Lockgraph does not invoke or certify dnt. |
| `DENO_DEP_PROJECTION_UNRESOLVED` | warning | A required native Deno npm dependency reference has no package that can be projected into the canonical graph. | Restore/regenerate the referenced npm package record before conversion. |
| `DENO_OPTIONAL_DEP_PROJECTION_UNRESOLVED` | warning | An optional native Deno npm dependency reference has no package that can be projected into the canonical graph. | Restore/regenerate the referenced npm package record before emission or conversion. |
| `DENO_PEER_PROJECTION_UNRESOLVED` | warning | A Deno native peer suffix has no unique npm package projection. The preserved raw native suffix remains authoritative for same-format replay. | Restore/disambiguate the npm package records before cross-format conversion; same-format output can retain the native suffix. |
| `DENO_MERGE_CONFLICT` | error | A line-start `<<<<<<<`, `|||||||`, `=======`, or `>>>>>>>` marker makes the native lock ambiguous before JSON parsing. | Resolve the conflict explicitly; the adapter will not choose a supply-chain claim. |
| `DENO_ORPHANED_SECTION_IGNORED` | warning | A populated package section is nested the way a generation *below* the declared `version` nests it, so Deno itself never reads it and the graph does not carry it; the subject names the exact `top-level:<path>`. | Re-declare the lock at the version whose nesting the body uses, or regenerate it with Deno; the section is unreachable as written. |
| `DENO_ORPHANED_SECTION_DROPPED` | error | A version conversion cannot carry an orphaned section, because neither the graph nor the native sidecar holds it and the target document has no key for it; the subject names the exact `top-level:<path>`. | Repair the source lock's declared version first, or explicitly accept the diagnosed loss in non-strict mode. |
| `DENO_V2_NATIVE_SECTION_DROPPED` | error | A conversion to `deno-v2` cannot carry a non-empty JSR, workspace, or redirects section; the subject names the exact `top-level:<section>`. | Use a newer Deno target or explicitly accept the diagnosed loss in non-strict mode. |
| `DENO_V3_NATIVE_SECTION_DROPPED` | error | A conversion to `deno-v3` cannot carry a non-empty redirects section; the subject is `top-level:redirects`. | Use `deno-v4`/`deno-v5` or explicitly accept the diagnosed loss in non-strict mode. |
| `DENO_V2_V5_ENTRY_FIELDS_DROPPED` | error | `deno-v5` → `deno-v2` drops the exact listed v5-only npm-entry fields for the subject native id. | Use `deno-v5` or accept the target-addressed downgrade loss in non-strict mode. |
| `DENO_V3_V5_ENTRY_FIELDS_DROPPED` | error | `deno-v5` → `deno-v3` drops the exact listed v5-only npm-entry fields for the subject native id. | Use `deno-v5` or accept the target-addressed downgrade loss in non-strict mode. |
| `DENO_V4_V5_ENTRY_FIELDS_DROPPED` | error | `deno-v5` → `deno-v4` drops the exact listed v5-only npm-entry fields for the subject native id. | Use `deno-v5` or accept the target-addressed downgrade loss in non-strict mode. |
| `NPM_BAD_ENTRY` | warning | An npm entry is malformed or incomplete and was skipped/degraded. | Regenerate the package lock or repair that entry. |
| `NPM_UNRESOLVED_DEP` | warning | An npm dependency path/range could not be bound to a node. | Restore the missing package entry or manifest evidence. |
| `NPM_V1_WORKSPACES_UNSAFE` | warning | npm v1 cannot faithfully represent the workspace graph. | Emit npm v2/v3/v4 or use a project-level conversion. |
| `NPM_V1_PEER_DROPPED` | warning | npm v1 has no peer representation for the edge. | Choose npm v2/v3/v4 or accept the loss. |
| `NPM_V1_PEER_UNSATISFIED` | warning | No npm v1 ancestor satisfies a peer range. | Correct/pin the peer dependency. |
| `NPM_V1_PEER_AMBIGUOUS` | warning | Multiple npm v1 candidates could satisfy the peer and no safe choice exists. | Supply authoritative layout/manifests or disambiguate versions. |
| `NPM_V1_NO_MANIFESTS` | warning | npm v1 peer/layout reconstruction needed manifests that were not supplied. | Pass complete manifests. |
| `NPM_V1_PEER_VIRT_FLATTENED` | warning | Peer-virtual identity was flattened for npm v1. | Use a target that preserves peer instances or accept the loss. |
| `NPM_V2_DUAL_MODE_DRIFT` | warning | npm v2's root dependency view and legacy package mirror disagree. | Regenerate the lock or resolve the two representations. |
| `NPM_V{2,3,4}_ROOT_VERSION_SYNTHESIZED` | info | The adapter supplied the canonical synthetic workspace-root version. | No action unless a real root manifest version should be supplied. |
| `NPM_V{2,3,4}_WORKSPACE_MEMBER_SYNTHESIZED` | info | A workspace package entry was synthesized from canonical graph state. | Supply complete manifests when exact package metadata matters. |
| `NPM_V{3,4}_UNEXPECTED_LEGACY_MIRROR` | warning | A packages-only npm lock contains an unexpected legacy mirror that disagrees with canonical data. | Regenerate with the intended npm version. |
| `NPM_V{2,3,4}_PEER_UNSATISFIED` | warning | No layout ancestor satisfies a peer range. | Correct/pin the peer or provide compatible layout evidence. |
| `NPM_V{2,3,4}_PEER_AMBIGUOUS` | warning | Several layout candidates can satisfy a peer with no unique binding. | Disambiguate the layout/version set. |
| `NPM_V{2,3,4}_PEER_VIRT_FLATTENED` | warning | npm cannot encode the source peer-virtual identity exactly. | Accept projection loss or use a preserving target. |
| `NPM_V4_PATCH_UNRESOLVED` | warning | npm v4 patch bytes were unavailable, so canonical identity is an unresolved sentinel while the native carrier is preserved. | Pass the project `workspaceRoot` with the patch file present before cross-format work. |
| `NPM_V4_PATCH_INTEGRITY_MISMATCH` | warning | Available npm v4 patch bytes do not match the native raw-byte SRI; canonical identity follows the bytes while the SRI is preserved. | Restore the patch file recorded by the lock or regenerate the lock with npm 12. |
| `PNPM_BAD_ENTRY` | warning | A pnpm package/snapshot entry is malformed or incomplete. | Regenerate `pnpm-lock.yaml` or fix the entry. |
| `PNPM_UNRESOLVED_DEP` | warning | A pnpm dependency reference could not be bound to a package/snapshot. | Restore the missing record or provide manifests. |
| `PNPM_WORKSPACE_LINK_PEER_BOUND` | info | A resolved-tree `link:` slot names a workspace member that the consumer's peer edge already binds. Nothing is lost; the slot is replayed verbatim. | No action; this is observability. |
| `PNPM_WORKSPACE_LINK_EDGE_DROPPED` | warning | A resolved-tree `link:` slot names a workspace member with no peer binding (hashed peer set, or an `overrides:` redirect). A published package carries no dependency edge into a workspace member, so the slot is replayed verbatim but no edge models it. | Supply the consumer's manifest, or accept the loss. |
| `PNPM_WORKSPACE_PEER_ATTR_MISSING` | warning | Workspace-peer projection lacks the original peer attribute needed for faithful output. | Supply complete manifest/evidence data. |
| `PNPM_WORKSPACE_PEER_ATTR_COLLISION` | warning | Several workspace-peer facts project to incompatible attributes. | Resolve the conflicting workspace/peer declarations. |
| `PNPM_V5_DUAL_TOP_LEVEL_DRIFT` | warning | v5 `dependencies` and `devDependencies`/`optionalDependencies` views disagree. | Regenerate or reconcile the top-level maps. |
| `PNPM_V5_SETTINGS_DROPPED` | warning | v5 settings cannot be represented by the selected target and were omitted. | Move settings to supported config/target or accept the loss. |
| `PNPM_V5_PEER_BOUND` | info | A v5 peer was bound through reconstructed layout. | No action; this is observability. |
| `PNPM_V5_PEER_UNSATISFIED` | warning | No v5 layout candidate satisfies the peer. | Correct/pin the peer declaration. |
| `PNPM_V5_PEER_AMBIGUOUS` | warning | Multiple v5 peer candidates are equally valid. | Supply manifests/layout evidence or disambiguate. |
| `PNPM_V5_NO_MANIFESTS` | warning | v5 peer reconstruction required manifests. | Pass complete manifests. |
| `PNPM_V{6,9}_SNAPSHOTS_MISSING` | warning | The schema expects a snapshots/package view that is absent. | Regenerate with the matching pnpm generation. |
| `PNPM_V{6,9}_PEER_BOUND` | info | A peer was successfully bound from pnpm layout evidence. | No action. |
| `PNPM_V{6,9}_PEER_UNSATISFIED` | warning | No pnpm layout candidate satisfies the peer. | Correct/pin the peer. |
| `PNPM_V{6,9}_PEER_AMBIGUOUS` | warning | Several pnpm candidates can satisfy the peer. | Supply manifests or disambiguate the graph. |
| `PNPM_V{6,9}_NO_MANIFESTS` | warning | Peer/workspace reconstruction lacks manifests. | Pass complete manifests. |
| `YARN_CLASSIC_UNKNOWN_FIELD` | info | An unrecognised Classic entry field was preserved/ignored. | Usually none; inspect when exact fidelity is required. |
| `YARN_CLASSIC_MISSING_ENTRY` | warning | A dependency descriptor has no matching Classic lock entry. | Restore the entry or supply resolution manifests. |
| `YARN_CLASSIC_NO_MANIFESTS` | warning | Classic resolution/peer reconstruction lacks manifests. | Pass complete manifests. |
| `YARN_CLASSIC_PEER_DROPPED` | warning | Classic cannot faithfully encode a peer edge. | Choose a capable target or accept the loss. |
| `YARN_CLASSIC_PEER_VIRT_FLATTENED` | warning | Peer-virtual identity was flattened for Classic. | Use Berry/pnpm or accept the loss. |
| `YARN_BERRY_BAD_ENTRY` | warning | A Berry entry is malformed or lacks canonical identity. | Regenerate `yarn.lock` or repair the entry. |
| `YARN_BERRY_PATCH_UNRESOLVED` | warning | A Berry patch locator cannot be connected to its base package/bytes. | Supply the patch file and base entry. |
| `YARN_BERRY_UNRESOLVED_DEP` | warning | A Berry dependency descriptor could not be resolved through the ladder. | Supply manifests/overrides or restore the missing entry. |
| `YARN_BERRY_V{4..10}_INVALID_INTEGRITY` | warning | A Berry checksum is malformed and was dropped. | Regenerate with Yarn or provide verified cache bytes. |
| `YARN_BERRY_V{4..10}_PEER_UNSATISFIED` | warning | No candidate satisfies a Berry peer range. | Correct/pin the peer dependency. |
| `YARN_BERRY_V{4..10}_PEER_AMBIGUOUS` | warning | Multiple Berry candidates can satisfy a peer. | Supply manifests or disambiguate versions. |
| `YARN_BERRY_V4_CONDITIONS_DROPPED` | warning | v4 cannot encode a later Berry `conditions` field. | Target v5+ or accept the condition loss. |
| `YARN_BERRY_V{4..10}_UNKNOWN_METADATA_DROPPED` | error | The source carries a producer-invalid unknown `__metadata` subkey. Non-strict output performs the measured producer-faithful repair, removes the key, and names its full `__metadata.<key>` path; strict output fails closed on the same loss. Producer evidence refuted the previous `compressionLevel` pass-through assumption: all seven pinned generations remove it, including under non-default compression configuration, which changes `cacheKey` instead of preserving `compressionLevel` as lock metadata. | Remove the named subkey or explicitly use non-strict output and retain the diagnostic; verify repaired output with the exact pinned Yarn producer. |
| `YARN_BERRY_V{4..10}_PEER_VIRT_FLATTENED` | warning | The selected projection flattened peer-virtual identity. | Use a preserving target or accept the loss. |

### Recipe, override, and conversion projection

| Code | Severity | Meaning / cause | Remedy |
|---|---:|---|---|
| `RECIPE_INTEGRITY_INCOMPLETE` | warning | Source integrity exists, but none of its origin classes fit the target. | Provide target-native artifact bytes or let the target recompute outside frozen mode. |
| `RECIPE_PEER_META_INCOMPLETE` | warning | Requested evidence could not reconstruct `peerDependenciesMeta.optional`. | Supply package manifests/cache/registry metadata. |
| `RECIPE_FEATURE_DROPPED` | warning | The target cannot represent a patch, git, directory, workspace, or unknown resolution feature. | Choose a capable target, use project conversion, or explicitly accept loss. |
| `RECIPE_RESOLUTION_UNKNOWN` | warning | A resolution shape cannot be canonicalised. | Add adapter support or replace it with a supported locator. |
| `RECIPE_WORKSPACE_RESOLVED` | info | A workspace protocol was replaced by its resolved version for the target. | No action if the version substitution is acceptable. |
| `RECIPE_WORKSPACE_COLLAPSED` | info | A rich workspace range was collapsed to `workspace:*`. | Preserve the original manifest if range intent matters. |
| `RECIPE_WORKSPACE_UNRESOLVED` | warning | The target requires a concrete version but workspace evidence lacks one. | Supply complete manifests/resolution evidence. |
| `RECIPE_PATCH_NORMALISED` | info | Patch bytes changed under BOM removal or CRLF→LF normalisation before hashing. | No action; keep canonical bytes under source control. |
| `RECIPE_OVERRIDE_NORMALISED` | info | Native overrides were captured into canonical constraints. | No action. |
| `OVERRIDE_PARENT_REF_DROPPED` | warning | An npm `$name` parent self-reference has no target equivalent. | Rewrite the constraint for the target manager. |
| `BUN_OVERRIDE_NESTED_UNSUPPORTED` | warning | Bun's flat overrides cannot express ancestry-scoped constraints. | Flatten/rewrite policy or use another target. |
| `INTEROP_OVERRIDE_NOT_PROJECTED` | warning | The lockfile carries no authoritative override field (npm/Yarn policy belongs in the manifest). | Use `convertProject` and apply companion manifest patches. |
| `YARN_CLASSIC_AMBIGUOUS_RESOLUTION`, `YARN_BERRY_V{4..10}_AMBIGUOUS_RESOLUTION` | warning | The descriptor ladder found several equally maximal candidates. | Supply authoritative overrides/manifests or disambiguate entries. |
| `YARN_CLASSIC_RESOLUTION_PIN_UNRESOLVED`, `YARN_BERRY_V{4..10}_RESOLUTION_PIN_UNRESOLVED` | info | A descriptor likely points through a non-satisfying manifest resolution pin, but manifests were absent. | Pass `ParseOptions.manifests`. |
| `YARN_BERRY_V{4..10}_PATCH_PREFERRED` | info | The lock-borne patch overlay redirected a registry edge to its sibling patch node without an override. | No action; this documents the intentional redirect. |
| `PROJECTION_LOSS` | warning | One target feature would be lost; `data` and the associated `ProjectionLoss` classify it. | Follow the structured remedy; strict mode converts the set to an exception. |
| `CONVERT_PATCH_BYTES_UNAVAILABLE` | warning | Conversion knows a patch path/fingerprint but cannot read the required bytes. | Supply filesystem access/artifact evidence. |
| `CONVERT_WORKSPACE_MANIFEST_MISSING` | warning | A discovered workspace has no corresponding manifest input. | Include the workspace manifest or correct glob/root options. |

### Completeness, evidence, output probes, and frozen certification

Unless noted otherwise, these diagnostics are blocking assessment evidence:
`warning` is used by requirement/profile evaluation, while orchestrated source,
output, and receipt failures use `error`.

| Code | Severity | Meaning / cause | Remedy |
|---|---:|---|---|
| `COMPLETENESS_REQUIREMENT_UNASSESSED` | warning | Available evidence does not reach a required completeness threshold. | Supply evidence for the named dimension. |
| `COMPLETENESS_TARGET_CAPABILITY_AMBIGUOUS` | warning | Target capability depends on an unspecified manager version. | Pin the exact manager version. |
| `COMPLETENESS_TARGET_FEATURE_UNSUPPORTED` | warning | The target cannot represent a detected graph feature. | Change target or remove/accept the feature loss. |
| `COMPLETENESS_TARGET_REQUEST_INVALID` | warning | Target format/version request is internally inconsistent. | Correct and pin the target request. |
| `COMPLETENESS_TARGET_COMPATIBILITY_OVERLAY_REQUIRED` | error | Berry emission contains a completed base package that requires the pinned target's derived compatibility sibling, but the order-sensitive target overlay did not run. | Use `enrich()` with the exact pinned Berry target after completion and before refurbish/stringify. |
| `COMPLETENESS_MANAGER_GENERATION_AMBIGUOUS` | warning | A manager version maps to more than one possible schema generation. | Supply an exact version/schema. |
| `COMPLETENESS_FEATURE_UNMODELED` | warning/error | A detected feature has no completeness evaluator. | Add evaluator support or avoid claiming the contract. |
| `COMPLETENESS_EVALUATOR_DEFERRED` | warning | Evaluation intentionally deferred because prerequisite evidence is missing. | Supply the prerequisite evidence. |
| `COMPLETENESS_EVIDENCE_CONFLICT` | warning | Two evidence sources assert incompatible facts. | Reconcile or choose one authoritative source. |
| `COMPLETENESS_EVIDENCE_SCOPE_MISMATCH` | warning | Evidence was captured for a different graph/scope. | Recapture evidence for the current graph. |
| `COMPLETENESS_EVIDENCE_INVALID` | error | Caller-supplied evidence failed validation. | Fix the evidence shape, digest, or subject. |
| `COMPLETENESS_MANIFESTS_MISSING` | error | Complete manifest coverage was claimed without manifests. | Supply the complete manifest map. |
| `COMPLETENESS_SOURCE_FORMAT_UNKNOWN` | error | Assessed conversion cannot identify the source. | Pass `from` or valid supported input. |
| `COMPLETENESS_SOURCE_PARSE_FAILED` | error | Source parsing failed during assessed conversion. | Fix the source lockfile/format selection. |
| `COMPLETENESS_ADAPTER_STATE_LOST` | error | A same-format native carrier would be lost on cross-format output, or public mutation detached load-bearing adapter state. `data.feature` identifies each carrier; unknown structured project keys are reported individually as `top-level:<key>` (Classic globals use `global-directive:<key>`). | Keep same-format state attached, avoid the detaching mutation, or explicitly accept non-strict cross-format loss; strict output fails closed. |
| `COMPLETENESS_PACKAGE_METADATA_INCOMPLETE` | warning | Required package metadata is absent. | Supply registry/cache/local metadata evidence. |
| `COMPLETENESS_PACKAGE_METADATA_MISMATCH` | warning | Metadata evidence disagrees with the graph/package identity. | Reconcile the source and graph. |
| `COMPLETENESS_PACKAGE_METADATA_SOURCE_UNSUPPORTED` | warning | The selected evidence source cannot provide the required metadata. | Use a capable registry/cache/manifest source. |
| `COMPLETENESS_MANIFEST_EXTENSION_DEPENDENCY_MISMATCH` | warning | Registry dependency facts differ from a package-manager-extended manifest (`packageExtensions`, `.pnpmfile.cjs`, or equivalent). This is extension evidence, not contradictory registry identity evidence, and does not roll back completion. | Retain the extension fingerprint/config and use the package manager's extended manifest as dependency authority. |
| `COMPLETENESS_POLICY_AUTHORITY_MISSING` | error | Output policy cannot be attributed to an authoritative source. | Supply authored manifest/config policy. |
| `COMPLETENESS_POLICY_AUTHORITY_REQUIRED` | warning | Project companion projection requires authoritative policy. | Supply authored overrides/manifests. |
| `COMPLETENESS_OVERRIDE_GRAMMAR_UNSUPPORTED` | warning | Canonical override cannot be expressed in target grammar. | Rewrite policy or choose a compatible target. |
| `COMPLETENESS_OVERRIDE_PROJECTION_CONFLICT` | warning | Several canonical overrides collapse to one incompatible target selector. | Disambiguate or split the constraints. |
| `COMPLETENESS_OUTPUT_EMIT_FAILED` | error | Target stringify threw during assessed conversion. | Resolve the reported target/graph failure. |
| `COMPLETENESS_OUTPUT_PARSE_FAILED` | error | The emitted lockfile cannot be parsed by its target adapter. | Treat as emitter failure; retain the reproduction. |
| `COMPLETENESS_OUTPUT_FORMAT_REJECTED` | error | The target adapter's `check` rejects emitted output. | Correct target emission/schema selection. |
| `COMPLETENESS_OUTPUT_GRAPH_MISMATCH` | error | Reparsed output differs from the required graph projection. | Resolve the reported loss or emitter mismatch. |
| `COMPLETENESS_OUTPUT_FEATURE_MISMATCH` | error | Reparsed output lost/mutated a required graph feature. | Supply evidence or choose a capable target. |
| `COMPLETENESS_OUTPUT_POLICY_ATTRIBUTION_MISSING` | error | Emitted policy exists without authoritative attribution. | Use project companions/authored policy evidence. |
| `COMPLETENESS_OUTPUT_POLICY_MISMATCH` | error | Reparsed output policy differs from canonical policy. | Reconcile override projection. |
| `COMPLETENESS_OUTPUT_PROBE_FAILED` | error | Output comparison itself threw. | Fix malformed output/graph and retry. |
| `COMPLETENESS_OUTPUT_PROBE_MISSING` | warning | A contract requiring output verification received no probe. | Run the output probe/assessed API. |
| `COMPLETENESS_OUTPUT_PROBE_REJECTED` | warning | The supplied output probe did not accept the output. | Inspect its diagnostics and repair projection. |
| `COMPLETENESS_FROZEN_TARGET_UNPINNED` | error | Frozen certification target is not an exact full manager version. | Pin the exact version. |
| `COMPLETENESS_FROZEN_ORACLE_UNAVAILABLE` | error | No native package-manager frozen oracle exists for the target (notably `lockgraph`). | Use a PM target with a native oracle or a non-frozen contract. |
| `COMPLETENESS_FROZEN_PREPARATION_FAILED` | error | Candidate preparation failed before native verification. | Fix input/evidence/filesystem diagnostics. |
| `COMPLETENESS_FROZEN_PROJECTION_BLOCKED` | error | Non-checksum projection loss makes a frozen candidate unsafe. | Resolve the loss before certification. |
| `COMPLETENESS_FROZEN_BERRY_CHECKSUM_PENDING` | warning | Berry checksum fidelity awaits exact native-PM verification. | Run the pinned Yarn oracle and certify its receipt. |
| `COMPLETENESS_FROZEN_CANDIDATE_INVALID` | error | Candidate was not produced by this runtime or its projection state changed. | Prepare a fresh candidate and do not clone/mutate opaque state. |
| `COMPLETENESS_FROZEN_RECEIPT_INVALID` | error | Receipt protocol, digests, platform, config, or oracle identity is malformed. | Produce a complete receipt from the prescribed runner. |
| `COMPLETENESS_FROZEN_SUBJECT_MISMATCH` | error | Receipt target/projection digest does not match the candidate. | Verify the exact candidate without intervening changes. |
| `COMPLETENESS_FROZEN_VERIFIED` | info | The exact pinned target accepted the project in frozen mode. | No action; retain the receipt as evidence. |

### Modify and completion

| Code | Severity | Meaning / cause | Remedy |
|---|---:|---|---|
| `MODIFY_NODE_REPLACED` | info | A modifier replaced one node identity with another. | No action. |
| `MODIFY_NODE_ADDED` | info | A modifier added a node. | No action. |
| `MODIFY_NODE_REMOVED` | info | A modifier removed a node. | No action. |
| `MODIFY_EDGE_REWIRED` | info | A modifier rewired an edge. | No action. |
| `MODIFY_PATCH_APPLIED` | info | Patch mutation succeeded. | No action. |
| `MODIFY_OVERRIDE_PINNED` | info | Override mutation recorded a resolved pin; `data` carries the package/target. | Persist the projected override/companion. |
| `MODIFY_LICENSE_FLAGGED` | warning | Package license matched a flag policy. | Review caller policy. |
| `MODIFY_LICENSE_BLOCKED` | warning | A blocked-license package is workspace-rooted and cannot be removed safely. | Change policy/dependency roots manually. |
| `MODIFY_RESOLVE_FAILED` | warning | Registry resolution returned no version. | Check range, registry, and resolver evidence. |
| `MODIFY_SENTINEL_REFUSED` | warning | Byte-changing mutation was refused for a sentinel-keyed source. | Materialise a normal source identity first. |
| `COMPLETION_NODE_ADDED` | info | Tree completion added a registry node. | No action. |
| `COMPLETION_EDGE_RESOLVED` | info | Completion wired an edge through find-up reuse. | No action. |
| `COMPLETION_UNRESOLVED` | warning | A dependency range could not be resolved. | Supply registry data or correct the range. |
| `COMPLETION_NODE_UNKNOWN` | warning | Registry has no packument for the node. | Check registry/source identity. |
| `COMPLETION_VERSION_UNKNOWN` | warning | Packument lacks the requested version. | Refresh registry data or choose an available version. |
| `COMPLETION_PEER_CONTEXT_INCOMPLETE` | warning | Completion cannot resolve a peer context. | Supply peers/layout/manifests. |
| `COMPLETION_NO_CANDIDATE` | warning | Every version satisfying the range failed a constraint; `data.rejected` explains why. | Apply `data.suggestion` when present or relax/fix the rejecting constraint. |
| `COMPLETION_OVERRIDE_CONSTRAINT_CONFLICT` | warning | An override forces a version rejected by another constraint. | Reconcile override and constraint policy. |

### Enrich, optimize, and prune

| Code | Severity | Meaning / cause | Remedy |
|---|---:|---|---|
| `ENRICH_FIELD_FILLED` | info | Enrichment filled one install-required field and records the evidence rung. | No action. |
| `ENRICH_CHECKSUM_DEFERRED` | warning | Berry checksum cannot be recomputed from available bytes/cache key. | Supply bytes or run mutable Yarn; frozen install will reject until verified. |
| `ENRICH_NOOP` | info | Enrichment found nothing to fill. | No action. |
| `ENRICH_OVERRIDE_AUTHORITY_UNKNOWN` | warning | Transitive completion lacks authoritative override policy. | Supply manifests/config evidence. |
| `ENRICH_OVERRIDE_AUTHORITY_CONFLICT` | warning | Override authorities disagree, so completion was skipped. | Reconcile policy sources. |
| `ENRICH_ADAPTER_STATE_INVALIDATED` | warning | Enrichment changed subjects whose source-adapter sidecar state is no longer valid. | Re-emit/reparse or refresh adapter evidence. |
| `ENRICH_ARTIFACT_ROUTE_MISSING` | warning | No byte-capable remote route claims the package. | Add the intended `LiveRegistryAdapter` to `sources.artifacts`, or remain offline and accept the checksum defer. |
| `ENRICH_ARTIFACT_ROUTE_AMBIGUOUS` | warning | More than one distinct remote route claims the package; sibling fallback is forbidden. | Supply one authoritative route for the package. |
| `ENRICH_ARTIFACT_URL_UNAUTHORIZED` | warning | Neither the configured route nor exact name-and-version metadata authorizes the candidate URL. | Correct the lock URL/registry configuration or provide exact-version attestation. |
| `ENRICH_ARTIFACT_REGISTRY_METADATA_FAILED` | warning | Exact-version route attestation could not be obtained. | Restore registry metadata access; no artifact request was made. |
| `ENRICH_ARTIFACT_REDIRECT_REJECTED` | warning | A redirect target failed per-hop authorization, lacked `Location`, or exceeded the hop bound. | Correct the registry redirect chain; cross-route redirects must be separately authorized. |
| `ENRICH_ARTIFACT_FETCH_FAILED` | warning | Authorized artifact transport failed before an HTTP response. | Restore network/proxy/CA transport or use a local artifact source. |
| `ENRICH_ARTIFACT_HTTP_FAILED` | warning | The authorized artifact endpoint returned a non-success status. | Correct credentials/route or restore the endpoint. |
| `ENRICH_ARTIFACT_CONTENT_LENGTH_MISMATCH` | warning | The response declared an invalid length or returned a different byte count. | Repair the endpoint/proxy; partial bytes are never checksummed. |
| `ENRICH_ARTIFACT_INTEGRITY_MISSING` | warning | Bytes arrived but the lock carries no integrity evidence that can authorize them. | Supply a lock-recorded integrity member; fetched bytes do not reach recompute. |
| `ENRICH_ARTIFACT_INTEGRITY_UNSUPPORTED` | warning | Lock integrity exists but this installation cannot reproduce or verify its algorithm or Berry source domain. | Use a supported hash/backend; for mixed Berry cache key 10, install optional `@yarnpkg/libzip` when named by the diagnostic. |
| `ENRICH_ARTIFACT_INTEGRITY_MISMATCH` | warning | Returned tgz bytes disagree with lock integrity or with the reproduced Berry source checksum. | Treat the source as untrusted or stale and restore the lock's original artifact. |
| `ENRICH_ARTIFACT_COMPRESSED_LIMIT` | warning | Compressed input exceeded its mandatory ceiling. | For an accepted PM artifact, override the implementation default; if caller-provided, that ceiling was reached. |
| `ENRICH_ARTIFACT_INFLATED_LIMIT` | warning | Inflated tar bytes exceeded their mandatory ceiling. | For an accepted PM artifact, override the implementation default; if caller-provided, that ceiling was reached. |
| `ENRICH_ARTIFACT_TAR_CONTENT_LIMIT` | warning | Cumulative tar entry content exceeded its mandatory ceiling. | For an accepted PM artifact, override the implementation default; if caller-provided, that ceiling was reached. |
| `ENRICH_ARTIFACT_REPACKED_LIMIT` | warning | The target repacked zip exceeded its mandatory ceiling. | For an accepted PM artifact, override the implementation default; if caller-provided, that ceiling was reached. |
| `ENRICH_ARTIFACT_LIVE_LIMIT` | warning | Simultaneously live artifact representations exceeded the operation ceiling. | Reduce live materialization or override the default; increasing worker concurrency is not a remedy. |
| `STORE_PATH_RESOLVED` | info | The operation is about to make its first filesystem mutation in the resolved lockgraph store. Emitted at most once per operation. | Confirm the global XDG-aware path, pass `store: lockgraphStore(path)`, or use `store: false`. |
| `ENRICH_ARTIFACT_STORE_CORRUPT` | warning | A canonical object, digest alias, or current-lock alias verification failed. The invalid object/index was removed before source traversal continued. | Restore a verified local/remote source; the next centrally verified bytes self-heal the removed store entry. |
| `ENRICH_ARTIFACT_STORE_READ_FAILED` | warning | Private-root validation, coordination recovery, locking, or object I/O prevented a store read. | Repair ownership/permissions or remove the damaged store; later artifact sources remain eligible. |
| `ENRICH_ARTIFACT_STORE_WRITE_FAILED` | warning | Atomic private persistence failed after bytes had already verified. | Repair store ownership/filesystem availability. Enrichment succeeded without persistence. |
| `ENRICH_ARTIFACT_STORE_CAPACITY_EXCEEDED` | warning | An artifact exceeded configured capacity, or live pins left insufficient evictable room. | Increase `store: lockgraphStore(path, { maxBytes })`, wait for in-flight readers, or use `store: false`; verified bytes still serve the operation. |
| `ENRICH_ARTIFACT_STORE_EVICTION_FAILED` | warning | The store could not scan/delete enough stable entries to prove room for a commit. | Repair store filesystem state/permissions. No unproved-capacity commit is made. |
| `OPTIMIZE_NODE_REMOVED` | info | Reachability GC removed an orphan. | No action. |
| `OPTIMIZE_NOOP` | info | Reachability GC reached a fixpoint. | No action. |
| `OPTIMIZE_NO_ROOTS` | warning | Non-empty graph has no workspace/preserve anchor; optimizer preserved everything. | Supply `preserve` roots for rootless graphs. |
| `OPTIMIZE_WORKSPACE_UNREACHABLE` | warning (reserved) | Reserved for a future strict workspace mark policy; current v1 never emits it. | No current action. |
| `PRUNE_NODE_REMOVED` | info | Reference-count GC removed an unreferenced node. | No action. |
| `PRUNE_NOOP` | info | Reference-count GC removed nothing. | No action. |
| `PRUNE_NO_ROOTS` | warning | Unseeded prune on a rootless non-empty graph would wipe everything, so it no-oped. | Supply an explicit seed/preserve set. |

## Handling guidance

- Switch on `error.code` or `diagnostic.code`; never parse English messages.
- Treat unknown diagnostic codes as forward-compatible events and preserve their
  `severity`, `subject`, and `data`.
- A warning can still make an assessed `project` or `frozen` contract
  unsatisfied. Use the returned assessment, not severity alone, as the gate.
- Do not apply a `FrozenCandidate`. Only a satisfied result returned by
  `certifyFrozen` is frozen-certified.
